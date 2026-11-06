using System.Text.Json;
using GenesisPDV.Fiscal.Validadores;

namespace GenesisPDV.Fiscal.Tests;

/// <summary>Roda a tabela <c>packages/shared/src/validadores.casos.json</c>, a mesma do lado TypeScript.</summary>
public class ValidadoresTests
{
    private static readonly JsonElement Casos = JsonDocument.Parse(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "validadores.casos.json"))).RootElement;

    public static TheoryData<string, bool> CasosDe(string grupo)
    {
        var dados = new TheoryData<string, bool>();
        foreach (var caso in Casos.GetProperty(grupo).EnumerateArray())
        {
            dados.Add(caso.GetProperty("valor").GetString()!, caso.GetProperty("valido").GetBoolean());
        }

        return dados;
    }

    public static TheoryData<string, string> CasosCompletarCnpj()
    {
        var dados = new TheoryData<string, string>();
        foreach (var caso in Casos.GetProperty("completarCnpj").EnumerateArray())
        {
            dados.Add(caso.GetProperty("base").GetString()!, caso.GetProperty("cnpj").GetString()!);
        }

        return dados;
    }

    [Theory]
    [MemberData(nameof(CasosDe), "cpf")]
    public void Cpf(string valor, bool valido) => Assert.Equal(valido, CpfValidador.Validar(valor));

    [Theory]
    [MemberData(nameof(CasosDe), "cnpj")]
    public void Cnpj(string valor, bool valido) => Assert.Equal(valido, CnpjValidador.Validar(valor));

    [Theory]
    [MemberData(nameof(CasosCompletarCnpj))]
    public void Completar_cnpj(string base12, string cnpj) => Assert.Equal(cnpj, CnpjValidador.Completar(base12));

    [Theory]
    [MemberData(nameof(CasosDe), "chaveAcesso")]
    public void Chave_de_acesso(string valor, bool valido) => Assert.Equal(valido, ChaveAcessoValidador.Validar(valor));

    [Fact]
    public void Tabela_tem_casos_de_todos_os_grupos()
    {
        foreach (var grupo in new[] { "cpf", "cnpj", "completarCnpj", "chaveAcesso" })
        {
            Assert.True(Casos.GetProperty(grupo).GetArrayLength() >= 3, grupo);
        }
    }
}
