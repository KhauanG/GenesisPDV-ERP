using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Vendas;
using static GenesisPDV.Core.Tests.CatalogoTeste;
using static GenesisPDV.Core.Tests.Fixtures;

namespace GenesisPDV.Core.Tests;

/// <summary>Vasilhames / cascos retornáveis (PDV 10.12, parte PDV-1).</summary>
public class VasilhameTests
{
    [Fact]
    public void Casco_e_cobrado_quando_o_cliente_nao_traz_o_vazio_e_cancelar_a_cerveja_cancela_o_casco()
    {
        var venda = VendaPreco();
        var cerveja = venda.AdicionarItem(Lido(Original600()), 1m, "0600", Agora);
        Assert.True(venda.ExigeCascos(cerveja));
        Assert.Equal(new SituacaoCascos(1m, 0m, 1m), venda.Cascos(cerveja.Sequencia));

        var casco = venda.RegistrarCascosTrazidos(cerveja.Sequencia, 0m, Garrafa, Agora)!;
        Assert.Equal(Garrafa.Id, casco.ProdutoId);
        Assert.Equal(1m, casco.Quantidade);
        Assert.Equal(2.50m, casco.ValorBruto);
        Assert.Equal(cerveja.Id, casco.VasilhameItemOrigemId);
        Assert.Equal(OrigemPreco.Varejo, casco.OrigemPreco);
        Assert.False(venda.ExigeCascos(casco));
        Assert.Equal(12.40m, venda.Total);
        Assert.Equal([new ResumoVasilhame(Garrafa.Id, 0m, 1m, 0m, null)], venda.ResumoVasilhames());

        venda.CancelarItem(cerveja.Sequencia, Operador, Agora, 0m);
        Assert.True(casco.Cancelado);
        Assert.Equal(0m, venda.Total);
    }

    [Theory]
    [InlineData(6, 0, 6.0, 0.0)]
    [InlineData(4, 2, 4.0, 2.0)]
    [InlineData(0, 6, 0.0, 6.0)]
    public void Seis_cervejas_com_cascos_trazidos(int trazidos, int cobradosEsperados, decimal devolvidos, decimal vendidos)
    {
        var venda = VendaPreco();
        var cerveja = venda.AdicionarItem(Lido(Original600()), 6m, "0600", Agora);
        var casco = venda.RegistrarCascosTrazidos(cerveja.Sequencia, trazidos, Garrafa, Agora);
        Assert.Equal(cobradosEsperados, (int)(casco?.Quantidade ?? 0m));
        Assert.Equal(cobradosEsperados == 0 ? 1 : 2, venda.ItensAtivos.Count());
        var resumo = Assert.Single(venda.ResumoVasilhames());
        Assert.Equal(devolvidos, resumo.Devolvidos);
        Assert.Equal(vendidos, resumo.Vendidos);
        Assert.Equal(59.40m + (cobradosEsperados * 2.50m), venda.Total);
    }

    [Fact]
    public void Engradado_de_24_lido_pelo_dun_deve_24_cascos()
    {
        var venda = VendaPreco();
        var engradado = venda.AdicionarItem(Fardo(Original600(), Guid.NewGuid(), 24m, null), 1m, "17891991015308", Agora);
        Assert.Equal(24m, venda.Cascos(engradado.Sequencia).Devidos);
        var casco = venda.RegistrarCascosTrazidos(engradado.Sequencia, 20m, Garrafa, Agora)!;
        Assert.Equal(4m, casco.Quantidade);
    }

