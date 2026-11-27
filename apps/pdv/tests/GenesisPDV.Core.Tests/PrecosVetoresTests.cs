using System.Globalization;
using System.Text.Json;
using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Vendas;
using static GenesisPDV.Core.Tests.CatalogoTeste;

namespace GenesisPDV.Core.Tests;

/// <summary>
/// Vetores da regra de preço (<c>packages/shared/testes/precos/regra-preco.vetores.json</c>; PDV 11.2, 11.3, 11.3.1;
/// F3-B17, e o parcelado do passo 9, F3-B18): os mesmos que o <c>precos.spec.ts</c> passa pelo <c>resolverPreco</c> do shared (o espelho que o ERP usa no
/// "Simular" do mix). Um caso que dá preço ou origem diferentes aqui e lá é o caixa e o ERP calculando diferente.
/// </summary>
public class PrecosVetoresTests
{
    private static readonly JsonElement Vetor = JsonDocument.Parse(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "precos", "regra-preco.vetores.json"))).RootElement;

    public static TheoryData<string> Casos()
    {
        var casos = new TheoryData<string>();
        foreach (var caso in Vetor.GetProperty("casos").EnumerateArray())
        {
            casos.Add(caso.GetProperty("nome").GetString()!);
        }

        return casos;
    }

    [Theory]
    [MemberData(nameof(Casos))]
    public void MotorPreco_igual_ao_resolverPreco_do_shared(string nome)
    {
        var caso = Vetor.GetProperty("casos").EnumerateArray().Single(c => c.GetProperty("nome").GetString() == nome);
        var p = caso.GetProperty("produto");
        GrupoPrecoQuantidade? grupo = p.TryGetProperty("grupo", out var g)
            ? new GrupoPrecoQuantidade(MixId, "MIX", g.GetProperty("modo").GetString() == "grupo" ? ModoPrecoGrupo.Grupo : ModoPrecoGrupo.Produto,
                Faixas: Faixas(g))
            : null;
        var tabela = new TabelaPreco(
            PrecoVendaLoja: Opcional(p, "preco_loja"),
            PrecoPromocional: Opcional(p, "preco_promocional"),
            PrecoAtacado: Opcional(p, "preco_atacado"),
            QtdMinimaAtacado: Opcional(p, "qtd_minima_atacado"),
            Faixas: Faixas(p),
            Grupo: grupo,
            PrecoParcelado: Opcional(p, "preco_parcelado"));
        var produto = Produto("VETOR", Valor(p.GetProperty("preco_venda")), tabela);
        var parametros = new ParametrosPreco(
            Loja1, caso.GetProperty("usa_preco_volume").GetBoolean(), caso.GetProperty("tipo_preco").GetString()!,
            Parcelado: caso.TryGetProperty("parcelado", out var parcelado) && parcelado.GetBoolean());

        var r = MotorPreco.Resolver(
            produto,
            caso.GetProperty("promocao_vigente").GetBoolean(),
            Valor(caso.GetProperty("qtd_total")),
            Opcional(caso, "qtd_grupo"),
            null,
            parametros);

        var esperado = caso.GetProperty("esperado");
        Assert.Equal((Valor(esperado.GetProperty("preco")), esperado.GetProperty("origem").GetString()), (r.Preco, r.Origem));
        Assert.Contains(r.Origem, OrigemPreco.Todas);
    }

    [Fact]
    public void Os_vetores_cobrem_o_F8_e_o_parcelado()
    {
        var casos = Vetor.GetProperty("casos").EnumerateArray().ToList();
        var tipos = casos.Select(c => c.GetProperty("tipo_preco").GetString()).ToList();
        Assert.True(tipos.Count(t => t == TipoPrecoVenda.Atacado) > 5);
        // O tipo do vetor é sempre o do F8: o parcelado vem à parte (o tipo de antes dele segue nos produtos sem parcelado).
        Assert.All(tipos, t => Assert.Contains(t, TipoPrecoVenda.DoF8));
        Assert.True(casos.Count(c => c.TryGetProperty("parcelado", out var p) && p.GetBoolean()) > 3);
    }

    private static decimal Valor(JsonElement e) => decimal.Parse(e.GetString()!, CultureInfo.InvariantCulture);

    private static decimal? Opcional(JsonElement objeto, string nome) =>
        objeto.TryGetProperty(nome, out var e) && e.ValueKind == JsonValueKind.String ? Valor(e) : null;

    private static List<FaixaPreco>? Faixas(JsonElement objeto) =>
        objeto.TryGetProperty("faixas", out var lista)
            ? lista.EnumerateArray().Select(f => new FaixaPreco(
                Valor(f.GetProperty("quantidade_inicial")),
                Opcional(f, "quantidade_final"),
                Valor(f.GetProperty("preco")),
                f.GetProperty("loja").GetString() switch
                {
                    "loja" => Loja1,
                    "outra" => Loja2,
                    _ => null,
                })).ToList()
            : null;
}
