using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Repositorios;

namespace GenesisPDV.App.ViewModels;

/// <summary>Uma linha da gestão de vendas (PDV 22.1): número, hora, total, formas e a situação.</summary>
public sealed class LinhaVendaSessaoViewModel(VendaDaSessao venda, TimeZoneInfo fuso)
{
    public VendaDaSessao Venda { get; } = venda;

    /// <summary>O número do caixa e, quando a nuvem renumerou a venda ("Aplicar com novo número", T27), o novo.</summary>
    public string Numero => Venda.NumeroNuvem is { } novo ? $"{Venda.NumeroExibicao} → {novo}" : Venda.NumeroExibicao;

    public string Hora => TimeZoneInfo.ConvertTime(Venda.Hora, fuso).ToString("HH:mm", NumeroBr.Cultura);

    public string Total => NumeroBr.Dinheiro(Venda.Total);

    public string Formas => Venda.Finalizada ? Venda.Formas : "(em andamento)";

    public bool Cancelada => Venda.Status == StatusVenda.Cancelada;

    public string Situacao => Cancelada ? $"CANCELADA: {Venda.MotivoCancelamento}" : string.Empty;

    /// <summary>Só a venda paga e não cancelada se cancela ou se reimprime (13.3, 22.2).</summary>
    public bool Ativa => Venda.Finalizada && !Cancelada;
}

/// <summary>
/// F12 Gestão de vendas (PDV 22.1; Fase 1C, bloco C11b): as vendas encerradas da sessão de caixa aberta, da mais nova à
/// mais antiga, com o filtro por número ou CPF/CNPJ. ↑/↓ escolhem, Enter mostra os detalhes, Ctrl+R reimprime (22.2) e
/// Ctrl+Del cancela a venda paga (13.3: o gerente ou o encarregado, O6 e a resposta do dono de 05/11/2026; os demais pedem
/// a liberação de um deles). F3 leva às vendas
/// dos caixas anteriores, na Central › 1 Vendas (bloco G5). Esc fecha.
/// </summary>
public sealed partial class DialogoGestaoVendasViewModel(VendaViewModel venda) : DialogoViewModel(venda)
{
    private readonly TimeZoneInfo _fuso = venda.ServicoCaixa.DiaOperacionalAtual().Fuso;

    public override string Titulo => "Gestão de vendas · sessão atual";

    public ObservableCollection<LinhaVendaSessaoViewModel> Linhas { get; } = [];

    [ObservableProperty]
    public partial LinhaVendaSessaoViewModel? Selecionada { get; set; }

