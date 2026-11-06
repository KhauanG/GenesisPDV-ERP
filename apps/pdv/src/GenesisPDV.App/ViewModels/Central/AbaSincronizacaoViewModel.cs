using System.Collections.ObjectModel;
using System.Diagnostics;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Ciclo;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels.Central;

/// <summary>O que a aba 4 mostra: as vendas não confirmadas (o padrão), o caixa não confirmado, o outbox inteiro ou os comandos.</summary>
public enum VisaoSincronizacao
{
    Vendas,
    Caixa,
    Todos,
    Comandos,
}

/// <summary>Para onde a aba Sincronização leva o foco.</summary>
public enum AlvoFocoSincronizacao
{
    /// <summary>A lista (↑/↓, Enter, F6 e as teclas F funcionam dela).</summary>
    Lista,

    /// <summary>O detalhe (Esc volta à lista).</summary>
    Detalhe,
}

/// <summary>
/// Uma linha da aba 4: uma venda (as "vendas a copiar"), um registro do caixa, um evento do outbox ou um comando do ERP. A
/// cor vem da situação — amarelo pendente ou enviando, vermelho recusada, verde confirmada — e nunca vem sozinha: a
/// palavra da situação está sempre ao lado (PDV 9.1).
/// </summary>
public sealed class LinhaSincronizacaoViewModel(
    Guid chave, string? agregadoTipo, Guid? agregadoId, string situacao, string registro, string hora, string valor, string envio, string motivo,
    NivelLinhaSincronizacao nivel) : ViewModelBase
{
    /// <summary>A venda, o evento ou o comando da linha (a releitura mantém a escolhida por ela).</summary>
    public Guid Chave { get; } = chave;

    /// <summary>O agregado do detalhe (nulo no comando).</summary>
    public string? AgregadoTipo { get; } = agregadoTipo;

    public Guid? AgregadoId { get; } = agregadoId;

    /// <summary>"AGUARDANDO", "ENVIANDO", "NOVA TENTATIVA", "RECUSADA", "✓ CONFIRMADA"…</summary>
    public string Situacao { get; } = situacao;

    /// <summary>"Venda L01-C02-000013", "Sangria", "venda.finalizada nº 123".</summary>
    public string Registro { get; } = registro;

    public string Hora { get; } = hora;

    public string Valor { get; } = valor;

    /// <summary>"na fila desde 14:30 · 3 tentativas · próxima 14:35".</summary>
    public string Envio { get; } = envio;

    /// <summary>O motivo da recusa (ou da última falha), mascarado.</summary>
    public string Motivo { get; } = motivo;

    public NivelLinhaSincronizacao Nivel { get; } = nivel;

    public bool Pendente => Nivel == NivelLinhaSincronizacao.Pendente;

    public bool Recusada => Nivel == NivelLinhaSincronizacao.Recusada;

    public bool Confirmada => Nivel == NivelLinhaSincronizacao.Confirmada;

    public bool TemMotivo => Motivo.Length > 0;

    public string Leitura => $"{Situacao}. {Registro}. {Hora}. {Valor}. {Envio}. {Motivo}".Trim();
}

/// <summary>A cor da linha (sempre com a palavra ao lado).</summary>
public enum NivelLinhaSincronizacao
{
    /// <summary>Amarelo: ainda não subiu (o caixa envia sozinho).</summary>
    Pendente,

    /// <summary>Vermelho: a nuvem recusou (a decisão é no ERP).</summary>
    Recusada,

    /// <summary>Verde: confirmada pela nuvem.</summary>
    Confirmada,

    /// <summary>Sem cor: descartado no ERP, ou um comando.</summary>
    Neutra,
}

/// <summary>
/// Aba 4 da Central do PDV, <b>Sincronização</b> (bloco G7; plano 4; o pedido do dono de 04/11/2026, como as "vendas a
/// copiar" do Nuvem3). Abre nas <b>vendas não confirmadas pela nuvem</b> — uma linha por venda, amarela enquanto pendente
/// ou enviando, vermelha quando recusada (com o motivo da nuvem); a confirmada sai da lista (a que estava na tela fica verde
/// até a próxima leitura manual; a que o ERP descartou fica sem cor, "descartada no ERP", nunca verde). A segunda visão traz
/// o <b>caixa não confirmado</b> (aberturas, sangrias, reforços e fechamentos); a terceira, o outbox inteiro paginado por
/// situação e tipo; a quarta, os comandos recebidos do ERP. <b>F9</b> mostra a situação completa do F11 › S. O detalhe de
/// uma venda mostra os itens e os pagamentos (a regra em <see cref="ServicoSincronizacaoCentral.VendaDoDetalheAsync"/>),
/// cada envio (tentativas, quando, a próxima, o último erro e as dependências; nunca o payload) e as ocorrências do
/// <c>log_local</c> ligadas a ela, tudo mascarado. <b>F6 Reenviar agora</b> só força o
/// ciclo de envio de sempre (idempotente); não há descartar nem reprocessar aqui: a recusada é decidida no ERP. F4 declara
/// a lacuna de eventos (ou libera o reenvio), como no F11 › S, com <c>pdv.config.fiscal</c> na hora. Pede
/// <c>pdv.diagnostico.ver</c> (a própria ou a emprestada pelo Ctrl+L). Teclas: F3 troca a visão, ↑/↓ escolhem, Enter (ou *)
/// detalhe, PgDn/PgUp (ou + e −) página, F5 atualiza, F7/F8 situação e tipo na visão "Todos", F9 situação completa, Esc volta; tudo também pelo
/// mouse. A lista se atualiza sozinha quando o sync muda (o relógio da Central).
/// </summary>
public sealed partial class AbaSincronizacaoViewModel : ViewModelBase
{
    public const string MensagemLiberacaoAcabou = "A liberação acabou: a sincronização pede o supervisor de novo (Ctrl+L).";

    public const string MensagemSemPayload = "O conteúdo do registro (payload) não aparece aqui: o suporte o vê no ERP.";

    /// <summary>A tela na auditoria da lacuna (F4), como as outras abas da Central.</summary>
    public const string Localizacao = "PDV › Central do PDV › Sincronização";

    /// <summary>O título do F9 (o mesmo status do F11 › S).</summary>
    public const string TituloSituacaoCompleta = "Situação completa da sincronização";

    /// <summary>A lista relida sozinha, sem mudança do sync, a cada tanto (as tentativas e a próxima andam).</summary>
    public static readonly TimeSpan Releitura = TimeSpan.FromSeconds(15);

    /// <summary>As situações da visão "Todos" (F7), na ordem de <see cref="SituacaoFiltroEvento"/>.</summary>
    public static IReadOnlyList<string> Situacoes { get; } = ["a enviar", "recusados", "confirmados", "todos"];

    private readonly ShellViewModel _shell;
    private readonly ServicoSincronizacaoCentral _servico;
    private readonly AcessoCentral _acesso;
    private readonly TimeZoneInfo _fuso;
    private readonly Func<Task> _voltar;
    private readonly Dictionary<Guid, string> _nomes = [];

    /// <summary>O começo de cada página já vista (a primeira é nula): o PgUp volta pelo cursor guardado.</summary>
    private readonly List<object?> _inicios = [null];

    /// <summary>
    /// As vendas da tela que o ERP resolveu nesta visita: as confirmadas ficam verdes, as descartadas sem cor ("descartada
    /// no ERP"), até a próxima leitura manual (F5, a visão, a página, a volta).
    /// </summary>
    private readonly Dictionary<Guid, LinhaSincronizacaoViewModel> _resolvidasAgora = [];

