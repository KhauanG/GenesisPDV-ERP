using GenesisPDV.Data.Entidades;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data;

public sealed class BancoCorrompidoException(string mensagem, Exception? interna = null) : Exception(mensagem, interna);

/// <summary>
/// O banco tem migrações que este executável não conhece (implantação I3): uma versão mais nova do GenesisPDV já o
/// atualizou e alguém instalou uma mais antiga por cima. Abrir assim faria o app antigo gravar num esquema que ele não
/// conhece; o banco fica intocado até voltar a versão nova.
/// </summary>
public sealed class BancoDeVersaoMaisNovaException(IReadOnlyList<string> desconhecidas)
    : Exception($"Banco local atualizado por uma versão mais nova do GenesisPDV (migrações desconhecidas: {string.Join(", ", desconhecidas)}).")
{
    public IReadOnlyList<string> MigracoesDesconhecidas { get; } = desconhecidas;
}

/// <param name="IndiceBusca">
/// A conferência do índice da pesquisa F2 (F2-B36; <see cref="Repositorios.IndiceBuscaProdutos"/>); nula se ela falhou (o
/// erro em <paramref name="ErroIndiceBusca"/>: a pesquisa usa a busca em memória e o caixa abre do mesmo jeito).
/// </param>
/// <param name="IndiceDescartado">O <c>integrity_check</c> acusou só a FTS5 da pesquisa, que foi descartada e refeita.</param>
public sealed record ResultadoInicializacao(
    bool BancoNovo,
    IReadOnlyList<string> MigracoesAplicadas,
    string? ArquivoBackup,
    Repositorios.ResultadoIndiceBusca? IndiceBusca = null,
    string? ErroIndiceBusca = null,
    bool IndiceDescartado = false);