    [ObservableProperty]
    public partial string Filtro { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string? Aviso { get; set; }

    /// <summary>A releitura pedida pela última mudança do filtro (os testes a aguardam).</summary>
    public Task Atualizacao { get; private set; } = Task.CompletedTask;

    partial void OnFiltroChanged(string value) => Atualizacao = AtualizarAsync();

    public async Task AtualizarAsync(Guid? selecionar = null)
    {
        var vendas = await Venda.ServicoVenda.VendasDaSessaoAsync(Filtro);
        Linhas.Clear();
        foreach (var v in vendas)
        {
            Linhas.Add(new LinhaVendaSessaoViewModel(v, _fuso));
        }

        Selecionada = Linhas.FirstOrDefault(l => l.Venda.Id == selecionar) ?? Linhas.FirstOrDefault();
    }

    [RelayCommand]
    private void Mover(string direcao)
    {
        if (Linhas.Count == 0)
        {
            return;
        }

        var i = Selecionada is null ? -1 : Linhas.IndexOf(Selecionada);
        Selecionada = Linhas[direcao == "acima" ? Math.Max(0, i - 1) : Math.Min(Linhas.Count - 1, i + 1)];
    }

    /// <summary>Enter: os detalhes da venda (itens, pagamentos e o cancelamento).</summary>
    protected override async Task AoConfirmarAsync()
    {
        var linha = Escolhida();
        var detalhe = new DialogoDetalheVendaViewModel(Venda, this, await Venda.ServicoVenda.ObterVendaAsync(linha.Venda.Id), _fuso);
        Venda.AbrirDialogo(detalhe);
    }

    /// <summary>Ctrl+R (22.2): reimprime o comprovante; sem <c>pdv.documento.reimprimir</c>, a liberação do supervisor.</summary>
    [RelayCommand]
    private Task Reimprimir() => Tentar(async () =>
    {
        var linha = Escolhida();
        if (!linha.Ativa)
        {
            throw new RegraNegocioException(linha.Cancelada ? ServicoVenda.MensagemReimpressaoCancelada : "Só a venda finalizada tem comprovante.");
        }

        var operador = Venda.Sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");
        if (operador.Tem(PermissoesPdv.Reimprimir))
        {
            await ReimprimirAsync(linha, null);
            return;
        }

        Venda.PedirLiberacao(PermissoesPdv.Reimprimir, $"Reimprimir a venda {linha.Venda.NumeroExibicao}", concedida => ReimprimirAsync(linha, concedida));
    });

    private async Task ReimprimirAsync(LinhaVendaSessaoViewModel linha, LiberacaoConcedida? liberacao)
    {
        var (texto, avisos) = await Venda.ServicoVenda.ReimprimirAsync(linha.Venda.Id, liberacao);
        Venda.MostrarCupom(texto);
        await VoltarComAvisoAsync(linha.Venda.Id, avisos.Count > 0 ? string.Join(" ", avisos) : $"Venda {linha.Venda.NumeroExibicao} reimpressa (2ª via).");
    }

    /// <summary>Ctrl+Del (13.3): abre o cancelamento da venda paga da sessão.</summary>
    [RelayCommand]
    private Task CancelarSelecionada() => Tentar(async () =>
    {
        var linha = Escolhida();
        if (!linha.Ativa)
        {
            throw new RegraNegocioException(linha.Cancelada
                ? $"A venda {linha.Venda.NumeroExibicao} já está cancelada."
                : "Só a venda finalizada é cancelada pela gestão de vendas.");
        }

        var preparado = await Venda.ServicoVenda.PrepararCancelamentoAsync(linha.Venda.Id);
        Venda.AbrirDialogo(new DialogoCancelarVendaFinalizadaViewModel(Venda, this, preparado));
    });

    /// <summary>
    /// F3: as vendas dos caixas anteriores (fechados nos últimos 30 dias), na Central › 1 Vendas (bloco G5). Exige o
    /// caixa livre, como o ⚙.
    /// </summary>
    [RelayCommand]
    private Task CaixasAnteriores() => Tentar(() => Venda.AbrirVendasNaCentralAsync());

    /// <summary>Volta à lista (depois da reimpressão ou do cancelamento), relida, com o aviso.</summary>
    public async Task VoltarComAvisoAsync(Guid vendaId, string aviso)
    {
        await AtualizarAsync(vendaId);
        Aviso = aviso;
        Erro = null;
        Venda.AbrirDialogo(this);
    }

    private LinhaVendaSessaoViewModel Escolhida() =>
        Selecionada ?? throw new RegraNegocioException(Linhas.Count == 0 ? "Nenhuma venda nesta sessão." : "Selecione uma venda (setas ↑/↓).");

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
    }
}

/// <summary>
/// As linhas do detalhe de uma venda (itens, pagamentos, liberações e o cancelamento), as mesmas no F12 (Enter na gestão de
/// vendas, 22.1) e na aba Vendas da Central (bloco G5). O CPF/CNPJ da nota aparece inteiro aqui (a lista o mascara).
/// </summary>
public static class TextoDetalheVenda
{
    /// <param name="documento">
    /// Como o CPF/CNPJ da nota aparece (nulo = inteiro, como no F12 e na aba Vendas; a aba 4 Sincronização o mascara: é
    /// diagnóstico, e o documento não ajuda a resolver o envio).
    /// </param>
    public static List<string> Linhas(Venda v, TimeZoneInfo fuso, Func<string, string>? documento = null)
    {
        string Hora(DateTimeOffset h) => TimeZoneInfo.ConvertTime(h, fuso).ToString("dd/MM HH:mm", NumeroBr.Cultura);
        var linhas = new List<string>();
        if (v.FinalizadaEm is { } f)
        {
            linhas.Add($"Finalizada em {Hora(f)}" + (v.CpfCnpjNota is { } doc ? $" · {(doc.Length == 11 ? "CPF" : "CNPJ")} {documento?.Invoke(doc) ?? doc}" : string.Empty));
        }

        foreach (var i in v.Itens)
        {
            linhas.Add($"{i.Sequencia,3} {i.Descricao,-30} {NumeroBr.Quantidade(i.Quantidade),9} {(i.Cancelado ? "CANCELADO" : NumeroBr.Dinheiro(i.ValorBruto)),10}");
        }

        linhas.Add($"Total R$ {NumeroBr.Dinheiro(v.Total)}");
        foreach (var p in v.Pagamentos.Where(p => p.Status is StatusPagamento.Aprovado or StatusPagamento.Estornado))
        {
            linhas.Add($"  {p.DescricaoForma}: R$ {NumeroBr.Dinheiro(p.Valor)}" + (p.Status == StatusPagamento.Estornado ? " (estornado)" : string.Empty));
        }

        if (v.Liberacoes.Count > 0)
        {
            linhas.Add($"Liberações do supervisor: {v.Liberacoes.Count}");
        }

        if (v.CanceladaEm is { } c)
        {
            linhas.Add($"Cancelada em {Hora(c)}: {v.MotivoCancelamento}");
        }

        return linhas;
    }
}

