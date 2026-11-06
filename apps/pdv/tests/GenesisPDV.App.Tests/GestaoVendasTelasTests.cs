using System.Text.Json.Nodes;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Fiscal;
using GenesisPDV.Hardware.Gaveta;
using GenesisPDV.Sync.Cliente;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// F12 Gestão de vendas pelo teclado (Fase 1C, bloco C11b; PDV 13.2, 13.3, 22.1, 22.2): o cancelamento da venda paga
/// (forma A do <c>venda.cancelada</c>) com a devolução escolhida por pagamento (O22 do dono), a liberação do gerente
/// (O6), o motivo em texto livre, os cascos que voltam ao cliente (D29) e o estorno na gaveta; a reimpressão com a marca
/// da 2ª via; o Shift+F4 com o motivo e o supervisor; e as recusas do serviço (caixa ocupado, D22, venda descartada no
/// ERP, cancelamento da venda em andamento sem a permissão).
/// </summary>
public class GestaoVendasTelasTests
{
    private static readonly Guid Debito = Guid.Parse("019a0004-0000-7000-8000-000000000102");
    private const string Carlos = "019a0003-0000-7000-8000-000000000002";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    private static Task DebitoNaLojaAsync(AmbienteUi pdv)
    {
        var agora = DateTimeOffset.UtcNow;
        return pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [
                new FormaPagamentoRegistro
                {
                    Id = Debito, Descricao = "Cartão de débito", Ordem = 2, TipoForma = "cartao_debito", MeioPagamentoFiscal = "04",
                    Integracao = "pos_externo", CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
                new FormaPagamentoLojaRegistro { Id = Guid.CreateVersion7(), FormaPagamentoId = Debito, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
            ],
            Ct);
    }

    private static async Task LiberarAsync(AmbienteUi pdv, VendaViewModel venda, string motivo)
    {
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var dialogo = Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
        dialogo.Pedido.Usuario = "2";
        dialogo.Pedido.Pin = "4321";
        dialogo.Pedido.Motivo = motivo;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is not DialogoLiberacaoViewModel, "liberação concedida");
    }

