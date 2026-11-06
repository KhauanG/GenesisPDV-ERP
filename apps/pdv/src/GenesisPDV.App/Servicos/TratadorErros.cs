using Avalonia.Threading;
using GenesisPDV.App.ViewModels;
using Serilog;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// Tratamento global de erros (PDV 32.2): nada derruba o caixa por erro de tela. A venda em andamento já está no
/// SQLite (cada passo é um commit), então basta registrar, avisar e recarregar a tela do banco.
/// </summary>
public static class TratadorErros
{
    private static bool _processoRegistrado;

    public static void RegistrarNoProcesso()
    {
        if (_processoRegistrado)
        {
            return;
        }

        _processoRegistrado = true;
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Log.Fatal(e.ExceptionObject as Exception, "Erro fatal não tratado (o processo vai encerrar: a venda está gravada no banco local)");
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Log.Error(e.Exception, "Tarefa com erro não observado");
            e.SetObserved();
        };
    }

    public static void RegistrarNaInterface(ShellViewModel shell)
    {
        Dispatcher.UIThread.UnhandledException += (_, e) =>
        {
            e.Handled = true;
            _ = shell.TratarErroInesperadoAsync(e.Exception);
        };
    }
}
