using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Repositorios;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Cascos descontados na venda (C11c) na tabela local <c>cascos_descontados_venda</c>: gravados no mesmo commit da venda,
/// a recuperação após queda devolve o crédito e a parte do operador separados, o desconto tirado sai da tabela, e a venda
/// encerrada mantém as linhas (cancelamento com os vazios, D29, e reimpressão).
/// </summary>
public class CascosDescontadosDadosTests
{
    private static readonly ContextoVenda Contexto = new(Guid.CreateVersion7(), Guid.CreateVersion7(), 1, Guid.CreateVersion7(), 2, null);
    private static readonly FormaPagamentoInfo Dinheiro = new(Guid.CreateVersion7(), "Dinheiro", "01", "dinheiro", PermiteTroco: true);
    private static readonly Guid Operador = Guid.CreateVersion7();

    private static readonly ProdutoVenda Garrafa =
        new(Guid.CreateVersion7(), 601, null, "GARRAFA 600ML", "UN", 2.50m) { Tipo = TipoProduto.Vasilhame };

    private static readonly ProdutoVenda Garrafao =
        new(Guid.CreateVersion7(), 620, null, "GARRAFAO 20L", "UN", 12.3456m) { Tipo = TipoProduto.Vasilhame };

    [Fact]
    public async Task Casco_descontado_volta_na_recuperacao_e_o_tirado_sai_da_tabela()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var repo = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var ct = TestContext.Current.CancellationToken;
        var agora = banco.Relogio.Agora;
        var venda = Venda.Iniciar(Guid.CreateVersion7(), await repo.ReservarNumeroVendaAsync(ct), Contexto, Operador, agora);
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.CreateVersion7(), 1, null, "WHISKY 1L", "UN", 99.90m)), 1m, "1", agora);
        venda.DescontarCascos(Garrafa, 3, agora);
        venda.DescontarCascos(Garrafao, 2, agora);
        venda.AplicarDescontoTotal(Desconto.EmPercentual(5m), 10m);
        await repo.SalvarEmAndamentoAsync(venda, ct: ct);

        Assert.Equal(2L, banco.Escalar($"select count(*) from cascos_descontados_venda where venda_id = '{venda.Id}'"));
        // Preço em inteiro escalado (4 casas), como os demais valores do banco local.
        Assert.Equal(123456L, banco.Escalar($"select preco_unitario from cascos_descontados_venda where produto_vasilhame_id = '{Garrafao.Id}'"));
        var recuperada = (await repo.ObterVendaAtualAsync(ct))!;
        Assert.Equal(
            (venda.DescontoTotal, venda.DescontoCascos, venda.DescontoTotalPct, venda.Total, venda.DescontoTotalOrigem),
            (recuperada.DescontoTotal, recuperada.DescontoCascos, recuperada.DescontoTotalPct, recuperada.Total, recuperada.DescontoTotalOrigem));
        Assert.Equal(7.50m + 24.69m, recuperada.DescontoCascos);
        Assert.Equal(venda.CascosDescontados, recuperada.CascosDescontados);

        recuperada.DescontarCascos(Garrafa, 1, agora);
        recuperada.DescontarCascos(Garrafao, 0, agora);
        await repo.SalvarEmAndamentoAsync(recuperada, ct: ct);
        Assert.Equal(1L, banco.Escalar($"select quantidade from cascos_descontados_venda where venda_id = '{venda.Id}'"));
        Assert.Equal(1L, banco.Escalar($"select count(*) from cascos_descontados_venda where venda_id = '{venda.Id}'"));
    }

    [Fact]
    public async Task Venda_encerrada_mantem_os_cascos_descontados()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var repo = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var ct = TestContext.Current.CancellationToken;
        var agora = banco.Relogio.Agora;
        var venda = Venda.Iniciar(Guid.CreateVersion7(), await repo.ReservarNumeroVendaAsync(ct), Contexto, Operador, agora);
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.CreateVersion7(), 1, null, "CARVAO 3KG", "UN", 19.90m)), 1m, "1", agora);
        venda.DescontarCascos(Garrafa, 2, agora);
        await repo.SalvarEmAndamentoAsync(venda, ct: ct);
        venda.IniciarPagamento();
        venda.LancarPagamento(Dinheiro, 20m, agora);
        venda.Finalizar(agora, Guid.CreateVersion7());
        await repo.EncerrarAsync(venda, null, ct: ct);

        var gravada = (await repo.ObterAsync(venda.Id, ct))!;
        Assert.Equal((StatusVenda.Finalizada, 14.90m, 5m), (gravada.Status, gravada.Total, gravada.DescontoCascos));
        Assert.Equal(new ResumoVasilhame(Garrafa.Id, 2m, 0m, 0m, null), Assert.Single(gravada.VaziosTrazidos()));
        Assert.Equal(1L, banco.Escalar($"select count(*) from cascos_descontados_venda where venda_id = '{venda.Id}'"));
    }
}
