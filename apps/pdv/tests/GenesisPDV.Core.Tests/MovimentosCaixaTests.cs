using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;

namespace GenesisPDV.Core.Tests;

/// <summary>
/// Movimentos do caixa no Core (Fase 1C, bloco C10b): limite de gaveta com as faixas da PDV 20.4, os campos da sangria e
/// do reforço (20.1–20.3, O5 do dono) e o resumo diário (21.6) com o período por dias ou por horário e a sessão aberta
/// fora dele no fechamento cego (O3).
/// </summary>
public class MovimentosCaixaTests
{
    private static readonly FormaCaixa Dinheiro = new(Guid.Parse("019a0004-0000-7000-8000-000000000001"), "Dinheiro", "dinheiro");
    private static readonly FormaCaixa Pix = new(Guid.Parse("019a0004-0000-7000-8000-000000000002"), "PIX", "pix");
    private static readonly FormaCaixa Debito = new(Guid.Parse("019a0004-0000-7000-8000-000000000003"), "Débito", "cartao_debito");
    private static readonly TimeZoneInfo Fuso = DiaOperacional.ObterFuso(null);
    private static readonly TimeOnly Corte = new(5, 0);

    private static DateTimeOffset Utc(string iso) => DateTimeOffset.Parse(iso, System.Globalization.CultureInfo.InvariantCulture);

    [Theory]
    [InlineData(null)]
    [InlineData("0")]
    public void Sem_limite_a_faixa_e_sempre_normal(string? limite)
    {
        // O5 do dono: `pdv.valor_limite_sangria` nulo no piloto; o caixa nunca obriga sangria.
        var l = limite is null ? (decimal?)null : decimal.Parse(limite, System.Globalization.CultureInfo.InvariantCulture);
        Assert.Equal(AvaliacaoGaveta.Normal, LimiteGaveta.Avaliar(1_000_000m, l, mostraValor: true));
    }

