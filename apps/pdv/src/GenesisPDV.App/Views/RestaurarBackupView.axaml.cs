using System.ComponentModel;
using Avalonia.Controls;
using Avalonia.Interactivity;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels;

namespace GenesisPDV.App.Views;

public partial class RestaurarBackupView : UserControl
{
    private RestaurarBackupViewModel? _vm;

    public RestaurarBackupView() => InitializeComponent();

    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        Focar();
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (_vm is not null)
        {
            _vm.PropertyChanged -= AoMudar;
        }

        _vm = DataContext as RestaurarBackupViewModel;
        if (_vm is not null)
        {
            _vm.PropertyChanged += AoMudar;
        }
    }

    private void AoMudar(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(RestaurarBackupViewModel.Etapa))
        {
            Focar();
        }
    }

    /// <summary>Cada passo tem o foco no campo dele (PDV 32.8); na lista e no fim, a própria tela recebe as teclas.</summary>
    private void Focar()
    {
        var campo = _vm?.Etapa switch
        {
            RestaurarBackupViewModel.EtapaLiberar => this.FindControl<TextBox>("CampoUsuarioRestauracao"),
            RestaurarBackupViewModel.EtapaConfirmar => this.FindControl<TextBox>("CampoConfirmacaoRestauracao"),
            _ => null,
        };
        if (campo is not null)
        {
            Foco.Focar(campo);
        }
        else
        {
            Foco.Focar(this);
        }
    }
}
