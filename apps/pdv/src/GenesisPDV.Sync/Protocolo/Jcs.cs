using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace GenesisPDV.Sync.Protocolo;

/// <summary>
/// JSON canônico RFC 8785 (sincronizacao.md 7.1): chaves ordenadas por unidades UTF-16, sem espaços, não ASCII
/// literal, escapes só de <c>"</c>, <c>\</c> e controles (forma curta ou <c>\u00xx</c> minúsculo). Escrito à mão:
/// o <c>System.Text.Json</c> com o codificador padrão escapa acentos e daria hash diferente do recalculado pela API.
/// Números no formato ES6 do RFC 8785 (o mesmo <c>String(n)</c> do TypeScript), conferidos pelos vetores de
/// <c>packages/shared/testes/jcs/vetores.json</c>; um <c>decimal</c> do C# é recusado: dinheiro e quantidade trafegam
/// como string decimal na escala da coluna (2.3).
/// </summary>
public static class Jcs
{
    public static string Serializar(JsonNode? no)
    {
        var sb = new StringBuilder();
        Escrever(sb, no);
        return sb.ToString();
    }

    public static string Sha256Hex(string jcs) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(jcs)));

    private static void Escrever(StringBuilder sb, JsonNode? no)
    {
        switch (no)
        {
            case null:
                sb.Append("null");
                break;
            case JsonObject objeto:
                sb.Append('{');
                var primeiro = true;
                foreach (var (chave, valor) in objeto.OrderBy(p => p.Key, StringComparer.Ordinal))
                {
                    if (!primeiro)
                    {
                        sb.Append(',');
                    }

                    primeiro = false;
                    EscreverTexto(sb, chave);
                    sb.Append(':');
                    Escrever(sb, valor);
                }

                sb.Append('}');
                break;
            case JsonArray lista:
                sb.Append('[');
                for (var i = 0; i < lista.Count; i++)
                {
                    if (i > 0)
                    {
                        sb.Append(',');
                    }

                    Escrever(sb, lista[i]);
                }

                sb.Append(']');
                break;
            case JsonValue valor:
                EscreverValor(sb, valor);
                break;
        }
    }

    private static void EscreverValor(StringBuilder sb, JsonValue valor)
    {
        switch (valor.GetValueKind())
        {
            case JsonValueKind.String:
                EscreverTexto(sb, valor.GetValue<string>());
                break;
            case JsonValueKind.True:
                sb.Append("true");
                break;
            case JsonValueKind.False:
                sb.Append("false");
                break;
            case JsonValueKind.Null:
                sb.Append("null");
                break;
            case JsonValueKind.Number:
                if (valor.TryGetValue<long>(out var inteiro))
                {
                    sb.Append(inteiro.ToString(CultureInfo.InvariantCulture));
                }
                else if (valor.TryGetValue<int>(out var i32))
                {
                    sb.Append(i32.ToString(CultureInfo.InvariantCulture));
                }
                else if (valor.TryGetValue<short>(out var i16))
                {
                    sb.Append(i16.ToString(CultureInfo.InvariantCulture));
                }
                else if (valor.TryGetValue<JsonElement>(out var lido))
                {
                    // Número lido de um JSON (payload recebido, vetores): mesma forma que o JSON.parse do TypeScript veria.
                    sb.Append(NumeroEs6(lido.GetDouble()));
                }
                else if (valor.TryGetValue<double>(out var real))
                {
                    sb.Append(NumeroEs6(real));
                }
                else
                {
                    throw new InvalidOperationException("JCS do PDV não aceita decimal do C#: dinheiro e quantidades vão como string decimal.");
                }

                break;
            default:
                throw new InvalidOperationException($"Tipo JSON não suportado: {valor.GetValueKind()}");
        }
    }

    /// <summary>
    /// <c>Number::toString</c> do ECMAScript (RFC 8785, 3.2.2.3): dígitos mais curtos que voltam ao mesmo double (o
    /// <c>"R"</c> do .NET), notação fixa para expoente decimal entre -6 e 21 e exponencial (<c>1e+21</c>) fora disso.
    /// </summary>
    public static string NumeroEs6(double numero)
    {
        if (!double.IsFinite(numero))
        {
            throw new InvalidOperationException("JCS não aceita NaN nem infinito.");
        }

        if (numero == 0)
        {
            return "0";
        }

        if (numero < 0)
        {
            return "-" + NumeroEs6(-numero);
        }

        var r = numero.ToString("R", CultureInfo.InvariantCulture);
        var expoente = 0;
        var e = r.IndexOfAny(['E', 'e']);
        if (e >= 0)
        {
            expoente = int.Parse(r[(e + 1)..], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
            r = r[..e];
        }

        var ponto = r.IndexOf('.', StringComparison.Ordinal);
        var inteira = ponto >= 0 ? r[..ponto] : r;
        var digitos = inteira + (ponto >= 0 ? r[(ponto + 1)..] : string.Empty);
        // n = posição da vírgula decimal em relação aos dígitos (valor = 0,d1d2… × 10^n).
        var n = inteira.Length + expoente;
        var zeros = 0;
        while (zeros < digitos.Length - 1 && digitos[zeros] == '0')
        {
            zeros++;
        }

        digitos = digitos[zeros..].TrimEnd('0');
        n -= zeros;
        var k = digitos.Length;
        if (k <= n && n <= 21)
        {
            return digitos + new string('0', n - k);
        }

        if (0 < n && n <= 21)
        {
            return digitos[..n] + "." + digitos[n..];
        }

        if (-6 < n && n <= 0)
        {
            return "0." + new string('0', -n) + digitos;
        }

        var sinal = n - 1 >= 0 ? "+" : "-";
        var mantissa = k == 1 ? digitos : digitos[..1] + "." + digitos[1..];
        return mantissa + "e" + sinal + Math.Abs(n - 1).ToString(CultureInfo.InvariantCulture);
    }

    private static void EscreverTexto(StringBuilder sb, string texto)
    {
        sb.Append('"');
        foreach (var c in texto)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20)
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }

                    break;
            }
        }

        sb.Append('"');
    }
}
