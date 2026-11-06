using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Tests;

public class RepositorioVendasTests
{
    private static readonly ContextoVenda Contexto = new(Guid.CreateVersion7(), Guid.CreateVersion7(), 1, Guid.CreateVersion7(), 2, null);
    private static readonly FormaPagamentoInfo Dinheiro = new(Guid.CreateVersion7(), "Dinheiro", "01", "dinheiro", PermiteTroco: true);
    private static readonly Guid Operador = Guid.CreateVersion7();

    private static ProdutoResolvido Produto(decimal preco, string unidade = "UN") =>
        new(new ProdutoVenda(Guid.CreateVersion7(), 1, null, "ÁGUA CRYSTAL 500ML", unidade, preco));

    private static async Task<(BancoTemporario Banco, RepositorioVendas Repo)> CriarAsync()
    {
        var banco = new BancoTemporario();
        await banco.InicializarAsync();
        return (banco, new RepositorioVendas(banco.Fabrica, banco.Relogio));
    }

    [Fact]
    public async Task Numero_de_venda_e_monotonico()
    {
        var (banco, repo) = await CriarAsync();
        using var _ = banco;
        var ct = TestContext.Current.CancellationToken;
        Assert.Equal(1, await repo.ReservarNumeroVendaAsync(ct));
        Assert.Equal(2, await repo.ReservarNumeroVendaAsync(ct));
        Assert.Equal(3, await repo.ReservarNumeroVendaAsync(ct));
    }

    [Fact]
    public async Task Venda_em_andamento_volta_exatamente_como_estava()
    {
        var (banco, repo) = await CriarAsync();
        using var _ = banco;
        var ct = TestContext.Current.CancellationToken;
        var agora = banco.Relogio.Agora;
        var venda = Venda.Iniciar(Guid.CreateVersion7(), await repo.ReservarNumeroVendaAsync(ct), Contexto, Operador, agora);
        venda.AdicionarItem(Produto(3.49m), 12m, "7891149103102", agora);
        await repo.SalvarEmAndamentoAsync(venda, ct: ct);
        venda.AdicionarItem(Produto(19.99m, "KG"), 0.795m, "0050", agora);
        await repo.SalvarEmAndamentoAsync(venda, ct: ct);
        venda.AdicionarItem(Produto(9.99m), 1m, "789", agora);
        venda.CancelarItem(3, Operador, agora, 100m, motivo: "desistiu");
        venda.AplicarDescontoTotal(Desconto.EmReais(1.00m), 100m);
        venda.IniciarPagamento();
        venda.LancarPagamento(Dinheiro, 20m, agora);
        await repo.SalvarEmAndamentoAsync(venda, ct: ct);

        var recuperada = await repo.ObterVendaAtualAsync(ct);
        Assert.NotNull(recuperada);
        Assert.Equal(venda.Id, recuperada.Id);
        Assert.Equal(StatusVenda.EmPagamento, recuperada.Status);
        Assert.Equal("L01-C02-000001", recuperada.NumeroExibicao);
        Assert.Equal(venda.Total, recuperada.Total);
        Assert.Equal(56.77m, recuperada.Total);
        Assert.Equal(venda.Falta, recuperada.Falta);
        Assert.Equal(3, recuperada.Itens.Count);
        Assert.True(recuperada.ObterItem(3).Cancelado);
        Assert.Equal(0.795m, recuperada.ObterItem(2).Quantidade);
        Assert.True(recuperada.ObterItem(2).Fracionavel);
        Assert.Equal(venda.Itens.Select(i => i.DescontoRateado), recuperada.Itens.Select(i => i.DescontoRateado));
        Assert.Single(recuperada.Pagamentos);
        Assert.Equal(20m, recuperada.Pagamentos[0].Valor);
    }

    [Fact]
    public async Task Valores_ficam_em_inteiro_escalado_e_ids_em_texto_minusculo()
    {
        var (banco, repo) = await CriarAsync();
        using var _ = banco;
        var ct = TestContext.Current.CancellationToken;
        var agora = banco.Relogio.Agora;
        var venda = Venda.Iniciar(Guid.CreateVersion7(), 1, Contexto, Operador, agora);
        venda.AdicionarItem(Produto(45.18m), 1m, "1", agora);
        await repo.SalvarEmAndamentoAsync(venda, ct: ct);

        Assert.Equal("integer", banco.Escalar("select typeof(total) from vendas"));
        Assert.Equal(4518L, banco.Escalar("select total from vendas"));
        Assert.Equal(451800L, banco.Escalar("select preco_unitario from itens_venda"));
        Assert.Equal(1000L, banco.Escalar("select quantidade from itens_venda"));
        Assert.Equal(venda.Id.ToString(), banco.Escalar("select id from vendas"));
        Assert.Equal(24L, banco.Escalar("select length(iniciada_em) from vendas"));
        Assert.Equal(4518L, banco.Escalar("select sum(valor_liquido) from itens_venda"));
    }

