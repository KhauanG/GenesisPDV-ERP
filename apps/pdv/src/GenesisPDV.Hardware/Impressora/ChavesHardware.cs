using System.Text.Json;
using GenesisPDV.Hardware.Gaveta;

namespace GenesisPDV.Hardware.Impressora;

/// <summary>
/// Chaves de <c>configuracao_terminal</c> da impressora e da gaveta (PDV 6.2, 6.3; modelo 4.4.2), valores em JSON como
/// as demais. Chave ausente ou valor desconhecido = o padrão (nunca derruba a abertura do caixa).
/// </summary>
public static class ChavesHardware
{
    public const string Modelo = "impressora.modelo";
    public const string Conexao = "impressora.conexao";
    public const string NomeSpooler = "impressora.nome_spooler";
    public const string Ip = "impressora.ip";
    public const string PortaRede = "impressora.porta_rede";
    public const string Porta = "impressora.porta";
    public const string Baud = "impressora.baud";
    public const string Colunas = "impressora.colunas";
    public const string Guilhotina = "impressora.guilhotina";
    public const string LinhasAvanco = "impressora.linhas_avanco";
    public const string Codepage = "impressora.codepage";
    public const string QrNativo = "impressora.qrcode_nativo";
    public const string GavetaModo = "gaveta.modo";
    public const string GavetaPino = "gaveta.pino";
    public const string GavetaPulso = "gaveta.tempo_pulso_ms";
    public const string GavetaMovimentos = "gaveta.abre_nos_movimentos";

    public static IReadOnlyList<string> Todas { get; } =
    [
        Modelo, Conexao, NomeSpooler, Ip, PortaRede, Porta, Baud, Colunas, Guilhotina, LinhasAvanco, Codepage, QrNativo,
        GavetaModo, GavetaPino, GavetaPulso, GavetaMovimentos,
    ];

    private static readonly (ModeloImpressora Valor, string Texto)[] Modelos =
    [
        (ModeloImpressora.GenericaEscPos, "generica_escpos"),
        (ModeloImpressora.EpsonTmT20, "epson_tm_t20"),
        (ModeloImpressora.EpsonTmT88, "epson_tm_t88"),
        (ModeloImpressora.BematechMp4200Th, "bematech_mp4200th"),
    ];

    private static readonly (TipoConexao Valor, string Texto)[] Conexoes =
    [
        (TipoConexao.Nenhuma, "nenhuma"),
        (TipoConexao.Spooler, "spooler"),
        (TipoConexao.Rede, "rede"),
        (TipoConexao.Serial, "serial"),
        (TipoConexao.Dispositivo, "dispositivo"),
        (TipoConexao.Simulada, "simulada"),
    ];

    private static readonly (Impressora.Guilhotina Valor, string Texto)[] Cortes =
    [
        (Impressora.Guilhotina.Parcial, "parcial"),
        (Impressora.Guilhotina.Total, "total"),
        (Impressora.Guilhotina.SemCorte, "sem_corte"),
    ];

    private static readonly (PaginaCodigo Valor, string Texto)[] Paginas =
    [
        (PaginaCodigo.Cp860, "cp860"),
        (PaginaCodigo.Cp850, "cp850"),
        (PaginaCodigo.Wpc1252, "wpc1252"),
    ];

