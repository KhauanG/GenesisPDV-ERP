using System.Text.Json;
using System.Text.Json.Nodes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Entidades;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Repositorios;

/// <summary>Identidade, configuração local, estado de conexão/sincronização e logs do terminal.</summary>
public sealed class RepositorioTerminal(IDbContextFactory<PdvDbContext> fabrica, IRelogio relogio)
{
    public async Task<IdentidadeTerminal?> ObterIdentidadeAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.IdentidadeTerminal.AsNoTracking().FirstOrDefaultAsync(ct);
    }

    /// <summary><c>versao_schema_local</c> (SYNC 3.2, 17): quantas migrações locais já foram aplicadas.</summary>
    public async Task<int> VersaoSchemaLocalAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return (await db.Database.GetAppliedMigrationsAsync(ct)).Count();
    }

    /// <summary>Ativação de demonstração (F8): sem nuvem, venda e evento começam em 0 e nada de conexão nem segredos.</summary>
    public Task RegistrarAtivacaoAsync(IdentidadeTerminal identidade, CancellationToken ct = default) =>
        RegistrarDemonstracaoAsync(identidade, null, ct);

    /// <summary>Ativação de demonstração com a auditoria local no mesmo commit.</summary>
    public Task RegistrarAtivacaoAsync(IdentidadeTerminal identidade, LogAuditoriaLocal auditoria, CancellationToken ct = default) =>
        RegistrarDemonstracaoAsync(identidade, auditoria, ct);

    private Task RegistrarDemonstracaoAsync(IdentidadeTerminal identidade, LogAuditoriaLocal? auditoria, CancellationToken ct) =>
        RegistrarAtivacaoAsync(
            new DadosAtivacao(identidade, new Dictionary<string, long> { [SequenciaLocal.Venda] = 0 }, null, new Dictionary<string, string>(), auditoria),
            ct);

    /// <summary>
    /// Grava o estado criado na ativação (sincronizacao.md 3.5) numa única transação: identidade (com o token já
    /// protegido), um cursor 0 por fluxo, as sequências locais (evento = 0; venda, vale e <c>nfce:&lt;serie&gt;:&lt;ambiente&gt;</c>
    /// como a API mandou, já com o salto da 13.3), <c>estado_conexao</c> e as chaves de <c>configuracao_terminal</c>
    /// (segredos protegidos) e a auditoria local da ativação. Falhou qualquer parte, nada fica gravado.
    /// </summary>
    public async Task RegistrarAtivacaoAsync(DadosAtivacao dados, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(dados);
        var identidade = dados.Identidade;
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        if (await db.IdentidadeTerminal.AnyAsync(ct))
        {
            throw new InvalidOperationException("Este terminal já está ativado.");
        }

        identidade.Id = IdentidadeTerminal.IdUnico;
        identidade.VersaoSchemaLocal = (await db.Database.GetAppliedMigrationsAsync(ct)).Count();
        db.IdentidadeTerminal.Add(identidade);
        foreach (var fluxo in EstadoSincronizacao.Fluxos)
        {
            var estado = await db.EstadoSincronizacao.FirstOrDefaultAsync(e => e.Fluxo == fluxo, ct);
            if (estado is null)
            {
                db.EstadoSincronizacao.Add(new EstadoSincronizacao { Fluxo = fluxo });
            }
            else
            {
                estado.Cursor = 0;
                estado.CargaInicialConcluida = false;
            }
        }

        var sequencias = new Dictionary<string, long>(dados.Sequencias) { [SequenciaLocal.Evento] = 0 };
        foreach (var (chave, valor) in sequencias)
        {
            var linha = await db.SequenciasLocais.FirstOrDefaultAsync(s => s.Chave == chave, ct);
            if (linha is null)
            {
                db.SequenciasLocais.Add(new SequenciaLocal { Chave = chave, UltimoValor = valor, AtualizadoEm = relogio.Agora });
            }
            else if (linha.UltimoValor < valor)
            {
                // Sequência nunca volta (MD 4.4.6): um resto de outra ativação só sobe.
                linha.UltimoValor = valor;
                linha.AtualizadoEm = relogio.Agora;
            }
        }

        if (dados.Conexao is { } conexao)
        {
            conexao.Id = 1;
            var atual = await db.EstadoConexao.FirstOrDefaultAsync(ct);
            if (atual is null)
            {
                db.EstadoConexao.Add(conexao);
            }
            else
            {
                db.Entry(atual).CurrentValues.SetValues(conexao);
            }
        }

        foreach (var (chave, valor) in dados.Configuracoes)
        {
            var linha = await db.ConfiguracaoTerminal.FirstOrDefaultAsync(c => c.Chave == chave, ct);
            if (linha is null)
            {
                linha = new ConfiguracaoTerminal { Chave = chave };
                db.ConfiguracaoTerminal.Add(linha);
            }

            linha.Valor = valor;
            linha.AtualizadoEm = relogio.Agora;
        }

        if (dados.Auditoria is { } auditoria)
        {
            db.LogAuditoriaLocal.Add(auditoria);
        }

        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
    }

    /// <summary>
    /// Promove o token pendente da rotação (SYNC 3.7): <c>token_protegido</c> recebe o novo e <c>token.pendente</c> some,
    /// no mesmo commit (nunca existe um estado sem um token válido conhecido).
    /// </summary>
    public async Task PromoverTokenPendenteAsync(byte[] tokenProtegido, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(tokenProtegido);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var identidade = await db.IdentidadeTerminal.FirstOrDefaultAsync(ct)
                         ?? throw new InvalidOperationException("Terminal não ativado.");
        identidade.TokenProtegido = tokenProtegido;
        await db.ConfiguracaoTerminal.Where(c => c.Chave == ChavesConfiguracaoTerminal.TokenPendente).ExecuteDeleteAsync(ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
    }

    /// <summary>
    /// Avança o status local do terminal (SYNC 3.8): <c>ativo → desativando → revogado</c> ou <c>ativo → revogado</c>;
    /// nunca volta. A partir do commit do <c>desativando</c> nenhum número de venda é reservado
    /// (<see cref="RepositorioVendas.ReservarNumeroVendaAsync"/> confere na mesma transação da reserva). O banco local
    /// nunca é apagado. Devolve se o status mudou.
    /// </summary>
    public async Task<bool> AvancarStatusAsync(string novo, CancellationToken ct = default)
    {
        var ordem = Array.IndexOf(StatusIdentidade.Ordem, novo);
        if (ordem < 0)
        {
            throw new ArgumentException($"Status de terminal desconhecido: {novo}.", nameof(novo));
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        var identidade = await db.IdentidadeTerminal.FirstOrDefaultAsync(ct);
        if (identidade is null || Array.IndexOf(StatusIdentidade.Ordem, identidade.Status) >= ordem)
        {
            return false;
        }

        identidade.Status = novo;
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task RemoverConfiguracaoAsync(string chave, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await db.ConfiguracaoTerminal.Where(c => c.Chave == chave).ExecuteDeleteAsync(ct);
    }

    /// <summary>Eventos do outbox ainda não confirmados pela nuvem (contador "⇅ N" da barra de status).</summary>
    public async Task<int> ContarEventosPendentesAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.EventosSaida.CountAsync(e => e.Status != StatusEventoSaida.Confirmado, ct);
    }

    public async Task<EstadoConexao> ObterEstadoConexaoAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.EstadoConexao.AsNoTracking().FirstOrDefaultAsync(ct) ?? new EstadoConexao();
    }

    public async Task<T?> ObterConfiguracaoAsync<T>(string chave, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var linha = await db.ConfiguracaoTerminal.AsNoTracking().FirstOrDefaultAsync(c => c.Chave == chave, ct);
        return linha is null ? default : JsonSerializer.Deserialize<T>(linha.Valor);
    }

    public async Task GravarConfiguracaoAsync<T>(string chave, T valor, Guid? usuarioId = null, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var linha = await db.ConfiguracaoTerminal.FirstOrDefaultAsync(c => c.Chave == chave, ct);
        if (linha is null)
        {
            linha = new ConfiguracaoTerminal { Chave = chave };
            db.ConfiguracaoTerminal.Add(linha);
        }

        linha.Valor = JsonSerializer.Serialize(valor);
        linha.AtualizadoEm = relogio.Agora;
        linha.AtualizadoPorId = usuarioId;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Os valores JSON das <paramref name="chaves"/> que existem (as ausentes ficam de fora).</summary>
    public async Task<IReadOnlyDictionary<string, string>> LerConfiguracoesAsync(IReadOnlyCollection<string> chaves, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.ConfiguracaoTerminal.AsNoTracking()
            .Where(c => chaves.Contains(c.Chave))
            .ToDictionaryAsync(c => c.Chave, c => c.Valor, StringComparer.Ordinal, ct);
    }

    /// <summary>
    /// Grava várias chaves (valores já em JSON) e a auditoria da mudança num commit só (PDV 6: "toda alteração é
    /// auditada"): ou a configuração muda com o registro, ou nada muda.
    /// </summary>
    public async Task GravarConfiguracoesAsync(
        IReadOnlyDictionary<string, string> valores, Guid? usuarioId, LogAuditoriaLocal? auditoria = null, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(valores);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var chaves = valores.Keys.ToList();
        var existentes = await db.ConfiguracaoTerminal.Where(c => chaves.Contains(c.Chave)).ToDictionaryAsync(c => c.Chave, StringComparer.Ordinal, ct);
        foreach (var (chave, valor) in valores)
        {
            if (!existentes.TryGetValue(chave, out var linha))
            {
                linha = new ConfiguracaoTerminal { Chave = chave };
                db.ConfiguracaoTerminal.Add(linha);
            }

            linha.Valor = valor;
            linha.AtualizadoEm = relogio.Agora;
            linha.AtualizadoPorId = usuarioId;
        }

        if (auditoria is not null)
        {
            auditoria.Id = auditoria.Id == Guid.Empty ? IdGerador.Novo() : auditoria.Id;
            auditoria.OcorridoEm = relogio.Agora;
            db.LogAuditoriaLocal.Add(auditoria);
        }

        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Uma ocorrência no <c>log_local</c> (Central do PDV, bloco G8): o código (e a origem dele), a mensagem e, no
    /// <c>detalhes</c> em JSON, os <paramref name="dados"/> que ligam a ocorrência e o <paramref name="texto"/> técnico
    /// (<see cref="Ocorrencias.Nova"/>). Não sobe para a nuvem nem passa pela trava da D22.
    /// </summary>
    public async Task RegistrarOcorrenciaAsync(
        string nivel, CodigoOcorrencia codigo, string mensagem, string? texto = null, JsonObject? dados = null, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        db.LogLocal.Add(Ocorrencias.Nova(relogio.Agora, nivel, codigo, mensagem, dados, texto));
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// O último registro do <c>log_local</c> de uma origem (nível e quando), ou nulo: uma linha só, pela chave (o mais
    /// recente primeiro), sem carregar o histórico (Painel de saúde, Central do PDV, bloco G4).
    /// </summary>
    public async Task<(string Nivel, DateTimeOffset OcorridoEm)?> UltimoLogAsync(string origem, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var ultimo = await db.LogLocal.AsNoTracking().Where(l => l.Origem == origem).OrderByDescending(l => l.Id)
            .Select(l => new { l.Nivel, l.OcorridoEm }).FirstOrDefaultAsync(ct);
        return ultimo is null ? null : (ultimo.Nivel, ultimo.OcorridoEm);
    }

    public async Task RegistrarAuditoriaAsync(
        string acao,
        Guid? usuarioId,
        string? entidade = null,
        Guid? registroId = null,
        string? descricao = null,
        string? localizacao = "pdv.venda",
        Guid? autorizadoPorId = null,
        CancellationToken ct = default,
        string? motivo = null,
        string? depois = null)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        db.LogAuditoriaLocal.Add(new LogAuditoriaLocal
        {
            Motivo = motivo,
            Depois = depois,
            Id = IdGerador.Novo(),
            OcorridoEm = relogio.Agora,
            UsuarioId = usuarioId,
            AutorizadoPorId = autorizadoPorId,
            Acao = acao,
            Entidade = entidade,
            RegistroId = registroId,
            Localizacao = localizacao,
            Descricao = descricao,
        });
        await db.SaveChangesAsync(ct);
    }
}

/// <summary>
/// O que a ativação grava localmente (SYNC 3.5), já montado a partir da resposta da API (o Data não conhece os contratos
/// do protocolo): sequências por chave de <c>sequencias_locais</c> e valores JSON de <c>configuracao_terminal</c>.
/// </summary>
/// <param name="Conexao">Nulo na demonstração (sem nuvem não há amostra de relógio).</param>
/// <param name="Auditoria">
/// <c>terminal_ativado</c> em <c>log_auditoria_local</c>, gravada no mesmo commit: depois dele a ativação não grava mais
/// nada, então uma falha local sempre significa "nada gravado".
/// </param>
public sealed record DadosAtivacao(
    IdentidadeTerminal Identidade,
    IReadOnlyDictionary<string, long> Sequencias,
    EstadoConexao? Conexao,
    IReadOnlyDictionary<string, string> Configuracoes,
    LogAuditoriaLocal? Auditoria = null);
