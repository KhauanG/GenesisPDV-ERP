using GenesisPDV.Sync.Push;

namespace GenesisPDV.Sync.Cliente;

/// <summary>Estado do terminal visto pelo ciclo online (SYNC 3.8, 5, 20.5, 22.1).</summary>
public enum EstadoTerminalSync
{
    Ativo,

    /// <summary>Revogação aceitando pendências: não vende, envia o outbox e confirma (3.8).</summary>
    Desativando,

    /// <summary>Desativado no ERP (401 <c>TERMINAL_REVOGADO</c> ou desativação confirmada): só a tela de diagnóstico.</summary>
    Revogado,

    /// <summary><c>id_hardware</c> diferente do registrado: vendas bloqueadas até a aprovação no ERP (20.5).</summary>
    HardwareAlterado,

    /// <summary>Sequência local abaixo da que a nuvem recebeu (banco restaurado/copiado): envio parado (22.1).</summary>
    Regressao,

    /// <summary>
    /// Lacuna de sequência (SYNC 8.6; Fase 1C, C15): a nuvem espera eventos que o caixa não tem mais. Vendas novas
    /// bloqueadas (a atual termina) até o supervisor declarar a lacuna (F11 › S); o push segue em backoff.
    /// </summary>
    Lacuna,

    /// <summary>Token recusado ou protocolo não suportado: a nuvem não aceita mais este terminal como está.</summary>
    Bloqueado,

    /// <summary>
    /// 403 da empresa ou da loja (<see cref="MensagensBloqueioNuvem"/>: empresa suspensa ou cancelada, PDV desabilitado,
    /// loja inativa): a venda em andamento termina, novas vendas são recusadas e o push continua (SYNC 2.5, 20.6; MD 2.3).
    /// </summary>
    Suspenso,
}

/// <summary>Situação do sync para a barra de status (PDV 30.2) e as telas.</summary>
/// <param name="Online">A última chamada à API respondeu (18.3: offline = 2 falhas de transporte seguidas).</param>
/// <param name="Pendentes">Eventos do outbox ainda não confirmados (inclui os rejeitados: o "⇅ N" da barra).</param>
/// <param name="Erro">Último erro de sync (texto para o status detalhado e o heartbeat).</param>
public sealed record SituacaoSincronizacao(bool Online, int Pendentes, DateTimeOffset? OfflineDesde, string? Erro = null)
{
    /// <summary>Push ou pull em andamento.</summary>
    public bool Sincronizando { get; init; }

    /// <summary>Eventos em quarentena na nuvem (<c>rejeitado</c>).</summary>
    public int Rejeitados { get; init; }

    public DateTimeOffset? UltimoPullSucessoEm { get; init; }

    public EstadoTerminalSync Terminal { get; init; } = EstadoTerminalSync.Ativo;

    /// <summary>Código do 403 que deixou o terminal <see cref="EstadoTerminalSync.Suspenso"/> (nulo fora dele).</summary>
    public string? BloqueioNuvem { get; init; }

    /// <summary>Terminal sem nuvem (demonstração, F8) ou ainda sem identidade: nada sobe nem desce.</summary>
    public bool SemNuvem { get; init; }

    /// <summary>
    /// D22: o heartbeat com <c>desativando_confirmado</c> está na rede. Até a resposta, logout, Ctrl+Alt+C e toda
    /// gravação que subiria são recusados (o banco recusa de qualquer jeito, <c>TravaDesativacao</c>); a tela avisa.
    /// </summary>
    public bool ConfirmandoDesativacao { get; init; }

    /// <summary>
    /// Lacuna de sequência revelada pelo push (SYNC 8.6; C15): a declarar (<see cref="EstadoTerminalSync.Lacuna"/>) ou
    /// recuperável (eventos de uma lacuna já declarada esperando a liberação do supervisor; não bloqueia vendas).
    /// </summary>
    public LacunaEventos? Lacuna { get; init; }
}

/// <summary>Desfecho do <c>GET /sync/estado</c> na abertura (SYNC 5).</summary>
public enum DesfechoHandshake
{
    Liberado,

