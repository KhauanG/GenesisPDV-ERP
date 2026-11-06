using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.App.ViewModels.Central;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Ativacao;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Pull;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels;

/// <summary>
/// Navegação entre as telas (PDV 5.3, 7, 9): banco local → assistente de ativação (sem identidade), handshake
/// <c>GET /sync/estado</c> (terminal real, SYNC 5), carga inicial (fluxos que bloqueiam as vendas ainda sem carga) ou
/// login → venda. O handshake decide antes do login: <c>revogado</c> → tela de terminal desativado; reidratação
/// interrompida (regressão, SYNC 22.2) → "Recuperando os dados do caixa…", que segue sozinha para o login; hardware
/// divergente, token recusado e 403 da empresa ou da loja (suspensa, cancelada, PDV desabilitado, loja inativa) → tela de
/// bloqueio; <c>desativando</c> → tela de desativação; sem conexão → segue com os dados locais. Depois o shell acompanha o ciclo online (<see cref="IServicoSincronizacao"/>): desativação ou revogação
/// no meio do expediente trocam a tela (a venda em andamento fica gravada) e a mensagem do ERP aparece no topo. Também
/// recebe os erros inesperados capturados globalmente.
/// </summary>
public sealed partial class ShellViewModel(IServiceProvider servicos, ILogger<ShellViewModel> log) : ViewModelBase
{
    private bool _inscrito;

    private bool _seguindoAposRecuperacao;

    [ObservableProperty]
    public partial ViewModelBase? PaginaAtual { get; set; }

    [ObservableProperty]
    public partial string? ErroGlobal { get; set; }

    /// <summary>Mensagem do ERP (comando <c>mensagem</c>, SYNC 21.1), até o operador fechar.</summary>
    [ObservableProperty]
    public partial string? MensagemNuvem { get; set; }

    [ObservableProperty]
    public partial bool Iniciando { get; set; } = true;

    /// <summary>
    /// Fecha e reabre o aplicativo (depois de restaurar um backup, C17). O <c>App</c> define o de verdade (abre o processo
    /// de novo e encerra este); os testes trocam para conferir e reabrir o PDV na mesma pasta.
    /// </summary>
    public Action? AoReiniciar { get; set; }

    public void Reiniciar() => (AoReiniciar ?? throw new InvalidOperationException("Reinício do aplicativo não configurado."))();

    public T Servico<T>() where T : notnull => servicos.GetRequiredService<T>();

