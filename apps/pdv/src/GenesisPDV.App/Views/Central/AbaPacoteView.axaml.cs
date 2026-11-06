using Avalonia.Controls;
using Avalonia.Interactivity;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels.Central;

namespace GenesisPDV.App.Views.Central;

public partial class AbaPacoteView : UserControl, IConteudoFocavel
{
    private AbaPacoteViewModel? _vm;

    /// <summary>O nome da aba quando ela tem o foco (os testes esperam por ele).</summary>
    public const string NomeTela = "TelaPacote";

    public AbaPacoteView()
    {
        InitializeComponent();
        Name = NomeTela;
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        Desinscrever();
        _vm = DataContext as AbaPacoteViewModel;
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

    /// <summary>O foco na aba: ↑/↓ escolhem o destino, Enter (ou F2) gera, F5 procura o pendrive, Esc volta ao menu.</summary>
    public void Focar() => Foco.Focar(this);

    private void Inscrever()
    {
        if (_vm is not null)
        {
            Desinscrever();
            _vm.FocoSolicitado += AoPedirFoco;
            _vm.PropertyChanged += AoMudar;
        }
    }

    private void Desinscrever()
    {
        if (_vm is not null)
        {
            _vm.FocoSolicitado -= AoPedirFoco;
            _vm.PropertyChanged -= AoMudar;
        }
    }

    private void AoPedirFoco(object? sender, EventArgs e) => Focar();

    /// <summary>O destino escolhido pelo mouse: o foco volta à aba (as teclas continuam valendo sem outro clique).</summary>
    private void AoMudar(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(AbaPacoteViewModel.DestinoSelecionado) && IsKeyboardFocusWithin && !IsFocused)
        {
            Focar();
        }
    }
}
