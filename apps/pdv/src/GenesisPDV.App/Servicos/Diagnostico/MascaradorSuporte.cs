using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using GenesisPDV.Sync.Ativacao;

namespace GenesisPDV.App.Servicos.Diagnostico;

/// <summary>
/// Mascarador único do que sai do caixa para os olhos de alguém (Central do PDV, bloco G2; plano 5.4; README › decisão
/// 67): o visor de logs e ocorrências, o pacote de suporte e o antes/depois da auditoria passam por aqui. Mascara <b>por
/// contexto</b>, nunca "toda sequência de dígitos", para não comer o <c>payload_sha256</c>, o GTIN-14, o número da venda
/// nem os ids:
/// <list type="bullet">
/// <item><c>Bearer …</c>, o cabeçalho <c>Authorization:</c> (o esquema e a credencial; o resto da linha fica) e o valor de
/// <c>token</c>, <c>chave</c>, <c>senha</c>, <c>pin</c>, <c>secret</c> e dos outros nomes sensíveis em <c>nome=valor</c> e
/// <c>nome: valor</c> (valor solto ou entre aspas);</item>
/// <item>o valor dos campos JSON com nome sensível (texto, número, lista ou objeto inteiros; <c>null</c>, <c>true</c> e
/// <c>false</c> ficam: não são segredo e são as regras da loja que o suporte lê), também no JSON escapado dentro de outro
/// (<c>\"token\":\"…\"</c>) e no JSON dentro de um CSV (<c>""token"":""…""</c>; nesses dois, texto e número);</item>
/// <item>nome sensível: <c>token</c>, <c>chave</c>, <c>senha</c>, <c>pin</c>, <c>secret</c>, <c>segredo</c>,
/// <c>privada</c>, <c>authorization</c>, <c>cpf</c>, <c>cpf_cnpj</c>, <c>br_code</c>, <c>payload_pix</c>,
/// <c>documento</c>, <c>email</c>, <c>telefone</c> e <c>celular</c>, sozinhos ou com prefixo/sufixo ligado por <c>_</c>,
/// <c>.</c> ou em camelCase (<c>access_token</c>, <c>backup.chave</c>, <c>senhaPdvHash</c>, <c>accessToken</c>); o
/// <c>gaveta.pino</c> e o <c>tipo_pinpad</c> não. O nome terminado em <c>_em</c> é data (<c>token_expira_em</c>) e fica.
/// O campo JSON <c>chave</c> sozinho também fica: no PDV é a coluna com o <b>nome</b> da configuração
/// (<c>{"chave":"impressora.modelo","valor":…}</c>), não um segredo;</item>
/// <item>CPF e CNPJ <b>com pontuação</b> (<c>000.000.000-00</c>, <c>00.000.000/0000-00</c>);</item>
/// <item>BR Code do PIX (começa com <c>000201</c> e tem <c>br.gov.bcb.pix</c>), lido campo a campo até o CRC (campo
/// <c>63</c>); fora do formato, até o fim da linha;</item>
/// <item>hash argon2 (<c>$argon2id$…</c>, o do PIN) e bloco PEM de chave privada;</item>
/// <item>a pasta do perfil do usuário do sistema (<c>C:\Users\fulano</c>, <c>/home/fulano</c>; no Windows também o
/// caminho exato do perfil, com espaço no nome ou fora de <c>C:\Users</c>) vira <c>%USERPROFILE%</c>, e a conta do
/// Windows (<c>DOMÍNIO\usuário</c>, a do <see cref="ContaSistema"/>) vira <c>%USERDOMAIN%\%USERNAME%</c>.</item>
/// </list>
/// Aplicado na exibição e na exportação, <b>não</b> no gravador do Serilog (nenhum log grava token, PIN ou CPF hoje; o
/// mascarador é a segunda barreira, conferida pelos testes com segredos plantados).
/// </summary>
public static partial class MascaradorSuporte
{
    public const string Mascara = "***";
    public const string MascaraBrCode = "[BR Code]";
    public const string MascaraHash = "[hash]";
    public const string MascaraChavePrivada = "[chave privada]";
    public const string PerfilUsuario = "%USERPROFILE%";
    public const string ContaUsuario = @"%USERDOMAIN%\%USERNAME%";

