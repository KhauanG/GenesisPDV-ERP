using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Input;
using Avalonia.LogicalTree;
using Avalonia.Threading;
using Avalonia.VisualTree;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.App.ViewModels.Central;
using GenesisPDV.App.Views;
using GenesisPDV.Data;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>Um PDV completo numa pasta temporária, com janela headless e teclado simulado.</summary>
public sealed class AmbienteUi : IDisposable
{
    private readonly bool _apagar;

    private AmbienteUi(string raiz, bool apagar, Action<IServiceCollection>? ajustar)
    {
        Raiz = raiz;
        _apagar = apagar;
        Caminhos = CaminhosPdv.SobRaiz(raiz);
        Servicos = Inicializacao.CriarServicos(Caminhos, ajustar: ajustar);
        Shell = Servicos.GetRequiredService<ShellViewModel>();
        Janela = new MainWindow { DataContext = Shell, Width = 1366, Height = 768 };
        Janela.Show();
    }

    public string Raiz { get; }
    public CaminhosPdv Caminhos { get; }
    public ServiceProvider Servicos { get; }
    public ShellViewModel Shell { get; }
    public MainWindow Janela { get; }

    public static string NovaRaiz() => Path.Combine(Path.GetTempPath(), "genesispdv-ui", Guid.NewGuid().ToString("N"));

    /// <param name="ajustar">Troca serviços antes de montar o PDV (ex.: o cliente do sync contra a <c>ApiFalsa</c>).</param>
    public static async Task<AmbienteUi> IniciarAsync(string? raiz = null, bool apagar = true, Action<IServiceCollection>? ajustar = null)
    {
        var ambiente = new AmbienteUi(raiz ?? NovaRaiz(), apagar, ajustar);
        await ambiente.Shell.IniciarAsync();
        await ambiente.EsperarAsync(() => ambiente.Shell.PaginaAtual is not null);
        return ambiente;
    }

    public async Task<VendaViewModel> AtivarDemonstracaoELogarAsync(string usuario = "1", string senha = "1234", string fundo = "0")
    {
        if (Shell.PaginaAtual is AtivacaoViewModel)
        {
            await EsperarAsync(() => Janela.FocusManager?.GetFocusedElement() is not null, "foco no assistente");
            Tecla(Key.F8);
            await EsperarAsync(() => Shell.PaginaAtual is LoginViewModel);
        }

        return await LogarAsync(usuario, senha, fundo);
    }

    /// <summary>
    /// Login e, sem sessão aberta, a abertura do caixa pelo teclado com o <paramref name="fundo"/> (PDV 8.2; Fase 1C,
    /// C10a): a venda só começa com o caixa aberto.
    /// </summary>
    public async Task<VendaViewModel> LogarAsync(string usuario = "1", string senha = "1234", string fundo = "0")
    {
        await EntrarAsync(usuario, senha);
        await EsperarAsync(() => Shell.PaginaAtual is VendaViewModel or AberturaCaixaViewModel, "venda ou abertura");
        if (Shell.PaginaAtual is AberturaCaixaViewModel)
        {
            await AbrirCaixaAsync(fundo);
        }

        await EsperarFocoAsync("CampoCodigo");
        return (VendaViewModel)Shell.PaginaAtual!;
    }

    /// <summary>Só o login (usuário, Tab, PIN, Enter); a tela seguinte fica para o teste.</summary>
    public async Task EntrarAsync(string usuario, string senha)
    {
        await EsperarFocoAsync("CampoUsuario");
        Digitar(usuario);
        Tecla(Key.Tab);
        Digitar(senha);
        Tecla(Key.Enter);
    }

    /// <summary>Na tela de abertura: digita o fundo e Enter (confirma de novo se o valor difere do herdado).</summary>
    public async Task AbrirCaixaAsync(string fundo)
    {
        await EsperarFocoAsync("CampoFundo");
        var abertura = (AberturaCaixaViewModel)Shell.PaginaAtual!;
        abertura.Fundo = string.Empty;
        Digitar(fundo);
        Tecla(Key.Enter);
        await Pausa();
        if (Shell.PaginaAtual is AberturaCaixaViewModel { Aviso: AberturaCaixaViewModel.MensagemConfirmarDiferenca })
        {
            Tecla(Key.Enter);
        }

        await EsperarAsync(() => Shell.PaginaAtual is VendaViewModel, "venda depois da abertura");
    }

