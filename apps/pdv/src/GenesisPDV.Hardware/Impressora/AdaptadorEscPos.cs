namespace GenesisPDV.Hardware.Impressora;

/// <summary>
/// Traduz o documento canônico do <see cref="ConstrutorEscPos"/> (o gravado na <c>fila_impressao</c>: PC860, corte
/// <c>GS V 66</c>, QR nativo) para o modelo e a configuração do terminal na hora de imprimir (PDV 6.2, 19.1;
/// implantação I4). Assim a reimpressão e a nova tentativa de um trabalho antigo saem certas mesmo depois de trocar a
/// impressora.
/// <list type="bullet">
/// <item>Texto: decodificado na página de entrada (a do <c>ESC t</c> do documento, PC860) e recodificado na do perfil;
/// todo <c>ESC @</c> sai seguido do <c>ESC t n</c> do modelo.</item>
/// <item>Corte: <c>ESC d</c> com as linhas de avanço e <c>GS V 1</c> (parcial), <c>GS V 0</c> (total) ou nada (sem
/// corte). A função A do <c>GS V</c> é a que a Epson e a Bematech em modo ESC/POS aceitam igual.</item>
/// <item>QR (<c>GS ( k</c>, <c>cn = 49</c>): nativo com o módulo do papel, ou imagem <c>GS v 0</c>.</item>
/// <item>Gaveta: todo <c>ESC p</c> do documento é retirado — o pulso só sai pela gaveta ligada (decisão 63).</item>
/// <item>Bytes de controle soltos no texto (abaixo de 0x20, fora o LF; o construtor já os troca por espaço) são
/// descartados: assim um <c>DLE DC4</c> (pulso da gaveta em tempo real) ou um <c>DLE EOT</c> de um trabalho antigo da fila
/// nunca chega à impressora.</item>
/// </list>
/// Comandos fora desse conjunto passam como vieram (o canônico não os tem).
/// </summary>
public static class AdaptadorEscPos
{
    public static byte[] Adaptar(byte[] canonico, ConfiguracaoImpressora configuracao)
    {
        ArgumentNullException.ThrowIfNull(canonico);
        ArgumentNullException.ThrowIfNull(configuracao);
        var perfil = configuracao.Perfil;
        var pagina = configuracao.PaginaEfetiva;
        var saida = new List<byte>(canonico.Length + 64);
        var destino = EscPos.Codificacao(PerfilImpressora.PaginaDotNet(pagina));
        var origem = EscPos.Texto;
        var texto = new List<byte>();
        byte[]? qr = null;

        void Inicializar() => saida.AddRange([EscPos.Esc, (byte)'@', EscPos.Esc, (byte)'t', perfil.ComandoTabela(pagina)]);

        void FecharTexto()
        {
            if (texto.Count == 0)
            {
                return;
            }

            saida.AddRange(destino.GetBytes(origem.GetString([.. texto])));
            texto.Clear();
        }

        Inicializar();
        var i = 0;
        while (i < canonico.Length)
        {
            var b = canonico[i];
            if (b == EscPos.Esc && i + 1 < canonico.Length)
            {
                FecharTexto();
                var cmd = (char)canonico[i + 1];
                switch (cmd)
                {
                    case '@':
                        // O primeiro já saiu acima; os do meio (reimpressão = marca + original) reiniciam e reaplicam a página.
                        if (i > 0)
                        {
                            Inicializar();
                        }

                        i += 2;
                        break;
                    case 't' when i + 2 < canonico.Length:
                        origem = EscPos.PaginaDaTabela(canonico[i + 2]) is { } p ? EscPos.Codificacao(p) : EscPos.Texto;
                        i += 3;
                        break;
                    case 'p':
                        i += 5;
                        break;
                    case 'a' or 'E' or 'd' or 'M' or '-' or 'G' or '!' when i + 2 < canonico.Length:
                        saida.AddRange(canonico.AsSpan(i, 3));
                        i += 3;
                        break;
                    default:
                        saida.AddRange(canonico.AsSpan(i, 2));
                        i += 2;
                        break;
                }
            }
            else if (b == EscPos.Gs && i + 1 < canonico.Length)
            {
                FecharTexto();
                var cmd = (char)canonico[i + 1];
                switch (cmd)
                {
                    case 'V':
                        var modo = i + 2 < canonico.Length ? canonico[i + 2] : (byte)0;
                        i += modo >= 65 ? 4 : 3;
                        Cortar(saida, configuracao);
                        break;
                    case '(' when i + 4 < canonico.Length && canonico[i + 2] == (byte)'k':
                        var tamanho = canonico[i + 3] | (canonico[i + 4] << 8);
                        var fim = Math.Min(canonico.Length, i + 5 + tamanho);
                        var corpo = canonico.AsSpan(i + 5, fim - (i + 5));
                        if (corpo.Length >= 2 && corpo[0] == QrCodeEscPos.SimboloQr)
                        {
                            switch (corpo[1])
                            {
                                case 80 when corpo.Length >= 3:
                                    qr = corpo[3..].ToArray();
                                    break;
                                case 81 when qr is not null:
                                    saida.AddRange(configuracao.QrNativoEfetivo
                                        ? QrCodeEscPos.Nativo(qr, configuracao.ModuloQrNativo)
                                        : QrCodeEscPos.Imagem(qr, configuracao.LarguraQrPontos));
                                    break;
                            }
                        }
                        else
                        {
                            saida.AddRange(canonico.AsSpan(i, fim - i));
                        }

                        i = fim;
                        break;
                    case 'v' when i + 7 < canonico.Length && canonico[i + 2] == (byte)'0':
                        var bytesImagem = (canonico[i + 4] | (canonico[i + 5] << 8)) * (canonico[i + 6] | (canonico[i + 7] << 8));
                        var fimImagem = Math.Min(canonico.Length, i + 8 + bytesImagem);
                        saida.AddRange(canonico.AsSpan(i, fimImagem - i));
                        i = fimImagem;
                        break;
                    case '!' when i + 2 < canonico.Length:
                        saida.AddRange(canonico.AsSpan(i, 3));
                        i += 3;
                        break;
                    default:
                        var copia = Math.Min(3, canonico.Length - i);
                        saida.AddRange(canonico.AsSpan(i, copia));
                        i += copia;
                        break;
                }
            }
            else if (b == EscPos.Lf)
            {
                FecharTexto();
                saida.Add(EscPos.Lf);
                i++;
            }
            else if (b < 0x20)
            {
                // Controle solto (DLE, DC4, NUL…): nunca vai como comando nem como texto.
                i++;
            }
            else
            {
                texto.Add(b);
                i++;
            }
        }

        FecharTexto();
        return [.. saida];
    }

    private static void Cortar(List<byte> saida, ConfiguracaoImpressora configuracao)
    {
        saida.AddRange([EscPos.Esc, (byte)'d', (byte)Math.Clamp(configuracao.LinhasAvanco, 0, 10)]);
        switch (configuracao.Guilhotina)
        {
            case Guilhotina.Parcial:
                saida.AddRange([EscPos.Gs, (byte)'V', 1]);
                break;
            case Guilhotina.Total:
                saida.AddRange([EscPos.Gs, (byte)'V', 0]);
                break;
        }
    }
}
