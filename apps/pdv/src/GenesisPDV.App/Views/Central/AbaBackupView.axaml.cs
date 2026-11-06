using Avalonia.Controls;
using Avalonia.Interactivity;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels.Central;

namespace GenesisPDV.App.Views.Central;

public partial class AbaBackupView : UserControl, IConteudoFocavel
{
    private AbaBackupViewModel? _vm;

    /// <summary>O nome da aba quando ela tem o foco (os testes esperam por ele).</summary>
    public const string NomeTela = "TelaBackup";

    public AbaBackupView()
    {
        InitializeComponent();
        Name = NomeTela;
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        Desinscrever();
        _vm = DataContext as AbaBackupViewModel;
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

    /// <summary>O foco na aba: F5 faz o backup, F6 atualiza, Esc volta ao menu.</summary>
    public void Focar() => Foco.Focar(this);

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

    private void AoPedirFoco(object? sender, EventArgs e) => Focar();
}
