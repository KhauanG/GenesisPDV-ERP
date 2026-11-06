using System.ComponentModel;
using Avalonia.Controls;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels;

namespace GenesisPDV.App.Views;

public partial class SessaoOutroOperadorView : UserControl
{
    private SessaoOutroOperadorViewModel? _vm;

    public SessaoOutroOperadorView() => InitializeComponent();

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (_vm is not null)
        {
            _vm.PropertyChanged -= AoMudar;
        }

        _vm = DataContext as SessaoOutroOperadorViewModel;
        if (_vm is not null)
        {
            _vm.PropertyChanged += AoMudar;
        }
    }

    private void AoMudar(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(SessaoOutroOperadorViewModel.Liberacao) && _vm is { Liberacao: null })
        {
            Foco.Focar(PainelSessaoOutro);
        }
    }
}
