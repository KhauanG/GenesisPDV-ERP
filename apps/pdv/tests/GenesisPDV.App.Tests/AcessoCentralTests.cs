using System.Text.Json.Nodes;
using Avalonia.Headless.XUnit;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Hardware.Impressora;
using GenesisPDV.Sync.Acesso;
using GenesisPDV.Sync.Ativacao;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Pull;
using GenesisPDV.Sync.Push;
using GenesisPDV.Sync.Relogio;
using GenesisPDV.Sync.Tests;
using GenesisPDV.Sync.Token;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Central do PDV, bloco G2 (plano 3.3; decisões do dono de 04/11/2026; README › decisão 67): quem está na Central, a
/// liberação de 5 min, a auditoria <c>liberacao</c> (sobe) e <c>central_acessada</c> (só local), a desativação (D22) e o
/// PIN pelas regras do login sem abrir sessão de operador.
/// </summary>
public sealed class AcessoCentralTests : IDisposable
{
    private static readonly string[] PerfilSupervisor =
    [
        .. PermissoesPdv.PerfilOperador, PermissoesPdv.Supervisor, PermissoesPdv.ConsultarHistoricoVendas,
        PermissoesPdv.ConsultarFechamentos, PermissoesPdv.VerDiagnostico, PermissoesPdv.PacoteSuporte,
        PermissoesPdv.VerCalculadoFechamento, PermissoesPdv.ConfigFiscal,
    ];

    private static readonly Operador Maria = Novo("maria", 1, PermissoesPdv.PerfilOperador);
    private static readonly Operador Joao = Novo("joao", 2, PerfilSupervisor);
    private static readonly Operador Ana = Novo("ana", 3, [.. PermissoesPdv.PerfilOperador, PermissoesPdv.VerDiagnostico]);
    private static readonly Operador Gerente = Novo("gerente", 4, [.. PerfilSupervisor, PermissoesPdv.VerAuditoriaLocal, PermissoesPdv.ConfigTerminal]);

    private readonly string _raiz = Path.Combine(Path.GetTempPath(), "genesispdv-central", Guid.NewGuid().ToString("N"));
    private readonly FabricaPdvDb _fabrica;
    private readonly Relogio _relogio = new();
    private readonly Tempo _tempo = new();
    private readonly RepositorioTerminal _terminal;
    private readonly Autenticador _autenticador = new();
    private readonly AcessoCentral _acesso;

