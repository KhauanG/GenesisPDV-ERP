using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;

namespace GenesisPDV.Core.Tests;

/// <summary>
/// Caixa no Core (Fase 1C, bloco C10a): apuração da gaveta e do calculado por forma (PDV 20.4, 21.2), fechamento cego
/// com a regra O3 do dono e com a conferência da especificação, sessão antiga (8.1) e contagem de cédulas (8.2).
/// </summary>
public class CaixaTests
{
    private static readonly FormaCaixa Dinheiro = new(Guid.Parse("019a0004-0000-7000-8000-000000000001"), "Dinheiro", "dinheiro");
    private static readonly FormaCaixa Pix = new(Guid.Parse("019a0004-0000-7000-8000-000000000002"), "PIX", "pix");
    private static readonly FormaCaixa Debito = new(Guid.Parse("019a0004-0000-7000-8000-000000000003"), "Débito", "cartao_debito");
    private static readonly FormaCaixa Vale = new(Guid.Parse("019a0004-0000-7000-8000-000000000004"), "Vale-alimentação", "vale_alimentacao");

    [Fact]
    public void Gaveta_soma_fundo_dinheiro_e_reforco_e_tira_sangria_estorno_troco_de_outra_forma_e_cancelado_nao_conta()
    {
        var apuracao = ApuracaoCaixa.Calcular(
            150m,
            [
                new PagamentoApurado(Dinheiro, 40m),
                new PagamentoApurado(Dinheiro, 12.90m),
                new PagamentoApurado(Pix, 30m),
                // Vale de R$ 50 numa compra de R$ 45: os R$ 5 de troco saem da gaveta (20.4).
                new PagamentoApurado(Vale, 45m, Troco: 5m),
            ],
            [
                new MovimentoApurado(TiposMovimento.Abertura, 150m),
                new MovimentoApurado(TiposMovimento.Reforco, 100m),
                new MovimentoApurado(TiposMovimento.Sangria, 200m),
                new MovimentoApurado(TiposMovimento.Sangria, 999m, Cancelado: true),
                new MovimentoApurado(TiposMovimento.EstornoVenda, 10m, Forma: Dinheiro),
                new MovimentoApurado(TiposMovimento.EstornoVenda, 30m, Forma: Pix),
            ],
            Dinheiro,
            [Dinheiro, Pix, Debito]);

        // 150 + 52,90 − 5 + 100 − 200 − 10 (a abertura é o próprio fundo, não conta de novo).
        Assert.Equal(87.90m, apuracao.DinheiroGaveta);
        Assert.Equal(
            [("Dinheiro", 87.90m, 2), ("PIX", 0m, 1), ("Vale-alimentação", 45m, 1), ("Débito", 0m, 0)],
            apuracao.Formas.Select(f => (f.Forma.Descricao, f.Calculado, f.QuantidadePagamentos)));
        Assert.Equal(132.90m, apuracao.TotalCalculado);
    }

    [Fact]
    public void Venda_do_turno_A_cancelada_no_turno_B_soma_em_A_e_subtrai_em_B_sem_dobrar()
    {
        // PDV 21.7: R$ 50 em dinheiro no turno A; o estorno em dinheiro fica no turno B, onde o dinheiro saiu.
        var turnoA = ApuracaoCaixa.Calcular(100m, [new PagamentoApurado(Dinheiro, 50m)], [], Dinheiro);
        var turnoB = ApuracaoCaixa.Calcular(150m, [], [new MovimentoApurado(TiposMovimento.EstornoVenda, 50m, Forma: Dinheiro)], Dinheiro);
        Assert.Equal(150m, turnoA.Formas[0].Calculado);
        Assert.Equal(100m, turnoB.Formas[0].Calculado);
        // Troca em dinheiro e resgate de vale reduzem o dinheiro calculado (devolucao_troca).
        Assert.Equal(80m, ApuracaoCaixa.Calcular(100m, [], [new MovimentoApurado(TiposMovimento.DevolucaoTroca, 20m)], Dinheiro).DinheiroGaveta);
    }

