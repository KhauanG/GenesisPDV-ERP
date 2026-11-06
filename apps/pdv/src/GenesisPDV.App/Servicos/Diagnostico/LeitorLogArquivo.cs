using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using GenesisPDV.Data;
using GenesisPDV.Data.Repositorios;

namespace GenesisPDV.App.Servicos.Diagnostico;

/// <summary>Um arquivo de log do Serilog (<c>genesispdv-AAAAMMDD.log</c>; a <see cref="Parte"/> 1 é o <c>_001</c>).</summary>
public sealed record ArquivoLog(string Caminho, DateOnly Dia, int Parte, long Tamanho)
{
    public string Nome => Path.GetFileName(Caminho);
}

/// <summary>Os arquivos de um dia, do mais novo (a maior parte) ao mais antigo.</summary>
public sealed record DiaLog(DateOnly Dia, IReadOnlyList<ArquivoLog> Arquivos)
{
    public long Tamanho => Arquivos.Sum(a => a.Tamanho);
}

/// <summary>Os filtros do arquivo técnico: o nível mínimo (os do <c>log_local</c>: <c>aviso</c>, <c>erro</c>…) e um texto.</summary>
public sealed record FiltroLogArquivo(string? NivelMinimo = null, string? Texto = null);

/// <summary>
/// Onde continuar: a <see cref="ArquivoLog.Parte"/> do arquivo do dia (pela parte, não pela posição na lista: o
/// <c>_001</c> que o Serilog abre quando o do dia passa dos 20 MB entra no começo da lista, e o F5 relê a lista) e a
/// posição do começo do último registro lido.
/// </summary>
public sealed record CursorLog(int Parte, long Posicao);

/// <summary>
/// Um registro do arquivo técnico: a linha com a data e o nível e as seguintes (a exceção), com o texto já
/// <b>mascarado</b> (<see cref="MascaradorSuporte"/>). <see cref="Nivel"/> no vocabulário do <c>log_local</c> (o
/// <c>[WRN]</c> é <c>aviso</c>); a linha solta sem cabeçalho (o começo de um arquivo cortado) vem sem data e como
/// <c>info</c>.
/// </summary>
public sealed record RegistroLog(
    DateTimeOffset? Quando,
    string Nivel,
    string NivelArquivo,
    string? Terminal,
    string? Categoria,
    string Mensagem,
    string Texto,
    int LinhasExtras,
    string Arquivo,
    long Posicao)
{
    /// <summary>Tem as linhas da exceção (ou de uma mensagem de várias linhas).</summary>
    public bool TemDetalhe => LinhasExtras > 0;
}

/// <summary>
/// Uma página do arquivo técnico, do mais novo ao mais antigo. <see cref="Parcial"/>: o leitor parou no
/// <see cref="LeitorLogArquivo.OrcamentoPorPagina"/> sem encher a página (o filtro acha pouco); o PgDn continua de
/// <see cref="Proxima"/>. <see cref="BytesLidos"/> é o que saiu do disco nesta leitura (o teste do arquivo de 20 MB).
/// </summary>
public sealed record PaginaLog(IReadOnlyList<RegistroLog> Registros, CursorLog? Proxima, long BytesLidos, bool Parcial);

/// <summary>
/// O leitor do arquivo de log do Serilog para a aba 5 Logs e ocorrências da Central do PDV (bloco G8; plano 5.5; README
/// › decisão 73). Lê <b>pelo final</b>, em blocos de <see cref="TamanhoBloco"/>, sem carregar o arquivo (até 20 MB,
/// <see cref="ConfiguracaoLog.TamanhoMaximoArquivo"/>) na memória; abre com <see cref="FileShare.ReadWrite"/> (o
/// Serilog continua escrevendo o do dia). A linha que começa com a data (<c>2026-11-05 14:32:01.123 -03:00 [ERR]</c>) abre
/// um registro; as seguintes são dele (a exceção). Aceita os dois formatos da decisão 67: com o código do terminal depois
/// do nível (<c>[INF] cx2-9f3a01bc Categoria …</c>) e sem ele (os arquivos de antes do G2, e as linhas antes da
/// identidade). Um dia pode ter vários arquivos (<c>_001</c>, <c>_002</c> com o limite de tamanho): lidos do mais novo
/// ao mais antigo, como um só. Tudo fora da tela (quem chama usa <c>Task.Run</c>).
/// </summary>
public sealed partial class LeitorLogArquivo(CaminhosPdv caminhos)
{
    public const int TamanhoBloco = 64 * 1024;

