using GenesisPDV.Data.Entidades;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Release R3 do PDV (Fase 3, F3-B7; SYNC 17.4.2; README do PDV › decisão 99): a migração <c>FaseTres</c> cria as tabelas
/// que descem na Fase 3 (promoções, vales, orçamentos e o status das vendas) e dá uma única volta nos cursores dos fluxos
/// que elas ampliam — <c>catalogo</c>, <c>pessoas</c> e <c>operacao</c>, mais o <c>configuracao</c> pelos templates de
/// <c>recibo_venda</c> e <c>orcamento_*</c> —, sem mexer nos outros fluxos, na carga inicial, na marca de "esperar o
/// suporte" nem nos dados locais (só as cópias do <c>recibo_receber</c>, que saiu do filtro, vão embora). Sobre o banco do
/// PDV mais antigo em uso (tratado como o 0.10.0 até a lista do dono, que vai no corpo do PR-17) e sobre o do 0.13.0.
/// </summary>
public class MigracaoFaseTresTests
{
    /// <summary>Última migração do <c>pdv-v0.10.0</c> (a mais antiga em uso, até a conferência do dono no ERP › Terminais).</summary>
    private const string MigracaoPdv0100 = "20261105131203_IndiceAuditoriaAutorizadoPor";

    /// <summary>Última migração do <c>pdv-v0.12.0</c> e do <c>pdv-v0.13.0</c>.</summary>
    private const string MigracaoPdv0130 = "20261111184626_FaseDois";

    private const string MigracaoFaseTres = "20261126035525_FaseTres";

    private static readonly string[] FluxosQueVoltam = ["configuracao", "catalogo", "pessoas", "operacao"];

    [Theory]
    [InlineData(MigracaoPdv0100)]
    [InlineData(MigracaoPdv0130)]
    public async Task Volta_so_os_cursores_dos_fluxos_ampliados_numa_migracao_so_e_preserva_os_dados(string migracaoInstalada)
    {
        using var banco = new BancoTemporario();
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.GetService<IMigrator>().MigrateAsync(migracaoInstalada, TestContext.Current.CancellationToken);
        }

        var pessoa = Guid.NewGuid().ToString("D");
        var marca = Guid.NewGuid().ToString("D");
        var cupom = Guid.NewGuid().ToString("D");
        var reciboReceber = Guid.NewGuid().ToString("D");
        using (var conexao = banco.AbrirConexao())
        {
            // Terminal em uso há semanas: carga inicial concluída, os sete cursores além das versões que a API nova gravou,
            // e o `acesso` marcado para esperar o suporte.
            Executar(conexao, "insert into estado_sincronizacao (fluxo, cursor, carga_inicial_concluida, linhas_recebidas, ressincronizar) values "
                + "('configuracao', 9100, 1, 120, 0), ('acesso', 9200, 1, 10, 1), ('referencia', 9300, 1, 6000, 0), "
                + "('catalogo', 9400, 1, 900, 0), ('estoque', 9500, 1, 800, 0), ('pessoas', 9600, 1, 50, 0), ('operacao', 9700, 0, 0, 0)");
            Executar(conexao, "insert into marcas (id, codigo, descricao, sem_marca, exibe_site, ordem, criado_em, atualizado_em, versao) "
                + $"values ('{marca}', 7, 'CERVEJARIA FICTICIA', 0, 0, 0, '2026-11-11T12:00:00.000Z', '2026-11-11T12:00:00.000Z', 8990)");
            Executar(conexao, "insert into pessoas (id, codigo, tipo, nome, ativa, indicador_ie, sexo, desconto_pct, bloqueada_credito, criado_em, atualizado_em, versao) "
                + $"values ('{pessoa}', 10, 'PF', 'CLIENTE FICTICIO', 1, '9', 'N', 0, 0, '2026-11-11T12:00:00.000Z', '2026-11-11T12:00:00.000Z', 8995)");
            foreach (var (id, tipo, versao) in new[] { (cupom, "cupom_rodape", 8996), (reciboReceber, "recibo_receber", 8997) })
            {
                Executar(conexao, "insert into templates_documentos (id, tipo, nome, formato, conteudo, padrao, ativo, criado_em, atualizado_em, versao) "
                    + $"values ('{id}', '{tipo}', 'Padrão', 'texto', 'Obrigado!', 1, 1, '2026-11-11T12:00:00.000Z', '2026-11-11T12:00:00.000Z', {versao})");
            }
        }

