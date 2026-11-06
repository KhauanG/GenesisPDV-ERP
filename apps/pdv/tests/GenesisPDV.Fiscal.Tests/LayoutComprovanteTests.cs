using GenesisPDV.Core.Vendas;

namespace GenesisPDV.Fiscal.Tests;

/// <summary>Rótulo "ATACADO 12+ (varejo 3,49)" do cupom (PDV 11.3.1).</summary>
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
}
