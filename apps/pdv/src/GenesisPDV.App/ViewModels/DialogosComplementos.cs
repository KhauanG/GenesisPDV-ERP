using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Produtos;

namespace GenesisPDV.App.ViewModels;

/// <summary>Uma opção do grupo no diálogo dos complementos ("▸ [x] 1 CHEDDAR CREMOSO  +R$ 4,50").</summary>
public sealed partial class OpcaoComplementoViewModel(int numero, OpcaoComplemento opcao) : ObservableObject
{
    public OpcaoComplemento Opcao { get; } = opcao;

    public int Numero { get; } = numero;

    public string Info => Opcao.PrecoAdicional > 0m ? $"+R$ {NumeroBr.Dinheiro(Opcao.PrecoAdicional)}" : string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Texto))]
    public partial bool Marcada { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Texto))]
    public partial bool Cursor { get; set; }

    public string Texto => $"{(Cursor ? "▸" : " ")} {(Marcada ? "[x]" : "[ ]")} {Numero} {Opcao.Descricao}";
}

/// <summary>Grupo no diálogo: a regra ("Escolha de 1 a 2"), as opções marcadas e o cursor.</summary>
public sealed partial class GrupoComplementosViewModel : ObservableObject
{
    public GrupoComplementosViewModel(GrupoComplementos grupo)
    {
        Grupo = grupo;
        Opcoes = new ObservableCollection<OpcaoComplementoViewModel>(grupo.Opcoes.Select((o, i) => new OpcaoComplementoViewModel(i + 1, o)));
        Opcoes[0].Cursor = true;
    }

    public GrupoComplementos Grupo { get; }

    public ObservableCollection<OpcaoComplementoViewModel> Opcoes { get; }

    public string Nome => Grupo.Nome;

    public string Regra => Grupo.Regra;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Marcador))]
    public partial bool EmFoco { get; set; }

    public string Marcador => EmFoco ? "▶" : " ";

    public int IndiceCursor { get; private set; }

    public IEnumerable<OpcaoComplemento> Marcadas => Opcoes.Where(o => o.Marcada).Select(o => o.Opcao);

    public int QuantasMarcadas => Opcoes.Count(o => o.Marcada);

    /// <summary>"2 de no máximo 2" sob o grupo.</summary>
    public string Situacao => $"{QuantasMarcadas} de no máximo {Grupo.Maximo}";

    /// <summary>↑/↓: o cursor anda entre as opções do grupo, sem dar a volta.</summary>
    public void Mover(int direcao)
    {
        var novo = Math.Clamp(IndiceCursor + direcao, 0, Opcoes.Count - 1);
        Opcoes[IndiceCursor].Cursor = false;
        IndiceCursor = novo;
        Opcoes[IndiceCursor].Cursor = true;
    }

    /// <summary>
    /// Marca ou desmarca a opção (o número dela, ou a do cursor). No grupo de no máximo 1, marcar outra troca a escolha
    /// (como um botão de rádio); nos demais, passar do máximo é recusado com a mensagem (F3-Q4: cada opção uma vez).
    /// </summary>
    public string? Alternar(int? numero = null)
    {
        var indice = numero is { } n ? n - 1 : IndiceCursor;
        if (indice < 0 || indice >= Opcoes.Count)
        {
            return $"Opção {numero} não existe em \"{Nome}\".";
        }

        var opcao = Opcoes[indice];
        Mover(indice - IndiceCursor);
        if (opcao.Marcada)
        {
            opcao.Marcada = false;
        }
        else if (Grupo.Maximo == 1)
        {
            foreach (var outra in Opcoes)
            {
                outra.Marcada = outra == opcao;
            }
        }
        else if (QuantasMarcadas >= Grupo.Maximo)
        {
            return RegrasComplementos.MotivoDoGrupo(Grupo, QuantasMarcadas + 1);
        }
        else
        {
            opcao.Marcada = true;
        }

        OnPropertyChanged(nameof(Situacao));
        return null;
    }
}

/// <summary>
/// Diálogo dos complementos (PDV 10.2; Fase 3, F3-B15), só pelo teclado: um grupo por vez, na ordem do cadastro, com a
/// regra dele; ↑/↓ andam entre as opções, Espaço ou 1–9 marcam e desmarcam; Enter confere o grupo (mínimo, máximo e
/// obrigatório) e passa ao próximo, e no último inclui o item; Tab/Shift+Tab andam sem conferir; Esc volta ao grupo
/// anterior e, no primeiro, fecha sem incluir nada. Cada opção vale uma vez por unidade do item (F3-Q4 = D75).
/// </summary>
public sealed partial class DialogoComplementosViewModel : DialogoViewModel
{
    private readonly ProdutoResolvido _produto;
    private readonly decimal _quantidade;
    private readonly string? _codigo;
    private readonly string? _origemEntrada;

