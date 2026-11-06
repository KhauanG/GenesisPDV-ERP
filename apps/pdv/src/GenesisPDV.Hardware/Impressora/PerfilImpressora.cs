namespace GenesisPDV.Hardware.Impressora;

/// <summary>Modelos com perfil próprio (PDV 6.2; dono, I4: as lojas terão Epson ou Bematech).</summary>
public enum ModeloImpressora
{
    GenericaEscPos,
    EpsonTmT20,
    EpsonTmT88,
    BematechMp4200Th,
}

/// <summary>Página de código dos acentos (<c>impressora.codepage</c>).</summary>
public enum PaginaCodigo
{
    Cp860,
    Cp850,
    Wpc1252,
}

/// <summary>
/// O que muda de um modelo para outro (PDV 6.2, "define a tabela de comandos"; implantação I4, decisão 63 do README):
/// o número do <c>ESC t n</c> de cada página de código, a página padrão, se há QR nativo e as colunas de cada papel. Corte
/// (<c>GS V 0/1</c> depois de <c>ESC d n</c>) e gaveta (<c>ESC p m t1 t2</c>) são os mesmos nos três: a Bematech segue a
/// Epson no modo ESC/POS.
/// </summary>
/// <param name="Tabelas">Páginas que o modelo tem, com o <c>n</c> do <c>ESC t n</c>.</param>
/// <param name="QrNativo">O <c>GS ( k</c> com <c>cn = 49</c> (QR); sem ele, o QR sai como imagem.</param>
/// <param name="Colunas80">
/// Caracteres por linha na fonte A (12 × 24, a do <c>ESC @</c>) no papel de 80 mm: a largura de impressão em pontos ÷ 12.
/// </param>
/// <param name="Colunas58">O mesmo no papel de 58 mm (o que cabe, arredondado para uma largura que os layouts conhecem).</param>
public sealed record PerfilImpressora(
    ModeloImpressora Modelo,
    string Nome,
    IReadOnlyDictionary<PaginaCodigo, byte> Tabelas,
    PaginaCodigo PaginaPadrao,
    bool QrNativo,
    int Colunas80 = 48,
    int Colunas58 = 32)
{
    /// <summary>
    /// Epson TM-T20 (II/III/X) e TM-T88 (V/VI): ESC t 3 = PC860, 2 = PC850, 16 = WPC1252; QR nativo. Padrão PC860 (o
    /// critério 6.9 da spec, "acentos corretos em CP860 numa Epson TM-T20").
    /// </summary>
    private static readonly Dictionary<PaginaCodigo, byte> TabelasEpson = new()
    {
        [PaginaCodigo.Cp860] = 3,
        [PaginaCodigo.Cp850] = 2,
        [PaginaCodigo.Wpc1252] = 16,
    };

    /// <summary>
    /// Bematech MP-4200 TH em modo ESC/POS (manual de programação rev. 1.0, cap. 4): ESC t 3 = PC860 e 2 = PC850 (a
    /// numeração da Epson; não tem WPC1252); o <c>GS ( k</c> só tem PDF417, então o QR sai como imagem. No modo
    /// ESC/Bema a numeração é outra (4 = PC860): a impressora precisa estar no modo ESC/POS.
    /// </summary>
    private static readonly Dictionary<PaginaCodigo, byte> TabelasBematech = new()
    {
        [PaginaCodigo.Cp860] = 3,
        [PaginaCodigo.Cp850] = 2,
    };

    /// <summary>
    /// Colunas na fonte A (fichas técnicas da Epson e da Bematech): a TM-T20 (203 dpi) e a MP-4200 TH imprimem 576 pontos
    /// no 80 mm = 48 colunas, e no 58 mm cabem 35 (TM-T20) — os layouts usam 32, a largura das bobinas estreitas comuns
    /// (384 pontos, a da Genérica). A TM-T88 V/VI é de 180 dpi: 512 pontos no 80 mm = **42** colunas e 360 no 58 mm =
    /// **30** (ficha da Epson: "80 mm: 42/48/56, 58 mm: 30/36/40"; os números maiores são de outras fontes, que o PDV não usa).
    /// </summary>
    public static IReadOnlyList<PerfilImpressora> Todos { get; } =
    [
        new(ModeloImpressora.GenericaEscPos, "Genérica ESC/POS", TabelasBematech, PaginaCodigo.Cp860, QrNativo: false),
        new(ModeloImpressora.EpsonTmT20, "Epson TM-T20 (II/III/X)", TabelasEpson, PaginaCodigo.Cp860, QrNativo: true),
        new(ModeloImpressora.EpsonTmT88, "Epson TM-T88 (V/VI)", TabelasEpson, PaginaCodigo.Cp860, QrNativo: true, Colunas80: 42, Colunas58: 30),
        new(ModeloImpressora.BematechMp4200Th, "Bematech MP-4200 TH (modo ESC/POS)", TabelasBematech, PaginaCodigo.Cp860, QrNativo: false),
    ];

    public static PerfilImpressora De(ModeloImpressora modelo) => Todos.First(p => p.Modelo == modelo);

    /// <summary>Caracteres por linha do modelo no papel (fonte A).</summary>
    public int Colunas(LarguraPapel papel) => papel == LarguraPapel.Mm58 ? Colunas58 : Colunas80;

    public bool Suporta(PaginaCodigo pagina) => Tabelas.ContainsKey(pagina);

    /// <summary>O <c>n</c> do <c>ESC t n</c>; a página que o modelo não tem cai na padrão.</summary>
    public byte ComandoTabela(PaginaCodigo pagina) => Tabelas.TryGetValue(pagina, out var n) ? n : Tabelas[PaginaPadrao];

    public static int PaginaDotNet(PaginaCodigo pagina) => pagina switch
    {
        PaginaCodigo.Cp850 => 850,
        PaginaCodigo.Wpc1252 => 1252,
        _ => 860,
    };
}
