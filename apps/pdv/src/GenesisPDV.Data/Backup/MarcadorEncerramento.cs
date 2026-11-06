using System.Text.Json;
using System.Text.Json.Serialization;

namespace GenesisPDV.Data.Backup;

/// <summary>Conteúdo do <c>encerramento.json</c>: o backup de saída e o sha256 dele (PDV 32.5; SYNC 22.1).</summary>
public sealed record Encerramento(
    [property: JsonPropertyName("arquivo")] string Arquivo,
    [property: JsonPropertyName("sha256")] string Sha256,
    [property: JsonPropertyName("feito_em")] DateTimeOffset FeitoEm);

/// <summary>
/// Marcador de encerramento limpo (PDV 32.5; SYNC 22.1, condição (c) da prova de que nada se perdeu): gravado fora do
/// banco, na pasta de dados (<c>%ProgramData%\GenesisPDV\dados\encerramento.json</c>), logo depois do backup de saída e
/// com o sha256 dele; apagado a cada inicialização logo depois do <c>integrity_check</c> bem-sucedido e antes de qualquer
/// venda (<see cref="InicializadorBanco"/>). Existir e conferir com o arquivo restaurado prova que o app não rodou depois
/// daquele backup — o que só acontece na restauração automática depois de um <c>integrity_check</c> falho.
/// </summary>
public static class MarcadorEncerramento
{
    public const string NomeArquivo = "encerramento.json";

    public static string Caminho(string pastaDados) => Path.Combine(pastaDados, NomeArquivo);

    /// <summary>Grava (substituindo) com escrita atômica: temporário e renomeação.</summary>
    public static void Gravar(string pastaDados, ResultadoBackup backup)
    {
        ArgumentNullException.ThrowIfNull(backup);
        Directory.CreateDirectory(pastaDados);
        var destino = Caminho(pastaDados);
        File.WriteAllText(destino + ".parcial", JsonSerializer.Serialize(new Encerramento(Path.GetFileName(backup.Arquivo), backup.Sha256, backup.FeitoEm)));
        File.Move(destino + ".parcial", destino, overwrite: true);
    }

    /// <summary>O marcador, se existir e for legível; nulo nos demais casos (ilegível vale como ausente).</summary>
    public static Encerramento? Ler(string pastaDados)
    {
        try
        {
            var arquivo = Caminho(pastaDados);
            return File.Exists(arquivo) ? JsonSerializer.Deserialize<Encerramento>(File.ReadAllText(arquivo)) : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    /// <summary>Apaga (idempotente).</summary>
    public static void Apagar(string pastaDados) => BackupLocal.ApagarSeExiste(Caminho(pastaDados));

    /// <summary>O marcador existe e é o do <paramref name="arquivo"/> (mesmo sha256): o backup de saída intacto.</summary>
    public static bool Confere(string pastaDados, string arquivo) =>
        Ler(pastaDados) is { } m && File.Exists(arquivo) && string.Equals(m.Sha256, BackupLocal.Sha256(arquivo), StringComparison.Ordinal);
}
