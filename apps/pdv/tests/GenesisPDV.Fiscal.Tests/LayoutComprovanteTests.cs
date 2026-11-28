using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Hardware.Impressora;

namespace GenesisPDV.Fiscal.Tests;

/// <summary>Rótulo "ATACADO 12+ (varejo 3,49)" do cupom (PDV 11.3.1) e os complementos sob o item (PDV 10.2, 19.2).</summary>
public class LayoutComprovanteTests
{
    [Fact]
    public void Sem_o_limiar_do_snapshot_o_rotulo_nao_usa_a_quantidade_do_cliente()
    {
        // Linha relida do banco sem snapshot: 15 latas no atacado; o limiar real (12) e o varejo da hora são desconhecidos.
        var item = new ItemVenda(
            Guid.CreateVersion7(), 1, Guid.CreateVersion7(), "0123", null, "CERV BRAHMA LT 350ML", "UN", false, 15m, 3.19m, 3.19m,
            OrigemPreco.Atacado, 47.85m, 0m, DateTimeOffset.UnixEpoch, quantidadeReferenciaPreco: 15m);
        Assert.Equal("ATACADO", LayoutComprovanteVenda.RotuloAtacado(item));
        Assert.Equal("ATAC", item.EtiquetaPreco);
        Assert.Equal(0m, item.EconomiaAtacado);
    }

    [Fact]
    public void Complementos_saem_sob_o_item_com_o_adicional_e_o_atacado_usa_o_varejo_com_eles()
    {
        // F3-B15: impressão simulada da porção com dois molhos e o cheddar (+4,50), no atacado de 3 porções.
        var molhos = Guid.CreateVersion7();
        var cheddar = Guid.CreateVersion7();
        var rose = Guid.CreateVersion7();
        var porcao = new ProdutoVenda(Guid.CreateVersion7(), 300, "0300", "PORÇÃO DE FRITAS", "UN", 25m)
        {
            Tipo = TipoProduto.ComComplementos,
            Precos = new Core.Precos.TabelaPreco(PrecoAtacado: 22m, QtdMinimaAtacado: 3m),
            GruposComplementos =
            [
                new GrupoComplementos(molhos, "Molhos", 1, 2, true, 1, [new OpcaoComplemento(rose, "Rosé", 0m, Ordem: 1), new OpcaoComplemento(cheddar, "CHEDDAR CREMOSO", 4.5m, Ordem: 2)]),
            ],
        };
        var agora = new DateTimeOffset(2026, 11, 27, 15, 0, 0, TimeSpan.Zero);
        var venda = Venda.Iniciar(Guid.CreateVersion7(), 9, new ContextoVenda(Guid.CreateVersion7(), Guid.CreateVersion7(), 1, Guid.CreateVersion7(), 2, null),
            Guid.CreateVersion7(), agora);
        venda.AdicionarItem(new ProdutoResolvido(porcao), 3m, "0300", agora, complementos: [rose, cheddar]);

        var texto = RenderizadorEscPos.RenderizarTexto(LayoutComprovanteVenda.Gerar(venda, new CabecalhoDocumento("Loja", "Razão", null, null, null, null, "Maria")));

        Assert.Contains("   + Rosé\n   + CHEDDAR CREMOSO (+4,50)\n   3,000 UN x 26,50", texto.Replace("\r", string.Empty, StringComparison.Ordinal));
        Assert.Contains("   ATACADO 3+ (varejo 29,50)", texto);
        Assert.Contains("Economia no atacado: R$ 9,00", texto);
    }
}
