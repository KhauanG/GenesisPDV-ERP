using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;

namespace GenesisPDV.Core.Precos;

/// <summary>Um candidato da regra 11.3 (passos 4–8).</summary>
/// <param name="Limiar">Quantidade a partir da qual o candidato vale ("12+"); nulo para varejo/loja/promocional/embalagem.</param>
public sealed record CandidatoPreco(string Origem, decimal Preco, decimal? Limiar = null);

/// <summary>Preço unitário resolvido pela regra 11.3 para uma linha.</summary>
/// <param name="Preco">Preço unitário; na embalagem é <c>preco ÷ fator</c> sem arredondar (o valor da linha é o da embalagem).</param>
/// <param name="PrecoVarejo">Varejo (loja ?? produto), exibido riscado ao lado do preço de atacado/mix.</param>
/// <param name="QuantidadeReferencia">Snapshot de <c>quantidade_referencia_preco</c> (Q ou <c>qtd_grupo</c> usados).</param>
/// <param name="GrupoId">Snapshot de <c>grupo_preco_quantidade_id</c> quando a soma do grupo definiu o preço.</param>
/// <param name="Limiar">A quantidade da faixa/atacado aplicada ("12" de "ATAC 12+").</param>
/// <param name="GrupoNome">Nome do grupo (mix) para "MIX 12+" e o cupom.</param>
public sealed record PrecoResolvido(
    decimal Preco,
    string Origem,
    decimal PrecoVarejo,
    decimal? QuantidadeReferencia,
    Guid? GrupoId,
    decimal? Limiar,
    string? GrupoNome,
    IReadOnlyList<CandidatoPreco> Candidatos);

/// <summary>Dica da barra de status: "Faltam 3 para o preço de atacado…" (PDV 11.3.1, informativa).</summary>
public sealed record DicaFaixa(decimal Faltam, decimal Preco, string Origem, string? GrupoNome);

/// <summary>
/// Regra oficial de preço (PDV 11.3/11.3.1): vale o <b>menor</b> candidato, nunca uma prioridade entre cadastros.
/// Pura e determinística — a <see cref="Venda"/> soma as quantidades de referência e aplica o resultado.
/// </summary>
public static class MotorPreco
{
    /// <summary>Desempate do passo 10: embalagem &gt; promocional &gt; grupo_mix &gt; quantidade &gt; atacado &gt; loja &gt; varejo.</summary>
    private static readonly string[] OrdemDesempate =
    [
        OrigemPreco.Embalagem, OrigemPreco.Promocional, OrigemPreco.GrupoMix, OrigemPreco.Quantidade,
        OrigemPreco.Atacado, OrigemPreco.Loja, OrigemPreco.Varejo,
    ];

    /// <summary>
    /// Resolve o preço unitário de uma linha.
    /// </summary>
    /// <param name="qtdTotal">Soma, em unidade base, das linhas que contam do mesmo produto na venda.</param>
    /// <param name="qtdGrupo">Soma das linhas que contam de todos os membros do grupo ativo do produto; nulo sem grupo.</param>
    /// <param name="embalagem">Embalagem lida na linha (fardo); o preço dela entra como candidato (passo 8).</param>
    public static PrecoResolvido Resolver(
        ProdutoVenda produto,
        bool promocaoVigente,
        decimal qtdTotal,
        decimal? qtdGrupo,
        EmbalagemPreco? embalagem,
        ParametrosPreco parametros)
    {
        ArgumentNullException.ThrowIfNull(produto);
        ArgumentNullException.ThrowIfNull(parametros);
        var t = produto.Precos ?? new TabelaPreco();
        var grupo = t.GrupoAtivo;
        var somaDoGrupo = grupo is not null && qtdGrupo is not null;
        var q = somaDoGrupo && grupo!.Modo == ModoPrecoGrupo.Produto ? qtdGrupo!.Value : qtdTotal;

        var candidatos = new List<CandidatoPreco>
        {
            new(t.PrecoVendaLoja is not null ? OrigemPreco.Loja : OrigemPreco.Varejo, produto.PrecoBase),
        };

        if (promocaoVigente && t.PrecoPromocional is > 0m and var promocional)
        {
            candidatos.Add(new CandidatoPreco(OrigemPreco.Promocional, promocional));
        }

        if (parametros.UsaPrecoVolume && Faixa(t.Faixas, q, parametros.LojaId) is { } faixa)
        {
            candidatos.Add(new CandidatoPreco(OrigemPreco.Quantidade, faixa.Preco, faixa.QuantidadeInicial));
        }

        if (parametros.UsaPrecoVolume && somaDoGrupo && grupo!.Modo == ModoPrecoGrupo.Grupo
            && Faixa(grupo.Faixas, qtdGrupo!.Value, parametros.LojaId) is { } faixaGrupo)
        {
            candidatos.Add(new CandidatoPreco(OrigemPreco.GrupoMix, faixaGrupo.Preco, faixaGrupo.QuantidadeInicial));
        }

        if (t.PrecoAtacado is > 0m and var atacado)
        {
            if (parametros.TipoPreco == "atacado")
            {
                candidatos.Add(new CandidatoPreco(OrigemPreco.Atacado, atacado));
            }
            else if (t.QtdMinimaAtacado is { } minimo && q >= minimo)
            {
                candidatos.Add(new CandidatoPreco(OrigemPreco.Atacado, atacado, minimo));
            }
        }

        if (embalagem is { Preco: { } precoEmbalagem, Fator: > 0m })
        {
            candidatos.Add(new CandidatoPreco(OrigemPreco.Embalagem, precoEmbalagem / embalagem.Fator));
        }

        var vencedor = candidatos
            .OrderBy(c => c.Preco)
            .ThenBy(c => Array.IndexOf(OrdemDesempate, c.Origem))
            .First();

        decimal? referencia = null;
        Guid? grupoId = null;
        string? grupoNome = null;
        if (vencedor.Origem == OrigemPreco.GrupoMix)
        {
            referencia = qtdGrupo;
            grupoId = grupo!.Id;
            grupoNome = grupo.Nome;
        }
        else if (OrigemPreco.PorQuantidade(vencedor.Origem))
        {
            referencia = q;
            if (somaDoGrupo && grupo!.Modo == ModoPrecoGrupo.Produto)
            {
                grupoId = grupo.Id;
                grupoNome = grupo.Nome;
            }
        }

        return new PrecoResolvido(vencedor.Preco, vencedor.Origem, produto.PrecoBase, referencia, grupoId, vencedor.Limiar, grupoNome, candidatos);
    }

