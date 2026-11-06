using System.Text.Json;
using System.Text.Json.Nodes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Convencoes;
using GenesisPDV.Data.Entidades;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Outbox;

/// <summary>Hora de um fato para o envelope do evento (SYNC 7.3, 12.3).</summary>
/// <param name="OcorridoEm">Hora corrigida (com a monotonicidade da 12.3).</param>
/// <param name="OcorridoEmLocal">Hora do SO, sem correção.</param>
/// <param name="DesvioMs">Desvio aplicado; nulo sem amostra.</param>
/// <param name="Regrediu">O último evento estava mais de 2 min à frente da hora corrigida (12.3).</param>
public sealed record HoraDoFato(DateTimeOffset OcorridoEm, DateTimeOffset OcorridoEmLocal, long? DesvioMs, bool Confiavel, bool Regrediu)
{
    public static readonly TimeSpan LimiteMonotonicidade = TimeSpan.FromMinutes(2);

    /// <summary>
    /// 12.3: <c>max(corrigida, último + 1 ms)</c> quando o último evento está até 2 min à frente; além disso, a hora
    /// corrigida pura com <see cref="Regrediu"/>. <paramref name="fato"/> é a hora do fato já corrigida (a do payload);
    /// sem ela, <c>agora_local + desvio</c>.
    /// </summary>
    public static HoraDoFato Calcular(DateTimeOffset agoraLocal, long? desvioMs, bool confiavel, DateTimeOffset? ultimoOcorridoEm, DateTimeOffset? fato = null)
    {
        var corrigida = fato ?? agoraLocal.AddMilliseconds(desvioMs ?? 0);
        if (ultimoOcorridoEm is { } ultimo)
        {
            if (ultimo > corrigida + LimiteMonotonicidade)
            {
                return new HoraDoFato(corrigida, agoraLocal, desvioMs, confiavel, Regrediu: true);
            }

            if (ultimo >= corrigida)
            {
                corrigida = ultimo.AddMilliseconds(1);
            }
        }

        return new HoraDoFato(corrigida, agoraLocal, desvioMs, confiavel, Regrediu: false);
    }
}

/// <summary>Relógio do envelope: o <c>RelogioSync</c> (desvio medido nas respostas da API, SYNC 12.2).</summary>
public interface IRelogioOutbox
{
    /// <param name="ultimoOcorridoEm"><c>ocorrido_em</c> do evento anterior deste terminal.</param>
    /// <param name="fato">Hora do fato já corrigida (a do payload); nula = agora corrigido.</param>
    HoraDoFato HoraDoFato(DateTimeOffset? ultimoOcorridoEm, DateTimeOffset? fato = null);
}

/// <summary>
/// Relógio do envelope sem o ciclo online (testes do Data e o repositório criado sem o gravador da composição): a hora do
/// SO, sem desvio, considerada confiável (a demonstração não sobe nada).
/// </summary>
public sealed class RelogioOutboxLocal(IRelogio relogio) : IRelogioOutbox
{
    public HoraDoFato HoraDoFato(DateTimeOffset? ultimoOcorridoEm, DateTimeOffset? fato = null) =>
        Outbox.HoraDoFato.Calcular(relogio.Agora, null, confiavel: true, ultimoOcorridoEm, fato);
}

/// <summary>Resultado da gravação: a sequência do evento e a hora usada no envelope.</summary>
public sealed record EventoGravado(long Sequencia, HoraDoFato Hora);

