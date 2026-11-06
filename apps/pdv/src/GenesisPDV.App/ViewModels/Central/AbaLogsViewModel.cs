using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.App.Servicos.Diagnostico.Verificacoes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Data.Repositorios;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels.Central;

/// <summary>De onde a aba 5 lê: as ocorrências do <c>log_local</c> ou o arquivo técnico do Serilog (F3 alterna).</summary>
public enum FonteLogs
{
    Ocorrencias,
    Arquivo,
}

/// <summary>Para onde a aba 5 leva o foco.</summary>
public enum AlvoFocoLogs
{
    /// <summary>O campo do texto (↑/↓, Enter, PgDn e as teclas F funcionam dele).</summary>
    Filtro,

    /// <summary>O detalhe aberto (Esc volta à lista).</summary>
    Detalhe,
}

/// <summary>
/// Uma linha da aba 5: a hora, o nível (a palavra ao lado da cor, PDV 9.1), a origem (ou a categoria do arquivo), a
/// mensagem mascarada e o resumo (o nome da dica, ou "+12 linhas" da exceção). <see cref="Ocorrencia"/> ou
/// <see cref="Registro"/>, conforme a fonte.
/// </summary>
public sealed class LinhaLogViewModel : ViewModelBase
{
    public LinhaLogViewModel(OcorrenciaCentral ocorrencia, TimeZoneInfo fuso)
    {
        Ocorrencia = ocorrencia;
        Nivel = ocorrencia.Nivel;
        Hora = TimeZoneInfo.ConvertTime(ocorrencia.OcorridoEm, fuso).ToString("dd/MM HH:mm:ss", NumeroBr.Cultura);
        Origem = CatalogoOcorrencias.RotuloOrigem(ocorrencia.Origem);
        Mensagem = UmaLinha(ocorrencia.Mensagem);
        Resumo = ocorrencia.Dica.Titulo;
    }

    public LinhaLogViewModel(RegistroLog registro, TimeZoneInfo fuso)
    {
        Registro = registro;
        Nivel = registro.Nivel;
        Hora = registro.Quando is { } q ? TimeZoneInfo.ConvertTime(q, fuso).ToString("dd/MM HH:mm:ss", NumeroBr.Cultura) : "—";
        Origem = registro.Categoria is { } c ? c[(c.LastIndexOf('.') + 1)..] : "—";
        Mensagem = UmaLinha(registro.Mensagem);
        Resumo = registro.TemDetalhe ? $"+{registro.LinhasExtras} {(registro.LinhasExtras == 1 ? "linha" : "linhas")} (Enter)" : string.Empty;
    }

    public OcorrenciaCentral? Ocorrencia { get; }

    public RegistroLog? Registro { get; }

    /// <summary>O nível no vocabulário do <c>log_local</c>.</summary>
    public string Nivel { get; }

    public string NivelRotulo => CatalogoOcorrencias.RotuloNivel(Nivel);

    public bool EhErro => Nivel is NiveisOcorrencia.Erro or NiveisOcorrencia.Critico;

    public bool EhAviso => Nivel == NiveisOcorrencia.Aviso;

    public string Hora { get; }

    public string Origem { get; }

    public string Mensagem { get; }

    public string Resumo { get; }

    public string Leitura => $"{Hora}, {NivelRotulo}, {Origem}: {Mensagem}. {Resumo}".Trim();

    private static string UmaLinha(string texto)
    {
        var primeira = texto.Split('\n', 2)[0].TrimEnd('\r');
        return primeira.Length > 300 ? primeira[..300] + "…" : primeira;
    }
}

