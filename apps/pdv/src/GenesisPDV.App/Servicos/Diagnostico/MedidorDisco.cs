using GenesisPDV.Data;

namespace GenesisPDV.App.Servicos.Diagnostico;

/// <summary>
/// Espaço do disco onde fica o banco local e o tamanho do que o caixa guarda (Painel de saúde, Sobre e o bloqueio de
/// abrir caixa com o disco quase cheio; Central do PDV, bloco G4; spec 32.2). Os testes trocam a medida do livre pelo
/// <c>ajustar</c> da composição (o disco de verdade do CI não fica com 150 MB). Nunca lança: o que não deu para medir é
/// nulo.
/// </summary>
public sealed class MedidorDisco(CaminhosPdv caminhos, Func<string, long?>? livre = null)
{
    /// <summary>Bytes livres no disco da pasta de dados (o do <c>pdv.db</c>); nulo sem como medir.</summary>
    public long? LivreBytes() => (livre ?? LivreDoSistema)(caminhos.PastaDados);

    /// <summary>O banco com o WAL e o SHM (o que o SQLite ocupa de verdade).</summary>
    public long TamanhoBanco() =>
        Tamanho(caminhos.ArquivoBanco) + Tamanho(caminhos.ArquivoBanco + "-wal") + Tamanho(caminhos.ArquivoBanco + "-shm");

    public long TamanhoLogs() => TamanhoPasta(caminhos.PastaLogs);

    public long TamanhoBackups() => TamanhoPasta(caminhos.PastaBackup);

    public static long? LivreDoSistema(string pasta)
    {
        try
        {
            var raiz = Path.GetPathRoot(Path.GetFullPath(pasta));
            return string.IsNullOrEmpty(raiz) ? null : new DriveInfo(raiz).AvailableFreeSpace;
        }
        catch (Exception e) when (e is IOException or ArgumentException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>"1,2 GB", "180 MB", "35 KB" (pt-BR).</summary>
    public static string Legivel(long bytes) => bytes switch
    {
        >= 1024L * 1024 * 1024 => string.Format(Core.Numeros.NumeroBr.Cultura, "{0:0.0} GB", bytes / (1024d * 1024 * 1024)),
        >= 1024L * 1024 => string.Format(Core.Numeros.NumeroBr.Cultura, "{0:0} MB", bytes / (1024d * 1024)),
        _ => string.Format(Core.Numeros.NumeroBr.Cultura, "{0:0} KB", Math.Ceiling(bytes / 1024d)),
    };

    private static long Tamanho(string arquivo)
    {
        try
        {
            return File.Exists(arquivo) ? new FileInfo(arquivo).Length : 0;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }

    private static long TamanhoPasta(string pasta)
    {
        try
        {
            return Directory.Exists(pasta)
                ? new DirectoryInfo(pasta).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length)
                : 0;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }
}

/// <summary>
/// O <c>PRAGMA integrity_check</c> da abertura (plano 4.1), guardado em memória pelo <c>ShellViewModel</c>: o Painel
/// mostra o resultado sem rodá-lo de novo (ele lê o arquivo inteiro). Com a integridade falha a abertura nem chega à
/// Central (vai à restauração do backup); fica registrado assim mesmo.
/// </summary>
public sealed class EstadoBanco
{
    /// <summary>Quando a abertura conferiu o banco existente (nulo: ainda não conferiu ou o banco é novo).</summary>
    public DateTimeOffset? ConferidoEm { get; private set; }

    /// <summary>A abertura criou o banco agora (não havia o que conferir).</summary>
    public bool BancoNovo { get; private set; }

    /// <summary>A abertura achou o banco com problema (o caixa foi à restauração).</summary>
    public string? Falha { get; private set; }

    public void Registrar(bool bancoNovo, DateTimeOffset agora)
    {
        BancoNovo = bancoNovo;
        ConferidoEm = bancoNovo ? null : agora;
        Falha = null;
    }

    public void RegistrarFalha(string mensagem) => Falha = mensagem;
}
