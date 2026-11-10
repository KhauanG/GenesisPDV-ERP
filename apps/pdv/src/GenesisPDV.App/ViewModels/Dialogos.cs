using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Sync.Cliente;

namespace GenesisPDV.App.ViewModels;

/// <summary>Diálogo sobreposto à tela de venda. Enter confirma, Esc volta, sempre (PDV 32.8).</summary>
public abstract partial class DialogoViewModel(VendaViewModel venda) : ViewModelBase
{
    protected VendaViewModel Venda { get; } = venda;

    public abstract string Titulo { get; }

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [RelayCommand]
    private Task ConfirmarAsync() => Executar(AoConfirmarAsync);

    /// <summary>Executa a ação do diálogo: a regra recusada vira o <see cref="Erro"/> (o diálogo fica aberto).</summary>
    protected async Task Executar(Func<Task> acao)
    {
        ArgumentNullException.ThrowIfNull(acao);
        try
        {
            Erro = null;
            await acao();
        }
        catch (EstoqueInsuficienteException e)
        {
            // PDV 29.1 com o bloqueio ligado: o supervisor pode liberar o produto (a inclusão é refeita pelo operador).
            Venda.PedirLiberacaoEstoque(e);
        }
        catch (ReducaoExigeLiberacaoException e)
        {
            // Diminuir a quantidade sem poder cancelar item: o supervisor libera o cancelamento parcial (PDV 13.1).
            Venda.PedirLiberacaoReducao(e);
        }
        catch (RegraNegocioException e)
        {
            Erro = e.Message;
        }
    }

    [RelayCommand]
    private async Task CancelarAsync() => await AoCancelarAsync();

    protected abstract Task AoConfirmarAsync();

    protected virtual Task AoCancelarAsync()
    {
        Venda.FecharDialogo();
        return Task.CompletedTask;
    }

    protected static decimal LerNumero(string texto, string mensagem) =>
        NumeroBr.TentarLer(texto, out var valor) ? valor : throw new RegraNegocioException(mensagem);
}

/// <summary>F3: altera a quantidade do item selecionado ou fixa o multiplicador da próxima leitura.</summary>
public sealed partial class DialogoQuantidadeViewModel(VendaViewModel venda, ItemLinhaViewModel? item) : DialogoViewModel(venda)
{
    public override string Titulo => item is null ? "Quantidade para o próximo item" : $"Quantidade do item {item.Sequencia} — {item.Descricao}";

    [ObservableProperty]
    public partial string Valor { get; set; } = item is null ? "1" : NumeroBr.Quantidade(item.Item.Quantidade);

    protected override async Task AoConfirmarAsync()
    {
        var qtd = LerNumero(Valor, "Informe a quantidade, por exemplo 3 ou 0,750.");
        if (item is null)
        {
            Venda.DefinirMultiplicador(qtd);
            Venda.FecharDialogo();
            return;
        }

        // Sem o diálogo dos cascos trazidos (o item cheio retornável pergunta de novo, 10.12), volta ao campo de código.
        if (!await Venda.AlterarQuantidadeAsync(item.Item, qtd))
        {
            Venda.FecharDialogo(item.Sequencia);
        }
    }
}

/// <summary>
/// F4 Remover item (PDV 13.1): sequência pré-preenchida com o item selecionado; quantidade vazia = tudo. Com a
/// <paramref name="liberacao"/> do supervisor (sem <c>pdv.venda.cancelar_item</c>), ela vai no item e na auditoria, e a
/// sequência fica travada no item que o supervisor viu no pedido (só a quantidade a cancelar muda).
/// </summary>
public sealed partial class DialogoRemoverItemViewModel(VendaViewModel venda, int? sequencia, LiberacaoConcedida? liberacao = null) : DialogoViewModel(venda)
{
    public override string Titulo => liberacao is null ? "Cancelar item" : $"Cancelar item {sequencia} (liberado por {liberacao.Supervisor.Nome})";

