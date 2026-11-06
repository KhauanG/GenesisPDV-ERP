using System.Diagnostics;
using System.Net;
using System.Text.Json;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Ativacao;
using GenesisPDV.Sync.Ciclo;
using GenesisPDV.Sync.Protocolo;
using GenesisPDV.Sync.Pull;
using GenesisPDV.Sync.Push;
using GenesisPDV.Sync.Recuperacao;
using GenesisPDV.Sync.Relogio;
using GenesisPDV.Sync.Token;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using F = GenesisPDV.Sync.Protocolo.FormatoProtocolo;

namespace GenesisPDV.Sync.Cliente;

/// <summary>
/// Ciclo online do PDV (SYNC 5, 6.5, 7.5, 18, 21.1; PDV 30): um único laço em segundo plano, uma chamada por vez, sem
/// transação do SQLite aberta durante a rede (18.4).
/// <list type="bullet">
/// <item><b>Push</b>: logo depois de cada gravação no outbox (debounce de 500 ms, <see cref="AcordarAsync"/>) e a cada
/// <c>push_pendente_s</c> enquanto houver pendentes; repete na hora enquanto houver lote. Antes, o lote de
/// <c>auditoria.registros</c> do <c>log_auditoria_local</c> (5 min/200; na desativação, tudo).</item>
/// <item><b>Heartbeat</b> no intervalo da nuvem (30 s sem SSE): telemetria, números, acks; aplica
/// <c>status_terminal</c>, comandos (<see cref="ProcessadorComandos"/>), eventos resolvidos, <c>renovar_token</c> e os
/// intervalos. Com comandos, o próximo heartbeat (com os acks) sai em 1 s. Os acks vão em fatias do máximo do contrato
/// (100 comandos, 500 eventos resolvidos): o resto fica para o heartbeat seguinte, também em 1 s. Heartbeat recusado
/// como inválido (400/422) descarta os acks pendentes em vez de repeti-los para sempre: a nuvem entrega de novo o que
/// ficou sem ack e o dedupe devolve o mesmo resultado.</item>
/// <item><b>Pull</b> a cada 30 s, fluxo a fluxo na ordem da 6.1, página seguinte imediata com <c>tem_mais</c>. Em
/// <c>desativando</c>, só <c>acesso</c> e <c>configuracao</c> (3.8).</item>
/// <item><b>Eventos-status</b> a cada 1 h, se houver <c>rejeitado</c> (7.2): a rede de segurança do
/// <c>eventos_resolvidos</c>, aplicada do mesmo jeito e sem ack (<see cref="ConsultarEventosStatusAsync"/>).</item>
/// <item><b>Backoff</b> de heartbeat, pull e handshake refeito pelo laço: 5 s a 5 min com jitter (18.3), nunca menos que
/// o <c>Retry-After</c> (429/503), zerado no primeiro sucesso (o do handshake também na volta de offline); o do evento da
/// frente é do <see cref="EnvioPush"/>. Toda falha reagenda (também as que
/// mudam o estado do terminal): o laço nunca gira sem espera. Offline = 2 falhas de transporte seguidas ou 1 timeout de
/// heartbeat (10 s, <see cref="TemposLimiteSync"/>); online de novo na primeira resposta. Offline por mais de 1 h: o
/// próximo contato refaz o handshake.</item>
/// <item><b>Desativação</b> (3.8): <c>desativando</c> (heartbeat, handshake ou comando <c>revogar</c>) é gravado na
/// identidade e daí em diante nenhum número é reservado; com o outbox vazio e a auditoria enviada, o heartbeat leva
/// <c>desativando_confirmado</c> e os números finais (só sem venda aberta: o encerramento dela ainda gera auditoria);
/// da contagem até a resposta, o banco recusa toda gravação que subiria (D22, <see cref="TravaDesativacao"/>).
/// <c>revogado</c> (confirmação ou 401 <c>TERMINAL_REVOGADO</c> em
/// qualquer chamada) é gravado e o laço para; o banco local nunca é apagado.</item>
/// <item><c>409 HARDWARE_ALTERADO</c> ou <c>status_terminal = hardware_alterado</c>: o push para (outbox intacto) até o
/// heartbeat voltar a <c>ativo</c> ou <c>desativando</c> (a API só manda os dois com o hardware conferido).
/// <c>409 REGRESSAO_DETECTADA</c> ou regressão no handshake: o push para (22.1, Fase 1C). <c>401 TOKEN_INVALIDO</c>:
/// push e pull param e só o heartbeat continua, com backoff; o primeiro <c>200</c> autenticado libera tudo de novo. O
/// handshake seguinte que passa (Enter na tela de bloqueio, volta de offline longo) limpa regressão e protocolo.</item>
/// <item><b>Lacuna</b> (SYNC 8.6; Fase 1C, C15): o <see cref="EnvioPush"/> devolve à fila o que o caixa ainda tem e
/// revela o que não existe mais. A lacuna a declarar bloqueia vendas novas (<see cref="EstadoTerminalSync.Lacuna"/>) até
/// o supervisor declará-la (<see cref="DeclararLacunaAsync"/>, <c>declarar_lacuna</c>); a recuperável (eventos de uma
/// lacuna já declarada) só avisa e espera a liberação do reenvio (<see cref="AutorizarRecuperacaoLacunaAsync"/>), que
/// vale até sair o último evento do outbox na faixa (vários lotes de 50). As duas ações correm fora do laço, sob o
/// mesmo semáforo do push (uma chamada de push por vez, e nenhum resultado de push em voo grava backoff por cima da
/// liberação). O primeiro push que avança sem lacuna limpa o aviso. A lacuna fica só em memória: na abertura do app e
/// na declaração recusada, a espera da lacuna cai e o próximo push a revela na hora.</item>
/// <item>403 da empresa ou da loja (<see cref="MensagensBloqueioNuvem"/>: <c>EMPRESA_SUSPENSA</c>,
/// <c>EMPRESA_CANCELADA</c>, <c>PDV_DESABILITADO</c>, <c>LOJA_INATIVA</c>) no handshake, no pull ou no heartbeat:
/// <see cref="EstadoTerminalSync.Suspenso"/> com a mensagem do código (novas vendas recusadas, a atual termina); o push
/// continua e o heartbeat, o pull e o handshake seguem com backoff até a primeira resposta 200 de um deles.</item>
/// </list>
/// Terminal de demonstração ou sem identidade: nada sobe nem desce; só o contador de pendentes.
/// </summary>
public sealed class ServicoSincronizacaoHttp : IServicoSincronizacao, IAsyncDisposable, IDisposable
{
    private static readonly string[] FluxosDesativando = [FluxosSync.Acesso, FluxosSync.Configuracao];
    private static readonly string[] NaoConfirmados = [StatusEventoSaida.Pendente, StatusEventoSaida.Enviando, StatusEventoSaida.ErroTemporario];
    private static readonly TimeSpan HeartbeatComAck = TimeSpan.FromSeconds(1);

    /// <summary>Máximo de <c>comandos_resultado</c> num heartbeat (<c>heartbeatSchema</c> do shared): o resto vai no próximo.</summary>
    internal const int MaximoAcksComandos = 100;

    /// <summary>Máximo de <c>eventos_resolvidos_ack</c> num heartbeat (<c>heartbeatSchema</c> do shared).</summary>
    internal const int MaximoAcksResolvidos = 500;

    private readonly IClienteSync _cliente;
    private readonly IDbContextFactory<PdvDbContext> _fabrica;
    private readonly RepositorioTerminal _terminal;
    private readonly AplicadorPull _aplicador;
    private readonly OutboxSync _outbox;
    private readonly EnvioPush _envio;
    private readonly ProcessadorComandos _comandos;
    private readonly RotacaoToken _rotacao;
    private readonly RelogioSync _relogio;
    private readonly MaquinaLocal _maquina;
    private readonly OpcoesSincronizacao _opcoes;
    private readonly ILogger<ServicoSincronizacaoHttp> _log;
    private readonly ReidratacaoLocal _reidratacao;
    private readonly Func<Guid?> _operador;
    private readonly Stopwatch _cronometro = Stopwatch.StartNew();
    private readonly SemaphoreSlim _sinal = new(0, int.MaxValue);
    private readonly CancellationTokenSource _parar = new();
    private readonly Lock _trava = new();

    private Task? _laco;
    private TimeSpan _intervaloHeartbeat;
    private TimeSpan _intervaloPull;
    private TimeSpan _intervaloPush;
    private TimeSpan _proximoPush;
    private TimeSpan _proximoHeartbeat;
    private TimeSpan _proximoPull;

    /// <summary>Próximo handshake refeito pelo laço (<see cref="_handshakePendente"/>), com backoff e <c>Retry-After</c>.</summary>
    private TimeSpan _proximoHandshake;

    /// <summary>Próxima consulta do <c>GET /sync/eventos-status</c> (7.2); zero = na primeira volta online do laço.</summary>
    private TimeSpan _proximaConsultaStatus;
    private int _falhasConsultaStatus;
    private int _falhasHeartbeat;
    private int _falhasPull;
    private int _falhasHandshake;
    private int _falhasTransporte;
    private bool _handshakePendente;
    private bool _hardwareAlterado;

    /// <summary>401 sem <c>TERMINAL_REVOGADO</c>: só heartbeat (com backoff) até uma chamada autenticada voltar a dar 200.</summary>
    private bool _tokenRecusado;

    /// <summary>Protocolo abaixo do mínimo da nuvem (handshake): até um handshake que passe.</summary>
    private bool _protocoloRecusado;

    /// <summary>Regressão da sequência (handshake ou <c>409 REGRESSAO_DETECTADA</c>): até a reidratação concluir (22.1).</summary>
    private bool _regressao;

    /// <summary>
    /// <c>409 REGRESSAO_DETECTADA</c> no push: a sequência que a nuvem já tinha com outro evento. O handshake seguinte
    /// (refeito já) reidrata a partir dela, mesmo com a sequência local acima da recebida pela nuvem (22.1).
    /// </summary>
    private long? _regressaoNoPushEm;

    /// <summary>
    /// Reidratação começada e não concluída (<see cref="ReidratacaoPendente"/>, ou evento com sequência provisória ≤ 0):
    /// o push para até ela terminar — o evento novo subiria na frente dos deslocados e a nuvem veria uma lacuna falsa
    /// (8.6) — e o handshake (refeito com backoff) a retoma. Também lido do banco ao ligar o ciclo (app reaberto).
    /// </summary>
    private bool _reidratacaoPendente;

