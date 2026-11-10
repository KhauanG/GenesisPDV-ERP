using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using System.Text.Json;
using GenesisPDV.Data.Convencoes;
using GenesisPDV.Data.Entidades;
using Microsoft.Data.Sqlite;

namespace GenesisPDV.Data.Repositorios;

/// <summary>Resultado da conferência do índice da pesquisa na abertura (<see cref="IndiceBuscaProdutos.GarantirAsync"/>).</summary>
/// <param name="Reconstruido">O índice foi (re)criado e preenchido a partir do espelho.</param>
/// <param name="Motivo">Por que foi reconstruído (estrutura ausente, reconstrução pendente, contagem diferente).</param>
/// <param name="Produtos">Produtos indexados na reconstrução.</param>
public sealed record ResultadoIndiceBusca(bool Reconstruido, string? Motivo, int Produtos);

/// <summary>
/// Índice local da pesquisa F2 (Fase 2, F2-B36; PDV 10.3; MD 4.2; README do PDV › decisão 83): a tabela virtual FTS5
/// <c>produtos_busca</c>, com o tokenizador <c>trigram</c>, sobre o conteúdo externo <c>produtos_busca_texto</c> (uma linha
/// por produto do espelho, com o texto já sem acento e em maiúsculas: nome, código interno, código numérico, marca e
/// categoria principal). Os gatilhos da tabela de conteúdo mantêm a FTS5. Não é espelho: fica fora do Esquema.g.cs e do
/// modelo do EF (a migração <c>BuscaProdutosFts</c> cria a estrutura com SQL), e o texto é recalculado do espelho.
/// <list type="bullet">
/// <item>A pesquisa casa <b>trechos</b> (o trigrama acha "350" em "LT350ML"), igual à busca em memória da Fase 1: cada
/// palavra de 3 letras ou mais vai ao <c>MATCH</c>; a mais curta (o trigrama não indexa) é filtrada com <c>instr</c> sobre
/// as linhas que o <c>MATCH</c> trouxe (só palavras curtas: <c>instr</c> sobre a tabela de conteúdo, ainda no SQLite).</item>
/// <item>O pull (<c>AplicadorPull</c>) e a gravação local dos espelhos (<see cref="RepositorioEspelhos"/>) recalculam, na
/// mesma transação da página, o texto dos produtos tocados (e dos produtos das marcas e categorias tocadas), sob um
/// <c>SAVEPOINT</c>: a falha do índice nunca desfaz a página nem trava o cursor; marca a reconstrução pendente
/// (<see cref="ChavesConfiguracaoTerminal.BuscaReconstruir"/>) e a pesquisa passa à busca em memória.</item>
/// <item>A abertura (<see cref="InicializadorBanco"/>) confere a estrutura, a marca pendente e a contagem contra
/// <c>produtos</c>, e reconstrói em lotes de <see cref="Lote"/> (a primeira abertura depois da migração preenche o índice
/// com o espelho que já existe, sem voltar o cursor). A FTS5 corrompida (o <c>integrity_check</c> da abertura acusa só
/// ela) é descartada e refeita, sem bloquear o caixa.</item>
/// </list>
/// </summary>
public static class IndiceBuscaProdutos
{
    public const string Tabela = "produtos_busca";
    public const string TabelaTexto = "produtos_busca_texto";

    /// <summary>Produtos por transação na reconstrução (SYNC 6.11: lotes curtos, a venda nunca espera muito).</summary>
    public const int Lote = 5000;

    /// <summary>O trigrama só indexa trechos de 3 caracteres ou mais; a palavra mais curta é filtrada com <c>instr</c>.</summary>
    public const int TamanhoMinimoMatch = 3;

    private const int LoteAtualizacao = 500;
    private const string PontoSalvamento = "indice_busca";
    private const string PontoGravacao = "indice_busca_gravacao";

