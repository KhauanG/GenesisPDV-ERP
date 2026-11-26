using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace GenesisPDV.Core.Vales;

/// <summary>Por que um código lido não vale (a tela mostra uma mensagem só; o motivo vai para o log).</summary>
public enum MotivoCodigoInvalido
{
    Formato,
    DigitoVerificador,
    Loja,
    Numero,
}

/// <summary>Resultado da leitura de um código: o código normalizado e as partes, ou o motivo da recusa.</summary>
public sealed record CodigoLido(bool Valido, MotivoCodigoInvalido? Motivo, string? Codigo, int Loja, int Caixa, long Numero)
{
    public static CodigoLido Recusado(MotivoCodigoInvalido motivo) => new(false, motivo, null, 0, 0, 0);
}

/// <summary>
/// Códigos do vale (<c>VC…</c>) e do cupom de troca (<c>CT…</c>), F3-B5; SYNC 13.4, MD 3.13.2, PDV 23.2. A mesma regra de
/// <c>packages/shared/src/vales.ts</c>, conferida pelos mesmos vetores (<c>vale.codigo.vetores.json</c>).
/// <list type="bullet">
/// <item>Vale: <c>VC</c> + loja 2 + caixa 2 + sequencial 7 (<c>sequencias_locais['vale']</c>) + DV Luhn sobre os 11
/// dígitos (<c>ck_vales_codigo ^VC[0-9]{12}$</c>). O ERP usa o caixa <c>00</c>.</item>
/// <item>Cupom de troca: <c>CT</c> + loja 2 + caixa 2 + número da venda 12 + DV Luhn sobre os 16 dígitos.</item>
/// </list>
/// O DV é conferido antes dos limites: um dígito trocado sempre aparece como erro de digitação.
/// </summary>
public static partial class CodigoVale
{
    public const int LojaMinimo = 1;
    public const int LojaMaximo = 99;
    public const int CaixaMaximo = 99;

    /// <summary>Caixa dos vales e das vendas do ERP (o caixa do sistema).</summary>
    public const int CaixaErp = 0;

    /// <summary><c>VALE_NUMERO_MAXIMO</c> do shared: os 7 dígitos do sequencial.</summary>
    public const int ValeNumeroMaximo = 9_999_999;

    /// <summary><c>NUMERO_VENDA_MAXIMO</c> do shared (SYNC 13.1): 12 dígitos.</summary>
    public const long NumeroVendaMaximo = 999_999_999_999;

    /// <summary>
    /// As pontas que a leitura tira: só espaço, tab, CR e LF. A lista é explícita porque o <c>Trim()</c> do .NET e o
    /// <c>trim()</c> do JS não tiram os mesmos caracteres (o .NET tira o NEL U+0085 e mantém o BOM U+FEFF; o JS faz o
    /// contrário); o shared usa a mesma lista.
    /// </summary>
    private static readonly char[] PontasLeitura = [' ', '\t', '\r', '\n'];

    // Os padrões terminam em \z, não em $: no .NET o $ também casa antes de um \n final, e no JS (sem a flag m) não.
    [GeneratedRegex(@"^VC[0-9]{12}\z", RegexOptions.CultureInvariant)]
    private static partial Regex PadraoVale();

    [GeneratedRegex(@"^CT[0-9]{17}\z", RegexOptions.CultureInvariant)]
    private static partial Regex PadraoCupomTroca();

    /// <summary>O código tem o formato do vale (sem conferir o DV); usado antes de montar o texto do resumo.</summary>
    public static bool FormatoVale(string codigo) => PadraoVale().IsMatch(codigo);

    /// <summary>Dígito verificador de Luhn (mod 10): dobra a partir do último dígito, como no cartão.</summary>
    public static int DigitoLuhn(string digitos)
    {
        ArgumentNullException.ThrowIfNull(digitos);
        if (digitos.Length == 0 || !digitos.All(char.IsAsciiDigit))
        {
            throw new ArgumentException("Luhn: só dígitos.", nameof(digitos));
        }

        var soma = 0;
        var dobra = true;
        for (var i = digitos.Length - 1; i >= 0; i--, dobra = !dobra)
        {
            var d = digitos[i] - '0';
            if (dobra)
            {
                d *= 2;
                if (d > 9)
                {
                    d -= 9;
                }
            }

            soma += d;
        }

        return (10 - (soma % 10)) % 10;
    }

