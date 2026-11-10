using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Protocolo;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// F4 "Outras lojas" da pesquisa F2 (Fase 2, F2-B35; F2-Q12 = D53; PDV 10.3), no terminal de demonstração com a consulta
/// trocada (a de verdade, contra a API, é do <c>ConsultaOutrasLojasTests</c>): online mostra a quantidade de cada loja e do
/// CD, com a loja do caixa marcada; offline (ou API antiga) o aviso "requer conexão"; com <c>pdv.consulta_outras_lojas</c>
/// desligada na loja, o aviso sem consultar; o produto sem saldo próprio com a nota "não controla estoque"; e a consulta
/// que demora, cancelada pelo Esc sem prender o F4 seguinte. Em todos, Esc ou Enter voltam à pesquisa com o filtro e a
/// venda continua.
/// </summary>
public class OutrasLojasTelasTests
{
    private static readonly Guid Gelo = CatalogoDemonstracao.Produto(44);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>
    /// Consulta trocada: a resposta configurada, os produtos pedidos e o <c>ct</c> de cada pedido. Com <see cref="Segurar"/>,
    /// a resposta fica pendente até o cancelamento de quem chamou (a API que demora).
    /// </summary>
    private sealed class ConsultaFalsa : IConsultaOutrasLojas
    {
        public Func<Guid, ResultadoConsultaOutrasLojas> Responder { get; set; } =
            _ => ResultadoConsultaOutrasLojas.Indisponivel(MensagensConsultaOutrasLojas.RequerConexao);

        public bool Segurar { get; set; }

        public List<Guid> Pedidos { get; } = [];

        public List<CancellationToken> Tokens { get; } = [];

        public async Task<ResultadoConsultaOutrasLojas> ConsultarAsync(Guid produtoId, CancellationToken ct = default)
        {
            Pedidos.Add(produtoId);
            Tokens.Add(ct);
            if (Segurar)
            {
                await Task.Delay(Timeout.Infinite, ct);
            }

            return Responder(produtoId);
        }
    }

    private static RespostaSaldosOutrasLojas Saldos(Guid produto) => new(
        "2026-11-10T15:30:00.000Z",
        produto,
        true,
        [
            new SaldoLocalOnline(Guid.CreateVersion7(), SaldoLocalOnline.TipoLoja, 1, "Loja 1 - Centro", true, "4.000"),
            new SaldoLocalOnline(Guid.CreateVersion7(), SaldoLocalOnline.TipoLoja, 2, "Petiscaria 2", false, "1250.000"),
            new SaldoLocalOnline(Guid.CreateVersion7(), SaldoLocalOnline.TipoLoja, 3, "Loja 3", false, "-2.000"),
            new SaldoLocalOnline(Guid.CreateVersion7(), SaldoLocalOnline.TipoDeposito, null, "CD - Estoque Ice Beer", false, "120.500"),
        ]);

