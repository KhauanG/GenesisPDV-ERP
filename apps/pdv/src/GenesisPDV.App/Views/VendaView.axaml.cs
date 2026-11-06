using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Threading;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels;

namespace GenesisPDV.App.Views;

public partial class VendaView : UserControl
{
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
        }

        _vm = DataContext as VendaViewModel;
        if (_vm is not null)
        {
            _vm.FocoNoCodigoSolicitado += FocarCodigo;
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
