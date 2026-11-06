using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Fase 1C (bloco C3): a migração <c>VendasAlinhadasNuvem</c> recria <c>vendas</c> e <c>pagamentos_venda</c> no SQLite
/// (CHECKs novos só entram recriando a tabela) sem perder as vendas que o caixa já gravou na 1B.
/// </summary>
public class MigracaoVendasTests
{
    private const string MigracaoAnterior = "20261031044319_EnvelopeEventos";

    [Fact]
    public async Task Recria_as_tabelas_de_venda_mantendo_as_linhas_e_passa_a_recusar_o_que_a_nuvem_recusa()
    {
        using var banco = new BancoTemporario();
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.GetService<IMigrator>().MigrateAsync(MigracaoAnterior, TestContext.Current.CancellationToken);
        }

        var vendaId = Guid.NewGuid().ToString("D");
        var itemId = Guid.NewGuid().ToString("D");
        var pagamentoId = Guid.NewGuid().ToString("D");
        using (var conexao = banco.AbrirConexao())
        {
            Inserir(conexao, "vendas", vendaId, null);
            Inserir(conexao, "itens_venda", itemId, vendaId);
            Inserir(conexao, "pagamentos_venda", pagamentoId, vendaId);
        }

        var resultado = await banco.InicializarAsync();
        Assert.Contains(resultado.MigracoesAplicadas, m => m.EndsWith("_VendasAlinhadasNuvem", StringComparison.Ordinal));

        // A linha antiga sobrevive à recriação (com os filhos e a FK) e fica com a hora tida como confiável.
        Assert.Equal(1L, banco.Escalar($"select relogio_confiavel from vendas where id = '{vendaId}'"));
        Assert.Equal(1L, banco.Escalar($"select count(*) from itens_venda where venda_id = '{vendaId}'"));
        Assert.Equal(1L, banco.Escalar($"select count(*) from pagamentos_venda where venda_id = '{vendaId}'"));
        Assert.Equal(0L, banco.Escalar("select count(*) from pragma_foreign_key_check"));

        using var depois = banco.AbrirConexao();
        Assert.Contains("ck_vendas_canal", Recusa(depois, $"update vendas set canal = 'balcao' where id = '{vendaId}'"));
        Assert.Contains("ck_vendas_status_fiscal", Recusa(depois, $"update vendas set status_fiscal = 'emitida' where id = '{vendaId}'"));
        Assert.Contains("ck_vendas_cancelamento_origem", Recusa(depois, $"update vendas set cancelamento_origem = 'api' where id = '{vendaId}'"));
        Assert.Contains("ck_pagamentos_venda_uf_pagamento", Recusa(depois, $"update pagamentos_venda set cnpj_pagamento = '12345678000195' where id = '{pagamentoId}'"));
        Assert.Contains("ck_pagamentos_venda_tipo_integracao", Recusa(depois, $"update pagamentos_venda set tipo_integracao = 3 where id = '{pagamentoId}'"));

        // CPF/CNPJ na nota com a mesma regra do `~` da nuvem: 11 dígitos, ou 12 alfanuméricos + 2 dígitos.
        foreach (var valido in new[] { "12345678909", "12ABC34501DE35", "12345678000195" })
        {
            Executar(depois, $"update vendas set cpf_cnpj_nota = '{valido}' where id = '{vendaId}'");
        }

        foreach (var invalido in new[] { "1234567890", "123.456.789-09", "12ABC34501DEXY", "12abc34501de35", "123456789012345" })
        {
            Assert.Contains("ck_vendas_cpf_cnpj_nota", Recusa(depois, $"update vendas set cpf_cnpj_nota = '{invalido}' where id = '{vendaId}'"));
        }
    }

    /// <summary>
    /// Insere uma linha mínima lendo as colunas obrigatórias do próprio SQLite (o esquema antes da migração, sem o
    /// modelo EF de hoje): inteiros = 1 e descontos = 0 (passam nos CHECKs de valor), textos com o valor válido da enumeração.
    /// </summary>
    private static void Inserir(SqliteConnection conexao, string tabela, string id, string? vendaId)
    {
        var enumeracoes = new Dictionary<string, string>
        {
            ["tipo"] = "pdv",
            ["canal"] = "pdv",
            ["modo"] = "balcao",
            ["status"] = tabela == "vendas" ? "em_andamento" : "aprovado",
            ["status_fiscal"] = "nao_aplicavel",
            ["devolucao"] = "nenhuma",
            ["tipo_preco"] = "varejo",
            ["origem_preco"] = "varejo",
            ["meio_pagamento_fiscal"] = "01",
            ["tipo_forma"] = "dinheiro",
        };
        var colunas = new List<string>();
        var valores = new List<string>();
        using (var info = conexao.CreateCommand())
        {
            info.CommandText = $"select name, type from pragma_table_info('{tabela}') where \"notnull\" = 1 and dflt_value is null";
            using var leitor = info.ExecuteReader();
            while (leitor.Read())
            {
                var nome = leitor.GetString(0);
                colunas.Add(nome);
                valores.Add(nome switch
                {
                    "id" => $"'{id}'",
                    "venda_id" => $"'{vendaId}'",
                    _ when enumeracoes.TryGetValue(nome, out var v) => $"'{v}'",
                    _ when nome.StartsWith("desconto_", StringComparison.Ordinal) => "0",
                    _ when leitor.GetString(1) == "INTEGER" => "1",
                    _ when nome.EndsWith("_id", StringComparison.Ordinal) => $"'{Guid.NewGuid():D}'",
                    _ when nome.EndsWith("_em", StringComparison.Ordinal) => "'2026-10-30T12:00:00.0000000+00:00'",
                    _ => "'x'",
                });
            }
        }

        Executar(conexao, $"insert into {tabela} ({string.Join(", ", colunas)}) values ({string.Join(", ", valores)})");
    }

    private static void Executar(SqliteConnection conexao, string sql)
    {
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static string Recusa(SqliteConnection conexao, string sql) =>
        Assert.Throws<SqliteException>(() => Executar(conexao, sql)).Message;
}
