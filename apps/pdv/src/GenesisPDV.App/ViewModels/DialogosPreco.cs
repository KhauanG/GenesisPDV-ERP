using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;

namespace GenesisPDV.App.ViewModels;

/// <summary>
/// O preço digitado (PDV 10.4; Fase 3, F3-B16): no "Produto genérico", a descrição (o nome do produto pré-preenchido, até
/// 120 caracteres) e o preço; no "Solicita preço PDV", só o preço, com o de tabela pré-preenchido quando há. Acima de
/// <c>pdv.limite_preco_digitado</c>, o primeiro Enter avisa e o segundo, com o mesmo preço, confirma.
/// </summary>
public sealed partial class DialogoPrecoDigitadoViewModel : DialogoViewModel
{
    private readonly ProdutoResolvido _produto;
    private readonly decimal _quantidade;
    private readonly string? _codigo;
    private readonly string? _origemEntrada;
    private readonly IReadOnlyCollection<Guid>? _complementos;
    private readonly decimal? _limite;
    private decimal? _confirmadoAcimaDoLimite;

    public DialogoPrecoDigitadoViewModel(
        VendaViewModel venda,
        ProdutoResolvido produto,
        decimal quantidade,
        string? codigo,
        string? origemEntrada,
        IReadOnlyCollection<Guid>? complementos,
        decimal? limite)
        : base(venda)
    {
        _produto = produto;
        _quantidade = quantidade;
        _codigo = codigo;
        _origemEntrada = origemEntrada;
        _complementos = complementos;
        _limite = limite;
        Descricao = produto.Produto.Descricao;
        Preco = produto.Produto.PrecoBase > 0m && Arredondamento.CabeEm(produto.Produto.PrecoBase, Arredondamento.CasasDinheiro)
            ? NumeroBr.Dinheiro(produto.Produto.PrecoBase)
            : string.Empty;
    }

    public override string Titulo => Generico ? $"Produto genérico ─ {_produto.Produto.Descricao}" : $"Informe o preço ─ {_produto.Produto.Descricao}";

    /// <summary>O genérico pede também a descrição (o campo some no "Solicita preço PDV").</summary>
    public bool Generico => _produto.Produto.Generico;

    public string Dica => _quantidade == 1m
        ? "Preço por unidade, em R$ (por exemplo 12,50)."
        : $"Preço por unidade, em R$ (por exemplo 12,50): {_quantidade.ToString("0.###", NumeroBr.Cultura)} unidades.";

    public int DescricaoMaxima => RegrasPrecoManual.DescricaoMaxima;

    [ObservableProperty]
    public partial string Descricao { get; set; }

    [ObservableProperty]
    public partial string Preco { get; set; }

    protected override async Task AoConfirmarAsync()
    {
        var preco = RegrasPrecoManual.LerPreco(Preco);
        var descricao = Generico ? RegrasPrecoManual.DescricaoGenerico(Descricao) : null;
        if (_limite is { } limite && RegrasPrecoManual.AcimaDoLimite(preco, limite) && _confirmadoAcimaDoLimite != preco)
        {
            _confirmadoAcimaDoLimite = preco;
            throw new RegraNegocioException(RegrasPrecoManual.MensagemAcimaDoLimite(preco, limite));
        }

        // A descrição igual à do cadastro não vira "digitada" (a linha leva o nome do produto, como sempre).
        var digitada = descricao is not null && descricao != _produto.Produto.Descricao ? descricao : null;
        await Venda.IncluirComPrecoAsync(_produto, _quantidade, _codigo, _origemEntrada, _complementos, new PrecoDigitado(preco, digitada));
    }
}

/// <summary>
/// <c>Ctrl+F6</c> Alterar preço do item selecionado (PDV 10.5; F3-B16): o preço novo por unidade, com o de tabela e o atual
/// na dica. A redução conta no limite de desconto (12.3); acima dele, ou sem <c>pdv.venda.alterar_preco</c>, o supervisor
/// libera (<see cref="VendaViewModel.AplicarAlterarPrecoAsync"/>). Acima de <c>pdv.limite_preco_digitado</c>, o segundo
/// Enter confirma.
/// </summary>
public sealed partial class DialogoAlterarPrecoViewModel(VendaViewModel venda, ItemLinhaViewModel item, decimal? limite) : DialogoViewModel(venda)
{
    private decimal? _confirmadoAcimaDoLimite;

    public override string Titulo => $"Alterar preço do item {item.Sequencia} ─ {item.Item.Descricao}";

    /// <summary>A tabela que a redução usa (no atacado, no mix e na embalagem, o varejo: o preço manual não segue a quantidade).</summary>
    public string Dica =>
        $"Preço de tabela R$ {NumeroBr.Preco(item.Item.PrecoTabelaParaPrecoManual)} · atual R$ {NumeroBr.Preco(item.Item.PrecoUnitario)}. "
        + "Preço abaixo da tabela conta no seu limite de desconto.";

    [ObservableProperty]
    public partial string Preco { get; set; } = string.Empty;

    protected override async Task AoConfirmarAsync()
    {
        var preco = RegrasPrecoManual.LerPreco(Preco);
        if (limite is { } l && RegrasPrecoManual.AcimaDoLimite(preco, l) && _confirmadoAcimaDoLimite != preco)
        {
            _confirmadoAcimaDoLimite = preco;
            throw new RegraNegocioException(RegrasPrecoManual.MensagemAcimaDoLimite(preco, l));
        }

        await Venda.AplicarAlterarPrecoAsync(item.Sequencia, preco, mensagem => Venda.FecharDialogo(item.Sequencia, mensagem));
    }
}

/// <summary>
/// F6 › 3 Acréscimo no total (PDV 12.2; F3-B16): em R$ ou em %, como o desconto (Enter lê "10%" ou "2,50"; os botões
/// fixam o tipo, para o teclado numérico sem a tecla %). Com a <paramref name="liberacao"/> do supervisor quando o operador
/// não tem <c>pdv.venda.acrescimo</c>.
/// </summary>
public sealed partial class DialogoValorAcrescimoViewModel(VendaViewModel venda, LiberacaoConcedida? liberacao) : DialogoViewModel(venda)
{
    public override string Titulo => liberacao is null ? "Acréscimo no total" : $"Acréscimo no total (liberado por {liberacao.Supervisor.Nome})";

    public string Dica => "Digite em R$ (2,50) ou em % (10%), ou digite só o número e clique em \"Aplicar em R$\" ou \"Aplicar em %\".";

    [ObservableProperty]
    public partial string Valor { get; set; } = string.Empty;

    protected override Task AoConfirmarAsync() => Aplicar(null);

    [RelayCommand]
    private Task AplicarReais() => Executar(() => Aplicar(TipoDesconto.Valor));

    [RelayCommand]
    private Task AplicarPercentual() => Executar(() => Aplicar(TipoDesconto.Percentual));

    private Task Aplicar(TipoDesconto? tipo) => Venda.AplicarAcrescimoAsync(Desconto.LerAcrescimo(Valor, tipo), liberacao);
}
