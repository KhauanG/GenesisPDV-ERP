using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.App.ViewModels;
using GenesisPDV.App.ViewModels.Central;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// A casca da Central do PDV, a engrenagem (bloco G3; README › decisão 68), no terminal de demonstração: o ⚙ da barra e
/// o F11 › 8 abrem a Central no Painel só com o caixa livre; o menu lateral pelo dígito e pelo clique; a aba sem permissão
/// com o cadeado, que pede o supervisor e abre depois do PIN (e fecha quando a liberação acaba ou ao sair); a entrada
/// pelo ⚙ do login com o PIN, sem sessão de operador; e a confirmação da desativação (D22) deixando a Central só para
/// consulta sem derrubar a tela. A aba 3 (Impressora e gaveta) tem os testes de antes em <c>ImpressoraTelasTests</c>,
/// <c>UsabilidadeTelasTests</c> e <c>RestaurarBackupTelasTests</c>.
/// </summary>
public class CentralTelasTests
{
    private static readonly Guid Maria = Guid.Parse("019a0003-0000-7000-8000-000000000001");
    private static readonly Guid Carlos = Guid.Parse("019a0003-0000-7000-8000-000000000002");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    private static Task<List<LogAuditoriaLocal>> AuditoriaAsync(AmbienteUi pdv, string acao)
    {
        using var db = Banco(pdv);
        return db.LogAuditoriaLocal.AsNoTracking().Where(a => a.Acao == acao).OrderBy(a => a.OcorridoEm).ToListAsync(Ct);
    }

    private static ItemMenuCentralViewModel Aba(CentralPdvViewModel central, string codigo) => central.Abas.Single(a => a.Codigo == codigo);

    [AvaloniaFact]
    public async Task Engrenagem_da_venda_abre_a_central_no_painel_so_com_o_caixa_livre()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();

        // O ⚙ no fim da barra (o mouse): a Central com a MARIA, no Painel de saúde, o foco no menu.
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();
        Assert.Equal(OrigemCentral.Venda, central.Origem);
        Assert.Equal("0", pdv.AbaFocada());
        Assert.Equal("0", central.AbaSelecionada!.Codigo);
        // O Painel de saúde (G4) abre já verificando, com o código do terminal para o suporte.
        var painel = Assert.IsType<AbaPainelViewModel>(central.Conteudo);
        await pdv.EsperarAsync(() => painel.Linhas.Count == 12, "as 12 verificações do Painel");
        Assert.Equal(pdv.Servicos.GetRequiredService<SessaoTerminal>().Identidade!.CodigoCurto, painel.CodigoTerminal);
        Assert.Contains("MARIA", central.UsuarioTexto, StringComparison.Ordinal);
        Assert.Equal(Maria, pdv.Servicos.GetRequiredService<SessaoTerminal>().Operador!.Id);
        pdv.Captura("60-central-painel");

        // O cadeado segue as permissões do operador: Painel, Vendas (só o caixa aberto) e Sobre abertos (PC-7); o resto pede quem pode.
        Assert.Equal(
            ["2", "3", "4", "5", "6", "7", "8", "P"],
            central.Abas.Where(a => a.Bloqueada).Select(a => a.Codigo));
        Assert.All(central.Abas, a => Assert.True(pdv.BotaoDaAba(a.Codigo).Bounds.Height >= 44, $"aba {a.Codigo} grande o bastante para o mouse"));

        // O rodapé diz para onde o Esc leva de cada lugar (da aba 3 volta ao menu, não à venda).
        Assert.Contains("Esc volta da aba ao menu e do menu à venda", central.Rodape, StringComparison.Ordinal);