    /// <summary>Sem resposta da API: segue com os dados locais (o ciclo repete o handshake ao reconectar).</summary>
    SemConexao,

    Desativando,
    Revogado,
    HardwareAlterado,
    Regressao,

    /// <summary>Token recusado (<c>TOKEN_INVALIDO</c>) ou protocolo abaixo do mínimo da nuvem.</summary>
    Bloqueado,

    /// <summary>403 da empresa ou da loja (<see cref="EstadoTerminalSync.Suspenso"/>): bloqueia novas vendas, o push continua.</summary>
    Suspenso,

    /// <summary>
    /// O token não abre com esta conta do sistema (<see cref="Token.TokenIlegivelException"/>; implantação I3): o banco é
    /// da máquina, a proteção é da conta que ativou (D21). Nada sobe nem desce até abrir com aquela conta.
    /// </summary>
    ContaDiferente,
}

/// <param name="Mensagem">Texto para a tela de bloqueio ou o aviso (perda provável, sem conexão).</param>
public sealed record ResultadoHandshake(DesfechoHandshake Desfecho, string? Mensagem = null);

/// <summary>
/// Serviço de sincronização em segundo plano (PDV 30; SYNC 18): handshake, pull periódico, push do outbox, heartbeat e
/// comandos. A tela só lê a situação, pede "acordar" depois de gravar um evento e mostra as mensagens do ERP.
/// </summary>
public interface IServicoSincronizacao
{
    SituacaoSincronizacao Situacao { get; }

    event EventHandler<SituacaoSincronizacao>? SituacaoAlterada;

    /// <summary>Texto do comando <c>mensagem</c> (ERP › PDVs/Terminais › Enviar mensagem).</summary>
    event EventHandler<string>? MensagemRecebida;

    /// <summary><c>GET /sync/estado</c> antes do login (SYNC 5); sem identidade real, <see cref="DesfechoHandshake.Liberado"/>.</summary>
    Task<ResultadoHandshake> HandshakeAsync(CancellationToken ct = default);

    /// <summary>Liga o ciclo em segundo plano (idempotente); sem identidade real, não faz nada.</summary>
    void Iniciar();

    /// <summary>Pede um ciclo de push logo (debounce de 500 ms) e reconta os pendentes.</summary>
    Task AcordarAsync(CancellationToken ct = default);

    /// <summary>"Sincronizar agora" (Ctrl+Alt+S, PDV 30.2): push, heartbeat e pull na hora.</summary>
    void SincronizarAgora();

    /// <summary>
    /// Declara a lacuna da <see cref="SituacaoSincronizacao.Lacuna"/> (SYNC 8.6; C15) com a liberação do supervisor
    /// (<c>pdv.config.fiscal</c>): <c>declarar_lacuna</c> no push, e as vendas voltam. Recusa da nuvem, sem lacuna a
    /// declarar ou sem conexão → <see cref="Core.Comum.RegraNegocioException"/> com o motivo. <paramref name="origem"/>:
    /// quem pediu e a tela, na auditoria da liberação (nulo = o operador da venda e o F11 › S).
    /// </summary>
    Task DeclararLacunaAsync(Guid autorizadoPorId, string? observacao, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null);

    /// <summary>
    /// Libera o reenvio dos eventos de uma lacuna já declarada (SYNC 8.6; C15): o próximo push leva
    /// <c>recuperar_lacuna</c> com o supervisor. Sem lacuna recuperável → <see cref="Core.Comum.RegraNegocioException"/>.
    /// <paramref name="origem"/>: como em <see cref="DeclararLacunaAsync"/>.
    /// </summary>
    Task AutorizarRecuperacaoLacunaAsync(Guid autorizadoPorId, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null);
}

