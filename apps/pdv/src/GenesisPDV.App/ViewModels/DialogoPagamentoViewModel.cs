using System.Collections.ObjectModel;
using Avalonia.Media.Imaging;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Repositorios;

namespace GenesisPDV.App.ViewModels;

/// <summary>Linha da lista de formas da tela de pagamento (16.1).</summary>
public sealed partial class LinhaFormaViewModel(int indice, FormaPagamentoInfo forma, string? marca) : ObservableObject
{
    public FormaPagamentoInfo Forma => forma;

    /// <summary>A posição (1 a 9) que o clique na forma escolhe, como o Alt+número.</summary>
    public string Indice => indice.ToString(System.Globalization.CultureInfo.InvariantCulture);

    public string Texto => $"{indice}  {forma.Descricao}" + (marca is null ? string.Empty : $"  ({marca})");

    [ObservableProperty]
    public partial bool Selecionada { get; set; }
}

/// <summary>
/// Tela de pagamento (PDV 16.1, 16.4; Fase 1C, C11a): as formas da loja (espelho, C8b) em ordem — ↑/↓ escolhem —, o
/// valor pré-preenchido com o saldo (0,00 na forma "Sempre zerado"), o troco enquanto se digita (só na forma que dá
/// troco, O23) e várias formas na mesma venda. Enter lança: dinheiro e "outros" direto; cartão abre a maquininha (16.5);
/// PIX, a confirmação manual com o QR estático (16.7); a forma que exige supervisor pede a liberação (31.3). Quitado o
/// total, a venda finaliza sozinha. F5 identifica o cliente; Del remove o último pagamento; Esc volta aos itens mantendo
/// o que foi lançado.
/// </summary>
public sealed partial class DialogoPagamentoViewModel : DialogoViewModel
{
    private DialogoPagamentoViewModel(VendaViewModel venda, IReadOnlyList<FormaPagamentoInfo> formas)
        : base(venda)
    {
        for (var i = 0; i < formas.Count; i++)
        {
            var f = formas[i];
            var marca = Venda.ServicoVenda.PermissaoParaLancar(f) is not null ? "supervisor" : f.Fluxo == FluxoPagamento.Pos ? "maquininha" : null;
            Formas.Add(new LinhaFormaViewModel(i + 1, f, marca));
        }

        Atualizar();
        Selecionar(Formas.FirstOrDefault());
    }

    /// <summary>Abre a tela com as formas da loja (a lista vazia aponta o cadastro).</summary>
    public static async Task<DialogoPagamentoViewModel> CriarAsync(VendaViewModel venda)
    {
        ArgumentNullException.ThrowIfNull(venda);
        return new DialogoPagamentoViewModel(venda, await venda.ServicoVenda.FormasPagamentoAsync());
    }

    private Venda VendaAtual => Venda.ServicoVenda.Atual ?? throw new InvalidOperationException("Sem venda.");

    public override string Titulo => $"Pagamento · Venda {VendaAtual.NumeroExibicao}";

    public ObservableCollection<LinhaFormaViewModel> Formas { get; } = [];

    [ObservableProperty]
    public partial LinhaFormaViewModel? FormaSelecionada { get; set; }

    public FormaPagamentoInfo? Forma => FormaSelecionada?.Forma;