    /// <summary>Com a liberação, a sequência é a do item liberado (o campo fica só leitura e o foco vai à quantidade).</summary>
    public bool SequenciaTravada => liberacao is not null;

    [ObservableProperty]
    public partial string Sequencia { get; set; } = sequencia?.ToString(NumeroBr.Cultura) ?? string.Empty;

    [ObservableProperty]
    public partial string Quantidade { get; set; } = string.Empty;

    protected override async Task AoConfirmarAsync()
    {
        int seq;
        if (liberacao is not null)
        {
            seq = sequencia ?? throw new RegraNegocioException("Informe o número do item.");
        }
        else if (!int.TryParse(Sequencia, out seq))
        {
            throw new RegraNegocioException("Informe o número do item.");
        }

        decimal? qtd = string.IsNullOrWhiteSpace(Quantidade) ? null : LerNumero(Quantidade, "Quantidade a cancelar inválida.");
        var restante = await Venda.ServicoVenda.CancelarItemAsync(seq, qtd, liberacao);
        Venda.FecharDialogo(mensagem: liberacao is null ? $"Item {seq} cancelado." : $"Item {seq} cancelado com liberação de {liberacao.Supervisor.Nome}.");
        Venda.AbrirCascosSeNecessario(restante);
    }
}

/// <summary>
/// F6 Desconto: 1 = no item selecionado, 2 = no total, 4 = remover desconto do total (PDV 12.2), 5 = remover o desconto
/// do item selecionado.
/// </summary>
public sealed partial class DialogoMenuDescontoViewModel(VendaViewModel venda, ItemLinhaViewModel? item) : DialogoViewModel(venda)
{
    public override string Titulo => "Desconto";

    public bool TemItem => item is { Cancelado: false };

    public string OpcaoItem => item is null ? "1  Desconto no item (selecione um item)" : $"1  Desconto no item {item.Sequencia} — {item.Descricao}";

    public bool TemDescontoItem => item is { Cancelado: false, Item.DescontoItem: > 0m };

    public string OpcaoRemoverItem => item is null ? string.Empty : $"5  Remover o desconto do item {item.Sequencia}";

    protected override Task AoConfirmarAsync() => Escolher(item is null ? "2" : "1");

    [RelayCommand]
    private async Task Escolher(string opcao)
    {
        switch (opcao)
        {
            case "1" when item is { Cancelado: false }:
                Venda.AbrirDialogo(new DialogoValorDescontoViewModel(Venda, item));
                break;
            case "1":
                Erro = "Selecione um item não cancelado (setas ↑/↓).";
                break;
            case "2":
                Venda.AbrirDialogo(new DialogoValorDescontoViewModel(Venda, null));
                break;
            case "4":
                await Venda.RemoverDescontoTotalAsync();
                break;
            case "5" when TemDescontoItem:
                await Venda.RemoverDescontoItemAsync(item!.Sequencia);
                break;
            case "5":
                Erro = "Selecione um item com desconto (setas ↑/↓).";
                break;
        }
    }
}

/// <summary>
/// F6 › 1/2: o valor do desconto. Enter lê o texto ("10%" ou "2,50"); os botões "Aplicar em R$" e "Aplicar em %" fixam o
/// tipo, para o caixa só com teclado numérico, que não tem a tecla % (decisão 65).
/// </summary>
public sealed partial class DialogoValorDescontoViewModel(VendaViewModel venda, ItemLinhaViewModel? item) : DialogoViewModel(venda)
{
    public override string Titulo => item is null ? "Desconto no total" : $"Desconto no item {item.Sequencia} — {item.Descricao}";

    public string Dica => "Digite em R$ (2,50) ou em % (10%), ou digite só o número e clique em \"Aplicar em R$\" ou \"Aplicar em %\".";

    [ObservableProperty]
    public partial string Valor { get; set; } = string.Empty;

