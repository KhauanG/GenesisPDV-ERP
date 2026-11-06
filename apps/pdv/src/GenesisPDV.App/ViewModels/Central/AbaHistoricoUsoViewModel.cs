using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Data.Repositorios;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels.Central;

/// <summary>Para onde a aba 6 leva o foco.</summary>
public enum AlvoFocoHistoricoUso
{
    /// <summary>O campo do texto (↑/↓, Enter, PgDn e as teclas F funcionam dele).</summary>
    Filtro,

    /// <summary>O detalhe aberto (Esc volta à lista).</summary>
    Detalhe,

    /// <summary>A lista do resumo por operador (↑/↓ escolhem, Enter filtra a lista pela pessoa).</summary>
    Resumo,
}

/// <summary>
/// Uma linha da aba 6: a hora, a frase ("MARIA cancelou um item · liberado por CARLOS"), a descrição do registro
/// (mascarada) e a marca de envio (a palavra ao lado da cor, PDV 9.1). Com o filtro "Quem" na pessoa que só liberou a
/// ação, a marca <see cref="MarcaLiberacao"/> antes da frase (decisão 78).
/// </summary>
public sealed class LinhaHistoricoUsoViewModel : ViewModelBase
{
    public LinhaHistoricoUsoViewModel(RegistroHistoricoUso registro, TimeZoneInfo fuso)
    {
        Registro = registro;
        Hora = TimeZoneInfo.ConvertTime(registro.OcorridoEm, fuso).ToString("dd/MM HH:mm", NumeroBr.Cultura);
        Grupo = DescritorAuditoria.RotuloGrupo(registro.Descricao.Grupo);
        Detalhe = UmaLinha(registro.Detalhe ?? string.Empty);
        Envio = DescritorAuditoria.RotuloEnvio(registro.Envio);
    }

    public RegistroHistoricoUso Registro { get; }

    public string Hora { get; }

    public string Grupo { get; }

    public string Frase => Registro.Frase;

    /// <summary>A linha entrou no filtro "Quem" porque a pessoa liberou com o PIN a ação de outra (não foi quem fez).</summary>
    public bool PorLiberacao => Registro.PorLiberacao;

    /// <summary>O selo antes da frase na linha que a pessoa do filtro só liberou.</summary>
    public const string MarcaLiberacao = "LIBEROU";

    public string? Marca => PorLiberacao ? MarcaLiberacao : null;

    public string Detalhe { get; }

    public string Envio { get; }

    public bool Enviado => Registro.Envio == SituacaoEnvio.Enviado;

    public bool AEnviar => Registro.Envio == SituacaoEnvio.AEnviar;

    public bool Recusado => Registro.Envio == SituacaoEnvio.Recusado;

    public string Leitura => $"{Hora}, {Grupo}: {(PorLiberacao ? $"{Registro.LiberadoPor} liberou com o PIN: " : string.Empty)}{Frase}. {Detalhe}. {Envio}".Trim();

    private static string UmaLinha(string texto)
    {
        var primeira = texto.Split('\n', 2)[0].TrimEnd('\r');
        return primeira.Length > 300 ? primeira[..300] + "…" : primeira;
    }
}

/// <summary>Uma linha do resumo por operador (F6): o nome e os números do período, em texto curto.</summary>
public sealed class LinhaResumoUsoViewModel(ResumoOperadorUso resumo, TimeZoneInfo fuso) : ViewModelBase
{
    public ResumoOperadorUso Resumo { get; } = resumo;

    public string Nome => Resumo.Nome;

    /// <summary>"das 08:02 de 03/11 às 18:40 de 05/11" (sem atividade na auditoria: "—").</summary>
    public string Atividade => Resumo.Primeira is { } p && Resumo.Ultima is { } u
        ? $"de {Hora(p)} a {Hora(u)}"
        : "—";

    public string Vendas => $"{Resumo.Vendas} {(Resumo.Vendas == 1 ? "venda paga" : "vendas pagas")} · {Resumo.Logins} {(Resumo.Logins == 1 ? "login" : "logins")}";

