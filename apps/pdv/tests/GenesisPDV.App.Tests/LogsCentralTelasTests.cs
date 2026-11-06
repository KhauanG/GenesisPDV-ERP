using System.Text;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.App.Servicos.Diagnostico.Verificacoes;
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
/// Aba 5 Logs e ocorrências da Central do PDV (bloco G8; README › decisão 73): o "pronto quando" do plano — o erro de
/// impressão de ontem aparece com a dica do que fazer —; a operadora que vê a aba só pela liberação (o
/// <c>central_acessada</c> gravado e nada mais); o F6 até "Ontem", o detalhe com o código e o que fazer, a busca pelo
/// texto; o F3 para o arquivo técnico do dia com a exceção inteira e mascarada; tudo pelo mouse também, com os botões de
/// 44 px em 1024 × 700; o "Erros recentes" do Painel de saúde que abre a aba já nos erros das últimas 24 h (depois do PIN
/// do supervisor); e a liberação que acaba, que esvazia a aba.
/// </summary>
public class LogsCentralTelasTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    /// <summary>A "impressora de rede" do teste: com <see cref="Falhar"/>, recusa como a desligada.</summary>
    private sealed class TransporteMemoria : ITransporteImpressora
    {
        public bool Falhar { get; set; }

        public Task EnviarAsync(byte[] dados, CancellationToken ct = default) =>
            Falhar ? throw new FalhaImpressoraException("Impressora de rede 192.168.0.50:9100 não respondeu.") : Task.CompletedTask;
    }

    private sealed class Tempo : TimeProvider
    {
        private long _ticks = 1;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => _ticks;

        public void Avancar(TimeSpan tempo) => _ticks += tempo.Ticks;
    }

    /// <summary>Gelo (12,90) pago com 20,00 em dinheiro.</summary>
    private static async Task VenderAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
    }

    /// <summary>O ENCARREGADO libera a aba pedida (o cadeado da operadora).</summary>
    private static async Task LiberarAsync(AmbienteUi pdv, CentralPdvViewModel central)
    {
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "encarregado";
        central.PinLiberacao = AutenticadorComExtras.PinEncarregado;
        pdv.Tecla(Key.Enter);
    }

    [AvaloniaFact]
    public async Task Erro_de_impressao_de_ontem_aparece_com_a_dica_e_o_arquivo_tecnico_mostra_a_excecao_mascarada()
    {
        var transporte = new TransporteMemoria();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s =>
        {
            AutenticadorComExtras.Registrar(s);
            s.AddSingleton<FabricaTransporteImpressora>(_ => transporte);
        });
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await pdv.Servicos.GetRequiredService<ServicoHardware>().GravarAsync(
            new ConfiguracaoHardware(new ConfiguracaoImpressora { Modelo = ModeloImpressora.EpsonTmT20, Conexao = TipoConexao.Rede, Endereco = "192.168.0.50" },
                new ConfiguracaoGaveta()), null, null, Ct);
        transporte.Falhar = true;
        await VenderAsync(pdv, venda);

        // A falha da impressão virou uma ocorrência (bloco G8): o código, a origem e o documento ligado, sem o conteúdo.
        Guid vendaId;
        await using (var db = Banco(pdv))
        {
            vendaId = (await db.Vendas.AsNoTracking().SingleAsync(Ct)).Id;
            var ocorrencia = await db.LogLocal.AsNoTracking().SingleAsync(l => l.Origem == OrigensOcorrencia.Impressora && l.Nivel == NiveisOcorrencia.Aviso, Ct);
            Assert.Equal(CodigoOcorrencia.ImpressaoFalhou.Codigo, Ocorrencias.CodigoDe(ocorrencia.Detalhes));
            Assert.StartsWith("Cupom da venda não saiu na impressora: ", ocorrencia.Mensagem, StringComparison.Ordinal);
            Assert.Contains("não respondeu", ocorrencia.Mensagem, StringComparison.Ordinal);
            Assert.Contains(vendaId.ToString(), ocorrencia.Detalhes, StringComparison.Ordinal);
            // A gravação da configuração também ficou (info), para o "parou depois que mudaram a configuração".
            Assert.Equal(1, await db.LogLocal.CountAsync(l => l.Detalhes!.Contains(CodigoOcorrencia.ConfiguracaoAlterada.Codigo), Ct));
            // "Ontem": a falha de impressão de ontem do critério de aceite.
            var falha = await db.LogLocal.SingleAsync(l => l.Id == ocorrencia.Id, Ct);
            falha.OcorridoEm = falha.OcorridoEm.AddDays(-1);
            await db.SaveChangesAsync(Ct);
        }

        // O arquivo técnico de hoje, como o Serilog grava, com uma exceção que leva um token (o mascarador o esconde).
        var agora = DateTimeOffset.Now;
        File.WriteAllText(Path.Combine(pdv.Caminhos.PastaLogs, $"{ConfiguracaoLog.PrefixoArquivo}{agora:yyyyMMdd}.log"),
            $"{agora.AddMinutes(-2):yyyy-MM-dd HH:mm:ss.fff zzz} [INF] cx1-0000abcd GenesisPDV.App.Servicos.ServicoVenda Venda finalizada\n"
            + $"{agora.AddMinutes(-1):yyyy-MM-dd HH:mm:ss.fff zzz} [ERR] cx1-0000abcd GenesisPDV.Sync.Cliente.ServicoSincronizacaoHttp Push falhou\n"
            + "System.Net.Http.HttpRequestException: 401 (Bearer abc.def.ghi)\n   at GenesisPDV.Sync.Cliente.ClienteSyncHttp.EnviarAsync()\n",
            new UTF8Encoding(false));
        int linhasDoLog;
        await using (var db = Banco(pdv))
        {
            linhasDoLog = await db.LogLocal.CountAsync(Ct);
        }

        // A MARIA não vê o diagnóstico: o 5 com o cadeado pede o supervisor; o ENCARREGADO libera e a aba abre no texto.
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();
        Assert.True(central.Abas.Single(a => a.Codigo == "5").Bloqueada);
        pdv.Tecla(Key.D5);
        await LiberarAsync(pdv, central);
        await pdv.EsperarAsync(() => central.Conteudo is AbaLogsViewModel, "aba 5 Logs e ocorrências");
        var aba = (AbaLogsViewModel)central.Conteudo!;
        await aba.Atualizacao;
        await pdv.EsperarFocoAsync("CampoFiltroLogs");
        Assert.True(aba.EmOcorrencias);
        Assert.Equal((int)PeriodoOcorrencias.Ultimos7Dias, aba.PeriodoIndice);
        Assert.Contains(aba.Linhas, l => l.Resumo == "Documento não impresso");
        Assert.Contains(aba.Linhas, l => l.Resumo == "Configuração do caixa alterada");

        // F6 até "Ontem": só o erro de impressão de ontem, com a dica.
        while (aba.PeriodoIndice != (int)PeriodoOcorrencias.Ontem)
        {
            pdv.Tecla(Key.F6);
        }

        await aba.Atualizacao;
        var linha = Assert.Single(aba.Linhas);
        Assert.Equal(("Impressora", "AVISO", "Documento não impresso", true), (linha.Origem, linha.NivelRotulo, linha.Resumo, linha.EhAviso));
        Assert.Contains("não respondeu", linha.Mensagem, StringComparison.Ordinal);
        pdv.Captura("80-central-logs-ocorrencias");

        // Enter: o detalhe com o código, o documento e o que fazer (o F7 da aba 3); Esc volta ao campo.
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe da ocorrência");
        await pdv.EsperarFocoAsync("PainelDetalheLogs");
        Assert.Contains(aba.LinhasDetalhe, l => l.Contains("código: IMPRESSAO_FALHOU", StringComparison.Ordinal));
        Assert.Contains(aba.LinhasDetalhe, l => l == "  tipo_impressao: cupom");
        Assert.Contains($"  referencia_id: {vendaId}", aba.LinhasDetalhe);
        Assert.Contains("F7 imprime de novo", aba.OQueFazer, StringComparison.Ordinal);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => !aba.MostrandoDetalhe, "volta à lista");
        await pdv.EsperarFocoAsync("CampoFiltroLogs");

        // A busca pelo texto, sem diferença de acento nem de maiúscula (como no arquivo técnico) e também pelo título da dica
        // (a coluna "Resumo"); e o F8 que limpa.
        pdv.Digitar("192.168.0.50");
        await aba.Atualizacao;
        Assert.Single(aba.Linhas);
        aba.Texto = "NAO RESPONDEU";
        await aba.Atualizacao;
        Assert.StartsWith("Cupom da venda não saiu na impressora", Assert.Single(aba.Linhas).Mensagem, StringComparison.Ordinal);
        aba.Texto = "documento nao impresso";
        await aba.Atualizacao;
        Assert.Single(aba.Linhas);
        // Shift+F6 volta um período (de "Ontem" a "Hoje", onde a falha de ontem não está) e o F6 vai de novo a "Ontem".
        pdv.Tecla(Key.F6, RawInputModifiers.Shift);
        await aba.Atualizacao;
        Assert.Equal(((int)PeriodoOcorrencias.Hoje, 0), (aba.PeriodoIndice, aba.Linhas.Count));
        pdv.Tecla(Key.F6);
        await aba.Atualizacao;
        Assert.Single(aba.Linhas);
        pdv.Tecla(Key.F8);
        await aba.Atualizacao;
        Assert.Equal((string.Empty, (int)PeriodoOcorrencias.Ultimos7Dias), (aba.Texto, aba.PeriodoIndice));
        Assert.True(aba.Linhas.Count >= 2);

        // F3: o arquivo técnico de hoje, o mais novo primeiro; a exceção inteira no detalhe, com o token mascarado.
        pdv.Tecla(Key.F3);
        await pdv.EsperarAsync(() => aba.NoArquivo, "arquivo técnico");
        await aba.Atualizacao;
        Assert.Equal(["Push falhou", "Venda finalizada"], aba.Linhas.Select(l => l.Mensagem));
        Assert.Equal(("ERRO", "ServicoSincronizacaoHttp", "+2 linhas (Enter)"), (aba.Linhas[0].NivelRotulo, aba.Linhas[0].Origem, aba.Linhas[0].Resumo));
        pdv.Tecla(Key.Multiply);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe do registro");
        Assert.Contains("System.Net.Http.HttpRequestException: 401", aba.TextoTecnico, StringComparison.Ordinal);
        Assert.DoesNotContain("abc.def.ghi", aba.TextoTecnico, StringComparison.Ordinal);
        Assert.Null(aba.OQueFazer);
        pdv.Clicar(pdv.Controle<Button>("BotaoVoltarDetalheLogs"));
        await pdv.EsperarAsync(() => !aba.MostrandoDetalhe, "volta à lista pelo mouse");
        // F4 (nível): só erros.
        pdv.Tecla(Key.F4);
        pdv.Tecla(Key.F4);
        await aba.Atualizacao;
        Assert.Equal(["Push falhou"], aba.Linhas.Select(l => l.Mensagem));

        // Pelo mouse em 1024 × 700: as fontes e as ações, todas com 44 px.
        pdv.Janela.Width = 1024;
        pdv.Janela.Height = 700;
        pdv.Clicar(pdv.Controle<Button>("BotaoFonteOcorrencias"));
        await pdv.EsperarAsync(() => aba.EmOcorrencias, "ocorrências pelo mouse");
        await aba.Atualizacao;
        foreach (var nome in new[] { "BotaoFonteOcorrencias", "BotaoFonteArquivo", "BotaoDetalheLogs", "BotaoProximaPaginaLogs", "BotaoNivelLogs", "BotaoPeriodoLogs", "BotaoLimparFiltrosLogs" })
        {
            Assert.True(pdv.Controle<Button>(nome).Bounds.Height >= 44, nome);
        }

        pdv.Clicar(pdv.Controle<Button>("BotaoNivelLogs"));
        await aba.Atualizacao;
        Assert.Equal(0, aba.NivelIndice);

        // Esc volta ao menu; olhar não gravou nada no log local (o acesso fica na auditoria: central_acessada e liberacao).
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "5", "menu na aba 5");
        await using (var db = Banco(pdv))
        {
            Assert.Equal(linhasDoLog, await db.LogLocal.CountAsync(Ct));
            Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(a => a.Acao == "central_acessada", Ct));
        }
    }

    [AvaloniaFact]
    public async Task Erros_recentes_do_painel_abrem_a_aba_nos_erros_de_24h_e_a_liberacao_que_acaba_esvazia_a_aba()
    {
        var tempo = new Tempo();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s =>
        {
            AutenticadorComExtras.Registrar(s);
            s.AddSingleton<TimeProvider>(tempo);
        });
        await pdv.AtivarDemonstracaoELogarAsync();
        var terminal = pdv.Servicos.GetRequiredService<RepositorioTerminal>();
        await terminal.RegistrarOcorrenciaAsync(NiveisOcorrencia.Erro, CodigoOcorrencia.ErroInesperado, "Object reference not set (cliente 123.456.789-09)", ct: Ct);
        await terminal.RegistrarOcorrenciaAsync(NiveisOcorrencia.Aviso, CodigoOcorrencia.GavetaFalhou, "A gaveta não abriu", ct: Ct);

        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();
        var painel = (AbaPainelViewModel)central.Conteudo!;
        await pdv.EsperarAsync(() => !painel.Verificando && painel.Linhas.Any(l => l.Codigo == "erros" && !l.Ok), "erros recentes no Painel");
        var erros = painel.Linhas.Single(l => l.Codigo == "erros");
        Assert.Equal(VerificacaoErros.FiltroErrosRecentes, erros.Item.Acao!.Filtro);

        // O botão da linha: a aba 5 com o cadeado pede o supervisor; depois do PIN, abre já filtrada.
        await painel.ExecutarAcaoCommand.ExecuteAsync(erros);
        Assert.True(central.Liberando);
        await LiberarAsync(pdv, central);
        await pdv.EsperarAsync(() => central.Conteudo is AbaLogsViewModel, "aba 5 pelo Painel");
        var aba = (AbaLogsViewModel)central.Conteudo!;
        await pdv.EsperarAsync(() => aba.NivelIndice == 2 && aba.PeriodoIndice == (int)PeriodoOcorrencias.Ultimas24Horas, "filtro dos erros de 24 h");
        await aba.Atualizacao;
        var linha = Assert.Single(aba.Linhas);
        Assert.Equal(("Sistema", "ERRO"), (linha.Origem, linha.NivelRotulo));
        // O CPF que a exceção trouxe fica mascarado na lista (o Painel nem mostra o texto; a aba 5 mostra mascarado).
        Assert.DoesNotContain("123.456.789-09", linha.Mensagem, StringComparison.Ordinal);
        Assert.Contains("Painel de saúde", aba.Mensagem, StringComparison.Ordinal);
        // Outro filtro (F4, todos os níveis): o aviso dos "erros das últimas 24 h" não vale mais e sai; Shift+F4 volta a "Só erros".
        pdv.Tecla(Key.F4);
        await aba.Atualizacao;
        Assert.Equal((0, (string?)null), (aba.NivelIndice, aba.Mensagem));
        Assert.True(aba.Linhas.Count >= 2);
        pdv.Tecla(Key.F4, RawInputModifiers.Shift);
        await aba.Atualizacao;
        Assert.Equal(2, aba.NivelIndice);
        Assert.Single(aba.Linhas);

        // Com a liberação ativa a aba abre sem o cadeado: o botão do Painel leva direto ao filtro, sem pedir o PIN de novo.
        aba.PeriodoIndice = (int)PeriodoOcorrencias.Tudo;
        await aba.Atualizacao;
        Assert.Null(aba.Mensagem);
        await painel.ExecutarAcaoCommand.ExecuteAsync(erros);
        Assert.False(central.Liberando);
        await aba.Atualizacao;
        Assert.Same(aba, central.Conteudo);
        Assert.Equal((2, (int)PeriodoOcorrencias.Ultimas24Horas), (aba.NivelIndice, aba.PeriodoIndice));
        Assert.Contains("Painel de saúde", aba.Mensagem, StringComparison.Ordinal);
        Assert.Single(aba.Linhas);

        // A liberação acaba (5 min sem uso): a Central volta ao Painel e a aba guardada fica vazia.
        tempo.Avancar(AcessoCentral.ValidadeLiberacao + TimeSpan.FromSeconds(1));
        central.Atualizar();
        Assert.IsType<AbaPainelViewModel>(central.Conteudo);
        Assert.Empty(aba.Linhas);
        Assert.False(aba.MostrandoDetalhe);
        await Assert.ThrowsAsync<Core.Comum.RegraNegocioException>(() =>
            pdv.Servicos.GetRequiredService<ServicoLogsCentral>().OcorrenciasAsync(new FiltroOcorrencias(), ct: Ct));
    }

    [AvaloniaFact]
    public async Task Busca_que_a_mascara_esvaziaria_enche_a_pagina_e_o_rodape_conta_as_linhas_mostradas()
    {
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: AutenticadorComExtras.Registrar);
        await pdv.AtivarDemonstracaoELogarAsync();
        // As 70 mais novas têm o termo só no token (a máscara esconde); as 55 mais antigas, à vista.
        var agora = DateTimeOffset.Now;
        await using (var db = Banco(pdv))
        {
            db.LogLocal.AddRange(Enumerable.Range(0, 55).Select(i => Ocorrencias.Nova(
                agora.AddHours(-2).AddMinutes(-i), NiveisOcorrencia.Aviso, CodigoOcorrencia.ComandoFalhou, $"visível {i:00} no arquivo XYZSECRETO.log")));
            db.LogLocal.AddRange(Enumerable.Range(0, 70).Select(i => Ocorrencias.Nova(
                agora.AddMinutes(-i), NiveisOcorrencia.Aviso, CodigoOcorrencia.ComandoFalhou, $"escondida {i:00} token: XYZSECRETO")));
            await db.SaveChangesAsync(Ct);
        }

        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();
        pdv.Tecla(Key.D5);
        await LiberarAsync(pdv, central);
        await pdv.EsperarAsync(() => central.Conteudo is AbaLogsViewModel, "aba 5 Logs e ocorrências");
        var aba = (AbaLogsViewModel)central.Conteudo!;
        await aba.Atualizacao;

        // Antes vinha "Nenhuma ocorrência" com o PgDn aceso; agora a página vem cheia das que se veem.
        aba.Texto = "xyzsecreto";
        await aba.Atualizacao;
        Assert.Equal(50, aba.Linhas.Count);
        Assert.All(aba.Linhas, l => Assert.StartsWith("visível", l.Mensagem, StringComparison.Ordinal));
        Assert.Equal("Ocorrências 1 a 50 · página 1 · PgDn mais antigos", aba.Rodape);
        pdv.Tecla(Key.PageDown);
        await aba.Atualizacao;
        Assert.Equal(5, aba.Linhas.Count);
        Assert.Equal("Ocorrências 51 a 55 · página 2", aba.Rodape);
        Assert.False(aba.TemProxima);
        pdv.Tecla(Key.PageUp);
        await aba.Atualizacao;
        Assert.Equal("Ocorrências 1 a 50 · página 1 · PgDn mais antigos", aba.Rodape);

        // O termo que só existe escondido responde como o que não existe: nenhuma, sem o PgDn aceso.
        aba.Texto = "token: XYZSECRETO";
        await aba.Atualizacao;
        Assert.Empty(aba.Linhas);
        Assert.Equal(("Nenhuma ocorrência com esses filtros.", false), (aba.Rodape, aba.TemProxima));
    }

    [AvaloniaFact]
    public async Task Nova_tentativa_da_fila_que_para_grava_a_ocorrencia_com_a_dica_do_F7()
    {
        var transporte = new TransporteMemoria();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<FabricaTransporteImpressora>(_ => transporte));
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await pdv.Servicos.GetRequiredService<ServicoHardware>().GravarAsync(
            new ConfiguracaoHardware(new ConfiguracaoImpressora { Modelo = ModeloImpressora.EpsonTmT20, Conexao = TipoConexao.Rede, Endereco = "192.168.0.50" },
                new ConfiguracaoGaveta()), null, null, Ct);
        transporte.Falhar = true;
        await VenderAsync(pdv, venda);

        // O F7 da aba 3 (o mesmo serviço) com a impressora ainda desligada: para no cupom e grava a ocorrência da fila.
        var impressao = pdv.Servicos.GetRequiredService<ServicoImpressao>();
        var (impressos, erro) = await impressao.ImprimirPendentesAsync(Ct);
        Assert.Equal(0, impressos);
        Assert.Contains("não respondeu", erro, StringComparison.Ordinal);
        await using (var db = Banco(pdv))
        {
            var paradas = (await db.LogLocal.AsNoTracking().Where(l => l.Origem == OrigensOcorrencia.Impressora).ToListAsync(Ct))
                .Where(l => Ocorrencias.CodigoDe(l.Detalhes) == CodigoOcorrencia.FilaImpressaoParou.Codigo)
                .ToList();
            var parada = Assert.Single(paradas);
            Assert.Equal(NiveisOcorrencia.Aviso, parada.Nivel);
            Assert.StartsWith("Nova tentativa da fila parou (0 impressos): ", parada.Mensagem, StringComparison.Ordinal);
            Assert.Contains("não respondeu", parada.Mensagem, StringComparison.Ordinal);
        }

        var dica = CatalogoOcorrencias.Dica(CodigoOcorrencia.FilaImpressaoParou.Codigo, OrigensOcorrencia.Impressora);
        Assert.Equal("A fila de impressão parou", dica.Titulo);
        Assert.Contains("F7", dica.OQueFazer, StringComparison.Ordinal);

        // A impressora voltou: o F7 imprime o que ficou e não grava outra parada.
        transporte.Falhar = false;
        Assert.Equal((1, (string?)null), await impressao.ImprimirPendentesAsync(Ct));
        await using (var db = Banco(pdv))
        {
            var codigos = (await db.LogLocal.AsNoTracking().Where(l => l.Origem == OrigensOcorrencia.Impressora).ToListAsync(Ct))
                .Select(l => Ocorrencias.CodigoDe(l.Detalhes));
            Assert.Single(codigos, c => c == CodigoOcorrencia.FilaImpressaoParou.Codigo);
        }
    }
}
