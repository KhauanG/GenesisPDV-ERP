using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace GenesisPDV.Sync.Ativacao;

/// <summary>
/// <c>maquina.id_hardware</c> e <c>X-Genesis-Id-Hardware</c> (SYNC 3.2, 20.5): SHA-256 em hex minúsculo do
/// <c>MachineGuid</c> (Windows, <c>HKLM\SOFTWARE\Microsoft\Cryptography</c>) ou do <c>/etc/machine-id</c> (Linux).
/// O número de série da placa-mãe ("quando disponível") fica de fora: no Linux ele só é legível como root e no Windows
/// exige WMI, e um id que muda conforme o usuário que roda o PDV daria <c>409 HARDWARE_ALTERADO</c> falso.
/// </summary>
public static class IdHardware
{
    /// <summary>Arquivo com o id gerado pelo próprio PDV quando o sistema não tem um (contêiner, imagem sem machine-id).</summary>
    public const string ArquivoReserva = "id_maquina";

    /// <summary>Hash determinístico do id da máquina: maiúsculas, espaços e quebra de linha não mudam o resultado.</summary>
    public static string De(string idMaquina)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(idMaquina);
        var normalizado = idMaquina.Trim().ToLowerInvariant();
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(normalizado)));
    }

    /// <summary>
    /// Id desta máquina. Sem <c>MachineGuid</c>/<c>machine-id</c>, usa (e cria na primeira vez) um id aleatório em
    /// <paramref name="pastaDados"/>, para o valor não mudar entre execuções.
    /// </summary>
    public static string Atual(string pastaDados)
    {
        var bruto = LerIdMaquina() ?? LerOuCriarReserva(pastaDados);
        return De(bruto);
    }

    /// <summary>Id bruto do sistema operacional (também usado como sal da chave local no Linux), ou nulo.</summary>
    public static string? LerIdMaquina()
    {
        if (OperatingSystem.IsWindows())
        {
            return LerMachineGuid();
        }

        foreach (var arquivo in new[] { "/etc/machine-id", "/var/lib/dbus/machine-id" })
        {
            try
            {
                var texto = File.ReadAllText(arquivo).Trim();
                if (texto.Length > 0)
                {
                    return texto;
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
            }
        }

        return null;
    }

    [SupportedOSPlatform("windows")]
    private static string? LerMachineGuid()
    {
        // Visão de 64 bits: num processo de 32 bits a chave seria redirecionada para WOW6432Node (sem MachineGuid).
        using var raiz = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var chave = raiz.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
        return chave?.GetValue("MachineGuid") as string is { Length: > 0 } guid ? guid : null;
    }

    private static string LerOuCriarReserva(string pastaDados)
    {
        var arquivo = Path.Combine(pastaDados, ArquivoReserva);
        if (File.Exists(arquivo))
        {
            var existente = File.ReadAllText(arquivo).Trim();
            if (existente.Length > 0)
            {
                return existente;
            }
        }

        Directory.CreateDirectory(pastaDados);
        var novo = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
        File.WriteAllText(arquivo, novo);
        return novo;
    }
}
