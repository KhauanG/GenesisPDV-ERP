using System.Text.Json.Nodes;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Backup;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// Quando o PDV faz backup (PDV 32.5; Fase 1C, C17; O12 do dono): a cada <see cref="OpcoesBackup.Intervalo"/> (2 h) com o
/// caixa aberto — conferido de tempos em tempos contra o <c>ultimo_backup_em</c>, que sobrevive ao app fechado —, logo
/// depois do fechamento do caixa (em segundo plano: o relatório e a gaveta não esperam) e ao fechar o aplicativo (o
/// backup de saída, seguido do <c>encerramento.json</c>). Antes de migração é o <see cref="InicializadorBanco"/>. Falha de
/// backup nunca para o caixa: vai para o log (e o <c>log_local</c>, que o suporte lê) e o próximo tenta de novo.
/// </summary>
public sealed class ServicoBackup(
    BackupLocal backup, IDbContextFactory<PdvDbContext> fabrica, CaminhosPdv caminhos, IRelogio relogio, ILogger<ServicoBackup> log) : IDisposable
{
    /// <summary>A entidade da auditoria do backup manual (plano 4: <c>criar</c> de <c>backup_local</c>).</summary>
    public const string EntidadeBackup = "backup_local";

    public const string MensagemVendaEmAndamento =
        "Há uma venda em andamento neste caixa: conclua ou cancele a venda antes de fazer o backup agora (o backup periódico continua sozinho).";

    public const string MensagemRestauracao = "Restauração de backup em curso: o backup agora fica para depois de o caixa reabrir.";

    private readonly CancellationTokenSource _parar = new();
    private bool _descartado;
    private volatile bool _suspenso;
    private Task? _laco;
    private Task _ultimo = Task.CompletedTask;

    /// <summary>Último backup feito por este processo (status e testes).</summary>
    public ResultadoBackup? Ultimo { get; private set; }

    /// <summary>
    /// A última tentativa que falhou neste processo, com a mensagem (Painel de saúde, Central do PDV, bloco G4): o
    /// Painel compara com o <c>ultimo_backup_em</c> (o sucesso, que sobrevive ao app fechado).
    /// </summary>
    public (DateTimeOffset Em, string Mensagem)? UltimaFalha { get; private set; }

    /// <summary>
    /// O <see cref="InicializadorBanco"/> terminou bem (integridade conferida, migrações aplicadas): só então há backup —
    /// o banco corrompido da restauração automática nunca vira backup de saída nem troca o <c>encerramento.json</c>.
    /// </summary>
    public bool BancoConferido => _laco is not null;

    /// <summary>Liga o laço do backup periódico (idempotente), depois do <see cref="InicializadorBanco"/> sem erro.</summary>
    public void Iniciar()
    {
        if (_laco is not null)
        {
            return;
        }

        _laco = Task.Run(() => LacoAsync(_parar.Token));
    }

    /// <summary>
    /// Antes de restaurar (C17): o laço para e nada mais sai até o app reabrir — nem o backup de saída, que gravaria o
    /// <c>ultimo_backup_em</c> no arquivo restaurado (a prova de que nada se perdeu compara com o dele).
    /// </summary>
    public void SuspenderParaRestauracao()
    {
        _suspenso = true;
        if (!_descartado)
        {
            _parar.Cancel();
        }
    }

    /// <summary>Backup do fechamento de caixa, em segundo plano (PDV 32.5).</summary>
    public void AgendarAposFechamento() => _ultimo = Task.Run(() => TentarAsync(MotivosBackup.Fechamento, CancellationToken.None));

    /// <summary>Espera o backup em segundo plano em curso (testes e o encerramento).</summary>
    public Task AguardarAsync() => _ultimo;

    /// <summary>Um backup agora; falha só no log (devolve nulo).</summary>
    public async Task<ResultadoBackup?> TentarAsync(string motivo, CancellationToken ct = default)
    {
        if (_suspenso)
        {
            return null;
        }

        try
        {
            var r = await backup.FazerAsync(motivo, ct);
            Ultimo = r;
            log.LogInformation("Backup {Motivo}: {Arquivo}", motivo, r.Arquivo);
            return r;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogError(e, "Backup {Motivo} falhou", motivo);
            UltimaFalha = (relogio.Agora, e.Message);
            await RegistrarFalhaAsync(motivo, e);
            return null;
        }
    }

    /// <summary>
    /// "Fazer backup agora" (aba 8 Backup da Central do PDV, bloco G11; plano 4 e 7): o mesmo backup do periódico (o banco
    /// em uso pela API de backup online, as duas pastas e a retenção), com o motivo <see cref="MotivosBackup.Manual"/>.
    /// Recusa com uma venda em andamento (aberta ou em pagamento) neste caixa e durante a restauração; com um backup em
    /// curso (o periódico, o do fechamento) <b>espera</b> ele terminar (um backup por vez). A falha vira a mensagem da tela
    /// e também fica como a do periódico (<see cref="UltimaFalha"/> e o <c>BACKUP_FALHOU</c>); a mensagem da tela passa pelo
    /// <see cref="MascaradorSuporte"/> (o caminho traz o perfil do Windows). O backup roda <b>fora da thread da tela</b>
    /// (<see cref="Task.Run(Func{Task})"/>, como o periódico e o do fechamento): a cópia online, a compressão, o sha256 e a
    /// cópia para o pendrive levam segundos num banco grande e a janela do caixa não pode parar ("Não respondendo"). Feito,
    /// grava a ocorrência <c>BACKUP_MANUAL</c> e a auditoria <c>criar</c> da entidade <c>backup_local</c> (já no catálogo;
    /// sobe no lote) com quem pediu e quem liberou. Esse registro é melhor esforço: na D22, com o banco ocupado ou com a
    /// restauração começada nesse meio-tempo (nada grava durante a troca), o backup continua feito e o motivo vai para o
    /// <see cref="ResultadoBackupManual.Aviso"/>. Quem pode pedir é a tela que decide (<c>pdv.config.parametros_locais</c>).
    /// </summary>
    public async Task<ResultadoBackupManual> FazerAgoraAsync(
        Guid usuarioId, Guid? autorizadoPorId, string? motivo, string localizacao, CancellationToken ct = default)
    {
        await ConferirAgoraAsync(ct);
        ResultadoBackup r;
        try
        {
            // Fora da thread da tela: boa parte do backup é síncrona (a API de backup online, o sha256, o File.Copy).
            r = await Task.Run(() => backup.FazerAsync(MotivosBackup.Manual, ct), ct);
            Ultimo = r;
            log.LogInformation("Backup {Motivo}: {Arquivo}", MotivosBackup.Manual, r.Arquivo);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogError(e, "Backup {Motivo} falhou", MotivosBackup.Manual);
            UltimaFalha = (relogio.Agora, e.Message);
            await RegistrarFalhaAsync(MotivosBackup.Manual, e);
            throw new RegraNegocioException(MascaradorSuporte.Mascarar(
                $"O backup não foi feito ({e.Message}). Confira o espaço no disco (aba 0, item Disco) e tente de novo.")!);
        }

        var nome = Path.GetFileName(r.Arquivo);
        long tamanho = 0;
        try
        {
            tamanho = new FileInfo(r.Arquivo).Length;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // O arquivo saiu da pasta nesse meio-tempo (a restauração, a retenção de outro processo): o backup foi feito.
            log.LogWarning(e, "Tamanho do backup manual não lido");
        }

        if (_suspenso)
        {
            // A restauração começou enquanto o backup terminava: nada grava no banco durante a troca.
            return new ResultadoBackupManual(r, tamanho, "O backup foi feito, mas não ficou registrado no histórico: a restauração de backup começou.");
        }

        string? aviso = null;
        try
        {
            await using var db = await fabrica.CreateDbContextAsync(ct);
            db.LogLocal.Add(Ocorrencias.Nova(relogio.Agora, NiveisOcorrencia.Info, CodigoOcorrencia.BackupManual,
                $"Backup feito agora (manual): {nome}" + (r.CopiaSecundaria is null ? string.Empty : ", com a cópia na pasta secundária")));
            db.LogAuditoriaLocal.Add(new LogAuditoriaLocal
            {
                Id = IdGerador.Novo(),
                OcorridoEm = relogio.Agora,
                Acao = "criar",
                Entidade = EntidadeBackup,
                UsuarioId = usuarioId,
                AutorizadoPorId = autorizadoPorId,
                Motivo = motivo,
                Localizacao = localizacao,
                Descricao = $"Backup feito agora: {nome}" + (r.CopiaSecundaria is null ? string.Empty : " (e a cópia na pasta secundária)"),
                Depois = new JsonObject
                {
                    ["arquivo"] = nome,
                    ["motivo_backup"] = MotivosBackup.Manual,
                    ["tamanho_bytes"] = tamanho,
                    ["copia_secundaria"] = r.CopiaSecundaria is not null,
                }.ToJsonString(),
            });
            await db.SaveChangesAsync(ct);
        }
        catch (RegraNegocioException e)
        {
            // D22: o gatilho recusa a auditoria (e a ocorrência vai junto, no mesmo commit). O backup já está feito.
            aviso = $"O backup foi feito, mas não ficou registrado no histórico: {e.Message}";
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // O banco ocupado (o sync no meio de um commit), o arquivo trocado: o backup está na pasta e o
            // ultimo_backup_em já foi gravado — não é "não deu certo".
            log.LogError(e, "Backup manual feito sem o registro no log local e na auditoria");
            aviso = MascaradorSuporte.Mascarar($"O backup foi feito, mas não ficou registrado no histórico ({e.Message}).");
        }

        return new ResultadoBackupManual(r, tamanho, aviso);
    }

    /// <summary>
    /// O que recusa o "Fazer backup agora" antes de começar, sem gravar nada: a restauração em curso e a venda em andamento
    /// (aberta ou em pagamento) no caixa aberto. O <see cref="FazerAgoraAsync"/> confere de novo; a aba 8 chama este antes
    /// do PIN do supervisor (ele não libera o que vai ser recusado, como na aba 7).
    /// </summary>
    public async Task ConferirAgoraAsync(CancellationToken ct = default)
    {
        if (_suspenso)
        {
            throw new RegraNegocioException(MensagemRestauracao);
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        var abertas = await db.SessoesCaixa.AsNoTracking()
            .Where(s => s.Status != StatusSessaoCaixa.Fechada && s.ExcluidoEm == null).Select(s => (Guid?)s.Id).ToListAsync(ct);
        if (abertas.Count > 0 && await db.Vendas.AsNoTracking().AnyAsync(
                v => abertas.Contains(v.SessaoCaixaId) && (v.Status == StatusVenda.EmAndamento || v.Status == StatusVenda.EmPagamento), ct))
        {
            throw new RegraNegocioException(MensagemVendaEmAndamento);
        }
    }

    /// <summary>
    /// A falha também fica no <c>log_local</c> (aba 5 da Central, bloco G8: o que o suporte procura depois de reabrir o
    /// app). Nível <c>aviso</c>: o item Backup do Painel já fica vermelho, e os "Erros recentes" não acendem duas vezes pela
    /// mesma falha. Se o banco também falhar (o porquê do backup ter falhado, às vezes), fica só no arquivo de log. Com a
    /// restauração em curso (<see cref="SuspenderParaRestauracao"/> não espera o backup do fechamento, que pode falhar
    /// justamente pela troca do arquivo), nada: "nada grava no banco durante a troca" — nem no restaurado, nem segurando o
    /// arquivo no Windows. Confere de novo logo antes de gravar.
    /// </summary>
    private async Task RegistrarFalhaAsync(string motivo, Exception e)
    {
        if (_suspenso)
        {
            log.LogWarning("Falha do backup {Motivo} não registrada no log local: a restauração está em curso", motivo);
            return;
        }

        try
        {
            await using var db = await fabrica.CreateDbContextAsync();
            db.LogLocal.Add(Ocorrencias.Nova(
                relogio.Agora, NiveisOcorrencia.Aviso, CodigoOcorrencia.BackupFalhou, $"Backup ({motivo}) não foi feito: {e.Message}",
                texto: e.ToString()));
            if (_suspenso)
            {
                return;
            }

            await db.SaveChangesAsync();
        }
        catch (Exception registro) when (registro is not OperationCanceledException)
        {
            log.LogError(registro, "Falha ao registrar o backup que falhou no log local");
        }
    }

    /// <summary>
    /// Backup de saída (encerramento normal do app, PDV 32.5): para o laço, faz o backup e grava o
    /// <c>encerramento.json</c> com o sha256 dele. Sem banco conferido (<see cref="BancoConferido"/>: a abertura parou no
    /// banco corrompido, com a restauração automática ou o erro fatal na tela) ou sem banco ativado (assistente de
    /// ativação), nada: o marcador do último encerramento bom fica valendo. Nunca lança (a saída não espera um erro).
    /// </summary>
    public async Task<ResultadoBackup?> EncerrarAsync()
    {
        if (!BancoConferido)
        {
            log.LogWarning("Backup de saída não feito: o banco local não passou pela inicialização neste processo");
            return null;
        }

        await _parar.CancelAsync();
        try
        {
            await _ultimo;
        }
        catch (Exception e)
        {
            log.LogWarning(e, "Backup em segundo plano terminou com erro no encerramento");
        }

        try
        {
            await using var db = await fabrica.CreateDbContextAsync();
            if (!await db.IdentidadeTerminal.AnyAsync())
            {
                return null;
            }
        }
        catch (Exception e)
        {
            log.LogError(e, "Backup de saída não feito: o banco local não pôde ser lido");
            return null;
        }

        var r = await TentarAsync(MotivosBackup.Saida);
        if (r is not null)
        {
            MarcadorEncerramento.Gravar(caminhos.PastaDados, r);
        }

        return r;
    }

    /// <summary>De tempos em tempos (um 24 avos do intervalo, entre 1 s e 5 min): caixa aberto e o último backup velho → backup.</summary>
    private async Task LacoAsync(CancellationToken ct)
    {
        var passo = TimeSpan.FromTicks(Math.Clamp(backup.Opcoes.Intervalo.Ticks / 24, TimeSpan.FromSeconds(1).Ticks, TimeSpan.FromMinutes(5).Ticks));
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(passo, ct);
                if (await DevidoAsync(ct))
                {
                    await TentarAsync(MotivosBackup.Periodico, ct);
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (Exception e)
        {
            log.LogError(e, "Laço do backup periódico parou");
        }
    }

    /// <summary>Backup periódico devido: caixa aberto e o último backup há pelo menos um intervalo (ou nenhum).</summary>
    internal async Task<bool> DevidoAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var identidade = await db.IdentidadeTerminal.AsNoTracking().FirstOrDefaultAsync(ct);
        if (identidade is null)
        {
            return false;
        }

        var aberta = await db.SessoesCaixa.AnyAsync(s => s.Status != StatusSessaoCaixa.Fechada && s.ExcluidoEm == null, ct);
        return aberta && (identidade.UltimoBackupEm is not { } ultimo || relogio.Agora - ultimo >= backup.Opcoes.Intervalo);
    }

    public void Dispose()
    {
        if (_descartado)
        {
            return;
        }

        _descartado = true;
        _parar.Cancel();
        _parar.Dispose();
    }
}

/// <summary>O "Fazer backup agora" feito: o arquivo, o tamanho e, na D22, o aviso de que a auditoria não foi gravada.</summary>
public sealed record ResultadoBackupManual(ResultadoBackup Backup, long Tamanho, string? Aviso);
