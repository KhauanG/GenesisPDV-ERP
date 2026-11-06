using Avalonia.Controls;
using Avalonia.Interactivity;

namespace GenesisPDV.App.Views;

public partial class DesativacaoView : UserControl
{
    public DesativacaoView() => InitializeComponent();

    /// <summary>Sem campo para digitar: a própria tela recebe o foco, para o atalho chegar.</summary>
    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        Focus();
    }
}
