using System.Globalization;
using Avalonia;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Data;
using Serilog;
using Serilog.Extensions.Logging;

namespace GenesisPDV.App;

internal static class Programa
{
    [STAThread]
    public static int Main(string[] args)
    {
        if (args is [ConfiguracaoBuild.ArgumentoInfoBuild, var arquivo, ..])
        {
            // Conferência do executável publicado (CI, I3): versão, URL padrão e modo de demonstração; nada de tela nem banco.
            ConfiguracaoBuild.GravarInfo(arquivo);
            return 0;
        }

        // Linux (.deb, I3): umask 007 antes de criar qualquer arquivo, para as outras contas do grupo genesispdv escreverem
        // no log do dia, nos backups e no banco (PermissoesGrupo). No Windows não faz nada.
        PermissoesGrupo.AplicarUmask();

        // Um PDV por computador (SYNC 23, cenário 13); o processo do reinício (C17) espera o anterior terminar de sair.
        using var instancia = InstanciaUnica.Adquirir(InstanciaUnica.NomePadrao,
            args.Contains(InstanciaUnica.ArgumentoReinicio) ? InstanciaUnica.EsperaReinicio : TimeSpan.Zero);
        if (!instancia.PodeAbrir)
        {
            Console.Error.WriteLine("O GenesisPDV já está aberto neste computador.");
            InstanciaUnica.AvisarJaAberto();
            return 2;
        }

        ConfigurarCultura();
        var caminhos = CaminhosPdv.Padrao();
        caminhos.CriarPastas();
        // Log do dia (Central do PDV, G2; README › decisão 67): sem o ruído do HttpClient, até 20 MB por arquivo e o código
        // do terminal em cada linha depois que a identidade é lida.
        Log.Logger = ConfiguracaoLog.Criar(caminhos.PastaLogs, EnriquecedorTerminal.Processo, VersaoApp.Atual).CreateLogger();
        TratadorErros.RegistrarNoProcesso();
        try
        {
            Log.Information("GenesisPDV {Versao} iniciando ({Sistema}); dados em {Pasta}", VersaoApp.Atual, Environment.OSVersion, caminhos.PastaDados);
            if (instancia.FalhaTrava is { } falha)
            {
                Log.Warning("Sem a trava de instância única ({Falha}): o PDV abre assim mesmo", falha);
            }

            App.Servicos = Inicializacao.CriarServicos(caminhos, new SerilogLoggerFactory(Log.Logger));
            return BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
        }
        catch (Exception e)
        {
            Log.Fatal(e, "Falha ao iniciar o GenesisPDV");
            return 1;
        }
        finally
        {
            Log.CloseAndFlush();
        }
    }

    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>().UsePlatformDetect().WithInterFont().LogToTrace();

    public static void ConfigurarCultura()
    {
        var ptBr = CultureInfo.GetCultureInfo("pt-BR");
        CultureInfo.DefaultThreadCurrentCulture = ptBr;
        CultureInfo.DefaultThreadCurrentUICulture = ptBr;
        CultureInfo.CurrentCulture = ptBr;
        CultureInfo.CurrentUICulture = ptBr;
    }
}
