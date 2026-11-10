using System.Text.Json;
using System.Text.Json.Serialization;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Convencoes;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.Data.Sqlite;

namespace GenesisPDV.Data.Backup;

/// <summary>
/// <c>configuracao_terminal['restauracao.pendente']</c> (SYNC 5, 22.1; Fase 1C, C17): a restauração ainda não resolvida
/// pelo handshake online. Gravada pela restauração no próprio arquivo restaurado; o handshake aplica a regra (salto ou a
/// prova de que nada se perdeu) e a apaga. Enquanto existir, a primeira venda reservada offline aplica o salto padrão de
/// +1000 em venda e vale ("modo restaurado", <see cref="SaltoAplicadoEm"/>).
/// </summary>
/// <param name="Arquivo">Nome do arquivo restaurado (só o nome).</param>
/// <param name="BackupDeSaida">O <c>encerramento.json</c> existia e conferia com o arquivo (condição (c) da prova).</param>
/// <param name="SequenciaBackup">
/// <c>sequencias_locais.evento</c> do arquivo restaurado: a reidratação pede o <c>GET /sync/recuperar</c> a partir dela,
/// mesmo depois de o caixa gerar eventos offline (que podem colidir com os que a nuvem já tem).
/// </param>
/// <param name="UltimoBackupEm"><c>ultimo_backup_em</c> do arquivo (condição (a): nenhum heartbeat depois dele).</param>
public sealed record RestauracaoPendente(
    [property: JsonPropertyName("restaurado_em")] DateTimeOffset RestauradoEm,
    [property: JsonPropertyName("arquivo")] string Arquivo,
    [property: JsonPropertyName("backup_de_saida")] bool BackupDeSaida,
    [property: JsonPropertyName("sequencia_backup")] long SequenciaBackup,
    [property: JsonPropertyName("ultimo_backup_em")] DateTimeOffset? UltimoBackupEm,
    [property: JsonPropertyName("salto_aplicado_em")] DateTimeOffset? SaltoAplicadoEm = null);

/// <summary>Restauração feita: o arquivo, a cópia do banco substituído (se ele era legível) e o que ficou pendente.</summary>
public sealed record ResultadoRestauracao(string Arquivo, string? BancoAnterior, RestauracaoPendente Pendente);

/// <summary>
/// O backup escolhido conferido antes de parar o caixa (<see cref="RestauracaoBackup.ConferirAsync"/>): o terminal, a
/// sequência de eventos do arquivo e quantos eventos o banco em uso ainda não enviou (nulo: banco em uso ilegível). Esses
/// eventos não estão no backup e a nuvem não os tem: depois da troca, só o <c>antes-restauracao</c> os guarda.
/// </summary>
public sealed record ConferenciaRestauracao(string Arquivo, Guid TerminalId, long SequenciaBackup, int? EventosPendentesEmUso);

/// <summary>
/// "Restaurar backup" (PDV 32.5; SYNC 22.1; Fase 1C, C17; O12 do dono): ação explícita — Ctrl+Alt+C › Restaurar backup,
/// com a liberação de <c>pdv.config.terminal</c> e a confirmação dupla, ou a automática depois de um
/// <c>integrity_check</c> falho — que valida o arquivo, guarda o banco em uso e o substitui. Quem chama para o ciclo de
/// sincronização antes (nenhuma conexão aberta) e reinicia o app depois. Passos:
/// <list type="number">
/// <item>Extrai o arquivo para um temporário na pasta de dados e confere: <c>integrity_check</c>, identidade presente e
/// o mesmo terminal do banco em uso (backup de outro caixa é recusado). Com o banco em uso corrompido, o terminal e o
/// token vêm da leitura direta da linha de <c>identidade_terminal</c>, sem o <c>integrity_check</c>, quando ela ainda
/// sai. <see cref="ConferirAsync"/> faz só este passo, antes de o caixa parar.</item>
/// <item>No temporário: <c>identidade_terminal.restaurado_em = agora</c> (o <c>ultimo_backup_em</c> do arquivo fica), o
/// token atual do banco em uso no lugar do antigo (o da época do backup pode já ter sido rotacionado: usá-lo de novo
/// seria o "token anterior reutilizado" da SYNC 3.7), a <see cref="RestauracaoPendente"/> e a auditoria local
/// <c>restaurar</c> (sobe no próximo lote). Se nem a leitura direta sai, fica o token do backup: rotacionado depois
/// dele, a nuvem o aceita como anterior por 7 dias (com o alerta <c>TOKEN_ANTERIOR_REUTILIZADO</c>) e, depois disso,
/// o terminal precisa de nova ativação.</item>
/// <item>O banco em uso vai para <c>backup/</c> (<see cref="MotivosBackup.AntesRestauracao"/>, fora da retenção
/// automática: pode ser a única cópia dos eventos que ele não enviou); ilegível, é renomeado ao lado
/// (<c>pdv.db.corrompido-…</c>). Nada é apagado.</item>
/// <item>O temporário substitui o <c>pdv.db</c> (o <c>-wal</c>/<c>-shm</c> do antigo saem antes).</item>
/// </list>
/// </summary>
public sealed class RestauracaoBackup(FabricaPdvDb fabrica, CaminhosPdv caminhos, BackupLocal backup, IRelogio relogio)
{
    public const string MensagemInvalido = "O arquivo escolhido não é um backup válido do PDV (falhou na verificação de integridade).";
    public const string MensagemOutroTerminal = "O backup escolhido é de outro terminal: escolha um backup deste caixa.";

