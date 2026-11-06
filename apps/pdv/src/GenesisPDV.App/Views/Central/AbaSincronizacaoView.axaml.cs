using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels.Central;

namespace GenesisPDV.App.Views.Central;

public partial class AbaSincronizacaoView : UserControl, IConteudoFocavel
{
    private AbaSincronizacaoViewModel? _vm;

    public AbaSincronizacaoView()
    {
        InitializeComponent();
        // O teclado numérico (plano 4): o * abre (ou fecha) o detalhe, o + e o − mudam de página, PgDn e PgUp também; na
        // lista as setas escolhem e no detalhe elas e as páginas (e o 8/2/9/3 do numérico) rolam. Pelo túnel, antes de
        // quem tem o foco.
        AddHandler(KeyDownEvent, AoTeclaNumerico, RoutingStrategies.Tunnel);
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        Desinscrever();
        _vm = DataContext as AbaSincronizacaoViewModel;
        if (IsLoaded)
        {
            Inscrever();
        }
    }

    // Só a tela na janela atende o pedido de foco (a de uma visita anterior à aba fica de fora).
    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        Inscrever();
        if (_vm is { MostrandoDetalhe: true })
        {
            _vm.Focar();
        }
    }

    protected override void OnUnloaded(RoutedEventArgs e)
    {
        base.OnUnloaded(e);
        Desinscrever();
    }

    /// <summary>O foco vai ao painel da lista (ou ao detalhe aberto): ↑/↓, Enter, F6 e as teclas F funcionam dali.</summary>
    public void Focar() => _vm?.Focar();

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

    private void AoTeclaNumerico(object? sender, KeyEventArgs e)
    {
        // No pedido do supervisor as teclas são dos campos dele.
        if (_vm is null || _vm.Liberacao is not null || e.KeyModifiers != KeyModifiers.None)
        {
            return;
        }

        if (_vm.MostrandoDetalhe && Rolar(e.Key))
        {
            e.Handled = true;
            return;
        }

        switch (e.Key)
        {
            case Key.Up or Key.Down:
                e.Handled = true;
                _vm.MoverCommand.Execute(e.Key == Key.Up ? "acima" : "abaixo");
                return;
            case Key.Add or Key.PageDown when !_vm.MostrandoDetalhe:
                e.Handled = true;
                _vm.ProximaPaginaCommand.Execute(null);
                return;
            case Key.Subtract or Key.PageUp when !_vm.MostrandoDetalhe:
                e.Handled = true;
                _vm.PaginaAnteriorCommand.Execute(null);
                return;
            case Key.Multiply:
                e.Handled = true;
                if (_vm.DetalharCommand.CanExecute(null))
                {
                    _vm.DetalharCommand.Execute(null);
                }

                return;
        }
    }

    /// <summary>No detalhe (a lista não se mexe): ↑/↓ (8/2) umas linhas, PgUp/PgDn (9/3) uma página.</summary>
    private bool Rolar(Key tecla)
    {
        const double linhas = 48;
        var rolagem = RolagemDetalheSincronizacao;
        var pagina = Math.Max(linhas, rolagem.Viewport.Height - linhas);
        double? passo = tecla switch
        {
            Key.Up or Key.NumPad8 => -linhas,
            Key.Down or Key.NumPad2 => linhas,
            Key.PageUp or Key.NumPad9 => -pagina,
            Key.PageDown or Key.NumPad3 => pagina,
            _ => null,
        };
        if (passo is not { } p)
        {
            return false;
        }

        var maximo = Math.Max(0, rolagem.Extent.Height - rolagem.Viewport.Height);
        rolagem.Offset = rolagem.Offset.WithY(Math.Clamp(rolagem.Offset.Y + p, 0, maximo));
        return true;
    }

    // O detalhe e a lista trocam de visibilidade no mesmo instante: o foco vai depois do layout.
    private void AoPedirFoco(object? sender, AlvoFocoSincronizacao alvo) => Dispatcher.UIThread.Post(
        () => Foco.Focar(alvo == AlvoFocoSincronizacao.Detalhe ? PainelDetalheSincronizacao : PainelListaSincronizacao),
        DispatcherPriority.Loaded);
}
