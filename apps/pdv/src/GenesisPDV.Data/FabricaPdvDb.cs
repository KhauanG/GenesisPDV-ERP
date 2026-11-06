using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace GenesisPDV.Data;

/// <summary>Cria contextos para um arquivo <c>pdv.db</c>. Um contexto por operação (cada operação = uma transação).</summary>
public sealed class FabricaPdvDb(string caminhoBanco) : IDbContextFactory<PdvDbContext>
{
    public string CaminhoBanco { get; } = caminhoBanco;

    public string StringConexao => new SqliteConnectionStringBuilder
    {
        DataSource = CaminhoBanco,
        Mode = SqliteOpenMode.ReadWriteCreate,
        ForeignKeys = true,
        Pooling = true,
    }.ToString();

    public PdvDbContext CreateDbContext() => new(Opcoes(StringConexao));

    public static DbContextOptions<PdvDbContext> Opcoes(string stringConexao) =>
        new DbContextOptionsBuilder<PdvDbContext>()
            .UseSqlite(stringConexao, o => o.MigrationsHistoryTable("__ef_migracoes"))
            .AddInterceptors(PragmasSqlite.Instancia)
            .Options;
}

/// <summary>Usado só pelo <c>dotnet ef migrations add</c>.</summary>
public sealed class FabricaPdvDbDesignTime : IDesignTimeDbContextFactory<PdvDbContext>
{
    public PdvDbContext CreateDbContext(string[] args) => new FabricaPdvDb("design-time.db").CreateDbContext();
}