    [Fact]
    public void Ambar_a_partir_de_80_por_cento_e_vermelha_no_limite_sem_mostrar_o_valor_no_fechamento_cego()
    {
        Assert.Equal(FaixaGaveta.Normal, LimiteGaveta.Avaliar(799.99m, 1000m, mostraValor: false).Faixa);
        var alerta = LimiteGaveta.Avaliar(800m, 1000m, mostraValor: false);
        Assert.Equal(FaixaGaveta.Alerta, alerta.Faixa);
        Assert.DoesNotContain("R$", alerta.Mensagem, StringComparison.Ordinal);
        Assert.Contains("F11 › 1", alerta.Mensagem, StringComparison.Ordinal);

        var bloqueio = LimiteGaveta.Avaliar(1000m, 1000m, mostraValor: false);
        Assert.Equal(FaixaGaveta.Bloqueio, bloqueio.Faixa);
        Assert.StartsWith("LIMITE DE DINHEIRO ATINGIDO —", bloqueio.Mensagem, StringComparison.Ordinal);

        // Com a conferência ligada (quem pode ver o esperado), a faixa traz o valor.
        Assert.Contains("R$ 1.284,50", LimiteGaveta.Avaliar(1284.50m, 1000m, mostraValor: true).Mensagem, StringComparison.Ordinal);
        Assert.Contains("R$ 850,00", LimiteGaveta.Avaliar(850m, 1000m, mostraValor: true).Mensagem, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("10.001")]
    [InlineData("100000")]
    public void Valor_do_movimento_e_maior_que_zero_em_centavos_e_ate_o_maximo(string? valor)
    {
        var v = valor is null ? (decimal?)null : decimal.Parse(valor, System.Globalization.CultureInfo.InvariantCulture);
        Assert.Equal(RegrasMovimentoCaixa.MensagemValorInvalido, Assert.Throws<RegraNegocioException>(() => RegrasMovimentoCaixa.ValidarValor(v)).Message);
    }

    [Fact]
    public void Sangria_acima_do_estimado_e_recusada_com_a_chave_ligada_e_so_avisa_com_ela_desligada()
    {
        Assert.Null(RegrasMovimentoCaixa.ValidarSangria(100m, 100m, limitadaAoSaldo: true, mostraValor: false));
        var recusa = Assert.Throws<RegraNegocioException>(() => RegrasMovimentoCaixa.ValidarSangria(100.01m, 100m, limitadaAoSaldo: true, mostraValor: false));
        // O3: a mensagem não conta ao operador quanto há na gaveta.
        Assert.DoesNotContain("R$", recusa.Message, StringComparison.Ordinal);
        Assert.Contains("R$ 100,00", Assert.Throws<RegraNegocioException>(() => RegrasMovimentoCaixa.ValidarSangria(150m, 100m, true, mostraValor: true)).Message,
            StringComparison.Ordinal);
        Assert.NotNull(RegrasMovimentoCaixa.ValidarSangria(150m, 100m, limitadaAoSaldo: false, mostraValor: false));
    }

    [Fact]
    public void Quem_retira_e_obrigatorio_na_sangria_ate_60_o_nome_do_usuario_e_cortado_e_o_motivo_do_cancelamento_e_obrigatorio()
    {
        Assert.Throws<RegraNegocioException>(() => RegrasMovimentoCaixa.QuemRetira("  ", null, obrigatorio: true));
        Assert.Null(RegrasMovimentoCaixa.QuemRetira(null, Guid.CreateVersion7(), obrigatorio: true));
        Assert.Equal("CARLOS", RegrasMovimentoCaixa.QuemRetira("  CARLOS ", null, obrigatorio: true));
        Assert.Null(RegrasMovimentoCaixa.QuemRetira(null, null, obrigatorio: false));
        Assert.Throws<RegraNegocioException>(() => RegrasMovimentoCaixa.QuemRetira(new string('x', 61), null, obrigatorio: false));
        // O nome do usuário do F2 (até 100 no cadastro) é cortado nos 60 do quem_retira_nome: o id é o que identifica.
        var longo = "Maria Aparecida dos Santos Oliveira Pereira da Silva Gomes Lima";
        Assert.Equal(longo[..60].TrimEnd(), RegrasMovimentoCaixa.QuemRetira(longo, Guid.CreateVersion7(), obrigatorio: true));
        Assert.Equal(60, RegrasMovimentoCaixa.NomeDoUsuario(new string('x', 100)).Length);
        Assert.Equal("CARLOS", RegrasMovimentoCaixa.NomeDoUsuario(" CARLOS "));
        Assert.Throws<RegraNegocioException>(() => RegrasMovimentoCaixa.TextoOpcional(new string('x', 256), "Observação"));
        Assert.Null(RegrasMovimentoCaixa.TextoOpcional(" ", "Observação"));
        Assert.Equal(RegrasMovimentoCaixa.MensagemMotivo, Assert.Throws<RegraNegocioException>(() => RegrasMovimentoCaixa.MotivoCancelamento(" ")).Message);
        Assert.Equal("Digitou errado", RegrasMovimentoCaixa.MotivoCancelamento(" Digitou errado "));
    }

    [Fact]
    public void Dinheiro_da_gaveta_e_o_mesmo_da_linha_dinheiro_do_fechamento()
    {
        PagamentoApurado[] pagamentos = [new(Dinheiro, 52.90m), new(Pix, 30m), new(Debito, 20m, Troco: 2m)];
        MovimentoApurado[] movimentos = [new(TiposMovimento.Reforco, 100m), new(TiposMovimento.Sangria, 200m), new(TiposMovimento.Sangria, 50m, Cancelado: true)];
        var gaveta = ApuracaoCaixa.DinheiroGaveta(150m, pagamentos, movimentos);
        Assert.Equal(100.90m, gaveta);
        Assert.Equal(gaveta, ApuracaoCaixa.Calcular(150m, pagamentos, movimentos, Dinheiro).DinheiroGaveta);
    }

    [Fact]
    public void Periodo_por_dias_comeca_na_hora_de_corte_e_por_horario_atravessa_a_madrugada_no_mesmo_dia_operacional()
    {
        // D7: corte 05:00 em Brasília (UTC−3) → o dia 29/10 vai de 29/10 08:00Z a 30/10 08:00Z.
        var dias = PeriodoResumo.PorDias(new DateOnly(2026, 10, 29), new DateOnly(2026, 10, 30), Fuso, Corte);
        Assert.Equal((Utc("2026-10-29T08:00:00Z"), Utc("2026-10-31T08:00:00Z")), (dias.Inicio, dias.Fim));
        Assert.True(dias.Contem(Utc("2026-10-31T07:59:59Z")));
        Assert.False(dias.Contem(Utc("2026-10-31T08:00:00Z")));
        Assert.Equal("Dias operacionais 29/10/2026 a 30/10/2026", dias.Descricao);

        // 22:00 de 29/10 às 02:00 (madrugada de 30/10, ainda o dia operacional 29/10), com o minuto final incluído.
        var horario = PeriodoResumo.PorHorario(new DateOnly(2026, 10, 29), new TimeOnly(22, 0), new TimeOnly(2, 0), Fuso, Corte);
        Assert.Equal((Utc("2026-10-30T01:00:00Z"), Utc("2026-10-30T05:01:00Z")), (horario.Inicio, horario.Fim));

        Assert.Throws<RegraNegocioException>(() => PeriodoResumo.PorDias(new DateOnly(2026, 10, 30), new DateOnly(2026, 10, 29), Fuso, Corte));
        Assert.Throws<RegraNegocioException>(() => PeriodoResumo.PorDias(new DateOnly(2026, 10, 1), new DateOnly(2026, 11, 1), Fuso, Corte));
        Assert.Throws<RegraNegocioException>(() => PeriodoResumo.PorHorario(new DateOnly(2026, 10, 29), new TimeOnly(14, 0), new TimeOnly(8, 0), Fuso, Corte));
    }

    [Fact]
    public void Resumo_conta_vendas_formas_cancelamentos_e_movimentos_do_periodo_e_oculta_os_valores_do_esperado_no_fechamento_cego()
    {
        var periodo = PeriodoResumo.PorDias(new DateOnly(2026, 10, 29), new DateOnly(2026, 10, 29), Fuso, Corte);
        var (fechada, aberta) = (Guid.CreateVersion7(), Guid.CreateVersion7());
        var dentro = Utc("2026-10-29T15:00:00Z");
        var fora = Utc("2026-10-30T09:00:00Z");
        VendaResumo[] vendas =
        [
            new(fechada, StatusVenda.Finalizada, dentro, null, 50m, 2m, 1, 9.99m, [new(Pix, 30m), new(Dinheiro, 20m)]),
            new(fechada, StatusVenda.Finalizada, dentro, null, 12.90m, 0m, 0, 0m, [new(Dinheiro, 12.90m)]),
            // Finalizada e cancelada no período: conta só nos cancelamentos.
            new(fechada, StatusVenda.Cancelada, dentro, dentro, 30m, 0m, 0, 0m, [new(Dinheiro, 30m)]),
            // Em andamento cancelada no período (sem pagamento).
            new(fechada, StatusVenda.Cancelada, null, dentro, 8m, 0m, 0, 0m, []),
            new(fechada, StatusVenda.Finalizada, fora, null, 99m, 0m, 0, 0m, [new(Dinheiro, 99m)]),
            new(aberta, StatusVenda.Finalizada, dentro, null, 70m, 0m, 0, 0m, [new(Debito, 70m)]),
        ];
        MovimentoResumo[] movimentos =
        [
            new(fechada, TiposMovimento.Sangria, 500m, false, dentro),
            new(fechada, TiposMovimento.Sangria, 100m, true, dentro),
            new(fechada, TiposMovimento.Reforco, 50m, false, dentro),
            new(fechada, TiposMovimento.Abertura, 150m, false, dentro),
            new(aberta, TiposMovimento.Sangria, 300m, false, dentro),
        ];

        var completo = ResumoDiario.Montar(periodo, vendas, movimentos);
        Assert.Equal((3, 132.90m), (completo.QtdVendas, completo.TotalVendas));
        Assert.Equal(["Dinheiro", "Débito", "PIX"], completo.Formas.Select(f => f.Descricao));
        Assert.Equal(new FormaResumo("Dinheiro", 2, 32.90m), completo.Formas[0]);
        Assert.Equal((2, 38m), (completo.QtdCanceladas, completo.TotalCanceladas));
        Assert.Equal((1, 9.99m, 2m), (completo.QtdItensCancelados, completo.TotalItensCancelados, completo.TotalDescontos));
        Assert.Equal((2, 800m, 1, 50m, 1), (completo.QtdSangrias, completo.TotalSangrias, completo.QtdReforcos, completo.TotalReforcos, completo.QtdMovimentosCancelados));
        Assert.Equal(44.30m, completo.TicketMedio);
        Assert.False(completo.ValoresOcultos);

        // O3: no fechamento cego, todas as sessões (a aberta e as fechadas) saem só com as quantidades — as vendas por
        // forma, com o fundo e as sangrias, são o esperado e a diferença que só o gerente vê no ERP.
        var oculto = ResumoDiario.Montar(periodo, vendas, movimentos, valoresOcultos: true);
        Assert.Equal((3, 0m, 0m), (oculto.QtdVendas, oculto.TotalVendas, oculto.TicketMedio));
        Assert.Equal([new FormaResumo("Dinheiro", 2, 0m), new FormaResumo("Débito", 1, 0m), new FormaResumo("PIX", 1, 0m)], oculto.Formas);
        Assert.Equal((2, 0m, 1, 0m, 1), (oculto.QtdSangrias, oculto.TotalSangrias, oculto.QtdReforcos, oculto.TotalReforcos, oculto.QtdMovimentosCancelados));
        // Cancelamentos, itens cancelados e descontos não entram no esperado: aparecem.
        Assert.Equal((2, 38m, 9.99m, 2m), (oculto.QtdCanceladas, oculto.TotalCanceladas, oculto.TotalItensCancelados, oculto.TotalDescontos));
        Assert.True(oculto.ValoresOcultos);
    }
}