        var resultado = await banco.InicializarAsync();
        // Uma migração só da Fase 3 depois da versão instalada (uma volta dos cursores): as migrações até a FaseTres que
        // entram são as da Fase 2 que faltavam (do 0.10.0) e a FaseTres; as de blocos seguintes não contam.
        var aplicadas = resultado.MigracoesAplicadas.Where(m => string.CompareOrdinal(m, MigracaoFaseTres) <= 0).ToList();
        Assert.Equal(MigracaoFaseTres, aplicadas[^1]);
        Assert.Single(aplicadas, m => string.CompareOrdinal(m, MigracaoPdv0130) > 0);

        foreach (var fluxo in EstadoSincronizacao.Fluxos)
        {
            var esperado = FluxosQueVoltam.Contains(fluxo) ? 0L : fluxo switch
            {
                "acesso" => 9200L,
                "referencia" => 9300L,
                "estoque" => 9500L,
                _ => throw new InvalidOperationException(fluxo),
            };
            Assert.Equal(esperado, banco.Escalar($"select cursor from estado_sincronizacao where fluxo = '{fluxo}'"));
        }

        Assert.Equal(6L, banco.Escalar("select count(*) from estado_sincronizacao where carga_inicial_concluida = 1"));
        Assert.Equal(0L, banco.Escalar("select carga_inicial_concluida from estado_sincronizacao where fluxo = 'operacao'"));
        Assert.Equal(1L, banco.Escalar("select ressincronizar from estado_sincronizacao where fluxo = 'acesso'"));
        Assert.Equal(0L, banco.Escalar("select count(*) from estado_sincronizacao where fluxo <> 'acesso' and ressincronizar = 1"));
        Assert.Equal(900L, banco.Escalar("select linhas_recebidas from estado_sincronizacao where fluxo = 'catalogo'"));

        // Nada local muda além do recibo_receber; a versão local das linhas existentes fica (nenhuma coluna nova nelas).
        Assert.Equal(8995L, banco.Escalar($"select versao from pessoas where id = '{pessoa}'"));
        Assert.Equal(8996L, banco.Escalar($"select versao from templates_documentos where id = '{cupom}'"));
        Assert.Equal(0L, banco.Escalar($"select count(*) from templates_documentos where id = '{reciboReceber}'"));
        // A FaseDois (só para quem vinha do 0.10.0) zera a versão das marcas; quem já estava no 0.13.0 fica com a dela.
        Assert.Equal(migracaoInstalada == MigracaoPdv0100 ? 0L : 8990L, banco.Escalar($"select versao from marcas where id = '{marca}'"));
        foreach (var tabela in new[] { "promocoes", "promocoes_itens", "vales", "orcamentos", "itens_orcamento", "vendas_status_pdv" })
        {
            Assert.Equal(0L, banco.Escalar($"select count(*) from {tabela}"));
        }

        await using var depois = banco.Fabrica.CreateDbContext();
        Assert.Empty(await depois.Database.GetPendingMigrationsAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Valido_ate_do_orcamento_e_calculado_pelo_sqlite_como_na_nuvem()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        using var conexao = banco.AbrirConexao();
        var id = Guid.NewGuid().ToString("D");
        Executar(conexao, "insert into orcamentos (id, codigo, loja_id, nome, data, dias_validade, ativo, status, respondido, desconto_valor, subtotal_bruto, total, origem, criado_em, atualizado_em) "
            + $"values ('{id}', 1, '{Guid.NewGuid():D}', 'BAR FICTICIO', '2026-12-25', 15, 1, 'aberto', 'nao', 0, 0, 0, 'erp', '2026-11-26T12:00:00.000Z', '2026-11-26T12:00:00.000Z')");
        Assert.Equal("2027-01-09", banco.Escalar($"select valido_ate from orcamentos where id = '{id}'"));
        await using var db = banco.Fabrica.CreateDbContext();
        var lido = await db.Set<OrcamentoRegistro>().SingleAsync(TestContext.Current.CancellationToken);
        Assert.Equal(new DateOnly(2027, 1, 9), lido.ValidoAte);
    }

    private static void Executar(SqliteConnection conexao, string sql)
    {
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
}
