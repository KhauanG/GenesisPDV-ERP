using System.Globalization;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Convencoes;
using GenesisPDV.Data.Entidades;
using Microsoft.Data.Sqlite;

namespace GenesisPDV.Data.Manutencao;

/// <summary>
/// Purga local das linhas que saíram da janela por tempo dos fluxos do pull (F3-B7; D90; MD 6.2; README do PDV ›
/// decisão 99). A nuvem só manda os vales na janela do caixa e o status das vendas dos últimos 90 dias, e a linha que sai
/// da janela pelo relógio não ganha versão nova: nada a "desce". Por isso o PDV apaga a própria cópia pelo mesmo
/// critério, por estado e uma vez por ciclo, na última página do fluxo (o padrão da purga de pessoas do SEG-B13). Os
/// critérios são o complemento exato dos filtros da API (<c>valeNaJanela</c> e o de <c>vendas_status_pdv</c> em
/// <c>apps/api/src/sync/fluxos.ts</c>), com <see cref="DiasJanela"/> igual ao <c>DIAS_JANELA_PDV</c> de lá.
/// </summary>
public static class PurgaJanelas
{
    /// <summary>Dias sem mudança depois dos quais o vale fora de uso e o status de venda saem do caixa (D90).</summary>
    public const int DiasJanela = 90;

    /// <summary>
    /// Folga da recarga do fluxo parado (<see cref="DescartarCopiaAsync"/>): o caixa sem pull com sucesso há mais de
    /// <c>DiasJanela − MargemRecargaDias</c> dias recarrega as tabelas com janela. A folga cobre a diferença entre o relógio
    /// do caixa, que gravou o <c>ultimo_pull_sucesso_em</c>, e o <c>now()</c> da nuvem, que corta a janela.
    /// </summary>
    public const int MargemRecargaDias = 10;

    /// <summary>Situações do evento que ainda vai subir e seguram a purga do vale; constantes, nunca da rede.</summary>
    private static readonly string EmCurso = string.Join(", ",
        new[] { StatusEventoSaida.Pendente, StatusEventoSaida.Enviando, StatusEventoSaida.ErroTemporario }.Select(s => $"'{s}'"));

    /// <summary>
    /// Vales fora da janela (D90): sem mudança há mais de 90 dias e não utilizáveis — vencidos há mais de 90 dias,
    /// zerados (ou negativos, D89), usados, expirados ou cancelados. Ficam sempre o vale emitido aqui e ainda não
    /// confirmado pela nuvem (<c>criado_localmente</c>, MD 4.2), o que está numa venda em curso e o de um evento ainda a
    /// subir. "Hoje" é a data no fuso da empresa, como o <c>hojeNaEmpresa</c> da API. Devolve quantos saíram.
    /// </summary>
    public static async Task<int> PurgarValesAsync(SqliteConnection conexao, SqliteTransaction? tx, DateTimeOffset agora, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(conexao);
        var fuso = DiaOperacional.ObterFuso(await FusoDaEmpresaAsync(conexao, tx, ct));
        var hoje = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(agora, fuso).DateTime);
        await using var cmd = conexao.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = $"""
            delete from vales
             where criado_localmente = 0
               and atualizado_em <= $limite
               and not (status = 'ativo' and saldo > 0 and validade >= $validade_minima)
               and not exists (select 1 from pagamentos_venda p join vendas v on v.id = p.venda_id
                                where p.vale_id = vales.id and v.status not in ('finalizada', 'cancelada'))
               and not exists (select 1 from eventos_saida e where e.status in ({EmCurso}) and e.agregado_id = vales.id)
            """;
        cmd.Parameters.AddWithValue("$limite", DataHoraUtcTexto.Formatar(agora.AddDays(-DiasJanela)));
        cmd.Parameters.AddWithValue("$validade_minima", hoje.AddDays(-DiasJanela).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        return await cmd.ExecuteNonQueryAsync(ct);
    }

    /// <summary>Status de venda sem mudança há mais de 90 dias (o filtro do fluxo <c>operacao</c>). Devolve quantos saíram.</summary>
    public static async Task<int> PurgarStatusVendasAsync(SqliteConnection conexao, SqliteTransaction? tx, DateTimeOffset agora, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(conexao);
        await using var cmd = conexao.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "delete from vendas_status_pdv where atualizado_em <= $limite";
        cmd.Parameters.AddWithValue("$limite", DataHoraUtcTexto.Formatar(agora.AddDays(-DiasJanela)));
        return await cmd.ExecuteNonQueryAsync(ct);
    }

    /// <summary>
    /// Recarga do fluxo parado (F3-B7; SYNC 6.8; README do PDV › decisão 99): o caixa que ficou mais tempo que a janela sem
    /// puxar não recebe a mudança que, enquanto ele estava parado, tirou a linha da janela e envelheceu (o ERP cancelou o
    /// vale no 5º dia, o caixa volta no 100º: a linha não desce e o cursor passa por cima dela), e a cópia local, velha,
    /// ainda diz "ativo". Quem chama apaga a cópia da tabela com janela do fluxo e volta o cursor a 0, na mesma transação;
    /// a descida seguinte traz de novo exatamente o que está na janela. Fica o emitido aqui e ainda não confirmado
    /// (<c>criado_localmente</c>), o vale de uma venda local em curso e o de um evento ainda a subir, como na purga.
    /// Devolve quantas linhas saíram.
    /// </summary>
    public static async Task<int> DescartarCopiaAsync(SqliteConnection conexao, SqliteTransaction? tx, string tabela, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(conexao);
        await using var cmd = conexao.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = tabela switch
        {
            "vales" => $"""
                delete from vales
                 where criado_localmente = 0
                   and not exists (select 1 from pagamentos_venda p join vendas v on v.id = p.venda_id
                                    where p.vale_id = vales.id and v.status not in ('finalizada', 'cancelada'))
                   and not exists (select 1 from eventos_saida e where e.status in ({EmCurso}) and e.agregado_id = vales.id)
                """,
            "vendas_status_pdv" => "delete from vendas_status_pdv where criado_localmente = 0",
            _ => throw new ArgumentOutOfRangeException(nameof(tabela), tabela, "Tabela sem janela por tempo."),
        };
        return await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task<string?> FusoDaEmpresaAsync(SqliteConnection conexao, SqliteTransaction? tx, CancellationToken ct)
    {
        await using var cmd = conexao.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "select fuso_horario from empresa where excluido_em is null limit 1";
        return await cmd.ExecuteScalarAsync(ct) as string;
    }
}
