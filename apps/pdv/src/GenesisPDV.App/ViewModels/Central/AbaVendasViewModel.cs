using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Repositorios;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels.Central;

/// <summary>Uma opção do filtro "Caixa" da aba Vendas: o aberto, todos os dos últimos 30 dias ou um fechado.</summary>
/// <param name="SessaoId">Nulo = todos os caixas consultáveis.</param>
public sealed record OpcaoCaixaVendas(Guid? SessaoId, string Rotulo, bool Aberto)
{
    public override string ToString() => Rotulo;
}

/// <summary>Uma linha da aba Vendas: número, data e hora, operador, total, formas, o documento mascarado e o selo.</summary>
public sealed class LinhaVendaCentralViewModel(VendaDaSessao venda, TimeZoneInfo fuso, string operador) : ViewModelBase
{
    public VendaDaSessao Venda { get; } = venda;

    /// <summary>O número do caixa e, quando a nuvem renumerou a venda ("Aplicar com novo número", T27), o novo.</summary>
    public string Numero => Venda.NumeroNuvem is { } novo ? $"{Venda.NumeroExibicao} → {novo}" : Venda.NumeroExibicao;

    public string DataHora => TimeZoneInfo.ConvertTime(Venda.Hora, fuso).ToString("dd/MM HH:mm", NumeroBr.Cultura);

    public string Operador { get; } = operador;

    public string Total => NumeroBr.Dinheiro(Venda.Total);

    public string Formas => Venda.Finalizada ? Venda.Formas : "(em andamento)";

    /// <summary>CPF mascarado na lista (<c>***.456.789-**</c>, plano 4.2); inteiro só no detalhe.</summary>
    public string Documento => MascararDocumento(Venda.CpfCnpjNota);

    /// <summary>"aberto" ou o dia do fechamento do caixa da venda.</summary>
    public string Caixa => Venda.CaixaFechadoEm is { } f ? $"fech. {TimeZoneInfo.ConvertTime(f, fuso).ToString("dd/MM", NumeroBr.Cultura)}" : "aberto";

    public bool Cancelada => Venda.Status == StatusVenda.Cancelada;

    /// <summary>CANCELADA, CANCELADA DEPOIS (do fechamento do caixa dela; nenhum caminho do PDV faz isso, D23) ou nada.</summary>
    public string Selo => Venda.CanceladaDepois ? "CANCELADA DEPOIS" : Cancelada ? "CANCELADA" : string.Empty;

    /// <summary>Só a venda paga e não cancelada se reimprime (22.2).</summary>
    public bool Ativa => Venda.Finalizada && !Cancelada;

    public string Leitura => $"Venda {Numero}, {DataHora}, {Operador}, R$ {Total}, {Formas}. {Selo}".Trim();

    /// <summary>CPF <c>***.456.789-**</c> e CNPJ <c>**.345.678/0001-**</c>: o meio, que ajuda a conferir sem expor o número.</summary>
    public static string MascararDocumento(string? documento) => documento switch
    {
        { Length: 11 } cpf => $"***.{cpf[3..6]}.{cpf[6..9]}-**",
        { Length: 14 } cnpj => $"**.{cnpj[2..5]}.{cnpj[5..8]}/{cnpj[8..12]}-**",
        null or "" => string.Empty,
        _ => "***",
    };
}

/// <summary>Para onde a aba Vendas leva o foco.</summary>
public enum AlvoFocoVendas
{
    /// <summary>O campo do número ou CPF (↑/↓, Enter, Ctrl+R e as teclas F funcionam dele).</summary>
    Filtro,

    /// <summary>O detalhe da venda (Esc volta à lista).</summary>
    Detalhe,
}

/// <summary>
/// Aba 1 da Central do PDV, <b>Vendas</b> (bloco G5; plano 4.2; decisões do dono de 04/11/2026; D23 mantida): as vendas do
/// <b>caixa aberto</b> primeiro e, num filtro, as de um caixa fechado deste terminal (ou de todos) nos <b>últimos 30
/// dias</b>; mais antigas, só no ERP. Sem <c>pdv.venda.consultar_historico</c> (própria ou emprestada pelo Ctrl+L da
/// Central), só o caixa aberto. Filtros no SQL: caixa, número ou CPF/CNPJ, situação, operador, forma e valor; 50 por
/// página, por cursor. A lista mostra o CPF mascarado e o selo CANCELADA / CANCELADA DEPOIS; o detalhe, os itens, os
/// pagamentos e o caixa da venda. Ctrl+R reimprime (2ª via; sem <c>pdv.documento.reimprimir</c>, o supervisor libera na
/// hora: a liberação da Central não empresta ação). Venda de caixa fechado não se cancela no PDV; a do caixa aberto,
/// pelo Ctrl+Del, vai ao F12 da venda (o mesmo fluxo de sempre, o gerente ou o encarregado). Teclas: ↑/↓ escolhem,
/// Enter (ou o * do numérico) detalhe, PgDn/PgUp (ou + e −) página, F3/Shift+F3 caixa, F4 situação, F5 atualiza, F6 limpa os filtros, Esc
/// volta; tudo também pelo mouse. Com o detalhe aberto, as ações são da venda dele; a releitura que a tira da lista fecha
/// o detalhe e o pedido do supervisor.
/// </summary>
public sealed partial class AbaVendasViewModel : ViewModelBase
{
    public const string Localizacao = "PDV › Central do PDV › Vendas";

