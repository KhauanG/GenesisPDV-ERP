using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Backup;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// Os parâmetros do próprio caixa (PDV 6.2.2 e 6.8; Central do PDV, bloco G11): o tema, o bloqueio da tela por
/// inatividade e a pasta secundária do backup. Ficam em <c>configuracao_terminal</c>, só deste computador.
/// </summary>
/// <param name="Tema"><see cref="ServicoTema.Escuro"/> (padrão) ou <see cref="ServicoTema.Claro"/>.</param>
/// <param name="BloqueioInatividadeMin">
/// Minutos sem tecla nem mouse até a tela da venda se bloquear; 0 = nunca (o padrão: PC-13, desligado por padrão).
/// </param>
/// <param name="PastaSecundaria">
/// Pasta da cópia do backup (pendrive, outra pasta desta máquina ou uma pasta de rede, <c>\\servidor\…</c>, como a spec 6.2.2
/// prevê: o <see cref="BackupLocal"/> grava numa subpasta por terminal); nula = só a pasta do PDV.
/// </param>
public sealed record ParametrosCaixa(string Tema = ServicoTema.Escuro, int BloqueioInatividadeMin = 0, string? PastaSecundaria = null)
{
    public static ParametrosCaixa Padrao { get; } = new();
}

/// <summary>
/// Grava os parâmetros do caixa (Central do PDV, bloco G11; plano 4.5; PC-2 e PC-13; README › decisão 75) num commit com a
/// auditoria <c>editar</c> de <c>configuracao_terminal</c> (antes e depois só das chaves que mudaram; o mesmo padrão do
/// <see cref="ServicoHardware.GravarAsync(Hardware.Impressora.ConfiguracaoHardware, PreferenciasCaixa, Guid?, Guid?, CancellationToken)"/>),
/// e a ocorrência <c>PARAMETRO_ALTERADO</c> no <c>log_local</c>; a pasta vai para a auditoria (que sobe no lote) e para a
/// ocorrência já pelo <see cref="MascaradorSuporte"/> (o perfil do Windows no caminho vira <c>%USERPROFILE%</c>), e só a
/// <c>configuracao_terminal</c> guarda o caminho inteiro. Valida antes de gravar: o bloqueio de
/// <see cref="BloqueioMinimo"/> a <see cref="BloqueioMaximo"/> minutos (0 = desligado) e, <b>só quando ela muda</b>, a
/// pasta secundária com o caminho completo, fora das pastas do próprio PDV e com o <b>teste de escrita</b> (cria e apaga um
/// arquivo nela). O que se confere sem gravar nada também está no <see cref="PrepararAsync"/>, que a aba 7 chama antes do
/// PIN do supervisor. Quem edita na
/// Central precisa de <c>pdv.config.parametros_locais</c> (a própria ou o supervisor na hora, PDV 31.3: a liberação da
/// Central só empresta o ver). O tema (Ctrl+Alt+T na venda) continua sem permissão, mas passa por aqui e é auditado. As
/// regras da loja (<c>pdv.*</c>, <c>geral.*</c>) não se editam no PDV: só no ERP (PC-2).
/// </summary>
public sealed class ServicoParametrosLocais(
    RepositorioTerminal terminal, ServicoTema tema, CaminhosPdv caminhos, ILogger<ServicoParametrosLocais> log)
{
    /// <summary>Minutos sem uso até bloquear a tela da venda (PDV 6.2.2, 7.4); 0 = nunca. Número inteiro em JSON.</summary>
    public const string ChaveBloqueioInatividade = "tela.bloqueio_inatividade_min";

    public const int BloqueioMinimo = 0;
    public const int BloqueioMaximo = 120;

    public const string LocalizacaoCentral = "PDV › Central do PDV › Parâmetros";
    public const string LocalizacaoTema = "PDV › Venda › Ctrl+Alt+T";

    public const string MensagemSemPermissao =
        "Editar os parâmetros do caixa pede quem tem a permissão (pdv.config.parametros_locais): o supervisor libera na hora.";

    public const string MensagemNadaMudou = "Nada mudou: os parâmetros do caixa já estão assim.";

    /// <summary>O aviso da pasta secundária (plano 4.5): o backup é o banco inteiro, sem cifra (até a D41).</summary>
    public const string AvisoPastaSecundaria =
        "O backup contém o banco inteiro do caixa, sem cifra, com CPFs: use um pendrive guardado, uma pasta só desta máquina ou uma pasta de rede que só a loja acessa.";

    /// <summary>As três chaves, na ordem da tela.</summary>
    public static IReadOnlyList<string> Chaves { get; } = [ServicoTema.Chave, ChaveBloqueioInatividade, BackupLocal.ChavePastaSecundaria];

    public ParametrosCaixa Atual { get; private set; } = ParametrosCaixa.Padrao;

    /// <summary>O bloqueio por inatividade em vigor (nulo = desligado, o padrão).</summary>
    public TimeSpan? BloqueioInatividade => Atual.BloqueioInatividadeMin > 0 ? TimeSpan.FromMinutes(Atual.BloqueioInatividadeMin) : null;

    /// <summary>Os parâmetros mudaram (a tela da venda relê o bloqueio).</summary>
    public event EventHandler? Alterados;

    /// <summary>Na abertura do app: lê as três chaves (ilegível ou fora da faixa vale o padrão; nunca impede o caixa de abrir).</summary>
    public async Task CarregarAsync(CancellationToken ct = default)
    {
        try
        {
            Atual = Ler(await terminal.LerConfiguracoesAsync(Chaves, ct));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogError(e, "Parâmetros do caixa ilegíveis: valem os padrões");
            Atual = ParametrosCaixa.Padrao;
        }
    }

    /// <summary>Os parâmetros como estão no banco (a aba 7 lê de novo a cada visita).</summary>
    public async Task<ParametrosCaixa> LerAsync(CancellationToken ct = default) => Ler(await terminal.LerConfiguracoesAsync(Chaves, ct));

    /// <summary>
    /// Ctrl+Alt+T (PDV 6.8): troca o tema sem permissão (preferência visual), com a auditoria <c>editar</c>. Parte do que
    /// está no <b>banco</b>, não da memória, e muda só o <c>tela.tema</c>: se a leitura da abertura falhou (vale o padrão em
    /// memória), o bloqueio e a pasta secundária continuam como estão gravados, e a pasta que não mudou não é validada de
    /// novo (a gravada antes do G11, fora das regras de hoje, não impede a troca do tema). Na desativação (D22) a auditoria
    /// é recusada e o tema não troca (a mensagem da trava vai para a tela).
    /// </summary>
    public async Task AlternarTemaAsync(Guid? usuarioId, CancellationToken ct = default)
    {
        var atuais = await LerAsync(ct);
        await GravarSemPermissaoAsync(atuais with { Tema = atuais.Tema == ServicoTema.Claro ? ServicoTema.Escuro : ServicoTema.Claro },
            usuarioId, null, null, LocalizacaoTema, testarPasta: false, ct);
    }

    /// <summary>
    /// O que o F2 Salvar da aba 7 confere <b>antes</b> do PIN do supervisor, sem gravar nada (o supervisor não libera o que
    /// não vai gravar): os minutos na faixa, o "nada mudou" (lendo do banco) e, se a pasta mudou, a regra dela e a unidade
    /// presente (o pendrive ligado, o compartilhamento respondendo), só lendo o disco. O teste de escrita fica para o
    /// <see cref="GravarAsync"/>, que roda com a permissão (a própria ou a que o supervisor deu): a liberação Ctrl+L da
    /// Central só empresta o ver, e ver não grava arquivo em pasta nenhuma. Devolve as chaves que vão mudar.
    /// </summary>
    public async Task<IReadOnlyList<string>> PrepararAsync(ParametrosCaixa novos, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(novos);
        var (normalizados, _, mudaram) = await ConferirAsync(novos, ct);
        if (mudaram.Contains(BackupLocal.ChavePastaSecundaria) && normalizados.PastaSecundaria is { } pasta
            && await Task.Run(() => UnidadeAusente(pasta), ct) is { } erro)
        {
            throw new RegraNegocioException(erro);
        }

        return mudaram;
    }

    /// <summary>
    /// A aba 7 da Central grava: <paramref name="quem"/> com <c>pdv.config.parametros_locais</c> ou o supervisor que liberou
    /// na hora (<paramref name="liberacao"/>, com o motivo; ele fica no <c>autorizado_por_id</c>). Recusa o que não mudou.
    /// Devolve as chaves gravadas (a tela só diz "testada agora" quando a pasta estava entre elas).
    /// </summary>
    public Task<IReadOnlyList<string>> GravarAsync(ParametrosCaixa novos, Operador quem, LiberacaoConcedida? liberacao, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(novos);
        ArgumentNullException.ThrowIfNull(quem);
        if (!quem.Tem(PermissoesPdv.ParametrosLocais) && liberacao is null)
        {
            throw new RegraNegocioException(MensagemSemPermissao);
        }

        return GravarSemPermissaoAsync(novos, quem.Id, liberacao?.Supervisor.Id, liberacao?.Motivo, LocalizacaoCentral, testarPasta: true, ct);
    }

    /// <summary>
    /// A regra da pasta secundária, sem tocar no disco: vazia é "sem cópia"; senão o caminho completo (com a unidade no
    /// Windows, <c>E:\backup</c>; no Linux, <c>/media/…</c>), fora das pastas do PDV (dados, backup, logs, impressão e a
    /// pasta que as contém): a cópia no mesmo lugar do banco não protege de nada. Devolve a mensagem ou nulo.
    /// </summary>
    public string? ValidarPasta(string? pasta)
    {
        if (string.IsNullOrWhiteSpace(pasta))
        {
            return null;
        }

        var texto = pasta.Trim();
        if (texto.Length > 240)
        {
            return "Pasta secundária: o caminho passa de 240 caracteres.";
        }

        if (!Path.IsPathFullyQualified(texto))
        {
            return OperatingSystem.IsWindows()
                ? "Pasta secundária: informe o caminho completo, com a unidade (por exemplo E:\\backup-caixa)."
                : "Pasta secundária: informe o caminho completo (por exemplo /media/pendrive/backup-caixa).";
        }

        string completa;
        try
        {
            completa = Normalizar(texto);
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return $"Pasta secundária inválida ({e.Message}).";
        }

        var doPdv = new List<string> { caminhos.PastaDados, caminhos.PastaBackup, caminhos.PastaLogs, caminhos.PastaImpressao };
        var raiz = Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(Path.GetFullPath(caminhos.PastaDados)));
        if (raiz is not null && string.Equals(Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(Path.GetFullPath(caminhos.PastaBackup))), raiz, Comparacao))
        {
            // A pasta que contém dados/ e backup/ (%ProgramData%\GenesisPDV): também é do PDV.
            doPdv.Add(raiz);
        }

        return doPdv.Select(Normalizar).Any(p => Dentro(completa, p))
            ? "Pasta secundária: escolha uma pasta fora do GenesisPDV (a cópia na mesma pasta do banco não protege de nada): um pendrive, outra pasta desta máquina ou uma pasta de rede."
            : null;
    }

    /// <summary>
    /// "Testar pasta" (e antes de gravar uma pasta nova): a regra de <see cref="ValidarPasta"/> e, no disco, criar a pasta se
    /// faltar, gravar, ler e apagar um arquivo pequeno nela (fora da thread da tela). Devolve a mensagem ou nulo (funciona).
    /// </summary>
    public async Task<string?> TestarPastaAsync(string pasta, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(pasta))
        {
            return "Pasta secundária: informe a pasta para testar.";
        }

        if (ValidarPasta(pasta) is { } erro)
        {
            return erro;
        }

        var completa = Path.GetFullPath(pasta.Trim());
        return await Task.Run(() =>
        {
            var teste = Path.Combine(completa, $".genesispdv-teste-{Guid.NewGuid():N}.tmp");
            try
            {
                Directory.CreateDirectory(completa);
                var conteudo = $"GenesisPDV: teste de escrita da pasta secundária do backup ({DateTimeOffset.UtcNow:O}).";
                File.WriteAllText(teste, conteudo);
                return File.ReadAllText(teste) == conteudo ? null : "Pasta secundária: o arquivo de teste voltou diferente do gravado.";
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
            {
                // Mascarado: o caminho (e a mensagem do sistema, que o repete) pode trazer o perfil do Windows.
                return MascaradorSuporte.Mascarar(
                    $"Pasta secundária: não deu para gravar em {completa} ({e.Message}). Confira se o pendrive está ligado e se a pasta aceita gravação.");
            }
            finally
            {
                ApagarTeste(teste);
            }
        }, ct);
    }

    /// <summary>
    /// A conferência sem disco (do <see cref="PrepararAsync"/> e do gravar): normaliza, confere a faixa dos minutos, lê o
    /// que está no banco, recusa o que não mudou e, se a pasta mudou, aplica a regra dela (<see cref="ValidarPasta"/>).
    /// </summary>
    private async Task<(ParametrosCaixa Normalizados, ParametrosCaixa Antes, List<string> Mudaram)> ConferirAsync(ParametrosCaixa novos, CancellationToken ct)
    {
        var normalizados = novos with
        {
            Tema = novos.Tema == ServicoTema.Claro ? ServicoTema.Claro : ServicoTema.Escuro,
            PastaSecundaria = string.IsNullOrWhiteSpace(novos.PastaSecundaria) ? null : novos.PastaSecundaria.Trim(),
        };
        if (normalizados.BloqueioInatividadeMin is < BloqueioMinimo or > BloqueioMaximo)
        {
            throw new RegraNegocioException(
                $"Bloqueio da tela: de {BloqueioMinimo} a {BloqueioMaximo} minutos (0 = desligado).");
        }

        // Lê do banco (não da memória): duas telas não gravam por cima uma da outra com um "antes" velho.
        var antes = await LerAsync(ct);
        var depois = Escrever(normalizados);
        var anteriores = Escrever(antes);
        var mudaram = Chaves.Where(c => anteriores[c] != depois[c]).ToList();
        if (mudaram.Count == 0)
        {
            throw new RegraNegocioException(MensagemNadaMudou);
        }

        // Só a pasta que muda passa pela regra: a que já estava gravada (de antes do G11, pelo suporte) não trava o resto.
        if (mudaram.Contains(BackupLocal.ChavePastaSecundaria) && ValidarPasta(normalizados.PastaSecundaria) is { } erroPasta)
        {
            throw new RegraNegocioException(erroPasta);
        }

        return (normalizados, antes, mudaram);
    }

    private async Task<IReadOnlyList<string>> GravarSemPermissaoAsync(
        ParametrosCaixa novos, Guid? usuarioId, Guid? autorizadoPorId, string? motivo, string localizacao, bool testarPasta, CancellationToken ct)
    {
        var (normalizados, antes, mudaram) = await ConferirAsync(novos, ct);
        if (testarPasta && mudaram.Contains(BackupLocal.ChavePastaSecundaria) && normalizados.PastaSecundaria is { } pasta
            && await TestarPastaAsync(pasta, ct) is { } erroEscrita)
        {
            throw new RegraNegocioException(erroEscrita);
        }

        var depois = Escrever(normalizados);
        var auditoria = new LogAuditoriaLocal
        {
            Acao = "editar",
            Entidade = "configuracao_terminal",
            UsuarioId = usuarioId,
            AutorizadoPorId = autorizadoPorId,
            Motivo = motivo,
            Localizacao = localizacao,
            Descricao = "Parâmetros do caixa: " + string.Join("; ", mudaram.Select(c => Descrever(c, normalizados))),
            // A auditoria sobe no lote (o ERP a guarda): a pasta vai mascarada, o caminho inteiro fica só na configuração.
            Antes = Json(Escrever(Mascarado(antes)), mudaram),
            Depois = Json(Escrever(Mascarado(normalizados)), mudaram),
        };
        await terminal.GravarConfiguracoesAsync(mudaram.ToDictionary(c => c, c => depois[c], StringComparer.Ordinal), usuarioId, auditoria, ct);
        log.LogInformation("Parâmetros do caixa alterados: {Chaves}", string.Join(", ", mudaram));
        Atual = normalizados;
        if (mudaram.Contains(ServicoTema.Chave))
        {
            tema.Aplicar(normalizados.Tema);
        }

        Alterados?.Invoke(this, EventArgs.Empty);
        try
        {
            // Para a aba 5 da Central: "o bloqueio de tela foi ligado às 14:32". O antes e o depois ficam na auditoria.
            await terminal.RegistrarOcorrenciaAsync(NiveisOcorrencia.Info, CodigoOcorrencia.ParametroAlterado, auditoria.Descricao, ct: ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogError(e, "Falha ao registrar no log local os parâmetros do caixa gravados");
        }

        return mudaram;
    }

    /// <summary>A pasta pelo <see cref="MascaradorSuporte"/> (o que vai para a auditoria e para o <c>log_local</c>).</summary>
    private static ParametrosCaixa Mascarado(ParametrosCaixa p) => p with { PastaSecundaria = MascaradorSuporte.Mascarar(p.PastaSecundaria) };

    /// <summary>
    /// A unidade da pasta (a letra do pendrive, o <c>\\servidor\compartilhamento</c>) não está aqui agora; só lê o disco.
    /// No Linux a raiz é <c>/</c> e sempre existe: lá o teste de escrita do gravar é que diz.
    /// </summary>
    private static string? UnidadeAusente(string pasta)
    {
        try
        {
            var raiz = Path.GetPathRoot(Path.GetFullPath(pasta));
            return string.IsNullOrEmpty(raiz) || Directory.Exists(raiz)
                ? null
                : $"Pasta secundária: a unidade {raiz} não está disponível agora. Confira se o pendrive está ligado (ou se a rede responde) e tente de novo.";
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException or IOException or UnauthorizedAccessException)
        {
            return MascaradorSuporte.Mascarar($"Pasta secundária inválida ({e.Message}).");
        }
    }

    /// <summary>"bloqueio da tela em 10 min" (o que foi gravado, em português de balcão).</summary>
    private static string Descrever(string chave, ParametrosCaixa p) => chave switch
    {
        ServicoTema.Chave => $"tema {(p.Tema == ServicoTema.Claro ? "claro" : "escuro")}",
        ChaveBloqueioInatividade => p.BloqueioInatividadeMin == 0
            ? "bloqueio da tela por inatividade desligado"
            : string.Create(CultureInfo.InvariantCulture, $"bloqueio da tela depois de {p.BloqueioInatividadeMin} min sem uso"),
        _ => p.PastaSecundaria is { } pasta ? $"cópia do backup em {MascaradorSuporte.Mascarar(pasta)}" : "sem cópia do backup em pasta secundária",
    };

    /// <summary>Os valores em JSON (o que vai para <c>configuracao_terminal</c>).</summary>
    private static Dictionary<string, string> Escrever(ParametrosCaixa p) => new(StringComparer.Ordinal)
    {
        [ServicoTema.Chave] = JsonSerializer.Serialize(p.Tema),
        [ChaveBloqueioInatividade] = JsonSerializer.Serialize(p.BloqueioInatividadeMin),
        [BackupLocal.ChavePastaSecundaria] = JsonSerializer.Serialize(p.PastaSecundaria),
    };

    private static ParametrosCaixa Ler(IReadOnlyDictionary<string, string> valores)
    {
        var minutos = Valor<int?>(valores, ChaveBloqueioInatividade) is { } m and >= BloqueioMinimo and <= BloqueioMaximo ? m : 0;
        return new ParametrosCaixa(
            Valor<string>(valores, ServicoTema.Chave) == ServicoTema.Claro ? ServicoTema.Claro : ServicoTema.Escuro,
            minutos,
            Valor<string>(valores, BackupLocal.ChavePastaSecundaria) is { Length: > 0 } pasta ? pasta : null);
    }

    private static T? Valor<T>(IReadOnlyDictionary<string, string> valores, string chave)
    {
        if (!valores.TryGetValue(chave, out var json))
        {
            return default;
        }

        try
        {
            return JsonSerializer.Deserialize<T>(json);
        }
        catch (JsonException)
        {
            return default;
        }
    }

    private static string Json(Dictionary<string, string> valores, IEnumerable<string> chaves)
    {
        var objeto = new JsonObject();
        foreach (var chave in chaves)
        {
            objeto[chave] = JsonNode.Parse(valores[chave]);
        }

        return objeto.ToJsonString();
    }

    private static StringComparison Comparacao => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    private static string Normalizar(string pasta) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(pasta));

    /// <summary><paramref name="pasta"/> é <paramref name="pai"/> ou fica dentro dela.</summary>
    private static bool Dentro(string pasta, string pai) =>
        string.Equals(pasta, pai, Comparacao) || pasta.StartsWith(pai + Path.DirectorySeparatorChar, Comparacao);

    private static void ApagarTeste(string arquivo)
    {
        try
        {
            if (File.Exists(arquivo))
            {
                File.Delete(arquivo);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Preso (antivírus, pendrive saindo): é um arquivo pequeno com nome de teste; fica.
        }
    }
}
