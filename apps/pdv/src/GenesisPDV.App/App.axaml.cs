using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.App.Views;
using GenesisPDV.Data;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App;

public partial class App : Application
{
    /// <summary>Serviços criados pelo <see cref="Programa"/>; nos testes headless cada teste cria os seus.</summary>
    public static IServiceProvider? Servicos { get; set; }

    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var servicos = Servicos ??= Inicializacao.CriarServicos(CaminhosPdv.Padrao());
            var shell = servicos.GetRequiredService<ShellViewModel>();
            TratadorErros.RegistrarNaInterface(shell);
            var janela = new MainWindow { DataContext = shell };
            desktop.MainWindow = janela;
            desktop.ShutdownRequested += (_, e) =>
            {
                // Alt+F4 com venda em andamento é bloqueado (PDV 7.4): a venda nunca fica para trás sem querer. Fora da tela
                // de venda (terminal desativado ou bloqueado no meio da venda) a venda fica gravada e o app pode fechar.
                if (servicos.GetRequiredService<ServicoVenda>().VendaAberta && shell.PaginaAtual is VendaViewModel or TelaBloqueadaViewModel)
                {
                    e.Cancel = true;
                    shell.ErroGlobal = "Há uma venda em andamento: conclua ou cancele (Shift+F4) antes de sair.";
                }
            };
            shell.AoReiniciar = () =>
            {
                // Depois de restaurar um backup (C17): um processo novo abre o banco restaurado do zero; este só sai.
                if (Environment.ProcessPath is { } exe)
                {
                    // O novo espera este soltar a trava de instância única (o backup de saída ainda pode estar rodando).
                    var inicio = new System.Diagnostics.ProcessStartInfo(exe) { UseShellExecute = false };
                    inicio.ArgumentList.Add(InstanciaUnica.ArgumentoReinicio);
                    System.Diagnostics.Process.Start(inicio);
                }

                desktop.Shutdown();
            };
            desktop.Exit += (_, _) =>
            {
                // PDV 32.5: backup de saída e o encerramento.json; fora da thread da tela, com prazo (nunca prende a saída).
                var backup = servicos.GetRequiredService<ServicoBackup>();
                try
                {
                    if (!Task.Run(backup.EncerrarAsync).Wait(TimeSpan.FromSeconds(60)))
                    {
                        Serilog.Log.Warning("Backup de saída não terminou em 60 s: o app fechou sem o encerramento.json");
                    }
                }
                catch (AggregateException e)
                {
                    Serilog.Log.Error(e, "Backup de saída falhou: o app fechou sem o encerramento.json");
                }
            };
            // O IniciarAsync troca qualquer falha pela tela de erro (nunca a janela vazia); a continuação só garante que
            // nada escape sem log.
            _ = shell.IniciarAsync().ContinueWith(
                t => Serilog.Log.Fatal(t.Exception, "Abertura do PDV falhou"), CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
        }

        base.OnFrameworkInitializationCompleted();
    }
}
