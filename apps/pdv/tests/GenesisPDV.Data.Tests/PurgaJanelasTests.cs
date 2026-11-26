using GenesisPDV.Core.Vales;
using GenesisPDV.Data.Convencoes;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Manutencao;
using Microsoft.Data.Sqlite;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Purga local das janelas por tempo (F3-B7; D90; README do PDV › decisão 99): o vale fora de uso e sem mudança há mais
/// de 90 dias e o status de venda com mais de 90 dias saem do espelho; o vale ainda utilizável, o que mudou há menos de
/// 90 dias, o emitido aqui e ainda não confirmado, o de uma venda em curso e o de um evento a subir ficam. O critério é o
/// complemento exato do filtro da API (<c>valeNaJanela</c>).
/// </summary>
public class PurgaJanelasTests
{
    private static readonly DateTimeOffset Agora = new(2026, 11, 26, 15, 0, 0, TimeSpan.Zero);

    /// <summary>Hoje no fuso padrão da empresa (Brasília), como o <c>hojeNaEmpresa</c> da API.</summary>
    private static readonly DateOnly Hoje = new(2026, 11, 26);

    [Fact]
    public async Task Vale_zerado_ha_91_dias_sai_o_de_89_fica_e_o_criado_localmente_nunca_sai()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        using var conexao = banco.AbrirConexao();
        var zerado91 = Vale(conexao, saldo: 0, status: "utilizado", mudouHaDias: 91);
        var zerado89 = Vale(conexao, saldo: 0, status: "utilizado", mudouHaDias: 89);
        var localZerado91 = Vale(conexao, saldo: 0, status: "utilizado", mudouHaDias: 91, criadoLocalmente: true);
        var negativo100 = Vale(conexao, saldo: -350, status: "ativo", mudouHaDias: 100);
        var cancelado91 = Vale(conexao, saldo: 5000, status: "cancelado", mudouHaDias: 91);
        // Ativos com saldo, sem mudança há 120 dias: o vencido há 89 dias continua utilizável com o supervisor (D88).
        var vencido89 = Vale(conexao, saldo: 5000, status: "ativo", mudouHaDias: 120, validade: Hoje.AddDays(-89));
        var vencido91 = Vale(conexao, saldo: 5000, status: "ativo", mudouHaDias: 120, validade: Hoje.AddDays(-91));
        var aVencer = Vale(conexao, saldo: 5000, status: "ativo", mudouHaDias: 120, validade: Hoje.AddDays(30));
        var vencidoMudou = Vale(conexao, saldo: 5000, status: "ativo", mudouHaDias: 1, validade: Hoje.AddDays(-400));

        var saidas = await PurgaJanelas.PurgarValesAsync(conexao, null, Agora, TestContext.Current.CancellationToken);