    [Fact]
    public async Task Finalizar_grava_venda_e_evento_no_mesmo_commit_com_sequencia_continua()
    {
        var (banco, repo) = await CriarAsync();
        using var _ = banco;
        var ct = TestContext.Current.CancellationToken;
        var sequencias = new List<long>();
        for (var n = 0; n < 2; n++)
        {
            var agora = banco.Relogio.Agora;
            var venda = Venda.Iniciar(Guid.CreateVersion7(), await repo.ReservarNumeroVendaAsync(ct), Contexto, Operador, agora);
            venda.AdicionarItem(Produto(10m), 1m, "1", agora);
            await repo.SalvarEmAndamentoAsync(venda, ct: ct);
            venda.IniciarPagamento();
            venda.LancarPagamento(Dinheiro, 50m, agora);
            var eventoId = Guid.CreateVersion7();
            venda.Finalizar(agora, eventoId);
            sequencias.Add(await repo.EncerrarAsync(venda, new EventoParaOutbox(eventoId, "venda.finalizada", 1, "venda", venda.Id, agora, "{}", new string('0', 64)), ct: ct));

            Assert.Null(await repo.ObterVendaAtualAsync(ct));
            var gravada = await repo.ObterAsync(venda.Id, ct);
            Assert.Equal(StatusVenda.Finalizada, gravada!.Status);
            Assert.Equal(40m, gravada.Troco);
            Assert.Equal(eventoId, gravada.EventoFinalizacaoId);
            await Assert.ThrowsAsync<InvalidOperationException>(() => repo.SalvarEmAndamentoAsync(venda, ct: ct));
        }

        Assert.Equal([1L, 2L], sequencias);
        await using var db = banco.Fabrica.CreateDbContext();
        var eventos = await db.EventosSaida.OrderBy(e => e.SequenciaTerminal).ToListAsync(ct);
        Assert.Equal(2, eventos.Count);
        Assert.All(eventos, e => Assert.Equal(StatusEventoSaida.Pendente, e.Status));
        Assert.Equal(2, await new RepositorioTerminal(banco.Fabrica, banco.Relogio).ContarEventosPendentesAsync(ct));
    }

    [Fact]
    public async Task Decimal_com_casas_demais_nao_e_gravado()
    {
        var (banco, _) = await CriarAsync();
        using var __ = banco;
        await using var db = banco.Fabrica.CreateDbContext();
        db.Vendas.Add(new VendaRegistro
        {
            Id = Guid.CreateVersion7(),
            NumeroExibicao = "X",
            LojaId = Guid.CreateVersion7(),
            CaixaId = Guid.CreateVersion7(),
            Numero = 1,
            OperadorId = Operador,
            Total = 1.005m,
            IniciadaEm = DateTimeOffset.UtcNow,
        });
        await Assert.ThrowsAnyAsync<Exception>(() => db.SaveChangesAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Chave_estrangeira_ligada()
    {
        var (banco, _) = await CriarAsync();
        using var __ = banco;
        var erro = Assert.Throws<SqliteException>(() => banco.Escalar(
            "insert into itens_venda (id, venda_id, sequencia, produto_id, descricao, unidade, quantidade, preco_tabela, preco_unitario, origem_preco, valor_bruto, desconto_item, desconto_promocao, desconto_rateado, acrescimo_rateado, frete_rateado, valor_liquido, quantidade_devolvida, cancelado, peso_digitado, kit_acrescimo, incluido_em, criado_em, atualizado_em, versao) " +
            "values ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000099', 1, '00000000-0000-7000-8000-000000000002', 'x', 'UN', 1000, 10000, 10000, 'varejo', 100, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, '2026-10-29T17:36:05.123Z', '2026-10-29T17:36:05.123Z', '2026-10-29T17:36:05.123Z', 0)"));
        Assert.Contains("FOREIGN KEY", erro.Message);
    }

    [Fact]
    public async Task Ativacao_cria_identidade_cursores_e_sequencias()
    {
        var (banco, _) = await CriarAsync();
        using var __ = banco;
        var ct = TestContext.Current.CancellationToken;
        var repo = new RepositorioTerminal(banco.Fabrica, banco.Relogio);
        Assert.Null(await repo.ObterIdentidadeAsync(ct));
        await repo.RegistrarAtivacaoAsync(new IdentidadeTerminal
        {
            TerminalId = Guid.CreateVersion7(),
            EmpresaCodigo = 100001,
            LojaId = Guid.CreateVersion7(),
            CaixaId = Guid.CreateVersion7(),
            NumeroCaixa = 2,
            UrlApi = "https://api.exemplo",
            AtivadoEm = banco.Relogio.Agora,
            NomeMaquina = "CAIXA02",
        }, ct);
        var identidade = await repo.ObterIdentidadeAsync(ct);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            Assert.Equal(db.Database.GetMigrations().Count(), identidade!.VersaoSchemaLocal);
        }

        Assert.Equal(7L, banco.Escalar("select count(*) from estado_sincronizacao where cursor = 0"));
        Assert.Equal(2L, banco.Escalar("select count(*) from sequencias_locais"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => repo.RegistrarAtivacaoAsync(new IdentidadeTerminal(), ct));

        await repo.GravarConfiguracaoAsync("tela.tema", "claro", ct: ct);
        Assert.Equal("claro", await repo.ObterConfiguracaoAsync<string>("tela.tema", ct));
    }
}