/// <summary>Detalhes da venda (Enter na gestão de vendas, 22.1): itens, pagamentos, liberações e o cancelamento. Esc volta.</summary>
public sealed class DialogoDetalheVendaViewModel(VendaViewModel venda, DialogoGestaoVendasViewModel lista, Venda detalhe, TimeZoneInfo fuso)
    : DialogoViewModel(venda)
{
    public override string Titulo => $"Venda {detalhe.NumeroExibicao}" + (detalhe.Status == StatusVenda.Cancelada ? " · CANCELADA" : string.Empty);

    public IReadOnlyList<string> Linhas { get; } = TextoDetalheVenda.Linhas(detalhe, fuso);

    protected override Task AoConfirmarAsync() => AoCancelarAsync();

    protected override Task AoCancelarAsync()
    {
        Venda.AbrirDialogo(lista);
        return Task.CompletedTask;
    }
}

/// <summary>Um pagamento no cancelamento (13.3) e como ele volta ao cliente (O22 do dono: F3 alterna).</summary>
public sealed partial class LinhaEstornoViewModel(PagamentoACancelar pagamento) : ObservableObject
{
    public PagamentoACancelar Pagamento { get; } = pagamento;

    public string Forma => $"{Pagamento.Pagamento.Sequencia}. {Pagamento.Pagamento.DescricaoForma}";

    public string Valor => NumeroBr.Dinheiro(Pagamento.Pagamento.Valor);

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Escolhida), nameof(Descricao))]
    public partial int Opcao { get; set; }

    [ObservableProperty]
    public partial bool Selecionada { get; set; }

    public OpcaoEstorno Escolhida => Pagamento.Opcoes[Opcao];

    public string Descricao => Escolhida.Descricao + (Pagamento.Opcoes.Count > 1 ? "  [F3]" : string.Empty);

    public void Alternar() => Opcao = (Opcao + 1) % Pagamento.Opcoes.Count;
}

/// <summary>
/// Cancelamento da venda paga (Ctrl+Del na gestão de vendas ou F11 › 5; PDV 13.3; Fase 1C, C11b): cada pagamento com a
/// devolução escolhida (O22 do dono — F2 passa ao próximo pagamento, F3 alterna entre o estorno no meio original e o
/// dinheiro), os cascos vazios a devolver (D29) e o motivo em texto livre de 15 a 255 caracteres (O6). Enter cancela:
/// quem não tem <c>pdv.venda.cancelar_venda_finalizada</c> (no seed, só o gerente e o encarregado) pede a liberação de um deles. Esc volta à
/// lista sem gravar nada.
/// </summary>
public sealed partial class DialogoCancelarVendaFinalizadaViewModel : DialogoViewModel
{
    private readonly DialogoGestaoVendasViewModel _lista;
    private readonly CancelamentoPreparado _preparado;