        Assert.Equal(4, saidas);
        Assert.Equal(
            new[] { zerado89, localZerado91, vencido89, aVencer, vencidoMudou }.Order(StringComparer.Ordinal),
            Ids(conexao, "vales"));
        Assert.DoesNotContain(zerado91, Ids(conexao, "vales"));
        Assert.DoesNotContain(negativo100, Ids(conexao, "vales"));
        Assert.DoesNotContain(cancelado91, Ids(conexao, "vales"));
        Assert.DoesNotContain(vencido91, Ids(conexao, "vales"));
    }

    [Fact]
    public async Task Vale_fora_da_janela_numa_venda_em_curso_ou_num_evento_a_subir_fica_ate_terminar()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        using var conexao = banco.AbrirConexao();
        var naVenda = Vale(conexao, saldo: 0, status: "utilizado", mudouHaDias: 120);
        var noEvento = Vale(conexao, saldo: 0, status: "utilizado", mudouHaDias: 120);
        var noRecusado = Vale(conexao, saldo: 0, status: "utilizado", mudouHaDias: 120);
        var venda = VendaEmAndamentoCom(conexao, naVenda);
        Evento(conexao, noEvento, StatusEventoSaida.Pendente);
        // O recusado em quarentena não segura (a nuvem guarda a cópia), como na purga de pessoas.
        Evento(conexao, noRecusado, StatusEventoSaida.Rejeitado);

        Assert.Equal(1, await PurgaJanelas.PurgarValesAsync(conexao, null, Agora, TestContext.Current.CancellationToken));
        Assert.Equal(new[] { naVenda, noEvento }.Order(StringComparer.Ordinal), Ids(conexao, "vales"));

        // A venda termina e o evento sobe: o ciclo seguinte purga os dois.
        Executar(conexao, $"update vendas set status = 'finalizada', finalizada_em = atualizado_em where id = '{venda}'");
        Executar(conexao, $"update eventos_saida set status = '{StatusEventoSaida.Confirmado}' where agregado_id = '{noEvento}'");
        Assert.Equal(2, await PurgaJanelas.PurgarValesAsync(conexao, null, Agora, TestContext.Current.CancellationToken));
        Assert.Empty(Ids(conexao, "vales"));
    }

    [Fact]
    public async Task Status_de_venda_de_91_dias_sai_e_o_de_89_fica()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        using var conexao = banco.AbrirConexao();
        var antigo = Status(conexao, mudouHaDias: 91);
        var recente = Status(conexao, mudouHaDias: 89);

        Assert.Equal(1, await PurgaJanelas.PurgarStatusVendasAsync(conexao, null, Agora, TestContext.Current.CancellationToken));
        Assert.Equal([recente], Ids(conexao, "vendas_status_pdv"));
        Assert.DoesNotContain(antigo, Ids(conexao, "vendas_status_pdv"));
    }

    [Fact]
    public async Task Recarga_do_fluxo_parado_apaga_a_copia_com_janela_menos_o_vale_local_o_da_venda_em_curso_e_o_do_evento()
    {
        // F3-B7 (SYNC 6.8): o caixa parado por mais tempo que a janela descarta a cópia, mesmo a que ainda parece
        // utilizável (o ERP pode tê-la cancelado enquanto ele estava parado), e o fluxo desce de novo do cursor 0.
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        using var conexao = banco.AbrirConexao();
        Vale(conexao, saldo: 5000, status: "ativo", mudouHaDias: 95);
        Vale(conexao, saldo: 5000, status: "ativo", mudouHaDias: 1);
        var local = Vale(conexao, saldo: 5000, status: "ativo", mudouHaDias: 95, criadoLocalmente: true);
        var naVenda = Vale(conexao, saldo: 5000, status: "ativo", mudouHaDias: 95);
        var noEvento = Vale(conexao, saldo: 5000, status: "ativo", mudouHaDias: 95);
        VendaEmAndamentoCom(conexao, naVenda);
        Evento(conexao, noEvento, StatusEventoSaida.ErroTemporario);
        Status(conexao, mudouHaDias: 95);
        Status(conexao, mudouHaDias: 1);

        Assert.Equal(2, await PurgaJanelas.DescartarCopiaAsync(conexao, null, "vales", TestContext.Current.CancellationToken));
        Assert.Equal(new[] { local, naVenda, noEvento }.Order(StringComparer.Ordinal), Ids(conexao, "vales"));
        Assert.Equal(2, await PurgaJanelas.DescartarCopiaAsync(conexao, null, "vendas_status_pdv", TestContext.Current.CancellationToken));
        Assert.Empty(Ids(conexao, "vendas_status_pdv"));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            PurgaJanelas.DescartarCopiaAsync(conexao, null, "pessoas", TestContext.Current.CancellationToken));
    }

    private static int _codigo;

    private static string Vale(SqliteConnection conexao, long saldo, string status, int mudouHaDias, DateOnly? validade = null, bool criadoLocalmente = false)
    {
        var id = Guid.CreateVersion7().ToString("D");
        var codigo = CodigoVale.MontarVale(1, 1, Interlocked.Increment(ref _codigo));
        var mudou = DataHoraUtcTexto.Formatar(Agora.AddDays(-mudouHaDias));
        Executar(conexao, "insert into vales (id, codigo, tipo, loja_emissao_id, valor_original, saldo, validade, status, origem_tipo, "
            + "emitido_em, emitido_por_id, criado_em, atualizado_em, versao, criado_localmente) values "
            + $"('{id}', '{codigo}', 'vale_troca', '{Guid.NewGuid():D}', 5000, {saldo}, '{(validade ?? Hoje.AddDays(60)):yyyy-MM-dd}', '{status}', "
            + $"'manual', '{mudou}', '{Guid.NewGuid():D}', '{mudou}', '{mudou}', {(criadoLocalmente ? 0 : 10)}, {(criadoLocalmente ? 1 : 0)})");
        return id;
    }

    private static string Status(SqliteConnection conexao, int mudouHaDias)
    {
        var id = Guid.CreateVersion7().ToString("D");
        var mudou = DataHoraUtcTexto.Formatar(Agora.AddDays(-mudouHaDias));
        Executar(conexao, "insert into vendas_status_pdv (id, caixa_id, terminal_id, status, status_fiscal, devolucao, cancelada_em, "
            + "cancelamento_origem, criado_em, atualizado_em, versao) values "
            + $"('{id}', '{Guid.NewGuid():D}', '{Guid.NewGuid():D}', 'cancelada', 'nao_aplicavel', 'nenhuma', '{mudou}', 'erp', '{mudou}', '{mudou}', 10)");
        return id;
    }

    /// <summary>Venda em andamento com um pagamento no vale (as FKs locais desligadas: só o vínculo importa aqui).</summary>
    private static string VendaEmAndamentoCom(SqliteConnection conexao, string valeId)
    {
        var venda = Guid.CreateVersion7().ToString("D");
        var data = DataHoraUtcTexto.Formatar(Agora);
        Executar(conexao, "PRAGMA foreign_keys = OFF");
        Executar(conexao, """
            insert into vendas (id, acrescimo_total, atualizado_em, caixa_id, canal, criado_em, desconto_itens, desconto_total, devolucao,
                iniciada_em, loja_id, modo, numero, numero_caixa, numero_exibicao, operador_id, qtd_itens, relogio_confiavel,
                sessao_caixa_id, status, status_fiscal, subtotal_bruto, taxa_entrega, taxa_servico, terminal_id, tipo, tipo_preco,
                total, troco, valor_frete, versao, dia_operacional)
            """ + $"values ('{venda}', 0, '{data}', '{Guid.NewGuid():D}', 'pdv', '{data}', 0, 0, 'nenhuma', '{data}', '{Guid.NewGuid():D}', "
            + $"'balcao', 1, 1, 'L01-C01-000001', '{Guid.NewGuid():D}', 1, 1, '{Guid.NewGuid():D}', 'em_andamento', 'nao_aplicavel', 1000, 0, 0, "
            + $"'{Guid.NewGuid():D}', 'pdv', 'varejo', 1000, 0, 0, 0, '2026-11-26')");
        Executar(conexao, """
            insert into pagamentos_venda (id, atualizado_em, criado_em, descricao_forma, forma_pagamento_id, indicador_pagamento, lanca_quitada,
                meio_pagamento_fiscal, parcelas, sequencia, status, taxa_pct, tipo_forma, troco, valor, valor_taxa_servico, venda_id, versao, vale_id)
            """ + $"values ('{Guid.CreateVersion7():D}', '{data}', '{data}', 'Vale Compra', '{Guid.NewGuid():D}', 0, 1, '99', 1, 1, 'aprovado', 0, "
            + $"'vale', 0, 1000, 0, '{venda}', 0, '{valeId}')");
        Executar(conexao, "PRAGMA foreign_keys = ON");
        return venda;
    }

    private static void Evento(SqliteConnection conexao, string valeId, string status)
    {
        var data = DataHoraUtcTexto.Formatar(Agora);
        Executar(conexao, "insert into eventos_saida (id, sequencia_terminal, tipo, versao_schema, agregado_tipo, agregado_id, ocorrido_em, "
            + "criado_em, payload, payload_sha256, status, tentativas, dependencias) values "
            + $"('{Guid.CreateVersion7():D}', {Interlocked.Increment(ref _codigo)}, 'vale.utilizado', 1, 'vale', '{valeId}', '{data}', '{data}', "
            + $"'{{}}', '{new string('0', 64)}', '{status}', 0, '[]')");
    }

    private static List<string> Ids(SqliteConnection conexao, string tabela)
    {
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = $"select id from {tabela} order by id";
        using var leitor = cmd.ExecuteReader();
        var ids = new List<string>();
        while (leitor.Read())
        {
            ids.Add(leitor.GetString(0));
        }

        return [.. ids.Order(StringComparer.Ordinal)];
    }

    private static void Executar(SqliteConnection conexao, string sql)
    {
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
}
