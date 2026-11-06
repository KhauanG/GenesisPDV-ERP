using System.Net;
using System.Text.Json;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Protocolo;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using F = GenesisPDV.Sync.Protocolo.FormatoProtocolo;

namespace GenesisPDV.Sync.Push;

/// <summary>Como terminou uma rodada do push.</summary>
public enum DesfechoPush
{
    /// <summary>Nada a enviar (outbox vazio ou só confirmados/rejeitados).</summary>
    Vazio,

    /// <summary>
    /// Lote enviado e resultados gravados; pode haver mais (o ciclo repete na hora, se algum evento saiu da fila:
    /// <see cref="ResultadoEnvio.Enviados"/>).
    /// </summary>
    Enviado,

    /// <summary>O evento da frente está em backoff (<c>proxima_tentativa_em</c> no futuro).</summary>
    Aguardando,

    /// <summary>Falha transitória (rede, 5xx, 429/503): o lote fica em <c>erro_temporario</c> com backoff.</summary>
    Falhou,

    /// <summary><c>409 REGRESSAO_DETECTADA</c>: o envio para até a recuperação (SYNC 22.1).</summary>
    Regressao,

    /// <summary><c>409 HARDWARE_ALTERADO</c>: nada foi gravado na nuvem; o outbox fica como está (SYNC 20.5).</summary>
    HardwareAlterado,

    /// <summary>
    /// Reidratação começada e não concluída (<see cref="Recuperacao.ReidratacaoPendente"/>, SYNC 22.2): nada é enviado. Os
    /// eventos deslocados para a sequência provisória e os gravados no meio só sobem renumerados, depois dos da nuvem; um
    /// evento novo na frente deles abriria uma lacuna falsa (8.6).
    /// </summary>
    ReidratacaoPendente,
}

/// <param name="Enviados">
/// Eventos do lote que saíram da fila (<c>confirmado</c> ou <c>rejeitado</c>), mais os que a procura da lacuna devolveu à
/// fila para o reenvio na hora (8.6); 0 = nenhum avanço.
/// </param>
/// <param name="Proxima">Quando vale tentar de novo (backoff do evento da frente ou <c>Retry-After</c>).</param>
/// <param name="Lacuna">Lacuna de sequência que a resposta revelou (8.6; Fase 1C, C15), ou nulo.</param>
public sealed record ResultadoEnvio(
    DesfechoPush Desfecho, int Enviados = 0, DateTimeOffset? Proxima = null, ErroSyncException? Erro = null, LacunaEventos? Lacuna = null);

/// <summary>
/// Lacuna de sequência (SYNC 8.6; Fase 1C, C15). <see cref="Recuperavel"/> falso: a nuvem espera <see cref="De"/> e o
/// caixa não tem mais as sequências <see cref="De"/>..<see cref="Ate"/> (nem confirmadas com payload) — vendas
/// bloqueadas até o supervisor declarar a lacuna. Verdadeiro: o caixa tem eventos de uma lacuna <b>já declarada</b>
/// (a faixa é a da declaração) e a nuvem só os aceita com a liberação do supervisor (<c>recuperar_lacuna</c>).
/// </summary>
public sealed record LacunaEventos(long De, long Ate, bool Recuperavel)
{
    /// <summary>"1048–1049" (ou só "1048").</summary>
    public string Faixa => De == Ate ? $"{De}" : $"{De}–{Ate}";
}

