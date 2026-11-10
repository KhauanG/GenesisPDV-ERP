using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Guarda do produto com variações no caixa (Fase 2, F2-B34; F2-Q2 = D44; PDV 10.2), no terminal de demonstração: o EAN
/// de uma variação e o do pai com variação ativa mostram a recusa, pelo bipe e pela pesquisa F2, sem abrir venda; o pai
/// sem variação ativa e o produto com complementos vendem; com <c>pdv.recusa_produto_com_variacoes</c> desligada na loja,
/// o EAN da variação vende o pai, como antes.
/// </summary>
public class VariacoesTelasTests
{
    /// <summary>A unidade "UN" do catálogo de demonstração (<c>CatalogoDemonstracao</c>).</summary>
    private static readonly Guid Un = Guid.Parse("019a0006-0000-7000-8000-000000000001");

    private static readonly Guid Camiseta = Guid.Parse("019a0034-0000-7000-8000-000000000001");
    private static readonly Guid Legado = Guid.Parse("019a0034-0000-7000-8000-000000000002");
    private static readonly Guid Porcao = Guid.Parse("019a0034-0000-7000-8000-000000000003");
    private static readonly Guid Azul = Guid.Parse("019a0034-0000-7000-8000-000000000011");

    private const string EanCamiseta = "7890000080001";
    private const string EanAzul = "7890000080018";
    private const string EanLegado = "7890000080025";
    private const string EanPorcao = "7890000080032";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Os produtos do teste no espelho do catálogo, como o pull gravaria.</summary>
    private static async Task GravarProdutosAsync(AmbienteUi pdv)
    {
        var agora = DateTimeOffset.UtcNow;
        LinhaEspelho[] linhas =
        [
            new ProdutoRegistro { Id = Camiseta, Codigo = 800, CodigoInterno = "0800", Nome = "CAMISETA ICE BEER", UnidadeId = Un, PrecoVenda = 49.90m, Tipo = TipoProduto.ComVariacoes },
            new ProdutoVariacaoRegistro { Id = Azul, ProdutoId = Camiseta, Nome = "AZUL", Ativo = true },
            new ProdutoCodigoBarrasRegistro { Id = Guid.CreateVersion7(), ProdutoId = Camiseta, Codigo = EanCamiseta, Principal = true },
            new ProdutoCodigoBarrasRegistro { Id = Guid.CreateVersion7(), ProdutoId = Camiseta, VariacaoId = Azul, Codigo = EanAzul },
            new ProdutoRegistro { Id = Legado, Codigo = 801, CodigoInterno = "0801", Nome = "CAMISA LEGADO SEM GRADE", UnidadeId = Un, PrecoVenda = 39.90m, Tipo = TipoProduto.ComVariacoes },
            new ProdutoCodigoBarrasRegistro { Id = Guid.CreateVersion7(), ProdutoId = Legado, Codigo = EanLegado, Principal = true },
            new ProdutoRegistro { Id = Porcao, Codigo = 802, CodigoInterno = "0802", Nome = "PORCAO DE FRITAS", UnidadeId = Un, PrecoVenda = 29.90m, Tipo = TipoProduto.ComComplementos },
            new ProdutoCodigoBarrasRegistro { Id = Guid.CreateVersion7(), ProdutoId = Porcao, Codigo = EanPorcao, Principal = true },
        ];
        foreach (var linha in linhas)
        {
            linha.CriadoEm = linha.AtualizadoEm = agora;
            linha.Versao = 1;
        }

        await pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(linhas, Ct);
    }

    [AvaloniaFact]
    public async Task Ean_da_variacao_e_do_pai_com_variacao_mostram_a_recusa_e_complementos_vende()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await GravarProdutosAsync(pdv);

        await pdv.EntrarCodigoAsync(EanAzul);
        await pdv.EsperarAsync(() => pdv.Texto("TextoMensagem") == GuardaVariacoes.Mensagem, "recusa da variação");
        Assert.Equal(string.Empty, venda.CodigoEntrada);
        Assert.Empty(venda.Itens);
        // A recusa não gasta o número da venda (a venda nem abre).
        Assert.True(venda.CaixaLivre);
        pdv.Captura("80-variacao-recusada");

        await pdv.EntrarCodigoAsync(EanCamiseta);
        Assert.Equal(GuardaVariacoes.Mensagem, pdv.Texto("TextoMensagem"));
        await pdv.EntrarCodigoAsync("0800");
        Assert.Equal(GuardaVariacoes.Mensagem, pdv.Texto("TextoMensagem"));
        Assert.Empty(venda.Itens);

        // O pai "Com variações" sem variação ativa (legado sem grade) e o "Com complementos" (sem os complementos) vendem.
        await pdv.EntrarCodigoAsync(EanLegado);
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "legado vendido");
        await pdv.EntrarCodigoAsync(EanPorcao);
        await pdv.EsperarAsync(() => venda.Itens.Count == 2, "porção vendida");
        Assert.Equal("69,80", pdv.Texto("TextoTotal"));
        Assert.StartsWith("VENDA L01-C02-000001", pdv.Texto("TextoCabecalhoVenda"), StringComparison.Ordinal);

        // Pela pesquisa F2: a linha aparece, e o Enter mostra a recusa no diálogo.
        pdv.Tecla(Key.F2);
        await pdv.EsperarFocoAsync("CampoPesquisa");
        pdv.Digitar("camiseta");
        var pesquisa = Assert.IsType<DialogoPesquisaViewModel>(venda.Dialogo);
        await pdv.EsperarAsync(() => pesquisa.Resultados.Count == 1, "camiseta pelo nome");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pesquisa.Erro == GuardaVariacoes.Mensagem, "recusa na pesquisa");
        Assert.Equal(2, venda.Itens.Count);
    }

    [AvaloniaFact]
    public async Task Com_a_chave_desligada_na_loja_o_ean_da_variacao_vende_o_pai()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await GravarProdutosAsync(pdv);
        var agora = DateTimeOffset.UtcNow;
        await pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [
                new ConfiguracaoRegistro
                {
                    Id = Guid.CreateVersion7(), Escopo = "loja", LojaId = CatalogoDemonstracao.LojaDemonstracao,
                    Chave = ChavesConfiguracao.RecusaProdutoComVariacoes, Valor = "false", CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
            ],
            Ct);

        await pdv.EntrarCodigoAsync(EanAzul);
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "variação vendida como o pai");
        Assert.Equal("49,90", pdv.Texto("TextoTotal"));
        await pdv.EntrarCodigoAsync(EanCamiseta);
        await pdv.EsperarAsync(() => venda.Itens.Count == 2, "pai vendido");
        Assert.NotEqual(GuardaVariacoes.Mensagem, pdv.Texto("TextoMensagem"));
    }
}
