using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Fase 1C (bloco C8b; SYNC 17.4.2): a migração <c>FormasPagamentoLojas</c> cria um espelho e uma coluna num fluxo que
/// já existia (<c>configuracao</c>). O PDV anterior descartou os dois e avançou o cursor; a migração volta o cursor do
/// fluxo a 0 e a versão local das formas também, para o pull baixar de novo os vínculos e o <c>exige_supervisor</c>.
/// </summary>
public class MigracaoFormasPagamentoLojasTests
{
    private const string MigracaoAnterior = "20261031155633_LiberacoesVenda";

    [Fact]
    public async Task Volta_o_cursor_de_configuracao_e_a_versao_das_formas_sem_mexer_nos_outros_fluxos()
    {
        using var banco = new BancoTemporario();
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.GetService<IMigrator>().MigrateAsync(MigracaoAnterior, TestContext.Current.CancellationToken);
        }

        var formaId = Guid.NewGuid().ToString("D");
        using (var conexao = banco.AbrirConexao())
        {
            // Terminal ativado no PDV anterior, com o pull já além das versões que a 0014 da API criou.
            Executar(conexao, "insert into estado_sincronizacao (fluxo, cursor, carga_inicial_concluida, linhas_recebidas, ressincronizar) "
                + "values ('configuracao', 5000, 1, 120, 0), ('pessoas', 7000, 1, 900, 0), ('acesso', 300, 1, 10, 1)");
            InserirForma(conexao, formaId, versao: 4990);
        }

        var resultado = await banco.InicializarAsync();
        Assert.Contains(resultado.MigracoesAplicadas, m => m.EndsWith("_FormasPagamentoLojas", StringComparison.Ordinal));

        Assert.Equal(0L, banco.Escalar("select cursor from estado_sincronizacao where fluxo = 'configuracao'"));
        // A carga inicial continua concluída (o caixa segue vendendo) e a marca de "esperar o suporte" não é usada.
        Assert.Equal(1L, banco.Escalar("select carga_inicial_concluida from estado_sincronizacao where fluxo = 'configuracao'"));
        Assert.Equal(0L, banco.Escalar("select ressincronizar from estado_sincronizacao where fluxo = 'configuracao'"));
        // Outros fluxos ficam como estavam, inclusive o que espera o suporte (o `catalogo` não serve de exemplo: a
        // `FaseDois`, aplicada na mesma abertura, volta o cursor dele).
        Assert.Equal(7000L, banco.Escalar("select cursor from estado_sincronizacao where fluxo = 'pessoas'"));
        Assert.Equal(1L, banco.Escalar("select ressincronizar from estado_sincronizacao where fluxo = 'acesso'"));
        // Versão 0: a mesma linha da nuvem (versão 4990, com o `exige_supervisor` real) volta a ser gravada.
        Assert.Equal(0L, banco.Escalar($"select versao from formas_pagamento where id = '{formaId}'"));
        Assert.Equal(0L, banco.Escalar($"select exige_supervisor from formas_pagamento where id = '{formaId}'"));
        Assert.Equal(0L, banco.Escalar("select count(*) from formas_pagamento_lojas"));
    }

    /// <summary>
    /// Forma mínima lendo as colunas obrigatórias do próprio SQLite (o esquema antes da migração, com <c>loja_id</c>):
    /// inteiros = 0, textos com um valor válido.
    /// </summary>
    private static void InserirForma(SqliteConnection conexao, string id, long versao)
    {
        var colunas = new List<string>();
        var valores = new List<string>();
        using (var info = conexao.CreateCommand())
        {
            info.CommandText = "select name, type from pragma_table_info('formas_pagamento') where \"notnull\" = 1";
            using var leitor = info.ExecuteReader();
            while (leitor.Read())
            {
                var nome = leitor.GetString(0);
                colunas.Add(nome);
                valores.Add(nome switch
                {
                    "id" => $"'{id}'",
                    "versao" => versao.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    "tipo_forma" => "'pix'",
                    "integracao" => "'nenhuma'",
                    "meio_pagamento_fiscal" => "'20'",
                    "parcelas_maximo" => "1",
                    _ when leitor.GetString(1) == "INTEGER" => "0",
                    _ when nome.EndsWith("_em", StringComparison.Ordinal) => "'2026-10-30T12:00:00.0000000+00:00'",
                    _ => "'PIX manual'",
                });
            }
        }

        Executar(conexao, $"insert into formas_pagamento ({string.Join(", ", colunas)}) values ({string.Join(", ", valores)})");
    }

    private static void Executar(SqliteConnection conexao, string sql)
    {
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
}
