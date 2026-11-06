using System.ComponentModel;
using Avalonia.Controls;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels;

namespace GenesisPDV.App.Views;

public partial class AberturaCaixaView : UserControl
{
    private AberturaCaixaViewModel? _vm;

    public AberturaCaixaView() => InitializeComponent();

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (_vm is not null)
        {
            _vm.PropertyChanged -= AoMudar;
        }

        _vm = DataContext as AberturaCaixaViewModel;
        if (_vm is not null)
        {
            _vm.PropertyChanged += AoMudar;
        }
    }

    /// <summary>Fechado o contador ou a liberação, o foco volta ao fundo de troco (PDV 32.8: sempre um foco definido).</summary>
    private void AoMudar(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(AberturaCaixaViewModel.Contador) or nameof(AberturaCaixaViewModel.Liberacao)
            && _vm is { Contador: null, Liberacao: null })
        {
            Foco.Focar(CampoFundo);
        }
    }
}
