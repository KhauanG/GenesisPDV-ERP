using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Produtos;

namespace GenesisPDV.App.ViewModels;

/// <summary>Uma opção da posição no diálogo Montar combo ("(•) 2 MONSTER 2L  +R$ 2,00").</summary>
public sealed partial class OpcaoComboViewModel(int numero, OpcaoCombo opcao) : ObservableObject
{
    public OpcaoCombo Opcao { get; } = opcao;

    public int Numero { get; } = numero;

    public bool Disponivel => Opcao.Disponivel;

    public string Descricao => Opcao.Produto.Descricao;

    public string Info => !Opcao.Disponivel
        ? $"({Opcao.Motivo ?? "indisponível"})"
        : Opcao.EhPadrao ? "(padrão)" : Opcao.Acrescimo > 0m ? $"+R$ {NumeroBr.Dinheiro(Opcao.Acrescimo)}" : string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Texto))]
    public partial bool Selecionada { get; set; }

    public string Texto => $"{(Selecionada ? "(•)" : "( )")} {Numero} {Descricao}";
}

/// <summary>Posição do combo no diálogo: fixa (só texto) ou com alternativas (recebe o foco).</summary>
public sealed partial class PosicaoComboViewModel : ObservableObject
{
    public PosicaoComboViewModel(PosicaoCombo posicao)
    {
        Posicao = posicao;
        Opcoes = new ObservableCollection<OpcaoComboViewModel>(posicao.Opcoes.Select((o, i) => new OpcaoComboViewModel(i + 1, o)));
        Indice = posicao.IndiceInicial;
        OnIndiceChanged(Indice);
    }

    public PosicaoCombo Posicao { get; }

    public ObservableCollection<OpcaoComboViewModel> Opcoes { get; }

    public string Rotulo => Posicao.Rotulo;

    public string QuantidadeTexto => $"{Posicao.Quantidade.ToString("0.###", NumeroBr.Cultura)} ×";

    /// <summary>Sem alternativa disponível: aparece só como texto, sem foco.</summary>
    public bool Fixa => !Posicao.TemAlternativas;

    public bool TemOpcoes => !Fixa;

    public string TextoFixo => Indice >= 0 ? $"{Opcoes[Indice].Descricao}  (fixo)" : "(indisponível)";

    [ObservableProperty]
    public partial int Indice { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Marcador))]
    public partial bool EmFoco { get; set; }

    public string Marcador => EmFoco ? "▶" : " ";

    public OpcaoComboViewModel? Escolhida => Indice >= 0 && Indice < Opcoes.Count ? Opcoes[Indice] : null;

    partial void OnIndiceChanged(int value)
    {
        for (var i = 0; i < Opcoes.Count; i++)
        {
            Opcoes[i].Selecionada = i == value;
        }
    }

    /// <summary>↑/↓: próxima opção disponível na direção, sem dar a volta.</summary>
    public void Mover(int direcao)
    {
        for (var i = Indice + direcao; i >= 0 && i < Opcoes.Count; i += direcao)
        {
            if (Opcoes[i].Disponivel)
            {
                Indice = i;
                return;
            }
        }
    }

    public bool Escolher(int numero)
    {
        if (numero < 1 || numero > Opcoes.Count || !Opcoes[numero - 1].Disponivel)
        {
            return false;
        }

        Indice = numero - 1;
        return true;
    }
}

/// <summary>
/// Diálogo Montar combo (PDV 10.9.1), só pelo teclado: foco na primeira posição com alternativas e o padrão marcado;
/// ↑/↓ ou 1–9 escolhem; Enter confirma e passa à próxima (na última inclui — Enter em sequência aceita os padrões);
/// Tab/Shift+Tab andam sem confirmar; Esc volta à posição anterior e, na primeira, fecha sem incluir nada.
/// </summary>
public sealed partial class DialogoMontarComboViewModel : DialogoViewModel
{
    private readonly ComboResolvido _combo;
    private readonly decimal _quantidade;
    private readonly string? _codigo;
    private readonly string? _origemEntrada;
    private readonly List<PosicaoComboViewModel> _navegaveis;
    private readonly decimal _precoKit;

