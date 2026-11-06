using Avalonia.Controls;
using Avalonia.Input.Platform;
using Avalonia.Interactivity;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels.Central;

namespace GenesisPDV.App.Views.Central;

public partial class AbaSobreView : UserControl, IConteudoFocavel
{
    private AbaSobreViewModel? _vm;

    /// <summary>O nome da aba quando ela tem o foco (os testes esperam por ele).</summary>
    public const string NomeTela = "TelaSobre";

    public AbaSobreView()
    {
        InitializeComponent();
        Name = NomeTela;
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        Desinscrever();
        _vm = DataContext as AbaSobreViewModel;
        if (IsLoaded)
        {
            Inscrever();
        }
    }

    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        Inscrever();
    }

    protected override void OnUnloaded(RoutedEventArgs e)
    {
        base.OnUnloaded(e);
        Desinscrever();
    }

    /// <summary>O foco vai à aba (Enter copia o código; F5 atualiza; Esc volta ao menu).</summary>
    public void Focar() => Foco.Focar(this);

    private void Inscrever()
    {
        if (_vm is not null)
        {
            Desinscrever();
            _vm.FocoSolicitado += AoPedirFoco;
            _vm.CopiaSolicitada += CopiarAsync;
        }
    }

    private void Desinscrever()
    {
        if (_vm is not null)
        {
            _vm.FocoSolicitado -= AoPedirFoco;
            _vm.CopiaSolicitada -= CopiarAsync;
        }
    }

    private void AoPedirFoco(object? sender, EventArgs e) => Focar();

    /// <summary>A área de transferência da janela; sem ela (a plataforma headless dos testes), devolve falso.</summary>
    private async Task<bool> CopiarAsync(string texto)
    {
        if (TopLevel.GetTopLevel(this)?.Clipboard is not { } area)
        {
            return false;
        }

        try
        {
            await area.SetTextAsync(texto);
            return true;
        }
        catch (Exception e) when (e is InvalidOperationException or NotSupportedException or NotImplementedException)
        {
            return false;
        }
    }
}