/// <summary>
/// Gravador único do outbox (Fase 1C, bloco C9; SYNC 7.1, 7.3, 8.5, 12.3, 17.5): venda, caixa, vasilhame e o lote de
/// auditoria entram em <c>eventos_saida</c> por aqui, dentro da transação do fato.
/// <list type="bullet">
/// <item>Sequência <c>evento</c> + 1 na mesma transação; hora do envelope pelo relógio corrigido, monotônica com o limite
/// de 2 min (<c>relogio_regrediu</c> quando não aplicada, com a auditoria local <c>relogio_regrediu</c> no mesmo commit,
/// C16), com <c>ocorrido_em_local</c>, desvio e <c>relogio_confiavel</c>;</item>
/// <item><c>usuario_id</c>, <c>dependencias</c> e o <c>contexto</c> do momento do fato: loja, caixa e número da
/// identidade, <c>estoque_id</c> vigente no espelho <c>lojas</c>, sessão de caixa e versões;</item>
/// <item>T13: o tipo e a versão têm de estar no <c>versoes_schema</c> do último handshake
/// (<see cref="EstadoConexao.VersoesSchemaNuvem"/>), salvo os tipos da 1B (<see cref="TiposSempreAceitos"/>) e o
/// terminal de demonstração. Tipo que a API não conhece voltaria <c>SCHEMA_DESCONHECIDO</c>, que é transitório e para o
/// lote inteiro (D18): recusado aqui, o fato não é gravado e a tela avisa. Sem nenhum handshake desde a migração
/// <c>TabelasCaixa</c> (coluna nula: terminal da 1B atualizado que abriu sem internet), o tipo vale como aceito: a
/// implantação é sempre API primeiro, e o caixa nunca trava por falta de internet (O18).</item>
/// </list>
/// A trava da D22 não passa por aqui: é do banco (<see cref="TravaDesativacao"/>), e vale para qualquer gravação.
/// </summary>
public sealed class GravadorOutbox(IRelogioOutbox relogio, string? versaoApp = null)
{
    /// <summary>Tipos que toda API desde a 1B aplica: não dependem do anúncio (o lote de auditoria nunca trava).</summary>
    public static readonly IReadOnlySet<string> TiposSempreAceitos =
        new HashSet<string>(StringComparer.Ordinal) { "auditoria.registros", "terminal.configuracao_alterada" };

    /// <summary>Ação da auditoria local da regressão do relógio (SYNC 12.3; T9 da 1C): no catálogo da nuvem, sobe no lote.</summary>
    public const string AcaoRelogioRegrediu = "relogio_regrediu";

    public static string MensagemTipoNaoAnunciado(string tipo, int versao) =>
        $"A nuvem ainda não aceita esta operação do caixa ({tipo} v{versao}): a API precisa ser atualizada antes. " +
        "Nada foi gravado; chame o suporte.";

    /// <summary>Grava o evento no contexto (sem salvar): o chamador salva e comita junto com o fato.</summary>
    public async Task<EventoGravado> GravarAsync(PdvDbContext db, EventoParaOutbox evento, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(evento);
        var identidade = await db.IdentidadeTerminal.AsNoTracking().FirstOrDefaultAsync(ct);
        if (identidade is { Demonstracao: false } && !await TipoAceitoAsync(db, evento.Tipo, evento.VersaoSchema, ct))
        {
            throw new RegraNegocioException(MensagemTipoNaoAnunciado(evento.Tipo, evento.VersaoSchema));
        }

        var gravado = await db.EventosSaida.AsNoTracking()
            .OrderByDescending(e => e.SequenciaTerminal).Select(e => (DateTimeOffset?)e.OcorridoEm).FirstOrDefaultAsync(ct);
        // Outro evento já adicionado nesta mesma transação também conta para a monotonicidade.
        var naTransacao = db.EventosSaida.Local.Select(e => (DateTimeOffset?)e.OcorridoEm).Max();
        var ultimo = naTransacao > gravado || gravado is null ? naTransacao : gravado;
        var hora = relogio.HoraDoFato(ultimo, evento.OcorridoEm);

        var sequencia = await db.SequenciasLocais.FirstOrDefaultAsync(s => s.Chave == SequenciaLocal.Evento, ct);
        if (sequencia is null)
        {
            sequencia = new SequenciaLocal { Chave = SequenciaLocal.Evento };
            db.SequenciasLocais.Add(sequencia);
        }

        sequencia.UltimoValor++;
        sequencia.AtualizadoEm = hora.OcorridoEmLocal;
        db.EventosSaida.Add(new EventoSaida
        {
            Id = evento.Id,
            SequenciaTerminal = sequencia.UltimoValor,
            Tipo = evento.Tipo,
            VersaoSchema = evento.VersaoSchema,
            AgregadoTipo = evento.AgregadoTipo,
            AgregadoId = evento.AgregadoId,
            OcorridoEm = hora.OcorridoEm,
            OcorridoEmLocal = hora.OcorridoEmLocal,
            DesvioRelogioMs = hora.DesvioMs,
            RelogioConfiavel = hora.Confiavel,
            RelogioRegrediu = hora.Regrediu ? true : null,
            UsuarioId = evento.UsuarioId,
            Contexto = identidade is null ? null : await ContextoAsync(db, identidade, evento.SessaoCaixaId, ct),
            Dependencias = Dependencias(evento.Dependencias),
            CriadoEm = hora.OcorridoEmLocal,
            Payload = evento.Payload,
            PayloadSha256 = evento.PayloadSha256,
            Status = StatusEventoSaida.Pendente,
        });
        if (hora.Regrediu)
        {
            db.LogAuditoriaLocal.Add(AuditoriaRegressao(evento, sequencia.UltimoValor, hora, ultimo!.Value));
        }

        return new EventoGravado(sequencia.UltimoValor, hora);
    }

