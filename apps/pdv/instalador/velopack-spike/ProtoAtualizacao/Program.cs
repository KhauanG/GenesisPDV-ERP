using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using Velopack;
using Velopack.Locators;

namespace GenesisPDV.Spike;

/// <summary>
/// Protótipo descartável do F3-B8 (README do PDV › decisão 100). Sem argumento, faz o papel do PDV abrindo: a
/// "migração" do banco simulado e, se ela falhar logo depois de uma atualização, a volta ao pacote anterior por decisão
/// do próprio app. <c>procurar --fonte &lt;pasta ou https&gt;</c> faz o papel do atualizador no login: manifesto assinado,
/// download, conferência e só então aplicar. <c>estado</c> mostra as pastas e o que está guardado. <c>mutex</c> confere
/// se o mutex do PDV de verdade (<c>Global\GenesisPDV.Instancia</c>) está tomado, para o critério (d).
/// </summary>
public static class Program
{
    public const string AppId = "GenesisPDV.Spike";
    private const string MutexPdv = @"Global\GenesisPDV.Instancia";

    public static async Task<int> Main(string[] args)
    {
        // O console do Windows (e o do Wine) não está em UTF-8 por padrão: sem isso os acentos do roteiro saem trocados.
        // Antes dos ganchos do Velopack, que já escrevem nele.
        Console.OutputEncoding = System.Text.Encoding.UTF8;

        // Antes de tudo (os ganchos do Velopack saem por aqui). Sem aplicar sozinho na abertura: o pacote que está na
        // pasta só é aplicado por este app, depois das conferências e na hora certa (o PDV: no login ou no fechamento).
        // Os ganchos rodam dentro do Run(), antes de o log existir: as linhas deles ficam guardadas e entram no spike.log
        // logo abaixo (a reabertura pelo Update.exe é a prova do critério (c) no roteiro do Windows).
        VelopackApp.Build()
            .SetAutoApplyOnStartup(false)
            .OnFirstRun(v => Registrar($"Primeira execução da {v} depois da instalação."))
            .OnRestarted(v => Registrar($"Reaberto pelo Velopack na {v}."))
            .Run();

        var estado = new EstadoLocal();
        DefinirLog(estado.Log);
        var comando = args.FirstOrDefault(a => !a.StartsWith("--", StringComparison.Ordinal)) ?? "iniciar";
        // --sem-pausa, ou a variável (herdada pelo Update.exe quando ele reabre o app), para o ensaio automático no Wine.
        var semPausa = args.Contains("--sem-pausa") || Environment.GetEnvironmentVariable("GENESIS_SPIKE_SEM_PAUSA") == "1";
        int codigo;
        try
        {
            codigo = comando switch
            {
                "iniciar" => Iniciar(estado),
                "procurar" => await ProcurarAsync(estado, Opcao(args, "--fonte")),
                "estado" => MostrarEstado(estado),
                "mutex" => ConferirMutex(),
                _ => Erro($"Comando desconhecido: {comando}. Use iniciar, procurar --fonte <pasta>, estado ou mutex."),
            };
        }
        catch (Exception ex)
        {
            codigo = Erro(ex.Message);
        }

        if (!semPausa && !Console.IsInputRedirected)
        {
            Console.WriteLine();
            Console.WriteLine("Pressione Enter para fechar.");
            Console.ReadLine();
        }
        return codigo;
    }

    private static string? _log;
    private static readonly List<string> LinhasAntesDoLog = [];

    /// <summary>Quantas vezes a volta é tentada (uma por abertura da versão que falhou) antes de pedir o suporte.</summary>
    private const int TentativasDaVolta = 3;

    private static SemanticVersion? VersaoInstalada => VelopackLocator.Current.CurrentlyInstalledVersion;

