using System.Text.Json;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// Preferências da tela do caixa deste computador (PDV 6.8; versão 0.9.1, decisão 65 do README), gravadas em
/// <c>configuracao_terminal</c> pela configuração do terminal, junto da impressora e da gaveta.
/// </summary>
/// <param name="BarraBotoes">
/// Barra de funções da venda com botões clicáveis (padrão) — para o caixa só com teclado numérico, o mouse ou o toque
/// fazem o que as teclas F fazem —; desligada, a legenda em texto de antes.
/// </param>
/// <param name="PesquisaSoNumeros">
/// Pesquisa de produto só por números (padrão: desligada): só dígitos, procurados nos códigos (interno, EAN, adicionais).
/// </param>
public sealed record PreferenciasCaixa(bool BarraBotoes = true, bool PesquisaSoNumeros = false)
{
    public static PreferenciasCaixa Padrao { get; } = new();
}

/// <summary>
/// Chaves das <see cref="PreferenciasCaixa"/> em <c>configuracao_terminal</c> (MD 4.4.2, grupo Tela), valores em JSON como
/// as de <c>ChavesHardware</c>. Chave ausente ou valor desconhecido = o padrão (nunca impede o caixa de abrir).
/// </summary>
public static class ChavesPreferencias
{
    /// <summary><c>"botoes"</c> (padrão) ou <c>"texto"</c>.</summary>
    public const string BarraFuncoes = "tela.barra_funcoes";

    /// <summary>Booleano, padrão <c>false</c>.</summary>
    public const string PesquisaSomenteNumeros = "pesquisa.somente_numeros";

    public const string Botoes = "botoes";
    public const string Texto = "texto";

    public static IReadOnlyList<string> Todas { get; } = [BarraFuncoes, PesquisaSomenteNumeros];

    public static PreferenciasCaixa Ler(IReadOnlyDictionary<string, string> valores)
    {
        ArgumentNullException.ThrowIfNull(valores);
        return new PreferenciasCaixa(
            BarraBotoes: Valor<string>(valores, BarraFuncoes) != Texto,
            PesquisaSoNumeros: Valor<bool?>(valores, PesquisaSomenteNumeros) ?? false);
    }

    public static IReadOnlyDictionary<string, string> Escrever(PreferenciasCaixa p)
    {
        ArgumentNullException.ThrowIfNull(p);
        return new Dictionary<string, string>
        {
            [BarraFuncoes] = JsonSerializer.Serialize(p.BarraBotoes ? Botoes : Texto),
            [PesquisaSomenteNumeros] = JsonSerializer.Serialize(p.PesquisaSoNumeros),
        };
    }

    private static T? Valor<T>(IReadOnlyDictionary<string, string> valores, string chave)
    {
        if (!valores.TryGetValue(chave, out var json))
        {
            return default;
        }

        try
        {
            return JsonSerializer.Deserialize<T>(json);
        }
        catch (JsonException)
        {
            return default;
        }
    }
}