    /// <summary>
    /// SYNC 12.3 (C16): auditoria local <c>relogio_regrediu</c>, uma por regressão — só o evento que deixou de seguir o
    /// anterior adiantado é marcado; o seguinte já compara com ele. Vai no commit do fato e sobe no próximo lote
    /// <c>auditoria.registros</c> (a ação está no catálogo da nuvem), com as horas em <c>depois</c>. A nuvem, ao receber o
    /// evento marcado, abre o <c>RELOGIO_SUSPEITO</c> informativo (12.4).
    /// </summary>
    private static LogAuditoriaLocal AuditoriaRegressao(EventoParaOutbox evento, long sequencia, HoraDoFato hora, DateTimeOffset ultimo)
    {
        var recuo = ultimo - hora.OcorridoEm;
        var depois = new JsonObject
        {
            ["evento_id"] = evento.Id.ToString("D"),
            ["sequencia"] = sequencia,
            ["tipo"] = evento.Tipo,
            ["ocorrido_em"] = DataHoraUtcTexto.Formatar(hora.OcorridoEm),
            ["ultimo_ocorrido_em"] = DataHoraUtcTexto.Formatar(ultimo),
            ["ocorrido_em_local"] = DataHoraUtcTexto.Formatar(hora.OcorridoEmLocal),
            ["desvio_relogio_ms"] = hora.DesvioMs,
            ["recuo_ms"] = (long)recuo.TotalMilliseconds,
        };
        return new LogAuditoriaLocal
        {
            Id = IdGerador.Novo(),
            OcorridoEm = hora.OcorridoEm,
            UsuarioId = evento.UsuarioId,
            SessaoCaixaId = evento.SessaoCaixaId,
            Acao = AcaoRelogioRegrediu,
            Entidade = "eventos_saida",
            RegistroId = evento.Id,
            Localizacao = "pdv.relogio",
            Descricao = $"Relógio regrediu: o evento anterior estava {DuracaoLegivel(recuo)} à frente da hora corrigida; " +
                        $"o evento nº {sequencia} ({evento.Tipo}) sai com a hora corrigida, sem a monotonicidade",
            Depois = depois.ToJsonString(),
        };
    }

    /// <summary>
    /// "45 s", "7 min", "3 h 12 min", "12 dias": a diferença de hora sem o sinal, com as mesmas faixas do
    /// <c>duracaoLegivel</c> do <c>@genesis/shared</c> (os alertas de relógio da nuvem e a coluna "Relógio" do ERP), para a
    /// auditoria do caixa e o alerta da nuvem dizerem o mesmo; a partir de 48 h, em dias inteiros.
    /// </summary>
    public static string DuracaoLegivel(TimeSpan diferenca)
    {
        var s = (long)Math.Round(Math.Abs(diferenca.TotalMilliseconds) / 1000, MidpointRounding.AwayFromZero);
        if (s < 60)
        {
            return $"{s} s";
        }

        var min = s / 60;
        if (min < 60)
        {
            return $"{min} min";
        }

        var h = min / 60;
        if (h < 48)
        {
            return min % 60 != 0 ? $"{h} h {min % 60} min" : $"{h} h";
        }

        return $"{h / 24} dias";
    }