    /// <summary>
    /// Só a conferência do passo 1 (extração, <c>integrity_check</c>, identidade e terminal), sem mexer em nada: quem chama
    /// confere antes de parar o sincronismo e o backup, e o arquivo recusado não deixa o caixa sem os dois.
    /// </summary>
    public async Task<ConferenciaRestauracao> ConferirAsync(string arquivo, CancellationToken ct = default)
    {
        var temporario = Temporario();
        try
        {
            var (restaurado, emUso, _) = await ExtrairEConferirAsync(arquivo, temporario, ct);
            return new ConferenciaRestauracao(arquivo, restaurado.TerminalId!.Value, restaurado.SequenciaEvento, emUso?.EventosPendentes);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            BackupLocal.ApagarSeExiste(temporario);
        }
    }

    public async Task<ResultadoRestauracao> RestaurarAsync(string arquivo, Guid? usuarioId, Guid? autorizadoPorId, CancellationToken ct = default)
    {
        var agora = relogio.Agora;
        var temporario = Temporario();
        try
        {
            var (restaurado, emUso, atual) = await ExtrairEConferirAsync(arquivo, temporario, ct);
            var pendente = new RestauracaoPendente(
                agora,
                Path.GetFileName(arquivo),
                MarcadorEncerramento.Confere(caminhos.PastaDados, arquivo),
                restaurado.SequenciaEvento,
                restaurado.UltimoBackupEm);
            Gravar(temporario, agora, pendente, atual, usuarioId, autorizadoPorId, restaurado.SoOIndiceCorrompido);

            var anterior = await GuardarBancoEmUsoAsync(emUso is not null, ct);
            SqliteConnection.ClearAllPools();
            BackupLocal.ApagarSeExiste(fabrica.CaminhoBanco + "-wal");
            BackupLocal.ApagarSeExiste(fabrica.CaminhoBanco + "-shm");
            File.Move(temporario, fabrica.CaminhoBanco, overwrite: true);
            return new ResultadoRestauracao(arquivo, anterior, pendente);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            BackupLocal.ApagarSeExiste(temporario);
        }
    }

    private string Temporario()
    {
        Directory.CreateDirectory(caminhos.PastaDados);
        return Path.Combine(caminhos.PastaDados, $".restaurando-{Guid.NewGuid():N}.db");
    }

    /// <summary>
    /// Passo 1: o arquivo extraído e conferido; o banco em uso legível (nulo: ilegível) e o que se leu dele para o
    /// terminal e o token — do banco legível ou, se não, da linha de <c>identidade_terminal</c> lida sem conferir.
    /// </summary>
    private async Task<(BancoLido Restaurado, BancoLido? EmUso, BancoLido? Atual)> ExtrairEConferirAsync(string arquivo, string temporario, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(arquivo);
        if (!File.Exists(arquivo))
        {
            throw new RegraNegocioException("O arquivo de backup não existe mais.");
        }

        await BackupLocal.ExtrairAsync(arquivo, temporario, ct);
        var restaurado = LerBanco(temporario, conferir: true) ?? throw new RegraNegocioException(MensagemInvalido);
        var emUso = File.Exists(fabrica.CaminhoBanco) ? LerBanco(fabrica.CaminhoBanco, conferir: true) : null;
        var atual = emUso ?? (File.Exists(fabrica.CaminhoBanco) ? LerBanco(fabrica.CaminhoBanco, conferir: false) : null);
        if (atual?.TerminalId is { } terminal && restaurado.TerminalId is { } doBackup && terminal != doBackup)
        {
            throw new RegraNegocioException(MensagemOutroTerminal);
        }

        if (restaurado.TerminalId is null)
        {
            throw new RegraNegocioException("O backup escolhido é de antes da ativação do terminal: não há o que restaurar.");
        }

        return (restaurado, emUso, atual?.TerminalId == restaurado.TerminalId ? atual : null);
    }

