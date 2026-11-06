using System.Collections.Concurrent;
using System.Text;

namespace GenesisPDV.Hardware.Impressora;

/// <summary>Comandos ESC/POS usados pelo PDV.</summary>
public static class EscPos
{
    public const byte Esc = 0x1B;
    public const byte Gs = 0x1D;
    public const byte Lf = 0x0A;

    /// <summary>
    /// Página de código 860 (português), selecionada com ESC t 3 nas Epson e na Bematech MP-4200 TH em modo ESC/POS: é a
    /// do documento gravado na <c>fila_impressao</c> (o "canônico"); o <see cref="AdaptadorEscPos"/> converte para a
    /// página do perfil na hora de imprimir.
    /// </summary>
    public const int PaginaCodigo = 860;
    public const byte TabelaPc860 = 3;

    private static readonly ConcurrentDictionary<int, Encoding> Codificacoes = new();

    public static Encoding Texto => Codificacao(PaginaCodigo);

    /// <summary>Codificação da página do Windows/IBM (860, 850, 1252…) com "?" no caractere que ela não tem.</summary>
    public static Encoding Codificacao(int pagina) => Codificacoes.GetOrAdd(pagina, p =>
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        return Encoding.GetEncoding(p, EncoderFallback.ReplacementFallback, DecoderFallback.ReplacementFallback);
    });

    /// <summary>
    /// Página do <c>ESC t n</c> na numeração da Epson, que a MP-4200 TH em modo ESC/POS segue (manual de programação da
    /// Bematech, rev. 1.0, capítulo 4): 0 PC437, 2 PC850, 3 PC860, 16 WPC1252 (só Epson), 19 PC858. Nulo = desconhecida.
    /// </summary>
    public static int? PaginaDaTabela(byte n) => n switch
    {
        0 => 437,
        2 => 850,
        3 => 860,
        16 => 1252,
        19 => 858,
        _ => null,
    };

    /// <summary>
    /// Pulso da gaveta (<c>ESC p m t1 t2</c>, igual na Epson e na Bematech em modo ESC/POS): <c>m</c> 0 = pino 2 e 1 =
    /// pino 5 do conector RJ-11; ligado <c>t1 × 2 ms</c> e desligado <c>t2 × 2 ms</c> (500 ms, nunca menor que o ligado).
    /// </summary>
    public static byte[] PulsoGaveta(int pino, int pulsoMs)
    {
        if (pino is not (2 or 5))
        {
            throw new ArgumentOutOfRangeException(nameof(pino), "A gaveta usa o pino 2 ou o 5 do conector.");
        }

        var ligado = (byte)Math.Clamp(pulsoMs / 2, 1, 250);
        return [Esc, (byte)'p', pino == 2 ? (byte)0 : (byte)1, ligado, 250];
    }
}

public enum Alinhamento : byte
{
    Esquerda = 0,
    Centro = 1,
    Direita = 2,
}

/// <summary>
/// Monta documentos ESC/POS em linhas de largura fixa (48/42/32/30 colunas). Colunas à esquerda/direita são alinhadas
/// com espaços, o que funciona igual em qualquer modelo; o centro usa ESC a. O texto longo quebra na palavra (o valor de
/// uma coluna nunca é partido no meio). O resultado é o documento "canônico" (PC860, corte e QR genéricos), gravado
/// na <c>fila_impressao</c>; o <see cref="AdaptadorEscPos"/> o traduz para o modelo configurado. Todo caractere de
/// controle do texto (nome de produto ou de cliente vindo do ERP, observação digitada) vira espaço: só o construtor
/// emite comandos, e um <c>DLE DC4</c> ou <c>GS ( k</c> escondido numa descrição abriria a gaveta ou engoliria o cupom.
/// </summary>
public sealed class ConstrutorEscPos
{
    /// <summary>Tamanho do módulo do QR no documento canônico; o adaptador usa o do papel.</summary>
    public const int ModuloQrPadrao = 6;

    private readonly List<byte> _bytes = [];
    private bool _duplo;

    public ConstrutorEscPos(int colunas = 48)
    {
        if (colunas is not (48 or 42 or 32 or 30))
        {
            throw new ArgumentOutOfRangeException(nameof(colunas), "Colunas suportadas: 48, 42, 32 ou 30.");
        }

        Colunas = colunas;
        _bytes.AddRange([EscPos.Esc, (byte)'@', EscPos.Esc, (byte)'t', EscPos.TabelaPc860]);
    }

    public int Colunas { get; }

    public ConstrutorEscPos Alinhar(Alinhamento alinhamento)
    {
        _bytes.AddRange([EscPos.Esc, (byte)'a', (byte)alinhamento]);
        return this;
    }

    public ConstrutorEscPos Negrito(bool ligado)
    {
        _bytes.AddRange([EscPos.Esc, (byte)'E', ligado ? (byte)1 : (byte)0]);
        return this;
    }