/// <summary>
/// Quem pediu a liberação da lacuna e de que tela, para a auditoria <c>liberacao</c> (Central do PDV, bloco G7; README ›
/// decisão 72): a Central aberta pelo login não tem operador na sessão, e quem está nela pode não ser o operador da venda.
/// </summary>
/// <param name="SolicitanteId">Quem está na tela e pediu (o usuário da Central).</param>
/// <param name="Localizacao">A tela, como as outras auditorias do PDV a gravam.</param>
public sealed record OrigemLiberacaoLacuna(Guid? SolicitanteId, string Localizacao)
{
    /// <summary>A tela de sempre da lacuna (o F11 › S da venda).</summary>
    public const string LocalizacaoStatusSync = "PDV › Status da sincronização";
}

/// <summary>
/// Textos dos bloqueios que a nuvem afirma (SYNC 2.5): 401 <c>TOKEN_INVALIDO</c> e os 403 da empresa ou da loja, que a
/// API responde no <c>/sync/estado</c>, no pull e no heartbeat (o push continua aceito, menos com a empresa cancelada).
/// </summary>
public static class MensagensBloqueioNuvem
{
    public const string TokenRecusado = "A nuvem recusou o token deste terminal. Chame o suporte (pode ser preciso reativar).";

    public const string EmpresaSuspensa =
        "O acesso desta empresa à nuvem Genesis está suspenso. Novas vendas ficam bloqueadas; o que já foi registrado neste " +
        "caixa continua subindo para a nuvem. Entre em contato com o suporte Genesis.";

    public const string EmpresaCancelada =
        "O contrato desta empresa foi cancelado: a nuvem não aceita mais este caixa e novas vendas ficam bloqueadas. O banco " +
        "local foi mantido. Entre em contato com o suporte Genesis.";

    public const string PdvDesabilitado =
        "O PDV está desabilitado para esta loja no ERP (Usa PDV = Não). Novas vendas ficam bloqueadas; o que já foi " +
        "registrado neste caixa continua subindo para a nuvem. Peça ao gerente para revisar a configuração.";

    public const string LojaInativa =
        "A loja deste caixa está inativa ou sem PDV no ERP. Novas vendas ficam bloqueadas; o que já foi registrado neste " +
        "caixa continua subindo para a nuvem. Peça ao gerente para revisar o cadastro da loja.";

    /// <summary>Os 403 que viram <see cref="EstadoTerminalSync.Suspenso"/> (SYNC 2.5: "bloqueia novas vendas após a atual").</summary>
    public static bool Suspende(string? codigo) => codigo is "EMPRESA_SUSPENSA" or "EMPRESA_CANCELADA" or "PDV_DESABILITADO" or "LOJA_INATIVA";

    /// <summary>Título curto (indicador da barra e tela de bloqueio).</summary>
    public static string Titulo(string? codigo) => codigo switch
    {
        "EMPRESA_SUSPENSA" => "Empresa suspensa — novas vendas bloqueadas",
        "EMPRESA_CANCELADA" => "Empresa cancelada — caixa bloqueado",
        "PDV_DESABILITADO" => "PDV desabilitado no ERP — novas vendas bloqueadas",
        "LOJA_INATIVA" => "Loja inativa no ERP — novas vendas bloqueadas",
        _ => "Vendas bloqueadas pela nuvem",
    };

    /// <summary>Texto completo (tela de bloqueio, dica do indicador e <c>ultimo_erro</c>).</summary>
    public static string Mensagem(string? codigo) => codigo switch
    {
        "EMPRESA_SUSPENSA" => EmpresaSuspensa,
        "EMPRESA_CANCELADA" => EmpresaCancelada,
        "PDV_DESABILITADO" => PdvDesabilitado,
        "LOJA_INATIVA" => LojaInativa,
        _ => "A nuvem recusou este caixa. Chame o suporte.",
    };
}

/// <summary>Nível visual do indicador (o texto sempre leva ícone: o estado nunca é só cor, PDV 9.1).</summary>
public enum NivelIndicador
{
    Ok,
    Info,
    Aviso,
    Erro,
}

/// <summary>Texto do indicador da barra (PDV 30.2) a partir da situação.</summary>
public static class IndicadorSync
{
    public static readonly TimeSpan Desatualizado = TimeSpan.FromHours(24);

