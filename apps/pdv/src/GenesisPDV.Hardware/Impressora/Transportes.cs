using System.ComponentModel;
using System.IO.Ports;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.RegularExpressions;

namespace GenesisPDV.Hardware.Impressora;

/// <summary>
/// Leva os bytes já adaptados até a impressora (PDV 6.2; implantação I4). Toda falha vira
/// <see cref="FalhaImpressoraException"/> com a mensagem para o operador: a venda nunca trava nem é desfeita por ela.
/// </summary>
public interface ITransporteImpressora
{
    Task EnviarAsync(byte[] dados, CancellationToken ct = default);
}

/// <summary>Monta o transporte da conexão configurada (os testes trocam por um que guarda os bytes).</summary>
public delegate ITransporteImpressora FabricaTransporteImpressora(ConfiguracaoImpressora configuracao);

public static class Transportes
{
    /// <summary>Tempo para conectar e enviar (rede), abrir a serial e cada consulta ao spooler: curto, a fila guarda o que não saiu.</summary>
    public static readonly TimeSpan TempoLimite = TimeSpan.FromSeconds(4);

    /// <summary>
    /// Quanto o <see cref="TransporteSpoolerWindows"/> espera o trabalho sair da fila do Windows; parado mais que isso
    /// (impressora desligada, sem papel, offline), é cancelado — senão o Windows o imprimiria sozinho mais tarde.
    /// </summary>
    public static readonly TimeSpan TempoFilaWindows = TimeSpan.FromSeconds(10);

    /// <summary>
    /// Escrita na serial: o tempo da linha (8N1 = 10 bits por byte) com 50% de folga, mais o <see cref="TempoLimite"/>. O
    /// QR em imagem da Bematech (cerca de 15 KB) leva uns 15 s a 9600 baud: um limite fixo o cortaria sempre no meio.
    /// </summary>
    public static TimeSpan TempoSerial(int bytes, int baud) =>
        TempoLimite + TimeSpan.FromSeconds(bytes * 10.0 * 1.5 / Math.Max(baud, 1));

    /// <summary>
    /// Limite do envio inteiro (<see cref="ImpressoraEscPos"/>), por cima do de cada transporte: o que travar numa chamada
    /// bloqueante (o <c>write()</c> do <c>usblp</c> sem papel, o spooler de um servidor que caiu) vira falha e a venda segue.
    /// </summary>
    public static TimeSpan TempoEnvio(ConfiguracaoImpressora c, int bytes)
    {
        ArgumentNullException.ThrowIfNull(c);
        return c.Conexao switch
        {
            TipoConexao.Serial => TempoSerial(bytes, c.Baud) + TempoLimite,
            TipoConexao.Spooler => TempoLimite + TempoLimite + TempoFilaWindows,
            _ => TempoLimite + TempoLimite,
        };
    }

    public static ITransporteImpressora Criar(ConfiguracaoImpressora c)
    {
        ArgumentNullException.ThrowIfNull(c);
        return c.Conexao switch
        {
            TipoConexao.Spooler when OperatingSystem.IsWindows() => new TransporteSpoolerWindows(c.NomeSpooler ?? string.Empty),
            TipoConexao.Spooler => throw new FalhaImpressoraException("A impressora do Windows só existe no Windows: use rede, serial ou dispositivo."),
            TipoConexao.Rede => new TransporteTcp(c.Endereco ?? string.Empty, c.PortaRede, TempoLimite),
            TipoConexao.Serial => new TransporteSerial(c.Porta ?? string.Empty, c.Baud),
            TipoConexao.Dispositivo when OperatingSystem.IsLinux() => new TransporteDispositivo(c.Porta ?? ConfiguracaoImpressora.DispositivoPadrao),
            TipoConexao.Dispositivo => throw new FalhaImpressoraException(TransporteDispositivo.MensagemSoLinux),
            _ => throw new FalhaImpressoraException("Nenhuma impressora configurada neste caixa."),
        };
    }
}

