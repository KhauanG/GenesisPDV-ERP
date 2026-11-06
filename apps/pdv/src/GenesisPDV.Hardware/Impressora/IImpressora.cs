namespace GenesisPDV.Hardware.Impressora;

public enum SituacaoImpressora
{
    Pronta,
    SemPapel,
    Offline,
}

/// <summary>Impressora térmica ESC/POS (PDV 6.2, 19). O conteúdo já chega renderizado em bytes ESC/POS.</summary>
public interface IImpressora
{
    int Colunas { get; }

    /// <summary>Falso = o terminal não tem impressora (PDV 6.2; I4): o PDV vende e avisa discretamente.</summary>
    bool Configurada => true;

    Task<SituacaoImpressora> ObterSituacaoAsync(CancellationToken ct = default);

    /// <exception cref="FalhaImpressoraException">Impressora sem papel, offline ou com erro de comunicação.</exception>
    Task ImprimirAsync(byte[] escPos, CancellationToken ct = default);
}

public sealed class FalhaImpressoraException(string mensagem, Exception? interna = null) : Exception(mensagem, interna);

/// <summary>
/// Impressora real (implantação I4): o documento canônico passa pelo <see cref="AdaptadorEscPos"/> (página de código,
/// corte e QR do modelo; sem gaveta) e sai pelo transporte da conexão. A situação (DLE EOT) não é lida (pelo spooler a
/// porta não volta para o PDV; o <see cref="TransporteSpoolerWindows"/> lê a do Windows), e a falha de envio já vira
/// <see cref="FalhaImpressoraException"/>. Todo envio tem um tempo limite (<see cref="Transportes.TempoEnvio"/>): o
/// transporte preso numa chamada bloqueante (o <c>write()</c> do <c>usblp</c> sem papel, o spooler de um servidor que
/// caiu) vira falha e a venda segue, mesmo que a thread dele continue presa.
/// </summary>
/// <param name="tempoLimite">Nulo = o da conexão e do tamanho do documento (os testes encurtam).</param>
public sealed class ImpressoraEscPos(ConfiguracaoImpressora configuracao, ITransporteImpressora transporte, TimeSpan? tempoLimite = null) : IImpressora
{
    public ConfiguracaoImpressora Configuracao { get; } = configuracao;

    public int Colunas => Configuracao.Colunas;

    public Task<SituacaoImpressora> ObterSituacaoAsync(CancellationToken ct = default) => Task.FromResult(SituacaoImpressora.Pronta);

    public Task ImprimirAsync(byte[] escPos, CancellationToken ct = default) =>
        EnviarBrutoAsync(AdaptadorEscPos.Adaptar(escPos, Configuracao), ct);

    /// <summary>Bytes como estão (o pulso da gaveta), pelo mesmo transporte.</summary>
    public async Task EnviarBrutoAsync(byte[] bytes, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        var limite = tempoLimite ?? Transportes.TempoEnvio(Configuracao, bytes.Length);
        Task envio;
        try
        {
            envio = transporte.EnviarAsync(bytes, ct);
        }
        catch (Exception e) when (e is not (FalhaImpressoraException or OperationCanceledException))
        {
            throw new FalhaImpressoraException($"Falha ao imprimir ({e.Message}).", e);
        }

        try
        {
            await envio.WaitAsync(limite, ct).ConfigureAwait(false);
        }
        catch (TimeoutException) when (!envio.IsCompleted)
        {
            // O envio preso termina (ou falha) sozinho depois: a falha dele é observada aqui e não vai a lugar nenhum.
            _ = envio.ContinueWith(t => t.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
            throw new FalhaImpressoraException($"A impressora ({Configuracao.DescricaoConexao}) não respondeu em {limite.TotalSeconds:0} s.");
        }
        catch (Exception e) when (e is not (FalhaImpressoraException or OperationCanceledException))
        {
            // Nada de fora do transporte derruba a venda: vira falha de impressão (fila, reimpressão).
            throw new FalhaImpressoraException($"Falha ao imprimir ({e.Message}).", e);
        }
    }
}