    /// <summary>
    /// Bancos (pelo arquivo) em que a falha do índice desfez o ponto de salvamento: a atualização fica suspensa neste
    /// processo até a reconstrução, para a página do pull não falhar sempre no COMMIT.
    /// </summary>
    private static readonly ConcurrentDictionary<string, bool> Suspensos = new(StringComparer.Ordinal);

    /// <summary>Objetos da estrutura (tabelas e gatilhos), para conferir que está completa.</summary>
    public static readonly IReadOnlyList<string> Objetos =
    [
        Tabela, TabelaTexto, "tg_produtos_busca_texto_ai", "tg_produtos_busca_texto_ad", "tg_produtos_busca_texto_au",
    ];

    /// <summary>
    /// DDL atual da estrutura (a mesma da migração <c>BuscaProdutosFts</c>; o <c>IndiceBuscaProdutosTests</c> confere que
    /// a recriação dá o mesmo esquema). O conteúdo externo guarda o texto uma vez; a FTS5 guarda só o índice.
    /// </summary>
    public static readonly IReadOnlyList<string> Ddl =
    [
        "CREATE TABLE produtos_busca_texto (id INTEGER PRIMARY KEY, produto_id TEXT NOT NULL UNIQUE, texto TEXT NOT NULL)",
        "CREATE VIRTUAL TABLE produtos_busca USING fts5(texto, content='produtos_busca_texto', content_rowid='id', tokenize='trigram')",
        "CREATE TRIGGER tg_produtos_busca_texto_ai AFTER INSERT ON produtos_busca_texto BEGIN "
        + "INSERT INTO produtos_busca (rowid, texto) VALUES (new.id, new.texto); END",
        "CREATE TRIGGER tg_produtos_busca_texto_ad AFTER DELETE ON produtos_busca_texto BEGIN "
        + "INSERT INTO produtos_busca (produtos_busca, rowid, texto) VALUES ('delete', old.id, old.texto); END",
        "CREATE TRIGGER tg_produtos_busca_texto_au AFTER UPDATE ON produtos_busca_texto BEGIN "
        + "INSERT INTO produtos_busca (produtos_busca, rowid, texto) VALUES ('delete', old.id, old.texto); "
        + "INSERT INTO produtos_busca (rowid, texto) VALUES (new.id, new.texto); END",
    ];

    /// <summary>Descarte da estrutura (a FTS5 antes: o <c>drop</c> funciona mesmo com o índice corrompido).</summary>
    public static readonly IReadOnlyList<string> Descarte =
    [
        "DROP TABLE IF EXISTS produtos_busca",
        "DROP TRIGGER IF EXISTS tg_produtos_busca_texto_ai",
        "DROP TRIGGER IF EXISTS tg_produtos_busca_texto_ad",
        "DROP TRIGGER IF EXISTS tg_produtos_busca_texto_au",
        "DROP TABLE IF EXISTS produtos_busca_texto",
    ];

    private const string SelecaoTexto = """
        select p.id, p.nome, p.codigo_interno, p.codigo, m.descricao, c.nome
        from produtos p
        left join marcas m on m.id = p.marca_id and m.excluido_em is null
        left join categorias c on c.id = p.categoria_principal_id and c.excluido_em is null
        """;

