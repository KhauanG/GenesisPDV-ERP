using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Repositorios;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// A marca do gelado e o tipo do F8 de antes do parcelado ficam só no caixa (Fase 3, F3-B18; README › decisão 105): a
/// tabela local <c>itens_venda_gelados</c> e a coluna <c>estado_operacao.tipo_preco_antes_parcelado</c>, gravadas no mesmo
/// commit da venda. A venda recuperada depois de uma queda mantém o gelado (o agrupamento e o desfazer) e volta do parcelado
/// ao tipo certo; nenhuma coluna nova sobe à nuvem.
/// </summary>
public class GeladoParceladoDadosTests
{
    private static readonly ContextoVenda Contexto = new(Guid.CreateVersion7(), Guid.CreateVersion7(), 1, Guid.CreateVersion7(), 2, null);

    private static readonly FormaPagamentoInfo Credito = new(
        Guid.CreateVersion7(), "Crédito", "03", "cartao_credito", PermiteTroco: false, Integracao: IntegracaoForma.PosExterno,
        PermiteParcelar: true, ParcelasMaximo: 6);

    private static readonly FormaPagamentoInfo Dinheiro = new(Guid.CreateVersion7(), "Dinheiro", "01", "dinheiro", PermiteTroco: true);
    private static readonly Guid Operador = Guid.CreateVersion7();

    private static readonly ProdutoVenda Brahma = new(Guid.CreateVersion7(), 123, null, "CERV BRAHMA LT 350ML", "UN", 3.49m)
    {
        Precos = new TabelaPreco(PrecoAtacado: 3.19m, QtdMinimaAtacado: 12m, AcrescimoGelada: 1.25m, PrecoParcelado: 3.69m),
    };

    [Fact]
    public async Task Gelado_gravado_na_tabela_local_volta_na_recuperacao_e_o_tirado_sai()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var repo = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var ct = TestContext.Current.CancellationToken;
        var agora = banco.Relogio.Agora;
        var venda = Venda.Iniciar(Guid.CreateVersion7(), await repo.ReservarNumeroVendaAsync(ct), Contexto, Operador, agora);
        var gelada = venda.AdicionarItem(new ProdutoResolvido(Brahma), 2m, "1", agora);
        venda.AlternarGelado(gelada.Sequencia);
        var natural = venda.AdicionarItem(new ProdutoResolvido(Brahma), 1m, "1", agora, agrupar: true);
        await repo.SalvarEmAndamentoAsync(venda, ct: ct);

        Assert.Equal(1L, banco.Escalar($"select count(*) from itens_venda_gelados where venda_id = '{venda.Id}'"));
        // Preço em inteiro escalado (4 casas), como os demais valores do banco local; o acréscimo também está no unitário.
        Assert.Equal(12500L, banco.Escalar($"select acrescimo_unitario from itens_venda_gelados where item_venda_id = '{gelada.Id}'"));
        Assert.Equal(47400L, banco.Escalar($"select preco_unitario from itens_venda where id = '{gelada.Id}'"));

        var recuperada = (await repo.ObterVendaAtualAsync(ct))!;
        recuperada.RegistrarProdutos(await repo.ObterSnapshotsAsync(venda.Id, ct), null, agora);
        Assert.True(recuperada.ObterItem(gelada.Sequencia).Gelado);
        Assert.False(recuperada.ObterItem(natural.Sequencia).Gelado);
        Assert.Equal(venda.Total, recuperada.Total);
        // O natural novo agrupa no natural, nunca no gelado.
        Assert.Equal(natural.Sequencia, recuperada.AdicionarItem(new ProdutoResolvido(Brahma), 1m, "1", agora, agrupar: true).Sequencia);

        recuperada.AlternarGelado(gelada.Sequencia);
        await repo.SalvarEmAndamentoAsync(recuperada, ct: ct);
        Assert.Equal(0L, banco.Escalar($"select count(*) from itens_venda_gelados where venda_id = '{venda.Id}'"));
        Assert.Equal(34900L, banco.Escalar($"select preco_unitario from itens_venda where id = '{gelada.Id}'"));