    public string Cancelamentos =>
        $"{Resumo.ItensCancelados} {(Resumo.ItensCancelados == 1 ? "item cancelado" : "itens cancelados")} · " +
        $"{Resumo.VendasCanceladas} {(Resumo.VendasCanceladas == 1 ? "venda paga cancelada" : "vendas pagas canceladas")} · " +
        $"{Resumo.CanceladasEmAndamento} em andamento {(Resumo.CanceladasEmAndamento == 1 ? "cancelada" : "canceladas")}";

    public string Descontos =>
        $"{Resumo.Descontos} {(Resumo.Descontos == 1 ? "desconto dado" : "descontos dados")} · " +
        $"{Resumo.VendasComDesconto} {(Resumo.VendasComDesconto == 1 ? "venda paga" : "vendas pagas")} com desconto: R$ {NumeroBr.Dinheiro(Resumo.ValorDescontos)}";

    public string Gaveta =>
        $"{Resumo.GavetasSemVenda} {(Resumo.GavetasSemVenda == 1 ? "gaveta aberta" : "gavetas abertas")} sem venda · " +
        $"{Resumo.LiberacoesPedidas} {(Resumo.LiberacoesPedidas == 1 ? "liberação pedida" : "liberações pedidas")} · " +
        $"{Resumo.LiberacoesDadas} {(Resumo.LiberacoesDadas == 1 ? "dada" : "dadas")} como supervisor";

    public string Leitura => $"{Nome}: {Atividade}. {Vendas}. {Cancelamentos}. {Descontos}. {Gaveta}.";

    private string Hora(DateTimeOffset quando) => TimeZoneInfo.ConvertTime(quando, fuso).ToString("dd/MM HH:mm", NumeroBr.Cultura);
}

/// <summary>
/// Aba 6 da Central do PDV, <b>Histórico de uso</b> (bloco G10; plano 4.4; README › decisão 74): o dono vê quem cancelou,
/// deu desconto ou abriu a gaveta, por operador, sem internet. Pede <c>pdv.auditoria.ver_local</c> (a própria ou a
/// emprestada pelo Ctrl+L do gerente ou do dono; o Encarregado não vê, PC-8). A lista é o <c>log_auditoria_local</c> em
/// frases, o mais novo primeiro, com a marca "enviado / a enviar / só local". Filtros: o período (F3, pelo dia
/// operacional), o grupo (F4: acessos, vendas, caixa, configuração, sistema), quem (F7: o que a pessoa fez e o que ela
/// liberou com o PIN, com o selo "LIBEROU" nessas linhas — resposta do dono de 05/11/2026, decisão 78) e o texto (o campo);
/// com Shift, o F3, o F4 e o F7 voltam um. <b>F6</b> alterna para o <b>resumo por operador</b> do período (Enter numa pessoa
/// volta à lista só com ela). Tudo mascarado; nada é gravado nem apagado. Teclas: ↑/↓ escolhem, Enter (ou o * do
/// numérico) detalhe, PgDn/PgUp (ou + e −) página, F5 atualiza, F8 limpa, Esc fecha o detalhe ou o resumo e volta ao
/// menu; tudo também pelo mouse.
/// </summary>
public sealed partial class AbaHistoricoUsoViewModel : ViewModelBase
{
    /// <summary>O índice segue <see cref="PeriodoHistoricoUso"/> (no máximo 30 dias, como as vendas e os caixas).</summary>
    public static IReadOnlyList<string> Periodos { get; } = ["Hoje", "Ontem", "Últimos 7 dias", "Últimos 30 dias"];

    /// <summary>"Todos os grupos" e os de <see cref="DescritorAuditoria.Grupos"/>, na ordem.</summary>
    public static IReadOnlyList<string> Grupos { get; } =
        ["Todos os grupos", .. DescritorAuditoria.Grupos.Select(DescritorAuditoria.RotuloGrupo)];

    private readonly ShellViewModel _shell;
    private readonly ServicoHistoricoUso _servico;
    private readonly Func<Task> _voltar;

    /// <summary>O começo de cada página já vista (a primeira é nula): o PgUp volta pelo cursor guardado.</summary>
    private readonly List<CursorAuditoria?> _inicios = [null];

    /// <summary>Quantas linhas as páginas antes de cada uma mostraram (o "Registros 51 a 97" do rodapé).</summary>
    private readonly List<int> _antes = [0];