    /// <summary>A conta do sistema que ativou o caixa (<c>ativacao.conta</c>), escondida no pacote de suporte.</summary>
    public const string ContaAtivacao = "%CONTA_ATIVACAO%";

    private const string Pix = "br.gov.bcb.pix";

    /// <summary>Acentos como texto, como o <c>Ocorrencias.Nova</c> grava (o JSON fica na tela e no pacote, nunca numa página).</summary>
    private static readonly JsonSerializerOptions JsonDetalhes = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>O perfil e a conta desta máquina (só no Windows; no Linux a regra de <c>/home</c> basta).</summary>
    private static readonly Lazy<(string? Perfil, string? Conta)> Maquina = new(() => OperatingSystem.IsWindows()
        ? (Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ContaSistema.Atual())
        : (null, null));

    /// <summary>O texto mascarado (nulo continua nulo). Idempotente: mascarar duas vezes dá o mesmo texto.</summary>
    public static string? Mascarar(string? texto) => Mascarar(texto, Maquina.Value.Perfil, Maquina.Value.Conta);

    /// <summary>O mesmo, com o perfil e a conta dados (os testes simulam o Windows em qualquer sistema).</summary>
    internal static string? Mascarar(string? texto, string? perfil, string? conta)
    {
        if (string.IsNullOrEmpty(texto))
        {
            return texto;
        }

        // A ordem importa: os blocos inteiros (PEM, BR Code, hash) antes dos campos, para o campo não cortar um BR Code
        // pela metade e deixar o resto à vista; o cabeçalho antes do "nome: valor" (que não mexe no já mascarado).
        var s = ChavePrivadaPem().Replace(texto, MascaraChavePrivada);
        s = MascararBrCode(s);
        s = HashArgon2().Replace(s, MascaraHash);
        s = Portador().Replace(s, m => m.Groups["prefixo"].Value + Mascara);
        s = CabecalhoAutorizacao().Replace(s, m => m.Groups["prefixo"].Value + Mascara);
        s = CampoJson().Replace(s, m => m.Groups["prefixo"].Value + "\"" + Mascara + "\"");
        s = CampoJsonEscapado().Replace(s, m => m.Groups["prefixo"].Value + "\\\"" + Mascara + "\\\"");
        s = CampoJsonCsv().Replace(s, m => m.Groups["prefixo"].Value + "\"\"" + Mascara + "\"\"");
        s = ChaveIgualValor().Replace(s, ValorMascarado);
        s = NomeDoisPontosValor().Replace(s, ValorMascarado);
        s = Cnpj().Replace(s, "**.***.***/****-**");
        s = Cpf().Replace(s, "***.***.***-**");
        s = PastaDoUsuario(s, perfil, conta);
        return s;
    }