    /// <summary>A linha do F9 (a situação completa) no lugar do detalhe de um registro.</summary>
    private readonly LinhaSincronizacaoViewModel _linhaSituacao = new(
        Guid.Empty, null, null, string.Empty, TituloSituacaoCompleta, string.Empty, string.Empty, string.Empty, string.Empty, NivelLinhaSincronizacao.Neutra);

    private object? _proxima;
    private int _versao;

    /// <summary>A leitura do detalhe (só a dele): a releitura da lista não descarta o detalhe que está sendo aberto.</summary>
    private int _versaoDetalhe;
    private bool? _viaDiagnostico;
    private (int Pendentes, int Rejeitados, bool Online)? _ultimaSituacao;
    private long _ultimaLeitura;
    private IReadOnlyList<string> _tipos = [];

    /// <summary>O agregado (ou comando) do detalhe aberto: a releitura sozinha o atualiza.</summary>
    private LinhaSincronizacaoViewModel? _linhaDetalhe;

    /// <param name="voltar">Esc: volta ao menu da Central.</param>
    public AbaSincronizacaoViewModel(ShellViewModel shell, Func<Task> voltar)
    {
        _shell = shell;
        _servico = shell.Servico<ServicoSincronizacaoCentral>();
        _acesso = shell.Servico<AcessoCentral>();
        _fuso = DiaOperacional.ObterFuso(shell.Servico<SessaoTerminal>().FusoHorario);
        _voltar = voltar;
    }

    public string Titulo => AbasCentral.Sincronizacao.Rotulo;

    public string Teclas =>
        "F3 troca a lista · ↑/↓ escolhem · Enter (ou *) detalhe · F6 Reenviar agora · PgDn/PgUp (ou + e −) página · F5 atualiza · F9 situação completa"
        + (Visao == VisaoSincronizacao.Todos ? " · F7 situação · F8 tipo" : string.Empty)
        + (AcaoLacuna is not null ? " · F4 lacuna" : string.Empty)
        + " · Esc volta ao menu";