    public async Task IniciarAsync()
    {
        Iniciando = true;
        var caminhos = Servico<CaminhosPdv>();
        try
        {
            var resultado = await Task.Run(() => InicializadorBanco.InicializarAsync(
                Servico<FabricaPdvDb>(), caminhos.PastaBackup, Servico<IRelogio>().Agora, pastaMarcadorEncerramento: caminhos.PastaDados));
            if (resultado.ArquivoBackup is not null)
            {
                log.LogInformation("Backup antes da migração: {Arquivo}", resultado.ArquivoBackup);
            }

            log.LogInformation("Banco local pronto em {Arquivo} ({Migracoes} migrações aplicadas agora)",
                caminhos.ArquivoBanco, resultado.MigracoesAplicadas.Count);
            // Painel de saúde (G4): o integrity_check da abertura fica em memória (o Painel nunca o roda de novo).
            Servico<EstadoBanco>().Registrar(resultado.BancoNovo, Servico<IRelogio>().Agora);
            // PDV 32.5: backup a cada 2 h com o caixa aberto (o do fechamento e o de saída são chamados por quem fecha).
            Servico<ServicoBackup>().Iniciar();
            // A rodada barata do Painel a cada minuto, para o ícone da barra da venda (G4).
            Servico<MonitorSaude>().Iniciar();
            await Servico<ServicoTema>().CarregarAsync();
            // Parâmetros do caixa (Central do PDV, bloco G11): o bloqueio da tela por inatividade (desligado por padrão).
            await Servico<ServicoParametrosLocais>().CarregarAsync();
            // Impressora e gaveta do terminal (I4): ilegível, segue com a padrão; nunca impede o caixa de abrir.
            await Servico<ServicoHardware>().CarregarAsync();
            var identidade = await Servico<RepositorioTerminal>().ObterIdentidadeAsync();
            Servico<SessaoTerminal>().Identidade = identidade;
            if (identidade is { Demonstracao: false }
                && await Servico<RepositorioTerminal>().ObterConfiguracaoAsync<TerminalAtivado>(ChavesConfiguracaoTerminal.ResumoAtivacao) is { } resumo)
            {
                Servico<SessaoTerminal>().AplicarResumo(resumo);
            }

#if MODO_DEMONSTRACAO
            if (identidade is { Demonstracao: true })
            {
                await CatalogoDemonstracao.GarantirAsync(Servico<RepositorioEspelhos>(), Servico<IRelogio>().Agora);
            }
#endif
            Inscrever();
            if (identidade is null)
            {
                IrParaAtivacao();
            }
            else if (identidade.Demonstracao)
            {
                IrParaLogin();
            }
            else if (await AplicarHandshakeAsync(await Servico<IServicoSincronizacao>().HandshakeAsync()))
            {
                // Bloqueio, desativação ou revogação: a tela já foi trocada.
            }
            else if (!await CargaInicial.LoginLiberadoAsync(Servico<IDbContextFactory<PdvDbContext>>()))
            {
                // Carga interrompida (rede, energia, app fechado): retoma do cursor salvo antes de liberar o login.
                await IrParaCargaInicialAsync();
            }
            else
            {
                await Servico<SessaoTerminal>().CarregarDoEspelhoAsync(Servico<IDbContextFactory<PdvDbContext>>());
                IrParaLogin();
            }
        }
        catch (BancoCorrompidoException e)
        {
            log.LogCritical(e, "Banco local corrompido");
            Servico<EstadoBanco>().RegistrarFalha(e.Message);
            // PDV 32.2, 32.5: a restauração automática escolhe o arquivo (o encerramento.json ficou: integridade falha).
            var restaurar = new RestaurarBackupViewModel(this, automatica: true,
                "O arquivo do banco local não passou na verificação de integridade. Escolha o backup a restaurar (o mais " +
                "recente vem primeiro); o banco com problema fica guardado ao lado. Sem backup, chame o suporte.");
            await restaurar.CarregarAsync();
            PaginaAtual = restaurar.Backups.Count > 0
                ? restaurar
                : new ErroFatalViewModel(
                    this,
                    "Banco local com problema",
                    "O arquivo do banco local não passou na verificação de integridade e não há backup local " +
                    $"(pasta {caminhos.PastaBackup}). Chame o suporte. Nenhum dado foi apagado.");
        }
        catch (BancoDeVersaoMaisNovaException e)
        {
            // I3: instalador antigo por cima do novo. O banco não foi tocado; a saída também não faz backup (não conferido).
            log.LogCritical(e, "Banco local de uma versão mais nova do GenesisPDV");
            PaginaAtual = new ErroFatalViewModel(
                this,
                "Este caixa já usa uma versão mais nova do GenesisPDV",
                $"O banco do caixa foi atualizado por uma versão mais nova que esta ({VersaoApp.Atual}), que não sabe ler o que " +
                "ela gravou. Nada foi alterado. Instale de novo a versão mais nova pelo instalador (a da página de Releases), por " +
                "cima desta, e abra o GenesisPDV. Se não souber qual era, chame o suporte.");
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // Qualquer outra falha na abertura (o App não espera esta Task): sem isto a janela ficaria vazia, sem mensagem.
            log.LogCritical(e, "Falha ao abrir o PDV");
            PaginaAtual = new ErroFatalViewModel(
                this,
                "O caixa não conseguiu abrir",
                $"Ocorreu um erro ao abrir o GenesisPDV ({e.GetType().Name}: {e.Message}). Feche (Alt+F4) e abra de novo; se " +
                $"repetir, chame o suporte com o log do dia (pasta {caminhos.PastaLogs}). Nenhum dado foi apagado.");
        }
        finally
        {
            Iniciando = false;
        }
    }

