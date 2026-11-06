using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Hardware.Gaveta;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// F11 do caixa pelo teclado (Fase 1C, bloco C10b; PDV 20, 21.6, 30.2, 10.12), no terminal de demonstração: sangria com
/// quem retira e 2 vias, reforço, F12 Movimentos com o cancelamento liberado pelo supervisor (O5 do dono), o limite de
/// gaveta com as faixas e a liberação de uma venda (só para aquele bloqueio e operador), a sangria recusada na auditoria,
/// o resumo diário sem os valores do esperado no fechamento cego (O3), o status detalhado do sync e a devolução avulsa de
/// cascos.
/// </summary>
public class MovimentosCaixaTelasTests
{
    private static readonly Guid Maria = Guid.Parse("019a0003-0000-7000-8000-000000000001");
    private static readonly Guid Carlos = Guid.Parse("019a0003-0000-7000-8000-000000000002");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    private static async Task ConfigurarAsync(AmbienteUi pdv, params (string Chave, string ValorJson)[] chaves)
    {
        var agora = DateTimeOffset.UtcNow;
        await pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [.. chaves.Select(c => (LinhaEspelho)new ConfiguracaoRegistro
            {
                Id = Guid.CreateVersion7(), Escopo = "loja", LojaId = CatalogoDemonstracao.LojaDemonstracao, Chave = c.Chave, Valor = c.ValorJson,
                CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
            })],
            Ct);
    }

    private static async Task<T> FuncaoAsync<T>(AmbienteUi pdv, VendaViewModel venda, Key tecla) where T : DialogoViewModel
    {
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(tecla);
        await pdv.EsperarAsync(() => venda.Dialogo is T, typeof(T).Name);
        return (T)venda.Dialogo!;
    }

    /// <summary>Uma venda de "GELO ESCAMA 5KG" (R$ 12,90) paga em dinheiro pelo teclado.</summary>
    private static async Task VenderGeloAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        await pdv.EntrarCodigoAsync("0044");
        Assert.False(venda.CaixaLivre);
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
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

    [AvaloniaFact]
    public async Task Sangria_e_reforco_pelo_f11_com_quem_retira_duas_vias_e_o_cancelamento_liberado_pelo_supervisor()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "200");
        // Gaveta ligada e "abre nos movimentos" (decisão 63): a sangria abre a gaveta.
        await pdv.LigarGavetaAsync(nosMovimentos: true);
        var gaveta = pdv.Servicos.GetRequiredService<GavetaSimulada>();
        var aberturas = gaveta.Aberturas;

        var sangria = await FuncaoAsync<DialogoMovimentoCaixaViewModel>(pdv, venda, Key.D1);
        await pdv.EsperarFocoAsync("CampoValorMovimento");
        // O3 do dono: no fechamento cego, nem a sangria mostra o dinheiro estimado.
        Assert.Null(sangria.EstimadoTexto);
        Assert.False(pdv.Controle<Avalonia.Controls.TextBlock>("TextoEstimadoGaveta").IsVisible);

        // Sem quem retira não grava; acima do estimado (R$ 200,00) também não (O5: limitada ao saldo).
        pdv.Digitar("150");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => sangria.Erro is not null);
        Assert.Equal(RegrasMovimentoCaixa.MensagemQuemRetira, pdv.Texto("TextoErroMovimento"));
        sangria.Valor = "200,01";
        sangria.QuemRetira = "Gerente";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => sangria.Erro?.StartsWith("Valor acima do dinheiro estimado", StringComparison.Ordinal) == true);
        Assert.DoesNotContain("R$", sangria.Erro, StringComparison.Ordinal);
        // A recusa conta ao operador que o valor passou do esperado: fica na auditoria (sobe no lote; o gerente vê no ERP).
        await using (var db = Banco(pdv))
        {
            var recusa = await db.LogAuditoriaLocal.SingleAsync(l => l.Acao == ServicoCaixa.AcaoSangriaRecusada, Ct);
            Assert.Equal((Maria, pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixaId), (recusa.UsuarioId!.Value, recusa.SessaoCaixaId));
            Assert.Equal("{\"valor_tentado\":\"200.01\",\"dinheiro_estimado\":\"200.00\"}", recusa.Depois);
            Assert.Equal(0, await db.MovimentosCaixa.CountAsync(m => m.Tipo == TipoMovimentoCaixa.Sangria, Ct));
        }

        // F2: quem retira pelo usuário (no terminal de demonstração, os operadores simulados).
        sangria.Valor = "150";
        sangria.QuemRetira = string.Empty;
        pdv.Tecla(Key.F2);
        await pdv.EsperarFocoAsync("CampoBuscaUsuario");
        var busca = Assert.IsType<DialogoBuscaUsuarioViewModel>(venda.Dialogo);
        pdv.Digitar("car");
        await pdv.EsperarAsync(() => busca.Selecionado?.Nome == "CARLOS", "CARLOS na busca");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo == sangria, "volta à sangria");
        Assert.Equal(("CARLOS", Carlos), (sangria.QuemRetira, sangria.QuemRetiraUsuarioId));
        sangria.Observacao = "Depósito banco";
        sangria.InfAdicionais = "Malote 4471";
        pdv.Captura("30-sangria");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "sangria gravada");
        Assert.Equal("Sangria de R$ 150,00 registrado(a).", pdv.Texto("TextoMensagem"));
        Assert.Contains("1ª VIA - CAIXA", venda.UltimoCupom, StringComparison.Ordinal);
        Assert.Contains("2ª VIA - QUEM RETIRA", venda.UltimoCupom, StringComparison.Ordinal);
        Assert.Contains("Quem retira: CARLOS", venda.UltimoCupom, StringComparison.Ordinal);
        Assert.Equal(aberturas + 1, gaveta.Aberturas);

        // Reforço: quem entrega é opcional; 1 via.
        var reforco = await FuncaoAsync<DialogoMovimentoCaixaViewModel>(pdv, venda, Key.D2);
        await pdv.EsperarFocoAsync("CampoValorMovimento");
        Assert.False(reforco.EhSangria);
        pdv.Digitar("30");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "reforço gravado");
        Assert.DoesNotContain("VIA", venda.UltimoCupom, StringComparison.Ordinal);

        await using (var db = Banco(pdv))
        {
            var movimento = await db.MovimentosCaixa.SingleAsync(m => m.Tipo == TipoMovimentoCaixa.Sangria, Ct);
            Assert.Equal((150m, Carlos, "CARLOS", "Depósito banco", "Malote 4471", (Guid?)null),
                (movimento.Valor, movimento.QuemRetiraUsuarioId!.Value, movimento.QuemRetiraNome, movimento.Observacao, movimento.InfAdicionais, movimento.AutorizadoPorId));
            Assert.Equal(1, await db.EventosSaida.CountAsync(e => e.Tipo == "caixa.sangria" && e.AgregadoId == movimento.Id, Ct));
            Assert.Equal(1, await db.EventosSaida.CountAsync(e => e.Tipo == "caixa.reforco", Ct));
            Assert.Equal(2, await db.FilaImpressao.Where(f => f.TipoDocumento == "sangria").Select(f => f.Vias).SingleAsync(Ct));
        }

        // F12 Movimentos (a partir da sangria): Ctrl+Del na sangria pede o motivo e, sem a permissão (O5), o supervisor.
        await FuncaoAsync<DialogoMovimentoCaixaViewModel>(pdv, venda, Key.D1);
        await pdv.EsperarFocoAsync("CampoValorMovimento");
        pdv.Tecla(Key.F12);
        await pdv.EsperarFocoAsync("DialogoMovimentos");
        var lista = Assert.IsType<DialogoMovimentosViewModel>(venda.Dialogo);
        Assert.Equal(["Abertura", "Sangria", "Reforço"], lista.Linhas.Select(l => l.TipoTexto));
        Assert.Equal("Reforço", lista.Selecionada!.TipoTexto);
        pdv.Tecla(Key.Up);
        pdv.Tecla(Key.Up);
        Assert.Equal("Abertura", lista.Selecionada!.TipoTexto);
        pdv.Tecla(Key.Delete, RawInputModifiers.Control);
        await AmbienteUi.Pausa();
        Assert.Equal(RepositorioCaixa.MensagemMovimentoNaoCancelavel, lista.Erro);
        pdv.Tecla(Key.Down);
        pdv.Tecla(Key.Delete, RawInputModifiers.Control);
        await pdv.EsperarFocoAsync("CampoMotivoCancelamentoMovimento");
        var motivo = Assert.IsType<DialogoCancelarMovimentoViewModel>(venda.Dialogo);
        pdv.Tecla(Key.Enter);
        await AmbienteUi.Pausa();
        Assert.Equal(RegrasMovimentoCaixa.MensagemMotivo, pdv.Texto("TextoErroCancelarMovimento"));
        pdv.Digitar("Valor digitado errado");
        pdv.Tecla(Key.Enter);
        await LiberarAsync(pdv, venda, "Conferido com o gerente");
        await pdv.EsperarAsync(() => venda.Dialogo == lista, "volta à lista");
        Assert.StartsWith("Sangria das ", lista.Aviso, StringComparison.Ordinal);
        Assert.Contains("CANCELADO: Valor digitado errado", lista.Linhas[1].Situacao, StringComparison.Ordinal);
        pdv.Captura("31-movimentos");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoMovimentoCaixaViewModel, "volta à sangria");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "fecha a sangria");

        await using (var db = Banco(pdv))
        {
            var cancelada = await db.MovimentosCaixa.SingleAsync(m => m.Tipo == TipoMovimentoCaixa.Sangria, Ct);
            Assert.Equal((true, Maria, Carlos, "Valor digitado errado"),
                (cancelada.Cancelado, cancelada.CanceladoPorId!.Value, cancelada.AutorizadoCancelamentoPorId!.Value, cancelada.MotivoCancelamento));
            Assert.Equal(1, await db.EventosSaida.CountAsync(e => e.Tipo == "caixa.movimento_cancelado" && e.AgregadoId == cancelada.Id, Ct));
            var auditoria = await db.LogAuditoriaLocal.SingleAsync(l => l.Acao == "liberacao", Ct);
            Assert.Equal(("movimentos_caixa", cancelada.Id, Carlos, "Conferido com o gerente"),
                (auditoria.Entidade, auditoria.RegistroId!.Value, auditoria.AutorizadoPorId!.Value, auditoria.Motivo));
        }

        // A sangria cancelada não conta: 200 + 30.
        var caixa = pdv.Servicos.GetRequiredService<ServicoCaixa>();
        Assert.Equal(230m, (await caixa.PrepararMovimentoAsync(TipoMovimentoCaixa.Sangria, Ct)).DinheiroEstimado);

        // Com venda em andamento, a sangria espera o caixa livre (os cascos não: o F11 › V abre com a venda, C11c).
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.D1);
        await pdv.EsperarAsync(() => venda.Dialogo is null);
        Assert.Equal(VendaViewModel.MensagemCaixaLivre, pdv.Texto("TextoMensagem"));
    }

    [AvaloniaFact]
    public async Task Limite_de_gaveta_mostra_as_faixas_bloqueia_a_venda_nova_e_o_supervisor_libera_uma_venda()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "85");
        // O5 do dono deixa sem limite; a loja que ligar a chave tem as faixas da 20.4.
        await ConfigurarAsync(pdv, (ChavesConfiguracao.ValorLimiteSangria, "\"100.00\""));
        Assert.Null(venda.AlertaGavetaAmbar);

        // 85 + 12,90 = 97,90: âmbar (≥ 80%), sem o valor (O3).
        await VenderGeloAsync(pdv, venda);
        await pdv.EsperarAsync(() => venda.AlertaGavetaAmbar is not null, "faixa âmbar");
        Assert.DoesNotContain("R$", pdv.Texto("TextoAlertaGaveta"), StringComparison.Ordinal);

        // 110,80: vermelha; a venda nova não começa e oferece a liberação.
        await VenderGeloAsync(pdv, venda);
        await pdv.EsperarAsync(() => venda.AlertaGavetaVermelho is not null, "faixa vermelha");
        Assert.True(pdv.Controle<Avalonia.Controls.TextBlock>("TextoBloqueioGaveta").IsVisible);
        pdv.Captura("32-limite-gaveta");
        await pdv.EntrarCodigoAsync("0044");
        Assert.True(venda.CaixaLivre);
        Assert.Equal(LimiteGaveta.MensagemBloqueioVenda, pdv.Texto("TextoMensagem"));
        await LiberarAsync(pdv, venda, "Fila grande no caixa");
        await pdv.EsperarFocoAsync("CampoCodigo");
        Assert.Contains("liberada acima do limite de gaveta por CARLOS", pdv.Texto("TextoMensagem"), StringComparison.Ordinal);
        await VenderGeloAsync(pdv, venda);

        // A liberação vale uma venda: a seguinte é recusada de novo (Esc desiste do pedido).
        await pdv.EntrarCodigoAsync("0044");
        Assert.True(venda.CaixaLivre);
        await pdv.EsperarFocoAsync("CampoSupervisor");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null);

        // A sangria leva abaixo do limite (123,70 − 50 = 73,70): a faixa some e a venda volta.
        var sangria = await FuncaoAsync<DialogoMovimentoCaixaViewModel>(pdv, venda, Key.D1);
        await pdv.EsperarFocoAsync("CampoValorMovimento");
        sangria.Valor = "50";
        sangria.QuemRetira = "Gerente";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "sangria gravada");
        await pdv.EsperarAsync(() => venda.AlertaGavetaVermelho is null && venda.AlertaGavetaAmbar is null, "sem faixa");
        await pdv.EntrarCodigoAsync("0044");
        Assert.False(venda.CaixaLivre);

        await using var db = Banco(pdv);
        var auditoria = await db.LogAuditoriaLocal.SingleAsync(l => l.Acao == "liberacao", Ct);
        Assert.Equal(("sessoes_caixa", Carlos, "Fila grande no caixa"), (auditoria.Entidade, auditoria.AutorizadoPorId!.Value, auditoria.Motivo));
    }

    [AvaloniaFact]
    public async Task Resumo_diario_sai_sem_os_valores_no_fechamento_cego_mesmo_depois_de_fechar_e_com_eles_sem_o_cego()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "50");
        await VenderGeloAsync(pdv, venda);
        DateOnly diaDaVenda;
        await using (var db = Banco(pdv))
        {
            // O dia operacional da venda (não o do relógio na hora do resumo: o teste não depende de cruzar as 05:00).
            diaDaVenda = (await db.Vendas.SingleAsync(v => v.Status == "finalizada", Ct)).DiaOperacional!.Value;
        }

        var resumo = await FuncaoAsync<DialogoResumoDiarioViewModel>(pdv, venda, Key.D6);
        await pdv.EsperarFocoAsync("CampoResumoDe");
        Assert.True(resumo.PorDias);
        resumo.De = resumo.Ate = diaDaVenda.ToString("dd/MM/yyyy", System.Globalization.CultureInfo.InvariantCulture);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => resumo.Texto is not null, "resumo mostrado");
        // O3: só as quantidades (os valores de vendas, sangrias e reforços compõem o esperado do fechamento cego).
        Assert.Contains("RESUMO DIÁRIO", resumo.Texto, StringComparison.Ordinal);
        // A linha longa quebra na palavra (I4): no papel e na tela, em mais de uma linha.
        Assert.Contains(LayoutsCaixa.MensagemValoresOcultos, resumo.Texto!.Replace('\n', ' '), StringComparison.Ordinal);
        Assert.Contains("Dinheiro (1)", resumo.Texto, StringComparison.Ordinal);
        Assert.DoesNotContain("12,90", resumo.Texto, StringComparison.Ordinal);
        Assert.DoesNotContain("Ticket médio", resumo.Texto, StringComparison.Ordinal);
        resumo.De = "31/02/2026";
        pdv.Tecla(Key.Enter);
        await AmbienteUi.Pausa();
        Assert.StartsWith("Data inválida", pdv.Texto("TextoErroResumo"), StringComparison.Ordinal);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null);

        // Depois de fechar (cego) e abrir a sessão seguinte, a sessão fechada também sai sem os valores: com o fundo, as
        // vendas por forma dela dariam o esperado e a diferença que só o gerente vê, no ERP.
        var caixa = pdv.Servicos.GetRequiredService<ServicoCaixa>();
        var preparado = await caixa.PrepararFechamentoAsync(ct: Ct);
        preparado.Fechamento.Contar(new Dictionary<Guid, decimal> { [preparado.Fechamento.Formas[0].Forma.Id] = 60m });
        await caixa.FecharAsync(preparado, preparado.Fechamento.Confirmar(zeraCaixa: true, null), null, sair: false, Ct);
        await caixa.AbrirAsync(50m, null, null, null, null, ct: Ct);
        var (fuso, corte, _) = caixa.DiaOperacionalAtual();
        var periodo = PeriodoResumo.PorDias(diaDaVenda, diaDaVenda, fuso, corte);
        var fechada = await caixa.ResumoDiarioAsync(periodo, imprimir: false, ct: Ct);
        Assert.Equal((1, 0m, true), (fechada.Resumo.QtdVendas, fechada.Resumo.TotalVendas, fechada.Resumo.ValoresOcultos));
        Assert.DoesNotContain("12,90", fechada.Texto, StringComparison.Ordinal);

        // Sem o fechamento cego (a loja que decidir assim), os valores aparecem; Ctrl+P imprime.
        await ConfigurarAsync(pdv, (ChavesConfiguracao.FechamentoCego, "false"), (ChavesConfiguracao.ResumoDiarioModo, "\"horario\""));
        resumo = await FuncaoAsync<DialogoResumoDiarioViewModel>(pdv, venda, Key.D6);
        await pdv.EsperarFocoAsync("CampoResumoDe");
        Assert.True(resumo.PorHorario);
        // O dia operacional inteiro da venda (corte 05:00): das 05:00 às 04:59 da madrugada seguinte.
        resumo.De = diaDaVenda.ToString("dd/MM/yyyy", System.Globalization.CultureInfo.InvariantCulture);
        resumo.Das = "05:00";
        resumo.As = "04:59";
        pdv.Tecla(Key.P, RawInputModifiers.Control);
        await pdv.EsperarAsync(() => resumo.Texto is not null, "resumo impresso");
        Assert.DoesNotContain(LayoutsCaixa.MensagemValoresOcultos, resumo.Texto, StringComparison.Ordinal);
        Assert.Contains("Dinheiro (1)", resumo.Texto, StringComparison.Ordinal);
        Assert.Contains("12,90", resumo.Texto, StringComparison.Ordinal);
        Assert.Equal("Resumo enviado à impressora.", resumo.Aviso);
        pdv.Captura("33-resumo-diario");
        await using (var db = Banco(pdv))
        {
            Assert.Equal(1, await db.FilaImpressao.CountAsync(f => f.TipoDocumento == "resumo_diario", Ct));
        }

        // Liberado pelo supervisor (31.3): a auditoria `liberacao` uma vez por liberação, mesmo com várias consultas e
        // impressões no mesmo diálogo; cada novo pedido ao supervisor é outra.
        var supervisor = new Operador(Carlos, 2, "carlos", "CARLOS", 100m, Master: true);
        var liberacao = new LiberacaoConcedida(supervisor, "Conferência do turno", DateTimeOffset.UtcNow);
        await caixa.ResumoDiarioAsync(periodo, imprimir: false, liberacao, ct: Ct);
        await caixa.ResumoDiarioAsync(periodo, imprimir: true, liberacao, ct: Ct);
        await caixa.ResumoDiarioAsync(periodo, imprimir: false, new LiberacaoConcedida(supervisor, "Outra conferência", DateTimeOffset.UtcNow), ct: Ct);
        await using (var db = Banco(pdv))
        {
            var auditorias = await db.LogAuditoriaLocal.Where(l => l.Acao == "liberacao").OrderBy(l => l.OcorridoEm).ToListAsync(Ct);
            Assert.Equal(["Conferência do turno", "Outra conferência"], auditorias.Select(l => l.Motivo));
            Assert.All(auditorias, l => Assert.Equal((Carlos, (Guid?)pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixaId),
                (l.AutorizadoPorId!.Value, l.SessaoCaixaId)));
            Assert.StartsWith("Resumo diário (Dia operacional ", auditorias[0].Descricao, StringComparison.Ordinal);
        }
    }

    [AvaloniaFact]
    public async Task Limite_de_gaveta_deixa_a_venda_em_andamento_terminar_e_a_liberacao_vale_so_para_aquele_bloqueio_e_operador()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "85");

        // 20.5: o limite atingido durante a venda (aqui a loja baixa a chave no meio dela) não a barra: ela termina.
        await pdv.EntrarCodigoAsync("0044");
        Assert.False(venda.CaixaLivre);
        await ConfigurarAsync(pdv, (ChavesConfiguracao.ValorLimiteSangria, "\"50.00\""));
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("30");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada no vermelho");
        await pdv.EsperarAsync(() => venda.AlertaGavetaVermelho is not null, "faixa vermelha");

        var caixa = pdv.Servicos.GetRequiredService<ServicoCaixa>();
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>();
        var maria = sessao.Operador!;
        var supervisor = new Operador(Carlos, 2, "carlos", "CARLOS", 100m, Master: true);
        LiberacaoConcedida Liberacao() => new(supervisor, "Fila grande no caixa", DateTimeOffset.UtcNow);
        await Assert.ThrowsAsync<LimiteGavetaAtingidoException>(() => caixa.GarantirLimiteParaNovaVendaAsync(Ct));

        // A liberação não usada não atravessa a sangria: fora do vermelho ela cai, e a volta ao limite pede outra.
        await caixa.LiberarLimiteGavetaAsync(Liberacao(), Ct);
        await caixa.RegistrarMovimentoAsync(new DadosMovimentoCaixa(TipoMovimentoCaixa.Sangria, 100m, null, "Gerente", null, null), null, Ct);
        Assert.Equal(FaixaGaveta.Normal, caixa.Gaveta.Faixa);
        await caixa.RegistrarMovimentoAsync(new DadosMovimentoCaixa(TipoMovimentoCaixa.Reforco, 100m, null, null, null, null), null, Ct);
        Assert.Equal(FaixaGaveta.Bloqueio, caixa.Gaveta.Faixa);
        await Assert.ThrowsAsync<LimiteGavetaAtingidoException>(() => caixa.GarantirLimiteParaNovaVendaAsync(Ct));

        // É do operador que a pediu: outro operador na mesma sessão não a usa; o próprio, sim (uma vez).
        await caixa.LiberarLimiteGavetaAsync(Liberacao(), Ct);
        sessao.Operador = new Operador(Guid.CreateVersion7(), 3, "joao", "JOAO", 10m, Permissoes: PermissoesPdv.PerfilOperador);
        await Assert.ThrowsAsync<LimiteGavetaAtingidoException>(() => caixa.GarantirLimiteParaNovaVendaAsync(Ct));
        sessao.Operador = maria;
        await caixa.GarantirLimiteParaNovaVendaAsync(Ct);
        await Assert.ThrowsAsync<LimiteGavetaAtingidoException>(() => caixa.GarantirLimiteParaNovaVendaAsync(Ct));

        // O login seguinte (mesmo operador de novo) descarta a liberação guardada.
        await caixa.LiberarLimiteGavetaAsync(Liberacao(), Ct);
        await caixa.AposLoginAsync(Ct);
        await Assert.ThrowsAsync<LimiteGavetaAtingidoException>(() => caixa.GarantirLimiteParaNovaVendaAsync(Ct));

        // Quem tem pdv.caixa.ignorar_limite_sangria (o supervisor logado) não é bloqueado.
        sessao.Operador = supervisor;
        await caixa.GarantirLimiteParaNovaVendaAsync(Ct);
        await caixa.GarantirLimiteParaNovaVendaAsync(Ct);
        sessao.Operador = maria;
    }

    [AvaloniaFact]
    public async Task Sangria_acima_do_estimado_com_a_chave_desligada_passa_com_aviso_e_nome_longo_do_usuario_e_cortado()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await ConfigurarAsync(pdv, (ChavesConfiguracao.SangriaLimitadaAoSaldo, "false"));

        var sangria = await FuncaoAsync<DialogoMovimentoCaixaViewModel>(pdv, venda, Key.D1);
        await pdv.EsperarFocoAsync("CampoValorMovimento");
        // O usuário do F2 com nome acima dos 60 do quem_retira_nome (o cadastro aceita até 100): grava cortado, com o id.
        var longo = "MARIA APARECIDA DOS SANTOS OLIVEIRA PEREIRA DA SILVA GOMES LIMA";
        sangria.DefinirUsuario(new UsuarioRetirada(Carlos, 2, longo));
        sangria.Valor = "150";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "sangria gravada com aviso");
        Assert.Contains("Sangria acima do dinheiro estimado na gaveta.", pdv.Texto("TextoMensagem"), StringComparison.Ordinal);

        await using var db = Banco(pdv);
        var movimento = await db.MovimentosCaixa.SingleAsync(m => m.Tipo == TipoMovimentoCaixa.Sangria, Ct);
        Assert.Equal((150m, Carlos, longo[..60].TrimEnd()), (movimento.Valor, movimento.QuemRetiraUsuarioId!.Value, movimento.QuemRetiraNome));
        Assert.Equal(0, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == ServicoCaixa.AcaoSangriaRecusada, Ct));
    }

    [AvaloniaFact]
    public async Task Status_do_sync_e_devolucao_avulsa_de_cascos_pelo_f11()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();

        var status = await FuncaoAsync<DialogoStatusSyncViewModel>(pdv, venda, Key.S);
        await pdv.EsperarFocoAsync("DialogoStatusSync");
        Assert.Contains(status.Linhas, l => l.Contains("Demonstração (sem nuvem)", StringComparison.Ordinal));
        Assert.Contains(status.Linhas, l => l.StartsWith("Pendentes de envio:", StringComparison.Ordinal));
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => status.Erro is not null);
        pdv.Captura("34-status-sync");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null);

        var cascos = await FuncaoAsync<DialogoVasilhamesViewModel>(pdv, venda, Key.V);
        await pdv.EsperarFocoAsync("CampoQuantidadeCascos");
        Assert.Equal("GARRAFA 600ML RETORNÁVEL", Assert.Single(cascos.Cascos).Nome);
        cascos.Quantidade = "1,5";
        pdv.Tecla(Key.Enter);
        await AmbienteUi.Pausa();
        Assert.Equal(ServicoCaixa.MensagemQuantidadeCascos, pdv.Texto("TextoErroVasilhames"));
        cascos.Quantidade = "3";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "devolução registrada");
        Assert.Equal("Devolução de 3 casco(s) GARRAFA 600ML RETORNÁVEL registrada.", pdv.Texto("TextoMensagem"));

        await using var db = Banco(pdv);
        var movimento = await db.MovimentosVasilhame.SingleAsync(Ct);
        Assert.Equal((3m, "entrada", Maria), (movimento.Quantidade, movimento.Destino, movimento.OperadorId));
        Assert.Equal(pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixaId, movimento.SessaoCaixaId);
        Assert.Equal(1, await db.EventosSaida.CountAsync(e => e.Tipo == "vasilhame.movimentado" && e.AgregadoId == movimento.Id, Ct));
    }
}