    [Fact]
    public void Perguntar_de_novo_ajusta_ou_cancela_o_casco_e_diminuir_o_cheio_limita_o_casco()
    {
        var venda = VendaPreco();
        var cerveja = venda.AdicionarItem(Lido(Original600()), 6m, "0600", Agora);
        var casco = venda.RegistrarCascosTrazidos(cerveja.Sequencia, 2m, Garrafa, Agora)!;
        Assert.Equal(4m, casco.Quantidade);

        Assert.Same(casco, venda.RegistrarCascosTrazidos(cerveja.Sequencia, 5m, Garrafa, Agora));
        Assert.Equal(1m, casco.Quantidade);
        Assert.Equal(2.50m, casco.ValorBruto);

        Assert.Null(venda.RegistrarCascosTrazidos(cerveja.Sequencia, 6m, Garrafa, Agora));
        Assert.True(casco.Cancelado);

        var novo = venda.RegistrarCascosTrazidos(cerveja.Sequencia, 0m, Garrafa, Agora)!;
        Assert.Equal(6m, novo.Quantidade);
        venda.AlterarQuantidade(cerveja.Sequencia, 2m, 0m);
        Assert.Equal(2m, novo.Quantidade);
        Assert.Equal(new SituacaoCascos(2m, 2m, 0m), venda.Cascos(cerveja.Sequencia));
    }

    [Fact]
    public void Cascos_fora_da_faixa_sao_recusados_e_o_casco_nao_se_altera_direto()
    {
        var venda = VendaPreco();
        var cerveja = venda.AdicionarItem(Lido(Original600()), 2m, "0600", Agora);
        Assert.Contains("devolução avulsa", Assert.Throws<RegraNegocioException>(() =>
            venda.RegistrarCascosTrazidos(cerveja.Sequencia, 3m, Garrafa, Agora)).Message);
        Assert.Throws<RegraNegocioException>(() => venda.RegistrarCascosTrazidos(cerveja.Sequencia, -1m, Garrafa, Agora));
        Assert.Throws<RegraNegocioException>(() => venda.RegistrarCascosTrazidos(cerveja.Sequencia, 0.5m, Garrafa, Agora));

        var casco = venda.RegistrarCascosTrazidos(cerveja.Sequencia, 0m, Garrafa, Agora)!;
        Assert.Contains("casco", Assert.Throws<RegraNegocioException>(() => venda.AlterarQuantidade(casco.Sequencia, 1m, 0m)).Message);

        // "+" vale para o produto cheio, não para o casco que entrou depois dele.
        Assert.Same(cerveja, venda.IncrementarUltimoItem(1, 0m));

        var outro = venda.AdicionarItem(Lido(Brahma()), 1m, "1", Agora);
        Assert.False(venda.ExigeCascos(outro));
        Assert.Throws<RegraNegocioException>(() => venda.RegistrarCascosTrazidos(outro.Sequencia, 0m, Garrafa, Agora));
    }

    [Fact]
    public void Casco_nao_conta_para_o_atacado_nem_e_recalculado()
    {
        var garrafaComAtacado = Garrafa with { Precos = new TabelaPreco(PrecoAtacado: 1m, QtdMinimaAtacado: 1m) };
        var cheio = Original600() with { VasilhameProdutoId = garrafaComAtacado.Id };
        var venda = VendaPreco();
        var cerveja = venda.AdicionarItem(Lido(cheio), 12m, "0600", Agora);
        var casco = venda.RegistrarCascosTrazidos(cerveja.Sequencia, 0m, garrafaComAtacado, Agora)!;
        Assert.Equal(2.50m, casco.PrecoUnitario);
        venda.AdicionarItem(Lido(garrafaComAtacado), 1m, "0601", Agora);
        Assert.Equal(2.50m, casco.PrecoUnitario);
    }

    [Fact]
    public void Cancelamento_parcial_do_cheio_cancela_o_casco_e_o_restante_pede_cascos_de_novo()
    {
        var venda = VendaPreco();
        var cerveja = venda.AdicionarItem(Lido(Original600()), 6m, "0600", Agora);
        var casco = venda.RegistrarCascosTrazidos(cerveja.Sequencia, 0m, Garrafa, Agora)!;
        var restante = venda.CancelarItem(cerveja.Sequencia, Operador, Agora, 0m, 2m)!;
        Assert.True(casco.Cancelado);
        Assert.True(venda.ExigeCascos(restante));
        Assert.Equal(new SituacaoCascos(4m, 0m, 4m), venda.Cascos(restante.Sequencia));
    }
}