    /// <summary>Aplica o desfecho do handshake; devolve se a tela foi trocada (o terminal não segue para o login).</summary>
    internal async Task<bool> AplicarHandshakeAsync(ResultadoHandshake handshake)
    {
        switch (handshake.Desfecho)
        {
            case DesfechoHandshake.Revogado:
                IrParaDesativado();
                return true;
            case DesfechoHandshake.Desativando:
                await Servico<SessaoTerminal>().CarregarDoEspelhoAsync(Servico<IDbContextFactory<PdvDbContext>>());
                IrParaDesativacao();
                return true;
            case DesfechoHandshake.HardwareAlterado:
                PaginaAtual = new TerminalBloqueadoViewModel(this, TerminalBloqueadoViewModel.TituloHardware,
                    handshake.Mensagem ?? "Este computador não é o registrado para o terminal.", podeTentarDeNovo: true);
                Servico<IServicoSincronizacao>().Iniciar();
                return true;
            case DesfechoHandshake.Regressao:
                // 22.2: a reidratação interrompida continua no ciclo (handshake com backoff); terminada, a tela vai sozinha
                // para o login (AoMudarSituacao) e o Enter só adianta a tentativa.
                PaginaAtual = new TerminalBloqueadoViewModel(this, TerminalBloqueadoViewModel.TituloRecuperando,
                    handshake.Mensagem ?? "Recuperando os dados do caixa da nuvem.", podeTentarDeNovo: true);
                Servico<IServicoSincronizacao>().Iniciar();
                return true;
            case DesfechoHandshake.Bloqueado:
                IrParaBloqueioSuporte(handshake.Mensagem ?? "A nuvem não aceita este terminal como está.");
                return true;
            case DesfechoHandshake.Suspenso:
                // O ciclo liga para o push continuar (as vendas já registradas sobem); heartbeat, pull e handshake seguem
                // com backoff e o Enter refaz o handshake.
                PaginaAtual = new TerminalBloqueadoViewModel(this, MensagensBloqueioNuvem.Titulo(Servico<IServicoSincronizacao>().Situacao.BloqueioNuvem),
                    handshake.Mensagem ?? MensagensBloqueioNuvem.Mensagem(null), podeTentarDeNovo: true);
                Servico<IServicoSincronizacao>().Iniciar();
                return true;
            case DesfechoHandshake.ContaDiferente:
                // I3: o PDV abre sozinho para qualquer conta (Run em HKLM); sem o token, nada sincroniza nem entra. O ciclo
                // fica desligado e a tela diz com qual conta entrar.
                PaginaAtual = new TerminalBloqueadoViewModel(this, TerminalBloqueadoViewModel.TituloContaDiferente,
                    handshake.Mensagem ?? "Este caixa foi ativado com outra conta do sistema.", podeTentarDeNovo: false);
                return true;
            case DesfechoHandshake.SemConexao:
                log.LogWarning("Handshake sem conexão: o caixa abre com os dados locais");
                return false;
            default:
                return false;
        }
    }

    /// <summary>Uma vez por processo: situação do ciclo online e mensagens do ERP (sempre tratadas na thread da tela).</summary>
    private void Inscrever()
    {
        if (_inscrito)
        {
            return;
        }

        _inscrito = true;
        var sync = Servico<IServicoSincronizacao>();
        sync.SituacaoAlterada += (_, s) => Dispatcher.UIThread.Post(() => AoMudarSituacao(s));
        sync.MensagemRecebida += (_, texto) => Dispatcher.UIThread.Post(() => MensagemNuvem = $"Mensagem do ERP: {texto}");
    }

