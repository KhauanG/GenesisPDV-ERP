using System.Runtime.InteropServices;

namespace GenesisPDV.Data;

/// <summary>
/// Linux com o <c>.deb</c> (implantação I3; README do PDV › decisão 62): <c>/var/lib/genesispdv</c> e
/// <c>/var/log/genesispdv</c> são <c>root:genesispdv 2770</c> e qualquer conta do grupo pode abrir o caixa. O setgid
/// passa o grupo aos arquivos novos, mas não a escrita: com a umask padrão (022 no Debian 12) o log do dia, o
/// <c>encerramento.json</c> e os backups sairiam <c>0644</c>, e o SQLite cria o <c>pdv.db</c> (e o <c>-wal</c>/<c>-shm</c>, que
/// copiam o modo do banco) com <c>0644</c> qualquer que seja a umask. A segunda conta passaria no teste da pasta e cairia
/// em "attempt to write a readonly database". Aqui: umask <c>007</c> no processo e <c>g+rw</c> nos arquivos do SQLite
/// numa pasta com escrita do grupo. No Windows não faz nada (a ACL herdada de <c>%ProgramData%\GenesisPDV</c> resolve).
/// </summary>
public static class PermissoesGrupo
{
    private const UnixFileMode LeituraEEscritaDoGrupo = UnixFileMode.GroupRead | UnixFileMode.GroupWrite;

    /// <summary>
    /// <c>umask(007)</c> no processo, antes de criar qualquer arquivo: o que o .NET e o Serilog criam sai com escrita do
    /// grupo e nada para os outros. Devolve a umask anterior (ou nulo no Windows).
    /// </summary>
    public static uint? AplicarUmask()
    {
        if (OperatingSystem.IsWindows())
        {
            return null;
        }

        return Umask(0b000_000_111);
    }

    /// <summary>
    /// <c>g+rw</c> em <paramref name="arquivo"/> e no <c>-wal</c>/<c>-shm</c> dele quando a pasta tem escrita do grupo (a
    /// pasta compartilhada do <c>.deb</c>; na pasta do usuário nada muda). Só o dono do arquivo pode mudar o modo: um
    /// arquivo de outra conta fica como está (a conta que o criou o liberou ao criar).
    /// </summary>
    public static void LiberarParaOGrupo(string arquivo)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        try
        {
            var pasta = Path.GetDirectoryName(Path.GetFullPath(arquivo));
            if (pasta is null || (File.GetUnixFileMode(pasta) & UnixFileMode.GroupWrite) == 0)
            {
                return;
            }

            foreach (var item in new[] { arquivo, arquivo + "-wal", arquivo + "-shm" })
            {
                if (File.Exists(item) && (File.GetUnixFileMode(item) & LeituraEEscritaDoGrupo) != LeituraEEscritaDoGrupo)
                {
                    File.SetUnixFileMode(item, File.GetUnixFileMode(item) | LeituraEEscritaDoGrupo);
                }
            }
        }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException)
        {
            // De outra conta (só o dono muda o modo) ou sumiu no meio: segue; quem criou já liberou.
        }
    }

    [DllImport("libc", EntryPoint = "umask", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
    private static extern uint Umask(uint mascara);
}
