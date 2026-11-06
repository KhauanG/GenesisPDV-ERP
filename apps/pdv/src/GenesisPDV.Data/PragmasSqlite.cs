using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace GenesisPDV.Data;

/// <summary>
/// PRAGMAs do PDV (4.2) em toda conexão aberta: WAL, <c>synchronous=FULL</c> (durável em queda de energia) e
/// <c>foreign_keys=ON</c>. <c>synchronous</c> e <c>foreign_keys</c> valem por conexão, por isso não basta na criação.
/// </summary>
public sealed class PragmasSqlite : DbConnectionInterceptor
{
    public const string Comando = "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;";

    public static readonly PragmasSqlite Instancia = new();

    public override void ConnectionOpened(DbConnection connection, ConnectionEndEventData eventData) => Aplicar(connection);

    public override async Task ConnectionOpenedAsync(DbConnection connection, ConnectionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = Comando;
        await cmd.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    public static void Aplicar(DbConnection connection)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = Comando;
        cmd.ExecuteNonQuery();
    }
}
