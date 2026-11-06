#if MODO_DEMONSTRACAO
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// Carga de demonstração dos espelhos do catálogo (só em <c>MODO_DEMONSTRACAO</c>, fora de todo <c>dotnet publish</c>):
/// grava no SQLite as mesmas tabelas que o fluxo <c>catalogo</c> do pull vai preencher, para a tela de venda já ler o
/// catálogo local. Mostra varejo, preço da loja, atacado por quantidade, faixas (Usa Produto Preço Volume), fardo com
/// preço, grupo de preço por quantidade (mix), combo com troca de componente e retornável com casco.
/// </summary>
public static class CatalogoDemonstracao
{
    public static readonly Guid LojaDemonstracao = Guid.Parse("019a0005-0000-7000-8000-000000000001");

    private static readonly Guid Un = Guid.Parse("019a0006-0000-7000-8000-000000000001");
    private static readonly Guid Kg = Guid.Parse("019a0006-0000-7000-8000-000000000002");
    private static readonly Guid Fd = Guid.Parse("019a0006-0000-7000-8000-000000000003");
    private static readonly Guid Cx = Guid.Parse("019a0006-0000-7000-8000-000000000004");
    private static readonly Guid MixLatas = Guid.Parse("019a0007-0000-7000-8000-000000000001");

    public static Guid Produto(int codigo) => Guid.Parse($"019a0001-0000-7000-8000-{codigo:000000000000}");

    /// <summary><c>configuracoes</c> da loja de demonstração: "Usa Produto Preço Volume" ligado (faixas e mix modo grupo).</summary>
    private static readonly Guid ConfigUsaPrecoVolume = Guid.Parse("019a0008-0000-7000-8000-000000000001");

    /// <summary>
    /// Grava a carga quando o catálogo local está vazio e as configurações da loja de demonstração sempre (terminais
    /// de demonstração antigos não tinham o espelho <c>configuracoes</c>). Idempotente (upsert por id, versão 1).
    /// </summary>
    public static async Task GarantirAsync(RepositorioEspelhos espelhos, DateTimeOffset agora, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(espelhos);
        if (await espelhos.CatalogoVazioAsync(ct))
        {
            await espelhos.GravarAsync(Linhas(agora), ct);
        }

        await espelhos.GravarAsync(Configuracoes(agora), ct);
    }

    public static IReadOnlyList<LinhaEspelho> Configuracoes(DateTimeOffset agora) =>
    [
        new ConfiguracaoRegistro
        {
            Id = ConfigUsaPrecoVolume, Escopo = "loja", LojaId = LojaDemonstracao, Chave = ChavesConfiguracao.UsaPrecoVolume,
            Valor = "true", CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
        },
    ];

