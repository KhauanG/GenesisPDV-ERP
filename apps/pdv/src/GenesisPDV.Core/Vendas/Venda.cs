using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Produtos;

namespace GenesisPDV.Core.Vendas;

/// <summary>Cabeçalho de <c>vendas</c> gravado no banco local, usado para reconstituir a venda.</summary>
public sealed record EstadoVenda(
    Guid Id,
    long Numero,
    string NumeroExibicao,
    Guid LojaId,
    Guid CaixaId,
    int NumeroCaixa,
    Guid? TerminalId,
    Guid? SessaoCaixaId,
    string Modo,
    string Status,
    string StatusFiscal,
    Guid OperadorId,
    string TipoPreco,
    decimal DescontoTotal,
    decimal? DescontoTotalPct,
    decimal AcrescimoTotal,
    DateTimeOffset IniciadaEm,
    DateTimeOffset? FinalizadaEm = null,
    DateOnly? DiaOperacional = null,
    Guid? VendedorId = null,
    Guid? ClienteId = null,
    string? CpfCnpjNota = null,
    string? NomeNota = null,
    DateTimeOffset? CanceladaEm = null,
    Guid? CanceladaPorId = null,
    Guid? CancelamentoAutorizadoPorId = null,
    string? MotivoCancelamento = null,
    string? CancelamentoOrigem = null,
    Guid? EventoFinalizacaoId = null,
    string? Observacao = null,
    string? DescontoTotalOrigem = null,
    Guid? IdadeConfirmadaPorId = null,
    DateTimeOffset? IdadeConfirmadaEm = null);

/// <summary>
/// Agregado da venda do PDV: itens, descontos, pagamentos, totais e troco (PDV 10–17, 34.1). Toda regra de valor
/// mora aqui; quem chama só persiste o resultado depois de cada operação (PDV 32.3).
/// </summary>
public sealed class Venda
{
    public const int MaximoItens = 990;
    public const int MaximoPagamentos = 10;
    public const decimal QuantidadeMaxima = 9999.999m;

    /// <summary>
    /// <c>vendas.motivo_cancelamento</c> (O6 do dono; <c>MOTIVO_CANCELAMENTO_VENDA_*</c> do contrato, sincronizacao.md 9.9):
    /// texto livre de 15 a 255 caracteres. Fora disso a nuvem recusa o <c>venda.cancelada</c> (<c>PAYLOAD_INVALIDO</c>).
    /// </summary>
    public const int MotivoCancelamentoMinimo = 15;
    public const int MotivoCancelamentoMaximo = 255;

    /// <summary><c>liberacoes[].motivo</c> do payload (sincronizacao.md 9.7): de 1 a 255 caracteres sem os espaços das pontas.</summary>
    public const int MotivoLiberacaoMaximo = 255;

    /// <summary>Valores de <c>vendas.desconto_total_origem</c>.</summary>
    public const string OrigemDescontoOperador = "operador";
    public const string OrigemDescontoCliente = "cliente";

    private readonly List<ItemVenda> _itens = [];
    private readonly List<PagamentoVenda> _pagamentos = [];
    private readonly List<string> _avisos = [];
    private readonly List<LiberacaoVenda> _liberacoes = [];
    private readonly List<CobrancaPixVenda> _cobrancasPix = [];
    private readonly List<CascoDescontado> _cascosDescontados = [];
    private readonly Dictionary<Guid, ProdutoRegistrado> _produtos = [];
    private readonly TimeZoneInfo _fuso;
    private readonly TimeOnly _horaCorte;
    private bool _usaPrecoVolume;

    /// <summary>
    /// Teto (%) do desconto no total em R$ dado pelo operador: o limite dele ou o % já aceito (liberado), o que for maior.
    /// Um recálculo de preço (atacado, mix) que faça o mesmo R$ passar desse % reduz o desconto (decisão 27).
    /// </summary>
    private decimal? _tetoDescontoTotalPct;

    /// <summary>
    /// A parte do operador no <see cref="DescontoTotal"/> (PDV 12.2, em R$; com <see cref="DescontoTotalPct"/>, refeita
    /// a cada recálculo). O resto é o <see cref="DescontoCascos"/> (C11c): os dois dividem a coluna <c>desconto_total</c>.
    /// </summary>
    private decimal _descontoTotalOperador;

    private Venda(EstadoVenda e, string fusoHorario, TimeOnly horaCorte, bool usaPrecoVolume)
    {
        Id = e.Id;
        Numero = e.Numero;
        NumeroExibicao = e.NumeroExibicao;
        LojaId = e.LojaId;
        CaixaId = e.CaixaId;
        NumeroCaixa = e.NumeroCaixa;
        TerminalId = e.TerminalId;
        SessaoCaixaId = e.SessaoCaixaId;
        Modo = e.Modo;
        Status = e.Status;
        StatusFiscal = e.StatusFiscal;
        OperadorId = e.OperadorId;
        TipoPreco = e.TipoPreco;
        DescontoTotal = e.DescontoTotal;
        DescontoTotalPct = e.DescontoTotalPct;
        _descontoTotalOperador = e.DescontoTotal;
        AcrescimoTotal = e.AcrescimoTotal;
        IniciadaEm = e.IniciadaEm;
        FinalizadaEm = e.FinalizadaEm;
        DiaOperacional = e.DiaOperacional;
        VendedorId = e.VendedorId;
        ClienteId = e.ClienteId;
        CpfCnpjNota = e.CpfCnpjNota;
        NomeNota = e.NomeNota;
        CanceladaEm = e.CanceladaEm;
        CanceladaPorId = e.CanceladaPorId;
        CancelamentoAutorizadoPorId = e.CancelamentoAutorizadoPorId;
        MotivoCancelamento = e.MotivoCancelamento;
        CancelamentoOrigem = e.CancelamentoOrigem;
        EventoFinalizacaoId = e.EventoFinalizacaoId;
        Observacao = e.Observacao;
        DescontoTotalOrigem = e.DescontoTotalOrigem;
        IdadeConfirmadaPorId = e.IdadeConfirmadaPorId;
        IdadeConfirmadaEm = e.IdadeConfirmadaEm;
        _fuso = Comum.DiaOperacional.ObterFuso(fusoHorario);
        _horaCorte = horaCorte;
        _usaPrecoVolume = usaPrecoVolume;
    }

    public Guid Id { get; }
    public long Numero { get; }
    public string NumeroExibicao { get; }
    public Guid LojaId { get; }
    public Guid CaixaId { get; }
    public int NumeroCaixa { get; }
    public Guid? TerminalId { get; }
    public Guid? SessaoCaixaId { get; private set; }
    public string Tipo => "pdv";
    public string Canal => "pdv";
    public string Modo { get; }
    public string Status { get; private set; }
    public string StatusFiscal { get; private set; }
    public DateOnly? DiaOperacional { get; private set; }
    public Guid OperadorId { get; }
    public Guid? VendedorId { get; private set; }
    public Guid? ClienteId { get; private set; }
    public string? CpfCnpjNota { get; private set; }
    public string? NomeNota { get; private set; }
    public string TipoPreco { get; }
    public int QtdItens { get; private set; }
    public decimal SubtotalBruto { get; private set; }
    public decimal DescontoItens { get; private set; }
    /// <summary>
    /// <c>desconto_total</c>: o desconto no total do operador mais o <see cref="DescontoCascos"/> (C11c), antes do rateio.
    /// </summary>
    public decimal DescontoTotal { get; private set; }

    /// <summary>
    /// O % do desconto no total <b>do operador</b> (gravado no banco local, para a venda recuperada refazer o valor). O
    /// payload leva o <see cref="DescontoTotalPctDocumento"/>.
    /// </summary>
    public decimal? DescontoTotalPct { get; private set; }

    /// <summary>
    /// <c>desconto_total_pct</c> do documento (sincronizacao.md 9.7): o % do operador só quando ele é o desconto inteiro;
    /// com o crédito dos cascos somado, o <c>desconto_total</c> não é mais esse % da venda e o campo vai nulo (C11c).
    /// </summary>
    public decimal? DescontoTotalPctDocumento => DescontoCascos > 0m ? null : DescontoTotalPct;

    /// <summary>
    /// <c>operador</c> quando o operador deu desconto no total (com ou sem os cascos); <c>cliente</c> quando o desconto é
    /// só o crédito dos cascos descontados (C11c: não conta no limite do operador, como o desconto padrão do cliente,
    /// PDV 12.3); nulo sem desconto no total.
    /// </summary>
    public string? DescontoTotalOrigem { get; private set; }

    /// <summary>Cascos excedentes descontados na venda (PDV 10.12; O14 do dono; C11c), um por casco.</summary>
    public IReadOnlyList<CascoDescontado> CascosDescontados => _cascosDescontados;

    /// <summary>Σ valor dos <see cref="CascosDescontados"/>: a parte deles no <see cref="DescontoTotal"/>.</summary>
    public decimal DescontoCascos => _cascosDescontados.Sum(c => c.Valor);
    public decimal AcrescimoTotal { get; private set; }
    public decimal TaxaServico => 0m;
    public decimal TaxaEntrega => 0m;
    public decimal ValorFrete => 0m;
    public decimal Total { get; private set; }
    public decimal Troco { get; private set; }
    public DateTimeOffset IniciadaEm { get; }
    public DateTimeOffset? FinalizadaEm { get; private set; }
    public DateTimeOffset? CanceladaEm { get; private set; }
    public Guid? CanceladaPorId { get; private set; }
    public Guid? CancelamentoAutorizadoPorId { get; private set; }
    public string? MotivoCancelamento { get; private set; }
    public string? CancelamentoOrigem { get; private set; }
    public Guid? EventoFinalizacaoId { get; private set; }
    public string? Observacao { get; private set; }
    public Guid? IdadeConfirmadaPorId { get; private set; }
    public DateTimeOffset? IdadeConfirmadaEm { get; private set; }

    public IReadOnlyList<ItemVenda> Itens => _itens;
    public IReadOnlyList<PagamentoVenda> Pagamentos => _pagamentos;

    /// <summary>Liberações de supervisor usadas na venda, na ordem (sobem em <c>liberacoes</c>, sincronizacao.md 9.7).</summary>
    public IReadOnlyList<LiberacaoVenda> Liberacoes => _liberacoes;

    /// <summary><c>cobrancas_pix</c> da venda (PIX estático/manual, 16.7): uma por pagamento PIX lançado.</summary>
    public IReadOnlyList<CobrancaPixVenda> CobrancasPix => _cobrancasPix;
    public IEnumerable<ItemVenda> ItensAtivos => _itens.Where(i => !i.Cancelado);
    public IEnumerable<PagamentoVenda> PagamentosAtivos => _pagamentos.Where(p => p.Ativo);

    /// <summary>Σ quantidade dos itens não cancelados ("17,795 vol." no wireframe).</summary>
    public decimal VolumeTotal => ItensAtivos.Sum(i => i.Quantidade);

    /// <summary>Σ valor aplicado dos pagamentos (sem troco).</summary>
    public decimal Pago => PagamentosAtivos.Sum(p => p.Valor);

    /// <summary>Σ entregue pelo cliente (com o troco).</summary>
    public decimal Recebido => PagamentosAtivos.Sum(p => p.ValorRecebido ?? p.Valor);

    public decimal Falta => Math.Max(0m, Total - Pago);

    public bool Aberta => StatusVenda.Aberta(Status);

    public static string FormatarNumeroExibicao(int lojaCodigo, int numeroCaixa, long numero) =>
        $"L{lojaCodigo:00}-C{numeroCaixa:00}-{numero:000000}";

    /// <summary>Abre a venda no primeiro item (o número já foi reservado em <c>sequencias_locais</c>).</summary>
    public static Venda Iniciar(Guid id, long numero, ContextoVenda contexto, Guid operadorId, DateTimeOffset agora)
    {
        ArgumentNullException.ThrowIfNull(contexto);
        if (numero <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(numero), "O número da venda começa em 1.");
        }

