using System.Runtime.CompilerServices;
using System.Text;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Fiscal;
using GenesisPDV.Hardware.Impressora;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Goldens de bytes (implantação I4, critério de pronto: "imprimir teste e um comprovante de venda geram os bytes ESC/POS
/// corretos para cada perfil/largura"): o teste de impressão e um comprovante de venda fixo, adaptados para cada modelo
/// nos papéis de 80 e 58 mm, comparados **byte a byte** com os arquivos de <c>goldens/impressora</c> (hex, 32 bytes por
/// linha). Pega o que os testes pelo texto renderizado não veem: negrito (<c>ESC E</c>), alinhamento (<c>ESC a</c>), a
/// página de código, o QR nativo × imagem e o corte. Mudou um layout de propósito? Regrave com
/// <c>GENESISPDV_REGRAVAR_GOLDENS=1 dotnet test …</c> e confira o diff dos <c>.hex</c> (e o <c>.txt</c> ao lado, o texto
/// como sai no papel).
/// </summary>
public class GoldensImpressoraTests
{
    private static readonly bool Regravar = Environment.GetEnvironmentVariable("GENESISPDV_REGRAVAR_GOLDENS") == "1";

    public static TheoryData<ModeloImpressora, LarguraPapel> Perfis()
    {
        var dados = new TheoryData<ModeloImpressora, LarguraPapel>();
        foreach (var modelo in Enum.GetValues<ModeloImpressora>())
        {
            dados.Add(modelo, LarguraPapel.Mm80);
            dados.Add(modelo, LarguraPapel.Mm58);
        }

        return dados;
    }

    private static ConfiguracaoImpressora Config(ModeloImpressora modelo, LarguraPapel papel) =>
        new() { Modelo = modelo, Conexao = TipoConexao.Rede, Endereco = "192.168.0.50", Papel = papel };

    /// <summary>Comprovante sempre igual: dois itens (um com desconto), dinheiro com troco, data fixa.</summary>
    public static byte[] Comprovante(int colunas)
    {
        var agora = new DateTimeOffset(2026, 11, 4, 13, 30, 0, TimeSpan.Zero);
        var venda = Venda.Iniciar(Guid.Empty, 7, new ContextoVenda(Guid.Empty, Guid.Empty, 1, Guid.Empty, 2, null), Guid.Empty, agora);
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.Parse("019a0000-0000-7000-8000-000000000001"), 1, null, "CERV BRAHMA DUPLO MALTE LT 350ML", "UN", 3.49m)), 12m, "789", agora);
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.Parse("019a0000-0000-7000-8000-000000000002"), 2, null, "ÁGUA CRYSTAL S/GÁS 500ML", "UN", 2.50m)), 2m, "789", agora);
        venda.AplicarDescontoItem(2, Desconto.EmReais(0.50m), 100m);
        venda.IniciarPagamento();
        venda.LancarPagamento(new FormaPagamentoInfo(Guid.Empty, "Dinheiro", "01", "dinheiro", true), 50m, agora);
        venda.Finalizar(agora, Guid.Empty);
        var cabecalho = new CabecalhoDocumento("Ice Beer Hermes - Loja 1", "Ice Beer Comércio de Bebidas Ltda", "00.000.000/0001-00", "123456789",
            "Rua Exemplo, 123 - Centro - Curitiba/PR", "(41) 3000-0000", "Maria", "Obrigado pela preferência!", VersaoApp: "0.9.0");
        return LayoutComprovanteVenda.Gerar(venda, cabecalho, colunas);
    }

    [Theory]
    [MemberData(nameof(Perfis))]
    public void Teste_de_impressao_adaptado_bate_com_o_golden(ModeloImpressora modelo, LarguraPapel papel)
    {
        var c = Config(modelo, papel);
        Conferir($"teste-{Nome(modelo)}-{Papel(papel)}", AdaptadorEscPos.Adaptar(LayoutTesteImpressao.Gerar(c, "Ice Beer Hermes - Loja 1", "04/11/2026 10:30"), c), c.Colunas);
    }

    [Theory]
    [MemberData(nameof(Perfis))]
    public void Comprovante_de_venda_adaptado_bate_com_o_golden(ModeloImpressora modelo, LarguraPapel papel)
    {
        var c = Config(modelo, papel);
        var bytes = AdaptadorEscPos.Adaptar(Comprovante(c.Colunas), c);
        // Além do golden, o que o renderizador não mostra: o negrito do aviso e o centro do cabeçalho chegam ao modelo.
        Assert.True(bytes.AsSpan().IndexOf(new byte[] { EscPos.Esc, (byte)'E', 1 }) >= 0);
        Assert.True(bytes.AsSpan().IndexOf(new byte[] { EscPos.Esc, (byte)'a', 1 }) >= 0);
        Assert.Equal(2, RenderizadorEscPos.Renderizar(bytes, c.Colunas).Count(l => l.Trim() == LayoutComprovanteVenda.AvisoNaoFiscal));
        Conferir($"comprovante-{Nome(modelo)}-{Papel(papel)}", bytes, c.Colunas);
    }

    private static string Nome(ModeloImpressora modelo) => modelo switch
    {
        ModeloImpressora.EpsonTmT20 => "epson-tm-t20",
        ModeloImpressora.EpsonTmT88 => "epson-tm-t88",
        ModeloImpressora.BematechMp4200Th => "bematech-mp4200th",
        _ => "generica",
    };

    private static string Papel(LarguraPapel papel) => papel == LarguraPapel.Mm58 ? "58mm" : "80mm";

    private static string Pasta([CallerFilePath] string arquivo = "") => Path.Combine(Path.GetDirectoryName(arquivo)!, "goldens", "impressora");

    private static void Conferir(string nome, byte[] bytes, int colunas)
    {
        var hex = Path.Combine(Pasta(), nome + ".hex");
        var texto = Path.Combine(Pasta(), nome + ".txt");
        if (Regravar)
        {
            Directory.CreateDirectory(Pasta());
            File.WriteAllText(hex, ParaHex(bytes));
            File.WriteAllText(texto, RenderizadorEscPos.RenderizarTexto(bytes, colunas), new UTF8Encoding(false));
        }

        Assert.True(File.Exists(hex), $"Golden {nome}.hex ausente: rode com GENESISPDV_REGRAVAR_GOLDENS=1 e versione o arquivo.");
        var esperado = Convert.FromHexString(string.Concat(File.ReadAllLines(hex).Select(l => l.Replace(" ", string.Empty, StringComparison.Ordinal))));
        if (!esperado.AsSpan().SequenceEqual(bytes))
        {
            var primeiro = Enumerable.Range(0, Math.Min(esperado.Length, bytes.Length)).FirstOrDefault(i => esperado[i] != bytes[i], Math.Min(esperado.Length, bytes.Length));
            Assert.Fail($"{nome}: os bytes mudaram a partir da posição {primeiro} (esperado {esperado.Length} bytes, saíram {bytes.Length}). " +
                        "Se a mudança é de propósito, regrave com GENESISPDV_REGRAVAR_GOLDENS=1 e confira o diff.");
        }
    }

    private static string ParaHex(byte[] bytes) =>
        string.Concat(bytes.Chunk(32).Select(linha => string.Join(' ', linha.Chunk(4).Select(Convert.ToHexString)) + "\n"));
}
