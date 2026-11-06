using System.Text.Json.Nodes;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Diálogos Montar combo (PDV 10.9.1) e Cascos trazidos (10.12) operados só pelo teclado, preço por quantidade na tela
/// (11.3.1) e o combo no comprovante (19.2), com o catálogo local carregado pela demonstração; e os cascos a mais
/// descontados na venda pelo F11 › V (C11c).
/// </summary>
public class ComboCascoTelasTests
{
    private static ServicoVenda Servico(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<ServicoVenda>();

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<DialogoVasilhamesViewModel> VasilhamesAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.V);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoVasilhamesViewModel, "vasilhames");
        await pdv.EsperarFocoAsync("CampoQuantidadeCascos");
        return (DialogoVasilhamesViewModel)venda.Dialogo!;
    }

    [AvaloniaFact]
    public async Task Cascos_a_mais_sao_descontados_na_venda_pelo_f11_e_saem_no_cupom_e_no_evento()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0600");
        await pdv.EsperarFocoAsync("CampoCascosTrazidos");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "cascos trazidos");
        await pdv.EntrarCodigoAsync("0044");
        Assert.Equal("22,80", pdv.Texto("TextoTotal"));

        // O cliente trouxe mais 2 garrafas: com a venda em andamento, o padrão é descontar nela.
        var cascos = await VasilhamesAsync(pdv, venda);
        Assert.True(cascos.Descontar);
        Assert.Contains("DESCONTAR NA VENDA", pdv.Texto("TextoDestinoVasilhames"));
        pdv.Tecla(Key.A, RawInputModifiers.Control);
        pdv.Digitar("2");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "cascos descontados");
        Assert.Equal("2 casco(s) GARRAFA 600ML RETORNÁVEL descontado(s) na venda: -R$ 5,00.", pdv.Texto("TextoMensagem"));
        Assert.Equal(("17,80", "-5,00"), (pdv.Texto("TextoTotal"), venda.DescontosTexto));
        Assert.Equal("Cascos descontados: 2 GARRAFA 600ML RETORNÁVEL  -5,00", pdv.Texto("TextoCascosDescontados"));
        pdv.Captura("37-cascos-descontados");

        // De novo no F11 › V: o casco já descontado aparece com a quantidade; F3 passa a só a entrada, que não mexe na venda.
        cascos = await VasilhamesAsync(pdv, venda);
        Assert.Equal("2", cascos.Quantidade);
        Assert.Contains("Já descontados nesta venda: 2", pdv.Texto("TextoDescontadoVasilhames"));
        pdv.Tecla(Key.F3);
        Assert.False(cascos.Descontar);
        Assert.Contains("SÓ A ENTRADA", pdv.Texto("TextoDestinoVasilhames"));
        Assert.False(pdv.Controle<TextBlock>("TextoDescontadoVasilhames").IsVisible);
        pdv.Tecla(Key.A, RawInputModifiers.Control);
        pdv.Digitar("1");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "entrada registrada");
        Assert.Equal("Devolução de 1 casco(s) GARRAFA 600ML RETORNÁVEL registrada.", pdv.Texto("TextoMensagem"));
        Assert.Equal("17,80", pdv.Texto("TextoTotal"));

        // A entrada avulsa sobe no vasilhame.movimentado e não mexe no crédito da venda.
        Assert.Equal(5m, Servico(pdv).Atual!.DescontoTotal);

        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.CaixaLivre && venda.Dialogo is null, "venda finalizada");
        var cupom = venda.UltimoCupom!;
        Assert.Contains("Cascos devolvidos: 3", cupom);
        Assert.Contains("Desconto casco: GARRAFA 600ML RETORNÁVEL", cupom);
        Assert.Matches(@"   2 x 2,50 +-5,00", cupom);

        await using var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
        var evento = await db.EventosSaida.SingleAsync(e => e.Tipo == "venda.finalizada", Ct);
        var payload = JsonNode.Parse(evento.Payload)!;
        Assert.Equal(("5.00", "cliente", "17.80"), (
            payload["vendas"]!["desconto_total"]!.GetValue<string>(),
            payload["vendas"]!["desconto_total_origem"]!.GetValue<string>(),
            payload["vendas"]!["total"]!.GetValue<string>()));
        var vazios = Assert.Single(payload["vasilhames"]!.AsArray())!;
        Assert.Equal((3, 0), (vazios["devolvidos"]!.GetValue<int>(), vazios["vendidos"]!.GetValue<int>()));
        Assert.Equal(1, await db.CascosDescontadosVenda.CountAsync(Ct));
        Assert.Equal(1, await db.MovimentosVasilhame.CountAsync(Ct));
        Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "cascos_descontados", Ct));
    }

    [AvaloniaFact]
    public async Task Desconto_dos_cascos_acima_do_teto_pede_o_supervisor_e_na_venda_em_pagamento_o_f11_v_manda_voltar_aos_itens()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("10*0044");

        // README › decisão 56 (D38): 21 garrafas = R$ 52,50, acima dos R$ 50,00 sem supervisor; nada muda até ele liberar.
        var cascos = await VasilhamesAsync(pdv, venda);
        pdv.Tecla(Key.A, RawInputModifiers.Control);
        pdv.Digitar("21");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var pedido = Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
        Assert.Contains("R$ 52,50 (sem supervisor: até R$ 50,00)", pedido.Titulo);
        Assert.Empty(Servico(pdv).Atual!.CascosDescontados);
        pedido.Pedido.Usuario = "2";
        pedido.Pedido.Pin = "4321";
        pedido.Pedido.Motivo = "Cliente trouxe duas grades";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "cascos descontados com a liberação");
        Assert.StartsWith("21 casco(s) GARRAFA 600ML RETORNÁVEL descontado(s) na venda: -R$ 52,50. Liberado por", pdv.Texto("TextoMensagem"));
        var atual = Servico(pdv).Atual!;
        Assert.Equal(52.50m, atual.DescontoCascos);
        var liberacao = Assert.Single(atual.Liberacoes);
        Assert.Equal((AcaoLiberacao.DescontoCascos, (Guid?)null, (decimal?)null), (liberacao.Acao, liberacao.ItemVendaId, liberacao.ValorPct));
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "liberacao", Ct));
        }

        // Reduzir o crédito não pede nada.
        cascos = await VasilhamesAsync(pdv, venda);
        pdv.Tecla(Key.A, RawInputModifiers.Control);
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "cascos reduzidos");
        Assert.Equal((50m, 1), (Servico(pdv).Atual!.DescontoCascos, Servico(pdv).Atual!.Liberacoes.Count));

        // Venda retomada em pagamento (sem o diálogo de pagamento aberto): o F11 › V manda voltar aos itens.
        await Servico(pdv).IniciarPagamentoAsync(Ct);
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.V);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "F11 › V recusado");
        Assert.Equal("Volte aos itens (Esc no pagamento) para registrar cascos nesta venda.", pdv.Texto("TextoMensagem"));
    }

    [AvaloniaFact]
    public async Task Enter_em_sequencia_aceita_os_padroes_do_combo()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0500");
        var dialogo = Assert.IsType<DialogoMontarComboViewModel>(venda.Dialogo);
        await pdv.EsperarFocoAsync("DialogoMontarCombo");
        Assert.Equal("Combo: R$ 129,90", pdv.Texto("TextoTotalCombo"));
        Assert.Equal("Energético 2L", dialogo.PosicaoEmFoco!.Rotulo);
        Assert.True(dialogo.Posicoes[0].Fixa);
        Assert.Equal("(•) 1 ENERGETICO RED BULL 2L", dialogo.Posicoes[1].Opcoes[0].Texto);
        pdv.Captura("10-montar-combo");

        pdv.Tecla(Key.Enter);
        Assert.Equal("Gelo de sabor", dialogo.PosicaoEmFoco!.Rotulo);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "combo incluído");

        Assert.Equal("129,90", pdv.Texto("TextoTotal"));
        Assert.Equal(4, venda.Itens.Count);
        Assert.True(venda.Itens[0].EhTituloCombo);
        Assert.Equal("COMBO DE WHISKY 1L", venda.Itens[0].Descricao);
        Assert.Equal("129,90", venda.Itens[0].Total);
        Assert.All(venda.Itens.Skip(1), l => Assert.True(l.EhComponente));
        var linhas = Servico(pdv).Atual!.ItensAtivos.ToList();
        Assert.Equal(["WHISKY 1L", "ENERGETICO RED BULL 2L", "GELO DE COCO"], linhas.Select(l => l.Descricao));
        Assert.All(linhas, l => Assert.Null(l.Kit!.AlternativaId));
        await pdv.EsperarFocoAsync("CampoCodigo");
    }

    [AvaloniaFact]
    public async Task Trocar_red_bull_por_monster_soma_o_acrescimo_e_o_cupom_mostra_o_desmembramento()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0500");
        var dialogo = Assert.IsType<DialogoMontarComboViewModel>(venda.Dialogo);
        await pdv.EsperarFocoAsync("DialogoMontarCombo");

        pdv.Tecla(Key.Down);
        Assert.Equal("(•) 2 ENERGETICO MONSTER 2L", dialogo.Posicoes[1].Opcoes[1].Texto);
        Assert.Equal("+R$ 2,00", dialogo.Posicoes[1].Opcoes[1].Info);
        Assert.Equal("Combo: R$ 131,90", pdv.Texto("TextoTotalCombo"));
        pdv.Tecla(Key.Enter);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "combo incluído");

        Assert.Equal("131,90", pdv.Texto("TextoTotal"));
        Assert.Contains(venda.Itens, l => l.Descricao.Contains("ENERGETICO MONSTER 2L  (troca +2,00)"));
        var linhas = Servico(pdv).Atual!.ItensAtivos.ToList();
        Assert.Equal([98.48m, 24.55m, 8.87m], linhas.Select(l => l.ValorBruto));
        Assert.DoesNotContain(linhas, l => l.Descricao.Contains("RED BULL"));

        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.CaixaLivre && venda.Dialogo is null, "venda finalizada");
        var cupom = venda.UltimoCupom!;
        Assert.Contains("COMBO DE WHISKY 1L", cupom);
        Assert.Contains("1,000 UN x 131,90", cupom);
        Assert.Contains("     1 WHISKY 1L", cupom);
        Assert.Contains("     1 ENERGETICO MONSTER 2L (troca +2,00)", cupom);
        Assert.Contains("     2 GELO DE COCO", cupom);
        Assert.DoesNotContain("98,48", cupom);
        pdv.Captura("11-cupom-combo");
    }

    [AvaloniaFact]
    public async Task Numeros_escolhem_a_opcao_tab_anda_e_esc_volta_ate_fechar_sem_incluir()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0500");
        var dialogo = Assert.IsType<DialogoMontarComboViewModel>(venda.Dialogo);
        await pdv.EsperarFocoAsync("DialogoMontarCombo");

        pdv.Tecla(Key.D3);
        Assert.Equal(2, dialogo.Posicoes[1].Indice);
        pdv.Tecla(Key.Tab);
        Assert.Equal("Gelo de sabor", dialogo.PosicaoEmFoco!.Rotulo);
        pdv.Tecla(Key.D2);
        Assert.Equal(1, dialogo.Posicoes[2].Indice);
        pdv.Tecla(Key.D9);
        Assert.NotNull(dialogo.Erro);
        Assert.Equal(1, dialogo.Posicoes[2].Indice);
        pdv.Tecla(Key.Tab, RawInputModifiers.Shift);
        Assert.Equal("Energético 2L", dialogo.PosicaoEmFoco!.Rotulo);
        pdv.Tecla(Key.Tab);
        pdv.Tecla(Key.Escape);
        Assert.Equal("Energético 2L", dialogo.PosicaoEmFoco!.Rotulo);
        Assert.Same(dialogo, venda.Dialogo);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "diálogo fechado");
        Assert.True(venda.CaixaLivre);
        Assert.Null(Servico(pdv).Atual);
        await pdv.EsperarFocoAsync("CampoCodigo");
    }

    [AvaloniaFact]
    public async Task Combo_sem_alternativas_entra_direto_e_f4_cancela_o_combo_inteiro()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0510");
        await pdv.EsperarAsync(() => venda.Itens.Count == 4, "kit churrasco");
        Assert.Null(venda.Dialogo);
        Assert.Equal("49,90", pdv.Texto("TextoTotal"));

        // As 6 latas do kit não ativam o atacado das 6 avulsas.
        await pdv.EntrarCodigoAsync("6*7891149103102");
        await pdv.EsperarAsync(() => venda.Itens.Count == 5);
        Assert.Equal("70,84", pdv.Texto("TextoTotal"));

        pdv.Tecla(Key.Up);
        pdv.Tecla(Key.Up);
        pdv.Tecla(Key.F4);
        await pdv.EsperarFocoAsync("CampoSequencia");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null);
        Assert.Equal("20,94", pdv.Texto("TextoTotal"));
        Assert.True(venda.Itens[0].Cancelado);
    }

    [AvaloniaFact]
    public async Task Casco_e_cobrado_quando_o_cliente_nao_traz_o_vazio()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0600");
        var dialogo = Assert.IsType<DialogoCascosViewModel>(venda.Dialogo);
        await pdv.EsperarFocoAsync("CampoCascosTrazidos");
        Assert.Equal("1", dialogo.Valor);
        pdv.Captura("12-cascos");

        // Esc não fecha: a pergunta é obrigatória.
        pdv.Tecla(Key.Escape);
        Assert.Same(dialogo, venda.Dialogo);
        Assert.Contains("[Enter] aceita 1", dialogo.Erro);

        pdv.Tecla(Key.A, RawInputModifiers.Control);
        pdv.Digitar("0");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "cascos registrados");
        Assert.Equal("12,40", pdv.Texto("TextoTotal"));
        Assert.Equal(2, venda.Itens.Count);
        Assert.Equal("GARRAFA 600ML RETORNÁVEL (casco)", venda.Itens[1].Descricao);
        Assert.Contains("Cascos: 1 devidos · 0 trazidos · 1 cobrados", venda.Itens[0].Detalhe);
        Assert.Contains("casco(s) cobrado(s)", pdv.Texto("TextoMensagem"));
        await pdv.EsperarFocoAsync("CampoCodigo");

        // F3 no cheio pergunta de novo; trazendo os 2, o casco cobrado sai.
        pdv.Tecla(Key.Up);
        pdv.Tecla(Key.F3);
        await pdv.EsperarFocoAsync("CampoQuantidade");
        pdv.Tecla(Key.A, RawInputModifiers.Control);
        pdv.Digitar("2");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoCascosViewModel, "pergunta de novo");
        await pdv.EsperarFocoAsync("CampoCascosTrazidos");
        pdv.Tecla(Key.A, RawInputModifiers.Control);
        pdv.Digitar("2");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null);
        Assert.Equal("19,80", pdv.Texto("TextoTotal"));
        Assert.Single(Servico(pdv).Atual!.ItensAtivos);
    }

    [AvaloniaFact]
    public async Task Enter_aceita_todos_os_cascos_trazidos_e_valor_fora_da_faixa_e_recusado()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("17891991015308");
        var dialogo = Assert.IsType<DialogoCascosViewModel>(venda.Dialogo);
        await pdv.EsperarFocoAsync("CampoCascosTrazidos");
        Assert.Equal("24", dialogo.Valor);
        Assert.Contains("Cascos devidos: 24", dialogo.DevidosTexto);

        // Uma leitura do leitor dentro do diálogo não vira quantidade válida.
        pdv.Digitar("7891991015301");
        pdv.Tecla(Key.Enter);
        Assert.Same(dialogo, venda.Dialogo);
        Assert.Contains("devolução avulsa", dialogo.Erro);

        pdv.Tecla(Key.A, RawInputModifiers.Control);
        pdv.Digitar("24");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null);
        Assert.Equal("237,60", pdv.Texto("TextoTotal"));
        Assert.Single(Servico(pdv).Atual!.ItensAtivos);
    }

    [AvaloniaFact]
    public async Task Mix_fardo_e_etiquetas_de_atacado_na_tela()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();

        // 6 Brahma + 6 Skol no MIX LATAS 350ML (modo produto): cada uma cai para o atacado dela.
        await pdv.EntrarCodigoAsync("6*7891149103102");
        await pdv.EntrarCodigoAsync("5*7891991010856");
        await pdv.EsperarAsync(() => venda.Itens.Count == 2);
        Assert.Equal("35,89", pdv.Texto("TextoTotal"));
        Assert.Contains("Faltam 1", pdv.Texto("TextoDicaPreco"));
        await pdv.EntrarCodigoAsync("+");
        await pdv.EsperarAsync(() => pdv.Texto("TextoTotal") == "35,88");
        Assert.All(venda.Itens, l => Assert.Equal("ATAC 12+", l.Etiqueta));
        Assert.Equal("3,49", venda.Itens[0].VarejoRiscado);
        var itens = Servico(pdv).Atual!.ItensAtivos.ToList();
        Assert.Equal([3.19m, 2.79m], itens.Select(i => i.PrecoUnitario));
        Assert.All(itens, i => Assert.Equal(CatalogoDemonstracaoMix, i.GrupoPrecoQuantidadeId));
        pdv.Captura("13-mix-atacado");

        // Fardo de 12 pelo DUN: 12 UN com o preço do fardo; soma no grupo (agora 24 latas).
        await pdv.EntrarCodigoAsync("17891149103109");
        await pdv.EsperarAsync(() => venda.Itens.Count == 3);
        var fardo = Servico(pdv).Atual!.ItensAtivos.Last();
        Assert.Equal(12m, fardo.Quantidade);
        Assert.Equal(37.90m, fardo.ValorBruto);
        Assert.Equal(OrigemPreco.Embalagem, fardo.OrigemPreco);
        Assert.Contains("FD 12 × 37,90", venda.Itens[2].Detalhe);
        Assert.Equal("73,78", pdv.Texto("TextoTotal"));
    }

    private static readonly Guid CatalogoDemonstracaoMix = Guid.Parse("019a0007-0000-7000-8000-000000000001");
}