    /// <summary>PDV 12.3, 31.3: acima do limite do operador, o supervisor libera (<see cref="VendaViewModel.AplicarDescontoAsync"/>).</summary>
    protected override Task AoConfirmarAsync() => Aplicar(null);

    [RelayCommand]
    private Task AplicarReais() => Executar(() => Aplicar(TipoDesconto.Valor));

    [RelayCommand]
    private Task AplicarPercentual() => Executar(() => Aplicar(TipoDesconto.Percentual));

    private Task Aplicar(TipoDesconto? tipo) =>
        Venda.AplicarDescontoAsync(item?.Sequencia, Desconto.Ler(Valor, tipo), mensagem => Venda.FecharDialogo(item?.Sequencia, mensagem));
}

/// <summary>Liberação do supervisor sobre a venda (PDV 31.3): login/código, PIN e motivo; Enter libera, Esc desiste.</summary>
public sealed class DialogoLiberacaoViewModel(VendaViewModel venda, PedidoLiberacaoViewModel pedido) : DialogoViewModel(venda)
{
    public PedidoLiberacaoViewModel Pedido => pedido;

    public override string Titulo => pedido.Titulo;

    protected override Task AoConfirmarAsync() => pedido.ConfirmarCommand.ExecuteAsync(null);

    protected override Task AoCancelarAsync() => pedido.CancelarCommand.ExecuteAsync(null);
}

/// <summary>Pesquisa de produto (F2, PDV 10.3): busca incremental; ↑/↓ navegam, Enter inclui.</summary>
public sealed partial class DialogoPesquisaViewModel : DialogoViewModel
{
    public DialogoPesquisaViewModel(VendaViewModel venda, string filtroInicial)
        : base(venda)
    {
        Filtro = filtroInicial;
    }

    public override string Titulo => SoNumeros ? "Pesquisar produto (só números)" : "Pesquisar produto";

    /// <summary>A pesquisa só por números do terminal (decisão 65): só dígitos, nos códigos do produto.</summary>
    public bool SoNumeros => Venda.PesquisaSoNumeros;

    public string Dica => SoNumeros
        ? "Só números: código interno, EAN ou código adicional — primeiro o exato, depois os que começam e os que contêm."
        : "Nome (todas as palavras, sem acento) ou código.";

    public ObservableCollection<ProdutoPesquisado> Resultados { get; } = [];

    [ObservableProperty]
    public partial string Filtro { get; set; }

    [ObservableProperty]
    public partial ProdutoPesquisado? Selecionado { get; set; }

    partial void OnFiltroChanged(string value) => _ = AtualizarAsync(value);

    public async Task AtualizarAsync(string filtro)
    {
        IReadOnlyList<ProdutoPesquisado> lista;
        try
        {
            lista = await Venda.ServicoVenda.PesquisarAsync(filtro ?? string.Empty, SoNumeros);
            Erro = SoNumeros && lista.Count == 0 && !string.IsNullOrWhiteSpace(filtro)
                ? $"Nenhum produto com os números {filtro.Trim()}: confira e corrija, ou Esc volta."
                : null;
        }
        catch (RegraNegocioException e)
        {
            // Só números: a letra é recusada (a lista fica vazia até o filtro voltar a ter só dígitos).
            lista = [];
            Erro = e.Message;
        }

        Resultados.Clear();
        foreach (var p in lista)
        {
            Resultados.Add(p);
        }

        Selecionado = Resultados.FirstOrDefault();
    }

    [RelayCommand]
    private void Mover(string direcao)
    {
        if (Resultados.Count == 0)
        {
            return;
        }

        var i = Selecionado is null ? -1 : Resultados.IndexOf(Selecionado);
        i = direcao == "acima" ? Math.Max(0, i - 1) : Math.Min(Resultados.Count - 1, i + 1);
        Selecionado = Resultados[i];
    }

