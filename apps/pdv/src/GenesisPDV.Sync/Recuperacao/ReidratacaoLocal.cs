using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Protocolo;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.Sync.Recuperacao;

/// <summary>Resumo da reidratação (log e status do sync).</summary>
/// <param name="Recebidos">Eventos que a nuvem devolveu (placeholders incluídos).</param>
/// <param name="Recriados">Eventos que não existiam no banco local e foram gravados, com os fatos recriados.</param>
/// <param name="JaExistiam">Eventos que o banco local já tinha (só a situação na nuvem foi aplicada).</param>
/// <param name="Renumerados">Eventos do caixa gerados depois do backup e nunca aceitos pela nuvem, levados para depois do último dela.</param>
/// <param name="UltimaSequencia">A sequência local de eventos no fim (<c>sequencias_locais.evento</c>).</param>
/// <param name="UltimaRecebida">A <c>ultima_recebida</c> da nuvem na última página (a base da renumeração).</param>
public sealed record ResultadoReidratacao(int Recebidos, int Recriados, int JaExistiam, int Renumerados, long UltimaSequencia, long UltimaRecebida);

/// <summary>
/// Reidratação começada e não concluída (<c>configuracao_terminal</c> <see cref="ChavesConfiguracaoTerminal.ReidratacaoPendente"/>):
/// gravada no passo 1 e apagada no passo 3, na mesma transação de cada um. Enquanto existe, o push não manda nada
/// (<see cref="Push.DesfechoPush.ReidratacaoPendente"/>) e o handshake reidrata de novo a partir de <see cref="Desde"/>,
/// também depois de reabrir o app; <see cref="Regressao"/> mantém as vendas bloqueadas, já que a sequência local subiu no
/// passo 1 e não mostra mais a regressão.
/// </summary>
public sealed record ReidratacaoPendente(long Desde, bool Regressao, DateTimeOffset IniciadaEm);

/// <summary>
/// Re-hidratação do banco local restaurado ou antigo (SYNC 22.1, 22.2; Fase 1C, C17): pede ao <c>GET /sync/recuperar</c>
/// o que este terminal já enviou depois de <c>desde</c> e recria no caixa o que o banco perdeu. Idempotente: o evento que
/// o banco já tem (mesmo <c>evento_id</c>) não é gravado de novo e repetir a reidratação inteira não muda nada.
/// <list type="number">
/// <item><b>Antes</b> (uma transação): grava a <see cref="ReidratacaoPendente"/> (o push para até o passo 3, também com o
/// app reaberto); os eventos ainda a enviar com sequência acima de <c>desde</c> — gerados depois do backup, offline no
/// "modo restaurado" — vão para uma sequência negativa provisória (o push nunca manda sequência ≤ 0): a nuvem pode já
/// ter as mesmas sequências com outros eventos, os que se perderam com o banco. <c>sequencias_locais.evento</c> sobe até
/// a <c>ultima_recebida</c> que o handshake conhece: o evento que o caixa grava no meio (a venda que termina, a sangria,
/// o fechamento, a auditoria) cai acima de tudo o que a nuvem tem, e não numa sequência que uma página vai gravar.</item>
/// <item><b>Uma transação por página</b> (50 eventos): o evento que o caixa já tem fica com a sequência da nuvem e a
/// situação dela (<c>aplicado</c> → <c>confirmado</c>; <c>erro</c>/<c>retido</c>/<c>descartado</c> → <c>rejeitado</c>,
/// como no push); o que não tem é gravado em <c>eventos_saida</c> com o mesmo id, a mesma sequência e o payload, e os
/// fatos do payload são recriados nas tabelas de movimento (<see cref="Tabelas"/>: venda com itens, pagamentos,
/// parcelas, PIX e liberações; sessão, movimentos e fechamento do caixa; devolução de cascos). O placeholder de lacuna
/// (T7) e o evento sem payload (anulado) só ocupam a sequência. A sequência local acompanha a <c>ultima_recebida</c> da
/// página.</item>
/// <item><b>Depois</b> (uma transação): os eventos provisórios e os gravados no meio voltam, na ordem em que foram
/// gerados, para logo depois da última sequência da nuvem, <c>sequencias_locais.evento</c> fica no último deles e a
/// <see cref="ReidratacaoPendente"/> é apagada. O push os manda em seguida.</item>
/// </list>
/// Linha parcial (o fechamento da sessão, o cancelamento do movimento ou da venda finalizada) só atualiza a linha que
/// existe: sem a linha, nada é criado (falta o evento que a criou, que é o caso da lacuna). O documento de venda
/// (<c>venda.finalizada</c>, <c>venda.cancelada</c> forma B) substitui as linhas filhas da venda em andamento que o backup
/// tinha. Ficam de fora a auditoria (os registros já estão na nuvem), os cascos descontados na venda (tabela só local, sem
/// payload próprio: a reimpressão da venda recuperada sai sem a linha do desconto pelos cascos) e o snapshot dos produtos.
/// </summary>
public sealed class ReidratacaoLocal(IClienteSync cliente, IDbContextFactory<PdvDbContext> fabrica, IRelogio relogio, ILogger log)
{
    /// <summary>Tabelas de movimento que a reidratação grava, na ordem das chaves estrangeiras.</summary>
    public static readonly IReadOnlyList<string> Tabelas =
    [
        "sessoes_caixa", "vendas", "itens_venda", "pagamentos_venda", "parcelas_venda", "cobrancas_pix",
        "fechamentos_caixa", "fechamentos_caixa_formas", "movimentos_caixa", "movimentos_vasilhame",
    ];

