using System.ComponentModel;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels.Central;

namespace GenesisPDV.App.Views.Central;

public partial class AbaCaixasView : UserControl, IConteudoFocavel
{
    private AbaCaixasViewModel? _vm;

    public AbaCaixasView()
    {
        InitializeComponent();
        // O teclado numérico (plano 4): o * abre (ou fecha) o detalhe, como o Enter; na lista as setas escolhem e no detalhe
        // elas e as páginas (e o 8/2/9/3 do numérico) rolam o relatório. Pelo túnel, antes de quem tem o foco.
        AddHandler(KeyDownEvent, AoTeclaNumerico, RoutingStrategies.Tunnel);
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        Desinscrever();
        _vm = DataContext as AbaCaixasViewModel;
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
        // A aba que chega já com o detalhe aberto (o F7 da aba Vendas): o pedido de foco pode ter vindo antes desta tela, e o
        // foco inicial da lista (escondida) não pega.
        if (_vm is { MostrandoDetalhe: true } or { MostrandoResumo: true })
        {
            _vm.Focar();
        }
    }

    protected override void OnUnloaded(RoutedEventArgs e)
    {
        base.OnUnloaded(e);
        Desinscrever();
    }

    /// <summary>O foco vai ao painel da lista (ou ao detalhe, ou ao resumo abertos): ↑/↓, Enter, Ctrl+R e as teclas F funcionam dali.</summary>
    public void Focar() => _vm?.Focar();

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

    // A 2ª via entra no fim do detalhe (abaixo da dobra em 1024 × 700): a tela rola até ela, que acabou de sair.
    private void AoMudar(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(AbaCaixasViewModel.TextoSegundaVia) && _vm?.TextoSegundaVia is not null)
        {
            Dispatcher.UIThread.Post(() => TextoSegundaViaCaixa.BringIntoView(), DispatcherPriority.Loaded);
        }
    }

    private void AoTeclaNumerico(object? sender, KeyEventArgs e)
    {
        // No pedido do supervisor as teclas são dos campos dele.
        if (_vm is null || _vm.Liberacao is not null || e.KeyModifiers != KeyModifiers.None)
        {
            return;
        }

        if (_vm is { MostrandoDetalhe: true, MostrandoResumo: false } && Rolar(e.Key))
        {
            e.Handled = true;
            return;
        }

        if (e.Key is Key.Up or Key.Down)
        {
            // Na lista, as setas escolhem o caixa (no resumo, nada: o MoverCommand confere).
            e.Handled = true;
            _vm.MoverCommand.Execute(e.Key == Key.Up ? "acima" : "abaixo");
            return;
        }

        if (e.Key != Key.Multiply)
        {
            return;
        }

        e.Handled = true;
        if (_vm.DetalharCommand.CanExecute(null))
        {
            _vm.DetalharCommand.Execute(null);
        }
    }

    /// <summary>No detalhe (a lista não se mexe): ↑/↓ (8/2) umas linhas, PgUp/PgDn (9/3) uma página.</summary>
    private bool Rolar(Key tecla)
    {
        const double linhas = 48;
        var rolagem = RolagemDetalheCaixaCentral;
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

    // O detalhe, o resumo e a lista trocam de visibilidade no mesmo instante: o foco vai depois do layout.
    private void AoPedirFoco(object? sender, AlvoFocoCaixas alvo) => Dispatcher.UIThread.Post(
        () => Foco.Focar(alvo switch
        {
            AlvoFocoCaixas.Detalhe => PainelDetalheCaixaCentral,
            AlvoFocoCaixas.Resumo => PainelResumoCaixaCentral,
            _ => PainelListaCaixasCentral,
        }),
        DispatcherPriority.Loaded);
}