    /// <summary>
    /// Liga a gaveta na configuração do terminal (desligada por padrão; dono, I4): na impressora simulada, a
    /// <c>GavetaSimulada</c> conta as aberturas. <paramref name="nosMovimentos"/> = também abertura, sangria, reforço,
    /// fechamento e devolução em dinheiro.
    /// </summary>
    public Task LigarGavetaAsync(bool nosMovimentos = false)
    {
        var hardware = Servicos.GetRequiredService<ServicoHardware>();
        return hardware.GravarAsync(hardware.Atual with { Gaveta = new Hardware.Gaveta.ConfiguracaoGaveta(Ligada: true, AbreNosMovimentos: nosMovimentos) }, null, null);
    }

    public void Digitar(string texto)
    {
        Janela.KeyTextInput(texto);
        Dispatcher.UIThread.RunJobs();
    }

    public void Tecla(Key tecla, RawInputModifiers modificadores = RawInputModifiers.None)
    {
        Janela.KeyPress(tecla, modificadores, PhysicalKey.None, null);
        Janela.KeyRelease(tecla, modificadores, PhysicalKey.None, null);
        Dispatcher.UIThread.RunJobs();
    }

    public async Task EntrarCodigoAsync(string codigo)
    {
        Digitar(codigo);
        Tecla(Key.Enter);
        await Pausa();
    }