    /// <summary>
    /// Preço sem quantidade (combo e casco): varejo/loja ou promocional, o menor (PDV 10.9.1 e 10.12 — o kit e o casco
    /// não participam de atacado, faixas nem mix).
    /// </summary>
    public static CandidatoPreco PrecoSemQuantidade(ProdutoVenda produto, bool promocaoVigente)
    {
        ArgumentNullException.ThrowIfNull(produto);
        var t = produto.Precos;
        var baseCandidato = new CandidatoPreco(t?.PrecoVendaLoja is not null ? OrigemPreco.Loja : OrigemPreco.Varejo, produto.PrecoBase);
        return promocaoVigente && t?.PrecoPromocional is > 0m and var p && p <= produto.PrecoBase
            ? new CandidatoPreco(OrigemPreco.Promocional, p)
            : baseCandidato;
    }

    /// <summary>
    /// A faixa que vale para <paramref name="quantidade"/>: a da loja prevalece sobre a geral; entre faixas que se
    /// tocam no limite (final de uma = início da outra), vale a de maior <c>quantidade_inicial</c>.
    /// </summary>
    public static FaixaPreco? Faixa(IReadOnlyList<FaixaPreco>? faixas, decimal quantidade, Guid lojaId)
    {
        if (faixas is null || faixas.Count == 0 || quantidade <= 0m)
        {
            return null;
        }

        return faixas.Where(f => f.LojaId == lojaId && f.Contem(quantidade)).MaxBy(f => f.QuantidadeInicial)
               ?? faixas.Where(f => f.LojaId is null && f.Contem(quantidade)).MaxBy(f => f.QuantidadeInicial);
    }

    /// <summary>
    /// Próximo preço menor alcançável aumentando a quantidade, quando a falta é de no máximo metade do limiar
    /// ("Faltam 3 para o preço de atacado de CERV BRAHMA LT (R$ 3,19)"). Nulo se não há.
    /// </summary>
    public static DicaFaixa? ProximaFaixa(
        ProdutoVenda produto,
        bool promocaoVigente,
        decimal qtdTotal,
        decimal? qtdGrupo,
        ParametrosPreco parametros)
    {
        ArgumentNullException.ThrowIfNull(produto);
        var atual = Resolver(produto, promocaoVigente, qtdTotal, qtdGrupo, null, parametros);
        var t = produto.Precos ?? new TabelaPreco();
        var grupo = t.GrupoAtivo;
        var porGrupo = grupo is not null && qtdGrupo is not null;
        var q = porGrupo && grupo!.Modo == ModoPrecoGrupo.Produto ? qtdGrupo!.Value : qtdTotal;

        // (quanto falta, limiar absoluto): a dica aparece quando falta no máximo metade do limiar.
        var alvos = new List<(decimal Faltam, decimal Limiar)>();
        if (t.PrecoAtacado is > 0m && t.QtdMinimaAtacado is { } minimo && minimo > q)
        {
            alvos.Add((minimo - q, minimo));
        }

        if (parametros.UsaPrecoVolume)
        {
            foreach (var f in t.Faixas ?? [])
            {
                if ((f.LojaId is null || f.LojaId == parametros.LojaId) && f.QuantidadeInicial > q)
                {
                    alvos.Add((f.QuantidadeInicial - q, f.QuantidadeInicial));
                }
            }

            if (porGrupo && grupo!.Modo == ModoPrecoGrupo.Grupo)
            {
                foreach (var f in grupo.Faixas ?? [])
                {
                    if ((f.LojaId is null || f.LojaId == parametros.LojaId) && f.QuantidadeInicial > qtdGrupo!.Value)
                    {
                        alvos.Add((f.QuantidadeInicial - qtdGrupo.Value, f.QuantidadeInicial));
                    }
                }
            }
        }

        foreach (var (faltam, limiar) in alvos.OrderBy(a => a.Faltam))
        {
            if (faltam * 2m > limiar)
            {
                continue;
            }

            var depois = Resolver(
                produto, promocaoVigente, qtdTotal + faltam, qtdGrupo is { } g ? g + faltam : null, null, parametros);
            if (depois.Preco < atual.Preco && OrigemPreco.PorQuantidade(depois.Origem))
            {
                return new DicaFaixa(faltam, Arredondamento.Arred4(depois.Preco), depois.Origem, depois.GrupoNome);
            }
        }

        return null;
    }
}
