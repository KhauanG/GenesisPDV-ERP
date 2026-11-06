using System.Text.RegularExpressions;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Entidades;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Fase 1C (bloco C9): a migração <c>TabelasCaixa</c> cria as tabelas de caixa e de devolução avulsa, recria
/// <c>eventos_saida</c> com <c>dependencias</c> e <c>relogio_regrediu</c> (o CHECK novo só entra recriando a tabela) e
/// a seguinte (<c>TravaDesativacao</c>) cria os gatilhos da trava da D22. O outbox de antes sobrevive com
/// <c>dependencias = []</c>.
/// </summary>
public partial class MigracaoTabelasCaixaTests
{
    private const string MigracaoAnterior = "20261031234924_FormasPagamentoLojas";

    [Fact]
    public async Task Outbox_anterior_sobrevive_com_dependencias_vazias_e_os_gatilhos_da_d22_existem()
    {
        using var banco = new BancoTemporario();
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.GetService<IMigrator>().MigrateAsync(MigracaoAnterior, TestContext.Current.CancellationToken);
        }

        var eventoId = Guid.NewGuid().ToString("D");
        using (var conexao = banco.AbrirConexao())
        {
            Executar(conexao, "insert into eventos_saida (id, sequencia_terminal, tipo, versao_schema, agregado_tipo, agregado_id, ocorrido_em, "
                + "criado_em, payload, payload_sha256, status, tentativas) values "
                + $"('{eventoId}', 1, 'auditoria.registros', 1, 'auditoria', '{Guid.NewGuid():D}', '2026-10-31T12:00:00.000Z', "
                + "'2026-10-31T12:00:00.000Z', '{}', 'abc', 'pendente', 0)");
        }

        var resultado = await banco.InicializarAsync();
        Assert.Contains(resultado.MigracoesAplicadas, m => m.EndsWith("_TabelasCaixa", StringComparison.Ordinal));
        Assert.Contains(resultado.MigracoesAplicadas, m => m.EndsWith("_TravaDesativacao", StringComparison.Ordinal));
        Assert.Equal("[]", banco.Escalar($"select dependencias from eventos_saida where id = '{eventoId}'"));
        Assert.Equal(DBNull.Value, banco.Escalar($"select relogio_regrediu from eventos_saida where id = '{eventoId}'"));
        foreach (var tabela in new[] { "sessoes_caixa", "movimentos_caixa", "fechamentos_caixa", "fechamentos_caixa_formas", "movimentos_vasilhame" })
        {
            Assert.Equal(1L, banco.Escalar($"select count(*) from sqlite_master where type = 'table' and name = '{tabela}'"));
        }

