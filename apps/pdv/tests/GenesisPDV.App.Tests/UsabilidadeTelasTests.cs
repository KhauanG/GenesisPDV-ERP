using Avalonia;
using Avalonia.Controls;
using Avalonia.VisualTree;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.App.ViewModels.Central;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Usabilidade do caixa (versão 0.9.1, decisão 65 do README): a barra de funções clicável (o mesmo comando da tecla e o
/// foco de volta no campo de código), a opção "texto", a pesquisa só por números, a janela do item pelo duplo clique e o
/// F4 Remover item exigindo <c>pdv.venda.cancelar_item</c> (ou a liberação do supervisor).
/// </summary>
public class UsabilidadeTelasTests
{
    private static readonly Guid Carlos = Guid.Parse("019a0003-0000-7000-8000-000000000002");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    /// <summary>A liberação do CARLOS (Master, supervisor da demonstração) com o motivo, pelo botão Liberar.</summary>
    private static async Task LiberarComCarlosAsync(AmbienteUi pdv, VendaViewModel venda, string motivo, bool esperarFechar = true)
    {
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var dialogo = Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
        dialogo.Pedido.Usuario = "2";
        dialogo.Pedido.Pin = "4321";
        dialogo.Pedido.Motivo = motivo;
        pdv.Clicar(pdv.Controle<Button>("BotaoLiberar"));
        if (esperarFechar)
        {
            await pdv.EsperarAsync(() => venda.Dialogo is not DialogoLiberacaoViewModel, "liberação concedida");
        }
    }

    /// <summary>Grava as preferências da tela do terminal e reabre a venda (a tela as lê ao abrir).</summary>
    private static async Task<VendaViewModel> PreferenciasAsync(AmbienteUi pdv, PreferenciasCaixa preferencias)
    {
        var hardware = pdv.Servicos.GetRequiredService<ServicoHardware>();
        await hardware.GravarAsync(hardware.Atual, preferencias, null, null, Ct);
        await pdv.Shell.IrParaVendaAsync();
        await pdv.EsperarFocoAsync("CampoCodigo");
        return (VendaViewModel)pdv.Shell.PaginaAtual!;
    }

    private static ListBoxItem LinhaDoItem(AmbienteUi pdv, int sequencia) =>
        pdv.LinhaDaLista("ListaItens", d => d is ItemLinhaViewModel { EhComponente: false } l && l.Sequencia == sequencia);

    /// <summary>Clica no botão da barra e espera o diálogo do tipo <typeparamref name="T"/>; Esc volta ao campo de código.</summary>
    private static async Task<T> ClicarEEsperarAsync<T>(AmbienteUi pdv, VendaViewModel venda, string tecla) where T : DialogoViewModel
    {
        pdv.Clicar(pdv.BotaoDaBarra(tecla));
        await pdv.EsperarAsync(() => venda.Dialogo is T, $"diálogo do {tecla}");
        return (T)venda.Dialogo!;
    }

    private static async Task FecharComEscAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "diálogo fechado");
        await pdv.EsperarFocoAsync("CampoCodigo");
    }

    [AvaloniaFact]
    public async Task Botoes_da_barra_disparam_o_mesmo_comando_da_tecla_e_o_foco_volta_ao_campo_de_codigo()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        Assert.True(venda.BarraBotoes);
        Assert.True(pdv.Controle<ItemsControl>("BarraFuncoes").IsVisible);
        Assert.False(pdv.Controle<StackPanel>("LegendaTeclas").IsVisible);
        Assert.Equal(
            ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "Ctrl+N", "Ctrl+T", "Shift+F4", VendaViewModel.TeclaCentral],
            venda.Atalhos.Select(a => a.Tecla));
        // Nenhum botão fica com o foco (o leitor digita no campo focado). O 16º é a engrenagem da Central (bloco G3).
        var botoes = pdv.Controle<ItemsControl>("BarraFuncoes").GetVisualDescendants().OfType<Button>().ToList();
        Assert.Equal(16, botoes.Count);
        Assert.All(botoes, b => Assert.True(b.Bounds.Height >= 44, "botão grande o bastante para mouse/toque"));
        Assert.All(botoes, b => Assert.False(b.Focusable));
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EntrarCodigoAsync("7891149103102");
        await pdv.EsperarAsync(() => venda.Itens.Count == 2, "2 itens");

        // Função das próximas fases: a mesma mensagem da tecla; o foco fica no código e o próximo bipe entra.
        pdv.Clicar(pdv.BotaoDaBarra("F7"));
        await AmbienteUi.Pausa();
        Assert.Equal("F7 Vendedor: disponível nas próximas fases.", pdv.Texto("TextoMensagem"));
        await pdv.EsperarFocoAsync("CampoCodigo");
        await pdv.EntrarCodigoAsync("7896045506873");
        await pdv.EsperarAsync(() => venda.Itens.Count == 3, "o bipe depois do clique entrou no campo de código");

        await ClicarEEsperarAsync<DialogoQuantidadeViewModel>(pdv, venda, "F3");
        await pdv.EsperarFocoAsync("CampoQuantidade");
        await FecharComEscAsync(pdv, venda);

        var remover = await ClicarEEsperarAsync<DialogoRemoverItemViewModel>(pdv, venda, "F4");
        Assert.Equal("3", remover.Sequencia);
        await pdv.EsperarFocoAsync("CampoSequencia");
        await FecharComEscAsync(pdv, venda);

        await ClicarEEsperarAsync<DialogoMenuDescontoViewModel>(pdv, venda, "F6");
        await FecharComEscAsync(pdv, venda);

        // F11: os itens do menu são clicáveis (S = status da sincronização).
        await ClicarEEsperarAsync<DialogoFuncoesViewModel>(pdv, venda, "F11");
        pdv.Clicar(pdv.Controle<Button>("OpcaoFuncaoS"));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoStatusSyncViewModel, "status do sync pelo clique");
        await FecharComEscAsync(pdv, venda);

        await ClicarEEsperarAsync<DialogoGestaoVendasViewModel>(pdv, venda, "F12");
        await FecharComEscAsync(pdv, venda);

        // Shift+F4 sem `pdv.venda.cancelar_venda_aberta` (fora do perfil): a mesma liberação da tecla.
        var liberacao = await ClicarEEsperarAsync<DialogoLiberacaoViewModel>(pdv, venda, "Shift+F4");
        Assert.Equal(PermissoesPdv.CancelarVendaAberta, liberacao.Pedido.Permissao);
        await FecharComEscAsync(pdv, venda);
        Assert.True(venda.ServicoVenda.VendaAberta);
        pdv.Captura("40-venda-barra-botoes");

        // F10 e o pagamento pelo mouse: Lançar finaliza e o foco volta ao código.
        await ClicarEEsperarAsync<DialogoPagamentoViewModel>(pdv, venda, "F10");
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("50");
        pdv.Captura("41-pagamento-botoes");
        pdv.Clicar(pdv.Controle<Button>("BotaoLancarPagamento"));
        await pdv.EsperarAsync(() => venda.CaixaLivre && venda.Dialogo is null, "venda finalizada pelo botão");
        await pdv.EsperarFocoAsync("CampoCodigo");
        Assert.StartsWith("TROCO R$", venda.TrocoTexto, StringComparison.Ordinal);

        // Em 1920×1080 a barra continua em duas linhas de 8, sem rolagem.
        pdv.Janela.Width = 1920;
        pdv.Janela.Height = 1080;
        await pdv.EntrarCodigoAsync("0044");
        await AmbienteUi.Pausa();
        var barra = pdv.Controle<ItemsControl>("BarraFuncoes");
        Assert.InRange(barra.Bounds.Height, 80, 120);
        Assert.Equal(1920 - 24, barra.Bounds.Width, 1);
        pdv.Captura("45-venda-barra-1920");
    }

    [AvaloniaFact]
    public async Task Barra_e_pesquisa_na_configuracao_do_terminal_texto_esconde_os_botoes_e_tudo_e_auditado()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();

        // F11 › 8 pelo mouse: a Central; o clique na aba 3 (com cadeado: a MARIA não tem `pdv.config.terminal`) e o
        // CARLOS libera na própria aba, pelo botão.
        await ClicarEEsperarAsync<DialogoFuncoesViewModel>(pdv, venda, "F11");
        pdv.Clicar(pdv.Controle<Button>("OpcaoFuncao8"));
        var central = await pdv.EsperarCentralAsync();
        Assert.True(central.Abas.Single(a => a.Codigo == "3").Bloqueada);
        pdv.Clicar(pdv.BotaoDaAba("3"));
        await pdv.EsperarFocoAsync("CampoUsuarioConfig");
        var tela = Assert.IsType<AbaHardwareViewModel>(central.Conteudo);
        tela.Usuario = "2";
        tela.Pin = "4321";
        pdv.Clicar(pdv.Controle<Button>("BotaoLiberarConfig"));
        await pdv.EsperarAsync(() => tela.Editando, "aba liberada");
        await pdv.EsperarFocoAsync("ListaModelo");
        Assert.False(central.Abas.Single(a => a.Codigo == "3").Bloqueada);
        Assert.Equal((0, false), (tela.BarraFuncoesIndice, tela.PesquisaSoNumeros));
        tela.BarraFuncoesIndice = 1;
        tela.PesquisaSoNumeros = true;
        await AmbienteUi.Pausa();
        pdv.Captura("42-configuracao-tela");
        pdv.Tecla(Key.F2);
        await pdv.EsperarAsync(() => tela.Mensagem?.StartsWith(AbaHardwareViewModel.MensagemSalva, StringComparison.Ordinal) == true, "salvo");
        await using (var db = Banco(pdv))
        {
            var chaves = await db.ConfiguracaoTerminal.AsNoTracking().Where(c => ChavesPreferencias.Todas.Contains(c.Chave)).ToDictionaryAsync(c => c.Chave, c => c.Valor, Ct);
            Assert.Equal("\"texto\"", chaves[ChavesPreferencias.BarraFuncoes]);
            Assert.Equal("true", chaves[ChavesPreferencias.PesquisaSomenteNumeros]);
            var auditoria = await db.LogAuditoriaLocal.AsNoTracking().SingleAsync(a => a.Acao == "editar" && a.Entidade == "configuracao_terminal", Ct);
            Assert.Contains("barra de funções em texto; pesquisa só por números", auditoria.Descricao, StringComparison.Ordinal);
            Assert.Equal(Carlos, auditoria.AutorizadoPorId);
            Assert.Contains("\"tela.barra_funcoes\":\"botoes\"", auditoria.Antes, StringComparison.Ordinal);
            Assert.Contains("\"tela.barra_funcoes\":\"texto\"", auditoria.Depois, StringComparison.Ordinal);
        }

        // De volta à venda (Esc ao menu, Esc à venda): a legenda em texto no lugar dos botões; as teclas continuam iguais.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "3", "foco no menu");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "venda");
        await pdv.EsperarFocoAsync("CampoCodigo");
        venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        Assert.False(venda.BarraBotoes);
        Assert.True(venda.PesquisaSoNumeros);
        Assert.False(pdv.Controle<ItemsControl>("BarraFuncoes").IsVisible);
        Assert.True(pdv.Controle<StackPanel>("LegendaTeclas").IsVisible);
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F3);
        await pdv.EsperarFocoAsync("CampoQuantidade");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("CampoCodigo");

        // A preferência fica gravada no terminal: o caixa reaberto lê as chaves.
        var hardware = pdv.Servicos.GetRequiredService<ServicoHardware>();
        await hardware.CarregarAsync(Ct);
        Assert.Equal(new PreferenciasCaixa(BarraBotoes: false, PesquisaSoNumeros: true), hardware.Preferencias);
    }

    [AvaloniaFact]
    public async Task Pesquisa_so_por_numeros_acha_por_codigo_na_ordem_exato_comeca_contem_e_recusa_letras()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();

        // Desligada (padrão): como antes, nome e números.
        Assert.False(venda.PesquisaSoNumeros);
        Assert.Contains((await servico.PesquisarAsync("cerv", ct: Ct)), p => p.Descricao == "CERV BRAHMA LT 350ML");
        pdv.Tecla(Key.F2);
        await pdv.EsperarFocoAsync("CampoPesquisa");
        pdv.Digitar("brahma");
        var pesquisa = Assert.IsType<DialogoPesquisaViewModel>(venda.Dialogo);
        await pdv.EsperarAsync(() => pesquisa.Resultados.Count == 1, "brahma pelo nome");
        Assert.Null(pesquisa.Erro);
        await FecharComEscAsync(pdv, venda);

        venda = await PreferenciasAsync(pdv, new PreferenciasCaixa(PesquisaSoNumeros: true));
        Assert.True(venda.PesquisaSoNumeros);

        // Texto com letras no campo de código: recusado (não abre a pesquisa por nome).
        await pdv.EntrarCodigoAsync("brahma");
        Assert.Null(venda.Dialogo);
        Assert.Equal(ServicoVenda.MensagemPesquisaSoNumeros, pdv.Texto("TextoMensagem"));
        Assert.Equal(string.Empty, venda.CodigoEntrada);

        pdv.Tecla(Key.F2);
        await pdv.EsperarFocoAsync("CampoPesquisa");
        pesquisa = Assert.IsType<DialogoPesquisaViewModel>(venda.Dialogo);
        Assert.Equal("Pesquisar produto (só números)", pesquisa.Titulo);
        Assert.StartsWith("Só números", pdv.Texto("TextoDicaPesquisa"), StringComparison.Ordinal);

        // "50": o QUEIJO (código 50, exato) primeiro; os 50x (começam) por nome; a ÁGUA (EAN 7896045506873 contém) depois deles.
        pdv.Digitar("50");
        await pdv.EsperarAsync(() => pesquisa.Resultados.Count > 3, "resultados do 50");
        var nomes = pesquisa.Resultados.Select(p => p.Descricao).ToList();
        Assert.Equal("QUEIJO COALHO KG", nomes[0]);
        var comecam = new[] { "COMBO DE WHISKY 1L", "ENERGETICO RED BULL 2L", "GELO DE COCO", "WHISKY 1L" };
        Assert.All(comecam, n => Assert.Contains(n, nomes));
        Assert.All(comecam, n => Assert.True(nomes.IndexOf(n) < nomes.IndexOf("ÁGUA CRYSTAL 500ML"), n));
        Assert.Equal(comecam.Order(StringComparer.Ordinal), nomes.Where(comecam.Contains));
        Assert.DoesNotContain("PRODUTO FORA DE LINHA", nomes);
        pdv.Captura("43-pesquisa-numeros");

        // Código adicional da embalagem (o fardo da Brahma) e o EAN principal.
        pesquisa.Filtro = "17891149103109";
        await pdv.EsperarAsync(() => pesquisa.Resultados.Count == 1 && pesquisa.Resultados[0].Descricao == "CERV BRAHMA LT 350ML", "fardo");
        pesquisa.Filtro = "7891149103102";
        await pdv.EsperarAsync(() => pesquisa.Resultados.FirstOrDefault()?.Descricao == "CERV BRAHMA LT 350ML", "EAN");

        // Letras: recusadas, lista vazia.
        pesquisa.Filtro = "cerv";
        await pdv.EsperarAsync(() => pesquisa.Erro == ServicoVenda.MensagemPesquisaSoNumeros, "letras recusadas");
        Assert.Empty(pesquisa.Resultados);
        await Assert.ThrowsAsync<RegraNegocioException>(() => servico.PesquisarAsync("12a", soNumeros: true, ct: Ct));

        // Código interno exato, com ↓/↑ e Enter (só dígitos, setas e Enter).
        pesquisa.Filtro = string.Empty;
        await AmbienteUi.Pausa();
        pdv.Digitar("0044");
        await pdv.EsperarAsync(() => pesquisa.Resultados.FirstOrDefault()?.Descricao == "GELO ESCAMA 5KG" && pesquisa.Erro is null, "gelo exato");
        pdv.Tecla(Key.Down);
        pdv.Tecla(Key.Up);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.Itens.Count == 1, "gelo incluído pelo Enter");
        await pdv.EsperarFocoAsync("CampoCodigo");

        // Pelo mouse: duplo clique na linha inclui.
        pdv.Tecla(Key.F2);
        await pdv.EsperarFocoAsync("CampoPesquisa");
        pesquisa = Assert.IsType<DialogoPesquisaViewModel>(venda.Dialogo);
        pdv.Digitar("7891149103102");
        await pdv.EsperarAsync(() => pesquisa.Resultados.Count == 1, "brahma pelo EAN");
        pdv.DuploClique(pdv.LinhaDaLista("ListaPesquisa", d => d is ProdutoPesquisado p && p.Descricao == "CERV BRAHMA LT 350ML"));
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.Itens.Count == 2, "brahma incluída pelo duplo clique");
        await pdv.EsperarFocoAsync("CampoCodigo");

        // O código completo no campo continua resolvendo direto (leitor), também o da embalagem.
        await pdv.EntrarCodigoAsync("17891149103109");
        await pdv.EsperarAsync(() => venda.Itens.Count == 3, "fardo pelo leitor");
    }

    [AvaloniaFact]
    public async Task Duplo_clique_no_item_abre_a_janela_e_muda_quantidade_e_desconto_com_e_sem_liberacao()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EntrarCodigoAsync("7891149103102");
        await pdv.EsperarAsync(() => venda.Itens.Count == 2, "2 itens");

        // Um clique só seleciona e não tira o foco do campo de código.
        pdv.Clicar(LinhaDoItem(pdv, 1));
        await pdv.EsperarAsync(() => venda.ItemSelecionado?.Sequencia == 1, "item 1 selecionado");
        await pdv.EsperarFocoAsync("CampoCodigo");

        pdv.DuploClique(LinhaDoItem(pdv, 1));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoItemViewModel, "janela do item");
        var janela = (DialogoItemViewModel)venda.Dialogo!;
        await pdv.EsperarFocoAsync("CampoQuantidadeItem");
        Assert.Equal("Item 1 — GELO ESCAMA 5KG", pdv.Texto("TituloDialogoItem"));
        Assert.Equal("1,000 UN × 12,90 = 12,90", pdv.Texto("TextoResumoItem"));

        // Quantidade: digita e Enter (a janela fica aberta com os valores novos).
        pdv.Digitar("10");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => janela.Mensagem == "Quantidade alterada para 10,000.", "quantidade alterada");
        Assert.Same(janela, venda.Dialogo);
        Assert.Equal("10,000 UN × 12,90 = 129,00", pdv.Texto("TextoResumoItem"));
        Assert.Equal("132,49", pdv.Texto("TextoTotal"));

        // Desconto dentro do limite da MARIA (10%), só por clique: "10" e o botão do % (o teclado numérico não tem a tecla %).
        pdv.Clicar(pdv.Controle<TextBox>("CampoDescontoItem"));
        await pdv.EsperarFocoAsync("CampoDescontoItem");
        pdv.Digitar("10");
        pdv.Clicar(pdv.Controle<Button>("BotaoAplicarDescontoPercentual"));
        await pdv.EsperarAsync(() => janela.Mensagem == "Desconto de R$ 12,90 aplicado.", "desconto aplicado");
        Assert.Equal("119,59", pdv.Texto("TextoTotal"));
        Assert.Equal("Desconto no item: R$ 12,90 (10,00%)", pdv.Texto("TextoDescontoItem"));
        pdv.Captura("44-janela-do-item");

        // Acima do limite: o supervisor libera (como o F6) e a janela volta com o desconto.
        janela.Desconto = "20";
        pdv.Clicar(pdv.Controle<Button>("BotaoAplicarDescontoPercentual"));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoLiberacaoViewModel, "liberação do desconto");
        Assert.Equal(PermissoesPdv.DescontoItem, ((DialogoLiberacaoViewModel)venda.Dialogo!).Pedido.Permissao);
        await LiberarComCarlosAsync(pdv, venda, "Cliente fiel");
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoItemViewModel, "janela de volta");
        Assert.Equal("Desconto de R$ 25,80 aplicado com liberação de CARLOS.", pdv.Texto("TextoMensagemItem"));
        Assert.Equal("106,69", pdv.Texto("TextoTotal"));
        await using (var db = Banco(pdv))
        {
            Assert.Equal(2, await db.LogAuditoriaLocal.CountAsync(a => a.Acao == "desconto_item", Ct));
            var liberacao = await db.LogAuditoriaLocal.SingleAsync(a => a.Acao == "liberacao" && a.Entidade == "itens_venda", Ct);
            Assert.Equal((Carlos, "Cliente fiel"), (liberacao.AutorizadoPorId, liberacao.Motivo));
            Assert.Equal(Carlos, (await db.ItensVenda.SingleAsync(i => i.Sequencia == 1, Ct)).AutorizadoPorId);
        }

        // Tirar o desconto; o mesmo número com o botão do R$ é em reais; o "%" com o botão do R$ é recusado.
        pdv.Clicar(pdv.Controle<Button>("BotaoRemoverDescontoItem"));
        await pdv.EsperarAsync(() => janela.Mensagem == "Desconto do item 1 removido.", "desconto removido");
        Assert.Equal("132,49", pdv.Texto("TextoTotal"));
        janela.Desconto = "10";
        pdv.Clicar(pdv.Controle<Button>("BotaoAplicarDescontoReais"));
        await pdv.EsperarAsync(() => janela.Mensagem == "Desconto de R$ 10,00 aplicado.", "desconto em R$");
        Assert.Equal("122,49", pdv.Texto("TextoTotal"));
        janela.Desconto = "5%";
        pdv.Clicar(pdv.Controle<Button>("BotaoAplicarDescontoReais"));
        await pdv.EsperarAsync(() => janela.Erro is not null, "% com o botão do R$");
        Assert.Equal("122,49", pdv.Texto("TextoTotal"));
        pdv.Clicar(pdv.Controle<Button>("BotaoRemoverDescontoItem"));
        await pdv.EsperarAsync(() => janela.Mensagem == "Desconto do item 1 removido.", "desconto removido de novo");
        pdv.Clicar(pdv.Controle<Button>("BotaoFecharItem"));
        await pdv.EsperarAsync(() => venda.Dialogo is null, "janela fechada");
        await pdv.EsperarFocoAsync("CampoCodigo");
    }

    [AvaloniaFact]
    public async Task Janela_do_item_respeita_fracionado_combo_remove_pelo_f4_e_item_cancelado_nao_abre()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0,795*0050");
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EntrarCodigoAsync("0510");
        await pdv.EsperarAsync(() => venda.Itens.Count(i => !i.EhComponente) == 3, "queijo, gelo e kit");

        // Pesado/fracionado (KG): aceita 3 casas, como o F3.
        pdv.DuploClique(LinhaDoItem(pdv, 1));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoItemViewModel, "janela do queijo");
        var janela = (DialogoItemViewModel)venda.Dialogo!;
        Assert.Equal("Vendido por KG: aceita até 3 casas (0,750).", pdv.Texto("TextoAvisoQuantidadeItem"));
        await pdv.EsperarFocoAsync("CampoQuantidadeItem");
        pdv.Digitar("1,25");
        pdv.Clicar(pdv.Controle<Button>("BotaoAlterarQuantidade"));
        await pdv.EsperarAsync(() => janela.Mensagem == "Quantidade alterada para 1,250.", "queijo 1,250");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "fechada");

        // Por unidade: a quantidade decimal é recusada pela mesma regra do F3.
        pdv.DuploClique(LinhaDoItem(pdv, 2));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoItemViewModel, "janela do gelo");
        janela = (DialogoItemViewModel)venda.Dialogo!;
        await pdv.EsperarFocoAsync("CampoQuantidadeItem");
        pdv.Digitar("0,5");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => janela.Erro is not null, "decimal recusado");
        Assert.Equal(1m, venda.ServicoVenda.Atual!.ObterItem(2).Quantidade);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "fechada");

        // Combo: a quantidade não muda na janela (a do F3 recusa igual); o desconto é o do combo.
        var kit = venda.Itens.First(i => i.EhTituloCombo);
        pdv.DuploClique(LinhaDoItem(pdv, kit.Sequencia));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoItemViewModel, "janela do kit");
        janela = (DialogoItemViewModel)venda.Dialogo!;
        Assert.False(janela.PodeAlterarQuantidade);
        Assert.False(pdv.Controle<TextBox>("CampoQuantidadeItem").IsEnabled);
        Assert.StartsWith("Combo:", pdv.Texto("TextoAvisoQuantidadeItem"), StringComparison.Ordinal);
        await pdv.EsperarFocoAsync("CampoDescontoItem");

        // Remover item pela janela: o mesmo diálogo do F4 (a MARIA tem `pdv.venda.cancelar_item`), o combo inteiro.
        pdv.Clicar(pdv.Controle<Button>("BotaoRemoverItemJanela"));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoRemoverItemViewModel, "cancelamento do item");
        Assert.Equal(kit.Sequencia.ToString(System.Globalization.CultureInfo.InvariantCulture), ((DialogoRemoverItemViewModel)venda.Dialogo!).Sequencia);
        pdv.Clicar(pdv.Controle<Button>("BotaoConfirmarRemover"));
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.Itens.First(i => i.EhTituloCombo).Cancelado, "combo cancelado");
        await pdv.EsperarFocoAsync("CampoCodigo");

        // Item cancelado não abre a janela.
        pdv.DuploClique(LinhaDoItem(pdv, kit.Sequencia));
        await AmbienteUi.Pausa();
        Assert.Null(venda.Dialogo);
        Assert.Equal($"Item {kit.Sequencia} cancelado: não pode ser alterado.", pdv.Texto("TextoMensagem"));
        await pdv.EsperarFocoAsync("CampoCodigo");
        await using var db = Banco(pdv);
        Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(a => a.Acao == "item_cancelado" && a.AutorizadoPorId == null, Ct));
    }

    [AvaloniaFact]
    public async Task Remover_item_sem_cancelar_item_pede_o_supervisor_o_proprio_operador_nao_libera_e_tudo_e_auditado()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>();
        var maria = sessao.Operador!;
        // O dono tirou a permissão do perfil no ERP (a do login fica no `Operador.Permissoes`).
        sessao.Operador = maria with { Permissoes = new HashSet<string>(PermissoesPdv.PerfilOperador.Where(p => p != PermissoesPdv.CancelarItem), StringComparer.Ordinal) };
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EntrarCodigoAsync("7891149103102");
        await pdv.EsperarAsync(() => venda.Itens.Count == 2, "2 itens");

        // O serviço confere também (sem confiar só na tela).
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() => servico.CancelarItemAsync(1, null, ct: Ct));
        Assert.Equal(ServicoCaixa.MensagemSemPermissao, recusa.Message);

        pdv.Tecla(Key.F4);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoLiberacaoViewModel, "liberação do F4");
        var dialogo = (DialogoLiberacaoViewModel)venda.Dialogo!;
        Assert.Equal(PermissoesPdv.CancelarItem, dialogo.Pedido.Permissao);
        // O supervisor vê qual item libera (sequência, descrição, quantidade e valor).
        Assert.Equal("Liberação do supervisor · Cancelar item 2 — CERV BRAHMA LT 350ML (1,000 UN, R$ 3,49)", dialogo.Titulo);

        // A própria MARIA não libera.
        await pdv.EsperarFocoAsync("CampoSupervisor");
        dialogo.Pedido.Usuario = "1";
        dialogo.Pedido.Pin = "1234";
        dialogo.Pedido.Motivo = "Cliente desistiu";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => dialogo.Pedido.Erro is not null, "liberação negada");
        Assert.Equal(Sync.Acesso.AutenticadorOffline.MensagemLiberadorProprio, dialogo.Pedido.Erro);
        Assert.Same(dialogo, venda.Dialogo);

        // O CARLOS libera: o diálogo do cancelamento, com o item e a auditoria.
        await LiberarComCarlosAsync(pdv, venda, "Cliente desistiu do item");
        var remover = Assert.IsType<DialogoRemoverItemViewModel>(venda.Dialogo);
        Assert.Equal("Cancelar item 2 (liberado por CARLOS)", remover.Titulo);
        Assert.Equal("2", remover.Sequencia);

        // A sequência fica travada no item liberado (o foco vai à quantidade); trocar o número não troca o item.
        await pdv.EsperarFocoAsync("CampoQuantidadeCancelar");
        Assert.True(pdv.Controle<TextBox>("CampoSequencia").IsReadOnly);
        remover.Sequencia = "1";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.Itens[1].Cancelado, "item 2 cancelado");
        Assert.False(venda.Itens[0].Cancelado);
        Assert.Equal("Item 2 cancelado com liberação de CARLOS.", pdv.Texto("TextoMensagem"));
        await pdv.EsperarFocoAsync("CampoCodigo");
        await using (var db = Banco(pdv))
        {
            var item = await db.ItensVenda.AsNoTracking().SingleAsync(i => i.Sequencia == 2, Ct);
            Assert.Equal((true, Carlos, "Cliente desistiu do item"), (item.Cancelado, item.AutorizadoPorId, item.MotivoCancelamento));
            var cancelado = await db.LogAuditoriaLocal.AsNoTracking().SingleAsync(a => a.Acao == "item_cancelado", Ct);
            Assert.Equal((maria.Id, Carlos), (cancelado.UsuarioId, cancelado.AutorizadoPorId));
            var liberacao = await db.LogAuditoriaLocal.AsNoTracking().SingleAsync(a => a.Acao == "liberacao", Ct);
            Assert.Equal(("itens_venda", item.Id, Carlos, "Cliente desistiu do item", "PDV › Venda"),
                (liberacao.Entidade, liberacao.RegistroId, liberacao.AutorizadoPorId, liberacao.Motivo, liberacao.Localizacao));
        }

        // Pela janela do item, o mesmo pedido de liberação.
        pdv.DuploClique(LinhaDoItem(pdv, 1));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoItemViewModel, "janela do item");
        pdv.Clicar(pdv.Controle<Button>("BotaoRemoverItemJanela"));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoLiberacaoViewModel { Pedido.Permissao: PermissoesPdv.CancelarItem }, "liberação pela janela");
        await FecharComEscAsync(pdv, venda);
        Assert.False(venda.Itens[0].Cancelado);
    }

    [AvaloniaFact]
    public async Task Com_cancelar_item_exige_supervisor_ligada_o_f4_pede_a_liberacao_mesmo_com_a_permissao()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "1 item");

        // Padrão (desligada): a MARIA cancela sozinha.
        Assert.False(await venda.ServicoVenda.CancelarItemExigeLiberacaoAsync(Ct));
        var agora = DateTimeOffset.UtcNow;
        await pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [
                new ConfiguracaoRegistro
                {
                    Id = Guid.CreateVersion7(), Escopo = "loja", LojaId = pdv.Servicos.GetRequiredService<SessaoTerminal>().Identidade!.LojaId,
                    Chave = ChavesConfiguracao.CancelarItemExigeSupervisor, Valor = "true", CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
            ],
            Ct);
        Assert.True(pdv.Servicos.GetRequiredService<SessaoTerminal>().Operador!.Tem(PermissoesPdv.CancelarItem));
        pdv.Tecla(Key.F4);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoLiberacaoViewModel { Pedido.Permissao: PermissoesPdv.CancelarItem }, "liberação mesmo com a permissão");
        await LiberarComCarlosAsync(pdv, venda, "Regra da loja");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.Itens[0].Cancelado, "cancelado com a liberação");
    }

    [AvaloniaFact]
    public async Task Perfil_da_nuvem_sem_cancelar_item_desce_ao_caixa_e_o_f4_pede_o_supervisor_do_perfil_padrao()
    {
        // Terminal real (fluxo `acesso` da API falsa): a MARIA com o perfil do operador menos `pdv.venda.cancelar_item`.
        var (pdv, _) = await TelasTests.TerminalRealLogadoAsync(
            comCatalogo: true, comSupervisor: true,
            permissoesOperador: PermissoesPdv.PerfilOperador.Where(p => p != PermissoesPdv.CancelarItem));
        using var __ = pdv;
        var venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        var operador = pdv.Servicos.GetRequiredService<SessaoTerminal>().Operador!;
        Assert.False(operador.Tem(PermissoesPdv.CancelarItem));
        Assert.True(operador.Tem(PermissoesPdv.DescontoItem));
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "1 item");

        pdv.Clicar(pdv.BotaoDaBarra("F4"));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoLiberacaoViewModel { Pedido.Permissao: PermissoesPdv.CancelarItem }, "liberação");
        await TelasTests.LiberarComJoaoAsync(pdv, venda, "Produto errado");
        Assert.IsType<DialogoRemoverItemViewModel>(venda.Dialogo);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.Itens[0].Cancelado, "cancelado");
        await using var db = Banco(pdv);
        Assert.Equal(TelasTests.JoaoId, (await db.ItensVenda.AsNoTracking().SingleAsync(Ct)).AutorizadoPorId);
    }

    [AvaloniaFact]
    public async Task Pesquisa_so_por_numeros_inclui_o_fardo_pelo_dun_e_digitos_sem_produto_no_campo_abrem_a_pesquisa()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        venda = await PreferenciasAsync(pdv, new PreferenciasCaixa(PesquisaSoNumeros: true));

        // Parte do código + Enter no campo de código (sem o F2): abre a pesquisa só por números com os dígitos.
        await pdv.EntrarCodigoAsync("789114910");
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoPesquisaViewModel, "pesquisa aberta pelos dígitos");
        var pesquisa = (DialogoPesquisaViewModel)venda.Dialogo!;
        await pdv.EsperarFocoAsync("CampoPesquisa");
        Assert.Equal("789114910", pesquisa.Filtro);
        Assert.Equal(string.Empty, venda.CodigoEntrada);
        await pdv.EsperarAsync(() => pesquisa.Resultados.Count == 2, "a unidade e o fardo");

        // A unidade (o EAN começa) antes do fardo (o DUN contém); a linha do fardo mostra o DUN e a embalagem.
        Assert.Equal(("7891149103102", "UN", false), (pesquisa.Resultados[0].Codigo, pesquisa.Resultados[0].Unidade, pesquisa.Resultados[0].EhEmbalagem));
        var fardo = pesquisa.Resultados[1];
        Assert.Equal(("17891149103109", "FD 12", 37.90m), (fardo.Codigo, fardo.Unidade, fardo.Preco));
        pdv.Captura("46-pesquisa-fardo");

        // O DUN exato: a linha do fardo em 1º; o Enter inclui o FARDO (12 unidades a 37,90), não 1 lata.
        pesquisa.Filtro = "17891149103109";
        await pdv.EsperarAsync(() => pesquisa.Resultados.Count == 1 && pesquisa.Resultados[0].EhEmbalagem, "fardo exato");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.Itens.Count == 1, "fardo incluído");
        var item = venda.ServicoVenda.Atual!.ObterItem(1);
        Assert.Equal((12m, 37.90m, "17891149103109"), (item.Quantidade, item.ValorBruto, item.CodigoLido));
        await pdv.EsperarFocoAsync("CampoCodigo");

        // "2*" + parte do código: o multiplicador vale para o produto escolhido na pesquisa.
        await pdv.EntrarCodigoAsync("2*789114910");
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoPesquisaViewModel, "pesquisa com o multiplicador");
        pesquisa = (DialogoPesquisaViewModel)venda.Dialogo!;
        Assert.Equal(2m, venda.MultiplicadorPendente);
        await pdv.EsperarAsync(() => pesquisa.Resultados.Count == 2, "resultados");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.Itens.Count == 2, "2 latas");
        Assert.Equal(2m, venda.ServicoVenda.Atual!.ObterItem(2).Quantidade);

        // Código que não existe: a pesquisa abre vazia e diz que nada bateu (Esc volta).
        await pdv.EntrarCodigoAsync("1234567890123");
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoPesquisaViewModel { Erro: not null }, "nada encontrado");
        Assert.Equal("Nenhum produto com os números 1234567890123: confira e corrija, ou Esc volta.", ((DialogoPesquisaViewModel)venda.Dialogo!).Erro);
        await FecharComEscAsync(pdv, venda);

        // Desligada (padrão): os mesmos dígitos continuam "Produto não encontrado" (como antes).
        venda = await PreferenciasAsync(pdv, new PreferenciasCaixa(PesquisaSoNumeros: false));
        await pdv.EntrarCodigoAsync("789114910");
        Assert.Null(venda.Dialogo);
        Assert.Equal("Produto não encontrado: 789114910", pdv.Texto("TextoMensagem"));
    }

    [AvaloniaFact]
    public async Task Diminuir_a_quantidade_sem_cancelar_item_pede_o_supervisor_e_vira_cancelamento_parcial_auditado()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>();
        var maria = sessao.Operador!;
        await pdv.EntrarCodigoAsync("10*0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "10 gelos");

        // Com a permissão (padrão), diminuir e aumentar continuam livres e sem auditoria própria (como o F3 sempre foi).
        await venda.AlterarQuantidadeAsync(venda.ServicoVenda.Atual!.ObterItem(1), 9m);
        Assert.Equal(9m, venda.ServicoVenda.Atual!.ObterItem(1).Quantidade);

        // O dono tirou "Cancelar item" do perfil: diminuir é cancelar parte do item.
        sessao.Operador = maria with { Permissoes = new HashSet<string>(PermissoesPdv.PerfilOperador.Where(p => p != PermissoesPdv.CancelarItem), StringComparer.Ordinal) };
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        var recusa = await Assert.ThrowsAsync<ReducaoExigeLiberacaoException>(() => servico.AlterarQuantidadeAsync(1, 1m, Ct));
        Assert.Equal((1, 8m), (recusa.Sequencia, recusa.Quantidade));

        // O que o Core recusaria de qualquer jeito (decimal na unidade) recusa antes, sem pedir o supervisor.
        var decimalNaUnidade = await Assert.ThrowsAnyAsync<RegraNegocioException>(() => servico.AlterarQuantidadeAsync(1, 0.5m, Ct));
        Assert.IsNotType<ReducaoExigeLiberacaoException>(decimalNaUnidade);
        Assert.Equal(9m, venda.ServicoVenda.Atual!.ObterItem(1).Quantidade);

        // Aumentar continua livre.
        await servico.AlterarQuantidadeAsync(1, 10m, Ct);
        venda.AtualizarTela();
        await AmbienteUi.Pausa();

        // Janela do item: 10 → 1 e "Alterar quantidade" pede o supervisor, com o item e o que sai.
        pdv.DuploClique(LinhaDoItem(pdv, 1));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoItemViewModel, "janela do item");
        await pdv.EsperarFocoAsync("CampoQuantidadeItem");
        pdv.Digitar("1");
        pdv.Clicar(pdv.Controle<Button>("BotaoAlterarQuantidade"));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoLiberacaoViewModel, "liberação da redução");
        var dialogo = (DialogoLiberacaoViewModel)venda.Dialogo!;
        Assert.Equal(PermissoesPdv.CancelarItem, dialogo.Pedido.Permissao);
        Assert.Equal("Liberação do supervisor · Cancelar 9,000 UN do item 1 — GELO ESCAMA 5KG (de 10,000, R$ 129,00)", dialogo.Titulo);
        Assert.Equal(10m, venda.ServicoVenda.Atual!.ObterItem(1).Quantidade);

        // A própria MARIA não libera.
        await pdv.EsperarFocoAsync("CampoSupervisor");
        dialogo.Pedido.Usuario = "1";
        dialogo.Pedido.Pin = "1234";
        dialogo.Pedido.Motivo = "Cliente levou menos";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => dialogo.Pedido.Erro is not null, "liberação negada");
        Assert.Equal(Sync.Acesso.AutenticadorOffline.MensagemLiberadorProprio, dialogo.Pedido.Erro);

        // O CARLOS libera: a linha de 10 fica cancelada e entra a de 1, com as auditorias do cancelamento.
        await LiberarComCarlosAsync(pdv, venda, "Cliente levou menos");
        await pdv.EsperarAsync(() => venda.Dialogo is null, "redução feita");
        Assert.Equal("9,000 do item 1 cancelado(s) com liberação de CARLOS.", pdv.Texto("TextoMensagem"));
        Assert.Equal("12,90", pdv.Texto("TextoTotal"));
        await pdv.EsperarFocoAsync("CampoCodigo");
        await using (var db = Banco(pdv))
        {
            var original = await db.ItensVenda.AsNoTracking().SingleAsync(i => i.Sequencia == 1, Ct);
            Assert.Equal((true, Carlos, "Cliente levou menos"), (original.Cancelado, original.AutorizadoPorId, original.MotivoCancelamento));
            Assert.Equal(1m, (await db.ItensVenda.AsNoTracking().SingleAsync(i => !i.Cancelado, Ct)).Quantidade);
            var cancelado = await db.LogAuditoriaLocal.AsNoTracking().SingleAsync(a => a.Acao == "item_cancelado", Ct);
            Assert.Equal((maria.Id, Carlos), (cancelado.UsuarioId, cancelado.AutorizadoPorId));
            Assert.Equal(Carlos, (await db.LogAuditoriaLocal.AsNoTracking().SingleAsync(a => a.Acao == "liberacao", Ct)).AutorizadoPorId);
        }

        // O F3 e o "−" pedem a mesma liberação (Esc desiste e nada muda).
        await pdv.EntrarCodigoAsync("3*7891149103102");
        await pdv.EsperarAsync(() => venda.Itens.Count(i => !i.Cancelado) == 2, "3 latas");
        pdv.Tecla(Key.F3);
        await pdv.EsperarFocoAsync("CampoQuantidade");
        pdv.Digitar("2");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoLiberacaoViewModel { Pedido.Permissao: PermissoesPdv.CancelarItem }, "liberação do F3");
        await FecharComEscAsync(pdv, venda);
        await pdv.EntrarCodigoAsync("-");
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoLiberacaoViewModel { Pedido.Permissao: PermissoesPdv.CancelarItem }, "liberação do −");
        await FecharComEscAsync(pdv, venda);
        Assert.Equal(3m, venda.ServicoVenda.Atual!.Itens.Single(i => !i.Cancelado && i.Descricao == "CERV BRAHMA LT 350ML").Quantidade);
        await pdv.EntrarCodigoAsync("+");
        Assert.Equal(4m, venda.ServicoVenda.Atual!.Itens.Single(i => !i.Cancelado && i.Descricao == "CERV BRAHMA LT 350ML").Quantidade);
    }

    [AvaloniaFact]
    public async Task Desconto_sem_a_permissao_do_operador_pede_o_supervisor_na_janela_do_item_e_no_f6()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>();
        var maria = sessao.Operador!;
        Assert.True(maria.LimiteDescontoEfetivoPct >= 10m);

        // O dono tirou os descontos do perfil: mesmo dentro do limite (10%), o supervisor libera.
        sessao.Operador = maria with
        {
            Permissoes = new HashSet<string>(
                PermissoesPdv.PerfilOperador.Where(p => p is not (PermissoesPdv.DescontoItem or PermissoesPdv.DescontoTotal)), StringComparer.Ordinal),
        };
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "1 item");

        pdv.DuploClique(LinhaDoItem(pdv, 1));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoItemViewModel, "janela do item");
        var janela = (DialogoItemViewModel)venda.Dialogo!;
        janela.Desconto = "10";
        pdv.Clicar(pdv.Controle<Button>("BotaoAplicarDescontoPercentual"));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoLiberacaoViewModel, "liberação do desconto no item");
        var liberacao = (DialogoLiberacaoViewModel)venda.Dialogo!;
        Assert.Equal(PermissoesPdv.DescontoItem, liberacao.Pedido.Permissao);
        Assert.Equal("Liberação do supervisor · Desconto de 10,00% (sem a permissão de desconto)", liberacao.Titulo);
        Assert.Equal(0m, venda.ServicoVenda.Atual!.ObterItem(1).DescontoItem);
        await LiberarComCarlosAsync(pdv, venda, "Gerente autorizou");
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoItemViewModel, "janela de volta");
        Assert.Equal("Desconto de R$ 1,29 aplicado com liberação de CARLOS.", pdv.Texto("TextoMensagemItem"));
        Assert.Equal(Carlos, venda.ServicoVenda.Atual!.ObterItem(1).AutorizadoPorId);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "janela fechada");

        // F6 › 2 (total) só por clique: "10" + "Aplicar em %" também pede o supervisor.
        await ClicarEEsperarAsync<DialogoMenuDescontoViewModel>(pdv, venda, "F6");
        pdv.Clicar(pdv.Controle<Button>("OpcaoDescontoTotal"));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoValorDescontoViewModel, "valor do desconto no total");
        await pdv.EsperarFocoAsync("CampoDesconto");
        pdv.Digitar("1");
        pdv.Clicar(pdv.Controle<Button>("BotaoAplicarDescontoPercentual"));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoLiberacaoViewModel { Pedido.Permissao: PermissoesPdv.DescontoTotal }, "liberação do total");
        await LiberarComCarlosAsync(pdv, venda, "Gerente autorizou o total");
        await pdv.EsperarAsync(() => venda.Dialogo is null, "desconto no total aplicado");
        await using var db = Banco(pdv);
        Assert.Equal(2, await db.LogAuditoriaLocal.CountAsync(a => a.Acao == "liberacao" && a.AutorizadoPorId == Carlos, Ct));
    }

    [AvaloniaFact]
    public async Task F6_aplica_o_percentual_so_por_clique_e_o_numero_com_o_botao_do_real_e_em_reais()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "1 item");

        await ClicarEEsperarAsync<DialogoMenuDescontoViewModel>(pdv, venda, "F6");
        pdv.Clicar(pdv.Controle<Button>("OpcaoDescontoItem"));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoValorDescontoViewModel, "desconto no item");
        await pdv.EsperarFocoAsync("CampoDesconto");
        pdv.Digitar("5");
        pdv.Clicar(pdv.Controle<Button>("BotaoAplicarDescontoPercentual"));
        await pdv.EsperarAsync(() => venda.Dialogo is null, "5% aplicado");
        Assert.Equal(0.65m, venda.ServicoVenda.Atual!.ObterItem(1).DescontoItem);
        Assert.Equal(5m, venda.ServicoVenda.Atual!.ObterItem(1).DescontoItemPct);
        await pdv.EsperarFocoAsync("CampoCodigo");

        // O número com o botão do R$: R$ 0,50 no total (dentro do limite de 10% somado ao do item).
        await ClicarEEsperarAsync<DialogoMenuDescontoViewModel>(pdv, venda, "F6");
        pdv.Clicar(pdv.Controle<Button>("OpcaoDescontoTotal"));
        await pdv.EsperarFocoAsync("CampoDesconto");
        pdv.Digitar("0,50");
        pdv.Clicar(pdv.Controle<Button>("BotaoAplicarDescontoReais"));
        await pdv.EsperarAsync(() => venda.Dialogo is null, "R$ 0,50 no total");
        Assert.Equal("11,75", pdv.Texto("TextoTotal"));
    }

    [AvaloniaFact]
    public async Task Fechamento_e_contador_de_cedulas_tem_saida_por_clique()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();

        // F11 › 3 pelo mouse: a tela do fechamento tem "Voltar [Esc]" (sem a tecla Esc, o caixa não ficava preso).
        await ClicarEEsperarAsync<DialogoFuncoesViewModel>(pdv, venda, "F11");
        pdv.Clicar(pdv.Controle<Button>("OpcaoFuncao3"));
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is FechamentoCaixaViewModel, "fechamento");
        var fechamento = (FechamentoCaixaViewModel)pdv.Shell.PaginaAtual!;
        await AmbienteUi.Pausa();
        Assert.True(pdv.Controle<Button>("BotaoVoltarFechamento").IsVisible);
        Assert.Equal(fechamento.RotuloAvancar, pdv.Controle<Button>("BotaoAvancarFechamento").Content);

        // Cédulas pelo clique e "Voltar" do contador sem usar o total.
        pdv.Clicar(pdv.Controle<Button>("BotaoCedulasFechamento"));
        await pdv.EsperarAsync(() => fechamento.Contador is not null, "contador");
        await AmbienteUi.Pausa();
        pdv.Clicar(pdv.Controle<Button>("BotaoVoltarCedulas"));
        await pdv.EsperarAsync(() => fechamento.Contador is null, "contador fechado pelo clique");
        pdv.Clicar(pdv.Controle<Button>("BotaoVoltarFechamento"));
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "de volta à venda pelo clique");
        await pdv.EsperarFocoAsync("CampoCodigo");
        venda = (VendaViewModel)pdv.Shell.PaginaAtual!;

        // Sangria › "Cédulas [F3]": o contador tem "Voltar [Esc]" clicável, que volta à sangria.
        await ClicarEEsperarAsync<DialogoFuncoesViewModel>(pdv, venda, "F11");
        pdv.Clicar(pdv.Controle<Button>("OpcaoFuncao1"));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoMovimentoCaixaViewModel, "sangria");
        pdv.Clicar(pdv.Controle<Button>("BotaoCedulasMovimento"));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoCedulasViewModel, "cédulas da sangria");
        await AmbienteUi.Pausa();
        pdv.Clicar(pdv.Controle<Button>("BotaoVoltarCedulas"));
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoMovimentoCaixaViewModel, "de volta à sangria");
    }

    [AvaloniaFact]
    public async Task Barra_de_botoes_cabe_em_1366_sem_cortar_rotulos()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        foreach (var (largura, altura) in new[] { (1366d, 768d), (1920d, 1080d) })
        {
            pdv.Janela.Width = largura;
            pdv.Janela.Height = altura;
            await AmbienteUi.Pausa();
            var barra = pdv.Controle<ItemsControl>("BarraFuncoes");
            Assert.True(barra.Bounds.Width <= largura - 24 + 0.5, $"barra cabe em {largura}");
            Assert.InRange(barra.Bounds.Height, 80, 120);
            var botoes = barra.GetVisualDescendants().OfType<Button>().ToList();
            Assert.Equal(16, botoes.Count);
            foreach (var botao in botoes)
            {
                var direita = botao.TranslatePoint(new Point(botao.Bounds.Width, 0), barra)?.X;
                Assert.True(direita <= barra.Bounds.Width + 0.5, $"botão {botao.DataContext} dentro da barra em {largura}");
                foreach (var rotulo in botao.GetVisualDescendants().OfType<TextBlock>().Where(t => !string.IsNullOrEmpty(t.Text)))
                {
                    // O mesmo texto, sem limite de largura: cabe no espaço que o rótulo recebeu (nada de "…").
                    var inteiro = new TextBlock
                    {
                        Text = rotulo.Text,
                        FontSize = rotulo.FontSize,
                        FontWeight = rotulo.FontWeight,
                        FontFamily = rotulo.FontFamily,
                        FontStyle = rotulo.FontStyle,
                    };
                    inteiro.Measure(Size.Infinity);
                    Assert.True(inteiro.DesiredSize.Width <= rotulo.Bounds.Width + 0.5,
                        $"\"{rotulo.Text}\" cortado em {largura}: {inteiro.DesiredSize.Width:N1} > {rotulo.Bounds.Width:N1}");
                }
            }
        }
    }
}
