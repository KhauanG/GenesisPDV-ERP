using System.Reflection;
using System.Text.Json;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Central do PDV, bloco G11 (aba 7 Parâmetros; plano 4.5; spec 6.9; README › decisão 75): toda regra da loja que o PDV lê
/// (as chaves de <see cref="ChavesConfiguracao"/>, achadas por reflexão) tem rótulo, tipo, padrão igual ao do código e onde
/// mudar no ERP; nenhuma chave interna do terminal entra; o valor aparece em português e o de outro tipo vale o padrão.
/// </summary>
public class CatalogoRotulosConfiguracaoTests
{
    /// <summary>As constantes de <see cref="ChavesConfiguracao"/> que são chaves (as que são valores, como "horario", não têm ponto).</summary>
    private static IReadOnlyList<string> ChavesDoPdv() =>
    [
        .. typeof(ChavesConfiguracao).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f.IsLiteral && f.FieldType == typeof(string))
            .Select(f => (string)f.GetRawConstantValue()!)
            .Where(v => v.Contains('.', StringComparison.Ordinal)),
    ];

    [Fact]
    public void Toda_chave_que_o_pdv_le_tem_rotulo_e_nenhuma_a_mais()
    {
        var chaves = ChavesDoPdv();
        Assert.True(chaves.Count >= 20, "a reflexão achou as chaves");
        Assert.Equal(chaves.Order(StringComparer.Ordinal), CatalogoRotulosConfiguracao.Todos.Select(r => r.Chave).Order(StringComparer.Ordinal));
        Assert.All(CatalogoRotulosConfiguracao.Todos, r =>
        {
            Assert.False(string.IsNullOrWhiteSpace(r.Rotulo));
            Assert.StartsWith("ERP ›", CatalogoRotulosConfiguracao.OndeMudar(r), StringComparison.Ordinal);
            Assert.DoesNotContain(r.Chave, ChavesConfiguracaoTerminal.Internas);
            Assert.False(ChavesExibiveis.Todas.Contains(r.Chave), $"{r.Chave} é da loja, não do terminal");
        });
    }

    [Fact]
    public void Os_padroes_do_catalogo_sao_os_que_o_caixa_usa()
    {
        foreach (var (chave, padrao) in ChavesConfiguracao.PadroesBool)
        {
            Assert.Equal(padrao ? "true" : "false", CatalogoRotulosConfiguracao.De(chave)!.PadraoJson);
        }

        Assert.Equal(ChavesConfiguracao.HorasAlertaSessaoPadrao, JsonSerializer.Deserialize<int>(CatalogoRotulosConfiguracao.De(ChavesConfiguracao.HorasAlertaSessao)!.PadraoJson));
        Assert.Equal(ChavesConfiguracao.HoraCortePadrao.ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture),
            JsonSerializer.Deserialize<string>(CatalogoRotulosConfiguracao.De(ChavesConfiguracao.HoraCorteDiaOperacional)!.PadraoJson));
        Assert.Equal(ChavesConfiguracao.DescontoCascosMaxSemSupervisorPadrao,
            decimal.Parse(JsonSerializer.Deserialize<string>(CatalogoRotulosConfiguracao.De(ChavesConfiguracao.DescontoCascosMaxSemSupervisor)!.PadraoJson)!,
                System.Globalization.CultureInfo.InvariantCulture));
        Assert.Equal(ChavesConfiguracao.ToleranciaPadrao,
            decimal.Parse(JsonSerializer.Deserialize<string>(CatalogoRotulosConfiguracao.De(ChavesConfiguracao.ToleranciaDiferencaCaixa)!.PadraoJson)!,
                System.Globalization.CultureInfo.InvariantCulture));
        Assert.Equal("null", CatalogoRotulosConfiguracao.De(ChavesConfiguracao.DiasMaxOffline)!.PadraoJson);
        Assert.Equal("null", CatalogoRotulosConfiguracao.De(ChavesConfiguracao.ValorLimiteSangria)!.PadraoJson);
    }

    [Theory]
    [InlineData(ChavesConfiguracao.FechamentoCego, "false", OrigemConfiguracao.Loja, "Não", "para esta loja", false)]
    [InlineData(ChavesConfiguracao.FechamentoCego, null, OrigemConfiguracao.Padrao, "Sim", "padrão do sistema", false)]
    [InlineData(ChavesConfiguracao.HorasAlertaSessao, "12", OrigemConfiguracao.Empresa, "12", "para a empresa", false)]
    [InlineData(ChavesConfiguracao.ValorLimiteSangria, "\"300.00\"", OrigemConfiguracao.Loja, "R$ 300,00", "loja", false)]
    [InlineData(ChavesConfiguracao.ValorLimiteSangria, "null", OrigemConfiguracao.Loja, "desligado", "loja", false)]
    [InlineData(ChavesConfiguracao.ValorLimiteSangria, null, OrigemConfiguracao.Padrao, "desligado", "padrão", false)]
    [InlineData(ChavesConfiguracao.DiasMaxOffline, "null", OrigemConfiguracao.Empresa, "sem limite", "empresa", false)]
    [InlineData(ChavesConfiguracao.HoraCorteDiaOperacional, "\"04:30\"", OrigemConfiguracao.Loja, "04:30", "loja", false)]
    [InlineData(ChavesConfiguracao.ResumoDiarioModo, "\"horario\"", OrigemConfiguracao.Loja, "Horário", "loja", false)]
    [InlineData(ChavesConfiguracao.DescontoCascosMaxSemSupervisor, "\"0.00\"", OrigemConfiguracao.Loja, "R$ 0,00 (sem teto)", "loja", false)]
    [InlineData(ChavesConfiguracao.FechamentoCego, "\"talvez\"", OrigemConfiguracao.Loja, "Sim (o valor do ERP não é válido: vale o padrão)", "loja", true)]
    [InlineData(ChavesConfiguracao.ResumoDiarioModo, "\"semanal\"", OrigemConfiguracao.Loja, "Intervalo de dias (o valor do ERP não é válido: vale o padrão)", "loja", true)]
    // O null onde ele não quer dizer nada: o caixa cai no padrão (ObterBoolAsync, ObterInteiroAsync, a tolerância ?? padrão).
    [InlineData(ChavesConfiguracao.FechamentoCego, "null", OrigemConfiguracao.Loja, "Sim (o valor do ERP não é válido: vale o padrão)", "loja", true)]
    [InlineData(ChavesConfiguracao.HorasAlertaSessao, "null", OrigemConfiguracao.Empresa, "24 (o valor do ERP não é válido: vale o padrão)", "empresa", true)]
    [InlineData(ChavesConfiguracao.ToleranciaDiferencaCaixa, "null", OrigemConfiguracao.Loja, "R$ 0,00 (o valor do ERP não é válido: vale o padrão)", "loja", true)]
    [InlineData(ChavesConfiguracao.HoraCorteDiaOperacional, "null", OrigemConfiguracao.Loja, "05:00 (o valor do ERP não é válido: vale o padrão)", "loja", true)]
    public void Valor_aparece_em_portugues_com_a_origem(string chave, string? json, OrigemConfiguracao origem, string valor, string trechoOrigem, bool invalido)
    {
        var linha = CatalogoRotulosConfiguracao.Exibir(CatalogoRotulosConfiguracao.De(chave)!, new ValorConfiguracao(chave, json, origem, null));
        Assert.Equal(valor, linha.Valor);
        Assert.Contains(trechoOrigem, linha.Origem, StringComparison.Ordinal);
        Assert.Equal(invalido, linha.ValorInvalido);
    }
}