    /// <summary>
    /// O <c>detalhes</c> do <c>log_local</c> (o JSON do <c>Ocorrencias.Nova</c>, bloco G8) mascarado <b>valor a valor</b>: cada
    /// texto, já decodificado (a quebra de linha do <c>texto</c> técnico volta a ser quebra e a aspa volta a ser aspa),
    /// passa pelo <see cref="Mascarar(string?)"/>, e o campo com nome sensível vira <c>"***"</c> inteiro (texto, número,
    /// lista ou objeto; <c>null</c>, <c>true</c> e <c>false</c> ficam, como no <c>CampoJson</c>). Mascarar o JSON como texto
    /// não basta: depois do <c>\n</c> escapado vem a letra <c>n</c> (o <c>senha=</c>, o <c>token:</c> e o <c>Bearer</c>
    /// exigem que o nome não venha grudado numa letra) e a aspa escapada <c>\"</c> não fecha o valor — o segredo ficava à
    /// vista, e a busca o achava. O JSON volta montado (o detalhe da tela o abre de novo); fora do JSON (as linhas de antes
    /// do G8, com o texto solto, ou um JSON quebrado), o texto inteiro pelo <see cref="Mascarar(string?)"/>. Idempotente.
    /// </summary>
    public static string? MascararDetalhes(string? detalhes)
    {
        if (string.IsNullOrWhiteSpace(detalhes) || detalhes.TrimStart() is not ['{' or '[', ..])
        {
            return Mascarar(detalhes);
        }

        JsonNode? raiz;
        try
        {
            raiz = JsonNode.Parse(detalhes);
        }
        catch (JsonException)
        {
            return Mascarar(detalhes);
        }

        try
        {
            return MascararNo(raiz)?.ToJsonString(JsonDetalhes) ?? Mascarar(detalhes);
        }
        catch (Exception e) when (e is InvalidOperationException or ArgumentException)
        {
            // Nome repetido no objeto (o JsonObject recusa ao ler): o texto inteiro.
            return Mascarar(detalhes);
        }
    }

    /// <summary>
    /// Esconde a conta do sistema que ativou o caixa (<c>ativacao.conta</c>, uma chave interna; a tela de "ativado com
    /// outra conta" a mostra) como <see cref="ContaAtivacao"/>: o pacote de suporte (Central do PDV, bloco G9; README ›
    /// decisão 76) não leva o nome de quem usa o computador, como já não leva o da conta atual. Com a barra
    /// (<c>DOMÍNIO\usuário</c>, o Windows), em qualquer lugar do texto, também escapada no JSON; sem ela (o Linux, um nome
    /// curto que pode aparecer em outras palavras), só entre aspas, como a mensagem a mostra.
    /// </summary>
    public static string OcultarConta(string texto, string? conta)
    {
        ArgumentNullException.ThrowIfNull(texto);
        if (string.IsNullOrWhiteSpace(conta) || conta.Length < 3 || texto.Length == 0)
        {
            return texto;
        }

        if (conta.Contains('\\', StringComparison.Ordinal))
        {
            texto = texto.Replace(conta.Replace("\\", "\\\\", StringComparison.Ordinal), ContaAtivacao, StringComparison.OrdinalIgnoreCase);
            return texto.Replace(conta, ContaAtivacao, StringComparison.OrdinalIgnoreCase);
        }

        texto = texto.Replace($"\\\"{conta}\\\"", $"\\\"{ContaAtivacao}\\\"", StringComparison.Ordinal);
        texto = texto.Replace($"\"\"{conta}\"\"", $"\"\"{ContaAtivacao}\"\"", StringComparison.Ordinal);
        return texto.Replace($"\"{conta}\"", $"\"{ContaAtivacao}\"", StringComparison.Ordinal);
    }

    /// <summary>Os textos de um <c>detalhes</c> já mascarado, decodificados (a busca da aba 5 confere neles).</summary>
    public static IEnumerable<string> TextosDoJson(string? detalhes)
    {
        if (string.IsNullOrWhiteSpace(detalhes) || detalhes.TrimStart() is not ['{' or '[', ..])
        {
            return [];
        }

        try
        {
            var textos = new List<string>();
            Juntar(JsonNode.Parse(detalhes), textos);
            return textos;
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or ArgumentException)
        {
            return [];
        }

        static void Juntar(JsonNode? no, List<string> textos)
        {
            switch (no)
            {
                case JsonObject objeto:
                    foreach (var (_, valor) in objeto)
                    {
                        Juntar(valor, textos);
                    }

                    break;
                case JsonArray lista:
                    foreach (var item in lista)
                    {
                        Juntar(item, textos);
                    }

                    break;
                case JsonValue valor when valor.TryGetValue<string>(out var texto):
                    textos.Add(texto);
                    break;
            }
        }
    }

