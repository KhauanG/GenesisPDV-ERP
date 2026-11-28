using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Vendas;

namespace GenesisPDV.Core.Produtos;

/// <summary>
/// Grupo de complementos do produto <c>com_complementos</c> (<c>produtos_grupos_complementos</c>, MD 3.6.8; PDV 10.2;
/// Fase 3, F3-B15): "Molhos", "Adicionais". Só os grupos vivos com ao menos uma opção ativa descem ao diálogo.
/// </summary>
/// <param name="Minimo">Opções que a unidade do item leva no mínimo (o obrigatório leva ao menos 1, <see cref="MinimoEfetivo"/>).</param>
/// <param name="Maximo">
/// Opções no máximo. Pela F3-Q4 (D75, decidida pelo dono pela recomendação): cada opção vale 0 ou 1 vez por unidade do
/// item, e o máximo conta opções diferentes ("2 molhos" são dois molhos diferentes).
/// </param>
public sealed record GrupoComplementos(
    Guid Id,
    string Nome,
    int Minimo,
    int Maximo,
    bool Obrigatorio,
    int Ordem,
    IReadOnlyList<OpcaoComplemento> Opcoes)
{
    /// <summary>O obrigatório leva ao menos 1 mesmo com o mínimo 0 (a nuvem já recusa esse cadastro, a defesa fica aqui).</summary>
    public int MinimoEfetivo => Obrigatorio ? Math.Max(1, Minimo) : Math.Max(0, Minimo);

    /// <summary>"Escolha 1", "Escolha de 1 a 2", "Opcional, até 3": a regra do grupo no diálogo.</summary>
    public string Regra => (MinimoEfetivo, Maximo) switch
    {
        (0, 1) => "Opcional, até 1",
        (0, var max) => $"Opcional, até {max}",
        (var min, var max) when min == max => $"Escolha {min}",
        (var min, var max) => $"Escolha de {min} a {max}",
    };
}

/// <summary>
/// Opção ativa de um grupo (<c>produtos_complementos</c>, MD 3.6.8): livre (só a <see cref="Descricao"/>) ou vinculada a
/// um produto (<see cref="ProdutoId"/>). O <see cref="PrecoAdicional"/> soma por unidade ao preço do item (Padrões da
/// Fase 3: "o adicional entra no <c>preco_unitario</c> e no <c>preco_tabela</c>").
/// </summary>
/// <param name="Descricao">O texto gravado em <c>itens_venda_complementos.descricao</c> (o da opção, ou o nome do vinculado).</param>
/// <param name="BaixaEstoque"><c>produtos_complementos.baixa_estoque</c>: o vinculado baixa estoque na nuvem (F3-B14).</param>
/// <param name="QuantidadeBaixa">Quanto do vinculado sai por unidade do complemento (<c>quantidade_baixa</c>).</param>
public sealed record OpcaoComplemento(
    Guid Id,
    string Descricao,
    decimal PrecoAdicional,
    Guid? ProdutoId = null,
    bool BaixaEstoque = false,
    decimal QuantidadeBaixa = 1m,
    int Ordem = 0)
{
    /// <summary>
    /// Ficha técnica do vinculado <c>produzido</c> (PDV 10.9.2): o caixa calcula os insumos da baixa, como a ficha do
    /// item (D17), e manda na <c>componentes_estoque</c> da linha do complemento (v2, SYNC 9.7). Nula nos demais.
    /// </summary>
    public IReadOnlyList<ComponenteFicha>? FichaVinculado { get; init; }

    /// <summary>O vinculado tem saldo próprio no caixa (simples ou matéria-prima com <c>controla_estoque</c>, PDV 29.1).</summary>
    public bool VinculadoComSaldo { get; init; }
}

/// <summary>Uma opção escolhida no diálogo, com o grupo dela, já na ordem do cadastro (grupo, depois opção).</summary>
public sealed record EscolhaComplemento(GrupoComplementos Grupo, OpcaoComplemento Opcao);

/// <summary>
/// Regras da escolha dos complementos (PDV 10.2; F3-B15), as mesmas no diálogo e na venda: cada opção no máximo uma vez
/// (F3-Q4 = D75), só opções dos grupos do produto, e em cada grupo entre o <see cref="GrupoComplementos.MinimoEfetivo"/>
/// e o <see cref="GrupoComplementos.Maximo"/>.
/// </summary>
public static class RegrasComplementos
{
    /// <summary><c>itens_venda_complementos.grupo_nome</c> (varchar 40) e <c>descricao</c> (varchar 60), como no contrato.</summary>
    public const int GrupoNomeMaximo = 40;

    public const int DescricaoMaximo = 60;

    /// <summary>
    /// O produto tem complementos a escolher: tipo <c>com_complementos</c> e ao menos um grupo com opção. Sem isso (o
    /// cadastro sem grupo, ou só com opções inativas) ele vende como antes, sem diálogo.
    /// </summary>
    public static bool TemComplementos(ProdutoVenda produto)
    {
        ArgumentNullException.ThrowIfNull(produto);
        return produto.Tipo == TipoProduto.ComComplementos && produto.GruposComplementos?.Any(g => g.Opcoes.Count > 0) == true;
    }