    protected override async Task AoConfirmarAsync()
    {
        var produto = Selecionado ?? throw new RegraNegocioException("Nenhum produto selecionado.");
        await Venda.IncluirDaPesquisaAsync(produto);
    }

    /// <summary>
    /// F4 "Outras lojas" (Fase 2, F2-B35; PDV 10.3): o saldo online do produto selecionado nas outras lojas e no CD. Esc
    /// no diálogo dos saldos volta a esta pesquisa, com o filtro e a seleção.
    /// </summary>
    [RelayCommand]
    private Task OutrasLojasAsync()
    {
        if (Selecionado is not { } linha)
        {
            Erro = "Nenhum produto selecionado.";
            return Task.CompletedTask;
        }

        Erro = null;
        return Venda.AbrirOutrasLojasAsync(this, linha.Produto);
    }
}

/// <summary>Uma linha do F4 "Outras lojas": o local e a quantidade já formatada na unidade do produto.</summary>
/// <param name="DestaLoja">O estoque da loja do próprio caixa (a quantidade online dela).</param>
public sealed record LinhaOutraLoja(string Local, string Quantidade, bool DestaLoja);

/// <summary>
/// F4 "Outras lojas" da pesquisa (Fase 2, F2-B35; F2-Q12 = D53; PDV 10.3): consulta online (até 3 s) do saldo vendável
/// do produto nas lojas reais e no CD, só quantidades. Enquanto consulta, "Consultando…"; offline, sem resposta, API
/// antiga ou a chave <c>pdv.consulta_outras_lojas</c> desligada, o aviso no lugar da lista. A venda nunca espera: Esc ou
/// Enter voltam à pesquisa na hora (a consulta em andamento é cancelada).
/// </summary>
public sealed partial class DialogoOutrasLojasViewModel : DialogoViewModel
{
    public const string NotaOnline = "Quantidade vendável na nuvem agora; vendas ainda não sincronizadas dos caixas não entram.";

    public const string NotaSemControle = "Este produto não controla estoque: as lojas não têm saldo dele.";

    private readonly DialogoPesquisaViewModel _pesquisa;
    private readonly ProdutoVenda _produto;
    private readonly CancellationTokenSource _cancelar = new();

    public DialogoOutrasLojasViewModel(VendaViewModel venda, DialogoPesquisaViewModel pesquisa, ProdutoVenda produto)
        : base(venda)
    {
        _pesquisa = pesquisa;
        _produto = produto;
        Consultando = true;
    }

    public override string Titulo => $"Estoque nas outras lojas — {_produto.Descricao}";

    public ObservableCollection<LinhaOutraLoja> Locais { get; } = [];

    [ObservableProperty]
    public partial bool Consultando { get; set; }

    /// <summary>Por que não há lista (offline, desligada, recusa); nulo com a lista.</summary>
    [ObservableProperty]
    public partial string? Aviso { get; set; }

    [ObservableProperty]
    public partial string? Nota { get; set; }

