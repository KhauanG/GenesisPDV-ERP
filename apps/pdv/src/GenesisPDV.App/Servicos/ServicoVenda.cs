using System.Text.Json.Nodes;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Fiscal;
using GenesisPDV.Fiscal.Validadores;
using GenesisPDV.Hardware.Gaveta;
using GenesisPDV.Hardware.Impressora;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Eventos;
using GenesisPDV.Sync.Protocolo;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.Servicos;

public enum TipoResultadoEntrada
{
    Nada,
    ItemIncluido,
    MultiplicadorDefinido,
    AbrirPesquisa,

    /// <summary>Combo com alternativas: a tela abre o diálogo Montar combo (PDV 10.9.1).</summary>
    MontarCombo,
}

/// <param name="Combo">Combo a montar (<see cref="TipoResultadoEntrada.MontarCombo"/>), com a quantidade em <paramref name="Multiplicador"/>.</param>
/// <param name="Codigo">Código lido que originou o combo.</param>
public sealed record ResultadoEntrada(
    TipoResultadoEntrada Tipo,
    ItemVenda? Item = null,
    decimal? Multiplicador = null,
    string? TextoPesquisa = null,
    ComboResolvido? Combo = null,
    string? Codigo = null);

public sealed record ResultadoFinalizacao(Venda Venda, long SequenciaEvento, string? TextoCupom, IReadOnlyList<string> Avisos);

/// <summary>Um pagamento da venda a cancelar e as formas de devolvê-lo (PDV 13.3; O22 do dono), a primeira é o padrão.</summary>
public sealed record PagamentoACancelar(PagamentoVenda Pagamento, IReadOnlyList<OpcaoEstorno> Opcoes);

/// <summary>
/// Desconto pelos cascos (F11 › V, C11c): o casco descontado (nulo quando a quantidade 0 tirou o desconto) ou, sem nada
/// aplicado, a <paramref name="ExigeLiberacao"/> — o texto do pedido ao supervisor (sem permissão ou acima do teto).
/// </summary>
public sealed record ResultadoCascosDescontados(CascoDescontado? Descontado, string? ExigeLiberacao);

/// <summary>Cascos vazios que voltam ao cliente com a venda cancelada (D29, <c>pdv.cancelamento_devolve_vazios</c>).</summary>
public sealed record CascosADevolver(Guid ProdutoVasilhameId, string Descricao, decimal Quantidade);

/// <summary>A venda finalizada que a gestão de vendas vai cancelar (13.3), já conferida: da sessão aberta e paga.</summary>
public sealed record CancelamentoPreparado(Venda Venda, IReadOnlyList<PagamentoACancelar> Pagamentos, IReadOnlyList<CascosADevolver> Vazios);

/// <summary>
/// Venda finalizada cancelada (13.3): o que foi gravado e o que o operador faz no balcão (<paramref name="Instrucoes"/>:
/// o dinheiro a devolver, a maquininha, o PIX e os cascos).
/// </summary>
public sealed record ResultadoCancelamentoFinalizada(
    Venda Venda,
    CancelamentoFinalizada Cancelamento,
    long SequenciaEvento,
    IReadOnlyList<string> Instrucoes,
    IReadOnlyList<string> Avisos);

/// <summary>Regras da tela de pagamento lidas ao abrir o F10 (PDV 16.7; O9b do dono).</summary>
public sealed record RegrasPagamento(bool PixManualExigeSupervisor)
{
    public static RegrasPagamento Padrao { get; } = new(true);
}

/// <summary>
/// PIX a confirmar (16.7): o BR Code estático com o valor (nulo sem chave PIX na loja, ou na forma sem "Gera QR Code
/// Pix": confirmação manual só com a chave impressa no balcão) e o <c>txid</c> (o número da venda).
/// </summary>
public sealed record PixPreparado(decimal Valor, string? Qrcode, string Txid, string? Chave);