/// <summary>
/// Aba 5 da Central do PDV, <b>Logs e ocorrências</b> (bloco G8; plano 4 e 5.5; README › decisão 73): achar o erro de
/// ontem em menos de um minuto, sem abrir o Windows Explorer. Pede <c>pdv.diagnostico.ver</c> (a própria ou a emprestada
/// pelo Ctrl+L). <b>F3</b> alterna as duas fontes: as <b>ocorrências</b> (o <c>log_local</c>: impressora, gaveta,
/// sincronização, backup… com a dica do que fazer) e o <b>arquivo técnico</b> (o Serilog do dia escolhido, lido pelo
/// final, com a exceção inteira no detalhe). Filtros: o nível (F4), o período ou o dia (F6), a origem (F7, nas
/// ocorrências) e o texto (o campo); com Shift, o F4, o F6 e o F7 voltam um. Tudo mascarado (<see cref="MascaradorSuporte"/>);
/// nada é gravado nem apagado. Teclas: ↑/↓ escolhem, Enter (ou o * do numérico) detalhe, PgDn/PgUp (ou + e −) página, F5
/// atualiza, F8 limpa os filtros, Esc fecha o detalhe e volta ao menu; tudo também pelo mouse.
/// </summary>
public sealed partial class AbaLogsViewModel : ViewModelBase
{
    public const string MensagemLiberacaoAcabou = "A liberação acabou: os logs pedem o supervisor de novo (Ctrl+L).";

    public const string MensagemSemArquivo = "Nenhum arquivo de log nesta máquina (a pasta de logs está vazia).";

    public const string MensagemFimDoDia = "Não há registros mais antigos neste dia: escolha outro dia (F6).";

    /// <summary>O índice segue <see cref="NiveisMinimos"/>.</summary>
    public static IReadOnlyList<string> Niveis { get; } = ["Todos os níveis", "Avisos e erros", "Só erros"];

    /// <summary>O índice segue <see cref="PeriodoOcorrencias"/>.</summary>
    public static IReadOnlyList<string> Periodos { get; } = ["Últimas 24 h", "Hoje", "Ontem", "Últimos 7 dias", "Últimos 30 dias", "Tudo"];

    private static readonly string?[] NiveisMinimos = [null, NiveisOcorrencia.Aviso, NiveisOcorrencia.Erro];

    private static readonly JsonSerializerOptions Indentado = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly ShellViewModel _shell;
    private readonly ServicoLogsCentral _servico;
    private readonly Func<Task> _voltar;

    /// <summary>O começo de cada página já vista (a primeira é nula): o PgUp volta pelo cursor guardado.</summary>
    private readonly List<object?> _inicios = [null];

    /// <summary>
    /// Quantas linhas as páginas antes de cada uma mostraram (o "Ocorrências 51 a 97" do rodapé): a página pode vir com
    /// menos de 50 (a busca que confere depois da máscara, o arquivo que parou no orçamento).
    /// </summary>
    private readonly List<int> _antes = [0];

    private object? _proxima;
    private int _versao;
    private bool _montando;
    private bool? _viaDiagnostico;
    private CancellationTokenSource? _leitura;
    private List<DiaLog> _dias = [];

    /// <param name="voltar">Esc: volta ao menu da Central.</param>
    public AbaLogsViewModel(ShellViewModel shell, Func<Task> voltar)
    {
        _shell = shell;
        _servico = shell.Servico<ServicoLogsCentral>();
        _voltar = voltar;
        Origens = ["Todas as origens", .. OrigensOcorrencia.Todas.Select(CatalogoOcorrencias.RotuloOrigem)];
    }

    public string Titulo => AbasCentral.Logs.Rotulo;

    public string Teclas =>
        "↑/↓ escolhem · Enter (ou *) detalhe · PgDn/PgUp (ou + e −) página · F3 ocorrências/arquivo · F4 nível · F6 período ou dia · F7 origem (Shift volta) · F5 atualiza · F8 limpa · Esc volta ao menu";

