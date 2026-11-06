using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.VisualTree;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.App.ViewModels;
using GenesisPDV.App.ViewModels.Central;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// O Painel de saúde e o Sobre o terminal na Central do PDV, e o disco quase cheio na abertura do caixa (bloco G4; plano
/// 4.1; README › decisão 69), no terminal de demonstração: o operador (sem PIN, PC-7) vê o item vermelho com o que fazer e
/// o código do terminal; o ícone ⚠ da barra da venda abre a Central no Painel; o botão e o Enter da linha levam à aba
/// certa; o Sobre copia o código; com menos de 200 MB livres o caixa não abre sessão nova sem o supervisor, que libera por
/// 1 h (auditado), e a venda em curso nunca é bloqueada.
/// </summary>
public class PainelSaudeTelasTests
{
    private const long MB = 1024L * 1024;
    private static readonly Guid Maria = Guid.Parse("019a0003-0000-7000-8000-000000000001");
    private static readonly Guid Carlos = Guid.Parse("019a0003-0000-7000-8000-000000000002");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    /// <summary>O PDV com o espaço livre do disco à mão (<paramref name="disco"/>) e o relógio monotônico da liberação de 1 h.</summary>
    private static Task<AmbienteUi> IniciarAsync(Disco disco, Tempo? tempo = null) => AmbienteUi.IniciarAsync(ajustar: s =>
    {
        s.AddSingleton(sp => new MedidorDisco(sp.GetRequiredService<CaminhosPdv>(), _ => disco.Livre));
        if (tempo is not null)
        {
            s.AddSingleton<TimeProvider>(tempo);
        }
    });

    private static Task<List<LogAuditoriaLocal>> LiberacoesAsync(AmbienteUi pdv)
    {
        using var db = Banco(pdv);
        return db.LogAuditoriaLocal.AsNoTracking().Where(a => a.Acao == "liberacao").ToListAsync(Ct);
    }