    public DialogoCancelarVendaFinalizadaViewModel(VendaViewModel venda, DialogoGestaoVendasViewModel lista, CancelamentoPreparado preparado)
        : base(venda)
    {
        _lista = lista;
        _preparado = preparado;
        Pagamentos = [.. preparado.Pagamentos.Select(p => new LinhaEstornoViewModel(p))];
        foreach (var p in Pagamentos)
        {
            p.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName == nameof(LinhaEstornoViewModel.Opcao))
                {
                    OnPropertyChanged(nameof(DinheiroADevolver));
                }
            };
        }

        if (Pagamentos.Count > 0)
        {
            Pagamentos[0].Selecionada = true;
        }

        Vazios = [.. preparado.Vazios.Select(v => $"Devolva ao cliente {v.Quantidade:0.###} casco(s) de {v.Descricao}.")];
    }

    public override string Titulo =>
        $"Cancelar a venda paga {_preparado.Venda.NumeroExibicao} (R$ {NumeroBr.Dinheiro(_preparado.Venda.Total)})";

    public ObservableCollection<LinhaEstornoViewModel> Pagamentos { get; }

    /// <summary>"Devolva ao cliente N cascos de …" (D29, <c>pdv.cancelamento_devolve_vazios</c>); vazio com a chave desligada.</summary>
    public IReadOnlyList<string> Vazios { get; }

    public bool TemVazios => Vazios.Count > 0;

    /// <summary>Quanto sai da gaveta com as escolhas atuais (entra no esperado do fechamento, 20.4).</summary>
    public string DinheiroADevolver =>
        $"Sai da gaveta: R$ {NumeroBr.Dinheiro(Pagamentos.Where(p => EstornoPagamento.SaiDaGaveta(p.Escolhida.Estorno)).Sum(p => p.Pagamento.Pagamento.Valor))}";

    [ObservableProperty]
    public partial string Motivo { get; set; } = string.Empty;

    /// <summary>F2: o próximo pagamento (o F3 alterna o selecionado).</summary>
    [RelayCommand]
    private void ProximoPagamento()
    {
        if (Pagamentos.Count == 0)
        {
            return;
        }

        var i = Pagamentos.ToList().FindIndex(p => p.Selecionada);
        foreach (var p in Pagamentos)
        {
            p.Selecionada = false;
        }

        Pagamentos[(i + 1) % Pagamentos.Count].Selecionada = true;
    }

    /// <summary>F3: alterna a devolução do pagamento selecionado (O22).</summary>
    [RelayCommand]
    private void AlternarEstorno() => Pagamentos.FirstOrDefault(p => p.Selecionada)?.Alternar();

    /// <summary>As escolhas da tela, por pagamento.</summary>
    public IReadOnlyDictionary<Guid, string> Escolhas => Pagamentos.ToDictionary(p => p.Pagamento.Pagamento.Id, p => p.Escolhida.Estorno);

    protected override async Task AoConfirmarAsync()
    {
        var motivo = Core.Vendas.Venda.ValidarMotivoCancelamento(Motivo);
        var operador = Venda.Sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");
        var venda = _preparado.Venda;
        if (operador.Tem(PermissoesPdv.CancelarVendaFinalizada))
        {
            await CancelarAsync(motivo, null);
            return;
        }

        Venda.PedirLiberacao(PermissoesPdv.CancelarVendaFinalizada, $"Cancelar a venda paga {venda.NumeroExibicao} (R$ {NumeroBr.Dinheiro(venda.Total)})",
            concedida => CancelarAsync(motivo, concedida));
    }

    private async Task CancelarAsync(string motivo, LiberacaoConcedida? liberacao)
    {
        var resultado = await Venda.ServicoVenda.CancelarFinalizadaAsync(_preparado.Venda.Id, motivo, Escolhas, liberacao);
        Venda.VendaFinalizadaCancelada(resultado);
        var texto = $"Venda {resultado.Venda.NumeroExibicao} cancelada" + (liberacao is null ? "." : $" com liberação de {liberacao.Supervisor.Nome}.");
        await _lista.VoltarComAvisoAsync(resultado.Venda.Id, string.Join(" ", [texto, .. resultado.Instrucoes, .. resultado.Avisos]));
    }

    protected override Task AoCancelarAsync()
    {
        Venda.AbrirDialogo(_lista);
        return Task.CompletedTask;
    }
}

/// <summary>
/// Motivo do cancelamento da venda em andamento (Shift+F4, PDV 13.2): texto livre de 15 a 255 caracteres (O6 do dono, o
/// mesmo da venda paga). Enter cancela; Esc volta à venda.
/// </summary>
public sealed partial class DialogoMotivoCancelamentoViewModel(VendaViewModel venda, string titulo, Func<string, Task> aoConfirmar)
    : DialogoViewModel(venda)
{
    public override string Titulo => titulo;

    public string Regra => $"Motivo (de {Core.Vendas.Venda.MotivoCancelamentoMinimo} a {Core.Vendas.Venda.MotivoCancelamentoMaximo} caracteres)";

    [ObservableProperty]
    public partial string Motivo { get; set; } = string.Empty;

    protected override Task AoConfirmarAsync() => aoConfirmar(Core.Vendas.Venda.ValidarMotivoCancelamento(Motivo));
}
