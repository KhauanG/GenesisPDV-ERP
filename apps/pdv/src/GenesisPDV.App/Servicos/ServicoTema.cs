using Avalonia;
using Avalonia.Styling;
using GenesisPDV.Data.Repositorios;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// Tema escuro/claro (configuração local <c>tela.tema</c>, PDV 6.8). Padrão: escuro. Quem grava (o Ctrl+Alt+T e a aba 7
/// Parâmetros da Central, com a auditoria) é o <see cref="ServicoParametrosLocais"/>; aqui só se lê e se aplica.
/// </summary>
public sealed class ServicoTema(RepositorioTerminal terminal)
{
    public const string Chave = "tela.tema";
    public const string Escuro = "escuro";
    public const string Claro = "claro";

    public string Atual { get; private set; } = Escuro;

    public async Task CarregarAsync()
    {
        Aplicar(await terminal.ObterConfiguracaoAsync<string>(Chave) ?? Escuro);
    }

    public void Aplicar(string tema)
    {
        Atual = tema == Claro ? Claro : Escuro;
        if (Application.Current is { } app)
        {
            app.RequestedThemeVariant = Atual == Claro ? ThemeVariant.Light : ThemeVariant.Dark;
        }
    }
}