    private static JsonNode? MascararNo(JsonNode? no)
    {
        switch (no)
        {
            case JsonObject objeto:
                var saida = new JsonObject();
                foreach (var (chave, valor) in objeto)
                {
                    saida[chave] = CampoSensivel(chave) && valor is not null && !Literal(valor)
                        ? JsonValue.Create(Mascara)
                        : MascararNo(valor);
                }

                return saida;
            case JsonArray lista:
                var itens = new JsonArray();
                foreach (var item in lista)
                {
                    itens.Add(MascararNo(item));
                }

                return itens;
            case JsonValue valor when valor.TryGetValue<string>(out var texto):
                return JsonValue.Create(Mascarar(texto));
            default:
                return no?.DeepClone();
        }
    }

    /// <summary><c>true</c>, <c>false</c> (o <c>null</c> chega aqui como nulo): não são segredo, ficam.</summary>
    private static bool Literal(JsonNode valor) => valor.GetValueKind() is JsonValueKind.True or JsonValueKind.False;

    /// <summary>O nome sensível do <c>CampoJson</c>, para o campo inteiro (o <c>chave</c> sozinho fica: é o nome da configuração).</summary>
    private static bool CampoSensivel(string chave) => !string.Equals(chave, "chave", StringComparison.OrdinalIgnoreCase) && NomeCampoSensivel().IsMatch(chave);

    /// <summary>Mantém as aspas do valor (<c>senha="***"</c>) para o texto continuar legível e a regra idempotente.</summary>
    private static string ValorMascarado(Match m)
    {
        var valor = m.Groups["valor"].Value;
        var aspa = valor[0] is '"' or '\'' ? valor[0].ToString() : string.Empty;
        return m.Groups["prefixo"].Value + aspa + Mascara + aspa;
    }

    private static string PastaDoUsuario(string s, string? perfil, string? conta)
    {
        // O caminho exato primeiro: pega o nome com espaço no fim do texto (C:\Users\João Silva) e o perfil fora de
        // C:\Users (outro disco, pasta redirecionada), que a regra geral não distingue do texto que vem depois.
        if (perfil is { Length: > 3 })
        {
            s = s.Replace(perfil.Replace("\\", "\\\\", StringComparison.Ordinal), PerfilUsuario, StringComparison.OrdinalIgnoreCase);
            s = s.Replace(perfil, PerfilUsuario, StringComparison.OrdinalIgnoreCase);
        }

        if (conta is { Length: > 2 } && conta.Contains('\\', StringComparison.Ordinal))
        {
            s = s.Replace(conta.Replace("\\", "\\\\", StringComparison.Ordinal), ContaUsuario.Replace("\\", "\\\\", StringComparison.Ordinal),
                StringComparison.OrdinalIgnoreCase);
            s = s.Replace(conta, ContaUsuario, StringComparison.OrdinalIgnoreCase);
        }

        s = PerfilWindows().Replace(s, PerfilUsuario);
        return PerfilLinux().Replace(s, PerfilUsuario);
    }

    /// <summary>Cada BR Code do texto vira <see cref="MascaraBrCode"/>, do <c>000201</c> ao fim do CRC.</summary>
    private static string MascararBrCode(string s)
    {
        var i = s.IndexOf("000201", StringComparison.Ordinal);
        if (i < 0)
        {
            return s;
        }

        var saida = new StringBuilder(s.Length);
        var copiado = 0;
        while (i >= 0)
        {
            var fim = FimBrCode(s, i);
            if (fim < 0)
            {
                i = s.IndexOf("000201", i + 1, StringComparison.Ordinal);
                continue;
            }

            saida.Append(s, copiado, i - copiado).Append(MascaraBrCode);
            copiado = fim;
            i = s.IndexOf("000201", fim, StringComparison.Ordinal);
        }

        return saida.Append(s, copiado, s.Length - copiado).ToString();
    }

