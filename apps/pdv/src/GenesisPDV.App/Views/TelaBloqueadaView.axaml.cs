using Avalonia.Controls;
using Avalonia.Interactivity;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels;

namespace GenesisPDV.App.Views;

public partial class TelaBloqueadaView : UserControl
{
    private TelaBloqueadaViewModel? _vm;

    public TelaBloqueadaView() => InitializeComponent();

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (_vm is not null)
        {
            _vm.FocoSolicitado -= AoPedirFoco;
        }

        _vm = DataContext as TelaBloqueadaViewModel;
        if (_vm is not null)
        {
            _vm.FocoSolicitado += AoPedirFoco;
        }
    }

    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        Focar();
    }

    protected override void OnUnloaded(RoutedEventArgs e)
    {
        base.OnUnloaded(e);
        if (_vm is not null)
        {
            _vm.FocoSolicitado -= AoPedirFoco;
        }
    }

    private void AoPedirFoco(object? sender, EventArgs e) => Focar();

    /// <summary>O foco no PIN do operador (o padrão) ou no usuário do supervisor (F2): o PIN já pode ser digitado.</summary>
    private void Focar() => Foco.Focar(_vm is { PeloSupervisor: true } ? CampoSupervisorDesbloqueio : CampoPinDesbloqueio);
}
