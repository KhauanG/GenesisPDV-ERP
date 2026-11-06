using GenesisPDV.Core.Vendas;

namespace GenesisPDV.Core.Tests;

public class EntradaCodigoTests
{
    [Fact]
    public void Codigo_simples_usa_quantidade_um_ou_multiplicador_pendente()
    {
        var e = EntradaCodigo.Interpretar("7891149103102");
        Assert.Equal(TipoEntrada.Produto, e.Tipo);
        Assert.Equal("7891149103102", e.Codigo);
        Assert.Equal(1m, e.Quantidade);
        Assert.Equal(3m, EntradaCodigo.Interpretar("7891149103102", 3m).Quantidade);
    }

    [Theory]
    [InlineData("12*7891149103102", "12")]
    [InlineData("12x7891149103102", "12")]
    [InlineData("12X7891149103102", "12")]
    [InlineData("0,750*0044", "0.750")]
    [InlineData("1.5*0044", "1.5")]
    [InlineData(" 3 * 0044 ", "3")]
    public void Multiplicador_com_codigo(string texto, string qtd)
    {
        var e = EntradaCodigo.Interpretar(texto, 99m);
        Assert.Equal(TipoEntrada.Produto, e.Tipo);
        Assert.Equal(decimal.Parse(qtd, System.Globalization.CultureInfo.InvariantCulture), e.Quantidade);
    }

    [Fact]
    public void Multiplicador_sozinho_fixa_para_a_proxima_leitura()
    {
        var e = EntradaCodigo.Interpretar("3*");
        Assert.Equal(TipoEntrada.DefinirMultiplicador, e.Tipo);
        Assert.Equal(3m, e.Quantidade);
    }

    [Theory]
    [InlineData("0*123")]
    [InlineData("10000*123")]
    [InlineData("1,0001*123")]
    [InlineData("1,2,3*123")]
    [InlineData("3*abc")]
    public void Entradas_invalidas(string texto)
    {
        Assert.Equal(TipoEntrada.Invalida, EntradaCodigo.Interpretar(texto).Tipo);
    }

    [Theory]
    [InlineData("brahma lata")]
    [InlineData("coca 2l")]
    [InlineData("x")]
    public void Texto_abre_pesquisa(string texto)
    {
        var e = EntradaCodigo.Interpretar(texto);
        Assert.Equal(TipoEntrada.Pesquisa, e.Tipo);
        Assert.Equal(texto.Trim(), e.Codigo);
    }

    [Fact]
    public void Mais_menos_e_vazio()
    {
        Assert.Equal(TipoEntrada.Incrementar, EntradaCodigo.Interpretar("+").Tipo);
        Assert.Equal(TipoEntrada.Decrementar, EntradaCodigo.Interpretar("-").Tipo);
        Assert.Equal(TipoEntrada.Vazia, EntradaCodigo.Interpretar("   ").Tipo);
    }

    [Fact]
    public void Codigo_longo_demais_vai_para_pesquisa()
    {
        Assert.Equal(TipoEntrada.Pesquisa, EntradaCodigo.Interpretar(new string('1', 31)).Tipo);
    }
}