    /// <summary>
    /// Desativação/revogação durante o uso (SYNC 3.8): revogado troca a tela na hora (a venda aberta fica no banco);
    /// desativando troca no login, com o caixa livre ou no bloqueio de hardware (aprovado no ERP durante a desativação,
    /// as pendências sobem) — com venda aberta, a barra avisa e a troca vem quando ela fechar (o heartbeat só confirma a
    /// desativação sem venda aberta). A reidratação interrompida na abertura (22.2) que o ciclo concluiu leva ao login.
    /// </summary>
    public void AoMudarSituacao(SituacaoSincronizacao s)
    {
        switch (s.Terminal)
        {
            case EstadoTerminalSync.Revogado when PaginaAtual is not TerminalBloqueadoViewModel { Titulo: TerminalBloqueadoViewModel.TituloDesativado }:
                IrParaDesativado();
                break;
            case EstadoTerminalSync.Desativando when PaginaAtual is LoginViewModel or AberturaCaixaViewModel or SessaoOutroOperadorViewModel
                                                     or TerminalBloqueadoViewModel { Titulo: TerminalBloqueadoViewModel.TituloHardware }
                                                     || (PaginaAtual is VendaViewModel && !Servico<ServicoVenda>().VendaAberta):
                IrParaDesativacao();
                break;
            case EstadoTerminalSync.Ativo when !s.Sincronizando
                                               && PaginaAtual is TerminalBloqueadoViewModel { Titulo: TerminalBloqueadoViewModel.TituloRecuperando }:
                _ = SeguirAposRecuperacaoAsync();
                break;
        }
    }

    /// <summary>A reidratação terminou no ciclo online: o caminho de depois do handshake (carga interrompida ou login).</summary>
    private async Task SeguirAposRecuperacaoAsync()
    {
        // Na thread da tela: duas publicações seguidas não levam ao login duas vezes.
        if (_seguindoAposRecuperacao)
        {
            return;
        }

        _seguindoAposRecuperacao = true;
        try
        {
            // Como na abertura: o terminal de demonstração não tem carga inicial a conferir.
            if (Servico<SessaoTerminal>().Identidade is not { Demonstracao: true }
                && !await CargaInicial.LoginLiberadoAsync(Servico<IDbContextFactory<PdvDbContext>>()))
            {
                await IrParaCargaInicialAsync();
                return;
            }

            await Servico<SessaoTerminal>().CarregarDoEspelhoAsync(Servico<IDbContextFactory<PdvDbContext>>());
            IrParaLogin();
        }
        catch (Exception e)
        {
            await TratarErroInesperadoAsync(e);
        }
        finally
        {
            _seguindoAposRecuperacao = false;
        }
    }

    public void IrParaAtivacao() => PaginaAtual = new AtivacaoViewModel(this);

    /// <summary>
    /// Central do PDV pelo login (bloco G3; Ctrl+Alt+C ou o ⚙ do login): a tela pede o usuário e o PIN (as regras do login,
    /// sem sessão de operador; <see cref="AcessoCentral.AbrirPeloLoginAsync"/>).
    /// </summary>
    public void IrParaCentralPeloLogin() => PaginaAtual = new CentralPdvViewModel(this, OrigemCentral.Login);

    /// <summary>
    /// Central do PDV pela venda (F11 › 8 ou o ⚙ da barra), com o operador logado; quem chama confere o caixa livre e a
    /// confirmação de desativação (D22). <paramref name="aba"/> abre já numa aba (o F3 do F12 leva à 1 Vendas).
    /// </summary>
    public void IrParaCentralPelaVenda(Operador operador, string? aba = null)
    {
        Servico<AcessoCentral>().AbrirPelaVenda(operador);
        var central = new CentralPdvViewModel(this, OrigemCentral.Venda);
        PaginaAtual = central;
        if (aba is not null)
        {
            central.AbrirAbaCommand.Execute(aba);
        }
    }