    private static string ChavePublica =>
        typeof(Program).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "SpikeChavePublica")?.Value ?? "nenhuma";

    /// <summary>O esquema do banco simulado que cada versão do roteiro espera (1.0.0 → 1, 1.0.1 → 2, 1.0.2 → 3).</summary>
    private static int EsquemaDaVersao(SemanticVersion versao) => versao.Patch + 1;

    private static int Iniciar(EstadoLocal estado)
    {
        var versao = VersaoInstalada;
        Registrar($"GenesisPDV.Spike {versao?.ToString() ?? "(fora do Velopack)"} abrindo.");
        if (versao is null)
            return Erro("Este exe não foi instalado pelo Setup do Velopack (rode o GenesisPDV.Spike-win-Setup.exe).");

        // A volta fica "em andamento" (com a atualização pendente e o backup) até a versão de destino abrir: só aí ela
        // está feita. Se a que falhou abriu de novo, o Update.exe não aplicou o pacote anterior (falta de energia entre o
        // fechamento e o apply, arquivo travado pelo antivírus, a chamada falhou): sem migrar, restaura o banco outra vez
        // e repete a volta.
        if (estado.Volta is { } volta)
        {
            if (volta.Para == versao.ToString())
            {
                Registrar($"VOLTA FEITA: a {volta.De} falhou ({volta.Motivo}) e o app voltou sozinho para a {volta.Para} em {volta.Em:dd/MM/yyyy HH:mm}. " +
                    $"A {volta.De} fica recusada neste computador até sair uma versão mais nova.");
                estado.Volta = null;
                estado.Pendente = null;
            }
            else if (volta.De == versao.ToString())
            {
                Registrar($"A volta para a {volta.Para} ainda não foi aplicada (a {versao} abriu de novo, depois de {volta.Tentativas} tentativa(s)).");
                return Voltar(estado, versao, volta.Motivo);
            }
            else
            {
                // Outra versão, instalada à mão por cima: a volta e a atualização desfeita já não valem para ela.
                Registrar($"Aviso: havia uma volta da {volta.De} para a {volta.Para} em andamento, mas a instalada é a {versao}: registro descartado.");
                estado.Volta = null;
                estado.Pendente = null;
            }
        }

        try
        {
            Migrar(estado, EsquemaDaVersao(versao));
        }
        catch (Exception ex) when (ex is not RecusaAtualizacaoException)
        {
            Registrar($"A migração do banco falhou na {versao}: {ex.Message}");
            return Voltar(estado, versao, ex.Message);
        }

        if (estado.Pendente is { } pendente && pendente.Para == versao.ToString())
        {
            Registrar($"ATUALIZADO: {pendente.De} → {pendente.Para}, banco no esquema {EsquemaDaVersao(versao)}.");
            estado.Pendente = null;
        }
        // Aberta sem erro: o pacote desta versão vai para a pasta própria já agora (a volta depende dele, e o Velopack
        // apaga da pasta dele o pacote instalado quando um download é recusado: CleanPackagesExcept no finally).
        GuardarAnterior(estado, versao);
        Registrar($"Pronto para vender (banco no esquema {EsquemaDaVersao(versao)}).");
        return 0;
    }

    /// <summary>A "migração": um arquivo de texto com o esquema. A 1.0.2 do roteiro grava pela metade e falha.</summary>
    private static void Migrar(EstadoLocal estado, int esquemaAlvo)
    {
        var atual = File.Exists(estado.Banco) ? int.Parse(File.ReadAllLines(estado.Banco)[0].Split('=')[1].Split('-')[0]) : 0;
        if (File.Exists(estado.Banco) && File.ReadAllText(estado.Banco).Contains("incompleto", StringComparison.Ordinal))
            throw new InvalidDataException($"banco danificado por uma migração interrompida ({estado.Banco})");
        if (atual > esquemaAlvo)
            throw new InvalidDataException($"o banco está no esquema {atual}, mais novo que o desta versão ({esquemaAlvo})");
        if (atual == esquemaAlvo)
            return;
#if FALHAR_MIGRACAO
        File.WriteAllText(estado.Banco, $"esquema={esquemaAlvo}-incompleto\nvendas=as do caixa\n");
        throw new InvalidOperationException($"falha simulada na migração para o esquema {esquemaAlvo} (pacote de teste)");
#else
        File.WriteAllText(estado.Banco, $"esquema={esquemaAlvo}\nvendas=as do caixa\n");
        Registrar($"Banco migrado do esquema {atual} para o {esquemaAlvo}.");
#endif
    }

    /// <summary>
    /// Critério (c): a volta é decidida aqui, pelo app, e só depois de uma falha de migração de uma versão que acabou de
    /// ser aplicada. Nenhum comando, argumento ou campo do manifesto pede volta. Restaura o banco do backup de antes da
    /// atualização, recusa a versão que falhou neste computador, confere o pacote anterior guardado (sha256 e mínima
    /// permitida) e o aplica pelo Update.exe do Velopack. A atualização pendente (com o backup) só sai depois que a versão
    /// de destino abrir (<see cref="Iniciar"/>): até lá a volta fica "em andamento" e se repete a cada abertura da versão
    /// que falhou, até <see cref="TentativasDaVolta"/> vezes.
    /// </summary>
    private static int Voltar(EstadoLocal estado, SemanticVersion versao, string motivo)
    {
        var pendente = estado.Pendente;
        if (pendente is null || pendente.Para != versao.ToString())
            return Erro("A migração falhou e não há atualização recente para desfazer: chame o suporte (nada foi mudado).");

        var voltaAnterior = estado.Volta is { } v && v.De == versao.ToString() ? v : null;
        var tentativa = (voltaAnterior?.Tentativas ?? 0) + 1;
        File.Copy(pendente.Backup, estado.Banco, overwrite: true);
        Registrar($"Banco restaurado do backup de antes da atualização ({pendente.Backup}).");
        estado.Recusar(versao.ToString());
        if (tentativa > TentativasDaVolta)
            return Erro($"A volta não foi aplicada em {TentativasDaVolta} tentativas: chame o suporte (o banco já foi restaurado, e a {versao} não migra enquanto a volta estiver pendente).");

        var anterior = estado.Anterior;
        var caminhoAnterior = anterior is null ? null : Path.Combine(estado.PastaAnterior, anterior.Arquivo);
        if (anterior is null || caminhoAnterior is null || !File.Exists(caminhoAnterior))
            return Erro("Não há pacote anterior guardado para voltar: chame o suporte (o banco já foi restaurado).");
        if (EstadoLocal.Sha256DoArquivo(caminhoAnterior) != anterior.Sha256)
            return Erro("O pacote anterior guardado não confere (sha256): chame o suporte (o banco já foi restaurado).");
        var versaoAnterior = SemanticVersion.Parse(anterior.Versao);
        if (estado.Piso is { } piso && versaoAnterior < SemanticVersion.Parse(piso))
            return Erro($"A volta para a {versaoAnterior} é proibida pela mínima permitida ({piso}): chame o suporte (o banco já foi restaurado).");

        // O Update.exe aplica o pacote passado em --package; se o arquivo não estiver na pasta de pacotes, o
        // UpdateExe.Apply simplesmente omite o --package e o Update.exe aplica o MAIS NOVO da pasta (a versão que
        // falhou). Por isso: tira da pasta tudo o que não é o anterior, copia o anterior e confere que ele está lá.
        var pastaPacotes = VelopackLocator.Current.PackagesDir
            ?? throw new InvalidOperationException("Pasta de pacotes do Velopack desconhecida.");
        foreach (var arquivo in Directory.EnumerateFiles(pastaPacotes, "*.nupkg"))
            File.Delete(arquivo);
        var destino = Path.Combine(pastaPacotes, anterior.Arquivo);
        File.Copy(caminhoAnterior, destino, overwrite: true);
        var pacote = VelopackAsset.FromNupkgNoChecksum(destino);
        if (!File.Exists(Path.Combine(pastaPacotes, pacote.FileName)) || pacote.Version != versaoAnterior)
            return Erro("O pacote anterior não ficou na pasta do Velopack com o nome esperado: chame o suporte.");

        // Em andamento, não feita: a pendente continua com o backup até a versão de destino abrir.
        estado.Volta = new RegistroVolta(versao.ToString(), versaoAnterior.ToString(), motivo,
            voltaAnterior?.Em ?? DateTimeOffset.Now, tentativa);
        Registrar($"Voltando para a {versaoAnterior} pelo pacote guardado (tentativa {tentativa} de {TentativasDaVolta}; o app fecha e reabre).");
        try
        {
#if FALHAR_MIGRACAO
            // Só no pacote de teste da migração que falha: o ensaio no Wine simula a volta que não chega a ser aplicada.
            if (Environment.GetEnvironmentVariable("GENESIS_SPIKE_FALHAR_VOLTA") == "1")
                throw new IOException("falha simulada ao aplicar o pacote anterior (ensaio)");
#endif
            new UpdateManager(new FonteAssinada(estado.Pasta, ChavePublica, AppId, estado)).ApplyUpdatesAndRestart(pacote);
        }
        catch (Exception ex)
        {
            return Erro($"A volta para a {versaoAnterior} não foi aplicada ({ex.Message}): na próxima abertura o app restaura o banco de novo e repete.");
        }
        return 0;
    }

    private static async Task<int> ProcurarAsync(EstadoLocal estado, string? fonte)
    {
        if (string.IsNullOrWhiteSpace(fonte))
            return Erro("Informe a fonte: procurar --fonte <pasta do feed> (no PDV ela vem fixa no build).");
        var versao = VersaoInstalada;
        if (versao is null)
            return Erro("Este exe não foi instalado pelo Setup do Velopack.");
        if (estado.Volta is { } volta)
            return Erro($"Há uma volta da {volta.De} para a {volta.Para} em andamento: abra o app (sem argumento) para concluí-la antes de procurar.");

        // Sem o pacote instalado na pasta do Velopack (um download recusado antes o apaga), não há delta: devolve a cópia
        // guardada, conferida pelo sha256, para a próxima atualização baixar só a diferença.
        DevolverBase(estado, versao);
        var origem = new FonteAssinada(fonte, ChavePublica, AppId, estado);
        var gerente = new UpdateManager(origem, new UpdateOptions { AllowVersionDowngrade = false });
        Registrar($"Procurando atualização em {fonte} (instalada: {versao}, canal {VelopackLocator.Current.Channel}).");

        UpdateInfo? atualizacao;
        try
        {
            atualizacao = await gerente.CheckForUpdatesAsync();
        }
        catch (Exception ex) when (ex is AssinaturaInvalidaException or RecusaAtualizacaoException or InvalidDataException)
        {
            return Erro($"RECUSADO antes de baixar: {ex.Message}");
        }
        if (atualizacao is null)
        {
            Registrar("Nenhuma versão mais nova (aceita pelo manifesto) na fonte.");
            return 0;
        }
        var alvo = atualizacao.TargetFullRelease;
        if (estado.Recusadas().Contains(alvo.Version.ToString()))
        {
            Registrar($"A {alvo.Version} falhou antes neste computador e fica recusada até sair uma mais nova.");
            return 0;
        }
        var manifesto = origem.ManifestoAceito!;

        // O pacote da versão instalada na pasta própria (já guardado na abertura; aqui, se faltou): é ele que a volta
        // aplica, e o Velopack apaga da pasta dele os pacotes que não são o baixado.
        GuardarAnterior(estado, versao);

        Registrar($"Baixando a {alvo.Version} ({(atualizacao.DeltasToTarget.Length > 0 ? $"{atualizacao.DeltasToTarget.Length} delta(s)" : "completo")}).");
        try
        {
            await gerente.DownloadUpdatesAsync(atualizacao);
        }
        catch (Exception ex)
        {
            return Erro($"RECUSADO no download: {ex.Message}");
        }

        // De novo, antes de aplicar, o completo que está na pasta do Velopack: o baixado tem o sha256 do manifesto; o
        // remontado pelos deltas (que o Velopack não confere contra o completo do feed) tem de ter exatamente os
        // arquivos assinados, cada um com o sha256 do manifesto.
        var baixado = Path.Combine(VelopackLocator.Current.PackagesDir!, alvo.FileName);
        var assinado = manifesto.Pacote(alvo.FileName);
        var conferencia = assinado is not null && File.Exists(baixado) ? ConferirCompleto(baixado, assinado) : "ausente";
        if (conferencia is not ("arquivo" or "conteudo"))
        {
            if (File.Exists(baixado))
                File.Delete(baixado);
            return Erro($"RECUSADO antes de aplicar: o pacote na pasta do Velopack não confere com o manifesto ({conferencia}).");
        }
        Registrar(conferencia == "arquivo"
            ? "Pacote completo conferido pelo sha256 do arquivo."
            : "Pacote remontado pelos deltas conferido arquivo por arquivo (o zip difere do completo publicado).");

        // Backup do banco antes de aplicar (no PDV: o backup da PDV 32.5 e o outbox gravado).
        var backup = Path.Combine(estado.PastaBackup, $"banco-{versao}-{DateTime.Now:yyyyMMddHHmmss}.txt");
        if (File.Exists(estado.Banco))
            File.Copy(estado.Banco, backup, overwrite: true);
        else
            File.WriteAllText(backup, "esquema=0\n");
        estado.Pendente = new AtualizacaoPendente(versao.ToString(), alvo.Version.ToString(), backup);
        Registrar($"Conferido ({assinado!.Sha256[..12]}…). Aplicando a {alvo.Version}: o app fecha e reabre.");
        gerente.ApplyUpdatesAndRestart(alvo);
        return 0;
    }

    /// <summary>"arquivo" (o sha256 do .nupkg é o assinado), "conteudo" (cada arquivo de dentro confere) ou o motivo da recusa.</summary>
    private static string ConferirCompleto(string caminho, PacoteManifesto assinado)
    {
        if (EstadoLocal.Sha256DoArquivo(caminho) == assinado.Sha256.ToLowerInvariant())
            return "arquivo";
        if (assinado.Conteudo is not { Count: > 0 } conteudo)
            return "sha256 diferente e sem a lista de arquivos assinada";
        using var zip = ZipFile.OpenRead(caminho);
        var nomes = zip.Entries.Select(e => e.FullName).ToList();
        if (nomes.Count != nomes.Distinct(StringComparer.Ordinal).Count())
            return "nome repetido dentro do pacote";
        if (nomes.Count != conteudo.Count)
            return "lista de arquivos diferente da assinada";
        foreach (var esperado in conteudo)
        {
            var entrada = zip.GetEntry(esperado.Arquivo);
            if (entrada is null)
                return $"falta o {esperado.Arquivo}";
            using var fluxo = entrada.Open();
            if (Convert.ToHexStringLower(SHA256.HashData(fluxo)) != esperado.Sha256.ToLowerInvariant())
                return $"o {esperado.Arquivo} difere do assinado";
        }
        return "conteudo";
    }

    private static void DevolverBase(EstadoLocal estado, SemanticVersion versao)
    {
        var anterior = estado.Anterior;
        var pastaPacotes = VelopackLocator.Current.PackagesDir;
        if (anterior is null || pastaPacotes is null || anterior.Versao != versao.ToString())
            return;
        var destino = Path.Combine(pastaPacotes, anterior.Arquivo);
        var origem = Path.Combine(estado.PastaAnterior, anterior.Arquivo);
        if (File.Exists(destino) || !File.Exists(origem) || EstadoLocal.Sha256DoArquivo(origem) != anterior.Sha256)
            return;
        File.Copy(origem, destino);
        Registrar($"Pacote da {versao} devolvido à pasta do Velopack (base para o delta).");
    }

    private static void GuardarAnterior(EstadoLocal estado, SemanticVersion versao)
    {
        if (estado.Anterior is { } guardado && guardado.Versao == versao.ToString()
            && File.Exists(Path.Combine(estado.PastaAnterior, guardado.Arquivo)))
            return;
        var pastaPacotes = VelopackLocator.Current.PackagesDir!;
        var instalado = VelopackLocator.Current.GetLocalPackages()
            .FirstOrDefault(p => p.Type == VelopackAssetType.Full && p.Version == versao);
        if (instalado is null)
        {
            Registrar($"Aviso: o pacote da {versao} não está na pasta do Velopack; a volta não terá para onde ir.");
            return;
        }
        foreach (var velho in Directory.EnumerateFiles(estado.PastaAnterior, "*.nupkg"))
            File.Delete(velho);
        var destino = Path.Combine(estado.PastaAnterior, instalado.FileName);
        File.Copy(Path.Combine(pastaPacotes, instalado.FileName), destino, overwrite: true);
        estado.Anterior = new PacoteAnterior(versao.ToString(), instalado.FileName, EstadoLocal.Sha256DoArquivo(destino));
        Registrar($"Pacote da {versao} guardado para a volta ({destino}).");
    }

    private static int MostrarEstado(EstadoLocal estado)
    {
        var l = VelopackLocator.Current;
        Registrar($"Versão instalada: {VersaoInstalada?.ToString() ?? "(fora do Velopack)"}; canal: {l.Channel}.");
        Registrar($"Pasta do app (Velopack): {l.RootAppDir}");
        Registrar($"Pacotes do Velopack: {l.PackagesDir} → {string.Join(", ", l.PackagesDir is { } p && Directory.Exists(p) ? Directory.EnumerateFiles(p, "*.nupkg").Select(Path.GetFileName) : [])}");
        Registrar($"Estado do protótipo: {estado.Pasta} (piso da mínima: {estado.Piso ?? "nenhum"}; recusadas: {string.Join(", ", estado.Recusadas())}; anterior: {estado.Anterior?.Versao ?? "nenhum"}; volta em andamento: {(estado.Volta is { } volta ? $"{volta.De} → {volta.Para}, {volta.Tentativas} tentativa(s)" : "nenhuma")}).");
        Registrar($"Dados: {estado.PastaDados} (banco: {(File.Exists(estado.Banco) ? File.ReadAllLines(estado.Banco)[0] : "ainda não criado")}).");
        Registrar($"Chave embutida: {(ChavePublica.Length > 40 ? ChavePublica[..40] + "…" : ChavePublica)}");
        return 0;
    }

    private static int ConferirMutex()
    {
        if (Mutex.TryOpenExisting(MutexPdv, out var aberto))
        {
            aberto.Dispose();
            Registrar($"O mutex {MutexPdv} existe: há um GenesisPDV aberto neste Windows (o do Inno ou o do Velopack).");
        }
        else
        {
            Registrar($"O mutex {MutexPdv} não existe: nenhum GenesisPDV aberto.");
        }
        return 0;
    }

    private static string? Opcao(string[] args, string nome)
    {
        var i = Array.IndexOf(args, nome);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    private static int Erro(string mensagem)
    {
        Registrar("ERRO: " + mensagem);
        return 1;
    }

    /// <summary>Liga o spike.log e grava nele as linhas registradas antes (as dos ganchos do Velopack).</summary>
    private static void DefinirLog(string caminho)
    {
        _log = caminho;
        foreach (var linha in LinhasAntesDoLog)
            GravarNoLog(linha);
        LinhasAntesDoLog.Clear();
    }

    private static void Registrar(string mensagem)
    {
        var linha = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {mensagem}";
        Console.WriteLine(linha);
        if (_log is null)
            LinhasAntesDoLog.Add(linha);
        else
            GravarNoLog(linha);
    }

    private static void GravarNoLog(string linha)
    {
        try
        {
            File.AppendAllText(_log!, linha + Environment.NewLine);
        }
        catch (IOException)
        {
            // o log é só para o roteiro; a tela já mostrou
        }
    }
}