    public DialogoComplementosViewModel(VendaViewModel venda, ProdutoResolvido produto, decimal quantidade, string? codigo, string? origemEntrada)
        : base(venda)
    {
        _produto = produto;
        _quantidade = quantidade;
        _codigo = codigo;
        _origemEntrada = origemEntrada;
        Grupos = new ObservableCollection<GrupoComplementosViewModel>(
            (produto.Produto.GruposComplementos ?? []).Where(g => g.Opcoes.Count > 0).Select(g => new GrupoComplementosViewModel(g)));
        foreach (var grupo in Grupos)
        {
            foreach (var opcao in grupo.Opcoes)
            {
                opcao.PropertyChanged += (_, e) =>
                {
                    if (e.PropertyName == nameof(OpcaoComplementoViewModel.Marcada))
                    {
                        OnPropertyChanged(nameof(AdicionalTexto));
                        OnPropertyChanged(nameof(Escolhidas));
                    }
                };
            }
        }

        Focar(0);
    }

    public override string Titulo => $"Complementos ─ {_produto.Produto.Descricao}";

    public string QuantidadeTexto => _quantidade == 1m ? string.Empty : $"{_quantidade.ToString("0.###", NumeroBr.Cultura)} unidades: os mesmos complementos em cada uma";

    public ObservableCollection<GrupoComplementosViewModel> Grupos { get; }

    public int Foco { get; private set; }

    public GrupoComplementosViewModel? GrupoEmFoco => Grupos.Count == 0 ? null : Grupos[Foco];

    /// <summary>As opções marcadas em todos os grupos, as que a venda recebe.</summary>
    public IReadOnlyList<Guid> Escolhidas => Grupos.SelectMany(g => g.Marcadas).Select(o => o.Id).ToList();

    /// <summary>"Adicionais: +R$ 4,50 por unidade" (a regra de preço do item, atacado incluído, roda na inclusão).</summary>
    public string AdicionalTexto
    {
        get
        {
            var adicional = Grupos.SelectMany(g => g.Marcadas).Sum(o => o.PrecoAdicional);
            return adicional > 0m ? $"Adicionais: +R$ {NumeroBr.Dinheiro(adicional)} por unidade" : "Sem adicional";
        }
    }

    [RelayCommand]
    private void MoverOpcao(string direcao) => GrupoEmFoco?.Mover(direcao == "acima" ? -1 : 1);

    [RelayCommand]
    private void Alternar(string? numero)
    {
        Erro = GrupoEmFoco?.Alternar(int.TryParse(numero, out var n) ? n : null);
    }

    [RelayCommand]
    private void Proximo() => Focar(Math.Min(Foco + 1, Math.Max(0, Grupos.Count - 1)));

    [RelayCommand]
    private void Anterior() => Focar(Math.Max(0, Foco - 1));

    protected override async Task AoConfirmarAsync()
    {
        if (GrupoEmFoco is { } grupo && RegrasComplementos.MotivoDoGrupo(grupo.Grupo, grupo.QuantasMarcadas) is { } motivo)
        {
            throw new RegraNegocioException(motivo);
        }

        if (Foco < Grupos.Count - 1)
        {
            Focar(Foco + 1);
            return;
        }

        // Os grupos pulados com o Tab também passam pela regra (a venda confere tudo de novo).
        if (Grupos.Select((g, i) => (g, i)).FirstOrDefault(x => RegrasComplementos.MotivoDoGrupo(x.g.Grupo, x.g.QuantasMarcadas) is not null) is
            { g: not null } pendente)
        {
            Focar(pendente.i);
            throw new RegraNegocioException(RegrasComplementos.MotivoDoGrupo(pendente.g.Grupo, pendente.g.QuantasMarcadas)!);
        }

        await Venda.IncluirComComplementosAsync(_produto, _quantidade, _codigo, _origemEntrada, Escolhidas);
    }

    protected override Task AoCancelarAsync()
    {
        if (Foco > 0)
        {
            Focar(Foco - 1);
            return Task.CompletedTask;
        }

        return base.AoCancelarAsync();
    }

    private void Focar(int indice)
    {
        Foco = indice;
        for (var i = 0; i < Grupos.Count; i++)
        {
            Grupos[i].EmFoco = i == indice;
        }

        OnPropertyChanged(nameof(GrupoEmFoco));
        OnPropertyChanged(nameof(Foco));
    }
}