    /// <summary>
    /// Confere a escolha e devolve as opções na ordem do cadastro. Recusa (<see cref="RegraNegocioException"/>) a opção
    /// repetida ou de fora do produto, o grupo abaixo do mínimo ou acima do máximo e o adicional inválido.
    /// </summary>
    public static IReadOnlyList<EscolhaComplemento> Conferir(ProdutoVenda produto, IReadOnlyCollection<Guid> opcoes)
    {
        ArgumentNullException.ThrowIfNull(produto);
        ArgumentNullException.ThrowIfNull(opcoes);
        if (!TemComplementos(produto))
        {
            throw new RegraNegocioException($"{produto.Descricao} não tem complementos a escolher.");
        }

        if (opcoes.Distinct().Count() != opcoes.Count)
        {
            throw new RegraNegocioException("Cada complemento entra uma vez só por unidade do item.");
        }

        var grupos = produto.GruposComplementos!.OrderBy(g => g.Ordem).ThenBy(g => g.Nome, StringComparer.Ordinal).ToList();
        var conhecidas = grupos.SelectMany(g => g.Opcoes.Select(o => o.Id)).ToHashSet();
        if (opcoes.Any(o => !conhecidas.Contains(o)))
        {
            throw new RegraNegocioException("Complemento fora do cadastro deste produto — escolha de novo.");
        }

        var escolhidas = new List<EscolhaComplemento>();
        foreach (var grupo in grupos)
        {
            var doGrupo = grupo.Opcoes.Where(o => opcoes.Contains(o.Id)).OrderBy(o => o.Ordem).ThenBy(o => o.Descricao, StringComparer.Ordinal).ToList();
            if (MotivoDoGrupo(grupo, doGrupo.Count) is { } motivo)
            {
                throw new RegraNegocioException(motivo);
            }

            foreach (var opcao in doGrupo)
            {
                if (opcao.PrecoAdicional < 0m || !Arredondamento.CabeEm(opcao.PrecoAdicional, Arredondamento.CasasPreco))
                {
                    throw new RegraNegocioException($"Adicional do complemento {opcao.Descricao} inválido — procure o gerente.");
                }

                escolhidas.Add(new EscolhaComplemento(grupo, opcao));
            }
        }

        return escolhidas;
    }

    /// <summary>
    /// O que falta (ou sobra) no grupo com <paramref name="escolhidas"/> opções marcadas; nulo quando está certo. É a
    /// mensagem do diálogo ao confirmar o grupo e a da venda.
    /// </summary>
    public static string? MotivoDoGrupo(GrupoComplementos grupo, int escolhidas)
    {
        ArgumentNullException.ThrowIfNull(grupo);
        if (grupo.MinimoEfetivo > grupo.Opcoes.Count)
        {
            return $"\"{grupo.Nome}\" pede {grupo.MinimoEfetivo} opção(ões) e só tem {grupo.Opcoes.Count} ativa(s) — procure o gerente.";
        }

        if (escolhidas < grupo.MinimoEfetivo)
        {
            return grupo.MinimoEfetivo == 1
                ? $"Escolha ao menos 1 opção em \"{grupo.Nome}\"."
                : $"Escolha ao menos {grupo.MinimoEfetivo} opções em \"{grupo.Nome}\".";
        }

        return escolhidas > grupo.Maximo
            ? $"\"{grupo.Nome}\": no máximo {grupo.Maximo} {(grupo.Maximo == 1 ? "opção" : "opções")}."
            : null;
    }

    /// <summary>
    /// A opção de cada escolha como o snapshot da venda a tem (<paramref name="snapshot"/>, os grupos da primeira inclusão
    /// do produto, PDV 11.3): o preço e a baixa da linha saem da mesma opção, como o preço e a ficha do item (D17). A
    /// escolha é conferida contra o cadastro lido agora (o que o diálogo mostrou: grupos, mínimo, máximo e opções ativas);
    /// a opção que o snapshot não tem (cadastrada no meio da venda) vale como veio e entra no snapshot (<see cref="Juntar"/>).
    /// </summary>
    public static IReadOnlyList<EscolhaComplemento> DoSnapshot(IReadOnlyList<EscolhaComplemento> escolhas, IReadOnlyList<GrupoComplementos>? snapshot)
    {
        ArgumentNullException.ThrowIfNull(escolhas);
        if (snapshot is not { Count: > 0 })
        {
            return escolhas;
        }

        return escolhas
            .Select(e =>
            {
                if (snapshot.SelectMany(g => g.Opcoes).FirstOrDefault(o => o.Id == e.Opcao.Id) is not { } antiga || ReferenceEquals(antiga, e.Opcao))
                {
                    return e;
                }

                if (antiga.PrecoAdicional < 0m || !Arredondamento.CabeEm(antiga.PrecoAdicional, Arredondamento.CasasPreco))
                {
                    throw new RegraNegocioException($"Adicional do complemento {antiga.Descricao} inválido — procure o gerente.");
                }

                return e with { Opcao = antiga };
            })
            .ToList();
    }