    private static readonly string[] Enviaveis = [StatusEventoSaida.Pendente, StatusEventoSaida.Enviando, StatusEventoSaida.ErroTemporario];

    /// <summary>Base das sequências provisórias da renumeração final (longe de qualquer sequência real negada).</summary>
    private const long BaseProvisoria = 1_000_000_000_000;

    public Task<ResultadoReidratacao> ExecutarAsync(long desde, CancellationToken ct = default) =>
        ExecutarAsync(desde, ultimaRecebida: 0, regressao: false, ct);

    /// <summary>
    /// Reidrata desde <paramref name="desde"/> (ou desde a <see cref="ReidratacaoPendente"/> interrompida, se for anterior).
    /// <paramref name="ultimaRecebida"/>: a do <c>/sync/estado</c> (a sequência local sobe até ela no passo 1);
    /// <paramref name="regressao"/>: fica gravada na pendência até o passo 3.
    /// </summary>
    public async Task<ResultadoReidratacao> ExecutarAsync(long desde, long ultimaRecebida, bool regressao, CancellationToken ct = default)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(desde);
        var (deslocados, pendente) = await ComecarAsync(desde, ultimaRecebida, regressao, ct);
        desde = pendente.Desde;
        int recebidos = 0, recriados = 0, existiam = 0;
        var cursor = desde;
        long ultimaNuvem = 0;
        for (var paginas = 0; ; paginas++)
        {
            var pagina = await cliente.RecuperarAsync(cursor, ClienteSyncHttp.PaginaRecuperar, ct);
            ultimaNuvem = pagina.UltimaRecebida;
            var (gravados, ja) = await AplicarPaginaAsync(pagina.Eventos, pagina.UltimaRecebida, ct);
            recebidos += pagina.Eventos.Count;
            recriados += gravados;
            existiam += ja;
            if (!pagina.TemMais || pagina.Eventos.Count == 0)
            {
                break;
            }

            var proximo = pagina.Eventos[^1].Envelope.Sequencia;
            if (proximo <= cursor)
            {
                throw new InvalidOperationException($"GET /sync/recuperar não avançou (desde {cursor}, última {proximo}).");
            }

            cursor = proximo;
        }