    /// <summary>
    /// O que a restauração lê de um banco (<see cref="EventosPendentes"/>: ainda a enviar; nulo sem a tabela).
    /// <see cref="SoOIndiceCorrompido"/>: o <c>integrity_check</c> acusou só a FTS5 da pesquisa (F2-B36), que é derivada do
    /// espelho; o banco vale, e a restauração descarta o índice no arquivo restaurado (a abertura o refaz).
    /// </summary>
    private sealed record BancoLido(
        Guid? TerminalId,
        byte[]? Token,
        string? TokenPendente,
        long SequenciaEvento,
        DateTimeOffset? UltimoBackupEm,
        int? EventosPendentes,
        bool SoOIndiceCorrompido = false);

    /// <summary>
    /// Nulo se o banco não é do PDV ou não sai; com <paramref name="conferir"/>, também se não passa no
    /// <c>integrity_check</c> — o problema só na FTS5 da pesquisa passa (a mesma regra da abertura,
    /// <see cref="InicializadorBanco"/>: o backup tirado com o índice corrompido offline continua restaurável). Sem conferir
    /// (o banco em uso corrompido), é a leitura direta das linhas, que pode sair mesmo com a página de outra tabela estragada.
    /// </summary>
    private static BancoLido? LerBanco(string arquivo, bool conferir)
    {
        try
        {
            using var c = new SqliteConnection(BackupLocal.Conexao(arquivo, SqliteOpenMode.ReadOnly));
            c.Open();
            var problemas = conferir ? ProblemasIntegridade(c) : [];
            var soOIndice = IndiceBuscaProdutos.SoOIndiceCorrompido(problemas);
            if ((problemas.Count > 0 && !soOIndice) || !Tabela(c, "identidade_terminal"))
            {
                return null;
            }

            Guid? terminal = null;
            byte[]? token = null;
            DateTimeOffset? ultimoBackup = null;
            using (var cmd = c.CreateCommand())
            {
                cmd.CommandText = "SELECT terminal_id, token_protegido, ultimo_backup_em FROM identidade_terminal LIMIT 1;";
                using var r = cmd.ExecuteReader();
                if (r.Read())
                {
                    terminal = Guid.ParseExact(r.GetString(0), "D");
                    token = r.IsDBNull(1) ? null : (byte[])r.GetValue(1);
                    ultimoBackup = r.IsDBNull(2) ? null : DataHoraUtcTexto.Ler(r.GetString(2));
                }
            }

            string? pendente = null;
            long evento = 0;
            int? aEnviar = null;
            try
            {
                pendente = Escalar(c, $"SELECT valor FROM configuracao_terminal WHERE chave = '{ChavesConfiguracaoTerminal.TokenPendente}';") as string;
                evento = Escalar(c, $"SELECT ultimo_valor FROM sequencias_locais WHERE chave = '{SequenciaLocal.Evento}';") as long? ?? 0;
                aEnviar = Tabela(c, "eventos_saida")
                    ? (int)(long)Escalar(c,
                        $"SELECT count(*) FROM eventos_saida WHERE status IN ('{StatusEventoSaida.Pendente}', '{StatusEventoSaida.Enviando}', '{StatusEventoSaida.ErroTemporario}');")!
                    : null;
            }
            catch (SqliteException) when (!conferir)
            {
                // Corrompido: o terminal e o token já bastam (o resto fica com o que saiu).
            }

            return new BancoLido(terminal, token, pendente, evento, ultimoBackup, aEnviar, soOIndice);
        }
        catch (Exception e) when (e is SqliteException || (!conferir && e is FormatException or InvalidCastException))
        {
            return null;
        }
    }

    /// <summary>As linhas do <c>integrity_check</c> (até 100); vazia = íntegro.</summary>
    private static List<string> ProblemasIntegridade(SqliteConnection c)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = "PRAGMA integrity_check(100);";
        var linhas = new List<string>();
        using var r = cmd.ExecuteReader();
        while (r.Read())
        {
            linhas.Add(r.IsDBNull(0) ? string.Empty : r.GetString(0));
        }