        // O 1 (Vendas, do perfil do operador; bloco G5): o caixa aberto, com o foco no campo do número (decisão 70);
        // venda de caixa fechado não se cancela em lugar nenhum (D23; dono, 04/11). Esc volta ao menu.
        pdv.Tecla(Key.D1);
        await pdv.EsperarAsync(() => central.AbaSelecionada?.Codigo == "1", "aba 1");
        Assert.IsType<AbaVendasViewModel>(central.Conteudo);
        await pdv.EsperarFocoAsync("CampoFiltroVendasCentral");
        Assert.DoesNotContain("pelo ERP", AbaVendasViewModel.MensagemCaixaFechado, StringComparison.Ordinal);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "1", "foco no menu");

        // O dígito com o foco no menu: o 9 (Sobre o terminal, G4) sem PIN; o foco fica no menu.
        pdv.Tecla(Key.NumPad9);
        await pdv.EsperarAsync(() => central.AbaSelecionada?.Codigo == "9", "aba 9");
        Assert.IsType<AbaSobreViewModel>(central.Conteudo);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "9", "foco na aba 9");

        // Esc volta à venda; nada foi gravado só por olhar (o Painel e o Sobre não gravam acesso).
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "venda");
        await pdv.EsperarFocoAsync("CampoCodigo");
        Assert.False(pdv.Servicos.GetRequiredService<AcessoCentral>().Aberta);
        Assert.Empty(await AuditoriaAsync(pdv, AcessoCentral.AcaoCentralAcessada));

        // Com a venda em andamento, nem o ⚙ nem o F11 › 8 abrem a Central.
        venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "1 item");
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        await AmbienteUi.Pausa();
        Assert.Same(venda, pdv.Shell.PaginaAtual);
        Assert.Equal(VendaViewModel.MensagemCaixaLivre, pdv.Texto("TextoMensagem"));
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.D8);
        await AmbienteUi.Pausa();
        Assert.Same(venda, pdv.Shell.PaginaAtual);
        Assert.Equal(VendaViewModel.MensagemCaixaLivre, pdv.Texto("TextoMensagem"));
    }

    [AvaloniaFact]
    public async Task Aba_com_cadeado_pede_o_supervisor_abre_depois_do_pin_e_fecha_ao_sair()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.D8);
        var central = await pdv.EsperarCentralAsync();

        // O 2 (Caixas) com cadeado: a liberação pede o supervisor; o PIN errado não libera nem fecha o pedido.
        Assert.True(Aba(central, "2").Bloqueada);
        pdv.Tecla(Key.D2);
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        Assert.True(central.Liberando);
        Assert.Equal("Liberar a aba 2 Caixas", central.TituloLiberacao);
        Assert.Equal("0", central.AbaSelecionada!.Codigo);
        central.UsuarioLiberacao = "2";
        central.PinLiberacao = "0000";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => central.ErroLiberacao is not null, "PIN recusado");
        Assert.True(central.Liberando);
        Assert.Empty(await AuditoriaAsync(pdv, "liberacao"));
        pdv.Captura("61-central-liberacao");

        // O PIN do CARLOS (pelo botão): a aba abre sozinha, emprestada, com a faixa de quem liberou e até quando.
        central.PinLiberacao = "4321";
        pdv.Clicar(pdv.Controle<Button>("BotaoConfirmarLiberacaoCentral"));
        await pdv.EsperarAsync(() => !central.Liberando && central.AbaSelecionada?.Codigo == "2", "aba 2 liberada");
        Assert.True(Aba(central, "2").Emprestada);
        Assert.False(Aba(central, "2").Bloqueada);
        Assert.StartsWith("Liberado por CARLOS: 2 Caixas", central.LiberacaoTexto, StringComparison.Ordinal);
        Assert.True(pdv.Controle<TextBlock>("TextoLiberacaoCentral").IsVisible);
        // Só as de consulta: a aba 3 (pdv.config.terminal, de ação) continua com o cadeado.
        Assert.True(Aba(central, "3").Bloqueada);
        var liberacao = Assert.Single(await AuditoriaAsync(pdv, "liberacao"));
        Assert.Equal((Maria, Carlos, AcessoCentral.Entidade), (liberacao.UsuarioId!.Value, liberacao.AutorizadoPorId!.Value, liberacao.Entidade));

        // O clique na aba 4 (Sincronização, emprestada): abre e grava o central_acessada com quem liberou.
        pdv.Clicar(pdv.BotaoDaAba("4"));
        await pdv.EsperarAsync(() => central.AbaSelecionada?.Codigo == "4", "aba 4");
        var acesso = Assert.Single(await AuditoriaAsync(pdv, AcessoCentral.AcaoCentralAcessada));
        Assert.Equal((Maria, Carlos), (acesso.UsuarioId!.Value, acesso.AutorizadoPorId!.Value));
        pdv.Captura("62-central-aba-liberada");

        // O botão "Liberar" abre o pedido sem aba; Esc fecha só o pedido.
        pdv.Clicar(pdv.Controle<Button>("BotaoLiberarCentral"));
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        Assert.Equal("Liberar abas da Central", central.TituloLiberacao);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => !central.Liberando, "pedido fechado");
        Assert.IsType<CentralPdvViewModel>(pdv.Shell.PaginaAtual);

        // Sair (o botão) acaba a liberação: a Central reaberta pede de novo.
        pdv.Clicar(pdv.Controle<Button>("BotaoSairCentral"));
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "venda");
        Assert.Null(pdv.Servicos.GetRequiredService<AcessoCentral>().Liberador);
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        central = await pdv.EsperarCentralAsync();
        Assert.True(Aba(central, "2").Bloqueada);
        Assert.Null(central.LiberacaoTexto);
    }

    [AvaloniaFact]
    public async Task Liberacao_que_acaba_sem_uso_fecha_a_aba_emprestada()
    {
        var tempo = new Tempo();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<TimeProvider>(tempo));
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();
        pdv.Tecla(Key.L, RawInputModifiers.Control);
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "2";
        central.PinLiberacao = "4321";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => !central.Liberando && !Aba(central, "5").Bloqueada, "liberado");
        pdv.Tecla(Key.D5);
        await pdv.EsperarAsync(() => central.AbaSelecionada?.Codigo == "5", "aba 5");

        // O uso renova (tecla na Central); 5 min sem uso, a aba emprestada fecha e o cadeado volta.
        tempo.Avancar(AcessoCentral.ValidadeLiberacao - TimeSpan.FromSeconds(10));
        pdv.Tecla(Key.D5);
        tempo.Avancar(TimeSpan.FromSeconds(20));
        central.Atualizar();
        Assert.Equal("5", central.AbaSelecionada!.Codigo);
        tempo.Avancar(AcessoCentral.ValidadeLiberacao);
        central.Atualizar();
        Assert.Equal("0", central.AbaSelecionada!.Codigo);
        Assert.Equal(CentralPdvViewModel.MensagemLiberacaoAcabou, central.Mensagem);
        Assert.True(Aba(central, "5").Bloqueada);
        Assert.Null(central.LiberacaoTexto);
    }

    [AvaloniaFact]
    public async Task Pela_engrenagem_do_login_entra_com_o_pin_sem_sessao_de_operador()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Shell.IrParaLogin();
        await pdv.EsperarFocoAsync("CampoUsuario");
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>();
        sessao.Operador = null;

        // O ⚙ do login (o mouse): a Central pede o usuário e o PIN.
        pdv.Clicar(pdv.Controle<Button>("BotaoCentralLogin"));
        await pdv.EsperarFocoAsync("CampoUsuarioCentral");
        var central = Assert.IsType<CentralPdvViewModel>(pdv.Shell.PaginaAtual);
        Assert.True(central.Entrando);
        central.Usuario = "1";
        central.Pin = "9999";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => central.Erro is not null, "PIN recusado");
        Assert.True(central.Entrando);
        Assert.Single(await AuditoriaAsync(pdv, "login_negado"));
        pdv.Captura("63-central-login");

        central.Pin = "1234";
        pdv.Clicar(pdv.Controle<Button>("BotaoEntrarCentral"));
        await pdv.EsperarCentralAsync();
        Assert.Equal(OrigemCentral.Login, central.Origem);
        Assert.Contains("entrou pelo login", central.UsuarioTexto, StringComparison.Ordinal);
        Assert.Null(sessao.Operador);
        var acesso = Assert.Single(await AuditoriaAsync(pdv, AcessoCentral.AcaoCentralAcessada));
        Assert.Equal(Maria, acesso.UsuarioId);

        // Esc volta ao login.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "login");
        Assert.False(pdv.Servicos.GetRequiredService<AcessoCentral>().Aberta);
    }

    [AvaloniaFact]
    public async Task Na_confirmacao_da_desativacao_a_central_fica_so_leitura_sem_derrubar_a_tela()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Shell.IrParaLogin();
        await pdv.EsperarFocoAsync("CampoUsuario");
        await using (var db = Banco(pdv))
        {
            // D22 só no banco (os gatilhos recusam a auditoria até a resposta), sem a situação do sync: o que a Central vê
            // quando a trava chega com ela já aberta. Com a situação ligada, ela nem abre (o teste da recusa, abaixo).
            Assert.Equal(1, await db.EstadoConexao.ExecuteUpdateAsync(e => e.SetProperty(x => x.ConfirmandoDesativacaoEm, DateTimeOffset.UtcNow), Ct));
        }

        var central = await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        await pdv.EsperarAsync(() => central.SomenteLeituraTexto is not null, "só leitura");
        Assert.True(pdv.Controle<TextBlock>("TextoSomenteLeituraCentral").IsVisible);

        // A aba 3 abre (o CARLOS tem pdv.config.terminal), mas salvar (o botão do F2) não grava: a mensagem da trava, a
        // tela continua.
        var aba = await pdv.AbrirAbaHardwareAsync();
        pdv.Clicar(pdv.Controle<Button>("BotaoSalvarConfig"));
        await pdv.EsperarAsync(() => aba.Erro is not null, "salvar recusado");
        Assert.Equal(TravaDesativacao.Mensagem, aba.Erro);
        Assert.Same(central, pdv.Shell.PaginaAtual);

        // O Liberar também não libera (nem confere o PIN).
        pdv.Tecla(Key.L, RawInputModifiers.Control);
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "1";
        central.PinLiberacao = "1234";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => central.ErroLiberacao is not null, "liberação recusada");
        Assert.Equal(TravaDesativacao.Mensagem, central.ErroLiberacao);
        pdv.Captura("64-central-desativacao");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => !central.Liberando, "pedido fechado");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "login");
    }

    [AvaloniaFact]
    public async Task Liberacao_da_aba_3_vale_so_ate_trocar_de_aba()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();

        // A MARIA não tem pdv.config.terminal: o CARLOS libera a aba 3 e sai de perto.
        var aba = await pdv.AbrirAbaHardwareAsync("2", "4321");
        Assert.True(aba.PorLiberacao);
        Assert.False(Aba(central, "3").Bloqueada);
        Assert.True(Aba(central, "3").Emprestada);

        // Trocar de aba acaba a liberação (como sair da configuração de antes): o cadeado volta e a volta pede o supervisor
        // de novo, em vez de deixar a gaveta (F6) e a configuração abertas em nome do CARLOS até sair da Central.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "3", "foco no menu");
        pdv.Tecla(Key.D0);
        await pdv.EsperarAsync(() => central.AbaSelecionada?.Codigo == "0", "aba 0");
        Assert.True(Aba(central, "3").Bloqueada);
        pdv.Tecla(Key.D3);
        await pdv.EsperarFocoAsync("CampoUsuarioConfig");
        var denovo = Assert.IsType<AbaHardwareViewModel>(central.Conteudo);
        Assert.NotSame(aba, denovo);
        Assert.True(denovo.Liberando);
        pdv.Tecla(Key.F6);
        await AmbienteUi.Pausa();
        Assert.Null(denovo.Mensagem);
        Assert.True(denovo.Liberando);
    }

    [AvaloniaFact]
    public async Task Pelo_login_a_aba_3_exige_tambem_o_supervisor_e_o_restaurar_pede_o_pin_na_hora()
    {
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: AutenticadorComExtras.Registrar);
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Shell.IrParaLogin();
        await pdv.EsperarFocoAsync("CampoUsuario");

        // O TECNICO tem pdv.config.terminal sem pdv.supervisor: pelo login (o Ctrl+Alt+C de antes pedia os dois) a aba 3
        // não abre direto; nem o F9 aparece.
        var central = await pdv.EntrarNaCentralPeloLoginAsync("tecnico", AutenticadorComExtras.PinTecnico);
        Assert.True(Aba(central, "3").Bloqueada);
        pdv.Tecla(Key.D3);
        await pdv.EsperarFocoAsync("CampoUsuarioConfig");
        var aba = Assert.IsType<AbaHardwareViewModel>(central.Conteudo);
        Assert.Equal(AbaHardwareViewModel.EtapaLiberar, aba.Etapa);
        Assert.False(aba.MostraRestaurar);
        pdv.Tecla(Key.F9);
        await AmbienteUi.Pausa();
        Assert.Same(central, pdv.Shell.PaginaAtual);

        // O CARLOS libera; o F9 leva ao "Restaurar backup", que pede o PIN na hora (não vale o da aba).
        aba.Usuario = "2";
        aba.Pin = "4321";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.Editando, "aba 3 liberada");
        Assert.True(aba.MostraRestaurar);
        Assert.False(Aba(central, "3").Bloqueada);
        Assert.True(Aba(central, "3").Emprestada);
        await pdv.Servicos.GetRequiredService<ServicoBackup>().TentarAsync(GenesisPDV.Data.Backup.MotivosBackup.Periodico, Ct);
        pdv.Tecla(Key.F9);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is RestaurarBackupViewModel, "restaurar backup");
        var tela = (RestaurarBackupViewModel)pdv.Shell.PaginaAtual!;
        Assert.False(pdv.Servicos.GetRequiredService<AcessoCentral>().Aberta);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoUsuarioRestauracao");
        Assert.Equal(RestaurarBackupViewModel.EtapaLiberar, tela.Etapa);

        // O próprio TECNICO não restaura (não é supervisor).
        tela.Usuario = "tecnico";
        tela.Pin = AutenticadorComExtras.PinTecnico;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => tela.Erro is not null, "TECNICO não libera");
        Assert.Equal(RestaurarBackupViewModel.EtapaLiberar, tela.Etapa);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => tela.Escolhendo, "volta à escolha");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "login");
    }

    [AvaloniaFact]
    public async Task Restaurar_que_termina_de_carregar_depois_de_sair_da_central_nao_abre_por_cima()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Shell.IrParaLogin();
        await pdv.EsperarFocoAsync("CampoUsuario");
        var central = await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        await pdv.AbrirAbaHardwareAsync();

        // A lista de backups carregou depois que a pessoa saiu da Central (Esc, Esc): a tela fica no login.
        pdv.Shell.IrParaLogin();
        await pdv.Shell.IrParaRestaurarBackupAsync(central);
        Assert.IsType<LoginViewModel>(pdv.Shell.PaginaAtual);
    }

    [AvaloniaFact]
    public async Task Liberacao_que_nao_abre_a_aba_pedida_avisa()
    {
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: AutenticadorComExtras.Registrar);
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();

        // A MARIA pede a aba 6 (Histórico de uso); o ENCARREGADO libera os caixas e o diagnóstico, mas não vê o histórico.
        pdv.Tecla(Key.D6);
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "encarregado";
        central.PinLiberacao = AutenticadorComExtras.PinEncarregado;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => !central.Liberando, "liberado");
        Assert.True(Aba(central, "6").Bloqueada);
        Assert.False(Aba(central, "2").Bloqueada);
        Assert.Equal("0", central.AbaSelecionada!.Codigo);
        Assert.Equal("ENCARREGADO não vê a aba 6 Histórico de uso: ela continua pedindo quem pode.", central.Mensagem);
        Assert.True(pdv.Controle<TextBlock>("TextoMensagemCentral").IsVisible);
    }

    [AvaloniaFact]
    public async Task Esc_que_nao_consegue_voltar_a_venda_deixa_a_central_ativa_para_tentar_de_novo()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();

        // A venda não carrega (a leitura das configurações falha): a Central continua, com a mensagem.
        await using (var db = Banco(pdv))
        {
            await db.Database.ExecuteSqlRawAsync("alter table configuracoes rename to configuracoes_fora", Ct);
        }

        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => central.Erro is not null, "volta à venda falhou");
        Assert.Same(central, pdv.Shell.PaginaAtual);
        Assert.False(central.Ocupado);
        await using (var db = Banco(pdv))
        {
            await db.Database.ExecuteSqlRawAsync("alter table configuracoes_fora rename to configuracoes", Ct);
        }

        // O Esc de novo volta.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "venda");
        Assert.False(pdv.Servicos.GetRequiredService<AcessoCentral>().Aberta);
    }

    [AvaloniaFact]
    public async Task Na_altura_minima_o_menu_rola_e_os_botoes_tem_44_px()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Janela.Width = 1024;
        pdv.Janela.Height = 700;
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();
        pdv.Tecla(Key.L, RawInputModifiers.Control);
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "2";
        central.PinLiberacao = "4321";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => !central.Liberando && central.LiberacaoTexto is not null, "faixa da liberação");
        await AmbienteUi.Pausa();

        // Com a faixa azul, as 11 abas não cabem: o menu rola até o P em vez de cortá-lo.
        var rolagem = pdv.Controle<ScrollViewer>("RolagemMenuCentral");
        Assert.True(rolagem.Extent.Height > rolagem.Viewport.Height, $"menu {rolagem.Extent.Height} em {rolagem.Viewport.Height}");
        var p = pdv.BotaoDaAba("P");
        p.BringIntoView();
        await AmbienteUi.Pausa();
        var fundo = p.TranslatePoint(new Point(0, p.Bounds.Height), rolagem)!.Value.Y;
        Assert.True(fundo <= rolagem.Viewport.Height + 0.5, $"P até {fundo} de {rolagem.Viewport.Height}");

        // Alvos de 44 px (plano 4): Liberar, Sair e a barra da aba 3.
        Assert.True(pdv.Controle<Button>("BotaoLiberarCentral").Bounds.Height >= 44);
        Assert.True(pdv.Controle<Button>("BotaoSairCentral").Bounds.Height >= 44);
        await pdv.AbrirAbaHardwareAsync("2", "4321");
        Assert.True(pdv.Controle<Button>("BotaoSalvarConfig").Bounds.Height >= 44);
        Assert.True(pdv.Controle<Button>("BotaoTesteGaveta").Bounds.Height >= 44);
        pdv.Captura("65-central-altura-minima");
    }

    [AvaloniaFact]
    public async Task Na_confirmacao_da_desativacao_nem_a_venda_nem_o_login_nem_a_entrada_abrem_a_central()
    {
        SincronizacaoComTrava? trava = null;
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<GenesisPDV.Sync.Cliente.IServicoSincronizacao>(sp =>
            trava = new SincronizacaoComTrava(sp.GetRequiredService<GenesisPDV.Sync.Cliente.ServicoSincronizacaoHttp>())));
        var venda = await pdv.AtivarDemonstracaoELogarAsync();

        // Na venda: nem o ⚙ nem o F11 › 8 (como o logout, D22).
        trava!.Confirmando = true;
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        await AmbienteUi.Pausa();
        Assert.Same(venda, pdv.Shell.PaginaAtual);
        Assert.Equal(ServicoCaixa.MensagemConfirmandoDesativacao, pdv.Texto("TextoMensagem"));
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.D8);
        await AmbienteUi.Pausa();
        Assert.Same(venda, pdv.Shell.PaginaAtual);

        // No login: o Ctrl+Alt+C fica no login com a mensagem.
        trava.Confirmando = false;
        pdv.Shell.IrParaLogin();
        await pdv.EsperarFocoAsync("CampoUsuario");
        var login = (LoginViewModel)pdv.Shell.PaginaAtual!;
        trava.Confirmando = true;
        pdv.Tecla(Key.C, RawInputModifiers.Control | RawInputModifiers.Alt);
        await AmbienteUi.Pausa();
        Assert.Same(login, pdv.Shell.PaginaAtual);
        Assert.Equal(ServicoCaixa.MensagemConfirmandoDesativacao, login.Erro);

        // A trava que chega com a entrada aberta: o PIN não é conferido nem a Central abre.
        trava.Confirmando = false;
        pdv.Tecla(Key.C, RawInputModifiers.Control | RawInputModifiers.Alt);
        await pdv.EsperarFocoAsync("CampoUsuarioCentral");
        var central = (CentralPdvViewModel)pdv.Shell.PaginaAtual!;
        trava.Confirmando = true;
        central.Usuario = "2";
        central.Pin = "4321";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => central.Erro is not null, "entrada recusada");
        Assert.Equal(ServicoCaixa.MensagemConfirmandoDesativacao, central.Erro);
        Assert.True(central.Entrando);
        Assert.False(pdv.Servicos.GetRequiredService<AcessoCentral>().Aberta);
        Assert.Empty(await AuditoriaAsync(pdv, AcessoCentral.AcaoCentralAcessada));
    }

    /// <summary>O relógio monotônico da liberação, avançado à mão (a hora do sistema fica a de verdade).</summary>
    private sealed class Tempo : TimeProvider
    {
        private long _ticks = 1;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => _ticks;

        public void Avancar(TimeSpan quanto) => _ticks += quanto.Ticks;
    }
}