    private static async Task<(AmbienteUi Pdv, VendaViewModel Venda, ConsultaFalsa Consulta)> IniciarAsync()
    {
        var consulta = new ConsultaFalsa();
        var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<IConsultaOutrasLojas>(consulta));
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        return (pdv, venda, consulta);
    }

    /// <summary>F2, "gelo escama" e F4 sobre a linha: o diálogo dos saldos já com a consulta respondida.</summary>
    private static async Task<DialogoOutrasLojasViewModel> AbrirF4Async(AmbienteUi pdv, VendaViewModel venda)
    {
        pdv.Tecla(Key.F2);
        await pdv.EsperarFocoAsync("CampoPesquisa");
        pdv.Digitar("gelo escama");
        var pesquisa = Assert.IsType<DialogoPesquisaViewModel>(venda.Dialogo);
        await pdv.EsperarAsync(() => pesquisa.Selecionado?.Produto.Id == Gelo, "gelo na pesquisa");
        return await F4RespondidoAsync(pdv, venda);
    }

    /// <summary>F4 na pesquisa já aberta: o diálogo dos saldos (um novo) com a consulta respondida.</summary>
    private static async Task<DialogoOutrasLojasViewModel> F4RespondidoAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        pdv.Tecla(Key.F4);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoOutrasLojasViewModel { Consultando: false }, "consulta respondida");
        await pdv.EsperarFocoAsync("DialogoOutrasLojas");
        return (DialogoOutrasLojasViewModel)venda.Dialogo!;
    }

    /// <summary>
    /// Esc (ou Enter) volta à pesquisa (o filtro e a linha) sem incluir nada, e o Enter nela inclui o produto: a venda segue.
    /// </summary>
    private static async Task VoltarEIncluirAsync(AmbienteUi pdv, VendaViewModel venda, Key tecla = Key.Escape)
    {
        pdv.Tecla(tecla);
        var pesquisa = Assert.IsType<DialogoPesquisaViewModel>(venda.Dialogo);
        Assert.Equal("gelo escama", pesquisa.Filtro);
        Assert.Empty(venda.Itens);
        await pdv.EsperarFocoAsync("CampoPesquisa");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "gelo incluído depois do F4");
        Assert.Equal("12,90", pdv.Texto("TextoTotal"));
    }

    [AvaloniaFact]
    public async Task Online_mostra_as_quantidades_das_lojas_e_do_cd_e_esc_volta_a_pesquisa()
    {
        var (pdv, venda, consulta) = await IniciarAsync();
        using var _ = pdv;
        consulta.Responder = p => new ResultadoConsultaOutrasLojas(Saldos(p), null);

        var dialogo = await AbrirF4Async(pdv, venda);
        Assert.Equal([Gelo], consulta.Pedidos);
        Assert.Equal("Estoque nas outras lojas — GELO ESCAMA 5KG", dialogo.Titulo);
        Assert.Equal(
            [
                new LinhaOutraLoja("Loja 1 - Centro (esta loja)", "4 UN", true),
                new LinhaOutraLoja("Petiscaria 2", "1.250 UN", false),
                new LinhaOutraLoja("Loja 3", "-2 UN", false),
                new LinhaOutraLoja("CD - Estoque Ice Beer", "120,5 UN", false),
            ],
            dialogo.Locais);
        Assert.Null(dialogo.Aviso);
        Assert.Equal(DialogoOutrasLojasViewModel.NotaOnline, pdv.Texto("TextoNotaOutrasLojas"));
        Assert.False(pdv.Controle<Avalonia.Controls.TextBlock>("TextoAvisoOutrasLojas").IsVisible);
        pdv.Captura("82-outras-lojas-online");

        await VoltarEIncluirAsync(pdv, venda);
    }

    [AvaloniaFact]
    public async Task Offline_mostra_requer_conexao_e_a_venda_continua()
    {
        var (pdv, venda, consulta) = await IniciarAsync();
        using var _ = pdv;

        var dialogo = await AbrirF4Async(pdv, venda);
        Assert.Single(consulta.Pedidos);
        Assert.Empty(dialogo.Locais);
        Assert.Equal(MensagensConsultaOutrasLojas.RequerConexao, pdv.Texto("TextoAvisoOutrasLojas"));
        pdv.Captura("82-outras-lojas-offline");

        await VoltarEIncluirAsync(pdv, venda);
    }

    [AvaloniaFact]
    public async Task Com_a_chave_desligada_na_loja_avisa_sem_consultar()
    {
        var (pdv, venda, consulta) = await IniciarAsync();
        using var _ = pdv;
        consulta.Responder = p => new ResultadoConsultaOutrasLojas(Saldos(p), null);
        var agora = DateTimeOffset.UtcNow;
        await pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [
                new ConfiguracaoRegistro
                {
                    Id = Guid.CreateVersion7(), Escopo = "loja", LojaId = CatalogoDemonstracao.LojaDemonstracao,
                    Chave = ChavesConfiguracao.ConsultaOutrasLojas, Valor = "false", CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
            ],
            Ct);

        var dialogo = await AbrirF4Async(pdv, venda);
        Assert.Empty(consulta.Pedidos);
        Assert.Empty(dialogo.Locais);
        Assert.Equal(MensagensConsultaOutrasLojas.Desligada, pdv.Texto("TextoAvisoOutrasLojas"));

        await VoltarEIncluirAsync(pdv, venda);
    }

    [AvaloniaFact]
    public async Task Produto_sem_saldo_proprio_mostra_que_nao_controla_e_enter_volta_a_pesquisa()
    {
        var (pdv, venda, consulta) = await IniciarAsync();
        using var _ = pdv;
        // O combo, o serviço e o produzido (a API manda `controla_estoque = false` com os locais zerados).
        consulta.Responder = p => new ResultadoConsultaOutrasLojas(
            Saldos(p) with
            {
                ControlaEstoque = false,
                Locais = [.. Saldos(p).Locais.Select(l => l with { Quantidade = "0.000" })],
            },
            null);

        var dialogo = await AbrirF4Async(pdv, venda);
        Assert.Equal(DialogoOutrasLojasViewModel.NotaSemControle, pdv.Texto("TextoNotaOutrasLojas"));
        Assert.Null(dialogo.Aviso);
        Assert.All(dialogo.Locais, l => Assert.Equal("0 UN", l.Quantidade));

        await VoltarEIncluirAsync(pdv, venda, Key.Enter);
    }

    [AvaloniaFact]
    public async Task Esc_com_a_consulta_em_andamento_cancela_e_o_f4_seguinte_consulta_de_novo()
    {
        var (pdv, venda, consulta) = await IniciarAsync();
        using var _ = pdv;
        consulta.Responder = p => new ResultadoConsultaOutrasLojas(Saldos(p), null);
        consulta.Segurar = true;

        pdv.Tecla(Key.F2);
        await pdv.EsperarFocoAsync("CampoPesquisa");
        pdv.Digitar("gelo escama");
        var pesquisa = Assert.IsType<DialogoPesquisaViewModel>(venda.Dialogo);
        await pdv.EsperarAsync(() => pesquisa.Selecionado?.Produto.Id == Gelo, "gelo na pesquisa");
        pdv.Tecla(Key.F4);
        await pdv.EsperarAsync(() => consulta.Pedidos.Count == 1, "consulta pedida");
        var pendente = Assert.IsType<DialogoOutrasLojasViewModel>(venda.Dialogo);
        Assert.True(pendente.Consultando);
        await pdv.EsperarFocoAsync("DialogoOutrasLojas");
        Assert.True(pdv.Controle<Avalonia.Controls.TextBlock>("TextoConsultandoOutrasLojas").IsVisible);

        // A API não respondeu: o Esc volta na hora e cancela a consulta (o `ct` repassado à consulta).
        pdv.Tecla(Key.Escape);
        Assert.Same(pesquisa, venda.Dialogo);
        Assert.Equal("gelo escama", pesquisa.Filtro);
        await pdv.EsperarAsync(() => consulta.Tokens[0].IsCancellationRequested && !pendente.Consultando, "consulta cancelada");
        Assert.Empty(pendente.Locais);
        Assert.Null(pendente.Aviso);

        // O F4 seguinte não fica preso na consulta anterior: abre outra, agora respondida.
        consulta.Segurar = false;
        await pdv.EsperarFocoAsync("CampoPesquisa");
        var dialogo = await F4RespondidoAsync(pdv, venda);
        Assert.NotSame(pendente, dialogo);
        Assert.Equal([Gelo, Gelo], consulta.Pedidos);
        Assert.False(consulta.Tokens[1].IsCancellationRequested);
        Assert.Equal(4, dialogo.Locais.Count);

        await VoltarEIncluirAsync(pdv, venda);
    }
}
