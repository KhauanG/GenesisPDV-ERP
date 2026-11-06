using GenesisPDV.Data.Convencoes;

namespace GenesisPDV.Data.Tests;

public class ConversoresTests
{
    [Theory]
    [InlineData("45.18", 2, 4518L)]
    [InlineData("3.4900", 4, 34900L)]
    [InlineData("0.795", 3, 795L)]
    [InlineData("-12.5", 2, -1250L)]
    [InlineData("0", 2, 0L)]
    [InlineData("9999999999999.99", 2, 999999999999999L)]
    public void EscalaDecimal_ida_e_volta(string texto, int casas, long inteiro)
    {
        var valor = decimal.Parse(texto, System.Globalization.CultureInfo.InvariantCulture);
        Assert.Equal(inteiro, EscalaDecimal.ParaInteiro(valor, casas));
        var volta = EscalaDecimal.DeInteiro(inteiro, casas);
        Assert.Equal(valor, volta);
        Assert.Equal(casas, volta.Scale);
    }

    [Fact]
    public void EscalaDecimal_nunca_arredonda_escondido()
    {
        var erro = Assert.Throws<InvalidOperationException>(() => EscalaDecimal.ParaInteiro(1.005m, 2));
        Assert.Contains("mais de 2 casas", erro.Message);
        Assert.Equal(100L, EscalaDecimal.ParaInteiro(1.000m, 2));
    }

    [Fact]
    public void Data_hora_utc_em_texto_de_largura_fixa()
    {
        var instante = new DateTimeOffset(2026, 10, 29, 14, 36, 5, 123, TimeSpan.FromHours(-3));
        var texto = DataHoraUtcTexto.Formatar(instante);
        Assert.Equal("2026-10-29T17:36:05.123Z", texto);
        Assert.Equal(24, texto.Length);
        Assert.Equal(instante, DataHoraUtcTexto.Ler(texto));
        Assert.Equal(TimeSpan.Zero, DataHoraUtcTexto.Ler(texto).Offset);
    }

    [Fact]
    public void Ordem_do_texto_igual_a_ordem_cronologica()
    {
        var a = DataHoraUtcTexto.Formatar(new DateTimeOffset(2026, 1, 2, 9, 0, 0, TimeSpan.Zero));
        var b = DataHoraUtcTexto.Formatar(new DateTimeOffset(2026, 1, 10, 8, 0, 0, TimeSpan.Zero));
        Assert.True(string.CompareOrdinal(a, b) < 0);
    }
}
