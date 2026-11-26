using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GenesisPDV.Spike;

/// <summary>
/// O que o protótipo guarda fora da pasta do Velopack (o <c>%LocalAppData%\GenesisPDV.Spike</c>, que a desinstalação e a
/// troca de versão reescrevem): o piso da versão mínima permitida, as versões recusadas neste computador, o pacote
/// anterior guardado para a volta, a atualização pendente e a volta em andamento (a pendente, com o backup, só sai
/// quando a versão de destino da volta abre). Por usuário do Windows, como a instalação do Velopack.
/// O banco simulado e o backup ficam no <c>%ProgramData%</c>, como os do PDV (decisão 62).
/// </summary>
public sealed class EstadoLocal
{
    private static readonly JsonSerializerOptions Opcoes = new() { WriteIndented = true };

    public EstadoLocal(string? raizEstado = null, string? raizDados = null)
    {
        Pasta = raizEstado ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GenesisPDV.Spike.Estado");
        PastaDados = raizDados ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "GenesisPDV.Spike");
        Directory.CreateDirectory(Pasta);
        Directory.CreateDirectory(PastaAnterior);
        Directory.CreateDirectory(Path.Combine(PastaDados, "dados"));
        Directory.CreateDirectory(Path.Combine(PastaDados, "backup"));
        Directory.CreateDirectory(Path.Combine(PastaDados, "logs"));
    }

    public string Pasta { get; }
    public string PastaDados { get; }
    public string PastaAnterior => Path.Combine(Pasta, "anterior");
    public string Banco => Path.Combine(PastaDados, "dados", "banco.txt");
    public string PastaBackup => Path.Combine(PastaDados, "backup");
    public string Log => Path.Combine(PastaDados, "logs", "spike.log");

    /// <summary>A maior "versão mínima permitida" de um manifesto já aceito: um manifesto com mínima menor é antigo (repetição).</summary>
    public string? Piso
    {
        get => LerTexto("piso.txt");
        set => GravarTexto("piso.txt", value);
    }

    public HashSet<string> Recusadas() =>
        Ler<HashSet<string>>("recusadas.json") ?? new HashSet<string>(StringComparer.Ordinal);

    public void Recusar(string versao)
    {
        var lista = Recusadas();
        lista.Add(versao);
        Gravar("recusadas.json", lista);
    }

    public PacoteAnterior? Anterior
    {
        get => Ler<PacoteAnterior>("anterior.json");
        set => Gravar("anterior.json", value);
    }

    public AtualizacaoPendente? Pendente
    {
        get => Ler<AtualizacaoPendente>("pendente.json");
        set => Gravar("pendente.json", value);
    }

    public RegistroVolta? Volta
    {
        get => Ler<RegistroVolta>("volta.json");
        set => Gravar("volta.json", value);
    }

    public static string Sha256DoArquivo(string caminho)
    {
        using var arquivo = File.OpenRead(caminho);
        return Convert.ToHexStringLower(SHA256.HashData(arquivo));
    }

    private string? LerTexto(string nome)
    {
        var caminho = Path.Combine(Pasta, nome);
        return File.Exists(caminho) ? File.ReadAllText(caminho).Trim() : null;
    }

    private void GravarTexto(string nome, string? valor)
    {
        var caminho = Path.Combine(Pasta, nome);
        if (valor is null)
            File.Delete(caminho);
        else
            GravarAtomico(caminho, valor);
    }

    private T? Ler<T>(string nome)
        where T : class
    {
        var caminho = Path.Combine(Pasta, nome);
        return File.Exists(caminho) ? JsonSerializer.Deserialize<T>(File.ReadAllText(caminho)) : null;
    }

    private void Gravar<T>(string nome, T? valor)
        where T : class
    {
        var caminho = Path.Combine(Pasta, nome);
        if (valor is null)
            File.Delete(caminho);
        else
            GravarAtomico(caminho, JsonSerializer.Serialize(valor, Opcoes));
    }

    private static void GravarAtomico(string caminho, string conteudo)
    {
        var temporario = caminho + ".tmp";
        File.WriteAllText(temporario, conteudo);
        File.Move(temporario, caminho, overwrite: true);
    }
}

public sealed record PacoteAnterior(
    [property: JsonPropertyName("versao")] string Versao,
    [property: JsonPropertyName("arquivo")] string Arquivo,
    [property: JsonPropertyName("sha256")] string Sha256);

public sealed record AtualizacaoPendente(
    [property: JsonPropertyName("de")] string De,
    [property: JsonPropertyName("para")] string Para,
    [property: JsonPropertyName("backup")] string Backup);

public sealed record RegistroVolta(
    [property: JsonPropertyName("de")] string De,
    [property: JsonPropertyName("para")] string Para,
    [property: JsonPropertyName("motivo")] string Motivo,
    [property: JsonPropertyName("em")] DateTimeOffset Em,
    [property: JsonPropertyName("tentativas")] int Tentativas);
