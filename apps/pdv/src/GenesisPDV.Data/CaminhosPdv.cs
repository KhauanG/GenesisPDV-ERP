namespace GenesisPDV.Data;

/// <summary>
/// Pastas do PDV (PDV 5.1). Windows: <c>%ProgramData%\GenesisPDV\…</c>; Linux: <c>/var/lib/genesispdv</c> e
/// <c>/var/log/genesispdv</c>. Com a variável <c>GENESISPDV_DADOS</c> (desenvolvimento e testes) tudo fica sob ela.
/// No Linux, se a pasta do sistema não for gravável (rodando sem o pacote instalado), usa a pasta do usuário.
/// </summary>
public sealed record CaminhosPdv(string PastaDados, string PastaBackup, string PastaLogs, string PastaImpressao)
{
    public const string VariavelAmbiente = "GENESISPDV_DADOS";

    /// <summary>
    /// Chave local de uma instalação Linux com conta de serviço (SYNC 3.6): 32 bytes, <c>0600</c>, dono <c>genesispdv</c>.
    /// O <c>.deb</c> do piloto não a gera (o caixa roda com a conta do operador e a chave fica por usuário, D21; README ›
    /// decisão 62); existindo, vale sobre a do usuário.
    /// </summary>
    public const string ArquivoChaveSistemaLinux = "/etc/genesispdv/chave_terminal";

    public string ArquivoBanco => Path.Combine(PastaDados, "pdv.db");

    /// <summary>
    /// Cache local das imagens do catálogo (Fase 2, F2-B45; SYNC 6.12): <c>&lt;sha256&gt;.webp</c>, nomes gerados pelo
    /// PDV. Fica sob a pasta de dados, fora do backup (que copia só o <c>pdv.db</c>), e é criada no primeiro download.
    /// </summary>
    public string PastaCacheImagens => Path.Combine(PastaDados, "cache", "imagens");

    /// <summary>
    /// Arquivo da chave local que protege o token e os segredos no Linux (SYNC 3.6; no Windows é a DPAPI e ele não é
    /// usado). Fica fora da pasta de dados, para uma cópia do <c>pdv.db</c> não levar a chave junto; sem o pacote
    /// instalado é criado na primeira ativação com <c>0600</c>.
    /// </summary>
    public string ArquivoChaveTerminal
    {
        get => string.IsNullOrEmpty(field)
            ? Path.Combine(Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(PastaDados)) ?? PastaDados, "chave", "chave_terminal")
            : field;
        init;
    }

    public static CaminhosPdv SobRaiz(string raiz) => new(
        Path.Combine(raiz, "dados"),
        Path.Combine(raiz, "backup"),
        Path.Combine(raiz, "logs"),
        Path.Combine(raiz, "impressao"))
    {
        ArquivoChaveTerminal = Path.Combine(raiz, "chave", "chave_terminal"),
    };

    public static CaminhosPdv Padrao()
    {
        var raiz = Environment.GetEnvironmentVariable(VariavelAmbiente);
        if (!string.IsNullOrWhiteSpace(raiz))
        {
            return SobRaiz(raiz);
        }

        if (OperatingSystem.IsWindows())
        {
            var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            var baseWin = Path.Combine(programData, "GenesisPDV");
            return new CaminhosPdv(
                Path.Combine(baseWin, "dados"),
                Path.Combine(baseWin, "backup"),
                Path.Combine(baseWin, "logs"),
                Path.Combine(baseWin, "impressao"));
        }

        const string baseLinux = "/var/lib/genesispdv";
        if (Gravavel(baseLinux) && Gravavel("/var/log/genesispdv"))
        {
            return new CaminhosPdv(baseLinux, Path.Combine(baseLinux, "backup"), "/var/log/genesispdv", Path.Combine(baseLinux, "impressao"))
            {
                ArquivoChaveTerminal = File.Exists(ArquivoChaveSistemaLinux) ? ArquivoChaveSistemaLinux : ChaveDoUsuario(),
            };
        }

        var usuario = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "genesispdv");
        return SobRaiz(usuario) with
        {
            ArquivoChaveTerminal = File.Exists(ArquivoChaveSistemaLinux) ? ArquivoChaveSistemaLinux : ChaveDoUsuario(),
        };
    }

    public void CriarPastas()
    {
        foreach (var pasta in new[] { PastaDados, PastaBackup, PastaLogs, PastaImpressao })
        {
            Directory.CreateDirectory(pasta);
        }
    }

    /// <summary><c>~/.config/genesispdv/chave_terminal</c> (ou <c>$XDG_CONFIG_HOME</c>): instalação sem o pacote.</summary>
    private static string ChaveDoUsuario() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "genesispdv", "chave_terminal");

    private static bool Gravavel(string pasta)
    {
        try
        {
            Directory.CreateDirectory(pasta);
            var teste = Path.Combine(pasta, $".teste-{Guid.NewGuid():N}");
            File.WriteAllText(teste, string.Empty);
            File.Delete(teste);
            return true;
        }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException)
        {
            return false;
        }
    }
}
