namespace GenesisPDV.Core.Produtos;

/// <summary>
/// Opção de uma posição do combo: o produto padrão (<see cref="AlternativaId"/> nulo) ou uma alternativa de
/// <c>produtos_componentes_alternativas</c> com o seu acréscimo por combo (PDV 10.9.1).
/// </summary>
/// <param name="Disponivel">Falso quando inativo na loja ou sem estoque com "Bloqueia venda sem estoque": aparece desabilitada.</param>
/// <param name="Motivo">Texto mostrado ao lado da opção indisponível ("sem estoque").</param>
public sealed record OpcaoCombo(Guid? AlternativaId, ProdutoVenda Produto, decimal Acrescimo = 0m, bool Disponivel = true, string? Motivo = null)
{
    public bool EhPadrao => AlternativaId is null;
}

/// <summary>Posição (<c>produtos_componentes</c> tipo <c>kit</c>): o padrão vem sempre em <c>Opcoes[0]</c>.</summary>
/// <param name="ComponenteId"><c>produtos_componentes.id</c>, gravado em <c>itens_venda.kit_componente_id</c>.</param>
/// <param name="Quantidade">Quantidade por 1 combo (vale também para a alternativa escolhida).</param>
public sealed record PosicaoCombo(Guid ComponenteId, string Rotulo, decimal Quantidade, int Ordem, IReadOnlyList<OpcaoCombo> Opcoes)
{
    /// <summary>Tem escolha a fazer no diálogo Montar combo: mais de uma opção disponível.</summary>
    public bool TemAlternativas => Opcoes.Count(o => o.Disponivel) > 1;

    /// <summary>Índice marcado ao abrir: o padrão ou, se indisponível, a primeira alternativa disponível; -1 = nenhuma.</summary>
    public int IndiceInicial
    {
        get
        {
            for (var i = 0; i < Opcoes.Count; i++)
            {
                if (Opcoes[i].Disponivel)
                {
                    return i;
                }
            }

            return -1;
        }
    }
}

/// <summary>Combo lido com as posições em <c>ordem</c> (snapshot do espelho no momento da inclusão).</summary>
public sealed record ComboResolvido(ProdutoVenda Kit, IReadOnlyList<PosicaoCombo> Posicoes)
{
    /// <summary>Abre o diálogo Montar combo quando alguma posição tem alternativa disponível.</summary>
    public bool ExigeEscolha => Posicoes.Any(p => p.TemAlternativas);

    /// <summary>Escolha com os padrões (ou a primeira disponível de cada posição).</summary>
    public IReadOnlyList<int> EscolhasPadrao => Posicoes.Select(p => p.IndiceInicial).ToList();
}
