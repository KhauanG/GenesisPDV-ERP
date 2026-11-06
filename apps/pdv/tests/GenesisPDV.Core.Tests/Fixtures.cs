using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;

namespace GenesisPDV.Core.Tests;

internal static class Fixtures
{
    public static readonly DateTimeOffset Agora = new(2026, 10, 29, 17, 36, 5, 123, TimeSpan.Zero);
    public static readonly Guid Operador = Guid.Parse("01a18754-76cb-7b74-b2e7-06298fadc1a6");
    public static readonly Guid Supervisor = Guid.Parse("01a18755-09d1-76b6-8b81-48f6b38a088c");

    public static readonly ContextoVenda Contexto = new(
        TerminalId: Guid.Parse("01a18751-a521-7238-b924-56de3eb13b90"),
        LojaId: Guid.Parse("01a18752-3782-7bda-ad3c-2d6d1a3d1fa7"),
        LojaCodigo: 1,
        CaixaId: Guid.Parse("01a18752-c8a9-7970-9641-9f828b9d2434"),
        NumeroCaixa: 2,
        SessaoCaixaId: null);

    public static readonly FormaPagamentoInfo Dinheiro = new(Guid.CreateVersion7(), "Dinheiro", "01", "dinheiro", PermiteTroco: true, AbreGaveta: true);
    public static readonly FormaPagamentoInfo Pix = new(Guid.CreateVersion7(), "PIX", "20", "pix", PermiteTroco: false);

    /// <summary>Confirmação manual do PIX (16.7; C11a): todo PIX da 1C é confirmado pelo operador no app do banco.</summary>
    public static readonly ConfirmacaoPix PixConfirmado = new("JOSE DA SILVA", Agora.AddMinutes(-1), string.Empty, "L01C02000123");

    public static ProdutoResolvido Produto(decimal preco, string descricao = "PRODUTO", string unidade = "UN") =>
        new(new ProdutoVenda(Guid.CreateVersion7(), 1, null, descricao, unidade, preco));

    public static Venda NovaVenda(long numero = 123) =>
        Venda.Iniciar(Guid.CreateVersion7(), numero, Contexto, Operador, Agora);

    public static Venda VendaComItens(params decimal[] valores)
    {
        var venda = NovaVenda();
        foreach (var valor in valores)
        {
            venda.AdicionarItem(Produto(valor), 1m, "1", Agora);
        }

        return venda;
    }
}
