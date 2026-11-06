using Avalonia;
using Avalonia.Headless;
using GenesisPDV.App;

[assembly: AvaloniaTestApplication(typeof(GenesisPDV.App.Tests.AppTeste))]

namespace GenesisPDV.App.Tests;

/// <summary>Aplicativo real com a plataforma headless e renderização Skia (permite capturar telas em PNG).</summary>
public static class AppTeste
{
    public static AppBuilder BuildAvaloniaApp()
    {
        Programa.ConfigurarCultura();
        return AppBuilder.Configure<App>()
            .UseSkia()
            .WithInterFont()
            .UseHeadless(new AvaloniaHeadlessPlatformOptions { UseHeadlessDrawing = false });
    }
}
