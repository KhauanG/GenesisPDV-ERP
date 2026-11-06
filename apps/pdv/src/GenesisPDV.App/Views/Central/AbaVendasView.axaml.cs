using System.Windows.Input;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels.Central;

namespace GenesisPDV.App.Views.Central;

public partial class AbaVendasView : UserControl, IConteudoFocavel
{
    private AbaVendasViewModel? _vm;

    /// <summary>A última tecla foi um atalho do numérico: o caractere que o sistema manda depois não entra no campo.</summary>
    private bool _suprimirTexto;

    public AbaVendasView()
    {
        InitializeComponent();
        // O teclado numérico (plano 4; o dono usa o numérico): + e − paginam, * abre o detalhe. Pelo túnel, antes do campo:
        // o + e o * nunca entram no número nem no CPF; o − só pagina com o campo vazio (no CPF com máscara ele é digitado).
        AddHandler(KeyDownEvent, AoTeclaNumerico, RoutingStrategies.Tunnel);
        CampoFiltroVendasCentral.AddHandler(TextInputEvent, AoDigitarNoCampo, RoutingStrategies.Tunnel);
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        Desinscrever();
        _vm = DataContext as AbaVendasViewModel;
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

    /// <summary>O foco vai ao campo do número (ou ao detalhe aberto): ↑/↓, Enter, Ctrl+R e as teclas F funcionam dali.</summary>
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

    // Caixa, situação, operador e forma escolhidos pelo mouse (ou pelo teclado na lista aberta): o foco volta ao campo, para
    // Enter, F4 e ↑/↓ continuarem sendo da aba (o ComboBox com o foco abriria a lista ou trocaria a escolha; decisão 65).
    private void AoFecharLista(object? sender, EventArgs e) =>
        Dispatcher.UIThread.Post(() => Foco.Focar(CampoFiltroVendasCentral), DispatcherPriority.Loaded);

    private void AoTeclaNumerico(object? sender, KeyEventArgs e)
    {
        _suprimirTexto = false;
        // Só no campo do número, na lista e no detalhe: nos valores e no pedido do supervisor as teclas são do campo.
        if (_vm is null || _vm.Liberacao is not null || e.KeyModifiers != KeyModifiers.None
            || (e.Source is TextBox campo && campo != CampoFiltroVendasCentral))
        {
            return;
        }

        ICommand? comando = e.Key switch
        {
            Key.Add => _vm.ProximaPaginaCommand,
            Key.Subtract when string.IsNullOrEmpty(_vm.Texto) => _vm.PaginaAnteriorCommand,
            Key.Multiply => _vm.DetalharCommand,
            _ => null,
        };
        if (comando is not null)
        {
            e.Handled = true;
            _suprimirTexto = true;
            if (comando.CanExecute(null))
            {
                comando.Execute(null);
            }
        }
    }

    // A tecla do numérico que paginou (ou abriu o detalhe) não vira texto no campo, onde o sistema ainda manda o caractere.
    private void AoDigitarNoCampo(object? sender, TextInputEventArgs e)
    {
        if (_suprimirTexto && e.Text is "+" or "-" or "*")
        {
            e.Handled = true;
        }

        _suprimirTexto = false;
    }

    // O detalhe e a lista trocam de visibilidade no mesmo instante: o foco vai depois do layout.
    private void AoPedirFoco(object? sender, AlvoFocoVendas alvo) => Dispatcher.UIThread.Post(
        () => Foco.Focar(alvo == AlvoFocoVendas.Detalhe ? PainelDetalheVendaCentral : CampoFiltroVendasCentral),
        DispatcherPriority.Loaded);
}