    public const string MensagemCaixaFechado = "Venda de caixa já fechado não se cancela no caixa: aqui ela só se consulta e reimprime.";

    public const string MensagemCancelarPeloLogin =
        "Para cancelar uma venda paga do caixa aberto, entre no caixa e use o F12 Gestão de vendas (o cancelamento é do gerente ou do encarregado).";

    public const string MensagemSemHistorico =
        "Você vê só as vendas do caixa aberto. Os caixas fechados dos últimos 30 dias pedem o supervisor: Ctrl+L Liberar.";

    public const string MensagemHistoricoAcabou = "A liberação acabou: a lista voltou ao caixa aberto.";

    /// <summary>O caixa escolhido sumiu da lista sem a liberação acabar: passou dos 30 dias (a hora de corte virou o dia).</summary>
    public const string MensagemCaixaForaDoAlcance =
        "O caixa escolhido passou dos últimos 30 dias: consulte-o no ERP (Fechamentos de caixa). A lista voltou ao primeiro caixa.";

    public const string MensagemSemCaixa = "Nenhum caixa aberto neste terminal.";

    /// <summary>Situação: o índice segue <see cref="SituacaoFiltroVenda"/>.</summary>
    public static IReadOnlyList<string> Situacoes { get; } = ["Todas", "Pagas", "Canceladas"];

    private readonly ShellViewModel _shell;
    private readonly AcessoCentral _acesso;
    private readonly ServicoHistoricoVendas _servico;
    private readonly TimeZoneInfo _fuso;
    private readonly Func<Guid, Task>? _cancelarNaVenda;
    private readonly Func<Task> _voltar;
    private readonly Func<Guid, Task>? _verCaixa;
    private readonly Dictionary<Guid, string> _nomes = [];
    private readonly Dictionary<Guid, CaixaConsultavel> _caixas = [];

    /// <summary>O começo de cada página já vista (a primeira é nula): o PgUp volta pelo cursor guardado.</summary>
    private readonly List<CursorVendas?> _inicios = [null];

    private CursorVendas? _proxima;
    private int _versao;
    private bool _montandoOpcoes;
    private bool? _historico;

    /// <summary>
    /// A venda do detalhe aberto: Ctrl+R e Ctrl+Del agem sobre ela (não sobre a <see cref="Selecionada"/>, que a releitura
    /// da lista pode trocar com o detalhe na tela).
    /// </summary>
    private LinhaVendaCentralViewModel? _linhaDetalhe;

    /// <summary>A venda do pedido do supervisor aberto (a reimpressão sem a permissão).</summary>
    private LinhaVendaCentralViewModel? _linhaLiberacao;

    /// <param name="cancelarNaVenda">
    /// Ctrl+Del na venda paga do caixa aberto, pela Central aberta na venda: volta à venda com o F12 nessa venda e o
    /// cancelamento de sempre. Nulo pela Central aberta no login (sem operador no caixa).
    /// </param>
    /// <param name="voltar">Esc: volta ao menu da Central.</param>
    /// <param name="verCaixa">F7: abre a aba 2 Caixas no caixa da venda (bloco G6); nulo, o F7 não faz nada.</param>
    public AbaVendasViewModel(ShellViewModel shell, Func<Guid, Task>? cancelarNaVenda, Func<Task> voltar, Func<Guid, Task>? verCaixa = null)
    {
        _shell = shell;
        _acesso = shell.Servico<AcessoCentral>();
        _servico = shell.Servico<ServicoHistoricoVendas>();
        _fuso = DiaOperacional.ObterFuso(shell.Servico<SessaoTerminal>().FusoHorario);
        _cancelarNaVenda = cancelarNaVenda;
        _voltar = voltar;
        _verCaixa = verCaixa;
    }