    /// <summary>Quanto uma página lê no máximo procurando o filtro (o PgDn continua dali).</summary>
    public const long OrcamentoPorPagina = 8L * 1024 * 1024;

    /// <summary>Linha maior que isso (um laço que grava um texto gigante) é cortada em pedaços.</summary>
    public const int MaximoLinha = 1024 * 1024;

    public const int TamanhoPagina = 50;

    /// <summary>Os dias com arquivo de log, o mais novo primeiro (nunca lança: sem pasta, nenhum).</summary>
    public IReadOnlyList<DiaLog> Dias()
    {
        List<ArquivoLog> arquivos;
        try
        {
            arquivos = [.. Directory.EnumerateFiles(caminhos.PastaLogs, ConfiguracaoLog.PrefixoArquivo + "*.log")
                .Select(Interpretar).OfType<ArquivoLog>()];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return [];
        }

        return [.. arquivos.GroupBy(a => a.Dia).OrderByDescending(g => g.Key)
            .Select(g => new DiaLog(g.Key, [.. g.OrderByDescending(a => a.Parte)]))];
    }

    /// <summary>
    /// Uma página dos registros do dia, do mais novo ao mais antigo, a partir de <paramref name="depois"/> (nulo: do fim
    /// do arquivo mais novo do dia). <paramref name="bloco"/> e <paramref name="orcamento"/> menores só nos testes.
    /// </summary>
    public PaginaLog Ler(
        DiaLog dia,
        FiltroLogArquivo filtro,
        CursorLog? depois = null,
        int tamanho = TamanhoPagina,
        CancellationToken ct = default,
        int bloco = TamanhoBloco,
        long orcamento = OrcamentoPorPagina)
    {
        ArgumentNullException.ThrowIfNull(dia);
        ArgumentNullException.ThrowIfNull(filtro);
        var niveis = filtro.NivelMinimo is { } minimo ? NiveisOcorrencia.APartirDe(minimo).ToHashSet(StringComparer.Ordinal) : null;
        var texto = filtro.Texto?.Trim() is { Length: > 0 } t ? t : null;
        var registros = new List<RegistroLog>();
        long lidos = 0;
        // A parte do cursor na lista de agora (a mais nova primeiro); se ela sumiu (a retenção do Serilog), a seguinte, do fim.
        var indice = depois is { } cursor ? Math.Max(0, IndiceDaParte(dia, cursor.Parte)) : 0;
        long? inicio = depois is { } c && indice < dia.Arquivos.Count && dia.Arquivos[indice].Parte == c.Parte ? c.Posicao : null;
        for (; indice < dia.Arquivos.Count; indice++, inicio = null)
        {
            var arquivo = dia.Arquivos[indice];
            var parada = LerArquivo(arquivo, inicio, niveis, texto, registros, tamanho, ref lidos, orcamento, bloco, ct);
            if (parada is { } posicao)
            {
                // Página cheia ou orçamento gasto: continua do começo do último registro olhado.
                var parcial = registros.Count < tamanho;
                return new PaginaLog(registros, new CursorLog(arquivo.Parte, posicao), lidos, parcial);
            }
        }

        return new PaginaLog(registros, null, lidos, false);
    }

    /// <summary>O primeiro arquivo do dia com a parte <paramref name="parte"/> ou mais antigo (a lista vai da maior parte à menor).</summary>
    private static int IndiceDaParte(DiaLog dia, int parte)
    {
        for (var i = 0; i < dia.Arquivos.Count; i++)
        {
            if (dia.Arquivos[i].Parte <= parte)
            {
                return i;
            }
        }

        return dia.Arquivos.Count;
    }