        var (renumerados, ultima) = await RenumerarAsync(desde, ultimaNuvem, ct);
        log.LogWarning(
            "Reidratação (SYNC 22.2) desde {Desde}: {Recebidos} evento(s) da nuvem, {Recriados} recriado(s), {Existiam} já no banco, " +
            "{Renumerados} do caixa renumerado(s) ({Deslocados} deslocado(s)); sequência local {Ultima}",
            desde, recebidos, recriados, existiam, renumerados, deslocados, ultima);
        return new ResultadoReidratacao(recebidos, recriados, existiam, renumerados, ultima, ultimaNuvem);
    }

    /// <summary>
    /// A reidratação começada e não concluída, ou nulo. Evento com sequência provisória (≤ 0) sem a pendência gravada
    /// (banco copiado no meio) também conta: recomeça logo antes do primeiro deles (a provisória é a original negada, então
    /// o primeiro é o mais próximo de zero).
    /// </summary>
    public static async Task<ReidratacaoPendente?> PendenteAsync(PdvDbContext db, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        var linha = await db.ConfiguracaoTerminal.AsNoTracking().FirstOrDefaultAsync(c => c.Chave == ChavesConfiguracaoTerminal.ReidratacaoPendente, ct);
        if (linha is not null && JsonSerializer.Deserialize<ReidratacaoPendente>(linha.Valor) is { } pendente)
        {
            return pendente;
        }

        var provisoria = await db.EventosSaida.Where(e => e.SequenciaTerminal <= 0).MaxAsync(e => (long?)e.SequenciaTerminal, ct);
        return provisoria is { } p ? new ReidratacaoPendente(Math.Max(0, Math.Min(-p, BaseProvisoria) - 1), false, DateTimeOffset.MinValue) : null;
    }

    /// <summary>
    /// Passo 1: grava a pendência, tira do caminho (sequência negativa) o que ainda vai subir com sequência acima de
    /// <c>desde</c> e leva a sequência local até a <paramref name="ultimaRecebida"/>.
    /// </summary>
    private async Task<(int Deslocados, ReidratacaoPendente Pendente)> ComecarAsync(long desde, long ultimaRecebida, bool regressao, CancellationToken ct)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var agora = relogio.Agora;
        // A anterior interrompida: recomeça do ponto mais antigo, e a regressão dela continua valendo.
        var anterior = await PendenteAsync(db, ct);
        var pendente = new ReidratacaoPendente(
            Math.Min(desde, anterior?.Desde ?? desde), regressao || anterior?.Regressao == true, anterior?.IniciadaEm ?? agora);
        var linha = await db.ConfiguracaoTerminal.FirstOrDefaultAsync(c => c.Chave == ChavesConfiguracaoTerminal.ReidratacaoPendente, ct);
        if (linha is null)
        {
            linha = new ConfiguracaoTerminal { Chave = ChavesConfiguracaoTerminal.ReidratacaoPendente };
            db.ConfiguracaoTerminal.Add(linha);
        }

        linha.Valor = JsonSerializer.Serialize(pendente);
        linha.AtualizadoEm = agora;

        var eventos = await db.EventosSaida
            .Where(e => e.SequenciaTerminal > pendente.Desde && Enviaveis.Contains(e.Status))
            .ToListAsync(ct);
        foreach (var e in eventos)
        {
            e.SequenciaTerminal = -e.SequenciaTerminal;
            Pendente(e);
        }

        await SubirSequenciaAsync(db, ultimaRecebida, agora, ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return (eventos.Count, pendente);
    }

    /// <summary><c>sequencias_locais.evento</c> nunca abaixo de <paramref name="minimo"/> (o próximo evento do caixa vem depois).</summary>
    private static async Task SubirSequenciaAsync(PdvDbContext db, long minimo, DateTimeOffset agora, CancellationToken ct)
    {
        var sequencia = await db.SequenciasLocais.FirstOrDefaultAsync(s => s.Chave == SequenciaLocal.Evento, ct);
        if (sequencia is null)
        {
            sequencia = new SequenciaLocal { Chave = SequenciaLocal.Evento };
            db.SequenciasLocais.Add(sequencia);
        }

        if (sequencia.UltimoValor < minimo)
        {
            sequencia.UltimoValor = minimo;
            sequencia.AtualizadoEm = agora;
        }
    }

    /// <summary>Passo 2: uma página, numa transação; devolve quantos foram gravados e quantos já existiam.</summary>
    private async Task<(int Gravados, int JaExistiam)> AplicarPaginaAsync(IReadOnlyList<EventoRecuperado> eventos, long ultimaRecebida, CancellationToken ct)
    {
        int gravados = 0, existiam = 0;
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var agora = relogio.Agora;
        foreach (var ev in eventos)
        {
            var env = ev.Envelope;
            if (await db.EventosSaida.FirstOrDefaultAsync(e => e.Id == env.EventoId, ct) is { } existente)
            {
                // O mesmo evento: deslocado no passo 1 (enviado, mas a resposta se perdeu) volta para a sequência da nuvem.
                if (existente.SequenciaTerminal < 0)
                {
                    existente.SequenciaTerminal = env.Sequencia;
                }

                AplicarSituacao(existente, ev, agora);
                existiam++;
            }
            else if (ev.TemPayload)
            {
                if (await db.EventosSaida.AnyAsync(e => e.SequenciaTerminal == env.Sequencia, ct))
                {
                    // Outro evento já confirmado nesta sequência: o banco não é deste terminal ou foi mexido à mão.
                    throw new InvalidOperationException(
                        string.Create(CultureInfo.InvariantCulture, $"Sequência {env.Sequencia} já ocupada no banco local por outro evento."));
                }

                var payload = JsonNode.Parse(env.Payload.GetRawText())!.AsObject();
                await RecriarAsync(db, env, payload, agora, ct);
                db.EventosSaida.Add(NovoEvento(ev, agora));
                gravados++;
            }
            else if (!ev.Lacuna)
            {
                log.LogWarning("Reidratação: evento {Evento} (sequência {Sequencia}, {Tipo}) sem payload na nuvem; só a sequência é ocupada",
                    env.EventoId, env.Sequencia, env.Tipo);
            }

            await db.SaveChangesAsync(ct);
            db.ChangeTracker.Clear();
        }

        // Interrompida depois desta página, o caixa continua gravando acima do que ela gravou (índice único da sequência).
        var maior = eventos.Count == 0 ? 0 : eventos.Max(e => e.Envelope.Sequencia);
        await SubirSequenciaAsync(db, Math.Max(maior, ultimaRecebida), agora, ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return (gravados, existiam);
    }

    /// <summary>Passo 3: os provisórios (e o que entrou na fila no meio) depois da última sequência da nuvem, em ordem.</summary>
    private async Task<(int Renumerados, long Ultima)> RenumerarAsync(long desde, long ultimaRecebida, CancellationToken ct)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var maiorFixo = await db.EventosSaida.Where(e => e.SequenciaTerminal > 0 && !Enviaveis.Contains(e.Status))
            .MaxAsync(e => (long?)e.SequenciaTerminal, ct) ?? 0;
        var aRenumerar = (await db.EventosSaida
                .Where(e => e.SequenciaTerminal < 0 || (e.SequenciaTerminal > desde && Enviaveis.Contains(e.Status)))
                .ToListAsync(ct))
            .OrderBy(e => Math.Abs(e.SequenciaTerminal)).ToList();
        var base0 = Math.Max(Math.Max(ultimaRecebida, maiorFixo), desde);
        // Primeiro todas para longe (o índice único da sequência não deixa trocar no lugar), depois para o destino.
        for (var i = 0; i < aRenumerar.Count; i++)
        {
            aRenumerar[i].SequenciaTerminal = -(BaseProvisoria + i);
        }

        await db.SaveChangesAsync(ct);
        for (var i = 0; i < aRenumerar.Count; i++)
        {
            aRenumerar[i].SequenciaTerminal = base0 + i + 1;
            Pendente(aRenumerar[i]);
        }

        var ultima = base0 + aRenumerar.Count;
        var sequencia = await db.SequenciasLocais.FirstOrDefaultAsync(s => s.Chave == SequenciaLocal.Evento, ct);
        if (sequencia is null)
        {
            sequencia = new SequenciaLocal { Chave = SequenciaLocal.Evento };
            db.SequenciasLocais.Add(sequencia);
        }

        sequencia.UltimoValor = ultima;
        sequencia.AtualizadoEm = relogio.Agora;
        await db.ConfiguracaoTerminal.Where(c => c.Chave == ChavesConfiguracaoTerminal.ReidratacaoPendente).ExecuteDeleteAsync(ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return (aRenumerar.Count, ultima);
    }

    /// <summary>A situação na nuvem num evento que o caixa já tem (o confirmado fica como está).</summary>
    private static void AplicarSituacao(EventoSaida e, EventoRecuperado ev, DateTimeOffset agora)
    {
        if (e.Status == StatusEventoSaida.Confirmado)
        {
            return;
        }

        if (ev.Status == StatusResultadoEvento.Aplicado)
        {
            e.Status = StatusEventoSaida.Confirmado;
            e.ConfirmadoEm = agora;
            e.VersaoNuvem = ev.VersaoNuvem;
            e.VersaoNuvemFim = ev.VersaoNuvemFim;
            e.Resultado = ev.Resultado?.GetRawText() ?? "{}";
            e.UltimoErro = null;
        }
        else
        {
            e.Status = StatusEventoSaida.Rejeitado;
            e.Resultado = ev.Resultado?.GetRawText();
            e.UltimoErro = ev.Erro is { } erro ? $"{erro.Codigo}: {erro.Mensagem}" : e.UltimoErro;
        }

        e.LoteEnvioId = null;
        e.ProximaTentativaEm = null;
    }

    /// <summary>A linha de <c>eventos_saida</c> do evento que o banco perdeu: o envelope original e a situação na nuvem.</summary>
    private static EventoSaida NovoEvento(EventoRecuperado ev, DateTimeOffset agora)
    {
        var env = ev.Envelope;
        var e = new EventoSaida
        {
            Id = env.EventoId,
            SequenciaTerminal = env.Sequencia,
            Tipo = env.Tipo,
            VersaoSchema = env.VersaoSchema,
            AgregadoTipo = env.AgregadoTipo,
            AgregadoId = env.AgregadoId,
            OcorridoEm = DataHora(env.OcorridoEm),
            CriadoEm = DataHora(env.OcorridoEm),
            Payload = Jcs.Serializar(JsonNode.Parse(env.Payload.GetRawText())),
            PayloadSha256 = env.PayloadSha256,
            Tentativas = 1,
            EnviadoEm = agora,
            OcorridoEmLocal = env.OcorridoEmLocal is { } local ? DataHora(local) : null,
            DesvioRelogioMs = env.DesvioRelogioMs,
            RelogioConfiavel = env.RelogioConfiavel,
            RelogioRegrediu = env.RelogioRegrediu,
            UsuarioId = env.UsuarioId,
            Contexto = JsonSerializer.Serialize(env.Contexto, ContratosJson.Opcoes),
            Dependencias = JsonSerializer.Serialize(env.Dependencias, ContratosJson.Opcoes),
            Status = StatusEventoSaida.Pendente,
        };
        AplicarSituacao(e, ev, agora);
        return e;
    }

    /// <summary>Recria os fatos do payload nas tabelas de movimento (<see cref="Tabelas"/>), na ordem das chaves estrangeiras.</summary>
    private static async Task RecriarAsync(PdvDbContext db, EnvelopeEvento env, JsonObject payload, DateTimeOffset agora, CancellationToken ct)
    {
        var documentoVenda = payload["vendas"] is JsonObject venda && payload["itens_venda"] is JsonArray ? venda : null;
        Guid? vendaId = documentoVenda is not null ? Guid.ParseExact(documentoVenda["id"]!.GetValue<string>(), "D") : null;
        if (vendaId is { } id)
        {
            // Documento completo: as linhas filhas da venda em andamento do backup dão lugar às do documento.
            await db.CobrancasPix.Where(c => c.VendaId == id).ExecuteDeleteAsync(ct);
            await db.ParcelasVenda.Where(p => db.PagamentosVenda.Any(g => g.Id == p.PagamentoVendaId && g.VendaId == id)).ExecuteDeleteAsync(ct);
            await db.PagamentosVenda.Where(p => p.VendaId == id).ExecuteDeleteAsync(ct);
            await db.ItensVenda.Where(i => i.VendaId == id).ExecuteDeleteAsync(ct);
            await db.LiberacoesVenda.Where(l => l.VendaId == id).ExecuteDeleteAsync(ct);
            await db.ProdutosVendaSnapshot.Where(s => s.VendaId == id).ExecuteDeleteAsync(ct);
        }

        foreach (var tabela in Tabelas)
        {
            switch (payload[tabela])
            {
                case JsonObject linha:
                    await UpsertAsync(db, tabela, linha, agora, ct);
                    break;
                case JsonArray linhas:
                    foreach (var l in linhas.OfType<JsonObject>())
                    {
                        await UpsertAsync(db, tabela, l, agora, ct);
                    }

                    break;
            }

            // A linha pai vai para o banco antes das filhas (as chaves estrangeiras são conferidas a cada comando).
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException e)
            {
                throw new InvalidOperationException($"Reidratação do evento {env.EventoId} ({env.Tipo}, sequência {env.Sequencia}): falha ao gravar {tabela}.", e);
            }
        }

        if (vendaId is not { } vid)
        {
            return;
        }

        var registro = await db.Vendas.FirstAsync(v => v.Id == vid, ct);
        registro.RelogioConfiavel = env.RelogioConfiavel ?? true;
        var ordem = 0;
        foreach (var l in (payload["liberacoes"] as JsonArray ?? []).OfType<JsonObject>())
        {
            db.LiberacoesVenda.Add(new LiberacaoVendaLocal
            {
                Id = IdGerador.Novo(),
                VendaId = vid,
                Acao = l["acao"]!.GetValue<string>(),
                ItemVendaId = l["item_venda_id"] is JsonValue item ? Guid.ParseExact(item.GetValue<string>(), "D") : null,
                ValorPct = l["valor_pct"] is JsonValue pct ? decimal.Parse(pct.GetValue<string>(), CultureInfo.InvariantCulture) : null,
                AutorizadoPorId = Guid.ParseExact(l["autorizado_por_id"]!.GetValue<string>(), "D"),
                Motivo = l["motivo"]?.GetValue<string>() ?? string.Empty,
                OcorridoEm = l["ocorrido_em"] is JsonValue quando ? DataHora(quando.GetValue<string>()) : agora.AddTicks(ordem),
            });
            ordem++;
        }

        // A venda em andamento do backup que a nuvem já tem encerrada não volta para a tela (PDV 32.3).
        if (await db.EstadoOperacao.FirstOrDefaultAsync(ct) is { } estado && estado.VendaAtualId == vid
            && registro.Status is not ("em_andamento" or "em_pagamento"))
        {
            estado.VendaAtualId = null;
            estado.AtualizadoEm = agora;
        }

        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Cria ou atualiza a linha pelo <c>id</c>, coluna a coluna (o nome da chave do payload é o nome da coluna, 9.1). A
    /// linha nova só é criada com todas as colunas UUID obrigatórias (loja, caixa, sessão, venda…) no payload; sem elas é
    /// o payload parcial de um evento cuja linha o caixa não tem (nada a fazer).
    /// </summary>
    private static async Task UpsertAsync(PdvDbContext db, string tabela, JsonObject linha, DateTimeOffset agora, CancellationToken ct)
    {
        var tipo = db.Model.GetEntityTypes().Single(t => t.GetTableName() == tabela);
        var id = Guid.ParseExact(linha["id"]!.GetValue<string>(), "D");
        var entidade = await db.FindAsync(tipo.ClrType, [id], ct);
        if (entidade is null)
        {
            var obrigatorias = tipo.GetProperties().Where(p => p.ClrType == typeof(Guid) && !p.IsPrimaryKey());
            if (obrigatorias.Any(p => linha[p.GetColumnName()] is null))
            {
                return;
            }

            entidade = Activator.CreateInstance(tipo.ClrType)!;
            if (entidade is LinhaMovimento nova)
            {
                nova.Id = id;
                nova.CriadoEm = agora;
            }

            Preencher(tipo, entidade, linha);
            db.Add(entidade);
        }
        else
        {
            Preencher(tipo, entidade, linha);
        }

        if (entidade is LinhaMovimento m)
        {
            m.AtualizadoEm = agora;
        }
    }

    private static void Preencher(IEntityType tipo, object entidade, JsonObject linha)
    {
        foreach (var (coluna, valor) in linha)
        {
            var p = tipo.GetProperties().FirstOrDefault(x => x.GetColumnName() == coluna);
            if (p?.PropertyInfo is null || p.GetComputedColumnSql() is not null || p.IsPrimaryKey())
            {
                continue;
            }

            var convertido = Converter(valor, p.ClrType);
            if (convertido is null && !p.IsNullable)
            {
                continue;
            }

            p.PropertyInfo.SetValue(entidade, convertido);
        }
    }

    /// <summary>Valor JSON do payload (datas ISO, decimais em texto, UUID canônico) no tipo da propriedade.</summary>
    internal static object? Converter(JsonNode? valor, Type tipo)
    {
        if (valor is null)
        {
            return null;
        }

        var alvo = Nullable.GetUnderlyingType(tipo) ?? tipo;
        if (alvo == typeof(string))
        {
            return valor is JsonValue v && v.TryGetValue<string>(out var s) ? s : valor.ToJsonString();
        }

        var texto = valor is JsonValue jv && jv.TryGetValue<string>(out var t) ? t : null;
        return alvo switch
        {
            _ when alvo == typeof(Guid) => Guid.ParseExact(texto!, "D"),
            _ when alvo == typeof(decimal) => texto is not null ? decimal.Parse(texto, CultureInfo.InvariantCulture) : valor.GetValue<decimal>(),
            _ when alvo == typeof(DateTimeOffset) => DataHora(texto!),
            _ when alvo == typeof(DateOnly) => DateOnly.ParseExact(texto!, "yyyy-MM-dd", CultureInfo.InvariantCulture),
            _ when alvo == typeof(bool) => valor.GetValue<bool>(),
            _ when alvo == typeof(short) => (short)valor.GetValue<long>(),
            _ when alvo == typeof(int) => (int)valor.GetValue<long>(),
            _ when alvo == typeof(long) => valor.GetValue<long>(),
            _ => throw new NotSupportedException($"Reidratação: coluna do tipo {alvo.Name} sem conversão."),
        };
    }

    private static DateTimeOffset DataHora(string texto) =>
        DateTimeOffset.Parse(texto, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);

    private static void Pendente(EventoSaida e)
    {
        e.Status = StatusEventoSaida.Pendente;
        e.LoteEnvioId = null;
        e.EnviadoEm = null;
        e.ProximaTentativaEm = null;
        e.Tentativas = 0;
    }
}