    public DialogoMontarComboViewModel(VendaViewModel venda, ComboResolvido combo, decimal quantidade, string? codigo, string? origemEntrada)
        : base(venda)
    {
        _combo = combo;
        _quantidade = quantidade;
        _codigo = codigo;
        _origemEntrada = origemEntrada;
        // Mesmo relógio (corrigido, 30.5) e mesma regra da inclusão: o rodapé mostra o que a venda vai cobrar.
        _precoKit = venda.ServicoVenda.PrecoKit(combo);
        Posicoes = new ObservableCollection<PosicaoComboViewModel>(combo.Posicoes.Select(p => new PosicaoComboViewModel(p)));
        _navegaveis = Posicoes.Where(p => !p.Fixa).ToList();
        foreach (var posicao in Posicoes)
        {
            posicao.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName == nameof(PosicaoComboViewModel.Indice))
                {
                    OnPropertyChanged(nameof(TotalTexto));
                }
            };
        }

        Focar(0);
    }

    public override string Titulo => $"Montar combo ─ {_combo.Kit.Descricao}";

    public string PrecoBaseTexto => $"R$ {NumeroBr.Dinheiro(_precoKit)}";

    public string QuantidadeTexto => _quantidade == 1m ? string.Empty : $"{_quantidade.ToString("0.###", NumeroBr.Cultura)} combos";

    public ObservableCollection<PosicaoComboViewModel> Posicoes { get; }

    /// <summary>Preço do combo já com os acréscimos das alternativas escolhidas (× quantidade de combos).</summary>
    public decimal PrecoCombo => _precoKit + Posicoes.Sum(p => p.Escolhida?.Opcao.Acrescimo ?? 0m);

    public string TotalTexto => $"Combo: R$ {NumeroBr.Dinheiro(Arredondamento.Arred2(PrecoCombo * _quantidade))}";

    /// <summary>Índice (entre as posições com alternativas) da posição em foco.</summary>
    public int Foco { get; private set; }

    public PosicaoComboViewModel? PosicaoEmFoco => _navegaveis.Count == 0 ? null : _navegaveis[Foco];

    public IReadOnlyList<int> Escolhas => Posicoes.Select(p => p.Indice).ToList();

    [RelayCommand]
    private void MoverOpcao(string direcao) => PosicaoEmFoco?.Mover(direcao == "acima" ? -1 : 1);

    [RelayCommand]
    private void EscolherNumero(string numero)
    {
        Erro = null;
        if (PosicaoEmFoco is { } p && int.TryParse(numero, out var n) && !p.Escolher(n))
        {
            Erro = $"Opção {n} não disponível em \"{p.Rotulo}\".";
        }
    }

    [RelayCommand]
    private void Proxima() => Focar(Math.Min(Foco + 1, Math.Max(0, _navegaveis.Count - 1)));

    [RelayCommand]
    private void Anterior() => Focar(Math.Max(0, Foco - 1));

    protected override async Task AoConfirmarAsync()
    {
        if (Foco < _navegaveis.Count - 1)
        {
            Focar(Foco + 1);
            return;
        }

        if (Posicoes.FirstOrDefault(p => p.Escolhida is not { Disponivel: true }) is { } semOpcao)
        {
            throw new RegraNegocioException($"\"{semOpcao.Rotulo}\" sem opção disponível — o combo não pode ser montado.");
        }

        await Venda.IncluirComboAsync(_combo, Escolhas, _quantidade, _codigo, _origemEntrada);
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
        for (var i = 0; i < _navegaveis.Count; i++)
        {
            _navegaveis[i].EmFoco = i == indice;
        }

        OnPropertyChanged(nameof(PosicaoEmFoco));
        OnPropertyChanged(nameof(Foco));
    }
}

/// <summary>
/// "Cascos trazidos" (PDV 10.12): o padrão é o que falta devolver (na primeira vez, todos os devidos); Enter aceita.
/// A pergunta é obrigatória: Esc não fecha (o item cheio já está na venda).
/// </summary>
public sealed partial class DialogoCascosViewModel : DialogoViewModel
{
    private readonly int _sequencia;

    public DialogoCascosViewModel(VendaViewModel venda, int sequencia)
        : base(venda)
    {
        _sequencia = sequencia;
        var vendaAtual = venda.ServicoVenda.Atual ?? throw new InvalidOperationException("Sem venda.");
        var item = vendaAtual.ObterItem(sequencia);
        var situacao = vendaAtual.Cascos(sequencia);
        Devidos = situacao.Devidos;
        Produto = item.Descricao;
        Valor = situacao.Trazidos.ToString("0", NumeroBr.Cultura);
        // C11c: os descontados do mesmo casco já cobriram os devidos novos (Venda.AbaterDescontadosPelosDevidos); os que
        // sobraram são vazios a mais, que não entram de novo como trazidos deste item.
        var cascoId = vendaAtual.ProdutosRegistrados.FirstOrDefault(p => p.Id == item.ProdutoId)?.VasilhameProdutoId;
        AvisoDescontados = vendaAtual.CascosDescontados.FirstOrDefault(c => c.ProdutoVasilhameId == cascoId) is { } descontado
            ? $"{descontado.Quantidade} casco(s) {descontado.Descricao} descontado(s) nesta venda, além destes: não conte os mesmos vazios de novo."
            : null;
    }

    /// <summary>Cascos do mesmo tipo já descontados na venda (F11 › V, C11c); nulo quando não há.</summary>
    public string? AvisoDescontados { get; }

    public override string Titulo => "Cascos trazidos";

    public string Produto { get; }

    public decimal Devidos { get; }

    public string DevidosTexto => $"Cascos devidos: {Devidos:0}  ·  sem o vazio, o casco é cobrado";

    [ObservableProperty]
    public partial string Valor { get; set; }

    protected override async Task AoConfirmarAsync()
    {
        // A faixa (0 a devidos, inteiro) é validada pela regra; uma leitura do leitor aqui cai fora dela e é recusada.
        if (!NumeroBr.TentarLer(Valor, out var trazidos))
        {
            throw new RegraNegocioException($"Informe quantos cascos vazios o cliente trouxe (0 a {Devidos:0}).");
        }

        var casco = await Venda.ServicoVenda.RegistrarCascosAsync(_sequencia, trazidos);
        var cobrados = casco is { Cancelado: false } c ? c.Quantidade : 0m;
        Venda.FecharDialogo(
            _sequencia,
            cobrados > 0m ? $"{cobrados:0} casco(s) cobrado(s): o cliente trouxe {trazidos:0} de {Devidos:0}." : $"Cascos devolvidos: {trazidos:0}.");
    }

    protected override Task AoCancelarAsync()
    {
        Erro = $"Informe os cascos trazidos ([Enter] aceita {Valor}).";
        return Task.CompletedTask;
    }
}
