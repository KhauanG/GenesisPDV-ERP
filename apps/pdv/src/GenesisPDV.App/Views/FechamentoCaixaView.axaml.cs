using System.ComponentModel;
using Avalonia.Controls;
using Avalonia.VisualTree;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels;

namespace GenesisPDV.App.Views;

public partial class FechamentoCaixaView : UserControl
{
    private FechamentoCaixaViewModel? _vm;

    public FechamentoCaixaView()
    {
        InitializeComponent();
        AttachedToVisualTree += (_, _) => FocarPrimeiraForma();
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (_vm is not null)
        {
            _vm.PropertyChanged -= AoMudar;
        }

        _vm = DataContext as FechamentoCaixaViewModel;
        if (_vm is not null)
        {
            _vm.PropertyChanged += AoMudar;
        }
    }

    /// <summary>Contagem (de novo, na recontagem, ou depois do contador): o foco vai ao Dinheiro; no fim, à tela.</summary>
    private void AoMudar(object? sender, PropertyChangedEventArgs e)
    {
        switch (e.PropertyName)
        {
            case nameof(FechamentoCaixaViewModel.Contador) when _vm is { Contador: null }:
            case nameof(FechamentoCaixaViewModel.Conferindo) when _vm is { Conferindo: false, Concluido: false }:
                FocarPrimeiraForma();
                break;
            case nameof(FechamentoCaixaViewModel.Conferindo) when _vm is { Conferindo: true }:
                Foco.Focar(CampoJustificativa);
                break;
            case nameof(FechamentoCaixaViewModel.Concluido) when _vm is { Concluido: true }:
                Foco.Focar(this);
                break;
        }
    }

    private void FocarPrimeiraForma() => Avalonia.Threading.Dispatcher.UIThread.Post(() =>
    {
        if (ListaFormas.GetVisualDescendants().OfType<TextBox>().FirstOrDefault() is { } campo)
        {
            Foco.Focar(campo);
        }
    }, Avalonia.Threading.DispatcherPriority.Loaded);
}
