using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Threading;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels.Central;

namespace GenesisPDV.App.Views.Central;

public partial class AbaPainelView : UserControl, IConteudoFocavel
{
    private AbaPainelViewModel? _vm;

    /// <summary>O foco estava na aba (na lista ou nela mesma, o 0 de novo antes da primeira rodada) quando a lista mudou.</summary>
    private bool _devolverFoco;

    public AbaPainelView() => InitializeComponent();

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        Desinscrever();
        _vm = DataContext as AbaPainelViewModel;
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
    }

    protected override void OnUnloaded(RoutedEventArgs e)
    {
        base.OnUnloaded(e);
        Desinscrever();
    }

    private void Inscrever()
    {
        if (_vm is not null)
        {
            Desinscrever();
            _vm.FocoSolicitado += AoPedirFoco;
            _vm.AtualizandoLinhas += AoAtualizarLinhas;
            _vm.LinhasAtualizadas += AoTerminarLinhas;
        }
    }

    private void Desinscrever()
    {
        if (_vm is not null)
        {
            _vm.FocoSolicitado -= AoPedirFoco;
            _vm.AtualizandoLinhas -= AoAtualizarLinhas;
            _vm.LinhasAtualizadas -= AoTerminarLinhas;
        }
    }

    private void AoPedirFoco(object? sender, EventArgs e) => Focar();

    // F5, Ctrl+Alt+S e a primeira rodada refazem a lista: o ListBoxItem com o foco some e o foco cairia na janela.
    private void AoAtualizarLinhas(object? sender, EventArgs e) => _devolverFoco = IsKeyboardFocusWithin;

    private void AoTerminarLinhas(object? sender, EventArgs e)
    {
        if (_devolverFoco)
        {
            _devolverFoco = false;
            Focar();
        }
    }

    /// <summary>O foco vai à linha escolhida da lista (↑/↓ e Enter funcionam dali); sem linhas, à própria aba.</summary>
    public void Focar() => Dispatcher.UIThread.Post(() =>
    {
        if (ListaSaude.ItemCount == 0)
        {
            Foco.Focar(this);
            return;
        }

        ListaSaude.SelectedIndex = Math.Max(0, ListaSaude.SelectedIndex);
        var item = ListaSaude.ContainerFromIndex(ListaSaude.SelectedIndex);
        Foco.Focar((Control?)item ?? ListaSaude);
    }, DispatcherPriority.Loaded);
}