    /// <summary>
    /// Linhas do item a partir da escolha: quantidade 1 por unidade do item (F3-Q4) e os textos no tamanho das colunas. Os
    /// ids seguem a ordem da escolha (<see cref="IdsEmOrdem"/>), e é por eles que a venda relida do banco devolve a ordem.
    /// </summary>
    public static IReadOnlyList<ComplementoItem> Linhas(IReadOnlyList<EscolhaComplemento> escolhas)
    {
        ArgumentNullException.ThrowIfNull(escolhas);
        var ids = IdsEmOrdem(escolhas.Count);
        return escolhas
            .Select((e, n) => new ComplementoItem(
                ids[n], e.Opcao.Id, Cortar(e.Grupo.Nome, GrupoNomeMaximo), Cortar(e.Opcao.Descricao, DescricaoMaximo), 1m,
                e.Opcao.PrecoAdicional))
            .ToList();
    }

    /// <summary>A mesma escolha para a linha nova (o restante do cancelamento parcial), com ids próprios na mesma ordem.</summary>
    public static IReadOnlyList<ComplementoItem> Copiar(IReadOnlyList<ComplementoItem> complementos)
    {
        ArgumentNullException.ThrowIfNull(complementos);
        var ids = IdsEmOrdem(complementos.Count);
        return complementos.Select((c, n) => c with { Id = ids[n] }).ToList();
    }

    /// <summary>
    /// <paramref name="quantidade"/> ids novos em ordem crescente. Os UUIDv7 gerados no mesmo milissegundo desempatam pela
    /// parte aleatória (o .NET não tem contador), e as linhas do item gravam o mesmo <c>criado_em</c>: sem ordenar, a
    /// venda relida depois de uma queda (PDV 32.3) ou reidratada (SYNC 22.2) embaralharia os complementos na tela, no
    /// cupom e no evento.
    /// </summary>
    public static IReadOnlyList<Guid> IdsEmOrdem(int quantidade)
    {
        var ids = Enumerable.Range(0, quantidade).Select(_ => IdGerador.Novo()).ToList();
        ids.Sort();
        return ids;
    }

    /// <summary>Σ adicionais por unidade do item: a "camada de acréscimos" que o recálculo do preço preserva.</summary>
    public static decimal Adicional(IEnumerable<ComplementoItem> complementos) =>
        complementos.Sum(c => c.PrecoAdicional * c.Quantidade);

    /// <summary>
    /// Mesmos complementos (agrupamento, PDV 10.2: "linhas com complementos diferentes não se agrupam"): a mesma lista de
    /// opções, adicionais e quantidades, sem olhar a ordem. Os valores comparam como número (a linha relida do banco volta
    /// com as casas da coluna: 4,5000 é o mesmo 4,50 da inclusão).
    /// </summary>
    public static bool Mesmos(IReadOnlyList<ComplementoItem> a, IReadOnlyList<ComplementoItem> b)
    {
        ArgumentNullException.ThrowIfNull(a);
        ArgumentNullException.ThrowIfNull(b);
        if (a.Count != b.Count)
        {
            return false;
        }

        var restantes = b.ToList();
        foreach (var c in a)
        {
            var i = restantes.FindIndex(o => o.ComplementoId == c.ComplementoId && o.GrupoNome == c.GrupoNome && o.Descricao == c.Descricao
                                             && o.Quantidade == c.Quantidade && o.PrecoAdicional == c.PrecoAdicional);
            if (i < 0)
            {
                return false;
            }

            restantes.RemoveAt(i);
        }

        return true;
    }

    /// <summary>Os grupos do snapshot mais os novos de <paramref name="atuais"/> (opção a opção, pelo id), sem mudar os antigos.</summary>
    public static IReadOnlyList<GrupoComplementos>? Juntar(IReadOnlyList<GrupoComplementos>? snapshot, IReadOnlyList<GrupoComplementos>? atuais)
    {
        if (atuais is not { Count: > 0 } || snapshot is null)
        {
            return snapshot ?? atuais;
        }

        var resultado = snapshot.ToList();
        var mudou = false;
        foreach (var grupo in atuais)
        {
            var i = resultado.FindIndex(g => g.Id == grupo.Id);
            if (i < 0)
            {
                resultado.Add(grupo);
                mudou = true;
                continue;
            }

            var antigo = resultado[i];
            var novas = grupo.Opcoes.Where(o => antigo.Opcoes.All(a => a.Id != o.Id)).ToList();
            if (novas.Count > 0)
            {
                resultado[i] = antigo with { Opcoes = [.. antigo.Opcoes, .. novas] };
                mudou = true;
            }
        }

        return mudou ? resultado : snapshot;
    }

    private static string Cortar(string texto, int maximo)
    {
        var t = texto.Trim();
        return t.Length <= maximo ? t : t[..maximo].TrimEnd();
    }
}