        return linhas is [var unica] && string.Equals(unica, "ok", StringComparison.OrdinalIgnoreCase) ? []
            : linhas.Count == 0 ? ["sem resposta do integrity_check"] : linhas;
    }

    private static bool Tabela(SqliteConnection c, string nome) =>
        Escalar(c, $"SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '{nome}';") is 1L;

    private static object? Escalar(SqliteConnection c, string sql)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        return cmd.ExecuteScalar();
    }

    /// <summary>
    /// Grava no arquivo restaurado (SQL direto: o backup pode ser de um schema anterior, migrado na abertura). Com
    /// <paramref name="descartarIndice"/>, a FTS5 corrompida sai e fica a reconstrução pendente (a abertura refaz).
    /// </summary>
    private static void Gravar(
        string arquivo, DateTimeOffset agora, RestauracaoPendente pendente, BancoLido? emUso, Guid? usuarioId, Guid? autorizadoPorId, bool descartarIndice)
    {
        using var c = new SqliteConnection(BackupLocal.Conexao(arquivo, SqliteOpenMode.ReadWrite));
        c.Open();
        using var tx = c.BeginTransaction();
        if (descartarIndice)
        {
            foreach (var sql in IndiceBuscaProdutos.Descarte)
            {
                Executar(c, sql);
            }

            GravarConfiguracao(c, ChavesConfiguracaoTerminal.BuscaReconstruir, "true", agora);
        }
        Executar(c, "UPDATE identidade_terminal SET restaurado_em = $agora;", ("$agora", DataHoraUtcTexto.Formatar(agora)));
        if (emUso?.Token is { Length: > 0 } token)
        {
            Executar(c, "UPDATE identidade_terminal SET token_protegido = $token;", ("$token", token));
            Executar(c, $"DELETE FROM configuracao_terminal WHERE chave = '{ChavesConfiguracaoTerminal.TokenPendente}';");
            if (emUso.TokenPendente is { } p)
            {
                GravarConfiguracao(c, ChavesConfiguracaoTerminal.TokenPendente, p, agora);
            }
        }

        GravarConfiguracao(c, ChavesConfiguracaoTerminal.RestauracaoPendente, JsonSerializer.Serialize(pendente), agora);
        // A trava da D22 (desativação confirmando) gravada no backup não pode impedir a auditoria nem o caixa restaurado.
        if (Escalar(c, "SELECT count(*) FROM pragma_table_info('estado_conexao') WHERE name = 'confirmando_desativacao_em';") is 1L)
        {
            Executar(c, "UPDATE estado_conexao SET confirmando_desativacao_em = NULL;");
        }

        Executar(c,
            "INSERT INTO log_auditoria_local (id, ocorrido_em, usuario_id, autorizado_por_id, acao, entidade, localizacao, descricao, depois) " +
            "VALUES ($id, $agora, $usuario, $autorizado, 'restaurar', 'identidade_terminal', 'PDV › Restaurar backup', $descricao, $depois);",
            ("$id", IdGerador.Novo().ToString("D")),
            ("$agora", DataHoraUtcTexto.Formatar(agora)),
            ("$usuario", usuarioId?.ToString("D")),
            ("$autorizado", autorizadoPorId?.ToString("D")),
            ("$descricao", $"Backup local restaurado ({pendente.Arquivo}){(pendente.BackupDeSaida ? ", backup de saída conferido" : string.Empty)}"),
            ("$depois", JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["arquivo"] = pendente.Arquivo,
                ["ultimo_backup_em"] = pendente.UltimoBackupEm is { } u ? DataHoraUtcTexto.Formatar(u) : null,
                ["sequencia_backup"] = pendente.SequenciaBackup,
                ["backup_de_saida"] = pendente.BackupDeSaida,
            })));
        tx.Commit();
    }

    private static void GravarConfiguracao(SqliteConnection c, string chave, string valorJson, DateTimeOffset agora) =>
        Executar(c,
            "INSERT INTO configuracao_terminal (chave, valor, atualizado_em) VALUES ($chave, $valor, $agora) " +
            "ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em;",
            ("$chave", chave), ("$valor", valorJson), ("$agora", DataHoraUtcTexto.Formatar(agora)));

    private static void Executar(SqliteConnection c, string sql, params (string Nome, object? Valor)[] parametros)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (nome, valor) in parametros)
        {
            cmd.Parameters.AddWithValue(nome, valor ?? DBNull.Value);
        }

        cmd.ExecuteNonQuery();
    }

    /// <summary>O banco em uso fica guardado: legível, como backup <c>antes-restauracao</c>; ilegível, renomeado ao lado.</summary>
    private async Task<string?> GuardarBancoEmUsoAsync(bool legivel, CancellationToken ct)
    {
        if (!File.Exists(fabrica.CaminhoBanco))
        {
            return null;
        }

        if (legivel)
        {
            return (await backup.FazerAsync(MotivosBackup.AntesRestauracao, ct)).Arquivo;
        }

        SqliteConnection.ClearAllPools();
        var destino = $"{fabrica.CaminhoBanco}.corrompido-{relogio.Agora.UtcDateTime:yyyyMMdd-HHmmss}";
        File.Move(fabrica.CaminhoBanco, destino);
        foreach (var sufixo in new[] { "-wal", "-shm" })
        {
            if (File.Exists(fabrica.CaminhoBanco + sufixo))
            {
                File.Move(fabrica.CaminhoBanco + sufixo, destino + sufixo);
            }
        }

        return destino;
    }
}
