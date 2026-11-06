namespace GenesisPDV.Hardware.Impressora;

/// <summary>
/// "Imprimir teste" da configuração do terminal (PDV 6.2; implantação I4): o modelo e a conexão, os acentos na página
/// escolhida, a régua das colunas (48 ou 32, conforme o papel), o alinhamento à direita, um QR de exemplo (nativo ou
/// imagem) e o corte. Acento trocado por outro sinal = página de código errada (README › Configurar a impressora).
/// </summary>
public static class LayoutTesteImpressao
{
    public const string Titulo = "TESTE DE IMPRESSÃO";
    public const string Acentos = "ÁÉÍÓÚ ÇÃÕ âêô";
    public const string AcentosMinusculos = "áéíóú çãõ àü";
    public const string ConteudoQr = "GenesisPDV - teste de impressão";

    public static byte[] Gerar(ConfiguracaoImpressora c, string nomeLoja, string quando)
    {
        ArgumentNullException.ThrowIfNull(c);
        var p = new ConstrutorEscPos(c.Colunas);
        p.Centro(nomeLoja.ToUpperInvariant(), negrito: true);
        p.Centro(Titulo, negrito: true);
        p.Centro(quando);
        p.Separador();
        p.Linha($"Modelo: {c.Perfil.Nome}");
        p.Linha($"Conexão: {c.DescricaoConexao}");
        p.Linha($"Papel: {(c.Papel == LarguraPapel.Mm58 ? "58 mm" : "80 mm")}, {c.Colunas} colunas");
        p.Linha($"Página de código: {c.PaginaEfetiva.ToString().ToUpperInvariant()}");
        p.Linha($"Corte: {c.Guilhotina switch { Guilhotina.Total => "total", Guilhotina.SemCorte => "sem corte", _ => "parcial" }}, {c.LinhasAvanco} linha(s) de avanço");
        p.Linha($"QR Code: {(c.QrNativoEfetivo ? "nativo" : "imagem")}");
        p.Separador();
        p.Linha($"Acentos: {Acentos}");
        p.Linha($"         {AcentosMinusculos}");
        p.Linha(Regua(c.Colunas));
        p.Colunado("Esquerda", "Direita");
        p.Colunado("TOTAL R$", "1.234,56");
        p.Separador('=');
        p.QrCode(ConteudoQr);
        p.Centro("Régua numa linha só e acentos certos: a impressora está pronta.");
        p.Cortar();
        return p.ParaBytes();
    }

    /// <summary>"1234567890" repetido até a largura: a última coluna é o último caractere da linha.</summary>
    public static string Regua(int colunas) =>
        string.Concat(Enumerable.Range(1, colunas).Select(i => (char)('0' + (i % 10))));
}
