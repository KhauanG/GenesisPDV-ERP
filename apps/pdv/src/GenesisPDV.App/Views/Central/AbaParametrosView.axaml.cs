using Avalonia.Controls;
using Avalonia.Interactivity;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels.Central;

namespace GenesisPDV.App.Views.Central;

public partial class AbaParametrosView : UserControl, IConteudoFocavel
{
    private AbaParametrosViewModel? _vm;

    public AbaParametrosView()
    {
        InitializeComponent();
        // A lista escolhida pelo mouse devolve o foco ao campo dos minutos: o ComboBox com o foco tomaria o F2 e as setas.
        ListaTemaParametros.DropDownClosed += (_, _) => Focar();
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        Desinscrever();
        _vm = DataContext as AbaParametrosViewModel;
        if (IsLoaded)
        {
            Inscrever();
        }
    }

    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        Inscrever();
        Focar();
    }

    protected override void OnUnloaded(RoutedEventArgs e)
    {
        base.OnUnloaded(e);
        Desinscrever();
    }

    /// <summary>O foco no campo dos minutos do bloqueio (o teclado numérico já digita; Tab vai ao tema e à pasta).</summary>
    public void Focar() => Foco.Focar(CampoBloqueioMinutos);

    private void Inscrever()
    {
        if (_vm is not null)
        {
            Desinscrever();
            _vm.FocoSolicitado += AoPedirFoco;
        }
    }

    private void Desinscrever()
    {
        if (_vm is not null)
        {
            _vm.FocoSolicitado -= AoPedirFoco;
        }
    }

    private void AoPedirFoco(object? sender, AlvoFocoParametros alvo) =>
        Foco.Focar(alvo == AlvoFocoParametros.Pasta ? CampoPastaSecundaria : CampoBloqueioMinutos);
}