    /// <summary>Saindo da Central por qualquer caminho (Esc, restaurar backup, desativação, revogação): a liberação acaba junto.</summary>
    partial void OnPaginaAtualChanged(ViewModelBase? oldValue, ViewModelBase? newValue)
    {
        if (oldValue is CentralPdvViewModel central && !ReferenceEquals(oldValue, newValue))
        {
            central.Encerrar();
        }
    }

    /// <summary>
    /// Central do PDV › 3 Impressora e gaveta › F9 Restaurar backup (PDV 32.5; C17; só na Central aberta pelo login). A
    /// tela pede sempre o PIN de quem tem <c>pdv.supervisor</c> e <c>pdv.config.terminal</c> (PIN na hora, plano 3.3).
    /// Só troca a página se <paramref name="deOnde"/> (a Central que pediu) ainda estiver na frente quando a lista de
    /// backups terminar de carregar: quem saiu dela nesse meio-tempo (Esc, desativação) não recebe a restauração por cima.
    /// </summary>
    public async Task IrParaRestaurarBackupAsync(ViewModelBase? deOnde)
    {
        var restaurar = new RestaurarBackupViewModel(this, automatica: false);
        await restaurar.CarregarAsync();
        if (ReferenceEquals(PaginaAtual, deOnde))
        {
            PaginaAtual = restaurar;
        }
    }

    /// <summary>
    /// Bloqueio da tela por inatividade (Central do PDV, bloco G11; PC-13, desligado por padrão): a tela de venda e a
    /// Central aberta pela venda chamam no relógio de 1 s delas. Com o <c>tela.bloqueio_inatividade_min</c> ligado, o
    /// operador logado e a janela sem tecla nem mouse por esse tempo (<see cref="MonitorInatividade"/>), a tela bloqueia.
    /// <paramref name="venda"/> é a tela de venda que volta depois do desbloqueio (nula na Central: a venda é carregada de
    /// novo, e a Central acaba ao trocar de página, como a liberação dela). <b>Nunca no meio do pagamento</b>: com a venda
    /// em pagamento ou um diálogo de pagamento na frente (o QR do PIX à espera do app do banco, a maquininha), ninguém mexe
    /// no teclado porque o cliente está pagando, e o bloqueio esconderia o QR; a contagem segue e bloqueia depois, se
    /// continuar sem uso. O Ctrl+Alt+B (o operador decidiu) bloqueia mesmo assim.
    /// </summary>
    public void ConferirInatividade(VendaViewModel? venda)
    {
        if (Servico<ServicoParametrosLocais>().BloqueioInatividade is { } limite
            && Servico<SessaoTerminal>().Operador is not null
            && Servico<MonitorInatividade>().Ociosidade >= limite
            && !EmPagamento(venda))
        {
            _ = BloquearTelaAsync(venda, BloqueioTela.ComoInatividade);
        }
    }

    /// <summary>A venda em pagamento (o F10 aberto) ou um diálogo de pagamento na frente: o bloqueio por inatividade espera.</summary>
    private bool EmPagamento(VendaViewModel? venda) =>
        Servico<ServicoVenda>().Atual is { Status: GenesisPDV.Core.Vendas.StatusVenda.EmPagamento }
        || venda?.Dialogo is DialogoPagamentoViewModel or DialogoPixViewModel or DialogoPosViewModel;

