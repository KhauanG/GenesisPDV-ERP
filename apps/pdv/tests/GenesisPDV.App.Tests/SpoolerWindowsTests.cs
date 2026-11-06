using GenesisPDV.Hardware.Impressora;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Spooler do Windows com envio RAW (implantação I4, padrão da loja): só no CI Windows, onde o
/// <c>instalador/windows/preparar-impressora-teste.ps1</c> cria a impressora "Generic / Text Only" numa porta de arquivo
/// e define <c>GENESISPDV_IMPRESSORA_TESTE</c> (nome) e <c>GENESISPDV_IMPRESSORA_ARQUIVO</c> (o arquivo da porta). O
/// documento adaptado tem de chegar ao arquivo byte a byte — o driver não pode ter tocado em nada. No CI Windows o teste
/// **não pula**: sem as variáveis (o preparo falhou ou não rodou) ele falha, a menos que <c>GENESISPDV_SPOOLER_OPCIONAL=1</c>
/// (variável do repositório <c>PDV_SPOOLER_OPCIONAL</c>). Fora do CI, sem as variáveis, fica pulado.
/// </summary>
public class SpoolerWindowsTests
{
    private static readonly string? Impressora = Environment.GetEnvironmentVariable("GENESISPDV_IMPRESSORA_TESTE");
    private static readonly string? Arquivo = Environment.GetEnvironmentVariable("GENESISPDV_IMPRESSORA_ARQUIVO");

    private static bool Preparado => !string.IsNullOrWhiteSpace(Impressora) && !string.IsNullOrWhiteSpace(Arquivo);

    /// <summary>No GitHub Actions a prova do spooler é obrigatória (salvo a tolerância explícita).</summary>
    private static bool Obrigatorio =>
        Environment.GetEnvironmentVariable("GITHUB_ACTIONS") == "true" && Environment.GetEnvironmentVariable("GENESISPDV_SPOOLER_OPCIONAL") != "1";

    public static bool Habilitado => OperatingSystem.IsWindows() && (Preparado || Obrigatorio);

    [Fact(SkipUnless = nameof(Habilitado), Skip = "Só no Windows com GENESISPDV_IMPRESSORA_TESTE e GENESISPDV_IMPRESSORA_ARQUIVO (CI Windows).")]
    public async Task Envio_raw_pelo_spooler_chega_ao_arquivo_da_porta_sem_mudanca()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        Assert.True(Preparado, "CI Windows sem a impressora de teste do spooler: o passo preparar-impressora-teste.ps1 falhou ou não rodou.");

        var ct = TestContext.Current.CancellationToken;
        Assert.Contains(Impressora!, TransporteSpoolerWindows.Listar());
        var configuracao = new ConfiguracaoImpressora { Modelo = ModeloImpressora.EpsonTmT20, Conexao = TipoConexao.Spooler, NomeSpooler = Impressora };
        var documento = LayoutTesteImpressao.Gerar(configuracao, "Ice Beer Hermes - Loja 1", "04/11/2026 10:00");
        var esperado = AdaptadorEscPos.Adaptar(documento, configuracao);
        if (File.Exists(Arquivo))
        {
            File.Delete(Arquivo!);
        }

        await new ImpressoraEscPos(configuracao, Transportes.Criar(configuracao)).ImprimirAsync(documento, ct);

        // O spooler grava na porta de forma assíncrona: espera o arquivo ficar com o tamanho do documento.
        var limite = DateTime.UtcNow.AddSeconds(60);
        byte[] gravado = [];
        while (DateTime.UtcNow < limite)
        {
            try
            {
                gravado = File.Exists(Arquivo) ? await File.ReadAllBytesAsync(Arquivo!, ct) : [];
            }
            catch (IOException)
            {
                // Ainda aberto pelo spooler.
            }

            if (gravado.Length >= esperado.Length)
            {
                break;
            }

            await Task.Delay(250, ct);
        }

        Assert.Equal(esperado, gravado);

        // A impressora que não existe vira falha de impressão (a venda nunca trava por ela).
        var inexistente = configuracao with { NomeSpooler = "GenesisPDV impressora que não existe" };
        await Assert.ThrowsAsync<FalhaImpressoraException>(() => Transportes.Criar(inexistente).EnviarAsync([0x41], ct));
    }
}