    /// <summary>Clique do mouse no centro do controle (decisão 65: os botões da barra e das telas do caixa).</summary>
    public void Clicar(Control controle)
    {
        var ponto = Centro(controle);
        Janela.MouseMove(ponto);
        Janela.MouseDown(ponto, MouseButton.Left);
        Janela.MouseUp(ponto, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
    }

    /// <summary>Duplo clique no centro do controle (a janela do item, a pesquisa).</summary>
    public void DuploClique(Control controle)
    {
        var ponto = Centro(controle);
        Janela.MouseMove(ponto);
        Janela.MouseDown(ponto, MouseButton.Left);
        Janela.MouseUp(ponto, MouseButton.Left);
        Janela.MouseDown(ponto, MouseButton.Left);
        Janela.MouseUp(ponto, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
    }

    /// <summary>O botão da barra de funções da venda com a <paramref name="tecla"/> ("F3", "Shift+F4").</summary>
    public Button BotaoDaBarra(string tecla) =>
        Janela.GetVisualDescendants().OfType<Button>().FirstOrDefault(b => b.DataContext is AtalhoBarraViewModel a && a.Tecla == tecla)
        ?? throw new InvalidOperationException($"Botão {tecla} não encontrado na barra.");

    /// <summary>O botão da aba <paramref name="codigo"/> ("0" a "9", "P") no menu lateral da Central do PDV.</summary>
    public Button BotaoDaAba(string codigo) =>
        Controle<ItemsControl>("MenuCentral").GetVisualDescendants().OfType<Button>()
            .FirstOrDefault(b => b.DataContext is ItemMenuCentralViewModel i && i.Codigo == codigo)
        ?? throw new InvalidOperationException($"Aba {codigo} não encontrada no menu da Central.");

    /// <summary>O código da aba cujo botão do menu da Central tem o foco (nulo com o foco em outro lugar).</summary>
    public string? AbaFocada() =>
        Janela.FocusManager?.GetFocusedElement() is Button { DataContext: ItemMenuCentralViewModel i } ? i.Codigo : null;

    /// <summary>A Central do PDV aberta (pela venda ou depois do PIN do login), com o foco no menu.</summary>
    public async Task<CentralPdvViewModel> EsperarCentralAsync()
    {
        await EsperarAsync(() => Shell.PaginaAtual is CentralPdvViewModel { Aberta: true }, "Central do PDV aberta");
        await EsperarAsync(() => AbaFocada() is not null, "foco no menu da Central");
        return (CentralPdvViewModel)Shell.PaginaAtual!;
    }

    /// <summary>No login: Ctrl+Alt+C, o usuário e o PIN da Central e Enter.</summary>
    public async Task<CentralPdvViewModel> EntrarNaCentralPeloLoginAsync(string usuario, string pin)
    {
        Tecla(Key.C, RawInputModifiers.Control | RawInputModifiers.Alt);
        await EsperarFocoAsync("CampoUsuarioCentral");
        var central = (CentralPdvViewModel)Shell.PaginaAtual!;
        central.Usuario = usuario;
        central.Pin = pin;
        Tecla(Key.Enter);
        return await EsperarCentralAsync();
    }

    /// <summary>
    /// Com o foco no menu da Central: o 3 (Impressora e gaveta); sem <c>pdv.config.terminal</c>, a aba pede e
    /// <paramref name="usuarioLibera"/> libera. Devolve a aba já na edição, com o foco no modelo.
    /// </summary>
    public async Task<AbaHardwareViewModel> AbrirAbaHardwareAsync(string? usuarioLibera = null, string? pinLibera = null)
    {
        var central = (CentralPdvViewModel)Shell.PaginaAtual!;
        Tecla(Key.D3);
        await EsperarAsync(() => central.Conteudo is AbaHardwareViewModel, "aba 3 Impressora e gaveta");
        var aba = (AbaHardwareViewModel)central.Conteudo!;
        if (usuarioLibera is not null)
        {
            await EsperarFocoAsync("CampoUsuarioConfig");
            aba.Usuario = usuarioLibera;
            aba.Pin = pinLibera ?? string.Empty;
            Tecla(Key.Enter);
        }

        await EsperarFocoAsync("ListaModelo");
        return aba;
    }

    /// <summary>A linha da lista <paramref name="lista"/> cujo modelo satisfaz <paramref name="filtro"/>.</summary>
    public ListBoxItem LinhaDaLista(string lista, Func<object?, bool> filtro) =>
        Controle<ListBox>(lista).GetVisualDescendants().OfType<ListBoxItem>().FirstOrDefault(i => filtro(i.DataContext))
        ?? throw new InvalidOperationException($"Linha não encontrada em {lista}.");

    private Point Centro(Control controle)
    {
        Dispatcher.UIThread.RunJobs();
        return controle.TranslatePoint(new Point(controle.Bounds.Width / 2, controle.Bounds.Height / 2), Janela)
               ?? throw new InvalidOperationException($"Controle {controle.Name} fora da janela.");
    }

    public T Controle<T>(string nome) where T : Control =>
        Janela.GetVisualDescendants().OfType<T>().FirstOrDefault(c => c.Name == nome)
        ?? Janela.GetLogicalDescendants().OfType<T>().FirstOrDefault(c => c.Name == nome)
        ?? throw new InvalidOperationException($"Controle {nome} não encontrado na tela.");

    public string? Texto(string nome) => Controle<TextBlock>(nome).Text;

    public string? NomeFocado() => (Janela.FocusManager?.GetFocusedElement() as Control)?.Name;

    public async Task EsperarFocoAsync(string nome) => await EsperarAsync(() => NomeFocado() == nome, $"foco em {nome}");

    public async Task EsperarAsync(Func<bool> condicao, string? descricao = null, int timeoutMs = 10_000)
    {
        var limite = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condicao())
        {
            if (DateTime.UtcNow > limite)
            {
                throw new TimeoutException($"Condição não atingida: {descricao ?? "?"} (foco em {NomeFocado() ?? "nada"}).");
            }

            Dispatcher.UIThread.RunJobs();
            await Task.Delay(10);
        }

        Dispatcher.UIThread.RunJobs();
    }

    public static async Task Pausa()
    {
        for (var i = 0; i < 5; i++)
        {
            Dispatcher.UIThread.RunJobs();
            await Task.Delay(5);
        }
    }

    public void Captura(string nome)
    {
        var pasta = Environment.GetEnvironmentVariable("GENESISPDV_CAPTURAS");
        if (string.IsNullOrWhiteSpace(pasta))
        {
            return;
        }

        Directory.CreateDirectory(pasta);
        Dispatcher.UIThread.RunJobs();
        using var quadro = Janela.CaptureRenderedFrame();
        quadro?.Save(Path.Combine(pasta, $"pdv-{nome}.png"), Avalonia.Media.Imaging.PngBitmapEncoderOptions.Default);
    }

    public void Dispose()
    {
        Janela.Close();
        Servicos.Dispose();
        SqliteConnection.ClearAllPools();
        if (_apagar)
        {
            try
            {
                Directory.Delete(Raiz, recursive: true);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // No Windows o SQLite (WAL/shm) ou o log podem segurar o arquivo por alguns ms; a pasta fica no %TEMP%.
            }
        }
    }
}