    private List<OpcaoQuem> _quem = [new(null, "Todos")];
    private CursorAuditoria? _proxima;
    private int _versao;
    private bool _montando;
    private bool? _viaPermissao;
    private CancellationTokenSource? _leitura;

    /// <param name="voltar">Esc: volta ao menu da Central.</param>
    public AbaHistoricoUsoViewModel(ShellViewModel shell, Func<Task> voltar)
    {
        _shell = shell;
        _servico = shell.Servico<ServicoHistoricoUso>();
        _voltar = voltar;
    }

    public string Titulo => AbasCentral.HistoricoUso.Rotulo;

    public string Teclas =>
        "↑/↓ escolhem · Enter (ou *) detalhe · PgDn/PgUp (ou + e −) página · F3 período · F4 grupo · F7 quem (Shift volta) · F6 resumo por operador · F5 atualiza · F8 limpa · Esc volta ao menu";

    public string TeclasResumo => "↑/↓ escolhem · Enter mostra o que a pessoa fez ou liberou · F3 período (Shift volta) · F5 atualiza · F6 ou Esc volta à lista";

    public string TeclasDetalhe => "Esc volta à lista";

    public string Explicacao =>
        "Quem fez o quê neste caixa nos últimos 30 dias, do mais novo ao mais antigo. \"Só local\" fica só aqui; \"enviado\" já está "
        + "guardado na nuvem. Vendas e caixas mais antigos: no ERP.";

    [ObservableProperty]
    public partial int PeriodoIndice { get; set; } = (int)PeriodoHistoricoUso.Ultimos7Dias;

    [ObservableProperty]
    public partial int GrupoIndice { get; set; }

    /// <summary>"Todos" e quem fez ou liberou alguma coisa no período (pelo nome).</summary>
    public ObservableCollection<string> Quem { get; } = ["Todos"];

    [ObservableProperty]
    public partial int QuemIndice { get; set; }

    [ObservableProperty]
    public partial string Texto { get; set; } = string.Empty;

    public ObservableCollection<LinhaHistoricoUsoViewModel> Linhas { get; } = [];

    [ObservableProperty]
    public partial LinhaHistoricoUsoViewModel? Selecionada { get; set; }

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