    public AcessoCentralTests()
    {
        var caminhos = CaminhosPdv.SobRaiz(_raiz);
        caminhos.CriarPastas();
        _fabrica = new FabricaPdvDb(caminhos.ArquivoBanco);
        _terminal = new RepositorioTerminal(_fabrica, _relogio);
        _acesso = new AcessoCentral(_autenticador, _terminal, _relogio, NullLogger<AcessoCentral>.Instance, _tempo);
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try
        {
            Directory.Delete(_raiz, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private static Operador Novo(string login, int codigo, IEnumerable<string> permissoes) =>
        new(Guid.CreateVersion7(), codigo, login, login.ToUpperInvariant(), 0m, Permissoes: new HashSet<string>(permissoes, StringComparer.Ordinal));

    /// <summary>Banco migrado e um terminal ativado de verdade (o lote de auditoria não sai na demonstração).</summary>
    private async Task IniciarAsync()
    {
        await InicializadorBanco.InicializarAsync(_fabrica, Path.Combine(_raiz, "backup"), _relogio.Agora, Ct);
        await using var db = _fabrica.CreateDbContext();
        db.IdentidadeTerminal.Add(new IdentidadeTerminal
        {
            TerminalId = Guid.CreateVersion7(),
            LojaId = Guid.CreateVersion7(),
            CaixaId = Guid.CreateVersion7(),
            NumeroCaixa = 2,
            UrlApi = "https://api.exemplo/",
            AtivadoEm = _relogio.Agora,
        });
        await db.SaveChangesAsync(Ct);
    }

    private async Task<List<LogAuditoriaLocal>> AuditoriaAsync()
    {
        await using var db = _fabrica.CreateDbContext();
        return await db.LogAuditoriaLocal.AsNoTracking().OrderBy(l => l.OcorridoEm).ThenBy(l => l.Id).ToListAsync(Ct);
    }

    [Fact]
    public async Task Operador_ve_o_painel_e_o_sobre_e_as_abas_do_proprio_perfil()
    {
        await IniciarAsync();
        Assert.False(_acesso.Tem(PermissoesPdv.Entrar));
        _acesso.AbrirPelaVenda(Maria);
        Assert.Equal((true, OrigemCentral.Venda), (_acesso.Aberta, _acesso.Origem));
        Assert.Equal(
            [AbasCentral.Painel, AbasCentral.Vendas, AbasCentral.Sobre],
            AbasCentral.Todas.Where(_acesso.PodeAbrir));
        Assert.False(_acesso.Tem(PermissoesPdv.ConsultarHistoricoVendas));
        Assert.Null(_acesso.Liberador);

        // A aba que não grava acesso não grava nada; a Central fechada não deixa nada.
        await _acesso.RegistrarAberturaAsync(AbasCentral.Vendas, Ct);
        _acesso.Encerrar();
        Assert.False(_acesso.PodeAbrir(AbasCentral.Painel));
        Assert.Empty(await AuditoriaAsync());
    }

    [Fact]
    public async Task Liberacao_empresta_as_abas_do_supervisor_menos_as_sem_liberacao_e_grava_a_auditoria()
    {
        await IniciarAsync();
        _autenticador.Cadastrar(Joao, "2222");
        _acesso.AbrirPelaVenda(Maria);

        Assert.Null(await _acesso.LiberarAsync("joao", "2222", Ct));
        Assert.Same(Joao, _acesso.Liberador);
        Assert.Equal(_relogio.Agora + AcessoCentral.ValidadeLiberacao, _acesso.LiberacaoExpiraEm);
        Assert.Equal(
            ["2 Caixas", "4 Sincronização", "5 Logs e ocorrências", "7 Parâmetros", "8 Backup", "P Pacote de suporte"],
            _acesso.AbasLiberadas);
        Assert.True(_acesso.PodeAbrir(AbasCentral.Sincronizacao));
        Assert.True(_acesso.Tem(PermissoesPdv.ConsultarHistoricoVendas));
        // O fiscal e o calculado do fechamento (O3) não se emprestam; o que nem o supervisor tem continua fechado.
        Assert.False(_acesso.Tem(PermissoesPdv.ConfigFiscal));
        Assert.False(_acesso.Tem(PermissoesPdv.VerCalculadoFechamento));
        Assert.False(_acesso.Tem(PermissoesPdv.Supervisor));
        Assert.False(_acesso.PodeAbrir(AbasCentral.HistoricoUso));

        var liberacao = Assert.Single(await AuditoriaAsync());
        Assert.Equal(("liberacao", Maria.Id, Joao.Id), (liberacao.Acao, liberacao.UsuarioId, liberacao.AutorizadoPorId));
        Assert.Equal((AcessoCentral.Entidade, AcessoCentral.Localizacao), (liberacao.Entidade, liberacao.Localizacao));
        Assert.Equal(
            "Central do PDV liberada por JOAO: 2 Caixas, 4 Sincronização, 5 Logs e ocorrências, 7 Parâmetros, 8 Backup, P Pacote de suporte",
            liberacao.Descricao);
        var depois = JsonNode.Parse(liberacao.Depois!)!;
        Assert.Equal("venda", depois["origem"]!.GetValue<string>());
        Assert.Equal(6, depois["abas"]!.AsArray().Count);
        Assert.Equal(
            new[]
            {
                PermissoesPdv.ConsultarFechamentos, PermissoesPdv.PacoteSuporte, PermissoesPdv.VerDiagnostico, PermissoesPdv.ConsultarHistoricoVendas,
            }.Order(StringComparer.Ordinal),
            depois["permissoes"]!.AsArray().Select(p => p!.GetValue<string>()));
    }

    [Fact]
    public async Task Liberacao_vale_5_minutos_sem_uso_renova_no_uso_e_acaba_ao_sair()
    {
        await IniciarAsync();
        _autenticador.Cadastrar(Joao, "2222");
        _acesso.AbrirPelaVenda(Maria);
        Assert.Null(await _acesso.LiberarAsync("joao", "2222", Ct));

        // Conferir a permissão (a tela redesenhando o menu, a contagem regressiva) não é uso: não renova.
        _tempo.Avancar(TimeSpan.FromMinutes(4));
        for (var i = 0; i < 10; i++)
        {
            Assert.True(_acesso.Tem(PermissoesPdv.VerDiagnostico));
            Assert.True(_acesso.PodeAbrir(AbasCentral.Sincronizacao));
        }

        Assert.Equal(_relogio.Agora + TimeSpan.FromMinutes(1), _acesso.LiberacaoExpiraEm);
        // Tecla ou clique renova; abrir uma aba pela liberação também.
        _acesso.RegistrarUso();
        _tempo.Avancar(TimeSpan.FromMinutes(4));
        await _acesso.RegistrarAberturaAsync(AbasCentral.Caixas, Ct);
        _tempo.Avancar(TimeSpan.FromMinutes(4));
        Assert.True(_acesso.LiberacaoAtiva);
        Assert.NotEmpty(_acesso.AbasLiberadas);
        // Abrir a aba do próprio perfil não é uso da liberação.
        await _acesso.RegistrarAberturaAsync(AbasCentral.Vendas, Ct);
        _tempo.Avancar(TimeSpan.FromMinutes(1) + TimeSpan.FromSeconds(1));
        Assert.False(_acesso.LiberacaoAtiva);
        Assert.Null(_acesso.LiberacaoExpiraEm);
        Assert.Null(_acesso.Liberador);
        Assert.Empty(_acesso.AbasLiberadas);
        Assert.False(_acesso.Tem(PermissoesPdv.VerDiagnostico));
        Assert.True(_acesso.Tem(PermissoesPdv.Entrar));
        // Expirada, o uso não a traz de volta.
        _acesso.RegistrarUso();
        Assert.False(_acesso.LiberacaoAtiva);

        // Sair da Central acaba com a liberação ativa.
        Assert.Null(await _acesso.LiberarAsync("joao", "2222", Ct));
        _acesso.Encerrar();
        _acesso.AbrirPelaVenda(Maria);
        Assert.False(_acesso.Tem(PermissoesPdv.VerDiagnostico));
        Assert.Empty(_acesso.AbasLiberadas);
    }

    [Fact]
    public async Task Relogio_do_windows_acertado_nao_estica_nem_encurta_a_liberacao()
    {
        await IniciarAsync();
        _autenticador.Cadastrar(Joao, "2222");
        _acesso.AbrirPelaVenda(Maria);
        Assert.Null(await _acesso.LiberarAsync("joao", "2222", Ct));

        // A hora do sistema volta 2 h (ajuste manual, NTP depois de offline): os 5 min contam pelo relógio monotônico.
        _relogio.Agora -= TimeSpan.FromHours(2);
        _tempo.Avancar(ValidadeMaisUmSegundo);
        Assert.False(_acesso.LiberacaoAtiva);
        Assert.False(_acesso.Tem(PermissoesPdv.VerDiagnostico));

        // E a hora que avança não expira antes.
        Assert.Null(await _acesso.LiberarAsync("joao", "2222", Ct));
        _relogio.Agora += TimeSpan.FromHours(3);
        _tempo.Avancar(TimeSpan.FromMinutes(1));
        Assert.True(_acesso.Tem(PermissoesPdv.VerDiagnostico));
    }

    [Fact]
    public async Task Liberacao_nao_empresta_as_permissoes_de_acao_e_diz_quem_autorizou()
    {
        await IniciarAsync();
        // A operadora sem reimprimir; o gerente com a configuração do terminal, os parâmetros e o histórico de uso.
        var operadora = Novo("bia", 5, PermissoesPdv.PerfilOperador.Where(p => p != PermissoesPdv.Reimprimir));
        var gerente = Novo("chefe", 6, [.. PerfilSupervisor, PermissoesPdv.VerAuditoriaLocal, PermissoesPdv.ConfigTerminal, PermissoesPdv.ParametrosLocais]);
        _autenticador.Cadastrar(gerente, "6666");
        _acesso.AbrirPelaVenda(operadora);
        Assert.Null(await _acesso.LiberarAsync("chefe", "6666", Ct));

        // As abas de ver abrem; a de Impressora e gaveta e as ações (reimprimir, parâmetros) pedem a própria liberação.
        Assert.True(_acesso.PodeAbrir(AbasCentral.HistoricoUso));
        Assert.False(_acesso.PodeAbrir(AbasCentral.ImpressoraGaveta));
        Assert.False(_acesso.Tem(PermissoesPdv.ConfigTerminal));
        Assert.False(_acesso.Tem(PermissoesPdv.ParametrosLocais));
        Assert.False(_acesso.Tem(PermissoesPdv.Reimprimir));
        Assert.DoesNotContain(AbasCentral.ImpressoraGaveta.Rotulo, _acesso.AbasLiberadas);
        var depois = JsonNode.Parse(Assert.Single(await AuditoriaAsync()).Depois!)!;
        Assert.DoesNotContain(
            depois["permissoes"]!.AsArray().Select(p => p!.GetValue<string>()),
            p => p is PermissoesPdv.ConfigTerminal or PermissoesPdv.ParametrosLocais or PermissoesPdv.Reimprimir);

        // Quem autorizou: o liberador na emprestada; nulo na do próprio perfil e na que não vale.
        Assert.Equal(gerente.Id, _acesso.AutorizadoPor(PermissoesPdv.PacoteSuporte));
        Assert.Null(_acesso.AutorizadoPor(PermissoesPdv.ConsultarVendas));
        Assert.Null(_acesso.AutorizadoPor(PermissoesPdv.ConfigTerminal));
        _tempo.Avancar(ValidadeMaisUmSegundo);
        Assert.Null(_acesso.AutorizadoPor(PermissoesPdv.PacoteSuporte));

        // Só as de ver as abas se emprestam; nunca as de ação nem as sem liberação.
        Assert.All(
            AbasCentral.Todas.Where(a => a != AbasCentral.ImpressoraGaveta),
            a => Assert.Contains(a.Permissao, AbasCentral.PermissoesLiberaveis));
        Assert.Empty(AbasCentral.PermissoesLiberaveis.Intersect(
            [PermissoesPdv.ConfigTerminal, PermissoesPdv.ParametrosLocais, PermissoesPdv.Reimprimir, .. PermissoesPdv.SemLiberacao]));
    }

    [Fact]
    public async Task Liberacao_recusada_nao_muda_nada_e_nao_grava_auditoria()
    {
        await IniciarAsync();
        _autenticador.Cadastrar(Maria, "1111");
        _autenticador.Cadastrar(Joao, "2222");
        _autenticador.Cadastrar(Ana, "3333");
        _autenticador.Cadastrar(Gerente, "4444");
        Assert.Equal(AcessoCentral.MensagemFechada, await _acesso.LiberarAsync("joao", "2222", Ct));

        _acesso.AbrirPelaVenda(Maria);
        Assert.Equal(AutenticadorOffline.MensagemLiberacaoNegada, await _acesso.LiberarAsync("joao", "0000", Ct));
        Assert.Equal(AcessoCentral.MensagemLiberadorProprio, await _acesso.LiberarAsync("maria", "1111", Ct));
        // Tem o diagnóstico mas não é supervisor (PDV 31.3: toda liberação é de supervisor).
        Assert.Equal(AcessoCentral.MensagemLiberadorNaoSupervisor, await _acesso.LiberarAsync("ana", "3333", Ct));
        _autenticador.Bloquear("joao");
        Assert.Equal($"{AutenticadorOffline.MensagemLiberacaoNegada}: {AutenticadorOffline.MensagemBloqueado}", await _acesso.LiberarAsync("joao", "2222", Ct));

        // O gerente na Central: o supervisor não tem nada a mais para liberar.
        _autenticador.Desbloquear("joao");
        _acesso.AbrirPelaVenda(Gerente);
        Assert.Equal(AcessoCentral.MensagemNadaALiberar, await _acesso.LiberarAsync("joao", "2222", Ct));
        Assert.Null(_acesso.Liberador);
        Assert.Empty(await AuditoriaAsync());
    }

    [Fact]
    public async Task Aba_sensivel_grava_central_acessada_uma_vez_por_abertura_e_com_quem_liberou()
    {
        await IniciarAsync();
        _autenticador.Cadastrar(Joao, "2222");
        _acesso.AbrirPelaVenda(Gerente);
        foreach (var aba in new[] { AbasCentral.Sincronizacao, AbasCentral.Sincronizacao, AbasCentral.HistoricoUso, AbasCentral.Parametros })
        {
            // Um milissegundo entre os registros: a ordem da auditoria é pela hora.
            _relogio.Agora += TimeSpan.FromMilliseconds(1);
            await _acesso.RegistrarAberturaAsync(aba, Ct);
        }

        // Outra abertura (a operadora com a liberação do supervisor): grava de novo, com o supervisor.
        _acesso.AbrirPelaVenda(Maria);
        Assert.Null(await _acesso.LiberarAsync("joao", "2222", Ct));
        _relogio.Agora += TimeSpan.FromMilliseconds(1);
        await _acesso.RegistrarAberturaAsync(AbasCentral.Logs, Ct);
        // Sem a permissão (nem emprestada), a aba não abre: chamar não grava nada.
        _relogio.Agora += TimeSpan.FromMilliseconds(1);
        await _acesso.RegistrarAberturaAsync(AbasCentral.HistoricoUso, Ct);

        var acessos = (await AuditoriaAsync()).Where(l => l.Acao == AcessoCentral.AcaoCentralAcessada).ToList();
        Assert.Equal(
            ["4 Sincronização", "6 Histórico de uso", "5 Logs e ocorrências"],
            acessos.Select(a => JsonNode.Parse(a.Depois!)!["aba"]!.GetValue<string>()));
        Assert.Equal([Gerente.Id, Gerente.Id, Maria.Id], acessos.Select(a => a.UsuarioId!.Value));
        Assert.Equal([null, null, Joao.Id], acessos.Select(a => a.AutorizadoPorId));
        Assert.Equal("Central do PDV: aba 5 Logs e ocorrências aberta, liberada por JOAO", acessos[2].Descricao);
        Assert.All(acessos, a => Assert.Equal((AcessoCentral.Entidade, AcessoCentral.Localizacao), (a.Entidade, a.Localizacao)));
    }

    [Fact]
    public async Task Pelo_login_entra_com_o_pin_sem_sessao_e_grava_o_acesso()
    {
        await IniciarAsync();
        _autenticador.Cadastrar(Joao, "2222");
        Assert.Equal(AutenticadorOffline.MensagemInvalido, await _acesso.AbrirPeloLoginAsync(" joao ", "0000", Ct));
        Assert.False(_acesso.Aberta);

        _relogio.Agora += TimeSpan.FromMilliseconds(1);
        Assert.Null(await _acesso.AbrirPeloLoginAsync("joao", "2222", Ct));
        Assert.Equal((OrigemCentral.Login, Joao), (_acesso.Origem, _acesso.Usuario));
        Assert.True(_acesso.PodeAbrir(AbasCentral.Logs));
        var auditoria = await AuditoriaAsync();
        Assert.Equal(2, auditoria.Count);
        // O PIN errado pela engrenagem do login deixa o mesmo rastro do login do caixa (sobe para o historico_logins).
        var negado = auditoria[0];
        Assert.Equal(("login_negado", MotivoRecusa.SenhaInvalida, AcessoCentral.Localizacao), (negado.Acao, negado.Motivo, negado.Localizacao));
        Assert.Equal("""{"login_informado":"joao"}""", negado.Depois);
        var acesso = auditoria[1];
        Assert.Equal((AcessoCentral.AcaoCentralAcessada, Joao.Id), (acesso.Acao, acesso.UsuarioId));
        Assert.Equal("""{"origem":"login","aba":null}""", acesso.Depois);
    }

    [Fact]
    public async Task Central_acessada_fica_local_e_o_lote_com_a_liberacao_continua_valido()
    {
        await IniciarAsync();
        Assert.DoesNotContain(AcessoCentral.AcaoCentralAcessada, CatalogosNuvem.AcoesAuditoria);
        Assert.Contains("liberacao", CatalogosNuvem.AcoesAuditoria);
        _autenticador.Cadastrar(Joao, "2222");
        Assert.NotNull(await _acesso.AbrirPeloLoginAsync("joao", "0000", Ct));
        _relogio.Agora += TimeSpan.FromMilliseconds(1);
        Assert.Null(await _acesso.AbrirPeloLoginAsync("joao", "2222", Ct));
        _relogio.Agora += TimeSpan.FromMilliseconds(1);
        _acesso.AbrirPelaVenda(Maria);
        Assert.Null(await _acesso.LiberarAsync("joao", "2222", Ct));
        await _acesso.RegistrarAberturaAsync(AbasCentral.Sincronizacao, Ct);
        // O lote sai com o registro de 5 min atrás ou forçado; força.

        var outbox = new OutboxSync(_fabrica, new RelogioSync(_fabrica, _relogio), "0.0.0-teste", NullLogger<OutboxSync>.Instance);
        Assert.Equal(2, await outbox.AuditoriaPendenteAsync(Ct));
        Assert.True(await outbox.GerarAuditoriaAsync(forcar: true, ct: Ct));

        await using var db = _fabrica.CreateDbContext();
        var evento = await db.EventosSaida.AsNoTracking().SingleAsync(Ct);
        var registros = JsonNode.Parse(evento.Payload)!["registros"]!.AsArray();
        Assert.Equal(["login_negado", "liberacao"], registros.Select(r => r!["acao"]!.GetValue<string>()));
        var login = Assert.Single(JsonNode.Parse(evento.Payload)!["logins"]!.AsArray())!;
        Assert.Equal(("joao", false, MotivoRecusa.SenhaInvalida), (login["login_informado"]!.GetValue<string>(), login["sucesso"]!.GetValue<bool>(), login["motivo_falha"]!.GetValue<string>()));
        var registro = registros[1]!;
        Assert.Equal("liberacao", registro["acao"]!.GetValue<string>());
        Assert.Equal(AcessoCentral.Entidade, registro["entidade"]!.GetValue<string>());
        Assert.Equal(Joao.Id.ToString("D"), registro["autorizado_por_id"]!.GetValue<string>());
        Assert.Equal("venda", registro["depois"]!["origem"]!.GetValue<string>());
        Assert.All(registros, r => Assert.Contains(r!["acao"]!.GetValue<string>(), CatalogosNuvem.AcoesAuditoria));
        Assert.Equal(Sync.Protocolo.Jcs.Sha256Hex(evento.Payload), evento.PayloadSha256);
        // Os dois acessos ficam no banco local, sem lote.
        Assert.Equal(2, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == AcessoCentral.AcaoCentralAcessada && l.EventoId == null, Ct));
    }

    [Fact]
    public async Task Na_desativacao_a_central_fica_so_leitura_e_nao_libera()
    {
        await IniciarAsync();
        _autenticador.Cadastrar(Joao, "2222");
        await using (var db = _fabrica.CreateDbContext())
        {
            // D22: o heartbeat com desativando_confirmado foi montado; os gatilhos recusam a auditoria até o revogado.
            var agora = _relogio.Agora;
            Assert.Equal(1, await db.EstadoConexao.ExecuteUpdateAsync(e => e.SetProperty(x => x.ConfirmandoDesativacaoEm, agora), Ct));
        }

        _acesso.AbrirPelaVenda(Gerente);
        await _acesso.RegistrarAberturaAsync(AbasCentral.Sincronizacao, Ct);
        Assert.True(_acesso.SomenteLeitura);
        Assert.True(_acesso.PodeAbrir(AbasCentral.Sincronizacao));

        _acesso.AbrirPelaVenda(Maria);
        Assert.Equal(TravaDesativacao.Mensagem, await _acesso.LiberarAsync("joao", "2222", Ct));
        Assert.True(_acesso.SomenteLeitura);
        Assert.Null(_acesso.Liberador);
        Assert.False(_acesso.Tem(PermissoesPdv.VerDiagnostico));
        // Já só leitura: a próxima tentativa nem confere o PIN (não roda o argon2 nem conta no bloqueio).
        var conferidos = _autenticador.Conferidos;
        Assert.Equal(TravaDesativacao.Mensagem, await _acesso.LiberarAsync("joao", "0000", Ct));
        Assert.Equal(conferidos, _autenticador.Conferidos);
        // O PIN errado pelo login também não derruba nada (a auditoria recusada só vira aviso no log).
        Assert.Equal(AutenticadorOffline.MensagemInvalido, await _acesso.AbrirPeloLoginAsync("joao", "0000", Ct));
        Assert.Empty(await AuditoriaAsync());
    }

    [Fact]
    public async Task Resposta_do_pin_depois_de_sair_da_central_nao_vale()
    {
        await IniciarAsync();
        _autenticador.Cadastrar(Joao, "2222");

        // Liberar: o argon2 demora, a pessoa sai (Esc) e reabre a Central antes da resposta.
        _acesso.AbrirPelaVenda(Maria);
        var portao = _autenticador.Segurar();
        var liberar = _acesso.LiberarAsync("joao", "2222", Ct);
        _acesso.Encerrar();
        _acesso.AbrirPelaVenda(Maria);
        portao.SetResult();
        Assert.Equal(AcessoCentral.MensagemFechada, await liberar);
        Assert.Null(_acesso.Liberador);
        Assert.False(_acesso.Tem(PermissoesPdv.VerDiagnostico));

        // Entrar pelo login: saiu antes da resposta, a Central não abre sozinha depois.
        _acesso.Encerrar();
        portao = _autenticador.Segurar();
        var entrar = _acesso.AbrirPeloLoginAsync("joao", "2222", Ct);
        _acesso.Encerrar();
        portao.SetResult();
        Assert.Equal(AcessoCentral.MensagemFechada, await entrar);
        Assert.False(_acesso.Aberta);
        Assert.Empty(await AuditoriaAsync());
    }

    [Fact]
    public async Task Aba_sensivel_apertada_duas_vezes_seguidas_grava_um_acesso()
    {
        await IniciarAsync();
        _acesso.AbrirPelaVenda(Gerente);
        await Task.WhenAll(_acesso.RegistrarAberturaAsync(AbasCentral.Logs, Ct), _acesso.RegistrarAberturaAsync(AbasCentral.Logs, Ct));
        Assert.Single(await AuditoriaAsync());
    }

    // --- Com o autenticador de verdade (espelho do fluxo acesso, argon2id, bloqueio persistido) ---

    [AvaloniaFact]
    public async Task Pin_da_central_segue_o_login_conta_no_mesmo_bloqueio_e_nao_abre_sessao_de_operador()
    {
        var api = new ApiFalsa();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: ComApiFalsa(api));
        Assert.True((await pdv.Servicos.GetRequiredService<ServicoAtivacao>()
            .AtivarAsync(new Uri("https://api.exemplo/"), "100001", "K7QM-2XRD", Ct)).Ativado);
        var (pin, hash) = PinDaApi();
        api.PublicarLojaECaixa();
        api.PublicarUsuario("maria", 1, hash);
        api.PublicarUsuario("joao", 2, hash, permissoes: PerfilSupervisor);
        await pdv.Servicos.GetRequiredService<CargaInicial>().ExecutarAsync(ct: Ct);
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>();
        sessao.Identidade = await pdv.Servicos.GetRequiredService<RepositorioTerminal>().ObterIdentidadeAsync(Ct);
        var autenticador = pdv.Servicos.GetRequiredService<IAutenticadorOperador>();
        var acesso = pdv.Servicos.GetRequiredService<AcessoCentral>();
        var agora = DateTimeOffset.UtcNow;

        // PIN certo: o operador com as permissões efetivas do espelho, e nada de sessão nem de `login`.
        var joao = await autenticador.AutenticarParaCentralAsync("joao", pin, agora, Ct);
        Assert.Equal("JOAO", joao.Operador!.Nome);
        Assert.True(joao.Operador.Tem(PermissoesPdv.VerDiagnostico));
        Assert.Null(await acesso.AbrirPeloLoginAsync("joao", pin, Ct));
        Assert.True(acesso.PodeAbrir(AbasCentral.Sincronizacao));
        Assert.Null(sessao.Operador);
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            Assert.Equal(
                ["terminal_ativado", AcessoCentral.AcaoCentralAcessada],
                await db.LogAuditoriaLocal.OrderBy(l => l.OcorridoEm).Select(l => l.Acao).ToListAsync(Ct));
            Assert.Empty(await db.SessoesCaixa.ToListAsync(Ct));
        }

        // 5 PINs errados pela Central bloqueiam a operadora também no login do caixa (o mesmo bloqueio do terminal).
        for (var i = 0; i < AutenticadorOffline.TentativasMaximas - 1; i++)
        {
            Assert.Equal(AutenticadorOffline.MensagemInvalido, await acesso.AbrirPeloLoginAsync("maria", "000000", Ct));
        }

        Assert.Equal(AutenticadorOffline.MensagemBloqueado, await acesso.AbrirPeloLoginAsync("maria", "000000", Ct));
        Assert.Equal(AutenticadorOffline.MensagemBloqueado, await acesso.AbrirPeloLoginAsync("maria", pin, Ct));
        Assert.Equal(AutenticadorOffline.MensagemBloqueado, (await autenticador.AutenticarAsync("maria", pin, DateTimeOffset.UtcNow, Ct)).Erro);
        Assert.False(acesso.Aberta);

        // Toda chave que a ativação e as telas gravam em configuracao_terminal está classificada (ChavesTerminalTests).
        var hardware = pdv.Servicos.GetRequiredService<ServicoHardware>();
        await hardware.GravarAsync(hardware.Atual, PreferenciasCaixa.Padrao, joao.Operador.Id, joao.Operador.Id, Ct);
        await pdv.Servicos.GetRequiredService<ServicoParametrosLocais>().AlternarTemaAsync(joao.Operador.Id, Ct);
        await pdv.Servicos.GetRequiredService<RepositorioTerminal>().GravarConfiguracaoAsync(Data.Backup.BackupLocal.ChavePastaSecundaria, "/media/pendrive", ct: Ct);
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            var chaves = await db.ConfiguracaoTerminal.Select(c => c.Chave).ToListAsync(Ct);
            Assert.Contains(ChavesConfiguracaoTerminal.ChavePrivadaTerminal, chaves);
            Assert.Contains(ChavesHardware.Modelo, chaves);
            Assert.All(chaves, c => Assert.True(
                ChavesExibiveis.Todas.Contains(c) ^ ChavesConfiguracaoTerminal.Internas.Contains(c), $"chave sem classificação: {c}"));
        }
    }

    private static (string Pin, string Hash) PinDaApi()
    {
        var caso = JsonNode.Parse(ApiFalsa.Fixture("argon2.vetores.json"))!["casos"]!.AsArray().First(c => c!["valido"]!.GetValue<bool>())!;
        return (caso["senha"]!.GetValue<string>(), caso["hash"]!.GetValue<string>());
    }

    private static Action<IServiceCollection> ComApiFalsa(ApiFalsa api) => servicos =>
        servicos.AddSingleton<IClienteSync>(sp => new ClienteSyncHttp(
            new HttpClient(api),
            sp.GetRequiredService<MaquinaLocal>().ParaCliente(),
            sp.GetRequiredService<IRelogio>(),
            sp.GetRequiredService<IFonteToken>(),
            () => new Uri("https://api.exemplo/")));

    private static TimeSpan ValidadeMaisUmSegundo => AcessoCentral.ValidadeLiberacao + TimeSpan.FromSeconds(1);

    private sealed class Relogio : IRelogio
    {
        public DateTimeOffset Agora { get; set; } = new RelogioSistema().Agora;
    }

    /// <summary>O relógio monotônico, avançado à mão (o da liberação; a hora do sistema é o <see cref="Relogio"/>).</summary>
    private sealed class Tempo : TimeProvider
    {
        private long _ticks = 1;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => _ticks;

        public void Avancar(TimeSpan tempo) => _ticks += tempo.Ticks;
    }

    /// <summary>Autenticador em memória: PIN por login, com bloqueio ligado à mão (o de verdade está no teste com a tela).</summary>
    private sealed class Autenticador : IAutenticadorOperador
    {
        private readonly Dictionary<string, (Operador Operador, string Pin)> _usuarios = new(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> _bloqueados = new(StringComparer.OrdinalIgnoreCase);
        private TaskCompletionSource? _portao;

        /// <summary>Quantas vezes um PIN foi conferido (cada uma roda o argon2 e conta no bloqueio no de verdade).</summary>
        public int Conferidos { get; private set; }

        /// <summary>A próxima conferência espera o portão abrir (o argon2 demorando).</summary>
        public TaskCompletionSource Segurar() => _portao = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        public void Cadastrar(Operador operador, string pin) => _usuarios[operador.Login] = (operador, pin);

        public void Bloquear(string login) => _bloqueados.Add(login);

        public void Desbloquear(string login) => _bloqueados.Remove(login);

        public async Task<ResultadoLogin> AutenticarParaCentralAsync(string usuario, string pin, DateTimeOffset agora, CancellationToken ct = default)
        {
            Conferidos++;
            if (_portao is { } portao)
            {
                _portao = null;
                await portao.Task;
            }

            usuario = usuario.Trim();
            if (_bloqueados.Contains(usuario))
            {
                return new ResultadoLogin(null, AutenticadorOffline.MensagemBloqueado, MotivoRecusa.Bloqueado);
            }

            return _usuarios.TryGetValue(usuario, out var u) && u.Pin == pin
                ? new ResultadoLogin(u.Operador, null, null, u.Operador.Id)
                : new ResultadoLogin(null, AutenticadorOffline.MensagemInvalido, MotivoRecusa.SenhaInvalida, _usuarios.TryGetValue(usuario, out var x) ? x.Operador.Id : null);
        }

        public Task<ResultadoLogin> AutenticarAsync(string usuario, string senha, DateTimeOffset agora, CancellationToken ct = default) =>
            throw new NotSupportedException("A Central não abre sessão de operador.");

        public Task<ResultadoLiberacaoSupervisor> LiberarAsync(
            string usuario, string pin, string permissao, Guid operadorId, DateTimeOffset agora, CancellationToken ct = default) =>
            throw new NotSupportedException("A Central libera pelo AutenticarParaCentralAsync.");
    }
}