    private static ResultadoApuracao ApuracaoPadrao() =>
        ApuracaoCaixa.Calcular(150m, [new PagamentoApurado(Dinheiro, 62.90m), new PagamentoApurado(Pix, 30m)], [], Dinheiro, [Dinheiro, Pix]);

    [Fact]
    public void Regra_do_dono_o3_ninguem_ve_o_calculado_sem_conferencia_sem_recontagem_e_justificativa_opcional()
    {
        var regras = RegrasFechamento.PadraoDono;
        Assert.Equal((true, 0m, false, false, false), (regras.FechamentoCego, regras.Tolerancia, regras.PermiteRecontagem, regras.ImprimeCalculado, regras.MostraConferencia));
        // Nem o supervisor ou o gerente com a permissão veem o esperado no PDV (O3).
        var fechamento = new FechamentoCego(ApuracaoPadrao(), regras, podeVerCalculado: true);
        Assert.False(fechamento.CalculadoVisivel);
        Assert.False(fechamento.ImprimeCalculado);
        fechamento.Contar(new Dictionary<Guid, decimal> { [Dinheiro.Id] = 210m, [Pix.Id] = 30m });
        Assert.Equal(EtapaFechamento.Pronto, fechamento.Etapa);
        Assert.False(fechamento.PodeRecontar);
        // Diferença de R$ 2,90 no dinheiro: sem a conferência, a justificativa não é pedida (pedir revelaria a diferença).
        Assert.True(fechamento.DiferencaDinheiroAcimaDaTolerancia);
        Assert.False(fechamento.ExigeJustificativa);
        // Sem conferência, a contagem ainda pode ser corrigida antes de confirmar.
        fechamento.Contar(new Dictionary<Guid, decimal> { [Dinheiro.Id] = 211m, [Pix.Id] = 30m });
        var conferido = fechamento.Confirmar(zeraCaixa: true, justificativa: "   ");
        Assert.Equal((212.90m + 30m, 241m, (string?)null, false, true), (conferido.TotalCalculado, conferido.TotalDigitado, conferido.Justificativa,
            conferido.Recontagem, conferido.FechamentoCego));
        Assert.Equal((211m, 0m), (conferido.DinheiroDigitado, conferido.ValorCaixa));
        Assert.Equal([-1.90m, 0m], conferido.Formas.Select(f => f.Diferenca));
        Assert.All(conferido.Formas, f => Assert.Null(f.PrimeiraContagem));
    }

    [Fact]
    public void Com_a_conferencia_ligada_a_diferenca_exige_justificativa_e_a_recontagem_vale_uma_vez()
    {
        var regras = new RegrasFechamento(FechamentoCego: true, Tolerancia: 1m, PermiteRecontagem: true, MostraConferencia: true);
        Assert.False(new FechamentoCego(ApuracaoPadrao(), regras, podeVerCalculado: false).CalculadoVisivel);
        var fechamento = new FechamentoCego(ApuracaoPadrao(), regras, podeVerCalculado: true);
        Assert.True(fechamento.CalculadoVisivel);
        fechamento.Contar(new Dictionary<Guid, decimal> { [Dinheiro.Id] = 210m });
        Assert.Equal(EtapaFechamento.Conferencia, fechamento.Etapa);
        Assert.True(fechamento.ExigeJustificativa);
        Assert.Equal(FechamentoCego.MensagemJustificativa, Assert.Throws<RegraNegocioException>(() => fechamento.Confirmar(true, null)).Message);
        fechamento.Recontar();
        Assert.Equal(EtapaFechamento.Contagem, fechamento.Etapa);
        Assert.Throws<InvalidOperationException>(() => fechamento.Confirmar(true, null));
        // Dentro da tolerância de R$ 1,00 não pede justificativa; a primeira contagem fica registrada.
        fechamento.Contar(new Dictionary<Guid, decimal> { [Dinheiro.Id] = 212m, [Pix.Id] = 30m });
        Assert.False(fechamento.ExigeJustificativa);
        Assert.False(fechamento.PodeRecontar);
        Assert.Throws<RegraNegocioException>(fechamento.Recontar);
        var conferido = fechamento.Confirmar(zeraCaixa: false, null);
        Assert.True(conferido.Recontagem);
        Assert.Equal([210m, 0m], conferido.Formas.Select(f => f.PrimeiraContagem));
        Assert.Equal(212m, conferido.ValorCaixa);
        Assert.True(regras.ImprimeCalculadoNoRelatorio(temPermissao: true));
        Assert.False(regras.ImprimeCalculadoNoRelatorio(temPermissao: false));
    }

