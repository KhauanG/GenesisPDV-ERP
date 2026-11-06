using Avalonia.Controls;
using Avalonia.Interactivity;

namespace GenesisPDV.App.Views;

public partial class ErroFatalView : UserControl
{
    public ErroFatalView() => InitializeComponent();

    /// <summary>Sem campo para digitar: a própria tela recebe o foco, para o F2 chegar ao atalho do pacote de suporte.</summary>
    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        Focus();
    }
}
