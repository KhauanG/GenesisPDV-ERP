using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Release R2 do PDV (Fase 2, F2-B45; SYNC 17.4.2): a migração <c>FaseDois</c> junta as mudanças de Esquema.g.cs da Fase 2
/// (as imagens das marcas e das categorias e as tabelas de complementos) e dá uma única volta no cursor do
/// <c>catalogo</c>: cursor e versão local das marcas e das categorias a 0, sem mexer nos outros fluxos, na carga
/// inicial nem na marca de "esperar o suporte".
/// </summary>
public class MigracaoFaseDoisTests
{
    private const string MigracaoAnterior = "20261110145032_BuscaProdutosFts";
    private const string MigracaoFaseDois = "20261111184626_FaseDois";

    [Fact]
    public async Task Volta_o_cursor_do_catalogo_e_a_versao_das_marcas_e_categorias_numa_migracao_so()
    {
        using var banco = new BancoTemporario();
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.GetService<IMigrator>().MigrateAsync(MigracaoAnterior, TestContext.Current.CancellationToken);
        }

        var marca = Guid.NewGuid().ToString("D");
        var categoria = Guid.NewGuid().ToString("D");
        using (var conexao = banco.AbrirConexao())
        {
            // Terminal no PDV 0.11.0, com o pull já além das versões que a API nova gravou.
            Executar(conexao, "insert into estado_sincronizacao (fluxo, cursor, carga_inicial_concluida, linhas_recebidas, ressincronizar) "
                + "values ('catalogo', 9000, 1, 900, 0), ('configuracao', 5000, 1, 120, 0), ('acesso', 300, 1, 10, 1)");
            Executar(conexao, "insert into marcas (id, codigo, descricao, sem_marca, exibe_site, ordem, criado_em, atualizado_em, versao) "
                + $"values ('{marca}', 7, 'CERVEJARIA FICTICIA', 0, 0, 0, '2026-11-11T12:00:00.000Z', '2026-11-11T12:00:00.000Z', 8990)");
            Executar(conexao, "insert into categorias (id, nome, caminho, caminho_nomes, nivel, ordem, ativa, exibe_pdv, exibe_menu_digital, exibe_totem, exibe_site, criado_em, atualizado_em, versao) "
                + $"values ('{categoria}', 'Cervejas', '/x/', 'Cervejas', 1, 0, 1, 1, 0, 0, 0, '2026-11-11T12:00:00.000Z', '2026-11-11T12:00:00.000Z', 8991)");
        }

        var resultado = await banco.InicializarAsync();
        // Uma migração só da Fase 2 depois da 0.11.0 (uma volta do cursor). Só as migrações até a FaseDois contam: as
        // das fases seguintes também entram no InicializarAsync e não mudam a regra da R2.
        Assert.Equal(
            [MigracaoFaseDois],
            resultado.MigracoesAplicadas.Where(m => string.CompareOrdinal(m, MigracaoFaseDois) <= 0));

        Assert.Equal(0L, banco.Escalar("select cursor from estado_sincronizacao where fluxo = 'catalogo'"));
        Assert.Equal(1L, banco.Escalar("select carga_inicial_concluida from estado_sincronizacao where fluxo = 'catalogo'"));
        Assert.Equal(0L, banco.Escalar("select ressincronizar from estado_sincronizacao where fluxo = 'catalogo'"));
        Assert.Equal(5000L, banco.Escalar("select cursor from estado_sincronizacao where fluxo = 'configuracao'"));
        Assert.Equal(1L, banco.Escalar("select ressincronizar from estado_sincronizacao where fluxo = 'acesso'"));
        Assert.Equal(0L, banco.Escalar($"select versao from marcas where id = '{marca}'"));
        Assert.Equal(0L, banco.Escalar($"select versao from categorias where id = '{categoria}'"));
        Assert.Equal(DBNull.Value, banco.Escalar($"select logotipo_url from marcas where id = '{marca}'") ?? DBNull.Value);
        Assert.Equal(0L, banco.Escalar("select count(*) from produtos_grupos_complementos"));
        Assert.Equal(0L, banco.Escalar("select count(*) from produtos_complementos"));

        await using var depois = banco.Fabrica.CreateDbContext();
        Assert.Empty(await depois.Database.GetPendingMigrationsAsync(TestContext.Current.CancellationToken));
    }

    private static void Executar(SqliteConnection conexao, string sql)
    {
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
}
