using System.Globalization;
using System.Text.Json;
using GenesisPDV.Data.Convencoes;

namespace GenesisPDV.Sync.Pull;

/// <summary>
/// Valor de uma coluna da linha do pull (formato do protocolo, SYNC 2.3: decimal em texto, UUID canônico, data ISO UTC)
/// para o valor gravado no SQLite (MD 4.1), pelo tipo da coluna no <see cref="EsquemaNuvem"/>: decimal → INTEGER
/// escalado na escala da coluna (nunca arredonda: mais casas que a coluna é erro), UUID e datas em TEXT de largura fixa,
/// booleano em 0/1, <c>jsonb</c> e arrays em TEXT JSON. Os formatos são os mesmos dos conversores do EF
/// (<see cref="EscalaDecimal"/>, <see cref="GuidTexto"/>, <see cref="DataHoraUtcTexto"/>…), então o que o pull grava o
/// modelo EF lê.
/// </summary>
public static class ConversorLinha
{
    public static object? Converter(ColunaEsquema coluna, JsonElement valor)
    {
        ArgumentNullException.ThrowIfNull(coluna);
        if (valor.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return null;
        }

        var tipo = coluna.TipoClr;
        if (tipo == typeof(decimal))
        {
            var texto = valor.ValueKind == JsonValueKind.String ? valor.GetString()! : valor.GetRawText();
            var numero = decimal.Parse(texto, NumberStyles.Number | NumberStyles.AllowExponent, CultureInfo.InvariantCulture);
            return EscalaDecimal.ParaInteiro(numero, coluna.Escala ?? 0);
        }

        if (tipo == typeof(Guid))
        {
            return Guid.Parse(valor.GetString()!).ToString("D");
        }

        if (tipo == typeof(DateTimeOffset))
        {
            var data = DateTimeOffset.Parse(valor.GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
            return DataHoraUtcTexto.Formatar(data);
        }

        if (tipo == typeof(DateOnly))
        {
            return DateOnly.ParseExact(valor.GetString()!, "yyyy-MM-dd", CultureInfo.InvariantCulture).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }

        if (tipo == typeof(TimeOnly))
        {
            return TimeOnly.Parse(valor.GetString()!, CultureInfo.InvariantCulture).ToString("HH:mm:ss", CultureInfo.InvariantCulture);
        }

        if (tipo == typeof(bool))
        {
            return valor.GetBoolean() ? 1L : 0L;
        }

        if (tipo == typeof(short) || tipo == typeof(int) || tipo == typeof(long))
        {
            // `bigint` desce como float8 (SYNC 2.3): número JSON inteiro, às vezes com expoente.
            return valor.TryGetInt64(out var inteiro) ? inteiro : checked((long)valor.GetDouble());
        }

        if (tipo == typeof(string[]) || tipo == typeof(short[]))
        {
            return valor.GetRawText();
        }

        if (tipo == typeof(byte[]))
        {
            return Convert.FromBase64String(valor.GetString()!);
        }

        // Texto: `jsonb` guarda o JSON como veio (objeto, número ou string com aspas); os demais, o próprio texto.
        if (coluna.TipoNuvem == "jsonb" || valor.ValueKind != JsonValueKind.String)
        {
            return valor.GetRawText();
        }

        return valor.GetString();
    }

    /// <summary>
    /// Valor neutro para coluna <c>NOT NULL</c> ausente numa linha nova (a API manda a projeção inteira; isto só cobre a
    /// API mais velha que o app, SYNC 17): a próxima versão da linha traz o valor real.
    /// </summary>
    public static object Neutro(ColunaEsquema coluna)
    {
        ArgumentNullException.ThrowIfNull(coluna);
        var tipo = coluna.TipoClr;
        if (tipo == typeof(string))
        {
            return coluna.TipoNuvem == "jsonb" ? "null" : string.Empty;
        }

        if (tipo == typeof(Guid))
        {
            return Guid.Empty.ToString("D");
        }

        if (tipo == typeof(DateTimeOffset))
        {
            return DataHoraUtcTexto.Formatar(DateTimeOffset.UnixEpoch);
        }

        if (tipo == typeof(DateOnly))
        {
            return "0001-01-01";
        }

        if (tipo == typeof(TimeOnly))
        {
            return "00:00:00";
        }

        if (tipo == typeof(string[]) || tipo == typeof(short[]))
        {
            return "[]";
        }

        if (tipo == typeof(byte[]))
        {
            return Array.Empty<byte>();
        }

        return 0L;
    }
}
