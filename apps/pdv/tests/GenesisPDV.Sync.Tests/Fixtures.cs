using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using GenesisPDV.Sync.Protocolo;

namespace GenesisPDV.Sync.Tests;

/// <summary>Fixtures de <c>packages/shared/testes</c>, copiadas para a saída pelo link do csproj.</summary>
internal static class Fixtures
{
    public static string Pasta(string sub) => Path.Combine(AppContext.BaseDirectory, "fixtures", sub);

    public static string Sync(string arquivo) => File.ReadAllText(Path.Combine(Pasta("sync"), arquivo));

    /// <summary>
    /// <see cref="ContratosJson.Opcoes"/> recusando membro desconhecido: a ida e volta tira os nulos dos dois lados, então
    /// sem isto um campo <c>null</c> da fixture que o record não tem (ou perdeu) passaria calado. Os <see cref="JsonElement"/>
    /// (<c>linha</c>, <c>payload</c>, <c>parametros</c>) continuam livres. Só nos testes: em produção o PDV tolera campo novo.
    /// </summary>
    public static JsonSerializerOptions Estritas { get; } = new(ContratosJson.Opcoes)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    public static T Ler<T>(string arquivo) =>
        JsonSerializer.Deserialize<T>(Sync(arquivo), Estritas) ?? throw new InvalidOperationException(arquivo);

    /// <summary>
    /// Sem as propriedades nulas, em qualquer nível: o PDV não distingue <c>null</c> de ausente (escreve sem nulos, como
    /// o zod da API pede nos campos só opcionais), então a ida e volta compara os dois lados nessa forma.
    /// </summary>
    public static JsonNode? SemNulos(JsonNode? no)
    {
        switch (no)
        {
            case JsonObject objeto:
                var limpo = new JsonObject();
                foreach (var (chave, valor) in objeto)
                {
                    if (valor is not null)
                    {
                        limpo[chave] = SemNulos(valor);
                    }
                }

                return limpo;
            case JsonArray lista:
                return new JsonArray([.. lista.Select(SemNulos)]);
            default:
                return no?.DeepClone();
        }
    }

    /// <summary>Compara dois JSON pela semântica (ordem de chaves e escapes não importam), ignorando nulos.</summary>
    public static void AssertMesmoJson(string esperado, string obtido, string contexto)
    {
        var a = SemNulos(JsonNode.Parse(esperado));
        var b = SemNulos(JsonNode.Parse(obtido));
        Assert.True(JsonNode.DeepEquals(a, b), $"{contexto}: JSON diferente.\nesperado: {a?.ToJsonString()}\nobtido:   {b?.ToJsonString()}");
    }
}
