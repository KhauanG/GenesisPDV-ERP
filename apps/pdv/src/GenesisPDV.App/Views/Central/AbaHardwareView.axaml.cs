using System.ComponentModel;
using Avalonia.Controls;
using Avalonia.Interactivity;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels.Central;

namespace GenesisPDV.App.Views.Central;

public partial class AbaHardwareView : UserControl, IConteudoFocavel
{
    private AbaHardwareViewModel? _vm;

    public AbaHardwareView() => InitializeComponent();

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

        _vm = DataContext as AbaHardwareViewModel;
        if (_vm is not null)
        {
            _vm.PropertyChanged += AoMudar;
        }
    }

    private void AoMudar(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(AbaHardwareViewModel.Etapa))
        {
            Focar();
        }
    }

    /// <summary>
    /// A liberação começa no usuário; a edição, no modelo (Tab percorre os campos; as teclas F valem em qualquer um). A
    /// Central chama de novo quando o dígito da aba já aberta é apertado no menu.
    /// </summary>
    public void Focar()
    {
        Control? campo = _vm?.Etapa == AbaHardwareViewModel.EtapaLiberar
            ? this.FindControl<TextBox>("CampoUsuarioConfig")
            : this.FindControl<ComboBox>("ListaModelo");
        Foco.Focar(campo ?? (Control)this);
    }
}
