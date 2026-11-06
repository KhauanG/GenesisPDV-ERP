using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.App.ViewModels;
using GenesisPDV.App.ViewModels.Central;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Aba 1 Vendas da Central do PDV (bloco G5; README › decisão 70; decisões do dono de 04/11/2026): a operadora vê só o
/// caixa aberto (o serviço também recusa o caixa fechado pedido pelo id), o supervisor libera os caixas fechados dos
/// últimos 30 dias pelo Ctrl+L (o de 40 dias nunca aparece), a busca pelo número em "todos os caixas", o CPF mascarado na
/// lista e inteiro no detalhe com o caixa da venda, a 2ª via auditada na Central, venda de caixa fechado que não se
/// cancela (D23), o Ctrl+Del da venda do caixa aberto que leva ao F12 de sempre, o F3 do F12 que abre a aba, a página
/// pelo PgDn/PgUp e pelos botões, a soma das pagas só para quem vê o calculado (O3), a liberação que acaba devolvendo a
/// lista ao caixa aberto e, pelo login, o TECNICO que reimprime com o supervisor na hora.
/// </summary>
public class VendasCentralTelasTests
{
    private static readonly Guid Carlos = Guid.Parse("019a0003-0000-7000-8000-000000000002");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    /// <summary>Gelo (12,90) pago com 20,00 em dinheiro.</summary>
    private static async Task VenderAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
    }

    private sealed record Antigos(SessaoCaixaRegistro Fechado, Guid VendaFechada, SessaoCaixaRegistro Velho);

    /// <summary>
    /// Leva a última venda paga (com o comprovante na fila de impressão) para um caixa fechado há 3 dias, como a venda
    /// 4512 com CPF na nota, e cria um caixa fechado há 40 dias com a venda 3001 (fora do teto de 30 dias).
    /// <paramref name="copias"/> põe mais vendas (sem comprovante) no caixa de 3 dias.
    /// </summary>
    private static async Task<Antigos> CaixasAntigosAsync(AmbienteUi pdv, int copias = 0)
    {
        var identidade = pdv.Servicos.GetRequiredService<SessaoTerminal>().Identidade!;
        var agora = DateTimeOffset.UtcNow;
        SessaoCaixaRegistro Sessao(DateTimeOffset fechada) => new()
        {
            Id = Guid.CreateVersion7(),
            LojaId = identidade.LojaId,
            CaixaId = identidade.CaixaId,
            NumeroCaixa = (short)identidade.NumeroCaixa,
            TerminalId = identidade.TerminalId,
            OperadorId = Carlos,
            Status = StatusSessaoCaixa.Fechada,
            DiaOperacional = DateOnly.FromDateTime(fechada.UtcDateTime),
            AbertaEm = fechada.AddHours(-8),
            FechadaEm = fechada,
            CriadoEm = fechada,
            AtualizadoEm = fechada,
            Versao = 1,
        };
        var fechado = Sessao(agora.AddDays(-3));
        var velho = Sessao(agora.AddDays(-40));
        await using var db = Banco(pdv);
        db.SessoesCaixa.AddRange(fechado, velho);
        await db.SaveChangesAsync(Ct);
        var paga = await db.Vendas.OrderByDescending(v => v.FinalizadaEm).FirstAsync(Ct);
        var hora = fechado.FechadaEm!.Value.AddHours(-1);
        await db.Vendas.Where(v => v.Id == paga.Id).ExecuteUpdateAsync(v => v
            .SetProperty(x => x.SessaoCaixaId, fechado.Id).SetProperty(x => x.Numero, 4512L).SetProperty(x => x.NumeroExibicao, "L01-C02-004512")
            .SetProperty(x => x.CpfCnpjNota, "12345678909").SetProperty(x => x.FinalizadaEm, hora).SetProperty(x => x.IniciadaEm, hora.AddMinutes(-2))
            .SetProperty(x => x.OperadorId, Carlos), Ct);
        VendaRegistro Copia(SessaoCaixaRegistro s, long numero, DateTimeOffset quando) => new()
        {
            Id = Guid.CreateVersion7(),
            Numero = numero,
            NumeroExibicao = $"L01-C02-{numero:000000}",
            LojaId = paga.LojaId,
            CaixaId = paga.CaixaId,
            NumeroCaixa = paga.NumeroCaixa,
            TerminalId = paga.TerminalId,
            SessaoCaixaId = s.Id,
            OperadorId = Carlos,
            Status = StatusVenda.Finalizada,
            IniciadaEm = quando.AddMinutes(-1),
            FinalizadaEm = quando,
            QtdItens = 1,
            SubtotalBruto = 5m,
            Total = 5m,
            CriadoEm = quando,
            AtualizadoEm = quando,
            Versao = 1,
        };
        db.Vendas.Add(Copia(velho, 3001, velho.FechadaEm!.Value.AddHours(-1)));
        for (var i = 0; i < copias; i++)
        {
            db.Vendas.Add(Copia(fechado, 5000 + i, hora.AddMinutes(-(i + 1))));
        }

        await db.SaveChangesAsync(Ct);
        return new Antigos(fechado, paga.Id, velho);
    }

    private static async Task<AbaVendasViewModel> AbrirAbaVendasAsync(AmbienteUi pdv, CentralPdvViewModel central)
    {
        pdv.Tecla(Key.D1);
        await pdv.EsperarAsync(() => central.Conteudo is AbaVendasViewModel, "aba 1 Vendas");
        await pdv.EsperarFocoAsync("CampoFiltroVendasCentral");
        var aba = (AbaVendasViewModel)central.Conteudo!;
        await aba.Atualizacao;
        return aba;
    }

    private static async Task LiberarNaCentralAsync(AmbienteUi pdv, CentralPdvViewModel central)
    {
        pdv.Tecla(Key.L, RawInputModifiers.Control);
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "2";
        central.PinLiberacao = "4321";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => !central.Liberando && central.LiberacaoTexto is not null, "liberado pelo CARLOS");
    }

    [AvaloniaFact]
    public async Task Operadora_ve_o_caixa_aberto_e_o_supervisor_libera_os_fechados_dos_ultimos_30_dias()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await VenderAsync(pdv, venda);
        var antigos = await CaixasAntigosAsync(pdv);
        await VenderAsync(pdv, venda);

        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();
        Assert.False(central.Abas.Single(a => a.Codigo == "1").Bloqueada);
        var aba = await AbrirAbaVendasAsync(pdv, central);

        // A MARIA (sem pdv.venda.consultar_historico): só o caixa aberto, com o aviso de como liberar.
        Assert.Equal([true], aba.Caixas.Select(c => c.Aberto));
        Assert.StartsWith("Caixa aberto · desde ", aba.Caixas[0].Rotulo, StringComparison.Ordinal);
        Assert.Equal(AbaVendasViewModel.MensagemSemHistorico, aba.AvisoHistorico);
        Assert.Null(aba.AvisoMaisAntigas);
        var aberta = Assert.Single(aba.Linhas);
        Assert.Equal(("12,90", "Dinheiro", "aberto", string.Empty), (aberta.Total, aberta.Formas, aberta.Caixa, aberta.Selo));
        Assert.DoesNotContain("pagas:", aba.Rodape, StringComparison.Ordinal);
        pdv.Tecla(Key.F3);
        Assert.True(aba.CaixaEscolhido!.Aberto);
        pdv.Digitar("4512");
        await aba.Atualizacao;
        Assert.Empty(aba.Linhas);
        // O serviço também prende ao caixa aberto, mesmo pedindo o fechado pelo id (sem confiar só na tela).
        var servico = pdv.Servicos.GetRequiredService<ServicoHistoricoVendas>();
        // Quem decide é o serviço (pelo AcessoCentral, sem a tela dizer): os caixas, os operadores e a página.
        Assert.False(servico.VeHistorico);
        var pedida = await servico.VendasAsync(new FiltroVendas(antigos.Fechado.Id), ct: Ct);
        Assert.Equal([aberta.Venda.Id], pedida.Vendas.Select(v => v.Id));
        Assert.Null(pedida.TotalPagas);
        Assert.Equal([true], (await servico.CaixasAsync(Ct)).Select(c => c.Aberto));
        Assert.Empty((await servico.VendasAsync(new FiltroVendas(Texto: "4512"), ct: Ct)).Vendas);

        // O CARLOS libera (Ctrl+L): os caixas fechados dos últimos 30 dias entram no filtro; o de 40 dias, não.
        await LiberarNaCentralAsync(pdv, central);
        central.Atualizar();
        await pdv.EsperarAsync(() => aba.Caixas.Count == 3, "o aberto, todos e o fechado");
        await aba.Atualizacao;
        Assert.Null(aba.AvisoHistorico);
        Assert.Equal([antigos.Fechado.Id], aba.Caixas.Where(c => !c.Aberto && c.SessaoId is not null).Select(c => c.SessaoId!.Value));
        Assert.StartsWith("Todos os caixas dos últimos 30 dias", aba.Caixas[1].Rotulo, StringComparison.Ordinal);
        Assert.True(aba.CaixaEscolhido!.Aberto);

        // O 1 de novo leva o foco ao campo; F3 escolhe "todos" e a 4512 da semana aparece, com o CPF mascarado.
        pdv.Tecla(Key.D1);
        await pdv.EsperarFocoAsync("CampoFiltroVendasCentral");
        pdv.Tecla(Key.F3);
        await aba.Atualizacao;
        Assert.Null(aba.CaixaEscolhido!.SessaoId);
        var antiga = Assert.Single(aba.Linhas);
        Assert.Equal(("L01-C02-004512", "***.456.789-**", "CARLOS"), (antiga.Numero, antiga.Documento, antiga.Operador));
        Assert.StartsWith("fech. ", antiga.Caixa, StringComparison.Ordinal);
        pdv.Captura("70-central-vendas");

        // Enter: o detalhe com o caixa da venda e o CPF inteiro; Esc volta à lista com o foco no campo.
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe");
        await pdv.EsperarFocoAsync("PainelDetalheVendaCentral");
        Assert.Contains(aba.LinhasDetalhe, l => l.StartsWith("Caixa 02 · aberto em ", StringComparison.Ordinal) && l.Contains("fechado em", StringComparison.Ordinal));
        Assert.Contains(aba.LinhasDetalhe, l => l.Contains("CPF 12345678909", StringComparison.Ordinal));
        Assert.Contains(AbaVendasViewModel.MensagemCaixaFechado, aba.LinhasDetalhe);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("CampoFiltroVendasCentral");
        Assert.False(aba.MostrandoDetalhe);

        // Venda de caixa fechado não se cancela no PDV (D23): a mensagem, nada gravado.
        pdv.Tecla(Key.Delete, RawInputModifiers.Control);
        await AmbienteUi.Pausa();
        Assert.Equal(AbaVendasViewModel.MensagemCaixaFechado, aba.Erro);
        Assert.Same(central, pdv.Shell.PaginaAtual);

        // Ctrl+R: a 2ª via (o comprovante original da fila), auditada com a localização da Central.
        pdv.Tecla(Key.R, RawInputModifiers.Control);
        await pdv.EsperarAsync(() => aba.Mensagem is not null || aba.Erro is not null, "reimpressão");
        Assert.Null(aba.Erro);
        Assert.Contains("L01-C02-004512 reimpressa (2ª via)", aba.Mensagem, StringComparison.Ordinal);
        await using (var db = Banco(pdv))
        {
            var auditoria = Assert.Single(await db.LogAuditoriaLocal.AsNoTracking().Where(a => a.Acao == "reimpressao").ToListAsync(Ct));
            // A MARIA reimprime (tem pdv.documento.reimprimir), mas a venda de caixa fechado só apareceu pelo histórico que o
            // CARLOS emprestou: ele vai no autorizado_por_id.
            Assert.Equal((AbaVendasViewModel.Localizacao, (Guid?)Carlos), (auditoria.Localizacao, auditoria.AutorizadoPorId));
            Assert.Equal(0, await db.EventosSaida.CountAsync(e => e.Tipo == "venda.cancelada", Ct));
        }

        // O caixa de 40 dias fica de fora até pelo número (mais antigo, só no ERP).
        aba.Texto = "3001";
        await aba.Atualizacao;
        Assert.Empty(aba.Linhas);
        Assert.Equal("Nenhuma venda com esses filtros.", aba.Rodape);
        Assert.Equal(ConsultasHistoricoLocal.MensagemMaisAntigas, aba.AvisoMaisAntigas);
        Assert.Equal(ConsultasHistoricoLocal.MensagemMaisAntigas, pdv.Texto("TextoMaisAntigasVendas"));

        // F6 limpa (volta ao caixa aberto) e Esc volta ao menu e à venda.
        pdv.Tecla(Key.F6);
        await aba.Atualizacao;
        Assert.True(aba.CaixaEscolhido!.Aberto);
        Assert.Equal(string.Empty, aba.Texto);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "1", "foco no menu");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "venda");
    }

    [AvaloniaFact]
    public async Task Ctrl_del_na_venda_do_caixa_aberto_leva_ao_cancelamento_do_f12_e_o_f3_do_f12_abre_a_aba()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await VenderAsync(pdv, venda);
        await VenderAsync(pdv, venda);
        Guid primeira;
        await using (var db = Banco(pdv))
        {
            primeira = (await db.Vendas.OrderBy(v => v.Numero).FirstAsync(Ct)).Id;
        }

        // F12 › F3 (o botão também): as vendas dos caixas anteriores, na Central › 1 Vendas.
        pdv.Tecla(Key.F12);
        await pdv.EsperarFocoAsync("CampoFiltroVendas");
        pdv.Tecla(Key.F3);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is CentralPdvViewModel { Conteudo: AbaVendasViewModel }, "Central › 1 Vendas");
        var central = (CentralPdvViewModel)pdv.Shell.PaginaAtual!;
        await pdv.EsperarFocoAsync("CampoFiltroVendasCentral");
        var aba = (AbaVendasViewModel)central.Conteudo!;
        await aba.Atualizacao;
        Assert.Equal(2, aba.Linhas.Count);

        // Ctrl+Del na mais antiga (↓): volta à venda com o F12 nela e o cancelamento de sempre (o gerente ou o encarregado libera).
        pdv.Tecla(Key.Down);
        Assert.Equal(primeira, aba.Selecionada!.Venda.Id);
        pdv.Clicar(pdv.Controle<Button>("BotaoCancelarVendaCentral"));
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel { Dialogo: DialogoCancelarVendaFinalizadaViewModel }, "cancelamento do F12");
        venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        await pdv.EsperarFocoAsync("CampoMotivoCancelamentoVenda");
        Assert.Contains("Cancelar a venda paga L01-C02-000001", ((DialogoCancelarVendaFinalizadaViewModel)venda.Dialogo!).Titulo, StringComparison.Ordinal);
        Assert.False(pdv.Servicos.GetRequiredService<AcessoCentral>().Aberta);

        // Esc volta à lista do F12, sem gravar nada; com a venda em andamento, o F3 do F12 fica na mensagem.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoGestaoVendasViewModel, "lista do F12");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("CampoCodigo");
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F12);
        await pdv.EsperarFocoAsync("CampoFiltroVendas");
        var lista = Assert.IsType<DialogoGestaoVendasViewModel>(venda.Dialogo);
        pdv.Clicar(pdv.Controle<Button>("BotaoCaixasAnteriores"));
        await AmbienteUi.Pausa();
        Assert.Equal(VendaViewModel.MensagemCaixaLivre, lista.Erro);
        Assert.Same(venda, pdv.Shell.PaginaAtual);
        await using (var db = Banco(pdv))
        {
            Assert.Equal(0, await db.EventosSaida.CountAsync(e => e.Tipo == "venda.cancelada", Ct));
        }
    }

    [AvaloniaFact]
    public async Task Pelo_login_o_gerente_pagina_ve_a_soma_e_nao_cancela_e_o_tecnico_reimprime_com_o_supervisor()
    {
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: AutenticadorComExtras.Registrar);
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await VenderAsync(pdv, venda);
        var antigos = await CaixasAntigosAsync(pdv, copias: 60);
        await VenderAsync(pdv, venda);
        pdv.Shell.IrParaLogin();

        // O CARLOS (Master) pelo ⚙ do login: todos os caixas dos 30 dias, a soma das pagas (vê o calculado, O3).
        var central = await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        var aba = await AbrirAbaVendasAsync(pdv, central);
        Assert.Equal(3, aba.Caixas.Count);
        Assert.Contains("pagas: R$ 12,90", aba.Rodape, StringComparison.Ordinal);
        pdv.Tecla(Key.Delete, RawInputModifiers.Control);
        await AmbienteUi.Pausa();
        Assert.Equal(AbaVendasViewModel.MensagemCancelarPeloLogin, aba.Erro);

        // Todos os caixas: 62 vendas, 50 por página; PgDn e o botão "Mais antigas", PgUp volta.
        pdv.Tecla(Key.F3);
        await aba.Atualizacao;
        Assert.Equal(50, aba.Linhas.Count);
        Assert.StartsWith("Vendas 1 a 50 de 62 · página 1 · pagas: R$ 325,80", aba.Rodape, StringComparison.Ordinal);
        Assert.True(aba.TemProxima);
        Assert.Null(aba.AvisoMaisAntigas);
        pdv.Tecla(Key.PageDown);
        await aba.Atualizacao;
        Assert.Equal((12, 2, false), (aba.Linhas.Count, aba.Pagina, aba.TemProxima));
        Assert.StartsWith("Vendas 51 a 62 de 62 · página 2", aba.Rodape, StringComparison.Ordinal);
        Assert.DoesNotContain("pagas:", aba.Rodape, StringComparison.Ordinal);
        // A última página diz que mais antigo é no ERP.
        Assert.Equal(ConsultasHistoricoLocal.MensagemMaisAntigas, aba.AvisoMaisAntigas);
        var segunda = aba.Linhas.Select(l => l.Venda.Id).ToList();
        pdv.Clicar(pdv.Controle<Button>("BotaoPaginaAnteriorVendas"));
        await aba.Atualizacao;
        Assert.Equal((50, 1), (aba.Linhas.Count, aba.Pagina));
        Assert.Empty(aba.Linhas.Select(l => l.Venda.Id).Intersect(segunda));
        pdv.Clicar(pdv.Controle<Button>("BotaoProximaPaginaVendas"));
        await aba.Atualizacao;
        Assert.Equal(segunda, aba.Linhas.Select(l => l.Venda.Id));
        Assert.DoesNotContain(aba.Linhas, l => l.Venda.SessaoCaixaId == antigos.Velho.Id);

        // O teclado numérico (plano 4): − volta (com o campo vazio) e + avança; o caractere que o sistema manda não entra no campo.
        pdv.Tecla(Key.Subtract);
        pdv.Digitar("-");
        await aba.Atualizacao;
        Assert.Equal((1, string.Empty), (aba.Pagina, aba.Texto));
        pdv.Tecla(Key.Add);
        pdv.Digitar("+");
        await aba.Atualizacao;
        Assert.Equal((2, string.Empty), (aba.Pagina, aba.Texto));
        Assert.Equal(segunda, aba.Linhas.Select(l => l.Venda.Id));

        // * abre o detalhe da escolhida (da página 2). Volta à aba depois da 0: a lista relida volta à página 1, a venda do
        // detalhe saiu dela e o detalhe fecha (o Ctrl+R não age sobre a primeira da página 1 com o detalhe da outra na tela).
        pdv.Tecla(Key.Multiply);
        pdv.Digitar("*");
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe pelo *");
        var doDetalhe = aba.Selecionada!.Venda.Id;
        Assert.Contains(doDetalhe, segunda);
        pdv.Clicar(pdv.BotaoDaAba("0"));
        await pdv.EsperarAsync(() => central.Conteudo is AbaPainelViewModel, "aba 0");
        pdv.Clicar(pdv.BotaoDaAba("1"));
        await pdv.EsperarAsync(() => central.Conteudo == aba && aba.Pagina == 1 && !aba.MostrandoDetalhe && !aba.Carregando, "a aba relida na página 1");
        Assert.Empty(aba.LinhasDetalhe);
        Assert.NotEqual(doDetalhe, aba.Selecionada!.Venda.Id);

        // O − com o CPF sendo digitado com a máscara é o traço do CPF, não a página.
        await pdv.EsperarFocoAsync("CampoFiltroVendasCentral");
        pdv.Digitar("123.456.789");
        pdv.Tecla(Key.Subtract);
        pdv.Digitar("-");
        await aba.Atualizacao;
        Assert.Equal(("123.456.789-", 1), (aba.Texto, aba.Pagina));
        aba.Texto = string.Empty;
        await aba.Atualizacao;

        // A situação escolhida pelo mouse devolve o foco ao campo: o F4 seguinte troca a situação (não abre a lista).
        var situacao = pdv.Controle<ComboBox>("ListaSituacaoVendas");
        pdv.Clicar(situacao);
        // A lista aberta tem o foco (o ComboBox ou o item escolhido nela): sem devolver, o F4 seria dela.
        Assert.True(situacao.IsDropDownOpen);
        Assert.IsAssignableFrom<ComboBoxItem>(pdv.Janela.FocusManager?.GetFocusedElement());
        situacao.SelectedIndex = 1;
        situacao.IsDropDownOpen = false;
        await pdv.EsperarFocoAsync("CampoFiltroVendasCentral");
        pdv.Tecla(Key.F4);
        await aba.Atualizacao;
        Assert.Equal((2, false), (aba.SituacaoIndice, situacao.IsDropDownOpen));
        aba.SituacaoIndice = 0;
        await aba.Atualizacao;

        // Sair; o TECNICO (sem ver vendas nem reimprimir) entra, o CARLOS libera a aba e, na 2ª via, libera de novo na hora.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "1", "menu");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "login");
        central = await pdv.EntrarNaCentralPeloLoginAsync("tecnico", AutenticadorComExtras.PinTecnico);
        Assert.True(central.Abas.Single(a => a.Codigo == "1").Bloqueada);
        await LiberarNaCentralAsync(pdv, central);
        aba = await AbrirAbaVendasAsync(pdv, central);
        Assert.Equal(3, aba.Caixas.Count);
        aba.Texto = "4512";
        aba.CaixaEscolhido = aba.Caixas[1];
        await aba.Atualizacao;
        Assert.Single(aba.Linhas);
        pdv.Clicar(pdv.Controle<Button>("BotaoReimprimirVendaCentral"));
        await pdv.EsperarFocoAsync("CampoSupervisor");
        Assert.NotNull(aba.Liberacao);
        aba.Liberacao!.Usuario = "2";
        aba.Liberacao.Pin = "4321";
        aba.Liberacao.Motivo = "Cliente pediu a segunda via";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.Liberacao is null && aba.Mensagem is not null, "reimpressa com o CARLOS");
        Assert.Contains("liberada por CARLOS", aba.Mensagem, StringComparison.Ordinal);
        await pdv.EsperarFocoAsync("CampoFiltroVendasCentral");
        await using var db = Banco(pdv);
        var reimpressao = Assert.Single(await db.LogAuditoriaLocal.AsNoTracking().Where(a => a.Acao == "reimpressao").ToListAsync(Ct));
        Assert.Equal(((Guid?)AutenticadorComExtras.Tecnico.Id, (Guid?)Carlos, (string?)AbaVendasViewModel.Localizacao),
            (reimpressao.UsuarioId, reimpressao.AutorizadoPorId, reimpressao.Localizacao));
    }

    [AvaloniaFact]
    public async Task Na_janela_minima_a_lista_aparece_e_os_botoes_tem_44_px()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await VenderAsync(pdv, venda);
        pdv.Janela.Width = 1024;
        pdv.Janela.Height = 700;
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();
        pdv.Clicar(pdv.BotaoDaAba("1"));
        await pdv.EsperarFocoAsync("CampoFiltroVendasCentral");
        var aba = (AbaVendasViewModel)central.Conteudo!;
        await aba.Atualizacao;
        await AmbienteUi.Pausa();
        pdv.Captura("71-central-vendas-1024");

        // Pelo mouse: a linha com o duplo clique abre o detalhe; o botão volta.
        Assert.True(pdv.Controle<ListBox>("ListaVendasCentral").Bounds.Height >= 120, "a lista com espaço para algumas vendas");
        foreach (var nome in new[] { "BotaoDetalheVendaCentral", "BotaoReimprimirVendaCentral", "BotaoCancelarVendaCentral", "BotaoProximaPaginaVendas" })
        {
            Assert.True(pdv.Controle<Button>(nome).Bounds.Height >= 44, nome);
        }

        pdv.DuploClique(pdv.LinhaDaLista("ListaVendasCentral", l => l is LinhaVendaCentralViewModel));
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe pelo duplo clique");
        pdv.Clicar(pdv.Controle<Button>("BotaoVoltarDetalheVenda"));
        await pdv.EsperarFocoAsync("CampoFiltroVendasCentral");
        Assert.False(aba.MostrandoDetalhe);
    }

    [AvaloniaFact]
    public async Task Liberacao_que_acaba_devolve_a_lista_ao_caixa_aberto()
    {
        var tempo = new Tempo();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<TimeProvider>(tempo));
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await VenderAsync(pdv, venda);
        var antigos = await CaixasAntigosAsync(pdv);
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();
        await LiberarNaCentralAsync(pdv, central);
        var aba = await AbrirAbaVendasAsync(pdv, central);
        aba.CaixaEscolhido = aba.Caixas.Single(c => c.SessaoId == antigos.Fechado.Id);
        await aba.Atualizacao;
        Assert.Equal([antigos.VendaFechada], aba.Linhas.Select(l => l.Venda.Id));

        // 5 min sem uso: a aba (da própria MARIA) fica, mas a lista volta ao caixa aberto, com o aviso.
        tempo.Avancar(AcessoCentral.ValidadeLiberacao + TimeSpan.FromSeconds(1));
        central.Atualizar();
        await aba.Atualizacao;
        Assert.Equal("1", central.AbaSelecionada!.Codigo);
        Assert.Equal([true], aba.Caixas.Select(c => c.Aberto));
        Assert.Equal(AbaVendasViewModel.MensagemHistoricoAcabou, aba.Mensagem);
        Assert.Equal(AbaVendasViewModel.MensagemSemHistorico, aba.AvisoHistorico);
        Assert.Empty(aba.Linhas);
    }

    [AvaloniaFact]
    public async Task Liberacao_que_acaba_antes_do_relogio_nao_reimprime_nem_abre_a_venda_de_caixa_fechado()
    {
        var tempo = new Tempo();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<TimeProvider>(tempo));
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await VenderAsync(pdv, venda);
        var antigos = await CaixasAntigosAsync(pdv);
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();
        await LiberarNaCentralAsync(pdv, central);
        var aba = await AbrirAbaVendasAsync(pdv, central);
        aba.CaixaEscolhido = aba.Caixas.Single(c => c.SessaoId == antigos.Fechado.Id);
        await aba.Atualizacao;
        Assert.Equal([antigos.VendaFechada], aba.Linhas.Select(l => l.Venda.Id));

        // A liberação acaba e a MARIA (que reimprime por conta própria) aperta Ctrl+R e Enter antes do relógio de 1 s:
        // a venda do caixa fechado não sai de novo nem abre, e a lista volta ao caixa aberto na hora.
        tempo.Avancar(AcessoCentral.ValidadeLiberacao + TimeSpan.FromSeconds(1));
        await aba.ReimprimirCommand.ExecuteAsync(null);
        Assert.Equal(AbaVendasViewModel.MensagemHistoricoAcabou, aba.Erro);
        await aba.Atualizacao;
        Assert.Equal([true], aba.Caixas.Select(c => c.Aberto));
        Assert.Equal(AbaVendasViewModel.MensagemHistoricoAcabou, aba.Mensagem);
        Assert.False(aba.MostrandoDetalhe);
        await using (var db = Banco(pdv))
        {
            Assert.Equal(0, await db.LogAuditoriaLocal.CountAsync(a => a.Acao == "reimpressao", Ct));
        }
    }

    [AvaloniaFact]
    public async Task Liberacao_que_acaba_fecha_o_detalhe_e_o_pedido_do_supervisor_da_venda_de_caixa_fechado()
    {
        var tempo = new Tempo();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s =>
        {
            AutenticadorComExtras.Registrar(s);
            s.AddSingleton<TimeProvider>(tempo);
        });
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await VenderAsync(pdv, venda);
        await CaixasAntigosAsync(pdv, copias: 1);
        await VenderAsync(pdv, venda);
        pdv.Shell.IrParaLogin();

        // O TECNICO (sem ver vendas nem reimprimir) pelo login; o CARLOS libera; o detalhe da 4512 (caixa fechado, CPF inteiro).
        var central = await pdv.EntrarNaCentralPeloLoginAsync("tecnico", AutenticadorComExtras.PinTecnico);
        await LiberarNaCentralAsync(pdv, central);
        var aba = await AbrirAbaVendasAsync(pdv, central);
        aba.CaixaEscolhido = aba.Caixas[1];
        aba.Texto = "4512";
        await aba.Atualizacao;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe da 4512");
        Assert.Contains(aba.LinhasDetalhe, l => l.Contains("CPF 12345678909", StringComparison.Ordinal));
        // Ctrl+R no detalhe: o pedido do supervisor (a liberação da Central não empresta a reimpressão).
        pdv.Tecla(Key.R, RawInputModifiers.Control);
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var pedido = aba.Liberacao!;
        // Com o pedido na tela, o Enter (ou o * e o botão) do detalhe não age por baixo dele.
        await aba.DetalharCommand.ExecuteAsync(null);
        Assert.True(aba.MostrandoDetalhe);
        Assert.Same(pedido, aba.Liberacao);

        // 5 min sem uso: a liberação acaba; o detalhe (com o CPF) e o pedido do supervisor saem da tela, e o PIN digitado
        // depois no pedido antigo não reimprime nada.
        tempo.Avancar(AcessoCentral.ValidadeLiberacao + TimeSpan.FromSeconds(1));
        central.Atualizar();
        await pdv.EsperarAsync(() => !aba.MostrandoDetalhe && aba.Liberacao is null && !aba.Carregando, "detalhe e pedido fechados");
        Assert.Empty(aba.LinhasDetalhe);
        Assert.Equal(string.Empty, aba.TituloDetalhe);
        Assert.Equal(CentralPdvViewModel.MensagemLiberacaoAcabou, central.Mensagem);
        pedido.Usuario = "2";
        pedido.Pin = "4321";
        pedido.Motivo = "Cliente pediu a segunda via";
        await pedido.ConfirmarCommand.ExecuteAsync(null);
        await AmbienteUi.Pausa();
        await using (var db = Banco(pdv))
        {
            Assert.Equal(0, await db.LogAuditoriaLocal.CountAsync(a => a.Acao == "reimpressao", Ct));
        }

        // A 2ª via gerada de novo (sem o original na fila) leva o operador da venda (o CARLOS), não quem reimprime.
        Guid copia;
        await using (var db = Banco(pdv))
        {
            copia = (await db.Vendas.SingleAsync(v => v.Numero == 5000, Ct)).Id;
        }

        var carlos = new LiberacaoConcedida(AutenticadorOperadorSimulado.Operadores.Single(o => o.Login == "carlos"), "Cliente pediu", DateTimeOffset.UtcNow);
        var (texto, _) = await pdv.Servicos.GetRequiredService<ServicoVenda>()
            .ReimprimirAsync(copia, carlos, AutenticadorComExtras.Tecnico, AbaVendasViewModel.Localizacao, ct: Ct);
        Assert.Contains("Operador: CARLOS", texto, StringComparison.Ordinal);
        Assert.DoesNotContain("TECNICO", texto, StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task Caixa_escolhido_que_passa_dos_30_dias_avisa_que_e_no_erp_e_nao_que_a_liberacao_acabou()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await VenderAsync(pdv, venda);
        var antigos = await CaixasAntigosAsync(pdv);
        pdv.Shell.IrParaLogin();

        // O CARLOS (com o histórico próprio) escolhe o caixa fechado; enquanto a aba está na 0, a hora de corte passa e o
        // caixa sai dos 30 dias (o fechamento fica com 31 dias, como no dia seguinte).
        var central = await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        var aba = await AbrirAbaVendasAsync(pdv, central);
        aba.CaixaEscolhido = aba.Caixas.Single(c => c.SessaoId == antigos.Fechado.Id);
        await aba.Atualizacao;
        Assert.Single(aba.Linhas);
        pdv.Clicar(pdv.BotaoDaAba("0"));
        await pdv.EsperarAsync(() => central.Conteudo is AbaPainelViewModel, "aba 0");
        await using (var db = Banco(pdv))
        {
            var fechada = DateTimeOffset.UtcNow.AddDays(-31);
            await db.SessoesCaixa.Where(x => x.Id == antigos.Fechado.Id).ExecuteUpdateAsync(x => x.SetProperty(c => c.FechadaEm, fechada), Ct);
        }

        pdv.Clicar(pdv.BotaoDaAba("1"));
        await pdv.EsperarAsync(() => aba.Mensagem is not null && !aba.Carregando, "a aba relida");
        Assert.Equal(AbaVendasViewModel.MensagemCaixaForaDoAlcance, aba.Mensagem);
        Assert.DoesNotContain(aba.Caixas, c => c.SessaoId == antigos.Fechado.Id);
        Assert.True(aba.CaixaEscolhido!.Aberto);
    }

    /// <summary>O relógio monotônico da liberação, avançado à mão.</summary>
    private sealed class Tempo : TimeProvider
    {
        private long _ticks = 1;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => _ticks;

        public void Avancar(TimeSpan quanto) => _ticks += quanto.Ticks;
    }
}
