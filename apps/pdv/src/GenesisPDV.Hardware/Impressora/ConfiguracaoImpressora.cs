using System.Globalization;
using GenesisPDV.Hardware.Gaveta;

namespace GenesisPDV.Hardware.Impressora;

/// <summary>Como o PDV chega à impressora (<c>impressora.conexao</c>).</summary>
public enum TipoConexao
{
    /// <summary>Sem impressora: o PDV vende e avisa discretamente (o trabalho fica na fila como cancelado).</summary>
    Nenhuma,

    /// <summary>A impressora instalada no Windows (driver do fabricante), com envio RAW pelo spooler. Padrão da loja.</summary>
    Spooler,

    /// <summary>Rede TCP (porta 9100).</summary>
    Rede,

    /// <summary>Serial (COMx, também a COM virtual do USB; <c>/dev/ttyUSBx</c> no Linux).</summary>
    Serial,

    /// <summary>Arquivo de dispositivo do Linux (<c>/dev/usb/lp0</c>).</summary>
    Dispositivo,

    /// <summary>Arquivos na pasta <c>impressao</c> (desenvolvimento e testes).</summary>
    Simulada,
}

public enum LarguraPapel
{
    Mm80,
    Mm58,
}

public enum Guilhotina
{
    Parcial,
    Total,
    SemCorte,
}

/// <summary>
/// Configuração local da impressora (PDV 6.2; <c>configuracao_terminal</c>, chaves <c>impressora.*</c>). Nulo em
/// <see cref="Pagina"/> e <see cref="QrNativo"/> = o do perfil do modelo.
/// </summary>
public sealed record ConfiguracaoImpressora
{
    public const int PortaRedePadrao = 9100;
    public const int BaudPadrao = 115200;
    public const int LinhasAvancoPadrao = 4;
    public const string DispositivoPadrao = "/dev/usb/lp0";

    public static readonly int[] BaudsValidos = [9600, 19200, 38400, 57600, 115200];

    public ModeloImpressora Modelo { get; init; } = ModeloImpressora.GenericaEscPos;

    public TipoConexao Conexao { get; init; } = TipoConexao.Nenhuma;

    /// <summary>Nome da impressora no Windows (Spooler).</summary>
    public string? NomeSpooler { get; init; }

    /// <summary>IP ou nome da impressora de rede.</summary>
    public string? Endereco { get; init; }

    public int PortaRede { get; init; } = PortaRedePadrao;

    /// <summary>COMx ou <c>/dev/ttyUSBx</c> (Serial); o caminho do dispositivo (Dispositivo).</summary>
    public string? Porta { get; init; }

    public int Baud { get; init; } = BaudPadrao;

    public LarguraPapel Papel { get; init; } = LarguraPapel.Mm80;

    public Guilhotina Guilhotina { get; init; } = Guilhotina.Parcial;

    /// <summary>Linhas de avanço antes do corte (0–10): o papel impresso passa da lâmina.</summary>
    public int LinhasAvanco { get; init; } = LinhasAvancoPadrao;

    public PaginaCodigo? Pagina { get; init; }

    public bool? QrNativo { get; init; }

    public PerfilImpressora Perfil => PerfilImpressora.De(Modelo);

    /// <summary>
    /// As do modelo no papel (<see cref="PerfilImpressora.Colunas(LarguraPapel)"/>): 48 no 80 mm e 32 no 58 mm, menos na
    /// TM-T88 (180 dpi), que tem 42 e 30.
    /// </summary>
    public int Colunas => Perfil.Colunas(Papel);

    /// <summary>
    /// Largura máxima do QR em imagem, em pontos: cabe na menor largura de impressão de cada papel (512 pontos da TM-T88
    /// no 80 mm, 360 no 58 mm).
    /// </summary>
    public int LarguraQrPontos => Papel == LarguraPapel.Mm58 ? 300 : 360;

    /// <summary>Módulo do QR nativo, em pontos.</summary>
    public int ModuloQrNativo => Papel == LarguraPapel.Mm58 ? 4 : 6;

    /// <summary>A página escolhida, se o modelo a tem; senão a do perfil.</summary>
    public PaginaCodigo PaginaEfetiva => Pagina is { } p && Perfil.Suporta(p) ? p : Perfil.PaginaPadrao;

    /// <summary>QR nativo só no modelo que o tem; "nativo" escolhido num modelo sem ele sai como imagem.</summary>
    public bool QrNativoEfetivo => Perfil.QrNativo && (QrNativo ?? true);

    public bool Configurada => Conexao != TipoConexao.Nenhuma;

    /// <summary>O primeiro problema da configuração (para a tela), ou nulo.</summary>
    public string? Validar()
    {
        if (LinhasAvanco is < 0 or > 10)
        {
            return "Linhas de avanço antes do corte: de 0 a 10.";
        }

        if (Pagina is { } p && !Perfil.Suporta(p))
        {
            return $"A {Perfil.Nome} não tem a página {p.ToString().ToUpperInvariant()}: use CP860 ou CP850.";
        }

        return Conexao switch
        {
            TipoConexao.Spooler when string.IsNullOrWhiteSpace(NomeSpooler) => "Escolha a impressora instalada no Windows.",
            TipoConexao.Rede when string.IsNullOrWhiteSpace(Endereco) => "Informe o IP da impressora de rede.",
            TipoConexao.Rede when PortaRede is < 1 or > 65535 => "Porta de rede inválida (a padrão é 9100).",
            TipoConexao.Serial when string.IsNullOrWhiteSpace(Porta) => "Informe a porta serial (ex.: COM3).",
            TipoConexao.Serial when !BaudsValidos.Contains(Baud) =>
                $"Velocidade da serial: {string.Join(", ", BaudsValidos.Select(b => b.ToString(CultureInfo.InvariantCulture)))}.",
            // O caminho é texto livre: só um dispositivo de impressora em /dev, e só no Linux (nunca um arquivo comum).
            TipoConexao.Dispositivo when !OperatingSystem.IsLinux() => TransporteDispositivo.MensagemSoLinux,
            TipoConexao.Dispositivo => TransporteDispositivo.Validar(Porta),
            _ => null,
        };
    }

    /// <summary>Texto curto da conexão para a tela e a página de teste.</summary>
    public string DescricaoConexao => Conexao switch
    {
        TipoConexao.Spooler => $"Windows: {NomeSpooler}",
        TipoConexao.Rede => string.Create(CultureInfo.InvariantCulture, $"Rede: {Endereco}:{PortaRede}"),
        TipoConexao.Serial => string.Create(CultureInfo.InvariantCulture, $"Serial: {Porta} {Baud}"),
        TipoConexao.Dispositivo => $"Dispositivo: {Porta}",
        TipoConexao.Simulada => "Simulada (arquivos)",
        _ => "Nenhuma",
    };
}

/// <summary>Impressora e gaveta do terminal, como gravadas em <c>configuracao_terminal</c>.</summary>
public sealed record ConfiguracaoHardware(ConfiguracaoImpressora Impressora, ConfiguracaoGaveta Gaveta);