    public string TeclasDetalhe => "↑/↓ (ou 8/2) e PgUp/PgDn (ou 9/3) rolam · F6 " + RotuloReenvio + " · Esc volta à lista";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Teclas), nameof(Explicacao), nameof(NaVisaoTodos), nameof(VisaoVendas), nameof(VisaoCaixa), nameof(VisaoTodos), nameof(VisaoComandos))]
    public partial VisaoSincronizacao Visao { get; set; }

    public bool NaVisaoTodos => Visao == VisaoSincronizacao.Todos;

    public bool VisaoVendas => Visao == VisaoSincronizacao.Vendas;

    public bool VisaoCaixa => Visao == VisaoSincronizacao.Caixa;

    public bool VisaoTodos => Visao == VisaoSincronizacao.Todos;

    public bool VisaoComandos => Visao == VisaoSincronizacao.Comandos;

    /// <summary>O que a visão aberta mostra, em palavras de balcão.</summary>
    public string Explicacao => Visao switch
    {
        VisaoSincronizacao.Vendas =>
            "Vendas que a nuvem ainda não confirmou: AMARELO ainda não subiu (o caixa envia sozinho, na ordem); VERMELHO a nuvem recusou " +
            "(a decisão é no ERP). A confirmada sai da lista.",
        VisaoSincronizacao.Caixa =>
            "Aberturas, sangrias, reforços e fechamentos que a nuvem ainda não confirmou (as mesmas cores das vendas).",
        VisaoSincronizacao.Todos => "Todos os registros que este caixa gravou para a nuvem, com a situação de cada um (sem o conteúdo).",
        _ => "Os comandos que o ERP mandou a este caixa (mensagens, sincronizações) e o que o caixa fez com eles.",
    };

    /// <summary>"Vendas não confirmadas (3)" (o botão da visão).</summary>
    [ObservableProperty]
    public partial string TextoVisaoVendas { get; set; } = "Vendas não confirmadas";

    [ObservableProperty]
    public partial string TextoVisaoCaixa { get; set; } = "Caixa não confirmado";

    public string TextoVisaoTodos => "Todos os registros";

    [ObservableProperty]
    public partial string TextoVisaoComandos { get; set; } = "Comandos do ERP";

    /// <summary>"● Online · última confirmação 05/11 14:32 · 3 a enviar · 1 recusado".</summary>
    [ObservableProperty]
    public partial string Resumo { get; set; } = string.Empty;

    [ObservableProperty]
    public partial bool ResumoComProblema { get; set; }

    /// <summary>"Último erro da conexão: …" (o porquê de nada subir: 401, DNS, TLS…), mascarado; nulo esconde a linha.</summary>
    [ObservableProperty]
    public partial string? ErroConexao { get; set; }

    /// <summary>A lacuna de eventos (F4), quando há; nulo esconde a linha e o botão.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Teclas))]
    public partial string? AcaoLacuna { get; set; }

    public ObservableCollection<LinhaSincronizacaoViewModel> Linhas { get; } = [];

    [ObservableProperty]
    public partial LinhaSincronizacaoViewModel? Selecionada { get; set; }

    [ObservableProperty]
    public partial string Rodape { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string? Mensagem { get; set; }

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [ObservableProperty]
    public partial bool Carregando { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TemAnterior))]
    public partial int Pagina { get; set; } = 1;

    [ObservableProperty]
    public partial bool TemProxima { get; set; }

    public bool TemAnterior => Pagina > 1;

    /// <summary>A situação da visão "Todos" (F7), o índice de <see cref="SituacaoFiltroEvento"/>.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TextoSituacao))]
    public partial SituacaoFiltroEvento SituacaoTodos { get; set; } = SituacaoFiltroEvento.AEnviar;

    /// <summary>O tipo da visão "Todos" (F8; nulo = todos; só nos a enviar e recusados, os poucos).</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TextoTipo))]
    public partial string? TipoTodos { get; set; }

    public string TextoSituacao => $"F7  Situação: {Situacoes[(int)SituacaoTodos]}";

    public string TextoTipo => SituacaoTodos is SituacaoFiltroEvento.AEnviar or SituacaoFiltroEvento.Recusados
        ? $"F8  Tipo: {(TipoTodos is null ? "todos" : TiposEvento.Rotulo(TipoTodos))}"
        : "F8  Tipo: todos (filtro nos a enviar e recusados)";

    // --- Detalhe (Enter) ---

    [ObservableProperty]
    public partial bool MostrandoDetalhe { get; set; }

    [ObservableProperty]
    public partial string TituloDetalhe { get; set; } = string.Empty;

    /// <summary>A faixa colorida do detalhe: o que está acontecendo e o que fazer.</summary>
    [ObservableProperty]
    public partial string? SituacaoDetalhe { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(DetalhePendente), nameof(DetalheRecusado), nameof(DetalheConfirmado))]
    public partial NivelLinhaSincronizacao NivelDetalhe { get; set; }

    public bool DetalhePendente => NivelDetalhe == NivelLinhaSincronizacao.Pendente;

    public bool DetalheRecusado => NivelDetalhe == NivelLinhaSincronizacao.Recusada;

    public bool DetalheConfirmado => NivelDetalhe == NivelLinhaSincronizacao.Confirmada;

    public ObservableCollection<string> LinhasDetalhe { get; } = [];

    /// <summary>"Reenviar agora" (pendente) ou "Conferir no ERP agora" (recusada): o mesmo ciclo de envio.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TeclasDetalhe), nameof(TextoBotaoReenvio))]
    public partial string RotuloReenvio { get; set; } = "Reenviar agora";

    public string TextoBotaoReenvio => $"F6  {RotuloReenvio}";

    /// <summary>A lacuna sem <c>pdv.config.fiscal</c>: usuário, PIN e motivo de quem a tem, na hora (31.3).</summary>
    [ObservableProperty]
    public partial PedidoLiberacaoViewModel? Liberacao { get; set; }

    /// <summary>A leitura em curso (os testes a aguardam).</summary>
    public Task Atualizacao { get; private set; } = Task.CompletedTask;

    /// <summary>Só os testes: esperado na leitura do detalhe, fora da thread da tela (a corrida com a releitura da lista).</summary>
    internal Func<Task>? AntesDeLerDetalhe { get; set; }

    public event EventHandler<AlvoFocoSincronizacao>? FocoSolicitado;

    /// <summary>A Central pede o foco no conteúdo (o 4 de novo no menu).</summary>
    public void Focar() => FocoSolicitado?.Invoke(this, MostrandoDetalhe ? AlvoFocoSincronizacao.Detalhe : AlvoFocoSincronizacao.Lista);

    /// <summary>Abre a aba (e a cada visita): a visão de antes, da primeira página, sem as verdes da visita anterior.</summary>
    public Task CarregarAsync()
    {
        _resolvidasAgora.Clear();
        ReiniciarPaginas();
        return Atualizacao = LerAsync(manual: true);
    }

    /// <summary>
    /// O relógio da Central (1 s): o sync mudou (pendentes, recusados, conexão) ou passou <see cref="Releitura"/>: lê de
    /// novo a mesma página (e o detalhe aberto), sem tirar as verdes. Nada com o pedido do supervisor na tela.
    /// </summary>
    public void Tique()
    {
        if (Carregando || Liberacao is not null || _viaDiagnostico != true)
        {
            return;
        }

        var s = _servico.Situacao;
        var agora = (s.Pendentes, s.Rejeitados, s.Online);
        if (agora == _ultimaSituacao && Stopwatch.GetElapsedTime(_ultimaLeitura) < Releitura)
        {
            return;
        }

        Atualizacao = LerAsync(manual: false);
    }

    /// <summary>
    /// O relógio da Central: a liberação que emprestou o diagnóstico acabou. Nada do que ela mostrava fica na aba (a lista,
    /// o detalhe, o pedido do supervisor): a próxima visita lê de novo, com quem pode então.
    /// </summary>
    public void ConferirPermissoes()
    {
        var antes = _viaDiagnostico;
        _viaDiagnostico = _servico.VeDiagnostico;
        if (antes != true || _viaDiagnostico == true)
        {
            return;
        }

        _versao++;
        Carregando = false;
        Liberacao = null;
        FecharDetalhe(focar: false);
        Linhas.Clear();
        _resolvidasAgora.Clear();
        Selecionada = null;
        Rodape = string.Empty;
        Resumo = string.Empty;
        ErroConexao = null;
        Mensagem = null;
        Erro = null;
    }

    private void ReiniciarPaginas()
    {
        _inicios.Clear();
        _inicios.Add(null);
        Pagina = 1;
        _proxima = null;
    }

    private async Task LerAsync(bool manual)
    {
        var versao = ++_versao;
        if (manual)
        {
            Erro = null;
        }

        Carregando = true;
        try
        {
            var visao = Visao;
            var inicio = _inicios[^1];
            var filtro = new FiltroEventos(SituacaoTodos, TipoTodos);
            // As vendas abertas da tela, para a que sair dela ficar verde (ou "descartada no ERP"): só na releitura sozinha da
            // mesma página; a leitura manual (F5, a página, a visão, a volta) recomeça sem elas.
            var anteriores = visao == VisaoSincronizacao.Vendas && !manual
                ? Linhas.Where(l => l.Nivel is NivelLinhaSincronizacao.Pendente or NivelLinhaSincronizacao.Recusada).ToDictionary(l => l.Chave)
                : [];
            var conhecidos = _nomes.Keys.ToHashSet();
            var leitura = await Task.Run(() => LerDoBancoAsync(visao, inicio, filtro, anteriores.Keys.ToList(), conhecidos));
            if (versao != _versao)
            {
                return;
            }

            _viaDiagnostico = true;
            _ultimaSituacao = (leitura.Situacao.Pendentes, leitura.Situacao.Rejeitados, leitura.Situacao.Online);
            _ultimaLeitura = Stopwatch.GetTimestamp();
            foreach (var (id, nome) in leitura.Nomes)
            {
                _nomes[id] = nome;
            }

            MostrarResumo(leitura);
            _tipos = leitura.Tipos;
            // A venda que estava na tela e a nuvem confirmou (o envio passou ou o ERP reprocessou) fica verde até a leitura
            // manual; a que o ERP descartou fica sem cor, "descartada no ERP" (a nuvem não a tem: nunca verde).
            foreach (var id in leitura.Resolvidas.Confirmadas)
            {
                if (anteriores.TryGetValue(id, out var antes))
                {
                    _resolvidasAgora[id] = Verde(antes);
                }
            }

            foreach (var id in leitura.Resolvidas.Descartadas)
            {
                if (anteriores.TryGetValue(id, out var antes))
                {
                    _resolvidasAgora[id] = Descartada(antes);
                }
            }

            var escolhida = Selecionada?.Chave;
            Linhas.Clear();
            if (visao == VisaoSincronizacao.Vendas)
            {
                foreach (var resolvida in _resolvidasAgora.Values)
                {
                    Linhas.Add(resolvida);
                }
            }

            foreach (var linha in leitura.Linhas(this))
            {
                _resolvidasAgora.Remove(linha.Chave);
                Linhas.Add(linha);
            }

            Selecionada = Linhas.FirstOrDefault(l => l.Chave == escolhida) ?? Linhas.FirstOrDefault();
            _proxima = leitura.Proxima;
            TemProxima = leitura.Proxima is not null;
            Rodape = leitura.Rodape(Pagina) + (TemProxima ? " · PgDn mais" : string.Empty);
            if (MostrandoDetalhe && _linhaDetalhe is { } aberta)
            {
                // O detalhe aberto acompanha (a venda que ficou verde diz que foi confirmada).
                await MostrarDetalheAsync(aberta, ++_versaoDetalhe);
            }
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            if (versao == _versao)
            {
                Tratar(e);
            }
        }
        finally
        {
            if (versao == _versao)
            {
                Carregando = false;
            }
        }
    }

    /// <summary>Tudo o que uma leitura traz do banco (fora da thread da tela).</summary>
    private async Task<Leitura> LerDoBancoAsync(
        VisaoSincronizacao visao, object? inicio, FiltroEventos filtro, IReadOnlyCollection<Guid> anteriores, HashSet<Guid> conhecidos)
    {
        var status = await _servico.StatusAsync();
        var recusados = await _servico.ContagemRecusadosAsync();
        var vendas = await _servico.VendasNaoConfirmadasAsync(visao == VisaoSincronizacao.Vendas ? inicio as CursorNaoConfirmados : null);
        var caixa = await _servico.CaixaNaoConfirmadoAsync(visao == VisaoSincronizacao.Caixa ? inicio as CursorNaoConfirmados : null);
        var (comandos, qtdComandos) = await _servico.ComandosAsync();
        PaginaEventos? todos = null;
        IReadOnlyList<string> tipos = [];
        IReadOnlyDictionary<Guid, AgregadoSincronizacao> agregados = new Dictionary<Guid, AgregadoSincronizacao>();
        if (visao == VisaoSincronizacao.Todos)
        {
            todos = await _servico.EventosAsync(filtro, inicio as long?);
            tipos = await _servico.TiposAsync(filtro.Situacao);
        }

        var eventos = visao switch
        {
            VisaoSincronizacao.Caixa => caixa.Eventos,
            VisaoSincronizacao.Todos => todos!.Eventos,
            _ => [],
        };
        if (eventos.Count > 0)
        {
            agregados = await _servico.AgregadosAsync(eventos);
        }

        // As que saíram da lista: confirmadas pela nuvem (verdes), descartadas no ERP (sem cor) ou só fora da página.
        var naPagina = vendas.Vendas.Select(v => v.VendaId).ToHashSet();
        var sairam = anteriores.Where(id => !naPagina.Contains(id)).ToList();
        var resolvidas = sairam.Count > 0 ? await _servico.VendasResolvidasAsync(sairam) : new VendasResolvidas(new HashSet<Guid>(), new HashSet<Guid>());
        var operadores = vendas.Vendas.Select(v => v.OperadorId).Concat(agregados.Values.Select(a => a.OperadorId))
            .OfType<Guid>().Distinct().Where(id => !conhecidos.Contains(id)).ToList();
        var nomes = new List<(Guid, string)>();
        foreach (var id in operadores)
        {
            nomes.Add((id, await _shell.Servico<ServicoCaixa>().NomeUsuarioAsync(id)));
        }

        return new Leitura(visao, _servico.Situacao, status, recusados, vendas, caixa, todos, comandos, qtdComandos, tipos, agregados, resolvidas, nomes);
    }

    private void MostrarResumo(Leitura l)
    {
        var (indicador, nivel) = IndicadorSync.Calcular(l.Situacao, DateTimeOffset.UtcNow);
        var aEnviar = l.Status.PendentesPorTipo.Values.Sum();
        // O vermelho é só o que espera a decisão do ERP; o descartado lá (decisão final) é citado à parte, sem cor.
        var (recusados, descartados) = (l.Recusados.SemDecisao, l.Recusados.Descartados);
        Resumo = $"{indicador} · última confirmação da nuvem: {Hora(l.Status.UltimoPushSucessoEm)} · "
                 + (aEnviar == 1 ? "1 registro a enviar" : $"{aEnviar} registros a enviar") + " · "
                 + (recusados == 1 ? "1 recusado" : $"{recusados} recusados")
                 + (descartados switch { 0 => string.Empty, 1 => " · 1 descartado no ERP", _ => $" · {descartados} descartados no ERP" })
                 + (l.Status.FilaImpressao > 0 ? $" · {l.Status.FilaImpressao} na fila de impressão" : string.Empty);
        ResumoComProblema = nivel == NivelIndicador.Erro || recusados > 0;
        ErroConexao = l.Situacao.Erro is { Length: > 0 } erro ? $"Último erro da conexão: {Mascarar(erro)} (F9 situação completa)" : null;
        TextoVisaoVendas = $"Vendas não confirmadas ({l.Vendas.Quantidade})";
        TextoVisaoCaixa = $"Caixa não confirmado ({l.Caixa.Quantidade})";
        TextoVisaoComandos = $"Comandos do ERP ({l.QuantidadeComandos})";
        AcaoLacuna = l.Situacao.Lacuna switch
        {
            { Recuperavel: false } lacuna =>
                $"Lacuna de eventos {lacuna.Faixa}: a nuvem espera registros que este caixa não tem mais (vendas novas bloqueadas). " +
                "F4 declara a lacuna (supervisor com pdv.config.fiscal).",
            { Recuperavel: true } lacuna =>
                $"Os registros da lacuna {lacuna.Faixa} foram achados e esperam a liberação do reenvio: F4 (supervisor com pdv.config.fiscal).",
            _ => null,
        };
    }

    /// <summary>A linha de uma venda não confirmada (amarela pendente, vermelha recusada).</summary>
    internal LinhaSincronizacaoViewModel LinhaVenda(VendaNaoConfirmada v)
    {
        var situacao = v.Recusada ? "RECUSADA" : v.Enviando ? "ENVIANDO" : v.ProximaTentativaEm is not null ? "NOVA TENTATIVA" : "AGUARDANDO";
        var registro = $"Venda {v.Numero ?? "(não está neste caixa)"}" + (v.StatusVenda == Core.Vendas.StatusVenda.Cancelada ? " · cancelada" : string.Empty);
        var motivo = v.Recusada || v.ProximaTentativaEm is not null ? Mascarar(v.Motivo) : string.Empty;
        return new LinhaSincronizacaoViewModel(
            v.VendaId, ConsultasSincronizacaoLocal.AgregadoVenda, v.VendaId, situacao, registro, v.Hora is { } h ? Hora(h) : "—",
            v.Total is { } t ? NumeroBr.Dinheiro(t) : "—", Envio(v.NaFilaDesde, v.Tentativas, v.ProximaTentativaEm, v.Recusada), motivo,
            v.Recusada ? NivelLinhaSincronizacao.Recusada : NivelLinhaSincronizacao.Pendente);
    }

    /// <summary>A linha de um evento (o caixa não confirmado e a visão "Todos").</summary>
    internal LinhaSincronizacaoViewModel LinhaEvento(EventoSincronizacao e, AgregadoSincronizacao? agregado)
    {
        var (situacao, nivel) = SituacaoEvento(e);
        var registro = TiposEvento.Rotulo(e.Tipo) + (agregado?.NumeroVenda is { } numero ? $" {numero}" : string.Empty) + $" · nº {e.Sequencia}";
        // O valor do agregado vale para a abertura (o fundo de troco) e o movimento; o fechamento e o cancelamento do
        // movimento não têm um valor deles aqui (o fechamento conferido fica no ERP).
        var valor = agregado?.Valor is { } v && e.Tipo is not ("caixa.fechado" or "caixa.movimento_cancelado") ? NumeroBr.Dinheiro(v) : "—";
        var motivo = e.Recusado || e.Status == StatusEventoSaida.ErroTemporario || e.Descartado ? Mascarar(e.UltimoErro) : string.Empty;
        return new LinhaSincronizacaoViewModel(
            e.Id, e.AgregadoTipo, e.AgregadoId, situacao, registro, Hora(e.OcorridoEm), valor,
            e.Status == StatusEventoSaida.Confirmado ? $"confirmado {Hora(e.ConfirmadoEm)}" : Envio(e.CriadoEm, e.Tentativas, e.ProximaTentativaEm, e.Recusado),
            motivo, nivel);
    }

    private LinhaSincronizacaoViewModel LinhaComando(ComandoSincronizacao c) => new(
        c.Id, null, null, c.Status switch { "executado" => "EXECUTADO", "falhou" => "FALHOU", _ => "RECEBIDO" },
        TiposEvento.RotuloComando(c.Tipo), Hora(c.RecebidoEm), "—", string.Empty,
        // O resultado é JSON ({"erro": …}, com a quebra de linha e a aspa escapadas): valor a valor, como o detalhe da aba 5.
        MascaradorSuporte.MascararDetalhes(c.Resultado) ?? string.Empty,
        c.Status == "falhou" ? NivelLinhaSincronizacao.Recusada : NivelLinhaSincronizacao.Neutra);

    private static LinhaSincronizacaoViewModel Verde(LinhaSincronizacaoViewModel antes) => new(
        antes.Chave, antes.AgregadoTipo, antes.AgregadoId, "✓ CONFIRMADA", antes.Registro, antes.Hora, antes.Valor, "confirmada pela nuvem agora",
        string.Empty, NivelLinhaSincronizacao.Confirmada);

    /// <summary>A venda que o ERP descartou: sem cor e sem ✓ (a nuvem não a tem; é a decisão final, não um envio que passou).</summary>
    private static LinhaSincronizacaoViewModel Descartada(LinhaSincronizacaoViewModel antes) => new(
        antes.Chave, antes.AgregadoTipo, antes.AgregadoId, "DESCARTADA NO ERP", antes.Registro, antes.Hora, antes.Valor,
        "decisão final: a nuvem não tem esta venda", string.Empty, NivelLinhaSincronizacao.Neutra);

    internal static (string Situacao, NivelLinhaSincronizacao Nivel) SituacaoEvento(EventoSincronizacao e) => e switch
    {
        { Status: StatusEventoSaida.Confirmado } => ("✓ CONFIRMADO", NivelLinhaSincronizacao.Confirmada),
        { Descartado: true } => ("DESCARTADO NO ERP", NivelLinhaSincronizacao.Neutra),
        { Status: StatusEventoSaida.Rejeitado } => ("RECUSADO", NivelLinhaSincronizacao.Recusada),
        { Status: StatusEventoSaida.Enviando } => ("ENVIANDO", NivelLinhaSincronizacao.Pendente),
        { Status: StatusEventoSaida.ErroTemporario } => ("NOVA TENTATIVA", NivelLinhaSincronizacao.Pendente),
        _ => ("AGUARDANDO", NivelLinhaSincronizacao.Pendente),
    };

    private string Envio(DateTimeOffset desde, int tentativas, DateTimeOffset? proxima, bool recusada) =>
        $"na fila desde {Hora(desde)}"
        + (tentativas switch { 0 => string.Empty, 1 => " · 1 tentativa", _ => $" · {tentativas} tentativas" })
        + (!recusada && proxima is { } p ? $" · próxima {HoraCurta(p)}" : string.Empty);

    // --- Comandos ---

    [RelayCommand]
    private void Mover(string direcao)
    {
        if (Linhas.Count == 0 || MostrandoDetalhe || Liberacao is not null)
        {
            return;
        }

        var i = Selecionada is null ? -1 : Linhas.IndexOf(Selecionada);
        Selecionada = Linhas[direcao == "acima" ? Math.Max(0, i - 1) : Math.Min(Linhas.Count - 1, i + 1)];
    }

    /// <summary>F3 (Shift+F3 volta) ou o botão da visão: vendas, caixa, todos, comandos.</summary>
    [RelayCommand]
    private Task TrocarVisao(string? para)
    {
        if (MostrandoDetalhe || Liberacao is not null)
        {
            return Task.CompletedTask;
        }

        var visoes = Enum.GetValues<VisaoSincronizacao>();
        var nova = para switch
        {
            "anterior" => visoes[(Array.IndexOf(visoes, Visao) + visoes.Length - 1) % visoes.Length],
            null or "" or "proxima" => visoes[(Array.IndexOf(visoes, Visao) + 1) % visoes.Length],
            _ => Enum.Parse<VisaoSincronizacao>(para),
        };
        Visao = nova;
        Mensagem = null;
        Selecionada = null;
        Linhas.Clear();
        _resolvidasAgora.Clear();
        ReiniciarPaginas();
        FocoSolicitado?.Invoke(this, AlvoFocoSincronizacao.Lista);
        return Atualizacao = LerAsync(manual: true);
    }

    /// <summary>F7 (visão "Todos"): a próxima situação.</summary>
    [RelayCommand]
    private Task ProximaSituacao()
    {
        if (!NaVisaoTodos || MostrandoDetalhe || Liberacao is not null)
        {
            return Task.CompletedTask;
        }

        SituacaoTodos = (SituacaoFiltroEvento)(((int)SituacaoTodos + 1) % Situacoes.Count);
        TipoTodos = null;
        OnPropertyChanged(nameof(TextoTipo));
        ReiniciarPaginas();
        return Atualizacao = LerAsync(manual: true);
    }

    /// <summary>F8 (visão "Todos", nos a enviar e recusados): o próximo tipo que existe na situação.</summary>
    [RelayCommand]
    private Task ProximoTipo()
    {
        if (!NaVisaoTodos || MostrandoDetalhe || Liberacao is not null || SituacaoTodos is not (SituacaoFiltroEvento.AEnviar or SituacaoFiltroEvento.Recusados))
        {
            return Task.CompletedTask;
        }

        var opcoes = new List<string?> { null };
        opcoes.AddRange(_tipos);
        var i = opcoes.IndexOf(TipoTodos);
        TipoTodos = opcoes[(i + 1) % opcoes.Count];
        ReiniciarPaginas();
        return Atualizacao = LerAsync(manual: true);
    }

    /// <summary>PgDn (ou +): a página seguinte, pelo cursor.</summary>
    [RelayCommand]
    private Task ProximaPagina()
    {
        if (_proxima is not { } proxima || MostrandoDetalhe || Liberacao is not null)
        {
            return Task.CompletedTask;
        }

        _inicios.Add(proxima);
        Pagina++;
        Selecionada = null;
        // As verdes (e as descartadas) eram da página que saiu: a troca de página é uma leitura manual.
        _resolvidasAgora.Clear();
        return Atualizacao = LerAsync(manual: true);
    }

    /// <summary>PgUp (ou −): a página anterior.</summary>
    [RelayCommand]
    private Task PaginaAnterior()
    {
        if (_inicios.Count <= 1 || MostrandoDetalhe || Liberacao is not null)
        {
            return Task.CompletedTask;
        }

        _inicios.RemoveAt(_inicios.Count - 1);
        Pagina--;
        Selecionada = null;
        _resolvidasAgora.Clear();
        return Atualizacao = LerAsync(manual: true);
    }

    /// <summary>F5: lê de novo (as verdes saem); com o detalhe aberto, ele é relido; com o pedido do supervisor, nada.</summary>
    [RelayCommand]
    private Task Atualizar()
    {
        if (Liberacao is not null)
        {
            return Task.CompletedTask;
        }

        Mensagem = null;
        _resolvidasAgora.Clear();
        return Atualizacao = LerAsync(manual: true);
    }

    /// <summary>
    /// F6 "Reenviar agora" (o pedido do dono): só força o ciclo de envio de sempre (push, heartbeat, pull e a consulta das
    /// recusadas no ERP), como o Ctrl+Alt+S. Não muda nenhum registro: apertar duas vezes não duplica nada.
    /// </summary>
    [RelayCommand]
    private Task Reenviar() => Tentar(() =>
    {
        if (Liberacao is not null)
        {
            return Task.CompletedTask;
        }

        ExigirAlcance();
        Mensagem = _servico.ReenviarAgora();
        return Task.CompletedTask;
    });

    /// <summary>Enter (ou o duplo clique, ou o *): o detalhe da linha; de novo, fecha.</summary>
    [RelayCommand]
    private Task Detalhar(LinhaSincronizacaoViewModel? linha) => Tentar(async () =>
    {
        if (Liberacao is not null)
        {
            return;
        }

        if (MostrandoDetalhe)
        {
            FecharDetalhe();
            return;
        }

        ExigirAlcance();
        var pedida = linha ?? Selecionada ?? throw new RegraNegocioException(Linhas.Count == 0 ? "Nada na lista." : "Escolha uma linha (setas ↑/↓ ou clique).");
        Selecionada = pedida;
        await AbrirDetalheAsync(pedida);
    });

    /// <summary>F9 (ou o botão): a situação completa da sincronização (o mesmo do F11 › S) no painel do detalhe; de novo, fecha.</summary>
    [RelayCommand]
    private Task SituacaoCompleta() => Tentar(async () =>
    {
        if (Liberacao is not null)
        {
            return;
        }

        if (MostrandoDetalhe)
        {
            var eraSituacao = _linhaDetalhe == _linhaSituacao;
            FecharDetalhe();
            if (eraSituacao)
            {
                return;
            }
        }

        ExigirAlcance();
        await AbrirDetalheAsync(_linhaSituacao);
    });

    /// <summary>
    /// Lê e mostra o detalhe de <paramref name="pedida"/> e só então abre o painel. A versão é a do detalhe: a releitura da
    /// lista que o relógio dispara no meio não o descarta (o painel não abre vazio); outro detalhe pedido, ou fechado, sim.
    /// </summary>
    private async Task AbrirDetalheAsync(LinhaSincronizacaoViewModel pedida)
    {
        _linhaDetalhe = pedida;
        Mensagem = null;
        Erro = null;
        var versao = ++_versaoDetalhe;
        await MostrarDetalheAsync(pedida, versao);
        if (_linhaDetalhe == pedida && versao == _versaoDetalhe)
        {
            MostrandoDetalhe = true;
            FocoSolicitado?.Invoke(this, AlvoFocoSincronizacao.Detalhe);
        }
    }

    /// <summary>O F9: as linhas do F11 › S (<see cref="TextoStatusSync"/>), mascaradas, com a hora em segundos.</summary>
    private async Task MostrarSituacaoCompletaAsync(int versao)
    {
        var status = await Task.Run(() => _servico.StatusAsync());
        if (versao != _versaoDetalhe || _linhaDetalhe != _linhaSituacao)
        {
            return;
        }

        var s = _servico.Situacao;
        var (indicador, nivel) = IndicadorSync.Calcular(s, DateTimeOffset.UtcNow);
        TituloDetalhe = TituloSituacaoCompleta;
        NivelDetalhe = nivel switch
        {
            NivelIndicador.Erro => NivelLinhaSincronizacao.Recusada,
            NivelIndicador.Aviso => NivelLinhaSincronizacao.Pendente,
            _ => NivelLinhaSincronizacao.Neutra,
        };
        SituacaoDetalhe = $"{indicador}. O mesmo status do F11 › S da venda: as trocas com a nuvem, os cursores, os pendentes, os recusados e o último erro.";
        RotuloReenvio = "Reenviar agora";
        LinhasDetalhe.Clear();
        foreach (var l in TextoStatusSync.Linhas(s, status, HoraSegundos))
        {
            LinhasDetalhe.Add(Mascarar(l));
        }
    }

    /// <summary>Monta o detalhe de <paramref name="linha"/> (a venda, o agregado do evento, o comando ou a situação completa), sem payload.</summary>
    private async Task MostrarDetalheAsync(LinhaSincronizacaoViewModel linha, int versao)
    {
        if (linha == _linhaSituacao)
        {
            await MostrarSituacaoCompletaAsync(versao);
            return;
        }

        var comando = linha.AgregadoId is null;
        DetalheSincronizacao? detalhe = null;
        Core.Vendas.Venda? venda = null;
        string? semVenda = null;
        var espera = AntesDeLerDetalhe;
        if (!comando)
        {
            var id = linha.AgregadoId!.Value;
            var ehVenda = linha.AgregadoTipo == ConsultasSincronizacaoLocal.AgregadoVenda;
            (detalhe, venda, semVenda) = await Task.Run(async () =>
            {
                if (espera is not null)
                {
                    await espera();
                }

                var d = await _servico.DetalheAsync(id);
                if (!ehVenda)
                {
                    return (d, (Core.Vendas.Venda?)null, (string?)null);
                }

                // Os itens e os pagamentos: a venda "a copiar" sempre; a que a nuvem já tem, com a regra da aba 1 (o serviço decide).
                var aCopiar = d?.Eventos.Any(e => e.Status != StatusEventoSaida.Confirmado && !e.Descartado) == true;
                var (v, sem) = await _servico.VendaDoDetalheAsync(id, aCopiar, d?.Agregado?.Quando);
                return (d, v, sem);
            });
        }

        if (versao != _versaoDetalhe || _linhaDetalhe != linha)
        {
            return;
        }

        LinhasDetalhe.Clear();
        if (comando)
        {
            TituloDetalhe = $"Comando do ERP · {linha.Registro}";
            NivelDetalhe = linha.Nivel;
            SituacaoDetalhe = $"{linha.Situacao}: recebido em {linha.Hora}.";
            RotuloReenvio = "Reenviar agora";
            LinhasDetalhe.Add($"Comando {linha.Chave}");
            LinhasDetalhe.Add(linha.Motivo.Length > 0 ? $"Resultado: {linha.Motivo}" : "Resultado: —");
            return;
        }

        foreach (var l in LinhasDoDetalhe(linha, detalhe, venda, semVenda))
        {
            LinhasDetalhe.Add(l);
        }
    }

    /// <summary>As linhas do detalhe de um agregado: a venda (itens e pagamentos), cada envio e as ocorrências ligadas.</summary>
    private IEnumerable<string> LinhasDoDetalhe(LinhaSincronizacaoViewModel linha, DetalheSincronizacao? detalhe, Core.Vendas.Venda? venda, string? semVenda)
    {
        var eventos = detalhe?.Eventos ?? [];
        var abertos = eventos.Where(e => e.Status != StatusEventoSaida.Confirmado && !e.Descartado).ToList();
        var recusado = abertos.FirstOrDefault(e => e.Recusado);
        var ehVenda = linha.AgregadoTipo == ConsultasSincronizacaoLocal.AgregadoVenda;
        var nome = ehVenda ? $"Venda {detalhe?.Agregado?.NumeroVenda ?? venda?.NumeroExibicao ?? "(não está neste caixa)"}" : TiposEvento.RotuloAgregado(linha.AgregadoTipo);
        if (recusado is not null)
        {
            NivelDetalhe = NivelLinhaSincronizacao.Recusada;
            TituloDetalhe = $"{nome} · RECUSADA";
            var motivo = Mascarar(recusado.UltimoErro).TrimEnd('.', ' ');
            SituacaoDetalhe = $"A nuvem recusou: {(motivo.Length == 0 ? "sem motivo informado" : motivo)}. "
                              + (recusado.Divergente ? ServicoSincronizacaoCentral.OndeResolverDivergente : ServicoSincronizacaoCentral.OndeResolver);
            RotuloReenvio = "Conferir no ERP agora";
        }
        else if (abertos.Count > 0)
        {
            NivelDetalhe = NivelLinhaSincronizacao.Pendente;
            TituloDetalhe = $"{nome} · AINDA NÃO CONFIRMADA";
            SituacaoDetalhe = "Ainda não confirmada pela nuvem: o caixa envia sozinho, na ordem em que aconteceu (sem internet, assim que ela voltar). "
                              + "F6 Reenviar agora força o envio; nada se duplica.";
            RotuloReenvio = "Reenviar agora";
        }
        else if (eventos.Count > 0 && eventos.All(e => e.Descartado || e.Status == StatusEventoSaida.Confirmado) && eventos.Any(e => e.Descartado))
        {
            NivelDetalhe = NivelLinhaSincronizacao.Neutra;
            TituloDetalhe = $"{nome} · DESCARTADA NO ERP";
            SituacaoDetalhe = "O ERP descartou este registro na fila de decisão: é a decisão final (a nuvem não o tem).";
            RotuloReenvio = "Reenviar agora";
        }
        else
        {
            NivelDetalhe = NivelLinhaSincronizacao.Confirmada;
            TituloDetalhe = $"{nome} · ✓ CONFIRMADA";
            SituacaoDetalhe = "✓ Confirmada pela nuvem: está no ERP.";
            RotuloReenvio = "Reenviar agora";
        }

        if (detalhe?.Agregado is { } a)
        {
            var quem = a.OperadorId is { } o ? $" · {Nome(o)}" : string.Empty;
            yield return ehVenda
                ? $"Caixa {a.NumeroCaixa:00}{quem}"
                : $"{TiposEvento.RotuloAgregado(linha.AgregadoTipo)}{(a.TipoMovimento is { } t ? $" ({TiposEvento.RotuloMovimento(t)}{(a.MovimentoCancelado ? ", cancelado" : string.Empty)})" : string.Empty)}"
                  + (a.Valor is { } v ? (linha.AgregadoTipo == "sessao_caixa" ? $" · fundo de troco R$ {NumeroBr.Dinheiro(v)}" : $" · R$ {NumeroBr.Dinheiro(v)}") : string.Empty)
                  + (a.Quando is { } q ? $" · {Hora(q)}" : string.Empty)
                  + (a.NumeroCaixa is { } n ? $" · caixa {n:00}" : string.Empty) + quem;
        }

        if (ehVenda)
        {
            if (venda is not null)
            {
                // Mascarado também o que foi digitado (o motivo do cancelamento com um CPF ou um telefone): é diagnóstico.
                foreach (var l in TextoDetalheVenda.Linhas(venda, _fuso, LinhaVendaCentralViewModel.MascararDocumento))
                {
                    yield return Mascarar(l);
                }
            }
            else
            {
                yield return semVenda ?? "A venda não está no banco local deste caixa (só o registro do envio).";
            }
        }

        yield return "Envios para a nuvem (o conteúdo não aparece aqui):";
        if (eventos.Count == 0)
        {
            yield return "  nenhum registro deste caixa para a nuvem.";
        }

        foreach (var e in eventos)
        {
            var (situacao, _) = SituacaoEvento(e);
            yield return $"  {TiposEvento.Rotulo(e.Tipo)} · nº {e.Sequencia} · {situacao}";
            yield return $"    gravado {Hora(e.CriadoEm)}"
                         + (e.Tentativas switch { 0 => " · nenhuma tentativa ainda", 1 => " · 1 tentativa", _ => $" · {e.Tentativas} tentativas" })
                         + (e.EnviadoEm is { } env ? $" · enviado {Hora(env)}" : string.Empty)
                         + (e.ProximaTentativaEm is { } p && e.AEnviar ? $" · próxima {Hora(p)}" : string.Empty)
                         + (e.ConfirmadoEm is { } c ? $" · confirmado {Hora(c)}" : string.Empty);
            if (e.UltimoErro is { Length: > 0 } erro && e.Status != StatusEventoSaida.Confirmado)
            {
                yield return $"    último erro: {Mascarar(erro)}";
            }

            if (detalhe!.Dependencias.GetValueOrDefault(e.Id) is { Count: > 0 } dependencias && e.Status != StatusEventoSaida.Confirmado)
            {
                yield return "    depende de: " + string.Join("; ", dependencias.Select(d =>
                    $"{TiposEvento.RotuloAgregado(d.AgregadoTipo)} — {LinhaCaixaCentralViewModel.TextoEnvio(d.Status, curto: true)}"));
            }
        }

        yield return MensagemSemPayload;
        if (detalhe?.Ocorrencias is { Count: > 0 } ocorrencias)
        {
            yield return "Ocorrências ligadas (log do caixa):";
            foreach (var o in ocorrencias)
            {
                yield return $"  {Hora(o.OcorridoEm)} {o.Nivel} {o.Origem}: {Mascarar(o.Mensagem)}";
            }
        }
        else
        {
            yield return "Ocorrências ligadas (log do caixa): nenhuma.";
        }
    }

    /// <summary>F4 (SYNC 8.6): declarar a lacuna ou liberar o reenvio, com <c>pdv.config.fiscal</c> de quem está na Central ou na hora.</summary>
    [RelayCommand]
    private Task Lacuna() => Tentar(async () =>
    {
        if (Liberacao is not null || MostrandoDetalhe)
        {
            return;
        }

        ExigirAlcance();
        var sync = _shell.Servico<IServicoSincronizacao>();
        if (sync.Situacao.Lacuna is not { } lacuna)
        {
            Mensagem = "Nenhuma lacuna de eventos neste caixa.";
            return;
        }

        var acao = lacuna.Recuperavel ? $"Reenviar os eventos da lacuna {lacuna.Faixa}" : $"Declarar a lacuna de eventos {lacuna.Faixa}";
        // pdv.config.fiscal nunca é emprestada pela Central (AbasCentral.PermissoesLiberaveis): a própria ou o PIN na hora.
        var usuario = _acesso.Usuario ?? throw new RegraNegocioException(AcessoCentral.MensagemFechada);
        // Na auditoria, quem está na Central e pediu, e esta tela (a Central aberta pelo login não tem operador na sessão).
        var origem = new OrigemLiberacaoLacuna(usuario.Id, Localizacao);
        async Task ExecutarAsync(Guid autorizadoPorId, string? motivo, string? quem)
        {
            if (lacuna.Recuperavel)
            {
                await sync.AutorizarRecuperacaoLacunaAsync(autorizadoPorId, origem: origem);
            }
            else
            {
                await sync.DeclararLacunaAsync(autorizadoPorId, motivo, origem: origem);
            }

            Mensagem = lacuna.Recuperavel
                ? $"Reenvio dos eventos da lacuna {lacuna.Faixa} liberado{(quem is null ? string.Empty : $" por {quem}")}."
                : $"Lacuna de eventos {lacuna.Faixa} declarada na nuvem{(quem is null ? string.Empty : $" com liberação de {quem}")}. Vendas liberadas.";
            await LerAsync(manual: false);
        }

        if (usuario.Tem(PermissoesPdv.ConfigFiscal))
        {
            await ExecutarAsync(usuario.Id, null, null);
            return;
        }

        PedidoLiberacaoViewModel? pedido = null;
        pedido = new PedidoLiberacaoViewModel(
            _shell.Servico<IAutenticadorOperador>(), _shell.Servico<IRelogio>(), usuario, PermissoesPdv.ConfigFiscal, acao,
            async concedida =>
            {
                if (!ReferenceEquals(Liberacao, pedido))
                {
                    return;
                }

                Liberacao = null;
                await Tentar(() => ExecutarAsync(concedida.Supervisor.Id, concedida.Motivo, concedida.Supervisor.Nome));
                FocoSolicitado?.Invoke(this, AlvoFocoSincronizacao.Lista);
            },
            erro =>
            {
                if (ReferenceEquals(Liberacao, pedido))
                {
                    Liberacao = null;
                    Erro = erro;
                    FocoSolicitado?.Invoke(this, AlvoFocoSincronizacao.Lista);
                }

                return Task.CompletedTask;
            });
        Liberacao = pedido;
    });

    /// <summary>Esc: fecha o pedido do supervisor, depois o detalhe, depois volta ao menu da Central.</summary>
    [RelayCommand]
    private Task Voltar()
    {
        if (Liberacao is not null)
        {
            Liberacao = null;
            Focar();
            return Task.CompletedTask;
        }

        if (MostrandoDetalhe)
        {
            FecharDetalhe();
            return Task.CompletedTask;
        }

        return _voltar();
    }

    private void FecharDetalhe(bool focar = true)
    {
        _versaoDetalhe++;
        MostrandoDetalhe = false;
        _linhaDetalhe = null;
        TituloDetalhe = string.Empty;
        SituacaoDetalhe = null;
        LinhasDetalhe.Clear();
        Mensagem = null;
        Erro = null;
        if (focar)
        {
            FocoSolicitado?.Invoke(this, AlvoFocoSincronizacao.Lista);
        }
    }

    /// <summary>A liberação que emprestou o diagnóstico pode ter acabado entre o relógio da Central e a tecla.</summary>
    private void ExigirAlcance()
    {
        if (!_servico.VeDiagnostico)
        {
            throw new RegraNegocioException(MensagemLiberacaoAcabou);
        }
    }

    private async Task Tentar(Func<Task> acao)
    {
        try
        {
            Erro = null;
            await acao();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Tratar(e);
        }
    }

    private void Tratar(Exception e)
    {
        if (e is RegraNegocioException regra)
        {
            Erro = regra.Message;
            return;
        }

        // Nada aqui derruba o caixa: a falha vai para o log e para a tela (mascarada).
        _shell.Servico<ILogger<AbaSincronizacaoViewModel>>().LogError(e, "Falha na aba Sincronização da Central");
        Erro = $"Não deu certo ({MascaradorSuporte.Mascarar(e.Message)}). F5 tenta de novo.";
    }

    private static string Mascarar(string? texto) => MascaradorSuporte.Mascarar(texto) ?? string.Empty;

    private string Nome(Guid usuarioId) => _nomes.GetValueOrDefault(usuarioId, "outro operador");

    private string Hora(DateTimeOffset? quando) => quando is { } q
        ? TimeZoneInfo.ConvertTime(q, _fuso).ToString("dd/MM HH:mm", NumeroBr.Cultura)
        : "—";

    private string HoraSegundos(DateTimeOffset? quando) => quando is { } q
        ? TimeZoneInfo.ConvertTime(q, _fuso).ToString("dd/MM HH:mm:ss", NumeroBr.Cultura)
        : "—";

    private string HoraCurta(DateTimeOffset quando) => TimeZoneInfo.ConvertTime(quando, _fuso).ToString("HH:mm:ss", NumeroBr.Cultura);

    /// <summary>O que uma leitura trouxe; as linhas são montadas na thread da tela.</summary>
    private sealed record Leitura(
        VisaoSincronizacao Visao,
        SituacaoSincronizacao Situacao,
        StatusDetalhadoSync Status,
        ContagemRecusados Recusados,
        PaginaVendasNaoConfirmadas Vendas,
        PaginaCaixaNaoConfirmado Caixa,
        PaginaEventos? Todos,
        IReadOnlyList<ComandoSincronizacao> Comandos,
        int QuantidadeComandos,
        IReadOnlyList<string> Tipos,
        IReadOnlyDictionary<Guid, AgregadoSincronizacao> Agregados,
        VendasResolvidas Resolvidas,
        IReadOnlyList<(Guid Id, string Nome)> Nomes)
    {
        public object? Proxima => Visao switch
        {
            VisaoSincronizacao.Vendas => Vendas.Proxima,
            VisaoSincronizacao.Caixa => Caixa.Proxima,
            VisaoSincronizacao.Todos => Todos?.Proxima,
            _ => null,
        };

        public IEnumerable<LinhaSincronizacaoViewModel> Linhas(AbaSincronizacaoViewModel aba) => Visao switch
        {
            VisaoSincronizacao.Vendas => Vendas.Vendas.Select(aba.LinhaVenda),
            VisaoSincronizacao.Caixa => Caixa.Eventos.Select(e => aba.LinhaEvento(e, Agregados.GetValueOrDefault(e.AgregadoId))),
            VisaoSincronizacao.Todos => Todos!.Eventos.Select(e => aba.LinhaEvento(e, Agregados.GetValueOrDefault(e.AgregadoId))),
            _ => Comandos.Select(aba.LinhaComando),
        };

        public string Rodape(int pagina)
        {
            var de = ((pagina - 1) * ConsultasSincronizacaoLocal.TamanhoPagina) + 1;
            return Visao switch
            {
                VisaoSincronizacao.Vendas => Vendas.Quantidade == 0
                    ? "✓ Todas as vendas deste caixa foram confirmadas pela nuvem." + Descartadas(Vendas.Descartadas)
                    : $"Vendas {de} a {de + Vendas.Vendas.Count - 1} de {Vendas.Quantidade} não confirmadas"
                      + $" ({(Vendas.Recusadas == 1 ? "1 recusada" : $"{Vendas.Recusadas} recusadas")}) · página {pagina}" + Descartadas(Vendas.Descartadas),
                VisaoSincronizacao.Caixa => Caixa.Quantidade == 0
                    ? "✓ Aberturas, sangrias, reforços e fechamentos confirmados pela nuvem." + Descartadas(Caixa.Descartados)
                    : $"Registros {de} a {de + Caixa.Eventos.Count - 1} de {Caixa.Quantidade} não confirmados"
                      + $" ({(Caixa.Recusados == 1 ? "1 recusado" : $"{Caixa.Recusados} recusados")}) · página {pagina}" + Descartadas(Caixa.Descartados),
                VisaoSincronizacao.Todos => Todos!.Quantidade == 0
                    ? "Nenhum registro com esse filtro."
                    : $"Registros {de} a {de + Todos.Eventos.Count - 1} de {Todos.Quantidade} · página {pagina}",
                _ => QuantidadeComandos == 0
                    ? "Nenhum comando recebido do ERP."
                    : QuantidadeComandos > Comandos.Count
                        ? $"Os {Comandos.Count} comandos mais novos de {QuantidadeComandos}"
                        : (QuantidadeComandos == 1 ? "1 comando recebido" : $"{QuantidadeComandos} comandos recebidos"),
            };
        }

        private static string Descartadas(int n) => n switch
        {
            0 => string.Empty,
            1 => " · 1 descartada no ERP (decisão final) não aparece",
            _ => $" · {n} descartadas no ERP (decisão final) não aparecem",
        };
    }
}