    /// <summary>
    /// Fim do BR Code que começa em <paramref name="inicio"/>, lido como EMV (id de 2 dígitos, tamanho de 2 dígitos e o
    /// valor) até o campo 63 (o CRC, sempre o último): o número da venda ou um hash depois dele ficam. Fora do formato
    /// (cortado, tamanho que não bate), até o fim da linha ou da aspa. -1 quando não é PIX.
    /// </summary>
    private static int FimBrCode(string s, int inicio)
    {
        var p = inicio;
        while (p + 4 <= s.Length && char.IsAsciiDigit(s[p]) && char.IsAsciiDigit(s[p + 1]) && char.IsAsciiDigit(s[p + 2]) && char.IsAsciiDigit(s[p + 3]))
        {
            var tamanho = ((s[p + 2] - '0') * 10) + (s[p + 3] - '0');
            if (p + 4 + tamanho > s.Length || s.AsSpan(p + 4, tamanho).IndexOfAny("\r\n\"") >= 0)
            {
                break;
            }

            var crc = s[p] == '6' && s[p + 1] == '3';
            p += 4 + tamanho;
            if (crc)
            {
                return s.AsSpan(inicio, p - inicio).Contains(Pix, StringComparison.OrdinalIgnoreCase) ? p : -1;
            }
        }

        var resto = s.AsSpan(inicio);
        var quebra = resto.IndexOfAny("\r\n\"");
        var trecho = quebra < 0 ? resto : resto[..quebra];
        return trecho.Contains(Pix, StringComparison.OrdinalIgnoreCase) ? inicio + trecho.Length : -1;
    }

    /// <summary>
    /// Nome sensível: a palavra sozinha ou com prefixo/sufixo ligados por <c>_</c>, <c>.</c> ou em camelCase
    /// (<c>access_token</c>, <c>backup.chave</c>, <c>senha_pdv_hash</c>, <c>accessToken</c>); <c>gaveta.pino</c>,
    /// <c>tipo_pinpad</c> e <c>tokens_total</c> não casam, e o nome que termina em <c>_em</c> (uma data) também não.
    /// </summary>
    private const string NomeSensivel =
        @"(?:[a-z0-9]+[_.]|(?-i:[A-Za-z][a-z0-9]*(?=[A-Z])))*"
        + @"(?:token|chave|senha|pin|secret|segredo|privada|authorization|cpf|cpf_cnpj|br_code|payload_pix|documento|email|telefone|celular)"
        + @"(?:[_.][a-z0-9]+|(?-i:[A-Z][a-z0-9]*))*(?<![_.]em)(?<!(?-i:[a-z0-9]Em))";

    /// <summary>Valor solto de <c>nome=valor</c> e <c>nome: valor</c>: entre aspas ou até o separador; nunca booleano.</summary>
    private const string ValorSolto =
        @"(?!['""]?\*\*\*)(?!(?:true|false)(?![\w.-]))(?<valor>""[^""\r\n]*""|'[^'\r\n]*'|[^\s&;,""'<>]+)";

    /// <summary>Texto JSON (com escapes), número, objeto ou lista (equilibrados, com as chaves dentro de textos ignoradas).</summary>
    private const string ValorJson =
        @"(?:""(?:[^""\\]|\\.)*""|-?\d[\d.eE+-]*"
        + @"|\{(?>[^{}""]+|""(?:[^""\\]|\\.)*""|(?<o>\{)|(?<-o>\}))*(?(o)(?!))\}"
        + @"|\[(?>[^\[\]""]+|""(?:[^""\\]|\\.)*""|(?<l>\[)|(?<-l>\]))*(?(l)(?!))\])";

    [GeneratedRegex(@"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)", RegexOptions.Singleline | RegexOptions.CultureInvariant)]
    private static partial Regex ChavePrivadaPem();

    [GeneratedRegex(@"\$argon2(?:id|i|d)\$[^\s""']+", RegexOptions.CultureInvariant)]
    private static partial Regex HashArgon2();

