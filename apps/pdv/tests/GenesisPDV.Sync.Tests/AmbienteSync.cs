using System.Collections.Concurrent;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Acesso;
using GenesisPDV.Sync.Ativacao;
using GenesisPDV.Sync.Ciclo;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Pull;
using GenesisPDV.Sync.Push;
using GenesisPDV.Sync.Relogio;
using GenesisPDV.Sync.Token;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.Sync.Tests;

/// <summary>Relógio dos testes: começa agora e só anda quando o teste manda.</summary>
public sealed class RelogioAjustavel : IRelogio
{
    public DateTimeOffset Agora { get; set; } = new RelogioSistema().Agora;
}

/// <summary>Logger que guarda as linhas formatadas (para conferir que o token nunca aparece).</summary>
public sealed class LogEmMemoria : ILoggerProvider, ILogger
{
    public ConcurrentQueue<string> Linhas { get; } = new();

    public ILogger CreateLogger(string categoryName) => this;

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        Linhas.Enqueue($"{logLevel}: {formatter(state, exception)} {exception}");
    }

    public void Dispose()
    {
    }
}

/// <summary>
/// PDV sem tela numa pasta temporária: <c>pdv.db</c> migrado, protetor de arquivo (chave sob a pasta, machine-id fixo),
/// cliente HTTP contra a <see cref="ApiFalsa"/>, ativação, guarda e rotação do token, aplicador do pull, carga inicial e
/// login offline.
/// </summary>
public sealed class AmbienteSync : IDisposable
{
    public static readonly Uri Url = new("https://api.exemplo/");

    private readonly ILoggerFactory _logs;

    private AmbienteSync()
    {
        Raiz = Path.Combine(Path.GetTempPath(), "genesispdv-sync", Guid.NewGuid().ToString("N"));
        Caminhos = CaminhosPdv.SobRaiz(Raiz);
        Caminhos.CriarPastas();
        Fabrica = new FabricaPdvDb(Caminhos.ArquivoBanco);
        Terminal = new RepositorioTerminal(Fabrica, Relogio);
        Protetor = new ProtetorArquivo(Caminhos.ArquivoChaveTerminal, () => "0123456789abcdef0123456789abcdef");
        Http = new HttpClient(Api);
        Maquina = new MaquinaLocal("CAIXA02-TESTE", "Linux de teste x64", IdHardware.De("maquina-de-teste"), "1.4.2", "linux_x64");
        Cofre = new CofreToken(Terminal, Protetor, Relogio);
        Cliente = new ClienteSyncHttp(Http, Maquina.ParaCliente(), Relogio, Cofre, () => Url);
        _logs = LoggerFactory.Create(b => b.AddProvider(Log));
        Ativacao = new ServicoAtivacao(Cliente, Terminal, Protetor, Relogio, Maquina, _logs.CreateLogger<ServicoAtivacao>());
        Rotacao = new RotacaoToken(Cliente, Terminal, Cofre);
        Aplicador = new AplicadorPull(Fabrica, Relogio, _logs.CreateLogger<AplicadorPull>());
        Carga = new CargaInicial(Cliente, Aplicador, Fabrica, Terminal, _logs.CreateLogger<CargaInicial>());
        Autenticador = new AutenticadorOffline(Fabrica, Terminal, _logs.CreateLogger<AutenticadorOffline>());
        RelogioSync = new RelogioSync(Fabrica, Relogio, _logs.CreateLogger<RelogioSync>());
        ClienteComRelogio = new ClienteSyncHttp(Http, Maquina.ParaCliente(), Relogio, Cofre, () => Url, RelogioSync);
        Outbox = new OutboxSync(Fabrica, RelogioSync, Maquina.VersaoApp, _logs.CreateLogger<OutboxSync>());
        Envio = new EnvioPush(ClienteComRelogio, Fabrica, Relogio, Maquina.VersaoApp, _logs.CreateLogger<EnvioPush>()) { Aleatorio = () => 1 };
        Comandos = new ProcessadorComandos(Fabrica, Terminal, Relogio, _logs.CreateLogger<ProcessadorComandos>());
    }

    /// <summary>Ciclo online com intervalos curtos (o padrão é 30 s), contra a <see cref="ApiFalsa"/>.</summary>
    /// <param name="cliente">Outro cliente (ex.: com <see cref="TemposLimiteSync"/> curtos); nulo = <see cref="ClienteComRelogio"/>.</param>
    public ServicoSincronizacaoHttp CriarCiclo(OpcoesSincronizacao? opcoes = null, Func<Guid?>? operador = null, IClienteSync? cliente = null)
    {
        var ciclo = new ServicoSincronizacaoHttp(
            cliente ?? ClienteComRelogio, Fabrica, Terminal, Aplicador, Outbox, Envio, Comandos, Rotacao, RelogioSync, Maquina,
            opcoes ?? new OpcoesSincronizacao
            {
                Heartbeat = TimeSpan.FromMilliseconds(200),
                Pull = TimeSpan.FromMilliseconds(200),
                PushPendente = TimeSpan.FromMilliseconds(200),
                Debounce = TimeSpan.FromMilliseconds(20),
            },
            _logs.CreateLogger<ServicoSincronizacaoHttp>(),
            operador);
        _ciclos.Add(ciclo);
        return ciclo;
    }