    /// <summary>
    /// Bloqueia a tela (PDV 7.4): pela inatividade ou pelo F11 › 7 / Ctrl+Alt+B. A venda em andamento fica como estava. A
    /// troca da tela vem antes da auditoria <c>bloqueio</c> (já no catálogo; sobe no lote), que é melhor esforço: na D22 o
    /// gatilho a recusa e a tela bloqueia do mesmo jeito.
    /// </summary>
    public async Task BloquearTelaAsync(VendaViewModel? venda, string como)
    {
        if (PaginaAtual is TelaBloqueadaViewModel || Servico<SessaoTerminal>().Operador is not { } operador)
        {
            return;
        }

        var minutos = Servico<ServicoParametrosLocais>().Atual.BloqueioInatividadeMin;
        var agora = Servico<IRelogio>().Agora;
        PaginaAtual = new TelaBloqueadaViewModel(this, operador, venda, como, minutos, agora);
        try
        {
            // A entidade própria (tela_pdv): no ERP, `bloqueio` também é o da conta bloqueada por tentativas (entidade
            // usuarios); quem filtra lá não confunde a tela do caixa com uma tentativa de força bruta.
            await Servico<RepositorioTerminal>().RegistrarAuditoriaAsync(
                BloqueioTela.AcaoBloqueio, operador.Id, BloqueioTela.Entidade,
                descricao: como == BloqueioTela.ComoInatividade
                    ? $"Tela bloqueada depois de {minutos} min sem uso"
                    : $"Tela bloqueada por {operador.Nome}",
                localizacao: BloqueioTela.Localizacao,
                depois: new System.Text.Json.Nodes.JsonObject { ["como"] = como, ["minutos"] = como == BloqueioTela.ComoInatividade ? minutos : null }
                    .ToJsonString());
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogWarning(e, "Bloqueio da tela sem a auditoria");
        }
    }

    /// <summary>Desbloqueada: a mesma tela de venda (a venda como estava) ou, sem ela (bloqueou na Central), a venda carregada de novo.</summary>
    public async Task VoltarDoBloqueioAsync(TelaBloqueadaViewModel tela, VendaViewModel? venda)
    {
        if (!ReferenceEquals(PaginaAtual, tela))
        {
            // A tela já foi trocada (desativação, revogação): não volta por cima dela.
            return;
        }

        if (venda is not null)
        {
            PaginaAtual = venda;
            venda.AposDesbloqueio();
            return;
        }

        await IrParaVendaAsync();
    }

    /// <summary>Login; no terminal real, liga o ciclo online (idempotente) — a carga de pessoas/operação continua nele.</summary>
    /// <param name="erro">Mensagem já mostrada no login (a abertura recusada depois da troca de turno, PDV 8.1).</param>
    public void IrParaLogin(string? erro = null)
    {
        var login = new LoginViewModel(this) { Erro = erro };
        PaginaAtual = login;
        IniciarSincronizacao();
        _ = CarregarLoginAsync(login);
    }

    /// <summary>O aviso de versão abaixo da mínima (I3) vem do banco; falhar aqui não impede o login.</summary>
    private async Task CarregarLoginAsync(LoginViewModel login)
    {
        try
        {
            await login.CarregarAsync();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogWarning(e, "Falha ao ler a versão mínima do app para o login");
        }
    }

    public void IrParaDesativacao()
    {
        PaginaAtual = new DesativacaoViewModel(this);
        IniciarSincronizacao();
    }

    /// <summary>"Terminal desativado pelo ERP" (SYNC 3.8): só o diagnóstico; o banco local nunca é apagado.</summary>
    public void IrParaDesativado() => PaginaAtual = new TerminalBloqueadoViewModel(this, TerminalBloqueadoViewModel.TituloDesativado,
        "Este terminal foi desativado em ERP › PDVs/Terminais e não sincroniza mais. O banco local foi mantido: as pendências e o " +
        "diagnóstico continuam neste computador para o suporte. Para usar este computador como caixa de novo, chame o suporte: a nova " +
        "ativação começa com um banco local novo (este fica guardado).",
        podeTentarDeNovo: false);

    /// <summary>Bloqueio que só o suporte resolve (regressão, token recusado, protocolo); Enter refaz o handshake.</summary>
    public void IrParaBloqueioSuporte(string mensagem) =>
        PaginaAtual = new TerminalBloqueadoViewModel(this, TerminalBloqueadoViewModel.TituloSuporte, mensagem, podeTentarDeNovo: true);

    private void IniciarSincronizacao()
    {
        if (Servico<SessaoTerminal>().IdentidadeReal)
        {
            Servico<IServicoSincronizacao>().Iniciar();
        }
    }