    /// <summary>
    /// T13: o tipo e a versão estão no <c>versoes_schema</c> do último handshake (ou são da 1B). A tela pergunta antes de
    /// começar a função (abrir o caixa, finalizar), para não deixar o operador montar o que não vai poder gravar.
    /// </summary>
    public static async Task<bool> TipoAceitoAsync(PdvDbContext db, string tipo, int versao, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        if (TiposSempreAceitos.Contains(tipo))
        {
            return true;
        }

        var versoes = await db.EstadoConexao.AsNoTracking().Select(c => c.VersoesSchemaNuvem).FirstOrDefaultAsync(ct);
        return TipoAnunciado(versoes, tipo, versao);
    }

    /// <summary>
    /// O JSON <c>{"tipo": [1, 2]}</c> gravado do handshake traz <paramref name="tipo"/> na <paramref name="versao"/>.
    /// Nulo = nenhum handshake desde a migração <c>TabelasCaixa</c>: aceito (padrão até a confirmação do dono, README ›
    /// decisão 51). A API já foi atualizada quando o PDV da 1C chega; se não foi, o evento fica pendente com
    /// <c>SCHEMA_DESCONHECIDO</c> (transitório) até ela aplicar o tipo, e o próximo handshake passa a valer.
    /// </summary>
    public static bool TipoAnunciado(string? versoesSchema, string tipo, int versao)
    {
        if (TiposSempreAceitos.Contains(tipo) || string.IsNullOrWhiteSpace(versoesSchema))
        {
            return true;
        }

        try
        {
            return JsonNode.Parse(versoesSchema) is JsonObject anunciados
                   && anunciados[tipo] is JsonArray aceitas
                   && aceitas.Any(v => v is JsonValue n && n.TryGetValue<int>(out var aceita) && aceita == versao);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>Contexto do envelope (7.3) no momento do fato, nos nomes do <c>ContextoEvento</c> do protocolo.</summary>
    public async Task<string> ContextoAsync(PdvDbContext db, IdentidadeTerminal identidade, Guid? sessaoCaixaId, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(identidade);
        var estoque = await db.Lojas.AsNoTracking()
            .Where(l => l.Id == identidade.LojaId && l.ExcluidoEm == null).Select(l => (Guid?)l.EstoqueId).FirstOrDefaultAsync(ct);
        var contexto = new JsonObject
        {
            ["loja_id"] = identidade.LojaId.ToString("D"),
            ["caixa_id"] = identidade.CaixaId.ToString("D"),
            ["numero_caixa"] = identidade.NumeroCaixa,
        };
        Opcional(contexto, "estoque_id", estoque?.ToString("D"));
        Opcional(contexto, "sessao_caixa_id", sessaoCaixaId?.ToString("D"));
        Opcional(contexto, "versao_app", versaoApp);
        contexto["versao_schema_local"] = identidade.VersaoSchemaLocal;
        return contexto.ToJsonString();
    }

    private static string Dependencias(IReadOnlyList<DependenciaOutbox> dependencias)
    {
        var lista = new JsonArray();
        foreach (var d in dependencias.DistinctBy(d => (d.AgregadoTipo, d.AgregadoId)))
        {
            lista.Add(new JsonObject { ["agregado_tipo"] = d.AgregadoTipo, ["agregado_id"] = d.AgregadoId.ToString("D") });
        }

        return lista.ToJsonString();
    }

    private static void Opcional(JsonObject alvo, string chave, string? valor)
    {
        if (valor is not null)
        {
            alvo[chave] = valor;
        }
    }
}
