using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using GenesisPDV.App.Comportamentos;
using GenesisPDV.App.ViewModels.Central;

namespace GenesisPDV.App.Views.Central;

public partial class CentralPdvView : UserControl
{
    private CentralPdvViewModel? _vm;

    public CentralPdvView()
    {
        InitializeComponent();
        // Toda tecla e todo clique na Central contam como uso: renovam a liberação ativa (5 min sem uso; AcessoCentral).
        AddHandler(KeyDownEvent, (_, _) => _vm?.RegistrarUso(), RoutingStrategies.Tunnel, handledEventsToo: true);
        AddHandler(PointerPressedEvent, (_, _) => _vm?.RegistrarUso(), RoutingStrategies.Tunnel, handledEventsToo: true);
    }

    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        // A Central aberta já numa aba de campo (o F3 do F12 abre a 1 Vendas): a aba pode ter chegado antes deste Loaded
        // (o foco inicial dela já correu), e o menu tomaria o foco do campo; então o foco fica com o conteúdo.
        Focar(_vm switch
        {
            { Entrando: true } => AlvoFocoCentral.Entrada,
            // A Central aberta já numa aba com cadeado (o "⇅ N" da venda leva à 4 Sincronização): o pedido do supervisor
            // veio antes desta tela, e o foco vai ao usuário dele, não ao menu.
            { Liberando: true } => AlvoFocoCentral.Liberacao,
            { Conteudo: AbaVendasViewModel or AbaCaixasViewModel or AbaHardwareViewModel or AbaSincronizacaoViewModel or AbaLogsViewModel or AbaHistoricoUsoViewModel } => AlvoFocoCentral.Conteudo,
            _ => AlvoFocoCentral.Menu,
        });
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (_vm is not null)
        {
            _vm.FocoSolicitado -= AoPedirFoco;
        }

        _vm = DataContext as CentralPdvViewModel;
        if (_vm is not null)
        {
            _vm.FocoSolicitado += AoPedirFoco;
        }
    }

    private void AoPedirFoco(object? sender, AlvoFocoCentral alvo) => Focar(alvo);

    private void Focar(AlvoFocoCentral alvo)
    {
        switch (alvo)
        {
            case AlvoFocoCentral.Entrada:
                Foco.Focar(CampoUsuarioCentral);
                break;
            case AlvoFocoCentral.Liberacao:
                Foco.Focar(CampoUsuarioLiberacaoCentral);
                break;
            case AlvoFocoCentral.Menu:
                // O botão da aba aberta (os botões nascem com o ItemsControl: depois do layout).
                Dispatcher.UIThread.Post(() =>
                {
                    var botoes = MenuCentral.GetVisualDescendants().OfType<Button>().ToList();
                    var botao = botoes.FirstOrDefault(b => b.DataContext is ItemMenuCentralViewModel { Selecionada: true }) ?? botoes.FirstOrDefault();
                    botao?.Focus(NavigationMethod.Tab);
                }, DispatcherPriority.Loaded);
                break;
            case AlvoFocoCentral.Conteudo:
                Dispatcher.UIThread.Post(() => ConteudoAba.GetVisualDescendants().OfType<IConteudoFocavel>().FirstOrDefault()?.Focar(),
                    DispatcherPriority.Loaded);
                break;
        }
    }
}