        var estado = new EstadoVenda(
            Id: id,
            Numero: numero,
            NumeroExibicao: FormatarNumeroExibicao(contexto.LojaCodigo, contexto.NumeroCaixa, numero),
            LojaId: contexto.LojaId,
            CaixaId: contexto.CaixaId,
            NumeroCaixa: contexto.NumeroCaixa,
            TerminalId: contexto.TerminalId,
            SessaoCaixaId: contexto.SessaoCaixaId,
            Modo: "balcao",
            Status: StatusVenda.EmAndamento,
            StatusFiscal: Vendas.StatusFiscal.NaoAplicavel,
            OperadorId: operadorId,
            TipoPreco: "varejo",
            DescontoTotal: 0m,
            DescontoTotalPct: null,
            AcrescimoTotal: 0m,
            IniciadaEm: agora);
        return new Venda(estado, contexto.FusoHorario, contexto.HoraCorteDiaOperacional, contexto.UsaPrecoVolume);
    }

    /// <summary>Reconstitui a venda gravada; os totais são recalculados a partir dos itens.</summary>
    public static Venda Restaurar(
        EstadoVenda estado,
        IEnumerable<ItemVenda> itens,
        IEnumerable<PagamentoVenda> pagamentos,
        string fusoHorario = Comum.DiaOperacional.FusoPadrao,
        TimeOnly horaCorte = default,
        bool usaPrecoVolume = false,
        IEnumerable<LiberacaoVenda>? liberacoes = null,
        IEnumerable<CobrancaPixVenda>? cobrancasPix = null,
        IEnumerable<CascoDescontado>? cascosDescontados = null)
    {
        var venda = new Venda(estado, fusoHorario, horaCorte, usaPrecoVolume);
        venda._itens.AddRange(itens.OrderBy(i => i.Sequencia));
        venda._pagamentos.AddRange(pagamentos.OrderBy(p => p.Sequencia));
        venda._liberacoes.AddRange((liberacoes ?? []).OrderBy(l => l.OcorridoEm).ThenBy(l => l.Id));
        venda._cobrancasPix.AddRange((cobrancasPix ?? []).OrderBy(c => c.PagaEm).ThenBy(c => c.Id));
        venda._cascosDescontados.AddRange((cascosDescontados ?? []).OrderBy(c => c.RegistradoEm).ThenBy(c => c.ProdutoVasilhameId));
        // O `desconto_total` gravado soma os dois: a parte do operador é o que sobra do crédito dos cascos.
        venda._descontoTotalOperador = Math.Max(0m, estado.DescontoTotal - venda.DescontoCascos);
        venda.Recalcular();
        venda._avisos.Clear();
        return venda;
    }

    /// <summary>Mensagens para o operador geradas pelas últimas operações (ex.: desconto no total zerado).</summary>
    public IReadOnlyList<string> ConsumirAvisos()
    {
        var avisos = _avisos.ToList();
        _avisos.Clear();
        return avisos;
    }

    public ItemVenda ObterItem(int sequencia) =>
        _itens.FirstOrDefault(i => i.Sequencia == sequencia)
        ?? throw new RegraNegocioException($"Item {sequencia} não existe nesta venda.");

    // ---------------------------------------------------------------- itens

    /// <summary>Produtos registrados na venda (snapshot da primeira inclusão), para reconstituir a tela e o cupom.</summary>
    public IReadOnlyCollection<ProdutoVenda> ProdutosRegistrados => _produtos.Values.Select(p => p.Produto).ToList();

    /// <summary>
    /// Snapshots da primeira inclusão de cada produto (PDV 11.3), gravados pelo repositório na tabela local
    /// <c>produtos_venda_snapshot</c> no mesmo commit da venda.
    /// </summary>
    public IReadOnlyCollection<KeyValuePair<Guid, ProdutoRegistrado>> Snapshots => _produtos.ToList();

    /// <summary>
    /// Venda recuperada após queda (PDV 32.3): registra os produtos com o snapshot gravado na primeira inclusão (nunca o
    /// espelho atual: um pull no meio da venda não muda os itens já incluídos, 11.3.1), refaz as informações que não são
    /// colunas (embalagem, varejo, etiqueta "ATAC 12+") e volta a recalcular os preços nas próximas mudanças. Não muda
    /// nenhum valor gravado.
    /// </summary>
    /// <param name="snapshots">Lidos de <c>produtos_venda_snapshot</c>.</param>
    /// <param name="semSnapshot">
    /// Produtos sem snapshot (venda gravada antes da tabela existir), lidos do espelho atual: as linhas já gravadas
    /// desses produtos ficam com o preço fixo (não são recalculadas), para o cliente nunca pagar o preço novo por elas.
    /// </param>
    /// <param name="usaPrecoVolume"><c>pdv.usa_preco_volume</c> da loja (a venda gravada não guarda a chave).</param>
    /// <param name="limiteOperadorPct">Limite de desconto do operador: teto dos descontos em R$ já aceitos (decisão 27).</param>
    public void RegistrarProdutos(
        IEnumerable<ProdutoRegistrado> snapshots,
        IEnumerable<ProdutoVenda>? semSnapshot,
        DateTimeOffset agora,
        bool? usaPrecoVolume = null,
        decimal? limiteOperadorPct = null)
    {
        ArgumentNullException.ThrowIfNull(snapshots);
        _usaPrecoVolume = usaPrecoVolume ?? _usaPrecoVolume;
        foreach (var snapshot in snapshots)
        {
            _produtos.TryAdd(snapshot.Produto.Id, snapshot);
        }

        var fixados = new HashSet<Guid>();
        foreach (var produto in semSnapshot ?? [])
        {
            if (!_produtos.ContainsKey(produto.Id))
            {
                Registrar(produto, agora);
                fixados.Add(produto.Id);
            }
        }

        var (porProduto, porGrupo) = QuantidadesDeReferencia();
        foreach (var item in _itens)
        {
            if (!_produtos.TryGetValue(item.ProdutoId, out var registrado))
            {
                // Produto que nem o espelho tem: a linha fica como gravada.
                item.PrecoFixado = true;
                continue;
            }

            if (item.CodigoBarrasId is { } cb && item.Embalagem is null)
            {
                item.Embalagem = registrado.Produto.Precos?.Embalagens?.FirstOrDefault(e => e.CodigoBarrasId == cb);
            }

            if (fixados.Contains(item.ProdutoId))
            {
                // Sem snapshot o varejo da hora da venda é desconhecido: sem "varejo 3,49" nem economia no cupom.
                item.PrecoFixado = true;
                continue;
            }

            item.PrecoVarejo ??= registrado.Produto.PrecoBase;
            if (!item.Cancelado && ContaParaPreco(item) && OrigemPreco.PorQuantidade(item.OrigemPreco))
            {
                var r = Resolver(registrado, item, porProduto, porGrupo);
                if (r.Origem == item.OrigemPreco && r.Preco == item.PrecoUnitario)
                {
                    item.LimiarPreco = r.Limiar;
                    item.NomeGrupoPreco = r.GrupoNome;
                }
            }
        }

        var limite = limiteOperadorPct ?? 0m;
        foreach (var item in ItensAtivos.Where(i => i.DescontoItem > 0m && i.DescontoItemPct is null))
        {
            item.TetoDescontoPct ??= Math.Max(limite, MedidaItem(item).Percentual);
        }

        if (DescontoTotalPct is null && DescontoTotalDoOperador > 0m)
        {
            _tetoDescontoTotalPct ??= Math.Max(limite, MedidaVenda().Percentual);
        }
    }

    public ItemVenda AdicionarItem(
        ProdutoResolvido resolvido,
        decimal multiplicador,
        string? codigoLido,
        DateTimeOffset agora,
        bool agrupar = false,
        string? origemEntrada = null) =>
        Atomico(() => AdicionarItemInterno(resolvido, multiplicador, codigoLido, agora, agrupar, origemEntrada));

    private ItemVenda AdicionarItemInterno(
        ProdutoResolvido resolvido,
        decimal multiplicador,
        string? codigoLido,
        DateTimeOffset agora,
        bool agrupar,
        string? origemEntrada)
    {
        ArgumentNullException.ThrowIfNull(resolvido);
        ExigirStatus(StatusVenda.EmAndamento, "incluir itens");
        var produto = resolvido.Produto;
        ValidarVendavel(produto);
        if (produto.EhKit)
        {
            throw new RegraNegocioException($"{produto.Descricao} é um combo: inclua pelo código do combo (Montar combo).");
        }

        if (resolvido.Fator <= 0m)
        {
            throw new RegraNegocioException("Embalagem com fator inválido — procure o gerente.");
        }

        if (resolvido.PrecoEmbalagem is { } pe && (pe <= 0m || !Arredondamento.CabeEm(pe, Arredondamento.CasasPreco)))
        {
            throw new RegraNegocioException("Preço da embalagem inválido — procure o gerente.");
        }

        var quantidade = resolvido.Fator * multiplicador;
        ValidarQuantidade(quantidade, produto.Fracionavel);
        _ = ValorBrutoValido(quantidade, produto.PrecoBase);
        var totalAntes = Total;
        var registrado = Registrar(produto, agora, resolvido.Embalagem);

        // O fardo também segue o snapshot: o preço do fardo da primeira inclusão (mesmo código e mesmo fator).
        var embalagem = resolvido.Embalagem is { } lida
            ? registrado.Produto.Precos?.Embalagens?.FirstOrDefault(e => e.CodigoBarrasId == lida.CodigoBarrasId && e.Fator == lida.Fator) ?? lida
            : null;

        if (agrupar && !produto.Fracionavel)
        {
            var existente = _itens.LastOrDefault(i =>
                !i.Cancelado
                && i.ProdutoId == produto.Id
                && i.CodigoBarrasId == resolvido.CodigoBarrasId
                && !i.EhKit
                && !i.EhCasco
                && OrigemPreco.Recalculavel(i.OrigemPreco)
                && i.DescontoItem == 0m);
            if (existente is not null)
            {
                var novaQuantidade = existente.Quantidade + quantidade;
                ValidarQuantidade(novaQuantidade, existente.Fracionavel);
                var devidosAntes = CascosDevidos(existente);
                existente.Quantidade = novaQuantidade;
                existente.ValorBruto = ValorBrutoValido(novaQuantidade, existente.PrecoUnitario);
                AbaterDescontadosPelosDevidos(existente, devidosAntes);
                Recalcular(ajustarDescontoTotalAoTeto: true);
                ExigirTotalNaoReduzidoComPagamento(totalAntes, "incluir itens");
                return existente;
            }
        }

        ExigirEspacoItens(1);
        var item = new ItemVenda(
            id: IdGerador.Novo(),
            sequencia: ProximaSequencia(),
            produtoId: produto.Id,
            codigoLido: codigoLido,
            codigoBarrasId: resolvido.CodigoBarrasId,
            descricao: produto.Descricao,
            unidade: produto.Unidade,
            fracionavel: produto.Fracionavel,
            quantidade: quantidade,
            precoTabela: registrado.Produto.PrecoBase,
            precoUnitario: registrado.Produto.PrecoBase,
            origemPreco: registrado.Produto.Precos?.PrecoVendaLoja is not null ? OrigemPreco.Loja : OrigemPreco.Varejo,
            valorBruto: ValorBrutoValido(quantidade, registrado.Produto.PrecoBase),
            descontoItem: 0m,
            incluidoEm: agora,
            origemEntrada: origemEntrada)
        {
            Embalagem = embalagem,
            PrecoVarejo = registrado.Produto.PrecoBase,
        };
        _itens.Add(item);
        AbaterDescontadosPelosDevidos(item, 0m);
        Recalcular(ajustarDescontoTotalAoTeto: true);
        ExigirTotalNaoReduzidoComPagamento(totalAntes, "incluir itens");
        return item;
    }

    /// <summary>
    /// Inclui um combo (kit, PDV 10.9.1): uma linha por posição com o produto escolhido, <c>quantidade =
    /// kit_quantidade × quantidade da posição</c> e o preço do combo (regra 11.3 do kit + acréscimos das alternativas)
    /// rateado pelo preço de varejo dos componentes escolhidos.
    /// </summary>
    /// <param name="escolhas">Índice da opção escolhida em cada posição (0 = padrão), na ordem de <see cref="ComboResolvido.Posicoes"/>.</param>
    public IReadOnlyList<ItemVenda> AdicionarCombo(
        ComboResolvido combo,
        IReadOnlyList<int> escolhas,
        decimal quantidadeCombos,
        string? codigoLido,
        DateTimeOffset agora,
        string? origemEntrada = null) =>
        Atomico(() => AdicionarComboInterno(combo, escolhas, quantidadeCombos, codigoLido, agora, origemEntrada));

    private IReadOnlyList<ItemVenda> AdicionarComboInterno(
        ComboResolvido combo,
        IReadOnlyList<int> escolhas,
        decimal quantidadeCombos,
        string? codigoLido,
        DateTimeOffset agora,
        string? origemEntrada)
    {
        ArgumentNullException.ThrowIfNull(combo);
        ArgumentNullException.ThrowIfNull(escolhas);
        ExigirStatus(StatusVenda.EmAndamento, "incluir itens");
        var kit = combo.Kit;
        ValidarVendavel(kit);
        if (!kit.EhKit || combo.Posicoes.Count == 0)
        {
            throw new RegraNegocioException($"{kit.Descricao} não tem composição de combo — procure o gerente.");
        }

        if (escolhas.Count != combo.Posicoes.Count)
        {
            throw new ArgumentException("Uma escolha por posição do combo.", nameof(escolhas));
        }

        ValidarQuantidade(quantidadeCombos, fracionavel: false);
        ExigirEspacoItens(combo.Posicoes.Count);

        var opcoes = new List<OpcaoCombo>();
        for (var i = 0; i < combo.Posicoes.Count; i++)
        {
            var posicao = combo.Posicoes[i];
            var indice = escolhas[i];
            if (indice < 0 || indice >= posicao.Opcoes.Count)
            {
                throw new RegraNegocioException($"Escolha uma opção para \"{posicao.Rotulo}\".");
            }

            var opcao = posicao.Opcoes[indice];
            if (!opcao.Disponivel)
            {
                throw new RegraNegocioException($"{opcao.Produto.Descricao} indisponível{(opcao.Motivo is null ? string.Empty : $" ({opcao.Motivo})")}.");
            }

            ValidarComponente(opcao.Produto);
            if (opcao.Produto.EhKit)
            {
                throw new RegraNegocioException("Combo dentro de combo não é permitido — procure o gerente.");
            }

            if (MotivoComponenteProibido(opcao.Produto) is { } motivo)
            {
                throw new RegraNegocioException($"{opcao.Produto.Descricao}: {motivo} — procure o gerente.");
            }

            if (opcao.Acrescimo < 0m || !Arredondamento.CabeEm(opcao.Acrescimo, Arredondamento.CasasPreco))
            {
                throw new RegraNegocioException("Acréscimo da alternativa inválido — procure o gerente.");
            }

            opcoes.Add(opcao);
        }

        var precoKit = PrecoKit(kit, agora);
        var precoUnitarioCombo = precoKit + opcoes.Sum(o => o.Acrescimo);
        var valorGrupo = Arredondamento.Arred2(quantidadeCombos * precoUnitarioCombo);
        var quantidades = combo.Posicoes.Select(p => quantidadeCombos * p.Quantidade).ToList();
        for (var i = 0; i < quantidades.Count; i++)
        {
            ValidarQuantidade(quantidades[i], opcoes[i].Produto.Fracionavel);
        }

        var valores = RateioCombo.Distribuir(
            valorGrupo,
            opcoes.Select((o, i) => new PesoComponente(o.Produto.PrecoBase * quantidades[i], quantidades[i])).ToList());

        var totalAntes = Total;
        var grupoId = IdGerador.Novo();
        var linhas = new List<ItemVenda>();
        for (var i = 0; i < opcoes.Count; i++)
        {
            var opcao = opcoes[i];

            // A linha do combo não é recalculada, mas o snapshot do componente vale para a recuperação e para uma
            // inclusão avulsa posterior do mesmo produto (primeira inclusão, 11.3).
            Registrar(opcao.Produto, agora);
            var precoUnitario = Arredondamento.Arred4(valores[i] / quantidades[i]);
            var linha = new ItemVenda(
                id: IdGerador.Novo(),
                sequencia: ProximaSequencia(),
                produtoId: opcao.Produto.Id,
                codigoLido: codigoLido,
                codigoBarrasId: null,
                descricao: opcao.Produto.Descricao,
                unidade: opcao.Produto.Unidade,
                fracionavel: opcao.Produto.Fracionavel,
                quantidade: quantidades[i],
                precoTabela: precoUnitario,
                precoUnitario: precoUnitario,
                origemPreco: OrigemPreco.KitRateio,
                valorBruto: valores[i],
                descontoItem: 0m,
                incluidoEm: agora,
                origemEntrada: origemEntrada,
                kit: new DadosKit(
                    grupoId, kit.Id, kit.Descricao, quantidadeCombos, precoUnitarioCombo,
                    combo.Posicoes[i].ComponenteId, opcao.AlternativaId, opcao.Acrescimo))
            {
                PrecoVarejo = opcao.Produto.PrecoBase,
            };
            _itens.Add(linha);
            linhas.Add(linha);
        }

        Recalcular(ajustarDescontoTotalAoTeto: true);
        ExigirTotalNaoReduzidoComPagamento(totalAntes, "incluir itens");
        return linhas;
    }

    /// <summary>
    /// Preço de 1 combo sem acréscimos (10.9.1): varejo/loja/promocional do kit no instante <paramref name="agora"/> (o
    /// relógio corrigido, 30.5). O diálogo Montar combo usa a mesma função e o mesmo relógio da inclusão.
    /// </summary>
    public static decimal PrecoKit(ProdutoVenda kit, DateTimeOffset agora)
    {
        ArgumentNullException.ThrowIfNull(kit);
        return MotorPreco.PrecoSemQuantidade(kit, kit.Precos?.PromocaoVigenteEm(agora) == true).Preco;
    }

    /// <summary>Linhas (não canceladas, salvo <paramref name="incluirCanceladas"/>) do mesmo combo vendido.</summary>
    public IReadOnlyList<ItemVenda> LinhasDoCombo(Guid kitGrupoId, bool incluirCanceladas = false) =>
        _itens.Where(i => i.Kit?.GrupoId == kitGrupoId && (incluirCanceladas || !i.Cancelado)).OrderBy(i => i.Sequencia).ToList();

    /// <summary>
    /// Altera a quantidade do item. O desconto do item fica em R$; ao diminuir a quantidade o % de desconto sobe e é
    /// validado de novo contra o limite do operador (PDV 12.3: "após cada desconto").
    /// </summary>
    public void AlterarQuantidade(int sequencia, decimal quantidade, decimal limiteOperadorPct) => Atomico(() =>
    {
        ExigirStatus(StatusVenda.EmAndamento, "alterar quantidade");
        var item = ObterItemAtivo(sequencia);
        if (item.EhKit)
        {
            throw new RegraNegocioException("Item de combo: para mudar a quantidade, cancele o combo e inclua de novo.");
        }

        if (item.EhCasco)
        {
            throw new RegraNegocioException("Item de casco: informe os cascos trazidos no item do produto cheio.");
        }

        ValidarQuantidade(quantidade, item.Fracionavel);
        ExigirMultiploDoFator(item, quantidade, "A quantidade");
        var novoBruto = ValorBrutoValido(quantidade, item.PrecoUnitario);
        if (novoBruto < item.ValorBruto)
        {
            ExigirSemPagamentos("diminuir a quantidade");
        }

        if (item.DescontoItem + item.DescontoPromocao >= novoBruto)
        {
            throw new RegraNegocioException("O desconto do item ficaria maior que o novo valor. Remova o desconto antes.");
        }

        var totalAntes = Total;
        var antes = MedirLimite(item);
        var aumentou = quantidade > item.Quantidade;
        var devidosAntes = CascosDevidos(item);
        item.Quantidade = quantidade;
        item.ValorBruto = novoBruto;
        LimitarCascosAoDevido(item);
        AbaterDescontadosPelosDevidos(item, devidosAntes);
        Recalcular(ajustarDescontoTotalAoTeto: aumentou);
        ExigirTotalNaoReduzidoComPagamento(totalAntes, "alterar a quantidade");
        ExigirLimiteMantido(antes, item, limiteOperadorPct, "diminuir a quantidade");
    });

    /// <summary>Tecla "+"/"−" sozinha: soma ou tira 1 (um fardo, na embalagem) do último item (não vale para itens fracionados).</summary>
    public ItemVenda IncrementarUltimoItem(int delta, decimal limiteOperadorPct)
    {
        if (delta is not (1 or -1))
        {
            throw new ArgumentOutOfRangeException(nameof(delta));
        }

        // O casco cobrado entra logo depois do cheio: "+"/"−" vale para o produto, não para o casco.
        var ultimo = ItensAtivos.LastOrDefault(i => !i.EhCasco) ?? throw new RegraNegocioException("Não há item para alterar a quantidade.");
        if (ultimo.Fracionavel)
        {
            throw new RegraNegocioException("Item vendido por peso/medida: use F3 para informar a quantidade.");
        }

        var passo = ultimo.Embalagem?.Fator ?? 1m;
        var nova = ultimo.Quantidade + (delta * passo);
        if (nova < passo)
        {
            throw new RegraNegocioException("A quantidade não pode ficar abaixo de 1. Use F4 para remover o item.");
        }

        AlterarQuantidade(ultimo.Sequencia, nova, limiteOperadorPct);
        return ultimo;
    }

    /// <summary>
    /// Cancela o item (PDV 13.1): a linha fica gravada como cancelada. Com <paramref name="quantidade"/> menor que a
    /// do item, cancela a linha original e cria outra com o restante (rastreabilidade); devolve a nova linha.
    /// Linha de combo cancela o combo inteiro (10.9.1); item cheio cancela o casco cobrado ligado a ele (10.12).
    /// </summary>
    public ItemVenda? CancelarItem(
        int sequencia,
        Guid operadorId,
        DateTimeOffset agora,
        decimal limiteOperadorPct,
        decimal? quantidade = null,
        string? motivo = null,
        Guid? autorizadoPorId = null) =>
        Atomico(() => CancelarItemInterno(sequencia, operadorId, agora, limiteOperadorPct, quantidade, motivo, autorizadoPorId));

    private ItemVenda? CancelarItemInterno(
        int sequencia,
        Guid operadorId,
        DateTimeOffset agora,
        decimal limiteOperadorPct,
        decimal? quantidade,
        string? motivo,
        Guid? autorizadoPorId)
    {
        ExigirStatus(StatusVenda.EmAndamento, "cancelar itens");
        var item = ObterItemAtivo(sequencia);
        ExigirSemPagamentos("cancelar itens");
        if (motivo is { Length: > 255 })
        {
            throw new RegraNegocioException("O motivo deve ter até 255 caracteres.");
        }

        if (item.Kit is { } kit)
        {
            if (quantidade is { } qk && qk != item.Quantidade)
            {
                throw new RegraNegocioException("Item de combo: o cancelamento é do combo inteiro (todas as linhas).");
            }

            var antesKit = MedirLimite(null);
            foreach (var linha in LinhasDoCombo(kit.GrupoId))
            {
                MarcarCancelado(linha, operadorId, agora, motivo, autorizadoPorId);
            }

            Recalcular();
            ExigirLimiteMantido(antesKit, null, limiteOperadorPct, "cancelar o combo");
            return null;
        }

        ItemVenda? restante = null;
        if (quantidade is { } q && q != item.Quantidade)
        {
            ValidarQuantidade(q, item.Fracionavel);
            if (q > item.Quantidade)
            {
                throw new RegraNegocioException($"O item {sequencia} tem só {NumeroBr.Quantidade(item.Quantidade)} {item.Unidade}.");
            }

            if (item.EhCasco)
            {
                throw new RegraNegocioException("Item de casco: informe os cascos trazidos no item do produto cheio.");
            }

            ExigirMultiploDoFator(item, q, "O cancelamento parcial");
            if (item.DescontoItem > 0m || item.DescontoPromocao > 0m)
            {
                throw new RegraNegocioException("Item com desconto: remova o desconto antes do cancelamento parcial.");
            }

            var sobra = item.Quantidade - q;
            var brutoSobra = ValorBrutoValido(sobra, item.PrecoUnitario);
            restante = new ItemVenda(
                id: IdGerador.Novo(),
                sequencia: ProximaSequencia(),
                produtoId: item.ProdutoId,
                codigoLido: item.CodigoLido,
                codigoBarrasId: item.CodigoBarrasId,
                descricao: item.Descricao,
                unidade: item.Unidade,
                fracionavel: item.Fracionavel,
                quantidade: sobra,
                precoTabela: item.PrecoTabela,
                precoUnitario: item.PrecoUnitario,
                origemPreco: item.OrigemPreco,
                valorBruto: brutoSobra,
                descontoItem: 0m,
                incluidoEm: agora,
                origemEntrada: item.OrigemEntrada,
                pesoDigitado: item.PesoDigitado,
                grupoPrecoQuantidadeId: item.GrupoPrecoQuantidadeId,
                quantidadeReferenciaPreco: item.QuantidadeReferenciaPreco)
            {
                Embalagem = item.Embalagem,
                PrecoVarejo = item.PrecoVarejo,
                LimiarPreco = item.LimiarPreco,
                NomeGrupoPreco = item.NomeGrupoPreco,
            };
        }

        var antes = MedirLimite(restante is null ? null : item);
        MarcarCancelado(item, operadorId, agora, motivo, autorizadoPorId);
        foreach (var casco in CascosDe(item))
        {
            // O restante (cancelamento parcial) pergunta os cascos de novo; a linha cancelada leva o casco junto.
            MarcarCancelado(casco, operadorId, agora, motivo ?? "Item do produto cheio cancelado", autorizadoPorId);
        }

        if (restante is not null)
        {
            _itens.Add(restante);
        }

        Recalcular();
        ExigirLimiteMantido(antes, restante, limiteOperadorPct, "cancelar o item");
        return restante;
    }

    private static void MarcarCancelado(ItemVenda item, Guid operadorId, DateTimeOffset agora, string? motivo, Guid? autorizadoPorId)
    {
        item.Cancelado = true;
        item.CanceladoEm = agora;
        item.CanceladoPorId = operadorId;
        item.AutorizadoPorId = autorizadoPorId ?? item.AutorizadoPorId;
        item.MotivoCancelamento = motivo;
    }

    // ---------------------------------------------------------------- vasilhames (PDV 10.12)

    /// <summary>O item é de produto cheio retornável e precisa da pergunta "Cascos trazidos".</summary>
    public bool ExigeCascos(ItemVenda item)
    {
        ArgumentNullException.ThrowIfNull(item);
        return !item.Cancelado && !item.EhKit && !item.EhCasco
               && _produtos.TryGetValue(item.ProdutoId, out var p) && p.Produto.Retornavel;
    }

    /// <summary>Cascos devidos, cobrados (itens de casco ligados) e trazidos (= devidos − cobrados) de um item cheio.</summary>
    public SituacaoCascos Cascos(int sequenciaCheio)
    {
        var cheio = ObterItem(sequenciaCheio);
        var devidos = CascosDevidos(cheio);
        var cobrados = CascosDe(cheio).Sum(c => c.Quantidade);
        return new SituacaoCascos(devidos, cobrados, Math.Max(0m, devidos - cobrados));
    }

    /// <summary>
    /// Registra os cascos trazidos para o item cheio (PDV 10.12): os faltantes viram um item do produto vasilhame ao
    /// preço do casco, ligado ao cheio por <c>vasilhame_item_origem_id</c>. Perguntar de novo (quantidade alterada)
    /// ajusta ou cancela o item de casco. Excedente (mais cascos que os devidos) é devolução avulsa, não entra aqui.
    /// </summary>
    public ItemVenda? RegistrarCascosTrazidos(int sequenciaCheio, decimal trazidos, ProdutoVenda casco, DateTimeOffset agora) =>
        Atomico(() => RegistrarCascosInterno(sequenciaCheio, trazidos, casco, agora));

    private ItemVenda? RegistrarCascosInterno(int sequenciaCheio, decimal trazidos, ProdutoVenda casco, DateTimeOffset agora)
    {
        ArgumentNullException.ThrowIfNull(casco);
        ExigirStatus(StatusVenda.EmAndamento, "registrar cascos");
        var cheio = ObterItemAtivo(sequenciaCheio);
        if (!ExigeCascos(cheio))
        {
            throw new RegraNegocioException($"O item {sequenciaCheio} não é de produto retornável.");
        }

        if (_produtos[cheio.ProdutoId].Produto.VasilhameProdutoId != casco.Id)
        {
            throw new ArgumentException("O casco informado não é o do produto cheio.", nameof(casco));
        }

        var devidos = CascosDevidos(cheio);
        if (trazidos < 0m || decimal.Truncate(trazidos) != trazidos || trazidos > devidos)
        {
            throw new RegraNegocioException(
                $"Cascos trazidos: de 0 a {NumeroBr.Quantidade(devidos).Split(',')[0]}. Cascos a mais são devolução avulsa (F11 › Vasilhames).");
        }

        var totalAntes = Total;
        var faltantes = devidos - trazidos;
        if (faltantes > 0m && _cascosDescontados.FirstOrDefault(c => c.ProdutoVasilhameId == casco.Id) is { } descontado)
        {
            // Cobrar e descontar o mesmo casco na mesma venda (C11c): os vazios a mais já estão com o cliente aqui.
            throw new RegraNegocioException(
                $"{descontado.Quantidade} casco(s) {descontado.Descricao} já descontado(s) nesta venda: use-os como trazidos " +
                $"(informe até {NumeroBr.Quantidade(devidos).Split(',')[0]}) ou tire o desconto dos cascos (F11 › Vasilhames) antes de cobrar o casco.");
        }

        var existentes = CascosDe(cheio).ToList();
        ItemVenda? linhaCasco = null;
        if (faltantes > 0m && existentes.Count > 0)
        {
            linhaCasco = existentes[0];
            linhaCasco.Quantidade = faltantes;
            linhaCasco.ValorBruto = ValorBrutoValido(faltantes, linhaCasco.PrecoUnitario);
            existentes.RemoveAt(0);
        }
        else if (faltantes > 0m)
        {
            // Snapshot do casco (primeira inclusão, 11.3): a mesma regra das demais linhas.
            var registrado = Registrar(casco, agora);
            var produtoCasco = registrado.Produto;
            if (produtoCasco.PrecoBase <= 0m)
            {
                // Casco cobrado é um item; item de R$ 0,00 não entra (decisão 18).
                throw new RegraNegocioException(
                    $"Casco {casco.Descricao} sem preço: não é possível cobrar os cascos faltantes — procure o gerente.");
            }

            ValidarVendavel(produtoCasco);
            var preco = MotorPreco.PrecoSemQuantidade(produtoCasco, registrado.PromocaoVigente);
            ExigirEspacoItens(1);
            linhaCasco = new ItemVenda(
                id: IdGerador.Novo(),
                sequencia: ProximaSequencia(),
                produtoId: casco.Id,
                codigoLido: null,
                codigoBarrasId: null,
                descricao: casco.Descricao,
                unidade: casco.Unidade,
                fracionavel: false,
                quantidade: faltantes,
                precoTabela: preco.Preco,
                precoUnitario: preco.Preco,
                origemPreco: preco.Origem,
                valorBruto: ValorBrutoValido(faltantes, preco.Preco),
                descontoItem: 0m,
                incluidoEm: agora,
                vasilhameItemOrigemId: cheio.Id)
            {
                PrecoVarejo = produtoCasco.PrecoBase,
            };
            _itens.Add(linhaCasco);
        }

        foreach (var sobra in existentes)
        {
            MarcarCancelado(sobra, OperadorId, agora, "Cascos devolvidos pelo cliente", null);
        }

        Recalcular(ajustarDescontoTotalAoTeto: true);
        ExigirTotalNaoReduzidoComPagamento(totalAntes, "reduzir os cascos cobrados");
        return linhaCasco;
    }

    /// <summary>
    /// Bloco <c>vasilhames</c> do <c>venda.finalizada</c> (sincronizacao.md 9.7): por casco, trazidos e cobrados. Os
    /// cascos descontados (C11c) somam nos trazidos (<c>devolvidos</c>): é por eles que a nuvem dá a entrada dos vazios.
    /// </summary>
    public IReadOnlyList<ResumoVasilhame> ResumoVasilhames()
    {
        var resumo = new Dictionary<Guid, (decimal Devolvidos, decimal Vendidos)>();
        foreach (var cheio in ItensAtivos.Where(ExigeCascos))
        {
            var cascoId = _produtos[cheio.ProdutoId].Produto.VasilhameProdutoId!.Value;
            var situacao = Cascos(cheio.Sequencia);
            var atual = resumo.GetValueOrDefault(cascoId);
            resumo[cascoId] = (atual.Devolvidos + situacao.Trazidos, atual.Vendidos + situacao.Cobrados);
        }

        foreach (var casco in ItensAtivos.Where(i => i.EhCasco))
        {
            // Casco cobrado de um item cheio sem snapshot (venda antiga recuperada sem o produto no espelho).
            var cheio = _itens.FirstOrDefault(i => i.Id == casco.VasilhameItemOrigemId);
            if (cheio is null || !ExigeCascos(cheio))
            {
                var atual = resumo.GetValueOrDefault(casco.ProdutoId);
                resumo[casco.ProdutoId] = (atual.Devolvidos, atual.Vendidos + casco.Quantidade);
            }
        }

        foreach (var descontado in _cascosDescontados)
        {
            var atual = resumo.GetValueOrDefault(descontado.ProdutoVasilhameId);
            resumo[descontado.ProdutoVasilhameId] = (atual.Devolvidos + descontado.Quantidade, atual.Vendidos);
        }

        return resumo
            .Where(r => r.Value.Devolvidos > 0m || r.Value.Vendidos > 0m)
            .Select(r => new ResumoVasilhame(r.Key, r.Value.Devolvidos, r.Value.Vendidos, 0m, null))
            .OrderBy(r => r.ProdutoVasilhameId)
            .ToList();
    }

    /// <summary>Quantidade aceita no desconto pelos cascos: inteira, de 0 (tira o desconto) a 9.999.</summary>
    public const int MaximoCascosDescontados = 9_999;

    public const string MensagemQuantidadeCascosDescontados =
        "Informe os cascos a descontar: de 0 (tira o desconto deste casco) a 9.999, sem fração.";

    /// <summary>
    /// Desconto na venda atual pelo valor do casco (PDV 10.12, devolução avulsa; O14 do dono; Fase 1C, C11c): o cliente
    /// trouxe <paramref name="quantidade"/> cascos vazios do <paramref name="casco"/> além dos devidos pela venda. Vale
    /// quantidade × preço do casco (o de varejo da 11.3, sem atacado, fixado na primeira vez) no <c>desconto_total</c> de
    /// origem <c>cliente</c>, fora do limite do operador, e os vazios entram pelo bloco <c>vasilhames</c>. A permissão e o
    /// teto sem supervisor são do serviço (README › decisão 56); com a <paramref name="liberacao"/>, a venda ganha a linha
    /// <c>desconto_cascos</c> de <c>liberacoes</c>. A quantidade substitui a anterior do mesmo casco; 0 tira o desconto
    /// dele. Recusa: venda sem item ou com pagamento, casco sem preço, o mesmo casco ainda cobrado num item cheio (os
    /// trazidos vêm antes) e o crédito que, somado ao desconto no total do operador, passaria do total da venda (cada item
    /// fica com ao menos R$ 0,01: o operador reduz o desconto dele, F6 › 4, ou registra o resto só como entrada dos vazios).
    /// </summary>
    /// <returns>O casco descontado; nulo quando a quantidade 0 tirou o desconto.</returns>
    public CascoDescontado? DescontarCascos(ProdutoVenda casco, int quantidade, DateTimeOffset agora, Liberacao? liberacao = null) =>
        Atomico<CascoDescontado?>(() =>
    {
        ArgumentNullException.ThrowIfNull(casco);
        ExigirStatus(StatusVenda.EmAndamento, "descontar cascos");
        if (casco.Tipo != TipoProduto.Vasilhame)
        {
            throw new RegraNegocioException($"{casco.Descricao} não é um casco vazio (produto do tipo vasilhame).");
        }

        if (quantidade is < 0 or > MaximoCascosDescontados)
        {
            throw new RegraNegocioException(MensagemQuantidadeCascosDescontados);
        }

        ExigirSemPagamentos("descontar cascos");
        var anterior = _cascosDescontados.FindIndex(c => c.ProdutoVasilhameId == casco.Id);
        if (quantidade == 0)
        {
            if (anterior < 0)
            {
                throw new RegraNegocioException($"Nenhum casco {casco.Descricao} descontado nesta venda.");
            }

            _cascosDescontados.RemoveAt(anterior);
            Recalcular();
            return null;
        }

        var ativos = ItensAtivos.ToList();
        if (ativos.Count == 0)
        {
            throw new RegraNegocioException("Inclua os itens da venda antes de descontar os cascos.");
        }

        var cobrados = ativos.Where(i => i.EhCasco && i.ProdutoId == casco.Id).Sum(i => i.Quantidade);
        if (cobrados > 0m)
        {
            throw new RegraNegocioException(
                $"{cobrados:0} casco(s) {casco.Descricao} cobrado(s) nesta venda: informe primeiro os cascos trazidos no item " +
                "(até não cobrar nenhum); o desconto é só para os cascos além dos devidos.");
        }

        var preco = PrecoCascoDescontado(casco, agora);
        if (preco <= 0m)
        {
            throw new RegraNegocioException(
                $"Casco {casco.Descricao} sem preço: não é possível descontar — registre só a entrada dos vazios ou procure o gerente.");
        }

        var descontado = new CascoDescontado(
            casco.Id, casco.Descricao, quantidade, preco, anterior >= 0 ? _cascosDescontados[anterior].RegistradoEm : agora);
        if (anterior >= 0)
        {
            _cascosDescontados[anterior] = descontado;
        }
        else
        {
            _cascosDescontados.Add(descontado);
            // A mesma ordem da venda recuperada (Restaurar): a do registro e, no mesmo instante, a do casco.
            _cascosDescontados.Sort((a, b) =>
                a.RegistradoEm != b.RegistradoEm ? a.RegistradoEm.CompareTo(b.RegistradoEm) : a.ProdutoVasilhameId.CompareTo(b.ProdutoVasilhameId));
        }

        var maximo = Rateio.DescontoMaximo(BasesRateio(ativos));
        if (DescontoCascos + _descontoTotalOperador > maximo)
        {
            // A ordem inversa (cascos antes, operador depois) é recusada no AplicarDescontoTotal; aqui também, para o
            // Recalcular não tirar em silêncio o desconto do operador (liberado ou não) com o crédito dos cascos.
            throw new RegraNegocioException(_descontoTotalOperador > 0m
                ? $"O desconto dos cascos (R$ {NumeroBr.Dinheiro(DescontoCascos)}) não cabe com o desconto no total de R$ " +
                  $"{NumeroBr.Dinheiro(_descontoTotalOperador)}: cabem até R$ {NumeroBr.Dinheiro(Math.Max(0m, maximo - _descontoTotalOperador))} " +
                  "em cascos. Reduza ou tire o desconto no total (F6 › 4) ou registre o resto só como entrada dos vazios."
                : $"O desconto dos cascos (R$ {NumeroBr.Dinheiro(DescontoCascos)}) passaria do total da venda (no máximo R$ " +
                  $"{NumeroBr.Dinheiro(Math.Max(0m, maximo))}): desconte menos cascos e registre o resto só como entrada dos vazios.");
        }

        Recalcular();
        if (liberacao is not null)
        {
            RegistrarLiberacao(liberacao, AcaoLiberacao.DescontoCascos, null, null);
        }

        return descontado;
    });

    /// <summary>
    /// Crédito de todos os cascos descontados se o <paramref name="casco"/> ficar com <paramref name="quantidade"/>: o
    /// serviço compara com o teto sem supervisor antes de descontar (a regra completa continua no
    /// <see cref="DescontarCascos"/>).
    /// </summary>
    public decimal DescontoCascosCom(ProdutoVenda casco, int quantidade, DateTimeOffset agora)
    {
        ArgumentNullException.ThrowIfNull(casco);
        var outros = _cascosDescontados.Where(c => c.ProdutoVasilhameId != casco.Id).Sum(c => c.Valor);
        return outros + Arredondamento.Arred2(Math.Max(0, quantidade) * PrecoCascoDescontado(casco, agora));
    }

    /// <summary>Preço do casco descontado: o da primeira vez nesta venda (snapshot, 11.3) ou o de varejo de agora.</summary>
    private decimal PrecoCascoDescontado(ProdutoVenda casco, DateTimeOffset agora) =>
        _cascosDescontados.FirstOrDefault(c => c.ProdutoVasilhameId == casco.Id) is { } anterior
            ? anterior.PrecoUnitario
            : MotorPreco.PrecoSemQuantidade(casco, casco.Precos?.PromocaoVigenteEm(agora) == true).Preco;

    /// <summary>
    /// Cheio retornável incluído ou aumentado depois do desconto pelos cascos (C11c): os vazios já descontados do mesmo
    /// casco estão no balcão e cobrem primeiro os novos devidos — passam a trazidos do item, e o desconto diminui. Sem
    /// isso, o "Cascos trazidos" (que só aceita todos os devidos com o casco descontado) contaria os mesmos vazios duas
    /// vezes. Se o cliente trouxe outros vazios, o operador desconta de novo no F11 › V.
    /// </summary>
    private void AbaterDescontadosPelosDevidos(ItemVenda cheio, decimal devidosAntes)
    {
        if (!ExigeCascos(cheio) || _produtos[cheio.ProdutoId].Produto.VasilhameProdutoId is not { } cascoId)
        {
            return;
        }

        var indice = _cascosDescontados.FindIndex(c => c.ProdutoVasilhameId == cascoId);
        var novos = CascosDevidos(cheio) - devidosAntes;
        if (indice < 0 || novos <= 0m)
        {
            return;
        }

        var descontado = _cascosDescontados[indice];
        var movidos = (int)Math.Min(descontado.Quantidade, novos);
        var resto = descontado.Quantidade - movidos;
        if (resto == 0)
        {
            _cascosDescontados.RemoveAt(indice);
        }
        else
        {
            _cascosDescontados[indice] = descontado with { Quantidade = resto };
        }

        _avisos.Add(
            $"{movidos} casco(s) {descontado.Descricao} já descontado(s) nesta venda passaram a trazidos do item {cheio.Sequencia}" +
            (resto == 0
                ? " (desconto dos cascos retirado)."
                : $" (ficam {resto} no desconto, R$ {NumeroBr.Dinheiro(_cascosDescontados[indice].Valor)}).") +
            " Se o cliente trouxe outros vazios, desconte-os de novo (F11 › Vasilhames).");
    }

    private IEnumerable<ItemVenda> CascosDe(ItemVenda cheio) =>
        _itens.Where(i => !i.Cancelado && i.VasilhameItemOrigemId == cheio.Id).OrderBy(i => i.Sequencia);

    private decimal CascosDevidos(ItemVenda cheio) =>
        _produtos.TryGetValue(cheio.ProdutoId, out var p) && p.Produto.VasilhameQuantidade is { } vq
            ? decimal.Ceiling(cheio.Quantidade * vq)
            : CascosDe(cheio).Sum(c => c.Quantidade);

    /// <summary>Ao diminuir o cheio, o casco cobrado nunca passa do devido (a tela pergunta os trazidos de novo).</summary>
    private void LimitarCascosAoDevido(ItemVenda cheio)
    {
        if (!ExigeCascos(cheio))
        {
            return;
        }

        // Há no máximo uma linha de casco por item cheio (RegistrarCascosTrazidos); devidos ≥ 1 com quantidade > 0.
        var devidos = CascosDevidos(cheio);
        if (CascosDe(cheio).FirstOrDefault() is { } casco && casco.Quantidade > devidos)
        {
            casco.Quantidade = devidos;
            casco.ValorBruto = ValorBrutoValido(devidos, casco.PrecoUnitario);
        }
    }

    // ---------------------------------------------------------------- preço (PDV 11.3)

    /// <summary>Dica "Faltam N para o preço de atacado…" do item (informativa, PDV 11.3.1); nulo se não há.</summary>
    public DicaFaixa? DicaPreco(ItemVenda item)
    {
        ArgumentNullException.ThrowIfNull(item);
        if (item.Cancelado || !ContaParaPreco(item) || !_produtos.TryGetValue(item.ProdutoId, out var registrado))
        {
            return null;
        }

        var (porProduto, porGrupo) = QuantidadesDeReferencia();
        var grupo = registrado.Produto.Precos?.GrupoAtivo;
        return MotorPreco.ProximaFaixa(
            registrado.Produto,
            registrado.PromocaoVigente,
            porProduto.GetValueOrDefault(item.ProdutoId),
            grupo is null ? null : porGrupo.GetValueOrDefault(grupo.Id),
            Parametros);
    }

    /// <summary>Σ economia em relação ao varejo nas linhas de atacado/faixa/mix ("Economia atacado: R$ 3,60").</summary>
    public decimal EconomiaAtacado => ItensAtivos.Sum(i => i.EconomiaAtacado);

    private ParametrosPreco Parametros => new(LojaId, _usaPrecoVolume, TipoPreco);

    /// <summary>
    /// Registra o snapshot na primeira inclusão do produto (PDV 11.3). Uma embalagem lida depois e que não estava no
    /// snapshot (código cadastrado no meio da venda) entra nele, para a recuperação reconhecer a linha do fardo.
    /// </summary>
    private ProdutoRegistrado Registrar(ProdutoVenda produto, DateTimeOffset agora, EmbalagemPreco? embalagem = null)
    {
        if (!_produtos.TryGetValue(produto.Id, out var registrado))
        {
            registrado = new ProdutoRegistrado(produto, produto.Precos?.PromocaoVigenteEm(agora) == true);
            _produtos[produto.Id] = registrado;
        }

        var tabela = registrado.Produto.Precos ?? new TabelaPreco();
        if (embalagem is not null && tabela.Embalagens?.Any(e => e.CodigoBarrasId == embalagem.CodigoBarrasId) != true)
        {
            registrado = registrado with
            {
                Produto = registrado.Produto with { Precos = tabela with { Embalagens = [.. tabela.Embalagens ?? [], embalagem] } },
            };
            _produtos[produto.Id] = registrado;
        }

        return registrado;
    }

    /// <summary>Linhas que somam na quantidade de referência: não contam combo, casco (11.3.1) nem orçamento.</summary>
    private static bool ContaParaPreco(ItemVenda item) => !item.EhKit && !item.EhCasco;

    private (Dictionary<Guid, decimal> PorProduto, Dictionary<Guid, decimal> PorGrupo) QuantidadesDeReferencia()
    {
        var porProduto = new Dictionary<Guid, decimal>();
        var porGrupo = new Dictionary<Guid, decimal>();
        foreach (var item in ItensAtivos.Where(ContaParaPreco))
        {
            porProduto[item.ProdutoId] = porProduto.GetValueOrDefault(item.ProdutoId) + item.Quantidade;
            if (_produtos.TryGetValue(item.ProdutoId, out var p) && p.Produto.Precos?.GrupoAtivo is { } grupo)
            {
                porGrupo[grupo.Id] = porGrupo.GetValueOrDefault(grupo.Id) + item.Quantidade;
            }
        }

        return (porProduto, porGrupo);
    }

    private PrecoResolvido Resolver(ProdutoRegistrado registrado, ItemVenda item, Dictionary<Guid, decimal> porProduto, Dictionary<Guid, decimal> porGrupo)
    {
        var grupo = registrado.Produto.Precos?.GrupoAtivo;
        return MotorPreco.Resolver(
            registrado.Produto,
            registrado.PromocaoVigente,
            porProduto.GetValueOrDefault(item.ProdutoId),
            grupo is null ? null : porGrupo.GetValueOrDefault(grupo.Id),
            item.Embalagem,
            Parametros);
    }

    /// <summary>
    /// Regra 11.3 em todas as linhas afetadas (11.3.1 "Recalcular"): a 12ª lata faz as 12 passarem ao atacado e
    /// cancelar uma volta todas ao varejo. Preço manual, balança tipo Valor, orçamento, combo e casco não mudam.
    /// </summary>
    private void Reprecificar()
    {
        if (_produtos.Count == 0)
        {
            return;
        }

        var (porProduto, porGrupo) = QuantidadesDeReferencia();
        foreach (var item in ItensAtivos.Where(i => ContaParaPreco(i) && !i.PrecoFixado && OrigemPreco.Recalculavel(i.OrigemPreco)).ToList())
        {
            if (!_produtos.TryGetValue(item.ProdutoId, out var registrado))
            {
                continue;
            }

            AplicarPreco(item, Resolver(registrado, item, porProduto, porGrupo));
        }
    }

    private void AplicarPreco(ItemVenda item, PrecoResolvido r)
    {
        decimal preco;
        decimal bruto;
        if (r.Origem == OrigemPreco.Embalagem && item.Embalagem is { Preco: { } precoEmbalagem } embalagem)
        {
            // Preço da embalagem é autoritativo (10.2): valor = arred2(preço × multiplicador); unitário com 4 casas.
            bruto = Arredondamento.Arred2(precoEmbalagem * (item.Quantidade / embalagem.Fator));
            preco = Arredondamento.Arred4(bruto / item.Quantidade);
        }
        else
        {
            preco = r.Preco;
            bruto = ValorBrutoValido(item.Quantidade, preco);
        }

        if (bruto != item.ValorBruto)
        {
            AjustarDescontoAoNovoValor(item, bruto, Arredondamento.Arred2(item.Quantidade * preco));
        }

        item.PrecoTabela = preco;
        item.PrecoUnitario = preco;
        item.ValorBruto = bruto;
        item.OrigemPreco = r.Origem;
        item.QuantidadeReferenciaPreco = r.QuantidadeReferencia;
        item.GrupoPrecoQuantidadeId = r.GrupoId;
        item.PrecoVarejo = r.PrecoVarejo;
        item.LimiarPreco = r.Limiar;
        item.NomeGrupoPreco = r.GrupoNome;
    }

    /// <summary>
    /// Preço mudou (11.3.1, "Desconto no item"): desconto em % é reaplicado; em R$ é mantido e limitado ao novo
    /// <c>valor_bruto − 0,01</c>, com aviso. O R$ também não pode passar do teto aceito (limite do operador ou % liberado,
    /// decisão 27): a 12ª lata que derruba o preço ao atacado não faz um desconto de 9,98% virar 10,91% sem supervisor.
    /// </summary>
    private void AjustarDescontoAoNovoValor(ItemVenda item, decimal novoBruto, decimal novoValorTabela)
    {
        if (item.DescontoItem <= 0m)
        {
            return;
        }

        var maximo = novoBruto - item.DescontoPromocao - Arredondamento.Centavo;
        var novo = item.DescontoItemPct is { } pct ? Arredondamento.ValorDoPercentual(novoBruto, pct) : item.DescontoItem;
        if (item.DescontoItemPct is null && item.TetoDescontoPct is { } teto)
        {
            var pelaRegra = Arredondamento.Truncar2(novoValorTabela * teto / 100m);
            if (novo > pelaRegra)
            {
                maximo = Math.Min(maximo, pelaRegra);
            }
        }

        if (novo > maximo)
        {
            novo = Math.Max(0m, maximo);
            _avisos.Add(novo > 0m
                ? $"Desconto do item {item.Sequencia} ajustado para R$ {NumeroBr.Dinheiro(novo)}: o preço do item mudou."
                : $"Desconto do item {item.Sequencia} removido: o preço do item mudou.");
        }

        item.DescontoItem = novo;
        if (novo == 0m)
        {
            item.DescontoItemPct = null;
            item.TetoDescontoPct = null;
        }
    }

    /// <summary>Item avulso, kit e casco: ativo, vendável e com preço &gt; 0 (PDV 10.1).</summary>
    private static void ValidarVendavel(ProdutoVenda produto)
    {
        ValidarComponente(produto);
        if (produto.PrecoBase <= 0m)
        {
            throw new RegraNegocioException($"Produto sem preço — procure o supervisor ({produto.Descricao}).");
        }
    }

    /// <summary>
    /// Componente ou alternativa de combo (10.9.1): ativo, vendável e preço ≥ 0 com até 4 casas. Preço 0 é permitido
    /// ("GELO BRINDE"): o componente só não pesa no rateio (todos 0 = rateio pela quantidade) e o mínimo de R$ 0,01 por
    /// linha do <see cref="RateioCombo"/> continua valendo.
    /// </summary>
    private static void ValidarComponente(ProdutoVenda produto)
    {
        if (!produto.Ativo)
        {
            throw new RegraNegocioException($"Produto inativo — não pode ser vendido ({produto.Descricao}).");
        }

        if (!produto.Vendavel)
        {
            throw new RegraNegocioException($"Produto não é vendável no PDV ({produto.Descricao}).");
        }

        if (produto.PrecoBase < 0m)
        {
            throw new RegraNegocioException($"Produto com preço negativo — procure o gerente ({produto.Descricao}).");
        }

        if (!Arredondamento.CabeEm(produto.PrecoBase, Arredondamento.CasasPreco))
        {
            throw new RegraNegocioException("Preço do produto com mais de 4 casas decimais — procure o gerente.");
        }
    }

    /// <summary>
    /// Componentes que a Fase 1 não vende dentro de combo (decisão 23): o retornável (a linha do kit não pergunta nem
    /// cobra cascos) e o produzido (sem estoque próprio; o <c>componentes_estoque</c> da ficha técnica ainda não é
    /// preenchido). O ERP recusa no cadastro; aqui é a defesa para cadastros antigos/importados. Nulo = permitido.
    /// </summary>
    public static string? MotivoComponenteProibido(ProdutoVenda produto)
    {
        ArgumentNullException.ThrowIfNull(produto);
        if (produto.VasilhameProdutoId is not null)
        {
            return "produto retornável não pode ser componente de combo";
        }

        return produto.Tipo == TipoProduto.Produzido ? "produto produzido (ficha técnica) não pode ser componente de combo" : null;
    }

    private static void ExigirMultiploDoFator(ItemVenda item, decimal quantidade, string oQue)
    {
        if (item.Embalagem is { Fator: > 1m } e && quantidade % e.Fator != 0m)
        {
            throw new RegraNegocioException(
                $"{oQue} do item {item.Sequencia} deve ser em múltiplos de {e.Fator:0.###} (embalagem {e.Sigla ?? "EMB"} com {e.Fator:0.###}).");
        }
    }

    private void ExigirEspacoItens(int novos)
    {
        if (_itens.Count + novos > MaximoItens)
        {
            throw new RegraNegocioException($"Limite de {MaximoItens} itens por venda atingido. Finalize esta venda e abra outra.");
        }
    }

    private int ProximaSequencia() => _itens.Count == 0 ? 1 : _itens.Max(i => i.Sequencia) + 1;

    /// <summary>
    /// Com pagamento lançado, o total não pode cair (README, decisão 8): o recálculo do atacado (a 12ª lata) também
    /// reduz o total, então a operação é desfeita e o operador remove o pagamento antes.
    /// </summary>
    private void ExigirTotalNaoReduzidoComPagamento(decimal totalAntes, string acao)
    {
        if (Total < totalAntes)
        {
            ExigirSemPagamentos(acao);
        }
    }

    // ---------------------------------------------------------------- descontos

    /// <summary>Desconto no item (PDV 12.2): substitui o desconto anterior do item. Valida o limite do operador (12.3).</summary>
    public ResultadoDesconto AplicarDescontoItem(int sequencia, Desconto desconto, decimal limiteOperadorPct, Liberacao? liberacao = null)
    {
        ArgumentNullException.ThrowIfNull(desconto);
        ExigirStatus(StatusVenda.EmAndamento, "dar desconto");
        var item = ObterItemAtivo(sequencia);
        ExigirSemPagamentos("dar desconto");
        if (item.Kit is { } kit)
        {
            return AplicarDescontoCombo(item, kit, desconto, limiteOperadorPct, liberacao);
        }

        var maximo = item.ValorBruto - item.DescontoPromocao;
        var valor = desconto.ValorSobre(item.ValorBruto);
        if (valor <= 0m || valor >= maximo)
        {
            throw new RegraNegocioException(
                $"O desconto do item deve ser maior que zero e menor que R$ {NumeroBr.Dinheiro(maximo)}.");
        }

        // Só o % digitado tem a folga do arredondamento: 10% de 0,99 vira 0,10 (10,10%) e continua dentro de 10%.
        var arredondaAgora = desconto.Tipo == TipoDesconto.Percentual ? 1 : 0;
        var ativos = ItensAtivos.ToList();
        var medidaItem = new MedidaDesconto(valor + item.ReducaoPrecoManual, item.ValorTabela, arredondaAgora);
        var medidaVenda = new MedidaDesconto(
            ativos.Sum(i => i.Sequencia == sequencia ? valor : i.DescontoItem) + ativos.Sum(i => i.ReducaoPrecoManual) + DescontoTotalDoOperador,
            ativos.Sum(i => i.ValorTabela),
            ativos.Count(i => i.Sequencia != sequencia && i.DescontoItem > 0m) + (DescontoTotalDoOperador > 0m ? 1 : 0) + arredondaAgora);

        var resultado = AvaliarLimite([medidaItem, medidaVenda], valor, limiteOperadorPct, liberacao);
        if (!resultado.Aplicado)
        {
            return resultado;
        }

        Atomico(() =>
        {
            item.DescontoItem = valor;
            item.DescontoItemPct = desconto.Tipo == TipoDesconto.Percentual ? desconto.Valor : null;
            item.TetoDescontoPct = Math.Max(limiteOperadorPct, medidaItem.Percentual);
            AceitarNoTetoDoTotal(medidaVenda);
            if (resultado.PorLiberacao)
            {
                item.AutorizadoPorId = liberacao!.SupervisorId;
            }

            Recalcular();
            // Por último: nada que ainda possa falhar vem depois (o Reverter também a desfaz).
            if (resultado.PorLiberacao)
            {
                RegistrarLiberacao(liberacao!, AcaoLiberacao.DescontoItem, item.Id, resultado.PercentualPedido);
            }
        });
        return resultado;
    }

    /// <summary>Um desconto de item aceito (no limite ou liberado) também passa a valer no teto do desconto no total em R$.</summary>
    private void AceitarNoTetoDoTotal(MedidaDesconto medidaVenda)
    {
        if (_tetoDescontoTotalPct is { } teto)
        {
            _tetoDescontoTotalPct = Math.Max(teto, medidaVenda.Percentual);
        }
    }

    public void RemoverDescontoItem(int sequencia) => Atomico(() =>
    {
        ExigirStatus(StatusVenda.EmAndamento, "remover desconto");
        var item = ObterItemAtivo(sequencia);
        var linhas = item.Kit is { } kit ? LinhasDoCombo(kit.GrupoId) : [item];
        if (linhas.All(l => l.DescontoItem == 0m))
        {
            throw new RegraNegocioException($"O item {sequencia} não tem desconto.");
        }

        foreach (var linha in linhas)
        {
            linha.DescontoItem = 0m;
            linha.DescontoItemPct = null;
            linha.TetoDescontoPct = null;
        }

        Recalcular();
    });

    /// <summary>
    /// Desconto de item numa linha de combo (10.9.1): vale para o combo inteiro (o valor do combo) e é rateado entre
    /// as linhas pelo <c>valor_bruto</c>, com o algoritmo da 12.4 (nenhuma linha com líquido zero).
    /// </summary>
    private ResultadoDesconto AplicarDescontoCombo(ItemVenda escolhido, DadosKit kit, Desconto desconto, decimal limiteOperadorPct, Liberacao? liberacao)
    {
        var linhas = LinhasDoCombo(kit.GrupoId);
        var bases = linhas.Select(l => new BaseRateio(l.Sequencia, l.ValorBruto - l.DescontoPromocao)).ToList();
        var valorCombo = linhas.Sum(l => l.ValorBruto);
        var valor = desconto.ValorSobre(valorCombo);
        var maximo = Rateio.DescontoMaximo(bases);
        if (valor <= 0m || valor > maximo)
        {
            throw new RegraNegocioException(
                $"O desconto do combo deve ser maior que zero e no máximo R$ {NumeroBr.Dinheiro(Math.Max(0m, maximo))}.");
        }

        var doGrupo = linhas.Select(l => l.Sequencia).ToHashSet();
        var arredondaAgora = desconto.Tipo == TipoDesconto.Percentual ? 1 : 0;
        var ativos = ItensAtivos.ToList();
        var medidaItem = new MedidaDesconto(valor, valorCombo, arredondaAgora);
        var medidaVenda = new MedidaDesconto(
            ativos.Where(i => !doGrupo.Contains(i.Sequencia)).Sum(i => i.DescontoItem) + valor + ativos.Sum(i => i.ReducaoPrecoManual) + DescontoTotalDoOperador,
            ativos.Sum(i => i.ValorTabela),
            ativos.Count(i => !doGrupo.Contains(i.Sequencia) && i.DescontoItem > 0m) + (DescontoTotalDoOperador > 0m ? 1 : 0) + arredondaAgora);
        var resultado = AvaliarLimite([medidaItem, medidaVenda], valor, limiteOperadorPct, liberacao);
        if (!resultado.Aplicado)
        {
            return resultado;
        }

        Atomico(() =>
        {
            var partes = Rateio.Distribuir(bases, valor, TipoRateio.Desconto);
            AceitarNoTetoDoTotal(medidaVenda);
            foreach (var linha in linhas)
            {
                linha.DescontoItem = partes[linha.Sequencia];
                linha.DescontoItemPct = null;
                if (resultado.PorLiberacao)
                {
                    linha.AutorizadoPorId = liberacao!.SupervisorId;
                }
            }

            Recalcular();
            if (resultado.PorLiberacao)
            {
                RegistrarLiberacao(liberacao!, AcaoLiberacao.DescontoItem, escolhido.Id, resultado.PercentualPedido);
            }
        });
        return resultado;
    }

    /// <summary>
    /// Desconto no total (PDV 12.2): substitui o anterior; em % é recalculado quando os itens mudam, em R$ fica fixo.
    /// Limite: Σ(valor_bruto − desconto_item − desconto_promocao) menos R$ 0,01 por item (nenhum item com líquido zero).
    /// </summary>
    public ResultadoDesconto AplicarDescontoTotal(Desconto desconto, decimal limiteOperadorPct, Liberacao? liberacao = null)
    {
        ArgumentNullException.ThrowIfNull(desconto);
        if (Status is not (StatusVenda.EmAndamento or StatusVenda.EmPagamento))
        {
            throw new RegraNegocioException("A venda não aceita desconto neste momento.");
        }

        ExigirSemPagamentos("dar desconto no total");
        var ativos = ItensAtivos.ToList();
        if (ativos.Count == 0)
        {
            throw new RegraNegocioException("Inclua itens antes de dar desconto no total.");
        }

        var bases = BasesRateio(ativos);
        var valor = desconto.ValorSobre(bases.Sum(b => b.Base));
        // O crédito dos cascos descontados (C11c) já ocupa parte do total: o do operador vem por cima dele.
        var maximo = Rateio.DescontoMaximo(bases) - DescontoCascos;
        if (valor <= 0m || valor > maximo)
        {
            throw new RegraNegocioException(
                $"O desconto no total deve ser maior que zero e no máximo R$ {NumeroBr.Dinheiro(Math.Max(0m, maximo))}.");
        }

        var medida = new MedidaDesconto(
            ativos.Sum(i => i.DescontoItem) + ativos.Sum(i => i.ReducaoPrecoManual) + valor,
            ativos.Sum(i => i.ValorTabela),
            ativos.Count(i => i.DescontoItem > 0m) + (desconto.Tipo == TipoDesconto.Percentual ? 1 : 0));
        var resultado = AvaliarLimite([medida], valor, limiteOperadorPct, liberacao);
        if (!resultado.Aplicado)
        {
            return resultado;
        }

        Atomico(() =>
        {
            _descontoTotalOperador = valor;
            DescontoTotalPct = desconto.Tipo == TipoDesconto.Percentual ? desconto.Valor : null;
            _tetoDescontoTotalPct = Math.Max(limiteOperadorPct, medida.Percentual);
            Recalcular();
            if (resultado.PorLiberacao)
            {
                RegistrarLiberacao(liberacao!, AcaoLiberacao.DescontoTotal, null, resultado.PercentualPedido);
            }
        });
        return resultado;
    }

    /// <summary>Tira o desconto no total do operador; o dos cascos descontados (C11c) fica (sai pelo F11 › V com 0).</summary>
    public void RemoverDescontoTotal() => Atomico(() =>
    {
        if (_descontoTotalOperador == 0m && DescontoTotalPct is null && DescontoCascos > 0m)
        {
            throw new RegraNegocioException(
                "O desconto no total desta venda é só o dos cascos devolvidos: tire-o pelo F11 › Vasilhames (quantidade 0).");
        }

        _descontoTotalOperador = 0m;
        DescontoTotalPct = null;
        _tetoDescontoTotalPct = null;
        Recalcular();
    });

    /// <summary>Acréscimo no total em R$ (PDV 12.2, previsto para a PDV-2), rateado em <c>acrescimo_rateado</c>.</summary>
    public void AplicarAcrescimoTotal(decimal valor) => Atomico(() =>
    {
        ExigirStatus(StatusVenda.EmAndamento, "dar acréscimo");
        if (valor < 0m || !Arredondamento.CabeEm(valor, Arredondamento.CasasDinheiro))
        {
            throw new RegraNegocioException("Acréscimo inválido.");
        }

        if (valor > 0m && !ItensAtivos.Any())
        {
            throw new RegraNegocioException("Inclua itens antes de dar acréscimo.");
        }

        // Diminuir o acréscimo com pagamento lançado deixaria Σ pagamentos > total (sem troco nas formas não dinheiro).
        if (valor < AcrescimoTotal)
        {
            ExigirSemPagamentos("diminuir o acréscimo");
        }

        AcrescimoTotal = valor;
        Recalcular();
    });

    /// <summary>
    /// Venda em andamento gravada sem sessão de caixa (a do terminal real da 1B, que montava venda sem caixa, D18) entra
    /// na sessão aberta antes de seguir (Fase 1C, C11a; SYNC 8.5): sem isso o <c>venda.finalizada</c> e o
    /// <c>venda.cancelada</c> B subiriam sem <c>sessao_caixa_id</c> e a nuvem os recusaria. Só sem pagamento ativo — a
    /// D18 não deixava pagar, então nada da gaveta fica de fora do fechamento.
    /// </summary>
    public void VincularSessaoCaixa(Guid sessaoCaixaId)
    {
        if (!Aberta)
        {
            throw new RegraNegocioException("Só a venda em andamento entra na sessão de caixa.");
        }

        if (SessaoCaixaId is not null)
        {
            throw new RegraNegocioException("A venda já é de uma sessão de caixa.");
        }

        if (sessaoCaixaId == Guid.Empty || PagamentosAtivos.Any())
        {
            throw new RegraNegocioException("A venda tem pagamento lançado sem sessão de caixa: cancele-a e refaça.");
        }

        SessaoCaixaId = sessaoCaixaId;
    }

    // ---------------------------------------------------------------- pagamento

    /// <summary>F10 Concluir venda: abre a tela de pagamento (precisa de ao menos um item não cancelado).</summary>
    public void IniciarPagamento()
    {
        ExigirStatus(StatusVenda.EmAndamento, "ir para o pagamento");
        if (!ItensAtivos.Any())
        {
            throw new RegraNegocioException("Inclua ao menos um item antes de concluir a venda.");
        }

        Status = StatusVenda.EmPagamento;
    }

    /// <summary>Esc na tela de pagamento: volta aos itens mantendo os pagamentos não eletrônicos lançados.</summary>
    public void VoltarParaItens()
    {
        ExigirStatus(StatusVenda.EmPagamento, "voltar aos itens");
        Status = StatusVenda.EmAndamento;
    }

    /// <summary>Quanto do valor informado é aplicado à venda e quanto vira troco (PDV 16.4), sem lançar.</summary>
    public (decimal ValorAplicado, decimal Troco) PreverPagamento(FormaPagamentoInfo forma, decimal valorInformado)
    {
        ArgumentNullException.ThrowIfNull(forma);
        if (forma.Fluxo == FluxoPagamento.Indisponivel)
        {
            throw new RegraNegocioException($"A forma {forma.Descricao} ainda não é aceita neste caixa.");
        }

        if (valorInformado <= 0m || !Arredondamento.CabeEm(valorInformado, Arredondamento.CasasDinheiro))
        {
            throw new RegraNegocioException("Informe um valor maior que zero, com até 2 casas decimais.");
        }

        var falta = Falta;
        if (falta <= 0m)
        {
            throw new RegraNegocioException("A venda já está quitada. Pressione F10 para finalizar.");
        }

        if (forma.RestringeIdadeMinima)
        {
            var maximo = MaximoFormasRestritas();
            if (Math.Min(valorInformado, falta) > maximo)
            {
                throw new RegraNegocioException(MensagemRestricaoIdade(forma.Descricao, maximo));
            }
        }

        if (valorInformado <= falta)
        {
            return (valorInformado, 0m);
        }

        // O23 do dono: troco só na forma que dá troco (dinheiro); cartão e PIX não passam do total.
        if (!forma.DaTroco)
        {
            throw new RegraNegocioException($"O valor excede o total e a forma {forma.Descricao} não permite troco.");
        }

        return (falta, valorInformado - falta);
    }

    /// <summary>
    /// Quanto as formas com <c>restringe_idade_minima</c> (VA/VR) ainda podem pagar (MD 3.10.1; ERP 10.2): o
    /// <c>valor_liquido</c> dos itens ativos sem idade mínima menos o que outras formas restritas já pagaram. O item de
    /// produto sem o cadastro registrado na venda conta como restrito.
    /// </summary>
    public decimal MaximoFormasRestritas() =>
        Math.Max(0m, ValorItensSemIdadeMinima() - PagamentosAtivos.Where(p => p.RestringeIdadeMinima).Sum(p => p.Valor));

    private decimal ValorItensSemIdadeMinima() =>
        ItensAtivos.Where(i => _produtos.TryGetValue(i.ProdutoId, out var r) && !r.Produto.RestritoPorIdade).Sum(i => i.ValorLiquido);

    /// <summary>Recusa do valor acima do máximo da forma restrita (texto da MD 3.10.1).</summary>
    public static string MensagemRestricaoIdade(string forma, decimal maximo) =>
        $"{forma} não pode pagar bebida alcoólica: máximo R$ {NumeroBr.Dinheiro(maximo)}.";

    /// <summary>
    /// Lança um pagamento (PDV 16). <paramref name="detalhe"/> leva os dados do POS (bandeira obrigatória, O9c);
    /// <paramref name="pix"/>, a confirmação manual do PIX (16.7), que vira a linha de <c>cobrancas_pix</c> ligada ao
    /// pagamento; <paramref name="liberacao"/>, o supervisor que liberou a forma (C8b) ou a confirmação do PIX (O9b): vira
    /// o <c>autorizado_por_id</c> do pagamento e uma linha de <c>liberacoes</c> (<c>pix_manual</c> ou
    /// <c>forma_pagamento</c>), no último passo da operação atômica.
    /// </summary>
    public PagamentoVenda LancarPagamento(
        FormaPagamentoInfo forma,
        decimal valorInformado,
        DateTimeOffset agora,
        DetalhePagamento? detalhe = null,
        ConfirmacaoPix? pix = null,
        Liberacao? liberacao = null) =>
        Atomico(() =>
        {
            var d = detalhe ?? DetalhePagamento.Vazio;
            if (liberacao is not null)
            {
                if (string.IsNullOrWhiteSpace(liberacao.Motivo) || liberacao.Motivo.Trim().Length > MotivoLiberacaoMaximo)
                {
                    throw new RegraNegocioException($"Informe o motivo da liberação (até {MotivoLiberacaoMaximo} caracteres).");
                }

                d = d with { AutorizadoPorId = liberacao.SupervisorId };
            }

            var pagamento = LancarPagamentoInterno(forma, valorInformado, agora, d, pix);
            if (liberacao is not null)
            {
                _liberacoes.Add(new LiberacaoVenda(
                    IdGerador.Novo(), forma.Fluxo == FluxoPagamento.PixManual ? AcaoLiberacao.PixManual : AcaoLiberacao.FormaPagamento, null, null,
                    liberacao.SupervisorId, liberacao.Motivo.Trim(), liberacao.ConcedidaEm));
            }

            return pagamento;
        });

    private PagamentoVenda LancarPagamentoInterno(
        FormaPagamentoInfo forma, decimal valorInformado, DateTimeOffset agora, DetalhePagamento detalhe, ConfirmacaoPix? pix)
    {
        ExigirStatus(StatusVenda.EmPagamento, "lançar pagamento");
        if (PagamentosAtivos.Count() >= MaximoPagamentos)
        {
            throw new RegraNegocioException($"Máximo de {MaximoPagamentos} pagamentos por venda.");
        }

        var (valor, troco) = PreverPagamento(forma, valorInformado);
        if (forma.ExigeSupervisor && detalhe.AutorizadoPorId is null)
        {
            throw new RegraNegocioException($"A forma {forma.Descricao} exige a liberação do supervisor.");
        }

        if (forma.ExigePessoa && ClienteId is null)
        {
            throw new RegraNegocioException($"A forma {forma.Descricao} exige o cliente cadastrado: identifique-o com F5.");
        }

        if (forma.Fluxo == FluxoPagamento.Pos && detalhe.Bandeira is null)
        {
            throw new RegraNegocioException("Informe a bandeira do cartão aprovado na maquininha.");
        }

        if (forma.Fluxo == FluxoPagamento.PixManual && pix is null)
        {
            throw new RegraNegocioException("Confirme o PIX no app do banco da loja (nome de quem pagou e horário).");
        }

        var id = IdGerador.Novo();
        if (pix is not null)
        {
            var cobranca = new CobrancaPixVenda(IdGerador.Novo(), pix.Txid, valor, pix.QrcodePayload, pix.PagaEm, pix.PagadorNome, id);
            _cobrancasPix.Add(cobranca);
            detalhe = detalhe with { PixCobrancaId = cobranca.Id };
        }

        var pagamento = new PagamentoVenda(
            id: id,
            sequencia: _pagamentos.Count == 0 ? 1 : _pagamentos.Max(p => p.Sequencia) + 1,
            formaPagamentoId: forma.Id,
            descricaoForma: forma.Descricao,
            meioPagamentoFiscal: forma.MeioPagamentoFiscal,
            tipoForma: forma.TipoForma,
            valor: valor,
            valorRecebido: forma.DaTroco ? valorInformado : null,
            troco: troco,
            status: StatusPagamento.Aprovado,
            lancaQuitada: forma.LancaQuitada,
            taxaPct: forma.TaxaPct,
            parcelas: detalhe.Parcelas,
            dataPagamento: DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(agora, _fuso).DateTime),
            detalhe: detalhe,
            restringeIdadeMinima: forma.RestringeIdadeMinima,
            exigePessoa: forma.ExigePessoa);
        _pagamentos.Add(pagamento);
        Recalcular();
        return pagamento;
    }

    /// <summary>Del na tela de pagamento: livre para dinheiro/POS/PIX manual (fica gravado como cancelado).</summary>
    public void RemoverPagamento(int sequencia) => Atomico(() =>
    {
        if (!Aberta)
        {
            throw new RegraNegocioException("A venda não está aberta.");
        }

        var pagamento = _pagamentos.FirstOrDefault(p => p.Sequencia == sequencia && p.Ativo)
                        ?? throw new RegraNegocioException($"Pagamento {sequencia} não encontrado.");
        pagamento.Status = StatusPagamento.Cancelado;
        CancelarCobrancas(pagamento.Id);
        Recalcular();
    });

    /// <summary>A cobrança PIX do pagamento removido (ou da venda cancelada) fica <c>cancelada</c> no payload.</summary>
    private void CancelarCobrancas(Guid? pagamentoId)
    {
        foreach (var cobranca in _cobrancasPix.Where(c => pagamentoId is null || c.PagamentoVendaId == pagamentoId))
        {
            cobranca.Status = StatusCobrancaPix.Cancelada;
        }
    }

    /// <summary>Finaliza (PDV 17.1): pago = total. Depois disso a venda é um documento imutável.</summary>
    public void Finalizar(DateTimeOffset agora, Guid eventoFinalizacaoId) => Atomico(() =>
    {
        ExigirStatus(StatusVenda.EmPagamento, "finalizar");
        Recalcular();
        if (!ItensAtivos.Any())
        {
            throw new RegraNegocioException("A venda não tem itens.");
        }

        if (Pago > Total)
        {
            throw new RegraNegocioException(
                $"Os pagamentos (R$ {NumeroBr.Dinheiro(Pago)}) passam do total (R$ {NumeroBr.Dinheiro(Total)}). Remova um pagamento e lance de novo.");
        }

        if (Pago != Total)
        {
            throw new RegraNegocioException($"Falta R$ {NumeroBr.Dinheiro(Falta)}.");
        }

        // De novo na finalização: um item sem idade mínima cancelado depois do VA/VR (Esc › itens) não deixa o vale pagar
        // a bebida (MD 3.10.1), e o pagamento que exige pessoa não sobe sem o cliente (16.2; MD 3.11.4).
        var restritos = PagamentosAtivos.Where(p => p.RestringeIdadeMinima).ToList();
        if (restritos.Count > 0 && restritos.Sum(p => p.Valor) > ValorItensSemIdadeMinima())
        {
            throw new RegraNegocioException(
                MensagemRestricaoIdade(restritos[0].DescricaoForma, ValorItensSemIdadeMinima()) + " Remova o pagamento e lance de novo.");
        }

        if (ClienteId is null && PagamentosAtivos.FirstOrDefault(p => p.ExigePessoa) is { } comPessoa)
        {
            throw new RegraNegocioException($"A forma {comPessoa.DescricaoForma} exige o cliente cadastrado: identifique-o com F5.");
        }

        Status = StatusVenda.Finalizada;
        FinalizadaEm = agora;
        DiaOperacional = Comum.DiaOperacional.Calcular(agora, _fuso, _horaCorte);
        EventoFinalizacaoId = eventoFinalizacaoId;
        StatusFiscal = Vendas.StatusFiscal.NaoAplicavel;
    });

    /// <summary>Cancela a venda em andamento (PDV 13.2). O número não é reutilizado.</summary>
    public void Cancelar(Guid operadorId, string motivo, DateTimeOffset agora, Guid? autorizadoPorId = null) => Atomico(() =>
    {
        if (Status is not (StatusVenda.EmAndamento or StatusVenda.EmPagamento or StatusVenda.Suspensa))
        {
            throw new RegraNegocioException("Só a venda em andamento pode ser cancelada aqui.");
        }

        var texto = ValidarMotivoCancelamento(motivo);
        foreach (var pagamento in PagamentosAtivos.ToList())
        {
            pagamento.Status = StatusPagamento.Cancelado;
        }

        CancelarCobrancas(null);

        Status = StatusVenda.Cancelada;
        CanceladaEm = agora;
        CanceladaPorId = operadorId;
        CancelamentoAutorizadoPorId = autorizadoPorId;
        MotivoCancelamento = texto;
        CancelamentoOrigem = "pdv";
        DiaOperacional = Comum.DiaOperacional.Calcular(IniciadaEm, _fuso, _horaCorte);
        Recalcular();
    });

    /// <summary>
    /// O6 do dono: texto livre de 15 a 255 caracteres sem os espaços das pontas, nas duas formas do cancelamento. Devolve
    /// o texto aparado (o gravado e o do payload).
    /// </summary>
    public static string ValidarMotivoCancelamento(string? motivo)
    {
        var texto = (motivo ?? string.Empty).Trim();
        if (texto.Length is < MotivoCancelamentoMinimo or > MotivoCancelamentoMaximo)
        {
            throw new RegraNegocioException(
                $"Informe o motivo do cancelamento (de {MotivoCancelamentoMinimo} a {MotivoCancelamentoMaximo} caracteres).");
        }

        return texto;
    }

    /// <summary>Mensagem da venda de outra sessão (O6 do dono): depois do fechamento, só o ERP cancela (Fase 3).</summary>
    public const string MensagemCancelamentoForaDaSessao =
        "Só as vendas da sessão de caixa aberta são canceladas no caixa; as das sessões fechadas, só pelo ERP.";

    /// <summary>
    /// Mensagem da venda cujo <c>venda.finalizada</c> foi descartado na fila de decisão do ERP (<c>resultado.descartado</c>,
    /// SYNC 9.9): a nuvem não tem a venda, e o <c>venda.cancelada</c> forma A cairia em erro permanente.
    /// </summary>
    public const string MensagemCancelamentoDescartada =
        "Venda descartada no ERP (fila de decisão): a nuvem não tem esta venda e o caixa não a cancela.";

    /// <summary>
    /// Cancela a venda <b>finalizada</b> (PDV 13.3; Fase 1C, bloco C11b; <c>venda.cancelada</c> forma A): só as da sessão
    /// de caixa ainda aberta (O6 do dono; <paramref name="sessaoCaixaAbertaId"/>). Cada pagamento aprovado volta como o
    /// operador escolheu (<paramref name="escolhas"/>, por pagamento; sem a escolha, o padrão de
    /// <see cref="RegrasEstorno"/>), fica <c>estornado</c>, e os estornos efetivados viram uma linha <c>estorno_venda</c>
    /// por forma na sessão do cancelamento: a devolução em dinheiro de um cartão/PIX (O22) vai na forma
    /// <paramref name="formaDinheiroId"/>. Os totais, o dia operacional e os itens ficam como na finalização (o
    /// documento é imutável; o estorno do estoque é da nuvem, SYNC 10.4). A PIX devolvida fica com a cobrança
    /// <c>devolvida</c>.
    /// </summary>
    public CancelamentoFinalizada CancelarFinalizada(
        Guid canceladaPorId,
        string motivo,
        DateTimeOffset agora,
        Guid sessaoCaixaAbertaId,
        Guid formaDinheiroId,
        IReadOnlyDictionary<Guid, string>? escolhas = null,
        Guid? autorizadoPorId = null) => Atomico(() =>
    {
        if (Status == StatusVenda.Cancelada)
        {
            throw new RegraNegocioException($"A venda {NumeroExibicao} já está cancelada.");
        }

        if (Status != StatusVenda.Finalizada)
        {
            throw new RegraNegocioException("Só a venda finalizada é cancelada pela gestão de vendas.");
        }

        if (SessaoCaixaId is null || SessaoCaixaId != sessaoCaixaAbertaId)
        {
            throw new RegraNegocioException(MensagemCancelamentoForaDaSessao);
        }

        var texto = ValidarMotivoCancelamento(motivo);
        var aprovados = _pagamentos.Where(p => p.Status == StatusPagamento.Aprovado).OrderBy(p => p.Sequencia).ToList();
        var estornos = new List<EstornoEscolhido>();
        var porForma = new List<(Guid Forma, decimal Valor)>();
        foreach (var pagamento in aprovados)
        {
            var estorno = escolhas?.GetValueOrDefault(pagamento.Id) ?? RegrasEstorno.Padrao(pagamento);
            if (RegrasEstorno.Opcoes(pagamento).All(o => o.Estorno != estorno))
            {
                throw new RegraNegocioException($"Estorno inválido para o pagamento {pagamento.Sequencia} ({pagamento.DescricaoForma}).");
            }

            estornos.Add(new EstornoEscolhido(pagamento.Id, pagamento.Sequencia, pagamento.DescricaoForma, pagamento.Valor, estorno));
            if (EstornoPagamento.GeraMovimento(estorno))
            {
                porForma.Add((estorno == EstornoPagamento.DevolvidoEmDinheiro ? formaDinheiroId : pagamento.FormaPagamentoId, pagamento.Valor));
            }
        }

        foreach (var (pagamento, estorno) in aprovados.Zip(estornos))
        {
            pagamento.Status = StatusPagamento.Estornado;
            if (estorno.Estorno == EstornoPagamento.PixDevolucaoManual)
            {
                foreach (var cobranca in _cobrancasPix.Where(c => c.PagamentoVendaId == pagamento.Id))
                {
                    cobranca.Status = StatusCobrancaPix.Devolvida;
                }
            }
        }

        Status = StatusVenda.Cancelada;
        CanceladaEm = agora;
        CanceladaPorId = canceladaPorId;
        CancelamentoAutorizadoPorId = autorizadoPorId;
        MotivoCancelamento = texto;
        CancelamentoOrigem = "pdv";
        // Uma linha por forma, na ordem em que a forma aparece nos pagamentos (o dinheiro devolvido de vários
        // pagamentos soma na mesma linha).
        var movimentos = porForma
            .GroupBy(m => m.Forma)
            .Select(g => new EstornoPorForma(g.Key, g.Sum(m => m.Valor)))
            .ToList();
        return new CancelamentoFinalizada(sessaoCaixaAbertaId, estornos, movimentos);
    });

    /// <summary>
    /// Vazios trazidos pelo cliente nesta venda (bloco <c>vasilhames</c>, 10.12): na venda cancelada com
    /// <c>pdv.cancelamento_devolve_vazios</c> (D29), o caixa devolve esses cascos ao cliente. Precisa dos produtos
    /// registrados (o casco do produto cheio vem do cadastro).
    /// </summary>
    public IReadOnlyList<ResumoVasilhame> VaziosTrazidos() => ResumoVasilhames().Where(r => r.Devolvidos > 0m).ToList();

    // ---------------------------------------------------------------- cliente (PDV 14.1, 14.2; O8 do dono)

    /// <summary><c>vendas.nome_nota</c>: até 60 caracteres (14.1).</summary>
    public const int NomeNotaMaximo = 60;

    /// <summary>
    /// CPF/CNPJ na nota e/ou cliente cadastrado (F5, a qualquer momento antes da finalização). O documento chega sem
    /// máscara e com os dígitos verificadores já conferidos pelo caixa (Fiscal); aqui vale o formato do
    /// <c>ck_vendas_cpf_cnpj_nota</c> (11 dígitos ou CNPJ alfanumérico de 14). O cliente do espelho (<c>cliente_id</c>)
    /// aciona a relevância <c>compra</c> na nuvem; o nome é opcional. Nada disso muda valores.
    /// </summary>
    public void IdentificarCliente(string? cpfCnpj, string? nome, Guid? clienteId) => Atomico(() =>
    {
        if (!Aberta)
        {
            throw new RegraNegocioException("Não há venda em andamento para identificar o cliente.");
        }

        var documento = string.IsNullOrWhiteSpace(cpfCnpj) ? null : cpfCnpj.Trim().ToUpperInvariant();
        if (documento is not null && !DocumentoValido(documento))
        {
            throw new RegraNegocioException("CPF (11 dígitos) ou CNPJ (14) inválido.");
        }

        var texto = string.IsNullOrWhiteSpace(nome) ? null : nome.Trim();
        if (texto is { Length: > NomeNotaMaximo })
        {
            throw new RegraNegocioException($"Nome na nota: até {NomeNotaMaximo} caracteres.");
        }

        if (documento is null && clienteId is null)
        {
            throw new RegraNegocioException("Informe o CPF/CNPJ ou escolha o cliente.");
        }

        if (clienteId != ClienteId)
        {
            ExigirClienteSemPagamentoComPessoa();
        }

        CpfCnpjNota = documento;
        NomeNota = texto;
        ClienteId = clienteId;
    });

    /// <summary>Tira o CPF/CNPJ e o cliente da venda (F5 › Del).</summary>
    public void RemoverCliente() => Atomico(() =>
    {
        if (!Aberta)
        {
            throw new RegraNegocioException("Não há venda em andamento.");
        }

        if (ClienteId is not null)
        {
            ExigirClienteSemPagamentoComPessoa();
        }

        CpfCnpjNota = null;
        NomeNota = null;
        ClienteId = null;
    });

    /// <summary>
    /// O pagamento ativo de forma que exige pessoa (16.2) é do cliente identificado: trocá-lo ou tirá-lo deixaria o
    /// devedor errado (ou nenhum) no <c>venda.finalizada</c>. Remova o pagamento antes.
    /// </summary>
    private void ExigirClienteSemPagamentoComPessoa()
    {
        if (PagamentosAtivos.FirstOrDefault(p => p.ExigePessoa) is { } pagamento)
        {
            throw new RegraNegocioException(
                $"O pagamento em {pagamento.DescricaoForma} é do cliente identificado: remova o pagamento (Del) antes de trocar ou tirar o cliente.");
        }
    }

    private static bool DocumentoValido(string d) =>
        (d.Length == 11 && d.All(char.IsAsciiDigit))
        || (d.Length == 14 && d[..12].All(c => char.IsAsciiDigit(c) || char.IsAsciiLetterUpper(c)) && d[12..].All(char.IsAsciiDigit));

    // ---------------------------------------------------------------- estoque

    /// <summary>
    /// <c>componentes_estoque</c> do item (SYNC 9.7; D17 do dono): o produto <c>produzido</c> baixa os insumos da ficha
    /// técnica do snapshot (a da primeira inclusão), já multiplicados pela quantidade do item e acrescidos da perda,
    /// em 3 casas; sem saldo próprio. Vazio para os demais itens, inclusive os do combo (cada componente já é item) e o
    /// produto <c>simples</c> com ficha (só informativa, de custo).
    /// </summary>
    public IReadOnlyList<ComponenteBaixa> ComponentesEstoque(ItemVenda item)
    {
        ArgumentNullException.ThrowIfNull(item);
        if (item.Kit is not null || !_produtos.TryGetValue(item.ProdutoId, out var registrado)
            || registrado.Produto.Tipo != TipoProduto.Produzido || registrado.Produto.FichaTecnica is not { Count: > 0 } ficha)
        {
            return [];
        }

        return ficha
            .Select(c => new ComponenteBaixa(
                c.ProdutoId, c.VariacaoId, Arredondamento.Arred3(item.Quantidade * c.Quantidade * (1m + (c.PerdaPct / 100m)))))
            .Where(c => c.Quantidade > 0m)
            .ToList();
    }

    /// <summary>
    /// Quanto a venda tira do saldo de cada produto (SYNC 15.2, "quantidades da venda em andamento"): itens não
    /// cancelados na unidade base (o fardo já vem multiplicado), os insumos da ficha no lugar do produzido.
    /// </summary>
    public IReadOnlyDictionary<Guid, decimal> BaixasEstimadas()
    {
        var baixas = new Dictionary<Guid, decimal>();
        foreach (var item in ItensAtivos)
        {
            var componentes = ComponentesEstoque(item);
            if (componentes.Count > 0)
            {
                foreach (var c in componentes)
                {
                    baixas[c.ProdutoId] = baixas.GetValueOrDefault(c.ProdutoId) + c.Quantidade;
                }

                continue;
            }

            baixas[item.ProdutoId] = baixas.GetValueOrDefault(item.ProdutoId) + item.Quantidade;
        }

        return baixas;
    }

    // ---------------------------------------------------------------- cálculo

    /// <summary>
    /// Desconto no total que conta no limite do operador: só a parte dele; o crédito dos cascos (origem <c>cliente</c>,
    /// C11c) não conta (PDV 12.3).
    /// </summary>
    private decimal DescontoTotalDoOperador => _descontoTotalOperador;

    /// <summary>Itens com base positiva; item de base zero (venda antiga gravada antes da validação) fica fora do rateio.</summary>
    private static List<BaseRateio> BasesRateio(IEnumerable<ItemVenda> ativos) =>
        ativos.Where(i => i.BaseRateio > 0m).Select(i => new BaseRateio(i.Sequencia, i.BaseRateio)).ToList();

    /// <param name="ajustarDescontoTotalAoTeto">
    /// Inclusão ou aumento de quantidade (decisão 27): o desconto no total em R$ é reduzido ao teto aceito se o preço das
    /// linhas cair (atacado, mix). Ao diminuir/cancelar, o % que sobe é recusado (decisão 11), não ajustado.
    /// </param>
    private void Recalcular(bool ajustarDescontoTotalAoTeto = false)
    {
        Reprecificar();
        var ativos = ItensAtivos.ToList();
        QtdItens = ativos.Count;
        SubtotalBruto = ativos.Sum(i => i.ValorBruto);
        DescontoItens = ativos.Sum(i => i.DescontoItem + i.DescontoPromocao);
        var bases = BasesRateio(ativos);

        if (bases.Count == 0)
        {
            if (_descontoTotalOperador > 0m || AcrescimoTotal > 0m)
            {
                _avisos.Add("Desconto/acréscimo no total removido: a venda ficou sem itens.");
            }

            if (_cascosDescontados.Count > 0)
            {
                _avisos.Add(MensagemCascosDescontadosRemovidos(DescontoCascos, "a venda ficou sem itens"));
            }

            _descontoTotalOperador = 0m;
            DescontoTotalPct = null;
            _cascosDescontados.Clear();
            AcrescimoTotal = 0m;
        }
        else
        {
            if (DescontoTotalPct is { } pct)
            {
                _descontoTotalOperador = Arredondamento.ValorDoPercentual(bases.Sum(b => b.Base), pct);
            }
            else if (ajustarDescontoTotalAoTeto && _descontoTotalOperador > 0m && _tetoDescontoTotalPct is { } teto)
            {
                // Desconto no total em R$ (decisão 27): o recálculo do preço não pode levar o % da venda além do teto aceito.
                var outros = ativos.Sum(i => i.DescontoItem + i.ReducaoPrecoManual);
                var permitido = Math.Max(0m, Arredondamento.Truncar2((ativos.Sum(i => i.ValorTabela) * teto / 100m) - outros));
                if (_descontoTotalOperador > permitido)
                {
                    _descontoTotalOperador = permitido;
                    _avisos.Add(permitido > 0m
                        ? $"Desconto no total ajustado para R$ {NumeroBr.Dinheiro(permitido)}: o preço dos itens mudou e o desconto passaria do seu limite."
                        : "Desconto no total removido: o preço dos itens mudou e o desconto passaria do seu limite.");
                }
            }

            // C11c: o crédito dos cascos é do cliente e vem primeiro; o do operador cabe no que sobra até o máximo.
            var maximo = Rateio.DescontoMaximo(bases);
            if (DescontoCascos > maximo)
            {
                _avisos.Add(MensagemCascosDescontadosRemovidos(DescontoCascos, "ficou maior que o total da venda"));
                _cascosDescontados.Clear();
            }

            if (_descontoTotalOperador > maximo - DescontoCascos)
            {
                _avisos.Add($"Desconto no total de R$ {NumeroBr.Dinheiro(_descontoTotalOperador)} removido: ficou maior que o subtotal.");
                _descontoTotalOperador = 0m;
                DescontoTotalPct = null;
            }

            if (_descontoTotalOperador == 0m)
            {
                _tetoDescontoTotalPct = null;
            }
        }

        DescontoTotal = _descontoTotalOperador + DescontoCascos;
        DescontoTotalOrigem = _descontoTotalOperador > 0m ? OrigemDescontoOperador
            : DescontoTotal > 0m ? OrigemDescontoCliente
            : null;

        var descontos = Rateio.Distribuir(bases, DescontoTotal, TipoRateio.Desconto);
        var acrescimos = Rateio.Distribuir(bases, AcrescimoTotal, TipoRateio.Acrescimo);
        foreach (var item in _itens)
        {
            item.DescontoRateado = item.Cancelado ? 0m : descontos.GetValueOrDefault(item.Sequencia);
            item.AcrescimoRateado = item.Cancelado ? 0m : acrescimos.GetValueOrDefault(item.Sequencia);
            item.FreteRateado = 0m;
            item.ValorLiquido = item.ValorBruto - item.DescontoItem - item.DescontoPromocao - item.DescontoRateado
                                + item.AcrescimoRateado + item.FreteRateado;
        }

        Total = SubtotalBruto - DescontoItens - DescontoTotal + AcrescimoTotal + TaxaServico + TaxaEntrega + ValorFrete;
        Troco = PagamentosAtivos.Sum(p => p.Troco);
    }

    /// <summary>
    /// Os cascos descontados saíram da venda (C11c): o cliente fica com os vazios, que só voltam como desconto (F11 › V)
    /// ou como entrada sem desconto.
    /// </summary>
    private static string MensagemCascosDescontadosRemovidos(decimal valor, string motivo) =>
        $"Desconto dos cascos de R$ {NumeroBr.Dinheiro(valor)} removido: {motivo}. Registre os vazios de novo pelo F11 › Vasilhames.";

    /// <summary>
    /// Desconto (R$) sobre o valor de tabela (R$) para o limite (PDV 12.3). <paramref name="Arredondamentos"/> = quantos
    /// descontos podem ter vindo de um % convertido com arred2: cada um pode ter subido até meio centavo, folga aceita
    /// para que "limite 10% aplica 10% sem senha" (12.5) valha também em valores pequenos.
    /// </summary>
    private readonly record struct MedidaDesconto(decimal Desconto, decimal Base, int Arredondamentos)
    {
        public decimal Percentual => Base <= 0m ? 0m : Desconto / Base * 100m;

        public bool CabeEm(decimal limitePct) =>
            Desconto <= 0m || Desconto <= (Base * limitePct / 100m) + (Arredondamento.Centavo / 2m * Arredondamentos);
    }

    private readonly record struct MedidasLimite(MedidaDesconto Venda, MedidaDesconto? Item);

    private MedidaDesconto MedidaVenda()
    {
        var ativos = ItensAtivos.ToList();
        return new MedidaDesconto(
            ativos.Sum(i => i.DescontoItem + i.ReducaoPrecoManual) + DescontoTotalDoOperador,
            ativos.Sum(i => i.ValorTabela),
            ativos.Count(i => i.DescontoItem > 0m) + (DescontoTotalDoOperador > 0m ? 1 : 0));
    }

    private static MedidaDesconto MedidaItem(ItemVenda item) =>
        new(item.DescontoItem + item.ReducaoPrecoManual, item.ValorTabela, item.DescontoItem > 0m ? 1 : 0);

    private MedidasLimite MedirLimite(ItemVenda? item) => new(MedidaVenda(), item is null ? null : MedidaItem(item));

    /// <summary>
    /// Depois de diminuir quantidade ou cancelar item, o desconto em R$ que ficou não pode passar do limite do operador
    /// nem do % já aceito antes (liberado por supervisor); senão a operação é desfeita.
    /// </summary>
    private void ExigirLimiteMantido(MedidasLimite antes, ItemVenda? item, decimal limiteOperadorPct, string acao)
    {
        if (item is { Cancelado: false } && antes.Item is { } itemAntes)
        {
            var depois = MedidaItem(item);
            if (!depois.CabeEm(Math.Max(limiteOperadorPct, itemAntes.Percentual)))
            {
                throw new RegraNegocioException(
                    $"Não é possível {acao}: o desconto do item {item.Sequencia} passaria a {NumeroBr.Percentual(depois.Percentual)}% " +
                    $"e excede seu limite ({NumeroBr.Percentual(limiteOperadorPct)}%). Remova o desconto do item antes.");
            }
        }

        var venda = MedidaVenda();
        if (!venda.CabeEm(Math.Max(limiteOperadorPct, antes.Venda.Percentual)))
        {
            throw new RegraNegocioException(
                $"Não é possível {acao}: o desconto da venda passaria a {NumeroBr.Percentual(venda.Percentual)}% " +
                $"e excede seu limite ({NumeroBr.Percentual(limiteOperadorPct)}%). Remova o desconto antes.");
        }
    }

    /// <summary>
    /// Dentro do limite do operador a liberação informada não é usada (<c>PorLiberacao</c> falso): o diálogo do supervisor
    /// pode montá-la antes de saber se precisa, e reaplicar um desconto menor com a mesma liberação não registra uma
    /// liberação que não aconteceu. O motivo só é exigido quando ela é usada (vai em <c>liberacoes[].motivo</c>, 1 a 255).
    /// </summary>
    private static ResultadoDesconto AvaliarLimite(IReadOnlyList<MedidaDesconto> medidas, decimal valor, decimal limiteOperadorPct, Liberacao? liberacao)
    {
        var pedido = medidas.Max(m => m.Percentual);
        if (medidas.All(m => m.CabeEm(limiteOperadorPct)))
        {
            return new ResultadoDesconto(SituacaoDesconto.Aplicado, pedido, valor);
        }

        if (liberacao is null)
        {
            return new ResultadoDesconto(SituacaoDesconto.ExigeLiberacao, pedido, valor);
        }

        if (string.IsNullOrWhiteSpace(liberacao.Motivo) || liberacao.Motivo.Trim().Length > MotivoLiberacaoMaximo)
        {
            throw new RegraNegocioException($"Informe o motivo da liberação (até {MotivoLiberacaoMaximo} caracteres).");
        }

        return medidas.All(m => m.CabeEm(liberacao.LimiteEfetivoPct))
            ? new ResultadoDesconto(SituacaoDesconto.Aplicado, pedido, valor, PorLiberacao: true)
            : new ResultadoDesconto(SituacaoDesconto.LiberacaoInsuficiente, pedido, valor);
    }

    /// <summary>
    /// Guarda a liberação usada (vai em <c>liberacoes</c> do payload e conta no <c>qtd_liberacoes</c> do fechamento). Fica
    /// mesmo que o desconto seja removido depois: o supervisor liberou, e a auditoria também registra. Só é chamada com
    /// <c>ResultadoDesconto.PorLiberacao</c> (motivo já validado) e como último passo dentro do <c>Atomico</c>, depois do
    /// <c>Recalcular</c>: uma falha da operação nunca deixa a linha para trás (o <c>Reverter</c> a desfaz de qualquer modo).
    /// </summary>
    private void RegistrarLiberacao(Liberacao liberacao, string acao, Guid? itemVendaId, decimal? percentual) =>
        _liberacoes.Add(new LiberacaoVenda(
            IdGerador.Novo(), acao, itemVendaId, percentual is { } pct ? decimal.Round(pct, 4) : null, liberacao.SupervisorId,
            liberacao.Motivo.Trim(), liberacao.ConcedidaEm));

    /// <summary>arred2(quantidade × preço); um item precisa valer ao menos R$ 0,01 (sem isso não há base de rateio).</summary>
    private static decimal ValorBrutoValido(decimal quantidade, decimal preco)
    {
        var bruto = Arredondamento.Arred2(quantidade * preco);
        if (bruto < Arredondamento.Centavo)
        {
            throw new RegraNegocioException(
                $"Quantidade × preço resulta em R$ 0,00 ({NumeroBr.Quantidade(quantidade)} × {NumeroBr.Preco(preco)}). Aumente a quantidade.");
        }

        return bruto;
    }

    /// <summary>Executa a operação inteira ou nada: qualquer exceção devolve a venda ao estado anterior.</summary>
    private T Atomico<T>(Func<T> operacao)
    {
        var foto = Fotografar();
        try
        {
            return operacao();
        }
        catch
        {
            Reverter(foto);
            throw;
        }
    }

    private void Atomico(Action operacao) => Atomico(() =>
    {
        operacao();
        return true;
    });

    private Foto Fotografar() => new(
        new Dictionary<Guid, ProdutoRegistrado>(_produtos),
        _itens.Count,
        _itens.Select(i => i.Capturar()).ToList(),
        _pagamentos.Count,
        _pagamentos.Select(p => p.Status).ToList(),
        _avisos.Count,
        _liberacoes.Count,
        _cobrancasPix.Count,
        _cobrancasPix.Select(c => c.Status).ToList(),
        [.. _cascosDescontados],
        new FotoCabecalho(
            Status, StatusFiscal, DiaOperacional, DescontoTotal, DescontoTotalPct, DescontoTotalOrigem, AcrescimoTotal,
            FinalizadaEm, CanceladaEm, CanceladaPorId, CancelamentoAutorizadoPorId, MotivoCancelamento, CancelamentoOrigem,
            EventoFinalizacaoId, _tetoDescontoTotalPct, ClienteId, CpfCnpjNota, NomeNota, _descontoTotalOperador));

    private void Reverter(Foto foto)
    {
        _produtos.Clear();
        foreach (var (id, registrado) in foto.Produtos)
        {
            _produtos[id] = registrado;
        }

        _itens.RemoveRange(foto.QtdItens, _itens.Count - foto.QtdItens);
        for (var i = 0; i < foto.QtdItens; i++)
        {
            _itens[i].Restaurar(foto.Itens[i]);
        }

        _pagamentos.RemoveRange(foto.QtdPagamentos, _pagamentos.Count - foto.QtdPagamentos);
        for (var i = 0; i < foto.QtdPagamentos; i++)
        {
            _pagamentos[i].Status = foto.StatusPagamentos[i];
        }

        _avisos.RemoveRange(foto.QtdAvisos, _avisos.Count - foto.QtdAvisos);
        _liberacoes.RemoveRange(foto.QtdLiberacoes, _liberacoes.Count - foto.QtdLiberacoes);
        _cobrancasPix.RemoveRange(foto.QtdCobrancas, _cobrancasPix.Count - foto.QtdCobrancas);
        for (var i = 0; i < foto.QtdCobrancas; i++)
        {
            _cobrancasPix[i].Status = foto.StatusCobrancas[i];
        }

        _cascosDescontados.Clear();
        _cascosDescontados.AddRange(foto.CascosDescontados);

        var c = foto.Cabecalho;
        Status = c.Status;
        StatusFiscal = c.StatusFiscal;
        DiaOperacional = c.DiaOperacional;
        DescontoTotal = c.DescontoTotal;
        DescontoTotalPct = c.DescontoTotalPct;
        DescontoTotalOrigem = c.DescontoTotalOrigem;
        AcrescimoTotal = c.AcrescimoTotal;
        FinalizadaEm = c.FinalizadaEm;
        CanceladaEm = c.CanceladaEm;
        CanceladaPorId = c.CanceladaPorId;
        CancelamentoAutorizadoPorId = c.CancelamentoAutorizadoPorId;
        MotivoCancelamento = c.MotivoCancelamento;
        CancelamentoOrigem = c.CancelamentoOrigem;
        EventoFinalizacaoId = c.EventoFinalizacaoId;
        _tetoDescontoTotalPct = c.TetoDescontoTotalPct;
        _descontoTotalOperador = c.DescontoTotalOperador;
        ClienteId = c.ClienteId;
        CpfCnpjNota = c.CpfCnpjNota;
        NomeNota = c.NomeNota;
        RecalcularTotaisSemRateio();
    }

    /// <summary>Os rateios dos itens já voltaram da foto; aqui só os totais do cabeçalho, que derivam deles.</summary>
    private void RecalcularTotaisSemRateio()
    {
        var ativos = ItensAtivos.ToList();
        QtdItens = ativos.Count;
        SubtotalBruto = ativos.Sum(i => i.ValorBruto);
        DescontoItens = ativos.Sum(i => i.DescontoItem + i.DescontoPromocao);
        Total = SubtotalBruto - DescontoItens - DescontoTotal + AcrescimoTotal + TaxaServico + TaxaEntrega + ValorFrete;
        Troco = PagamentosAtivos.Sum(p => p.Troco);
    }

    private sealed record Foto(
        Dictionary<Guid, ProdutoRegistrado> Produtos,
        int QtdItens,
        List<ItemVenda.EstadoItem> Itens,
        int QtdPagamentos,
        List<string> StatusPagamentos,
        int QtdAvisos,
        int QtdLiberacoes,
        int QtdCobrancas,
        List<string> StatusCobrancas,
        List<CascoDescontado> CascosDescontados,
        FotoCabecalho Cabecalho);

    private sealed record FotoCabecalho(
        string Status,
        string StatusFiscal,
        DateOnly? DiaOperacional,
        decimal DescontoTotal,
        decimal? DescontoTotalPct,
        string? DescontoTotalOrigem,
        decimal AcrescimoTotal,
        DateTimeOffset? FinalizadaEm,
        DateTimeOffset? CanceladaEm,
        Guid? CanceladaPorId,
        Guid? CancelamentoAutorizadoPorId,
        string? MotivoCancelamento,
        string? CancelamentoOrigem,
        Guid? EventoFinalizacaoId,
        decimal? TetoDescontoTotalPct,
        Guid? ClienteId,
        string? CpfCnpjNota,
        string? NomeNota,
        decimal DescontoTotalOperador);

    private static void ValidarQuantidade(decimal quantidade, bool fracionavel)
    {
        if (quantidade <= 0m || quantidade > QuantidadeMaxima)
        {
            throw new RegraNegocioException("Quantidade deve ser maior que zero e no máximo 9.999,999.");
        }

        if (!Arredondamento.CabeEm(quantidade, Arredondamento.CasasQuantidade))
        {
            throw new RegraNegocioException("Quantidade com no máximo 3 casas decimais.");
        }

        if (!fracionavel && decimal.Truncate(quantidade) != quantidade)
        {
            throw new RegraNegocioException("Produto vendido por unidade, informe quantidade inteira.");
        }
    }

    private ItemVenda ObterItemAtivo(int sequencia)
    {
        var item = ObterItem(sequencia);
        if (item.Cancelado)
        {
            throw new RegraNegocioException($"O item {sequencia} já está cancelado.");
        }

        return item;
    }

    private void ExigirStatus(string status, string acao)
    {
        if (Status != status)
        {
            var mensagem = Status switch
            {
                StatusVenda.EmPagamento => $"Não é possível {acao} durante o pagamento. Pressione Esc para voltar aos itens.",
                StatusVenda.Finalizada => $"Venda finalizada: não é possível {acao}.",
                StatusVenda.Cancelada => $"Venda cancelada: não é possível {acao}.",
                _ => $"Não é possível {acao} agora.",
            };
            throw new RegraNegocioException(mensagem);
        }
    }

    private void ExigirSemPagamentos(string acao)
    {
        if (PagamentosAtivos.Any())
        {
            throw new RegraNegocioException($"Há pagamentos lançados: remova-os na tela de pagamento antes de {acao}.");
        }
    }
}
