using System.Text.Json;
using GenesisPDV.Core.Vales;

namespace GenesisPDV.Core.Tests;

/// <summary>
/// Vetores dos códigos do vale e do cupom de troca e do código de conferência do vale
/// (<c>packages/shared/testes/sync/vale.codigo.vetores.json</c>; F3-B5, SYNC 13.4, D96): os mesmos que o Vitest de
/// <c>packages/shared</c> (<c>vales.spec.ts</c>) confere. Um código ou um resumo que saísse diferente do caixa e da nuvem
/// faria o vale emitido num lado não ser aceito no outro.
/// </summary>
public class CodigoValeVetoresTests
{
    private static readonly JsonElement Vetor = JsonDocument.Parse(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "sync", "vale.codigo.vetores.json"))).RootElement;

    private static IEnumerable<JsonElement> Casos(string grupo, string lista) =>
        Vetor.GetProperty(grupo).GetProperty(lista).EnumerateArray();

    private static TheoryData<string> Descricoes(string grupo, string lista)
    {
        var d = new TheoryData<string>();
        foreach (var c in Casos(grupo, lista))
        {
            d.Add(c.GetProperty("descricao").GetString()!);
        }

        return d;
    }

    private static JsonElement Caso(string grupo, string lista, string descricao) =>
        Casos(grupo, lista).Single(c => c.GetProperty("descricao").GetString() == descricao);

    public static TheoryData<string> ValeMontar() => Descricoes("vale", "montar");

    public static TheoryData<string> ValeRecusado() => Descricoes("vale", "montar_recusado");

    public static TheoryData<string> ValeConferir() => Descricoes("vale", "conferir");

    public static TheoryData<string> CupomMontar() => Descricoes("cupom_troca", "montar");

    public static TheoryData<string> CupomRecusado() => Descricoes("cupom_troca", "montar_recusado");

    public static TheoryData<string> CupomConferir() => Descricoes("cupom_troca", "conferir");

    public static TheoryData<string> ConferenciaResumir() => Descricoes("conferencia", "resumir");

    public static TheoryData<string> ConferenciaResumirRecusado() => Descricoes("conferencia", "resumir_recusado");

    public static TheoryData<string> ConferenciaConferir() => Descricoes("conferencia", "conferir");

    [Theory]
    [MemberData(nameof(ValeMontar))]
    public void Monta_o_codigo_do_vale(string descricao)
    {
        var c = Caso("vale", "montar", descricao);
        Assert.Equal(
            c.GetProperty("codigo").GetString(),
            CodigoVale.MontarVale(c.GetProperty("loja").GetInt32(), c.GetProperty("caixa").GetInt32(), c.GetProperty("sequencial").GetInt32()));
    }

    [Theory]
    [MemberData(nameof(ValeRecusado))]
    public void Recusa_montar_o_vale_fora_dos_limites(string descricao)
    {
        var c = Caso("vale", "montar_recusado", descricao);
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            CodigoVale.MontarVale(c.GetProperty("loja").GetInt32(), c.GetProperty("caixa").GetInt32(), c.GetProperty("sequencial").GetInt32()));
    }

    [Theory]
    [MemberData(nameof(ValeConferir))]
    public void Confere_o_codigo_do_vale(string descricao)
    {
        var c = Caso("vale", "conferir", descricao);
        AssertLido(c, CodigoVale.ConferirVale(c.GetProperty("lido").GetString()), "sequencial");
    }

    [Theory]
    [MemberData(nameof(CupomMontar))]
    public void Monta_o_cupom_de_troca(string descricao)
    {
        var c = Caso("cupom_troca", "montar", descricao);
        Assert.Equal(
            c.GetProperty("codigo").GetString(),
            CodigoVale.MontarCupomTroca(c.GetProperty("loja").GetInt32(), c.GetProperty("caixa").GetInt32(), c.GetProperty("numero").GetInt64()));
    }

    [Theory]
    [MemberData(nameof(CupomRecusado))]
    public void Recusa_montar_o_cupom_fora_dos_limites(string descricao)
    {
        var c = Caso("cupom_troca", "montar_recusado", descricao);
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            CodigoVale.MontarCupomTroca(c.GetProperty("loja").GetInt32(), c.GetProperty("caixa").GetInt32(), c.GetProperty("numero").GetInt64()));
    }

    [Theory]
    [MemberData(nameof(CupomConferir))]
    public void Confere_o_cupom_de_troca(string descricao)
    {
        var c = Caso("cupom_troca", "conferir", descricao);
        AssertLido(c, CodigoVale.ConferirCupomTroca(c.GetProperty("lido").GetString()), "numero");
    }

    [Fact]
    public void Constantes_iguais_as_do_shared()
    {
        var conf = Vetor.GetProperty("conferencia");
        Assert.Equal(ConferenciaVale.Digitos, conf.GetProperty("digitos").GetInt32());
        Assert.Equal(ConferenciaVale.IteracoesPadrao, conf.GetProperty("iteracoes_padrao").GetInt32());
        Assert.Equal(ConferenciaVale.IteracoesMinimo, conf.GetProperty("iteracoes_minimo").GetInt32());
        Assert.Equal(ConferenciaVale.IteracoesMaximo, conf.GetProperty("iteracoes_maximo").GetInt32());
    }

    [Theory]
    [MemberData(nameof(ConferenciaResumir))]
    public void Resume_o_codigo_de_conferencia_igual_a_nuvem(string descricao)
    {
        var c = Caso("conferencia", "resumir", descricao);
        var resumo = ConferenciaVale.Resumir(
            c.GetProperty("codigo_vale").GetString()!,
            c.GetProperty("conferencia").GetString()!,
            Convert.FromHexString(c.GetProperty("sal_hex").GetString()!),
            c.GetProperty("iteracoes").GetInt32());
        Assert.Equal(c.GetProperty("resumo").GetString(), resumo);
        Assert.True(ConferenciaVale.ResumoValido(resumo));
    }

    [Theory]
    [MemberData(nameof(ConferenciaResumirRecusado))]
    public void Recusa_resumir_entrada_invalida(string descricao)
    {
        var c = Caso("conferencia", "resumir_recusado", descricao);
        Assert.ThrowsAny<ArgumentException>(() => ConferenciaVale.Resumir(
            c.GetProperty("codigo_vale").GetString()!,
            c.GetProperty("conferencia").GetString()!,
            new byte[ConferenciaVale.SalBytes],
            ConferenciaVale.IteracoesMinimo));
    }

    [Theory]
    [MemberData(nameof(ConferenciaConferir))]
    public void Confere_o_codigo_de_conferencia(string descricao)
    {
        var c = Caso("conferencia", "conferir", descricao);
        Assert.Equal(
            c.GetProperty("valido").GetBoolean(),
            ConferenciaVale.Conferir(
                c.GetProperty("codigo_vale").GetString(),
                c.GetProperty("conferencia").GetString(),
                c.GetProperty("resumo").GetString()));
    }

    [Fact]
    public void Quebra_de_linha_no_fim_e_recusada_como_no_shared()
    {
        // O $ do .NET casa antes de um \n final (o do JS não): os padrões terminam em \z.
        var resumo = Caso("conferencia", "resumir", "iterações padrão").GetProperty("resumo").GetString()!;
        Assert.True(ConferenciaVale.ResumoValido(resumo));
        Assert.False(ConferenciaVale.ResumoValido(resumo + "\n"));
        Assert.True(CodigoVale.FormatoVale("VC010200000080"));
        Assert.False(CodigoVale.FormatoVale("VC010200000080\n"));
    }

    [Fact]
    public void Qualquer_digito_trocado_no_vale_e_recusado_pelo_dv()
    {
        var codigo = CodigoVale.MontarVale(45, 0, 7_654_321);
        for (var i = 2; i < codigo.Length; i++)
        {
            var trocado = codigo[..i] + (char)('0' + ((codigo[i] - '0' + 1) % 10)) + codigo[(i + 1)..];
            Assert.Equal(MotivoCodigoInvalido.DigitoVerificador, CodigoVale.ConferirVale(trocado).Motivo);
        }
    }

    [Fact]
    public void Codigo_sorteado_tem_4_digitos_e_o_resumo_novo_confere()
    {
        var vistos = new HashSet<string>();
        for (var i = 0; i < 2000; i++)
        {
            var c = ConferenciaVale.Gerar();
            Assert.Matches("^[0-9]{4}$", c);
            vistos.Add(c);
        }

        Assert.True(vistos.Count > 1700, $"só {vistos.Count} distintos em 2000 sorteios");
        var codigo = CodigoVale.MontarVale(1, 2, 8);
        var a = ConferenciaVale.Resumir(codigo, "0427");
        var b = ConferenciaVale.Resumir(codigo, "0427");
        Assert.NotEqual(a, b);
        Assert.Equal(87, a.Length);
        Assert.True(ConferenciaVale.Conferir(codigo, "0427", a));
        Assert.False(ConferenciaVale.Conferir(codigo, "0428", a));
    }

    private static void AssertLido(JsonElement c, CodigoLido lido, string campoNumero)
    {
        if (c.GetProperty("valido").GetBoolean())
        {
            Assert.Equal(
                new CodigoLido(
                    true,
                    null,
                    c.GetProperty("codigo").GetString(),
                    c.GetProperty("loja").GetInt32(),
                    c.GetProperty("caixa").GetInt32(),
                    c.GetProperty(campoNumero).GetInt64()),
                lido);
        }
        else
        {
            var motivo = c.GetProperty("motivo").GetString() switch
            {
                "FORMATO" => MotivoCodigoInvalido.Formato,
                "DIGITO_VERIFICADOR" => MotivoCodigoInvalido.DigitoVerificador,
                "LOJA" => MotivoCodigoInvalido.Loja,
                "NUMERO" => MotivoCodigoInvalido.Numero,
                var m => throw new InvalidOperationException($"motivo desconhecido no vetor: {m}"),
            };
            Assert.Equal(CodigoLido.Recusado(motivo), lido);
        }
    }
}