/// <summary>Impressora de rede (TCP 9100, "RAW"/JetDirect): conecta, manda e fecha, com tempo limite curto.</summary>
public sealed class TransporteTcp(string endereco, int porta, TimeSpan tempoLimite) : ITransporteImpressora
{
    public async Task EnviarAsync(byte[] dados, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(dados);
        using var limite = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limite.CancelAfter(tempoLimite);
        try
        {
            using var cliente = new TcpClient { NoDelay = true, SendTimeout = (int)tempoLimite.TotalMilliseconds };
            await cliente.ConnectAsync(endereco, porta, limite.Token).ConfigureAwait(false);
            var fluxo = cliente.GetStream();
            await fluxo.WriteAsync(dados, limite.Token).ConfigureAwait(false);
            await fluxo.FlushAsync(limite.Token).ConfigureAwait(false);
            cliente.Client.Shutdown(SocketShutdown.Send);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new FalhaImpressoraException($"Impressora de rede {endereco}:{porta} não respondeu.");
        }
        catch (Exception e) when (e is SocketException or IOException)
        {
            throw new FalhaImpressoraException($"Impressora de rede {endereco}:{porta} não respondeu.", e);
        }
    }
}

/// <summary>
/// Arquivo de dispositivo do Linux (<c>/dev/usb/lp0</c>, módulo <c>usblp</c>): o usuário precisa do grupo <c>lp</c>. O
/// caminho é texto livre da configuração, então só vale um dispositivo de impressora dentro de <c>/dev</c>
/// (<c>usb/lpN</c>, <c>lpN</c>, <c>ttyUSBN</c>, <c>ttyACMN</c>; o link vale pelo destino) — conferido ao salvar e de novo
/// aqui, antes de abrir: um arquivo comum (o <c>pdv.db</c>, um backup) nunca é aberto para escrita. Só o root cria
/// arquivo em <c>/dev</c>.
/// </summary>
/// <param name="raiz">A pasta dos dispositivos (<c>/dev</c>; os testes usam uma temporária).</param>
public sealed partial class TransporteDispositivo(string caminho, string raiz = TransporteDispositivo.RaizDispositivos) : ITransporteImpressora
{
    public const string RaizDispositivos = "/dev";

    public const string MensagemSoLinux = "O dispositivo de impressora só existe no Linux: no Windows use a impressora instalada (spooler), a rede ou a serial.";

    /// <summary>O problema do caminho (para a tela), ou nulo.</summary>
    public static string? Validar(string? caminho, string raiz = RaizDispositivos) => string.IsNullOrWhiteSpace(caminho)
        ? $"Informe o dispositivo (ex.: {ConfiguracaoImpressora.DispositivoPadrao})."
        : Resolver(caminho, raiz) is null
            ? $"\"{caminho.Trim()}\" não é um dispositivo de impressora: use {ConfiguracaoImpressora.DispositivoPadrao} (ou /dev/lpN, /dev/ttyUSBN, /dev/ttyACMN)."
            : null;