    public async Task ConsultarAsync()
    {
        var ct = _cancelar.Token;
        try
        {
            if (!await Venda.ServicoVenda.ConsultaOutrasLojasLigadaAsync(ct))
            {
                Aviso = MensagensConsultaOutrasLojas.Desligada;
                return;
            }

            var r = await Venda.Servico<IConsultaOutrasLojas>().ConsultarAsync(_produto.Id, ct);
            if (r.Saldos is not { } saldos)
            {
                Aviso = r.Aviso ?? MensagensConsultaOutrasLojas.RequerConexao;
                return;
            }

            foreach (var local in saldos.Locais)
            {
                var quantidade = local.QuantidadeNumero;
                var nome = local.LojaDoTerminal ? $"{local.Nome} (esta loja)" : local.Nome;
                Locais.Add(new LinhaOutraLoja(nome, $"{quantidade.ToString("#,##0.###", NumeroBr.Cultura)} {_produto.Unidade}", local.LojaDoTerminal));
            }

            Nota = saldos.ControlaEstoque ? NotaOnline : NotaSemControle;
            if (Locais.Count == 0)
            {
                Aviso = "Nenhuma loja ou depósito para mostrar.";
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Voltou à pesquisa antes da resposta: nada a mostrar.
        }
        finally
        {
            Consultando = false;
        }
    }

    protected override Task AoConfirmarAsync() => VoltarAsync();

    protected override Task AoCancelarAsync() => VoltarAsync();

    private Task VoltarAsync()
    {
        _cancelar.Cancel();
        Venda.AbrirDialogo(_pesquisa);
        return Task.CompletedTask;
    }
}

/// <summary>Confirmação perigosa: exige a tecla S (nunca só Enter, para o leitor não confirmar sem querer — PDV 32.8).</summary>
public sealed partial class DialogoConfirmacaoViewModel(VendaViewModel venda, string titulo, string mensagem, Func<Task> aoConfirmar) : DialogoViewModel(venda)
{
    public override string Titulo => titulo;

    public string Mensagem => mensagem;

    protected override Task AoConfirmarAsync() => Task.CompletedTask;

    [RelayCommand]
    private async Task Sim()
    {
        try
        {
            await aoConfirmar();
        }
        catch (RegraNegocioException e)
        {
            Erro = e.Message;
        }
    }
}

public sealed class DialogoAjudaViewModel(VendaViewModel venda) : DialogoViewModel(venda)
{
    public override string Titulo => "Atalhos do caixa";

    public IReadOnlyList<string> Atalhos { get; } =
    [
        "Enter      Incluir o código digitado/bipado (aceita 3*código e 0,750*código)",
        "+ / -      Somar ou tirar 1 do último item",
        "↑ ↓        Selecionar item          Home/End  Primeiro/último item",
        "F2         Pesquisar produto (na pesquisa, F4 = estoque nas outras lojas, online)    F3  Quantidade",
        "F4         Remover (cancelar) item  Shift+F4  Cancelar a venda",
        "F5         CPF na nota / cliente    F6  Desconto (item / total)",
        "F10        Concluir venda: ↑↓ ou Alt+1..9 escolhem a forma (cartão: maquininha; PIX: QR e supervisor)",
        "Ctrl+Alt+T Alternar tema escuro/claro    Ctrl+Alt+B Bloquear a tela (F11 › 7; desbloqueia com o PIN)",
        "F11        Funções: 1 Sangria  2 Reforço  3 Fechamento  4 Reimprimir  5 Cancelar última  6 Resumo diário",
        "           S Status do sync  V Vasilhames (na sangria/reforço: F2 Quem retira  F3 Cédulas  F12 Movimentos)",
        "           7 Bloquear a tela  8 ⚙ Central do PDV (Painel de saúde, impressora e gaveta; também o ⚙ da barra)  9 Abrir a gaveta",
        "⚠ na barra  Problema no Painel de saúde: o clique abre a Central e diz o que fazer",
        "F12        Gestão de vendas: Enter detalhes  Ctrl+R reimprimir  Ctrl+Del cancelar venda paga (gerente ou encarregado)",
        "           F3 Caixas anteriores (os fechados dos últimos 30 dias, na Central › 1 Vendas)",
        "Ctrl+Alt+S Sincronizar agora",
        "Mouse      Botões da barra de baixo = as teclas F; duplo clique no item abre a janela do item",
        "F7 F8 F9 Ctrl+N Ctrl+T  Chegam nas próximas fases",
    ];

    protected override Task AoConfirmarAsync()
    {
        Venda.FecharDialogo();
        return Task.CompletedTask;
    }
}

/// <summary>
/// Janela do item (duplo clique num item lançado; decisão 65): quantidade, desconto no item (R$ ou %) e "Remover item",
/// para o operador sem as teclas F. Cada ação usa a mesma regra da tecla: a quantidade a do F3
/// (<see cref="VendaViewModel.AlterarQuantidadeAsync"/>: inteiro fora das unidades fracionáveis, combo e casco não mudam),
/// o desconto a do F6 (<see cref="VendaViewModel.AplicarDescontoAsync"/>: o limite e a liberação do supervisor) e o
/// remover a do F4 (<see cref="VendaViewModel.RemoverItemAsync"/>: <c>pdv.venda.cancelar_item</c> ou a liberação). Depois
/// de mudar a quantidade ou o desconto a janela continua aberta com os valores novos; Esc fecha.
/// </summary>
public sealed partial class DialogoItemViewModel : DialogoViewModel
{
    private readonly int _sequencia;

    public DialogoItemViewModel(VendaViewModel venda, int sequencia)
        : base(venda)
    {
        _sequencia = sequencia;
        Quantidade = NumeroBr.Quantidade(Item.Quantidade);
    }

    private ItemVenda Item => Venda.ServicoVenda.Atual?.ObterItem(_sequencia) ?? throw new RegraNegocioException("Não há venda em andamento.");

    private IReadOnlyList<ItemVenda> Linhas => Item.Kit is { } kit
        ? Venda.ServicoVenda.Atual!.LinhasDoCombo(kit.GrupoId)
        : [Item];

    public int Sequencia => _sequencia;

    public override string Titulo => $"Item {_sequencia} — {(Item.Kit is { } k ? k.Descricao : Item.Descricao)}";

    /// <summary>"12 UN × 3,19 = 38,28" (no combo, a quantidade de combos e o total das linhas).</summary>
    public string Resumo => Item.Kit is { } kit
        ? $"{NumeroBr.Quantidade(kit.Quantidade)} combo(s) × {NumeroBr.Preco(kit.PrecoUnitario)} = {NumeroBr.Dinheiro(Linhas.Sum(l => l.ValorBruto))}"
        : $"{NumeroBr.Quantidade(Item.Quantidade)} {Item.Unidade} × {NumeroBr.Preco(Item.PrecoUnitario)} = {NumeroBr.Dinheiro(Item.ValorBruto)}";

    public decimal DescontoAtual => Linhas.Sum(l => l.DescontoItem);

    public bool TemDesconto => DescontoAtual > 0m;

    public string DescontoTexto => TemDesconto
        ? $"Desconto no {(Item.EhKit ? "combo" : "item")}: R$ {NumeroBr.Dinheiro(DescontoAtual)}"
          + (Item.DescontoItemPct is { } pct && !Item.EhKit ? $" ({NumeroBr.Percentual(pct)}%)" : string.Empty)
        : $"Sem desconto no {(Item.EhKit ? "combo" : "item")}.";

    /// <summary>Combo e casco não mudam a quantidade (as mesmas recusas do F3, ditas antes de tentar).</summary>
    public bool PodeAlterarQuantidade => !Item.EhKit && !Item.EhCasco;

    public string? AvisoQuantidade => Item.EhKit
        ? "Combo: para mudar a quantidade, remova o combo e inclua de novo."
        : Item.EhCasco
            ? "Casco: a quantidade segue os cascos trazidos no item do produto cheio."
            : Item.Fracionavel ? $"Vendido por {Item.Unidade}: aceita até 3 casas (0,750)." : null;

    public string DicaDesconto => "Digite o número e clique em \"Aplicar em R$\" ou \"Aplicar em %\" (ou digite 2,50 ou 10% e Enter).";

    [ObservableProperty]
    public partial string Quantidade { get; set; }

    [ObservableProperty]
    public partial string Desconto { get; set; } = string.Empty;

    /// <summary>O que acabou de ser feito ("Quantidade alterada para 3.").</summary>
    [ObservableProperty]
    public partial string? Mensagem { get; set; }

    protected override Task AoConfirmarAsync() => PodeAlterarQuantidade ? MudarQuantidade() : AplicarDescontoItem();

    protected override Task AoCancelarAsync()
    {
        Venda.FecharDialogo(_sequencia);
        return Task.CompletedTask;
    }

    [RelayCommand]
    private Task AlterarQuantidade() => Executar(MudarQuantidade);

    [RelayCommand]
    private Task AplicarDesconto() => Executar(() => AplicarDescontoItem());

    /// <summary>"Aplicar em R$": o número digitado em reais.</summary>
    [RelayCommand]
    private Task AplicarDescontoReais() => Executar(() => AplicarDescontoItem(TipoDesconto.Valor));

    /// <summary>"Aplicar em %": o número digitado em percentual (o teclado numérico não tem a tecla %; decisão 65).</summary>
    [RelayCommand]
    private Task AplicarDescontoPercentual() => Executar(() => AplicarDescontoItem(TipoDesconto.Percentual));

    [RelayCommand]
    private Task RemoverDesconto() => Executar(async () =>
    {
        if (!TemDesconto)
        {
            throw new RegraNegocioException("O item não tem desconto.");
        }

        await Venda.ServicoVenda.RemoverDescontoItemAsync(_sequencia);
        Venda.AtualizarTela(_sequencia);
        Atualizado($"Desconto do item {_sequencia} removido.");
    });

    /// <summary>O mesmo fluxo do F4 (permissão ou liberação; a quantidade a cancelar no diálogo do cancelamento).</summary>
    [RelayCommand]
    private Task RemoverItem() => Venda.RemoverItemAsync(_sequencia);

    private async Task MudarQuantidade()
    {
        if (!PodeAlterarQuantidade)
        {
            throw new RegraNegocioException(AvisoQuantidade!);
        }

        var qtd = LerNumero(Quantidade, "Informe a quantidade, por exemplo 3 ou 0,750.");
        if (qtd == Item.Quantidade)
        {
            Atualizado(null);
            return;
        }

        if (await Venda.AlterarQuantidadeAsync(Item, qtd))
        {
            // Item cheio retornável: o diálogo dos cascos trazidos tomou o lugar da janela (10.12), como no F3.
            return;
        }

        Atualizado($"Quantidade alterada para {NumeroBr.Quantidade(qtd)}.");
    }

    private async Task AplicarDescontoItem(TipoDesconto? tipo = null)
    {
        var desconto = Core.Vendas.Desconto.Ler(Desconto, tipo);
        await Venda.AplicarDescontoAsync(_sequencia, desconto, mensagem =>
        {
            // Com a liberação do supervisor, a janela volta no lugar do diálogo dele.
            Venda.AtualizarTela(_sequencia);
            Venda.AbrirDialogo(this);
            Desconto = string.Empty;
            Atualizado(mensagem);
        });
    }

    private void Atualizado(string? mensagem)
    {
        Erro = null;
        Mensagem = mensagem;
        Quantidade = NumeroBr.Quantidade(Item.Quantidade);
        OnPropertyChanged(nameof(Resumo));
        OnPropertyChanged(nameof(DescontoAtual));
        OnPropertyChanged(nameof(TemDesconto));
        OnPropertyChanged(nameof(DescontoTexto));
    }
}

/// <summary>Botão da barra de funções da venda (decisão 65): a tecla, a função e o mesmo comando da tecla.</summary>
/// <param name="Futuro">Função das próximas fases (F7, F8, F9, Ctrl+N, Ctrl+T): o botão mostra o "em breve" de sempre.</param>
/// <param name="Destaque">O F10 CONCLUIR.</param>
public sealed record AtalhoBarraViewModel(
    string Tecla, string Funcao, System.Windows.Input.ICommand Comando, object? Parametro = null, bool Futuro = false, bool Destaque = false)
{
    public string Rotulo => $"{Tecla} {Funcao}";
}