    public string TeclasDetalhe => "↑/↓ (ou 8/2) e PgUp/PgDn (ou 9/3) rolam · Esc volta à lista";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(EmOcorrencias))]
    [NotifyPropertyChangedFor(nameof(NoArquivo))]
    [NotifyPropertyChangedFor(nameof(Explicacao))]
    public partial FonteLogs Fonte { get; set; }

    public bool EmOcorrencias => Fonte == FonteLogs.Ocorrencias;

    public bool NoArquivo => Fonte == FonteLogs.Arquivo;

    public string Explicacao => EmOcorrencias
        ? "Ocorrências do caixa (impressora, gaveta, sincronização, backup): cada uma com o que fazer. F3 abre o arquivo técnico."
        : "Arquivo técnico do dia (o que o suporte lê), do mais novo ao mais antigo; Enter mostra a exceção inteira. F3 volta às ocorrências.";

    [ObservableProperty]
    public partial int NivelIndice { get; set; }

    [ObservableProperty]
    public partial int PeriodoIndice { get; set; } = (int)PeriodoOcorrencias.Ultimos7Dias;

    public IReadOnlyList<string> Origens { get; }

    [ObservableProperty]
    public partial int OrigemIndice { get; set; }

    /// <summary>Os dias com arquivo de log ("05/11/2026 · 2 arquivos · 21,3 MB").</summary>
    public ObservableCollection<string> Dias { get; } = [];

    [ObservableProperty]
    public partial int DiaIndice { get; set; }

    [ObservableProperty]
    public partial string Texto { get; set; } = string.Empty;

    public ObservableCollection<LinhaLogViewModel> Linhas { get; } = [];

    [ObservableProperty]
    public partial LinhaLogViewModel? Selecionada { get; set; }

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

    // --- Detalhe (Enter) ---

    [ObservableProperty]
    public partial bool MostrandoDetalhe { get; set; }

    [ObservableProperty]
    public partial string TituloDetalhe { get; set; } = string.Empty;

    public ObservableCollection<string> LinhasDetalhe { get; } = [];

    /// <summary>"O que fazer" (o catálogo; só nas ocorrências).</summary>
    [ObservableProperty]
    public partial string? OQueFazer { get; set; }

    /// <summary>A exceção, o texto técnico (mascarado).</summary>
    [ObservableProperty]
    public partial string? TextoTecnico { get; set; }

    /// <summary>A leitura em curso (os testes a aguardam).</summary>
    public Task Atualizacao { get; private set; } = Task.CompletedTask;

    public event EventHandler<AlvoFocoLogs>? FocoSolicitado;

    /// <summary>A Central pede o foco no conteúdo (o 5 de novo no menu).</summary>
    public void Focar() => FocoSolicitado?.Invoke(this, MostrandoDetalhe ? AlvoFocoLogs.Detalhe : AlvoFocoLogs.Filtro);

    /// <summary>Abre a aba (e a cada visita): os dias do arquivo e a primeira página da fonte escolhida.</summary>
    public Task CarregarAsync() => Atualizacao = LerDoComecoAsync(recarregarDias: true);

    /// <summary>
    /// O filtro pedido por outra aba (o botão "Erros recentes" do Painel: <see cref="VerificacaoErros.FiltroErrosRecentes"/>,
    /// as ocorrências de erro das últimas 24 h). Filtro desconhecido: nada muda.
    /// </summary>
    public Task AplicarFiltroAsync(string? filtro)
    {
        if (filtro != VerificacaoErros.FiltroErrosRecentes)
        {
            return Atualizacao;
        }

        FecharDetalhe(focar: false);
        _montando = true;
        try
        {
            Fonte = FonteLogs.Ocorrencias;
            NivelIndice = 2;
            PeriodoIndice = (int)PeriodoOcorrencias.Ultimas24Horas;
            OrigemIndice = 0;
            Texto = string.Empty;
        }
        finally
        {
            _montando = false;
        }

        Mensagem = "Os erros das últimas 24 h (o item \"Erros recentes\" do Painel de saúde).";
        FocoSolicitado?.Invoke(this, AlvoFocoLogs.Filtro);
        return Atualizacao = LerDoComecoAsync(recarregarDias: false);
    }

    partial void OnNivelIndiceChanged(int value) => FiltroMudou();

    partial void OnPeriodoIndiceChanged(int value) => FiltroMudou();

    partial void OnOrigemIndiceChanged(int value) => FiltroMudou();

    partial void OnDiaIndiceChanged(int value) => FiltroMudou();

    partial void OnTextoChanged(string value) => FiltroMudou();

    partial void OnFonteChanged(FonteLogs value) => FiltroMudou();

    private void FiltroMudou()
    {
        if (!_montando)
        {
            // O aviso era do filtro de antes (o "erros das últimas 24 h" do Painel, o fim do dia do F6): não vale mais.
            Mensagem = null;
            Atualizacao = LerDoComecoAsync(recarregarDias: false);
        }
    }

    private Task LerDoComecoAsync(bool recarregarDias)
    {
        _inicios.Clear();
        _inicios.Add(null);
        _antes.Clear();
        _antes.Add(0);
        Pagina = 1;
        return LerAsync(null, recarregarDias);
    }

    private async Task LerAsync(object? inicio, bool recarregarDias = false, bool avancando = false)
    {
        var versao = ++_versao;
        if (_leitura is { } anterior)
        {
            // A leitura do arquivo que o novo filtro tornou inútil para de ler (o PgDn de antes, a tecla anterior no texto).
            // Sem Dispose: a leitura em segundo plano ainda olha o token dela.
            await anterior.CancelAsync();
        }

        var cancelar = new CancellationTokenSource();
        _leitura = cancelar;
        Erro = null;
        Carregando = true;
        try
        {
            _viaDiagnostico = _servico.VeDiagnostico;
            if (recarregarDias || (NoArquivo && _dias.Count == 0))
            {
                var dias = await Task.Run(() => _servico.DiasDoArquivo(), cancelar.Token);
                if (versao != _versao)
                {
                    return;
                }

                MontarDias(dias);
            }

            var fuso = _servico.Fuso;
            var nivel = NiveisMinimos[Math.Clamp(NivelIndice, 0, NiveisMinimos.Length - 1)];
            var texto = Texto;
            if (EmOcorrencias)
            {
                var (desde, ate) = _servico.Intervalo((PeriodoOcorrencias)Math.Clamp(PeriodoIndice, 0, Periodos.Count - 1));
                var origem = OrigemIndice > 0 && OrigemIndice <= OrigensOcorrencia.Todas.Count ? OrigensOcorrencia.Todas[OrigemIndice - 1] : null;
                var filtro = new FiltroOcorrencias(nivel, desde, ate, origem, texto);
                var pagina = await Task.Run(() => _servico.OcorrenciasAsync(filtro, inicio as CursorOcorrencias, cancelar.Token), cancelar.Token);
                if (versao != _versao)
                {
                    return;
                }

                Mostrar([.. pagina.Ocorrencias.Select(o => new LinhaLogViewModel(o, fuso))], pagina.Proxima, pagina.Parcial, avancando);
            }
            else
            {
                if (_dias.Count == 0)
                {
                    Mostrar([], null, parcial: false, avancando);
                    Rodape = MensagemSemArquivo;
                    return;
                }

                var dia = _dias[Math.Clamp(DiaIndice, 0, _dias.Count - 1)];
                var filtro = new FiltroLogArquivo(nivel, texto);
                var pagina = await Task.Run(() => _servico.Arquivo(dia, filtro, inicio as CursorLog, cancelar.Token), cancelar.Token);
                if (versao != _versao)
                {
                    return;
                }

                Mostrar([.. pagina.Registros.Select(r => new LinhaLogViewModel(r, fuso))], pagina.Proxima, pagina.Parcial, avancando);
            }
        }
        catch (OperationCanceledException) when (cancelar.IsCancellationRequested)
        {
            // Trocou o filtro no meio da leitura: a leitura nova é que vale.
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

    private void MontarDias(IReadOnlyList<DiaLog> dias)
    {
        var anterior = _dias.Count > 0 && DiaIndice < _dias.Count ? _dias[DiaIndice].Dia : (DateOnly?)null;
        _montando = true;
        try
        {
            _dias = [.. dias];
            Dias.Clear();
            foreach (var d in dias)
            {
                var arquivos = d.Arquivos.Count == 1 ? "1 arquivo" : $"{d.Arquivos.Count} arquivos";
                Dias.Add($"{d.Dia.ToString("dd/MM/yyyy", CultureInfo.InvariantCulture)} · {arquivos} · {MedidorDisco.Legivel(d.Tamanho)}");
            }

            var i = anterior is { } a ? _dias.FindIndex(d => d.Dia == a) : -1;
            DiaIndice = Math.Max(0, i);
        }
        finally
        {
            _montando = false;
        }
    }

    private void Mostrar(List<LinhaLogViewModel> linhas, object? proxima, bool parcial, bool avancando)
    {
        if (avancando && linhas.Count == 0 && proxima is null)
        {
            // O PgDn que só achou o fim (a página anterior acabou exatamente no último registro): fica na página de antes.
            _inicios.RemoveAt(_inicios.Count - 1);
            _antes.RemoveAt(_antes.Count - 1);
            Pagina--;
            TemProxima = false;
            _proxima = null;
            Mensagem = NoArquivo ? MensagemFimDoDia : "Não há ocorrências mais antigas com esses filtros.";
            Rodape = Rodape.Replace(" · PgDn mais antigos", string.Empty, StringComparison.Ordinal);
            return;
        }

        var escolhida = Selecionada;
        Linhas.Clear();
        foreach (var l in linhas)
        {
            Linhas.Add(l);
        }

        Selecionada = Linhas.FirstOrDefault(l => Mesma(l, escolhida)) ?? Linhas.FirstOrDefault();
        _proxima = proxima;
        TemProxima = proxima is not null;
        var nome = EmOcorrencias ? "Ocorrências" : "Registros";
        var lida = EmOcorrencias ? $"nas {ServicoLogsCentral.LimiteBusca.ToString("N0", NumeroBr.Cultura)} ocorrências já procuradas" : "na parte já lida do arquivo";
        var de = _antes[^1] + 1;
        Rodape = Linhas.Count == 0
            ? (parcial ? $"Nada achado {lida}: PgDn procura mais para trás." : (EmOcorrencias ? "Nenhuma ocorrência" : "Nenhum registro") + " com esses filtros.")
            : $"{nome} {de} a {de + Linhas.Count - 1} · página {Pagina}"
              + (parcial ? $" · a busca parou {lida}" : string.Empty)
              + (TemProxima ? " · PgDn mais antigos" : string.Empty);
    }

    private static bool Mesma(LinhaLogViewModel l, LinhaLogViewModel? outra) =>
        outra is not null
        && ((l.Ocorrencia is { } o && outra.Ocorrencia?.Id == o.Id)
            || (l.Registro is { } r && outra.Registro is { } r2 && r.Arquivo == r2.Arquivo && r.Posicao == r2.Posicao));

    [RelayCommand]
    private void Mover(string direcao)
    {
        if (Linhas.Count == 0 || MostrandoDetalhe)
        {
            return;
        }

        var i = Selecionada is null ? -1 : Linhas.IndexOf(Selecionada);
        Selecionada = Linhas[direcao == "acima" ? Math.Max(0, i - 1) : Math.Min(Linhas.Count - 1, i + 1)];
    }

    /// <summary>PgDn: os 50 seguintes (mais antigos), pelo cursor.</summary>
    [RelayCommand]
    private Task ProximaPagina()
    {
        if (_proxima is not { } proxima || MostrandoDetalhe)
        {
            return Task.CompletedTask;
        }

        Mensagem = null;
        _inicios.Add(proxima);
        _antes.Add(_antes[^1] + Linhas.Count);
        Pagina++;
        Selecionada = null;
        return Atualizacao = LerAsync(proxima, avancando: true);
    }

    /// <summary>PgUp: os 50 anteriores (mais novos).</summary>
    [RelayCommand]
    private Task PaginaAnterior()
    {
        if (_inicios.Count <= 1 || MostrandoDetalhe)
        {
            return Task.CompletedTask;
        }

        Mensagem = null;
        _inicios.RemoveAt(_inicios.Count - 1);
        _antes.RemoveAt(_antes.Count - 1);
        Pagina--;
        Selecionada = null;
        return Atualizacao = LerAsync(_inicios[^1]);
    }

    /// <summary>F3: ocorrências ↔ arquivo técnico (os filtros de nível e texto ficam).</summary>
    [RelayCommand]
    private void AlternarFonte(string? fonte)
    {
        if (MostrandoDetalhe)
        {
            return;
        }

        Mensagem = null;
        Fonte = fonte switch
        {
            "ocorrencias" => FonteLogs.Ocorrencias,
            "arquivo" => FonteLogs.Arquivo,
            _ => EmOcorrencias ? FonteLogs.Arquivo : FonteLogs.Ocorrencias,
        };
        FocoSolicitado?.Invoke(this, AlvoFocoLogs.Filtro);
    }

    /// <summary>F4: todos os níveis, avisos e erros, só erros (Shift+F4, <c>anterior</c>, volta um).</summary>
    [RelayCommand]
    private void ProximoNivel(string? direcao)
    {
        if (!MostrandoDetalhe)
        {
            NivelIndice = Girar(NivelIndice, Niveis.Count, direcao);
        }
    }

    /// <summary>
    /// F6: o próximo período (ocorrências) ou o dia anterior (arquivo; do mais novo ao mais antigo, e volta); Shift+F6
    /// (<c>anterior</c>) volta um.
    /// </summary>
    [RelayCommand]
    private void ProximoPeriodo(string? direcao)
    {
        if (MostrandoDetalhe)
        {
            return;
        }

        if (EmOcorrencias)
        {
            PeriodoIndice = Girar(PeriodoIndice, Periodos.Count, direcao);
        }
        else if (Dias.Count > 0)
        {
            DiaIndice = Girar(DiaIndice, Dias.Count, direcao);
        }
    }

    /// <summary>F7: a próxima origem (só nas ocorrências; o arquivo técnico filtra pelo texto); Shift+F7 volta uma.</summary>
    [RelayCommand]
    private void ProximaOrigem(string? direcao)
    {
        if (!MostrandoDetalhe && EmOcorrencias)
        {
            OrigemIndice = Girar(OrigemIndice, Origens.Count, direcao);
        }
    }

    /// <summary>O índice seguinte (ou o anterior, com <c>anterior</c>), dando a volta.</summary>
    private static int Girar(int atual, int total, string? direcao) =>
        (atual + (direcao == "anterior" ? total - 1 : 1)) % total;

    /// <summary>F5: lê de novo (a mesma página; no arquivo, também os dias); com o detalhe aberto, nada.</summary>
    [RelayCommand]
    private Task Atualizar()
    {
        if (MostrandoDetalhe)
        {
            return Task.CompletedTask;
        }

        Mensagem = null;
        return Atualizacao = LerAsync(_inicios[^1], recarregarDias: NoArquivo);
    }

    /// <summary>F8: todos os níveis, últimos 7 dias, todas as origens, o dia mais novo, sem texto (a fonte fica).</summary>
    [RelayCommand]
    private Task LimparFiltros()
    {
        if (MostrandoDetalhe)
        {
            return Task.CompletedTask;
        }

        _montando = true;
        try
        {
            NivelIndice = 0;
            PeriodoIndice = (int)PeriodoOcorrencias.Ultimos7Dias;
            OrigemIndice = 0;
            DiaIndice = 0;
            Texto = string.Empty;
        }
        finally
        {
            _montando = false;
        }

        Mensagem = null;
        FocoSolicitado?.Invoke(this, AlvoFocoLogs.Filtro);
        return Atualizacao = LerDoComecoAsync(recarregarDias: false);
    }

    /// <summary>Enter (ou o duplo clique, ou o *): o detalhe da linha; de novo, fecha.</summary>
    [RelayCommand]
    private Task Detalhar(LinhaLogViewModel? linha) => Tentar(async () =>
    {
        if (MostrandoDetalhe)
        {
            FecharDetalhe();
            return;
        }

        linha ??= Selecionada ?? throw new RegraNegocioException(Linhas.Count == 0 ? "Nada na lista." : "Escolha uma linha (setas ↑/↓ ou clique).");
        Selecionada = linha;
        if (linha.Ocorrencia is { } o)
        {
            // Lida de novo pelo id (a lista guarda só o que mostra); o serviço confere a permissão de novo.
            var atual = await Task.Run(() => _servico.OcorrenciaAsync(o.Id)) ?? o;
            if (!ReferenceEquals(Selecionada, linha))
            {
                return;
            }

            DetalharOcorrencia(atual, linha);
        }
        else if (linha.Registro is { } r)
        {
            if (!_servico.VeDiagnostico)
            {
                throw new RegraNegocioException(MensagemLiberacaoAcabou);
            }

            DetalharRegistro(r, linha);
        }

        Mensagem = null;
        MostrandoDetalhe = true;
        FocoSolicitado?.Invoke(this, AlvoFocoLogs.Detalhe);
    });

    private void DetalharOcorrencia(OcorrenciaCentral o, LinhaLogViewModel linha)
    {
        TituloDetalhe = $"{o.Dica.Titulo} · {linha.Hora}";
        LinhasDetalhe.Clear();
        LinhasDetalhe.Add($"Quando: {TimeZoneInfo.ConvertTime(o.OcorridoEm, _servico.Fuso).ToString("dd/MM/yyyy HH:mm:ss", NumeroBr.Cultura)}");
        LinhasDetalhe.Add($"Nível: {linha.NivelRotulo} · origem: {linha.Origem}" + (o.Codigo is { } c ? $" · código: {c}" : string.Empty));
        LinhasDetalhe.Add($"O que aconteceu: {o.Mensagem}");
        string? tecnico = null;
        if (o.Detalhes is { Length: > 0 } detalhes)
        {
            if (Json(detalhes) is { } objeto)
            {
                foreach (var (chave, valor) in objeto)
                {
                    if (chave == Ocorrencias.CampoCodigo)
                    {
                        continue;
                    }

                    // O serviço já mascarou valor a valor (MascararDetalhes); de novo aqui, decodificado, por garantia: o que
                    // sai do JSON é o que a pessoa lê (idempotente).
                    if (chave == Ocorrencias.CampoTexto)
                    {
                        tecnico = MascaradorSuporte.Mascarar(valor is JsonValue v && v.TryGetValue<string>(out var t) ? t : valor?.ToJsonString(Indentado));
                        continue;
                    }

                    var texto = valor is JsonValue jv && jv.TryGetValue<string>(out var s) ? s : valor?.ToJsonString(Indentado);
                    LinhasDetalhe.Add($"  {chave}: {MascaradorSuporte.Mascarar(texto) ?? "—"}");
                }
            }
            else
            {
                tecnico = detalhes;
            }
        }

        OQueFazer = o.Dica.OQueFazer;
        TextoTecnico = tecnico;
    }

    private void DetalharRegistro(RegistroLog r, LinhaLogViewModel linha)
    {
        TituloDetalhe = $"Arquivo técnico · {linha.Hora}";
        LinhasDetalhe.Clear();
        LinhasDetalhe.Add(r.Quando is { } q
            ? $"Quando: {TimeZoneInfo.ConvertTime(q, _servico.Fuso).ToString("dd/MM/yyyy HH:mm:ss", NumeroBr.Cultura)}"
            : "Quando: (linha sem data, do começo do arquivo)");
        LinhasDetalhe.Add($"Nível: {linha.NivelRotulo}" + (r.NivelArquivo.Length > 0 ? $" ([{r.NivelArquivo}])" : string.Empty));
        if (r.Categoria is { } categoria)
        {
            LinhasDetalhe.Add($"Onde: {categoria}");
        }

        if (r.Terminal is { } terminal)
        {
            LinhasDetalhe.Add($"Terminal: {terminal}");
        }

        LinhasDetalhe.Add($"Arquivo: {r.Arquivo}");
        OQueFazer = null;
        TextoTecnico = r.Texto;
    }

    private static JsonObject? Json(string texto)
    {
        try
        {
            return texto.TrimStart().StartsWith('{') ? JsonNode.Parse(texto) as JsonObject : null;
        }
        catch (JsonException)
        {
            // A máscara pode ter mexido no JSON: mostra o texto como está.
            return null;
        }
    }

    /// <summary>Esc: fecha o detalhe, depois volta ao menu da Central.</summary>
    [RelayCommand]
    private Task Voltar()
    {
        if (MostrandoDetalhe)
        {
            FecharDetalhe();
            return Task.CompletedTask;
        }

        return _voltar();
    }

    /// <summary>
    /// O relógio da Central (1 s): a liberação que emprestou o diagnóstico acabou. Nada do que ela mostrava fica na aba (a
    /// lista, o detalhe): a próxima visita lê de novo, com quem pode então.
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
        _leitura?.Cancel();
        Carregando = false;
        FecharDetalhe(focar: false);
        Linhas.Clear();
        Selecionada = null;
        _proxima = null;
        TemProxima = false;
        Rodape = string.Empty;
        Mensagem = null;
        Erro = null;
    }

    private void FecharDetalhe(bool focar = true)
    {
        if (!MostrandoDetalhe && LinhasDetalhe.Count == 0)
        {
            return;
        }

        MostrandoDetalhe = false;
        TituloDetalhe = string.Empty;
        LinhasDetalhe.Clear();
        OQueFazer = null;
        TextoTecnico = null;
        Erro = null;
        if (focar)
        {
            FocoSolicitado?.Invoke(this, AlvoFocoLogs.Filtro);
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
        _shell.Servico<ILogger<AbaLogsViewModel>>().LogError(e, "Falha na aba Logs e ocorrências da Central");
        Erro = $"Não deu certo ({MascaradorSuporte.Mascarar(e.Message)}). F5 tenta de novo.";
    }
}
