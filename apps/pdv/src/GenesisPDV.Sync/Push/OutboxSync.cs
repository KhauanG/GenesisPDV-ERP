using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Outbox;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Sync.Protocolo;
using GenesisPDV.Sync.Relogio;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using F = GenesisPDV.Sync.Protocolo.FormatoProtocolo;

namespace GenesisPDV.Sync.Push;

/// <summary>
/// Catálogos da nuvem que o <c>auditoria.registros</c> precisa respeitar: <c>ACOES_AUDITORIA</c> e
/// <c>MOTIVOS_FALHA_LOGIN</c> de <c>packages/shared/src/enums.ts</c> (o <c>CicloOnlineTests.Catalogos_do_pdv_sao_os_da_nuvem</c> lê
/// o arquivo e confere as duas listas). Ação fora do catálogo derrubaria o evento inteiro na API (<c>PAYLOAD_INVALIDO</c>).
/// </summary>
public static class CatalogosNuvem
{
    public static IReadOnlyList<string> AcoesAuditoria { get; } =
    [
        "criar", "editar", "excluir", "restaurar", "cancelar", "estornar", "importar", "exportar", "login", "login_negado",
        "logout", "liberacao", "permissoes_alteradas", "terminal_ativado", "gaveta_aberta", "efetivar", "movimentar",
        "converter", "conferir", "senha_alterada", "senha_redefinida", "bloqueio", "download_xml", "terminal_revogado",
        "evento_descartado", "evento_reprocessado", "lacuna_substituida", "relogio_regrediu", "acesso_suporte", "segredo_entregue",
        "token_anterior_reutilizado", "hardware_alterado", "idade_confirmada", "idade_recusada", "horario_restrito_liberado", "hash_fora_dos_limites",
        "sangria_recusada", "pix_confirmado_manual", "reimpressao", "pix_recebedor_alterado", "recalcular_saldos",
    ];

    public static IReadOnlyList<string> MotivosFalhaLogin { get; } =
    [
        "senha_invalida", "usuario_inativo", "demitido", "loja_nao_permitida", "bloqueado", "empresa_suspensa",
        "sem_acesso_pdv", "totem", "hash_fora_dos_limites",
    ];
}

/// <summary>
/// Outbox do lado do sync (SYNC 7.1, 7.3, 9.22): gera os lotes <c>auditoria.registros</c> a partir do
/// <c>log_auditoria_local</c> e monta o envelope de cada evento para o push.
/// <list type="bullet">
/// <item>Lote a cada 5 min ou 200 registros (18.2), ou já, quando forçado (desativação: tudo precisa subir antes da
/// confirmação). Só sobem as ações do catálogo da nuvem; as do caixa que não estão nele (desconto, item cancelado,
/// venda recuperada…) ficam locais: são detalhes da venda e sobem com os eventos dela na Fase 1C.</item>
/// <item><c>login</c>/<c>login_negado</c> também viram <c>logins</c> (<c>historico_logins</c>): <c>login_informado</c> vem
/// do <c>depois</c> gravado pelo login e o motivo só sai se estiver no catálogo da nuvem.</item>
/// <item>O evento (pelo <see cref="GravadorOutbox"/>, como os da venda e do caixa), a sequência <c>evento</c> e o
/// <c>log_auditoria_local.evento_id</c> dos registros vão num commit só: o mesmo registro nunca entra em dois lotes.</item>
/// </list>
/// </summary>
public sealed partial class OutboxSync(IDbContextFactory<PdvDbContext> fabrica, RelogioSync relogio, string versaoApp, ILogger<OutboxSync> log)
{
    private readonly GravadorOutbox _gravador = new(relogio, versaoApp);

    public const int RegistrosPorLote = 200;
    public const string TipoAuditoria = "auditoria.registros";
    public static readonly TimeSpan EsperaAuditoria = TimeSpan.FromMinutes(5);

    private static readonly string[] Acoes = [.. CatalogosNuvem.AcoesAuditoria];
    private static readonly HashSet<string> Motivos = new(CatalogosNuvem.MotivosFalhaLogin, StringComparer.Ordinal);