    [Fact]
    public void Fechamento_nao_cego_mostra_a_todos_e_valor_contado_invalido_e_recusado()
    {
        var fechamento = new FechamentoCego(ApuracaoPadrao(), new RegrasFechamento(FechamentoCego: false), podeVerCalculado: false);
        Assert.True(fechamento.CalculadoVisivel);
        Assert.True(fechamento.Regras.TemConferencia);
        Assert.Throws<RegraNegocioException>(() => fechamento.Contar(new Dictionary<Guid, decimal> { [Dinheiro.Id] = -1m }));
        Assert.Throws<RegraNegocioException>(() => fechamento.Contar(new Dictionary<Guid, decimal> { [Dinheiro.Id] = 1.005m }));
        // Ainda na contagem: não há o que confirmar.
        Assert.Throws<InvalidOperationException>(() => fechamento.Confirmar(true, null));
        fechamento.Contar(new Dictionary<Guid, decimal> { [Dinheiro.Id] = 212.90m, [Pix.Id] = 30m });
        Assert.Throws<RegraNegocioException>(() => fechamento.Confirmar(true, new string('x', 256)));
        Assert.Throws<ArgumentException>(() => new FechamentoCego(
            ApuracaoCaixa.Calcular(0m, [], [], Pix), RegrasFechamento.PadraoDono, podeVerCalculado: false));
    }

    [Fact]
    public void Confirmar_nao_muda_a_etapa_ate_a_gravacao_e_a_recusa_deixa_repetir_sem_recontar()
    {
        // Sem conferência (O3): a gravação recusada (venda aberta, D22) deixa a máquina pronta para o Enter seguinte.
        var cego = new FechamentoCego(ApuracaoPadrao(), RegrasFechamento.PadraoDono, podeVerCalculado: false);
        cego.Contar(new Dictionary<Guid, decimal> { [Dinheiro.Id] = 212.90m, [Pix.Id] = 30m });
        var primeira = cego.Confirmar(zeraCaixa: true, null);
        Assert.Equal(EtapaFechamento.Pronto, cego.Etapa);
        Assert.Equal(primeira.TotalDigitado, cego.Confirmar(zeraCaixa: true, null).TotalDigitado);
        cego.MarcarConfirmado();
        Assert.Equal(EtapaFechamento.Confirmado, cego.Etapa);
        Assert.Throws<InvalidOperationException>(() => cego.Contar(new Dictionary<Guid, decimal>()));
        Assert.Throws<InvalidOperationException>(() => cego.Confirmar(true, null));
        Assert.Throws<InvalidOperationException>(cego.MarcarConfirmado);

        // Com a conferência: continua na conferência (e a recontagem segue disponível).
        var conferencia = new FechamentoCego(ApuracaoPadrao(), new RegrasFechamento(PermiteRecontagem: true, MostraConferencia: true), false);
        Assert.Throws<InvalidOperationException>(conferencia.MarcarConfirmado);
        conferencia.Contar(new Dictionary<Guid, decimal> { [Dinheiro.Id] = 212.90m, [Pix.Id] = 30m });
        conferencia.Confirmar(zeraCaixa: false, null);
        Assert.Equal(EtapaFechamento.Conferencia, conferencia.Etapa);
        Assert.True(conferencia.PodeRecontar);
    }

