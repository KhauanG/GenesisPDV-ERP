using System.Globalization;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Backup;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.Servicos.Diagnostico;

/// <summary>O pacote gerado: onde ficou, o tamanho, o SHA-256 do zip, o que tem dentro e os avisos (o que ficou de fora e por quê).</summary>
/// <param name="AvisoRegistro">O pacote foi gerado, mas a auditoria e a ocorrência não foram gravadas (D22, banco ocupado).</param>
public sealed record ResultadoPacote(
    string Arquivo, long Tamanho, string Sha256, IReadOnlyList<string> Conteudo, IReadOnlyList<string> Avisos, string? AvisoRegistro = null)
{
    public string Nome => Path.GetFileName(Arquivo);
}

/// <summary>
/// O pacote de suporte da Central do PDV (bloco G9; plano 4.6 e 5.4; decisões do dono de 04/11/2026: PC-12, pendrive
/// agora e o envio pelo ERP depois; README › decisão 76): um zip que o suporte entende sozinho e que <b>não tem segredo</b>.
/// Montado por <b>lista de permitidos</b> (<see cref="ArquivosPermitidos"/>): cada arquivo é gerado aqui, das consultas que
/// só leem o que ele leva (<see cref="ConsultasPacoteSuporte"/>), e todo texto passa pelo <see cref="MascaradorSuporte"/>
/// antes de entrar. <b>Nunca</b> entram o banco (<c>pdv.db</c>, <c>-wal</c>, <c>-shm</c>), os backups (<c>*.gz</c>), a
/// <c>chave_terminal</c>, as chaves internas do terminal (chave de backup, chave privada, token pendente, resumo da
/// ativação), o token protegido, os hashes de PIN, os payloads e o contexto do outbox, os bytes da impressão nem o
/// <c>encerramento.json</c>: nenhum é lido. O nome que não está na lista é recusado (<see cref="ExigirPermitido"/>).
/// Dois modos: o <b>completo</b> (aba P da Central, com <c>pdv.diagnostico.pacote_suporte</c>, a própria ou a emprestada
/// pelo Ctrl+L; grava a auditoria <c>exportar</c> e a ocorrência <c>PACOTE_GERADO</c>) e o <b>sem banco</b> (as telas de
/// erro fatal e de terminal bloqueado: sem login e sem abrir o banco, só o manifesto, os logs mascarados e o texto da tela).
/// Tudo fora da thread da tela; um pacote por vez; grava num arquivo <c>.parcial</c> e só no fim troca pelo nome certo
/// (o pendrive tirado no meio não deixa um zip pela metade com o nome de pronto).
/// O construtor pede só o que o modo sem banco usa (os caminhos, o relógio, a sessão, os destinos, o leitor do log e o
/// logger): o resto (a Central, o banco, o sync, o Painel de saúde, o backup) é pedido ao <paramref name="servicos"/> na
/// hora, dentro de cada parte do modo completo — a tela de erro fatal nasce justamente da falha de um desses, e o pacote
/// dela não pode depender deles. A restauração do backup suspende o pacote (<see cref="SuspenderParaRestauracaoAsync"/>):
/// nada lê nem grava no banco durante a troca.
/// </summary>
public sealed partial class ServicoPacoteSuporte(
    CaminhosPdv caminhos,
    IRelogio relogio,
    SessaoTerminal sessao,
    IDestinosPacote destinos,
    LeitorLogArquivo leitorLog,
    IServiceProvider servicos,
    ILogger<ServicoPacoteSuporte> log)
{
    /// <summary>A entidade da auditoria <c>exportar</c> (plano 4).</summary>
    public const string EntidadePacote = "pacote_suporte";

    public const string LocalizacaoCentral = "PDV › Central do PDV › Pacote de suporte";

    public const string MensagemSemPermissao =
        "O pacote de suporte pede quem pode gerá-lo (pdv.diagnostico.pacote_suporte): Ctrl+L Liberar.";

    public const string AvisoEntrega = "O pacote contém registros técnicos do caixa (sem senhas, chaves nem dados de clientes): entregue só ao suporte.";

    public const string Manifesto = "manifesto.json";
    public const string Saude = "saude.json";
    public const string StatusSync = "status-sync.json";
    public const string Outbox = "outbox.csv";
    public const string Comandos = "comandos.csv";
    public const string OcorrenciasCsv = "ocorrencias.csv";
    public const string ConfiguracaoTerminalJson = "configuracao-terminal.json";
    public const string ConfiguracoesEfetivas = "configuracoes-efetivas.json";
    public const string BackupsCsv = "backups.csv";
    public const string FilaImpressaoCsv = "fila-impressao.csv";
    public const string Disco = "disco.json";
    public const string AuditoriaResumo = "auditoria-resumo.csv";
    public const string DiagnosticoTxt = "diagnostico.txt";
    public const string PastaLogs = "logs/";

    /// <summary>Os dias do arquivo técnico (Serilog) que o pacote leva (plano 4.6).</summary>
    public const int DiasDeLog = 7;

    /// <summary>Os dias das ocorrências do <c>log_local</c> (plano 4.6).</summary>
    public const int DiasDeOcorrencias = 30;

    /// <summary>Os dias da contagem da auditoria (plano 4.6).</summary>
    public const int DiasDeAuditoria = 7;

    /// <summary>
    /// Quanto do arquivo técnico o pacote lê no máximo (o mais novo primeiro): sete dias normais cabem com folga (até 20 MB
    /// por arquivo, decisão 67); num laço de erro, os mais antigos ficam de fora e o manifesto diz quais.
    /// </summary>
    public const long OrcamentoLogs = 200L * 1024 * 1024;

    /// <summary>Um registro do log maior que isso (um laço que grava um texto enorme) é mascarado em pedaços.</summary>
    public const int MaximoRegistro = 4 * 1024 * 1024;

    /// <summary>Os arquivos que o pacote pode ter (fora os do <see cref="PastaLogs"/>, pelo nome do Serilog).</summary>
    public static IReadOnlySet<string> ArquivosPermitidos { get; } = new HashSet<string>(
        [
            Manifesto, Saude, StatusSync, Outbox, Comandos, OcorrenciasCsv, ConfiguracaoTerminalJson, ConfiguracoesEfetivas, BackupsCsv,
            FilaImpressaoCsv, Disco, AuditoriaResumo, DiagnosticoTxt,
        ],
        StringComparer.Ordinal);

    private static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static readonly UTF8Encoding Utf8ComBom = new(encoderShouldEmitUTF8Identifier: true);
    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    /// <summary>A restauração do backup começou: o que o pacote ainda leria do banco fica de fora (o aviso diz por quê).</summary>
    public const string MotivoRestauracao = "a restauração do backup começou (nada lê nem grava no banco durante a troca)";

    /// <summary>O fim de uma chave privada que nunca fechou no log (o registro gigante cortado sem o <c>-----END</c>).</summary>
    public const string MarcadorChaveSemFim = "[restante da chave privada omitido: o registro foi cortado antes do fim dela]";

    private readonly SemaphoreSlim _trava = new(1, 1);

    /// <summary>Uma leitura ou gravação do pacote no banco agora (a restauração espera a que está em curso).</summary>
    private readonly SemaphoreSlim _banco = new(1, 1);

    private volatile bool _suspenso;

    /// <summary>Um pacote sendo gerado agora (a tela diz "gerando…"; o segundo espera o primeiro).</summary>
    public bool Gerando => _trava.CurrentCount == 0;

    /// <summary>Suspenso para a restauração do backup: nenhuma parte do pacote lê nem grava no banco até o app reabrir.</summary>
    public bool Suspenso => _suspenso;

    /// <summary>A fila de um pacote por vez (os testes a seguram para simular o pacote grande em curso).</summary>
    internal SemaphoreSlim Trava => _trava;

    /// <summary>
    /// Antes de restaurar o backup (C17; junto do backup, do Painel de saúde e do sync): nenhuma parte do pacote lê nem
    /// grava no banco até o app reabrir, e espera a que está em curso por até <paramref name="espera"/> (a travada de vez
    /// não prende a restauração, como no Painel). O pacote em montagem segue com os logs e diz no manifesto o que ficou de
    /// fora; a auditoria e a ocorrência não são gravadas (o <see cref="ResultadoPacote.AvisoRegistro"/> diz).
    /// </summary>
    public async Task SuspenderParaRestauracaoAsync(TimeSpan? espera = null)
    {
        _suspenso = true;
        if (await _banco.WaitAsync(espera ?? VerificadorSaude.EsperaSuspensao))
        {
            _banco.Release();
        }
        else
        {
            log.LogWarning("Pacote de suporte ainda lendo o banco ao suspender para a restauração");
        }
    }

    /// <summary>Onde dá para salvar agora: os pendrives ligados e, por último, a pasta dos Documentos.</summary>
    public IReadOnlyList<DestinoPacote> Destinos() => destinos.Listar();

    /// <summary>O nome que está na lista de permitidos (e nada que pareça o banco ou um backup).</summary>
    public static bool Permitido(string nome)
    {
        ArgumentNullException.ThrowIfNull(nome);
        if (nome.Contains("..", StringComparison.Ordinal) || nome.Contains('\\', StringComparison.Ordinal) || Path.IsPathRooted(nome))
        {
            return false;
        }

        return ArquivosPermitidos.Contains(nome)
               || (nome.StartsWith(PastaLogs, StringComparison.Ordinal) && LogPermitido().IsMatch(nome[PastaLogs.Length..]));
    }

    /// <summary>Recusa o nome fora da lista (a segunda barreira: o pacote só gera os nomes dela).</summary>
    public static void ExigirPermitido(string nome)
    {
        if (!Permitido(nome))
        {
            throw new InvalidOperationException($"O arquivo \"{nome}\" não pode entrar no pacote de suporte.");
        }
    }

    /// <summary>
    /// O pacote completo (aba P): exige <c>pdv.diagnostico.pacote_suporte</c> de quem está na Central (a própria ou a
    /// emprestada pela liberação, com quem liberou no <c>autorizado_por_id</c>). A auditoria <c>exportar</c> e a ocorrência
    /// são melhor esforço: na D22 (o gatilho recusa a auditoria) ou com o banco ocupado, o pacote fica pronto e o
    /// <see cref="ResultadoPacote.AvisoRegistro"/> diz que não ficou no histórico.
    /// </summary>
    public async Task<ResultadoPacote> GerarAsync(DestinoPacote destino, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(destino);
        var acesso = Completo<AcessoCentral>();
        _ = Conferir(acesso);
        ResultadoPacote resultado;
        Operador usuario;
        Guid? autorizadoPor;
        await _trava.WaitAsync(ct);
        try
        {
            // De novo depois da espera: o pacote grande na frente pode ter levado minutos, e nesse meio-tempo a liberação do
            // Ctrl+L expirou ou a Central fechou — o pacote não sai em nome de quem já não libera.
            (usuario, autorizadoPor, var gerado) = Conferir(acesso);
            resultado = await Task.Run(() => MontarAsync(destino, gerado, null, null, ct), ct);
        }
        finally
        {
            _trava.Release();
        }

        log.LogInformation("Pacote de suporte gerado: {Arquivo} ({Bytes} bytes, sha256 {Sha256})", resultado.Nome, resultado.Tamanho, resultado.Sha256);
        // O zip já está no destino: o registro sai mesmo que a liberação acabe agora (sem o ct), para o histórico dizer a verdade.
        var aviso = await RegistrarAsync(resultado, destino, usuario.Id, autorizadoPor, CancellationToken.None);
        return resultado with { AvisoRegistro = aviso };
    }

    /// <summary>Quem está na Central, com a permissão (a própria ou a emprestada) e quem liberou.</summary>
    private static (Operador Usuario, Guid? AutorizadoPor, GeradoPor Gerado) Conferir(AcessoCentral acesso)
    {
        var usuario = acesso.Usuario ?? throw new RegraNegocioException(AcessoCentral.MensagemFechada);
        if (!acesso.Tem(PermissoesPdv.PacoteSuporte))
        {
            throw new RegraNegocioException(MensagemSemPermissao);
        }

        var autorizadoPor = acesso.AutorizadoPor(PermissoesPdv.PacoteSuporte);
        var liberador = autorizadoPor is not null ? acesso.Liberador?.Nome : null;
        return (usuario, autorizadoPor, new GeradoPor(usuario.Nome, liberador));
    }

    /// <summary>
    /// O pacote sem banco (as telas de erro fatal e de terminal bloqueado, sem login): só o manifesto (sem o "gerado por"),
    /// os logs mascarados e o <paramref name="texto"/> da tela, mascarado; <b>não abre o banco</b>. Com
    /// <paramref name="registrarNoBanco"/> (a tela de terminal bloqueado, onde o banco abriu), grava a ocorrência
    /// <c>PACOTE_GERADO</c> como melhor esforço (e lê a conta que ativou o caixa, só para escondê-la: a tela de "ativado
    /// com outra conta" a mostra); na de erro fatal, só o log de texto (o banco pode ser o problema).
    /// </summary>
    public async Task<ResultadoPacote> GerarSemBancoAsync(
        DestinoPacote destino, string titulo, string texto, bool registrarNoBanco = false, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(destino);
        ResultadoPacote resultado;
        await _trava.WaitAsync(ct);
        try
        {
            var conta = registrarNoBanco ? await ContaAtivacaoAsync(ct) : null;
            resultado = await Task.Run(() => MontarAsync(destino, null, (titulo, texto), conta, ct), ct);
        }
        finally
        {
            _trava.Release();
        }

        log.LogInformation("Pacote de suporte (sem banco) gerado: {Arquivo} ({Bytes} bytes, sha256 {Sha256})", resultado.Nome, resultado.Tamanho, resultado.Sha256);
        if (!registrarNoBanco)
        {
            return resultado;
        }

        const string semRegistro = "O pacote foi gerado, mas não ficou registrado nas ocorrências do caixa.";
        try
        {
            var gravou = await NoBancoAsync(async () =>
            {
                await using var db = await Completo<IDbContextFactory<PdvDbContext>>().CreateDbContextAsync(ct);
                db.LogLocal.Add(Ocorrencia(resultado, destino, semLogin: true));
                await db.SaveChangesAsync(ct);
                return true;
            }, ct);
            return gravou ? resultado : resultado with { AvisoRegistro = $"{semRegistro[..^1]}: {MotivoRestauracao}." };
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogWarning(e, "Pacote de suporte sem banco gerado sem a ocorrência no log local");
            return resultado with { AvisoRegistro = semRegistro };
        }
    }

    /// <summary>
    /// A conta do sistema que ativou o caixa (<c>ativacao.conta</c>, uma chave interna), lida <b>só para ser escondida</b>
    /// no pacote (vira <see cref="MascaradorSuporte.ContaAtivacao"/>); nula sem banco, sem a chave ou na restauração.
    /// </summary>
    private async Task<string?> ContaAtivacaoAsync(CancellationToken ct)
    {
        try
        {
            string? conta = null;
            await NoBancoAsync(async () =>
            {
                conta = await Completo<RepositorioTerminal>().ObterConfiguracaoAsync<string>(ChavesConfiguracaoTerminal.ContaAtivacao, ct);
                return true;
            }, ct);
            return conta;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogWarning(e, "Pacote de suporte: conta da ativação não lida");
            return null;
        }
    }

    /// <summary>
    /// Uma leitura ou gravação do pacote no banco: uma por vez com a restauração (que espera a em curso) e nenhuma depois
    /// que ela começou (devolve <c>false</c> sem rodar).
    /// </summary>
    private async Task<bool> NoBancoAsync(Func<Task<bool>> acao, CancellationToken ct)
    {
        await _banco.WaitAsync(ct);
        try
        {
            return !_suspenso && await acao();
        }
        finally
        {
            _banco.Release();
        }
    }

    /// <summary>Um serviço do modo completo, pedido na hora (o modo sem banco não depende de nenhum deles).</summary>
    private T Completo<T>() where T : notnull => servicos.GetRequiredService<T>();

    /// <summary>
    /// Monta o zip no <c>.parcial</c> e troca pelo nome certo no fim. <paramref name="semBanco"/> com o título e o texto da
    /// tela: o modo sem banco; nulo, o completo (<paramref name="gerado"/> é quem pediu). <paramref name="conta"/>: a conta
    /// que ativou o caixa, a esconder (o modo completo a lê aqui).
    /// </summary>
    private async Task<ResultadoPacote> MontarAsync(
        DestinoPacote destino, GeradoPor? gerado, (string Titulo, string Texto)? semBanco, string? conta, CancellationToken ct)
    {
        Directory.CreateDirectory(destino.Pasta);
        var agora = relogio.Agora;
        var fuso = DiaOperacional.ObterFuso(sessao.FusoHorario);
        var final = NomeLivre(destino.Pasta, NomeArquivo(agora, fuso));
        var parcial = Path.Combine(destino.Pasta, $".{Path.GetFileName(final)}.parcial");
        var avisos = new List<string>();
        if (semBanco is null)
        {
            conta = await ContaAtivacaoAsync(ct);
        }

        List<string> conteudo;
        try
        {
            await using (var arquivo = new FileStream(parcial, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                using var pacote = new MontadorPacote(arquivo, conta);
                IdentidadePacote? identidade = null;
                IReadOnlyList<string>? migracoes = null;
                if (semBanco is { } tela)
                {
                    pacote.Texto(DiagnosticoTxt, TextoDiagnostico(tela.Titulo, tela.Texto, agora, fuso));
                }
                else
                {
                    identidade = await Secao(avisos, "identidade do terminal", () => Completo<ConsultasPacoteSuporte>().IdentidadeAsync(ct), ct);
                    migracoes = await Secao(avisos, "versão do banco", async () =>
                    {
                        await using var db = await Completo<IDbContextFactory<PdvDbContext>>().CreateDbContextAsync(ct);
                        return (IReadOnlyList<string>)[.. await db.Database.GetAppliedMigrationsAsync(ct)];
                    }, ct);
                    await EscreverCompletoAsync(pacote, agora, fuso, avisos, ct);
                }

                EscreverLogs(pacote, agora, avisos, conta, ct);
                pacote.Texto(Manifesto, ManifestoJson(pacote, agora, fuso, gerado, identidade, migracoes, avisos, semBanco is not null), registrar: false);
                conteudo = [.. pacote.Nomes];
            }

            File.Move(parcial, final);
        }
        catch
        {
            TentarApagar(parcial);
            throw;
        }

        var tamanho = new FileInfo(final).Length;
        string sha;
        await using (var leitura = File.OpenRead(final))
        {
            sha = Convert.ToHexStringLower(await SHA256.HashDataAsync(leitura, ct));
        }

        return new ResultadoPacote(final, tamanho, sha, conteudo, avisos);
    }

    /// <summary>Os arquivos do modo completo; cada um à parte: o que falha vira um aviso no manifesto e o resto entra.</summary>
    private async Task EscreverCompletoAsync(MontadorPacote pacote, DateTimeOffset agora, TimeZoneInfo fuso, List<string> avisos, CancellationToken ct)
    {
        string? Hora(DateTimeOffset? q) => FormatarHora(q, fuso);

        // Painel de saúde (G4): a rodada completa (as 12, 2 s cada, em paralelo); suspensa (restauração), a última.
        var resultadoSaude = await Secao(avisos, Saude, () => Completo<VerificadorSaude>().VerificarAsync(completa: true, ct), ct);
        if (resultadoSaude is not null)
        {
            pacote.Json(Saude, new JsonObject
            {
                ["verificado_em"] = Hora(resultadoSaude.VerificadoEm),
                ["problemas"] = resultadoSaude.Problemas,
                ["avisos"] = resultadoSaude.Avisos,
                ["itens"] = new JsonArray([.. resultadoSaude.Itens.Select(i => (JsonNode)new JsonObject
                {
                    ["codigo"] = i.Codigo,
                    ["nome"] = i.Nome,
                    ["nivel"] = i.Nivel.ToString().ToLowerInvariant(),
                    ["frase"] = M(i.Frase),
                    ["o_que_fazer"] = M(i.OQueFazer),
                })]),
            });
        }

        // Sincronização (F11 › S, aba 4): a situação do ciclo, o status detalhado e a contagem do outbox.
        var outbox = await Secao(avisos, Outbox, () => Completo<ConsultasPacoteSuporte>().OutboxAsync(ct: ct), ct);
        await Secao(avisos, StatusSync, async () =>
        {
            StatusDetalhadoSync status;
            await using (var db = await Completo<IDbContextFactory<PdvDbContext>>().CreateDbContextAsync(ct))
            {
                status = await StatusDetalhadoSync.LerAsync(db, ct);
            }

            var recusados = await Completo<ConsultasSincronizacaoLocal>().ContagemRecusadosAsync(ct);
            var s = Completo<IServicoSincronizacao>().Situacao;
            pacote.Json(StatusSync, new JsonObject
            {
                ["situacao"] = new JsonObject
                {
                    ["online"] = s.Online,
                    ["sem_nuvem"] = s.SemNuvem,
                    ["terminal"] = s.Terminal.ToString(),
                    ["sincronizando"] = s.Sincronizando,
                    ["pendentes"] = s.Pendentes,
                    ["rejeitados"] = s.Rejeitados,
                    ["offline_desde"] = Hora(s.OfflineDesde),
                    ["ultimo_pull_sucesso_em"] = Hora(s.UltimoPullSucessoEm),
                    ["bloqueio_nuvem"] = s.BloqueioNuvem,
                    ["confirmando_desativacao"] = s.ConfirmandoDesativacao,
                    ["lacuna"] = s.Lacuna is { } l ? $"{l.Faixa}{(l.Recuperavel ? " (recuperável)" : string.Empty)}" : null,
                    ["ultimo_erro"] = M(s.Erro),
                },
                ["ultimo_pull_sucesso_em"] = Hora(status.UltimoPullSucessoEm),
                ["ultimo_push_sucesso_em"] = Hora(status.UltimoPushSucessoEm),
                ["ultimo_heartbeat_em"] = Hora(status.UltimoHeartbeatEm),
                ["desvio_relogio_ms"] = status.DesvioRelogioMs,
                ["cursores"] = new JsonArray([.. status.Cursores.Select(c => (JsonNode)new JsonObject
                {
                    ["fluxo"] = c.Fluxo,
                    ["cursor"] = c.Cursor,
                    ["ultimo_pull_sucesso_em"] = Hora(c.UltimoPullSucessoEm),
                    ["ultimo_erro"] = M(c.UltimoErro),
                })]),
                ["pendentes_por_tipo"] = new JsonObject([.. status.PendentesPorTipo.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))]),
                ["recusados_sem_decisao"] = recusados.SemDecisao,
                ["recusados_descartados_no_erp"] = recusados.Descartados,
                ["quarentena"] = new JsonArray([.. status.Quarentena.Select(q => (JsonNode)new JsonObject
                {
                    ["sequencia"] = q.Sequencia,
                    ["tipo"] = q.Tipo,
                    ["ocorrido_em"] = Hora(q.OcorridoEm),
                    ["erro"] = M(q.Erro),
                })]),
                ["fila_impressao_pendente"] = status.FilaImpressao,
                ["outbox_por_situacao"] = outbox is null
                    ? null
                    : new JsonObject([.. outbox.PorSituacao.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))]),
            });
            return true;
        }, ct);

        if (outbox is not null)
        {
            pacote.Csv(Outbox,
                ["id", "sequencia", "tipo", "agregado_tipo", "agregado_id", "situacao", "descartado_no_erp", "tentativas", "ocorrido_em", "criado_em", "enviado_em",
                    "proxima_tentativa_em", "confirmado_em", "lote_envio_id", "ultimo_erro", "dependencias"],
                outbox.Eventos.Select(e => new[]
                {
                    e.Id.ToString(), Num(e.Sequencia), e.Tipo, e.AgregadoTipo, e.AgregadoId.ToString(), e.Status, e.Descartado ? "sim" : "não", Num(e.Tentativas),
                    Hora(e.OcorridoEm), Hora(e.CriadoEm), Hora(e.EnviadoEm), Hora(e.ProximaTentativaEm), Hora(e.ConfirmadoEm), e.LoteEnvioId?.ToString(),
                    M(e.UltimoErro), M(e.Dependencias),
                }));
            if (outbox.ConfirmadosTotal > ConsultasPacoteSuporte.ConfirmadosLevados)
            {
                avisos.Add($"{Outbox}: só os {ConsultasPacoteSuporte.ConfirmadosLevados} confirmados mais novos de {outbox.ConfirmadosTotal} (o resto já está na nuvem).");
            }

            // Os não confirmados vão todos até o limite por situação (semanas sem internet passam dele): o corte é dito.
            foreach (var (situacao, total) in outbox.PorSituacao)
            {
                if (situacao != StatusEventoSaida.Confirmado && total > ConsultasPacoteSuporte.LimiteNaoConfirmados)
                {
                    avisos.Add($"{Outbox}: só os {ConsultasPacoteSuporte.LimiteNaoConfirmados} mais antigos de {total} na situação {situacao} (a contagem toda está no {StatusSync}).");
                }
            }
        }

        await Secao(avisos, Comandos, async () =>
        {
            var (lista, quantidade) = await Completo<ConsultasSincronizacaoLocal>().ComandosAsync(ct);
            pacote.Csv(Comandos, ["id", "tipo", "recebido_em", "situacao", "resultado"],
                lista.Select(c => new[] { c.Id.ToString(), M(c.Tipo), Hora(c.RecebidoEm), c.Status, MascaradorSuporte.MascararDetalhes(c.Resultado) }));
            if (quantidade > lista.Count)
            {
                avisos.Add($"{Comandos}: os {lista.Count} mais novos de {quantidade}.");
            }

            return true;
        }, ct);

        await Secao(avisos, OcorrenciasCsv, async () =>
        {
            var lista = await Completo<ConsultasPacoteSuporte>().OcorrenciasAsync(agora.AddDays(-DiasDeOcorrencias), ct);
            // O detalhe valor a valor (o texto técnico escapado no JSON, decisão 73), a mensagem como texto.
            pacote.Csv(OcorrenciasCsv, ["id", "ocorrido_em", "nivel", "origem", "codigo", "mensagem", "detalhes"],
                lista.Select(o => new[]
                {
                    Num(o.Id), Hora(o.OcorridoEm), o.Nivel, o.Origem, o.Codigo, M(o.Mensagem), MascaradorSuporte.MascararDetalhes(o.Detalhes),
                }));
            if (lista.Count >= ConsultasPacoteSuporte.LimiteOcorrencias)
            {
                avisos.Add($"{OcorrenciasCsv}: só as {ConsultasPacoteSuporte.LimiteOcorrencias} mais novas dos últimos {DiasDeOcorrencias} dias.");
            }

            return true;
        }, ct);

        await Secao(avisos, ConfiguracaoTerminalJson, async () =>
        {
            var linhas = await Completo<ConsultasPacoteSuporte>().ConfiguracaoTerminalAsync(ct);
            var objeto = new JsonObject();
            foreach (var (chave, valor, atualizado) in linhas)
            {
                // A lista de permitidos de novo (a consulta já filtra no SQL): chave fora dela nunca entra.
                if (ChavesExibiveis.Exibivel(chave))
                {
                    objeto[chave] = new JsonObject { ["valor"] = ValorMascarado(valor), ["atualizado_em"] = Hora(atualizado) };
                }
            }

            pacote.Json(ConfiguracaoTerminalJson, objeto);
            return true;
        }, ct);

        await Secao(avisos, ConfiguracoesEfetivas, async () =>
        {
            var chaves = CatalogoRotulosConfiguracao.Todos.Select(r => r.Chave).ToList();
            var valores = await Completo<RepositorioConfiguracoes>().ValoresEfetivosAsync(chaves, sessao.Identidade?.LojaId ?? Guid.Empty, ct);
            var pull = await Completo<RepositorioConfiguracoes>().UltimoPullAsync(ct);
            pacote.Json(ConfiguracoesEfetivas, new JsonObject
            {
                ["ultimo_pull"] = Hora(pull),
                ["regras"] = new JsonArray([.. valores.Select(v =>
                {
                    var exibida = CatalogoRotulosConfiguracao.Exibir(CatalogoRotulosConfiguracao.De(v.Chave)!, v);
                    return (JsonNode)new JsonObject
                    {
                        ["chave"] = v.Chave,
                        ["rotulo"] = exibida.Rotulo,
                        ["valor"] = M(exibida.Valor),
                        ["valor_json"] = v.Valor is null ? null : ValorMascarado(v.Valor),
                        ["origem"] = v.Origem.ToString().ToLowerInvariant(),
                        ["atualizado_em"] = Hora(v.AtualizadoEm),
                        ["valor_invalido"] = exibida.ValorInvalido,
                    };
                })]),
            });
            return true;
        }, ct);

        await Secao(avisos, BackupsCsv, async () =>
        {
            var arquivos = await Completo<BackupLocal>().ListarAsync(ct);
            pacote.Csv(BackupsCsv, ["nome", "feito_em", "motivo", "tamanho_bytes", "local"],
                arquivos.Select(a => new[] { a.Nome, Hora(a.FeitoEm), MotivosBackup.Rotulo(a.Motivo), Num(a.Tamanho), a.NaSecundaria ? "pasta secundária" : "pasta do PDV" }));
            return true;
        }, ct);

        await Secao(avisos, FilaImpressaoCsv, async () =>
        {
            var fila = await Completo<ConsultasPacoteSuporte>().FilaImpressaoAsync(ct);
            pacote.Csv(FilaImpressaoCsv,
                ["id", "tipo", "referencia_id", "impressora", "vias", "situacao", "tentativas", "ultimo_erro", "criado_em", "impresso_em"],
                fila.Select(f => new[]
                {
                    f.Id.ToString(), f.TipoDocumento, f.ReferenciaId?.ToString(), f.Impressora, Num(f.Vias), f.Status, Num(f.Tentativas), M(f.UltimoErro),
                    Hora(f.CriadoEm), Hora(f.ImpressoEm),
                }));
            return true;
        }, ct);

        await Secao(avisos, Disco, () =>
        {
            var disco = Completo<MedidorDisco>();
            pacote.Json(Disco, new JsonObject
            {
                ["livre_bytes"] = disco.LivreBytes(),
                ["banco_bytes"] = disco.TamanhoBanco(),
                ["logs_bytes"] = disco.TamanhoLogs(),
                ["backups_bytes"] = disco.TamanhoBackups(),
                ["livre"] = disco.LivreBytes() is { } livre ? MedidorDisco.Legivel(livre) : "não deu para medir",
            });
            return Task.FromResult(true);
        }, ct);

        await Secao(avisos, AuditoriaResumo, async () =>
        {
            var registros = await Completo<ConsultasPacoteSuporte>().AuditoriaAsync(agora.AddDays(-DiasDeAuditoria), ct);
            // Só quantas vezes cada ação por dia (do calendário da loja): sem quem, motivo, descrição nem antes/depois.
            var contagem = registros
                .GroupBy(r => (Dia: DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(r.OcorridoEm, fuso).DateTime), r.Acao))
                .OrderByDescending(g => g.Key.Dia).ThenBy(g => g.Key.Acao, StringComparer.Ordinal);
            pacote.Csv(AuditoriaResumo, ["dia", "acao", "quantidade"],
                contagem.Select(g => new[] { g.Key.Dia.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), g.Key.Acao, Num(g.Count()) }));
            if (registros.Count >= ConsultasPacoteSuporte.LimiteAuditoria)
            {
                avisos.Add($"{AuditoriaResumo}: contados só os {ConsultasPacoteSuporte.LimiteAuditoria} registros mais novos dos últimos {DiasDeAuditoria} dias.");
            }

            return true;
        }, ct);
    }

    /// <summary>
    /// O arquivo técnico (Serilog) dos últimos <see cref="DiasDeLog"/> dias, do mais novo ao mais antigo, mascarado registro
    /// a registro (a exceção junto da linha que a abriu: o bloco PEM e o JSON de várias linhas não se partem), até o
    /// <see cref="OrcamentoLogs"/>. Lido com <see cref="FileShare.ReadWrite"/> (o Serilog continua escrevendo o do dia).
    /// </summary>
    private void EscreverLogs(MontadorPacote pacote, DateTimeOffset agora, List<string> avisos, string? conta, CancellationToken ct)
    {
        var hoje = DateOnly.FromDateTime(agora.ToLocalTime().DateTime);
        var primeiro = hoje.AddDays(-(DiasDeLog - 1));
        var orcamento = OrcamentoLogs;
        var omitidos = new List<string>();
        foreach (var arquivo in leitorLog.Dias().Where(d => d.Dia >= primeiro).SelectMany(d => d.Arquivos))
        {
            ct.ThrowIfCancellationRequested();
            if (orcamento <= 0)
            {
                omitidos.Add(arquivo.Nome);
                continue;
            }

            try
            {
                var copia = default(CopiaLog);
                pacote.Escrever(PastaLogs + arquivo.Nome, saida => copia = CopiarMascarado(arquivo.Caminho, saida, conta, ct));
                orcamento -= copia.Lidos;
                if (copia.ChaveSemFim)
                {
                    avisos.Add($"{PastaLogs}{arquivo.Nome}: um registro gigante foi cortado dentro de uma chave privada que não fecha; o resto dela ficou de fora até o registro seguinte.");
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                avisos.Add(M($"{PastaLogs}{arquivo.Nome}: não deu para ler ({e.Message}).")!);
            }
        }

        if (omitidos.Count > 0)
        {
            avisos.Add($"{PastaLogs}: os mais antigos ficaram de fora pelo tamanho ({string.Join(", ", omitidos)}).");
        }
    }

    /// <summary>Quantos bytes do log foram lidos e se uma chave privada cortada nunca fechou (o manifesto avisa).</summary>
    internal readonly record struct CopiaLog(long Lidos, bool ChaveSemFim);

    /// <summary>
    /// Copia o arquivo de log mascarado (e com a <paramref name="conta"/> que ativou o caixa escondida). A chave privada
    /// cortada no registro gigante é descartada até o <c>-----END</c> ou, se ele nunca vier (o log truncado), até o registro
    /// seguinte, com o <see cref="MarcadorChaveSemFim"/> no lugar: o resto do arquivo não some junto.
    /// </summary>
    internal static CopiaLog CopiarMascarado(string caminho, Stream saida, string? conta = null, CancellationToken ct = default)
    {
        using var entrada = new FileStream(caminho, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024);
        using var leitor = new StreamReader(entrada, Utf8, detectEncodingFromByteOrderMarks: true);
        using var escritor = new StreamWriter(saida, Utf8, 64 * 1024, leaveOpen: true) { NewLine = "\n" };
        var registro = new StringBuilder();
        var dentroDeChave = false;
        var chaveSemFim = false;

        void Descarregar(bool corte)
        {
            if (registro.Length == 0)
            {
                return;
            }

            var texto = registro.ToString();
            registro.Clear();
            // O registro gigante cortado no meio de um bloco PEM: o mascarador esconde do BEGIN ao fim do pedaço, e as linhas
            // seguintes até o END ficam de fora (o resto da chave nunca sai sem o BEGIN que a reconheceria).
            if (corte && ChaveAbertaSemFim(texto))
            {
                dentroDeChave = true;
            }

            escritor.Write(MascaradorSuporte.OcultarConta(MascaradorSuporte.Mascarar(texto)!, conta));
        }

        while (leitor.ReadLine() is { } linha)
        {
            ct.ThrowIfCancellationRequested();
            if (dentroDeChave)
            {
                if (linha.Contains("-----END ", StringComparison.Ordinal))
                {
                    dentroDeChave = false;
                    continue;
                }

                if (!LeitorLogArquivo.AbreRegistro(linha))
                {
                    continue;
                }

                // A chave nunca fechou (o log cortado sem o END): o descarte para no registro seguinte, que sai normal.
                dentroDeChave = false;
                chaveSemFim = true;
                escritor.Write(MarcadorChaveSemFim + "\n");
            }

            if (LeitorLogArquivo.AbreRegistro(linha))
            {
                Descarregar(corte: false);
            }

            registro.Append(linha).Append('\n');
            if (registro.Length > MaximoRegistro)
            {
                Descarregar(corte: true);
            }
        }

        Descarregar(corte: false);
        if (dentroDeChave)
        {
            // O arquivo acabou dentro da chave: o marcador diz que o resto dela não veio.
            chaveSemFim = true;
            escritor.Write(MarcadorChaveSemFim + "\n");
        }

        escritor.Flush();
        return new CopiaLog(entrada.Position, chaveSemFim);
    }

    private static bool ChaveAbertaSemFim(string texto)
    {
        var inicio = texto.LastIndexOf("-----BEGIN ", StringComparison.Ordinal);
        if (inicio < 0)
        {
            return false;
        }

        var fimLinha = texto.IndexOf('\n', inicio);
        var cabecalho = fimLinha < 0 ? texto[inicio..] : texto[inicio..fimLinha];
        return cabecalho.Contains("PRIVATE KEY-----", StringComparison.Ordinal) && texto.LastIndexOf("-----END ", StringComparison.Ordinal) < inicio;
    }

    /// <summary>
    /// O manifesto: quem é o caixa (nada secreto: o código, a loja, o caixa, o servidor só pelo host), a versão do app e do
    /// banco, quem gerou e quando (no modo sem banco, sem o "gerado por"), os avisos e o SHA-256 de cada arquivo (o suporte
    /// confere que nada mudou no caminho).
    /// </summary>
    private string ManifestoJson(
        MontadorPacote pacote, DateTimeOffset agora, TimeZoneInfo fuso, GeradoPor? gerado, IdentidadePacote? identidade,
        IReadOnlyList<string>? migracoes, IReadOnlyList<string> avisos, bool semBanco)
    {
        // Sem a consulta (o modo sem banco), a identidade que a abertura deixou em memória (nunca o token: só os campos daqui).
        var emMemoria = sessao.Identidade;
        var terminalId = identidade?.TerminalId ?? emMemoria?.TerminalId;
        var numeroCaixa = identidade?.NumeroCaixa ?? emMemoria?.NumeroCaixa;
        var url = identidade?.UrlApi ?? emMemoria?.UrlApi;
        var demonstracao = url == IdentidadeTerminal.UrlDemonstracao;
        var manifesto = new JsonObject
        {
            ["formato"] = 1,
            ["modo"] = semBanco ? "sem_banco" : "completo",
            ["gerado_em"] = FormatarHora(agora, fuso),
            ["fuso"] = fuso.Id,
            ["versao_app"] = VersaoApp.Atual,
            ["sistema"] = $"{RuntimeInformation.OSDescription} ({RuntimeInformation.OSArchitecture})",
            ["computador"] = identidade?.NomeMaquina is { Length: > 0 } maquina ? maquina : Environment.MachineName,
            ["terminal"] = terminalId is null
                ? null
                : new JsonObject
                {
                    ["codigo"] = new IdentidadeTerminal { TerminalId = terminalId.Value, NumeroCaixa = numeroCaixa ?? 0 }.CodigoCurto,
                    ["terminal_id"] = terminalId.Value.ToString(),
                    ["empresa_codigo"] = identidade?.EmpresaCodigo ?? emMemoria?.EmpresaCodigo,
                    ["loja_codigo"] = sessao.LojaCodigo,
                    ["loja"] = sessao.NomeLoja,
                    ["caixa"] = numeroCaixa,
                    ["situacao"] = identidade?.Status ?? emMemoria?.Status,
                    ["servidor"] = demonstracao ? "demonstração (sem nuvem)" : Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host : null,
                    ["ativado_em"] = FormatarHora(identidade?.AtivadoEm ?? emMemoria?.AtivadoEm, fuso),
                    ["ultimo_backup_em"] = FormatarHora(identidade?.UltimoBackupEm, fuso),
                    ["restaurado_em"] = FormatarHora(identidade?.RestauradoEm, fuso),
                },
        };
        // As pastas (pelo mascarador: o perfil do Windows vira %USERPROFILE%), para o suporte saber onde procurar no caixa.
        manifesto["pastas"] = new JsonObject
        {
            ["dados"] = M(Path.GetFullPath(caminhos.PastaDados)),
            ["logs"] = M(Path.GetFullPath(caminhos.PastaLogs)),
            ["backup"] = M(Path.GetFullPath(caminhos.PastaBackup)),
        };
        if (!semBanco)
        {
            manifesto["banco"] = migracoes is null
                ? null
                : new JsonObject { ["migracoes"] = migracoes.Count, ["ultima_migracao"] = migracoes.LastOrDefault() };
            manifesto["gerado_por"] = gerado?.Nome;
            manifesto["liberado_por"] = gerado?.Liberador;
        }

        manifesto["nunca_inclui"] =
            "o banco (pdv.db, -wal, -shm), os backups, a chave do terminal, as chaves internas, o token, os hashes de PIN, o " +
            "conteúdo (payload) dos registros enviados à nuvem e os bytes dos impressos";
        manifesto["avisos"] = new JsonArray([.. avisos.Select(a => (JsonNode?)M(a))]);
        manifesto["arquivos"] = new JsonArray([.. pacote.Arquivos.Select(a => (JsonNode)new JsonObject
        {
            ["nome"] = a.Nome,
            ["bytes"] = a.Bytes,
            ["sha256"] = a.Sha256,
        })]);
        return manifesto.ToJsonString(Json);
    }

    private static string TextoDiagnostico(string titulo, string texto, DateTimeOffset agora, TimeZoneInfo fuso) =>
        M($"GenesisPDV {VersaoApp.Atual} · pacote de suporte sem banco · {FormatarHora(agora, fuso)}\n\n{titulo}\n\n{texto}\n\n{AvisoEntrega}\n")!;

    /// <summary>A auditoria <c>exportar</c> e a ocorrência <c>PACOTE_GERADO</c>, num commit; devolve o aviso se não gravou.</summary>
    private async Task<string?> RegistrarAsync(ResultadoPacote r, DestinoPacote destino, Guid usuarioId, Guid? autorizadoPor, CancellationToken ct)
    {
        try
        {
            var gravou = await NoBancoAsync(() => GravarRegistroAsync(r, destino, usuarioId, autorizadoPor, ct), ct);
            return gravou ? null : $"O pacote foi gerado, mas não ficou registrado no histórico: {MotivoRestauracao}.";
        }
        catch (RegraNegocioException e)
        {
            // D22: o gatilho recusa a auditoria (a ocorrência vai junto, no mesmo commit). O pacote já está no destino.
            return $"O pacote foi gerado, mas não ficou registrado no histórico: {e.Message}";
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogError(e, "Pacote de suporte gerado sem o registro no log local e na auditoria");
            return M($"O pacote foi gerado, mas não ficou registrado no histórico ({e.Message}).");
        }
    }

    private async Task<bool> GravarRegistroAsync(ResultadoPacote r, DestinoPacote destino, Guid usuarioId, Guid? autorizadoPor, CancellationToken ct)
    {
        await using var db = await Completo<IDbContextFactory<PdvDbContext>>().CreateDbContextAsync(ct);
        db.LogLocal.Add(Ocorrencia(r, destino, semLogin: false));
        db.LogAuditoriaLocal.Add(new LogAuditoriaLocal
        {
            Id = IdGerador.Novo(),
            OcorridoEm = relogio.Agora,
            Acao = "exportar",
            Entidade = EntidadePacote,
            UsuarioId = usuarioId,
            AutorizadoPorId = autorizadoPor,
            Localizacao = LocalizacaoCentral,
            Descricao = $"Pacote de suporte gerado: {r.Nome} ({destino.Tipo})",
            Depois = new JsonObject
            {
                ["arquivo"] = r.Nome,
                ["tamanho_bytes"] = r.Tamanho,
                ["sha256"] = r.Sha256,
                ["destino"] = destino.Tipo,
            }.ToJsonString(),
        });
        await db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>
    /// A <c>PACOTE_GERADO</c>. <paramref name="semLogin"/>: a tela de terminal bloqueado (a única sem login que grava; a
    /// de erro fatal não abre o banco), sem ninguém logado e sem a auditoria — a mensagem diz de onde veio.
    /// </summary>
    private LogLocal Ocorrencia(ResultadoPacote r, DestinoPacote destino, bool semLogin) => Ocorrencias.Nova(
        relogio.Agora, NiveisOcorrencia.Info, CodigoOcorrencia.PacoteGerado,
        $"Pacote de suporte gerado{(semLogin ? " sem login, na tela de terminal bloqueado (sem o banco no pacote)" : " na Central do PDV")}: {r.Nome} ({MedidorDisco.Legivel(r.Tamanho)}, {destino.Tipo})",
        new JsonObject { ["arquivo"] = r.Nome, ["sha256"] = r.Sha256, ["destino"] = destino.Tipo, ["sem_banco"] = semLogin });

    /// <summary>
    /// Uma parte do pacote: a falha vira um aviso (mascarado) e o resto continua; o cancelamento sobe. Lê o banco uma por
    /// vez com a restauração (<see cref="NoBancoAsync"/>): depois que ela começou, a parte fica de fora com um aviso só.
    /// </summary>
    private async Task<T?> Secao<T>(List<string> avisos, string nome, Func<Task<T>> acao, CancellationToken ct)
    {
        try
        {
            T? valor = default;
            if (await NoBancoAsync(async () =>
                {
                    valor = await acao();
                    return true;
                }, ct))
            {
                return valor;
            }

            var aviso = $"As partes que vêm do banco do caixa ficaram de fora: {MotivoRestauracao}.";
            if (!avisos.Contains(aviso))
            {
                avisos.Add(aviso);
            }

            return default;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogWarning(e, "Pacote de suporte: {Parte} ficou de fora", nome);
            avisos.Add(M($"{nome}: ficou de fora ({e.Message}).")!);
            return default;
        }
    }

    private async Task Secao(List<string> avisos, string nome, Func<Task<bool>> acao, CancellationToken ct) =>
        await Secao(avisos, nome, async () => (object)await acao(), ct);

    /// <summary><c>suporte-loja1-cx02-20261105-1432.zip</c> (a hora da loja); sem terminal, <c>suporte-caixa-…</c>.</summary>
    private string NomeArquivo(DateTimeOffset agora, TimeZoneInfo fuso)
    {
        var quando = TimeZoneInfo.ConvertTime(agora, fuso).ToString("yyyyMMdd-HHmm", CultureInfo.InvariantCulture);
        return sessao.Identidade is { } i
            ? $"suporte-loja{sessao.LojaCodigo.ToString(CultureInfo.InvariantCulture)}-cx{i.NumeroCaixa:00}-{quando}.zip"
            : $"suporte-caixa-{quando}.zip";
    }

    /// <summary>O nome no destino sem apagar outro pacote do mesmo minuto (<c>-2</c>, <c>-3</c>…).</summary>
    private static string NomeLivre(string pasta, string nome)
    {
        var caminho = Path.Combine(pasta, nome);
        var baseNome = Path.GetFileNameWithoutExtension(nome);
        for (var n = 2; File.Exists(caminho); n++)
        {
            caminho = Path.Combine(pasta, $"{baseNome}-{n.ToString(CultureInfo.InvariantCulture)}.zip");
        }

        return caminho;
    }

    private static void TentarApagar(string arquivo)
    {
        try
        {
            File.Delete(arquivo);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // O pendrive saiu: o .parcial fica lá, com o nome que diz que não terminou.
        }
    }

    /// <summary>
    /// O valor JSON de uma configuração mascarado como o <c>detalhes</c> da decisão 73 (<see cref="MascaradorSuporte.MascararDetalhes"/>):
    /// cada texto decodificado (o caminho da pasta do backup tem o perfil do Windows) e o campo de nome sensível inteiro
    /// (<c>{"senha":…}</c>, <c>{"pin":…}</c>), para a chave nova que entrar na lista de permitidos com um segredo dentro.
    /// O texto que não é JSON vai mascarado como texto.
    /// </summary>
    internal static JsonNode? ValorMascarado(string json)
    {
        var mascarado = MascaradorSuporte.MascararDetalhes(json);
        try
        {
            return mascarado is null ? null : JsonNode.Parse(mascarado);
        }
        catch (JsonException)
        {
            return JsonValue.Create(M(json));
        }
    }

    private static string? M(string? texto) => MascaradorSuporte.Mascarar(texto);

    private static string Num(long n) => n.ToString(CultureInfo.InvariantCulture);

    /// <summary>A hora na loja com o fuso (<c>2026-11-05 14:32:01 -03:00</c>); vazio sem hora.</summary>
    private static string? FormatarHora(DateTimeOffset? quando, TimeZoneInfo fuso) => quando is { } q
        ? TimeZoneInfo.ConvertTime(q, fuso).ToString("yyyy-MM-dd HH:mm:ss zzz", CultureInfo.InvariantCulture)
        : null;

    [GeneratedRegex(@"^genesispdv-\d{8}(?:_\d{3,})?\.log$", RegexOptions.CultureInvariant)]
    private static partial Regex LogPermitido();

    private sealed record GeradoPor(string Nome, string? Liberador);

    /// <summary>Um arquivo já escrito no zip: o nome, o tamanho e o SHA-256 (o manifesto lista).</summary>
    internal sealed record ArquivoNoPacote(string Nome, long Bytes, string Sha256);

    /// <summary>O zip em montagem: só aceita os nomes permitidos e guarda o SHA-256 de cada arquivo enquanto escreve.</summary>
    /// <param name="conta">A conta do sistema que ativou o caixa, escondida em todo arquivo (<see cref="MascaradorSuporte.OcultarConta"/>).</param>
    private sealed class MontadorPacote(Stream destino, string? conta) : IDisposable
    {
        private readonly ZipArchive _zip = new(destino, ZipArchiveMode.Create, leaveOpen: true, Utf8);
        private readonly List<ArquivoNoPacote> _arquivos = [];
        private readonly List<string> _nomes = [];

        public IReadOnlyList<ArquivoNoPacote> Arquivos => _arquivos;

        public IReadOnlyList<string> Nomes => _nomes;

        /// <summary>Escreve um arquivo; com <paramref name="registrar"/>, entra na lista do manifesto (o próprio manifesto não).</summary>
        public void Escrever(string nome, Action<Stream> escrever, bool registrar = true)
        {
            ExigirPermitido(nome);
            var entrada = _zip.CreateEntry(nome, CompressionLevel.Optimal);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long bytes = 0;
            try
            {
                using var saida = new SaidaComHash(entrada.Open(), hash);
                escrever(saida);
                bytes = saida.Bytes;
            }
            finally
            {
                // Mesmo o arquivo que parou no meio (o log que sumiu) entra no manifesto com o que foi escrito: os hashes conferem.
                _nomes.Add(nome);
                if (registrar)
                {
                    _arquivos.Add(new ArquivoNoPacote(nome, bytes, Convert.ToHexStringLower(hash.GetHashAndReset())));
                }
            }
        }

        public void Texto(string nome, string conteudo, bool registrar = true) =>
            Escrever(nome, s => s.Write(Utf8.GetBytes(MascaradorSuporte.OcultarConta(conteudo, conta))), registrar);

        public void Json(string nome, JsonNode no) => Texto(nome, no.ToJsonString(ServicoPacoteSuporte.Json));

        /// <summary>CSV com <c>;</c> e BOM (o Excel em português abre direto), uma linha por registro, textos já mascarados.</summary>
        public void Csv(string nome, IReadOnlyList<string> colunas, IEnumerable<IReadOnlyList<string?>> linhas) => Escrever(nome, s =>
        {
            using var escritor = new StreamWriter(s, Utf8ComBom, 64 * 1024, leaveOpen: true) { NewLine = "\r\n" };
            escritor.WriteLine(string.Join(';', colunas.Select(CampoCsv)));
            foreach (var linha in linhas)
            {
                escritor.WriteLine(string.Join(';', linha.Select(v => CampoCsv(v is null ? null : MascaradorSuporte.OcultarConta(v, conta)))));
            }
        });

        public void Dispose() => _zip.Dispose();
    }

    /// <summary>
    /// O campo do CSV: entre aspas quando tem <c>;</c>, aspa ou quebra; o texto que o Excel leria como fórmula (<c>=</c>,
    /// <c>+</c>, <c>@</c>, tabulação, retorno, e o <c>-</c> quando o valor todo não é um número: <c>-1+cmd|' /C calc'!A0</c>)
    /// ganha um apóstrofo na frente. Só o número negativo (<c>-12</c>, <c>-3.5</c>) fica como está.
    /// </summary>
    internal static string CampoCsv(string? valor)
    {
        if (string.IsNullOrEmpty(valor))
        {
            return string.Empty;
        }

        if (valor[0] is '=' or '+' or '@' or '\t' or '\r'
            || (valor[0] == '-' && !decimal.TryParse(valor, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out _)))
        {
            valor = "'" + valor;
        }

        return valor.IndexOfAny([';', '"', '\n', '\r']) >= 0 ? $"\"{valor.Replace("\"", "\"\"", StringComparison.Ordinal)}\"" : valor;
    }

    /// <summary>Repassa ao zip e soma o SHA-256 e o tamanho do que passa (o arquivo não é lido de novo para o manifesto).</summary>
    private sealed class SaidaComHash(Stream interno, IncrementalHash hash) : Stream
    {
        public long Bytes { get; private set; }

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => Bytes;

        public override long Position
        {
            get => Bytes;
            set => throw new NotSupportedException();
        }

        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            hash.AppendData(buffer);
            Bytes += buffer.Length;
            interno.Write(buffer);
        }

        public override void Flush() => interno.Flush();

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                interno.Dispose();
            }

            base.Dispose(disposing);
        }
    }
}