/// <summary>
/// Caso de uso da venda no caixa: aplica a regra do <see cref="Venda"/> (Core) e grava no SQLite antes de a tela
/// mudar (PDV 32.3). A finalização grava venda + outbox num commit e só depois emite, imprime e abre a gaveta (17.1).
/// <para>
/// Fase 1C, bloco C11a: fim da D18 — o terminal ativado vende de verdade. A venda só começa com o caixa aberto (8.1) e
/// com o <c>venda.finalizada</c> anunciado pela nuvem (T13); as formas vêm do espelho <c>formas_pagamento</c> da loja
/// (C8b), com várias na mesma venda, o cartão na maquininha (16.5) e o PIX estático/manual (16.7); o comprovante sai com
/// os dados da loja; o CPF na nota e o cliente entram pelo F5 (O8); o saldo estimado avisa ou bloqueia (29.1, O15); e o
/// tempo máximo offline (30.6) só vale com a chave preenchida (O18: sem limite).
/// </para>
/// </summary>
public sealed class ServicoVenda(
    IRepositorioVendas repositorio,
    ICatalogoProdutos catalogo,
    IRelogio relogio,
    SessaoTerminal sessao,
    IEmissorDocumento emissor,
    ServicoImpressao impressao,
    ServicoGaveta gaveta,
    RepositorioTerminal terminal,
    IServicoSincronizacao sincronizacao,
    ILogger<ServicoVenda> log,
    CatalogoLocal formas,
    ConsultasVendaLocal consultas,
    RepositorioConfiguracoes configuracoes,
    RepositorioCaixa repositorioCaixa,
    ServicoCaixa? caixa = null)
{
    /// <summary>Forma Dinheiro do catálogo de demonstração (só existe nele; o terminal real usa as formas do espelho).</summary>
    public static readonly FormaPagamentoInfo Dinheiro = new(
        Guid.Parse("019a0004-0000-7000-8000-000000000001"), "Dinheiro", "01", "dinheiro", PermiteTroco: true, AbreGaveta: true);

    /// <summary>PDV 8.1, 8.3: nenhum item entra antes de abrir o caixa.</summary>
    public const string MensagemCaixaFechado = "Caixa fechado: abra o caixa (pelo login) antes de vender.";

    /// <summary>
    /// Venda sem sessão de caixa que não pôde entrar na aberta (C11a): a nuvem recusaria o <c>venda.finalizada</c> sem
    /// <c>sessao_caixa_id</c>; o cancelamento dela sai sem evento.
    /// </summary>
    public const string MensagemVendaSemSessao =
        "Esta venda foi montada sem caixa aberto (antes da atualização): abra o caixa, ou cancele-a (Shift+F4) e refaça.";

    public const string MensagemSemFormaDinheiro = "Nenhuma forma de pagamento do tipo Dinheiro nesta loja (ERP › Formas de pagamento).";
    public const string MensagemDocumentoInvalido = "CPF ou CNPJ inválido: confira os dígitos.";
    public const string MensagemClienteInativo = "Cliente inativo no cadastro: não pode ser escolhido.";

    /// <summary>Vendas paradas pelo ciclo online (hardware alterado, regressão, token recusado; SYNC 20.5, 22.1).</summary>
    public const string MensagemTerminalBloqueado = "Vendas bloqueadas: veja o aviso de sincronização na barra (chame o gerente ou o suporte).";

    /// <summary>SYNC 8.6 (C15): a nuvem espera eventos que o caixa não tem mais; o supervisor declara em F11 › S.</summary>
    public static string MensagemLacuna(string faixa) =>
        $"Vendas bloqueadas: lacuna de eventos {faixa} (o caixa não tem mais estes eventos). Chame o supervisor para declarar a lacuna em F11 › S.";

    public Venda? Atual { get; private set; }

    public bool VendaAberta => Atual is { Aberta: true };

    /// <summary>Hora corrigida do caixa (a dos fatos da venda, SYNC 12.3): base do horário do PIX que o operador digita.</summary>
    public DateTimeOffset Agora => relogio.Agora;

    /// <summary>Fuso da loja do terminal (MD 1.2).</summary>
    public TimeZoneInfo Fuso => Core.Comum.DiaOperacional.ObterFuso(sessao.FusoHorario);

    private Operador Operador => sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");

    private decimal Limite => Operador.LimiteDescontoEfetivoPct;

    /// <summary>
    /// Limite do operador para dar o desconto: o dele com a permissão (<c>pdv.venda.desconto_item</c> ou
    /// <c>pdv.venda.desconto_total</c>, PDV 12.2), 0% sem ela (todo desconto pede a liberação do supervisor).
    /// </summary>
    public decimal LimiteDoDesconto(string permissao) => Operador.Tem(permissao) ? Limite : 0m;

    /// <summary>Regras do pagamento relidas a cada F10 (o pull pode mudar a chave no meio do turno).</summary>
    public RegrasPagamento RegrasPagamento { get; private set; } = RegrasPagamento.Padrao;

    /// <summary>
    /// Aviso âmbar do saldo (PDV 29.1; O15 do dono): o último item incluído deixou o saldo estimado negativo. A tela mostra
    /// numa faixa própria; a próxima inclusão o refaz.
    /// </summary>
    public string? AvisoEstoque { get; private set; }

    /// <summary>
    /// Produtos liberados pelo supervisor para vender sem estoque (29.1, <c>pdv.venda.vender_sem_estoque</c>), cada um
    /// amarrado ao login do operador e à venda: a da tela, ou — quando o bloqueio foi no primeiro item — a próxima que
    /// esse mesmo login abrir com o produto. A venda que abre sem o produto, outro login (logout, troca de operador) e o
    /// fim da venda descartam a liberação: ela nunca passa para outra venda sem o supervisor.
    /// </summary>
    private readonly List<LiberacaoEstoque> _semEstoqueLiberados = [];

    /// <param name="Login">O <see cref="Operador"/> do login que pediu (a referência muda a cada login).</param>
    /// <param name="VendaId">A venda da liberação; nula enquanto espera a venda que o item vai abrir.</param>
    private sealed record LiberacaoEstoque(Guid ProdutoId, Operador Login, Guid? VendaId);

    private bool SemEstoqueLiberado(Guid produtoId, Venda venda) =>
        _semEstoqueLiberados.Any(l => l.ProdutoId == produtoId && ReferenceEquals(l.Login, sessao.Operador)
                                      && (l.VendaId == venda.Id || (l.VendaId is null && venda.Id == Guid.Empty)));

    /// <summary>
    /// Venda nova aberta (número reservado): as liberações à espera, do mesmo login e de produtos que ela inclui, passam a
    /// ser dela; as demais são descartadas.
    /// </summary>
    private void AmarrarLiberacoesEstoque(Guid vendaId, IReadOnlyCollection<Guid> produtos)
    {
        var pendentes = _semEstoqueLiberados.Where(l => l.VendaId is null).ToList();
        _semEstoqueLiberados.RemoveAll(l => l.VendaId != vendaId);
        _semEstoqueLiberados.AddRange(pendentes
            .Where(l => ReferenceEquals(l.Login, sessao.Operador) && produtos.Contains(l.ProdutoId))
            .Select(l => l with { VendaId = vendaId }));
    }

    /// <summary>Reabre a venda que estava na tela quando o PDV caiu (PDV 32.3).</summary>
    public async Task<bool> RecuperarAsync(CancellationToken ct = default)
    {
        Atual = await repositorio.ObterVendaAtualAsync(ct);
        if (Atual is null)
        {
            return false;
        }

        await RegistrarProdutosAsync(Atual, ct);
        var vinculada = await VincularSessaoSeAusenteAsync(ct);
        log.LogWarning("Venda {Numero} recuperada após interrupção ({Itens} itens)", Atual.NumeroExibicao, Atual.QtdItens);
        await terminal.RegistrarAuditoriaAsync("venda_recuperada", Operador.Id, "venda", Atual.Id,
            $"Venda {Atual.NumeroExibicao} recuperada após interrupção" + (vinculada ? " e incluída na sessão de caixa aberta" : string.Empty), ct: ct);
        return true;
    }

    /// <summary>
    /// A venda em andamento sem sessão de caixa (montada no terminal real da 1B, que vendia sem caixa, D18) entra na
    /// sessão aberta (Fase 1C, C11a): é gravada com o <c>sessao_caixa_id</c> antes de seguir. Sem sessão aberta (ou com
    /// pagamento lançado), fica como está: não finaliza (<see cref="MensagemVendaSemSessao"/>) e o cancelamento sai sem
    /// evento. O terminal sem o serviço de caixa (testes antigos) não tem sessão e segue como antes.
    /// </summary>
    private async Task<bool> VincularSessaoSeAusenteAsync(CancellationToken ct)
    {
        if (caixa is null || Atual is not { Aberta: true, SessaoCaixaId: null } venda || sessao.SessaoCaixaId is not { } sessaoId
            || venda.PagamentosAtivos.Any())
        {
            return false;
        }

        venda.VincularSessaoCaixa(sessaoId);
        await repositorio.SalvarEmAndamentoAsync(venda, ct: ct);
        log.LogWarning("Venda {Numero} sem sessão de caixa incluída na sessão {Sessao}", venda.NumeroExibicao, sessaoId);
        return true;
    }

    /// <summary>Relê do banco a venda atual (depois de um erro inesperado a tela volta ao que está gravado).</summary>
    public async Task RecarregarAsync(CancellationToken ct = default)
    {
        if (Atual is not null)
        {
            Atual = await repositorio.ObterVendaAtualAsync(ct);
            if (Atual is not null)
            {
                await RegistrarProdutosAsync(Atual, ct);
            }
        }
    }

    /// <summary>
    /// A venda relida do banco é reconstituída com o snapshot da primeira inclusão de cada produto
    /// (<c>produtos_venda_snapshot</c>), nunca com o espelho atual: um pull no meio da venda não muda os itens já
    /// incluídos (PDV 11.3.1, 32.3). Produto sem snapshot (venda gravada antes da tabela) vem do espelho e as linhas
    /// dele ficam com o preço gravado.
    /// </summary>
    private async Task RegistrarProdutosAsync(Venda venda, CancellationToken ct)
    {
        var snapshots = await repositorio.ObterSnapshotsAsync(venda.Id, ct);
        var comSnapshot = snapshots.Select(s => s.Produto.Id).ToHashSet();
        var semSnapshot = new List<ProdutoVenda>();
        foreach (var id in venda.Itens.Select(i => i.ProdutoId).Distinct().Where(id => !comSnapshot.Contains(id)))
        {
            if (await catalogo.ObterAsync(id, ct) is { } produto)
            {
                semSnapshot.Add(produto);
            }
        }

        venda.RegistrarProdutos(snapshots, semSnapshot, relogio.Agora, sessao.UsaPrecoVolume, sessao.Operador?.LimiteDescontoEfetivoPct);
    }

    /// <param name="pesquisaSoNumeros">
    /// A "pesquisa só por números" do terminal (configuração do terminal): letras são recusadas
    /// (<see cref="MensagemPesquisaSoNumeros"/>), e os dígitos que não acham produto (parte do código: "7891149", "44") abrem
    /// a pesquisa só por números com eles, em vez do "Produto não encontrado" (quem só tem o teclado numérico não tem o F2).
    /// </param>
    public async Task<ResultadoEntrada> ProcessarEntradaAsync(
        string texto, decimal? multiplicadorPendente, CancellationToken ct = default, bool pesquisaSoNumeros = false)
    {
        var entrada = EntradaCodigo.Interpretar(texto, multiplicadorPendente);
        if (entrada.Tipo == TipoEntrada.Decrementar && await ReducaoDoUltimoExigeLiberacaoAsync(ct) is { } reducao)
        {
            throw reducao;
        }

        switch (entrada.Tipo)
        {
            case TipoEntrada.Vazia:
                return new ResultadoEntrada(TipoResultadoEntrada.Nada);
            case TipoEntrada.Invalida:
                throw new RegraNegocioException(entrada.Mensagem ?? "Entrada inválida.");
            case TipoEntrada.DefinirMultiplicador:
                return new ResultadoEntrada(TipoResultadoEntrada.MultiplicadorDefinido, Multiplicador: entrada.Quantidade);
            case TipoEntrada.Pesquisa when pesquisaSoNumeros && !SoDigitos(entrada.Codigo):
                throw new RegraNegocioException(MensagemPesquisaSoNumeros);
            case TipoEntrada.Pesquisa:
                return new ResultadoEntrada(TipoResultadoEntrada.AbrirPesquisa, TextoPesquisa: entrada.Codigo);
            case TipoEntrada.Incrementar or TipoEntrada.Decrementar:
                var alterado = await ExecutarAsync(
                    v => v.IncrementarUltimoItem(entrada.Tipo == TipoEntrada.Incrementar ? 1 : -1, Limite), null, ct, (v, item) => Afetados(v, item));
                return new ResultadoEntrada(TipoResultadoEntrada.ItemIncluido, alterado);
        }

        var codigo = entrada.Codigo!;
        var encontrados = await catalogo.ResolverAsync(codigo, ct);
        if (encontrados.Count == 0 && pesquisaSoNumeros && SoDigitos(codigo))
        {
            // O multiplicador digitado ("3*44") vale para o produto escolhido na pesquisa.
            return new ResultadoEntrada(TipoResultadoEntrada.AbrirPesquisa, Multiplicador: entrada.Quantidade, TextoPesquisa: codigo);
        }

        if (encontrados.Count == 0)
        {
            throw new RegraNegocioException($"Produto não encontrado: {codigo}");
        }

        return await IncluirResolvidoAsync(encontrados[0], entrada.Quantidade, codigo, null, ct);
    }

    /// <summary>
    /// Inclui o produto resolvido (código lido ou pesquisa): combo com alternativas devolve <see cref="TipoResultadoEntrada.MontarCombo"/>
    /// para a tela abrir o diálogo; combo sem alternativas entra direto com os padrões (PDV 10.9.1).
    /// </summary>
    public async Task<ResultadoEntrada> IncluirResolvidoAsync(
        ProdutoResolvido resolvido,
        decimal quantidade,
        string? codigo,
        string? origemEntrada = null,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(resolvido);
        // F2-B34 (D44): o código de uma variação e o pai com variação ativa, pelo bipe e pela pesquisa, antes de abrir a venda.
        if (resolvido.ExigeVariacao && GuardaVariacoes.Motivo(resolvido, await RecusaProdutoComVariacoesAsync(ct)) is { } recusa)
        {
            throw new RegraNegocioException(recusa);
        }

        if (resolvido.Produto.EhKit)
        {
            var combo = await catalogo.ObterComboAsync(resolvido.Produto.Id, ct)
                        ?? throw new RegraNegocioException($"{resolvido.Produto.Descricao}: composição do combo não encontrada — procure o gerente.");
            if (combo.ExigeEscolha)
            {
                return new ResultadoEntrada(TipoResultadoEntrada.MontarCombo, Multiplicador: quantidade, Combo: combo, Codigo: codigo);
            }

            var linhas = await IncluirComboAsync(combo, combo.EscolhasPadrao, quantidade, codigo, origemEntrada, ct);
            return new ResultadoEntrada(TipoResultadoEntrada.ItemIncluido, linhas[0]);
        }

        var item = await IncluirAsync(resolvido, quantidade, codigo, origemEntrada, ct);
        return new ResultadoEntrada(TipoResultadoEntrada.ItemIncluido, item);
    }

    /// <summary><c>pdv.consulta_outras_lojas</c> da loja do terminal (F2-B35; padrão do catálogo: ligada).</summary>
    public async Task<bool> ConsultaOutrasLojasLigadaAsync(CancellationToken ct = default) =>
        sessao.Identidade is { } identidade
            ? await configuracoes.ObterBoolAsync(ChavesConfiguracao.ConsultaOutrasLojas, identidade.LojaId, ct)
            : ChavesConfiguracao.PadroesBool[ChavesConfiguracao.ConsultaOutrasLojas];

    /// <summary><c>pdv.recusa_produto_com_variacoes</c> da loja do terminal (padrão do catálogo: ligada).</summary>
    private async Task<bool> RecusaProdutoComVariacoesAsync(CancellationToken ct) =>
        sessao.Identidade is { } identidade
            ? await configuracoes.ObterBoolAsync(ChavesConfiguracao.RecusaProdutoComVariacoes, identidade.LojaId, ct)
            : ChavesConfiguracao.PadroesBool[ChavesConfiguracao.RecusaProdutoComVariacoes];

    /// <summary>Inclui o combo com as escolhas do diálogo Montar combo (ou os padrões), PDV 10.9.1.</summary>
    public async Task<IReadOnlyList<ItemVenda>> IncluirComboAsync(
        ComboResolvido combo,
        IReadOnlyList<int> escolhas,
        decimal quantidade,
        string? codigoLido,
        string? origemEntrada = null,
        CancellationToken ct = default)
    {
        var agora = relogio.Agora;
        await AbrirVendaSeNecessarioAsync(v => Afetados(v, v.AdicionarCombo(combo, escolhas, quantidade, codigoLido, agora)), ct);
        return await ExecutarAsync(
            v => v.AdicionarCombo(combo, escolhas, quantidade, codigoLido, agora, origemEntrada), null, ct, (v, linhas) => Afetados(v, linhas));
    }

    /// <summary>Preço de 1 combo (sem acréscimos) para o diálogo Montar combo, no relógio corrigido da venda (30.5).</summary>
    public decimal PrecoKit(ComboResolvido combo)
    {
        ArgumentNullException.ThrowIfNull(combo);
        return Venda.PrecoKit(combo.Kit, relogio.Agora);
    }

    /// <summary>O item é de produto cheio retornável: a tela pergunta os cascos trazidos (PDV 10.12).</summary>
    public bool ExigeCascos(ItemVenda item) => Atual is { } v && v.ExigeCascos(item);

    /// <summary>Registra os cascos trazidos; os faltantes viram item do casco ao preço do vasilhame.</summary>
    public async Task<ItemVenda?> RegistrarCascosAsync(int sequenciaCheio, decimal trazidos, CancellationToken ct = default)
    {
        var venda = Atual ?? throw new RegraNegocioException("Não há venda em andamento.");
        var cheio = venda.ObterItem(sequenciaCheio);
        var produto = venda.ProdutosRegistrados.FirstOrDefault(p => p.Id == cheio.ProdutoId);
        var cascoId = produto?.VasilhameProdutoId ?? throw new RegraNegocioException($"O item {sequenciaCheio} não é de produto retornável.");
        var casco = await catalogo.ObterAsync(cascoId, ct)
                    ?? throw new RegraNegocioException("Casco (vasilhame) do produto não está no catálogo local — procure o gerente.");
        return await ExecutarAsync(
            v => v.RegistrarCascosTrazidos(sequenciaCheio, trazidos, casco, relogio.Agora),
            (v, _) => [new RegistroAuditoria("cascos_trazidos", Operador.Id, "item_venda", cheio.Id,
                $"Item {sequenciaCheio}: {trazidos:0} cascos trazidos de {v.Cascos(sequenciaCheio).Devidos:0} devidos")],
            ct);
    }

    /// <summary>
    /// Desconto na venda atual pelo valor do casco (F11 › V com a venda em andamento; PDV 10.12, O14 do dono; C11c): os
    /// vazios além dos devidos viram desconto no total (origem <c>cliente</c>) e entrada pelo bloco <c>vasilhames</c>. A
    /// quantidade substitui a anterior do mesmo casco; 0 tira o desconto. Aumentar o crédito exige
    /// <c>pdv.venda.desconto_total</c> e, acima de <c>pdv.desconto_cascos_max_sem_supervisor</c> (R$ 50,00 por venda no
    /// padrão; 0 = sem teto), o supervisor (README › decisão 56; roadmap D38, decidida pelo dono): sem a
    /// <paramref name="liberacao"/>, nada muda e o resultado diz o que a tela pede. O serviço confere, sem confiar só na
    /// tela; reduzir ou tirar não pede nada. Auditado localmente como os cascos trazidos (a venda sobe com o operador e o
    /// crédito); com a liberação, também a auditoria <c>liberacao</c> e a linha <c>desconto_cascos</c> de <c>liberacoes</c>.
    /// </summary>
    public async Task<ResultadoCascosDescontados> DescontarCascosAsync(
        Guid produtoVasilhameId,
        int quantidade,
        LiberacaoConcedida? liberacao = null,
        CancellationToken ct = default)
    {
        if (Atual is not { } venda)
        {
            throw new RegraNegocioException("Não há venda em andamento.");
        }

        if (liberacao is not null && !liberacao.Supervisor.Tem(PermissoesPdv.DescontoTotal))
        {
            throw new RegraNegocioException($"{liberacao.Supervisor.Nome} não tem a permissão para dar desconto no total.");
        }

        var casco = await catalogo.ObterAsync(produtoVasilhameId, ct)
                    ?? throw new RegraNegocioException(ServicoCaixa.MensagemVasilhameInvalido);
        var agora = relogio.Agora;
        var credito = venda.DescontoCascosCom(casco, quantidade, agora);
        if (liberacao is null && credito > venda.DescontoCascos)
        {
            if (!Operador.Tem(PermissoesPdv.DescontoTotal))
            {
                return new ResultadoCascosDescontados(null, $"Desconto dos cascos de R$ {NumeroBr.Dinheiro(credito)} (sem permissão de desconto)");
            }

            var teto = sessao.Identidade is { } identidade
                ? await configuracoes.ObterDinheiroAsync(
                    ChavesConfiguracao.DescontoCascosMaxSemSupervisor, identidade.LojaId, ChavesConfiguracao.DescontoCascosMaxSemSupervisorPadrao, ct)
                : ChavesConfiguracao.DescontoCascosMaxSemSupervisorPadrao;
            if (teto is > 0m && credito > teto)
            {
                return new ResultadoCascosDescontados(
                    null, $"Desconto dos cascos de R$ {NumeroBr.Dinheiro(credito)} (sem supervisor: até R$ {NumeroBr.Dinheiro(teto.Value)})");
            }
        }

        var core = liberacao is null
            ? null
            : new Liberacao(liberacao.Supervisor.Id, liberacao.Supervisor.LimiteDescontoPct, liberacao.Motivo, liberacao.ConcedidaEm,
                liberacao.Supervisor.Master);
        var descontado = await ExecutarAsync(
            v => v.DescontarCascos(casco, quantidade, agora, core),
            (v, r) =>
            {
                var texto = r is null
                    ? $"Desconto dos cascos {casco.Descricao} retirado da venda {venda.NumeroExibicao}"
                    : $"{r.Quantidade} casco(s) {r.Descricao} descontado(s) na venda {venda.NumeroExibicao}: R$ {r.Valor:N2}";
                var registro = new RegistroAuditoria("cascos_descontados", Operador.Id, "venda", v.Id,
                    texto + (core is null ? string.Empty : " liberado pelo supervisor"), core?.SupervisorId);
                return core is null || r is null
                    ? [registro]
                    : [registro, LiberacaoDesconto("vendas", v.Id, $"Desconto dos cascos de R$ {v.DescontoCascos:N2}", "desconto_cascos", v.DescontoCascos, core)];
            },
            ct);
        return new ResultadoCascosDescontados(descontado, null);
    }

    public async Task<ItemVenda> IncluirAsync(
        ProdutoResolvido produto,
        decimal quantidade,
        string? codigoLido,
        string? origemEntrada = null,
        CancellationToken ct = default)
    {
        var agora = relogio.Agora;
        await AbrirVendaSeNecessarioAsync(v => Afetados(v, v.AdicionarItem(produto, quantidade, codigoLido, agora)), ct);
        return await ExecutarAsync(
            v => v.AdicionarItem(produto, quantidade, codigoLido, agora, origemEntrada: origemEntrada), null, ct, (v, item) => Afetados(v, item));
    }

    /// <summary>
    /// Valida a inclusão numa venda descartável antes de reservar o número: item recusado — pela regra, pelo saldo com o
    /// bloqueio ligado ou pelo caixa — não gasta número.
    /// </summary>
    private async Task AbrirVendaSeNecessarioAsync(Func<Venda, IReadOnlyCollection<Guid>> validar, CancellationToken ct)
    {
        if (VendaAberta)
        {
            return;
        }

        // PDV 8.1, 8.3 (C11a): sem caixa aberto não há venda. O terminal sem o serviço de caixa (testes antigos do
        // Core/Data) segue sem sessão.
        if (caixa is not null && sessao.SessaoCaixa is null)
        {
            throw new RegraNegocioException(MensagemCaixaFechado);
        }

        // T13: a venda nem começa se a nuvem não aceita o `venda.finalizada` (o gravador recusaria no commit).
        if (!await repositorioCaixa.TipoAceitoAsync("venda.finalizada", FabricaEventos.VersaoSchemaVenda, ct))
        {
            throw new RegraNegocioException(Data.Outbox.GravadorOutbox.MensagemTipoNaoAnunciado("venda.finalizada", FabricaEventos.VersaoSchemaVenda));
        }

        await GarantirTempoOfflineAsync(ct);

        // SYNC 8.6 (C15): com a lacuna a declarar, a venda nova espera o supervisor (a que está aberta termina).
        if (sincronizacao.Situacao is { Terminal: EstadoTerminalSync.Lacuna, Lacuna: { } lacuna })
        {
            throw new RegraNegocioException(MensagemLacuna(lacuna.Faixa));
        }

        // Só a venda nova: a que está aberta termina (SYNC 2.5, empresa suspensa: "bloqueia novas vendas após a atual").
        if (sincronizacao.Situacao.Terminal is EstadoTerminalSync.HardwareAlterado or EstadoTerminalSync.Regressao or EstadoTerminalSync.Bloqueado
            or EstadoTerminalSync.Suspenso)
        {
            throw new RegraNegocioException(MensagemTerminalBloqueado);
        }

        // PDV 8.1: sessão de dia operacional anterior com `pdv.bloqueia_sessao_dia_anterior` não aceita venda nova.
        if (caixa?.AvaliarSessao() is { Situacao: Core.Caixa.SituacaoSessao.Bloqueada } bloqueio)
        {
            throw new RegraNegocioException(bloqueio.Mensagem!);
        }

        var agora = relogio.Agora;
        var descartavel = Venda.Iniciar(Guid.Empty, 1, sessao.Contexto(), Operador.Id, agora);
        var produtos = validar(descartavel);
        await ConferirEstoqueAsync(descartavel, produtos, ct);
        // PDV 20.4 (C10b): com a gaveta no limite, nenhuma venda nova começa (a em andamento termina), salvo a liberação.
        if (caixa is not null)
        {
            await caixa.GarantirLimiteParaNovaVendaAsync(ct);
        }

        var numero = await repositorio.ReservarNumeroVendaAsync(ct);
        Atual = Venda.Iniciar(IdGerador.Novo(), numero, sessao.Contexto(), Operador.Id, agora);
        AmarrarLiberacoesEstoque(Atual.Id, produtos);
    }

    /// <summary>
    /// PDV 30.6: com <c>pdv.dias_max_offline</c> preenchida, o terminal sem sincronizar além do prazo não começa venda
    /// nova. O18 do dono: a chave é nula (sem limite) e isto nunca bloqueia. A demonstração não sincroniza.
    /// </summary>
    private async Task GarantirTempoOfflineAsync(CancellationToken ct)
    {
        if (!sessao.IdentidadeReal || sessao.Identidade is not { } identidade)
        {
            return;
        }

        var limite = await configuracoes.ObterInteiroOuNuloAsync(ChavesConfiguracao.DiasMaxOffline, identidade.LojaId, null, ct);
        if (limite is not > 0)
        {
            return;
        }

        var situacao = await consultas.SituacaoOfflineAsync(ct);
        var offline = TempoOffline.Calcular(situacao.MaiorHoraVista, relogio.Agora, situacao.UltimoPullSucesso, situacao.SegundosOfflineAcumulados);
        if (TempoOffline.Excedido(offline, limite))
        {
            throw new RegraNegocioException(TempoOffline.Mensagem(limite.Value));
        }
    }

    /// <summary>Produtos cujo saldo a linha muda: o item ou, no produzido, os insumos da ficha (SYNC 15.2).</summary>
    private static IReadOnlyCollection<Guid> Afetados(Venda v, ItemVenda item)
    {
        var componentes = v.ComponentesEstoque(item);
        return componentes.Count > 0 ? componentes.Select(c => c.ProdutoId).ToList() : [item.ProdutoId];
    }

    private static IReadOnlyCollection<Guid> Afetados(Venda v, IEnumerable<ItemVenda> itens) =>
        itens.SelectMany(i => Afetados(v, i)).Distinct().ToList();

    /// <summary>
    /// Saldo estimado na inclusão (PDV 29.1; SYNC 15.1–15.2): para cada produto que controla estoque (o combo e o
    /// produzido não têm saldo próprio), saldo do espelho − vendas deste caixa ainda não refletidas − a venda em
    /// andamento. Negativo: aviso âmbar (O15 do dono, o padrão) ou, com o bloqueio ligado (online, ou offline com a chave
    /// própria), a recusa que a tela converte no pedido de liberação. A demonstração não tem estoque.
    /// </summary>
    private async Task ConferirEstoqueAsync(Venda venda, IReadOnlyCollection<Guid> produtos, CancellationToken ct)
    {
        AvisoEstoque = null;
        if (!sessao.IdentidadeReal || sessao.Identidade is not { } identidade || produtos.Count == 0)
        {
            return;
        }

        var controlados = new List<ProdutoVenda>();
        foreach (var id in produtos)
        {
            var produto = venda.ProdutosRegistrados.FirstOrDefault(p => p.Id == id) ?? await catalogo.ObterAsync(id, ct);
            if (produto is { ControlaEstoque: true } && produto.Tipo is not (TipoProduto.Kit or TipoProduto.Produzido) && produto.Tipo != "servico")
            {
                controlados.Add(produto);
            }
        }

        if (controlados.Count == 0)
        {
            return;
        }

        var loja = identidade.LojaId;
        var regras = new RegrasEstoque(
            await configuracoes.ObterBoolAsync(ChavesConfiguracao.BloqueiaVendaSemEstoque, loja, ct)
            || await configuracoes.ObterBoolAsync(ChavesConfiguracao.ValidaEstoque, loja, ct),
            await configuracoes.ObterBoolAsync(ChavesConfiguracao.BloqueioEstoqueOffline, loja, ct));
        var saldos = await consultas.SaldosEstimadosAsync(controlados.Select(p => p.Id).ToList(), ct);
        var baixas = venda.BaixasEstimadas();
        foreach (var produto in controlados)
        {
            var avaliacao = RegrasEstoqueVenda.Avaliar(
                produto.Descricao, saldos.GetValueOrDefault(produto.Id), baixas.GetValueOrDefault(produto.Id), regras, sincronizacao.Situacao.Online);
            if (avaliacao.Situacao == SituacaoEstoque.Bloqueio && !SemEstoqueLiberado(produto.Id, venda))
            {
                throw new EstoqueInsuficienteException(avaliacao.Mensagem!, produto.Id);
            }

            if (avaliacao.Situacao != SituacaoEstoque.Normal)
            {
                AvisoEstoque ??= avaliacao.Situacao == SituacaoEstoque.Bloqueio
                    ? $"{produto.Descricao}: vendido sem estoque com a liberação do supervisor."
                    : avaliacao.Mensagem;
            }
        }
    }

    /// <summary>
    /// Liberação do supervisor para vender o produto sem estoque (29.1, <c>pdv.venda.vender_sem_estoque</c>): vale para a
    /// venda em andamento (ou a que o item vai abrir, no mesmo login) e fica na auditoria <c>liberacao</c>, que sobe no
    /// lote. A auditoria é gravada antes: se ela falha (a trava D22 na desativação, erro do SQLite), nada fica liberado.
    /// </summary>
    public async Task LiberarSemEstoqueAsync(Guid produtoId, LiberacaoConcedida liberacao, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(liberacao);
        if (!liberacao.Supervisor.Tem(PermissoesPdv.VenderSemEstoque))
        {
            throw new RegraNegocioException($"{liberacao.Supervisor.Nome} não tem a permissão para liberar a venda sem estoque.");
        }

        var descricao = (await catalogo.ObterAsync(produtoId, ct))?.Descricao ?? "produto";
        await terminal.RegistrarAuditoriaAsync("liberacao", Operador.Id, "produtos", produtoId,
            $"Venda sem estoque de {descricao} liberada por {liberacao.Supervisor.Nome}", "PDV › Venda", liberacao.Supervisor.Id, ct,
            liberacao.Motivo);
        _semEstoqueLiberados.Add(new LiberacaoEstoque(produtoId, Operador, VendaAberta ? Atual!.Id : null));
    }

    /// <summary>
    /// F4 Remover item e o "Remover" da janela do item (PDV 13.1): pede o supervisor quando o operador não tem
    /// <c>pdv.venda.cancelar_item</c> ou quando <c>pdv.cancelar_item_exige_supervisor</c> (nuvem, padrão desligada) está ligada.
    /// </summary>
    public async Task<bool> CancelarItemExigeLiberacaoAsync(CancellationToken ct = default) =>
        !Operador.Tem(PermissoesPdv.CancelarItem)
        || (sessao.Identidade is { } identidade
            && await configuracoes.ObterBoolAsync(ChavesConfiguracao.CancelarItemExigeSupervisor, identidade.LojaId, ct));

    /// <summary>
    /// F3, a janela do item e o "−" (PDV 13.1, decisão 65): diminuir a quantidade tira unidades da venda, então é um
    /// cancelamento parcial. Quem pode cancelar item sozinho (<see cref="CancelarItemExigeLiberacaoAsync"/>) diminui como
    /// sempre; sem a permissão, a redução é recusada com <see cref="ReducaoExigeLiberacaoException"/> e a tela pede o
    /// supervisor e faz o cancelamento parcial liberado (<see cref="CancelarItemAsync"/>: linha cancelada, <c>autorizado_por_id</c>
    /// e auditorias <c>item_cancelado</c> e <c>liberacao</c>). Aumentar não muda.
    /// </summary>
    public async Task AlterarQuantidadeAsync(int sequencia, decimal quantidade, CancellationToken ct = default)
    {
        // Só a redução que o Core aceitaria pede o supervisor (combo, casco, decimal fora do fracionável e fora do fator
        // da embalagem continuam com a recusa de sempre, antes de qualquer PIN).
        if (Atual is { Aberta: true } venda && venda.ObterItem(sequencia) is { Cancelado: false, EhKit: false, EhCasco: false } item
            && quantidade > 0m && quantidade < item.Quantidade
            && (item.Fracionavel || decimal.Truncate(quantidade) == quantidade)
            && quantidade % (item.Embalagem?.Fator ?? 1m) == 0m
            && await CancelarItemExigeLiberacaoAsync(ct))
        {
            throw new ReducaoExigeLiberacaoException(item, item.Quantidade - quantidade);
        }

        await ExecutarAsync(
            v =>
            {
                v.AlterarQuantidade(sequencia, quantidade, Limite);
                return v.ObterItem(sequencia);
            },
            null,
            ct,
            (v, item) => Afetados(v, item));
    }

    /// <summary>
    /// "−" sem poder cancelar item (<see cref="AlterarQuantidadeAsync"/>): a redução de 1 (ou de um fardo) do último item
    /// pede o supervisor. Nulo quando pode, ou quando o Core vai recusar o "−" de qualquer jeito (fracionado, abaixo de 1).
    /// </summary>
    private async Task<ReducaoExigeLiberacaoException?> ReducaoDoUltimoExigeLiberacaoAsync(CancellationToken ct)
    {
        if (Atual is not { Aberta: true } venda || venda.ItensAtivos.LastOrDefault(i => !i.EhCasco) is not { Fracionavel: false } ultimo)
        {
            return null;
        }

        var passo = ultimo.Embalagem?.Fator ?? 1m;
        return ultimo.Quantidade - passo >= passo && await CancelarItemExigeLiberacaoAsync(ct)
            ? new ReducaoExigeLiberacaoException(ultimo, passo)
            : null;
    }

    /// <summary>
    /// Cancela o item (F4, PDV 13.1). Sem a <paramref name="liberacao"/>, exige que o operador possa cancelar sozinho
    /// (<see cref="CancelarItemExigeLiberacaoAsync"/>; o serviço confere também, sem confiar só na tela); com ela, o
    /// supervisor precisa de <c>pdv.venda.cancelar_item</c>, vira o <c>autorizado_por_id</c> e o motivo da linha cancelada,
    /// e o mesmo commit grava a auditoria <c>liberacao</c> (31.3; o motivo sobe em <c>depois.motivo</c>).
    /// </summary>
    /// <returns>A linha com o restante, no cancelamento parcial (a tela pergunta os cascos de novo se for retornável).</returns>
    public async Task<ItemVenda?> CancelarItemAsync(int sequencia, decimal? quantidade, LiberacaoConcedida? liberacao = null, CancellationToken ct = default)
    {
        if (liberacao is null && await CancelarItemExigeLiberacaoAsync(ct))
        {
            throw new RegraNegocioException(ServicoCaixa.MensagemSemPermissao);
        }

        if (liberacao is not null && !liberacao.Supervisor.Tem(PermissoesPdv.CancelarItem))
        {
            throw new RegraNegocioException($"{liberacao.Supervisor.Nome} não tem a permissão para cancelar item.");
        }

        Guid? itemId = null;
        return await ExecutarAsync(
            v =>
            {
                itemId = v.ObterItem(sequencia).Id;
                return v.CancelarItem(sequencia, Operador.Id, relogio.Agora, Limite, quantidade, liberacao?.Motivo, liberacao?.Supervisor.Id);
            },
            (v, _) =>
            {
                var texto = $"Item {sequencia} cancelado na venda {v.NumeroExibicao}";
                var cancelado = new RegistroAuditoria("item_cancelado", Operador.Id, "item_venda", itemId!.Value,
                    texto + (liberacao is null ? string.Empty : $" com liberação de {liberacao.Supervisor.Nome}"), liberacao?.Supervisor.Id);
                return liberacao is null
                    ? [cancelado]
                    : [cancelado, new RegistroAuditoria("liberacao", Operador.Id, "itens_venda", itemId.Value,
                        $"{texto} liberado pelo supervisor", liberacao.Supervisor.Id, "PDV › Venda", liberacao.Motivo)];
            },
            ct);
    }

    /// <param name="liberacao">
    /// Liberação do supervisor (PDV 12.3, 31.3; C10a): usada só acima do limite do operador, vira linha de <c>liberacoes</c>,
    /// a auditoria do desconto leva o <c>autorizado_por_id</c> e o mesmo commit grava a auditoria <c>liberacao</c>, que sobe
    /// no lote de auditoria (SYNC 9.7, 9.22: com o motivo em <c>depois.motivo</c>).
    /// </param>
    /// <remarks>
    /// Sem <c>pdv.venda.desconto_item</c> no perfil (PDV 12.2), o limite do operador vale 0%: todo desconto pede o
    /// supervisor (<see cref="SituacaoDesconto.ExigeLiberacao"/>), e o liberado fica com a liberação gravada.
    /// </remarks>
    public Task<ResultadoDesconto> DescontoItemAsync(int sequencia, Desconto desconto, Liberacao? liberacao = null, CancellationToken ct = default) =>
        ExecutarAsync(
            v => v.AplicarDescontoItem(sequencia, desconto, LimiteDoDesconto(PermissoesPdv.DescontoItem), liberacao),
            (v, r) =>
            {
                if (!r.Aplicado)
                {
                    return [];
                }

                var item = v.ObterItem(sequencia);
                var texto = $"Desconto de R$ {r.Valor:N2} ({r.PercentualPedido:N2}%) no item {sequencia}";
                var desc = new RegistroAuditoria("desconto_item", Operador.Id, "item_venda", item.Id,
                    texto + (r.PorLiberacao ? " liberado pelo supervisor" : string.Empty), r.PorLiberacao ? liberacao!.SupervisorId : null);
                return r.PorLiberacao
                    ? [desc, LiberacaoDesconto("itens_venda", item.Id, texto, "desconto_item", r.Valor, liberacao!)]
                    : [desc];
            },
            ct);

    /// <remarks>Sem <c>pdv.venda.desconto_total</c> no perfil, o limite do operador vale 0% (como no item).</remarks>
    public Task<ResultadoDesconto> DescontoTotalAsync(Desconto desconto, Liberacao? liberacao = null, CancellationToken ct = default) =>
        ExecutarAsync(
            v => v.AplicarDescontoTotal(desconto, LimiteDoDesconto(PermissoesPdv.DescontoTotal), liberacao),
            (v, r) =>
            {
                if (!r.Aplicado)
                {
                    return [];
                }

                var texto = $"Desconto no total de R$ {r.Valor:N2} ({r.PercentualPedido:N2}%)";
                var desc = new RegistroAuditoria("desconto_total", Operador.Id, "venda", v.Id,
                    texto + (r.PorLiberacao ? " liberado pelo supervisor" : string.Empty), r.PorLiberacao ? liberacao!.SupervisorId : null);
                return r.PorLiberacao
                    ? [desc, LiberacaoDesconto("vendas", v.Id, texto, "desconto_total", r.Valor, liberacao!)]
                    : [desc];
            },
            ct);

    /// <summary>
    /// Auditoria <c>liberacao</c> do desconto acima do limite (PDV 31.3), no formato da fixture da SYNC 9.22: entidade da
    /// nuvem, <c>PDV › Desconto</c>, o valor no <c>depois</c> (o motivo entra nele no lote) e o supervisor.
    /// </summary>
    private RegistroAuditoria LiberacaoDesconto(string entidade, Guid registroId, string texto, string chave, decimal valor, Liberacao liberacao) =>
        new("liberacao", Operador.Id, entidade, registroId, $"{texto} liberado pelo supervisor", liberacao.SupervisorId, "PDV › Desconto",
            liberacao.Motivo, Depois: new JsonObject { [chave] = FormatoProtocolo.Dinheiro(valor) }.ToJsonString());

    public Task RemoverDescontoItemAsync(int sequencia, CancellationToken ct = default) =>
        ExecutarAsync(
            v =>
            {
                v.RemoverDescontoItem(sequencia);
                return true;
            },
            (v, _) => [new RegistroAuditoria("desconto_item_removido", Operador.Id, "item_venda", v.ObterItem(sequencia).Id,
                $"Desconto do item {sequencia} removido")],
            ct);

    public Task RemoverDescontoTotalAsync(CancellationToken ct = default) => ExecutarAsync(v => v.RemoverDescontoTotal(), ct);

    /// <summary>F10: abre o pagamento e relê as regras dele (16.1, 16.7).</summary>
    public async Task IniciarPagamentoAsync(CancellationToken ct = default)
    {
        await ExigirSessaoDaVendaAsync(ct);
        await CarregarRegrasPagamentoAsync(ct);
        await ExecutarAsync(v => v.IniciarPagamento(), ct);
    }

    public async Task CarregarRegrasPagamentoAsync(CancellationToken ct = default) =>
        RegrasPagamento = sessao.Identidade is { } identidade
            ? new RegrasPagamento(await configuracoes.ObterBoolAsync(ChavesConfiguracao.PixManualExigeSupervisor, identidade.LojaId, ct))
            : RegrasPagamento.Padrao;

    /// <summary>
    /// Formas que o caixa oferece (16.1; C8b): as do espelho que valem na loja, ativas, de uso no PDV, na ordem, menos as
    /// que a 1C não lança (TEF, crediário, boleto, vale…, <see cref="FluxoPagamento.Indisponivel"/>).
    /// </summary>
    public async Task<IReadOnlyList<FormaPagamentoInfo>> FormasPagamentoAsync(CancellationToken ct = default) =>
        (await formas.FormasPagamentoAsync(ct)).Select(ParaInfo).Where(f => f.Fluxo != FluxoPagamento.Indisponivel).ToList();

    public static FormaPagamentoInfo ParaInfo(FormaPagamentoRegistro f)
    {
        ArgumentNullException.ThrowIfNull(f);
        return new FormaPagamentoInfo(
            f.Id, f.Descricao, f.MeioPagamentoFiscal, f.TipoForma, f.PermiteTroco, f.LancaQuitada, f.AbrirGaveta, f.TaxaPct, f.SempreZeradoPdv,
            f.Integracao, ExigeSupervisor: f.ExigeSupervisor || f.SenhaLiberacaoHash is not null, GeraQrPix: f.GeraQrcodePix,
            PermiteParcelar: f.PermiteParcelar, ParcelasMaximo: f.ParcelasMaximo, ExigePessoa: f.ExigePessoa,
            RestringeIdadeMinima: f.RestringeIdadeMinima);
    }

    /// <summary>
    /// Permissões que o supervisor precisa ter para liberar a forma (31.3); vazio se o operador lança sozinho. Forma com
    /// "exige supervisor" ou senha de liberação (C8b, 16.2): <c>pdv.pagamento.forma_com_senha</c>. PIX manual: sempre com
    /// <c>pdv.pix_manual_exige_supervisor</c> (O9b, padrão), ou quando o operador não tem
    /// <c>pdv.pagamento.confirmar_pix_manual</c>. As duas regras se somam (PDV 16.2, ERP 10.2): uma liberação só cobre
    /// as duas, e o supervisor precisa das duas permissões.
    /// </summary>
    public IReadOnlyList<string> PermissoesParaLancar(FormaPagamentoInfo forma)
    {
        ArgumentNullException.ThrowIfNull(forma);
        var lista = new List<string>(2);
        if (forma.ExigeSupervisor)
        {
            lista.Add(PermissoesPdv.FormaComSenha);
        }

        if (forma.Fluxo == FluxoPagamento.PixManual && (RegrasPagamento.PixManualExigeSupervisor || !Operador.Tem(PermissoesPdv.ConfirmarPixManual)))
        {
            lista.Add(PermissoesPdv.ConfirmarPixManual);
        }

        return lista;
    }

    /// <summary>
    /// A permissão que o diálogo de liberação pede (a primeira de <see cref="PermissoesParaLancar"/>), ou nula se o
    /// operador lança sozinho; as demais são conferidas no lançamento.
    /// </summary>
    public string? PermissaoParaLancar(FormaPagamentoInfo forma) => PermissoesParaLancar(forma).FirstOrDefault();

    /// <summary>
    /// QR estático do PIX (16.7): BR Code com a chave, o recebedor e a cidade da loja, o valor e o número da venda como
    /// <c>txid</c>, gerado offline. Só na forma com "Gera QR Code Pix" (ou integração PIX estático) e com a chave PIX na
    /// loja; sem isso, a confirmação é manual sem QR.
    /// </summary>
    public async Task<PixPreparado> PrepararPixAsync(FormaPagamentoInfo forma, decimal valor, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(forma);
        var venda = Atual ?? throw new RegraNegocioException("Não há venda em andamento.");
        var (aplicado, _) = venda.PreverPagamento(forma, valor);
        var txid = PixEstatico.Txid(venda.NumeroExibicao);
        var loja = sessao.Identidade is { } identidade ? await consultas.DadosLojaAsync(identidade.LojaId, ct) : null;
        var geraQr = forma.GeraQrPix || forma.Integracao == IntegracaoForma.PixEstatico;
        var qr = geraQr && loja?.ChavePix is { } chave
            ? PixEstatico.Gerar(chave, loja.PixNomeRecebedor ?? loja.RazaoSocial, loja.PixCidadeRecebedor ?? string.Empty, aplicado, txid)
            : null;
        return new PixPreparado(aplicado, qr, txid, loja?.ChavePix);
    }

    /// <summary>
    /// Lança um pagamento (16.1): dinheiro e "outros" direto; cartão com os dados do POS (16.5, O9c); PIX com a
    /// confirmação manual (16.7), que grava a cobrança e a auditoria <c>pix_confirmado_manual</c>. A liberação do
    /// supervisor, quando a forma pede (<see cref="PermissaoParaLancar"/>), vira o <c>autorizado_por_id</c>, a linha de
    /// <c>liberacoes</c> e a auditoria <c>liberacao</c> do mesmo commit. Quitado o total, finaliza
    /// (<c>pagamento.finaliza_ao_quitar</c>, padrão ligado).
    /// </summary>
    public async Task<ResultadoFinalizacao?> LancarPagamentoAsync(
        FormaPagamentoInfo forma,
        decimal valor,
        DetalhePagamento? detalhe = null,
        ConfirmacaoPix? pix = null,
        LiberacaoConcedida? liberacao = null,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(forma);
        var exigidas = PermissoesParaLancar(forma);
        if (exigidas.Count > 0 && liberacao is null)
        {
            throw new RegraNegocioException($"A forma {forma.Descricao} exige a liberação do supervisor.");
        }

        // Defesa em profundidade: o diálogo confere só a primeira permissão; quem liberou precisa de todas.
        if (liberacao is not null && exigidas.FirstOrDefault(p => !liberacao.Supervisor.Tem(p)) is { } faltando)
        {
            throw new RegraNegocioException($"{liberacao.Supervisor.Nome} não tem a permissão {faltando} para liberar {forma.Descricao}.");
        }

        var supervisor = liberacao is null
            ? null
            : new Liberacao(liberacao.Supervisor.Id, liberacao.Supervisor.LimiteDescontoEfetivoPct, liberacao.Motivo, liberacao.ConcedidaEm,
                liberacao.Supervisor.Master);
        await ExecutarAsync(
            v => v.LancarPagamento(forma, valor, relogio.Agora, detalhe, pix, supervisor),
            (v, p) => AuditoriaPagamento(forma, p, pix, liberacao),
            ct);
        return Atual!.Falta == 0m ? await FinalizarAsync(ct) : null;
    }

    private List<RegistroAuditoria> AuditoriaPagamento(FormaPagamentoInfo forma, PagamentoVenda p, ConfirmacaoPix? pix, LiberacaoConcedida? liberacao)
    {
        var lista = new List<RegistroAuditoria>();
        var valor = $"R$ {NumeroBr.Dinheiro(p.Valor)}";
        if (pix is not null)
        {
            var fuso = Core.Comum.DiaOperacional.ObterFuso(sessao.FusoHorario);
            lista.Add(new RegistroAuditoria("pix_confirmado_manual", Operador.Id, "pagamentos_venda", p.Id,
                $"PIX de {valor} confirmado manualmente: {pix.PagadorNome} às {TimeZoneInfo.ConvertTime(pix.PagaEm, fuso):HH:mm}",
                liberacao?.Supervisor.Id, "PDV › Pagamento",
                Depois: new JsonObject
                {
                    ["pagador_nome"] = pix.PagadorNome,
                    ["paga_em"] = FormatoProtocolo.DataHora(pix.PagaEm),
                    ["valor"] = FormatoProtocolo.Dinheiro(p.Valor),
                    ["txid"] = pix.Txid,
                }.ToJsonString()));
        }

        if (liberacao is not null)
        {
            lista.Add(new RegistroAuditoria("liberacao", Operador.Id, "pagamentos_venda", p.Id,
                $"{forma.Descricao} de {valor} liberado por {liberacao.Supervisor.Nome}", liberacao.Supervisor.Id, "PDV › Pagamento", liberacao.Motivo,
                Depois: new JsonObject { ["forma_pagamento"] = forma.Descricao, ["valor"] = FormatoProtocolo.Dinheiro(p.Valor) }.ToJsonString()));
        }

        return lista;
    }

    public Task VoltarParaItensAsync(CancellationToken ct = default) => ExecutarAsync(v => v.VoltarParaItens(), ct);

    public Task RemoverPagamentoAsync(int sequencia, CancellationToken ct = default) => ExecutarAsync(v => v.RemoverPagamento(sequencia), ct);

    /// <summary>Lança dinheiro na forma Dinheiro da loja (a primeira do tipo); quitado o total, finaliza.</summary>
    public async Task<ResultadoFinalizacao?> LancarDinheiroAsync(decimal valorRecebido, CancellationToken ct = default)
    {
        var dinheiro = (await FormasPagamentoAsync(ct)).FirstOrDefault(f => f.TipoForma == "dinheiro")
                       ?? throw new RegraNegocioException(MensagemSemFormaDinheiro);
        return await LancarPagamentoAsync(dinheiro, valorRecebido, ct: ct);
    }

    // ---------------------------------------------------------------- cliente (F5; PDV 14.1, 14.2; O8 do dono)

    /// <summary>
    /// CPF/CNPJ na nota (14.1): com ou sem máscara, com os dígitos verificadores conferidos. Se o documento é de uma
    /// pessoa ativa do espelho, a venda leva também o <c>cliente_id</c> (que aciona a relevância <c>compra</c>); senão
    /// só o documento, sem criar cadastro (o cadastro rápido é da 1D). Devolve o cliente vinculado.
    /// </summary>
    public async Task<ClienteLocal?> IdentificarDocumentoAsync(string documento, string? nome, CancellationToken ct = default)
    {
        var doc = CnpjValidador.Normalizar(documento);
        var valido = doc.Length switch
        {
            11 => doc.All(char.IsAsciiDigit) && CpfValidador.Validar(doc),
            14 => CnpjValidador.Validar(doc),
            _ => false,
        };
        if (!valido)
        {
            throw new RegraNegocioException(MensagemDocumentoInvalido);
        }

        var cliente = await consultas.ClientePorDocumentoAsync(doc, ct);
        var vinculado = cliente is { Ativa: true } ? cliente : null;
        await ExecutarAsync(v => v.IdentificarCliente(doc, nome, vinculado?.Id), ct);
        return vinculado;
    }

    /// <summary>F5 › Buscar cliente (14.2): o cliente ativo do espelho, com o documento dele na nota quando tem.</summary>
    public async Task EscolherClienteAsync(ClienteLocal cliente, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(cliente);
        if (!cliente.Ativa)
        {
            throw new RegraNegocioException(MensagemClienteInativo);
        }

        var doc = CnpjValidador.Normalizar(cliente.CpfCnpj);
        var documento = (doc.Length == 11 && CpfValidador.Validar(doc)) || (doc.Length == 14 && CnpjValidador.Validar(doc)) ? doc : null;
        await ExecutarAsync(v => v.IdentificarCliente(documento, null, cliente.Id), ct);
    }

    public Task RemoverClienteAsync(CancellationToken ct = default) => ExecutarAsync(v => v.RemoverCliente(), ct);

    public Task<IReadOnlyList<ClienteLocal>> BuscarClientesAsync(string texto, CancellationToken ct = default) =>
        consultas.BuscarClientesAsync(texto, ct);

    /// <summary>Nome do cliente vinculado à venda atual (para a tela), do espelho.</summary>
    public async Task<string?> NomeClienteAsync(CancellationToken ct = default) =>
        Atual?.ClienteId is { } id ? (await consultas.ClienteAsync(id, ct))?.Nome : null;

    /// <summary>
    /// A venda só vai ao pagamento e à finalização com a sessão de caixa (C11a): a sem sessão tenta entrar na aberta
    /// (o caixa pode ter sido aberto depois da recuperação); se não der, é recusada antes de virar evento.
    /// </summary>
    private async Task ExigirSessaoDaVendaAsync(CancellationToken ct)
    {
        await VincularSessaoSeAusenteAsync(ct);
        if (caixa is not null && Atual is { SessaoCaixaId: null })
        {
            throw new RegraNegocioException(MensagemVendaSemSessao);
        }
    }

    public async Task<ResultadoFinalizacao> FinalizarAsync(CancellationToken ct = default)
    {
        var venda = Atual ?? throw new RegraNegocioException("Não há venda em andamento.");
        await ExigirSessaoDaVendaAsync(ct);
        var eventoId = IdGerador.Novo();
        long sequencia;
        try
        {
            venda.Finalizar(relogio.Agora, eventoId);
            sequencia = await repositorio.EncerrarAsync(venda, FabricaEventos.VendaFinalizada(venda, eventoId), ct: ct);
        }
        catch
        {
            await VoltarAoGravadoAsync();
            throw;
        }

        Atual = null;
        _semEstoqueLiberados.Clear();
        AvisoEstoque = null;
        log.LogInformation("Venda {Numero} finalizada: total {Total}, troco {Troco}, evento {Sequencia}", venda.NumeroExibicao, venda.Total, venda.Troco, sequencia);

        var avisos = new List<string>();
        var texto = await EmitirEImprimirAsync(venda, avisos, ct);
        // 16.2/19.4 e dono (I4, decisão 63): a gaveta ligada abre só com algum pagamento de forma "Abrir gaveta" (o PIX e
        // o cartão, não); desligada, nada sai para ela.
        var abremGaveta = (await formas.FormasPagamentoAsync(ct)).Where(f => f.AbrirGaveta).Select(f => f.Id).ToHashSet();
        if (await gaveta.AbrirNaVendaAsync(venda.PagamentosAtivos.Any(p => abremGaveta.Contains(p.FormaPagamentoId)), ct) is { } avisoGaveta)
        {
            avisos.Add(avisoGaveta);
        }

        if (caixa is not null)
        {
            // A faixa do limite de gaveta (20.4) acompanha cada venda paga.
            await caixa.AtualizarGavetaAsync(ct);
        }

        await sincronizacao.AcordarAsync(ct);
        return new ResultadoFinalizacao(venda, sequencia, texto, avisos);
    }

    public Task CancelarVendaAsync(string motivo, CancellationToken ct = default) => CancelarVendaAsync(motivo, null, ct);

    /// <summary>
    /// Cancela a venda em andamento (Shift+F4, PDV 13.2): motivo em texto livre de 15 a 255 caracteres (O6 do dono). A
    /// tela pede a liberação do supervisor a quem não tem <c>pdv.venda.cancelar_venda_aberta</c> (fora do perfil do
    /// operador, O6); quem liberou vira o <c>cancelamento_autorizado_por_id</c> e a auditoria <c>liberacao</c>. O serviço
    /// confere a permissão também, sem confiar só na tela (como o cancelamento da venda paga e a reimpressão).
    /// </summary>
    public async Task CancelarVendaAsync(string motivo, LiberacaoConcedida? liberacao, CancellationToken ct = default)
    {
        var venda = Atual ?? throw new RegraNegocioException("Não há venda em andamento.");
        var (total, itens) = (venda.Total, venda.QtdItens);
        if (liberacao is null && !Operador.Tem(PermissoesPdv.CancelarVendaAberta))
        {
            throw new RegraNegocioException(ServicoCaixa.MensagemSemPermissao);
        }

        if (liberacao is not null && !liberacao.Supervisor.Tem(PermissoesPdv.CancelarVendaAberta))
        {
            throw new RegraNegocioException($"{liberacao.Supervisor.Nome} não tem a permissão para cancelar a venda em andamento.");
        }

        try
        {
            await VincularSessaoSeAusenteAsync(ct);
            // A venda sem sessão (da 1B, sem caixa aberto) ou de uma sessão que não é mais a aberta neste terminal não vira
            // `venda.cancelada` B: a nuvem recusaria o documento sem a sessão (ou fora dela) e o caixa ficaria preso nela.
            var foraDaSessao = caixa is not null && (venda.SessaoCaixaId is null || venda.SessaoCaixaId != sessao.SessaoCaixaId);
            venda.Cancelar(Operador.Id, motivo, relogio.Agora, liberacao?.Supervisor.Id);
            if (foraDaSessao || !await repositorioCaixa.TipoAceitoAsync("venda.cancelada", FabricaEventos.VersaoSchemaVenda, ct))
            {
                // T13 com a nuvem que ainda não aplica o `venda.cancelada` (API entre o C6b e o C7, só em homologação), ou a
                // venda fora da sessão aberta: o caixa não fica preso na venda — cancela como na 1B, sem evento, e a ação
                // do catálogo sobe na auditoria.
                await repositorio.EncerrarAsync(
                    venda,
                    null,
                    new RegistroAuditoria("cancelar", Operador.Id, "vendas", venda.Id,
                        $"Venda {venda.NumeroExibicao} em andamento cancelada (R$ {NumeroBr.Dinheiro(total)}, {itens} itens): {motivo}"),
                    ct);
            }
            else
            {
                var eventoId = IdGerador.Novo();
                await repositorio.EncerrarAsync(
                    venda,
                    FabricaEventos.VendaCancelada(venda, eventoId),
                    new RegistroAuditoria("venda_cancelada", Operador.Id, "venda", venda.Id, $"Venda {venda.NumeroExibicao} cancelada: {venda.MotivoCancelamento}",
                        liberacao?.Supervisor.Id),
                    ct);
            }

            if (liberacao is not null)
            {
                // Depois do commit da venda (o `cancelamento_autorizado_por_id` já foi com ela), como a liberação do limite de
                // gaveta: o `EncerrarAsync` grava uma auditoria só.
                await terminal.RegistrarAuditoriaAsync("liberacao", Operador.Id, "vendas", venda.Id,
                    $"Cancelamento da venda {venda.NumeroExibicao} em andamento (R$ {NumeroBr.Dinheiro(total)}) liberado por {liberacao.Supervisor.Nome}",
                    "PDV › Venda", liberacao.Supervisor.Id, ct, liberacao.Motivo);
            }
        }
        catch
        {
            await VoltarAoGravadoAsync();
            throw;
        }

        Atual = null;
        _semEstoqueLiberados.Clear();
        AvisoEstoque = null;
        await sincronizacao.AcordarAsync(ct);
    }

    // ---------------------------------------------------------------- gestão de vendas (F12; PDV 13.3, 22.1, 22.2; C11b)

    /// <summary>A gestão de vendas cancela e reimprime com o caixa livre (o estorno mexe na gaveta, a reimpressão na impressora).</summary>
    public const string MensagemCaixaLivreGestao = "Finalize ou cancele a venda atual antes: a gestão de vendas exige o caixa livre.";

    public const string MensagemVendaNaoEncontrada = "Venda não encontrada neste caixa.";

    /// <summary>A <c>localizacao</c> da auditoria da reimpressão pelo F12 (o ERP filtra por ela).</summary>
    public const string LocalizacaoGestaoVendas = "PDV › Gestão de vendas";

    /// <summary>PDV 16.3 (projeção de status): a venda cancelada não se reimprime.</summary>
    public const string MensagemReimpressaoCancelada = "Venda cancelada: não há comprovante a reimprimir.";

    /// <summary>F12 (22.1): as vendas encerradas da sessão de caixa aberta, da mais nova à mais antiga; filtro por número ou CPF/CNPJ.</summary>
    public async Task<IReadOnlyList<VendaDaSessao>> VendasDaSessaoAsync(string? filtro = null, CancellationToken ct = default)
    {
        var aberta = sessao.SessaoCaixa ?? throw new RegraNegocioException(RepositorioCaixa.MensagemSemSessao);
        return await consultas.VendasDaSessaoAsync(aberta.Id, filtro, ct);
    }

    /// <summary>A venda gravada (Enter na gestão de vendas: itens, pagamentos e cancelamento).</summary>
    public async Task<Venda> ObterVendaAsync(Guid vendaId, CancellationToken ct = default) =>
        await repositorio.ObterAsync(vendaId, ct) ?? throw new RegraNegocioException(MensagemVendaNaoEncontrada);

    /// <summary>
    /// Antes do cancelamento da venda finalizada (Ctrl+Del na gestão de vendas ou F11 › 5; PDV 13.3): caixa livre, fora da
    /// confirmação da desativação (D22), o <c>venda.cancelada</c> anunciado pela nuvem (T13: o estorno não fica sem
    /// evento, o dinheiro sai da gaveta), a venda paga **da sessão aberta** (O6 do dono) e o <c>venda.finalizada</c> dela
    /// não descartado no ERP (a nuvem não tem a venda descartada e recusaria o cancelamento para sempre). Devolve os pagamentos com as
    /// formas de devolução (O22) e, com <c>pdv.cancelamento_devolve_vazios</c> (D29), os cascos vazios que voltam ao
    /// cliente.
    /// </summary>
    public async Task<CancelamentoPreparado> PrepararCancelamentoAsync(Guid vendaId, CancellationToken ct = default)
    {
        if (VendaAberta)
        {
            throw new RegraNegocioException(MensagemCaixaLivreGestao);
        }

        if (sincronizacao.Situacao.ConfirmandoDesativacao)
        {
            throw new RegraNegocioException(ServicoCaixa.MensagemConfirmandoDesativacao);
        }

        var aberta = sessao.SessaoCaixa ?? throw new RegraNegocioException(RepositorioCaixa.MensagemSemSessao);
        if (!await repositorioCaixa.TipoAceitoAsync("venda.cancelada", FabricaEventos.VersaoSchemaVenda, ct))
        {
            throw new RegraNegocioException(Data.Outbox.GravadorOutbox.MensagemTipoNaoAnunciado("venda.cancelada", FabricaEventos.VersaoSchemaVenda));
        }

        var venda = await ObterVendaAsync(vendaId, ct);
        if (venda.Status == StatusVenda.Cancelada)
        {
            throw new RegraNegocioException($"A venda {venda.NumeroExibicao} já está cancelada.");
        }

        if (venda.Status != StatusVenda.Finalizada)
        {
            throw new RegraNegocioException("Só a venda finalizada é cancelada pela gestão de vendas.");
        }

        if (venda.SessaoCaixaId != aberta.Id)
        {
            throw new RegraNegocioException(Venda.MensagemCancelamentoForaDaSessao);
        }

        if (await consultas.FinalizadaDescartadaAsync(venda.Id, ct))
        {
            throw new RegraNegocioException(Venda.MensagemCancelamentoDescartada);
        }

        var pagamentos = venda.Pagamentos.Where(p => p.Status == StatusPagamento.Aprovado)
            .Select(p => new PagamentoACancelar(p, RegrasEstorno.Opcoes(p)))
            .ToList();
        return new CancelamentoPreparado(venda, pagamentos, await VaziosADevolverAsync(venda, ct));
    }

    /// <summary>D29: com a chave da loja ligada (padrão), os vazios trazidos na venda voltam ao cliente; desligada, nada.</summary>
    private async Task<IReadOnlyList<CascosADevolver>> VaziosADevolverAsync(Venda venda, CancellationToken ct)
    {
        var loja = sessao.Identidade?.LojaId ?? venda.LojaId;
        if (!await configuracoes.ObterBoolAsync(ChavesConfiguracao.CancelamentoDevolveVazios, loja, ct))
        {
            return [];
        }

        // O casco do produto cheio vem do cadastro (o snapshot da venda já foi apagado no encerramento).
        await RegistrarProdutosAsync(venda, ct);
        var lista = new List<CascosADevolver>();
        foreach (var r in venda.VaziosTrazidos())
        {
            var casco = await catalogo.ObterAsync(r.ProdutoVasilhameId, ct);
            lista.Add(new CascosADevolver(r.ProdutoVasilhameId, casco?.Descricao ?? "casco", r.Devolvidos));
        }

        return lista;
    }

    /// <summary>
    /// Cancela a venda finalizada (PDV 13.3; <c>venda.cancelada</c> forma A): o gerente ou o encarregado (O6 do dono e a
    /// resposta de 05/11/2026, decisão 78: <c>pdv.venda.cancelar_venda_finalizada</c>, que no seed só os dois têm; o
    /// operador e o supervisor trazem a <paramref name="liberacao"/> de um deles). Só a venda da sessão de caixa aberta
    /// (<see cref="PrepararCancelamentoAsync"/>; a de caixa fechado não se cancela no PDV, D23). Cada pagamento volta como o
    /// operador escolheu (<paramref name="escolhas"/>, O22); a venda, os <c>estorno_venda</c> por forma, o evento e a
    /// auditoria vão num commit (<see cref="RepositorioCaixa.CancelarVendaFinalizadaAsync"/>), e só depois a gaveta abre
    /// (quando sai dinheiro).
    /// </summary>
    public async Task<ResultadoCancelamentoFinalizada> CancelarFinalizadaAsync(
        Guid vendaId,
        string motivo,
        IReadOnlyDictionary<Guid, string>? escolhas = null,
        LiberacaoConcedida? liberacao = null,
        CancellationToken ct = default)
    {
        var operador = Operador;
        if (!operador.Tem(PermissoesPdv.CancelarVendaFinalizada) && liberacao is null)
        {
            throw new RegraNegocioException(ServicoCaixa.MensagemSemPermissao);
        }

        if (liberacao is not null && !liberacao.Supervisor.Tem(PermissoesPdv.CancelarVendaFinalizada))
        {
            throw new RegraNegocioException($"{liberacao.Supervisor.Nome} não tem a permissão para cancelar venda paga (gerente ou encarregado).");
        }

        var preparado = await PrepararCancelamentoAsync(vendaId, ct);
        var venda = preparado.Venda;
        var aberta = sessao.SessaoCaixa!;
        var dinheiro = await FormaDinheiroAsync(venda, ct);
        var cancelamento = venda.CancelarFinalizada(operador.Id, motivo, relogio.Agora, aberta.Id, dinheiro, escolhas, liberacao?.Supervisor.Id);
        var linhas = RepositorioCaixa.LinhasEstorno(aberta, venda, cancelamento, IdGerador.Novo);
        var evento = FabricaEventos.VendaCanceladaFinalizada(venda, cancelamento, linhas, IdGerador.Novo());
        var estornos = new JsonArray();
        foreach (var e in cancelamento.Estornos)
        {
            estornos.Add(new JsonObject
            {
                ["pagamento_venda_id"] = FormatoProtocolo.Uuid(e.PagamentoVendaId),
                ["forma"] = e.DescricaoForma,
                ["valor"] = FormatoProtocolo.Dinheiro(e.Valor),
                ["estorno"] = e.Estorno,
            });
        }

        var depois = new JsonObject
        {
            ["numero"] = venda.NumeroExibicao,
            ["total"] = FormatoProtocolo.Dinheiro(venda.Total),
            ["estornos"] = estornos,
            ["sai_da_gaveta"] = FormatoProtocolo.Dinheiro(cancelamento.SaiDaGaveta),
            ["cascos_devolvidos"] = preparado.Vazios.Sum(v => v.Quantidade),
        }.ToJsonString();
        List<RegistroAuditoria> auditoria =
        [
            new("venda_cancelada", operador.Id, "venda", venda.Id,
                $"Venda {venda.NumeroExibicao} finalizada cancelada (R$ {NumeroBr.Dinheiro(venda.Total)}): {venda.MotivoCancelamento}",
                liberacao?.Supervisor.Id, "PDV › Gestão de vendas", venda.MotivoCancelamento, Depois: depois),
        ];
        if (liberacao is not null)
        {
            auditoria.Add(new RegistroAuditoria("liberacao", operador.Id, "vendas", venda.Id,
                $"Cancelamento da venda paga {venda.NumeroExibicao} (R$ {NumeroBr.Dinheiro(venda.Total)}) liberado por {liberacao.Supervisor.Nome}",
                liberacao.Supervisor.Id, "PDV › Gestão de vendas", liberacao.Motivo, Depois: depois));
        }

        var sequencia = await repositorioCaixa.CancelarVendaFinalizadaAsync(venda, linhas, evento, ct, auditoria);
        log.LogInformation("Venda {Numero} finalizada cancelada: {Estornos} estorno(s), R$ {Gaveta} da gaveta, evento {Sequencia}",
            venda.NumeroExibicao, cancelamento.Estornos.Count, cancelamento.SaiDaGaveta, sequencia);

        var avisos = new List<string>();
        // A devolução em dinheiro é movimento do caixa: a gaveta ligada só abre com "abre nos movimentos" (decisão 63).
        if (cancelamento.SaiDaGaveta > 0m && await gaveta.AbrirNoMovimentoAsync(ct) is { } avisoGaveta)
        {
            avisos.Add(avisoGaveta);
        }

        if (caixa is not null)
        {
            await caixa.AtualizarGavetaAsync(ct);
        }

        await sincronizacao.AcordarAsync(ct);
        return new ResultadoCancelamentoFinalizada(venda, cancelamento, sequencia, Instrucoes(cancelamento, preparado.Vazios), avisos);
    }

    /// <summary>O que o operador faz no balcão depois do cancelamento (13.3; O22 e D29 do dono).</summary>
    public static IReadOnlyList<string> Instrucoes(CancelamentoFinalizada cancelamento, IReadOnlyList<CascosADevolver> vazios)
    {
        ArgumentNullException.ThrowIfNull(cancelamento);
        ArgumentNullException.ThrowIfNull(vazios);
        var lista = new List<string>();
        if (cancelamento.SaiDaGaveta > 0m)
        {
            lista.Add($"Devolva ao cliente R$ {NumeroBr.Dinheiro(cancelamento.SaiDaGaveta)} em dinheiro.");
        }

        foreach (var e in cancelamento.Estornos)
        {
            var valor = $"R$ {NumeroBr.Dinheiro(e.Valor)}";
            switch (e.Estorno)
            {
                case EstornoPagamento.PosCanceladoNaMaquininha:
                    lista.Add($"{e.DescricaoForma} de {valor}: cancelado na maquininha.");
                    break;
                case EstornoPagamento.PixDevolucaoManual:
                    lista.Add($"{e.DescricaoForma} de {valor}: devolvido pelo app do banco da loja.");
                    break;
                case EstornoPagamento.DinheiroNaoDevolvido:
                    lista.Add($"{e.DescricaoForma} de {valor}: não devolvido (fica na gaveta).");
                    break;
                case EstornoPagamento.CreditoCancelado:
                    lista.Add($"{e.DescricaoForma} de {valor}: lançamento cancelado.");
                    break;
            }
        }

        lista.AddRange(vazios.Select(v => $"Devolva ao cliente {v.Quantidade:0.###} casco(s) de {v.Descricao}."));
        return lista;
    }

    /// <summary>
    /// A forma da linha <c>estorno_venda</c> da devolução em dinheiro (O22): a Dinheiro da loja, a de um pagamento em
    /// dinheiro da venda ou a do espelho, na ordem do fechamento (a gaveta é uma só).
    /// </summary>
    private async Task<Guid> FormaDinheiroAsync(Venda venda, CancellationToken ct) =>
        (await formas.FormasPagamentoAsync(ct)).FirstOrDefault(f => f.TipoForma == "dinheiro")?.Id
        ?? venda.Pagamentos.FirstOrDefault(p => p.TipoForma == "dinheiro")?.FormaPagamentoId
        ?? (await formas.FormaDinheiroDoEspelhoAsync(ct))?.Id
        ?? (sessao.Identidade is { Demonstracao: true } ? Dinheiro.Id : throw new RegraNegocioException(MensagemSemFormaDinheiro));

    /// <summary>
    /// Reimprime o comprovante da venda finalizada (Ctrl+R na gestão de vendas, F11 › 4; PDV 22.2): o mesmo conteúdo do
    /// original (o da <c>fila_impressao</c>; sem ele, gerado de novo) com a marca "2ª VIA - REIMPRESSÃO" e a hora, e a
    /// auditoria <c>reimpressao</c>. A cancelada não se reimprime. Devolve o texto do comprovante (a impressora simulada).
    /// Não depende da sessão: a aba Vendas da Central (bloco G5) reimprime a venda de um caixa fechado e, aberta pelo
    /// login, sem operador logado: <paramref name="quem"/> é quem está na Central e <paramref name="localizacao"/> a dela.
    /// O comprovante gerado de novo leva o operador <b>da venda</b> (quem reimprime fica só na auditoria).
    /// <paramref name="autorizadoPorId"/>: quem emprestou a permissão com que a venda foi achada (a liberação da Central,
    /// para a venda de caixa fechado); vai no <c>autorizado_por_id</c> quando a reimpressão não pediu o supervisor.
    /// </summary>
    public async Task<(string Texto, IReadOnlyList<string> Avisos)> ReimprimirAsync(
        Guid vendaId, LiberacaoConcedida? liberacao = null, Operador? quem = null, string localizacao = LocalizacaoGestaoVendas,
        Guid? autorizadoPorId = null, CancellationToken ct = default)
    {
        var operador = quem ?? Operador;
        if (!operador.Tem(PermissoesPdv.Reimprimir) && liberacao is null)
        {
            throw new RegraNegocioException(ServicoCaixa.MensagemSemPermissao);
        }

        var venda = await ObterVendaAsync(vendaId, ct);
        if (venda.Status == StatusVenda.Cancelada)
        {
            throw new RegraNegocioException(MensagemReimpressaoCancelada);
        }

        if (venda.Status != StatusVenda.Finalizada)
        {
            throw new RegraNegocioException("Só a venda finalizada tem comprovante.");
        }

        var original = await consultas.ComprovanteOriginalAsync(venda.Id, ct);
        if (original is null)
        {
            await RegistrarProdutosAsync(venda, ct);
            original = (await emissor.EmitirAsync(venda, await CabecalhoAsync(await NomeOperadorDaVendaAsync(venda, operador, ct), ct), ct)).Impressao;
        }

        var agora = relogio.Agora;
        var conteudo = LayoutComprovanteVenda.Reimpressao(original, agora, sessao.FusoHorario, impressao.Colunas);
        await terminal.RegistrarAuditoriaAsync("reimpressao", operador.Id, "vendas", venda.Id,
            $"Reimpressão do comprovante da venda {venda.NumeroExibicao}" + (liberacao is null ? string.Empty : $", liberada por {liberacao.Supervisor.Nome}"),
            localizacao, liberacao?.Supervisor.Id ?? autorizadoPorId, ct, liberacao?.Motivo,
            new JsonObject { ["numero"] = venda.NumeroExibicao, ["documento"] = "cupom" }.ToJsonString());
        var avisos = new List<string>();
        if (await impressao.ImprimirAsync("cupom_reimpressao", venda.Id, conteudo, e => $"Reimpressão não impressa ({e}) — ficou na fila.", ct: ct,
                semImpressora: MensagemReimpressaoSemImpressora) is { } aviso)
        {
            avisos.Add(aviso);
        }

        return (impressao.Texto(conteudo), avisos);
    }

    /// <summary>
    /// F4 na tela do PIX (PDV 16.7; I4): imprime o QR da cobrança para o cliente ler do papel (o QR nativo da impressora
    /// ou a imagem) com o valor e o "copia e cola". Não é comprovante: a confirmação continua manual, pelo app do banco.
    /// Devolve o aviso (nulo = enviado à impressora).
    /// </summary>
    public async Task<string?> ImprimirCobrancaPixAsync(PixPreparado pix, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(pix);
        if (pix.Qrcode is not { } payload)
        {
            throw new RegraNegocioException("Esta forma de PIX não tem QR: o cliente digita a chave da loja.");
        }

        var venda = Atual ?? throw new RegraNegocioException("Não há venda em andamento.");
        var cabecalho = await CabecalhoAsync(ct);
        var conteudo = LayoutsCaixa.CobrancaPix(cabecalho.NomeLoja, venda.NumeroExibicao, pix.Valor, payload, pix.Chave, impressao.Colunas);
        // Só serve na frente do cliente: a falha fica cancelada (nunca sai horas depois pelo F7 com o QR de uma venda
        // encerrada) e, sem impressora, a tela diz que nada saiu.
        return await impressao.ImprimirAsync("cobranca_pix", venda.Id, conteudo, e => $"QR do PIX não impresso ({e}): mostre a tela ao cliente.", ct: ct,
            semImpressora: MensagemPixSemImpressora, novaTentativa: false);
    }

    public const string MensagemPixSemImpressora = "Sem impressora configurada neste caixa: mostre a tela ao cliente.";

    public const string MensagemReimpressaoSemImpressora = "Sem impressora configurada neste caixa: a 2ª via ficou só na tela.";

    public const string MensagemPesquisaSoNumeros =
        "Pesquisa só por números neste caixa: digite o código interno, o EAN ou o código adicional (sem letras).";

    /// <param name="soNumeros">
    /// A "pesquisa só por números" do terminal: só dígitos (letras recusadas), procurados nos códigos do produto — exato,
    /// depois os que começam e por fim os que contêm (<see cref="ICatalogoProdutos.PesquisarCodigoAsync"/>).
    /// </param>
    /// <returns>
    /// As linhas da pesquisa: na só por números, o código de uma embalagem (o DUN do fardo) dá a linha da embalagem, que
    /// entra como ela (<see cref="ProdutoPesquisado"/>); na por nome, sempre a unidade.
    /// </returns>
    public async Task<IReadOnlyList<ProdutoPesquisado>> PesquisarAsync(string texto, bool soNumeros = false, CancellationToken ct = default)
    {
        if (!soNumeros)
        {
            return (await catalogo.PesquisarAsync(texto, 50, ct)).Select(p => new ProdutoPesquisado(new ProdutoResolvido(p))).ToList();
        }

        var digitos = (texto ?? string.Empty).Trim();
        return SoDigitos(digitos)
            ? await catalogo.PesquisarCodigoAsync(digitos, 50, ct)
            : digitos.Length == 0 ? [] : throw new RegraNegocioException(MensagemPesquisaSoNumeros);
    }

    private static bool SoDigitos(string? texto) => !string.IsNullOrEmpty(texto) && texto.All(char.IsAsciiDigit);

    private async Task<string?> EmitirEImprimirAsync(Venda venda, List<string> avisos, CancellationToken ct)
    {
        DocumentoEmitido documento;
        try
        {
            documento = await emissor.EmitirAsync(venda, await CabecalhoAsync(ct), ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogError(e, "Falha ao gerar o comprovante da venda {Numero}", venda.NumeroExibicao);
            avisos.Add("Comprovante não gerado — use a reimpressão.");
            return null;
        }

        if (await impressao.ImprimirAsync(documento.TipoDocumentoImpressao, venda.Id, documento.Impressao,
                e => $"Cupom não impresso ({e}) — ficou na fila para reimpressão.", ct: ct) is { } aviso)
        {
            avisos.Add(aviso);
        }

        return impressao.Texto(documento.Impressao);
    }

    public const string FraseRodapePadrao = "Obrigado pela preferência!";

    /// <summary>
    /// Cabeçalho do comprovante (PDV 19.2): razão social, CNPJ, IE, endereço e telefone da loja do espelho
    /// <c>lojas</c> (os vazios caem na <c>empresa</c>) e a frase do rodapé da loja. A demonstração, sem a linha, usa os
    /// dados de exemplo.
    /// </summary>
    private Task<CabecalhoDocumento> CabecalhoAsync(CancellationToken ct) => CabecalhoAsync(Operador.Nome, ct);

    /// <summary>
    /// O nome de quem fez a venda, para o comprovante gerado de novo na reimpressão: quem reimprime (outro operador, a
    /// Central pelo login) não vira o operador da venda.
    /// </summary>
    private async Task<string> NomeOperadorDaVendaAsync(Venda venda, Operador quemReimprime, CancellationToken ct) =>
        venda.OperadorId == quemReimprime.Id ? quemReimprime.Nome
        : sessao.Operador is { } logado && logado.Id == venda.OperadorId ? logado.Nome
        : caixa is not null ? await caixa.NomeUsuarioAsync(venda.OperadorId, ct)
        : "outro operador";

    private async Task<CabecalhoDocumento> CabecalhoAsync(string nomeOperador, CancellationToken ct)
    {
        var loja = sessao.Identidade is { } identidade ? await consultas.DadosLojaAsync(identidade.LojaId, ct) : null;
        if (loja is null)
        {
            return new CabecalhoDocumento(
                NomeLoja: sessao.NomeLoja,
                RazaoSocial: "GENESIS DEMONSTRAÇÃO LTDA",
                Cnpj: "00.000.000/0001-00",
                InscricaoEstadual: "ISENTO",
                Endereco: "Rua Exemplo, 123 - Centro",
                Telefone: null,
                NomeOperador: nomeOperador,
                FraseRodape: FraseRodapePadrao,
                VersaoApp: VersaoApp.Atual,
                FusoHorario: sessao.FusoHorario);
        }

        return new CabecalhoDocumento(
            NomeLoja: loja.NomeLoja,
            RazaoSocial: loja.RazaoSocial,
            Cnpj: loja.Cnpj,
            InscricaoEstadual: loja.InscricaoEstadual,
            Endereco: loja.Endereco,
            Telefone: loja.Telefone,
            NomeOperador: nomeOperador,
            FraseRodape: loja.FraseRodape ?? FraseRodapePadrao,
            VersaoApp: VersaoApp.Atual,
            FusoHorario: sessao.FusoHorario);
    }

    private Task<T> ExecutarAsync<T>(Func<Venda, T> acao, CancellationToken ct) => ExecutarAsync(acao, null, ct, null);

    private Task ExecutarAsync(Action<Venda> acao, CancellationToken ct) =>
        ExecutarAsync(
            v =>
            {
                acao(v);
                return true;
            },
            null,
            ct,
            null);

    /// <summary>
    /// Aplica a regra e grava (venda + auditoria) num commit. A tela nunca mostra o que não está gravado: qualquer
    /// falha — da regra, do saldo com o bloqueio ligado (<paramref name="estoque"/>: os produtos cujo saldo a operação
    /// muda, 29.1) ou do banco — devolve <see cref="Atual"/> ao último estado comitado.
    /// </summary>
    private async Task<T> ExecutarAsync<T>(
        Func<Venda, T> acao,
        Func<Venda, T, IReadOnlyList<RegistroAuditoria>>? auditoria,
        CancellationToken ct,
        Func<Venda, T, IReadOnlyCollection<Guid>>? estoque = null)
    {
        var venda = Atual ?? throw new RegraNegocioException("Não há venda em andamento.");
        try
        {
            var resultado = acao(venda);
            if (estoque is not null)
            {
                await ConferirEstoqueAsync(venda, estoque(venda, resultado), ct);
            }

            await repositorio.SalvarEmAndamentoAsync(venda, auditoria?.Invoke(venda, resultado) ?? [], ct);
            return resultado;
        }
        catch
        {
            await VoltarAoGravadoAsync();
            throw;
        }
    }

    private async Task VoltarAoGravadoAsync()
    {
        try
        {
            Atual = await repositorio.ObterVendaAtualAsync(CancellationToken.None);
            if (Atual is not null)
            {
                await RegistrarProdutosAsync(Atual, CancellationToken.None);
            }
        }
        catch (Exception e)
        {
            // Mantém a exceção original para o operador. A regra do Core já desfaz a própria operação (Venda é atômica).
            log.LogError(e, "Falha ao reler a venda atual do banco local");
        }
    }
}
