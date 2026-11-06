using System.Text;

namespace GenesisPDV.Hardware.Impressora;

/// <summary>
/// Converte bytes ESC/POS em texto (como sairia no papel), para a impressora simulada em arquivo/tela e para testes.
/// Comandos desconhecidos são ignorados; centro e direita são aplicados na largura de colunas da impressora. Lê também
/// o documento já adaptado (<see cref="AdaptadorEscPos"/>): a página do <c>ESC t</c>, o QR nativo e a imagem.
/// </summary>
public static class RenderizadorEscPos
{
    public const string MarcaCorte = "✂ - - - - - - - - - - - - - - - - - - - - - -";
    public const string MarcaGaveta = "[gaveta aberta]";
    public const string MarcaQrCode = "[QR Code]";
    public const string MarcaImagem = "[imagem]";

    public static IReadOnlyList<string> Renderizar(byte[] dados, int colunas = 48)
    {
        ArgumentNullException.ThrowIfNull(dados);
        var linhas = new List<string>();
        var atual = new List<byte>();
        var alinhamento = Alinhamento.Esquerda;
        var larguraDupla = false;
        var codificacao = EscPos.Texto;

        void FecharLinha()
        {
            var texto = codificacao.GetString([.. atual]).TrimEnd();
            var largura = larguraDupla ? colunas / 2 : colunas;
            texto = alinhamento switch
            {
                Alinhamento.Centro when texto.Length < largura => new string(' ', (largura - texto.Length) / 2) + texto,
                Alinhamento.Direita when texto.Length < largura => texto.PadLeft(largura),
                _ => texto,
            };
            if (larguraDupla)
            {
                // Largura dupla ocupa o dobro no papel: espaça os caracteres para a visualização ficar fiel.
                texto = string.Join(" ", texto.ToCharArray());
            }

            linhas.Add(texto);
            atual.Clear();
        }

        for (var i = 0; i < dados.Length; i++)
        {
            var b = dados[i];
            if (b == EscPos.Lf)
            {
                FecharLinha();
            }
            else if (b == EscPos.Esc && i + 1 < dados.Length)
            {
                var cmd = (char)dados[++i];
                switch (cmd)
                {
                    case '@':
                        alinhamento = Alinhamento.Esquerda;
                        larguraDupla = false;
                        break;
                    case 'a' when i + 1 < dados.Length:
                        alinhamento = (Alinhamento)(dados[++i] % 3);
                        break;
                    case 'd' when i + 1 < dados.Length:
                        var n = dados[++i];
                        if (atual.Count > 0)
                        {
                            FecharLinha();
                        }

                        for (var k = 0; k < n; k++)
                        {
                            linhas.Add(string.Empty);
                        }

                        break;
                    case 'p':
                        i += 3;
                        linhas.Add(MarcaGaveta);
                        break;
                    case 't' when i + 1 < dados.Length:
                        codificacao = EscPos.PaginaDaTabela(dados[++i]) is { } pagina ? EscPos.Codificacao(pagina) : EscPos.Texto;
                        break;
                    case 'E' or 'M' or '-' or 'G' or '!':
                        i++;
                        break;
                }
            }
            else if (b == EscPos.Gs && i + 1 < dados.Length)
            {
                var cmd = (char)dados[++i];
                switch (cmd)
                {
                    case '!' when i + 1 < dados.Length:
                        larguraDupla = (dados[++i] & 0xF0) != 0;
                        break;
                    case '(' when i + 3 < dados.Length && dados[i + 1] == (byte)'k':
                        var tamanho = dados[i + 2] | (dados[i + 3] << 8);
                        var imprimeQr = tamanho >= 2 && i + 5 < dados.Length && dados[i + 4] == QrCodeEscPos.SimboloQr && dados[i + 5] == 81;
                        i += 3 + tamanho;
                        if (imprimeQr)
                        {
                            if (atual.Count > 0)
                            {
                                FecharLinha();
                            }

                            linhas.Add(MarcaQrCode);
                        }

                        break;
                    case 'v' when i + 6 < dados.Length && dados[i + 1] == (byte)'0':
                        var bytesImagem = (dados[i + 3] | (dados[i + 4] << 8)) * (dados[i + 5] | (dados[i + 6] << 8));
                        i += 6 + bytesImagem;
                        if (atual.Count > 0)
                        {
                            FecharLinha();
                        }

                        // Uma imagem em vários blocos (o QR em imagem) aparece uma vez só.
                        if (linhas.Count == 0 || linhas[^1] != MarcaImagem)
                        {
                            linhas.Add(MarcaImagem);
                        }

                        break;
                    case 'V':
                        var modo = i + 1 < dados.Length ? dados[++i] : (byte)0;
                        if (modo >= 65)
                        {
                            i++;
                        }

                        if (atual.Count > 0)
                        {
                            FecharLinha();
                        }

                        linhas.Add(MarcaCorte);
                        break;
                    default:
                        i++;
                        break;
                }
            }
            else
            {
                atual.Add(b);
            }
        }

        if (atual.Count > 0)
        {
            FecharLinha();
        }

        return linhas;
    }

    public static string RenderizarTexto(byte[] dados, int colunas = 48) =>
        string.Join('\n', Renderizar(dados, colunas)) + "\n";
}
