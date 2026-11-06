using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Fiscal;
using GenesisPDV.Hardware.Balanca;
using GenesisPDV.Hardware.Gaveta;
using GenesisPDV.Hardware.Impressora;
using GenesisPDV.Hardware.Leitor;

namespace GenesisPDV.App.Tests;

public class HardwareTests
{
    [Fact]
    public void EscPos_renderiza_centro_colunas_corte_e_acentos()
    {
        var bytes = new ConstrutorEscPos(48)
            .Centro("ÁGUA E PÃO", negrito: true)
            .Colunado("Subtotal", "75,68")
            .Separador()
            .PulsoGaveta()
            .Avancar(1)
            .Cortar()
            .ParaBytes();
        var linhas = RenderizadorEscPos.Renderizar(bytes, 48);
        Assert.Equal(new string(' ', 19) + "ÁGUA E PÃO", linhas[0]);
        Assert.Equal(48, linhas[1].Length);
        Assert.EndsWith("75,68", linhas[1]);
        Assert.Equal(new string('-', 48), linhas[2]);
        Assert.Contains(RenderizadorEscPos.MarcaGaveta, linhas);
        Assert.Equal(RenderizadorEscPos.MarcaCorte, linhas[^1]);
    }

    [Fact]
    public void Texto_longo_quebra_na_largura_da_bobina()
    {
        var linhas = RenderizadorEscPos.Renderizar(new ConstrutorEscPos(32).Colunado(new string('X', 40), "1,00").ParaBytes(), 32);
        Assert.Equal(new string('X', 32), linhas[0]);
        Assert.EndsWith("1,00", linhas[1]);
    }

    [Fact]
    public async Task Impressora_simulada_grava_arquivo_e_simula_falta_de_papel()
    {
        var pasta = Path.Combine(Path.GetTempPath(), "genesispdv-impressora", Guid.NewGuid().ToString("N"));
        var impressora = new ImpressoraArquivoSimulada(pasta);
        string? impresso = null;
        impressora.Impresso += (_, t) => impresso = t;
        await impressora.ImprimirAsync(new ConstrutorEscPos().Linha("TESTE").ParaBytes(), TestContext.Current.CancellationToken);
        Assert.Contains("TESTE", await File.ReadAllTextAsync(impressora.UltimoArquivo!, TestContext.Current.CancellationToken));
        Assert.Single(Directory.GetFiles(pasta, "*.bin"));
        Assert.Contains("TESTE", impresso);

        impressora.SituacaoSimulada = SituacaoImpressora.SemPapel;
        await Assert.ThrowsAsync<FalhaImpressoraException>(() => impressora.ImprimirAsync([0x41], TestContext.Current.CancellationToken));
        try
        {
            Directory.Delete(pasta, true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Limpeza de pasta temporária: no Windows o arquivo pode seguir aberto por alguns ms.
        }
    }

    [Fact]
    public void Leitor_como_teclado_distingue_rajada_do_leitor_e_digitacao()
    {
        var leitor = new LeitorComoTeclado();
        var t = DateTimeOffset.UtcNow;
        foreach (var (c, i) in "7891149103102".Select((c, i) => (c, i)))
        {
            leitor.Caractere(c, t.AddMilliseconds(i * 8));
        }

        Assert.Equal(OrigemEntrada.Leitor, leitor.Sufixo(t.AddMilliseconds(110))!.Origem);

        foreach (var (c, i) in "0044".Select((c, i) => (c, i)))
        {
            leitor.Caractere(c, t.AddMilliseconds(1000 + (i * 250)));
        }

        var digitado = leitor.Sufixo(t.AddMilliseconds(2200));
        Assert.Equal("0044", digitado!.Codigo);
        Assert.Equal(OrigemEntrada.Teclado, digitado.Origem);
        Assert.Null(leitor.Sufixo(t.AddMilliseconds(3000)));
    }

    [Fact]
    public async Task Balanca_e_gaveta_simuladas()
    {
        var balanca = new BalancaSimulada { PesoKg = 0.7954m };
        var leitura = await balanca.LerPesoAsync(TestContext.Current.CancellationToken);
        Assert.Equal(0.795m, leitura.PesoKg);
        Assert.True(leitura.Estavel);
        balanca.SemComunicacao = true;
        await Assert.ThrowsAsync<FalhaBalancaException>(() => balanca.LerPesoAsync(TestContext.Current.CancellationToken));

        var gaveta = new GavetaSimulada();
        await gaveta.AbrirAsync(TestContext.Current.CancellationToken);
        Assert.Equal(1, gaveta.Aberturas);
        Assert.True(await gaveta.EstaAbertaAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Emissor_nao_fiscal_gera_comprovante_com_aviso_no_topo_e_no_rodape()
    {
        var agora = new DateTimeOffset(2026, 10, 29, 17, 36, 0, TimeSpan.Zero);
        var venda = Venda.Iniciar(Guid.CreateVersion7(), 123, new ContextoVenda(Guid.NewGuid(), Guid.NewGuid(), 1, Guid.NewGuid(), 2, null), Guid.NewGuid(), agora);
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.NewGuid(), 1, null, "CERV BRAHMA LT 350ML", "UN", 3.49m)), 12m, "789", agora);
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.NewGuid(), 2, null, "ÁGUA CRYSTAL 500ML", "UN", 2.50m)), 2m, "789", agora);
        venda.AplicarDescontoItem(2, Desconto.EmReais(0.50m), 100m);
        venda.IniciarPagamento();
        venda.LancarPagamento(new FormaPagamentoInfo(Guid.NewGuid(), "Dinheiro", "01", "dinheiro", true), 50m, agora);
        venda.Finalizar(agora, Guid.NewGuid());

        var doc = await new EmissorNaoFiscal().EmitirAsync(venda, new CabecalhoDocumento("Ice Beer Hermes - Loja 1", "Ice Beer Ltda", null, null, null, null, "Maria"), TestContext.Current.CancellationToken);
        var texto = RenderizadorEscPos.RenderizarTexto(doc.Impressao);
        Assert.Equal(StatusFiscal.NaoAplicavel, doc.StatusFiscal);
        Assert.Equal(2, texto.Split(LayoutComprovanteVenda.AvisoNaoFiscal).Length - 1);
        Assert.Contains("Venda: L01-C02-000123", texto);
        Assert.Contains("29/10/2026 14:36", texto);
        Assert.Contains("12,000 UN x 3,49", texto);
        Assert.Contains("-0,50", texto);
        Assert.Contains("TOTAL R$     46,38", texto);
        Assert.Contains("Troco", texto);
        Assert.Contains("3,62", texto);
        Assert.All(texto.Split('\n'), l => Assert.True(l.Length <= 48, l));
    }
}
