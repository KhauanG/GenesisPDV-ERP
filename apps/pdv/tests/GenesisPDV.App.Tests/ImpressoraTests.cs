using System.Net;
using System.Net.Sockets;
using GenesisPDV.Hardware.Gaveta;
using GenesisPDV.Hardware.Impressora;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Impressora térmica e gaveta reais (implantação I4, README › decisão 63): os bytes ESC/POS que cada perfil recebe
/// (página de código, corte, QR nativo × imagem, gaveta), as larguras de 48 e 32 colunas, os transportes TCP, serial e
/// dispositivo, as colunas de cada modelo, os tempos limite, o texto com caracteres de controle e as chaves de
/// <c>configuracao_terminal</c>. O spooler do Windows é provado no CI Windows
/// (<c>instalador/windows/preparar-impressora-teste.ps1</c>, <see cref="SpoolerWindowsTests"/>); os bytes inteiros do
/// teste de impressão e do comprovante, por modelo e papel, nos goldens (<see cref="GoldensImpressoraTests"/>).
/// </summary>
public class ImpressoraTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private const string Acentos = LayoutTesteImpressao.Acentos;

    private static byte[] Hex(string hex) => Convert.FromHexString(hex.Replace(" ", string.Empty, StringComparison.Ordinal));

    private static ConfiguracaoImpressora Config(ModeloImpressora modelo, PaginaCodigo? pagina = null, Guilhotina corte = Guilhotina.Parcial,
        LarguraPapel papel = LarguraPapel.Mm80, bool? qrNativo = null, int avanco = 4) => new()
        {
            Modelo = modelo,
            Conexao = TipoConexao.Rede,
            Endereco = "127.0.0.1",
            Pagina = pagina,
            Guilhotina = corte,
            Papel = papel,
            QrNativo = qrNativo,
            LinhasAvanco = avanco,
        };

    private static bool Contem(byte[] dados, byte[] trecho) => dados.AsSpan().IndexOf(trecho) >= 0;

    [Theory]
    // Epson: ESC t 3 = PC860 (padrão), 16 = WPC1252; Bematech em modo ESC/POS: 3 = PC860, 2 = PC850 (manual rev. 1.0).
    [InlineData(ModeloImpressora.EpsonTmT20, null, "1B7403", "86 90 8B 9F 96 20 80 8E 99 20 83 88 93")]
    [InlineData(ModeloImpressora.EpsonTmT88, PaginaCodigo.Wpc1252, "1B7410", "C1 C9 CD D3 DA 20 C7 C3 D5 20 E2 EA F4")]
    [InlineData(ModeloImpressora.BematechMp4200Th, null, "1B7403", "86 90 8B 9F 96 20 80 8E 99 20 83 88 93")]
    [InlineData(ModeloImpressora.BematechMp4200Th, PaginaCodigo.Cp850, "1B7402", "B5 90 D6 E0 E9 20 80 C7 E5 20 83 88 93")]
    [InlineData(ModeloImpressora.GenericaEscPos, null, "1B7403", "86 90 8B 9F 96 20 80 8E 99 20 83 88 93")]
    public void Golden_de_bytes_por_perfil_com_os_acentos_na_pagina_do_modelo_e_o_corte_parcial(
        ModeloImpressora modelo, PaginaCodigo? pagina, string tabela, string acentos)
    {
        var canonico = new ConstrutorEscPos(48).Linha(Acentos).Cortar().ParaBytes();
        var bytes = AdaptadorEscPos.Adaptar(canonico, Config(modelo, pagina));
        // ESC @ + ESC t n, o texto recodificado, LF, ESC d 4 (avanço) e GS V 1 (parcial, função A: Epson e Bematech).
        Assert.Equal(Hex($"1B40 {tabela} {acentos} 0A 1B6404 1D5601"), bytes);
        Assert.Equal(Acentos, RenderizadorEscPos.Renderizar(bytes)[0]);
    }

    [Fact]
    public void Pagina_que_o_modelo_nao_tem_e_recusada_na_tela_e_cai_na_padrao()
    {
        var c = Config(ModeloImpressora.BematechMp4200Th, PaginaCodigo.Wpc1252);
        Assert.Contains("não tem a página WPC1252", c.Validar(), StringComparison.Ordinal);
        Assert.Equal(PaginaCodigo.Cp860, c.PaginaEfetiva);
    }

    [Theory]
    [InlineData(Guilhotina.Total, 4, "1B6404 1D5600")]
    [InlineData(Guilhotina.SemCorte, 6, "1B6406")]
    [InlineData(Guilhotina.Parcial, 0, "1B6400 1D5601")]
    public void Corte_e_avanco_seguem_a_configuracao(Guilhotina corte, int avanco, string esperado)
    {
        var bytes = AdaptadorEscPos.Adaptar(new ConstrutorEscPos().Linha("X").Cortar().ParaBytes(), Config(ModeloImpressora.EpsonTmT20, corte: corte, avanco: avanco));
        Assert.Equal(Hex($"1B40 1B7403 58 0A {esperado}"), bytes);
    }

    [Fact]
    public void Qr_nativo_na_epson_e_imagem_na_bematech_e_na_generica()
    {
        const string payload = "00020126580014br.gov.bcb.pix0136pix@icebeer.com.br5204000053039865406123.455802BR5913ICE BEER LOJA6009CURITIBA62070503***6304ABCD";
        var canonico = new ConstrutorEscPos().QrCode(payload).Cortar().ParaBytes();
        Assert.Contains(RenderizadorEscPos.MarcaQrCode, RenderizadorEscPos.Renderizar(canonico));

        // Epson: GS ( k modelo 2, módulo 6 no 80 mm (4 no 58 mm), correção M, dados e impressão; nada de imagem.
        var epson = AdaptadorEscPos.Adaptar(canonico, Config(ModeloImpressora.EpsonTmT20));
        Assert.True(Contem(epson, Hex("1D286B 0400 31 41 32 00")));
        Assert.True(Contem(epson, Hex("1D286B 0300 31 43 06")));
        Assert.True(Contem(epson, Hex("1D286B 0300 31 45 31")));
        Assert.True(Contem(epson, [.. Hex("1D286B"), (byte)(payload.Length + 3), 0, 0x31, 0x50, 0x30, .. System.Text.Encoding.ASCII.GetBytes(payload)]));
        Assert.True(Contem(epson, Hex("1D286B 0300 31 51 30")));
        Assert.False(Contem(epson, Hex("1D7630")));
        Assert.True(Contem(AdaptadorEscPos.Adaptar(canonico, Config(ModeloImpressora.EpsonTmT20, papel: LarguraPapel.Mm58)), Hex("1D286B 0300 31 43 04")));

        // Bematech (o GS ( k dela só tem PDF417), Genérica e Epson com "imagem": GS v 0, sem o QR nativo.
        foreach (var c in new[]
                 {
                     Config(ModeloImpressora.BematechMp4200Th), Config(ModeloImpressora.GenericaEscPos),
                     Config(ModeloImpressora.EpsonTmT88, qrNativo: false),
                 })
        {
            var bytes = AdaptadorEscPos.Adaptar(canonico, c);
            Assert.False(Contem(bytes, Hex("1D286B")), c.Perfil.Nome);
            Assert.True(Contem(bytes, Hex("1D7630 00")), c.Perfil.Nome);
            Assert.Contains(RenderizadorEscPos.MarcaImagem, RenderizadorEscPos.Renderizar(bytes));
            Assert.Equal(RenderizadorEscPos.MarcaCorte, RenderizadorEscPos.Renderizar(bytes)[^1]);
        }

        // "Nativo" escolhido num modelo que não tem cai na imagem.
        Assert.False(Config(ModeloImpressora.BematechMp4200Th, qrNativo: true).QrNativoEfetivo);
    }

    [Fact]
    public void Qr_em_imagem_tem_a_zona_de_silencio_e_cabe_no_papel()
    {
        var imagem = QrCodeEscPos.Imagem("GenesisPDV"u8.ToArray(), 300);
        Assert.Equal(Hex("1D7630 00"), imagem[..4]);
        var bytesPorLinha = imagem[4] | (imagem[5] << 8);
        var linhas = imagem[6] | (imagem[7] << 8);
        Assert.InRange(bytesPorLinha * 8, 100, 300 + 7);
        Assert.InRange(linhas, 1, QrCodeEscPos.LinhasPorBloco);
        // A primeira linha é da zona de silêncio (branca); a imagem é quadrada (soma das linhas dos blocos = largura).
        Assert.All(imagem.AsSpan(8, bytesPorLinha).ToArray(), b => Assert.Equal(0, b));
    }

    [Fact]
    public void Gaveta_pino_2_e_5_com_o_pulso_e_o_documento_nunca_leva_esc_p()
    {
        Assert.Equal(Hex("1B70 00 3C FA"), new ConfiguracaoGaveta(Ligada: true).Comando());
        Assert.Equal(Hex("1B70 01 32 FA"), new ConfiguracaoGaveta(Ligada: true, Pino: 5, PulsoMs: 100).Comando());
        Assert.Equal("Pulso da gaveta: de 50 a 500 ms.", new ConfiguracaoGaveta(PulsoMs: 20).Validar());
        Assert.NotNull(new ConfiguracaoGaveta(Pino: 3).Validar());

        // O ESC p do documento (só a simulada o mostra) sai na adaptação: a gaveta só abre pelo ServicoGaveta, ligada.
        var documento = new ConstrutorEscPos().Linha("CUPOM").PulsoGaveta().Cortar().ParaBytes();
        Assert.Contains(RenderizadorEscPos.MarcaGaveta, RenderizadorEscPos.Renderizar(documento));
        foreach (var modelo in Enum.GetValues<ModeloImpressora>())
        {
            Assert.False(Contem(AdaptadorEscPos.Adaptar(documento, Config(modelo)), Hex("1B70")), modelo.ToString());
        }
    }

    [Fact]
    public async Task Gaveta_pela_impressora_desligada_nao_envia_nada()
    {
        var enviados = new List<byte[]>();
        var configuracao = new ConfiguracaoGaveta();
        var gaveta = new GavetaImpressora(() => configuracao, (b, _) =>
        {
            enviados.Add(b);
            return Task.CompletedTask;
        });
        await gaveta.AbrirAsync(Ct);
        Assert.Empty(enviados);
        configuracao = new ConfiguracaoGaveta(Ligada: true, Pino: 5);
        await gaveta.AbrirAsync(Ct);
        Assert.Equal(Hex("1B70 01 3C FA"), Assert.Single(enviados));
    }

    [Fact]
    public void Teste_de_impressao_em_48_e_32_colunas_sem_linha_maior_que_o_papel()
    {
        foreach (var (papel, colunas) in new[] { (LarguraPapel.Mm80, 48), (LarguraPapel.Mm58, 32) })
        {
            var c = Config(ModeloImpressora.EpsonTmT20, papel: papel);
            Assert.Equal(colunas, c.Colunas);
            var linhas = RenderizadorEscPos.Renderizar(LayoutTesteImpressao.Gerar(c, "Ice Beer Hermes - Loja 1", "04/11/2026 10:00"), colunas);
            Assert.Contains(LayoutTesteImpressao.Titulo, string.Join('\n', linhas), StringComparison.Ordinal);
            Assert.Contains($"Acentos: {Acentos}", linhas);
            Assert.Contains(LayoutTesteImpressao.Regua(colunas), linhas);
            Assert.Contains(RenderizadorEscPos.MarcaQrCode, linhas);
            Assert.Equal(RenderizadorEscPos.MarcaCorte, linhas[^1]);
            Assert.All(linhas.Where(l => l != RenderizadorEscPos.MarcaCorte), l => Assert.True(l.Length <= colunas, $"{colunas}: {l}"));
        }
    }

    [Fact]
    public void Cobranca_pix_impressa_leva_o_qr_o_valor_e_o_copia_e_cola_em_32_colunas()
    {
        const string payload = "00020126580014br.gov.bcb.pix0136pix@icebeer.com.br5204000053039865406123.455802BR5913ICE BEER LOJA6009CURITIBA62070503***6304ABCD";
        var canonico = Servicos.LayoutsCaixa.CobrancaPix("Ice Beer Hermes", "L01-C02-000007", 123.45m, payload, "pix@icebeer.com.br", 32);
        var linhas = RenderizadorEscPos.Renderizar(canonico, 32);
        Assert.Contains(RenderizadorEscPos.MarcaQrCode, linhas);
        // O número e o valor na mesma linha, o valor encostado à direita (21 + 9 caracteres cabem nas 32 colunas).
        Assert.Contains("Venda: L01-C02-000007  R$ 123,45", linhas);
        Assert.Contains("NÃO É COMPROVANTE DE PAGAMENTO", string.Join('\n', linhas), StringComparison.Ordinal);
        var copiaECola = string.Concat(linhas.SkipWhile(l => l != "Copia e cola:").Skip(1).TakeWhile(l => !l.StartsWith('-')));
        Assert.Equal(payload.Replace(" ", string.Empty, StringComparison.Ordinal), copiaECola.Replace(" ", string.Empty, StringComparison.Ordinal));
        Assert.All(linhas.Where(l => l != RenderizadorEscPos.MarcaCorte), l => Assert.True(l.Length <= 32, l));
        Assert.True(Contem(AdaptadorEscPos.Adaptar(canonico, Config(ModeloImpressora.EpsonTmT20, papel: LarguraPapel.Mm58)),
            [.. System.Text.Encoding.ASCII.GetBytes(payload)]));
    }

    [Theory]
    [InlineData(48)]
    [InlineData(42)]
    [InlineData(32)]
    [InlineData(30)]
    public void Fechamento_com_o_calculado_nunca_cola_um_valor_no_outro(int colunas)
    {
        var fuso = TimeZoneInfo.Utc;
        var cabecalho = new Servicos.CabecalhoCaixa("Ice Beer Hermes", 2, "Maria", fuso);
        var sessao = new Data.Entidades.SessaoCaixaRegistro { AbertaEm = DateTimeOffset.UnixEpoch, FundoTroco = 200m };
        var fechamento = new Data.Entidades.FechamentoCaixaRegistro { OcorridoEm = DateTimeOffset.UnixEpoch.AddHours(8) };
        var dinheiro = new Core.Caixa.FormaApurada(new Core.Caixa.FormaCaixa(Guid.Empty, "Dinheiro", "dinheiro"), 12_345.67m, 30);
        var pix = new Core.Caixa.FormaApurada(new Core.Caixa.FormaCaixa(Guid.Empty, "PIX", "pix"), 87.50m, 1);
        var conferido = new Core.Caixa.FechamentoConferido(
            [new Core.Caixa.FormaContada(dinheiro, 12_300.00m, null), new Core.Caixa.FormaContada(pix, 87.50m, null)], ZeraCaixa: true, null, false, true);
        var dados = new Data.Repositorios.DadosApuracaoSessao(sessao, [], [], [], new Data.Repositorios.ResumoTurno(31, 12_433.17m, 0, 0m, 0, 0m, 0m, 0));
        var linhas = RenderizadorEscPos.Renderizar(Servicos.LayoutsCaixa.Fechamento(cabecalho, sessao, fechamento, conferido, imprimeCalculado: true, dados, colunas), colunas);

        Assert.All(linhas.Where(l => l != RenderizadorEscPos.MarcaCorte), l => Assert.True(l.Length <= colunas, l));
        // Cada valor tem espaço antes (nada de "12.345,6712.300,00"): na tabela (48/42) ou um por linha (32/30).
        foreach (var valor in new[] { "12.345,67", "12.300,00", "-45,67", "87,50" })
        {
            Assert.Contains(linhas, l => l.Contains(" " + valor, StringComparison.Ordinal) || l == valor);
        }

        Assert.DoesNotContain(linhas, l => l.Contains("12.345,6712", StringComparison.Ordinal) || l.Contains("CalculadoContado", StringComparison.Ordinal));
        if (colunas >= 42)
        {
            Assert.Contains(linhas, l => l.StartsWith("Forma ", StringComparison.Ordinal) && l.EndsWith("Diferença", StringComparison.Ordinal) && l.Length == colunas);
        }
        else
        {
            var i = linhas.ToList().IndexOf("Dinheiro");
            Assert.Equal([$"  Calculado{"12.345,67".PadLeft(colunas - 11)}", $"  Contado{"12.300,00".PadLeft(colunas - 9)}", $"  Diferença{"-45,67".PadLeft(colunas - 11)}"],
                linhas.Skip(i + 1).Take(3));
        }
    }

    [Theory]
    [InlineData(48)]
    [InlineData(42)]
    [InlineData(32)]
    [InlineData(30)]
    public void Relatorio_do_fechamento_diz_se_saiu_com_o_calculado_em_qualquer_largura(int colunas)
    {
        // A Central (2 Caixas, bloco G6) só reimprime o relatório com o calculado para quem o veria: ela reconhece o
        // original pelo texto, lido na largura da impressora de agora (que pode não ser a daquele dia).
        var fuso = TimeZoneInfo.Utc;
        var cabecalho = new Servicos.CabecalhoCaixa("Ice Beer Hermes", 2, "Maria", fuso);
        var sessao = new Data.Entidades.SessaoCaixaRegistro { AbertaEm = DateTimeOffset.UnixEpoch, FundoTroco = 200m };
        var fechamento = new Data.Entidades.FechamentoCaixaRegistro { OcorridoEm = DateTimeOffset.UnixEpoch.AddHours(8) };
        var dinheiro = new Core.Caixa.FormaApurada(new Core.Caixa.FormaCaixa(Guid.Empty, "Dinheiro", "dinheiro"), 9_999_999.99m, 30);
        var conferido = new Core.Caixa.FechamentoConferido(
            [new Core.Caixa.FormaContada(dinheiro, 9_999_000.00m, null)], ZeraCaixa: true, "Conferido com o gerente", false, true);
        var dados = new Data.Repositorios.DadosApuracaoSessao(sessao, [], [], [], new Data.Repositorios.ResumoTurno(31, 12_433.17m, 0, 0m, 0, 0m, 0m, 0));
        foreach (var imprimeCalculado in new[] { true, false })
        {
            var bytes = Servicos.LayoutsCaixa.Fechamento(cabecalho, sessao, fechamento, conferido, imprimeCalculado, dados, colunas);
            foreach (var leitura in new[] { 48, 30 })
            {
                Assert.Equal(imprimeCalculado, Servicos.ServicoHistoricoCaixas.TrazCalculado(RenderizadorEscPos.RenderizarTexto(bytes, leitura)));
            }
        }
    }

    [Fact]
    public void Texto_longo_quebra_na_palavra_e_o_valor_nunca_e_partido()
    {
        var linhas = RenderizadorEscPos.Renderizar(new ConstrutorEscPos(32)
            .Linha("CERVEJA BRAHMA DUPLO MALTE LATA 350ML")
            .Colunado("   12,000 UN x 3,49 ATACADO DA LOJA", "41,88")
            .ParaBytes(), 32);
        Assert.Equal(["CERVEJA BRAHMA DUPLO MALTE LATA", "350ML", "   12,000 UN x 3,49 ATACADO DA", "LOJA                       41,88"], linhas);
    }

    [Fact]
    public async Task Transporte_tcp_entrega_os_bytes_e_a_impressora_desligada_vira_falha()
    {
        using var ouvinte = new TcpListener(IPAddress.Loopback, 0);
        ouvinte.Start();
        var porta = ((IPEndPoint)ouvinte.LocalEndpoint).Port;
        var recebido = Task.Run(async () =>
        {
            using var cliente = await ouvinte.AcceptTcpClientAsync(Ct);
            using var memoria = new MemoryStream();
            await cliente.GetStream().CopyToAsync(memoria, Ct);
            return memoria.ToArray();
        }, Ct);
        var dados = AdaptadorEscPos.Adaptar(new ConstrutorEscPos().Linha(Acentos).Cortar().ParaBytes(), Config(ModeloImpressora.EpsonTmT20));
        await new TransporteTcp("127.0.0.1", porta, TimeSpan.FromSeconds(4)).EnviarAsync(dados, Ct);
        Assert.Equal(dados, await recebido);

        ouvinte.Stop();
        var falha = await Assert.ThrowsAsync<FalhaImpressoraException>(() =>
            new TransporteTcp("127.0.0.1", porta, TimeSpan.FromSeconds(2)).EnviarAsync([0x41], Ct));
        Assert.Contains($"127.0.0.1:{porta} não respondeu", falha.Message, StringComparison.Ordinal);
    }

    private sealed class PortaFalsa(bool falhar) : IPortaSerial
    {
        public List<byte> Escrito { get; } = [];

        public bool Aberta { get; private set; }

        public bool Fechada { get; private set; }

        public void Abrir() => Aberta = falhar ? throw new UnauthorizedAccessException("Acesso negado à porta COM3.") : true;

        public void Escrever(byte[] dados) => Escrito.AddRange(dados);

        public void Dispose() => Fechada = true;
    }

    [Fact]
    public async Task Transporte_serial_abre_escreve_e_fecha_a_porta_e_a_porta_ocupada_vira_falha()
    {
        PortaFalsa? porta = null;
        await new TransporteSerial("COM3", 115200, (nome, baud) =>
        {
            Assert.Equal(("COM3", 115200), (nome, baud));
            return porta = new PortaFalsa(falhar: false);
        }).EnviarAsync([0x1B, 0x40, 0x41], Ct);
        Assert.True(porta!.Aberta);
        Assert.True(porta.Fechada);
        Assert.Equal(new byte[] { 0x1B, 0x40, 0x41 }, porta.Escrito);

        var ocupada = new PortaFalsa(falhar: true);
        var falha = await Assert.ThrowsAsync<FalhaImpressoraException>(() => new TransporteSerial("COM3", 9600, (_, _) => ocupada).EnviarAsync([0x41], Ct));
        Assert.Contains("porta COM3", falha.Message, StringComparison.Ordinal);
        Assert.True(ocupada.Fechada);
    }

    public static bool NoLinux => OperatingSystem.IsLinux();

    [Fact(SkipUnless = nameof(NoLinux), Skip = "O dispositivo de impressora só existe no Linux.")]
    public async Task Transporte_de_dispositivo_so_grava_num_dispositivo_de_impressora_e_nunca_num_arquivo_comum()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        // Uma "/dev" de mentira: usb/lp0 é o dispositivo; o pdv.db fica fora, e o usb/lp1 é um link para ele.
        var raiz = Path.Combine(Path.GetTempPath(), $"genesispdv-dev-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Path.Combine(raiz, "usb"));
        var lp0 = Path.Combine(raiz, "usb", "lp0");
        var banco = Path.Combine(Path.GetTempPath(), $"genesispdv-pdv-{Guid.NewGuid():N}.db");
        byte[] cabecalhoSqlite = [.. "SQLite format 3\0"u8];
        await File.WriteAllBytesAsync(lp0, [], Ct);
        await File.WriteAllBytesAsync(banco, cabecalhoSqlite, Ct);
        var link = Path.Combine(raiz, "usb", "lp1");
        File.CreateSymbolicLink(link, banco);
        try
        {
            await new TransporteDispositivo(lp0, raiz).EnviarAsync([0x1B, 0x40], Ct);
            Assert.Equal(new byte[] { 0x1B, 0x40 }, await File.ReadAllBytesAsync(lp0, Ct));
            Assert.Null(TransporteDispositivo.Validar(lp0, raiz));

            // O arquivo comum (o banco local) e o link para ele são recusados antes de abrir: nada é gravado.
            foreach (var caminho in new[] { banco, link, Path.Combine(raiz, "usb", "..", "usb", "lp0x") })
            {
                Assert.NotNull(TransporteDispositivo.Validar(caminho, raiz));
                var falha = await Assert.ThrowsAsync<FalhaImpressoraException>(() => new TransporteDispositivo(caminho, raiz).EnviarAsync([0x1B, 0x40], Ct));
                Assert.Contains("não é um dispositivo de impressora", falha.Message, StringComparison.Ordinal);
            }

            Assert.Equal(cabecalhoSqlite, await File.ReadAllBytesAsync(banco, Ct));
            await Assert.ThrowsAsync<FalhaImpressoraException>(() => new TransporteDispositivo(Path.Combine(raiz, "usb", "lp7"), raiz).EnviarAsync([0x41], Ct));
        }
        finally
        {
            Directory.Delete(raiz, recursive: true);
            File.Delete(banco);
        }

        // Na configuração (a /dev de verdade): o padrão e a serial do USB valem; o banco, /dev/null e o vazio não.
        var dispositivo = Config(ModeloImpressora.EpsonTmT20) with { Conexao = TipoConexao.Dispositivo };
        Assert.Null((dispositivo with { Porta = ConfiguracaoImpressora.DispositivoPadrao }).Validar());
        Assert.Null((dispositivo with { Porta = "/dev/ttyACM0" }).Validar());
        Assert.NotNull((dispositivo with { Porta = "/home/caixa/.local/share/GenesisPDV/pdv.db" }).Validar());
        Assert.NotNull((dispositivo with { Porta = "/dev/null" }).Validar());
        Assert.NotNull((dispositivo with { Porta = "/dev/usb/../sda" }).Validar());
        Assert.NotNull((dispositivo with { Porta = " " }).Validar());
    }

    [Fact]
    public void Dispositivo_fora_do_linux_e_recusado_na_configuracao_e_no_transporte()
    {
        if (OperatingSystem.IsLinux())
        {
            return;
        }

        var c = Config(ModeloImpressora.EpsonTmT20) with { Conexao = TipoConexao.Dispositivo, Porta = ConfiguracaoImpressora.DispositivoPadrao };
        Assert.Equal(TransporteDispositivo.MensagemSoLinux, c.Validar());
        Assert.Equal(TransporteDispositivo.MensagemSoLinux, Assert.Throws<FalhaImpressoraException>(() => Transportes.Criar(c)).Message);
    }

    /// <summary>Transporte preso numa chamada bloqueante (o <c>write()</c> do <c>usblp</c> sem papel): nunca termina.</summary>
    private sealed class TransporteTravado : ITransporteImpressora
    {
        public Task EnviarAsync(byte[] dados, CancellationToken ct = default) => new TaskCompletionSource().Task;
    }

    [Fact]
    public async Task Envio_que_nunca_termina_vira_falha_no_tempo_limite_e_a_venda_segue()
    {
        var impressora = new ImpressoraEscPos(Config(ModeloImpressora.EpsonTmT20), new TransporteTravado(), TimeSpan.FromMilliseconds(300));
        var relogio = System.Diagnostics.Stopwatch.StartNew();
        var falha = await Assert.ThrowsAsync<FalhaImpressoraException>(() => impressora.ImprimirAsync(new ConstrutorEscPos().Linha("X").Cortar().ParaBytes(), Ct));
        Assert.InRange(relogio.Elapsed, TimeSpan.FromMilliseconds(250), TimeSpan.FromSeconds(10));
        Assert.Contains("não respondeu em", falha.Message, StringComparison.Ordinal);
        await Assert.ThrowsAsync<FalhaImpressoraException>(() => impressora.EnviarBrutoAsync(new ConfiguracaoGaveta(Ligada: true).Comando(), Ct));

        // O limite de cada conexão: rede e dispositivo 8 s; spooler com a espera da fila do Windows; a serial pelo tamanho.
        Assert.Equal(TimeSpan.FromSeconds(8), Transportes.TempoEnvio(Config(ModeloImpressora.EpsonTmT20), 4000));
        Assert.True(Transportes.TempoEnvio(Config(ModeloImpressora.EpsonTmT20) with { Conexao = TipoConexao.Spooler }, 4000) > Transportes.TempoFilaWindows);
        var serial = Config(ModeloImpressora.BematechMp4200Th) with { Conexao = TipoConexao.Serial, Baud = 9600 };
        Assert.True(Transportes.TempoEnvio(serial, 15_000) > Transportes.TempoSerial(15_000, 9600));
    }

    [Fact]
    public void Tempo_da_serial_cresce_com_o_documento_e_cai_com_a_velocidade()
    {
        // O QR em imagem da Bematech no 80 mm (cerca de 15 KB) leva uns 15 s de linha a 9600 baud: o limite passa disso.
        var qr = QrCodeEscPos.Imagem(System.Text.Encoding.UTF8.GetBytes(new string('7', 140)), 360).Length;
        Assert.InRange(qr, 8_000, 30_000);
        Assert.True(Transportes.TempoSerial(qr, 9600) > TimeSpan.FromSeconds(qr * 10.0 / 9600));
        Assert.True(Transportes.TempoSerial(15_000, 19200) > TimeSpan.FromSeconds(7.8));
        Assert.True(Transportes.TempoSerial(15_000, 9600) > Transportes.TempoSerial(15_000, 115200));
        // O documento curto mantém o mínimo de sempre.
        Assert.InRange(Transportes.TempoSerial(10, 115200), Transportes.TempoLimite, Transportes.TempoLimite + TimeSpan.FromSeconds(1));
    }

    [Theory]
    // Impressora: papel, tampa, atolada, "Usar impressora offline", offline, pausada, erro; e a que está pronta.
    [InlineData(SituacaoSpooler.ImpressoraSemPapel, 0u, "está sem papel")]
    [InlineData(SituacaoSpooler.ImpressoraTampaAberta, 0u, "está com a tampa aberta")]
    [InlineData(SituacaoSpooler.ImpressoraAtolada, 0u, "está com o papel atolado")]
    [InlineData(0u, SituacaoSpooler.AtributoUsarOffline, "está marcada \"Usar impressora offline\" no Windows")]
    [InlineData(SituacaoSpooler.ImpressoraOffline, 0u, "está desligada ou offline")]
    [InlineData(SituacaoSpooler.ImpressoraPausada, 0u, "está pausada no Windows")]
    [InlineData(SituacaoSpooler.ImpressoraErro, 0u, "está com erro")]
    [InlineData(0u, 0x40u, null)]
    public void Situacao_da_impressora_no_windows_recusa_o_envio_antes_da_fila(uint status, uint atributos, string? esperado) =>
        Assert.Equal(esperado, SituacaoSpooler.ProblemaImpressora(status, atributos));

    [Fact]
    public void Situacao_do_trabalho_na_fila_do_windows()
    {
        // Saiu (impresso, ou mantido depois de impresso) × ainda andando (na fila, imprimindo) × problema (cancelar e falhar).
        Assert.True(SituacaoSpooler.TrabalhoConcluido(SituacaoSpooler.TrabalhoImpresso));
        Assert.True(SituacaoSpooler.TrabalhoConcluido(SituacaoSpooler.TrabalhoCompleto | 0x2000));
        Assert.Null(SituacaoSpooler.ProblemaTrabalho(0));
        Assert.Null(SituacaoSpooler.ProblemaTrabalho(0x8 | 0x10));
        Assert.Equal("está sem papel", SituacaoSpooler.ProblemaTrabalho(SituacaoSpooler.TrabalhoSemPapel | SituacaoSpooler.TrabalhoErro | 0x10));
        Assert.Equal("está desligada ou offline", SituacaoSpooler.ProblemaTrabalho(SituacaoSpooler.TrabalhoOffline));
        Assert.Equal("está com erro", SituacaoSpooler.ProblemaTrabalho(SituacaoSpooler.TrabalhoBloqueado));
        Assert.Equal("teve o documento excluído da fila do Windows", SituacaoSpooler.ProblemaTrabalho(SituacaoSpooler.TrabalhoExcluindo));
        Assert.Null(SituacaoSpooler.ProblemaTrabalho(SituacaoSpooler.TrabalhoImpresso | SituacaoSpooler.TrabalhoExcluindo));
    }

    [Fact]
    public void Caractere_de_controle_no_texto_nunca_vira_comando()
    {
        // Descrição vinda do ERP com o pulso da gaveta em tempo real (DLE DC4 1 0 5) e um GS ( k que engoliria o cupom.
        var canonico = new ConstrutorEscPos(48)
            .Linha("CERVEJA \u0010\u0014\u0001\u0000\u0005 LATA")
            .Colunado("ANTES \u001D(k\u00FF\u00FF X", "1,00")
            .Centro("NOME\u001Bp\u0000\u0019\u00FA")
            .Linha("TOTAL")
            .Cortar()
            .ParaBytes();
        Assert.Equal("CERVEJA       LATA", RenderizadorEscPos.Renderizar(canonico)[0]);
        foreach (var modelo in Enum.GetValues<ModeloImpressora>())
        {
            var bytes = AdaptadorEscPos.Adaptar(canonico, Config(modelo));
            Assert.False(Contem(bytes, Hex("1014")), modelo.ToString());
            Assert.False(Contem(bytes, Hex("1D286B")), modelo.ToString());
            Assert.False(Contem(bytes, Hex("1B70")), modelo.ToString());
            // O cupom inteiro saiu: o TOTAL e o corte do terminal no fim.
            Assert.Contains("TOTAL", RenderizadorEscPos.Renderizar(bytes));
            Assert.Equal(Hex("1B6404 1D5601"), bytes[^6..]);
        }

        // Defesa extra: um trabalho antigo da fila com o DLE DC4 cru no texto perde o comando na adaptação.
        byte[] antigo = [.. new ConstrutorEscPos().ParaBytes(), .. "A"u8, 0x10, 0x14, 0x01, 0x00, 0x05, .. "B"u8, EscPos.Lf];
        Assert.Equal(Hex("1B40 1B7403 41 42 0A"), AdaptadorEscPos.Adaptar(antigo, Config(ModeloImpressora.EpsonTmT20)));
    }

    [Theory]
    [InlineData(ModeloImpressora.EpsonTmT20, 48, 32)]
    [InlineData(ModeloImpressora.EpsonTmT88, 42, 30)]
    [InlineData(ModeloImpressora.BematechMp4200Th, 48, 32)]
    [InlineData(ModeloImpressora.GenericaEscPos, 48, 32)]
    public void Colunas_sao_do_modelo_e_do_papel_e_nenhuma_linha_passa_da_largura(ModeloImpressora modelo, int colunas80, int colunas58)
    {
        foreach (var (papel, colunas) in new[] { (LarguraPapel.Mm80, colunas80), (LarguraPapel.Mm58, colunas58) })
        {
            var c = Config(modelo, papel: papel);
            Assert.Equal(colunas, c.Colunas);
            var teste = RenderizadorEscPos.Renderizar(AdaptadorEscPos.Adaptar(LayoutTesteImpressao.Gerar(c, "Ice Beer Hermes - Loja 1", "04/11/2026 10:00"), c), colunas);
            Assert.Contains(LayoutTesteImpressao.Regua(colunas), teste);
            Assert.Contains($"Papel: {(papel == LarguraPapel.Mm58 ? "58" : "80")} mm, {colunas} colunas", teste);
            var cupom = RenderizadorEscPos.Renderizar(AdaptadorEscPos.Adaptar(GoldensImpressoraTests.Comprovante(colunas), c), colunas);
            foreach (var linhas in new[] { teste, cupom })
            {
                Assert.All(linhas.Where(l => l != RenderizadorEscPos.MarcaCorte && !l.StartsWith('[')), l => Assert.True(l.Length <= colunas, $"{modelo} {colunas}: {l}"));
            }

            // A chave grava as colunas do modelo e a leitura volta ao mesmo papel.
            var chaves = ChavesHardware.Escrever(new ConfiguracaoHardware(c, new ConfiguracaoGaveta()));
            Assert.Equal(colunas.ToString(System.Globalization.CultureInfo.InvariantCulture), chaves[ChavesHardware.Colunas]);
            Assert.Equal(papel, ChavesHardware.Ler(chaves, TipoConexao.Nenhuma).Impressora.Papel);
        }
    }

    [Fact]
    public void Chaves_de_configuracao_ida_e_volta_e_o_padrao_sem_impressora_e_gaveta_desligada()
    {
        var padrao = ChavesHardware.Ler(new Dictionary<string, string>(), TipoConexao.Nenhuma);
        Assert.False(padrao.Impressora.Configurada);
        Assert.False(padrao.Gaveta.Ligada);
        Assert.Equal((48, Guilhotina.Parcial, 4, PaginaCodigo.Cp860), (padrao.Impressora.Colunas, padrao.Impressora.Guilhotina, padrao.Impressora.LinhasAvanco, padrao.Impressora.PaginaEfetiva));

        var configurada = new ConfiguracaoHardware(
            new ConfiguracaoImpressora
            {
                Modelo = ModeloImpressora.BematechMp4200Th,
                Conexao = TipoConexao.Serial,
                Porta = "COM4",
                Baud = 9600,
                Papel = LarguraPapel.Mm58,
                Guilhotina = Guilhotina.Total,
                LinhasAvanco = 6,
                Pagina = PaginaCodigo.Cp850,
                QrNativo = false,
            },
            new ConfiguracaoGaveta(Ligada: true, Pino: 5, PulsoMs: 200, AbreNosMovimentos: true));
        var chaves = ChavesHardware.Escrever(configurada);
        Assert.Equal(ChavesHardware.Todas.Order(StringComparer.Ordinal), chaves.Keys.Order(StringComparer.Ordinal));
        Assert.Equal("\"bematech_mp4200th\"", chaves[ChavesHardware.Modelo]);
        Assert.Equal("32", chaves[ChavesHardware.Colunas]);
        Assert.Equal("\"impressora\"", chaves[ChavesHardware.GavetaModo]);
        Assert.Equal(configurada, ChavesHardware.Ler(chaves, TipoConexao.Nenhuma));

        // Valor estragado ou desconhecido cai no padrão (a abertura do caixa nunca depende da impressora).
        var estragada = ChavesHardware.Ler(new Dictionary<string, string>
        {
            [ChavesHardware.Modelo] = "\"daruma\"",
            [ChavesHardware.Baud] = "{",
            [ChavesHardware.GavetaModo] = "\"serial\"",
        }, TipoConexao.Simulada);
        Assert.Equal((ModeloImpressora.GenericaEscPos, TipoConexao.Simulada, ConfiguracaoImpressora.BaudPadrao, false),
            (estragada.Impressora.Modelo, estragada.Impressora.Conexao, estragada.Impressora.Baud, estragada.Gaveta.Ligada));
    }
}
