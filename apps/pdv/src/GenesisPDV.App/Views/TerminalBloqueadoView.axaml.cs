using Avalonia.Controls;
using Avalonia.Interactivity;

namespace GenesisPDV.App.Views;

public partial class TerminalBloqueadoView : UserControl
{
    public TerminalBloqueadoView() => InitializeComponent();

    /// <summary>Sem campo para digitar: a própria tela recebe o foco, para o Enter chegar ao atalho.</summary>
    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        Focus();
    }
}