    [ObservableProperty]
    public partial string TotalTexto { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string PagoTexto { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string FaltaTexto { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string TrocoTexto { get; set; } = "0,00";

    [ObservableProperty]
    public partial string LancadosTexto { get; set; } = string.Empty;

    /// <summary>CPF/CNPJ ou cliente da venda (F5), mostrado acima dos lançados.</summary>
    [ObservableProperty]
    public partial string? ClienteTexto { get; set; }

    [ObservableProperty]
    public partial string ValorRecebido { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string RotuloValor { get; set; } = "Valor (R$)";

    partial void OnValorRecebidoChanged(string value) => PreverTroco();

    private void PreverTroco()
    {
        Erro = null;
        if (Forma is not { } forma || !NumeroBr.TentarLer(ValorRecebido, out var valor) || valor <= 0m)
        {
            TrocoTexto = "0,00";
            return;
        }

        try
        {
            TrocoTexto = NumeroBr.Dinheiro(VendaAtual.PreverPagamento(forma, valor).Troco);
        }
        catch (RegraNegocioException e)
        {
            TrocoTexto = "0,00";
            Erro = e.Message;
        }
    }

    private void Selecionar(LinhaFormaViewModel? linha)
    {
        foreach (var l in Formas)
        {
            l.Selecionada = l == linha;
        }

        FormaSelecionada = linha;
        RotuloValor = linha?.Forma.DaTroco == true ? "Valor recebido (R$)" : "Valor (R$)";
        ValorRecebido = NumeroBr.Dinheiro(linha?.Forma.SempreZeradoNoPdv == true ? 0m : VendaAtual.Falta);
        PreverTroco();
        if (Formas.Count == 0)
        {
            Erro = "Nenhuma forma de pagamento nesta loja: cadastre em ERP › Formas de pagamento e sincronize.";
        }
    }

    [RelayCommand]
    private void MoverForma(string direcao)
    {
        if (Formas.Count == 0)
        {
            return;
        }

        var i = FormaSelecionada is null ? 0 : Formas.IndexOf(FormaSelecionada);
        Selecionar(Formas[direcao == "acima" ? Math.Max(0, i - 1) : Math.Min(Formas.Count - 1, i + 1)]);
    }

    /// <summary>Atalho 1–9 (Alt+número na tela): escolhe a forma pela posição.</summary>
    [RelayCommand]
    private void EscolherForma(string indice)
    {
        if (int.TryParse(indice, out var n) && n >= 1 && n <= Formas.Count)
        {
            Selecionar(Formas[n - 1]);
        }
    }

    public void Atualizar()
    {
        var v = VendaAtual;
        TotalTexto = NumeroBr.Dinheiro(v.Total);
        PagoTexto = NumeroBr.Dinheiro(v.Recebido);
        FaltaTexto = NumeroBr.Dinheiro(v.Falta);
        LancadosTexto = string.Join(Environment.NewLine, v.PagamentosAtivos.Select(p =>
            $"{p.Sequencia}  {p.DescricaoForma,-14} {NumeroBr.Dinheiro(p.ValorRecebido ?? p.Valor),10}" +
            (p.Detalhe.BandeiraNome is { } b ? $"  {b}" : string.Empty)));
        ClienteTexto = v.CpfCnpjNota is { } doc ? $"{(doc.Length == 11 ? "CPF" : "CNPJ")} {doc}" : v.ClienteId is not null ? "Cliente identificado" : null;
    }

    protected override async Task AoConfirmarAsync()
    {
        var forma = Forma ?? throw new RegraNegocioException("Escolha a forma de pagamento (↑/↓).");
        var valor = LerNumero(ValorRecebido, "Informe o valor, por exemplo 50,00.");
        VendaAtual.PreverPagamento(forma, valor);
        switch (forma.Fluxo)
        {
            case FluxoPagamento.Pos:
                Venda.AbrirDialogo(new DialogoPosViewModel(Venda, this, forma, valor));
                return;
            case FluxoPagamento.PixManual:
                var pix = new DialogoPixViewModel(Venda, this, forma, valor);
                await pix.CarregarAsync();
                Venda.AbrirDialogo(pix);
                return;
            default:
                await LancarAsync(forma, valor, null, null);
                return;
        }
    }

    /// <summary>
    /// Lança na forma, pedindo antes a liberação quando ela exige (PIX manual, forma com supervisor); quitado, finaliza.
    /// Senão volta a esta tela com o saldo novo.
    /// </summary>
    public async Task LancarAsync(FormaPagamentoInfo forma, decimal valor, DetalhePagamento? detalhe, ConfirmacaoPix? pix)
    {
        ArgumentNullException.ThrowIfNull(forma);
        if (Venda.ServicoVenda.PermissaoParaLancar(forma) is { } permissao)
        {
            Venda.PedirLiberacao(permissao, $"{forma.Descricao} de R$ {NumeroBr.Dinheiro(valor)}", concedida => EfetivarAsync(forma, valor, detalhe, pix, concedida));
            return;
        }

        await EfetivarAsync(forma, valor, detalhe, pix, null);
    }

    private async Task EfetivarAsync(FormaPagamentoInfo forma, decimal valor, DetalhePagamento? detalhe, ConfirmacaoPix? pix, LiberacaoConcedida? liberacao)
    {
        var finalizacao = await Venda.ServicoVenda.LancarPagamentoAsync(forma, valor, detalhe, pix, liberacao);
        if (finalizacao is not null)
        {
            Venda.VendaFinalizada(finalizacao);
            return;
        }

        Atualizar();
        Selecionar(FormaSelecionada);
        Venda.AtualizarTela();
        Venda.AbrirDialogo(this);
    }

    /// <summary>F5 na tela de pagamento (14.1): CPF na nota ou cliente; Esc volta aqui.</summary>
    [RelayCommand]
    private void Cliente() => Venda.AbrirDialogo(new DialogoClienteViewModel(Venda, this));

    [RelayCommand]
    private async Task RemoverUltimoPagamento()
    {
        var ultimo = VendaAtual.PagamentosAtivos.LastOrDefault();
        if (ultimo is null)
        {
            return;
        }

        await Venda.ServicoVenda.RemoverPagamentoAsync(ultimo.Sequencia);
        Atualizar();
        Selecionar(FormaSelecionada);
    }

    protected override async Task AoCancelarAsync()
    {
        await Venda.ServicoVenda.VoltarParaItensAsync();
        Venda.FecharDialogo();
    }
}

/// <summary>
/// Cartão na maquininha (PDV 16.5; O9c do dono): "Passe o cartão na maquininha. Aprovado?" — Enter = sim, com a bandeira
/// obrigatória (o número da lista), o NSU/CV e o código de autorização opcionais e as parcelas no crédito que parcela
/// (informativas); Esc = não, volta ao pagamento.
/// </summary>
public sealed partial class DialogoPosViewModel(VendaViewModel venda, DialogoPagamentoViewModel pagamento, FormaPagamentoInfo forma, decimal valor)
    : DialogoViewModel(venda)
{
    public override string Titulo => $"{forma.Descricao} · R$ {NumeroBr.Dinheiro(valor)}";

    public string Instrucao => "Passe o cartão na maquininha. Aprovado? [Enter] Sim  [Esc] Não";

    public string BandeirasTexto { get; } =
        string.Join("   ", RegrasFormaPagamento.Bandeiras.Select(b => $"{b.Codigo} {b.Nome}"));

    public bool Parcela => forma.TipoForma == "cartao_credito" && forma.PermiteParcelar && forma.ParcelasMaximo > 1;

    [ObservableProperty]
    public partial string Bandeira { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Nsu { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Autorizacao { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Parcelas { get; set; } = "1";

    protected override Task AoConfirmarAsync()
    {
        var codigo = Bandeira.Trim();
        if (codigo.Length == 1)
        {
            codigo = "0" + codigo;
        }

        var parcelas = int.TryParse(Parcelas, out var p) ? p : 0;
        var detalhe = RegrasFormaPagamento.ValidarPos(forma, codigo, Nsu, Autorizacao, parcelas);
        return pagamento.LancarAsync(forma, valor, detalhe, null);
    }

    protected override Task AoCancelarAsync()
    {
        Venda.AbrirDialogo(pagamento);
        return Task.CompletedTask;
    }
}

/// <summary>
/// PIX estático ou manual (PDV 16.7; O9b do dono): o QR com a chave da loja e o valor (gerado offline) — ou só a chave,
/// sem QR — e a confirmação conferida no app/extrato do banco da loja, nunca no celular do cliente: nome de quem pagou e
/// o horário que aparece lá. Com <c>pdv.pix_manual_exige_supervisor</c> (padrão), Enter pede a liberação.
/// </summary>
public sealed partial class DialogoPixViewModel(VendaViewModel venda, DialogoPagamentoViewModel pagamento, FormaPagamentoInfo forma, decimal valor)
    : DialogoViewModel(venda)
{
    private PixPreparado? _pix;

    public override string Titulo => $"{forma.Descricao} · R$ {NumeroBr.Dinheiro(_pix?.Valor ?? valor)}";

    public string Instrucao =>
        "Confira o PIX no app ou no extrato do banco da LOJA (nunca no celular do cliente) e informe o nome de quem pagou e o horário.";

    [ObservableProperty]
    public partial Bitmap? Qr { get; set; }

    [ObservableProperty]
    public partial string? CopiaECola { get; set; }

    [ObservableProperty]
    public partial string? ChaveTexto { get; set; }

    [ObservableProperty]
    public partial string PagadorNome { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Horario { get; set; } = string.Empty;

    public async Task CarregarAsync()
    {
        _pix = await Venda.ServicoVenda.PrepararPixAsync(forma, valor);
        CopiaECola = _pix.Qrcode;
        Qr = _pix.Qrcode is { } payload ? QrPix.Imagem(payload) : null;
        ChaveTexto = _pix.Chave is { } chave
            ? $"Chave PIX da loja: {chave}" + (_pix.Qrcode is null ? " (forma sem QR: o cliente digita a chave)" : string.Empty)
            : "Loja sem chave PIX cadastrada (ERP › Lojas): confirmação manual pelo extrato.";
        OnPropertyChanged(nameof(Titulo));
    }

    /// <summary>Resultado do F4 (QR impresso ou o aviso da impressora).</summary>
    [ObservableProperty]
    public partial string? AvisoImpressao { get; set; }

    /// <summary>F4 (I4): o QR da cobrança na impressora, para o cliente ler do papel; a tela segue esperando a confirmação.</summary>
    [RelayCommand]
    private async Task ImprimirQrAsync()
    {
        if (_pix is not { } pix)
        {
            return;
        }

        try
        {
            Erro = null;
            AvisoImpressao = await Venda.ServicoVenda.ImprimirCobrancaPixAsync(pix) ?? "QR do PIX enviado à impressora.";
        }
        catch (RegraNegocioException e)
        {
            Erro = e.Message;
        }
    }

    protected override Task AoConfirmarAsync()
    {
        var pix = _pix ?? throw new InvalidOperationException("PIX não preparado.");
        var servico = Venda.ServicoVenda;
        var quando = RegrasFormaPagamento.HorarioDoBanco(Horario, servico.Agora, servico.Fuso);
        var (nome, pagaEm) = RegrasFormaPagamento.ValidarPix(PagadorNome, quando, servico.Agora, servico.Atual?.IniciadaEm);
        return pagamento.LancarAsync(forma, pix.Valor, null, new ConfirmacaoPix(nome, pagaEm, pix.Qrcode ?? string.Empty, pix.Txid));
    }

    protected override Task AoCancelarAsync()
    {
        Venda.AbrirDialogo(pagamento);
        return Task.CompletedTask;
    }
}

/// <summary>
/// F5 Cliente (PDV 14.1, 14.2; O8 do dono): opcional e só quando o cliente pede — o fluxo padrão não pergunta nada.
/// CPF/CNPJ na nota (dígitos conferidos; se for de um cliente ativo do espelho, a venda leva também o cliente) ou a
/// busca de cliente cadastrado (nome, apelido, CPF/CNPJ ou código; inativos não são escolhidos). Ctrl+Del tira a
/// identificação. O cadastro rápido é da 1D.
/// </summary>
public sealed partial class DialogoClienteViewModel(VendaViewModel venda, DialogoViewModel? voltarPara) : DialogoViewModel(venda)
{
    public override string Titulo => "Cliente da venda";

    public ObservableCollection<ClienteLocal> Resultados { get; } = [];

    [ObservableProperty]
    public partial string Documento { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Nome { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Busca { get; set; } = string.Empty;

    [ObservableProperty]
    public partial ClienteLocal? Selecionado { get; set; }

    partial void OnBuscaChanged(string value) => _ = AtualizarAsync();

    public async Task AtualizarAsync()
    {
        var lista = await Venda.ServicoVenda.BuscarClientesAsync(Busca);
        Resultados.Clear();
        foreach (var c in lista)
        {
            Resultados.Add(c);
        }

        Selecionado = Resultados.FirstOrDefault(c => c.Ativa);
    }

    [RelayCommand]
    private void Mover(string direcao)
    {
        if (Resultados.Count == 0)
        {
            return;
        }

        var i = Selecionado is null ? -1 : Resultados.IndexOf(Selecionado);
        Selecionado = Resultados[direcao == "acima" ? Math.Max(0, i - 1) : Math.Min(Resultados.Count - 1, i + 1)];
    }

    protected override async Task AoConfirmarAsync()
    {
        string mensagem;
        if (!string.IsNullOrWhiteSpace(Documento))
        {
            var vinculado = await Venda.ServicoVenda.IdentificarDocumentoAsync(Documento, Nome);
            mensagem = vinculado is null ? "CPF/CNPJ na nota." : $"Cliente {vinculado.Nome} na venda.";
        }
        else if (Selecionado is { } cliente && !string.IsNullOrWhiteSpace(Busca))
        {
            await Venda.ServicoVenda.EscolherClienteAsync(cliente);
            mensagem = $"Cliente {cliente.Nome} na venda.";
        }
        else
        {
            throw new RegraNegocioException("Digite o CPF/CNPJ ou busque o cliente pelo nome ou código.");
        }

        Voltar(mensagem);
    }

    [RelayCommand]
    private async Task Remover()
    {
        await Venda.ServicoVenda.RemoverClienteAsync();
        Voltar("Identificação do cliente removida.");
    }

    private void Voltar(string mensagem)
    {
        if (voltarPara is DialogoPagamentoViewModel pagamento)
        {
            pagamento.Atualizar();
            Venda.AbrirDialogo(pagamento);
            return;
        }

        Venda.FecharDialogo(mensagem: mensagem);
    }

    protected override Task AoCancelarAsync()
    {
        if (voltarPara is not null)
        {
            Venda.AbrirDialogo(voltarPara);
            return Task.CompletedTask;
        }

        Venda.FecharDialogo();
        return Task.CompletedTask;
    }
}
