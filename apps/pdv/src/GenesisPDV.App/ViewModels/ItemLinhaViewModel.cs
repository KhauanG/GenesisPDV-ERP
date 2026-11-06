using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Vendas;

namespace GenesisPDV.App.ViewModels;

public enum TipoLinha
{
    Item,

    /// <summary>Linha de título do combo (não é <c>itens_venda</c>): nome, quantidade, preço do combo e total (10.9.1).</summary>
    TituloCombo,

    /// <summary>Componente escolhido do combo, indentado sob o título, sem preço próprio na tela.</summary>
    ComponenteCombo,
}

/// <summary>Linha da lista de itens da tela de venda (PDV 9.1, 10.9.1, 10.12, 11.3.1).</summary>
public sealed class ItemLinhaViewModel
{
    private readonly string? _nomeQuemCancelou;
    private readonly TimeZoneInfo _fuso;
    private readonly IReadOnlyList<ItemVenda> _linhasCombo;
    private readonly SituacaoCascos? _cascos;

    public ItemLinhaViewModel(
        ItemVenda item,
        string? nomeQuemCancelou,
        TimeZoneInfo fuso,
        TipoLinha tipo = TipoLinha.Item,
        IReadOnlyList<ItemVenda>? linhasCombo = null,
        SituacaoCascos? cascos = null)
    {
        Item = item;
        Tipo = tipo;
        _nomeQuemCancelou = nomeQuemCancelou;
        _fuso = fuso;
        _linhasCombo = linhasCombo ?? [];
        _cascos = cascos;
    }

    public ItemVenda Item { get; }

    public TipoLinha Tipo { get; }

    public bool EhTituloCombo => Tipo == TipoLinha.TituloCombo;

    public bool EhComponente => Tipo == TipoLinha.ComponenteCombo;

    /// <summary>Sequência usada por F3/F4/F6: no combo, qualquer linha leva ao grupo inteiro.</summary>
    public int Sequencia => Item.Sequencia;

    public string SequenciaTexto => EhComponente ? string.Empty : Item.Sequencia.ToString(NumeroBr.Cultura);

    public string Codigo => EhComponente ? string.Empty : Item.CodigoLido ?? string.Empty;

    public string Descricao => Tipo switch
    {
        TipoLinha.TituloCombo => Item.Kit!.Descricao,
        TipoLinha.ComponenteCombo => $"   └ {Item.Descricao}{Troca}",
        _ => Item.EhCasco ? $"{Item.Descricao} (casco)" : Item.Descricao,
    };

    public string Quantidade => Tipo switch
    {
        TipoLinha.TituloCombo => $"{NumeroBr.Quantidade(Item.Kit!.Quantidade)} UN",
        _ => $"{NumeroBr.Quantidade(Item.Quantidade)} {Item.Unidade}",
    };

    public string Unitario => Tipo switch
    {
        TipoLinha.TituloCombo => NumeroBr.Preco(Item.Kit!.PrecoUnitario),
        TipoLinha.ComponenteCombo => string.Empty,
        _ => NumeroBr.Preco(Item.PrecoUnitario),
    };

    public string Total => Tipo switch
    {
        TipoLinha.TituloCombo => NumeroBr.Dinheiro(_linhasCombo.Sum(l => l.ValorBruto)),
        TipoLinha.ComponenteCombo => string.Empty,
        _ => NumeroBr.Dinheiro(Item.ValorBruto),
    };

    /// <summary>"ATAC 12+" / "MIX 12+" ao lado do preço (11.3.1).</summary>
    public string? Etiqueta => Tipo == TipoLinha.Item && !Item.Cancelado ? Item.EtiquetaPreco : null;

    public bool TemEtiqueta => Etiqueta is not null;

    /// <summary>Varejo riscado ao lado do preço de atacado/mix.</summary>
    public string? VarejoRiscado => TemEtiqueta && Item.PrecoVarejo is { } v && v != Item.PrecoUnitario ? NumeroBr.Preco(v) : null;

    public bool TemVarejoRiscado => VarejoRiscado is not null;

    public bool Cancelado => Tipo == TipoLinha.TituloCombo ? _linhasCombo.All(l => l.Cancelado) : Item.Cancelado;

    public string? Detalhe
    {
        get
        {
            if (EhComponente)
            {
                return null;
            }

            if (Cancelado)
            {
                return $"└ CANCELADO ({_nomeQuemCancelou ?? "operador"} {TimeZoneInfo.ConvertTime(Item.CanceladoEm ?? Item.IncluidoEm, _fuso):HH:mm})";
            }

            var partes = new List<string>();
            if (Item.Embalagem is { } e)
            {
                partes.Add($"{e.Sigla ?? "EMB"} {e.Fator:0.###}" + (e.Preco is { } pe ? $" × {NumeroBr.Preco(pe)}" : string.Empty));
            }

            var desconto = EhTituloCombo ? _linhasCombo.Sum(l => l.DescontoItem) : Item.DescontoItem;
            if (desconto > 0m)
            {
                partes.Add($"desconto {(EhTituloCombo ? "combo" : "item")}  -{NumeroBr.Dinheiro(desconto)}");
            }

            if (_cascos is { } c)
            {
                partes.Add($"Cascos: {c.Devidos:0} devidos · {c.Trazidos:0} trazidos · {c.Cobrados:0} cobrados");
            }

            return partes.Count == 0 ? null : "└ " + string.Join("  ·  ", partes);
        }
    }

    public bool TemDetalhe => Detalhe is not null;

    private string Troca => Item.Kit is { AlternativaId: not null } k
        ? k.Acrescimo > 0m ? $"  (troca +{NumeroBr.Dinheiro(k.Acrescimo)})" : "  (troca)"
        : string.Empty;
}
