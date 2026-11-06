using System.Runtime.InteropServices;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Protocolo;

namespace GenesisPDV.Sync.Ativacao;

/// <summary>Identificação desta máquina para o <c>maquina</c> da ativação (SYNC 3.2) e os cabeçalhos do protocolo (2.2).</summary>
/// <param name="Plataforma"><c>windows_x64</c> ou <c>linux_x64</c>.</param>
public sealed record MaquinaLocal(string NomeMaquina, string SistemaOperacional, string IdHardware, string VersaoApp, string Plataforma)
{
    /// <summary>Nome e sistema cortados nos limites da API (100 e 60 caracteres).</summary>
    public static MaquinaLocal Detectar(string pastaDados, string versaoApp) => new(
        Cortar(Environment.MachineName, 100),
        Cortar($"{RuntimeInformation.OSDescription} {RuntimeInformation.OSArchitecture}", 60),
        Ativacao.IdHardware.Atual(pastaDados),
        versaoApp,
        ClienteSyncHttp.PlataformaAtual());

    public MaquinaAtivacao ParaAtivacao(int versaoSchemaLocal) =>
        new(NomeMaquina, SistemaOperacional, IdHardware, VersaoApp, Plataforma, versaoSchemaLocal);

    public ConfiguracaoClienteSync ParaCliente() => new(VersaoApp, Plataforma, IdHardware);

    private static string Cortar(string texto, int maximo)
    {
        var limpo = texto.Trim();
        return limpo.Length <= maximo ? limpo : limpo[..maximo];
    }
}

/// <summary>
/// Conta do sistema que roda o PDV (implantação I3): gravada na ativação (<c>ativacao.conta</c>) para a tela de "ativado
/// com outra conta" dizer com qual entrar, já que a DPAPI CurrentUser e a chave local do Linux são da conta (D21).
/// Windows: <c>DOMÍNIO\usuário</c> (o domínio é o nome do computador numa conta local); Linux: o usuário.
/// </summary>
public static class ContaSistema
{
    public static string Atual() => OperatingSystem.IsWindows()
        ? $"{Environment.UserDomainName}\\{Environment.UserName}"
        : Environment.UserName;

    /// <summary>"Windows" ou "Linux", para os textos da tela.</summary>
    public static string Sistema => OperatingSystem.IsWindows() ? "Windows" : "Linux";
}

/// <summary>
/// Identificador do boot atual, gravado com a amostra de desvio do relógio (<c>estado_conexao.desvio_amostra_boot_id</c>,
/// SYNC 12.2): a amostra só vale para o mesmo boot. Calculado uma vez por processo (chamadas seguintes devolvem o mesmo
/// valor, mesmo que o relógio do SO seja corrigido no meio). Linux: <c>/proc/sys/kernel/random/boot_id</c>. Windows: o
/// contador de boots do sistema (<c>PrefetchParameters\BootId</c> no registro, <c>win:&lt;n&gt;</c>), que não depende do
/// relógio. Sem nenhum dos dois, o instante do boot (agora − tempo ligado) arredondado ao minuto mais próximo: a
/// correção de alguns segundos do relógio entre dois processos do mesmo boot quase nunca muda o minuto.
/// </summary>
public static class IdBoot
{
    private const string ChaveBootIdWindows = @"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters";

    private static readonly Lazy<string> Calculado = new(Calcular);

    public static string Atual() => Calculado.Value;

    /// <summary>Reserva sem fonte do sistema: <c>boot:yyyyMMddHHmm</c> do instante do boot arredondado ao minuto.</summary>
    public static string PorInstante(DateTimeOffset agoraUtc, long ligadoMs)
    {
        var boot = agoraUtc.ToUniversalTime() - TimeSpan.FromMilliseconds(ligadoMs);
        var minutos = (long)Math.Round(boot.UtcTicks / (double)TimeSpan.TicksPerMinute, MidpointRounding.AwayFromZero);
        var arredondado = new DateTimeOffset(minutos * TimeSpan.TicksPerMinute, TimeSpan.Zero);
        return "boot:" + arredondado.ToString("yyyyMMddHHmm", System.Globalization.CultureInfo.InvariantCulture);
    }

    private static string Calcular()
    {
        if (OperatingSystem.IsWindows())
        {
            try
            {
                if (Microsoft.Win32.Registry.GetValue(ChaveBootIdWindows, "BootId", null) is int contador)
                {
                    return "win:" + contador.ToString(System.Globalization.CultureInfo.InvariantCulture);
                }
            }
            catch (Exception e) when (e is System.Security.SecurityException or IOException or UnauthorizedAccessException)
            {
            }
        }
        else
        {
            try
            {
                var id = File.ReadAllText("/proc/sys/kernel/random/boot_id").Trim();
                if (id.Length > 0)
                {
                    return id;
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
            }
        }

        return PorInstante(DateTimeOffset.UtcNow, Environment.TickCount64);
    }
}