    public string Titulo => AbasCentral.Vendas.Rotulo;

    public string Teclas =>
        "↑/↓ escolhem · Enter (ou *) detalhe · Ctrl+R reimprime · PgDn/PgUp (ou + e −) página · F3 caixa · F4 situação · F5 atualiza · F6 limpa · F7 caixa da venda · Esc volta ao menu";

    public ObservableCollection<OpcaoCaixaVendas> Caixas { get; } = [];

    [ObservableProperty]
    public partial OpcaoCaixaVendas? CaixaEscolhido { get; set; }

    [ObservableProperty]
    public partial int SituacaoIndice { get; set; }

    public ObservableCollection<OpcaoFiltroVenda> Operadores { get; } = [];

    [ObservableProperty]
    public partial OpcaoFiltroVenda? Operador { get; set; }

    public ObservableCollection<OpcaoFiltroVenda> Formas { get; } = [];

    [ObservableProperty]
    public partial OpcaoFiltroVenda? Forma { get; set; }

    /// <summary>Número (inteiro, o do caixa ou o novo da nuvem) ou CPF/CNPJ da nota, com ou sem a máscara.</summary>
    [ObservableProperty]
    public partial string Texto { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string ValorMinimo { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string ValorMaximo { get; set; } = string.Empty;

    public ObservableCollection<LinhaVendaCentralViewModel> Linhas { get; } = [];

    [ObservableProperty]
    public partial LinhaVendaCentralViewModel? Selecionada { get; set; }

    /// <summary>"Vendas 1 a 50 de 812 · página 1" e, para quem vê o calculado do caixa (O3), a soma das pagas.</summary>
    [ObservableProperty]
    public partial string Rodape { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string? Mensagem { get; set; }

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [ObservableProperty]
    public partial bool Carregando { get; set; }

    /// <summary>Sem o histórico: o aviso de que só o caixa aberto aparece (e como liberar).</summary>
    [ObservableProperty]
    public partial string? AvisoHistorico { get; set; }

    /// <summary>
    /// Com o histórico, na última página (ou sem nada achado): mais antigo que 30 dias, só no ERP (PC-11; decisão do dono).
    /// </summary>
    [ObservableProperty]
    public partial string? AvisoMaisAntigas { get; set; }

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

    /// <summary>A reimpressão sem a permissão: usuário, PIN e motivo do supervisor, na hora (31.3).</summary>
    [ObservableProperty]
    public partial PedidoLiberacaoViewModel? Liberacao { get; set; }

    /// <summary>A leitura pedida pela última mudança de filtro (os testes a aguardam).</summary>
    public Task Atualizacao { get; private set; } = Task.CompletedTask;

    public event EventHandler<AlvoFocoVendas>? FocoSolicitado;

    /// <summary>A Central pede o foco no conteúdo (o 1 de novo no menu).</summary>
    public void Focar() => FocoSolicitado?.Invoke(this, MostrandoDetalhe ? AlvoFocoVendas.Detalhe : AlvoFocoVendas.Filtro);

    /// <summary>Só para a tela (as opções do filtro, o aviso): quem prende a consulta é o <see cref="ServicoHistoricoVendas"/>.</summary>
    private bool Historico => _servico.VeHistorico;

    /// <summary>Abre a aba: os caixas que a pessoa pode ver (o aberto primeiro), os operadores, as formas e a primeira página.</summary>
    public async Task CarregarAsync()
    {
        var historico = Historico;
        var perdeu = _historico == true && !historico;
        _historico = historico;
        if (perdeu)
        {
            // A liberação acabou: o detalhe e o pedido do supervisor de uma venda de caixa fechado saem da tela já.
            FecharForaDoAlcance(l => l.Venda.CaixaFechadoEm is null);
        }

        Carregando = true;
        try
        {
            var conhecidos = _nomes.Keys.ToHashSet();
            var (caixas, operadores, formas, nomes) = await Task.Run(async () =>
            {
                var c = await _servico.CaixasAsync();
                var o = await _servico.OperadoresAsync();
                var f = await _servico.FormasAsync();
                return (c, o, f, await NomesAsync(c.Select(x => x.OperadorId), conhecidos));
            });
            foreach (var (id, nome) in nomes)
            {
                _nomes[id] = nome;
            }

            foreach (var o in operadores.Where(o => o.Id is not null))
            {
                _nomes[o.Id!.Value] = o.Nome;
            }

            // Lidos antes de trocar as listas (a lista vazia apaga a escolha da tela).
            var anterior = CaixaEscolhido?.SessaoId;
            var tinhaEscolha = CaixaEscolhido is not null;
            var operadorAnterior = Operador?.Id;
            var formaAnterior = Forma?.Id;
            _montandoOpcoes = true;
            try
            {
                _caixas.Clear();
                Caixas.Clear();
                foreach (var c in caixas)
                {
                    _caixas[c.SessaoId] = c;
                }

                if (caixas.FirstOrDefault(c => c.Aberto) is { } aberto)
                {
                    Caixas.Add(new OpcaoCaixaVendas(aberto.SessaoId, $"Caixa aberto · desde {Hora(aberto.AbertaEm)} · {Nome(aberto.OperadorId)} · {Vendas(aberto.QuantidadeVendas)}", true));
                }

                if (historico)
                {
                    Caixas.Add(new OpcaoCaixaVendas(null, $"Todos os caixas dos últimos {ConsultasHistoricoLocal.LimiteDias} dias", false));
                    foreach (var c in caixas.Where(c => !c.Aberto))
                    {
                        Caixas.Add(new OpcaoCaixaVendas(c.SessaoId,
                            $"Fechado {Hora(c.FechadaEm!.Value)} · aberto {Hora(c.AbertaEm)} · {Nome(c.OperadorId)} · {Vendas(c.QuantidadeVendas)}", false));
                    }
                }

                CaixaEscolhido = (tinhaEscolha ? Caixas.FirstOrDefault(c => c.SessaoId == anterior) : null) ?? Caixas.FirstOrDefault();
                Trocar(Operadores, operadores);
                Operador = Operadores.FirstOrDefault(o => o.Id == operadorAnterior) ?? Operadores.FirstOrDefault();
                Trocar(Formas, formas);
                Forma = Formas.FirstOrDefault(f => f.Id == formaAnterior) ?? Formas.FirstOrDefault();
            }
            finally
            {
                _montandoOpcoes = false;
            }

            AvisoHistorico = historico ? null : MensagemSemHistorico;
            if (tinhaEscolha && CaixaEscolhido?.SessaoId != anterior)
            {
                Mensagem = perdeu ? MensagemHistoricoAcabou : MensagemCaixaForaDoAlcance;
            }
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Falhou(e);
        }
        finally
        {
            Carregando = false;
        }

        await RecarregarAsync();
    }

    /// <summary>A volta à aba (a Central): lê de novo os caixas e a página, com os filtros que estavam.</summary>
    public Task Recarregar() => Atualizacao = CarregarAsync();

    /// <summary>
    /// F7 da aba 2 Caixas (bloco G6): as vendas do caixa <paramref name="sessaoId"/>, com os outros filtros limpos. O caixa
    /// fora do alcance da pessoa (fechado, sem o histórico de vendas; ou fora dos 30 dias) não entra: a mensagem diz como
    /// liberar ou onde consultar.
    /// </summary>
    public async Task MostrarCaixaAsync(Guid sessaoId)
    {
        await Atualizacao;
        FecharLiberacao();
        if (MostrandoDetalhe)
        {
            FecharDetalhe();
        }

        if (Caixas.FirstOrDefault(c => c.SessaoId == sessaoId) is not { } opcao)
        {
            Mensagem = Historico ? MensagemCaixaForaDoAlcance : MensagemSemHistorico;
            FocoSolicitado?.Invoke(this, AlvoFocoVendas.Filtro);
            return;
        }

        _montandoOpcoes = true;
        try
        {
            CaixaEscolhido = opcao;
            SituacaoIndice = 0;
            Operador = Operadores.FirstOrDefault();
            Forma = Formas.FirstOrDefault();
            Texto = string.Empty;
            ValorMinimo = string.Empty;
            ValorMaximo = string.Empty;
        }
        finally
        {
            _montandoOpcoes = false;
        }

        Mensagem = null;
        await (Atualizacao = RecarregarAsync());
        FocoSolicitado?.Invoke(this, AlvoFocoVendas.Filtro);
    }

    /// <summary>
    /// O relógio da Central (1 s): a liberação que empresta o histórico começou ou acabou; a lista de caixas acompanha (sem
    /// ela, volta ao caixa aberto).
    /// </summary>
    public void ConferirPermissoes()
    {
        if (_historico is { } antes && antes != Historico)
        {
            Atualizacao = CarregarAsync();
        }
    }

    partial void OnCaixaEscolhidoChanged(OpcaoCaixaVendas? value) => FiltroMudou();

    partial void OnSituacaoIndiceChanged(int value) => FiltroMudou();

    partial void OnOperadorChanged(OpcaoFiltroVenda? value) => FiltroMudou();

    partial void OnFormaChanged(OpcaoFiltroVenda? value) => FiltroMudou();

    partial void OnTextoChanged(string value) => FiltroMudou();

    partial void OnValorMinimoChanged(string value) => FiltroMudou();

    partial void OnValorMaximoChanged(string value) => FiltroMudou();

    private void FiltroMudou()
    {
        if (!_montandoOpcoes)
        {
            Atualizacao = RecarregarAsync();
        }
    }

    /// <summary>Do começo (a primeira página) com os filtros da tela.</summary>
    public Task RecarregarAsync(Guid? selecionar = null)
    {
        _inicios.Clear();
        _inicios.Add(null);
        Pagina = 1;
        return LerAsync(null, selecionar);
    }

    private async Task LerAsync(CursorVendas? inicio, Guid? selecionar = null)
    {
        var versao = ++_versao;
        Erro = null;
        if (!TentarValor(ValorMinimo, "Valor mínimo", out var minimo) || !TentarValor(ValorMaximo, "Valor máximo", out var maximo))
        {
            return;
        }

        if (Caixas.Count == 0)
        {
            Linhas.Clear();
            Selecionada = null;
            TemProxima = false;
            Rodape = MensagemSemCaixa;
            AvisoMaisAntigas = null;
            FecharForaDoAlcance(_ => false);
            return;
        }

        var filtro = new FiltroVendas(
            CaixaEscolhido?.SessaoId,
            Texto,
            (SituacaoFiltroVenda)Math.Clamp(SituacaoIndice, 0, Situacoes.Count - 1),
            Operador?.Id,
            Forma?.Id,
            minimo,
            maximo);
        var historico = Historico;
        var conhecidos = _nomes.Keys.ToHashSet();
        Carregando = true;
        try
        {
            var (pagina, nomes) = await Task.Run(async () =>
            {
                var p = await _servico.VendasAsync(filtro, inicio);
                return (p, await NomesAsync(p.Vendas.Select(v => v.OperadorId), conhecidos));
            });
            if (versao != _versao)
            {
                return;
            }

            foreach (var (id, nome) in nomes)
            {
                _nomes[id] = nome;
            }

            var escolhida = selecionar ?? Selecionada?.Venda.Id;
            Linhas.Clear();
            foreach (var v in pagina.Vendas)
            {
                Linhas.Add(new LinhaVendaCentralViewModel(v, _fuso, Nome(v.OperadorId)));
            }

            Selecionada = Linhas.FirstOrDefault(l => l.Venda.Id == escolhida) ?? Linhas.FirstOrDefault();
            // A venda do detalhe (ou do pedido do supervisor) que saiu da lista (a liberação acabou, outra página, outro
            // filtro): o detalhe fecha, para nada agir sobre uma venda que a pessoa não vê mais.
            var visiveis = Linhas.Select(l => l.Venda.Id).ToHashSet();
            FecharForaDoAlcance(l => visiveis.Contains(l.Venda.Id));
            _proxima = pagina.Proxima;
            TemProxima = pagina.Proxima is not null;
            AvisoMaisAntigas = historico && !TemProxima ? ConsultasHistoricoLocal.MensagemMaisAntigas : null;
            var de = ((Pagina - 1) * ConsultasHistoricoLocal.TamanhoPagina) + 1;
            Rodape = pagina.Quantidade == 0
                ? "Nenhuma venda com esses filtros."
                : $"Vendas {de} a {de + Linhas.Count - 1} de {pagina.Quantidade} · página {Pagina}"
                  + (pagina.TotalPagas is { } total ? $" · pagas: R$ {NumeroBr.Dinheiro(total)}" : string.Empty)
                  + (TemProxima ? " · PgDn mais antigas" : string.Empty);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Falhou(e);
        }
        finally
        {
            if (versao == _versao)
            {
                Carregando = false;
            }
        }
    }

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

    /// <summary>PgDn: as 50 seguintes (mais antigas), pelo cursor.</summary>
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
        return Atualizacao = LerAsync(proxima);
    }

    /// <summary>PgUp: as 50 anteriores (mais novas).</summary>
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
        return Atualizacao = LerAsync(_inicios[^1]);
    }

    /// <summary>F3 (Shift+F3 volta): o próximo caixa da lista (o aberto, todos, os fechados).</summary>
    [RelayCommand]
    private void ProximoCaixa(string? sentido)
    {
        if (Caixas.Count == 0 || MostrandoDetalhe || Liberacao is not null)
        {
            return;
        }

        var i = CaixaEscolhido is null ? 0 : Caixas.IndexOf(CaixaEscolhido);
        var passo = sentido == "anterior" ? -1 : 1;
        CaixaEscolhido = Caixas[(i + passo + Caixas.Count) % Caixas.Count];
    }

    /// <summary>F4: todas, pagas, canceladas.</summary>
    [RelayCommand]
    private void ProximaSituacao()
    {
        if (!MostrandoDetalhe && Liberacao is null)
        {
            SituacaoIndice = (SituacaoIndice + 1) % Situacoes.Count;
        }
    }

    /// <summary>F5: lê de novo (a mesma página e os mesmos filtros); com o detalhe ou o pedido do supervisor aberto, nada.</summary>
    [RelayCommand]
    private Task Atualizar()
    {
        if (MostrandoDetalhe || Liberacao is not null)
        {
            return Task.CompletedTask;
        }

        Mensagem = null;
        return Atualizacao = LerAsync(_inicios[^1]);
    }

    /// <summary>F6: volta ao caixa aberto, sem texto, todas as situações, operadores, formas e valores.</summary>
    [RelayCommand]
    private Task LimparFiltros()
    {
        if (MostrandoDetalhe || Liberacao is not null)
        {
            return Task.CompletedTask;
        }

        _montandoOpcoes = true;
        try
        {
            CaixaEscolhido = Caixas.FirstOrDefault();
            SituacaoIndice = 0;
            Operador = Operadores.FirstOrDefault();
            Forma = Formas.FirstOrDefault();
            Texto = string.Empty;
            ValorMinimo = string.Empty;
            ValorMaximo = string.Empty;
        }
        finally
        {
            _montandoOpcoes = false;
        }

        Mensagem = null;
        FocoSolicitado?.Invoke(this, AlvoFocoVendas.Filtro);
        return Atualizacao = RecarregarAsync();
    }

    /// <summary>Enter (ou o duplo clique): o detalhe da venda escolhida, com o caixa dela.</summary>
    [RelayCommand]
    private Task Detalhar(LinhaVendaCentralViewModel? linha) => Tentar(async () =>
    {
        if (Liberacao is not null)
        {
            // O pedido do supervisor está na tela: o Enter é dele (nada abre nem fecha por baixo).
            return;
        }

        if (MostrandoDetalhe)
        {
            FecharDetalhe();
            return;
        }

        var pedida = linha ?? Escolhida();
        ExigirAlcance(pedida);
        Selecionada = pedida;
        var venda = await Task.Run(() => _shell.Servico<ServicoVenda>().ObterVendaAsync(pedida.Venda.Id));
        // A lista pode ter sido relida enquanto a venda carregava: o detalhe só abre se ela continua na lista.
        if (MostrandoDetalhe || Linhas.FirstOrDefault(l => l.Venda.Id == pedida.Venda.Id) is not { } atual)
        {
            return;
        }

        linha = atual;
        Selecionada = linha;
        _linhaDetalhe = linha;
        TituloDetalhe = $"Venda {linha.Numero}" + (linha.Selo.Length > 0 ? $" · {linha.Selo}" : string.Empty);
        LinhasDetalhe.Clear();
        LinhasDetalhe.Add($"Operador: {linha.Operador}");
        if (venda.SessaoCaixaId is { } s && _caixas.GetValueOrDefault(s) is { } caixa)
        {
            LinhasDetalhe.Add($"Caixa {caixa.NumeroCaixa:00} · aberto em {Hora(caixa.AbertaEm)} por {Nome(caixa.OperadorId)} · "
                              + (caixa.FechadaEm is { } f ? $"fechado em {Hora(f)}" : "ainda aberto"));
        }

        foreach (var l in TextoDetalheVenda.Linhas(venda, _fuso))
        {
            LinhasDetalhe.Add(l);
        }

        if (linha.Venda.CanceladaDepois)
        {
            LinhasDetalhe.Add("Cancelada depois do fechamento do caixa: o fechamento impresso daquele caixa não mudou.");
        }

        if (linha.Venda.CaixaFechadoEm is not null)
        {
            LinhasDetalhe.Add(MensagemCaixaFechado);
        }

        MostrandoDetalhe = true;
        FocoSolicitado?.Invoke(this, AlvoFocoVendas.Detalhe);
    });

    /// <summary>Ctrl+R (22.2): a 2ª via; sem <c>pdv.documento.reimprimir</c>, o supervisor libera na hora.</summary>
    [RelayCommand]
    private Task Reimprimir() => Tentar(async () =>
    {
        if (Liberacao is not null)
        {
            return;
        }

        var linha = Alvo();
        ExigirAlcance(linha);
        if (!linha.Ativa)
        {
            throw new RegraNegocioException(linha.Cancelada ? ServicoVenda.MensagemReimpressaoCancelada : "Só a venda finalizada tem comprovante.");
        }

        var usuario = _acesso.Usuario ?? throw new RegraNegocioException(AcessoCentral.MensagemFechada);
        if (usuario.Tem(PermissoesPdv.Reimprimir))
        {
            await ReimprimirAsync(linha, null);
            return;
        }

        _linhaLiberacao = linha;
        Liberacao = new PedidoLiberacaoViewModel(
            _shell.Servico<IAutenticadorOperador>(), _shell.Servico<IRelogio>(), usuario, PermissoesPdv.Reimprimir, $"Reimprimir a venda {linha.Venda.NumeroExibicao}",
            async concedida =>
            {
                if (_linhaLiberacao != linha)
                {
                    // O pedido foi fechado (a liberação da Central acabou e a venda saiu da lista) antes do PIN.
                    return;
                }

                FecharLiberacao();
                await Tentar(() => ReimprimirAsync(linha, concedida));
                FocoSolicitado?.Invoke(this, MostrandoDetalhe ? AlvoFocoVendas.Detalhe : AlvoFocoVendas.Filtro);
            },
            erro =>
            {
                FecharLiberacao();
                Erro = erro;
                FocoSolicitado?.Invoke(this, MostrandoDetalhe ? AlvoFocoVendas.Detalhe : AlvoFocoVendas.Filtro);
                return Task.CompletedTask;
            });
    });

    private async Task ReimprimirAsync(LinhaVendaCentralViewModel linha, LiberacaoConcedida? liberacao)
    {
        var usuario = _acesso.Usuario ?? throw new RegraNegocioException(AcessoCentral.MensagemFechada);
        ExigirAlcance(linha);
        // A venda de caixa fechado vista só pelo histórico emprestado (Ctrl+L): quem liberou vai no autorizado_por_id.
        var emprestado = linha.Venda.CaixaFechadoEm is not null ? _acesso.AutorizadoPor(PermissoesPdv.ConsultarHistoricoVendas) : null;
        var (_, avisos) = await _shell.Servico<ServicoVenda>().ReimprimirAsync(linha.Venda.Id, liberacao, usuario, Localizacao, emprestado);
        Mensagem = avisos.Count > 0
            ? string.Join(" ", avisos)
            : $"Venda {linha.Venda.NumeroExibicao} reimpressa (2ª via)" + (liberacao is null ? "." : $", liberada por {liberacao.Supervisor.Nome}.");
    }

    /// <summary>
    /// Ctrl+Del: venda de caixa fechado não se cancela no PDV (D23); a paga do caixa aberto vai ao F12 da venda (o
    /// cancelamento de sempre: o gerente ou o encarregado, a devolução por pagamento, o motivo).
    /// </summary>
    [RelayCommand]
    private Task Cancelar() => Tentar(async () =>
    {
        if (Liberacao is not null)
        {
            return;
        }

        var linha = Alvo();
        if (!linha.Ativa)
        {
            throw new RegraNegocioException(linha.Cancelada
                ? $"A venda {linha.Venda.NumeroExibicao} já está cancelada."
                : "Só a venda finalizada se cancela.");
        }

        if (linha.Venda.CaixaFechadoEm is not null)
        {
            throw new RegraNegocioException(MensagemCaixaFechado);
        }

        if (_cancelarNaVenda is null)
        {
            throw new RegraNegocioException(MensagemCancelarPeloLogin);
        }

        await _cancelarNaVenda(linha.Venda.Id);
    });

    /// <summary>F7 (bloco G6): o caixa da venda (a do detalhe aberto ou a escolhida) na aba 2 Caixas, pelo retrato dele.</summary>
    [RelayCommand]
    private Task VerCaixa() => Tentar(async () =>
    {
        if (Liberacao is not null || _verCaixa is null)
        {
            return;
        }

        var linha = Alvo();
        ExigirAlcance(linha);
        if (linha.Venda.SessaoCaixaId is not { } sessao)
        {
            throw new RegraNegocioException("Esta venda não tem caixa registrado neste terminal.");
        }

        await _verCaixa(sessao);
    });

    /// <summary>Esc: fecha o pedido do supervisor, depois o detalhe, depois volta ao menu da Central.</summary>
    [RelayCommand]
    private Task Voltar()
    {
        if (Liberacao is not null)
        {
            FecharLiberacao();
            FocoSolicitado?.Invoke(this, MostrandoDetalhe ? AlvoFocoVendas.Detalhe : AlvoFocoVendas.Filtro);
            return Task.CompletedTask;
        }

        if (MostrandoDetalhe)
        {
            FecharDetalhe();
            return Task.CompletedTask;
        }

        return _voltar();
    }

    private void FecharDetalhe()
    {
        MostrandoDetalhe = false;
        _linhaDetalhe = null;
        TituloDetalhe = string.Empty;
        LinhasDetalhe.Clear();
        FocoSolicitado?.Invoke(this, AlvoFocoVendas.Filtro);
    }

    private void FecharLiberacao()
    {
        Liberacao = null;
        _linhaLiberacao = null;
    }

    /// <summary>
    /// Fecha o detalhe e o pedido do supervisor cuja venda não passa em <paramref name="continua"/> (saiu da lista ou do
    /// alcance da pessoa): nada fica na tela, nem age, sobre a venda que ela não vê mais.
    /// </summary>
    private void FecharForaDoAlcance(Func<LinhaVendaCentralViewModel, bool> continua)
    {
        if (_linhaLiberacao is { } pedida && !continua(pedida))
        {
            FecharLiberacao();
        }

        if (_linhaDetalhe is { } aberta && !continua(aberta))
        {
            FecharDetalhe();
        }
    }

    /// <summary>
    /// A venda de caixa fechado só se abre ou reimprime com o histórico valendo agora: a liberação pode ter acabado depois
    /// da última conferência do relógio (1 s) e antes da tecla. A lista é refeita na hora (volta ao caixa aberto).
    /// </summary>
    private void ExigirAlcance(LinhaVendaCentralViewModel linha)
    {
        if (linha.Venda.CaixaFechadoEm is not null && !Historico)
        {
            ConferirPermissoes();
            throw new RegraNegocioException(MensagemHistoricoAcabou);
        }
    }

    private LinhaVendaCentralViewModel Escolhida() =>
        Selecionada ?? throw new RegraNegocioException(Linhas.Count == 0 ? "Nenhuma venda na lista." : "Escolha uma venda (setas ↑/↓ ou clique).");

    /// <summary>A venda das ações (Ctrl+R, Ctrl+Del): a do detalhe aberto ou, na lista, a escolhida.</summary>
    private LinhaVendaCentralViewModel Alvo() => MostrandoDetalhe && _linhaDetalhe is { } aberta ? aberta : Escolhida();

    /// <summary>Os nomes dos operadores ainda não conhecidos, lidos fora da thread da tela.</summary>
    private async Task<List<(Guid Id, string Nome)>> NomesAsync(IEnumerable<Guid> ids, HashSet<Guid> conhecidos)
    {
        var nomes = new List<(Guid, string)>();
        foreach (var id in ids.Distinct().Where(id => !conhecidos.Contains(id)))
        {
            nomes.Add((id, await _servico.NomeUsuarioAsync(id)));
        }

        return nomes;
    }

    private async Task Tentar(Func<Task> acao)
    {
        try
        {
            Erro = null;
            await acao();
        }
        catch (RegraNegocioException e)
        {
            Erro = e.Message;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Falhou(e);
        }
    }

    private void Falhou(Exception e)
    {
        // Nada aqui derruba o caixa: a falha vai para o log e para a tela (mascarada).
        _shell.Servico<ILogger<AbaVendasViewModel>>().LogError(e, "Falha na aba Vendas da Central");
        Erro = $"Não deu certo ({MascaradorSuporte.Mascarar(e.Message)}). F5 tenta de novo.";
    }

    private bool TentarValor(string texto, string rotulo, out decimal? valor)
    {
        valor = null;
        if (string.IsNullOrWhiteSpace(texto))
        {
            return true;
        }

        if (NumeroBr.TentarLer(texto, out var v) && v >= 0)
        {
            valor = v;
            return true;
        }

        Erro = $"{rotulo} inválido: use o valor em reais (por exemplo 12,90).";
        return false;
    }

    private static void Trocar(ObservableCollection<OpcaoFiltroVenda> lista, IReadOnlyList<OpcaoFiltroVenda> novas)
    {
        lista.Clear();
        foreach (var n in novas)
        {
            lista.Add(n);
        }
    }

    private string Nome(Guid usuarioId) => _nomes.GetValueOrDefault(usuarioId, "outro operador");

    private string Hora(DateTimeOffset quando) => TimeZoneInfo.ConvertTime(quando, _fuso).ToString("dd/MM HH:mm", NumeroBr.Cultura);

    private static string Vendas(int n) => n == 1 ? "1 venda" : $"{n} vendas";
}
