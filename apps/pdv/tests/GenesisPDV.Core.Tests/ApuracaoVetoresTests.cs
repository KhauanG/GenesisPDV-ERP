using System.Globalization;
using System.Text.Json;
using GenesisPDV.Core.Caixa;

namespace GenesisPDV.Core.Tests;

/// <summary>
/// Vetor compartilhado da apuração do caixa (<c>packages/shared/testes/sync/caixa.apuracao.vetores.json</c>; PDV 20.4 e
/// 21.2): o mesmo turno que a API aplica pelo push e confere no cálculo do dinheiro refeito na nuvem (ERP 14.9,
/// <c>GET /sessoes-caixa/:id</c>, teste <c>consultas-vendas-caixa.test.ts</c>). Os pagamentos entram como o
/// <c>RepositorioCaixa</c> os entrega (aprovados e estornados das vendas finalizadas na sessão) e os movimentos com a
/// forma do estorno; a sangria do próprio fechamento fica fora do calculado (ainda não existe quando o PDV apura) e só
/// entra no <c>dinheiro_gaveta</c> depois do fechamento.
/// </summary>
public class ApuracaoVetoresTests
{
    private static readonly JsonElement Vetor = JsonDocument.Parse(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "sync", "caixa.apuracao.vetores.json"))).RootElement;

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
    public void Calculado_por_forma_e_dinheiro_na_gaveta_iguais_aos_da_nuvem(string nome)
    {
        var caso = Vetor.GetProperty("casos").EnumerateArray().Single(c => c.GetProperty("nome").GetString() == nome);
        var formas = Vetor.GetProperty("formas").EnumerateObject().ToDictionary(
            f => f.Name,
            f => new FormaCaixa(Guid.CreateVersion7(), f.Value.GetProperty("descricao").GetString()!, f.Value.GetProperty("tipo_forma").GetString()!));
        var pagamentos = caso.GetProperty("vendas").EnumerateArray()
            .SelectMany(v => v.GetProperty("pagamentos").EnumerateArray())
            .Select(p => new PagamentoApurado(formas[p.GetProperty("forma").GetString()!], Valor(p, "valor"), Valor(p, "troco")))
            .ToList();
        var movimentos = caso.GetProperty("movimentos").EnumerateArray()
            .Select(m => new MovimentoApurado(
                m.GetProperty("tipo").GetString()!,
                Valor(m, "valor"),
                m.TryGetProperty("cancelado", out var cancelado) && cancelado.GetBoolean(),
                m.TryGetProperty("forma", out var forma) ? formas[forma.GetString()!] : null))
            .ToList();
        var fundo = Valor(caso, "fundo_troco");
        var esperado = caso.GetProperty("esperado");

        var apuracao = ApuracaoCaixa.Calcular(fundo, pagamentos, movimentos, formas["dinheiro"], formas.Values);

        Assert.Equal(Valor(esperado, "dinheiro"), apuracao.DinheiroGaveta);
        var porForma = esperado.GetProperty("formas").EnumerateObject()
            .Select(f => (f.Name, Valor(f.Value, "calculado"), f.Value.GetProperty("quantidade_pagamentos").GetInt32()))
            .OrderBy(f => f.Name, StringComparer.Ordinal);
        Assert.Equal(
            porForma,
            apuracao.Formas.Select(f => (formas.Single(x => x.Value == f.Forma).Key, f.Calculado, f.QuantidadePagamentos))
                .OrderBy(f => f.Key, StringComparer.Ordinal));
        Assert.Equal(apuracao.DinheiroGaveta, apuracao.Formas[0].Calculado);

        // Depois do fechamento a sangria dele sai da gaveta (o heartbeat seguinte informa o que sobrou).
        var depois = movimentos.Append(new MovimentoApurado(TiposMovimento.SangriaFechamento, Valor(caso, "sangria_fechamento")));
        Assert.Equal(Valor(esperado, "gaveta_apos_sangria_fechamento"), ApuracaoCaixa.DinheiroGaveta(fundo, pagamentos, depois));
    }

    private static decimal Valor(JsonElement no, string campo) =>
        no.TryGetProperty(campo, out var v) ? decimal.Parse(v.GetString()!, CultureInfo.InvariantCulture) : 0m;
}
