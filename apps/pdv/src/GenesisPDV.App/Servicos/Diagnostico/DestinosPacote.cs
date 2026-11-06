namespace GenesisPDV.App.Servicos.Diagnostico;

/// <summary>
/// Onde o pacote de suporte é salvo (Central do PDV, bloco G9; plano 4.6): um pendrive (a raiz da unidade removível) ou,
/// sem pendrive, a pasta <c>Documentos\GenesisPDV-suporte</c> deste computador.
/// </summary>
/// <param name="Nome">Como a tela mostra: "Pendrive E:\ (KINGSTON)" ou "Documentos › GenesisPDV-suporte".</param>
/// <param name="Pasta">O caminho completo (só no disco; a auditoria e a ocorrência gravam o tipo, não o caminho).</param>
/// <param name="Removivel">Pendrive (unidade removível); senão, a pasta do computador.</param>
public sealed record DestinoPacote(string Nome, string Pasta, bool Removivel)
{
    /// <summary>O tipo, para a auditoria e o manifesto: <c>pendrive</c> ou <c>documentos</c> (o caminho tem o perfil do Windows).</summary>
    public string Tipo => Removivel ? "pendrive" : "documentos";
}

/// <summary>Os lugares onde o pacote pode ser salvo agora (os testes trocam pelo <c>ajustar</c>).</summary>
public interface IDestinosPacote
{
    /// <summary>Os pendrives ligados e prontos, depois a pasta dos Documentos (sempre a última: nunca fica sem destino).</summary>
    IReadOnlyList<DestinoPacote> Listar();
}

/// <summary>
/// Os destinos de verdade: os pendrives prontos (<see cref="EhPendrive"/>) e a pasta <c>Documentos\GenesisPDV-suporte</c>
/// (criada na hora de gravar). Nunca lança: uma unidade que some no meio da leitura fica de fora.
/// </summary>
public sealed class DestinosPacoteSistema : IDestinosPacote
{
    public const string PastaDocumentos = "GenesisPDV-suporte";

    /// <summary>Onde o Linux monta o pendrive (o udisks em <c>/media/usuário</c> e <c>/run/media/usuário</c>; à mão, <c>/mnt</c>).</summary>
    private static readonly string[] MontagensLinux = ["/media/", "/run/media/", "/mnt/"];

    /// <summary>Os sistemas de arquivos de pendrive (FAT, exFAT, NTFS pelo driver do kernel ou pelo ntfs-3g, que é FUSE).</summary>
    private static readonly HashSet<string> FormatosPendrive = new(["vfat", "msdos", "exfat", "ntfs", "ntfs3", "fuseblk"], StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// A unidade é um pendrive. No Windows, a removível (<see cref="DriveType.Removable"/>; o HD ou o pendrive que o Windows
    /// vê como disco fixo não entra: o texto da aba diz para copiar dos Documentos). No Linux o .NET tira o tipo do sistema
    /// de arquivos, não do barramento: só o <c>vfat</c> vira <see cref="DriveType.Removable"/>, o <c>exfat</c> e o
    /// <c>ntfs</c> viram <see cref="DriveType.Fixed"/>, o <c>ntfs3</c> é <see cref="DriveType.Unknown"/> e o <c>fuseblk</c>
    /// do ntfs-3g é <see cref="DriveType.Network"/>. Então vale também a montagem sob <c>/media</c>, <c>/run/media</c> ou
    /// <c>/mnt</c> com um desses sistemas de arquivos (a raiz, o <c>/home</c> e o disco do sistema nunca estão lá).
    /// </summary>
    internal static bool EhPendrive(string raiz, DriveType tipo, string? formato, bool linux)
    {
        if (!linux)
        {
            return tipo == DriveType.Removable;
        }

        if (tipo is DriveType.Ram or DriveType.CDRom or DriveType.NoRootDirectory)
        {
            return false;
        }

        var naMontagem = MontagensLinux.Any(m => raiz.StartsWith(m, StringComparison.Ordinal) && raiz.Length > m.Length);
        return naMontagem && formato is not null && FormatosPendrive.Contains(formato);
    }

    public IReadOnlyList<DestinoPacote> Listar()
    {
        var destinos = new List<DestinoPacote>();
        try
        {
            foreach (var unidade in DriveInfo.GetDrives())
            {
                try
                {
                    var linux = OperatingSystem.IsLinux();
                    if (!unidade.IsReady || !EhPendrive(unidade.Name, unidade.DriveType, linux ? unidade.DriveFormat : null, linux))
                    {
                        continue;
                    }

                    var rotulo = string.IsNullOrWhiteSpace(unidade.VolumeLabel) ? string.Empty : $" ({unidade.VolumeLabel})";
                    destinos.Add(new DestinoPacote($"Pendrive {unidade.Name}{rotulo}", unidade.RootDirectory.FullName, true));
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    // O pendrive saiu enquanto a lista era lida: fica de fora (o F5 lê de novo).
                }
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Sem como listar as unidades: só a pasta dos Documentos.
        }

        destinos.Add(Documentos());
        return destinos;
    }

    /// <summary>A pasta <c>Documentos\GenesisPDV-suporte</c> (sem a pasta Documentos, a do perfil do usuário).</summary>
    public static DestinoPacote Documentos()
    {
        var documentos = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        if (string.IsNullOrWhiteSpace(documentos))
        {
            documentos = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        }

        return new DestinoPacote($"Documentos › {PastaDocumentos}", Path.Combine(documentos, PastaDocumentos), false);
    }
}
