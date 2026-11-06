using System.Reflection;
using System.Text.RegularExpressions;
using GenesisPDV.App.Servicos;
using GenesisPDV.Data.Backup;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Hardware.Impressora;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Central do PDV, bloco G2 (plano 5.4; README › decisão 67): toda chave de <c>configuracao_terminal</c> é ou
/// <see cref="ChavesConfiguracaoTerminal.Internas"/> (nunca aparece) ou <see cref="ChavesExibiveis"/> (pode aparecer,
/// mascarada), nunca as duas e nunca nenhuma. Chave nova entra numa constante, na lista do teste e numa das duas listas.
/// </summary>
public sealed partial class ChavesTerminalTests
{
    /// <summary>Todas as chaves que o código grava em <c>configuracao_terminal</c>, pelas constantes de cada dono.</summary>
    private static IReadOnlySet<string> ChavesDoCodigo()
    {
        var internas = typeof(ChavesConfiguracaoTerminal).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f.IsLiteral && f.FieldType == typeof(string))
            .Select(f => (string)f.GetRawConstantValue()!);
        return new HashSet<string>(
            [
                .. internas, .. ChavesHardware.Todas, .. ChavesPreferencias.Todas, ServicoTema.Chave, ServicoParametrosLocais.ChaveBloqueioInatividade,
                BackupLocal.ChavePastaSecundaria,
            ],
            StringComparer.Ordinal);
    }

    [Fact]
    public void Exibiveis_e_internas_nao_se_cruzam_e_toda_chave_esta_em_uma_delas()
    {
        Assert.Empty(ChavesExibiveis.Todas.Intersect(ChavesConfiguracaoTerminal.Internas));
        var classificadas = new HashSet<string>(ChavesExibiveis.Todas.Concat(ChavesConfiguracaoTerminal.Internas), StringComparer.Ordinal);
        Assert.Equal(ChavesDoCodigo().Order(StringComparer.Ordinal), classificadas.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Exibiveis_repetem_os_textos_das_constantes_do_hardware_e_do_caixa()
    {
        // O Data não conhece o Hardware nem o App: a lista é de textos, e aqui eles batem com as constantes.
        Assert.Equal(ChavesHardware.Todas, ChavesExibiveis.Hardware);
        Assert.Equal(
            new[] { ServicoTema.Chave, ServicoParametrosLocais.ChaveBloqueioInatividade, BackupLocal.ChavePastaSecundaria }.Concat(ChavesPreferencias.Todas).Order(StringComparer.Ordinal),
            ChavesExibiveis.Caixa.Order(StringComparer.Ordinal));
        Assert.True(ChavesExibiveis.Exibivel(ChavesHardware.Modelo));
        Assert.False(ChavesExibiveis.Exibivel(ChavesConfiguracaoTerminal.BackupChave));
        Assert.False(ChavesExibiveis.Exibivel(ChavesConfiguracaoTerminal.ChavePrivadaTerminal));
        Assert.False(ChavesExibiveis.Exibivel("tela.chave_que_ninguem_classificou"));
    }

    [Fact]
    public void Nenhum_codigo_grava_ou_le_configuracao_do_terminal_com_a_chave_escrita_a_mao()
    {
        // A garantia do teste acima depende de a chave vir sempre de uma constante: um texto solto na chamada escaparia.
        var raiz = Path.Combine(PastaPdv(), "src");
        var achados = Directory.EnumerateFiles(raiz, "*.cs", SearchOption.AllDirectories)
            .Where(a => !a.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                        && !a.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .SelectMany(a => File.ReadLines(a).Select((linha, i) => (Arquivo: Path.GetRelativePath(raiz, a), Linha: i + 1, Texto: linha)))
            .Where(l => ChamadaComTexto().IsMatch(l.Texto))
            .Select(l => $"{l.Arquivo}:{l.Linha}: {l.Texto.Trim()}")
            .ToList();
        Assert.Empty(achados);
    }

    [Fact]
    public void Constante_com_cara_de_chave_do_terminal_esta_na_lista_do_teste()
    {
        // A lista de ChavesDoCodigo é fechada (as constantes dos donos conhecidos). Um serviço novo com a própria
        // constante ("tela.x") passaria pelas duas checagens acima sem nunca ser classificado: aqui toda constante de texto
        // com o prefixo de uma chave do terminal (tela., backup., impressora. …) tem de estar na lista.
        var conhecidas = ChavesDoCodigo();
        var prefixos = conhecidas.Select(c => c[..(c.IndexOf('.', StringComparison.Ordinal) + 1)]).Where(p => p.Length > 1).ToHashSet(StringComparer.Ordinal);
        var raiz = Path.Combine(PastaPdv(), "src");
        var soltas = Directory.EnumerateFiles(raiz, "*.cs", SearchOption.AllDirectories)
            .Where(a => !a.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                        && !a.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .SelectMany(a => ConstanteDeTexto().Matches(File.ReadAllText(a)).Select(m => (Arquivo: Path.GetRelativePath(raiz, a), Valor: m.Groups["valor"].Value)))
            .Where(c => prefixos.Any(p => c.Valor.StartsWith(p, StringComparison.Ordinal)) && !conhecidas.Contains(c.Valor))
            .Select(c => $"{c.Arquivo}: {c.Valor}")
            .ToList();
        Assert.Empty(soltas);
    }

    [GeneratedRegex("""\bconst\s+string\s+\w+\s*=\s*"(?<valor>[a-z_]+\.[a-z_.]+)"\s*;""")]
    private static partial Regex ConstanteDeTexto();

    [GeneratedRegex("""(?:(?:Obter|Gravar|Remover)Configuracao(?:es)?Async\s*(?:<[^>()]*>)?\(\s*\[?\s*"|LerConfiguracoesAsync\(\s*\[?\s*"|GravarConfiguracao\(\s*c\s*,\s*"|configuracao_terminal\s+WHERE\s+chave\s*=\s*'[a-z]|ConfiguracaoTerminal\b[^;]*\.Chave\s*==\s*")""", RegexOptions.IgnoreCase)]
    private static partial Regex ChamadaComTexto();

    /// <summary><c>apps/pdv</c>, subindo a partir da saída do teste até achar o <c>GenesisPDV.slnx</c>.</summary>
    internal static string PastaPdv()
    {
        for (var pasta = new DirectoryInfo(AppContext.BaseDirectory); pasta is not null; pasta = pasta.Parent)
        {
            if (File.Exists(Path.Combine(pasta.FullName, "GenesisPDV.slnx")))
            {
                return pasta.FullName;
            }
        }

        throw new InvalidOperationException("apps/pdv não encontrado acima da saída do teste.");
    }
}