    [AvaloniaFact]
    public async Task Operador_ve_o_vermelho_com_o_que_fazer_e_o_icone_da_barra_abre_o_painel()
    {
        var disco = new Disco();
        using var pdv = await IniciarAsync(disco);
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        var verificador = pdv.Servicos.GetRequiredService<VerificadorSaude>();

        // Tudo bem: o ícone não aparece.
        await verificador.VerificarAsync(completa: false, Ct);
        await pdv.EsperarAsync(() => venda.SaudeTexto is null, "sem ícone");
        Assert.False(pdv.Controle<Button>("BotaoSaude").IsVisible);

        // O disco cai para 150 MB e um comprovante falha na impressora: a rodada do minuto acende o ícone na barra.
        disco.Livre = 150 * MB;
        var fila = pdv.Servicos.GetRequiredService<RepositorioImpressao>();
        await fila.MarcarResultadoAsync(await fila.EnfileirarAsync("cupom", null, [0x41], ct: Ct), impresso: false, "sem papel", Ct);
        await verificador.VerificarAsync(completa: false, Ct);
        await pdv.EsperarAsync(() => venda.SaudeTexto == "⚠ 2 problemas", "ícone na barra");
        Assert.Contains("Disco: Disco quase cheio", venda.SaudeDica, StringComparison.Ordinal);
        Assert.True(pdv.Controle<Button>("BotaoSaude").IsVisible);

        // O clique (o mouse) abre a Central no Painel, já verificado, sem PIN (PC-7): o vermelho primeiro, com o que fazer.
        pdv.Clicar(pdv.Controle<Button>("BotaoSaude"));
        var central = await pdv.EsperarCentralAsync();
        var painel = Assert.IsType<AbaPainelViewModel>(central.Conteudo);
        await pdv.EsperarAsync(() => !painel.Verificando && painel.Linhas.Count == 12, "Painel verificado");
        Assert.Equal(["disco", "impressora"], painel.Linhas.Where(l => l.Problema).Select(l => l.Codigo).Order(StringComparer.Ordinal));
        Assert.True(painel.Linhas[0].Problema && painel.Linhas[1].Problema);
        var linhaDisco = painel.Linhas.Single(l => l.Codigo == "disco");
        Assert.StartsWith("O que fazer: Apague arquivos", linhaDisco.OQueFazer, StringComparison.Ordinal);
        Assert.StartsWith("2 problemas", painel.Resumo, StringComparison.Ordinal);
        var codigo = pdv.Servicos.GetRequiredService<SessaoTerminal>().Identidade!.CodigoCurto;
        Assert.Equal($"Código do terminal para o suporte: {codigo}", pdv.Texto("TextoCodigoTerminalPainel"));
        // O demonstração não tem nuvem: verde, e nada a sincronizar.
        Assert.True(painel.Linhas.Single(l => l.Codigo == "sincronizacao").Ok);
        pdv.Captura("62-central-painel-saude");

        // O 0 de novo leva o foco à lista; ↓ escolhe a linha da impressora; o Enter faz a ação dela (a aba 3, que pede
        // ela mesma quem pode configurar o terminal).
        Assert.Equal("0", pdv.AbaFocada());
        pdv.Tecla(Key.D0);
        await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is ListBoxItem, "foco na lista do Painel");
        while (painel.Selecionada?.Codigo != "impressora")
        {
            pdv.Tecla(Key.Down);
        }

        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => central.Conteudo is AbaHardwareViewModel, "aba 3 pela linha do Painel");
        Assert.Equal("3", central.AbaSelecionada!.Codigo);
        await pdv.EsperarFocoAsync("CampoUsuarioConfig");

        // De volta ao Painel pelo menu; F5 verifica de novo e Ctrl+Alt+S avisa que a demonstração não sincroniza.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "3", "menu");
        pdv.Clicar(pdv.BotaoDaAba("0"));
        await pdv.EsperarAsync(() => central.Conteudo is AbaPainelViewModel, "Painel de novo");
        pdv.Tecla(Key.D0);
        await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is ListBoxItem, "foco na lista");
        pdv.Tecla(Key.S, RawInputModifiers.Control | RawInputModifiers.Alt);
        Assert.Equal("Terminal de demonstração: nada sobe nem desce.", painel.Mensagem);
        disco.Livre = 50_000 * MB;
        pdv.Clicar(pdv.Controle<Button>("BotaoVerificarPainel"));
        await pdv.EsperarAsync(() => !painel.Verificando && painel.Linhas.Single(l => l.Codigo == "disco").Ok, "disco verde depois do F5");
        Assert.Null(painel.Mensagem);

        // Esc da lista volta ao menu; o Esc do menu, à venda. Olhar o Painel não grava nada.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "0", "foco no menu");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "venda");
        await using var db = Banco(pdv);
        Assert.False(await db.LogAuditoriaLocal.AnyAsync(a => a.Acao == AcessoCentral.AcaoCentralAcessada || a.Acao == "liberacao", Ct));
    }

    [AvaloniaFact]
    public async Task Caixa_aberto_ha_muito_tempo_e_backup_velho_aparecem_no_painel()
    {
        using var pdv = await IniciarAsync(new Disco());
        await pdv.AtivarDemonstracaoELogarAsync();
        var verificador = pdv.Servicos.GetRequiredService<VerificadorSaude>();
        var resultado = await verificador.VerificarAsync(ct: Ct);
        Assert.Equal(NivelSaude.Ok, resultado.Itens.Single(i => i.Codigo == "caixa").Nivel);

        // Aberto há 30 h, no mesmo dia operacional (24 h é o padrão de pdv.horas_alerta_sessao): amarelo.
        await using (var db = Banco(pdv))
        {
            var sessao = await db.SessoesCaixa.SingleAsync(Ct);
            sessao.AbertaEm = sessao.AbertaEm.AddHours(-30);
            (await db.IdentidadeTerminal.SingleAsync(Ct)).UltimoBackupEm = DateTimeOffset.UtcNow.AddHours(-5);
            await db.SaveChangesAsync(Ct);
        }

        resultado = await verificador.VerificarAsync(ct: Ct);
        var caixa = resultado.Itens.Single(i => i.Codigo == "caixa");
        Assert.Equal(NivelSaude.Aviso, caixa.Nivel);
        Assert.StartsWith("Caixa aberto há 30 h", caixa.Frase, StringComparison.Ordinal);
        Assert.Contains("F11 › 3", caixa.OQueFazer, StringComparison.Ordinal);
        // Caixa aberto e o último backup há 5 h (o periódico é a cada 2 h): amarelo.
        Assert.Equal(NivelSaude.Aviso, resultado.Itens.Single(i => i.Codigo == "backup").Nivel);

        // De um dia operacional anterior: vermelho.
        await using (var db = Banco(pdv))
        {
            var sessao = await db.SessoesCaixa.SingleAsync(Ct);
            sessao.DiaOperacional = sessao.DiaOperacional.AddDays(-1);
            await db.SaveChangesAsync(Ct);
        }

        resultado = await verificador.VerificarAsync(ct: Ct);
        Assert.Equal(NivelSaude.Problema, resultado.Itens.Single(i => i.Codigo == "caixa").Nivel);
        Assert.Equal("caixa", resultado.Itens[0].Codigo);
    }

    [AvaloniaFact]
    public async Task Sobre_o_terminal_mostra_o_codigo_e_copia_para_o_suporte()
    {
        using var pdv = await IniciarAsync(new Disco());
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();

        // O 9 sem PIN (PC-7): empresa, loja, caixa, o código e o id completo, a versão, o banco e as pastas.
        pdv.Tecla(Key.D9);
        await pdv.EsperarAsync(() => central.Conteudo is AbaSobreViewModel { Carregando: false, Linhas.Count: > 0 }, "Sobre carregado");
        var sobre = (AbaSobreViewModel)central.Conteudo!;
        var identidade = pdv.Servicos.GetRequiredService<SessaoTerminal>().Identidade!;
        var linhas = sobre.Linhas.ToDictionary(l => l.Rotulo, l => l.Valor);
        Assert.Equal(identidade.CodigoCurto, linhas["Código do terminal"]);
        Assert.Equal(identidade.TerminalId.ToString(), linhas["Identificador completo"]);
        Assert.StartsWith("Demonstração", linhas["Servidor"], StringComparison.Ordinal);
        Assert.Equal(VersaoApp.Atual, linhas["Versão do GenesisPDV"]);
        Assert.Contains("migrações · a última: ", linhas["Versão do banco local"], StringComparison.Ordinal);
        Assert.Contains("pdv.db", linhas["Banco local"], StringComparison.Ordinal);
        Assert.Equal(identidade.CodigoCurto, pdv.Texto("TextoCodigoTerminalSobre"));
        Assert.DoesNotContain(sobre.Linhas, l => l.Valor.Contains("token", StringComparison.OrdinalIgnoreCase));
        pdv.Captura("63-central-sobre");

        // O 9 de novo leva o foco à aba; Enter copia (ou, sem área de transferência, diz o código a ditar).
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "9", "foco no menu, na aba 9");
        pdv.Tecla(Key.D9);
        await pdv.EsperarFocoAsync(Views.Central.AbaSobreView.NomeTela);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => sobre.Mensagem is not null, "copiado");
        Assert.Contains(identidade.CodigoCurto, sobre.Mensagem, StringComparison.Ordinal);
        Assert.StartsWith($"{identidade.CodigoCurto} · terminal {identidade.TerminalId} · GenesisPDV ", sobre.TextoParaCopiar, StringComparison.Ordinal);

        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "9", "menu");

        // O Enter antes de terminar de carregar copia o código certo (da identidade em memória), nunca um texto vazio.
        var antes = new AbaSobreViewModel(pdv.Shell, () => Task.CompletedTask);
        Assert.Empty(antes.Linhas);
        Assert.Equal(sobre.TextoParaCopiar, antes.TextoParaCopiar);
    }

    [AvaloniaFact]
    public async Task Disco_quase_cheio_bloqueia_abrir_caixa_o_supervisor_libera_por_1_h_e_a_venda_em_curso_segue()
    {
        var disco = new Disco { Livre = 150 * MB };
        var tempo = new Tempo();
        using var pdv = await IniciarAsync(disco, tempo);
        if (pdv.Shell.PaginaAtual is AtivacaoViewModel)
        {
            await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is not null, "foco no assistente");
            pdv.Tecla(Key.F8);
            await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel);
        }

        // A MARIA (operadora) entra: a abertura recusa com o disco e pede o supervisor.
        await pdv.EntrarAsync("1", "1234");
        await pdv.EsperarFocoAsync("CampoFundo");
        var abertura = (AberturaCaixaViewModel)pdv.Shell.PaginaAtual!;
        abertura.Fundo = "0";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => abertura.Liberacao is not null, "pedido de liberação do disco");
        Assert.StartsWith("Disco quase cheio (150 MB livres)", abertura.Erro, StringComparison.Ordinal);
        Assert.Equal($"Liberação do supervisor · {AberturaCaixaViewModel.AcaoLiberarDisco}", abertura.Liberacao!.Titulo);
        await using (var db = Banco(pdv))
        {
            Assert.False(await db.SessoesCaixa.AnyAsync(Ct));
        }

        pdv.Captura("64-abertura-disco-cheio");

        // Esc no pedido: o aviso do disco fica na tela, nada é gravado e o foco volta ao fundo de troco.
        await pdv.EsperarFocoAsync("CampoSupervisor");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => abertura.Liberacao is null, "pedido cancelado");
        await pdv.EsperarFocoAsync("CampoFundo");
        Assert.StartsWith("Disco quase cheio (150 MB livres)", abertura.Erro, StringComparison.Ordinal);
        Assert.Empty(await LiberacoesAsync(pdv));
        Assert.Same(abertura, pdv.Shell.PaginaAtual);

        // O Enter de novo pede o supervisor outra vez.
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => abertura.Liberacao is not null, "pedido de liberação do disco de novo");

        // O CARLOS libera (PIN na hora, com o motivo): a abertura segue sozinha e a venda abre.
        abertura.Liberacao.Usuario = "2";
        abertura.Liberacao.Pin = "4321";
        abertura.Liberacao.Motivo = "Suporte avisado, limpeza amanhã cedo";
        await abertura.Liberacao.ConfirmarCommand.ExecuteAsync(null);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "venda depois da liberação");
        var liberacao = Assert.Single(await LiberacoesAsync(pdv));
        Assert.Equal((Maria, Carlos, "Suporte avisado, limpeza amanhã cedo"), (liberacao.UsuarioId!.Value, liberacao.AutorizadoPorId!.Value, liberacao.Motivo));
        Assert.Contains("disco quase cheio liberada por 1 h por CARLOS", liberacao.Descricao, StringComparison.Ordinal);
        Assert.Contains("\"livre_mb\":150", liberacao.Depois, StringComparison.Ordinal);

        // A venda em curso nunca é bloqueada pelo disco: registra e finaliza com 150 MB livres.
        var venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        await pdv.EsperarFocoAsync("CampoCodigo");
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "item registrado");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("50");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");

        // A liberação vale 1 h pelo relógio monotônico; depois, abrir caixa novo volta a pedir o supervisor.
        var caixa = pdv.Servicos.GetRequiredService<ServicoCaixa>();
        Assert.True(caixa.DiscoLiberado);
        Assert.Null(caixa.DiscoBloqueiaAbertura());
        tempo.Avancar(TimeSpan.FromMinutes(61));
        Assert.False(caixa.DiscoLiberado);
        Assert.Equal(150 * MB, caixa.DiscoBloqueiaAbertura());
    }

    [AvaloniaFact]
    public async Task Supervisor_logado_libera_o_disco_com_outro_enter()
    {
        using var pdv = await IniciarAsync(new Disco { Livre = 150 * MB });
        if (pdv.Shell.PaginaAtual is AtivacaoViewModel)
        {
            await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is not null, "foco no assistente");
            pdv.Tecla(Key.F8);
            await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel);
        }

        await pdv.EntrarAsync("2", "4321");
        await pdv.EsperarFocoAsync("CampoFundo");
        var abertura = (AberturaCaixaViewModel)pdv.Shell.PaginaAtual!;
        abertura.Fundo = "0";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => abertura.Aviso == AberturaCaixaViewModel.MensagemConfirmarDisco, "confirmação do supervisor");
        Assert.Null(abertura.Liberacao);
        Assert.Empty(await LiberacoesAsync(pdv));

        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "venda");
        var liberacao = Assert.Single(await LiberacoesAsync(pdv));
        Assert.Equal((Carlos, Carlos), (liberacao.UsuarioId!.Value, liberacao.AutorizadoPorId!.Value));
        // O motivo é obrigatório na liberação (PDV 31.3): o do próprio supervisor logado é fixo.
        Assert.Equal(ServicoCaixa.MotivoDiscoProprioSupervisor, liberacao.Motivo);
    }

    [AvaloniaFact]
    public async Task Abertura_automatica_com_o_disco_quase_cheio_vai_para_a_tela_que_pede_o_supervisor()
    {
        var disco = new Disco();
        using var pdv = await IniciarAsync(disco);
        if (pdv.Shell.PaginaAtual is AtivacaoViewModel)
        {
            await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is not null, "foco no assistente");
            pdv.Tecla(Key.F8);
            await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel);
        }

        // pdv.solicita_abertura_caixa desligada: o login abriria o caixa sozinho, mas o disco está com 150 MB.
        var agora = DateTimeOffset.UtcNow;
        await pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [new ConfiguracaoRegistro
            {
                Id = Guid.CreateVersion7(), Escopo = "loja", LojaId = CatalogoDemonstracao.LojaDemonstracao,
                Chave = ChavesConfiguracao.SolicitaAberturaCaixa, Valor = "false", CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
            }],
            Ct);
        disco.Livre = 150 * MB;
        await pdv.EntrarAsync("1", "1234");
        await pdv.EsperarFocoAsync("CampoFundo");
        var abertura = Assert.IsType<AberturaCaixaViewModel>(pdv.Shell.PaginaAtual);
        await using (var db = Banco(pdv))
        {
            Assert.False(await db.SessoesCaixa.AnyAsync(Ct));
        }

        // A tela diz por que parou e o fundo é o herdado (0,00), só leitura: a abertura continua sendo a automática.
        Assert.True(abertura.Automatica);
        Assert.StartsWith("Disco quase cheio (150 MB livres)", abertura.Erro, StringComparison.Ordinal);
        Assert.True(pdv.Controle<TextBox>("CampoFundo").IsReadOnly);
        Assert.False(pdv.Controle<TextBox>("CampoObservacao").IsVisible);
        pdv.Tecla(Key.F2);
        Assert.Null(abertura.Contador);

        // O CARLOS libera o disco (um PIN só): abre como a automática, sem pedir pdv.caixa.abrir de novo.
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => abertura.Liberacao is not null, "pedido de liberação do disco");
        abertura.Liberacao!.Usuario = "2";
        abertura.Liberacao.Pin = "4321";
        abertura.Liberacao.Motivo = "Limpeza do disco agendada";
        await abertura.Liberacao.ConfirmarCommand.ExecuteAsync(null);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "venda depois da liberação");
        await using (var db = Banco(pdv))
        {
            var sessao = await db.SessoesCaixa.SingleAsync(Ct);
            Assert.True(sessao.AberturaAutomatica);
            Assert.Equal(0m, sessao.FundoTroco);
        }

        var liberacao = Assert.Single(await LiberacoesAsync(pdv));
        Assert.Contains("disco quase cheio", liberacao.Descricao, StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task Venda_em_curso_segue_com_o_disco_quase_cheio_e_na_d22_a_liberacao_nao_e_gravada()
    {
        var disco = new Disco();
        SincronizacaoComTrava? trava = null;
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s =>
        {
            s.AddSingleton(sp => new MedidorDisco(sp.GetRequiredService<CaminhosPdv>(), _ => disco.Livre));
            s.AddSingleton<GenesisPDV.Sync.Cliente.IServicoSincronizacao>(sp =>
                trava = new SincronizacaoComTrava(sp.GetRequiredService<GenesisPDV.Sync.Cliente.ServicoSincronizacaoHttp>()));
        });
        var venda = await pdv.AtivarDemonstracaoELogarAsync();

        // O caixa já aberto e o disco cai para 150 MB: a venda registra e finaliza sem liberação nenhuma.
        disco.Livre = 150 * MB;
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "item registrado");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("50");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
        Assert.Empty(await LiberacoesAsync(pdv));
        await using (var db = Banco(pdv))
        {
            Assert.Equal(1, await db.Vendas.CountAsync(v => v.FinalizadaEm != null, Ct));
        }

        // D22 (o desativando_confirmado em voo): a liberação do disco não grava nada e não libera.
        var caixa = pdv.Servicos.GetRequiredService<ServicoCaixa>();
        var carlos = new LiberacaoConcedida(AutenticadorOperadorSimulado.Operadores.Single(o => o.Login == "carlos"), "Limpeza amanhã", DateTimeOffset.UtcNow);
        Assert.NotNull(trava);
        trava!.Confirmando = true;
        var recusa = await Assert.ThrowsAsync<GenesisPDV.Core.Comum.RegraNegocioException>(() => caixa.LiberarDiscoAsync(carlos, Ct));
        Assert.Equal(ServicoCaixa.MensagemConfirmandoDesativacao, recusa.Message);
        Assert.False(caixa.DiscoLiberado);
        Assert.Empty(await LiberacoesAsync(pdv));
        trava.Confirmando = false;
        await caixa.LiberarDiscoAsync(carlos, Ct);
        Assert.True(caixa.DiscoLiberado);
        Assert.Single(await LiberacoesAsync(pdv));
    }

    [AvaloniaFact]
    public async Task Foco_volta_a_lista_do_painel_depois_da_primeira_rodada_e_do_f5()
    {
        // Uma verificação lenta (como num computador fraco): o 0 de novo chega antes das linhas.
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<IVerificacaoSaude>(new Demorada(TimeSpan.FromMilliseconds(1500))));
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();
        var painel = Assert.IsType<AbaPainelViewModel>(central.Conteudo);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "0", "foco no menu");
        pdv.Tecla(Key.D0);
        Assert.True(painel.Verificando);

        // As linhas chegam e o foco vai sozinho à lista: ↑/↓ funcionam sem outro 0 nem clique.
        await pdv.EsperarAsync(() => !painel.Verificando && painel.Linhas.Count == 13, "Painel verificado");
        await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is ListBoxItem, "foco na lista depois da rodada");
        var primeira = painel.Selecionada;
        pdv.Tecla(Key.Down);
        Assert.NotSame(primeira, painel.Selecionada);
        var escolhida = painel.Selecionada!.Codigo;

        // F5 refaz a lista: o foco continua nela, na mesma linha, e ↓ e Esc seguem pelo teclado.
        pdv.Tecla(Key.F5);
        await pdv.EsperarAsync(() => painel.Verificando, "verificando de novo");
        await pdv.EsperarAsync(() => !painel.Verificando, "verificado de novo");
        await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is ListBoxItem, "foco na lista depois do F5");
        Assert.Equal(escolhida, painel.Selecionada!.Codigo);
        pdv.Tecla(Key.Down);
        Assert.NotEqual(escolhida, painel.Selecionada!.Codigo);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "0", "Esc volta ao menu");
    }

    /// <summary>Verde, mas demora (o Painel espera até o limite de 2 s).</summary>
    private sealed class Demorada(TimeSpan demora) : IVerificacaoSaude
    {
        public string Codigo => "demorada";

        public string Nome => "Demorada";

        public async Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct)
        {
            await Task.Delay(demora, ct);
            return new ItemSaude(Codigo, Nome, NivelSaude.Ok, "Demorou, mas está certo.");
        }
    }

    /// <summary>O espaço livre do disco à mão (começa folgado).</summary>
    private sealed class Disco
    {
        public long? Livre { get; set; } = 50_000 * MB;
    }

    /// <summary>O relógio monotônico, avançado à mão (a liberação de 1 h).</summary>
    private sealed class Tempo : TimeProvider
    {
        private long _ticks = 1;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => _ticks;

        public void Avancar(TimeSpan quanto) => _ticks += quanto.Ticks;
    }
}