    // --- Resumo por operador (F6) ---

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(NaLista))]
    public partial bool MostrandoResumo { get; set; }

    public bool NaLista => !MostrandoResumo && !MostrandoDetalhe;

    public ObservableCollection<LinhaResumoUsoViewModel> Resumo { get; } = [];

    [ObservableProperty]
    public partial LinhaResumoUsoViewModel? ResumoSelecionado { get; set; }

    [ObservableProperty]
    public partial string TituloResumo { get; set; } = string.Empty;

    // --- Detalhe (Enter) ---

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(NaLista))]
    public partial bool MostrandoDetalhe { get; set; }

    [ObservableProperty]
    public partial string TituloDetalhe { get; set; } = string.Empty;

    public ObservableCollection<string> LinhasDetalhe { get; } = [];

    /// <summary>A leitura em curso (os testes a aguardam).</summary>
    public Task Atualizacao { get; private set; } = Task.CompletedTask;

    public event EventHandler<AlvoFocoHistoricoUso>? FocoSolicitado;

    /// <summary>A Central pede o foco no conteúdo (o 6 de novo no menu).</summary>
    public void Focar() => FocoSolicitado?.Invoke(this, Alvo());

    /// <summary>Abre a aba (e a cada visita): quem fez ou liberou alguma coisa no período e a primeira página (ou o resumo aberto).</summary>
    public Task CarregarAsync() => Atualizacao = LerDoComecoAsync(recarregarQuem: true);

    partial void OnPeriodoIndiceChanged(int value)
    {
        if (!_montando)
        {
            Mensagem = null;
            // O período muda quem aparece no filtro "Quem" (a pessoa escolhida fica, se ainda estiver).
            Atualizacao = LerDoComecoAsync(recarregarQuem: true);
        }
    }

    partial void OnGrupoIndiceChanged(int value) => FiltroMudou();

    partial void OnQuemIndiceChanged(int value) => FiltroMudou();

    partial void OnTextoChanged(string value) => FiltroMudou();

    private void FiltroMudou()
    {
        if (!_montando)
        {
            Mensagem = null;
            Atualizacao = LerDoComecoAsync(recarregarQuem: false);
        }
    }

    private Task LerDoComecoAsync(bool recarregarQuem)
    {
        _inicios.Clear();
        _inicios.Add(null);
        _antes.Clear();
        _antes.Add(0);
        Pagina = 1;
        return LerAsync(null, recarregarQuem);
    }

    private async Task LerAsync(CursorAuditoria? inicio, bool recarregarQuem = false, bool avancando = false)
    {
        var versao = ++_versao;
        if (_leitura is { } anterior)
        {
            await anterior.CancelAsync();
        }

        var cancelar = new CancellationTokenSource();
        _leitura = cancelar;
        Erro = null;
        Carregando = true;
        try
        {
            _viaPermissao = _servico.VeHistorico;
            var periodo = (PeriodoHistoricoUso)Math.Clamp(PeriodoIndice, 0, Periodos.Count - 1);
            if (recarregarQuem)
            {
                var quem = await Task.Run(() => _servico.QuemAsync(periodo, cancelar.Token), cancelar.Token);
                if (versao != _versao)
                {
                    return;
                }

                MontarQuem(quem);
            }

            if (MostrandoResumo)
            {
                var resumo = await Task.Run(() => _servico.ResumoAsync(periodo, cancelar.Token), cancelar.Token);
                if (versao != _versao)
                {
                    return;
                }

                MostrarResumo(resumo, periodo);
                return;
            }

            var (desde, ate) = _servico.Intervalo(periodo);
            var acoes = GrupoIndice > 0 && GrupoIndice <= DescritorAuditoria.Grupos.Count
                ? DescritorAuditoria.AcoesDoGrupo(DescritorAuditoria.Grupos[GrupoIndice - 1])
                : null;
            var usuario = QuemIndice > 0 && QuemIndice < _quem.Count ? _quem[QuemIndice].Id : null;
            var filtro = new FiltroAuditoria(desde, ate, usuario, acoes, Texto);
            var pagina = await Task.Run(() => _servico.RegistrosAsync(filtro, inicio, cancelar.Token), cancelar.Token);
            if (versao != _versao)
            {
                return;
            }

            var fuso = _servico.Fuso;
            Mostrar([.. pagina.Registros.Select(r => new LinhaHistoricoUsoViewModel(r, fuso))], pagina.Proxima, pagina.Parcial, avancando);
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

    private void MontarQuem(IReadOnlyList<OpcaoQuem> quem)
    {
        var anterior = QuemIndice > 0 && QuemIndice < _quem.Count ? _quem[QuemIndice].Id : null;
        _montando = true;
        try
        {
            _quem = [.. quem];
            Quem.Clear();
            foreach (var q in quem)
            {
                Quem.Add(q.Nome);
            }

            var i = anterior is { } a ? _quem.FindIndex(q => q.Id == a) : -1;
            QuemIndice = Math.Max(0, i);
        }
        finally
        {
            _montando = false;
        }
    }

    private void Mostrar(List<LinhaHistoricoUsoViewModel> linhas, CursorAuditoria? proxima, bool parcial, bool avancando)
    {
        if (avancando && linhas.Count == 0 && proxima is null)
        {
            // O PgDn que só achou o fim (a página anterior acabou exatamente no último registro): fica na página de antes.
            _inicios.RemoveAt(_inicios.Count - 1);
            _antes.RemoveAt(_antes.Count - 1);
            Pagina--;
            TemProxima = false;
            _proxima = null;
            Mensagem = "Não há registros mais antigos com esses filtros.";
            Rodape = Rodape.Replace(" · PgDn mais antigos", string.Empty, StringComparison.Ordinal);
            return;
        }

        var escolhida = Selecionada;
        Linhas.Clear();
        foreach (var l in linhas)
        {
            Linhas.Add(l);
        }

        Selecionada = Linhas.FirstOrDefault(l => l.Registro.Id == escolhida?.Registro.Id) ?? Linhas.FirstOrDefault();
        _proxima = proxima;
        TemProxima = proxima is not null;
        var lidos = $"nos {ServicoHistoricoUso.LimiteBusca.ToString("N0", NumeroBr.Cultura)} registros já procurados";
        var de = _antes[^1] + 1;
        Rodape = Linhas.Count == 0
            ? (parcial ? $"Nada achado {lidos}: PgDn procura mais para trás." : "Nenhum registro com esses filtros.")
            : $"Registros {de} a {de + Linhas.Count - 1} · página {Pagina}"
              + (parcial ? $" · a busca parou {lidos}" : string.Empty)
              + (TemProxima ? " · PgDn mais antigos" : string.Empty)
              + (Linhas.FirstOrDefault(l => l.PorLiberacao) is { } liberada
                  ? $" · \"{LinhaHistoricoUsoViewModel.MarcaLiberacao}\": a ação foi de outra pessoa e {liberada.Registro.LiberadoPor} liberou com o PIN"
                  : string.Empty);
    }

    private void MostrarResumo(IReadOnlyList<ResumoOperadorUso> resumo, PeriodoHistoricoUso periodo)
    {
        var escolhido = ResumoSelecionado?.Resumo.UsuarioId;
        var fuso = _servico.Fuso;
        Resumo.Clear();
        foreach (var r in resumo)
        {
            Resumo.Add(new LinhaResumoUsoViewModel(r, fuso));
        }

        ResumoSelecionado = Resumo.FirstOrDefault(r => r.Resumo.UsuarioId == escolhido) ?? Resumo.FirstOrDefault();
        TituloResumo = $"Resumo por operador · {Periodos[(int)periodo]}";
        Rodape = Resumo.Count == 0
            ? "Ninguém usou o caixa neste período."
            : $"{Resumo.Count} {(Resumo.Count == 1 ? "pessoa" : "pessoas")} · vendas e descontos das vendas pagas deste caixa; o resto, do histórico de uso";
    }

    [RelayCommand]
    private void Mover(string direcao)
    {
        if (MostrandoDetalhe)
        {
            return;
        }

        if (MostrandoResumo)
        {
            if (Resumo.Count > 0)
            {
                var r = ResumoSelecionado is null ? -1 : Resumo.IndexOf(ResumoSelecionado);
                ResumoSelecionado = Resumo[direcao == "acima" ? Math.Max(0, r - 1) : Math.Min(Resumo.Count - 1, r + 1)];
            }

            return;
        }

        if (Linhas.Count == 0)
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
        if (_proxima is not { } proxima || !NaLista)
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
        if (_inicios.Count <= 1 || !NaLista)
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

    /// <summary>F3: o próximo período (Shift+F3, <c>anterior</c>, volta um); vale para a lista e para o resumo.</summary>
    [RelayCommand]
    private void ProximoPeriodo(string? direcao)
    {
        if (!MostrandoDetalhe)
        {
            PeriodoIndice = Girar(PeriodoIndice, Periodos.Count, direcao);
        }
    }

    /// <summary>F4: o próximo grupo de ações (Shift+F4 volta um).</summary>
    [RelayCommand]
    private void ProximoGrupo(string? direcao)
    {
        if (NaLista)
        {
            GrupoIndice = Girar(GrupoIndice, Grupos.Count, direcao);
        }
    }

    /// <summary>F7: a próxima pessoa (Shift+F7 volta uma).</summary>
    [RelayCommand]
    private void ProximoQuem(string? direcao)
    {
        if (NaLista && Quem.Count > 0)
        {
            QuemIndice = Girar(QuemIndice, Quem.Count, direcao);
        }
    }

    private static int Girar(int atual, int total, string? direcao) =>
        (atual + (direcao == "anterior" ? total - 1 : 1)) % total;

    /// <summary>F5: lê de novo (a mesma página, ou o resumo); com o detalhe aberto, nada.</summary>
    [RelayCommand]
    private Task Atualizar()
    {
        if (MostrandoDetalhe)
        {
            return Task.CompletedTask;
        }

        Mensagem = null;
        return Atualizacao = MostrandoResumo ? LerAsync(null, recarregarQuem: true) : LerAsync(_inicios[^1], recarregarQuem: true);
    }

    /// <summary>F8: últimos 7 dias, todos os grupos, todos, sem texto (na lista).</summary>
    [RelayCommand]
    private Task LimparFiltros()
    {
        if (!NaLista)
        {
            return Task.CompletedTask;
        }

        _montando = true;
        try
        {
            PeriodoIndice = (int)PeriodoHistoricoUso.Ultimos7Dias;
            GrupoIndice = 0;
            QuemIndice = 0;
            Texto = string.Empty;
        }
        finally
        {
            _montando = false;
        }

        Mensagem = null;
        FocoSolicitado?.Invoke(this, AlvoFocoHistoricoUso.Filtro);
        return Atualizacao = LerDoComecoAsync(recarregarQuem: true);
    }

    /// <summary>F6: a lista ↔ o resumo por operador do mesmo período.</summary>
    [RelayCommand]
    private Task AlternarResumo()
    {
        if (MostrandoDetalhe)
        {
            return Task.CompletedTask;
        }

        Mensagem = null;
        MostrandoResumo = !MostrandoResumo;
        FocoSolicitado?.Invoke(this, Alvo());
        return Atualizacao = MostrandoResumo ? LerAsync(null) : LerDoComecoAsync(recarregarQuem: false);
    }

    /// <summary>
    /// Enter (ou o duplo clique, ou o *): na lista, o detalhe da linha (de novo, fecha); no resumo, volta à lista só com o
    /// que a pessoa escolhida fez no período.
    /// </summary>
    [RelayCommand]
    private Task Detalhar(object? alvo) => Tentar(async () =>
    {
        if (MostrandoDetalhe)
        {
            FecharDetalhe();
            return;
        }

        if (MostrandoResumo)
        {
            var resumo = alvo as LinhaResumoUsoViewModel ?? ResumoSelecionado
                ?? throw new RegraNegocioException(Resumo.Count == 0 ? "Ninguém no resumo." : "Escolha uma pessoa (setas ↑/↓ ou clique).");
            await MostrarDaPessoaAsync(resumo.Resumo);
            return;
        }

        var linha = alvo as LinhaHistoricoUsoViewModel ?? Selecionada
            ?? throw new RegraNegocioException(Linhas.Count == 0 ? "Nada na lista." : "Escolha uma linha (setas ↑/↓ ou clique).");
        Selecionada = linha;
        // Lido de novo pelo id (a lista guarda só o que mostra); o serviço confere a permissão de novo.
        var atual = await Task.Run(() => _servico.RegistroAsync(linha.Registro.Id)) ?? linha.Registro;
        if (!ReferenceEquals(Selecionada, linha))
        {
            return;
        }

        MontarDetalhe(atual, linha);
        Mensagem = null;
        MostrandoDetalhe = true;
        FocoSolicitado?.Invoke(this, AlvoFocoHistoricoUso.Detalhe);
    });

    /// <summary>Do resumo para a lista, com o filtro "Quem" na pessoa (os outros filtros limpos; o período fica).</summary>
    private async Task MostrarDaPessoaAsync(ResumoOperadorUso pessoa)
    {
        var usuarioId = pessoa.UsuarioId;
        MostrandoResumo = false;
        _montando = true;
        try
        {
            GrupoIndice = 0;
            Texto = string.Empty;
            var i = _quem.FindIndex(q => q.Id == usuarioId);
            QuemIndice = Math.Max(0, i);
        }
        finally
        {
            _montando = false;
        }

        FocoSolicitado?.Invoke(this, AlvoFocoHistoricoUso.Filtro);
        await (Atualizacao = LerDoComecoAsync(recarregarQuem: false));
        if (QuemIndice == 0)
        {
            // Quem não fez nem liberou nada no histórico de uso do período (só vendeu) não está no filtro "Quem" (quem só
            // liberou está, decisão 78): a lista mostra todos, e a mensagem diz por quê.
            Mensagem = $"{pessoa.Nome} não tem registros no histórico de uso deste período (só vendas). A lista mostra todos.";
        }
    }

    private void MontarDetalhe(RegistroHistoricoUso r, LinhaHistoricoUsoViewModel linha)
    {
        TituloDetalhe = $"{r.Descricao.Titulo} · {linha.Hora}";
        LinhasDetalhe.Clear();
        LinhasDetalhe.Add($"Quando: {TimeZoneInfo.ConvertTime(r.OcorridoEm, _servico.Fuso).ToString("dd/MM/yyyy HH:mm:ss", NumeroBr.Cultura)}");
        LinhasDetalhe.Add($"O que: {r.Frase}");
        if (linha.PorLiberacao)
        {
            LinhasDetalhe.Add($"Na lista porque {linha.Registro.LiberadoPor} liberou com o PIN (a ação foi de {r.Quem ?? "outra pessoa"}).");
        }
        LinhasDetalhe.Add($"Grupo: {DescritorAuditoria.RotuloGrupo(r.Descricao.Grupo)} · nuvem: {DescritorAuditoria.RotuloEnvio(r.Envio)}"
                          + r.Envio switch
                          {
                              SituacaoEnvio.Recusado => " (quem resolve é o ERP; veja a aba 4 Sincronização)",
                              SituacaoEnvio.Descartado => " (o ERP descartou o envio: não entra na nuvem e fica só neste caixa)",
                              _ => string.Empty,
                          });
        if (r.Detalhe is { Length: > 0 } detalhe)
        {
            LinhasDetalhe.Add($"Registro: {detalhe}");
        }

        if (r.Motivo is { Length: > 0 } motivo)
        {
            LinhasDetalhe.Add($"Motivo: {motivo}");
        }

        if (r.Localizacao is { Length: > 0 } onde)
        {
            LinhasDetalhe.Add($"Onde: {onde}");
        }

        foreach (var c in r.Campos)
        {
            LinhasDetalhe.Add(c.Antes is null ? $"  {c.Nome}: {c.Depois ?? "—"}"
                : c.Depois is null ? $"  {c.Nome}: {c.Antes} (antes)"
                : $"  {c.Nome}: {c.Antes} → {c.Depois}");
        }

        if (r.CamposOcultos > 0)
        {
            LinhasDetalhe.Add(r.CamposOcultos == 1 ? "  (+1 campo não mostrado aqui)" : $"  (+{r.CamposOcultos} campos não mostrados aqui)");
        }
    }

    /// <summary>Esc: fecha o detalhe ou o resumo, depois volta ao menu da Central.</summary>
    [RelayCommand]
    private Task Voltar()
    {
        if (MostrandoDetalhe)
        {
            FecharDetalhe();
            return Task.CompletedTask;
        }

        if (MostrandoResumo)
        {
            return AlternarResumo();
        }

        return _voltar();
    }

    /// <summary>
    /// O relógio da Central (1 s): a liberação que emprestou o histórico de uso acabou. Nada do que ela mostrava fica na aba
    /// (a lista, o resumo, o detalhe, os nomes do filtro "Quem" e o texto buscado): a próxima visita lê de novo, com quem
    /// pode então.
    /// </summary>
    public void ConferirPermissoes()
    {
        var antes = _viaPermissao;
        _viaPermissao = _servico.VeHistorico;
        if (antes != true || _viaPermissao == true)
        {
            return;
        }

        _versao++;
        _leitura?.Cancel();
        Carregando = false;
        FecharDetalhe(focar: false);
        MostrandoResumo = false;
        Linhas.Clear();
        Selecionada = null;
        Resumo.Clear();
        ResumoSelecionado = null;
        _montando = true;
        try
        {
            _quem = [new(null, "Todos")];
            Quem.Clear();
            Quem.Add("Todos");
            QuemIndice = 0;
            Texto = string.Empty;
        }
        finally
        {
            _montando = false;
        }

        _proxima = null;
        TemProxima = false;
        Rodape = string.Empty;
        Mensagem = null;
        Erro = null;
    }

    private AlvoFocoHistoricoUso Alvo() => MostrandoDetalhe ? AlvoFocoHistoricoUso.Detalhe
        : MostrandoResumo ? AlvoFocoHistoricoUso.Resumo
        : AlvoFocoHistoricoUso.Filtro;

    private void FecharDetalhe(bool focar = true)
    {
        if (!MostrandoDetalhe && LinhasDetalhe.Count == 0)
        {
            return;
        }

        MostrandoDetalhe = false;
        TituloDetalhe = string.Empty;
        LinhasDetalhe.Clear();
        Erro = null;
        if (focar)
        {
            FocoSolicitado?.Invoke(this, AlvoFocoHistoricoUso.Filtro);
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
        _shell.Servico<ILogger<AbaHistoricoUsoViewModel>>().LogError(e, "Falha na aba Histórico de uso da Central");
        Erro = $"Não deu certo ({MascaradorSuporte.Mascarar(e.Message)}). F5 tenta de novo.";
    }
}
