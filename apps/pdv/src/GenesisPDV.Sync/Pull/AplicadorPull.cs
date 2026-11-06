using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Convencoes;
using GenesisPDV.Sync.Protocolo;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.Sync.Pull;

/// <summary>Resultado da aplicação de uma página do pull.</summary>
/// <param name="Recebidas">Alterações da página.</param>
/// <param name="Gravadas">Linhas inseridas ou substituídas (versão maior que a local).</param>
/// <param name="Ignoradas">Tabela desconhecida, sem chave ou versão não maior que a local.</param>
/// <param name="PessoasPurgadas">Pessoas que deixaram de ser relevantes e saíram do espelho (MD 3.5.4).</param>
public sealed record ResultadoPagina(int Recebidas, int Gravadas, int Ignoradas, int PessoasPurgadas);

/// <summary>
/// Aplicação local de uma página do <c>/sync/pull</c> (SYNC 6.10; PDV 30.3). A página inteira e o cursor do fluxo
/// (<c>estado_sincronizacao</c>) vão num commit só: queda no meio = a mesma página de novo (o upsert é idempotente) e o
/// cursor nunca passa de uma página não gravada (6.6).
/// <list type="bullet">
/// <item>SQL em lote gerado do <see cref="EsquemaNuvem"/>: <c>insert … on conflict(&lt;chave&gt;) do update set … where
/// excluded.versao &gt; versao</c> (a nuvem vence, mas só com versão mais nova); um comando preparado por tabela e
/// conjunto de colunas.</item>
/// <item>Tabela desconhecida (app mais velho que a API, ou sem espelho local) é ignorada com log, sem travar o cursor;
/// coluna desconhecida também. Coluna conhecida ausente mantém o valor local (fica fora do <c>update</c>).</item>
/// <item>Decimal chega em texto e é gravado como INTEGER na escala da coluna (<see cref="ConversorLinha"/>).</item>
/// <item><c>criado_localmente</c> é só local: o valor que vier na linha é ignorado, e a versão da nuvem que substitui a
/// linha grava <c>0</c> (MD 4.2: a linha criada no caixa passa a ser a da nuvem).</item>
/// <item>Relevância de pessoa excluída (MD 3.5.4): sem outra relevância ativa nem venda/evento local pendente, a pessoa e
/// as filhas saem do espelho (exceção à regra 6.4.4); quando só sobra <c>funcionario</c>, saem telefones e endereços
/// (D19).</item>
/// </list>
/// A linha adiada por evento local pendente (MD 4.4.12) entra com os espelhos que têm escrita local (vales, comandas),
/// em fases seguintes: os fluxos da Fase 1B são todos mestres na nuvem.
/// </summary>
public sealed class AplicadorPull(FabricaPdvDb fabrica, IRelogio relogio, ILogger<AplicadorPull> log)
{
    private const string ColunaVersao = "versao";
    private const string ColunaCriadoLocalmente = "criado_localmente";

    /// <summary>Filhas que descem pela relevância da pessoa (fluxo <c>pessoas</c>, MD 6.2).</summary>
    private static readonly string[] FilhasPessoa =
    [
        "pessoas_categorias", "pessoas_enderecos", "pessoas_telefones", "saldos_credito_pessoas", "parcelas_credito_pessoas",
        "saldos_vasilhame_pessoas",
    ];

    private readonly ConcurrentDictionary<string, IReadOnlyDictionary<string, ColunaLocal>> _colunasLocais = new(StringComparer.Ordinal);

    private sealed record ColunaLocal(string Nome, bool NotNull, bool TemPadrao);