    /// <summary>Gelo (12,90) pago com 5,00 no débito (maquininha) e o resto em dinheiro (20,00, troco de 12,10).</summary>
    private static async Task VenderDebitoEDinheiroAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        pdv.Tecla(Key.Down);
        pagamento.ValorRecebido = "5,00";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoBandeira");
        Assert.IsType<DialogoPosViewModel>(venda.Dialogo).Bandeira = "6";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoPagamentoViewModel, "volta ao pagamento");
        pagamento.EscolherFormaCommand.Execute("1");
        pagamento.ValorRecebido = "20,00";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
    }

    [AvaloniaFact]
    public async Task Venda_paga_cancelada_pelo_gerente_devolve_o_cartao_em_dinheiro_e_gera_a_forma_A()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await DebitoNaLojaAsync(pdv);
        await VenderDebitoEDinheiroAsync(pdv, venda);
        var caixa = pdv.Servicos.GetRequiredService<ServicoCaixa>();
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixa!;
        var repositorioCaixa = pdv.Servicos.GetRequiredService<RepositorioCaixa>();
        Assert.Equal(107.90m, await repositorioCaixa.DinheiroGavetaAsync(sessao.Id, Ct));
        // A devolução em dinheiro é movimento do caixa: com a gaveta ligada e "abre nos movimentos" (decisão 63), abre.
        await pdv.LigarGavetaAsync(nosMovimentos: true);
        var gaveta = pdv.Servicos.GetRequiredService<GavetaSimulada>();
        var aberturas = gaveta.Aberturas;

        // F12: a venda da sessão, a mais nova primeiro; Ctrl+Del abre o cancelamento.
        pdv.Tecla(Key.F12);
        await pdv.EsperarFocoAsync("CampoFiltroVendas");
        var lista = Assert.IsType<DialogoGestaoVendasViewModel>(venda.Dialogo);
        var linha = Assert.Single(lista.Linhas);
        Assert.Equal(("12,90", "Cartão de débito + Dinheiro"), (linha.Total, linha.Formas));
        pdv.Tecla(Key.Delete, RawInputModifiers.Control);
        await pdv.EsperarFocoAsync("CampoMotivoCancelamentoVenda");
        var cancelar = Assert.IsType<DialogoCancelarVendaFinalizadaViewModel>(venda.Dialogo);
        Assert.Equal(["Cancelar na maquininha (nada sai da gaveta)  [F3]", "Devolver o dinheiro (sai da gaveta)  [F3]"],
            cancelar.Pagamentos.Select(p => p.Descricao));
        Assert.Equal("Sai da gaveta: R$ 7,90", pdv.Texto("TextoDinheiroADevolver"));

        // O22: o operador escolhe devolver o débito em dinheiro (F3 no primeiro pagamento, o selecionado).
        pdv.Tecla(Key.F3);
        Assert.Equal("Sai da gaveta: R$ 12,90", pdv.Texto("TextoDinheiroADevolver"));
        pdv.Tecla(Key.F2);
        Assert.True(cancelar.Pagamentos[1].Selecionada);

        // O6: motivo livre de 15 a 255; sem a permissão (gerente ou encarregado), a liberação de quem a tem (CARLOS é Master).
        pdv.Digitar("desistiu");
        pdv.Tecla(Key.Enter);
        await AmbienteUi.Pausa();
        Assert.Contains("de 15 a 255 caracteres", cancelar.Erro);
        cancelar.Motivo = "Cliente desistiu depois de pagar";
        pdv.Tecla(Key.Enter);
        await LiberarAsync(pdv, venda, "Cliente desistiu");
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoGestaoVendasViewModel, "volta à lista");
        Assert.Contains("Devolva ao cliente R$ 12,90 em dinheiro.", lista.Aviso);
        Assert.Contains("liberação de CARLOS", lista.Aviso);
        Assert.Equal("CANCELADA: Cliente desistiu depois de pagar", Assert.Single(lista.Linhas).Situacao);
        Assert.Equal(aberturas + 1, gaveta.Aberturas);

        // A gaveta estimada sai do fundo + 7,90 para o fundo − 5,00 (o débito devolvido em dinheiro saiu dela).
        Assert.Equal(95.00m, await repositorioCaixa.DinheiroGavetaAsync(sessao.Id, Ct));
        await using var db = Banco(pdv);
        var gravada = await db.Vendas.Include(v => v.Pagamentos).SingleAsync(Ct);
        Assert.Equal((StatusVenda.Cancelada, (Guid?)Guid.Parse(Carlos), "Cliente desistiu depois de pagar"),
            (gravada.Status, gravada.CancelamentoAutorizadoPorId, gravada.MotivoCancelamento));
        Assert.All(gravada.Pagamentos, p => Assert.Equal(StatusPagamento.Estornado, p.Status));
        var estorno = Assert.Single(await db.MovimentosCaixa.Where(m => m.Tipo == TipoMovimentoCaixa.EstornoVenda).ToListAsync(Ct));
        Assert.Equal((12.90m, (Guid?)ServicoVenda.Dinheiro.Id, (Guid?)Guid.Parse(Carlos), sessao.Id),
            (estorno.Valor, estorno.FormaPagamentoId, estorno.AutorizadoPorId, estorno.SessaoCaixaId));

        var evento = await db.EventosSaida.SingleAsync(e => e.Tipo == "venda.cancelada", Ct);
        Assert.Equal(("venda", gravada.Id), (evento.AgregadoTipo, evento.AgregadoId));
        var payload = JsonNode.Parse(evento.Payload)!.AsObject();
        Assert.False(payload.ContainsKey("itens_venda"));
        Assert.Equal(["devolvido_em_dinheiro", "dinheiro_devolvido"],
            payload["pagamentos_venda"]!.AsArray().Select(p => p!["estorno"]!.GetValue<string>()).Order(StringComparer.Ordinal));
        Assert.Equal(sessao.Id.ToString(), payload["sessao_caixa_cancelamento_id"]!.GetValue<string>());
        var dependencias = JsonNode.Parse(evento.Dependencias)!.AsArray().Select(d => d!["agregado_tipo"]!.GetValue<string>()).ToList();
        Assert.Equal(["venda", "sessao_caixa"], dependencias);
        Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "liberacao" && l.Entidade == "vendas", Ct));

        // A cancelada não se reimprime nem se cancela de novo.
        pdv.Tecla(Key.R, RawInputModifiers.Control);
        Assert.Equal(ServicoVenda.MensagemReimpressaoCancelada, lista.Erro);
        pdv.Tecla(Key.Delete, RawInputModifiers.Control);
        await AmbienteUi.Pausa();
        Assert.Contains("já está cancelada", lista.Erro);

        // O fechamento conta o estorno uma vez: a linha Dinheiro é o fundo − o débito devolvido.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "lista fechada");
        var preparado = await caixa.PrepararFechamentoAsync(ct: Ct);
        var apuracao = Core.Caixa.ApuracaoCaixa.Calcular(preparado.Sessao.FundoTroco, preparado.Dados.Pagamentos, preparado.Dados.Movimentos,
            new Core.Caixa.FormaCaixa(ServicoVenda.Dinheiro.Id, "Dinheiro", "dinheiro"));
        Assert.Equal(95.00m, apuracao.Formas.Single(f => f.Forma.TipoForma == "dinheiro").Calculado);
        Assert.Equal(5.00m, apuracao.Formas.Single(f => f.Forma.Id == Debito).Calculado);
        Assert.Equal((0, 1), (preparado.Dados.Resumo.QtdVendas, preparado.Dados.Resumo.QtdCanceladas));
    }

    [AvaloniaFact]
    public async Task Encarregado_libera_o_cancelamento_da_venda_paga_do_caixa_aberto_e_o_supervisor_nao()
    {
        // Resposta do dono de 05/11/2026 (decisão 78): o Encarregado cancela a venda paga do caixa aberto; o Supervisor de
        // caixa, não. A de caixa fechado continua sem cancelamento no PDV para todos (D23; VendasCentralTelasTests).
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: AutenticadorComExtras.Registrar);
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");

        pdv.Tecla(Key.F12);
        await pdv.EsperarFocoAsync("CampoFiltroVendas");
        var lista = Assert.IsType<DialogoGestaoVendasViewModel>(venda.Dialogo);
        pdv.Tecla(Key.Delete, RawInputModifiers.Control);
        await pdv.EsperarFocoAsync("CampoMotivoCancelamentoVenda");
        var cancelar = Assert.IsType<DialogoCancelarVendaFinalizadaViewModel>(venda.Dialogo);
        cancelar.Motivo = "Cliente desistiu depois de pagar";
        pdv.Tecla(Key.Enter);

        // O SUPERVISOR (Supervisor de caixa) não tem a permissão: a liberação é negada e a venda continua paga.
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var liberacao = Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
        liberacao.Pedido.Usuario = "supervisor";
        liberacao.Pedido.Pin = AutenticadorComExtras.PinSupervisor;
        liberacao.Pedido.Motivo = "Cliente desistiu";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => liberacao.Pedido.Erro is not null, "liberação negada");
        Assert.Equal(Sync.Acesso.AutenticadorOffline.MensagemLiberadorSemPermissao, liberacao.Pedido.Erro);
        Assert.Same(liberacao, venda.Dialogo);

        // O ENCARREGADO libera: a venda é cancelada com ele como quem autorizou.
        liberacao.Pedido.Usuario = "encarregado";
        liberacao.Pedido.Pin = AutenticadorComExtras.PinEncarregado;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoGestaoVendasViewModel, "volta à lista");
        Assert.Contains("liberação de ENCARREGADO", lista.Aviso);
        Assert.Equal("CANCELADA: Cliente desistiu depois de pagar", Assert.Single(lista.Linhas).Situacao);
        await using var db = Banco(pdv);
        var gravada = await db.Vendas.SingleAsync(Ct);
        Assert.Equal((StatusVenda.Cancelada, (Guid?)AutenticadorComExtras.Encarregado.Id), (gravada.Status, gravada.CancelamentoAutorizadoPorId));
        string[] acoes = ["liberacao", "venda_cancelada"];
        var auditoria = await db.LogAuditoriaLocal.Where(l => l.RegistroId == gravada.Id && acoes.Contains(l.Acao)).ToListAsync(Ct);
        Assert.Equal(acoes, auditoria.Select(l => l.Acao).Order(StringComparer.Ordinal));
        Assert.All(auditoria, l => Assert.Equal(AutenticadorComExtras.Encarregado.Id, l.AutorizadoPorId));

        // O serviço confere de novo (sem confiar só na tela): a liberação do SUPERVISOR não cancela a venda paga.
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        var negada = await Assert.ThrowsAsync<RegraNegocioException>(() => servico.CancelarFinalizadaAsync(
            gravada.Id, "Cliente desistiu depois de pagar", liberacao: new LiberacaoConcedida(AutenticadorComExtras.SupervisorCaixa, "teste", DateTimeOffset.UtcNow)));
        Assert.Equal("SUPERVISOR não tem a permissão para cancelar venda paga (gerente ou encarregado).", negada.Message);
    }

    [AvaloniaFact]
    public async Task Cascos_trazidos_voltam_ao_cliente_e_o_gerente_cancela_sem_liberacao()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        // CARLOS (Master) tem a permissão: cancela sem pedir liberação.
        var venda = await pdv.AtivarDemonstracaoELogarAsync("2", "4321");
        await pdv.EntrarCodigoAsync("0600");
        await pdv.EsperarFocoAsync("CampoCascosTrazidos");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "cascos trazidos");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("10");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");

        // F11 › 5 "Cancelar última venda" vai direto ao cancelamento dela.
        pdv.Tecla(Key.F11);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoFuncoesViewModel, "funções");
        pdv.Tecla(Key.D5);
        await pdv.EsperarFocoAsync("CampoMotivoCancelamentoVenda");
        var cancelar = Assert.IsType<DialogoCancelarVendaFinalizadaViewModel>(venda.Dialogo);
        Assert.Equal(["Devolva ao cliente 1 casco(s) de GARRAFA 600ML RETORNÁVEL."], cancelar.Vazios);
        pdv.Digitar("Produto com defeito na embalagem");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoGestaoVendasViewModel, "volta à lista");
        var lista = (DialogoGestaoVendasViewModel)venda.Dialogo!;
        Assert.Contains("Devolva ao cliente R$ 9,90 em dinheiro.", lista.Aviso);
        Assert.Contains("Devolva ao cliente 1 casco(s) de GARRAFA 600ML RETORNÁVEL.", lista.Aviso);

        await using var db = Banco(pdv);
        var gravada = await db.Vendas.SingleAsync(Ct);
        Assert.Null(gravada.CancelamentoAutorizadoPorId);
        Assert.Equal(0, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "liberacao", Ct));
        Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "venda_cancelada" && l.RegistroId == gravada.Id, Ct));
    }

    [AvaloniaFact]
    public async Task Reimpressao_sai_com_a_marca_da_segunda_via_e_fica_na_auditoria()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
        var original = venda.UltimoCupom!;

        // F11 › 4 reimprime a última; o operador tem `pdv.documento.reimprimir` no perfil.
        pdv.Tecla(Key.F11);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoFuncoesViewModel, "funções");
        pdv.Tecla(Key.D4);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoGestaoVendasViewModel { Aviso: not null }, "reimpressa");
        Assert.StartsWith(LayoutComprovanteVenda.MarcaReimpressao, venda.UltimoCupom!.TrimStart());
        Assert.Contains(original.Trim(), venda.UltimoCupom);

        // O filtro pelo número: outro número não lista a venda.
        var lista = (DialogoGestaoVendasViewModel)venda.Dialogo!;
        lista.Filtro = "999";
        await lista.Atualizacao;
        Assert.Empty(lista.Linhas);
        lista.Filtro = "1";
        await lista.Atualizacao;
        Assert.Single(lista.Linhas);

        await using var db = Banco(pdv);
        var auditoria = await db.LogAuditoriaLocal.SingleAsync(l => l.Acao == "reimpressao", Ct);
        Assert.Contains("\"documento\":\"cupom\"", auditoria.Depois);
        Assert.Equal(1, await db.FilaImpressao.CountAsync(f => f.TipoDocumento == "cupom_reimpressao", Ct));
    }

    [AvaloniaFact]
    public async Task Shift_F4_pede_o_supervisor_e_o_motivo_livre_e_o_evento_leva_quem_liberou()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0044");

        // O6: a MARIA (perfil do operador) não tem `pdv.venda.cancelar_venda_aberta`: o supervisor libera antes do motivo.
        pdv.Tecla(Key.F4, RawInputModifiers.Shift);
        await LiberarAsync(pdv, venda, "Cliente desistiu");
        await pdv.EsperarFocoAsync("CampoMotivoCancelamento");
        var motivo = Assert.IsType<DialogoMotivoCancelamentoViewModel>(venda.Dialogo);
        pdv.Digitar("curto");
        pdv.Tecla(Key.Enter);
        await AmbienteUi.Pausa();
        Assert.Contains("de 15 a 255 caracteres", motivo.Erro);
        motivo.Motivo = "  Cliente desistiu antes de pagar  ";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda cancelada");
        Assert.Equal("Venda cancelada com liberação de CARLOS.", pdv.Texto("TextoMensagem"));

        await using var db = Banco(pdv);
        var evento = await db.EventosSaida.SingleAsync(e => e.Tipo == "venda.cancelada", Ct);
        var vendas = JsonNode.Parse(evento.Payload)!["vendas"]!;
        Assert.Equal(("Cliente desistiu antes de pagar", Carlos),
            (vendas["motivo_cancelamento"]!.GetValue<string>(), vendas["cancelamento_autorizado_por_id"]!.GetValue<string>()));
        Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "liberacao" && l.Entidade == "vendas", Ct));
    }

    [AvaloniaFact]
    public async Task Servico_recusa_cancelar_com_o_caixa_ocupado_na_d22_ou_a_venda_descartada_e_sem_a_permissao()
    {
        SincronizacaoComTrava? trava = null;
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<IServicoSincronizacao>(sp =>
            trava = new SincronizacaoComTrava(sp.GetRequiredService<GenesisPDV.Sync.Cliente.ServicoSincronizacaoHttp>())));
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        Guid paga;
        await using (var db = Banco(pdv))
        {
            paga = (await db.Vendas.SingleAsync(Ct)).Id;
        }

        var carlos = new LiberacaoConcedida(AutenticadorOperadorSimulado.Operadores.Single(o => o.Login == "carlos"), "Cliente desistiu", DateTimeOffset.UtcNow);
        async Task<string> RecusaAsync(Func<Task> acao) => (await Assert.ThrowsAsync<RegraNegocioException>(acao)).Message;

        // Caixa ocupado: a gestão de vendas exige o caixa livre (o estorno mexe na gaveta).
        await pdv.EntrarCodigoAsync("0044");
        Assert.True(servico.VendaAberta);
        Assert.Equal(ServicoVenda.MensagemCaixaLivreGestao, await RecusaAsync(() => servico.PrepararCancelamentoAsync(paga, Ct)));

        // O6 no serviço, sem confiar só na tela: a MARIA, sem `pdv.venda.cancelar_venda_aberta` e sem liberação, não
        // cancela a venda em andamento; com a liberação do CARLOS, cancela.
        Assert.Equal(ServicoCaixa.MensagemSemPermissao, await RecusaAsync(() => servico.CancelarVendaAsync("Cliente desistiu da compra", Ct)));
        Assert.True(servico.VendaAberta);
        await servico.CancelarVendaAsync("Cliente desistiu da compra", carlos, Ct);
        Assert.False(servico.VendaAberta);

        // D22: com o `desativando_confirmado` em voo, nada é gravado.
        Assert.NotNull(trava);
        trava!.Confirmando = true;
        Assert.Equal(ServicoCaixa.MensagemConfirmandoDesativacao, await RecusaAsync(() => servico.PrepararCancelamentoAsync(paga, Ct)));
        Assert.Equal(ServicoCaixa.MensagemConfirmandoDesativacao,
            await RecusaAsync(() => servico.CancelarFinalizadaAsync(paga, "Cliente desistiu depois de pagar", liberacao: carlos, ct: Ct)));
        trava.Confirmando = false;
        Assert.NotNull(await servico.PrepararCancelamentoAsync(paga, Ct));

        // O `venda.finalizada` descartado no ERP (fila de decisão): a nuvem não tem a venda, o caixa não a cancela.
        await using (var db = Banco(pdv))
        {
            await db.EventosSaida.Where(e => e.Tipo == "venda.finalizada" && e.AgregadoId == paga)
                .ExecuteUpdateAsync(e => e.SetProperty(x => x.Resultado, """{"descartado":true}"""), Ct);
        }

        Assert.Equal(Venda.MensagemCancelamentoDescartada, await RecusaAsync(() => servico.PrepararCancelamentoAsync(paga, Ct)));
        Assert.Equal(Venda.MensagemCancelamentoDescartada,
            await RecusaAsync(() => servico.CancelarFinalizadaAsync(paga, "Cliente desistiu depois de pagar", liberacao: carlos, ct: Ct)));

        await using (var db = Banco(pdv))
        {
            Assert.Equal(StatusVenda.Finalizada, (await db.Vendas.SingleAsync(v => v.Id == paga, Ct)).Status);
            Assert.Equal(0, await db.MovimentosCaixa.CountAsync(m => m.Tipo == TipoMovimentoCaixa.EstornoVenda, Ct));
            Assert.Equal(1, await db.EventosSaida.CountAsync(e => e.Tipo == "venda.cancelada", Ct));
        }
    }
}