    public static (string Texto, NivelIndicador Nivel) Calcular(SituacaoSincronizacao s, DateTimeOffset agora)
    {
        ArgumentNullException.ThrowIfNull(s);
        switch (s.Terminal)
        {
            case EstadoTerminalSync.Revogado:
                return ("■ Terminal desativado pelo ERP", NivelIndicador.Erro);
            case EstadoTerminalSync.HardwareAlterado:
                return ("■ Hardware alterado — aguardando aprovação no ERP", NivelIndicador.Erro);
            case EstadoTerminalSync.Desativando:
                return ($"▲ Em desativação — enviando pendências ({s.Pendentes})", NivelIndicador.Aviso);
            case EstadoTerminalSync.Regressao or EstadoTerminalSync.Bloqueado:
                return ("▲ Erro de sync — chame o suporte", NivelIndicador.Erro);
            case EstadoTerminalSync.Lacuna:
                return ($"■ Lacuna de eventos {s.Lacuna?.Faixa} — chame o supervisor (F11 › S)", NivelIndicador.Erro);
            case EstadoTerminalSync.Suspenso:
                return ($"■ {MensagensBloqueioNuvem.Titulo(s.BloqueioNuvem)}", NivelIndicador.Erro);
        }

        if (s.SemNuvem)
        {
            return ("● Demonstração (sem nuvem)", NivelIndicador.Info);
        }

        if (!s.Online)
        {
            var minutos = s.OfflineDesde is { } desde ? (int)Math.Max(0, (agora - desde).TotalMinutes) : 0;
            return (minutos > 0 ? $"● Offline há {Duracao(minutos)}" : "● Offline", NivelIndicador.Erro);
        }

        if (s.Lacuna is { Recuperavel: true } recuperavel)
        {
            return ($"▲ Eventos da lacuna {recuperavel.Faixa} — liberação do supervisor (F11 › S)", NivelIndicador.Aviso);
        }

        if (s.Rejeitados > 0)
        {
            return ("▲ Erro de sync", NivelIndicador.Aviso);
        }

        if (s.Sincronizando)
        {
            return ("⇅ Sincronizando", NivelIndicador.Info);
        }

        if (s.UltimoPullSucessoEm is { } pull && agora - pull > Desatualizado)
        {
            var dias = (int)Math.Floor((agora - pull).TotalDays);
            return (dias <= 1 ? "▲ Cadastros de ontem" : $"▲ Cadastros de {dias} dias atrás", NivelIndicador.Aviso);
        }

        return ("● Online", NivelIndicador.Ok);
    }

    private static string Duracao(int minutos) => minutos < 60
        ? $"{minutos} min"
        : minutos < 60 * 48 ? $"{minutos / 60} h" : $"{minutos / 60 / 24} dias";
}

/// <summary>Intervalos e tempos do ciclo (SYNC 18.2–18.3); os intervalos da nuvem (heartbeat) substituem os padrões.</summary>
public sealed record OpcoesSincronizacao
{
    public TimeSpan Heartbeat { get; init; } = TimeSpan.FromSeconds(30);
    public TimeSpan Pull { get; init; } = TimeSpan.FromSeconds(30);
    public TimeSpan PushPendente { get; init; } = TimeSpan.FromSeconds(15);
    public TimeSpan Debounce { get; init; } = TimeSpan.FromMilliseconds(500);

    /// <summary>Teto do backoff de heartbeat e pull (18.3: 5 min; o do evento da frente é 10 min).</summary>
    public TimeSpan TetoBackoff { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>Página do pull fora da carga inicial (PDV 30.3).</summary>
    public int LimitePull { get; init; } = 500;

    /// <summary>Offline por mais que isso: o próximo contato refaz o handshake (SYNC 5).</summary>
    public TimeSpan HandshakeAposOffline { get; init; } = TimeSpan.FromHours(1);

    /// <summary>
    /// Consulta do <c>GET /sync/eventos-status</c> para os <c>rejeitado</c> (SYNC 7.2, 18.2: 1 h, só se houver algum), a rede
    /// de segurança do <c>eventos_resolvidos</c> do heartbeat.
    /// </summary>
    public TimeSpan ConsultaEventosStatus { get; init; } = TimeSpan.FromHours(1);
}