    /// <summary>Monta o código do vale; fora dos limites é erro de programação.</summary>
    public static string MontarVale(int loja, int caixa, int sequencial)
    {
        Limites(loja, caixa);
        ArgumentOutOfRangeException.ThrowIfLessThan(sequencial, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(sequencial, ValeNumeroMaximo);
        var corpo = string.Create(CultureInfo.InvariantCulture, $"{loja:00}{caixa:00}{sequencial:0000000}");
        return string.Create(CultureInfo.InvariantCulture, $"VC{corpo}{DigitoLuhn(corpo)}");
    }

    /// <summary>Monta o cupom de troca da venda (a do ERP usa o caixa <c>00</c>).</summary>
    public static string MontarCupomTroca(int loja, int caixa, long numeroVenda)
    {
        Limites(loja, caixa);
        ArgumentOutOfRangeException.ThrowIfLessThan(numeroVenda, 1L);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(numeroVenda, NumeroVendaMaximo);
        var corpo = string.Create(CultureInfo.InvariantCulture, $"{loja:00}{caixa:00}{numeroVenda:000000000000}");
        return string.Create(CultureInfo.InvariantCulture, $"CT{corpo}{DigitoLuhn(corpo)}");
    }

    /// <summary>
    /// Lê um código de vale (do leitor ou digitado): sem espaço, tab, CR e LF nas pontas, prefixo em qualquer caixa de
    /// letra.
    /// </summary>
    public static CodigoLido ConferirVale(string? lido) => Conferir(lido, PadraoVale(), 11);

    /// <summary>Lê um cupom de troca, com a mesma normalização e a mesma ordem de conferência do vale.</summary>
    public static CodigoLido ConferirCupomTroca(string? lido) => Conferir(lido, PadraoCupomTroca(), 16);

    private static CodigoLido Conferir(string? lido, Regex padrao, int digitosCorpo)
    {
        var codigo = NormalizarLido(lido);
        if (!padrao.IsMatch(codigo))
        {
            return CodigoLido.Recusado(MotivoCodigoInvalido.Formato);
        }

        var corpo = codigo.Substring(2, digitosCorpo);
        if (DigitoLuhn(corpo) != codigo[2 + digitosCorpo] - '0')
        {
            return CodigoLido.Recusado(MotivoCodigoInvalido.DigitoVerificador);
        }

        var loja = int.Parse(corpo.AsSpan(0, 2), CultureInfo.InvariantCulture);
        var caixa = int.Parse(corpo.AsSpan(2, 2), CultureInfo.InvariantCulture);
        var numero = long.Parse(corpo.AsSpan(4), CultureInfo.InvariantCulture);
        if (loja < LojaMinimo)
        {
            return CodigoLido.Recusado(MotivoCodigoInvalido.Loja);
        }

        return numero < 1
            ? CodigoLido.Recusado(MotivoCodigoInvalido.Numero)
            : new CodigoLido(true, null, codigo, loja, caixa, numero);
    }

    /// <summary>Tira as <see cref="PontasLeitura"/> e passa a maiúsculas só as letras ASCII, como o shared.</summary>
    private static string NormalizarLido(string? lido)
    {
        var aparado = (lido ?? string.Empty).Trim(PontasLeitura);
        return string.Create(aparado.Length, aparado, static (destino, origem) =>
        {
            for (var i = 0; i < origem.Length; i++)
            {
                destino[i] = char.IsAsciiLetterLower(origem[i]) ? (char)(origem[i] - ('a' - 'A')) : origem[i];
            }
        });
    }

    private static void Limites(int loja, int caixa)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(loja, LojaMinimo);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(loja, LojaMaximo);
        ArgumentOutOfRangeException.ThrowIfNegative(caixa);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(caixa, CaixaMaximo);
    }
}

/// <summary>
/// Código de conferência do vale (D96, <c>pdv.vale_exige_conferencia</c>): 4 dígitos aleatórios impressos no vale; o caixa
/// e a nuvem guardam só o resumo (<c>vales.conferencia_hash</c>), PBKDF2-HMAC-SHA-256 com sal de 16 bytes sobre
/// <c>&lt;código do vale&gt;:&lt;4 dígitos&gt;</c>, no formato <c>pbkdf2-sha256$&lt;iterações&gt;$&lt;sal&gt;$&lt;resumo&gt;</c>
/// (base64url sem <c>=</c>). A mesma regra de <c>packages/shared/src/vales.ts</c> e os mesmos vetores.
/// </summary>
public static partial class ConferenciaVale
{
    public const int Digitos = 4;
    public const int IteracoesPadrao = 100_000;
    public const int IteracoesMinimo = 10_000;
    public const int IteracoesMaximo = 1_000_000;
    public const int SalBytes = 16;
    private const int ResumoBytes = 32;