/// <summary>Os nomes de balcão dos tipos de registro que sobem para a nuvem (SYNC 9) e dos comandos do ERP (21.1).</summary>
public static class TiposEvento
{
    public static string Rotulo(string tipo) => tipo switch
    {
        "venda.finalizada" => "Venda",
        "venda.cancelada" => "Cancelamento da venda",
        "caixa.aberto" => "Abertura do caixa",
        "caixa.fechado" => "Fechamento do caixa",
        "caixa.sangria" => "Sangria",
        "caixa.reforco" => "Reforço",
        "caixa.movimento_cancelado" => "Cancelamento de sangria ou reforço",
        "vasilhame.movimentado" => "Vasilhames",
        "auditoria.registros" => "Histórico de uso",
        _ when tipo.StartsWith("terminal.", StringComparison.Ordinal) => $"Terminal ({tipo})",
        _ => tipo,
    };

    public static string RotuloAgregado(string? agregado) => agregado switch
    {
        ConsultasSincronizacaoLocal.AgregadoVenda => "venda",
        "sessao_caixa" => "caixa (abertura e fechamento)",
        "movimento_caixa" => "movimento do caixa",
        "movimento_vasilhame" => "vasilhames",
        null => "registro",
        _ => agregado,
    };

    public static string RotuloMovimento(string tipo) => tipo switch
    {
        TipoMovimentoCaixa.Sangria => "sangria",
        TipoMovimentoCaixa.Reforco => "reforço",
        TipoMovimentoCaixa.Abertura => "abertura",
        TipoMovimentoCaixa.SangriaFechamento => "sangria do fechamento",
        TipoMovimentoCaixa.EstornoVenda => "devolução de venda",
        _ => tipo,
    };

    public static string RotuloComando(string tipo) => tipo switch
    {
        TiposComando.Mensagem => "Mensagem do ERP",
        TiposComando.Ressincronizar => "Baixar tudo de novo do ERP",
        TiposComando.RessincronizarFluxo => "Baixar de novo um cadastro do ERP",
        TiposComando.Revogar => "Desativar o terminal",
        TiposComando.EnviarLogs => "Enviar os logs (ainda não suportado)",
        TiposComando.AtualizarApp => "Atualizar o aplicativo (ainda não suportado)",
        TiposComando.ReservarFaixa => "Reservar faixa (ainda não suportado)",
        _ => tipo,
    };
}
