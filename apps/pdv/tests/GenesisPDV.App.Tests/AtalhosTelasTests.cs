using System.Text.Json.Nodes;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.Interactivity;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Atalhos;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Tests;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Atalhos configuráveis no caixa e Nova venda (F3-B13; PDV 28.1–28.4): os critérios 28.4 — a tecla trocada no ERP vale
/// depois do pull e a antiga deixa de fazer a ação; a ação desabilitada sai da barra e a tecla só bipa; o roteiro completo
/// sem mouse — mais a ocorrência da tecla repetida, o F1 com as teclas configuradas, o CONCLUIR e Funções que não se
/// desligam (com o ⚙ na tecla de Funções) e o Ctrl+N com e sem itens. (O "ERP
/// recusa duas ações com a mesma tecla" é da API e do ERP: `formas-configuracoes.test.ts` e `Configuracoes.test.tsx`.)
/// </summary>
public class AtalhosTelasTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly Guid Debito = Guid.Parse("019a0004-0000-7000-8000-000000000302");

    private static JsonObject Atalho(Guid id, string acao, string tecla, bool habilitado, int ordem) => new()
    {
        ["id"] = id.ToString("D"),
        ["loja_id"] = null,
        ["acao"] = acao,
        ["tecla"] = tecla,
        ["habilitado"] = habilitado,
        ["ordem"] = ordem,
        ["excluido_em"] = null,
    };

    /// <summary>Linhas do espelho como o pull as gravaria, para o terminal de demonstração (que não sincroniza).</summary>
    private static Task GravarAtalhosAsync(AmbienteUi pdv, params (Guid? Loja, string Acao, string Tecla, bool Habilitado, int Ordem)[] linhas)
    {
        var agora = DateTimeOffset.UtcNow;
        return pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [
                .. linhas.Select(l => new AtalhoPdvRegistro
                {
                    Id = Guid.CreateVersion7(), LojaId = l.Loja, Acao = l.Acao, Tecla = l.Tecla, Habilitado = l.Habilitado, Ordem = l.Ordem,
                    CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                }),
            ],
            Ct);
    }

    [AvaloniaFact]
    public async Task Tecla_trocada_no_erp_vale_depois_do_pull_e_a_desabilitada_sai_da_barra_e_so_bipa()
    {
        var (pdv, api) = await TelasTests.TerminalRealLogadoAsync(comCatalogo: true, permissoesOperador: PerfilComCancelarItem);
        using var _ = pdv;
        var venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        var sync = pdv.Servicos.GetRequiredService<IServicoSincronizacao>();
        await pdv.EsperarAsync(() => sync.Situacao.Online, "online", 20_000);
        Assert.Contains(venda.Atalhos, a => a.Tecla == "F4");

        // Critério 28.4 (1): no ERP, Remover item passa para Ctrl+R; depois do pull, o F4 não faz nada e o Ctrl+R remove.
        var linha = Guid.CreateVersion7();
        api.Publicar("configuracao", "atalhos_pdv", Atalho(linha, AcoesAtalho.RemoverItem, "Ctrl+R", true, 2));
        await pdv.EsperarAsync(() => venda.Mapa.Da(AcoesAtalho.RemoverItem).Tecla == "Ctrl+R", "atalho do pull", 20_000);
        Assert.Contains(venda.Atalhos, a => a.Tecla == "Ctrl+R" && a.Funcao == "Remover item");
        Assert.DoesNotContain(venda.Atalhos, a => a.Tecla == "F4");
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "1 item");
        var bipes = pdv.Servicos.GetRequiredService<ServicoAtalhos>().Bipes;
        pdv.Tecla(Key.F4);
        await AmbienteUi.Pausa();
        Assert.Null(venda.Dialogo);
        Assert.Equal(bipes, pdv.Servicos.GetRequiredService<ServicoAtalhos>().Bipes);
        pdv.Tecla(Key.R, RawInputModifiers.Control);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoRemoverItemViewModel, "remover pelo Ctrl+R");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "voltou");

        // Critério 28.4 (2): desabilitada no ERP, a ação sai da barra e a tecla só bipa com "Ação indisponível".
        api.Publicar("configuracao", "atalhos_pdv", Atalho(linha, AcoesAtalho.RemoverItem, "Ctrl+R", false, 2));
        await pdv.EsperarAsync(() => !venda.Mapa.Da(AcoesAtalho.RemoverItem).Habilitado, "desabilitada pelo pull", 20_000);
        Assert.DoesNotContain(venda.Atalhos, a => a.Funcao == "Remover item");
        pdv.Tecla(Key.R, RawInputModifiers.Control);
        await AmbienteUi.Pausa();
        Assert.Null(venda.Dialogo);
        Assert.Equal(bipes + 1, pdv.Servicos.GetRequiredService<ServicoAtalhos>().Bipes);
        Assert.Equal("Ação indisponível (Ctrl+R Remover item)", pdv.Texto("TextoMensagem"));
        Assert.False(venda.Itens[0].Cancelado);
        await pdv.EsperarFocoAsync("CampoCodigo");
    }

    /// <summary>O perfil do operador da API falsa com o cancelamento de item (o F4 abre o diálogo direto, sem o supervisor).</summary>
    private static readonly IReadOnlySet<string> PerfilComCancelarItem =
        new HashSet<string>(Core.Caixa.PermissoesPdv.PerfilOperador, StringComparer.Ordinal) { Core.Caixa.PermissoesPdv.CancelarItem };

    [AvaloniaFact]
    public async Task Tecla_repetida_ou_reservada_cai_na_padrao_com_a_ocorrencia_e_o_F1_lista_as_teclas_configuradas()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        var loja = CatalogoDemonstracao.LojaDemonstracao;
        // A loja põe a Gestão de vendas no F4 (repetida com o Remover item da empresa) e a Ajuda no Ctrl+Alt+T (o tema);
        // a empresa leva o Cliente para o Ctrl+K e desabilita o Sincronizar agora.
        await GravarAtalhosAsync(pdv,
            (loja, AcoesAtalho.GestaoVendas, "F4", true, 6),
            (loja, AcoesAtalho.Ajuda, "Ctrl+Alt+T", true, 19),
            (null, AcoesAtalho.Cliente, "ctrl+k", true, 22),
            (null, AcoesAtalho.SincronizarAgora, "Ctrl+Alt+S", false, 34));
        await venda.RecarregarAtalhosAsync();
        await venda.RecarregarAtalhosAsync();

        Assert.Equal("F12", venda.Mapa.Da(AcoesAtalho.GestaoVendas).Tecla);
        Assert.Equal("F1", venda.Mapa.Da(AcoesAtalho.Ajuda).Tecla);
        Assert.Equal("Ctrl+K", venda.Mapa.Da(AcoesAtalho.Cliente).Tecla);
        Assert.DoesNotContain(venda.Atalhos, a => a.Tecla == "Ctrl+Alt+S");
        // Uma ocorrência só para o mesmo conjunto de alertas (o pull repete a cada 30 s).
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            var ocorrencias = await db.LogLocal.AsNoTracking().Where(l => l.Detalhes!.Contains(CodigoOcorrencia.AtalhoInvalido.Codigo)).ToListAsync(Ct);
            var ocorrencia = Assert.Single(ocorrencias);
            Assert.Equal(NiveisOcorrencia.Aviso, ocorrencia.Nivel);
            Assert.Contains("gestao_vendas", ocorrencia.Detalhes, StringComparison.Ordinal);
            Assert.Contains("Ctrl+Alt+T", ocorrencia.Detalhes, StringComparison.Ordinal);
        }

        // O F1 lista cada ação com a tecla que vale; as que esta versão não tem e as desabilitadas, nas listas corridas.
        pdv.Tecla(Key.F1);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoAjudaViewModel, "ajuda");
        var ajuda = (DialogoAjudaViewModel)venda.Dialogo!;
        Assert.Contains(ajuda.Atalhos, l => l.StartsWith("Ctrl+K     CPF na nota", StringComparison.Ordinal));
        Assert.Contains(ajuda.Atalhos, l => l.StartsWith("F12        Gestão de vendas", StringComparison.Ordinal));
        Assert.Contains(ajuda.Atalhos, l => l.StartsWith("Ctrl+N     Nova venda", StringComparison.Ordinal));
        // O F8 Tipo de preço (F3-B17) já é desta versão (a demonstração tem o recurso da onda).
        Assert.Contains(ajuda.Atalhos, l => l.StartsWith("F8         Tipo de preço", StringComparison.Ordinal));
        Assert.Contains(ajuda.Atalhos, l => l.StartsWith("Chegam numa próxima versão:", StringComparison.Ordinal) && l.Contains("Alt+G Gelada", StringComparison.Ordinal)
            && !l.Contains("F8 Tipo de preço", StringComparison.Ordinal));
        Assert.Contains(ajuda.Atalhos, l => l.StartsWith("Desabilitadas no ERP:", StringComparison.Ordinal) && l.Contains("Ctrl+Alt+S Sincronizar", StringComparison.Ordinal));
        pdv.Captura("80-ajuda-atalhos");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "ajuda fechada");

        // A tecla nova abre o cliente; o F5 antigo não faz nada; o tema (Ctrl+Alt+T) continua fixo.
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F5);
        await AmbienteUi.Pausa();
        Assert.Null(venda.Dialogo);
        pdv.Tecla(Key.K, RawInputModifiers.Control);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoClienteViewModel, "cliente pelo Ctrl+K");
    }

    [AvaloniaFact]
    public async Task Concluir_e_Funcoes_desligados_na_nuvem_continuam_valendo_e_a_engrenagem_segue_a_tecla_de_Funcoes()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        var loja = CatalogoDemonstracao.LojaDemonstracao;
        // A empresa desliga o CONCLUIR; a loja leva Funções para o Ctrl+U e a desliga; a Central do PDV também desligada.
        await GravarAtalhosAsync(pdv,
            (null, AcoesAtalho.ConcluirVenda, "F10", false, 5),
            (loja, AcoesAtalho.MenuFuncoes, "Ctrl+U", false, 26),
            (null, AcoesAtalho.ConfiguracaoTerminal, "Ctrl+Alt+C", false, 35));
        await venda.RecarregarAtalhosAsync();

        // Sem eles o caixa ficaria preso (nenhuma venda concluída; sem sangria, reforço e fechamento): ficam ligados e na
        // barra, com a ocorrência. O ⚙ fica no fim da barra (é a opção 8 de Funções) e mostra a tecla nova de Funções.
        Assert.Contains(venda.Atalhos, a => a.Tecla == "F10" && a.Destaque);
        Assert.Contains(venda.Atalhos, a => a.Tecla == "Ctrl+U" && a.Funcao == "Funções");
        Assert.Equal(("Ctrl+U › 8", "⚙ Central"), (venda.Atalhos[^1].Tecla, venda.Atalhos[^1].Funcao));
        Assert.Equal("Ctrl+U › 8", venda.TeclaDaCentral);
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            var ocorrencia = Assert.Single(await db.LogLocal.AsNoTracking()
                .Where(l => l.Detalhes!.Contains(CodigoOcorrencia.AtalhoInvalido.Codigo)).ToListAsync(Ct));
            Assert.Contains("concluir_venda", ocorrencia.Detalhes, StringComparison.Ordinal);
            Assert.Contains("menu_funcoes", ocorrencia.Detalhes, StringComparison.Ordinal);
            Assert.Contains(MapaAtalhos.MotivoEssencial, ocorrencia.Detalhes, StringComparison.Ordinal);
        }

        // O F11 antigo não faz nada; o Ctrl+U abre Funções; o Ctrl+Alt+C da Central desligada só bipa.
        var bipes = pdv.Servicos.GetRequiredService<ServicoAtalhos>().Bipes;
        pdv.Tecla(Key.F11);
        await AmbienteUi.Pausa();
        Assert.Null(venda.Dialogo);
        pdv.Tecla(Key.U, RawInputModifiers.Control);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoFuncoesViewModel, "Funções pelo Ctrl+U");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "voltou");
        pdv.Tecla(Key.C, RawInputModifiers.Control | RawInputModifiers.Alt);
        await AmbienteUi.Pausa();
        Assert.Null(venda.Dialogo);
        Assert.Equal(bipes + 1, pdv.Servicos.GetRequiredService<ServicoAtalhos>().Bipes);

        // O F10 conclui a venda.
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda concluída pelo F10");
    }

    [AvaloniaFact]
    public async Task Nova_venda_limpa_o_caixa_livre_e_com_itens_pede_cancelar_ou_voltar()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
        Assert.NotNull(venda.TrocoTexto);
        pdv.Digitar("3*");
        pdv.Tecla(Key.Enter);
        Assert.Equal(3m, venda.MultiplicadorPendente);

        // Sem itens: limpa o que ficou da venda anterior (o troco, o cupom na tela, o multiplicador).
        pdv.Tecla(Key.N, RawInputModifiers.Control);
        await AmbienteUi.Pausa();
        Assert.Null(venda.Dialogo);
        Assert.Null(venda.TrocoTexto);
        Assert.Null(venda.UltimoCupom);
        Assert.Null(venda.MultiplicadorPendente);
        Assert.Equal("Pronto para a nova venda.", pdv.Texto("TextoMensagem"));
        await pdv.EsperarFocoAsync("CampoCodigo");

        // Com itens: Esc (ou Enter) volta com a venda intacta; C vai ao cancelamento do Shift+F4 (o motivo).
        await pdv.EntrarCodigoAsync("0044");
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        Assert.True(servico.VendaAberta);
        pdv.Tecla(Key.N, RawInputModifiers.Control);
        await pdv.EsperarFocoAsync("DialogoNovaVenda");
        var nova = Assert.IsType<DialogoNovaVendaViewModel>(venda.Dialogo);
        Assert.Contains("R$ 12,90", nova.Mensagem, StringComparison.Ordinal);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "voltou");
        Assert.True(servico.VendaAberta);
        pdv.Tecla(Key.N, RawInputModifiers.Control);
        await pdv.EsperarFocoAsync("DialogoNovaVenda");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "Enter volta");
        Assert.True(servico.VendaAberta);
        pdv.Tecla(Key.N, RawInputModifiers.Control);
        await pdv.EsperarFocoAsync("DialogoNovaVenda");
        // O operador de demonstração não tem pdv.venda.cancelar_venda_aberta (O6): como no Shift+F4, o supervisor libera.
        pdv.Tecla(Key.C);
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var liberacao = Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
        liberacao.Pedido.Usuario = "2";
        liberacao.Pedido.Pin = "4321";
        liberacao.Pedido.Motivo = "Cliente desistiu";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoMotivoCancelamentoViewModel, "motivo do cancelamento");
        pdv.Digitar("Cliente desistiu da compra no caixa");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && !servico.VendaAberta, "venda cancelada");
        Assert.StartsWith("Venda cancelada com liberação de ", pdv.Texto("TextoMensagem"), StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task Roteiro_completo_sem_mouse_abre_o_caixa_vende_com_duas_formas_faz_sangria_e_fecha()
    {
        // Critério 28.4 (4): abrir o caixa, vender com 2 formas, sangria e fechar, sem nenhum evento de mouse.
        using var pdv = await AmbienteUi.IniciarAsync();
        var ponteiro = 0;
        pdv.Janela.AddHandler(InputElement.PointerPressedEvent, (_, _) => ponteiro++, RoutingStrategies.Tunnel | RoutingStrategies.Bubble, handledEventsToo: true);
        pdv.Janela.AddHandler(InputElement.PointerReleasedEvent, (_, _) => ponteiro++, RoutingStrategies.Tunnel | RoutingStrategies.Bubble, handledEventsToo: true);
        await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is not null, "foco no assistente");
        pdv.Tecla(Key.F8);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "login");
        await pdv.EntrarAsync("1", "1234");
        await pdv.EsperarFocoAsync("CampoFundo");
        pdv.Digitar("100");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "venda");
        await pdv.EsperarFocoAsync("CampoCodigo");
        var venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        var agora = DateTimeOffset.UtcNow;
        await pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [
                new FormaPagamentoRegistro
                {
                    Id = Debito, Descricao = "Cartão de débito", Ordem = 2, TipoForma = "cartao_debito", MeioPagamentoFiscal = "04",
                    Integracao = "pos_externo", CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
                new FormaPagamentoLojaRegistro { Id = Guid.CreateVersion7(), FormaPagamentoId = Debito, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
            ],
            Ct);

        // Venda de R$ 12,90: R$ 5,00 em dinheiro e o resto no débito (↓ escolhe a forma; a bandeira e o NSU pelo Tab).
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        pdv.Digitar("5");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pagamento.FaltaTexto == "7,90", "falta 7,90");
        pdv.Tecla(Key.Down);
        Assert.Equal("Cartão de débito", pagamento.Forma!.Descricao);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoBandeira");
        pdv.Digitar("6");
        pdv.Tecla(Key.Tab);
        await pdv.EsperarFocoAsync("CampoNsu");
        pdv.Digitar("000123");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");

        // Sangria de R$ 5,00 (F11 › 1), com quem retira pelo Tab.
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.D1);
        await pdv.EsperarFocoAsync("CampoValorMovimento");
        pdv.Digitar("5");
        pdv.Tecla(Key.Tab);
        await pdv.EsperarFocoAsync("CampoQuemRetira");
        pdv.Digitar("Gerente");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "sangria registrada");

        // Fechamento (F11 › 3): o dinheiro contado e o débito pelo Tab, Enter confirma; Enter de novo volta ao login.
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.D3);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is FechamentoCaixaViewModel, "fechamento");
        await pdv.EsperarFocoAsync("CampoValorForma");
        var fechamento = (FechamentoCaixaViewModel)pdv.Shell.PaginaAtual!;
        pdv.Digitar("100");
        for (var i = 1; i < fechamento.Formas.Count; i++)
        {
            pdv.Tecla(Key.Tab);
            pdv.Digitar("7,90");
        }

        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Concluido, "fechamento confirmado");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "volta ao login");
        Assert.Equal(0, ponteiro);

        await using var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
        Assert.Equal(StatusSessaoCaixa.Fechada, (await db.SessoesCaixa.SingleAsync(Ct)).Status);
        Assert.Equal(2, await db.PagamentosVenda.CountAsync(Ct));
        Assert.Equal(1, await db.MovimentosCaixa.CountAsync(m => m.Tipo == TipoMovimentoCaixa.Sangria, Ct));
    }
}