/// <summary>
/// Abertura do banco local na inicialização (PDV 4.2, 32.2, 32.5): confere a integridade, apaga o marcador de
/// encerramento limpo (<c>encerramento.json</c>, <see cref="Backup.MarcadorEncerramento"/>: daqui em diante o app rodou
/// depois do backup de saída), faz backup antes de qualquer migração pendente (pela API de backup online do SQLite),
/// aplica as migrações e cria as linhas únicas. Com a integridade falha o marcador fica: a restauração automática do
/// backup de saída o confere (SYNC 22.1). Um banco com migrações que este executável não conhece (versão mais antiga
/// instalada por cima da nova) não é aberto (<see cref="BancoDeVersaoMaisNovaException"/>; I3). Por fim confere o índice
/// da pesquisa F2 (F2-B36): a primeira abertura depois da migração o preenche com o espelho; a falha dele nunca impede a
/// abertura. A FTS5 corrompida (só ela no <c>integrity_check</c>) é descartada e refeita, sem bloquear o caixa.
/// </summary>
public static class InicializadorBanco
{
    public static async Task<ResultadoInicializacao> InicializarAsync(
        FabricaPdvDb fabrica,
        string pastaBackup,
        DateTimeOffset agora,
        CancellationToken ct = default,
        string? pastaMarcadorEncerramento = null)
    {
        var arquivo = fabrica.CaminhoBanco;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(arquivo))!);
        var existia = File.Exists(arquivo) && new FileInfo(arquivo).Length > 0;

        await using var db = fabrica.CreateDbContext();
        var indiceDescartado = false;
        if (existia)
        {
            // Só lê: o descarte da FTS5 corrompida espera a conferência das migrações abaixo.
            var soOIndiceCorrompido = await VerificarIntegridadeAsync(db, ct);
            // Antes de apagar o marcador, de descartar o índice e de migrar: o banco de uma versão mais nova fica
            // exatamente como estava.
            var conhecidas = db.Database.GetMigrations().ToHashSet(StringComparer.Ordinal);
            var desconhecidas = (await db.Database.GetAppliedMigrationsAsync(ct)).Where(m => !conhecidas.Contains(m)).ToList();
            if (desconhecidas.Count > 0)
            {
                throw new BancoDeVersaoMaisNovaException(desconhecidas);
            }

            if (soOIndiceCorrompido)
            {
                await DescartarIndiceCorrompidoAsync(db, agora, ct);
                indiceDescartado = true;
            }
        }

        if (pastaMarcadorEncerramento is not null)
        {
            Backup.MarcadorEncerramento.Apagar(pastaMarcadorEncerramento);
        }

        var pendentes = (await db.Database.GetPendingMigrationsAsync(ct)).ToList();
        string? backup = null;
        if (existia && pendentes.Count > 0)
        {
            backup = FazerBackup(fabrica, pastaBackup, agora, Backup.MotivosBackup.AntesMigracao);
        }

        await db.Database.MigrateAsync(ct);
        await CriarLinhasUnicasAsync(db, agora, ct);
        // .deb com mais de uma conta no grupo (I3): o SQLite criou o banco com 0644; a próxima conta precisa escrever.
        PermissoesGrupo.LiberarParaOGrupo(arquivo);
        Repositorios.ResultadoIndiceBusca? indice = null;
        string? erroIndice = null;
        try
        {
            indice = await Repositorios.IndiceBuscaProdutos.GarantirAsync(fabrica.StringConexao, agora, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // A pesquisa cai na busca em memória (a marca pendente fica, quando chegou a ser gravada).
            erroIndice = e.Message;
        }

        return new ResultadoInicializacao(!existia, pendentes, backup, indice, erroIndice, indiceDescartado);
    }

    /// <summary>Cópia consistente do banco em uso (API de backup online do SQLite).</summary>
    public static string FazerBackup(FabricaPdvDb fabrica, string pastaBackup, DateTimeOffset agora, string motivo)
    {
        Directory.CreateDirectory(pastaBackup);
        var destino = Path.Combine(pastaBackup, Backup.BackupLocal.NomeArquivo(agora, motivo));
        using var origem = new SqliteConnection(fabrica.StringConexao);
        origem.Open();
        using var copia = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = destino, Pooling = false }.ToString());
        copia.Open();
        origem.BackupDatabase(copia);
        PermissoesGrupo.LiberarParaOGrupo(destino);
        return destino;
    }

    /// <summary>
    /// <c>PRAGMA integrity_check</c>, só lendo: falha em qualquer objeto lança <see cref="BancoCorrompidoException"/>; com
    /// problema só na FTS5 da pesquisa (<see cref="Repositorios.IndiceBuscaProdutos"/>, derivada do espelho) devolve
    /// verdadeiro, e quem chama a descarta (<see cref="DescartarIndiceCorrompidoAsync"/>) depois de conferir as migrações.
    /// </summary>
    private static async Task<bool> VerificarIntegridadeAsync(PdvDbContext db, CancellationToken ct)
    {
        try
        {
            var conexao = (SqliteConnection)db.Database.GetDbConnection();
            await db.Database.OpenConnectionAsync(ct);
            var problemas = await ProblemasIntegridadeAsync(conexao, ct);
            if (Repositorios.IndiceBuscaProdutos.SoOIndiceCorrompido(problemas))
            {
                return true;
            }

            if (problemas.Count > 0)
            {
                throw new BancoCorrompidoException($"Banco local com falha de integridade: {problemas[0]}");
            }

            return false;
        }
        catch (SqliteException e)
        {
            throw new BancoCorrompidoException("Banco local ilegível ou corrompido.", e);
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }

    /// <summary>Descarta a FTS5 corrompida (marca a reconstrução) e confere a integridade de novo.</summary>
    private static async Task DescartarIndiceCorrompidoAsync(PdvDbContext db, DateTimeOffset agora, CancellationToken ct)
    {
        try
        {
            var conexao = (SqliteConnection)db.Database.GetDbConnection();
            await db.Database.OpenConnectionAsync(ct);
            await Repositorios.IndiceBuscaProdutos.DescartarAsync(conexao, agora, ct);
            var problemas = await ProblemasIntegridadeAsync(conexao, ct);
            if (problemas.Count > 0)
            {
                throw new BancoCorrompidoException($"Banco local com falha de integridade: {problemas[0]}");
            }
        }
        catch (SqliteException e)
        {
            throw new BancoCorrompidoException("Banco local ilegível ou corrompido.", e);
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }

    /// <summary>As linhas do <c>integrity_check</c> (até 100); vazia = íntegro.</summary>
    private static async Task<List<string>> ProblemasIntegridadeAsync(SqliteConnection conexao, CancellationToken ct)
    {
        await using var cmd = conexao.CreateCommand();
        cmd.CommandText = "PRAGMA integrity_check(100);";
        var linhas = new List<string>();
        await using var leitor = await cmd.ExecuteReaderAsync(ct);
        while (await leitor.ReadAsync(ct))
        {
            linhas.Add(leitor.IsDBNull(0) ? string.Empty : leitor.GetString(0));
        }

        if (linhas is [var unica] && string.Equals(unica, "ok", StringComparison.OrdinalIgnoreCase))
        {
            return [];
        }

        return linhas.Count == 0 ? ["sem resposta do integrity_check"] : linhas;
    }

    private static async Task CriarLinhasUnicasAsync(PdvDbContext db, DateTimeOffset agora, CancellationToken ct)
    {
        if (!await db.EstadoConexao.AnyAsync(ct))
        {
            db.EstadoConexao.Add(new EstadoConexao { Online = false, OfflineDesde = agora });
        }

        if (!await db.EstadoOperacao.AnyAsync(ct))
        {
            db.EstadoOperacao.Add(new EstadoOperacao { AtualizadoEm = agora });
        }

        var identidade = await db.IdentidadeTerminal.FirstOrDefaultAsync(ct);
        if (identidade is not null)
        {
            identidade.VersaoSchemaLocal = (await db.Database.GetAppliedMigrationsAsync(ct)).Count();
        }

        await db.SaveChangesAsync(ct);
    }
}