    public static IReadOnlyList<LinhaEspelho> Linhas(DateTimeOffset agora)
    {
        var linhas = new List<LinhaEspelho>
        {
            Unidade(Un, "UN", "Unidade", false),
            Unidade(Kg, "KG", "Quilograma", true),
            Unidade(Fd, "FD", "Fardo", false),
            Unidade(Cx, "CX", "Caixa", false),
            new GrupoPrecoQuantidadeRegistro { Id = MixLatas, Codigo = 1, Nome = "MIX LATAS 350ML", ModoPreco = "produto" },
            new FormaPagamentoRegistro
            {
                Id = ServicoVenda.Dinheiro.Id, Descricao = "Dinheiro", Ordem = 1, TipoForma = "dinheiro", MeioPagamentoFiscal = "01",
                LancaQuitada = true, PermiteTroco = true, AbrirGaveta = true,
            },
            // Vale em todas as lojas (vínculo de loja nula, Fase 1C C8b).
            new FormaPagamentoLojaRegistro { Id = Id(12, 1), FormaPagamentoId = ServicoVenda.Dinheiro.Id },
        };

        // Latas do mix (modo produto): a soma das latas ativa o atacado de cada uma (6 Brahma + 6 Skol = 12).
        linhas.Add(P(123, "0123", "CERV BRAHMA LT 350ML", 3.49m, p =>
        {
            p.PrecoAtacado = 3.19m;
            p.QtdMinimaAtacado = 12m;
            p.GrupoPrecoQuantidadeId = MixLatas;
            p.IdadeMinima = 18;
        }));
        linhas.Add(P(125, "0125", "CERV SKOL LT 350ML", 2.99m, p =>
        {
            p.PrecoAtacado = 2.79m;
            p.QtdMinimaAtacado = 12m;
            p.GrupoPrecoQuantidadeId = MixLatas;
            p.IdadeMinima = 18;
        }));
        linhas.Add(P(126, "0126", "CERV ANTARCTICA LT 350ML", 3.29m, p =>
        {
            p.PrecoAtacado = 2.99m;
            p.QtdMinimaAtacado = 12m;
            p.GrupoPrecoQuantidadeId = MixLatas;
            p.IdadeMinima = 18;
        }));
        linhas.Add(Barras(1, 123, "7891149103102", principal: true));
        linhas.Add(Barras(2, 123, "17891149103109", fator: 12m, preco: 37.90m, unidade: Fd, descricao: "Fardo 12 un"));
        linhas.Add(Barras(9, 125, "7891991010856", principal: true));
        linhas.Add(Barras(10, 126, "7891991000826", principal: true));

        // Faixas por quantidade (Usa Produto Preço Volume): geral 6+ e, na loja de demonstração, 12+.
        linhas.Add(P(201, "0201", "ÁGUA CRYSTAL 500ML", 2.50m));
        linhas.Add(Barras(3, 201, "7896045506873", principal: true));
        linhas.Add(new ProdutoPrecoQuantidadeRegistro { Id = Id(8, 1), ProdutoId = Produto(201), QuantidadeInicial = 6m, QuantidadeFinal = 11m, Preco = 2.29m });
        linhas.Add(new ProdutoPrecoQuantidadeRegistro { Id = Id(8, 2), ProdutoId = Produto(201), LojaId = LojaDemonstracao, QuantidadeInicial = 12m, Preco = 1.99m });

        linhas.Add(P(310, "0310", "REFRI COCA-COLA 2L", 9.99m));
        linhas.Add(Barras(4, 310, "7894900027013", principal: true));
        linhas.Add(P(44, "0044", "GELO ESCAMA 5KG", 12.90m));
        linhas.Add(P(50, "0050", "QUEIJO COALHO KG", 19.99m, p =>
        {
            p.UnidadeId = Kg;
            p.PermiteFracao = true;
        }));
        linhas.Add(P(77, "0077", "CARVÃO VEGETAL 3KG", 18.90m));
        linhas.Add(Barras(5, 77, "7896005800010", principal: true));
        linhas.Add(P(88, "0088", "AMENDOIM JAPONÊS 150G", 6.75m));
        linhas.Add(Barras(6, 88, "7896336000561", principal: true));

        // Preço da loja (produtos_lojas.preco_venda) menor que o geral.
        linhas.Add(P(124, "0124", "CERV HEINEKEN LN 330ML", 6.99m, p => p.IdadeMinima = 18));
        linhas.Add(Barras(7, 124, "7896045504831", principal: true));
        linhas.Add(new ProdutoLojaRegistro { Id = Id(9, 1), ProdutoId = Produto(124), LojaId = LojaDemonstracao, PrecoVenda = 6.49m });

        linhas.Add(P(999, "0999", "PRODUTO FORA DE LINHA", 1.00m, p => p.Ativo = false));
        linhas.Add(Barras(8, 999, "7890000009999", principal: true));

        // Retornável: cerveja 600 ml com casco (PDV 10.12) e engradado de 24 lido pelo DUN.
        linhas.Add(P(601, "0601", "GARRAFA 600ML RETORNÁVEL", 2.50m, p =>
        {
            p.Tipo = "vasilhame";
            p.Ncm = "70109021";
        }));
        linhas.Add(P(600, "0600", "CERV ORIGINAL 600ML RET", 9.90m, p =>
        {
            p.VasilhameProdutoId = Produto(601);
            p.VasilhameQuantidade = 1;
            p.IdadeMinima = 18;
        }));
        linhas.Add(Barras(11, 600, "7891991015301", principal: true));
        linhas.Add(Barras(12, 600, "17891991015308", fator: 24m, unidade: Cx, descricao: "Engradado 24 un"));

        // Combo com troca de componente (10.9.1): o exemplo do dono.
        linhas.Add(P(501, "0501", "WHISKY 1L", 99.90m, p => p.IdadeMinima = 18));
        linhas.Add(P(502, "0502", "ENERGETICO RED BULL 2L", 22.90m));
        linhas.Add(P(503, "0503", "ENERGETICO MONSTER 2L", 24.90m));
        linhas.Add(P(504, "0504", "ENERGETICO FUSION 2L", 19.90m));
        linhas.Add(P(505, "0505", "GELO DE COCO", 4.50m));
        linhas.Add(P(506, "0506", "GELO DE MELANCIA", 4.50m));
        linhas.Add(P(507, "0507", "GELO DE MARACUJA", 4.50m));
        linhas.Add(P(500, "0500", "COMBO DE WHISKY 1L", 129.90m, p => p.Tipo = "kit"));
        linhas.Add(Barras(13, 500, "7890000005003", principal: true));
        linhas.Add(Posicao(1, 500, 501, 1m, 1, null, false));
        linhas.Add(Posicao(2, 500, 502, 1m, 2, "Energético 2L", true));
        linhas.Add(Posicao(3, 500, 505, 2m, 3, "Gelo de sabor", true));
        linhas.Add(Alternativa(1, 2, 503, 2.00m, 1));
        linhas.Add(Alternativa(2, 2, 504, 0m, 2));
        linhas.Add(Alternativa(3, 3, 506, 0m, 1));
        linhas.Add(Alternativa(4, 3, 507, 0m, 2));

        // Combo sem alternativas: inclui direto, sem diálogo.
        linhas.Add(P(510, "0510", "KIT CHURRASCO", 49.90m, p => p.Tipo = "kit"));
        linhas.Add(Posicao(4, 510, 77, 1m, 1, null, false));
        linhas.Add(Posicao(5, 510, 44, 1m, 2, null, false));
        linhas.Add(Posicao(6, 510, 123, 6m, 3, null, false));

        foreach (var linha in linhas)
        {
            linha.CriadoEm = linha.AtualizadoEm = agora;
            linha.Versao = 1;
        }

        return linhas;
    }