    /// <summary>Altura e largura duplas (GS ! 0x11). Na largura dupla cabem metade das colunas.</summary>
    public ConstrutorEscPos Duplo(bool ligado)
    {
        _duplo = ligado;
        _bytes.AddRange([EscPos.Gs, (byte)'!', ligado ? (byte)0x11 : (byte)0x00]);
        return this;
    }

    /// <summary>Uma linha; maior que a bobina, quebra na palavra (a impressora partiria no meio dela).</summary>
    public ConstrutorEscPos Linha(string texto = "")
    {
        foreach (var parte in Quebrar(SemControle(texto), _duplo ? Colunas / 2 : Colunas))
        {
            _bytes.AddRange(EscPos.Texto.GetBytes(parte));
            _bytes.Add(EscPos.Lf);
        }

        return this;
    }

    public ConstrutorEscPos Centro(string texto, bool negrito = false)
    {
        Alinhar(Alinhamento.Centro);
        if (negrito)
        {
            Negrito(true);
        }

        Linha(texto);
        if (negrito)
        {
            Negrito(false);
        }

        return Alinhar(Alinhamento.Esquerda);
    }

    /// <summary>Texto à esquerda e valor encostado à direita na mesma linha (quebra o texto se não couber).</summary>
    public ConstrutorEscPos Colunado(string esquerda, string direita)
    {
        esquerda = SemControle(esquerda);
        direita = SemControle(direita);
        var espaco = Colunas - direita.Length - 1;
        if (esquerda.Length > espaco)
        {
            var partes = Quebrar(esquerda, Colunas).ToList();
            foreach (var parte in partes.SkipLast(1))
            {
                Linha(parte);
            }

            esquerda = partes[^1];
            if (esquerda.Length > espaco)
            {
                Linha(esquerda);
                esquerda = string.Empty;
            }
        }

        return Linha(esquerda.PadRight(Math.Max(0, Colunas - direita.Length)) + direita);
    }

    public ConstrutorEscPos Separador(char caractere = '-') => Linha(new string(caractere, Colunas));

    public ConstrutorEscPos Avancar(int linhas)
    {
        _bytes.AddRange([EscPos.Esc, (byte)'d', (byte)Math.Clamp(linhas, 0, 255)]);
        return this;
    }

    /// <summary>
    /// Fim do documento: corte parcial com avanço (GS V 66 n). O adaptador troca pelo avanço e pela guilhotina do
    /// terminal (parcial, total ou sem corte).
    /// </summary>
    public ConstrutorEscPos Cortar()
    {
        _bytes.AddRange([EscPos.Gs, (byte)'V', 66, 3]);
        return this;
    }

    /// <summary>
    /// Pulso na gaveta (ESC p 0 25 250), só para a impressora simulada e os testes: o adaptador o tira de todo documento
    /// (a gaveta abre pelo <c>ServicoGaveta</c>, só ligada, decisão 63 do README).
    /// </summary>
    public ConstrutorEscPos PulsoGaveta()
    {
        _bytes.AddRange([EscPos.Esc, (byte)'p', 0, 25, 250]);
        return this;
    }

    /// <summary>
    /// QR Code centralizado (modelo 2, correção M, os apps de banco leem o PIX assim) pelo comando nativo <c>GS ( k</c>:
    /// o adaptador mantém o nativo nos modelos que o têm ou troca por imagem (<c>GS v 0</c>).
    /// </summary>
    public ConstrutorEscPos QrCode(string dados)
    {
        ArgumentException.ThrowIfNullOrEmpty(dados);
        Alinhar(Alinhamento.Centro);
        _bytes.AddRange(QrCodeEscPos.Nativo(Encoding.UTF8.GetBytes(dados), ModuloQrPadrao));
        _bytes.Add(EscPos.Lf);
        return Alinhar(Alinhamento.Esquerda);
    }

    public byte[] ParaBytes() => [.. _bytes];

    /// <summary>O texto com cada caractere de controle (U+0000–U+001F, U+007F–U+009F) trocado por espaço.</summary>
    public static string SemControle(string? texto)
    {
        if (string.IsNullOrEmpty(texto) || !texto.Any(char.IsControl))
        {
            return texto ?? string.Empty;
        }

        return string.Create(texto.Length, texto, (destino, origem) =>
        {
            for (var i = 0; i < origem.Length; i++)
            {
                destino[i] = char.IsControl(origem[i]) ? ' ' : origem[i];
            }
        });
    }

    /// <summary>Partes de até <paramref name="largura"/> caracteres, quebradas no último espaço (palavra maior, no meio).</summary>
    public static IEnumerable<string> Quebrar(string texto, int largura)
    {
        if (string.IsNullOrEmpty(texto))
        {
            yield return string.Empty;
            yield break;
        }

        var resto = texto;
        while (resto.Length > largura)
        {
            var corte = resto.LastIndexOf(' ', largura);
            if (corte <= 0 || string.IsNullOrWhiteSpace(resto[..corte]))
            {
                yield return resto[..largura];
                resto = resto[largura..];
                continue;
            }

            yield return resto[..corte].TrimEnd();
            resto = resto[(corte + 1)..];
        }

        yield return resto;
    }
}
