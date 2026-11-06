using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels;

namespace GenesisPDV.App.Views;

public partial class AtivacaoView : UserControl
{
    public AtivacaoView() => InitializeComponent();

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (DataContext is AtivacaoViewModel vm)
        {
            vm.FocoPedido += (_, _) => FocarPasso(vm);
            if (TopLevel.GetTopLevel(this) is not null)
            {
                FocarPasso(vm);
            }
        }
    }

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        if (DataContext is AtivacaoViewModel vm)
        {
            FocarPasso(vm);
        }
    }

    /// <summary>Foco inicial de cada passo (PDV 32.8): o primeiro campo, ou o próprio assistente quando o passo não tem campo.</summary>
    private void FocarPasso(AtivacaoViewModel vm)
    {
        InputElement alvo = vm.Passo switch
        {
            AtivacaoViewModel.PassoConexao => CampoUrl,
            AtivacaoViewModel.PassoCodigo => CampoCodigoEmpresa,
            _ => this,
        };
        Foco.Focar(alvo);
    }
}