    /// <summary>
    /// Lê um arquivo de trás para a frente a partir de <paramref name="fim"/> (nulo: o tamanho de agora). Devolve a posição
    /// onde parou (página cheia ou orçamento gasto) ou nulo quando chegou ao começo do arquivo.
    /// </summary>
    private static long? LerArquivo(
        ArquivoLog arquivo,
        long? fim,
        HashSet<string>? niveis,
        string? texto,
        List<RegistroLog> registros,
        int tamanho,
        ref long lidos,
        long orcamento,
        int bloco,
        CancellationToken ct)
    {
        FileStream fluxo;
        try
        {
            fluxo = new FileStream(arquivo.Caminho, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1, FileOptions.RandomAccess);
        }
        catch (FileNotFoundException)
        {
            // Apagado pela retenção do Serilog entre a lista e a leitura: nada a ler nele.
            return null;
        }

        using (fluxo)
        {
            var posicao = Math.Min(fim ?? fluxo.Length, fluxo.Length);
            // O pedaço do começo da região já lida que pertence a uma linha que começa antes (o fim dela, com o \n).
            var resto = Array.Empty<byte>();
            // As linhas de continuação já vistas (de trás para a frente) esperando o cabeçalho delas.
            var pendentes = new List<string>();
            var buffer = new byte[bloco];
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                var inicio = Math.Max(0, posicao - bloco);
                var quantos = (int)(posicao - inicio);
                fluxo.Seek(inicio, SeekOrigin.Begin);
                fluxo.ReadExactly(buffer, 0, quantos);
                lidos += quantos;
                var dados = new byte[quantos + resto.Length];
                Buffer.BlockCopy(buffer, 0, dados, 0, quantos);
                Buffer.BlockCopy(resto, 0, dados, quantos, resto.Length);

                // Sem chegar ao começo do arquivo, o primeiro pedaço (até o primeiro \n) é o fim de uma linha anterior.
                var primeira = 0;
                if (inicio > 0)
                {
                    var nl = Array.IndexOf(dados, (byte)'\n');
                    if (nl < 0 && dados.Length <= MaximoLinha)
                    {
                        resto = dados;
                        posicao = inicio;
                        continue;
                    }

                    // A linha gigante sem \n é cortada aqui (o pedaço vira uma linha de continuação).
                    primeira = nl < 0 ? dados.Length - Math.Min(dados.Length, MaximoLinha) : nl + 1;
                }

                resto = primeira > 0 ? dados[..primeira] : [];
                var linhas = Linhas(dados, primeira);
                for (var i = linhas.Count - 1; i >= 0; i--)
                {
                    var (deslocamento, comprimento) = linhas[i];
                    var linha = Encoding.UTF8.GetString(dados, deslocamento, comprimento).TrimEnd('\r');
                    if (inicio + deslocamento == 0)
                    {
                        // O BOM, se algum editor salvou o arquivo com ele (o Serilog não grava).
                        linha = linha.TrimStart('\uFEFF');
                    }

                    var cabecalho = Cabecalho().Match(linha);
                    if (!cabecalho.Success)
                    {
                        pendentes.Add(linha);
                        continue;
                    }

                    pendentes.Reverse();
                    var registro = Montar(cabecalho, linha, pendentes, arquivo, inicio + deslocamento, niveis, texto);
                    pendentes.Clear();
                    if (registro is not null)
                    {
                        registros.Add(registro);
                    }

                    if (registros.Count >= tamanho || lidos >= orcamento)
                    {
                        return inicio + deslocamento;
                    }
                }

                posicao = inicio;
                if (inicio == 0)
                {
                    // O começo do arquivo: as linhas soltas antes do primeiro cabeçalho viram um registro sem data.
                    if (pendentes.Count > 0 || resto.Length > 0)
                    {
                        pendentes.Reverse();
                        if (MontarSolto(pendentes, arquivo, niveis, texto) is { } solto)
                        {
                            registros.Add(solto);
                        }
                    }

                    return null;
                }
            }
        }
    }

    /// <summary>As linhas completas de <paramref name="dados"/> a partir de <paramref name="primeira"/> (deslocamento, comprimento sem o \n).</summary>
    private static List<(int Deslocamento, int Comprimento)> Linhas(byte[] dados, int primeira)
    {
        var linhas = new List<(int, int)>();
        var comeco = primeira;
        for (var i = primeira; i < dados.Length; i++)
        {
            if (dados[i] == (byte)'\n')
            {
                linhas.Add((comeco, i - comeco));
                comeco = i + 1;
            }
        }

        if (comeco < dados.Length)
        {
            // A última linha sem \n: o Serilog no meio da escrita (o fim do arquivo do dia).
            linhas.Add((comeco, dados.Length - comeco));
        }

        return linhas;
    }

    private static RegistroLog? Montar(
        Match cabecalho, string linha, List<string> extras, ArquivoLog arquivo, long posicao, HashSet<string>? niveis, string? texto)
    {
        var nivelArquivo = cabecalho.Groups["nivel"].Value;
        var nivel = Nivel(nivelArquivo);
        if (niveis is not null && !niveis.Contains(nivel))
        {
            return null;
        }

        var bruto = extras.Count == 0 ? linha : linha + "\n" + string.Join("\n", extras);
        if (texto is not null && !Contem(bruto, texto))
        {
            return null;
        }

        var mascarado = MascaradorSuporte.Mascarar(bruto) ?? string.Empty;
        // O filtro confere também o texto mascarado: procurar um CPF ou um token não "acha" a linha onde ele foi escondido.
        if (texto is not null && !Contem(mascarado, texto))
        {
            return null;
        }

        var quando = DateTimeOffset.TryParseExact(cabecalho.Groups["data"].Value, "yyyy-MM-dd HH:mm:ss.fff zzz", CultureInfo.InvariantCulture,
            DateTimeStyles.None, out var d) ? d : (DateTimeOffset?)null;
        var resto = cabecalho.Groups["resto"].Value;
        var categoria = Categoria().Match(resto) is { Success: true } c ? c.Groups["categoria"].Value : null;
        var mensagem = categoria is null ? resto : resto[(categoria.Length + 1)..];
        return new RegistroLog(
            quando,
            nivel,
            nivelArquivo,
            cabecalho.Groups["terminal"].Success ? cabecalho.Groups["terminal"].Value : null,
            categoria,
            MascaradorSuporte.Mascarar(mensagem) ?? string.Empty,
            mascarado,
            extras.Count,
            arquivo.Nome,
            posicao);
    }

    private static RegistroLog? MontarSolto(List<string> linhas, ArquivoLog arquivo, HashSet<string>? niveis, string? texto)
    {
        var bruto = string.Join("\n", linhas).Trim();
        if (bruto.Length == 0 || (niveis is not null && !niveis.Contains(NiveisOcorrencia.Info)))
        {
            return null;
        }

        var mascarado = MascaradorSuporte.Mascarar(bruto) ?? string.Empty;
        if (texto is not null && (!Contem(bruto, texto) || !Contem(mascarado, texto)))
        {
            return null;
        }

        var primeira = mascarado.Split('\n')[0];
        return new RegistroLog(null, NiveisOcorrencia.Info, string.Empty, null, null, primeira, mascarado, Math.Max(0, linhas.Count - 1), arquivo.Nome, 0);
    }

    /// <summary>Sem diferença de maiúsculas nem de acento ("impressao" acha "Impressão"), como nas ocorrências.</summary>
    private static bool Contem(string onde, string termo) => BuscaSemAcento.Contem(onde, termo);

    /// <summary>
    /// A linha abre um registro (começa com a data e o nível, nos dois formatos da decisão 67); as seguintes, até a próxima
    /// que abre, são dele (a exceção). O pacote de suporte (bloco G9) mascara registro a registro com esta regra.
    /// </summary>
    public static bool AbreRegistro(string linha) => linha.Length > 0 && char.IsAsciiDigit(linha[0]) && Cabecalho().IsMatch(linha);

    /// <summary>O nível do Serilog no vocabulário do <c>log_local</c>.</summary>
    public static string Nivel(string nivelArquivo) => nivelArquivo switch
    {
        "VRB" or "DBG" => NiveisOcorrencia.Debug,
        "WRN" => NiveisOcorrencia.Aviso,
        "ERR" => NiveisOcorrencia.Erro,
        "FTL" => NiveisOcorrencia.Critico,
        _ => NiveisOcorrencia.Info,
    };

    private static ArquivoLog? Interpretar(string caminho)
    {
        var m = NomeArquivo().Match(Path.GetFileName(caminho));
        if (!m.Success || !DateOnly.TryParseExact(m.Groups["dia"].Value, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var dia))
        {
            return null;
        }

        try
        {
            var parte = m.Groups["parte"].Success ? int.Parse(m.Groups["parte"].Value, CultureInfo.InvariantCulture) : 0;
            return new ArquivoLog(caminho, dia, parte, new FileInfo(caminho).Length);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    [GeneratedRegex(@"^genesispdv-(?<dia>\d{8})(?:_(?<parte>\d{3,}))?\.log$", RegexOptions.CultureInvariant)]
    private static partial Regex NomeArquivo();

    /// <summary>O modelo de <see cref="ConfiguracaoLog.Modelo"/>: data, nível, o código do terminal (quando há) e o resto.</summary>
    [GeneratedRegex(@"^(?<data>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2}) \[(?<nivel>[A-Z]{3})\] (?:(?<terminal>cx\d+-[0-9a-f]{8}) )?(?<resto>.*)$", RegexOptions.CultureInvariant)]
    private static partial Regex Cabecalho();

    /// <summary>A categoria do <c>ILogger</c> (<c>GenesisPDV.App.Servicos.ServicoBackup</c>) antes da mensagem.</summary>
    [GeneratedRegex(@"^(?<categoria>[A-Za-z_][\w`]*(?:\.[\w`]+)+) ", RegexOptions.CultureInvariant)]
    private static partial Regex Categoria();
}
