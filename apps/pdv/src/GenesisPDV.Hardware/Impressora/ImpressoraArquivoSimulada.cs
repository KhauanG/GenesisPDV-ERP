using System.Globalization;

namespace GenesisPDV.Hardware.Impressora;

/// <summary>
/// Impressora simulada: grava o ESC/POS bruto (<c>.bin</c>) e o texto renderizado (<c>.txt</c>) numa pasta e avisa a
/// tela (<see cref="Impresso"/>). Permite simular falta de papel/offline para testar a fila de impressão.
/// </summary>
public sealed class ImpressoraArquivoSimulada(string pasta, int colunas = 48) : IImpressora
{
    private int _contador;

    /// <summary>Largura do texto renderizado: a do papel configurado (a <c>ImpressoraDoTerminal</c> acerta antes de imprimir).</summary>
    public int Colunas { get; set; } = colunas;

    public SituacaoImpressora SituacaoSimulada { get; set; } = SituacaoImpressora.Pronta;

    public string? UltimoTexto { get; private set; }

    public string? UltimoArquivo { get; private set; }

    public event EventHandler<string>? Impresso;

    public Task<SituacaoImpressora> ObterSituacaoAsync(CancellationToken ct = default) => Task.FromResult(SituacaoSimulada);

    public async Task ImprimirAsync(byte[] escPos, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(escPos);
        if (SituacaoSimulada != SituacaoImpressora.Pronta)
        {
            throw new FalhaImpressoraException(SituacaoSimulada == SituacaoImpressora.SemPapel ? "Impressora sem papel." : "Impressora offline.");
        }

        Directory.CreateDirectory(pasta);
        var nome = $"impressao-{DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff", CultureInfo.InvariantCulture)}-{Interlocked.Increment(ref _contador):000}";
        var texto = RenderizadorEscPos.RenderizarTexto(escPos, Colunas);
        await File.WriteAllBytesAsync(Path.Combine(pasta, nome + ".bin"), escPos, ct).ConfigureAwait(false);
        UltimoArquivo = Path.Combine(pasta, nome + ".txt");
        await File.WriteAllTextAsync(UltimoArquivo, texto, ct).ConfigureAwait(false);
        UltimoTexto = texto;
        Impresso?.Invoke(this, texto);
    }
}
