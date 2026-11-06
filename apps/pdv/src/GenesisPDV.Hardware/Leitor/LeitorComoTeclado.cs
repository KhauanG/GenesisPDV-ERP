using System.Text;

namespace GenesisPDV.Hardware.Leitor;

public enum OrigemEntrada
{
    Teclado,
    Leitor,
}

public sealed record LeituraCodigo(string Codigo, OrigemEntrada Origem);

/// <summary>Leitor de código de barras (PDV 6.4): modo teclado (USB HID com sufixo Enter) ou serial.</summary>
public interface ILeitorCodigoBarras
{
    event EventHandler<LeituraCodigo>? CodigoLido;
}

/// <summary>
/// Leitor em modo teclado: recebe as teclas que chegam ao campo de código e distingue a rajada do leitor (caracteres
/// em intervalos curtos, terminada pelo sufixo) da digitação humana. A distinção serve para ignorar leituras durante
/// diálogos de confirmação (PDV 32.8) e para registrar a origem da entrada.
/// </summary>
public sealed class LeitorComoTeclado(TimeSpan? intervaloMaximo = null, int tamanhoMinimo = 4) : ILeitorCodigoBarras
{
    private readonly StringBuilder _buffer = new();
    private readonly TimeSpan _intervaloMaximo = intervaloMaximo ?? TimeSpan.FromMilliseconds(50);
    private DateTimeOffset? _ultimaTecla;
    private bool _rajada = true;

    public event EventHandler<LeituraCodigo>? CodigoLido;

    public void Caractere(char c, DateTimeOffset instante)
    {
        if (_ultimaTecla is { } anterior && instante - anterior > _intervaloMaximo)
        {
            _rajada = false;
        }

        _buffer.Append(c);
        _ultimaTecla = instante;
    }

    /// <summary>Sufixo (Enter) recebido: emite a leitura e limpa o buffer.</summary>
    public LeituraCodigo? Sufixo(DateTimeOffset instante)
    {
        if (_buffer.Length == 0)
        {
            Reiniciar();
            return null;
        }

        var leitor = _rajada && _buffer.Length >= tamanhoMinimo
                     && _ultimaTecla is { } ultima && instante - ultima <= _intervaloMaximo;
        var leitura = new LeituraCodigo(_buffer.ToString(), leitor ? OrigemEntrada.Leitor : OrigemEntrada.Teclado);
        Reiniciar();
        CodigoLido?.Invoke(this, leitura);
        return leitura;
    }

    public void Reiniciar()
    {
        _buffer.Clear();
        _ultimaTecla = null;
        _rajada = true;
    }
}

/// <summary>Leitor simulado para desenvolvimento: "bipa" um código como se viesse do aparelho.</summary>
public sealed class LeitorSimulado : ILeitorCodigoBarras
{
    public event EventHandler<LeituraCodigo>? CodigoLido;

    public void Bipar(string codigo) => CodigoLido?.Invoke(this, new LeituraCodigo(codigo, OrigemEntrada.Leitor));
}
