using GenesisPDV.Core.Comum;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.Servicos.Diagnostico;

/// <summary>
/// Limites do Painel de saúde (plano 4.1; spec 32.2): constantes do código, não chaves da loja (os testes trocam pelo
/// <c>ajustar</c> da composição).
/// </summary>
public sealed record OpcoesSaude
{
    /// <summary>Cada verificação tem até isto; a que passa vira um aviso "não respondeu" e o Painel não espera mais.</summary>
    public TimeSpan LimitePorVerificacao { get; init; } = TimeSpan.FromSeconds(2);

    /// <summary>A rodada barata do ícone da barra de status da venda.</summary>
    public TimeSpan IntervaloIcone { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>Abaixo disto, amarelo (spec 32.2).</summary>
    public long DiscoAvisoBytes { get; init; } = 1024L * 1024 * 1024;

    /// <summary>Abaixo disto, vermelho, e abrir caixa novo fica bloqueado (a venda em curso nunca: spec 32.2 revista).</summary>
    public long DiscoBloqueioBytes { get; init; } = 200L * 1024 * 1024;

    /// <summary>Registro esperando envio há mais que isto: amarelo.</summary>
    public TimeSpan PendenteAntigo { get; init; } = TimeSpan.FromHours(1);

    /// <summary>Último backup com sucesso mais velho que isto, com o caixa aberto: amarelo (o periódico é de 2 h).</summary>
    public TimeSpan BackupAntigo { get; init; } = TimeSpan.FromHours(4);

    /// <summary>Janela dos "erros recentes" do <c>log_local</c> e da regressão do relógio.</summary>
    public TimeSpan JanelaRecente { get; init; } = TimeSpan.FromHours(24);

    /// <summary>Desvio do relógio além disto, amarelo; além do crítico, vermelho (os mesmos do ERP, shared/terminais.ts).</summary>
    public TimeSpan DesvioRelogioAviso { get; init; } = TimeSpan.FromMinutes(2);

    public TimeSpan DesvioRelogioCritico { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>Quanto vale a liberação do supervisor para abrir o caixa com o disco quase cheio.</summary>
    public TimeSpan LiberacaoDisco { get; init; } = TimeSpan.FromHours(1);
}

/// <summary>
/// Painel de saúde da Central do PDV (bloco G4; plano 4.1; spec 32.2): roda as verificações <b>em paralelo</b>, fora da
/// thread da tela, cada uma com o limite de <see cref="OpcoesSaude.LimitePorVerificacao"/>: a que trava ou falha vira um
/// item amarelo e as outras aparecem assim mesmo (o tempo total fica no limite, nunca na soma). A verificação que passou
/// do limite e ainda roda não é disparada de novo: a rodada seguinte espera a mesma (uma thread presa, nunca uma por
/// minuto). Guarda a última rodada (<see cref="Ultimo"/>), que o ícone da barra lê. Ordem do Painel: vermelho, amarelo e
/// verde, e dentro de cada cor a ordem da composição. Tudo local: funciona sem internet. Antes de restaurar um backup,
/// <see cref="SuspenderAsync"/> espera as que estão rodando e não deixa outra começar (nada lê o banco durante a troca).
/// </summary>
public sealed class VerificadorSaude(IEnumerable<IVerificacaoSaude> verificacoes, OpcoesSaude opcoes, IRelogio relogio, ILogger<VerificadorSaude> log)
{
    /// <summary>Quanto a restauração espera as verificações em curso antes de seguir assim mesmo.</summary>
    public static readonly TimeSpan EsperaSuspensao = TimeSpan.FromSeconds(10);

    private readonly IReadOnlyList<IVerificacaoSaude> _verificacoes = [.. verificacoes];

    /// <summary>A verificação em curso de cada código (inclusive a que passou do limite e ainda não terminou).</summary>
    private readonly Dictionary<string, Task<ItemSaude>> _emCurso = new(StringComparer.Ordinal);

    private bool _suspenso;

    /// <summary>A última rodada (vazia antes da primeira).</summary>
    public ResultadoSaude Ultimo { get; private set; } = ResultadoSaude.Vazio;

    public IReadOnlyList<IVerificacaoSaude> Verificacoes => _verificacoes;

    /// <summary>Suspenso para a restauração do backup: nenhuma verificação começa até o app reabrir.</summary>
    public bool Suspenso
    {
        get
        {
            lock (_emCurso)
            {
                return _suspenso;
            }
        }
    }

    /// <param name="completa">Verdadeiro no Painel; falso na rodada do ícone (<see cref="IVerificacaoSaude.VerificarAsync"/>).</param>
    public async Task<ResultadoSaude> VerificarAsync(bool completa = true, CancellationToken ct = default)
    {
        if (Suspenso)
        {
            return Ultimo;
        }

        var rodadas = _verificacoes.Select(v => RodarAsync(v, completa, ct)).ToList();
        var itens = await Task.WhenAll(rodadas);
        var ordenados = itens
            .Select((item, indice) => (item, indice))
            .OrderByDescending(x => x.item.Nivel)
            .ThenBy(x => x.indice)
            .Select(x => x.item)
            .ToList();
        var resultado = new ResultadoSaude(ordenados, relogio.Agora, completa);
        Ultimo = resultado;
        return resultado;
    }

    /// <summary>
    /// Antes de restaurar o backup (C17): nenhuma verificação começa mais (até o app reabrir) e espera as que estão rodando
    /// — também a que passou do limite do Painel e segue em segundo plano com a conexão aberta, que no Windows impediria a
    /// troca do <c>pdv.db</c> — por até <paramref name="espera"/> (a travada de vez não prende a restauração).
    /// </summary>
    public async Task SuspenderAsync(TimeSpan? espera = null)
    {
        Task[] emCurso;
        lock (_emCurso)
        {
            _suspenso = true;
            emCurso = [.. _emCurso.Values];
        }

        if (emCurso.Length == 0)
        {
            return;
        }

        // A falha (ou o cancelamento pelo limite) de cada uma já virou aviso na rodada dela: aqui só importa terminar.
        await Task.WhenAll(emCurso).WaitAsync(espera ?? EsperaSuspensao).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        if (!emCurso.All(t => t.IsCompleted))
        {
            log.LogWarning("Verificações do Painel de saúde ainda rodando ao suspender para a restauração");
        }
    }

    /// <summary>A verificação em curso do código, ou uma nova (a que passou do limite e ainda roda é reaproveitada).</summary>
    private Task<ItemSaude> EmCurso(IVerificacaoSaude verificacao, bool completa, CancellationToken ct)
    {
        lock (_emCurso)
        {
            if (_suspenso)
            {
                return Task.FromResult(new ItemSaude(verificacao.Codigo, verificacao.Nome, NivelSaude.Aviso,
                    "Não conferido agora: o caixa está restaurando um backup.", "O GenesisPDV reabre sozinho depois da restauração."));
            }

            if (_emCurso.TryGetValue(verificacao.Codigo, out var atual))
            {
                return atual;
            }

            var limite = CancellationTokenSource.CreateLinkedTokenSource(ct);
            limite.CancelAfter(opcoes.LimitePorVerificacao);
            // Task.Run: a verificação que bloqueia (disco de rede, banco ocupado) não segura a tela nem as outras.
            var tarefa = Task.Run(() => verificacao.VerificarAsync(completa, limite.Token), limite.Token);
            _emCurso[verificacao.Codigo] = tarefa;
            _ = tarefa.ContinueWith(
                t =>
                {
                    lock (_emCurso)
                    {
                        if (_emCurso.TryGetValue(verificacao.Codigo, out var registrada) && registrada == t)
                        {
                            _emCurso.Remove(verificacao.Codigo);
                        }
                    }

                    limite.Dispose();
                },
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            return tarefa;
        }
    }

    private async Task<ItemSaude> RodarAsync(IVerificacaoSaude verificacao, bool completa, CancellationToken ct)
    {
        try
        {
            return await EmCurso(verificacao, completa, ct).WaitAsync(opcoes.LimitePorVerificacao, ct);
        }
        catch (Exception e) when (!ct.IsCancellationRequested && e is TimeoutException or OperationCanceledException)
        {
            log.LogWarning("Verificação {Codigo} do Painel de saúde não respondeu em {Limite}", verificacao.Codigo, opcoes.LimitePorVerificacao);
            return new ItemSaude(verificacao.Codigo, verificacao.Nome, NivelSaude.Aviso,
                $"Não deu para conferir agora (não respondeu em {opcoes.LimitePorVerificacao.TotalSeconds:0} s).",
                "Verifique de novo daqui a pouco (F5). Se repetir, chame o suporte.");
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogWarning(e, "Verificação {Codigo} do Painel de saúde falhou", verificacao.Codigo);
            return new ItemSaude(verificacao.Codigo, verificacao.Nome, NivelSaude.Aviso,
                $"Não deu para conferir agora ({MascaradorSuporte.Mascarar(e.Message)}).",
                "Verifique de novo daqui a pouco (F5). Se repetir, chame o suporte.");
        }
    }
}

/// <summary>
/// A rodada barata do Painel a cada <see cref="OpcoesSaude.IntervaloIcone"/> (plano 4.1): o ícone ⚠ da barra de status
/// da venda lê o <see cref="VerificadorSaude.Ultimo"/>. Liga depois do banco conferido (como o backup periódico) e nunca
/// roda o <c>integrity_check</c>. Falha só no log.
/// </summary>
public sealed class MonitorSaude(VerificadorSaude verificador, OpcoesSaude opcoes, ILogger<MonitorSaude> log) : IDisposable
{
    private readonly CancellationTokenSource _parar = new();
    private Task? _laco;
    private bool _descartado;

    /// <summary>Liga o laço (idempotente).</summary>
    public void Iniciar()
    {
        if (_laco is not null || _descartado)
        {
            return;
        }

        _laco = Task.Run(() => LacoAsync(_parar.Token));
    }

    /// <summary>
    /// Antes de restaurar o backup (C17; junto do <see cref="ServicoBackup.SuspenderParaRestauracao"/>): o laço para, a
    /// rodada em curso termina e nenhuma verificação começa até o app reabrir (nada lê o <c>pdv.db</c> durante a troca).
    /// </summary>
    public async Task SuspenderParaRestauracaoAsync()
    {
        if (!_descartado)
        {
            _parar.Cancel();
        }

        if (_laco is { } laco)
        {
            await laco.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        }

        await verificador.SuspenderAsync();
    }

    private async Task LacoAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await verificador.VerificarAsync(completa: false, ct);
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    log.LogWarning(e, "Rodada do Painel de saúde falhou");
                }

                await Task.Delay(opcoes.IntervaloIcone, ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
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
