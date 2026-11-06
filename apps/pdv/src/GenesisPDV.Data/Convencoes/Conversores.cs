using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace GenesisPDV.Data.Convencoes;

/// <summary>
/// <see cref="decimal"/> ⇄ INTEGER escalado (valor × 10^casas). Lança exceção se o valor tiver mais casas que a coluna:
/// nunca arredonda escondido (modelo de dados 4.1).
/// </summary>
public sealed class EscalaDecimal : ValueConverter<decimal, long>
{
    public EscalaDecimal(int casas)
        : base(v => ParaInteiro(v, casas), v => DeInteiro(v, casas))
    {
        if (casas is < 0 or > 6)
        {
            throw new ArgumentOutOfRangeException(nameof(casas));
        }

        Casas = casas;
    }

    public int Casas { get; }

    public static long ParaInteiro(decimal valor, int casas)
    {
        var fator = Fator(casas);
        var escalado = valor * fator;
        if (decimal.Truncate(escalado) != escalado)
        {
            throw new InvalidOperationException(
                $"Valor {valor.ToString(CultureInfo.InvariantCulture)} tem mais de {casas} casas decimais e não pode ser gravado sem arredondar.");
        }

        return decimal.ToInt64(escalado);
    }

    public static decimal DeInteiro(long valor, int casas)
    {
        // new decimal(lo, mid, hi, negativo, escala) preserva a escala (12,50 volta como 12.50).
        var abs = (ulong)(valor < 0 ? -(decimal)valor : valor);
        return new decimal((int)(abs & 0xFFFFFFFF), (int)(abs >> 32), 0, valor < 0, (byte)casas);
    }

    private static decimal Fator(int casas) => casas switch
    {
        0 => 1m,
        1 => 10m,
        2 => 100m,
        3 => 1_000m,
        4 => 10_000m,
        5 => 100_000m,
        _ => 1_000_000m,
    };
}

/// <summary>UUID em TEXT canônico minúsculo com hífens (36 caracteres).</summary>
public sealed class GuidTexto() : ValueConverter<Guid, string>(v => v.ToString("D"), v => Guid.ParseExact(v, "D"));

/// <summary>
/// <see cref="DateTimeOffset"/> em TEXT ISO-8601 UTC de largura fixa <c>AAAA-MM-DDTHH:MM:SS.fffZ</c>: ordem de texto =
/// ordem cronológica.
/// </summary>
public sealed class DataHoraUtcTexto() : ValueConverter<DateTimeOffset, string>(v => Formatar(v), v => Ler(v))
{
    public const string Formato = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";

    public static string Formatar(DateTimeOffset valor) => valor.ToUniversalTime().ToString(Formato, CultureInfo.InvariantCulture);

    public static DateTimeOffset Ler(string texto) =>
        DateTimeOffset.ParseExact(texto, Formato, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
}

/// <summary><see cref="DateOnly"/> em TEXT <c>AAAA-MM-DD</c>.</summary>
public sealed class DataTexto() : ValueConverter<DateOnly, string>(
    v => v.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
    v => DateOnly.ParseExact(v, "yyyy-MM-dd", CultureInfo.InvariantCulture));

/// <summary>
/// <see cref="TimeOnly"/> (<c>time</c> da nuvem) em TEXT <c>HH:MM:SS</c>: o MD 4.1 não lista <c>time</c>; a largura fixa
/// mantém a ordem de texto = ordem do horário (faixas de <c>restricoes_horario_venda</c>).
/// </summary>
public sealed class HoraTexto() : ValueConverter<TimeOnly, string>(
    v => v.ToString("HH:mm:ss", CultureInfo.InvariantCulture),
    v => TimeOnly.Parse(v, CultureInfo.InvariantCulture));

/// <summary>Array da nuvem (<c>smallint[]</c>) em TEXT JSON (<c>[0,6]</c>), MD 4.1; o CHECK local é <c>json_valid</c>.</summary>
public sealed class ListaCurtaJson() : ValueConverter<short[], string>(
    v => JsonSerializer.Serialize(v, (JsonSerializerOptions?)null),
    v => JsonSerializer.Deserialize<short[]>(v, (JsonSerializerOptions?)null) ?? Array.Empty<short>())
{
    public static readonly ValueComparer<short[]> Comparador = new(
        (a, b) => a == null ? b == null : b != null && a.SequenceEqual(b),
        v => v.Aggregate(0, (h, x) => HashCode.Combine(h, x)),
        v => v.ToArray());
}

/// <summary>Array de texto da nuvem (<c>text[]</c>) em TEXT JSON (<c>["nfce","sat"]</c>), MD 4.1.</summary>
public sealed class ListaTextoJson() : ValueConverter<string[], string>(
    v => JsonSerializer.Serialize(v, (JsonSerializerOptions?)null),
    v => JsonSerializer.Deserialize<string[]>(v, (JsonSerializerOptions?)null) ?? Array.Empty<string>())
{
    public static readonly ValueComparer<string[]> Comparador = new(
        (a, b) => a == null ? b == null : b != null && a.SequenceEqual(b),
        v => v.Aggregate(0, (h, x) => HashCode.Combine(h, x)),
        v => v.ToArray());
}
