using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;

namespace GenesisPDV.App.Views;

public partial class MainWindow : Window
{
    private MonitorInatividade? _monitor;

    public MainWindow()
    {
        InitializeComponent();
        // Bloqueio da tela por inatividade (Central do PDV, bloco G11): toda tecla e todo mouse na janela contam como uso,
        // também os que uma tela já tratou (o túnel vê antes de qualquer controle).
        AddHandler(KeyDownEvent, (_, _) => _monitor?.RegistrarAtividade(), RoutingStrategies.Tunnel, handledEventsToo: true);
        AddHandler(TextInputEvent, (_, _) => _monitor?.RegistrarAtividade(), RoutingStrategies.Tunnel, handledEventsToo: true);
        AddHandler(PointerPressedEvent, (_, _) => _monitor?.RegistrarAtividade(), RoutingStrategies.Tunnel, handledEventsToo: true);
        AddHandler(PointerMovedEvent, (_, _) => _monitor?.RegistrarAtividade(), RoutingStrategies.Tunnel, handledEventsToo: true);
        AddHandler(PointerWheelChangedEvent, (_, _) => _monitor?.RegistrarAtividade(), RoutingStrategies.Tunnel, handledEventsToo: true);
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        _monitor = (DataContext as ShellViewModel)?.Servico<MonitorInatividade>();
    }
}
