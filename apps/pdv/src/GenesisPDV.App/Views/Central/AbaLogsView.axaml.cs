using System.Windows.Input;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels.Central;

namespace GenesisPDV.App.Views.Central;

public partial class AbaLogsView : UserControl, IConteudoFocavel
{
    private AbaLogsViewModel? _vm;

    /// <summary>A última tecla foi um atalho do numérico: o caractere que o sistema manda depois não entra no campo.</summary>
    private bool _suprimirTexto;

    public AbaLogsView()
    {
        InitializeComponent();
        // Pelo túnel, antes do campo: na lista ↑/↓ escolhem e PgUp/PgDn (+ e − do numérico) paginam; no detalhe as setas,
        // as páginas e o 8/2/9/3 do numérico rolam; o * abre (ou fecha) o detalhe. O − só pagina com o campo vazio.
        AddHandler(KeyDownEvent, AoTecla, RoutingStrategies.Tunnel);
        CampoFiltroLogs.AddHandler(TextInputEvent, AoDigitarNoCampo, RoutingStrategies.Tunnel);
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        Desinscrever();
        _vm = DataContext as AbaLogsViewModel;
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

    /// <summary>O foco vai ao campo do texto (ou ao detalhe aberto).</summary>
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

    // Nível, período, dia e origem escolhidos pelo mouse: o foco volta ao campo, para Enter, F4 e ↑/↓ continuarem sendo da
    // aba (o ComboBox com o foco abriria a lista ou trocaria a escolha; decisão 65).
    private void AoFecharLista(object? sender, EventArgs e) =>
        Dispatcher.UIThread.Post(() => Foco.Focar(CampoFiltroLogs), DispatcherPriority.Loaded);

    private void AoTecla(object? sender, KeyEventArgs e)
    {
        _suprimirTexto = false;
        if (_vm is null || e.KeyModifiers != KeyModifiers.None || e.Source is ComboBox)
        {
            return;
        }

        if (_vm.MostrandoDetalhe)
        {
            if (Rolar(e.Key))
            {
                e.Handled = true;
            }
            else if (e.Key == Key.Multiply)
            {
                e.Handled = true;
                _vm.DetalharCommand.Execute(null);
            }

            return;
        }

        ICommand? comando = e.Key switch
        {
            Key.Up => _vm.MoverCommand,
            Key.Down => _vm.MoverCommand,
            Key.PageDown or Key.Add => _vm.ProximaPaginaCommand,
            Key.PageUp => _vm.PaginaAnteriorCommand,
            Key.Subtract when string.IsNullOrEmpty(_vm.Texto) => _vm.PaginaAnteriorCommand,
            Key.Multiply => _vm.DetalharCommand,
            _ => null,
        };
        if (comando is null)
        {
            return;
        }

        e.Handled = true;
        _suprimirTexto = e.Key is Key.Add or Key.Subtract or Key.Multiply;
        object? parametro = e.Key switch
        {
            Key.Up => "acima",
            Key.Down => "abaixo",
            _ => null,
        };
        if (comando.CanExecute(parametro))
        {
            comando.Execute(parametro);
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

    /// <summary>No detalhe: ↑/↓ (8/2) umas linhas, PgUp/PgDn (9/3) uma página.</summary>
    private bool Rolar(Key tecla)
    {
        const double linhas = 48;
        var rolagem = RolagemDetalheLogs;
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
    private void AoPedirFoco(object? sender, AlvoFocoLogs alvo) => Dispatcher.UIThread.Post(
        () => Foco.Focar(alvo == AlvoFocoLogs.Detalhe ? PainelDetalheLogs : CampoFiltroLogs),
        DispatcherPriority.Loaded);
}