    [GeneratedRegex(@"(?<prefixo>\bBearer\s+)[^\s""',;]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Portador();

    /// <summary>
    /// O esquema e a credencial do cabeçalho (<c>Authorization: Basic …, status 401</c> vira <c>Authorization: ***, status
    /// 401</c>); o <c>Bearer ***</c> já mascarado fica. Esquema desconhecido: a palavra e a seguinte, se parecer credencial.
    /// </summary>
    [GeneratedRegex(
        @"(?<prefixo>\bAuthorization\s*:\s*)(?!\*\*\*|Bearer\s+\*\*\*)"
        + @"(?:(?:Basic|Bearer|Digest|Negotiate|NTLM|Token|ApiKey|Signature)\s+[^\s,;""']+|[A-Za-z][\w-]*\s+[^\s,;""']{16,}|[^\s,;""']+)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CabecalhoAutorizacao();

    [GeneratedRegex("^(?:" + NomeSensivel + ")$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex NomeCampoSensivel();

    [GeneratedRegex(@"(?<prefixo>""(?!chave"")" + NomeSensivel + @"""\s*:\s*)" + ValorJson, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CampoJson();

    /// <summary>JSON guardado como texto dentro de outro JSON (a coluna <c>depois</c> exportada, por exemplo).</summary>
    [GeneratedRegex(
        @"(?<prefixo>\\""(?!chave\\"")" + NomeSensivel + @"\\""\s*:\s*)(?:\\""(?:(?!\\"")[^\r\n])*\\""|-?\d[\d.eE+-]*)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CampoJsonEscapado();

    /// <summary>JSON numa célula de CSV, com as aspas dobradas.</summary>
    [GeneratedRegex(
        @"(?<prefixo>""""(?!chave"""")" + NomeSensivel + @"""""\s*:\s*)(?:""""(?:(?!"""")[^\r\n])*""""|-?\d[\d.eE+-]*)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CampoJsonCsv();

    [GeneratedRegex(@"(?<prefixo>(?<![A-Za-z0-9_.])" + NomeSensivel + @"\s*=\s*)" + ValorSolto, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ChaveIgualValor();

    /// <summary>
    /// <c>Token: abc</c> e <c>senha:abc</c> fora do JSON (o nome entre aspas é do JSON, acima). <c>Chave: …</c> sozinha
    /// fica (é o nome de uma configuração nas mensagens), como no JSON.
    /// </summary>
    [GeneratedRegex(
        @"(?<prefixo>(?<![\w.""'\\/])(?!chave\s*:)" + NomeSensivel + @"\s*:[ \t]*)(?!Bearer\s+\*\*\*|//)" + ValorSolto,
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex NomeDoisPontosValor();

    [GeneratedRegex(@"(?<!\d)\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}(?!\d)", RegexOptions.CultureInvariant)]
    private static partial Regex Cnpj();

    [GeneratedRegex(@"(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)", RegexOptions.CultureInvariant)]
    private static partial Regex Cpf();

    /// <summary>
    /// <c>C:\Users\fulano</c> (também escapado no JSON, <c>C:\\Users\\fulano</c>) e <c>C:\Usuários\fulano</c>. Nome com
    /// espaço (<c>C:\Users\Caixa 1\AppData</c>) só quando a pasta continua depois dele (o desta máquina, sempre: o caminho
    /// exato vem antes).
    /// </summary>
    [GeneratedRegex(@"[A-Za-z]:(?<sep>\\{1,2}|/)(?:Users|Usuários|Documents and Settings)\k<sep>(?:[^\\/\r\n""':;*?<>|]+?(?=\k<sep>)|[^\\/\s""':;*?<>|]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PerfilWindows();

    /// <summary><c>/home/fulano</c> como caminho, não no meio de um endereço (<c>https://api.exemplo/home/…</c>).</summary>
    [GeneratedRegex(@"(?<![\w.%-])/home/[^/\s""':;]+", RegexOptions.CultureInvariant)]
    private static partial Regex PerfilLinux();
}