    /// <summary>Passo 5 da ativação (PDV 5.3) ou retomada da carga interrompida.</summary>
    public async Task IrParaCargaInicialAsync()
    {
        var carga = new CargaInicialViewModel(this);
        PaginaAtual = carga;
        await carga.IniciarAsync();
    }

    /// <summary>
    /// Depois do login (PDV 7.2, 8.1; Fase 1C, C10a): sessão do mesmo operador → venda; de outro → diálogo da troca de
    /// turno; sem sessão → abertura (ou a abertura automática com a chave desligada).
    /// </summary>
    public async Task AposLoginAsync()
    {
        await Servico<SessaoTerminal>().CarregarConfiguracoesAsync(Servico<RepositorioConfiguracoes>());
        var r = await Servico<ServicoCaixa>().AposLoginAsync();
        switch (r.Situacao)
        {
            case SituacaoAposLogin.Abrir:
                PaginaAtual = new AberturaCaixaViewModel(this, r.Herdado, r.AberturaAutomatica);
                break;
            case SituacaoAposLogin.SessaoDeOutro:
                PaginaAtual = new SessaoOutroOperadorViewModel(this, r.Sessao!, r.NomeOperadorSessao!);
                break;
            default:
                await IrParaVendaAsync();
                break;
        }
    }

    /// <param name="mensagem">Aviso na barra da venda (caixa aberto, gaveta que não abriu).</param>
    /// <param name="depois">O que fazer com a venda carregada (o Ctrl+Del da aba Vendas da Central abre o F12 nela).</param>
    public async Task IrParaVendaAsync(string? mensagem = null, Func<VendaViewModel, Task>? depois = null)
    {
        await Servico<SessaoTerminal>().CarregarConfiguracoesAsync(Servico<RepositorioConfiguracoes>());
        await Servico<SessaoTerminal>().CarregarSessaoCaixaAsync(Servico<RepositorioCaixa>());
        await Servico<ServicoCaixa>().CarregarRegrasAsync();
        var venda = new VendaViewModel(this);
        PaginaAtual = venda;
        await venda.CarregarAsync(mensagem);
        if (depois is not null && ReferenceEquals(PaginaAtual, venda))
        {
            await depois(venda);
        }
    }

    /// <summary>
    /// Fechamento de caixa (F11 › 3) ou troca de turno pedida pelo próximo operador (8.1, opção 1): a apuração vem do
    /// banco local, offline (21.5).
    /// </summary>
    public async Task IrParaFechamentoAsync(bool trocaDeTurno = false, LiberacaoConcedida? liberacao = null)
    {
        var preparado = await Servico<ServicoCaixa>().PrepararFechamentoAsync(liberacao);
        var pendentes = await Servico<RepositorioTerminal>().ContarEventosPendentesAsync();
        PaginaAtual = new FechamentoCaixaViewModel(this, preparado, liberacao, trocaDeTurno, pendentes);
    }

    /// <summary>Erro não tratado na interface: registra, avisa e recarrega a venda do SQLite (PDV 32.2).</summary>
    public async Task TratarErroInesperadoAsync(Exception erro)
    {
        log.LogError(erro, "Erro inesperado na interface");
        try
        {
            await Servico<RepositorioTerminal>().RegistrarOcorrenciaAsync(
                NiveisOcorrencia.Erro, CodigoOcorrencia.ErroInesperado, erro.Message, erro.ToString());
        }
        catch (Exception e)
        {
            log.LogError(e, "Falha ao gravar log_local");
        }

        ErroGlobal = "Ocorreu um erro. A venda foi preservada.";
        if (PaginaAtual is VendaViewModel venda)
        {
            await venda.RecarregarDoBancoAsync();
        }
    }

    [CommunityToolkit.Mvvm.Input.RelayCommand]
    private void FecharErro() => ErroGlobal = null;

    [CommunityToolkit.Mvvm.Input.RelayCommand]
    private void FecharMensagemNuvem() => MensagemNuvem = null;
}