    private static Guid Id(int tabela, int n) => Guid.Parse($"019a{tabela:0000}-0000-7000-8000-{n:000000000000}");

    private static UnidadeMedidaRegistro Unidade(Guid id, string sigla, string descricao, bool fracao) =>
        new() { Id = id, Sigla = sigla, Descricao = descricao, PermiteFracao = fracao, Sistema = true };

    private static ProdutoRegistro P(int codigo, string interno, string nome, decimal preco, Action<ProdutoRegistro>? ajustar = null)
    {
        var p = new ProdutoRegistro { Id = Produto(codigo), Codigo = codigo, CodigoInterno = interno, Nome = nome, UnidadeId = Un, PrecoVenda = preco };
        ajustar?.Invoke(p);
        return p;
    }

    private static ProdutoCodigoBarrasRegistro Barras(
        int n, int produto, string codigo, bool principal = false, decimal fator = 1m, decimal? preco = null, Guid? unidade = null, string? descricao = null) =>
        new()
        {
            Id = Id(2, n),
            ProdutoId = Produto(produto),
            Codigo = codigo,
            Principal = principal,
            Fator = fator,
            Preco = preco,
            UnidadeId = unidade,
            Descricao = descricao,
            Tipo = "gtin",
        };

    private static ProdutoComponenteRegistro Posicao(int n, int kit, int padrao, decimal quantidade, int ordem, string? rotulo, bool troca) =>
        new()
        {
            Id = Id(10, n),
            ProdutoId = Produto(kit),
            Tipo = "kit",
            ComponenteId = Produto(padrao),
            Quantidade = quantidade,
            Ordem = ordem,
            RotuloPosicao = rotulo,
            PermiteSubstituicao = troca,
        };

    private static ProdutoComponenteAlternativaRegistro Alternativa(int n, int posicao, int produto, decimal acrescimo, int ordem) =>
        new() { Id = Id(11, n), ComponenteId = Id(10, posicao), ProdutoId = Produto(produto), Acrescimo = acrescimo, Ordem = ordem };
}
#endif