    /// <summary>Maiúsculas sem acento (a mesma regra da busca em memória da Fase 1): "Açaí" → "ACAI".</summary>
    public static string Normalizar(string? texto)
    {
        var normalizado = (texto ?? string.Empty).ToUpperInvariant().Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(normalizado.Length);
        foreach (var c in normalizado)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark)
            {
                sb.Append(c);
            }
        }

        return sb.ToString();
    }

    /// <summary>As palavras da pesquisa, já normalizadas (separadas por espaço).</summary>
    public static string[] Palavras(string? texto) => Normalizar(texto).Split(' ', StringSplitOptions.RemoveEmptyEntries);

    /// <summary>O texto pesquisável do produto: nome, código interno, código numérico, marca e categoria principal.</summary>
    public static string Texto(string nome, string? codigoInterno, int codigo, string? marca, string? categoria) =>
        Normalizar(string.Join(' ', new[] { nome, codigoInterno, codigo.ToString(CultureInfo.InvariantCulture), marca, categoria }
            .Where(s => !string.IsNullOrWhiteSpace(s))));

    /// <summary>
    /// O índice pode responder: a estrutura está completa e não há reconstrução pendente. Falso = a busca em memória.
    /// </summary>
    public static async Task<bool> ProntoAsync(SqliteConnection conexao, SqliteTransaction? tx, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(conexao);
        return await EstruturaCompletaAsync(conexao, tx, ct) && !await ReconstrucaoPendenteAsync(conexao, tx, ct);
    }

    /// <summary>
    /// Ids dos produtos ativos e não excluídos com todas as <paramref name="palavras"/> (já normalizadas), por nome, até
    /// <paramref name="limite"/>. Sem palavras, os primeiros por nome. Lança <see cref="SqliteException"/> com o índice
    /// corrompido (quem chama marca a reconstrução e usa a busca em memória).
    /// </summary>
    public static async Task<List<Guid>> PesquisarAsync(SqliteConnection conexao, IReadOnlyList<string> palavras, int limite, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(conexao);
        ArgumentNullException.ThrowIfNull(palavras);
        await using var cmd = conexao.CreateCommand();
        var longas = palavras.Where(p => p.Length >= TamanhoMinimoMatch).ToList();
        var curtas = palavras.Where(p => p.Length < TamanhoMinimoMatch).ToList();
        var sql = new StringBuilder("select p.id from ");
        if (palavras.Count == 0)
        {
            sql.Append("produtos p where 1 = 1");
        }
        else if (longas.Count > 0)
        {
            // Cada palavra entre aspas (aspas internas dobradas): o MATCH as lê como trechos, nunca como operadores.
            sql.Append(Tabela).Append(" b join ").Append(TabelaTexto).Append(" t on t.id = b.rowid join produtos p on p.id = t.produto_id ")
                .Append("where ").Append(Tabela).Append(" match $match");
            cmd.Parameters.AddWithValue("$match", string.Join(' ', longas.Select(p => $"\"{p.Replace("\"", "\"\"", StringComparison.Ordinal)}\"")));
        }
        else
        {
            sql.Append(TabelaTexto).Append(" t join produtos p on p.id = t.produto_id where 1 = 1");
        }

        for (var i = 0; i < curtas.Count; i++)
        {
            sql.Append(CultureInfo.InvariantCulture, $" and instr(t.texto, $curta{i}) > 0");
            cmd.Parameters.AddWithValue($"$curta{i}", curtas[i]);
        }

        sql.Append(" and p.excluido_em is null and p.ativo = 1 order by p.nome, p.id limit $limite");
        cmd.Parameters.AddWithValue("$limite", limite);
        cmd.CommandText = sql.ToString();
        var ids = new List<Guid>();
        await using var leitor = await cmd.ExecuteReaderAsync(ct);
        while (await leitor.ReadAsync(ct))
        {
            ids.Add(Guid.Parse(leitor.GetString(0)));
        }

        return ids;
    }

    /// <summary>
    /// Recalcula, na transação de quem chama, o texto dos <paramref name="produtos"/> e dos produtos das
    /// <paramref name="marcas"/> e <paramref name="categorias"/> (ids no texto do espelho, <c>D</c> minúsculo). O produto
    /// que não está mais no espelho sai do índice. Sem a estrutura (banco anterior à migração, ou descartada), não faz
    /// nada: a abertura reconstrói. Sob um <c>SAVEPOINT</c>: a falha desfaz só o índice, marca a reconstrução pendente e
    /// devolve a exceção (para o log), sem lançar.
    /// </summary>
    public static async Task<Exception?> AtualizarAsync(
        SqliteConnection conexao,
        SqliteTransaction tx,
        IReadOnlyCollection<string> produtos,
        IReadOnlyCollection<string> marcas,
        IReadOnlyCollection<string> categorias,
        DateTimeOffset agora,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(conexao);
        ArgumentNullException.ThrowIfNull(tx);
        ArgumentNullException.ThrowIfNull(produtos);
        ArgumentNullException.ThrowIfNull(marcas);
        ArgumentNullException.ThrowIfNull(categorias);
        if (produtos.Count + marcas.Count + categorias.Count == 0 || !await EstruturaCompletaAsync(conexao, tx, ct))
        {
            return null;
        }

        if (Suspensos.ContainsKey(conexao.DataSource))
        {
            await MarcarReconstrucaoAsync(conexao, tx, agora, ct);
            return null;
        }

        await tx.SaveAsync(PontoSalvamento, ct);
        try
        {
            var ids = new HashSet<string>(produtos, StringComparer.Ordinal);
            if (marcas.Count + categorias.Count > 0)
            {
                await using var cmd = Comando(conexao, tx, """
                    select id from produtos
                    where marca_id in (select value from json_each($marcas)) or categoria_principal_id in (select value from json_each($categorias))
                    """);
                cmd.Parameters.AddWithValue("$marcas", JsonSerializer.Serialize(marcas));
                cmd.Parameters.AddWithValue("$categorias", JsonSerializer.Serialize(categorias));
                await using var leitor = await cmd.ExecuteReaderAsync(ct);
                while (await leitor.ReadAsync(ct))
                {
                    ids.Add(leitor.GetString(0));
                }
            }

            foreach (var lote in ids.Chunk(LoteAtualizacao))
            {
                var textos = await TextosAsync(conexao, tx, $"{SelecaoTexto} where p.id in (select value from json_each($ids))",
                    c => c.Parameters.AddWithValue("$ids", JsonSerializer.Serialize(lote)), ct);
                await GravarTextosAsync(conexao, tx, textos, ct);
                foreach (var ausente in lote.Where(id => !textos.ContainsKey(id)))
                {
                    await using var apagar = Comando(conexao, tx, "delete from produtos_busca_texto where produto_id = $id");
                    apagar.Parameters.AddWithValue("$id", ausente);
                    await apagar.ExecuteNonQueryAsync(ct);
                }
            }

            // A FTS5 junta as escritas em memória e só as grava no SAVEPOINT, no RELEASE ou no COMMIT. O SAVEPOINT aninhado
            // força a gravação aqui dentro: a falha do índice corrompido aparece com o ponto de salvamento ainda de pé. No
            // RELEASE ela desfaria o ponto (e voltaria no COMMIT da página, que nunca passaria).
            await tx.SaveAsync(PontoGravacao, ct);
            await tx.ReleaseAsync(PontoGravacao, ct);
            await tx.ReleaseAsync(PontoSalvamento, ct);
            return null;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            try
            {
                await tx.RollbackAsync(PontoSalvamento, ct);
                await tx.ReleaseAsync(PontoSalvamento, ct);
            }
            catch (Exception desfazer) when (desfazer is SqliteException or InvalidOperationException)
            {
                // Sem o ponto de salvamento, a escrita pendente da FTS5 falharia de novo no COMMIT: a página falha agora e,
                // nas próximas, o índice fica de fora até a reconstrução (senão o cursor nunca passaria desta página). A
                // falha que desfez a transação inteira (disco cheio, I/O) chega aqui como InvalidOperationException: o
                // Microsoft.Data.Sqlite dá a transação por encerrada e recusa o ROLLBACK TO.
                Suspensos[conexao.DataSource] = true;
                throw;
            }

            await MarcarReconstrucaoAsync(conexao, tx, agora, ct);
            return e;
        }
    }

    /// <summary>Marca a reconstrução pendente (a pesquisa usa a busca em memória até a próxima reconstrução).</summary>
    public static async Task MarcarReconstrucaoAsync(SqliteConnection conexao, SqliteTransaction? tx, DateTimeOffset agora, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(conexao);
        await using var cmd = Comando(conexao, tx, """
            insert into configuracao_terminal (chave, valor, atualizado_em) values ($chave, 'true', $agora)
            on conflict (chave) do update set valor = excluded.valor, atualizado_em = excluded.atualizado_em
            """);
        cmd.Parameters.AddWithValue("$chave", ChavesConfiguracaoTerminal.BuscaReconstruir);
        cmd.Parameters.AddWithValue("$agora", DataHoraUtcTexto.Formatar(agora));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    /// <summary>
    /// Confere o índice e, se preciso, reconstrói (a estrutura ausente ou incompleta, a reconstrução pendente ou a contagem
    /// diferente da de <c>produtos</c>): descarta e recria a estrutura, depois preenche em lotes de <see cref="Lote"/>
    /// produtos, cada lote numa transação curta, e por fim tira a marca pendente. Enquanto isso, a pesquisa usa a busca em
    /// memória. Interrompida, a próxima abertura recomeça (a marca fica).
    /// </summary>
    public static async Task<ResultadoIndiceBusca> GarantirAsync(string stringConexao, DateTimeOffset agora, CancellationToken ct = default)
    {
        await using var conexao = new SqliteConnection(stringConexao);
        await conexao.OpenAsync(ct);
        PragmasSqlite.Aplicar(conexao);
        string? motivo = null;
        if (!await EstruturaCompletaAsync(conexao, null, ct))
        {
            motivo = "estrutura ausente";
        }
        else if (await ReconstrucaoPendenteAsync(conexao, null, ct))
        {
            motivo = "reconstrução pendente";
        }
        else if (await ContarAsync(conexao, "select count(*) from produtos", ct) != await ContarAsync(conexao, "select count(*) from produtos_busca_texto", ct))
        {
            motivo = "contagem diferente do espelho";
        }

        if (motivo is null)
        {
            return new ResultadoIndiceBusca(false, null, 0);
        }

        await using (var tx = (SqliteTransaction)await conexao.BeginTransactionAsync(ct))
        {
            await MarcarReconstrucaoAsync(conexao, tx, agora, ct);
            foreach (var sql in Descarte.Concat(Ddl))
            {
                await using var cmd = Comando(conexao, tx, sql);
                await cmd.ExecuteNonQueryAsync(ct);
            }

            await tx.CommitAsync(ct);
        }

        var total = 0;
        var ultimo = string.Empty;
        while (true)
        {
            // Transação de escrita já no início (immediate): a leitura do lote e a gravação não se cruzam com uma página
            // do pull, que também recalcula o texto dos produtos que toca.
            await using var tx = conexao.BeginTransaction(deferred: false);
            var textos = await TextosAsync(conexao, tx, $"{SelecaoTexto} where p.id > $ultimo order by p.id limit {Lote}",
                c => c.Parameters.AddWithValue("$ultimo", ultimo), ct);
            await GravarTextosAsync(conexao, tx, textos, ct);
            if (textos.Count < Lote)
            {
                await using var limpar = Comando(conexao, tx, "delete from configuracao_terminal where chave = $chave");
                limpar.Parameters.AddWithValue("$chave", ChavesConfiguracaoTerminal.BuscaReconstruir);
                await limpar.ExecuteNonQueryAsync(ct);
            }

            await tx.CommitAsync(ct);
            total += textos.Count;
            if (textos.Count < Lote)
            {
                Suspensos.TryRemove(conexao.DataSource, out _);
                return new ResultadoIndiceBusca(true, motivo, total);
            }

            ultimo = textos.Keys.Max(StringComparer.Ordinal)!;
        }
    }

    /// <summary>
    /// O <c>integrity_check</c> da abertura acusou problema só na FTS5 (toda linha cita <c>produtos_busca</c>): o índice é
    /// derivado do espelho, então é descartado (a abertura recria e preenche) em vez de bloquear o caixa.
    /// </summary>
    public static bool SoOIndiceCorrompido(IReadOnlyList<string> problemas) =>
        problemas.Count > 0 && problemas.All(p => p.Contains(Tabela, StringComparison.Ordinal));

    /// <summary>Descarta a estrutura (tabelas e gatilhos) e marca a reconstrução pendente, numa transação.</summary>
    public static async Task DescartarAsync(SqliteConnection conexao, DateTimeOffset agora, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(conexao);
        await using var tx = (SqliteTransaction)await conexao.BeginTransactionAsync(ct);
        foreach (var sql in Descarte)
        {
            await using var cmd = Comando(conexao, tx, sql);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await MarcarReconstrucaoAsync(conexao, tx, agora, ct);
        await tx.CommitAsync(ct);
    }

    private static async Task<bool> EstruturaCompletaAsync(SqliteConnection conexao, SqliteTransaction? tx, CancellationToken ct)
    {
        await using var cmd = Comando(conexao, tx, "select count(*) from sqlite_master where name in (select value from json_each($nomes))");
        cmd.Parameters.AddWithValue("$nomes", JsonSerializer.Serialize(Objetos));
        return Convert.ToInt64(await cmd.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture) == Objetos.Count;
    }

    private static async Task<bool> ReconstrucaoPendenteAsync(SqliteConnection conexao, SqliteTransaction? tx, CancellationToken ct)
    {
        await using var cmd = Comando(conexao, tx, "select count(*) from configuracao_terminal where chave = $chave");
        cmd.Parameters.AddWithValue("$chave", ChavesConfiguracaoTerminal.BuscaReconstruir);
        return Convert.ToInt64(await cmd.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture) > 0;
    }

    private static async Task<long> ContarAsync(SqliteConnection conexao, string sql, CancellationToken ct)
    {
        await using var cmd = Comando(conexao, null, sql);
        return Convert.ToInt64(await cmd.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture);
    }

    /// <summary>Texto de cada produto da seleção, pelo id (texto do espelho).</summary>
    private static async Task<Dictionary<string, string>> TextosAsync(
        SqliteConnection conexao, SqliteTransaction tx, string sql, Action<SqliteCommand> parametros, CancellationToken ct)
    {
        var textos = new Dictionary<string, string>(StringComparer.Ordinal);
        await using var cmd = Comando(conexao, tx, sql);
        parametros(cmd);
        await using var leitor = await cmd.ExecuteReaderAsync(ct);
        while (await leitor.ReadAsync(ct))
        {
            textos[leitor.GetString(0)] = Texto(
                leitor.GetString(1),
                leitor.IsDBNull(2) ? null : leitor.GetString(2),
                leitor.GetInt32(3),
                leitor.IsDBNull(4) ? null : leitor.GetString(4),
                leitor.IsDBNull(5) ? null : leitor.GetString(5));
        }

        return textos;
    }

    /// <summary>Upsert pelo produto; o texto igual não reescreve (nem mexe na FTS5).</summary>
    private static async Task GravarTextosAsync(SqliteConnection conexao, SqliteTransaction tx, Dictionary<string, string> textos, CancellationToken ct)
    {
        if (textos.Count == 0)
        {
            return;
        }

        await using var cmd = Comando(conexao, tx, """
            insert into produtos_busca_texto (produto_id, texto) values ($id, $texto)
            on conflict (produto_id) do update set texto = excluded.texto where texto <> excluded.texto
            """);
        var id = cmd.Parameters.Add("$id", SqliteType.Text);
        var texto = cmd.Parameters.Add("$texto", SqliteType.Text);
        cmd.Prepare();
        foreach (var (produto, valor) in textos)
        {
            id.Value = produto;
            texto.Value = valor;
            await cmd.ExecuteNonQueryAsync(ct);
        }
    }

    private static SqliteCommand Comando(SqliteConnection conexao, SqliteTransaction? tx, string sql)
    {
        var cmd = conexao.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = sql;
        return cmd;
    }
}
