using GenesisPDV.Hardware.Impressora;

namespace GenesisPDV.Hardware.Gaveta;

/// <summary>Gaveta de dinheiro (PDV 6.3, 19.4): pela impressora (pulso ESC p), serial ou nenhuma.</summary>
public interface IGaveta
{
    Task AbrirAsync(CancellationToken ct = default);

    /// <summary>Nulo quando a gaveta não tem sensor.</summary>
    Task<bool?> EstaAbertaAsync(CancellationToken ct = default);
}

/// <summary>
/// Configuração local da gaveta (PDV 6.3; chaves <c>gaveta.*</c> de <c>configuracao_terminal</c>). **Desligada por
/// padrão** (dono, I4: as lojas da Ice Beer não têm gaveta na impressora): desligada, nenhum <c>ESC p</c> sai, nunca.
/// Ligada, abre na finalização com forma "Abrir gaveta" e pelo comando manual (F11 › 9); nos movimentos do caixa
/// (abertura, sangria, reforço, fechamento, devolução em dinheiro) só com <see cref="AbreNosMovimentos"/>.
/// </summary>
/// <param name="Pino">2 ou 5 do conector RJ-11.</param>
/// <param name="PulsoMs">Tempo ligado do pulso, 50–500 ms (padrão 120, PDV 6.3).</param>
public sealed record ConfiguracaoGaveta(bool Ligada = false, int Pino = 2, int PulsoMs = 120, bool AbreNosMovimentos = false)
{
    public string? Validar() => (Pino, PulsoMs) switch
    {
        (not (2 or 5), _) => "A gaveta usa o pino 2 ou o 5 do conector.",
        (_, < 50 or > 500) => "Pulso da gaveta: de 50 a 500 ms.",
        _ => null,
    };

    public byte[] Comando() => EscPos.PulsoGaveta(Pino, PulsoMs);
}

/// <summary>
/// Gaveta ligada à impressora (PDV 6.3, modo <c>impressora</c>): manda o <c>ESC p</c> do pino e do pulso pelo mesmo
/// transporte da impressora. Quem decide se abre (ligada, forma, permissão) é o <c>ServicoGaveta</c> do App.
/// </summary>
public sealed class GavetaImpressora(Func<ConfiguracaoGaveta> configuracao, Func<byte[], CancellationToken, Task> enviar) : IGaveta
{
    public async Task AbrirAsync(CancellationToken ct = default)
    {
        var gaveta = configuracao();
        if (!gaveta.Ligada)
        {
            return;
        }

        await enviar(gaveta.Comando(), ct).ConfigureAwait(false);
    }

    public Task<bool?> EstaAbertaAsync(CancellationToken ct = default) => Task.FromResult<bool?>(null);
}

public sealed class GavetaSimulada : IGaveta
{
    public int Aberturas { get; private set; }

    public bool Aberta { get; set; }

    public bool Falhar { get; set; }

    public event EventHandler? Abriu;

    public Task AbrirAsync(CancellationToken ct = default)
    {
        if (Falhar)
        {
            throw new InvalidOperationException("Gaveta não respondeu.");
        }

        Aberturas++;
        Aberta = true;
        Abriu?.Invoke(this, EventArgs.Empty);
        return Task.CompletedTask;
    }

    public Task<bool?> EstaAbertaAsync(CancellationToken ct = default) => Task.FromResult<bool?>(Aberta);
}