    public async Task EnviarAsync(byte[] dados, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(dados);
        var real = Resolver(caminho, raiz)
                   ?? throw new FalhaImpressoraException($"\"{caminho}\" não é um dispositivo de impressora (nada foi gravado): confira a impressora na Central do PDV › 3 Impressora e gaveta.");
        try
        {
            await using var fluxo = new FileStream(real, FileMode.Open, FileAccess.Write, FileShare.ReadWrite, 4096, useAsync: false);
            await fluxo.WriteAsync(dados, ct).ConfigureAwait(false);
            await fluxo.FlushAsync(ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw new FalhaImpressoraException($"Impressora {caminho} indisponível ({e.Message}).", e);
        }
    }

    /// <summary>O caminho real (link resolvido) se for um dispositivo de impressora dentro da <paramref name="raiz"/>; senão nulo.</summary>
    private static string? Resolver(string caminho, string raiz)
    {
        string completo;
        try
        {
            completo = Path.GetFullPath(caminho.Trim());
            try
            {
                if (File.ResolveLinkTarget(completo, returnFinalTarget: true) is { } destino)
                {
                    completo = Path.GetFullPath(destino.FullName);
                }
            }
            catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
            {
                // Ainda não existe (impressora desligada na hora de configurar): vale o nome.
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }

        var pasta = Path.TrimEndingDirectorySeparator(Path.GetFullPath(raiz)) + "/";
        return completo.StartsWith(pasta, StringComparison.Ordinal) && NomeDispositivo().IsMatch(completo[pasta.Length..]) ? completo : null;
    }

    [GeneratedRegex(@"^(usb/lp|lp|ttyUSB|ttyACM)[0-9]{1,2}$", RegexOptions.CultureInvariant)]
    private static partial Regex NomeDispositivo();
}

/// <summary>Porta serial vista pelo transporte (a de verdade é a <see cref="PortaSerialSistema"/>; os testes simulam).</summary>
public interface IPortaSerial : IDisposable
{
    void Abrir();

    void Escrever(byte[] dados);
}

/// <summary>
/// Serial (COMx, também a COM virtual do driver USB da Epson/Bematech; <c>/dev/ttyUSBx</c> no Linux), 8N1. A escrita
/// roda fora da thread da tela, com o tempo limite proporcional ao tamanho e à velocidade
/// (<see cref="Transportes.TempoSerial"/>).
/// </summary>
public sealed class TransporteSerial(string porta, int baud, Func<string, int, IPortaSerial>? fabrica = null) : ITransporteImpressora
{
    public async Task EnviarAsync(byte[] dados, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(dados);
        try
        {
            await Task.Run(() =>
            {
                var tempo = Transportes.TempoSerial(dados.Length, baud);
                using var serial = (fabrica ?? ((p, b) => new PortaSerialSistema(p, b, tempo)))(porta, baud);
                serial.Abrir();
                serial.Escrever(dados);
            }, ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or TimeoutException or InvalidOperationException or ArgumentException)
        {
            throw new FalhaImpressoraException($"Impressora na porta {porta} não respondeu ({e.Message}).", e);
        }
    }
}

/// <summary>
/// <see cref="SerialPort"/> do <c>System.IO.Ports</c>, com DTR/RTS ligados (a impressora espera o "pronto"). O
/// <paramref name="tempoLimite"/> vale para a escrita do documento inteiro (no Windows vira o
/// <c>WriteTotalTimeoutConstant</c>, sem multiplicador): quem cria calcula pelo tamanho.
/// </summary>
public sealed class PortaSerialSistema(string porta, int baud, TimeSpan tempoLimite) : IPortaSerial
{
    private readonly SerialPort _porta = new(porta, baud, Parity.None, 8, StopBits.One)
    {
        Handshake = Handshake.None,
        DtrEnable = true,
        RtsEnable = true,
        WriteTimeout = (int)tempoLimite.TotalMilliseconds,
        ReadTimeout = (int)tempoLimite.TotalMilliseconds,
    };

    public void Abrir() => _porta.Open();

    public void Escrever(byte[] dados)
    {
        ArgumentNullException.ThrowIfNull(dados);
        _porta.Write(dados, 0, dados.Length);
        _porta.BaseStream.Flush();
    }

    public void Dispose() => _porta.Dispose();

    public static IReadOnlyList<string> Listar()
    {
        try
        {
            return [.. SerialPort.GetPortNames().Order(StringComparer.OrdinalIgnoreCase)];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or PlatformNotSupportedException)
        {
            return [];
        }
    }
}

/// <summary>
/// O que a situação do spooler do Windows quer dizer para o operador (<see cref="TransporteSpoolerWindows"/>), fora da
/// classe com P/Invoke para os testes rodarem em qualquer sistema. Valores do <c>winspool.h</c>.
/// </summary>
public static class SituacaoSpooler
{
    public const uint ImpressoraPausada = 0x1;
    public const uint ImpressoraErro = 0x2;
    public const uint ImpressoraAtolada = 0x8;
    public const uint ImpressoraSemPapel = 0x10;
    public const uint ImpressoraOffline = 0x80;
    public const uint ImpressoraNaoDisponivel = 0x1000;
    public const uint ImpressoraIntervencao = 0x100000;
    public const uint ImpressoraTampaAberta = 0x400000;

    /// <summary><c>PRINTER_ATTRIBUTE_WORK_OFFLINE</c>: "Usar impressora offline" marcado no Windows.</summary>
    public const uint AtributoUsarOffline = 0x400;

    public const uint TrabalhoPausado = 0x1;
    public const uint TrabalhoErro = 0x2;
    public const uint TrabalhoExcluindo = 0x4;
    public const uint TrabalhoOffline = 0x20;
    public const uint TrabalhoSemPapel = 0x40;
    public const uint TrabalhoImpresso = 0x80;
    public const uint TrabalhoExcluido = 0x100;
    public const uint TrabalhoBloqueado = 0x200;
    public const uint TrabalhoIntervencao = 0x400;
    public const uint TrabalhoCompleto = 0x1000;

    /// <summary>
    /// O problema da impressora (<c>PRINTER_INFO_2.Status</c> e <c>Attributes</c>) antes do envio, ou nulo. Com ele o
    /// documento nem entra na fila do Windows (de onde sairia sozinho quando a impressora voltasse).
    /// </summary>
    public static string? ProblemaImpressora(uint status, uint atributos) =>
        (status & ImpressoraSemPapel) != 0 ? "está sem papel"
        : (status & ImpressoraTampaAberta) != 0 ? "está com a tampa aberta"
        : (status & ImpressoraAtolada) != 0 ? "está com o papel atolado"
        : (atributos & AtributoUsarOffline) != 0 ? "está marcada \"Usar impressora offline\" no Windows"
        : (status & (ImpressoraOffline | ImpressoraNaoDisponivel)) != 0 ? "está desligada ou offline"
        : (status & ImpressoraPausada) != 0 ? "está pausada no Windows"
        : (status & (ImpressoraErro | ImpressoraIntervencao)) != 0 ? "está com erro"
        : null;

    /// <summary>Saiu da fila: impresso (ou mantido depois de impresso, "Manter documentos impressos").</summary>
    public static bool TrabalhoConcluido(uint status) => (status & (TrabalhoImpresso | TrabalhoCompleto)) != 0;

    /// <summary>O problema do trabalho na fila (<c>JOB_INFO_1.Status</c>), ou nulo enquanto ele anda.</summary>
    public static string? ProblemaTrabalho(uint status) =>
        TrabalhoConcluido(status) ? null
        : (status & TrabalhoSemPapel) != 0 ? "está sem papel"
        : (status & TrabalhoOffline) != 0 ? "está desligada ou offline"
        : (status & (TrabalhoExcluindo | TrabalhoExcluido)) != 0 ? "teve o documento excluído da fila do Windows"
        : (status & TrabalhoPausado) != 0 ? "está com o documento pausado no Windows"
        : (status & (TrabalhoErro | TrabalhoBloqueado | TrabalhoIntervencao)) != 0 ? "está com erro"
        : null;
}

/// <summary>
/// Impressora instalada no Windows (driver da Epson/Bematech, "Generic / Text Only"…), padrão da loja (dono, I4): o
/// documento vai ao spooler com o tipo de dado <c>RAW</c> (<c>OpenPrinter</c>, <c>StartDocPrinter</c>,
/// <c>WritePrinter</c>), sem passar pelo driver gráfico — os comandos ESC/POS chegam como saíram do adaptador.
/// <para>
/// O <c>WritePrinter</c> só grava no arquivo de spool: com a impressora desligada, sem papel ou offline ele dá certo e o
/// Windows imprimiria o documento sozinho quando ela voltasse — o cupom de um cliente que já foi embora, em dobro com a
/// reimpressão (decisão 63: nova tentativa só manual). Por isso: antes do envio, a situação da impressora
/// (<c>GetPrinter</c> nível 2: sem papel, tampa, offline, "Usar impressora offline", pausada, erro) recusa o documento;
/// depois, o trabalho (o <c>JobId</c> do <c>StartDocPrinter</c>) é acompanhado pelo <c>GetJob</c> até sair da fila, e
/// com erro ou parado mais que <see cref="Transportes.TempoFilaWindows"/> é excluído (<c>SetJob</c>
/// <c>JOB_CONTROL_DELETE</c>) e vira <see cref="FalhaImpressoraException"/> (fila do PDV, <c>falhou</c>). A falha no meio
/// da escrita descarta o trabalho (<c>AbortPrinter</c>), nunca entrega o pedaço ao spooler. Limite: o driver que não
/// informa a situação (sem comunicação bidirecional) e aceita o documento num buffer próprio continua parecendo
/// impresso.
/// </para>
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class TransporteSpoolerWindows(string nomeImpressora, TimeSpan? tempoFila = null) : ITransporteImpressora
{
    public const string NomeDocumento = "GenesisPDV";

    private const int ParametroInvalido = 87;
    private const uint ExcluirTrabalho = 5;

    public Task EnviarAsync(byte[] dados, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(dados);
        return Task.Run(() => Enviar(nomeImpressora, dados, tempoFila ?? Transportes.TempoFilaWindows, ct), ct);
    }

    private static void Enviar(string nome, byte[] dados, TimeSpan tempoFila, CancellationToken ct)
    {
        if (!OpenPrinterW(nome, out var impressora, IntPtr.Zero))
        {
            throw Falha(nome, "não encontrada no Windows");
        }

        try
        {
            ConferirImpressora(nome, impressora);
            var documento = new DocInfo1 { NomeDocumento = NomeDocumento, Arquivo = null, TipoDado = "RAW" };
            var trabalho = StartDocPrinterW(impressora, 1, ref documento);
            if (trabalho == 0)
            {
                throw Falha(nome, "recusou o documento");
            }

            var entregue = false;
            try
            {
                if (!StartPagePrinter(impressora))
                {
                    throw Falha(nome, "recusou o documento");
                }

                if (!WritePrinter(impressora, dados, dados.Length, out var escritos) || escritos != dados.Length)
                {
                    throw Falha(nome, "não recebeu o documento inteiro");
                }

                if (!EndPagePrinter(impressora) || !EndDocPrinter(impressora))
                {
                    throw Falha(nome, "não fechou o documento");
                }

                entregue = true;
            }
            finally
            {
                if (!entregue)
                {
                    // O pedaço já gravado no spool não pode sair no papel: a fila do PDV manda o documento inteiro depois.
                    _ = AbortPrinter(impressora);
                }
            }

            AcompanharTrabalho(nome, impressora, (uint)trabalho, tempoFila, ct);
        }
        finally
        {
            _ = ClosePrinter(impressora);
        }
    }

    /// <summary>Recusa antes de pôr na fila do Windows a impressora que ele já sabe que não imprime.</summary>
    private static void ConferirImpressora(string nome, IntPtr impressora)
    {
        if (LerImpressora(impressora) is var (status, atributos) && SituacaoSpooler.ProblemaImpressora(status, atributos) is { } problema)
        {
            throw new FalhaImpressoraException($"Impressora \"{nome}\" {problema}.");
        }
    }

    /// <summary>Espera o trabalho sair da fila; com erro ou parado demais, exclui e falha.</summary>
    private static void AcompanharTrabalho(string nome, IntPtr impressora, uint trabalho, TimeSpan tempoFila, CancellationToken ct)
    {
        var relogio = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            if (StatusTrabalho(impressora, trabalho) is not { } status || SituacaoSpooler.TrabalhoConcluido(status))
            {
                return;
            }

            var problema = SituacaoSpooler.ProblemaTrabalho(status)
                           ?? (LerImpressora(impressora) is var (situacao, atributos) ? SituacaoSpooler.ProblemaImpressora(situacao, atributos) : null);
            if (problema is null && relogio.Elapsed < tempoFila && !ct.IsCancellationRequested)
            {
                Thread.Sleep(200);
                continue;
            }

            _ = SetJobW(impressora, trabalho, 0, IntPtr.Zero, ExcluirTrabalho);
            throw new FalhaImpressoraException(problema is null
                ? $"Impressora \"{nome}\" não imprimiu em {tempoFila.TotalSeconds:0} s (desligada, sem papel ou offline?): o documento foi tirado da fila do Windows."
                : $"Impressora \"{nome}\" {problema}: o documento foi tirado da fila do Windows.");
        }
    }

    /// <summary><c>Status</c> e <c>Attributes</c> do <c>PRINTER_INFO_2</c>; nulo se o Windows não informar.</summary>
    private static (uint Status, uint Atributos)? LerImpressora(IntPtr impressora)
    {
        _ = GetPrinterW(impressora, 2, IntPtr.Zero, 0, out var necessario);
        if (necessario == 0)
        {
            return null;
        }

        var buffer = Marshal.AllocHGlobal((int)necessario);
        try
        {
            if (!GetPrinterW(impressora, 2, buffer, necessario, out _))
            {
                return null;
            }

            var info = Marshal.PtrToStructure<PrinterInfo2>(buffer);
            return (info.Status, info.Atributos);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>O <c>JOB_INFO_1.Status</c> do trabalho; nulo quando ele já saiu da fila.</summary>
    private static uint? StatusTrabalho(IntPtr impressora, uint trabalho)
    {
        if (!GetJobW(impressora, trabalho, 1, IntPtr.Zero, 0, out var necessario) && Marshal.GetLastPInvokeError() == ParametroInvalido)
        {
            return null;
        }

        if (necessario == 0)
        {
            return null;
        }

        var buffer = Marshal.AllocHGlobal((int)necessario);
        try
        {
            if (!GetJobW(impressora, trabalho, 1, buffer, necessario, out _))
            {
                return null;
            }

            return Marshal.PtrToStructure<JobInfo1>(buffer).Status;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static FalhaImpressoraException Falha(string nome, string oQue) => Marshal.GetLastPInvokeError() is var erro and not 0
        ? new($"Impressora \"{nome}\" {oQue} ({new Win32Exception(erro).Message}).")
        : new($"Impressora \"{nome}\" {oQue}.");

    /// <summary>Impressoras locais e conectadas (<c>EnumPrinters</c> nível 4), para a lista da configuração.</summary>
    public static IReadOnlyList<string> Listar()
    {
        const uint locais = 0x2, conectadas = 0x4;
        _ = EnumPrintersW(locais | conectadas, null, 4, IntPtr.Zero, 0, out var necessario, out _);
        if (necessario == 0)
        {
            return [];
        }

        var buffer = Marshal.AllocHGlobal((int)necessario);
        try
        {
            if (!EnumPrintersW(locais | conectadas, null, 4, buffer, necessario, out _, out var quantidade))
            {
                return [];
            }

            var nomes = new List<string>();
            var tamanho = Marshal.SizeOf<PrinterInfo4>();
            for (var i = 0; i < quantidade; i++)
            {
                var info = Marshal.PtrToStructure<PrinterInfo4>(buffer + (i * tamanho));
                if (Marshal.PtrToStringUni(info.Nome) is { Length: > 0 } nome)
                {
                    nomes.Add(nome);
                }
            }

            return [.. nomes.Order(StringComparer.OrdinalIgnoreCase)];
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DocInfo1
    {
        [MarshalAs(UnmanagedType.LPWStr)]
        public string NomeDocumento;

        [MarshalAs(UnmanagedType.LPWStr)]
        public string? Arquivo;

        [MarshalAs(UnmanagedType.LPWStr)]
        public string TipoDado;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PrinterInfo2
    {
        public IntPtr Servidor;
        public IntPtr Nome;
        public IntPtr Compartilhamento;
        public IntPtr Porta;
        public IntPtr Driver;
        public IntPtr Comentario;
        public IntPtr Local;
        public IntPtr ModoDispositivo;
        public IntPtr ArquivoSeparador;
        public IntPtr Processador;
        public IntPtr TipoDado;
        public IntPtr Parametros;
        public IntPtr Seguranca;
        public uint Atributos;
        public uint Prioridade;
        public uint PrioridadePadrao;
        public uint Inicio;
        public uint Fim;
        public uint Status;
        public uint Trabalhos;
        public uint PaginasPorMinuto;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobInfo1
    {
        public uint Id;
        public IntPtr Impressora;
        public IntPtr Maquina;
        public IntPtr Usuario;
        public IntPtr Documento;
        public IntPtr TipoDado;
        public IntPtr TextoStatus;
        public uint Status;
        public uint Prioridade;
        public uint Posicao;
        public uint TotalPaginas;
        public uint PaginasImpressas;
        public ushort Ano;
        public ushort Mes;
        public ushort DiaSemana;
        public ushort Dia;
        public ushort Hora;
        public ushort Minuto;
        public ushort Segundo;
        public ushort Milissegundo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PrinterInfo4
    {
        public IntPtr Nome;
        public IntPtr Servidor;
        public uint Atributos;
    }

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenPrinterW(string nome, out IntPtr impressora, IntPtr padrao);

    [DllImport("winspool.drv", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClosePrinter(IntPtr impressora);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern int StartDocPrinterW(IntPtr impressora, int nivel, ref DocInfo1 documento);

    [DllImport("winspool.drv", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EndDocPrinter(IntPtr impressora);

    [DllImport("winspool.drv", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool StartPagePrinter(IntPtr impressora);

    [DllImport("winspool.drv", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EndPagePrinter(IntPtr impressora);

    [DllImport("winspool.drv", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WritePrinter(IntPtr impressora, byte[] dados, int tamanho, out int escritos);

    [DllImport("winspool.drv", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AbortPrinter(IntPtr impressora);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetPrinterW(IntPtr impressora, uint nivel, IntPtr buffer, uint tamanho, out uint necessario);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetJobW(IntPtr impressora, uint trabalho, uint nivel, IntPtr buffer, uint tamanho, out uint necessario);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetJobW(IntPtr impressora, uint trabalho, uint nivel, IntPtr buffer, uint comando);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumPrintersW(uint flags, string? nome, uint nivel, IntPtr buffer, uint tamanho, out uint necessario, out uint quantidade);
}
