using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;

namespace GenesisPDV.Core.Tests;

/// <summary>Produtos dos exemplos do dono e da especificação (PDV 10.9.1, 10.12, 11.3.1, 11.5).</summary>
internal static class CatalogoTeste
{
    public static readonly Guid Loja1 = Fixtures.Contexto.LojaId;
    public static readonly Guid Loja2 = Guid.Parse("01a18752-0000-7000-8000-000000000002");
    public static readonly Guid MixId = Guid.Parse("01a19000-0000-7000-8000-000000000001");

    public static ContextoVenda ContextoVolume(Guid? loja = null) =>
        Fixtures.Contexto with { UsaPrecoVolume = true, LojaId = loja ?? Loja1 };

    public static Venda VendaPreco(bool usaPrecoVolume = false, Guid? loja = null) =>
        Venda.Iniciar(Guid.CreateVersion7(), 1, usaPrecoVolume ? ContextoVolume(loja) : Fixtures.Contexto with { LojaId = loja ?? Loja1 },
            Fixtures.Operador, Fixtures.Agora);

    public static ProdutoVenda Produto(
        string descricao,
        decimal preco,
        TabelaPreco? precos = null,
        string tipo = TipoProduto.Simples,
        string unidade = "UN",
        Guid? id = null) =>
        new(id ?? Guid.CreateVersion7(), 1, null, descricao, unidade, preco) { Precos = precos, Tipo = tipo };

    public static GrupoPrecoQuantidade Mix(ModoPrecoGrupo modo, decimal? precoFaixa12 = null, bool ativo = true) =>
        new(MixId, "MIX LATAS 350ML", modo, ativo, precoFaixa12 is { } p ? [new FaixaPreco(12m, null, p)] : []);

    /// <summary>Brahma 3,49 com atacado 12+ a 3,19 (o exemplo da especificação).</summary>
    public static ProdutoVenda Brahma(GrupoPrecoQuantidade? grupo = null, IReadOnlyList<FaixaPreco>? faixas = null, IReadOnlyList<EmbalagemPreco>? embalagens = null) =>
        Produto("CERV BRAHMA LT 350ML", 3.49m, new TabelaPreco(PrecoAtacado: 3.19m, QtdMinimaAtacado: 12m, Grupo: grupo, Faixas: faixas, Embalagens: embalagens));

    public static ProdutoVenda Skol(GrupoPrecoQuantidade? grupo = null) =>
        Produto("CERV SKOL LT 350ML", 2.99m, new TabelaPreco(PrecoAtacado: 2.79m, QtdMinimaAtacado: 12m, Grupo: grupo));

    public static ProdutoVenda Antarctica(GrupoPrecoQuantidade? grupo = null) =>
        Produto("CERV ANTARCTICA LT 350ML", 3.29m, new TabelaPreco(PrecoAtacado: 2.99m, QtdMinimaAtacado: 12m, Grupo: grupo));

    public static ProdutoResolvido Lido(ProdutoVenda produto) => new(produto);

    public static ProdutoResolvido Fardo(ProdutoVenda produto, Guid codigoBarrasId, decimal fator, decimal? preco) =>
        new(produto, codigoBarrasId, fator, preco, "FD");

    // ------------------------------------------------ combo do dono: COMBO DE WHISKY 1L

    public static readonly Guid PosicaoWhisky = Guid.Parse("01a18773-0000-7000-8000-000000000001");
    public static readonly Guid PosicaoEnergetico = Guid.Parse("01a18773-0000-7000-8000-000000000002");
    public static readonly Guid PosicaoGelo = Guid.Parse("01a18773-0000-7000-8000-000000000003");
    public static readonly Guid AlternativaMonster = Guid.Parse("01a18776-0000-7000-8000-000000000001");
    public static readonly Guid AlternativaFusion = Guid.Parse("01a18776-0000-7000-8000-000000000002");

    public static readonly ProdutoVenda Whisky = Produto("WHISKY 1L", 99.90m);
    public static readonly ProdutoVenda RedBull = Produto("ENERGETICO RED BULL 2L", 22.90m);
    public static readonly ProdutoVenda Monster = Produto("ENERGETICO MONSTER 2L", 24.90m);
    public static readonly ProdutoVenda Fusion = Produto("ENERGETICO FUSION 2L", 19.90m);
    public static readonly ProdutoVenda GeloCoco = Produto("GELO DE COCO", 4.50m);
    public static readonly ProdutoVenda GeloMelancia = Produto("GELO DE MELANCIA", 4.50m);

    public static ComboResolvido ComboWhisky(decimal preco = 129.90m, TabelaPreco? precosKit = null, bool monsterDisponivel = true) => new(
        Produto("COMBO DE WHISKY 1L", preco, precosKit, TipoProduto.Kit),
        [
            new PosicaoCombo(PosicaoWhisky, "Whisky 1L", 1m, 1, [new OpcaoCombo(null, Whisky)]),
            new PosicaoCombo(PosicaoEnergetico, "Energético 2L", 1m, 2,
            [
                new OpcaoCombo(null, RedBull),
                new OpcaoCombo(AlternativaMonster, Monster, 2.00m, monsterDisponivel, monsterDisponivel ? null : "sem estoque"),
                new OpcaoCombo(AlternativaFusion, Fusion),
            ]),
            new PosicaoCombo(PosicaoGelo, "Gelo de sabor", 2m, 3,
            [
                new OpcaoCombo(null, GeloCoco),
                new OpcaoCombo(Guid.CreateVersion7(), GeloMelancia),
            ]),
        ]);

    // ------------------------------------------------ retornável (10.12)

    public static readonly ProdutoVenda Garrafa = Produto("GARRAFA 600ML RETORNÁVEL", 2.50m, tipo: TipoProduto.Vasilhame);

    public static ProdutoVenda Original600(TabelaPreco? precos = null) =>
        Produto("CERV ORIGINAL 600ML RET", 9.90m, precos) with { VasilhameProdutoId = Garrafa.Id, VasilhameQuantidade = 1 };
}
