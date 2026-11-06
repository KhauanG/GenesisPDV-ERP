using GenesisPDV.Data.Entidades;
using Serilog;
using Serilog.Core;
using Serilog.Events;

namespace GenesisPDV.App.Servicos.Diagnostico;

/// <summary>
/// O arquivo de log do PDV (<c>logs/genesispdv-AAAAMMDD.log</c>; Central do PDV, bloco G2; plano 5.5; README › decisão
/// 67), montado aqui para o <c>Programa</c> e os testes usarem a mesma configuração:
/// <list type="bullet">
/// <item><c>Information</c> do PDV; <c>Microsoft.*</c> e <c>System.Net.Http.HttpClient.*</c> só a partir de
/// <c>Warning</c>: acabam as quatro linhas do <c>IHttpClientFactory</c> a cada heartbeat (30 s), pull e push.</item>
/// <item>Um arquivo por dia, até <see cref="TamanhoMaximoArquivo"/> (passou, abre <c>…_001.log</c> no mesmo dia), os
/// últimos <see cref="ArquivosRetidos"/> <b>arquivos</b> guardados (até 600 MB): são 30 dias num caixa normal, menos num
/// dia de erro em laço que vira vários arquivos (os <c>_001</c>, <c>_002</c> contam).</item>
/// <item>Cada linha leva o código curto do terminal (<see cref="IdentidadeTerminal.CodigoCurto"/>) depois do nível,
/// quando a identidade já é conhecida (<see cref="EnriquecedorTerminal"/>); antes dela (ou sem ativação), a linha é a
/// mesma de antes. São dois formatos no mesmo arquivo (e os arquivos de antes desta versão só têm o primeiro): o leitor
/// do G8 aceita os dois. Nada de pessoa no log.</item>
/// </list>
/// </summary>
public static class ConfiguracaoLog
{
    public const long TamanhoMaximoArquivo = 20L * 1024 * 1024;
    public const int ArquivosRetidos = 30;
    public const string PrefixoArquivo = "genesispdv-";

    /// <summary>Data, nível, terminal (quando há), categoria e mensagem; a exceção nas linhas seguintes.</summary>
    public const string Modelo =
        "{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} [{Level:u3}] {" + EnriquecedorTerminal.Propriedade + ":l}{SourceContext} {Message:lj}{NewLine}{Exception}";

    /// <param name="tamanhoMaximoArquivo">O <see cref="TamanhoMaximoArquivo"/>; menor só no teste da virada por tamanho.</param>
    public static LoggerConfiguration Criar(string pastaLogs, EnriquecedorTerminal terminal, string versao, long tamanhoMaximoArquivo = TamanhoMaximoArquivo)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pastaLogs);
        ArgumentNullException.ThrowIfNull(terminal);
        return new LoggerConfiguration()
            .MinimumLevel.Information()
            .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
            .MinimumLevel.Override("System.Net.Http.HttpClient", LogEventLevel.Warning)
            .Enrich.WithProperty("versao", versao)
            .Enrich.With(terminal)
            .WriteTo.File(
                Path.Combine(pastaLogs, PrefixoArquivo + ".log"),
                rollingInterval: RollingInterval.Day,
                fileSizeLimitBytes: tamanhoMaximoArquivo,
                rollOnFileSizeLimit: true,
                retainedFileCountLimit: ArquivosRetidos,
                outputTemplate: Modelo);
    }
}

/// <summary>
/// Põe o código curto do terminal em cada linha do log (<see cref="ConfiguracaoLog"/>), lido da identidade quando o
/// <see cref="SessaoTerminal"/> a recebe (abertura, ativação). Sem identidade, não acrescenta nada.
/// </summary>
public sealed class EnriquecedorTerminal : ILogEventEnricher
{
    public const string Propriedade = "Terminal";

    /// <summary>O do processo (o <c>Programa</c> monta o log com ele e o <see cref="SessaoTerminal"/> o atualiza).</summary>
    public static EnriquecedorTerminal Processo { get; } = new();

    private volatile LogEventProperty? _propriedade;

    public void Definir(IdentidadeTerminal? identidade) =>
        _propriedade = identidade is null ? null : new LogEventProperty(Propriedade, new ScalarValue(identidade.CodigoCurto + " "));

    public void Enrich(LogEvent logEvent, ILogEventPropertyFactory propertyFactory)
    {
        ArgumentNullException.ThrowIfNull(logEvent);
        if (_propriedade is { } p)
        {
            logEvent.AddPropertyIfAbsent(p);
        }
    }
}