    /// <summary>
    /// Aplica a página e avança o cursor do fluxo na mesma transação. <paramref name="cargaInicial"/> usa
    /// <c>synchronous=NORMAL</c> (SYNC 6.9: antes da primeira venda); fora dela, <c>FULL</c>. <paramref name="concluirCarga"/>
    /// marca <c>carga_inicial_concluida</c> no mesmo commit da última página.
    /// </summary>
    public async Task<ResultadoPagina> AplicarAsync(RespostaPull pagina, bool cargaInicial = false, bool concluirCarga = false, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(pagina);
        await using var conexao = new SqliteConnection(fabrica.StringConexao);
        await conexao.OpenAsync(ct);
        await ExecutarAsync(conexao, null, $"{PragmasSqlite.Comando} PRAGMA synchronous={(cargaInicial ? "NORMAL" : "FULL")};", ct);
        await using var tx = (SqliteTransaction)await conexao.BeginTransactionAsync(ct);
        var resultado = await AplicarAsync(conexao, tx, pagina, ct);
        await AtualizarCursorAsync(conexao, tx, pagina, concluirCarga, ct);
        await tx.CommitAsync(ct);
        return resultado;
    }

    /// <summary>
    /// Falha do pull (rede, API): grava o erro e a hora da tentativa; o cursor fica onde está (SYNC 6.5). Com
    /// <paramref name="ressincronizar"/>, marca o fluxo para refazer do zero (SYNC 6.3: teto menor que o cursor).
    /// </summary>
    public async Task RegistrarErroAsync(string fluxo, string erro, CancellationToken ct = default, bool ressincronizar = false)
    {
        await using var conexao = new SqliteConnection(fabrica.StringConexao);
        await conexao.OpenAsync(ct);
        await using var cmd = conexao.CreateCommand();
        cmd.CommandText = "update estado_sincronizacao set ultimo_pull_em = $agora, ultimo_erro = $erro, "
            + "ressincronizar = max(ressincronizar, $ressincronizar) where fluxo = $fluxo";
        cmd.Parameters.AddWithValue("$agora", DataHoraUtcTexto.Formatar(relogio.Agora));
        cmd.Parameters.AddWithValue("$erro", erro.Length > 500 ? erro[..500] : erro);
        cmd.Parameters.AddWithValue("$ressincronizar", ressincronizar ? 1 : 0);
        cmd.Parameters.AddWithValue("$fluxo", fluxo);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    /// <summary>Aplica as alterações na transação de quem chama (sem tocar o cursor).</summary>
    public async Task<ResultadoPagina> AplicarAsync(SqliteConnection conexao, SqliteTransaction tx, RespostaPull pagina, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(conexao);
        ArgumentNullException.ThrowIfNull(pagina);
        var comandos = new Dictionary<string, (SqliteCommand Comando, string[] Colunas)>(StringComparer.Ordinal);
        var avisados = new HashSet<string>(StringComparer.Ordinal);
        var relevanciasExcluidas = new HashSet<string>(StringComparer.Ordinal);
        int gravadas = 0, ignoradas = 0;
        try
        {
            foreach (var alt in pagina.Alteracoes)
            {
                var tabela = EsquemaNuvem.Tabela(alt.Tabela);
                var locais = tabela is { Papel: PapelTabela.Espelho } ? await ColunasLocaisAsync(conexao, tx, alt.Tabela, ct) : null;
                if (tabela is null || locais is null || locais.Count == 0)
                {
                    if (avisados.Add(alt.Tabela))
                    {
                        log.LogWarning("Pull {Fluxo}: tabela desconhecida {Tabela} ignorada (app mais antigo que a API?)", pagina.Fluxo, alt.Tabela);
                    }

                    ignoradas++;
                    continue;
                }

                var valores = Valores(tabela, locais, alt, avisados, pagina.Fluxo);
                if (!tabela.Chave.All(valores.ContainsKey))
                {
                    log.LogWarning("Pull {Fluxo}: linha de {Tabela} sem a chave {Chave} ignorada", pagina.Fluxo, alt.Tabela, string.Join(",", tabela.Chave));
                    ignoradas++;
                    continue;
                }

                var assinatura = $"{alt.Tabela}|{string.Join(",", valores.Keys)}";
                if (!comandos.TryGetValue(assinatura, out var preparado))
                {
                    preparado = Preparar(conexao, tx, tabela, locais, [.. valores.Keys]);
                    comandos[assinatura] = preparado;
                }

                for (var i = 0; i < preparado.Colunas.Length; i++)
                {
                    preparado.Comando.Parameters[i].Value = valores.TryGetValue(preparado.Colunas[i], out var v)
                        ? v ?? DBNull.Value
                        : ConversorLinha.Neutro(ColunaDoEsquema(tabela, preparado.Colunas[i]));
                }

                if (await preparado.Comando.ExecuteNonQueryAsync(ct) > 0)
                {
                    gravadas++;
                }
                else
                {
                    ignoradas++;
                }

                if (alt.Tabela == "pessoas_relevancia_loja"
                    && alt.Linha.TryGetProperty("excluido_em", out var excluido) && excluido.ValueKind != JsonValueKind.Null
                    && alt.Linha.TryGetProperty("pessoa_id", out var pessoa) && pessoa.GetString() is { } pessoaId)
                {
                    relevanciasExcluidas.Add(Guid.Parse(pessoaId).ToString("D"));
                }
            }

            var purgadas = 0;
            foreach (var pessoaId in relevanciasExcluidas)
            {
                purgadas += await PurgarPessoaAsync(conexao, tx, pessoaId, ct) ? 1 : 0;
            }

            return new ResultadoPagina(pagina.Alteracoes.Count, gravadas, ignoradas, purgadas);
        }
        finally
        {
            foreach (var (comando, _) in comandos.Values)
            {
                await comando.DisposeAsync();
            }
        }
    }

    /// <summary>Colunas da linha que existem no espelho local, já convertidas; <c>versao</c> = a da alteração.</summary>
    private Dictionary<string, object?> Valores(
        TabelaEsquema tabela,
        IReadOnlyDictionary<string, ColunaLocal> locais,
        AlteracaoPull alt,
        HashSet<string> avisados,
        string fluxo)
    {
        var valores = new Dictionary<string, object?>(StringComparer.Ordinal);
        if (alt.Linha.ValueKind != JsonValueKind.Object)
        {
            return valores;
        }

        foreach (var propriedade in alt.Linha.EnumerateObject())
        {
            // `criado_localmente` é só do PDV (MD 4.2): nunca vem da nuvem, e se viesse não seria aplicado (o upsert
            // grava a constante, ver Preparar).
            if (!locais.ContainsKey(propriedade.Name) || propriedade.Name == ColunaCriadoLocalmente)
            {
                if (avisados.Add($"{alt.Tabela}.{propriedade.Name}"))
                {
                    log.LogInformation("Pull {Fluxo}: coluna desconhecida {Tabela}.{Coluna} ignorada", fluxo, alt.Tabela, propriedade.Name);
                }

                continue;
            }

            valores[propriedade.Name] = ConversorLinha.Converter(ColunaDoEsquema(tabela, propriedade.Name), propriedade.Value);
        }

        if (locais.ContainsKey(ColunaVersao))
        {
            valores[ColunaVersao] = alt.Versao;
        }

        return valores;
    }

    /// <summary>Coluna da nuvem; uma só local (campo calculado do pull, como <c>foto_url</c>) é texto.</summary>
    private static ColunaEsquema ColunaDoEsquema(TabelaEsquema tabela, string nome) =>
        tabela.Colunas.FirstOrDefault(c => c.Nome == nome) ?? new ColunaEsquema(nome, "text", typeof(string), Nulo: true, Escala: null);

    /// <summary>
    /// <c>insert</c> com as colunas presentes mais as <c>NOT NULL</c> sem padrão que faltaram (valor neutro, só na linha
    /// nova); o <c>update</c> só com as presentes, então a coluna ausente mantém o valor local. Quando a versão da nuvem
    /// substitui a linha, <c>criado_localmente</c> vai a <c>0</c> (MD 4.2); na linha nova fica o padrão, também 0.
    /// </summary>
    private static (SqliteCommand Comando, string[] Colunas) Preparar(
        SqliteConnection conexao,
        SqliteTransaction tx,
        TabelaEsquema tabela,
        IReadOnlyDictionary<string, ColunaLocal> locais,
        string[] presentes)
    {
        var faltando = locais.Values
            .Where(c => c.NotNull && !c.TemPadrao && !presentes.Contains(c.Nome))
            .Select(c => c.Nome);
        string[] colunas = [.. presentes, .. faltando];
        var atualizar = presentes.Where(c => !tabela.Chave.Contains(c)).Select(c => $"{Id(c)} = excluded.{Id(c)}").ToList();
        if (locais.ContainsKey(ColunaCriadoLocalmente))
        {
            atualizar.Add($"{Id(ColunaCriadoLocalmente)} = 0");
        }

        var sql = new StringBuilder()
            .Append("insert into ").Append(Id(tabela.Nome)).Append(" (").AppendJoin(", ", colunas.Select(Id)).Append(") values (")
            .AppendJoin(", ", colunas.Select((_, i) => $"$p{i}")).Append(") on conflict (")
            .AppendJoin(", ", tabela.Chave.Select(Id)).Append(") do update set ")
            .AppendJoin(", ", atualizar)
            .Append(" where excluded.").Append(Id(ColunaVersao)).Append(" > ").Append(Id(tabela.Nome)).Append('.').Append(Id(ColunaVersao));
        var comando = conexao.CreateCommand();
        comando.Transaction = tx;
        comando.CommandText = sql.ToString();
        for (var i = 0; i < colunas.Length; i++)
        {
            comando.Parameters.Add(new SqliteParameter($"$p{i}", DBNull.Value));
        }

        comando.Prepare();
        return (comando, colunas);
    }

    private async Task<IReadOnlyDictionary<string, ColunaLocal>> ColunasLocaisAsync(SqliteConnection conexao, SqliteTransaction tx, string tabela, CancellationToken ct)
    {
        if (_colunasLocais.TryGetValue(tabela, out var cache))
        {
            return cache;
        }

        var colunas = new Dictionary<string, ColunaLocal>(StringComparer.Ordinal);
        await using (var cmd = conexao.CreateCommand())
        {
            cmd.Transaction = tx;
            cmd.CommandText = "select name, \"notnull\", dflt_value from pragma_table_info($tabela)";
            cmd.Parameters.AddWithValue("$tabela", tabela);
            await using var leitor = await cmd.ExecuteReaderAsync(ct);
            while (await leitor.ReadAsync(ct))
            {
                var nome = leitor.GetString(0);
                colunas[nome] = new ColunaLocal(nome, leitor.GetInt64(1) == 1, !leitor.IsDBNull(2));
            }
        }

        _colunasLocais[tabela] = colunas;
        return colunas;
    }

    /// <summary>
    /// Pessoa cuja relevância foi excluída (MD 3.5.4): sem outra relevância ativa (o espelho só tem as da loja e as de
    /// todas) nem venda em andamento ou evento local pendente, sai do espelho com as filhas; se só sobrou a de
    /// funcionário, saem telefones e endereços (D19). Devolve se a pessoa foi purgada.
    /// </summary>
    private async Task<bool> PurgarPessoaAsync(SqliteConnection conexao, SqliteTransaction tx, string pessoaId, CancellationToken ct)
    {
        var motivos = new List<string>();
        await using (var cmd = Comando(conexao, tx, "select motivo from pessoas_relevancia_loja where pessoa_id = $p and excluido_em is null", pessoaId))
        await using (var leitor = await cmd.ExecuteReaderAsync(ct))
        {
            while (await leitor.ReadAsync(ct))
            {
                motivos.Add(leitor.GetString(0));
            }
        }

        if (motivos.Count > 0)
        {
            if (motivos.All(m => m == "funcionario"))
            {
                foreach (var filha in new[] { "pessoas_telefones", "pessoas_enderecos" })
                {
                    await using var apagar = Comando(conexao, tx, $"delete from {Id(filha)} where pessoa_id = $p", pessoaId);
                    await apagar.ExecuteNonQueryAsync(ct);
                }
            }

            return false;
        }

        await using (var pendente = Comando(conexao, tx, """
            select exists (select 1 from vendas where cliente_id = $p and status not in ('finalizada', 'cancelada'))
                or exists (select 1 from eventos_saida e where e.status <> 'confirmado'
                           and (e.agregado_id = $p or e.agregado_id in (select v.id from vendas v where v.cliente_id = $p)))
            """, pessoaId))
        {
            if (Convert.ToInt64(await pendente.ExecuteScalarAsync(ct), System.Globalization.CultureInfo.InvariantCulture) == 1)
            {
                log.LogInformation("Pessoa {Pessoa} deixou de ser relevante mas tem venda ou evento local pendente: fica no espelho", pessoaId);
                return false;
            }
        }

        foreach (var filha in FilhasPessoa)
        {
            await using var apagar = Comando(conexao, tx, $"delete from {Id(filha)} where pessoa_id = $p", pessoaId);
            await apagar.ExecuteNonQueryAsync(ct);
        }

        await using (var apagar = Comando(conexao, tx, "delete from pessoas where id = $p", pessoaId))
        {
            await apagar.ExecuteNonQueryAsync(ct);
        }

        log.LogInformation("Pessoa {Pessoa} deixou de ser relevante para a loja e saiu do espelho local (MD 3.5.4)", pessoaId);
        return true;
    }

    private async Task AtualizarCursorAsync(SqliteConnection conexao, SqliteTransaction tx, RespostaPull pagina, bool concluirCarga, CancellationToken ct)
    {
        await using var cmd = conexao.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            insert into estado_sincronizacao (fluxo, cursor, carga_inicial_concluida, ultimo_pull_em, ultimo_pull_sucesso_em, linhas_recebidas, ultimo_erro, ressincronizar)
            values ($fluxo, $cursor, $concluida, $agora, $agora, $linhas, null, 0)
            on conflict (fluxo) do update set
                cursor = excluded.cursor,
                carga_inicial_concluida = max(carga_inicial_concluida, excluded.carga_inicial_concluida),
                ultimo_pull_em = excluded.ultimo_pull_em,
                ultimo_pull_sucesso_em = excluded.ultimo_pull_sucesso_em,
                linhas_recebidas = linhas_recebidas + excluded.linhas_recebidas,
                ultimo_erro = null
            """;
        cmd.Parameters.AddWithValue("$fluxo", pagina.Fluxo);
        cmd.Parameters.AddWithValue("$cursor", pagina.NovoCursor);
        cmd.Parameters.AddWithValue("$concluida", concluirCarga ? 1 : 0);
        cmd.Parameters.AddWithValue("$agora", DataHoraUtcTexto.Formatar(relogio.Agora));
        cmd.Parameters.AddWithValue("$linhas", (long)pagina.Alteracoes.Count);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static SqliteCommand Comando(SqliteConnection conexao, SqliteTransaction tx, string sql, string pessoaId)
    {
        var cmd = conexao.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = sql;
        cmd.Parameters.AddWithValue("$p", pessoaId);
        return cmd;
    }

    private static async Task ExecutarAsync(SqliteConnection conexao, SqliteTransaction? tx, string sql, CancellationToken ct)
    {
        await using var cmd = conexao.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = sql;
        await cmd.ExecuteNonQueryAsync(ct);
    }

    /// <summary>Identificador entre aspas: os nomes vêm do Esquema.g.cs e do <c>pragma table_info</c>, nunca da rede.</summary>
    private static string Id(string nome) => $"\"{nome.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";
}