    /// <summary>Código do 403 da empresa ou da loja: até uma resposta 200 do handshake, do pull ou do heartbeat.</summary>
    private string? _bloqueioNuvem;

    /// <summary>Lacuna revelada pelo push (8.6): até ser declarada, recuperada ou o push avançar sem ela.</summary>
    private volatile LacunaEventos? _lacuna;

    /// <summary>O push do laço e as ações da lacuna (declarar, liberar o reenvio) não se cruzam na rede.</summary>
    private readonly SemaphoreSlim _semaforoPush = new(1, 1);
    private string? _ultimoErro;

    /// <summary>
    /// D22: este processo marcou a trava da confirmação da desativação (<see cref="TravaDesativacao"/>) e espera a
    /// resposta do heartbeat. Uma trava no banco sem este sinal sobrou de um processo que caiu no meio e é limpa.
    /// </summary>
    private volatile bool _confirmandoDesativacao;

    /// <summary>Marcar a trava (montagem do heartbeat) e limpar a órfã (handshake, início do laço) não se cruzam.</summary>
    private readonly SemaphoreSlim _semaforoTravaD22 = new(1, 1);

    /// <summary>Acks ainda não aceitos pela nuvem, na ordem; cada heartbeat leva no máximo <see cref="MaximoAcksComandos"/>.</summary>
    private readonly List<ResultadoComando> _acksComandos = [];
    private readonly List<Guid> _acksResolvidos = [];

    public ServicoSincronizacaoHttp(
        IClienteSync cliente,
        IDbContextFactory<PdvDbContext> fabrica,
        RepositorioTerminal terminal,
        AplicadorPull aplicador,
        OutboxSync outbox,
        EnvioPush envio,
        ProcessadorComandos comandos,
        RotacaoToken rotacao,
        RelogioSync relogio,
        MaquinaLocal maquina,
        OpcoesSincronizacao opcoes,
        ILogger<ServicoSincronizacaoHttp> log,
        Func<Guid?>? operador = null)
    {
        _cliente = cliente;
        _fabrica = fabrica;
        _terminal = terminal;
        _aplicador = aplicador;
        _outbox = outbox;
        _envio = envio;
        _comandos = comandos;
        _rotacao = rotacao;
        _relogio = relogio;
        _maquina = maquina;
        _opcoes = opcoes;
        _log = log;
        _reidratacao = new ReidratacaoLocal(cliente, fabrica, new RelogioCorrigido(relogio), log);
        _operador = operador ?? (() => null);
        _intervaloHeartbeat = opcoes.Heartbeat;
        _intervaloPull = opcoes.Pull;
        _intervaloPush = opcoes.PushPendente;
        _comandos.MensagemRecebida += (_, texto) => MensagemRecebida?.Invoke(this, texto);
        _comandos.DesativacaoIniciada += (_, _) => AgendarHeartbeat(TimeSpan.Zero);
        Situacao = new SituacaoSincronizacao(false, 0, null) { SemNuvem = true };
    }

    public SituacaoSincronizacao Situacao { get; private set; }

    public event EventHandler<SituacaoSincronizacao>? SituacaoAlterada;

    public event EventHandler<string>? MensagemRecebida;

    /// <summary>O laço está rodando (testes e diagnóstico).</summary>
    public bool Rodando => _laco is { IsCompleted: false };

    /// <summary>Quanto falta para o próximo heartbeat (testes do backoff e do <c>Retry-After</c>).</summary>
    internal TimeSpan EsperaHeartbeat => _proximoHeartbeat - Agora;

    /// <summary>Quanto falta para o próximo pull (testes do backoff e do <c>Retry-After</c>).</summary>
    internal TimeSpan EsperaPull => _proximoPull - Agora;

    /// <summary>Quanto falta para o laço refazer o handshake pendente (testes do backoff e do <c>Retry-After</c>).</summary>
    internal TimeSpan EsperaHandshake => _proximoHandshake - Agora;

    public async Task<ResultadoHandshake> HandshakeAsync(CancellationToken ct = default)
    {
        var identidade = await _terminal.ObterIdentidadeAsync(ct);
        if (identidade is null || identidade.Demonstracao)
        {
            await PublicarAsync(ct: ct);
            return new ResultadoHandshake(DesfechoHandshake.Liberado);
        }

        await _relogio.CarregarAsync(ct);
        if (identidade.Status == StatusIdentidade.Revogado)
        {
            await PublicarAsync(EstadoTerminalSync.Revogado, ct);
            return new ResultadoHandshake(DesfechoHandshake.Revogado);
        }

        await LimparTravaOrfaAsync(identidade, ct);

        RespostaEstado estado;
        try
        {
            estado = await _cliente.EstadoAsync(ct);
            await MarcarOnlineAsync(ct);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            var desfecho = await TratarErroAsync(e, "handshake", ct);
            // Backoff próprio (18.3), nunca menos que o Retry-After: o laço só refaz o handshake depois disso, e não a
            // cada volta (503 MANUTENCAO, 403 da empresa). Depois do TratarErroAsync, que pode marcar a volta de offline.
            _falhasHandshake++;
            _proximoHandshake = Agora + EsperaApos(_falhasHandshake, e);
            if (desfecho is { Desfecho: not DesfechoHandshake.Suspenso })
            {
                return desfecho;
            }

            _handshakePendente = true;
            if (desfecho is { Desfecho: DesfechoHandshake.Suspenso })
            {
                // 22.2, T41: o recuperar responde com a empresa suspensa, como o push; sem isto o banco restaurado ficaria
                // com o push parado (regressão, reidratação pendente) até a reativação.
                await ReidratarSuspensoAsync(ct);
            }

            await PublicarAsync(ct: ct);
            return desfecho ?? new ResultadoHandshake(DesfechoHandshake.SemConexao,
                "Sem conexão com a nuvem: o caixa abre com os dados locais e sincroniza quando a internet voltar.");
        }

        _falhasHandshake = 0;
        return await AplicarEstadoAsync(estado, ct);
    }

    public void Iniciar()
    {
        lock (_trava)
        {
            if (_laco is not null)
            {
                return;
            }

            _laco = Task.Run(() => ExecutarAsync(_parar.Token));
        }
    }

    public async Task AcordarAsync(CancellationToken ct = default)
    {
        AgendarPush(_opcoes.Debounce);
        await PublicarAsync(ct: ct);
    }

    public void SincronizarAgora()
    {
        lock (_trava)
        {
            _proximoPush = _proximoHeartbeat = _proximoPull = _proximoHandshake = _proximaConsultaStatus = TimeSpan.Zero;
            _falhasHeartbeat = _falhasPull = _falhasHandshake = _falhasConsultaStatus = 0;
        }

        _sinal.Release();
    }

    /// <summary>Encerramento síncrono (o contêiner de serviços do app): para o laço e espera até 5 s.</summary>
    public void Dispose()
    {
        if (_parar.IsCancellationRequested)
        {
            return;
        }

        _parar.Cancel();
        try
        {
            _laco?.Wait(TimeSpan.FromSeconds(5));
        }
        catch (AggregateException)
        {
            // Cancelado ou com erro já registrado no log: nada a fazer no encerramento.
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_parar.IsCancellationRequested)
        {
            return;
        }

        await _parar.CancelAsync();
        if (_laco is { } laco)
        {
            try
            {
                await laco;
            }
            catch (OperationCanceledException)
            {
            }
        }

    }

    // -----------------------------------------------------------------------------------------------------------------
    // Laço
    // -----------------------------------------------------------------------------------------------------------------

