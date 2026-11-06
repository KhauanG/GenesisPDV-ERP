using GenesisPDV.Core.Comum;
using Microsoft.Data.Sqlite;

namespace GenesisPDV.Data.Tests;

/// <summary>Pasta temporária própria por teste, com um <c>pdv.db</c> novo; apagada no fim.</summary>
public sealed class BancoTemporario : IDisposable
{
    public BancoTemporario()
    {
        Raiz = Path.Combine(Path.GetTempPath(), "genesispdv-testes", Guid.NewGuid().ToString("N"));
        Caminhos = CaminhosPdv.SobRaiz(Raiz);
        Caminhos.CriarPastas();
        Fabrica = new FabricaPdvDb(Caminhos.ArquivoBanco);
    }

    public string Raiz { get; }
    public CaminhosPdv Caminhos { get; }
    public FabricaPdvDb Fabrica { get; }
    public IRelogio Relogio { get; } = new RelogioSistema();

    public Task<ResultadoInicializacao> InicializarAsync() =>
        InicializadorBanco.InicializarAsync(Fabrica, Caminhos.PastaBackup, Relogio.Agora, TestContext.Current.CancellationToken);

    public SqliteConnection AbrirConexao()
    {
        var conexao = new SqliteConnection(Fabrica.StringConexao);
        conexao.Open();
        PragmasSqlite.Aplicar(conexao);
        return conexao;
    }

    public object? Escalar(string sql)
    {
        using var conexao = AbrirConexao();
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = sql;
        return cmd.ExecuteScalar();
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try
        {
            Directory.Delete(Raiz, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // No Windows o arquivo pode seguir aberto por alguns ms (WAL/shm); a pasta fica no %TEMP%.
        }
    }
}