/// <summary>
/// Envio do outbox (SYNC 7.2, 7.4, 7.5): lote de até 50 eventos em ordem de <c>sequencia_terminal</c>, sempre um
/// <b>prefixo contínuo</b> a partir do menor <c>pendente</c>/<c>enviando</c>/<c>erro_temporario</c> (evento da frente em
/// backoff = espera, nunca pula). O lote recebe <c>lote_envio_id</c> e <c>enviado_em</c> antes do envio; um reenvio (sem
/// resposta, queda do app) repete o <b>mesmo lote</b>: mesmos eventos, mesmo <c>lote_id</c> (também no
/// <c>X-Requisicao-Id</c>) e mesmo corpo. A leitura, o envio e a gravação do resultado são separados: nenhuma
/// transação do SQLite fica aberta esperando a rede (18.4). Máquina de status (7.2): <c>aplicado</c>/<c>duplicado</c> →
/// <c>confirmado</c>; <c>rejeitado</c>/<c>retido</c>/<c>descartado</c> → <c>rejeitado</c> (a nuvem tem o evento);
/// <c>nao_processado</c> → <c>pendente</c> (fora do lote); <c>erro_temporario</c>, <c>fora_de_ordem</c> (diagrama da
/// 7.2: lacuna antes dele, 8.6, ou nuvem restaurada, 22.5), status desconhecido e falha de rede → <c>erro_temporario</c>
/// com backoff de 5 s a 10 min (18.3; <c>Retry-After</c> nunca é encurtado). Nenhum desfecho deixa o evento da frente
/// pronto para reenvio na hora sem ter avançado: o laço do push nunca gira sem espera.
/// <para>
/// Lacunas (8.6; Fase 1C, C15): no <c>fora_de_ordem</c>, as sequências que a nuvem ainda espera (de
/// <c>proxima_sequencia_esperada</c> até a anterior à da frente) são procuradas em <c>eventos_saida</c> — inclusive
/// <c>confirmado</c>/<c>rejeitado</c> com payload, o caso da nuvem restaurada de backup (22.5) — e voltam a
/// <c>pendente</c> para o reenvio na hora; o que não existe mais vira <see cref="LacunaEventos"/>, que o ciclo publica
/// (vendas bloqueadas) até o supervisor declarar (<see cref="DeclararLacunaAsync"/>). <c>lacuna_recuperavel</c> fica em
/// backoff, como o <c>fora_de_ordem</c>, até o supervisor liberar o reenvio (<see cref="RecuperacaoAutorizada"/>, que vai
/// no lote como <c>recuperar_lacuna</c>). A re-hidratação pelo <c>GET /sync/recuperar</c> antes de declarar é do C17.
/// </para>
/// </summary>
public sealed class EnvioPush(IClienteSync cliente, IDbContextFactory<PdvDbContext> fabrica, IRelogio relogio, string versaoApp, ILogger<EnvioPush> log)
{
    public const int EventosPorLote = 50;
    public static readonly TimeSpan TetoBackoffEvento = TimeSpan.FromMinutes(10);

    private static readonly string[] Enviaveis = [StatusEventoSaida.Pendente, StatusEventoSaida.Enviando, StatusEventoSaida.ErroTemporario];

    /// <summary>Gerador do jitter do backoff (testes fixam).</summary>
    public Func<double> Aleatorio { get; set; } = Random.Shared.NextDouble;

    /// <summary>
    /// Liberação do supervisor para reenviar os eventos de uma lacuna já declarada (8.6): vai em todo lote como
    /// <c>recuperar_lacuna</c> enquanto houver. Quem a põe e a tira é o ciclo (<c>ServicoSincronizacaoHttp</c>): fica
    /// enquanto o outbox tiver eventos a enviar dentro da faixa (<see cref="TemAEnviarNaFaixaAsync"/>).
    /// </summary>
    public RecuperacaoLacuna? RecuperacaoAutorizada { get; set; }

    /// <summary>Texto do <c>ultimo_erro</c> do evento que a procura da lacuna devolveu à fila (8.6).</summary>
    public const string ReenvioLacuna = "reenvio: a nuvem não tem este evento (lacuna de sequência, SYNC 8.6)";

    /// <summary>Prefixo do <c>ultimo_erro</c> do evento em espera por <c>fora_de_ordem</c> (lacuna antes dele, 8.6).</summary>
    public const string PrefixoForaDeOrdem = "fora_de_ordem: ";

    /// <summary>Prefixo do <c>ultimo_erro</c> do evento em espera por <c>lacuna_recuperavel</c> (lacuna declarada, 8.6).</summary>
    public const string PrefixoLacunaRecuperavel = "lacuna_recuperavel: ";

