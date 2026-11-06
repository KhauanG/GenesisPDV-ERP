using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.App.ViewModels;
using GenesisPDV.App.ViewModels.Central;
using GenesisPDV.Data;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Hardware.Gaveta;
using GenesisPDV.Hardware.Impressora;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Impressora e gaveta no caixa (implantação I4, README › decisão 63), com um transporte em memória no lugar da rede: o
/// cupom sai adaptado ao modelo e ao papel, a gaveta só recebe o <c>ESC p</c> ligada e com forma "Abrir gaveta" (ou no
/// F11 › 9 com a liberação), a falha da impressora não trava a venda e fica na fila (nova tentativa na configuração), sem
/// impressora o caixa vende e avisa discretamente, e a aba 3 Impressora e gaveta da Central do PDV (Ctrl+Alt+C no login,
/// F11 › 8 na venda; a antiga configuração do terminal) testa, grava e audita.
/// </summary>
public class ImpressoraTelasTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly byte[] EscP = [0x1B, 0x70];

    /// <summary>A "impressora de rede" dos testes: guarda cada envio; com <see cref="Falhar"/>, recusa como a desligada.</summary>
    private sealed class TransporteMemoria : ITransporteImpressora
    {
        public List<byte[]> Enviados { get; } = [];

        public bool Falhar { get; set; }

        public Task EnviarAsync(byte[] dados, CancellationToken ct = default)
        {
            if (Falhar)
            {
                throw new FalhaImpressoraException("Impressora de rede 192.168.0.50:9100 não respondeu.");
            }

            Enviados.Add(dados);
            return Task.CompletedTask;
        }
    }

    private static Task<AmbienteUi> IniciarAsync(TransporteMemoria transporte) =>
        AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<FabricaTransporteImpressora>(_ => transporte));

    private static Task ConfigurarAsync(AmbienteUi pdv, ConfiguracaoImpressora impressora, ConfiguracaoGaveta? gaveta = null) =>
        pdv.Servicos.GetRequiredService<ServicoHardware>().GravarAsync(new ConfiguracaoHardware(impressora, gaveta ?? new ConfiguracaoGaveta()), null, null, Ct);

    private static ConfiguracaoImpressora Rede(ModeloImpressora modelo = ModeloImpressora.EpsonTmT20, LarguraPapel papel = LarguraPapel.Mm80) =>
        new() { Modelo = modelo, Conexao = TipoConexao.Rede, Endereco = "192.168.0.50", Papel = papel };

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    private static bool Contem(byte[] dados, byte[] trecho) => dados.AsSpan().IndexOf(trecho) >= 0;

    /// <summary>"GELO ESCAMA 5KG" (R$ 12,90) em dinheiro (forma "Abrir gaveta" da demonstração) pelo teclado.</summary>
    private static async Task VenderGeloAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
    }

    private static async Task<VendaViewModel> VoltarParaVendaAsync(AmbienteUi pdv)
    {
        await pdv.Shell.IrParaVendaAsync();
        await pdv.EsperarFocoAsync("CampoCodigo");
        return (VendaViewModel)pdv.Shell.PaginaAtual!;
    }

    /// <summary>CARLOS (Master) libera no diálogo do supervisor; quem chama espera a tela seguinte.</summary>
    private static async Task LiberarAsync(AmbienteUi pdv, VendaViewModel venda, string motivo)
    {
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var dialogo = Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
        dialogo.Pedido.Usuario = "2";
        dialogo.Pedido.Pin = "4321";
        dialogo.Pedido.Motivo = motivo;
        pdv.Tecla(Key.Enter);
    }

    private static async Task FuncaoAsync(AmbienteUi pdv, Key tecla)
    {
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(tecla);
        await AmbienteUi.Pausa();
    }

    [AvaloniaFact]
    public async Task Cupom_sai_adaptado_ao_modelo_e_ao_papel_e_a_gaveta_so_recebe_o_pulso_ligada()
    {
        var transporte = new TransporteMemoria();
        using var pdv = await IniciarAsync(transporte);
        await pdv.AtivarDemonstracaoELogarAsync();
        await ConfigurarAsync(pdv, Rede(papel: LarguraPapel.Mm58));
        var venda = await VoltarParaVendaAsync(pdv);

        // Gaveta desligada (padrão do dono): o cupom de 32 colunas em PC860, cortado, e nenhum ESC p, nunca.
        await VenderGeloAsync(pdv, venda);
        var cupom = Assert.Single(transporte.Enviados);
        Assert.Equal(new byte[] { 0x1B, 0x40, 0x1B, 0x74, 0x03 }, cupom[..5]);
        Assert.True(Contem(cupom, EscPos.Codificacao(860).GetBytes("NÃO É DOCUMENTO FISCAL")));
        Assert.Equal(new byte[] { 0x1B, 0x64, 0x04, 0x1D, 0x56, 0x01 }, cupom[^6..]);
        Assert.False(Contem(cupom, EscP));
        var linhas = RenderizadorEscPos.Renderizar(cupom, 32);
        Assert.All(linhas.Where(l => l != RenderizadorEscPos.MarcaCorte), l => Assert.True(l.Length <= 32, l));
        Assert.Contains(linhas, l => l.EndsWith("12,90", StringComparison.Ordinal));
        Assert.Equal(0, pdv.Servicos.GetRequiredService<GavetaSimulada>().Aberturas);

        // Ligada no pino 5: depois do cupom, só o pulso, pelo mesmo transporte.
        await ConfigurarAsync(pdv, Rede(papel: LarguraPapel.Mm58), new ConfiguracaoGaveta(Ligada: true, Pino: 5, PulsoMs: 120));
        await VenderGeloAsync(pdv, venda);
        Assert.Equal(3, transporte.Enviados.Count);
        Assert.False(Contem(transporte.Enviados[1], EscP));
        Assert.Equal(new byte[] { 0x1B, 0x70, 0x01, 0x3C, 0xFA }, transporte.Enviados[2]);
        await using var db = Banco(pdv);
        Assert.Equal(2, await db.FilaImpressao.CountAsync(f => f.TipoDocumento == "cupom" && f.Status == "impresso", Ct));
    }

    [AvaloniaFact]
    public async Task Falha_da_impressora_nao_trava_a_venda_e_a_fila_sai_depois_pela_configuracao_do_terminal()
    {
        var transporte = new TransporteMemoria { Falhar = true };
        using var pdv = await IniciarAsync(transporte);
        await pdv.AtivarDemonstracaoELogarAsync();
        await ConfigurarAsync(pdv, Rede());
        var venda = await VoltarParaVendaAsync(pdv);

        await VenderGeloAsync(pdv, venda);
        Assert.Contains("Cupom não impresso (Impressora de rede 192.168.0.50:9100 não respondeu.)", pdv.Texto("TextoMensagem"), StringComparison.Ordinal);
        Assert.Contains("NÃO É DOCUMENTO FISCAL", venda.UltimoCupom, StringComparison.Ordinal);
        await using (var db = Banco(pdv))
        {
            var trabalho = await db.FilaImpressao.SingleAsync(f => f.TipoDocumento == "cupom", Ct);
            Assert.Equal(("falhou", 1), (trabalho.Status, trabalho.Tentativas));
            Assert.Equal(1, await db.Vendas.CountAsync(v => v.Status == "finalizada", Ct));
        }

        // F11 › 8 › 3 (MARIA não tem pdv.config.terminal: a aba pede e CARLOS libera); F7 tenta de novo com a impressora de volta.
        await FuncaoAsync(pdv, Key.D8);
        await pdv.EsperarCentralAsync();
        var configuracao = await pdv.AbrirAbaHardwareAsync("2", "4321");
        await pdv.EsperarAsync(() => configuracao.Pendentes == 1, "um pendente");
        Assert.Equal(OrigemCentral.Venda, configuracao.Origem);
        Assert.False(configuracao.PodeRestaurarBackup);
        pdv.Tecla(Key.F7);
        await pdv.EsperarAsync(() => configuracao.Erro is not null, "ainda desligada");
        Assert.Contains("parou em", configuracao.Erro, StringComparison.Ordinal);
        transporte.Falhar = false;
        pdv.Tecla(Key.F7);
        await pdv.EsperarAsync(() => configuracao.Pendentes == 0, "fila impressa");
        Assert.StartsWith("1 documento(s) da fila impresso(s)", configuracao.Mensagem, StringComparison.Ordinal);
        Assert.Single(transporte.Enviados);
        await using (var db = Banco(pdv))
        {
            var trabalho = await db.FilaImpressao.SingleAsync(f => f.TipoDocumento == "cupom", Ct);
            Assert.Equal(("impresso", 3), (trabalho.Status, trabalho.Tentativas));
        }

        // F9 não existe pela venda (o "Restaurar backup" é só do login); Esc volta ao menu e de lá à venda.
        pdv.Tecla(Key.F9);
        await AmbienteUi.Pausa();
        Assert.IsType<CentralPdvViewModel>(pdv.Shell.PaginaAtual);
        Assert.False(pdv.Controle<Button>("BotaoRestaurarBackup").IsVisible);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "3", "foco no menu");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "venda");
    }

    [AvaloniaFact]
    public async Task Sem_impressora_vende_sem_aviso_e_a_barra_mostra_discretamente()
    {
        var transporte = new TransporteMemoria();
        using var pdv = await IniciarAsync(transporte);
        await pdv.AtivarDemonstracaoELogarAsync();
        await ConfigurarAsync(pdv, new ConfiguracaoImpressora { Conexao = TipoConexao.Nenhuma }, new ConfiguracaoGaveta(Ligada: true));
        var venda = await VoltarParaVendaAsync(pdv);
        Assert.True(pdv.Controle<TextBlock>("TextoSemImpressora").IsVisible);
        Assert.Equal("🖶 Sem impressora", venda.ImpressoraTexto);

        await VenderGeloAsync(pdv, venda);
        Assert.DoesNotContain("não impresso", pdv.Texto("TextoMensagem") ?? string.Empty, StringComparison.Ordinal);
        Assert.Empty(transporte.Enviados);
        // Sem impressora, a gaveta "ligada" também não recebe nada (ela é pela impressora).
        Assert.Equal(0, pdv.Servicos.GetRequiredService<GavetaSimulada>().Aberturas);
        await using var db = Banco(pdv);
        var trabalho = await db.FilaImpressao.SingleAsync(f => f.TipoDocumento == "cupom", Ct);
        Assert.Equal(("cancelado", RepositorioImpressao.MensagemSemImpressora), (trabalho.Status, trabalho.UltimoErro));
        Assert.Equal(0, await pdv.Servicos.GetRequiredService<RepositorioImpressao>().ContarPendentesAsync(Ct));
    }

    [AvaloniaFact]
    public async Task Ctrl_Alt_C_testa_impressora_e_gaveta_e_grava_a_configuracao_com_auditoria()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Shell.IrParaLogin();
        await pdv.EsperarFocoAsync("CampoUsuario");

        // Ctrl+Alt+C: a Central pelo login com o PIN do CARLOS (Master), que tem pdv.config.terminal: a aba 3 abre editando.
        await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        var tela = await pdv.AbrirAbaHardwareAsync();
        Assert.True(tela.PodeRestaurarBackup);
        Assert.True(pdv.Controle<Button>("BotaoRestaurarBackup").IsVisible);
        // O build de desenvolvimento começa na simulada; a gaveta, desligada.
        Assert.Equal((int)TipoConexao.Simulada, tela.ConexaoIndice);
        Assert.False(tela.GavetaLigada);

        // Bematech no 58 mm: o teste sai com a régua de 32 colunas, os acentos e o QR.
        tela.ModeloIndice = 3;
        tela.PapelIndice = 1;
        pdv.Tecla(Key.F5);
        await pdv.EsperarAsync(() => tela.Mensagem is not null, "teste impresso");
        Assert.StartsWith(AbaHardwareViewModel.MensagemTesteEnviado, tela.Mensagem, StringComparison.Ordinal);
        var impresso = pdv.Servicos.GetRequiredService<ImpressoraArquivoSimulada>().UltimoTexto!;
        Assert.Contains(LayoutTesteImpressao.Acentos, impresso, StringComparison.Ordinal);
        Assert.Contains(LayoutTesteImpressao.Regua(32), impresso.Split('\n'));
        Assert.Contains("Modelo: Bematech MP-4200 TH", impresso, StringComparison.Ordinal);
        Assert.Contains("QR Code: imagem", impresso, StringComparison.Ordinal);
        pdv.Captura("50-configuracao-terminal");

        // Gaveta: o teste só com ela ligada (desligada, nada é enviado).
        pdv.Tecla(Key.F6);
        await pdv.EsperarAsync(() => tela.Erro is not null, "gaveta desligada");
        var gaveta = pdv.Servicos.GetRequiredService<GavetaSimulada>();
        Assert.Equal(0, gaveta.Aberturas);
        tela.GavetaLigada = true;
        pdv.Tecla(Key.F6);
        await pdv.EsperarAsync(() => gaveta.Aberturas == 1, "pulso de teste");
        // O pulso do teste é real: fica a auditoria gaveta_aberta (motivo do teste, quem liberou a tela), como no F11 › 9.
        await using (var db = Banco(pdv))
        {
            var abertura = await db.LogAuditoriaLocal.SingleAsync(a => a.Acao == "gaveta_aberta", Ct);
            Assert.Equal((ServicoGaveta.MotivoTeste, OperadoresDemonstracaoCarlos, OperadoresDemonstracaoCarlos, ServicoHardware.Localizacao),
                (abertura.Motivo, abertura.UsuarioId!.Value, abertura.AutorizadoPorId!.Value, abertura.Localizacao));
        }

        // A página que o modelo não tem é recusada; a válida grava as chaves e a auditoria com antes/depois.
        tela.PaginaIndice = 3;
        pdv.Tecla(Key.F2);
        await pdv.EsperarAsync(() => tela.Erro is not null, "página recusada");
        Assert.Contains("não tem a página WPC1252", tela.Erro, StringComparison.Ordinal);
        tela.PaginaIndice = 2;
        tela.PinoIndice = 1;
        tela.PulsoMs = "200";
        pdv.Tecla(Key.F2);
        await pdv.EsperarAsync(() => tela.Mensagem?.StartsWith(AbaHardwareViewModel.MensagemSalva, StringComparison.Ordinal) == true, "salva");
        var atual = pdv.Servicos.GetRequiredService<ServicoHardware>().Atual;
        Assert.Equal((ModeloImpressora.BematechMp4200Th, 32, PaginaCodigo.Cp850), (atual.Impressora.Modelo, atual.Impressora.Colunas, atual.Impressora.PaginaEfetiva));
        Assert.Equal(new ConfiguracaoGaveta(Ligada: true, Pino: 5, PulsoMs: 200), atual.Gaveta);
        Assert.Equal(32, pdv.Servicos.GetRequiredService<IImpressora>().Colunas);
        await using (var db = Banco(pdv))
        {
            var chaves = await db.ConfiguracaoTerminal.Where(c => c.Chave.StartsWith("impressora.") || c.Chave.StartsWith("gaveta."))
                .ToDictionaryAsync(c => c.Chave, c => c.Valor, Ct);
            Assert.Equal("\"bematech_mp4200th\"", chaves[ChavesHardware.Modelo]);
            Assert.Equal("32", chaves[ChavesHardware.Colunas]);
            Assert.Equal("\"cp850\"", chaves[ChavesHardware.Codepage]);
            Assert.Equal("\"impressora\"", chaves[ChavesHardware.GavetaModo]);
            var auditoria = await db.LogAuditoriaLocal.SingleAsync(a => a.Entidade == "configuracao_terminal", Ct);
            Assert.Equal("editar", auditoria.Acao);
            Assert.Equal(OperadoresDemonstracaoCarlos, auditoria.AutorizadoPorId);
            Assert.Equal(ServicoHardware.Localizacao, auditoria.Localizacao);
            Assert.Contains("\"impressora.modelo\":\"generica_escpos\"", auditoria.Antes, StringComparison.Ordinal);
            Assert.Contains("\"impressora.modelo\":\"bematech_mp4200th\"", auditoria.Depois, StringComparison.Ordinal);
        }

        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "3", "foco no menu");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "login");
    }

    private static readonly Guid OperadoresDemonstracaoCarlos = Guid.Parse("019a0003-0000-7000-8000-000000000002");

    [AvaloniaFact]
    public async Task F6_com_o_caixa_aberto_audita_a_gaveta_com_a_sessao_e_quem_liberou()
    {
        var transporte = new TransporteMemoria();
        using var pdv = await IniciarAsync(transporte);
        await pdv.AtivarDemonstracaoELogarAsync();
        await ConfigurarAsync(pdv, Rede());
        var venda = await VoltarParaVendaAsync(pdv);

        // F11 › 8 › 3 no meio do turno (CARLOS libera na aba); na tela, a gaveta marcada (ainda não salva) e o F6.
        await FuncaoAsync(pdv, Key.D8);
        await pdv.EsperarCentralAsync();
        var tela = await pdv.AbrirAbaHardwareAsync("2", "4321");
        tela.GavetaLigada = true;
        pdv.Tecla(Key.F6);
        await pdv.EsperarAsync(() => tela.Mensagem is not null, "pulso de teste");
        Assert.Equal(new byte[] { 0x1B, 0x70, 0x00, 0x3C, 0xFA }, Assert.Single(transporte.Enviados));
        await using (var db = Banco(pdv))
        {
            var abertura = await db.LogAuditoriaLocal.SingleAsync(a => a.Acao == "gaveta_aberta", Ct);
            Assert.Equal((ServicoGaveta.MotivoTeste, OperadoresDemonstracaoCarlos, pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixaId),
                (abertura.Motivo, abertura.AutorizadoPorId!.Value, abertura.RegistroId));
        }

        // A impressora que não responde: a auditoria do pedido fica, o aviso vai para a tela e o log local registra.
        transporte.Falhar = true;
        pdv.Tecla(Key.F6);
        await pdv.EsperarAsync(() => tela.Erro is not null, "gaveta não abriu");
        Assert.StartsWith("A gaveta não abriu", tela.Erro, StringComparison.Ordinal);
        await using (var db = Banco(pdv))
        {
            Assert.Equal(2, await db.LogAuditoriaLocal.CountAsync(a => a.Acao == "gaveta_aberta", Ct));
            Assert.Equal(1, await db.LogLocal.CountAsync(l => l.Origem == "gaveta", Ct));
        }
    }

    private static readonly Guid Pix = Guid.Parse("019a0004-0000-7000-8000-000000000103");

    /// <summary>PIX estático (com QR) para a loja de demonstração, e a loja com a chave PIX.</summary>
    private static Task PixNaLojaAsync(AmbienteUi pdv)
    {
        var agora = DateTimeOffset.UtcNow;
        return pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [
                new Data.Entidades.FormaPagamentoRegistro
                {
                    Id = Pix, Descricao = "PIX", Ordem = 3, TipoForma = "pix", MeioPagamentoFiscal = "20", Integracao = "pix_estatico",
                    GeraQrcodePix = true, LancaQuitada = true, CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
                new Data.Entidades.FormaPagamentoLojaRegistro { Id = Guid.CreateVersion7(), FormaPagamentoId = Pix, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
                new Data.Entidades.LojaRegistro
                {
                    Id = CatalogoDemonstracao.LojaDemonstracao, Codigo = 1, Nome = "Loja 1", RazaoSocial = "ICE BEER COMÉRCIO DE BEBIDAS LTDA",
                    NomeFantasia = "Ice Beer", Cnpj = "12345678000195", ChavePix = "pix@icebeer.com.br", PixNomeRecebedor = "ICE BEER",
                    PixCidadeRecebedor = "CURITIBA", Ativa = true, UsaPdv = true, CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
            ],
            Ct);
    }

    [AvaloniaFact]
    public async Task F4_do_pix_diz_o_que_aconteceu_e_a_cobranca_que_falhou_nunca_sai_depois_pelo_f7()
    {
        var transporte = new TransporteMemoria();
        using var pdv = await IniciarAsync(transporte);
        await pdv.AtivarDemonstracaoELogarAsync();
        await PixNaLojaAsync(pdv);
        await ConfigurarAsync(pdv, new ConfiguracaoImpressora { Conexao = TipoConexao.Nenhuma });
        var venda = await VoltarParaVendaAsync(pdv);
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        pagamento.EscolherFormaCommand.Execute("2");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoPagadorPix");
        var pix = Assert.IsType<DialogoPixViewModel>(venda.Dialogo);

        // Sem impressora: a tela diz que nada saiu (antes dizia "enviado à impressora").
        pdv.Tecla(Key.F4);
        await pdv.EsperarAsync(() => pix.AvisoImpressao is not null, "aviso sem impressora");
        Assert.Equal(ServicoVenda.MensagemPixSemImpressora, pix.AvisoImpressao);
        Assert.Empty(transporte.Enviados);

        // Com a impressora: o QR nativo da Epson com o BR Code do "copia e cola".
        await ConfigurarAsync(pdv, Rede());
        pix.AvisoImpressao = null;
        pdv.Tecla(Key.F4);
        await pdv.EsperarAsync(() => pix.AvisoImpressao is not null, "QR enviado");
        Assert.Equal("QR do PIX enviado à impressora.", pix.AvisoImpressao);
        var enviado = Assert.Single(transporte.Enviados);
        Assert.True(Contem(enviado, EscPos.Codificacao(860).GetBytes(pix.CopiaECola!)));
        Assert.True(Contem(enviado, [0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30]));

        // A impressora caiu: o aviso, e a cobrança fica cancelada — nem pendente no heartbeat, nem no F7 horas depois.
        transporte.Falhar = true;
        pix.AvisoImpressao = null;
        pdv.Tecla(Key.F4);
        pdv.Tecla(Key.F4);
        await pdv.EsperarAsync(() => pix.AvisoImpressao?.StartsWith("QR do PIX não impresso", StringComparison.Ordinal) == true, "QR não impresso");
        await using (var db = Banco(pdv))
        {
            var cobrancas = await db.FilaImpressao.Where(f => f.TipoDocumento == "cobranca_pix").OrderBy(f => f.CriadoEm).ToListAsync(Ct);
            Assert.InRange(cobrancas.Count, 3, 4);
            Assert.Equal(["cancelado", "impresso"], cobrancas.Select(c => c.Status).Distinct().Order(StringComparer.Ordinal));
            Assert.All(cobrancas.Where(c => c.Status == "cancelado").Skip(1), c => Assert.Contains("não respondeu", c.UltimoErro, StringComparison.Ordinal));
            // A ocorrência da aba 5 (bloco G8): o código do que não fica na fila — a dica não manda o F7, que não o imprime.
            var ocorrencias = await db.LogLocal.AsNoTracking().Where(l => l.Origem == OrigensOcorrencia.Impressora && l.Nivel == NiveisOcorrencia.Aviso)
                .ToListAsync(Ct);
            Assert.NotEmpty(ocorrencias);
            Assert.All(ocorrencias, o =>
            {
                Assert.Equal(CodigoOcorrencia.ImpressaoFalhouSemFila.Codigo, Ocorrencias.CodigoDe(o.Detalhes));
                Assert.StartsWith("QR do PIX não saiu na impressora:", o.Mensagem, StringComparison.Ordinal);
            });
            var dica = CatalogoOcorrencias.Dica(CodigoOcorrencia.ImpressaoFalhouSemFila.Codigo, null).OQueFazer;
            Assert.Contains("não sai pelo F7", dica, StringComparison.Ordinal);
            Assert.Contains("mostre a tela", dica, StringComparison.Ordinal);
        }

        var impressao = pdv.Servicos.GetRequiredService<ServicoImpressao>();
        Assert.Equal(0, await impressao.ContarPendentesAsync(Ct));
        transporte.Falhar = false;
        Assert.Equal((0, (string?)null), await impressao.ImprimirPendentesAsync(Ct));
        Assert.Single(transporte.Enviados);
    }

    [AvaloniaFact]
    public async Task Reimpressao_sem_impressora_avisa_que_a_segunda_via_ficou_so_na_tela()
    {
        var transporte = new TransporteMemoria();
        using var pdv = await IniciarAsync(transporte);
        await pdv.AtivarDemonstracaoELogarAsync();
        await ConfigurarAsync(pdv, new ConfiguracaoImpressora { Conexao = TipoConexao.Nenhuma });
        var venda = await VoltarParaVendaAsync(pdv);
        await VenderGeloAsync(pdv, venda);
        Guid paga;
        await using (var db = Banco(pdv))
        {
            paga = (await db.Vendas.SingleAsync(Ct)).Id;
        }

        var carlos = new LiberacaoConcedida(AutenticadorOperadorSimulado.Operadores.Single(o => o.Login == "carlos"), "Cliente pediu", DateTimeOffset.UtcNow);
        var (texto, avisos) = await pdv.Servicos.GetRequiredService<ServicoVenda>().ReimprimirAsync(paga, carlos, ct: Ct);
        Assert.Contains(LayoutComprovanteVendaMarca, texto, StringComparison.Ordinal);
        Assert.Equal([ServicoVenda.MensagemReimpressaoSemImpressora], avisos);
        Assert.Empty(transporte.Enviados);
    }

    private const string LayoutComprovanteVendaMarca = Fiscal.LayoutComprovanteVenda.MarcaReimpressao;

    [AvaloniaFact]
    public async Task Gaveta_ligada_sem_nos_movimentos_nao_abre_no_caixa_nem_no_troco_sem_a_forma_abrir_gaveta()
    {
        var transporte = new TransporteMemoria();
        using var pdv = await IniciarAsync(transporte);
        await pdv.AtivarDemonstracaoELogarAsync(fundo: "200");
        // O padrão até a confirmação do dono: ligada, mas sem "abre nos movimentos".
        await ConfigurarAsync(pdv, Rede(), new ConfiguracaoGaveta(Ligada: true));
        var venda = await VoltarParaVendaAsync(pdv);
        int Pulsos() => transporte.Enviados.Count(e => Contem(e, EscP));

        // Venda em dinheiro (forma "Abrir gaveta"): o único pulso.
        await VenderGeloAsync(pdv, venda);
        Assert.Equal(1, Pulsos());
        Guid paga;
        await using (var db = Banco(pdv))
        {
            paga = (await db.Vendas.SingleAsync(Ct)).Id;
        }

        // Sangria, reforço, o cancelamento da venda paga com devolução em dinheiro e o fechamento: nenhum ESC p.
        var caixa = pdv.Servicos.GetRequiredService<ServicoCaixa>();
        await caixa.RegistrarMovimentoAsync(new DadosMovimentoCaixa(Data.Entidades.TipoMovimentoCaixa.Sangria, 50m, null, "Gerente", null, null), null, Ct);
        await caixa.RegistrarMovimentoAsync(new DadosMovimentoCaixa(Data.Entidades.TipoMovimentoCaixa.Reforco, 20m, null, null, null, null), null, Ct);
        var carlos = new LiberacaoConcedida(AutenticadorOperadorSimulado.Operadores.Single(o => o.Login == "carlos"), "Cliente desistiu", DateTimeOffset.UtcNow);
        await pdv.Servicos.GetRequiredService<ServicoVenda>().CancelarFinalizadaAsync(paga, "Cliente desistiu depois de pagar", liberacao: carlos, ct: Ct);
        await using (var db = Banco(pdv))
        {
            Assert.Equal(1, await db.MovimentosCaixa.CountAsync(m => m.Tipo == Data.Entidades.TipoMovimentoCaixa.EstornoVenda, Ct));
        }

        // O troco sozinho não abre: a mesma venda com troco, com a forma Dinheiro sem "Abrir gaveta".
        await using (var db = Banco(pdv))
        {
            await db.FormasPagamento.Where(f => f.Id == ServicoVenda.Dinheiro.Id).ExecuteUpdateAsync(f => f.SetProperty(x => x.AbrirGaveta, false), Ct);
        }

        await VenderGeloAsync(pdv, venda);
        var preparado = await caixa.PrepararFechamentoAsync(ct: Ct);
        preparado.Fechamento.Contar(new Dictionary<Guid, decimal> { [preparado.Fechamento.Formas[0].Forma.Id] = 170m });
        await caixa.FecharAsync(preparado, preparado.Fechamento.Confirmar(zeraCaixa: true, null), null, sair: false, Ct);

        Assert.Equal(1, Pulsos());
        Assert.Equal(0, pdv.Servicos.GetRequiredService<GavetaSimulada>().Aberturas);
        // Os comprovantes saíram (a impressora está lá): só a gaveta ficou fechada.
        Assert.True(transporte.Enviados.Count >= 6);
    }

    [AvaloniaFact]
    public async Task F11_9_abre_a_gaveta_so_ligada_com_a_liberacao_e_o_motivo_auditados()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        var gaveta = pdv.Servicos.GetRequiredService<GavetaSimulada>();

        // Desligada: só o aviso, nada é enviado.
        await FuncaoAsync(pdv, Key.D9);
        Assert.Equal(ServicoGaveta.MensagemDesligada, pdv.Texto("TextoMensagem"));
        Assert.Equal(0, gaveta.Aberturas);

        // Ligada: MARIA não tem pdv.gaveta.abrir_avulsa; CARLOS libera, o motivo vem da liberação e o Enter abre.
        await pdv.LigarGavetaAsync();
        await FuncaoAsync(pdv, Key.D9);
        await LiberarAsync(pdv, venda, "Troco para o caixa ao lado");
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoAbrirGavetaViewModel, "motivo da gaveta");
        await pdv.EsperarFocoAsync("CampoMotivoGaveta");
        var dialogo = Assert.IsType<DialogoAbrirGavetaViewModel>(venda.Dialogo);
        Assert.Equal("Troco para o caixa ao lado", dialogo.Motivo);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "gaveta aberta");
        Assert.Equal(1, gaveta.Aberturas);
        Assert.Equal("Gaveta aberta.", pdv.Texto("TextoMensagem"));
        await using var db = Banco(pdv);
        var auditoria = await db.LogAuditoriaLocal.SingleAsync(a => a.Acao == "gaveta_aberta", Ct);
        Assert.Equal((OperadoresDemonstracaoCarlos, "Troco para o caixa ao lado", "gaveta"), (auditoria.AutorizadoPorId!.Value, auditoria.Motivo, auditoria.Entidade));
        Assert.Equal(pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixaId, auditoria.RegistroId);
    }
}