    private readonly List<ServicoSincronizacaoHttp> _ciclos = [];

    /// <summary>Espera a condição por polling (nunca um sleep fixo), com tempo limite.</summary>
    public static async Task EsperarAsync(Func<Task<bool>> condicao, string descricao, int timeoutMs = 15_000)
    {
        var limite = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!await condicao())
        {
            if (DateTime.UtcNow > limite)
            {
                throw new TimeoutException($"Condição não atingida: {descricao}.");
            }

            await Task.Delay(20, TestContext.Current.CancellationToken);
        }
    }

    public static Task EsperarAsync(Func<bool> condicao, string descricao, int timeoutMs = 15_000) =>
        EsperarAsync(() => Task.FromResult(condicao()), descricao, timeoutMs);

    public string Raiz { get; }
    public CaminhosPdv Caminhos { get; }
    public FabricaPdvDb Fabrica { get; }
    public RelogioAjustavel Relogio { get; } = new();
    public RepositorioTerminal Terminal { get; }
    public ProtetorArquivo Protetor { get; }
    public ApiFalsa Api { get; } = new();
    public HttpClient Http { get; }
    public MaquinaLocal Maquina { get; }
    public CofreToken Cofre { get; }
    public ClienteSyncHttp Cliente { get; }
    public ServicoAtivacao Ativacao { get; }
    public RotacaoToken Rotacao { get; }
    public AplicadorPull Aplicador { get; }
    public CargaInicial Carga { get; }
    public AutenticadorOffline Autenticador { get; }
    public RelogioSync RelogioSync { get; }

    /// <summary>Cliente que manda as amostras de relógio ao <see cref="RelogioSync"/> (o do ciclo online).</summary>
    public ClienteSyncHttp ClienteComRelogio { get; }

    public OutboxSync Outbox { get; }
    public EnvioPush Envio { get; }
    public ProcessadorComandos Comandos { get; }
    public LogEmMemoria Log { get; } = new();

    public static async Task<AmbienteSync> CriarAsync()
    {
        var ambiente = new AmbienteSync();
        await InicializadorBanco.InicializarAsync(ambiente.Fabrica, ambiente.Caminhos.PastaBackup, ambiente.Relogio.Agora, TestContext.Current.CancellationToken);
        return ambiente;
    }

    /// <summary>Banco só até <paramref name="migracao"/> (o PDV de uma versão anterior); <see cref="MigrarAsync"/> leva à atual.</summary>
    public static async Task<AmbienteSync> CriarAteAsync(string migracao)
    {
        var ambiente = new AmbienteSync();
        await using var db = ambiente.Fabrica.CreateDbContext();
        await db.GetService<IMigrator>().MigrateAsync(migracao, TestContext.Current.CancellationToken);
        return ambiente;
    }

    /// <summary>Atualização do app: aplica as migrações que faltam, como na abertura do PDV.</summary>
    public Task MigrarAsync() =>
        InicializadorBanco.InicializarAsync(Fabrica, Caminhos.PastaBackup, Relogio.Agora, TestContext.Current.CancellationToken);

    /// <summary>Ativação com o código da fixture contra a API falsa (201 por padrão).</summary>
    public Task<ResultadoAtivacao> AtivarAsync(string codigo = "K7QM-2XRD") =>
        Ativacao.AtivarAsync(Url, "100001", codigo, TestContext.Current.CancellationToken);

    public long Contar(string tabela) => (long)Escalar($"select count(*) from {tabela}")!;

    public object? Escalar(string sql)
    {
        using var conexao = new SqliteConnection(Fabrica.StringConexao);
        conexao.Open();
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = sql;
        return cmd.ExecuteScalar();
    }

    /// <summary>Bytes do <c>pdv.db</c> e do WAL (a página recém-gravada pode estar só no WAL).</summary>
    public byte[] BytesDoBanco()
    {
        var bytes = new List<byte>();
        foreach (var arquivo in new[] { Caminhos.ArquivoBanco, Caminhos.ArquivoBanco + "-wal" })
        {
            if (File.Exists(arquivo))
            {
                using var fluxo = new FileStream(arquivo, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var memoria = new MemoryStream();
                fluxo.CopyTo(memoria);
                bytes.AddRange(memoria.ToArray());
            }
        }

        return [.. bytes];
    }

    public void Dispose()
    {
        foreach (var ciclo in _ciclos)
        {
            ciclo.Dispose();
        }

        Http.Dispose();
        _logs.Dispose();
        SqliteConnection.ClearAllPools();
        try
        {
            Directory.Delete(Raiz, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // No Windows o arquivo pode seguir aberto por alguns ms (WAL/shm); a pasta fica no %TEMP%.
        }
    }
}
