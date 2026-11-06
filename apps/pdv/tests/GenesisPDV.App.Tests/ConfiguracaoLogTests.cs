using System.Net;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Serilog;
using Serilog.Extensions.Logging;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Central do PDV, bloco G2 (plano 5.5; README › decisão 67): o arquivo de log do dia sem o ruído do HttpClient a cada
/// heartbeat, com o código do terminal em cada linha depois da identidade e com o modelo de linha de antes.
/// </summary>
public sealed class ConfiguracaoLogTests : IDisposable
{
    private readonly string _raiz = Path.Combine(Path.GetTempPath(), "genesispdv-log", Guid.NewGuid().ToString("N"));

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        try
        {
            Directory.Delete(_raiz, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    /// <summary>Monta o log como o <c>Programa</c>, escreve, fecha e devolve as linhas do arquivo do dia.</summary>
    private string[] Registrar(EnriquecedorTerminal terminal, Action<ILoggerFactory> escrever)
    {
        var pasta = Path.Combine(_raiz, "logs");
        Directory.CreateDirectory(pasta);
        using (var serilog = ConfiguracaoLog.Criar(pasta, terminal, "0.0.0-teste").CreateLogger())
        using (var fabrica = new SerilogLoggerFactory(serilog))
        {
            escrever(fabrica);
        }

        var arquivo = Assert.Single(Directory.GetFiles(pasta, ConfiguracaoLog.PrefixoArquivo + "*.log"));
        return File.ReadAllLines(arquivo);
    }

    /// <summary>
    /// A composição real do PDV (o <c>IHttpClientFactory</c> com o cliente "sync" e o log do Serilog) contra uma rede
    /// falsa: 5 heartbeats e 3 linhas do PDV. Devolve as linhas do arquivo.
    /// </summary>
    private async Task<string[]> DiaDeHeartbeatsAsync(Serilog.LoggerConfiguration configuracao, string pasta)
    {
        var caminhos = CaminhosPdv.SobRaiz(Path.Combine(_raiz, "pdv-" + Path.GetFileName(pasta)));
        using (var serilog = configuracao.CreateLogger())
        using (var fabrica = new SerilogLoggerFactory(serilog))
        using (var servicos = Inicializacao.CriarServicos(caminhos, fabrica, s =>
                   s.AddHttpClient(Inicializacao.ClienteHttpSync).ConfigurePrimaryHttpMessageHandler(() => new RedeQueResponde())))
        {
            var http = servicos.GetRequiredService<IHttpClientFactory>().CreateClient(Inicializacao.ClienteHttpSync);
            for (var i = 0; i < 5; i++)
            {
                using var resposta = await http.PostAsync(new Uri("https://api.exemplo/sync/heartbeat"), null, Ct);
                Assert.Equal(HttpStatusCode.OK, resposta.StatusCode);
            }

            fabrica.CreateLogger("GenesisPDV.Sync.Cliente.ServicoSincronizacaoHttp").LogInformation("Sync: online de novo");
            fabrica.CreateLogger("System.Net.Http.HttpClient.sync.LogicalHandler").LogWarning("Falha de rede de verdade");
            fabrica.CreateLogger("Microsoft.EntityFrameworkCore.Database.Command").LogInformation("Executed DbCommand");
        }

        return File.ReadAllLines(Assert.Single(Directory.GetFiles(pasta, ConfiguracaoLog.PrefixoArquivo + "*.log")));
    }

    private static bool LinhaDoHttpClient(string l) =>
        l.Contains("Start processing HTTP request", StringComparison.Ordinal)
        || l.Contains("Sending HTTP request", StringComparison.Ordinal)
        || l.Contains("Received HTTP response", StringComparison.Ordinal)
        || l.Contains("End processing HTTP request", StringComparison.Ordinal);

    [Fact]
    public async Task Um_dia_de_heartbeats_nao_escreve_as_linhas_do_http_client()
    {
        // Controle: com a configuração de antes (só Information, sem os overrides), as 4 linhas por chamada aparecem.
        var antes = Path.Combine(_raiz, "antes");
        var linhasAntes = await DiaDeHeartbeatsAsync(
            new Serilog.LoggerConfiguration().MinimumLevel.Information()
                .WriteTo.File(Path.Combine(antes, ConfiguracaoLog.PrefixoArquivo + ".log"), rollingInterval: Serilog.RollingInterval.Day),
            antes);
        Assert.True(linhasAntes.Count(LinhaDoHttpClient) >= 5 * 4, string.Join(Environment.NewLine, linhasAntes));

        var depois = Path.Combine(_raiz, "depois");
        Directory.CreateDirectory(depois);
        var linhas = await DiaDeHeartbeatsAsync(ConfiguracaoLog.Criar(depois, new EnriquecedorTerminal(), "0.0.0-teste"), depois);
        Assert.DoesNotContain(linhas, LinhaDoHttpClient);
        Assert.DoesNotContain(linhas, l => l.Contains("Executed DbCommand", StringComparison.Ordinal));
        // O do PDV continua em Information; o aviso do HttpClient (Warning) continua aparecendo.
        Assert.Contains(linhas, l => l.Contains("[INF] GenesisPDV.Sync.Cliente.ServicoSincronizacaoHttp Sync: online de novo", StringComparison.Ordinal));
        Assert.Contains(linhas, l => l.Contains("[WRN] System.Net.Http.HttpClient.sync.LogicalHandler Falha de rede de verdade", StringComparison.Ordinal));
    }

    [Fact]
    public void Linha_leva_o_codigo_do_terminal_depois_da_identidade_e_nada_de_pessoa()
    {
        var terminal = new EnriquecedorTerminal();
        var identidade = new IdentidadeTerminal { TerminalId = Guid.Parse("019a0b3c-7d2e-7f00-8a1b-2c3d9f3a01bc"), NumeroCaixa = 2 };
        var linhas = Registrar(terminal, f =>
        {
            var log = f.CreateLogger("GenesisPDV.App.Teste");
            log.LogInformation("antes da identidade");
            terminal.Definir(identidade);
            log.LogInformation("depois da identidade");
            log.LogError(new InvalidOperationException("quebrou"), "com exceção");
            terminal.Definir(null);
            log.LogInformation("sem identidade de novo");
        });

        Assert.Equal("cx2-9f3a01bc", identidade.CodigoCurto);
        // Sem identidade a linha é a de sempre (data, nível, categoria, mensagem): o leitor do G8 não muda.
        Assert.Matches(@"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2} \[INF\] GenesisPDV\.App\.Teste antes da identidade$", linhas[0]);
        Assert.EndsWith("[INF] cx2-9f3a01bc GenesisPDV.App.Teste depois da identidade", linhas[1], StringComparison.Ordinal);
        Assert.EndsWith("[ERR] cx2-9f3a01bc GenesisPDV.App.Teste com exceção", linhas[2], StringComparison.Ordinal);
        Assert.StartsWith("System.InvalidOperationException: quebrou", linhas[3], StringComparison.Ordinal);
        Assert.EndsWith("[INF] GenesisPDV.App.Teste sem identidade de novo", linhas[^1], StringComparison.Ordinal);
    }

    [Fact]
    public void Arquivo_do_dia_vira_por_tamanho_e_guarda_30_arquivos()
    {
        Assert.Equal(20L * 1024 * 1024, ConfiguracaoLog.TamanhoMaximoArquivo);
        Assert.Equal(30, ConfiguracaoLog.ArquivosRetidos);

        // A configuração de verdade com um limite pequeno: passou do tamanho, nasce o _001 no mesmo dia (rollOnFileSizeLimit).
        var pasta = Path.Combine(_raiz, "logs-tamanho");
        Directory.CreateDirectory(pasta);
        using (var serilog = ConfiguracaoLog.Criar(pasta, new EnriquecedorTerminal(), "0.0.0-teste", tamanhoMaximoArquivo: 2048).CreateLogger())
        using (var fabrica = new SerilogLoggerFactory(serilog))
        {
            var log = fabrica.CreateLogger("GenesisPDV.App.Teste");
            for (var i = 0; i < 60; i++)
            {
                log.LogError("impressora fora do ar, tentativa {Tentativa} {Texto}", i, new string('x', 80));
            }
        }

        var arquivos = Directory.GetFiles(pasta, ConfiguracaoLog.PrefixoArquivo + "*.log").Select(Path.GetFileNameWithoutExtension).Order(StringComparer.Ordinal).ToList();
        Assert.True(arquivos.Count > 1, string.Join(", ", arquivos));
        Assert.Matches(@"^genesispdv-\d{8}$", arquivos[0]);
        Assert.Matches(@"^genesispdv-\d{8}_001$", arquivos[1]);
        Assert.All(arquivos, a => Assert.StartsWith(arquivos[0], a, StringComparison.Ordinal));
    }

    [Fact]
    public void Sessao_do_terminal_atualiza_o_codigo_do_log()
    {
        var terminal = new EnriquecedorTerminal();
        var identidade = new IdentidadeTerminal { TerminalId = Guid.CreateVersion7(), NumeroCaixa = 7 };
        var linhas = Registrar(terminal, f =>
        {
            _ = new SessaoTerminal(terminal) { Identidade = identidade };
            f.CreateLogger("GenesisPDV.App.Teste").LogInformation("com a sessão");
        });
        Assert.Contains($"[INF] {identidade.CodigoCurto} GenesisPDV.App.Teste com a sessão", Assert.Single(linhas), StringComparison.Ordinal);
    }

    private sealed class RedeQueResponde : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}") });
    }
}