        AssertGatilhosDaTrava(banco);
    }

    [Fact]
    public async Task Gatilhos_da_d22_estao_no_banco_atual_e_recusam_evento_e_auditoria()
    {
        // Uma migração futura que recrie `eventos_saida` ou `log_auditoria_local` (CHECK novo no SQLite) perde o gatilho:
        // este teste roda sobre o banco com todas as migrações e quebra até ela recriá-lo.
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        AssertGatilhosDaTrava(banco);

        await using var db = banco.Fabrica.CreateDbContext();
        await db.EstadoConexao.ExecuteUpdateAsync(
            s => s.SetProperty(c => c.ConfirmandoDesativacaoEm, DateTimeOffset.UtcNow), TestContext.Current.CancellationToken);
        db.LogAuditoriaLocal.Add(new LogAuditoriaLocal { Id = Guid.CreateVersion7(), OcorridoEm = DateTimeOffset.UtcNow, Acao = "logout" });
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() => db.SaveChangesAsync(TestContext.Current.CancellationToken));
        Assert.Equal(TravaDesativacao.Mensagem, recusa.Message);
        db.ChangeTracker.Clear();

        // O SQL cru (fora do EF) também é recusado: a trava é do banco, não do repositório.
        using var conexao = banco.AbrirConexao();
        var cru = Assert.Throws<SqliteException>(() => Executar(conexao,
            "insert into eventos_saida (id, sequencia_terminal, tipo, versao_schema, agregado_tipo, agregado_id, ocorrido_em, criado_em, "
            + $"payload, payload_sha256, status, tentativas) values ('{Guid.NewGuid():D}', 9, 'caixa.aberto', 1, 'sessao_caixa', "
            + $"'{Guid.NewGuid():D}', '2026-10-31T12:00:00.000Z', '2026-10-31T12:00:00.000Z', '{{}}', 'abc', 'pendente', 0)"));
        Assert.Contains(TravaDesativacao.Marcador, cru.Message, StringComparison.Ordinal);

        // Destravada, grava (o que não sobe — log técnico, estado de conexão — nunca foi travado).
        Executar(conexao, "update estado_conexao set confirmando_desativacao_em = null");
        db.LogAuditoriaLocal.Add(new LogAuditoriaLocal { Id = Guid.CreateVersion7(), OcorridoEm = DateTimeOffset.UtcNow, Acao = "logout" });
        Assert.Equal(1, await db.SaveChangesAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Recriar_estado_conexao_exige_derrubar_os_gatilhos_da_d22_antes()
    {
        // A armadilha do caso inverso (README › decisão 51): o EF recria a tabela no SQLite com CREATE ef_temp, cópia,
        // DROP e RENAME. O RENAME revalida os gatilhos que citam estado_conexao no WHEN e aborta a migração; com o
        // DROP TRIGGER antes (e os gatilhos recriados depois), a recriação passa.
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        using var conexao = banco.AbrirConexao();
        var colunas = string.Join(", ", Colunas(conexao, "estado_conexao"));

        var quebra = Assert.Throws<SqliteException>(() => RecriarComoOEf(conexao, colunas));
        Assert.Contains("no such table: main.estado_conexao", quebra.Message, StringComparison.Ordinal);
        Assert.Equal(1L, Contar(conexao, "select count(*) from sqlite_master where type = 'table' and name = 'estado_conexao'"));

        foreach (var tabela in TravaDesativacao.Tabelas)
        {
            Executar(conexao, $"DROP TRIGGER tg_{tabela}_confirmando_desativacao");
        }

        RecriarComoOEf(conexao, colunas);
        foreach (var tabela in TravaDesativacao.Tabelas)
        {
            Executar(conexao, TravaDesativacao.Gatilho(tabela));
        }

        AssertGatilhosDaTrava(banco);
    }

    /// <summary>A sequência que o EF executa ao recriar uma tabela (CHECK novo), numa transação como a da migração.</summary>
    private static void RecriarComoOEf(SqliteConnection conexao, string colunas)
    {
        var sql = (string)Escalar(conexao, "select sql from sqlite_master where type = 'table' and name = 'estado_conexao'")!;
        Executar(conexao, "BEGIN");
        try
        {
            Executar(conexao, CriarTabela().Replace(sql, "CREATE TABLE \"ef_temp_estado_conexao\"", 1));
            Executar(conexao, $"INSERT INTO ef_temp_estado_conexao ({colunas}) SELECT {colunas} FROM estado_conexao");
            Executar(conexao, "DROP TABLE estado_conexao");
            Executar(conexao, "ALTER TABLE ef_temp_estado_conexao RENAME TO estado_conexao");
            Executar(conexao, "COMMIT");
        }
        catch
        {
            Executar(conexao, "ROLLBACK");
            throw;
        }
    }

    [GeneratedRegex(@"^CREATE TABLE ""?estado_conexao""?", RegexOptions.IgnoreCase)]
    private static partial Regex CriarTabela();

    private static IEnumerable<string> Colunas(SqliteConnection conexao, string tabela)
    {
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = $"select name from pragma_table_info('{tabela}')";
        using var leitor = cmd.ExecuteReader();
        var nomes = new List<string>();
        while (leitor.Read())
        {
            nomes.Add(leitor.GetString(0));
        }

        return nomes;
    }

    private static object? Escalar(SqliteConnection conexao, string sql)
    {
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = sql;
        return cmd.ExecuteScalar();
    }

    private static long Contar(SqliteConnection conexao, string sql) => (long)Escalar(conexao, sql)!;

    private static void AssertGatilhosDaTrava(BancoTemporario banco)
    {
        foreach (var tabela in TravaDesativacao.Tabelas)
        {
            var sql = banco.Escalar($"select sql from sqlite_master where type = 'trigger' and name = 'tg_{tabela}_confirmando_desativacao'") as string;
            Assert.NotNull(sql);
            Assert.Equal(Normalizar(TravaDesativacao.Gatilho(tabela)).TrimEnd(';'), Normalizar(sql).TrimEnd(';'));
        }
    }

    private static string Normalizar(string sql) => Espacos().Replace(sql, " ").Trim();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Espacos();

    private static void Executar(SqliteConnection conexao, string sql)
    {
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
}