    /// <param name="valores">Chave → valor JSON (o <c>configuracao_terminal.valor</c>).</param>
    /// <param name="conexaoPadrao">Sem a chave: <c>nenhuma</c> no build da loja, <c>simulada</c> no de desenvolvimento.</param>
    public static ConfiguracaoHardware Ler(IReadOnlyDictionary<string, string> valores, TipoConexao conexaoPadrao)
    {
        ArgumentNullException.ThrowIfNull(valores);
        string? Texto(string chave) => Valor<string>(valores, chave);
        T Enum<T>((T Valor, string Texto)[] tabela, string chave, T padrao) =>
            Texto(chave) is { } t && tabela.FirstOrDefault(x => x.Texto == t) is { Texto: not null } achado ? achado.Valor : padrao;

        var colunas = Valor<int?>(valores, Colunas);
        var impressora = new ConfiguracaoImpressora
        {
            Modelo = Enum(Modelos, Modelo, ModeloImpressora.GenericaEscPos),
            Conexao = Enum(Conexoes, Conexao, conexaoPadrao),
            NomeSpooler = Texto(NomeSpooler),
            Endereco = Texto(Ip),
            PortaRede = Valor<int?>(valores, PortaRede) ?? ConfiguracaoImpressora.PortaRedePadrao,
            Porta = Texto(Porta),
            Baud = Valor<int?>(valores, Baud) ?? ConfiguracaoImpressora.BaudPadrao,
            // As colunas gravadas são as do modelo no papel (48/32; 42/30 na TM-T88): até 35 é a bobina de 58 mm.
            Papel = colunas is <= 35 ? LarguraPapel.Mm58 : LarguraPapel.Mm80,
            Guilhotina = Enum(Cortes, Guilhotina, Impressora.Guilhotina.Parcial),
            LinhasAvanco = Valor<int?>(valores, LinhasAvanco) ?? ConfiguracaoImpressora.LinhasAvancoPadrao,
            Pagina = Texto(Codepage) is { } pagina && Paginas.Any(p => p.Texto == pagina) ? Paginas.First(p => p.Texto == pagina).Valor : null,
            QrNativo = Valor<bool?>(valores, QrNativo),
        };
        var gaveta = new ConfiguracaoGaveta(
            Ligada: Texto(GavetaModo) == "impressora",
            Pino: Valor<int?>(valores, GavetaPino) ?? 2,
            PulsoMs: Valor<int?>(valores, GavetaPulso) ?? 120,
            AbreNosMovimentos: Valor<bool?>(valores, GavetaMovimentos) ?? false);
        return new ConfiguracaoHardware(impressora, gaveta);
    }

    /// <summary>Todas as chaves, em JSON (a gravação regrava o conjunto inteiro num commit).</summary>
    public static IReadOnlyDictionary<string, string> Escrever(ConfiguracaoHardware c)
    {
        ArgumentNullException.ThrowIfNull(c);
        var i = c.Impressora;
        var g = c.Gaveta;
        return new Dictionary<string, string>
        {
            [Modelo] = Json(Modelos.First(m => m.Valor == i.Modelo).Texto),
            [Conexao] = Json(Conexoes.First(m => m.Valor == i.Conexao).Texto),
            [NomeSpooler] = Json(i.NomeSpooler),
            [Ip] = Json(i.Endereco),
            [PortaRede] = Json(i.PortaRede),
            [Porta] = Json(i.Porta),
            [Baud] = Json(i.Baud),
            [Colunas] = Json(i.Colunas),
            [Guilhotina] = Json(Cortes.First(m => m.Valor == i.Guilhotina).Texto),
            [LinhasAvanco] = Json(i.LinhasAvanco),
            [Codepage] = Json(i.Pagina is { } p ? Paginas.First(m => m.Valor == p).Texto : null),
            [QrNativo] = Json(i.QrNativo),
            [GavetaModo] = Json(g.Ligada ? "impressora" : "nenhuma"),
            [GavetaPino] = Json(g.Pino),
            [GavetaPulso] = Json(g.PulsoMs),
            [GavetaMovimentos] = Json(g.AbreNosMovimentos),
        };
    }

    private static string Json<T>(T valor) => JsonSerializer.Serialize(valor);

    private static T? Valor<T>(IReadOnlyDictionary<string, string> valores, string chave)
    {
        if (!valores.TryGetValue(chave, out var json))
        {
            return default;
        }

        try
        {
            return JsonSerializer.Deserialize<T>(json);
        }
        catch (JsonException)
        {
            return default;
        }
    }
}