    [Fact]
    public void Fundo_de_troco_e_diferenca_de_recebimento_da_troca_de_turno()
    {
        Assert.Equal(0m, RegrasSessaoCaixa.ValidarFundo(0m));
        Assert.Equal(99_999.99m, RegrasSessaoCaixa.ValidarFundo(99_999.99m));
        Assert.Throws<RegraNegocioException>(() => RegrasSessaoCaixa.ValidarFundo(100_000m));
        Assert.Throws<RegraNegocioException>(() => RegrasSessaoCaixa.ValidarFundo(-0.01m));
        Assert.Throws<RegraNegocioException>(() => RegrasSessaoCaixa.ValidarFundo(1.001m));
        Assert.Equal(-10m, RegrasSessaoCaixa.DiferencaRecebimento(90m, 100m));
        Assert.Null(RegrasSessaoCaixa.DiferencaRecebimento(90m, null));
    }

    [Fact]
    public void Sessao_antiga_alerta_e_so_bloqueia_a_de_dia_anterior_com_a_chave()
    {
        var fuso = DiaOperacional.ObterFuso("America/Sao_Paulo");
        var corte = new TimeOnly(5, 0);
        var abertaEm = new DateTimeOffset(2026, 10, 28, 11, 2, 0, TimeSpan.Zero); // 08:02 em Brasília
        var dia = DiaOperacional.Calcular(abertaEm, fuso, corte);
        Assert.Equal(SituacaoSessao.Normal, RegrasSessaoCaixa.Avaliar(abertaEm, dia, abertaEm.AddHours(10), fuso, corte, 24, true).Situacao);
        // 02:30 do dia seguinte ainda é o mesmo dia operacional (corte 05:00, D7).
        Assert.Equal(SituacaoSessao.Normal, RegrasSessaoCaixa.Avaliar(abertaEm, dia, abertaEm.AddHours(18.5), fuso, corte, 24, true).Situacao);
        var outroDia = RegrasSessaoCaixa.Avaliar(abertaEm, dia, abertaEm.AddHours(22), fuso, corte, 24, bloqueiaDiaAnterior: false);
        Assert.Equal((SituacaoSessao.Alerta, "Caixa aberto desde 28/10 08:02 — faça o fechamento."), (outroDia.Situacao, outroDia.Mensagem));
        Assert.Equal(SituacaoSessao.Bloqueada, RegrasSessaoCaixa.Avaliar(abertaEm, dia, abertaEm.AddHours(22), fuso, corte, 24, true).Situacao);
        // Mais de N horas no mesmo dia operacional: só o alerta.
        Assert.Equal(SituacaoSessao.Alerta, RegrasSessaoCaixa.Avaliar(abertaEm, dia, abertaEm.AddHours(3), fuso, corte, 2, true).Situacao);
    }

    [Fact]
    public void Contagem_de_cedulas_soma_e_recusa_o_que_nao_existe()
    {
        var contagem = ContagemCedulas.Normalizar(new Dictionary<decimal, int> { [100m] = 1, [50m] = 0, [0.05m] = 3, [20m] = 2 });
        Assert.Equal([100m, 20m, 0.05m], contagem.Keys);
        Assert.Equal(140.15m, ContagemCedulas.Somar(contagem));
        Assert.Throws<RegraNegocioException>(() => ContagemCedulas.Normalizar(new Dictionary<decimal, int> { [3m] = 1 }));
        Assert.Throws<RegraNegocioException>(() => ContagemCedulas.Normalizar(new Dictionary<decimal, int> { [10m] = -1 }));
    }
}
