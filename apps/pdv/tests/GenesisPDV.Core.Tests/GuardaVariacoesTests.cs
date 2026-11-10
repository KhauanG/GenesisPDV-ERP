using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;

namespace GenesisPDV.Core.Tests;

/// <summary>
/// Guarda do produto com variações no caixa (Fase 2, F2-B34; F2-Q2 = D44; PDV 10.2): o código de uma variação e o pai
/// "Com variações" com variação ativa são recusados com a chave ligada e entram como o pai com ela desligada; o pai sem
/// variação ativa e o <c>com_complementos</c> sempre entram.
/// </summary>
public class GuardaVariacoesTests
{
    private static ProdutoVenda Produto(string tipo, bool variacoesAtivas = false) =>
        new(Guid.CreateVersion7(), 10, "0010", "CAMISETA", "UN", 49.90m) { Tipo = tipo, TemVariacoesAtivas = variacoesAtivas };

    [Fact]
    public void Codigo_de_variacao_e_pai_com_variacao_ativa_sao_recusados_com_a_chave_ligada()
    {
        var pai = new ProdutoResolvido(Produto(TipoProduto.ComVariacoes, variacoesAtivas: true));
        var codigoDaVariacao = new ProdutoResolvido(Produto(TipoProduto.ComVariacoes, variacoesAtivas: true), Guid.CreateVersion7(), VariacaoId: Guid.CreateVersion7());
        // O código de variação num produto que não é "Com variações" (cadastro inconsistente) também: a baixa seria do pai.
        var simplesComCodigoDeVariacao = new ProdutoResolvido(Produto(TipoProduto.Simples), Guid.CreateVersion7(), VariacaoId: Guid.CreateVersion7());

        foreach (var r in new[] { pai, codigoDaVariacao, simplesComCodigoDeVariacao })
        {
            Assert.True(r.ExigeVariacao);
            Assert.Equal("Produto com variações: venda disponível na próxima versão", GuardaVariacoes.Motivo(r, recusa: true));
            Assert.Null(GuardaVariacoes.Motivo(r, recusa: false));
        }
    }

    [Theory]
    [InlineData(TipoProduto.ComVariacoes, false)]
    [InlineData(TipoProduto.ComComplementos, false)]
    [InlineData(TipoProduto.ComComplementos, true)]
    [InlineData(TipoProduto.Simples, true)]
    public void Pai_sem_variacao_ativa_complementos_e_simples_entram(string tipo, bool variacoesAtivas)
    {
        // TemVariacoesAtivas só vale para "Com variações" (o catálogo só marca esse tipo; aqui, nem marcado conta).
        var r = new ProdutoResolvido(Produto(tipo, variacoesAtivas));
        Assert.False(r.ExigeVariacao);
        Assert.Null(GuardaVariacoes.Motivo(r, recusa: true));
    }

    [Fact]
    public void Com_a_chave_desligada_o_pai_entra_na_venda_como_hoje()
    {
        var venda = CatalogoTeste.VendaPreco();
        var pai = new ProdutoResolvido(Produto(TipoProduto.ComVariacoes, variacoesAtivas: true));
        Assert.Null(GuardaVariacoes.Motivo(pai, recusa: false));
        var item = venda.AdicionarItem(pai, 1m, "0010", Fixtures.Agora);
        Assert.Equal(pai.Produto.Id, item.ProdutoId);
        Assert.Equal(49.90m, item.ValorBruto);
    }
}