        // A venda encerrada mantém a marca (a reimpressão mostra o "GELADO").
        recuperada.AlternarGelado(gelada.Sequencia);
        recuperada.IniciarPagamento();
        recuperada.LancarPagamento(Dinheiro, 50m, agora);
        recuperada.Finalizar(agora, Guid.CreateVersion7());
        await repo.EncerrarAsync(recuperada, null, ct: ct);
        var encerrada = (await repo.ObterAsync(venda.Id, ct))!;
        Assert.True(encerrada.ObterItem(gelada.Sequencia).Gelado);
        Assert.Equal(1.25m, encerrada.ObterItem(gelada.Sequencia).AcrescimoGelada);
    }

    [Fact]
    public async Task Tipo_do_F8_de_antes_do_parcelado_fica_no_estado_da_operacao()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var repo = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var ct = TestContext.Current.CancellationToken;
        var agora = banco.Relogio.Agora;
        var venda = Venda.Iniciar(Guid.CreateVersion7(), await repo.ReservarNumeroVendaAsync(ct), Contexto, Operador, agora);
        var item = venda.AdicionarItem(new ProdutoResolvido(Brahma), 2m, "1", agora);
        venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, temPermissaoAtacado: true);
        venda.IniciarPagamento();
        venda.AplicarPrecoParcelado();
        var credito = venda.LancarPagamento(Credito, 3m, agora, RegrasFormaPagamento.ValidarPos(Credito, "01", null, null, 3));
        await repo.SalvarEmAndamentoAsync(venda, ct: ct);

        Assert.Equal("parcelado", banco.Escalar($"select tipo_preco from vendas where id = '{venda.Id}'"));
        Assert.Equal("atacado", banco.Escalar("select tipo_preco_antes_parcelado from estado_operacao"));
        Assert.Equal("parcelado", banco.Escalar($"select origem_preco from itens_venda where id = '{item.Id}'"));

        var recuperada = (await repo.ObterVendaAtualAsync(ct))!;
        recuperada.RegistrarProdutos(await repo.ObterSnapshotsAsync(venda.Id, ct), null, agora);
        Assert.Equal((TipoPrecoVenda.Parcelado, TipoPrecoVenda.Atacado), (recuperada.TipoPreco, recuperada.TipoPrecoAntesParcelado));

        recuperada.RemoverPagamento(credito.Sequencia);
        await repo.SalvarEmAndamentoAsync(recuperada, ct: ct);
        Assert.Equal("atacado", banco.Escalar($"select tipo_preco from vendas where id = '{venda.Id}'"));
        Assert.Equal(DBNull.Value, banco.Escalar("select tipo_preco_antes_parcelado from estado_operacao") ?? DBNull.Value);
        Assert.Equal(31900L, banco.Escalar($"select preco_unitario from itens_venda where id = '{item.Id}'"));

        // De novo no parcelado e finalizada: o encerramento limpa a coluna (ela só vale para a venda atual).
        recuperada.AplicarPrecoParcelado();
        recuperada.LancarPagamento(Credito, recuperada.Falta, agora, RegrasFormaPagamento.ValidarPos(Credito, "01", null, null, 2));
        recuperada.Finalizar(agora, Guid.CreateVersion7());
        await repo.EncerrarAsync(recuperada, null, ct: ct);
        Assert.Equal(DBNull.Value, banco.Escalar("select tipo_preco_antes_parcelado from estado_operacao") ?? DBNull.Value);
        Assert.Equal("parcelado", banco.Escalar($"select tipo_preco from vendas where id = '{venda.Id}'"));
        Assert.Equal(TipoPrecoVenda.Parcelado, (await repo.ObterAsync(venda.Id, ct))!.TipoPreco);
    }
}