    /// <summary>Registros do catálogo ainda sem lote.</summary>
    public async Task<int> AuditoriaPendenteAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.LogAuditoriaLocal.CountAsync(l => l.EventoId == null && Acoes.Contains(l.Acao), ct);
    }

    /// <summary>
    /// Gera um lote <c>auditoria.registros</c> quando há 200 registros ou o mais antigo passou de 5 min (ou sempre, com
    /// <paramref name="forcar"/>). Devolve se gerou. Com o terminal revogado, nada é gerado.
    /// </summary>
    public async Task<bool> GerarAuditoriaAsync(bool forcar = false, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var identidade = await db.IdentidadeTerminal.AsNoTracking().FirstOrDefaultAsync(ct);
        if (identidade is null || identidade.Demonstracao || identidade.Status == StatusIdentidade.Revogado)
        {
            return false;
        }

        var linhas = await db.LogAuditoriaLocal
            .Where(l => l.EventoId == null && Acoes.Contains(l.Acao))
            .OrderBy(l => l.OcorridoEm)
            .Take(RegistrosPorLote)
            .ToListAsync(ct);
        if (linhas.Count == 0
            || (!forcar && linhas.Count < RegistrosPorLote && relogio.AgoraLocal - linhas[0].OcorridoEm < EsperaAuditoria))
        {
            return false;
        }

        var payload = Payload(linhas);
        var jcs = Jcs.Serializar(payload);
        var eventoId = IdGerador.Novo();
        // Agregado = o lote de auditoria (9.22): id próprio, como na fixture do contrato. A hora é a corrigida de agora.
        var gravado = await _gravador.GravarAsync(
            db, new EventoParaOutbox(eventoId, TipoAuditoria, 1, "auditoria", IdGerador.Novo(), relogio.Agora, jcs, Jcs.Sha256Hex(jcs)), ct);
        if (gravado.Hora.Regrediu)
        {
            log.LogWarning("Relógio regrediu: o último evento está mais de 2 min à frente da hora corrigida (SYNC 12.3)");
        }

        foreach (var linha in linhas)
        {
            linha.EventoId = eventoId;
        }

        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        log.LogInformation("Lote de auditoria {Evento} gerado: {Registros} registros (sequência {Sequencia})", eventoId, linhas.Count, gravado.Sequencia);
        return true;
    }

    /// <summary>Envelope do evento (7.3) a partir da linha do outbox; sem contexto gravado, o da identidade.</summary>
    public static EnvelopeEvento Envelope(EventoSaida e, IdentidadeTerminal identidade, string versaoApp)
    {
        ArgumentNullException.ThrowIfNull(e);
        ArgumentNullException.ThrowIfNull(identidade);
        var contexto = e.Contexto is { } c
            ? JsonSerializer.Deserialize<ContextoEvento>(c, ContratosJson.Opcoes)!
            : new ContextoEvento(identidade.LojaId, identidade.CaixaId, identidade.NumeroCaixa, null, null, versaoApp, identidade.VersaoSchemaLocal);
        using var payload = JsonDocument.Parse(e.Payload);
        return new EnvelopeEvento(
            e.Id,
            identidade.TerminalId,
            e.SequenciaTerminal,
            e.Tipo,
            e.VersaoSchema,
            e.AgregadoTipo,
            e.AgregadoId,
            Dependencias(e.Dependencias),
            F.DataHora(e.OcorridoEm),
            e.OcorridoEmLocal is { } local ? F.DataHora(local) : null,
            e.DesvioRelogioMs,
            e.RelogioConfiavel,
            e.RelogioRegrediu == true ? true : null,
            e.UsuarioId,
            contexto,
            payload.RootElement.Clone(),
            e.PayloadSha256);
    }

    /// <summary><c>dependencias</c> gravadas pelo <see cref="GravadorOutbox"/> (<c>[]</c> nos eventos anteriores à coluna).</summary>
    private static IReadOnlyList<DependenciaEvento> Dependencias(string? json) =>
        string.IsNullOrWhiteSpace(json) ? [] : JsonSerializer.Deserialize<List<DependenciaEvento>>(json, ContratosJson.Opcoes) ?? [];

    /// <summary>Payload v1 (9.22): <c>registros</c> com tudo e <c>logins</c> com as tentativas de login.</summary>
    internal static JsonObject Payload(IReadOnlyList<LogAuditoriaLocal> linhas)
    {
        var registros = new JsonArray();
        var logins = new JsonArray();
        foreach (var l in linhas)
        {
            var registro = new JsonObject
            {
                ["id"] = F.Uuid(l.Id),
                ["ocorrido_em"] = F.DataHora(l.OcorridoEm),
                ["usuario_id"] = F.Uuid(l.UsuarioId),
                ["acao"] = l.Acao,
                // O login grava sem entidade; a nuvem exige uma (é o "PDV" da fixture do contrato).
                ["entidade"] = Cortar(string.IsNullOrWhiteSpace(l.Entidade) ? "pdv" : l.Entidade, 60),
            };
            Opcional(registro, "autorizado_por_id", F.Uuid(l.AutorizadoPorId));
            Opcional(registro, "registro_id", F.Uuid(l.RegistroId));
            Opcional(registro, "localizacao", l.Localizacao is { } loc ? Cortar(loc, 60) : null);
            Opcional(registro, "descricao", l.Descricao is { } d ? Cortar(d, 2000) : null);
            Opcional(registro, "antes", Json(l.Antes));
            Opcional(registro, "depois", Depois(l));
            Opcional(registro, "sessao_caixa_id", F.Uuid(l.SessaoCaixaId));
            registros.Add(registro);
            if (l.Acao is "login" or "login_negado")
            {
                logins.Add(new JsonObject
                {
                    ["id"] = F.Uuid(l.Id),
                    ["ocorrido_em"] = F.DataHora(l.OcorridoEm),
                    ["usuario_id"] = F.Uuid(l.UsuarioId),
                    ["login_informado"] = LoginInformado(l),
                    ["sucesso"] = l.Acao == "login",
                    ["motivo_falha"] = l.Acao == "login_negado" && l.Motivo is { } m && Motivos.Contains(m) ? m : null,
                });
            }
        }

        return new JsonObject { ["registros"] = registros, ["logins"] = logins };
    }

    /// <summary>
    /// <c>depois</c> do registro. Na <c>liberacao</c> o motivo obrigatório (PDV 31.3) vai em <c>depois.motivo</c>, junto
    /// do que já houver, como na fixture da SYNC 9.22: a nuvem não tem coluna de motivo na auditoria.
    /// </summary>
    private static JsonNode? Depois(LogAuditoriaLocal l)
    {
        var depois = Json(l.Depois);
        if (l.Acao != "liberacao" || string.IsNullOrWhiteSpace(l.Motivo))
        {
            return depois;
        }

        var objeto = depois as JsonObject ?? (depois is null ? new JsonObject() : new JsonObject { ["valor"] = depois });
        objeto["motivo"] = Cortar(l.Motivo.Trim(), 255);
        return objeto;
    }

    /// <summary><c>login_informado</c> do <c>depois</c> do login; registro antigo (sem ele), o texto entre aspas da descrição.</summary>
    private static string LoginInformado(LogAuditoriaLocal l)
    {
        string? informado = null;
        if (Json(l.Depois) is JsonObject depois && depois["login_informado"] is JsonValue v && v.TryGetValue<string>(out var s))
        {
            informado = s;
        }
        else if (l.Descricao is { } d && EntreAspas().Match(d) is { Success: true } m)
        {
            informado = m.Groups[1].Value;
        }

        informado = informado?.Trim();
        return string.IsNullOrEmpty(informado) ? "(vazio)" : Cortar(informado, 60);
    }

    private static JsonNode? Json(string? texto)
    {
        if (string.IsNullOrWhiteSpace(texto))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(texto);
        }
        catch (JsonException)
        {
            return JsonValue.Create(texto);
        }
    }

    private static void Opcional(JsonObject alvo, string chave, JsonNode? valor)
    {
        if (valor is not null)
        {
            alvo[chave] = valor;
        }
    }

    private static void Opcional(JsonObject alvo, string chave, string? valor)
    {
        if (valor is not null)
        {
            alvo[chave] = valor;
        }
    }

    private static string Cortar(string texto, int maximo) => texto.Length <= maximo ? texto : texto[..maximo];

    [GeneratedRegex("'(.+)'")]
    private static partial Regex EntreAspas();
}
