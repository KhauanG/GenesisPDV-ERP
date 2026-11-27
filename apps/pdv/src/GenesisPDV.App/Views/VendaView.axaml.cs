using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Threading;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels;

namespace GenesisPDV.App.Views;

public partial class VendaView : UserControl
{
    private readonly List<KeyBinding> _teclasDoMapa = [];
    private VendaViewModel? _vm;

    public VendaView()
    {
        InitializeComponent();
        AttachedToVisualTree += (_, _) => Foco.Focar(CampoCodigo);

        // O clique numa linha da lista (ou num botão da barra) não pode deixar o campo de código sem foco: o leitor de
        // código de barras digita no campo focado (decisão 65). O duplo clique que abre a janela do item fica com ela.
        ListaItens.AddHandler(PointerReleasedEvent, (_, _) => VoltarFocoAoCodigo(), handledEventsToo: true);
        BarraFuncoes.AddHandler(PointerReleasedEvent, (_, _) => VoltarFocoAoCodigo(), handledEventsToo: true);
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (_vm is not null)
        {
            _vm.FocoNoCodigoSolicitado -= FocarCodigo;
            _vm.TeclasAlteradas -= AplicarTeclas;
        }

        _vm = DataContext as VendaViewModel;
        if (_vm is not null)
        {
            _vm.FocoNoCodigoSolicitado += FocarCodigo;
            _vm.TeclasAlteradas += AplicarTeclas;
        }

        AplicarTeclas(this, EventArgs.Empty);
    }

    /// <summary>
    /// As teclas das ações (F3-B13; PDV 28.3): uma ligação por tecla do mapa, todas no mesmo comando, que decide entre a
    /// ação e o bipe do "Ação indisponível". O mapa novo (depois do pull) troca as ligações: a tecla antiga deixa de valer.
    /// As do diálogo aberto continuam na frente (ficam no diálogo, mais perto do foco).
    /// </summary>
    private void AplicarTeclas(object? sender, EventArgs e)
    {
        foreach (var k in _teclasDoMapa)
        {
            KeyBindings.Remove(k);
        }

        _teclasDoMapa.Clear();
        if (_vm is null)
        {
            return;
        }

        foreach (var (gesto, acao) in _vm.TeclasDaVenda())
        {
            var ligacao = new KeyBinding { Gesture = gesto, Command = _vm.TeclaAtalhoCommand, CommandParameter = acao };
            KeyBindings.Add(ligacao);
            _teclasDoMapa.Add(ligacao);
        }
    }

    private void FocarCodigo(object? sender, EventArgs e) => Foco.Focar(CampoCodigo);

    /// <summary>Sem diálogo aberto, o foco volta ao campo de código mantendo o que já foi digitado nele.</summary>
    private void VoltarFocoAoCodigo() => Dispatcher.UIThread.Post(() =>
    {
        if (_vm is { Dialogo: null } && !CampoCodigo.IsFocused)
        {
            CampoCodigo.Focus(NavigationMethod.Pointer);
            CampoCodigo.CaretIndex = CampoCodigo.Text?.Length ?? 0;
        }
    }, DispatcherPriority.Loaded);
}
