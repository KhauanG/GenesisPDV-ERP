using System.Globalization;
using System.Text.Json.Nodes;
using GenesisPDV.Sync.Protocolo;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// Vetores JCS de <c>packages/shared/testes/jcs/vetores.json</c>, os mesmos do <c>jcs.spec.ts</c>: um hash diferente entre
/// o PDV e a API vira <c>PAYLOAD_INVALIDO</c> em todo evento (SYNC 7.1).
/// </summary>
public class JcsVetoresTests
{
    private static JsonArray Vetores() =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(Fixtures.Pasta("jcs"), "vetores.json")))!["vetores"]!.AsArray();

    public static TheoryData<string> Descricoes()
    {
        var dados = new TheoryData<string>();
        foreach (var v in Vetores())
        {
            dados.Add(v!["descricao"]!.GetValue<string>());
        }

        return dados;
    }

    [Theory]
    [MemberData(nameof(Descricoes))]
    public void Vetor_da_mesma_saida_e_sha256_que_o_TypeScript(string descricao)
    {
        var vetor = Vetores().Single(v => v!["descricao"]!.GetValue<string>() == descricao)!;
        var saida = Jcs.Serializar(vetor["entrada"]);
        Assert.Equal(vetor["saida"]!.GetValue<string>(), saida);
        Assert.Equal(vetor["sha256"]!.GetValue<string>(), Jcs.Sha256Hex(saida));
    }

    [Theory]
    [InlineData(1e21, "1e+21")]
    [InlineData(1e20, "100000000000000000000")]
    [InlineData(1e-7, "1e-7")]
    [InlineData(0.000001, "0.000001")]
    [InlineData(123.456, "123.456")]
    [InlineData(-0.5, "-0.5")]
    [InlineData(1.5e300, "1.5e+300")]
    [InlineData(5e-324, "5e-324")]
    public void Numero_no_formato_ES6(double numero, string esperado) =>
        Assert.Equal(esperado, Jcs.NumeroEs6(numero));

    [Fact]
    public void Numero_ES6_volta_ao_mesmo_double()
    {
        foreach (var n in new[] { 0.1, 1.0 / 3, 2.5e-8, 9007199254740991d, 4.35, 1e22 })
        {
            Assert.Equal(n, double.Parse(Jcs.NumeroEs6(n), CultureInfo.InvariantCulture));
        }
    }
}
