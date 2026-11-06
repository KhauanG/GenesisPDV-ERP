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

public sealed record ResultadoInicializacao(bool BancoNovo, IReadOnlyList<string> MigracoesAplicadas, string? ArquivoBackup);

/// <summary>
/// Abertura do banco local na inicialização (PDV 4.2, 32.2, 32.5): confere a integridade, apaga o marcador de
/// encerramento limpo (<c>encerramento.json</c>, <see cref="Backup.MarcadorEncerramento"/>: daqui em diante o app rodou
/// depois do backup de saída), faz backup antes de qualquer migração pendente (pela API de backup online do SQLite),
/// aplica as migrações e cria as linhas únicas. Com a integridade falha o marcador fica: a restauração automática do
/// backup de saída o confere (SYNC 22.1). Um banco com migrações que este executável não conhece (versão mais antiga
/// instalada por cima da nova) não é aberto (<see cref="BancoDeVersaoMaisNovaException"/>; I3).
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
        if (existia)
        {
            await VerificarIntegridadeAsync(db, ct);
            // Antes de apagar o marcador e de migrar: o banco de uma versão mais nova fica exatamente como estava.
            var conhecidas = db.Database.GetMigrations().ToHashSet(StringComparer.Ordinal);
            var desconhecidas = (await db.Database.GetAppliedMigrationsAsync(ct)).Where(m => !conhecidas.Contains(m)).ToList();
            if (desconhecidas.Count > 0)
            {
                throw new BancoDeVersaoMaisNovaException(desconhecidas);
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
        return new ResultadoInicializacao(!existia, pendentes, backup);
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

    private static async Task VerificarIntegridadeAsync(PdvDbContext db, CancellationToken ct)
    {
        try
        {
            var conexao = db.Database.GetDbConnection();
            await db.Database.OpenConnectionAsync(ct);
            await using var cmd = conexao.CreateCommand();
            cmd.CommandText = "PRAGMA integrity_check;";
            var resultado = (await cmd.ExecuteScalarAsync(ct))?.ToString();
            if (!string.Equals(resultado, "ok", StringComparison.OrdinalIgnoreCase))
            {
                throw new BancoCorrompidoException($"Banco local com falha de integridade: {resultado}");
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