    // \z no fim, como em CodigoVale: o $ do .NET aceitaria um \n final que o shared recusa.
    [GeneratedRegex(@"^pbkdf2-sha256\$([1-9][0-9]{4,6})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})\z", RegexOptions.CultureInvariant)]
    private static partial Regex PadraoResumo();

    [GeneratedRegex(@"^[0-9]{4}\z", RegexOptions.CultureInvariant)]
    private static partial Regex PadraoConferencia();

    /// <summary>Os 4 dígitos (com zeros à esquerda) sorteados pelo gerador criptográfico, sem viés.</summary>
    public static string Gerar() =>
        RandomNumberGenerator.GetInt32(0, 10_000).ToString("0000", CultureInfo.InvariantCulture);

    /// <summary>Resumo do código de conferência; o sal é sorteado quando não é passado (os vetores passam o deles).</summary>
    public static string Resumir(string codigoVale, string conferencia, byte[]? sal = null, int iteracoes = IteracoesPadrao)
    {
        ArgumentNullException.ThrowIfNull(codigoVale);
        ArgumentNullException.ThrowIfNull(conferencia);
        if (!CodigoVale.FormatoVale(codigoVale))
        {
            throw new ArgumentException("Código do vale inválido.", nameof(codigoVale));
        }

        if (!PadraoConferencia().IsMatch(conferencia))
        {
            throw new ArgumentException("Código de conferência: 4 dígitos.", nameof(conferencia));
        }

        ArgumentOutOfRangeException.ThrowIfLessThan(iteracoes, IteracoesMinimo);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(iteracoes, IteracoesMaximo);
        sal ??= RandomNumberGenerator.GetBytes(SalBytes);
        if (sal.Length != SalBytes)
        {
            throw new ArgumentException("Sal: 16 bytes.", nameof(sal));
        }

        var resumo = Derivar(codigoVale, conferencia, sal, iteracoes);
        return string.Create(
            CultureInfo.InvariantCulture,
            $"pbkdf2-sha256${iteracoes}${Base64Url(sal)}${Base64Url(resumo)}");
    }

    /// <summary>O resumo tem o formato aceito, com as iterações dentro da faixa.</summary>
    public static bool ResumoValido(string? resumo)
    {
        if (resumo is null)
        {
            return false;
        }

        var m = PadraoResumo().Match(resumo);
        if (!m.Success)
        {
            return false;
        }

        var iteracoes = int.Parse(m.Groups[1].ValueSpan, CultureInfo.InvariantCulture);
        return iteracoes is >= IteracoesMinimo and <= IteracoesMaximo;
    }

    /// <summary>
    /// Confere os 4 dígitos digitados contra o resumo do vale. Entrada inválida dá <c>false</c>, nunca exceção (é dado
    /// digitado ou recebido); a comparação final é em tempo constante.
    /// </summary>
    public static bool Conferir(string? codigoVale, string? conferencia, string? resumo)
    {
        if (codigoVale is null || conferencia is null || !CodigoVale.FormatoVale(codigoVale) ||
            !PadraoConferencia().IsMatch(conferencia) || !ResumoValido(resumo))
        {
            return false;
        }

        var m = PadraoResumo().Match(resumo!);
        var iteracoes = int.Parse(m.Groups[1].ValueSpan, CultureInfo.InvariantCulture);
        var sal = DeBase64Url(m.Groups[2].Value);
        var esperado = DeBase64Url(m.Groups[3].Value);
        var calculado = Derivar(codigoVale, conferencia, sal, iteracoes);
        return CryptographicOperations.FixedTimeEquals(esperado, calculado);
    }

    private static byte[] Derivar(string codigoVale, string conferencia, byte[] sal, int iteracoes) =>
        Rfc2898DeriveBytes.Pbkdf2(
            Encoding.ASCII.GetBytes($"{codigoVale}:{conferencia}"),
            sal,
            iteracoes,
            HashAlgorithmName.SHA256,
            ResumoBytes);

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] DeBase64Url(string texto)
    {
        var b = texto.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(b.PadRight(b.Length + ((4 - (b.Length % 4)) % 4), '='));
    }
}
