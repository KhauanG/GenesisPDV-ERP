namespace GenesisPDV.Data.Tests;

/// <summary>
/// As classes com o volume sintético do G5 (120 mil vendas e o outbox delas) medem cada consulta contra os 300 ms do
/// plano: rodam uma de cada vez e fora do paralelismo do resto da montagem (Central do PDV, bloco G7). Juntas, as três
/// cargas de 120 mil vendas disputavam o disco e a CPU e a medição de uma pegava o pico da outra.
/// </summary>
[CollectionDefinition(Nome, DisableParallelization = true)]
public sealed class ColecaoVolumeSintetico
{
    public const string Nome = "Volume sintético";

    /// <summary>
    /// O teto de cada consulta: os 300 ms do plano, ou o que o CI pedir em <c>GENESISPDV_TETO_CONSULTA_MS</c> (os runners
    /// do GitHub, sobretudo o Windows, oscilam bem mais que um computador de caixa; a meta de 300 ms continua no teste
    /// local e no log do diagnóstico).
    /// </summary>
    public static TimeSpan TetoConsulta { get; } = TimeSpan.FromMilliseconds(
        int.TryParse(Environment.GetEnvironmentVariable("GENESISPDV_TETO_CONSULTA_MS"), out var ms) && ms > 0 ? ms : 300);
}