    private async Task ExecutarAsync(CancellationToken ct)
    {
        try
        {
            await _relogio.CarregarAsync(ct);
            if (await _terminal.ObterIdentidadeAsync(ct) is { Demonstracao: false } inicial)
            {
                await LimparTravaOrfaAsync(inicial, ct);
            }

            var retomados = await _envio.RetomarEmVooAsync(ct);
            if (retomados > 0)
            {
                _log.LogInformation("{Eventos} evento(s) em voo na última execução voltam para o reenvio do mesmo lote", retomados);
            }

            // 22.2: a reidratação interrompida (também com o app fechado no meio) segura o push até o handshake retomá-la.
            if (await ReidratacaoPendenteAsync(ct) is { } pendente)
            {
                _reidratacaoPendente = true;
                _handshakePendente = true;
                _log.LogWarning("Reidratação começada em {Inicio:O} e não concluída: o push espera o handshake retomá-la desde {Desde}",
                    pendente.IniciadaEm, pendente.Desde);
            }

            // 8.6, T39: a lacuna conhecida não sobrevive ao app fechado; o primeiro push a revela de novo, já, e não só
            // quando o backoff do fora_de_ordem vencer (até 10 min de vendas liberadas).
            if (await _envio.LiberarEsperaDaLacunaAsync(ct) is > 0 and var esperando)
            {
                _log.LogInformation("{Eventos} evento(s) em espera por lacuna de sequência saem no primeiro push", esperando);
            }

            while (!ct.IsCancellationRequested)
            {
                var identidade = await _terminal.ObterIdentidadeAsync(ct);
                if (identidade is null || identidade.Demonstracao)
                {
                    return;
                }

                if (identidade.Status == StatusIdentidade.Revogado)
                {
                    await PublicarAsync(EstadoTerminalSync.Revogado, ct);
                    _log.LogWarning("Terminal revogado: o ciclo online parou (o banco local fica intacto)");
                    return;
                }

                var desativando = identidade.Status == StatusIdentidade.Desativando;
                if (HandshakeNoLaco && Agora >= _proximoHandshake)
                {
                    await HandshakeAsync(ct);
                }

                if (Agora >= _proximoPush && !PushParado)
                {
                    await CicloPushAsync(desativando, ct);
                }

                if (Agora >= _proximoHeartbeat && Situacao.Terminal != EstadoTerminalSync.Revogado)
                {
                    await HeartbeatAsync(ct);
                }

                if (Agora >= _proximoPull && PullLiberado)
                {
                    await CicloPullAsync(desativando, ct);
                }

                // Fora da espera do laço: é a rede de segurança de 1 h e sai na volta seguinte (o heartbeat acorda o laço).
                if (Agora >= _proximaConsultaStatus && PullLiberado && Situacao.Online)
                {
                    await ConsultarEventosStatusAsync(ct);
                }

                await PublicarAsync(ct: ct);
                // Push parado e pull sem token ficam fora da espera: o horário deles ficaria no passado e o laço giraria
                // sem pausa. O heartbeat (sempre reagendado, com backoff na falha) acorda o laço; AgendarPush também.
                var espera = Min(PushParado ? TimeSpan.MaxValue : _proximoPush, _proximoHeartbeat,
                    PullLiberado ? _proximoPull : TimeSpan.MaxValue, HandshakeNoLaco ? _proximoHandshake : TimeSpan.MaxValue) - Agora;
                if (espera > TimeSpan.Zero)
                {
                    await _sinal.WaitAsync(espera, ct);
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (Exception e)
        {
            // Erro de programação ou de banco local: registra e para (o caixa segue; reabrir o app religa o ciclo).
            _log.LogError(e, "Ciclo de sincronização parou por erro inesperado");
            _ultimoErro = e.Message;
            await PublicarAsync(ct: CancellationToken.None);
        }
    }

    private TimeSpan Agora => _cronometro.Elapsed;

    /// <summary>
    /// Push parado: token recusado, protocolo, regressão ou reidratação pendente (22.1, até a reidratação concluir) ou
    /// hardware (aprovação no ERP).
    /// </summary>
    private bool PushParado => _tokenRecusado || _protocoloRecusado || _regressao || _reidratacaoPendente || _hardwareAlterado;

    private bool PullLiberado => !_tokenRecusado && Situacao.Terminal != EstadoTerminalSync.Revogado;

    /// <summary>Handshake a refazer pelo laço (falhou ou offline longo), com a nuvem respondendo e o token aceito.</summary>
    private bool HandshakeNoLaco => _handshakePendente && Situacao.Online && !_tokenRecusado;

    private static TimeSpan Min(params TimeSpan[] valores) => valores.Min();

    private void AgendarPush(TimeSpan apos)
    {
        lock (_trava)
        {
            var quando = Agora + apos;
            if (quando < _proximoPush || _proximoPush <= Agora)
            {
                _proximoPush = quando;
            }
        }

        _sinal.Release();
    }

    private void AgendarHeartbeat(TimeSpan apos)
    {
        lock (_trava)
        {
            _proximoHeartbeat = Agora + apos;
        }

        _sinal.Release();
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Push
    // -----------------------------------------------------------------------------------------------------------------

    private async Task CicloPushAsync(bool desativando, CancellationToken ct)
    {
        await _semaforoPush.WaitAsync(ct);
        try
        {
            await CicloPushSemTravaAsync(desativando, ct);
        }
        finally
        {
            _semaforoPush.Release();
        }
    }

    private async Task CicloPushSemTravaAsync(bool desativando, CancellationToken ct)
    {
        await PublicarAsync(sincronizando: true, ct: ct);
        await _outbox.GerarAuditoriaAsync(forcar: desativando, ct);
        for (var i = 0; i < 100; i++)
        {
            ResultadoEnvio r;
            try
            {
                r = await _envio.EnviarAsync(voltaDeOffline: !Situacao.Online && Situacao.OfflineDesde is not null, ct);
            }
            catch (ErroSyncException e) when (e.Status == HttpStatusCode.Unauthorized)
            {
                await TratarErroAsync(e, "push", ct);
                _proximoPush = Agora + _intervaloPush;
                return;
            }

            switch (r.Desfecho)
            {
                case DesfechoPush.Enviado:
                    await MarcarOnlineAsync(ct);
                    _ultimoErro = null;
                    if (r.Lacuna is { } lacuna)
                    {
                        AtualizarLacuna(lacuna);
                    }
                    else if (r.Enviados > 0)
                    {
                        await AvancouSemLacunaAsync(ct);
                    }

                    if (r.Enviados == 0)
                    {
                        // Nenhum evento saiu da fila (fora de ordem, não processado): o próximo lote espera o backoff
                        // do evento da frente, nunca um reenvio na hora.
                        _proximoPush = Agora + _opcoes.Debounce;
                        return;
                    }

                    continue;
                case DesfechoPush.Aguardando:
                    _proximoPush = Agora + Ate(r.Proxima);
                    return;
                case DesfechoPush.Falhou:
                    _proximoPush = Agora + Ate(r.Proxima);
                    _ultimoErro = r.Erro?.Message ?? "Falha ao enviar o outbox.";
                    if (r.Erro is null)
                    {
                        await FalhaTransporteAsync(ct);
                    }

                    return;
                case DesfechoPush.Regressao:
                    // 22.1: o handshake refeito já reidrata a partir da sequência recusada e só então o push volta.
                    _regressao = true;
                    _regressaoNoPushEm = SequenciaDaRegressao(r.Erro);
                    _handshakePendente = true;
                    _proximoHandshake = Agora;
                    _ultimoErro = "A nuvem detectou regressão da sequência (banco local restaurado ou copiado): recuperando os dados do caixa.";
                    await PublicarAsync(EstadoTerminalSync.Regressao, ct);
                    return;
                case DesfechoPush.HardwareAlterado:
                    _hardwareAlterado = true;
                    await PublicarAsync(EstadoTerminalSync.HardwareAlterado, ct);
                    return;
                case DesfechoPush.ReidratacaoPendente:
                    // Nada foi enviado: o handshake (com o backoff dele) retoma a reidratação e libera o push.
                    _reidratacaoPendente = true;
                    _handshakePendente = true;
                    return;
                default:
                    // Vazio: confere de novo no intervalo (a auditoria de 5 min também sai daqui).
                    AtualizarLacuna(null);
                    _proximoPush = Agora + _intervaloPush;
                    if (desativando)
                    {
                        // Outbox vazio na desativação: o heartbeat já pode confirmar.
                        AgendarHeartbeat(TimeSpan.Zero);
                    }

                    return;
            }
        }

        _proximoPush = Agora;
    }

    /// <summary>
    /// Push que avançou sem lacuna: o aviso some. A liberação do reenvio fica enquanto o outbox tiver evento a enviar
    /// dentro da faixa liberada — um lote leva no máximo <see cref="EnvioPush.EventosPorLote"/> e a faixa pode ter até
    /// 5.000 —, para o supervisor liberar uma vez só; sai o último, ela cai.
    /// </summary>
    private async Task AvancouSemLacunaAsync(CancellationToken ct)
    {
        if (_envio.RecuperacaoAutorizada is { } autorizada && await _envio.TemAEnviarNaFaixaAsync(autorizada.De, autorizada.Ate, ct))
        {
            _lacuna = null;
            return;
        }

        AtualizarLacuna(null);
    }

    /// <summary>
    /// Troca a lacuna conhecida (8.6). Outra faixa, ou nenhuma (outbox vazio, push que avançou sem nada da faixa
    /// liberada a enviar), desfaz a liberação de reenvio dada para a anterior: ela só vale para os placeholders que o
    /// supervisor viu.
    /// </summary>
    private void AtualizarLacuna(LacunaEventos? lacuna)
    {
        // Antes da comparação: durante o reenvio liberado a lacuna conhecida já é nula (AvancouSemLacunaAsync).
        if (_envio.RecuperacaoAutorizada is { } autorizada && (lacuna is not { Recuperavel: true } || lacuna.De != autorizada.De || lacuna.Ate != autorizada.Ate))
        {
            _envio.RecuperacaoAutorizada = null;
        }

        if (lacuna == _lacuna)
        {
            return;
        }

        _lacuna = lacuna;
        if (lacuna is { Recuperavel: false })
        {
            _ultimoErro = $"Lacuna de eventos {lacuna.Faixa}: o caixa não tem mais estes eventos. Vendas bloqueadas até o supervisor declarar a lacuna (F11 › S).";
        }
        else if (lacuna is { Recuperavel: true })
        {
            _ultimoErro = $"Eventos da lacuna {lacuna.Faixa} encontrados: o reenvio precisa da liberação do supervisor (F11 › S).";
        }
    }

    public async Task DeclararLacunaAsync(Guid autorizadoPorId, string? observacao, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null)
    {
        if (_lacuna is not { Recuperavel: false } lacuna)
        {
            throw new Core.Comum.RegraNegocioException("Não há lacuna de eventos a declarar.");
        }

        var texto = string.IsNullOrWhiteSpace(observacao) ? null : observacao.Trim() is { Length: > 255 } longa ? longa[..255] : observacao.Trim();
        await _semaforoPush.WaitAsync(ct);
        try
        {
            var resposta = await _envio.DeclararLacunaAsync(
                new DeclaracaoLacuna(lacuna.De, lacuna.Ate, MotivosLacuna.BancoLocalPerdido, texto, autorizadoPorId), ct);
            await MarcarOnlineAsync(ct);
            _lacuna = null;
            _ultimoErro = null;
            _log.LogCritical("Lacuna de eventos {Faixa} declarada na nuvem com a liberação de {Supervisor}; a nuvem espera agora a sequência {Proxima} (SYNC 8.6)",
                lacuna.Faixa, autorizadoPorId, resposta.ProximaSequenciaEsperada);
        }
        catch (ErroSyncException e) when (e.Codigo is "LACUNA_INVALIDA")
        {
            // A nuvem espera outra sequência (outro envio andou, ou a lacuna mudou): o próximo push mostra a faixa certa.
            // Já, sem esperar o backoff do fora_de_ordem: até lá as vendas novas ficariam liberadas (T39).
            _lacuna = null;
            await _envio.LiberarEsperaDaLacunaAsync(CancellationToken.None);
            AgendarPush(TimeSpan.Zero);
            throw new Core.Comum.RegraNegocioException($"A nuvem recusou a lacuna {lacuna.Faixa}: {e.Message} Confira de novo em instantes.");
        }
        catch (Exception e) when (e is ErroSyncException or HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new Core.Comum.RegraNegocioException(e is ErroSyncException
                ? $"A nuvem recusou a declaração da lacuna: {e.Message}"
                : "Sem conexão com a nuvem: a lacuna só pode ser declarada online. Tente de novo quando a internet voltar.");
        }
        finally
        {
            _semaforoPush.Release();
        }

        await _terminal.RegistrarAuditoriaAsync("liberacao", origem is null ? _operador() : origem.SolicitanteId, "eventos_saida", null,
            $"Lacuna de eventos {lacuna.Faixa} declarada na nuvem (SYNC 8.6)", origem?.Localizacao ?? OrigemLiberacaoLacuna.LocalizacaoStatusSync,
            autorizadoPorId, ct,
            motivo: texto ?? "Lacuna de eventos declarada");
        await PublicarAsync(ct: ct);
        AgendarPush(TimeSpan.Zero);
    }

    public async Task AutorizarRecuperacaoLacunaAsync(Guid autorizadoPorId, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null)
    {
        if (_lacuna is not { Recuperavel: true })
        {
            throw new Core.Comum.RegraNegocioException("Não há eventos de lacuna esperando liberação.");
        }

        LacunaEventos lacuna;
        // Sob o semáforo do push: o resultado de um push em voo (sem recuperar_lacuna) gravaria o backoff do
        // lacuna_recuperavel por cima da espera liberada, e o reenvio esperaria até 10 min em vez de sair já.
        await _semaforoPush.WaitAsync(ct);
        try
        {
            // Relida sob o semáforo: o push que acabou de voltar pode ter trocado a faixa.
            lacuna = _lacuna is { Recuperavel: true } atual
                ? atual
                : throw new Core.Comum.RegraNegocioException("Os eventos da lacuna já não esperam liberação. Confira de novo.");
            _envio.RecuperacaoAutorizada = new RecuperacaoLacuna(lacuna.De, lacuna.Ate, autorizadoPorId);
            await _envio.LiberarEsperaAsync(ct);
        }
        finally
        {
            _semaforoPush.Release();
        }

        await _terminal.RegistrarAuditoriaAsync("liberacao", origem is null ? _operador() : origem.SolicitanteId, "eventos_saida", null,
            $"Reenvio dos eventos da lacuna {lacuna.Faixa} liberado (SYNC 8.6)", origem?.Localizacao ?? OrigemLiberacaoLacuna.LocalizacaoStatusSync,
            autorizadoPorId, ct,
            motivo: "Eventos da lacuna declarada encontrados");
        _log.LogWarning("Reenvio dos eventos da lacuna {Faixa} liberado por {Supervisor} (SYNC 8.6)", lacuna.Faixa, autorizadoPorId);
        AgendarPush(TimeSpan.Zero);
        await PublicarAsync(ct: ct);
    }

    private TimeSpan Ate(DateTimeOffset? quando) =>
        quando is { } q && q > _relogio.AgoraLocal ? q - _relogio.AgoraLocal : _opcoes.Debounce;

    // -----------------------------------------------------------------------------------------------------------------
    // Heartbeat
    // -----------------------------------------------------------------------------------------------------------------

    private async Task HeartbeatAsync(CancellationToken ct)
    {
        RespostaHeartbeat resposta;
        RequisicaoHeartbeat requisicao;
        RespostaHeartbeat? recebida = null;
        try
        {
            try
            {
                requisicao = await MontarHeartbeatAsync(ct);
                resposta = recebida = await _cliente.HeartbeatAsync(requisicao, ct);
            }
            finally
            {
                // D22: a trava só dura a ida e volta. Com `revogado` ela fica (o terminal não grava mais nada que suba);
                // sem resposta ou com outro status, destrava e o próximo heartbeat recontará e tentará de novo.
                if (_confirmandoDesativacao && recebida?.StatusTerminal != "revogado")
                {
                    await DestravarConfirmacaoAsync();
                }
            }
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            var desfecho = await TratarErroAsync(e, "heartbeat", ct);
            _falhasHeartbeat++;
            if (e is ErroSyncException { Status: HttpStatusCode.BadRequest or HttpStatusCode.UnprocessableEntity }
                && (_acksComandos.Count > 0 || _acksResolvidos.Count > 0))
            {
                // Recusado como inválido: os mesmos acks iriam de novo em todo heartbeat, para sempre. A nuvem entrega de
                // novo o que ficou sem ack e o dedupe (comandos_recebidos, evento já confirmado) devolve o mesmo resultado.
                _log.LogWarning("Heartbeat recusado ({Erro}): {Comandos} ack(s) de comando e {Resolvidos} de evento resolvido descartados; a nuvem os entrega de novo",
                    e.Message, _acksComandos.Count, _acksResolvidos.Count);
                _acksComandos.Clear();
                _acksResolvidos.Clear();
            }
            if (desfecho is null && e is TaskCanceledException)
            {
                // 1 timeout de heartbeat (10 s) já é offline (18.3).
                await FalhaTransporteAsync(ct, imediata: true);
            }

            // Também com desfecho (token recusado): o heartbeat é o que testa se a nuvem voltou a aceitar o terminal.
            _proximoHeartbeat = Agora + EsperaApos(_falhasHeartbeat, e);
            return;
        }

        _falhasHeartbeat = 0;
        await MarcarOnlineAsync(ct, heartbeat: true);
        LiberarBloqueioNuvem("heartbeat");
        if (_tokenRecusado)
        {
            // O 401 era passageiro (proxy, janela da rotação): a nuvem aceitou o token de novo.
            _tokenRecusado = false;
            _ultimoErro = null;
            _log.LogInformation("Token aceito de novo pela nuvem: push e pull voltam");
            _proximoPull = Agora;
            AgendarPush(TimeSpan.Zero);
        }

        // Só os que foram neste heartbeat saem da fila; o resto (acima do máximo) vai no próximo.
        var comandosEnviados = requisicao.ComandosResultado.Select(a => a.ComandoId).ToHashSet();
        _acksComandos.RemoveAll(a => comandosEnviados.Contains(a.ComandoId));
        var resolvidosEnviados = requisicao.EventosResolvidosAck.ToHashSet();
        _acksResolvidos.RemoveAll(resolvidosEnviados.Contains);
        _intervaloHeartbeat = Segundos(resposta.Intervalos.HeartbeatS, _opcoes.Heartbeat);
        _intervaloPull = Segundos(resposta.Intervalos.PullS, _opcoes.Pull);
        _intervaloPush = Segundos(resposta.Intervalos.PushPendenteS, _opcoes.PushPendente);
        _proximoHeartbeat = Agora + _intervaloHeartbeat;

        switch (resposta.StatusTerminal)
        {
            case "revogado":
                await _terminal.AvancarStatusAsync(StatusIdentidade.Revogado, ct);
                _log.LogWarning("Desativação confirmada pela nuvem: terminal revogado ({Estado})", requisicao.EstadoLocal);
                await PublicarAsync(EstadoTerminalSync.Revogado, ct);
                return;
            case "desativando":
                HardwareConferido();
                if (await _terminal.AvancarStatusAsync(StatusIdentidade.Desativando, ct))
                {
                    _log.LogWarning("Terminal em desativação pelo ERP: novas vendas bloqueadas; enviando as pendências");
                    AgendarPush(TimeSpan.Zero);
                }

                break;
            case "hardware_alterado":
                _hardwareAlterado = true;
                break;
            default:
                HardwareConferido();
                break;
        }

        if (resposta.Comandos.Count > 0)
        {
            var acks = await _comandos.ProcessarAsync(resposta.Comandos, ct);
            // Comando entregue de novo com o ack ainda na fila (fatia seguinte): o dedupe devolveu o mesmo resultado.
            var novos = acks.Select(a => a.ComandoId).ToHashSet();
            _acksComandos.RemoveAll(a => novos.Contains(a.ComandoId));
            _acksComandos.AddRange(acks);
            if (acks.Any(a => a.Status == "executado") && resposta.Comandos.Any(c => c.Tipo is TiposComando.Ressincronizar or TiposComando.RessincronizarFluxo))
            {
                _proximoPull = Agora;
            }
        }

        if (resposta.EventosResolvidos.Count > 0)
        {
            var acks = await AplicarResolvidosAsync(resposta.EventosResolvidos, ct);
            _acksResolvidos.AddRange(acks.Where(id => !_acksResolvidos.Contains(id)));
        }

        if (_acksComandos.Count > 0 || _acksResolvidos.Count > 0)
        {
            _proximoHeartbeat = Agora + HeartbeatComAck;
        }

        if (resposta.App.VersaoMinima is { } minima)
        {
            await using var db = await _fabrica.CreateDbContextAsync(ct);
            await db.EstadoConexao.ExecuteUpdateAsync(s => s.SetProperty(c => c.VersaoMinimaApp, minima), ct);
        }

        if (resposta.RenovarToken)
        {
            try
            {
                await _rotacao.RenovarAsync(ct);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                // Repete no próximo heartbeat (o pendente gravado garante o mesmo requisicao_id).
                _log.LogWarning("Renovação do token falhou ({Erro}); repete no próximo heartbeat", e.Message);
            }
        }
    }

    /// <summary>
    /// <c>ativo</c> e <c>desativando</c> só chegam com o hardware conferido (a API dá prioridade a
    /// <c>hardware_alterado</c>): aprovado no ERP, inclusive durante a desativação, o envio do outbox volta.
    /// </summary>
    private void HardwareConferido()
    {
        if (_hardwareAlterado)
        {
            _log.LogInformation("Hardware aprovado no ERP: o envio do outbox volta");
            _hardwareAlterado = false;
            AgendarPush(TimeSpan.Zero);
        }
    }

    private async Task<RequisicaoHeartbeat> MontarHeartbeatAsync(CancellationToken ct)
    {
        await _semaforoTravaD22.WaitAsync(ct);
        try
        {
            return await MontarHeartbeatTravadoAsync(ct);
        }
        finally
        {
            _semaforoTravaD22.Release();
        }
    }

    private async Task<RequisicaoHeartbeat> MontarHeartbeatTravadoAsync(CancellationToken ct)
    {
        await using var db = await _fabrica.CreateDbContextAsync(ct);
        // Em desativação, a contagem roda numa transação IMMEDIATE (a do Microsoft.Data.Sqlite): espera a gravação em voo
        // comitar, e a trava da D22 é marcada antes de qualquer outra começar. Os números enviados são os finais. Fora
        // dela, sem transação (o status só avança: um `ativo` lido aqui nunca confirma).
        var desativando = await db.IdentidadeTerminal.AsNoTracking().AnyAsync(i => i.Status == StatusIdentidade.Desativando, ct);
        await using var tx = desativando ? await db.Database.BeginTransactionAsync(ct) : null;
        var identidade = await db.IdentidadeTerminal.AsNoTracking().FirstAsync(ct);
        var cursores = await db.EstadoSincronizacao.AsNoTracking().ToListAsync(ct);
        var sequencias = await db.SequenciasLocais.AsNoTracking().ToDictionaryAsync(s => s.Chave, s => s.UltimoValor, StringComparer.Ordinal, ct);
        var pendentes = await db.EventosSaida.AsNoTracking().Where(e => NaoConfirmados.Contains(e.Status)).Select(e => e.CriadoEm).ToListAsync(ct);
        var rejeitados = await db.EventosSaida.CountAsync(e => e.Status == StatusEventoSaida.Rejeitado, ct);
        var impressao = await db.FilaImpressao.CountAsync(f => f.Status == "pendente" || f.Status == "falhou", ct);
        var auditoria = identidade.Status == StatusIdentidade.Desativando ? await _outbox.AuditoriaPendenteAsync(ct) : 0;
        var vendaAberta = identidade.Status == StatusIdentidade.Desativando
                          && await db.EstadoOperacao.AsNoTracking().AnyAsync(o => o.VendaAtualId != null, ct);
        var estadoLocal = identidade.Status;
        if (tx is not null && estadoLocal == StatusIdentidade.Desativando && pendentes.Count == 0 && auditoria == 0 && !vendaAberta)
        {
            // 3.8: parou de vender (gravado), sem venda aberta (o cancelamento dela ainda gera a auditoria `cancelar`),
            // outbox vazio e auditoria enviada: os números abaixo são os finais. D22 (dono): daqui até a resposta, nada
            // que suba é gravado (logout, Ctrl+Alt+C, auditoria, evento), pelos gatilhos da TravaDesativacao.
            estadoLocal = "desativando_confirmado";
            var agora = _relogio.AgoraLocal;
            await db.EstadoConexao.ExecuteUpdateAsync(s => s.SetProperty(c => c.ConfirmandoDesativacaoEm, agora), ct);
            _confirmandoDesativacao = true;
        }

        if (tx is not null)
        {
            await tx.CommitAsync(ct);
        }

        if (_confirmandoDesativacao)
        {
            await PublicarAsync(ct: ct);
        }

        // PDV 20.4 / SYNC 10.1 (C10b): a sessão aberta e o dinheiro estimado na gaveta (o ERP mostra no terminal; o
        // `terminais.sessao_caixa_id` da nuvem só aceita a sessão mais nova, T12).
        var sessaoAberta = await db.SessoesCaixa.AsNoTracking()
            .Where(s => s.Status != StatusSessaoCaixa.Fechada && s.ExcluidoEm == null)
            .Select(s => (Guid?)s.Id)
            .FirstOrDefaultAsync(ct);
        var gaveta = sessaoAberta is { } sessaoId ? await RepositorioCaixa.DinheiroGavetaAsync(db, sessaoId, ct) : null;
        var nfce = sequencias.Where(s => s.Key.StartsWith("nfce:", StringComparison.Ordinal))
            .Select(s => s.Key.Split(':') is [_, var serie, var ambiente] ? new NfceUltimoNumero(int.Parse(serie, System.Globalization.CultureInfo.InvariantCulture), int.Parse(ambiente, System.Globalization.CultureInfo.InvariantCulture), s.Value) : null)
            .OfType<NfceUltimoNumero>().ToList();
        return new RequisicaoHeartbeat
        {
            VersaoApp = _maquina.VersaoApp,
            EstadoLocal = estadoLocal,
            So = _maquina.SistemaOperacional,
            HoraLocal = F.DataHora(_relogio.AgoraLocal),
            DesvioRelogioMs = _relogio.DesvioMs,
            RelogioConfiavel = _relogio.Confiavel,
            CursorPull = cursores.ToDictionary(c => c.Fluxo, c => c.Cursor, StringComparer.Ordinal),
            UltimoPullSucessoEm = F.DataHora(cursores.Max(c => c.UltimoPullSucessoEm)),
            EventosPendentes = pendentes.Count,
            EventoMaisAntigoEm = pendentes.Count > 0 ? F.DataHora(pendentes.Min()) : null,
            EventosRejeitados = rejeitados,
            UltimaSequenciaGerada = sequencias.GetValueOrDefault(SequenciaLocal.Evento),
            VendaUltimoNumero = sequencias.GetValueOrDefault(SequenciaLocal.Venda),
            ValeUltimoNumero = sequencias.GetValueOrDefault(SequenciaLocal.Vale),
            NfceUltimoNumero = nfce.Count > 0 ? nfce : null,
            FilaImpressaoPendentes = impressao,
            VersaoSchemaLocal = identidade.VersaoSchemaLocal,
            OperadorId = _operador(),
            SessaoCaixaId = sessaoAberta,
            DinheiroEstimadoGaveta = gaveta is { } dinheiro ? F.Dinheiro(dinheiro) : null,
            DiscoLivreMb = DiscoLivreMb(),
            TamanhoBancoMb = TamanhoBancoMb(),
            UltimoErro = _ultimoErro is { Length: > 2000 } erro ? erro[..2000] : _ultimoErro,
            EventosResolvidosAck = [.. _acksResolvidos.Take(MaximoAcksResolvidos)],
            ComandosResultado = [.. _acksComandos.Take(MaximoAcksComandos)],
        };
    }

    /// <summary>D22: tira a trava (sem resposta, ou com status diferente de <c>revogado</c>); o caixa volta a gravar.</summary>
    private async Task DestravarConfirmacaoAsync()
    {
        await using (var db = await _fabrica.CreateDbContextAsync())
        {
            await db.EstadoConexao.ExecuteUpdateAsync(s => s.SetProperty(c => c.ConfirmandoDesativacaoEm, (DateTimeOffset?)null));
        }

        _confirmandoDesativacao = false;
        await PublicarAsync();
    }

    /// <summary>
    /// Trava da D22 que sobrou de um processo que caiu esperando o <c>revogado</c>: sem ela limpa, nem o login gravaria
    /// a auditoria. Revogado, ela fica (nada mais sobe).
    /// </summary>
    private async Task LimparTravaOrfaAsync(IdentidadeTerminal identidade, CancellationToken ct)
    {
        if (identidade.Status == StatusIdentidade.Revogado)
        {
            return;
        }

        await _semaforoTravaD22.WaitAsync(ct);
        try
        {
            if (_confirmandoDesativacao)
            {
                return;
            }

            await using var db = await _fabrica.CreateDbContextAsync(ct);
            if (await db.EstadoConexao.Where(c => c.ConfirmandoDesativacaoEm != null).ExecuteUpdateAsync(
                    s => s.SetProperty(c => c.ConfirmandoDesativacaoEm, (DateTimeOffset?)null), ct) > 0)
            {
                _log.LogWarning("Trava da confirmação da desativação de uma execução anterior removida (D22): o heartbeat confirma de novo");
            }
        }
        finally
        {
            _semaforoTravaD22.Release();
        }
    }

    /// <summary>
    /// Rejeitado por <c>EVENTO_DIVERGENTE</c> (SYNC 8.4 camada 3, 11.2): a linha da nuvem com esse <c>evento_id</c> é a do
    /// envio original, de outro conteúdo, e a situação dela não diz nada do evento local. Fica em quarentena até o suporte
    /// (permanente), fora da consulta de <c>eventos-status</c> e sem confirmar pelo <c>eventos_resolvidos</c>.
    /// </summary>
    private static bool Divergente(string? ultimoErro) =>
        ultimoErro?.StartsWith(CodigoEventoDivergente + ":", StringComparison.Ordinal) == true;

    private const string CodigoEventoDivergente = "EVENTO_DIVERGENTE";

    /// <summary>
    /// Eventos resolvidos no ERP (7.2): <c>aplicado</c> → <c>confirmado</c>; <c>descartado</c> continua rejeitado. O
    /// rejeitado por <c>EVENTO_DIVERGENTE</c> não muda (<see cref="Divergente"/>): a resolução é a do original.
    /// </summary>
    private async Task<IReadOnlyList<Guid>> AplicarResolvidosAsync(IReadOnlyList<EventoResolvido> resolvidos, CancellationToken ct)
    {
        await using var db = await _fabrica.CreateDbContextAsync(ct);
        var ids = resolvidos.Select(r => r.EventoId).ToArray();
        var eventos = await db.EventosSaida.Where(e => ids.Contains(e.Id)).ToDictionaryAsync(e => e.Id, ct);
        foreach (var r in resolvidos)
        {
            if (!eventos.TryGetValue(r.EventoId, out var e)
                || (e.Status == StatusEventoSaida.Rejeitado && Divergente(e.UltimoErro)))
            {
                continue;
            }

            if (r.Status == StatusResultadoEvento.Aplicado && e.Status != StatusEventoSaida.Confirmado)
            {
                var recusado = e.Status == StatusEventoSaida.Rejeitado;
                e.Status = StatusEventoSaida.Confirmado;
                e.ConfirmadoEm = _relogio.AgoraLocal;
                e.VersaoNuvem = r.VersaoNuvem;
                e.VersaoNuvemFim = r.VersaoNuvemFim;
                e.Resultado = r.Resultado?.GetRawText() ?? "{}";
                e.UltimoErro = null;
                if (recusado)
                {
                    // A ocorrência ligada ao evento (aba 4 da Central, bloco G7): a venda recusada ficou verde pelo ERP.
                    db.LogLocal.Add(OcorrenciaResolvida(e, "O ERP reprocessou e a nuvem aceitou"));
                }
            }
            else if (r.Status == StatusResultadoEvento.Descartado)
            {
                if (!ConsultasVendaLocal.Descartado(e.Resultado))
                {
                    db.LogLocal.Add(OcorrenciaResolvida(e, "O ERP descartou (decisão final na nuvem)"));
                }

                e.Resultado = r.Resultado?.GetRawText();
            }
        }

        await db.SaveChangesAsync(ct);
        // Ack de todos, inclusive os que já estavam aplicados (repetição) ou que o PDV não tem.
        return ids;
    }

    /// <summary>
    /// Rede de segurança dos <c>rejeitado</c> (7.2, 18.2, 21.1): a cada <see cref="OpcoesSincronizacao.ConsultaEventosStatus"/>
    /// (1 h), se houver algum, consulta o <c>GET /sync/eventos-status</c> em fatias de 200 (na ordem da sequência) e aplica
    /// o <c>aplicado</c>/<c>descartado</c> como o <c>eventos_resolvidos</c> do heartbeat (<see cref="AplicarResolvidosAsync"/>);
    /// <c>erro</c>/<c>retido</c> só atualizam o motivo no <c>ultimo_erro</c> (<see cref="AtualizarMotivosAsync"/>, decisão
    /// 72; a situação continua <c>rejeitado</c>) e o id que a nuvem não devolve não muda nada. Os já descartados ficam de fora (decisão
    /// final na nuvem), e também os rejeitados por <c>EVENTO_DIVERGENTE</c> (<see cref="Divergente"/>: a nuvem responderia
    /// pela linha do envio original, quase sempre <c>aplicado</c>, e o evento sairia da quarentena). Nenhum ack: a nuvem continua entregando a resolução no heartbeat até o ack de lá, e a aplicação
    /// repetida não tem efeito. Roda também em <c>desativando</c> e com o hardware divergente (a API aceita, T6); falha
    /// reagenda com backoff (5 s a 5 min, nunca menos que o <c>Retry-After</c>), sem tocar no resto do ciclo.
    /// </summary>
    private async Task ConsultarEventosStatusAsync(CancellationToken ct)
    {
        List<Guid> ids;
        await using (var db = await _fabrica.CreateDbContextAsync(ct))
        {
            var rejeitados = await db.EventosSaida.AsNoTracking()
                .Where(e => e.Status == StatusEventoSaida.Rejeitado)
                .OrderBy(e => e.SequenciaTerminal)
                .Select(e => new { e.Id, e.Resultado, e.UltimoErro })
                .ToListAsync(ct);
            ids = [.. rejeitados
                .Where(e => !ConsultasVendaLocal.Descartado(e.Resultado) && !Divergente(e.UltimoErro))
                .Select(e => e.Id)];
        }

        var resolvidos = 0;
        try
        {
            foreach (var fatia in ids.Chunk(ClienteSyncHttp.MaximoIdsEventosStatus))
            {
                var resposta = await _cliente.EventosStatusAsync(fatia, ct);
                var decididos = resposta.Eventos.Select(e => e.ComoResolvido()).OfType<EventoResolvido>().ToList();
                if (decididos.Count > 0)
                {
                    await AplicarResolvidosAsync(decididos, ct);
                    resolvidos += decididos.Count;
                }

                await AtualizarMotivosAsync(resposta.Eventos, ct);
            }
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            await TratarErroAsync(e, "eventos-status", ct);
            _falhasConsultaStatus++;
            _proximaConsultaStatus = Agora + EsperaApos(_falhasConsultaStatus, e);
            return;
        }

        _falhasConsultaStatus = 0;
        _proximaConsultaStatus = Agora + _opcoes.ConsultaEventosStatus;
        if (ids.Count > 0)
        {
            _log.LogInformation("Sync: eventos-status de {Rejeitados} evento(s) em quarentena; {Resolvidos} resolvido(s) no ERP aplicado(s)",
                ids.Count, resolvidos);
        }
    }

    /// <summary>
    /// O motivo atual da nuvem para o recusado ainda sem decisão (<c>erro</c> ou <c>retido</c> no <c>eventos-status</c>):
    /// o <c>ultimo_erro</c> passa a ser o de lá (o ERP pode ter reprocessado e a nuvem recusado de novo por outro motivo).
    /// É o que a aba 4 da Central mostra em vermelho (pedido do dono de 04/11/2026, "vendas a copiar"). Nada mais muda: a
    /// situação continua <c>rejeitado</c> e a decisão continua no ERP. O <c>EVENTO_DIVERGENTE</c> fica como está. O
    /// <c>ERRO_INTERNO</c> vira o texto genérico do push (<see cref="MotivoErroInterno"/>): a nuvem guarda (e o
    /// <c>eventos-status</c> devolve) a mensagem crua da falha — do PostgreSQL ou da exceção, com tabela, coluna e às
    /// vezes o valor —, que o push esconde de propósito do terminal; ela não vai para o banco local nem para a tela.
    /// </summary>
    private async Task AtualizarMotivosAsync(IReadOnlyList<StatusEventoNuvem> eventos, CancellationToken ct)
    {
        var motivos = eventos
            .Where(e => e.Status is StatusEventoNuvemErro or StatusResultadoEvento.Retido && e.Erro is not null)
            .ToDictionary(e => e.EventoId, e => e.Erro!.Codigo == CodigoErroInterno ? MotivoErroInterno : $"{e.Erro.Codigo}: {e.Erro.Mensagem}");
        if (motivos.Count == 0)
        {
            return;
        }

        await using var db = await _fabrica.CreateDbContextAsync(ct);
        var ids = motivos.Keys.ToArray();
        var locais = await db.EventosSaida.Where(e => ids.Contains(e.Id) && e.Status == StatusEventoSaida.Rejeitado).ToListAsync(ct);
        foreach (var e in locais.Where(e => !Divergente(e.UltimoErro)))
        {
            var motivo = motivos[e.Id] is { Length: > 2000 } longo ? longo[..2000] : motivos[e.Id];
            if (!string.Equals(e.UltimoErro, motivo, StringComparison.Ordinal))
            {
                e.UltimoErro = motivo;
            }
        }

        await db.SaveChangesAsync(ct);
    }

    /// <summary><c>erro</c> no <c>GET /sync/eventos-status</c>: a nuvem guardou o evento com erro, sem decisão no ERP ainda.</summary>
    private const string StatusEventoNuvemErro = "erro";

    /// <summary>A falha da nuvem ao aplicar o evento (exceção ou erro do banco de lá, não uma regra).</summary>
    private const string CodigoErroInterno = "ERRO_INTERNO";

    /// <summary>O motivo do <c>ERRO_INTERNO</c> no PDV: o mesmo texto que o push devolve ao terminal, nunca o detalhe técnico.</summary>
    internal const string MotivoErroInterno = "ERRO_INTERNO: Falha ao aplicar o evento.";

    /// <summary>A ocorrência do <c>log_local</c> de um evento recusado que o ERP resolveu (aba 4 da Central, bloco G7).</summary>
    private LogLocal OcorrenciaResolvida(EventoSaida e, string desfecho) => Ocorrencias.Nova(
        _relogio.Agora,
        NiveisOcorrencia.Info,
        CodigoOcorrencia.RegistroResolvidoErp,
        $"{desfecho}: registro {e.Tipo} nº {e.SequenciaTerminal}",
        new System.Text.Json.Nodes.JsonObject
        {
            ["evento_id"] = e.Id.ToString(),
            ["tipo"] = e.Tipo,
            ["sequencia"] = e.SequenciaTerminal,
            ["agregado_tipo"] = e.AgregadoTipo,
            ["agregado_id"] = e.AgregadoId.ToString(),
        });

    // -----------------------------------------------------------------------------------------------------------------
    // Pull
    // -----------------------------------------------------------------------------------------------------------------

    private async Task CicloPullAsync(bool desativando, CancellationToken ct)
    {
        await PublicarAsync(sincronizando: true, ct: ct);
        List<EstadoSincronizacao> estados;
        await using (var db = await _fabrica.CreateDbContextAsync(ct))
        {
            estados = await db.EstadoSincronizacao.AsNoTracking().ToListAsync(ct);
        }

        foreach (var fluxo in CargaInicial.Ordem)
        {
            if (desativando && !FluxosDesativando.Contains(fluxo))
            {
                continue;
            }

            var estado = estados.FirstOrDefault(e => e.Fluxo == fluxo);
            if (estado is { Ressincronizar: true })
            {
                // Teto menor que o cursor (nuvem restaurada, 6.3): espera o suporte ou um comando de ressincronização.
                continue;
            }

            var cursor = estado?.Cursor ?? 0;
            for (var pagina = 0; pagina < 1_000; pagina++)
            {
                RespostaPull r;
                try
                {
                    r = await _cliente.PullAsync(fluxo, cursor, _opcoes.LimitePull, ct: ct);
                }
                catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
                {
                    if (await TratarErroAsync(e, $"pull de {fluxo}", ct) is null)
                    {
                        await _aplicador.RegistrarErroAsync(fluxo, e.Message, CancellationToken.None);
                    }

                    // Sempre reagenda (também com desfecho): sem isso o horário do pull fica no passado e o laço gira.
                    _falhasPull++;
                    _proximoPull = Agora + EsperaApos(_falhasPull, e);
                    return;
                }

                if (r.CursorTeto < cursor)
                {
                    _log.LogError("Pull de {Fluxo}: teto {Teto} menor que o cursor local {Cursor}", fluxo, r.CursorTeto, cursor);
                    await _aplicador.RegistrarErroAsync(fluxo, "A nuvem devolveu um teto menor que o cursor local (banco restaurado?). Chame o suporte.",
                        CancellationToken.None, ressincronizar: true);
                    break;
                }

                await _aplicador.AplicarAsync(r, cargaInicial: false, concluirCarga: !r.TemMais, ct);
                cursor = r.NovoCursor;
                if (!r.TemMais)
                {
                    break;
                }
            }
        }

        _falhasPull = 0;
        await MarcarOnlineAsync(ct);
        LiberarBloqueioNuvem("pull");
        _proximoPull = Agora + _intervaloPull;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Handshake e estados
    // -----------------------------------------------------------------------------------------------------------------

    /// <summary>
    /// Aplica o <c>/sync/estado</c>: cada bloqueio é reavaliado do zero (o token foi aceito; protocolo, regressão e
    /// hardware valem o que a nuvem disser agora), então o Enter da tela de bloqueio realmente libera quando passou.
    /// </summary>
    private async Task<ResultadoHandshake> AplicarEstadoAsync(RespostaEstado estado, CancellationToken ct)
    {
        var pushEstavaParado = PushParado;
        _handshakePendente = false;
        _tokenRecusado = false;
        _bloqueioNuvem = null;
        _ultimoErro = null;
        long eventoLocal;
        await using (var db = await _fabrica.CreateDbContextAsync(ct))
        {
            eventoLocal = await db.SequenciasLocais.AsNoTracking()
                .Where(s => s.Chave == SequenciaLocal.Evento).Select(s => s.UltimoValor).FirstOrDefaultAsync(ct);
            if (estado.App.VersaoMinima is { } minima)
            {
                await db.EstadoConexao.ExecuteUpdateAsync(s => s.SetProperty(c => c.VersaoMinimaApp, minima), ct);
            }

            // T13: o que a nuvem aplica (tipo → versões). O GravadorOutbox só grava o tipo anunciado no último handshake,
            // também offline; uma API sem o handler de um tipo nunca recebe esse tipo (SCHEMA_DESCONHECIDO pararia o lote).
            var versoes = JsonSerializer.Serialize(estado.VersoesSchema);
            await db.EstadoConexao.ExecuteUpdateAsync(s => s.SetProperty(c => c.VersoesSchemaNuvem, versoes), ct);
        }

        _protocoloRecusado = estado.Protocolo.Minimo > _maquina.ParaCliente().Protocolo;
        if (_protocoloRecusado)
        {
            await PublicarAsync(EstadoTerminalSync.Bloqueado, ct);
            return new ResultadoHandshake(DesfechoHandshake.Bloqueado,
                $"Esta versão do PDV não fala mais com a nuvem. {MensagensAtivacao.ComoAtualizar(estado.App.VersaoMinima)}");
        }

        // 5 / 22.1: a nuvem já recebeu sequências que este banco não tem (restaurado ou copiado), o push foi recusado
        // por regressão, há uma restauração ainda não resolvida ou uma reidratação interrompida (a regressão dela continua
        // valendo: o passo 1 já subiu a sequência local): reidrata pelo GET /sync/recuperar antes de liberar.
        var pendente = await ReidratacaoPendenteAsync(ct);
        _reidratacaoPendente = pendente is not null;
        var regressaoLocal = eventoLocal < estado.SequenciaTerminal.UltimaRecebida;
        var houveRegressao = regressaoLocal || _regressaoNoPushEm is not null || pendente?.Regressao == true;
        var desde = await DesdeDaReidratacaoAsync(regressaoLocal ? eventoLocal : null, pendente, ct);
        if (desde is { } d)
        {
            _regressao = houveRegressao;
            _ultimoErro = houveRegressao
                ? $"Regressão: sequência local {eventoLocal}, a nuvem já recebeu {estado.SequenciaTerminal.UltimaRecebida}. Recuperando os dados do caixa…"
                : null;
            _log.LogWarning("Handshake: reidratação desde a sequência {Desde} (local {Local}, nuvem {Nuvem}, regressão {Regressao})",
                d, eventoLocal, estado.SequenciaTerminal.UltimaRecebida, houveRegressao);
            await PublicarAsync(houveRegressao ? EstadoTerminalSync.Regressao : null, ct, sincronizando: true);
            if (await ReidratarAsync(d, estado.SequenciaTerminal.UltimaRecebida, houveRegressao, ct) is { } falha)
            {
                return falha;
            }
        }

        await using (var db = await _fabrica.CreateDbContextAsync(ct))
        {
            await RegraRestauracao.AplicarAsync(db, estado, houveRegressao, new RelogioCorrigido(_relogio), _log, ct);
        }

        if (_regressao || desde is not null)
        {
            _regressao = false;
            _regressaoNoPushEm = null;
            _ultimoErro = null;
            AgendarPush(TimeSpan.Zero);
        }

        if (!estado.Terminal.IdHardwareConfere)
        {
            _hardwareAlterado = true;
            await PublicarAsync(EstadoTerminalSync.HardwareAlterado, ct);
            return new ResultadoHandshake(DesfechoHandshake.HardwareAlterado,
                "Este computador não é o registrado para o terminal. Peça ao gerente para confirmar a troca em ERP › PDVs/Terminais.");
        }

        _hardwareAlterado = false;
        if (pushEstavaParado)
        {
            // Bloqueio resolvido (Enter na tela, volta de offline longo): o outbox volta a subir sem esperar o heartbeat.
            AgendarPush(TimeSpan.Zero);
        }

        if (estado.Terminal.Status == StatusIdentidade.Desativando)
        {
            await _terminal.AvancarStatusAsync(StatusIdentidade.Desativando, ct);
            await PublicarAsync(EstadoTerminalSync.Desativando, ct);
            return new ResultadoHandshake(DesfechoHandshake.Desativando);
        }

        await PublicarAsync(ct: ct);
        return new ResultadoHandshake(DesfechoHandshake.Liberado);
    }

    /// <summary>
    /// Roda a reidratação (22.2); nulo quando ela terminou. Falha: o que já foi gravado fica (uma transação por passo e
    /// por página) e a <see cref="ReidratacaoPendente"/> segura o push até o handshake seguinte retomá-la, com backoff.
    /// </summary>
    private async Task<ResultadoHandshake?> ReidratarAsync(long desde, long ultimaRecebida, bool houveRegressao, CancellationToken ct)
    {
        try
        {
            await _reidratacao.ExecutarAsync(desde, ultimaRecebida, houveRegressao, ct);
            _reidratacaoPendente = false;
            return null;
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Rede, recusa da nuvem (409 de hardware, 401) e o banco local inconsistente: nada foi perdido, e os eventos
            // deslocados e os gravados no meio só sobem depois da renumeração (o push fica parado até lá).
            _reidratacaoPendente = await ReidratacaoPendenteAsync(CancellationToken.None) is not null;
            var transporte = e is ErroSyncException or HttpRequestException or TaskCanceledException or JsonException;
            if (!transporte)
            {
                _log.LogError(e, "Reidratação falhou");
            }

            if (transporte && await TratarErroAsync(e, "recuperar", ct) is { } desfecho)
            {
                return desfecho;
            }

            _handshakePendente = true;
            _proximoHandshake = Agora + Espera(++_falhasHandshake);
            if (!houveRegressao)
            {
                // Restaurado sem regressão: o caixa segue no modo restaurado (o salto offline vale) e tenta de novo; o que
                // ele grava fica na fila até a reidratação terminar.
                _log.LogWarning("Reidratação adiada ({Erro}): o caixa segue no modo restaurado, com o envio parado até ela terminar", e.Message);
                await PublicarAsync(ct: ct);
                return new ResultadoHandshake(DesfechoHandshake.SemConexao,
                    "A recuperação dos dados do caixa ficou para quando a nuvem responder; até lá as vendas ficam só no caixa.");
            }

            _ultimoErro = $"Recuperação dos dados do caixa interrompida ({e.Message}); nova tentativa em instantes.";
            await PublicarAsync(EstadoTerminalSync.Regressao, ct);
            return new ResultadoHandshake(DesfechoHandshake.Regressao,
                "O banco local está atrás do que a nuvem já recebeu deste terminal (backup antigo restaurado ou cópia de outro computador). " +
                "As vendas ficam bloqueadas até a recuperação dos dados do caixa terminar; ela continua sozinha quando a nuvem responder.");
        }
    }

    /// <summary>
    /// Handshake recusado por 403 da empresa ou da loja (SYNC 2.5) com recuperação a fazer — regressão vinda do push ou
    /// reidratação interrompida: reidrata sem o <c>/sync/estado</c> (a <c>ultima_recebida</c> vem das páginas do
    /// recuperar, que responde com a empresa suspensa, T41) e o push volta, aceito na suspensão. A regra de numeração
    /// (salto, prova de que nada se perdeu) precisa do estado e fica para o handshake depois da reativação; até lá a
    /// regressão do push segura as vendas novas (<see cref="EstadoTerminalSync.Regressao"/>), e o "modo restaurado" vale.
    /// </summary>
    private async Task ReidratarSuspensoAsync(CancellationToken ct)
    {
        var pendente = await ReidratacaoPendenteAsync(ct);
        if (_regressaoNoPushEm is null && pendente is null)
        {
            return;
        }

        var houveRegressao = _regressaoNoPushEm is not null || pendente?.Regressao == true;
        var desde = await DesdeDaReidratacaoAsync(null, pendente, ct) ?? 0;
        _log.LogWarning("Handshake recusado ({Codigo}): reidratação desde a sequência {Desde} sem o /sync/estado (T41)", _bloqueioNuvem, desde);
        if (await ReidratarAsync(desde, ultimaRecebida: 0, houveRegressao, ct) is null)
        {
            // O push volta (a fila já está depois do que a nuvem tem); a regressão do push continua marcada para a regra 22.1.
            _regressao = false;
            AgendarPush(TimeSpan.Zero);
        }
    }

    /// <summary>A reidratação começada e não concluída gravada no banco local, ou nulo.</summary>
    private async Task<ReidratacaoPendente?> ReidratacaoPendenteAsync(CancellationToken ct)
    {
        await using var db = await _fabrica.CreateDbContextAsync(ct);
        return await ReidratacaoLocal.PendenteAsync(db, ct);
    }

    /// <summary>
    /// De onde reidratar (22.1, 22.2), ou nulo: a regressão do handshake (a sequência local), a do push (a anterior à
    /// recusada), a reidratação interrompida e a restauração pendente (a sequência do arquivo restaurado), a menor delas.
    /// </summary>
    private async Task<long?> DesdeDaReidratacaoAsync(long? regressaoLocal, ReidratacaoPendente? pendente, CancellationToken ct)
    {
        var desde = regressaoLocal;
        if (_regressaoNoPushEm is { } recusada)
        {
            desde = Math.Min(desde ?? long.MaxValue, Math.Max(0, recusada - 1));
        }

        if (pendente is not null)
        {
            desde = Math.Min(desde ?? long.MaxValue, pendente.Desde);
        }

        if (await _terminal.ObterConfiguracaoAsync<Data.Backup.RestauracaoPendente>(ChavesConfiguracaoTerminal.RestauracaoPendente, ct) is { } restauracao)
        {
            desde = Math.Min(desde ?? long.MaxValue, restauracao.SequenciaBackup);
        }

        return desde;
    }

    /// <summary><c>detalhes.sequencia</c> do <c>409 REGRESSAO_DETECTADA</c>; sem ela, a primeira ainda a enviar.</summary>
    private static long SequenciaDaRegressao(ErroSyncException? erro) =>
        erro?.Erro?.Detalhes is { ValueKind: JsonValueKind.Object } d && d.TryGetProperty("sequencia", out var s) && s.TryGetInt64(out var n)
            ? n
            : 1;

    /// <summary>A nuvem respondeu 200 a uma rota que o 403 da empresa ou da loja recusa: as vendas voltam.</summary>
    private void LiberarBloqueioNuvem(string onde)
    {
        if (_bloqueioNuvem is null)
        {
            return;
        }

        _log.LogInformation("Sync: {Onde} aceito de novo depois do 403 {Codigo}: novas vendas liberadas", onde, _bloqueioNuvem);
        _bloqueioNuvem = null;
        _ultimoErro = null;
    }

    /// <summary>
    /// Erros que mudam o estado do terminal: 401 <c>TERMINAL_REVOGADO</c> grava <c>revogado</c>; 401
    /// <c>TOKEN_INVALIDO</c> bloqueia; 409 <c>HARDWARE_ALTERADO</c> para o push; 403 da empresa ou da loja
    /// (<see cref="MensagensBloqueioNuvem.Suspende"/>) suspende as vendas novas. Devolve o desfecho para o handshake (ou
    /// nulo, quando o erro é só de rede/transitório e o chamador aplica o backoff).
    /// </summary>
    private async Task<ResultadoHandshake?> TratarErroAsync(Exception e, string onde, CancellationToken ct)
    {
        switch (e)
        {
            case ErroSyncException { Status: HttpStatusCode.Unauthorized, Codigo: "TERMINAL_REVOGADO" }:
                await _terminal.AvancarStatusAsync(StatusIdentidade.Revogado, ct);
                _log.LogWarning("Terminal desativado pelo ERP (401 no {Onde}): o banco local fica intacto", onde);
                await PublicarAsync(EstadoTerminalSync.Revogado, ct);
                return new ResultadoHandshake(DesfechoHandshake.Revogado);
            case ErroSyncException { Status: HttpStatusCode.Unauthorized }:
                _tokenRecusado = true;
                _ultimoErro = MensagensBloqueioNuvem.TokenRecusado;
                _log.LogError("Token recusado pela nuvem no {Onde}", onde);
                await PublicarAsync(EstadoTerminalSync.Bloqueado, ct);
                return new ResultadoHandshake(DesfechoHandshake.Bloqueado, _ultimoErro);
            case ErroSyncException { Codigo: "HARDWARE_ALTERADO" }:
                _hardwareAlterado = true;
                await PublicarAsync(EstadoTerminalSync.HardwareAlterado, ct);
                return new ResultadoHandshake(DesfechoHandshake.HardwareAlterado);
            case ErroSyncException { Status: HttpStatusCode.Forbidden } s when MensagensBloqueioNuvem.Suspende(s.Codigo):
                // SYNC 2.5: bloqueia novas vendas (a atual termina); o push segue e o chamador aplica o backoff.
                if (_bloqueioNuvem != s.Codigo)
                {
                    _log.LogWarning("Sync: {Onde} recusado com 403 {Codigo}: novas vendas bloqueadas, o push continua", onde, s.Codigo);
                }

                _bloqueioNuvem = s.Codigo;
                _ultimoErro = MensagensBloqueioNuvem.Mensagem(s.Codigo);
                await MarcarOnlineAsync(ct);
                await PublicarAsync(EstadoTerminalSync.Suspenso, ct);
                return new ResultadoHandshake(DesfechoHandshake.Suspenso, _ultimoErro);
            case ErroSyncException s:
                _ultimoErro = $"{s.Codigo ?? ((int)s.Status).ToString(System.Globalization.CultureInfo.InvariantCulture)}: {s.Message}";
                _log.LogWarning("Sync: {Onde} recusado ({Erro})", onde, _ultimoErro);
                await MarcarOnlineAsync(ct);
                return null;
            case TokenIlegivelException:
                // Outra conta do sistema abriu o banco da máquina (I3): o mesmo bloqueio do token recusado (push, pull e
                // handshake do laço param), mas com o texto de qual conta usar; só some abrindo com a conta certa.
                _tokenRecusado = true;
                _ultimoErro = MensagensAtivacao.ContaDiferente(
                    await _terminal.ObterConfiguracaoAsync<string>(ChavesConfiguracaoTerminal.ContaAtivacao, ct), ContaSistema.Atual());
                _log.LogError("Token do terminal não abre com a conta {Conta} no {Onde}: o terminal foi ativado com outra conta", ContaSistema.Atual(), onde);
                await PublicarAsync(EstadoTerminalSync.Bloqueado, ct);
                return new ResultadoHandshake(DesfechoHandshake.ContaDiferente, _ultimoErro);
            case HttpRequestException or TaskCanceledException or JsonException:
                _ultimoErro = $"Sem conexão com a nuvem ({onde}).";
                _log.LogInformation("Sync: {Onde} sem resposta ({Tipo})", onde, e.GetType().Name);
                await FalhaTransporteAsync(ct);
                return null;
            default:
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw(e);
                return null;
        }
    }

    private async Task MarcarOnlineAsync(CancellationToken ct, bool heartbeat = false)
    {
        var estavaOffline = !Situacao.Online && Situacao.OfflineDesde is not null;
        _falhasTransporte = 0;
        if (estavaOffline && Situacao.OfflineDesde is { } desde && _relogio.AgoraLocal - desde > _opcoes.HandshakeAposOffline)
        {
            _handshakePendente = true;
        }

        var agora = _relogio.AgoraLocal;
        await using var db = await _fabrica.CreateDbContextAsync(ct);
        await db.EstadoConexao.ExecuteUpdateAsync(
            s => s.SetProperty(c => c.Online, true).SetProperty(c => c.OfflineDesde, (DateTimeOffset?)null)
                .SetProperty(c => c.UltimoHeartbeatEm, c => heartbeat ? agora : c.UltimoHeartbeatEm),
            ct);
        Situacao = Situacao with { Online = true, OfflineDesde = null };
        if (estavaOffline)
        {
            // O que segurava o handshake pendente era a rede: refeito já no reencontro (o backoff recomeça).
            _proximoHandshake = Agora;
            _falhasHandshake = 0;
            // O backoff de transporte da frente cresceu durante a queda (até 10 min): zera, e o outbox sobe já (18.3, C13).
            // Só esse: o Retry-After e o backoff de um resultado da nuvem valem até o fim, mesmo que a volta venha de um
            // 503 do heartbeat ou de um push que acabou de gravar `erro_temporario` por evento.
            var liberados = await _envio.ZerarBackoffAsync(ct);
            _log.LogInformation("Sync: online de novo ({Eventos} evento(s) do outbox liberados do backoff)", liberados);
            AgendarPush(TimeSpan.Zero);
        }
    }

    private async Task FalhaTransporteAsync(CancellationToken ct, bool imediata = false)
    {
        _falhasTransporte++;
        if (!imediata && _falhasTransporte < 2)
        {
            return;
        }

        if (Situacao.Online || Situacao.OfflineDesde is null)
        {
            var desde = Situacao.OfflineDesde ?? _relogio.AgoraLocal;
            await using var db = await _fabrica.CreateDbContextAsync(ct);
            await db.EstadoConexao.ExecuteUpdateAsync(
                s => s.SetProperty(c => c.Online, false).SetProperty(c => c.OfflineDesde, c => c.OfflineDesde ?? desde), ct);
            Situacao = Situacao with { Online = false, OfflineDesde = desde };
            _log.LogWarning("Sync: offline (sem resposta da API)");
        }
    }

    /// <summary>Recalcula a situação a partir do banco e avisa a tela.</summary>
    private async Task PublicarAsync(EstadoTerminalSync? terminal = null, CancellationToken ct = default, bool sincronizando = false)
    {
        IdentidadeTerminal? identidade;
        int pendentes;
        int rejeitados;
        DateTimeOffset? ultimoPull;
        await using (var db = await _fabrica.CreateDbContextAsync(ct))
        {
            identidade = await db.IdentidadeTerminal.AsNoTracking().FirstOrDefaultAsync(ct);
            pendentes = await db.EventosSaida.CountAsync(e => e.Status != StatusEventoSaida.Confirmado, ct);
            rejeitados = await db.EventosSaida.CountAsync(e => e.Status == StatusEventoSaida.Rejeitado, ct);
            ultimoPull = (await db.EstadoSincronizacao.AsNoTracking().Select(e => e.UltimoPullSucessoEm).ToListAsync(ct)).Max();
        }

        var estado = terminal ?? EstadoAtual(identidade);
        Situacao = Situacao with
        {
            Pendentes = pendentes,
            Rejeitados = rejeitados,
            UltimoPullSucessoEm = ultimoPull,
            Erro = _ultimoErro,
            Sincronizando = sincronizando,
            Terminal = estado,
            BloqueioNuvem = estado == EstadoTerminalSync.Suspenso ? _bloqueioNuvem : null,
            ConfirmandoDesativacao = _confirmandoDesativacao,
            SemNuvem = identidade is null || identidade.Demonstracao,
            Lacuna = _lacuna,
        };
        SituacaoAlterada?.Invoke(this, Situacao);
    }

    /// <summary>Estado a partir da identidade e dos bloqueios em memória (nunca herdado da publicação anterior).</summary>
    private EstadoTerminalSync EstadoAtual(IdentidadeTerminal? identidade) => identidade?.Status switch
    {
        StatusIdentidade.Revogado => EstadoTerminalSync.Revogado,
        StatusIdentidade.Desativando => EstadoTerminalSync.Desativando,
        _ when _hardwareAlterado => EstadoTerminalSync.HardwareAlterado,
        // A regressão do push resolvida pela reidratação com a empresa suspensa segura as vendas até a regra 22.1.
        _ when _regressao || _regressaoNoPushEm is not null => EstadoTerminalSync.Regressao,
        _ when _lacuna is { Recuperavel: false } => EstadoTerminalSync.Lacuna,
        _ when _bloqueioNuvem is not null => EstadoTerminalSync.Suspenso,
        _ when _tokenRecusado || _protocoloRecusado => EstadoTerminalSync.Bloqueado,
        _ => EstadoTerminalSync.Ativo,
    };

    /// <summary>18.3: <c>aleatório(0, min(5 min, 5 s × 2^n))</c>, nunca abaixo de 5 s.</summary>
    private TimeSpan Espera(int falhas) => EnvioPush.CalcularBackoff(falhas, _opcoes.TetoBackoff, Random.Shared.NextDouble());

    /// <summary>Backoff de heartbeat e pull; com <c>Retry-After</c> (429/503), nunca menos que o informado (18.3).</summary>
    private TimeSpan EsperaApos(int falhas, Exception erro)
    {
        var espera = Espera(falhas);
        return erro is ErroSyncException { RepetirApos: { } repetir } && repetir > espera ? repetir : espera;
    }

    private static TimeSpan Segundos(int segundos, TimeSpan padrao) => segundos > 0 ? TimeSpan.FromSeconds(segundos) : padrao;

    private string? ArquivoBanco => _fabrica is FabricaPdvDb f ? f.CaminhoBanco : null;

    private int? DiscoLivreMb()
    {
        try
        {
            return ArquivoBanco is { } arquivo
                ? (int)(new DriveInfo(Path.GetPathRoot(Path.GetFullPath(arquivo))!).AvailableFreeSpace / 1024 / 1024)
                : null;
        }
        catch (Exception e) when (e is IOException or ArgumentException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private int? TamanhoBancoMb() =>
        ArquivoBanco is { } arquivo && File.Exists(arquivo) ? (int)(new FileInfo(arquivo).Length / 1024 / 1024) : null;
}