    /// <summary>Abertura do app (7.5 passo 6): lote em voo volta a <c>pendente</c>, mantendo o lote para o reenvio igual.</summary>
    public async Task<int> RetomarEmVooAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.EventosSaida.Where(e => e.Status == StatusEventoSaida.Enviando)
            .ExecuteUpdateAsync(s => s.SetProperty(e => e.Status, StatusEventoSaida.Pendente), ct);
    }

    /// <summary>
    /// Prefixo do <c>ultimo_erro</c> do evento em <c>erro_temporario</c> quando a espera veio de falha de transporte (sem
    /// resposta da nuvem: rede, DNS, TLS, prazo, corpo ilegível). É a única espera que a volta de offline zera (C13): a
    /// que a nuvem pediu (<c>Retry-After</c> do 429/503, o <c>erro_temporario</c>/<c>fora_de_ordem</c> por evento, o
    /// erro HTTP) fica como está.
    /// </summary>
    public const string PrefixoTransporte = "transporte: ";

    /// <summary>
    /// Volta de um período offline (SYNC 18.3: o backoff "zera no primeiro sucesso" e a reconexão faz "push até
    /// esvaziar"; Fase 1C, C13): os eventos em <c>erro_temporario</c> por falha de transporte
    /// (<see cref="PrefixoTransporte"/>) deixam de esperar o backoff que cresceu durante a queda (até 10 min) e a contagem
    /// de tentativas, que só serve ao expoente do backoff, recomeça. O lote sai na hora e é o mesmo lote
    /// (<c>lote_envio_id</c> e corpo intactos); uma falha logo depois da volta espera de 5 a 10 s, não os minutos
    /// acumulados offline. A espera que a nuvem pediu não é tocada: um <c>Retry-After</c> já gravado vale até o fim
    /// (18.3, "nunca menos que o informado") e o backoff de um resultado por evento continua crescendo.
    /// </summary>
    public async Task<int> ZerarBackoffAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.EventosSaida
            .Where(e => e.Status == StatusEventoSaida.ErroTemporario && e.UltimoErro != null && e.UltimoErro.StartsWith(PrefixoTransporte))
            .ExecuteUpdateAsync(s => s.SetProperty(e => e.ProximaTentativaEm, (DateTimeOffset?)null).SetProperty(e => e.Tentativas, 0), ct);
    }

    /// <summary>Uma rodada: monta (ou repete) o lote da frente, envia e grava os resultados.</summary>
    public Task<ResultadoEnvio> EnviarAsync(CancellationToken ct = default) => EnviarAsync(voltaDeOffline: false, ct);

    /// <summary>
    /// Uma rodada. <paramref name="voltaDeOffline"/>: o PDV está offline e este push pode ser o primeiro contato com a
    /// nuvem; se ela responder, as tentativas do lote que só falharam no transporte não contam no backoff do que ela
    /// devolver (o mesmo que <see cref="ZerarBackoffAsync"/> faz quando a volta vem pelo heartbeat ou pelo pull).
    /// </summary>
    public async Task<ResultadoEnvio> EnviarAsync(bool voltaDeOffline, CancellationToken ct = default)
    {
        await using (var db = await fabrica.CreateDbContextAsync(ct))
        {
            if (await Recuperacao.ReidratacaoLocal.PendenteAsync(db, ct) is not null)
            {
                return new ResultadoEnvio(DesfechoPush.ReidratacaoPendente);
            }
        }

        var lote = await PrepararAsync(ct);
        if (lote is null)
        {
            return new ResultadoEnvio(DesfechoPush.Vazio);
        }

        if (lote.Aguardar is { } aguardar)
        {
            return new ResultadoEnvio(DesfechoPush.Aguardando, Proxima: aguardar);
        }

        RespostaPush resposta;
        try
        {
            resposta = await cliente.PushAsync(lote.Requisicao, ct);
        }
        catch (ErroSyncException e) when (e.Codigo == "REGRESSAO_DETECTADA")
        {
            // Os eventos do lote já processados vêm em `detalhes.resultados` (README da API): grava e para.
            var parciais = e.Erro?.Detalhes is { ValueKind: JsonValueKind.Object } d && d.TryGetProperty("resultados", out var r)
                ? r.Deserialize<List<ResultadoEventoPush>>(ContratosJson.Opcoes) ?? []
                : [];
            await GravarResultadosAsync(lote, parciais, voltaDeOffline, ct);
            log.LogCritical("Push: regressão detectada pela nuvem (sequência já usada por outro evento); envio parado (SYNC 22.1)");
            return new ResultadoEnvio(DesfechoPush.Regressao, Erro: e);
        }
        catch (ErroSyncException e) when (e.Codigo == "HARDWARE_ALTERADO")
        {
            await DevolverAsync(lote, ct);
            return new ResultadoEnvio(DesfechoPush.HardwareAlterado, Erro: e);
        }
        catch (ErroSyncException e) when (e.Status == HttpStatusCode.Unauthorized)
        {
            // Revogado/token inválido: quem chama trata o 401; o lote volta intacto (nunca se perde).
            await DevolverAsync(lote, ct);
            throw;
        }
        catch (Exception e) when (e is ErroSyncException or HttpRequestException or JsonException
                                      || (e is TaskCanceledException && !ct.IsCancellationRequested))
        {
            // Sem resposta da nuvem (rede, prazo, corpo ilegível): espera de transporte, a única que a volta de offline zera.
            var semResposta = e is not ErroSyncException;
            var proxima = await BackoffAsync(lote, semResposta ? PrefixoTransporte + e.Message : e.Message, (e as ErroSyncException)?.RepetirApos,
                descontarQueda: voltaDeOffline && !semResposta, ct);
            log.LogWarning("Push do lote {Lote} falhou ({Erro}); nova tentativa a partir de {Proxima:O}", lote.Requisicao.LoteId, e.Message, proxima);
            return new ResultadoEnvio(DesfechoPush.Falhou, Proxima: proxima, Erro: e as ErroSyncException);
        }

        var (avancaram, lacuna) = await GravarResultadosAsync(lote, resposta.Resultados, voltaDeOffline, ct, resposta.ProximaSequenciaEsperada);
        return new ResultadoEnvio(DesfechoPush.Enviado, avancaram, Lacuna: lacuna);
    }

    /// <summary>
    /// <c>declarar_lacuna</c> (8.6): um lote sem eventos com a faixa, o motivo e o supervisor que liberou. Aceita (a
    /// <c>proxima_sequencia_esperada</c> passou da faixa), os eventos em espera do <c>fora_de_ordem</c> saem já no próximo
    /// push. Recusa da nuvem (<c>LACUNA_INVALIDA</c>, <c>LIBERACAO_INVALIDA</c>) ou falha de rede sobem como exceção.
    /// </summary>
    public async Task<RespostaPush> DeclararLacunaAsync(DeclaracaoLacuna declaracao, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(declaracao);
        IdentidadeTerminal identidade;
        int pendentes;
        await using (var db = await fabrica.CreateDbContextAsync(ct))
        {
            identidade = await db.IdentidadeTerminal.AsNoTracking().FirstOrDefaultAsync(ct)
                         ?? throw new InvalidOperationException("Terminal sem identidade.");
            pendentes = await db.EventosSaida.CountAsync(e => e.Status != StatusEventoSaida.Confirmado, ct);
        }

        var resposta = await cliente.PushAsync(
            new RequisicaoPush(IdGerador.Novo(), identidade.TerminalId, F.DataHora(relogio.Agora), pendentes, [], declaracao), ct);
        if (resposta.ProximaSequenciaEsperada > declaracao.Ate)
        {
            await LiberarEsperaAsync(ct);
        }

        return resposta;
    }

    /// <summary>Os eventos em <c>erro_temporario</c> saem no próximo push (lacuna declarada ou reenvio liberado, 8.6).</summary>
    public async Task<int> LiberarEsperaAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.EventosSaida.Where(e => e.Status == StatusEventoSaida.ErroTemporario)
            .ExecuteUpdateAsync(s => s.SetProperty(e => e.ProximaTentativaEm, (DateTimeOffset?)null), ct);
    }

    /// <summary>
    /// Só a espera que veio da lacuna (<see cref="PrefixoForaDeOrdem"/>, <see cref="PrefixoLacunaRecuperavel"/>) cai: o
    /// próximo push a revela de novo na hora. A lacuna conhecida fica só em memória, e sem isto ela sumiria até o backoff
    /// do evento da frente vencer (até 10 min) — na abertura do app e na declaração recusada com <c>LACUNA_INVALIDA</c>,
    /// as vendas novas ficariam liberadas nesse tempo (8.6, T39). O <c>Retry-After</c> e o backoff de outros erros não
    /// são tocados; as tentativas continuam contando.
    /// </summary>
    public async Task<int> LiberarEsperaDaLacunaAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.EventosSaida
            .Where(e => e.Status == StatusEventoSaida.ErroTemporario && e.ProximaTentativaEm != null && e.UltimoErro != null
                        && (e.UltimoErro.StartsWith(PrefixoForaDeOrdem) || e.UltimoErro.StartsWith(PrefixoLacunaRecuperavel)))
            .ExecuteUpdateAsync(s => s.SetProperty(e => e.ProximaTentativaEm, (DateTimeOffset?)null), ct);
    }

    /// <summary>Ainda há evento a enviar (<c>pendente</c>, <c>enviando</c>, <c>erro_temporario</c>) com sequência na faixa?</summary>
    public async Task<bool> TemAEnviarNaFaixaAsync(long de, long ate, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.EventosSaida.AnyAsync(
            e => Enviaveis.Contains(e.Status) && e.SequenciaTerminal >= de && e.SequenciaTerminal <= ate, ct);
    }

    private sealed record Lote(RequisicaoPush Requisicao, IReadOnlyList<Guid> Ids, DateTimeOffset? Aguardar);

    /// <summary>
    /// Prefixo contínuo da frente. Se o evento da frente já tem lote (reenvio), o lote é exatamente o daquele id, na mesma
    /// ordem e com o mesmo <c>enviado_em</c>; senão, um lote novo com até 50 eventos sem lote anterior.
    /// </summary>
    private async Task<Lote?> PrepararAsync(CancellationToken ct)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var identidade = await db.IdentidadeTerminal.AsNoTracking().FirstOrDefaultAsync(ct);
        if (identidade is null || identidade.Demonstracao)
        {
            return null;
        }

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        // Sequência ≤ 0 é a provisória da reidratação (22.1, C17): o evento espera ela terminar e ganhar a sequência final
        // (a pendência já parou o envio acima; o filtro fica para o caso de a pendência ter sido apagada à mão).
        var frente = await db.EventosSaida.Where(e => Enviaveis.Contains(e.Status) && e.SequenciaTerminal > 0)
            .OrderBy(e => e.SequenciaTerminal).FirstOrDefaultAsync(ct);
        if (frente is null)
        {
            return null;
        }

        var agora = relogio.Agora;
        if (frente.Status == StatusEventoSaida.ErroTemporario && frente.ProximaTentativaEm is { } proxima && proxima > agora)
        {
            return new Lote(null!, [], proxima);
        }

        List<EventoSaida> eventos;
        Guid loteId;
        if (frente.LoteEnvioId is { } existente)
        {
            loteId = existente;
            eventos = await db.EventosSaida.Where(e => e.LoteEnvioId == existente && Enviaveis.Contains(e.Status))
                .OrderBy(e => e.SequenciaTerminal).ToListAsync(ct);
        }
        else
        {
            loteId = IdGerador.Novo();
            var candidatos = await db.EventosSaida.Where(e => Enviaveis.Contains(e.Status) && e.SequenciaTerminal >= frente.SequenciaTerminal)
                .OrderBy(e => e.SequenciaTerminal).Take(EventosPorLote).ToListAsync(ct);
            // Prefixo contínuo e sem lote anterior: um evento de outro lote em voo encerra este.
            eventos = [.. candidatos.TakeWhile(e => e.LoteEnvioId is null)];
        }

        var enviadoEm = eventos.Select(e => e.EnviadoEm).FirstOrDefault(e => e is not null) ?? agora;
        foreach (var e in eventos)
        {
            e.Status = StatusEventoSaida.Enviando;
            e.LoteEnvioId = loteId;
            e.EnviadoEm ??= enviadoEm;
            e.Tentativas++;
        }

        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        var requisicao = new RequisicaoPush(
            loteId,
            identidade.TerminalId,
            F.DataHora(enviadoEm),
            null,
            [.. eventos.Select(e => OutboxSync.Envelope(e, identidade, versaoApp))],
            RecuperarLacuna: RecuperacaoAutorizada);
        return new Lote(requisicao, [.. eventos.Select(e => e.Id)], null);
    }

    /// <summary>
    /// Grava os resultados do lote; devolve quantos eventos saíram da fila (confirmados ou rejeitados, mais os devolvidos
    /// à fila pela procura da lacuna) e a lacuna revelada, se houver (8.6).
    /// </summary>
    private async Task<(int Avancaram, LacunaEventos? Lacuna)> GravarResultadosAsync(
        Lote lote, IReadOnlyList<ResultadoEventoPush> resultados, bool descontarQueda, CancellationToken ct, long? esperado = null)
    {
        var avancaram = 0;
        LacunaEventos? lacuna = null;
        var porId = resultados.ToDictionary(r => r.EventoId);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var eventos = await db.EventosSaida.Where(e => lote.Ids.Contains(e.Id)).ToListAsync(ct);
        var agora = relogio.Agora;
        foreach (var e in eventos)
        {
            if (!porId.TryGetValue(e.Id, out var r))
            {
                // Sem resultado (lote cortado pela regressão): volta para a fila, fora do lote.
                Pendente(e);
                continue;
            }

            switch (r.Status)
            {
                case StatusResultadoEvento.Aplicado or StatusResultadoEvento.Duplicado:
                    avancaram++;
                    e.Status = StatusEventoSaida.Confirmado;
                    e.ConfirmadoEm = agora;
                    e.VersaoNuvem = r.VersaoNuvem;
                    e.VersaoNuvemFim = r.VersaoNuvemFim;
                    e.Resultado = r.Resultado is { } res ? res.GetRawText() : "{}";
                    e.UltimoErro = null;
                    e.ProximaTentativaEm = null;
                    break;
                case StatusResultadoEvento.Rejeitado or StatusResultadoEvento.Retido or StatusResultadoEvento.Descartado:
                    // A nuvem guardou o evento (quarentena): não reenvia, não apaga; a resolução chega pelo heartbeat.
                    avancaram++;
                    e.Status = StatusEventoSaida.Rejeitado;
                    e.Resultado = r.Resultado?.GetRawText();
                    e.UltimoErro = Erro(r);
                    e.ProximaTentativaEm = null;
                    // A ocorrência ligada ao evento (Central do PDV, aba 4, bloco G7): o motivo com o id do evento e do
                    // agregado, para o detalhe da venda achar o que aconteceu com ela. O log_local não sobe nem tem a
                    // trava da D22 (README do PDV › decisão 72).
                    db.LogLocal.Add(OcorrenciaRecusa(e, r.Status, agora));
                    break;
                case StatusResultadoEvento.NaoProcessado:
                    // O lote parou num evento anterior (que ficou com backoff): volta para a fila, fora do lote.
                    Pendente(e);
                    break;
                case StatusResultadoEvento.LacunaRecuperavel:
                    // 8.6: a sequência está numa lacuna já declarada. Espera em backoff (como o fora_de_ordem) até o
                    // supervisor liberar o reenvio, que então sai na hora com `recuperar_lacuna`.
                    DescontarQueda(e, descontarQueda);
                    e.Status = StatusEventoSaida.ErroTemporario;
                    e.UltimoErro = PrefixoLacunaRecuperavel + (Erro(r) ?? "evento numa lacuna declarada.");
                    e.ProximaTentativaEm = agora + Backoff(e.Tentativas);
                    lacuna ??= FaixaDeclarada(r) is { } faixa ? new LacunaEventos(faixa.De, faixa.Ate, true) : new LacunaEventos(r.Sequencia, r.Sequencia, true);
                    break;
                default:
                    // erro_temporario, fora_de_ordem e qualquer status novo: backoff. O `fora_de_ordem` repetido (lacuna
                    // ainda não declarada) vira POST espaçado, nunca um reenvio sem fim; a procura das sequências que
                    // faltam vem depois do laço (ProcurarFaltantesAsync, 8.6).
                    DescontarQueda(e, descontarQueda);
                    e.Status = StatusEventoSaida.ErroTemporario;
                    e.UltimoErro = r.Status == StatusResultadoEvento.ForaDeOrdem
                        ? PrefixoForaDeOrdem + (Erro(r) ?? "a nuvem espera outra sequência deste terminal.")
                        : Erro(r) ?? $"{r.Status}: status sem tratamento neste PDV.";
                    e.ProximaTentativaEm = agora + Backoff(e.Tentativas);
                    break;
            }
        }

        if (esperado is { } espera && resultados.FirstOrDefault(r => r.Status == StatusResultadoEvento.ForaDeOrdem) is { } fora)
        {
            var (reenviados, faltando) = await ProcurarFaltantesAsync(db, espera, fora.Sequencia, eventos, ct);
            avancaram += reenviados;
            lacuna ??= faltando;
        }

        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        if (lacuna is { Recuperavel: false } perdida)
        {
            log.LogCritical("Push: lacuna de eventos {Faixa}: a nuvem espera a sequência {De} e o caixa não a tem mais; vendas bloqueadas até o supervisor declarar (SYNC 8.6)",
                perdida.Faixa, perdida.De);
        }

        var rejeitados = resultados.Count(r => r.Status is StatusResultadoEvento.Rejeitado or StatusResultadoEvento.Retido);
        if (rejeitados > 0)
        {
            log.LogWarning("Push do lote {Lote}: {Rejeitados} evento(s) em quarentena na nuvem", lote.Requisicao.LoteId, rejeitados);
        }

        if (resultados.Any(r => r.Status == StatusResultadoEvento.ForaDeOrdem))
        {
            log.LogError("Push do lote {Lote}: a nuvem respondeu fora_de_ordem (lacuna local ou nuvem restaurada); nova tentativa com backoff",
                lote.Requisicao.LoteId);
        }

        return (avancaram, lacuna);
    }

    /// <summary>
    /// <c>fora_de_ordem</c> (8.6): a nuvem espera <paramref name="esperado"/> e o lote começou em <paramref name="frente"/>.
    /// As sequências do meio que o caixa ainda tem — <c>confirmado</c> ou <c>rejeitado</c> com payload: a nuvem foi
    /// restaurada de backup e as esqueceu (22.5) — voltam a <c>pendente</c>; se a esperada é uma delas, o lote do
    /// <c>fora_de_ordem</c> também volta, sem espera, e tudo sai de novo em ordem no próximo push. A sequência
    /// esperada que não existe mais é o começo da lacuna, que vai até a anterior à primeira que o caixa tem.
    /// </summary>
    private static async Task<(int Reenviados, LacunaEventos? Lacuna)> ProcurarFaltantesAsync(
        PdvDbContext db, long esperado, long frente, IReadOnlyList<EventoSaida> doLote, CancellationToken ct)
    {
        if (esperado >= frente)
        {
            return (0, null);
        }

        var locais = await db.EventosSaida
            .Where(e => e.SequenciaTerminal >= esperado && e.SequenciaTerminal < frente
                        && (e.Status == StatusEventoSaida.Confirmado || e.Status == StatusEventoSaida.Rejeitado))
            .ToListAsync(ct);
        var reenviaveis = locais.Where(e => !string.IsNullOrWhiteSpace(e.Payload)).OrderBy(e => e.SequenciaTerminal).ToList();
        foreach (var e in reenviaveis)
        {
            Pendente(e);
            e.Tentativas = 0;
            e.UltimoErro = ReenvioLacuna;
        }

        if (reenviaveis.FirstOrDefault()?.SequenciaTerminal == esperado)
        {
            // Nada perdido na frente: o lote do fora_de_ordem volta para a fila e sai em ordem, já.
            foreach (var e in doLote.Where(e => e.Status == StatusEventoSaida.ErroTemporario))
            {
                Pendente(e);
                e.UltimoErro = ReenvioLacuna;
            }

            return (reenviaveis.Count, null);
        }

        var ate = (reenviaveis.FirstOrDefault()?.SequenciaTerminal ?? frente) - 1;
        return (reenviaveis.Count, new LacunaEventos(esperado, ate, false));
    }

    /// <summary>A faixa declarada que a nuvem devolve no <c>lacuna_recuperavel</c> (<c>resultado.lacuna</c>).</summary>
    private static (long De, long Ate)? FaixaDeclarada(ResultadoEventoPush r)
    {
        if (r.Resultado is not { ValueKind: JsonValueKind.Object } res
            || !res.TryGetProperty("lacuna", out var l) || l.ValueKind != JsonValueKind.Object
            || !l.TryGetProperty("de", out var de) || !l.TryGetProperty("ate", out var ate)
            || !de.TryGetInt64(out var d) || !ate.TryGetInt64(out var a))
        {
            return null;
        }

        return (d, a);
    }

    /// <summary>O lote não chegou a ser processado (401, 409 de hardware): volta como estava, com o mesmo lote.</summary>
    private async Task DevolverAsync(Lote lote, CancellationToken ct)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await db.EventosSaida.Where(e => lote.Ids.Contains(e.Id) && e.Status == StatusEventoSaida.Enviando)
            .ExecuteUpdateAsync(s => s.SetProperty(e => e.Status, StatusEventoSaida.Pendente), CancellationToken.None);
    }

    private async Task<DateTimeOffset> BackoffAsync(Lote lote, string erro, TimeSpan? repetirApos, bool descontarQueda, CancellationToken ct)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var eventos = await db.EventosSaida.Where(e => lote.Ids.Contains(e.Id)).ToListAsync(CancellationToken.None);
        foreach (var e in eventos)
        {
            DescontarQueda(e, descontarQueda);
        }

        var tentativas = eventos.Count == 0 ? 1 : eventos.Min(e => e.Tentativas);
        var espera = Backoff(tentativas);
        if (repetirApos is { } r && r > espera)
        {
            espera = r;
        }

        var proxima = relogio.Agora + espera;
        foreach (var e in eventos.Where(e => e.Status == StatusEventoSaida.Enviando))
        {
            e.Status = StatusEventoSaida.ErroTemporario;
            e.UltimoErro = erro.Length > 500 ? erro[..500] : erro;
            e.ProximaTentativaEm = proxima;
        }

        await db.SaveChangesAsync(CancellationToken.None);
        return proxima;
    }

    /// <summary>18.3: <c>aleatório(0, min(teto, 5 s × 2^(tentativa−1)))</c>, nunca abaixo de 5 s.</summary>
    public TimeSpan Backoff(int tentativa) => CalcularBackoff(tentativa, TetoBackoffEvento, Aleatorio());

    public static TimeSpan CalcularBackoff(int tentativa, TimeSpan teto, double aleatorio)
    {
        var expoente = Math.Clamp(tentativa - 1, 0, 20);
        var limite = Math.Min(teto.TotalMilliseconds, 5_000 * Math.Pow(2, expoente));
        return TimeSpan.FromMilliseconds(Math.Max(5_000, limite * Math.Clamp(aleatorio, 0, 1)));
    }

    /// <summary>
    /// Primeira resposta da nuvem depois de offline: as tentativas que só falharam no transporte durante a queda saem da
    /// conta (fica a desta resposta), como no <see cref="ZerarBackoffAsync"/>; a contagem do que a nuvem já devolveu antes
    /// da queda continua.
    /// </summary>
    private static void DescontarQueda(EventoSaida e, bool descontar)
    {
        if (descontar && e.UltimoErro?.StartsWith(PrefixoTransporte, StringComparison.Ordinal) == true)
        {
            e.Tentativas = 1;
        }
    }

    private static void Pendente(EventoSaida e)
    {
        e.Status = StatusEventoSaida.Pendente;
        e.LoteEnvioId = null;
        e.EnviadoEm = null;
        e.ProximaTentativaEm = null;
    }

    private static string? Erro(ResultadoEventoPush r) => r.Erro is { } e ? $"{e.Codigo}: {e.Mensagem}" : null;

    /// <summary>Origem das ocorrências do envio no <c>log_local</c> (a aba 4 Sincronização as liga ao evento e à venda).</summary>
    public const string OrigemLog = OrigensOcorrencia.Sync;

    /// <summary>
    /// A ocorrência do <c>log_local</c> de um evento recusado (ou retido, ou descartado) pela nuvem: o tipo, a sequência e
    /// o motivo na mensagem; o id do evento, o agregado e o código da nuvem (<c>codigo_nuvem</c>; o <c>codigo</c> é o do
    /// PDV, <see cref="CodigoOcorrencia.RegistroRecusado"/>, bloco G8) no <c>detalhes</c> (JSON). Sem payload.
    /// </summary>
    internal static LogLocal OcorrenciaRecusa(EventoSaida e, string status, DateTimeOffset agora)
    {
        var codigo = e.UltimoErro is { } erro && erro.IndexOf(':', StringComparison.Ordinal) is var i and > 0 ? erro[..i] : null;
        var dados = new System.Text.Json.Nodes.JsonObject
        {
            ["evento_id"] = e.Id.ToString(),
            ["tipo"] = e.Tipo,
            ["sequencia"] = e.SequenciaTerminal,
            ["agregado_tipo"] = e.AgregadoTipo,
            ["agregado_id"] = e.AgregadoId.ToString(),
            ["status_nuvem"] = status,
            ["codigo_nuvem"] = codigo,
        };
        return Ocorrencias.Nova(
            agora, NiveisOcorrencia.Aviso, CodigoOcorrencia.RegistroRecusado,
            $"A nuvem recusou o registro {e.Tipo} nº {e.SequenciaTerminal}: {e.UltimoErro ?? "sem motivo informado"}", dados);
    }
}
