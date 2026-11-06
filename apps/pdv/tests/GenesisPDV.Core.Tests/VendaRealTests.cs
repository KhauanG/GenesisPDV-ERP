using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using static GenesisPDV.Core.Tests.Fixtures;

namespace GenesisPDV.Core.Tests;

/// <summary>
/// Venda real da Fase 1C (bloco C11a): formas do espelho com o troco só no dinheiro (O23), cartão na maquininha com a
/// bandeira (16.5, O9c), PIX estático/manual com a cobrança (16.7), a liberação da forma (31.3), CPF/cliente na nota
/// (14.1, O8), a ficha técnica do produzido (D17), o BR Code, o saldo (29.1, O15) e o tempo offline (30.6, O18).
/// </summary>
public class VendaRealTests
{
    private static readonly FormaPagamentoInfo Debito = new(Guid.CreateVersion7(), "Cartão de débito", "04", "cartao_debito", PermiteTroco: false,
        LancaQuitada: false, Integracao: IntegracaoForma.PosExterno);

    private static readonly FormaPagamentoInfo Credito = new(Guid.CreateVersion7(), "Cartão de crédito", "03", "cartao_credito", PermiteTroco: true,
        Integracao: IntegracaoForma.PosExterno, PermiteParcelar: true, ParcelasMaximo: 6);

    private static Venda EmPagamento(params decimal[] valores)
    {
        var venda = VendaComItens(valores);
        venda.IniciarPagamento();
        return venda;
    }

    [Fact]
    public void Troco_so_na_forma_que_da_troco_sem_integracao_e_fora_de_cartao_e_pix()
    {
        // O23: a marca "dá troco" num cartão (cadastro antigo) não faz o cartão passar do total.
        Assert.True(Dinheiro.DaTroco);
        Assert.False(Credito.DaTroco);
        Assert.False(Pix.DaTroco);
        Assert.False((Pix with { PermiteTroco = true }).DaTroco);
        Assert.True(new FormaPagamentoInfo(Guid.CreateVersion7(), "Outros", "99", "outros", PermiteTroco: true).DaTroco);

        var venda = EmPagamento(12.90m);
        var recusa = Assert.Throws<RegraNegocioException>(() => venda.PreverPagamento(Credito, 20m));
        Assert.Contains("não permite troco", recusa.Message);
        Assert.Equal((12.90m, 7.10m), venda.PreverPagamento(Dinheiro, 20m));
    }

    [Fact]
    public void Fluxo_da_forma_na_fase_1c()
    {
        Assert.Equal(FluxoPagamento.Direto, Dinheiro.Fluxo);
        Assert.Equal(FluxoPagamento.Pos, Debito.Fluxo);
        // Cartão sem integração também é maquininha (16.5).
        Assert.Equal(FluxoPagamento.Pos, (Debito with { Integracao = IntegracaoForma.Nenhuma }).Fluxo);
        Assert.Equal(FluxoPagamento.PixManual, Pix.Fluxo);
        // O PIX dinâmico (Fase 6) cai na confirmação manual; TEF, crediário e vale não são lançados na 1C.
        Assert.Equal(FluxoPagamento.PixManual, (Pix with { Integracao = IntegracaoForma.PixDinamico }).Fluxo);
        Assert.Equal(FluxoPagamento.Indisponivel, (Credito with { Integracao = IntegracaoForma.Tef }).Fluxo);
        Assert.Equal(FluxoPagamento.Indisponivel, new FormaPagamentoInfo(Guid.CreateVersion7(), "Caderneta", "05", "crediario", false).Fluxo);
        var venda = EmPagamento(10m);
        Assert.Throws<RegraNegocioException>(() =>
            venda.LancarPagamento(new FormaPagamentoInfo(Guid.CreateVersion7(), "Vale", "99", "vale", false), 10m, Agora));
    }

    [Fact]
    public void Cartao_na_maquininha_exige_a_bandeira_e_grava_nsu_autorizacao_e_parcelas()
    {
        var venda = EmPagamento(100m);
        Assert.Throws<RegraNegocioException>(() => venda.LancarPagamento(Debito, 40m, Agora));
        Assert.Empty(venda.PagamentosAtivos);

        // O9c: bandeira obrigatória; NSU (até 12 dígitos) e autorização (até 6) opcionais.
        Assert.Throws<RegraNegocioException>(() => RegrasFormaPagamento.ValidarPos(Debito, null, null, null, 1));
        Assert.Throws<RegraNegocioException>(() => RegrasFormaPagamento.ValidarPos(Debito, "02", "12AB", null, 1));
        Assert.Throws<RegraNegocioException>(() => RegrasFormaPagamento.ValidarPos(Debito, "02", null, "1234567", 1));
        Assert.Throws<RegraNegocioException>(() => RegrasFormaPagamento.ValidarPos(Debito, "02", null, null, 2));
        Assert.Throws<RegraNegocioException>(() => RegrasFormaPagamento.ValidarPos(Credito, "02", null, null, 7));

        var debito = venda.LancarPagamento(Debito, 40m, Agora, RegrasFormaPagamento.ValidarPos(Debito, "02", " 000123 ", "ab12c", 1));
        Assert.Equal(((short?)2, "02", "Mastercard", "000123", "AB12C"), (debito.Detalhe.TipoIntegracao, debito.Detalhe.Bandeira,
            debito.Detalhe.BandeiraNome, debito.Detalhe.Nsu, debito.Detalhe.Autorizacao));
        Assert.Null(debito.ValorRecebido);
        Assert.False(debito.LancaQuitada);

        var credito = venda.LancarPagamento(Credito, 60m, Agora, RegrasFormaPagamento.ValidarPos(Credito, "01", null, null, 3));
        Assert.Equal(3, credito.Parcelas);
        Assert.Equal(0m, venda.Falta);
    }

    [Fact]
    public void Pix_manual_grava_a_cobranca_paga_e_o_cancelamento_a_cancela()
    {
        var venda = EmPagamento(75.18m);
        Assert.Throws<RegraNegocioException>(() => venda.LancarPagamento(Pix, 30m, Agora));
        Assert.Empty(venda.CobrancasPix);

        var confirmacao = new ConfirmacaoPix("JOSE DA SILVA", Agora.AddMinutes(-2), "000201...", "L01C02000123");
        var pix = venda.LancarPagamento(Pix, 30m, Agora, pix: confirmacao);
        var cobranca = Assert.Single(venda.CobrancasPix);
        Assert.Equal((cobranca.Id, pix.Id, 30m, StatusCobrancaPix.Paga, "estatico"), (pix.Detalhe.PixCobrancaId!.Value, cobranca.PagamentoVendaId!.Value,
            cobranca.Valor, cobranca.Status, cobranca.Tipo));

        // 16.12: PIX 30,00 + dinheiro 50,00 numa venda de 75,18 dá troco 4,82 e Σ valor = total.
        venda.LancarPagamento(Dinheiro, 50m, Agora);
        Assert.Equal(4.82m, venda.Troco);
        Assert.Equal(75.18m, venda.PagamentosAtivos.Sum(p => p.Valor));

        venda.RemoverPagamento(pix.Sequencia);
        Assert.Equal(StatusCobrancaPix.Cancelada, cobranca.Status);
    }

    [Fact]
    public void Pix_recusado_no_meio_da_operacao_nao_deixa_cobranca()
    {
        // A forma exige o supervisor e não veio a liberação: a operação atômica desfaz a cobrança.
        var venda = EmPagamento(10m);
        var exige = Pix with { ExigeSupervisor = true };
        Assert.Throws<RegraNegocioException>(() =>
            venda.LancarPagamento(exige, 10m, Agora, pix: new ConfirmacaoPix("JOSE", Agora, string.Empty, "L01")));
        Assert.Empty(venda.CobrancasPix);
        Assert.Empty(venda.Liberacoes);
    }

    [Fact]
    public void Liberacao_da_forma_vira_o_autorizado_e_a_linha_de_liberacoes()
    {
        var venda = EmPagamento(10m, 5m);
        var vale = new FormaPagamentoInfo(Guid.CreateVersion7(), "Vale refeição", "11", "vale_refeicao", false, ExigeSupervisor: true);
        Assert.Throws<RegraNegocioException>(() => venda.LancarPagamento(vale, 10m, Agora));

        var liberacao = new Liberacao(Supervisor, 0m, "  Cliente da empresa conveniada  ", Agora);
        var pago = venda.LancarPagamento(vale, 10m, Agora, liberacao: liberacao);
        Assert.Equal((Guid?)Supervisor, pago.Detalhe.AutorizadoPorId);
        var linha = Assert.Single(venda.Liberacoes);
        Assert.Equal((AcaoLiberacao.FormaPagamento, (Guid?)null, (decimal?)null, "Cliente da empresa conveniada"), (linha.Acao, linha.ItemVendaId, linha.ValorPct, linha.Motivo));

        venda.LancarPagamento(Pix, 5m, Agora, pix: PixConfirmado, liberacao: liberacao);
        Assert.Equal(AcaoLiberacao.PixManual, venda.Liberacoes[^1].Acao);
    }

    [Fact]
    public void Cpf_na_nota_e_cliente_valem_ate_finalizar()
    {
        var venda = NovaVenda();
        venda.AdicionarItem(Produto(10m), 1m, "1", Agora);
        Assert.Throws<RegraNegocioException>(() => venda.IdentificarCliente("1234", null, null));
        Assert.Throws<RegraNegocioException>(() => venda.IdentificarCliente("52998224725", new string('X', 61), null));
        Assert.Throws<RegraNegocioException>(() => venda.IdentificarCliente(null, null, null));
        Assert.Null(venda.CpfCnpjNota);

        var cliente = Guid.CreateVersion7();
        venda.IdentificarCliente("52998224725", "  Maria Cliente ", cliente);
        Assert.Equal(("52998224725", "Maria Cliente", (Guid?)cliente), (venda.CpfCnpjNota, venda.NomeNota, venda.ClienteId));
        // CNPJ alfanumérico (14: 12 letras/dígitos + 2 dígitos), como o ck_vendas_cpf_cnpj_nota.
        venda.IdentificarCliente("12ABC34501DE35", null, null);
        Assert.Equal(("12ABC34501DE35", (Guid?)null), (venda.CpfCnpjNota, venda.ClienteId));

        venda.RemoverCliente();
        Assert.Equal((null, null, (Guid?)null), (venda.CpfCnpjNota, venda.NomeNota, venda.ClienteId));
    }

    [Fact]
    public void Produzido_baixa_os_insumos_da_ficha_com_a_perda_e_o_simples_nao()
    {
        // D17: caipirinha (produzido) = 0,250 kg de limão com 10% de perda + 1 dose; 2 caipirinhas.
        var limao = Guid.CreateVersion7();
        var cachaca = Guid.CreateVersion7();
        var caipirinha = new ProdutoVenda(Guid.CreateVersion7(), 30, null, "CAIPIRINHA", "UN", 18m)
        {
            Tipo = TipoProduto.Produzido,
            FichaTecnica = [new ComponenteFicha(limao, null, 0.25m, 10m), new ComponenteFicha(cachaca, null, 0.05m, 0m)],
        };
        var venda = NovaVenda();
        var item = venda.AdicionarItem(new ProdutoResolvido(caipirinha), 2m, "30", Agora);
        var gelo = venda.AdicionarItem(Produto(12.90m), 1m, "44", Agora);

        Assert.Equal(new[] { new ComponenteBaixa(limao, null, 0.550m), new ComponenteBaixa(cachaca, null, 0.100m) }, venda.ComponentesEstoque(item));
        Assert.Empty(venda.ComponentesEstoque(gelo));
        var baixas = venda.BaixasEstimadas();
        Assert.Equal((0.550m, 0.100m, 1m, false), (baixas[limao], baixas[cachaca], baixas[gelo.ProdutoId], baixas.ContainsKey(caipirinha.Id)));

        // Ficha no produto simples é só informativa (custo): não baixa insumo.
        var simples = venda.AdicionarItem(new ProdutoResolvido(caipirinha with { Tipo = TipoProduto.Simples, Id = Guid.CreateVersion7() }), 1m, "31", Agora);
        Assert.Empty(venda.ComponentesEstoque(simples));
    }

    [Fact]
    public void Crc16_do_br_code_e_o_ccitt_false()
    {
        Assert.Equal(0x29B1, PixEstatico.Crc16("123456789"));
    }

    [Fact]
    public void Br_code_estatico_tem_chave_valor_recebedor_txid_e_crc()
    {
        var payload = PixEstatico.Gerar("pix@icebeer.com.br", "Ice Beer Comércio de Bebidas", "São José dos Pinhais", 75.18m, "L01-C02-000123");

        Assert.StartsWith("000201", payload);
        Assert.Contains("0014br.gov.bcb.pix0118pix@icebeer.com.br", payload);
        Assert.Contains("5204000053039865405" + "75.18", payload);
        Assert.Contains("5802BR", payload);
        // Nome (25) e cidade (15) sem acento e cortados; txid só letras e dígitos.
        Assert.Contains("5925ICE BEER COMERCIO DE BEBI", payload);
        Assert.Contains("6015SAO JOSE DOS PI62", payload);
        Assert.Contains("62160512L01C02000123", payload);
        Assert.Equal(PixEstatico.Crc16(payload[..^4]).ToString("X4", System.Globalization.CultureInfo.InvariantCulture), payload[^4..]);
        Assert.Throws<RegraNegocioException>(() => PixEstatico.Gerar(" ", "X", "Y", 1m, "1"));
        Assert.Equal("***", PixEstatico.Txid("---"));
    }

    [Fact]
    public void Vale_alimentacao_so_paga_os_itens_sem_idade_minima()
    {
        // MD 3.10.1 (critério de aceite): cerveja R$ 40,00 (18 anos) + carvão R$ 20,00 aceita no máximo R$ 20,00 no VA.
        var va = new FormaPagamentoInfo(Guid.CreateVersion7(), "Vale Alimentação", "10", "vale_alimentacao", false,
            Integracao: IntegracaoForma.PosExterno, RestringeIdadeMinima: true);
        var vr = va with { Id = Guid.CreateVersion7(), Descricao = "Vale Refeição", TipoForma = "vale_refeicao" };
        var venda = NovaVenda();
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.CreateVersion7(), 1, null, "CERVEJA", "UN", 40m) { IdadeMinima = 18 }), 1m, "1", Agora);
        venda.AdicionarItem(Produto(20m, "CARVAO"), 1m, "2", Agora);
        venda.IniciarPagamento();
        Assert.Equal(20m, venda.MaximoFormasRestritas());

        var recusa = Assert.Throws<RegraNegocioException>(() => venda.PreverPagamento(va, 60m));
        Assert.Equal("Vale Alimentação não pode pagar bebida alcoólica: máximo R$ 20,00.", recusa.Message);
        var pos = new DetalhePagamento(TipoIntegracao: 2, Bandeira: "10", BandeiraNome: "Alelo");
        Assert.Throws<RegraNegocioException>(() => venda.LancarPagamento(va, 20.01m, Agora, pos));
        Assert.Empty(venda.PagamentosAtivos);
        Assert.True(venda.LancarPagamento(va, 20m, Agora, pos).RestringeIdadeMinima);

        // Outra forma restrita desconta o que o VA já pagou; a forma comum paga o resto.
        Assert.Equal(0m, venda.MaximoFormasRestritas());
        Assert.Contains("máximo R$ 0,00", Assert.Throws<RegraNegocioException>(() => venda.LancarPagamento(vr, 1m, Agora, pos)).Message);
        venda.LancarPagamento(Dinheiro, 40m, Agora);
        venda.Finalizar(Agora, Guid.CreateVersion7());
        Assert.Equal(StatusVenda.Finalizada, venda.Status);
    }

    [Fact]
    public void Pagamento_de_forma_que_exige_pessoa_prende_o_cliente_da_venda()
    {
        // 16.2: com o pagamento ativo da forma que exige pessoa, o cliente não sai nem é trocado (o devedor do convênio).
        var convenio = new FormaPagamentoInfo(Guid.CreateVersion7(), "Convênio", "99", "outros", false, ExigePessoa: true);
        var cliente = Guid.CreateVersion7();
        var venda = EmPagamento(50m);
        Assert.Contains("exige o cliente", Assert.Throws<RegraNegocioException>(() => venda.LancarPagamento(convenio, 30m, Agora)).Message);
        venda.IdentificarCliente("52998224725", null, cliente);
        var pagamento = venda.LancarPagamento(convenio, 30m, Agora);
        Assert.True(pagamento.ExigePessoa);

        Assert.Contains("remova o pagamento", Assert.Throws<RegraNegocioException>(() => venda.RemoverCliente()).Message);
        Assert.Throws<RegraNegocioException>(() => venda.IdentificarCliente(null, null, Guid.CreateVersion7()));
        Assert.Equal(cliente, venda.ClienteId);
        // O mesmo cliente (o nome na nota) pode ser ajustado.
        venda.IdentificarCliente("52998224725", "MARIA", cliente);

        venda.RemoverPagamento(pagamento.Sequencia);
        venda.RemoverCliente();
        Assert.Null(venda.ClienteId);
    }

    [Fact]
    public void Venda_sem_sessao_entra_na_sessao_aberta_so_sem_pagamento()
    {
        // A venda montada no terminal real da 1B (sem caixa, D18) entra na sessão aberta antes de finalizar (C11a).
        var sessao = Guid.CreateVersion7();
        var venda = VendaComItens(10m);
        Assert.Null(venda.SessaoCaixaId);
        venda.VincularSessaoCaixa(sessao);
        Assert.Equal(sessao, venda.SessaoCaixaId);
        Assert.Throws<RegraNegocioException>(() => venda.VincularSessaoCaixa(Guid.CreateVersion7()));

        var paga = EmPagamento(10m);
        paga.LancarPagamento(Dinheiro, 5m, Agora);
        Assert.Throws<RegraNegocioException>(() => paga.VincularSessaoCaixa(sessao));
        Assert.Null(paga.SessaoCaixaId);
    }

    [Fact]
    public void Horario_do_pix_lido_no_banco_e_do_dia_do_caixa_ou_da_vespera()
    {
        var fuso = DiaOperacional.ObterFuso(DiaOperacional.FusoPadrao);
        // 00:03 em Brasília: o PIX das 23:58 é da véspera; o das 00:01, de hoje.
        var agora = new DateTimeOffset(2026, 10, 30, 3, 3, 0, TimeSpan.Zero);
        Assert.Equal(new DateTimeOffset(2026, 10, 29, 23, 58, 0, TimeSpan.FromHours(-3)), RegrasFormaPagamento.HorarioDoBanco("23:58", agora, fuso));
        Assert.Equal(new DateTimeOffset(2026, 10, 30, 0, 1, 0, TimeSpan.FromHours(-3)), RegrasFormaPagamento.HorarioDoBanco("0001", agora, fuso));
        Assert.Null(RegrasFormaPagamento.HorarioDoBanco("25:00", agora, fuso));
        Assert.Null(RegrasFormaPagamento.HorarioDoBanco("ontem", agora, fuso));

        Assert.Throws<RegraNegocioException>(() => RegrasFormaPagamento.ValidarPix(" ", agora, agora));
        Assert.Throws<RegraNegocioException>(() => RegrasFormaPagamento.ValidarPix("JOSE", null, agora));
        Assert.Throws<RegraNegocioException>(() => RegrasFormaPagamento.ValidarPix("JOSE", agora.AddMinutes(6), agora));
        Assert.Equal(("JOSE", agora), RegrasFormaPagamento.ValidarPix(" JOSE ", agora, agora));
    }

    [Fact]
    public void Horario_do_pix_a_frente_longe_da_meia_noite_e_recusado_e_o_anterior_a_venda_tambem()
    {
        var fuso = DiaOperacional.ObterFuso(DiaOperacional.FusoPadrao);
        // 14:40 em Brasília: "14:50" (queria 14:05, ou comprovante de ontem) fica hoje e o ValidarPix recusa (16.7).
        var agora = new DateTimeOffset(2026, 10, 30, 17, 40, 0, TimeSpan.Zero);
        var digitado = RegrasFormaPagamento.HorarioDoBanco("14:50", agora, fuso);
        Assert.Equal(new DateTimeOffset(2026, 10, 30, 14, 50, 0, TimeSpan.FromHours(-3)), digitado);
        var aFrente = Assert.Throws<RegraNegocioException>(() => RegrasFormaPagamento.ValidarPix("JOSE", digitado, agora));
        Assert.Contains("à frente do relógio", aFrente.Message);
        // Dentro da folga de 5 min continua aceito.
        Assert.Equal(agora.AddMinutes(4), RegrasFormaPagamento.ValidarPix("JOSE", RegrasFormaPagamento.HorarioDoBanco("14:44", agora, fuso), agora).PagaEm);

        // Antes do início da venda (menos a folga de 30 min): recusado; dentro da folga, aceito.
        var inicio = agora.AddMinutes(-10);
        var antes = Assert.Throws<RegraNegocioException>(() =>
            RegrasFormaPagamento.ValidarPix("JOSE", RegrasFormaPagamento.HorarioDoBanco("13:55", agora, fuso), agora, inicio));
        Assert.Contains("anterior ao início desta venda", antes.Message);
        Assert.Equal(agora.AddMinutes(-35), RegrasFormaPagamento.ValidarPix("JOSE", RegrasFormaPagamento.HorarioDoBanco("14:05", agora, fuso), agora, inicio).PagaEm);

        // A véspera vale só perto da virada (até 2 h antes do relógio): às 00:20, "23:40" é de ontem; às 03:00, "23:55"
        // fica hoje e é recusado.
        var madrugada = new DateTimeOffset(2026, 10, 30, 3, 20, 0, TimeSpan.Zero);
        Assert.Equal(new DateTimeOffset(2026, 10, 29, 23, 40, 0, TimeSpan.FromHours(-3)), RegrasFormaPagamento.HorarioDoBanco("23:40", madrugada, fuso));
        var tarde = new DateTimeOffset(2026, 10, 30, 6, 0, 0, TimeSpan.Zero);
        Assert.Equal(new DateTimeOffset(2026, 10, 30, 23, 55, 0, TimeSpan.FromHours(-3)), RegrasFormaPagamento.HorarioDoBanco("23:55", tarde, fuso));
        Assert.Throws<RegraNegocioException>(() => RegrasFormaPagamento.ValidarPix("JOSE", RegrasFormaPagamento.HorarioDoBanco("23:55", tarde, fuso), tarde));
    }

    [Theory]
    [InlineData(5, 3, false, false, true, SituacaoEstoque.Normal)]
    [InlineData(2, 3, false, false, true, SituacaoEstoque.Aviso)]
    [InlineData(2, 3, true, false, true, SituacaoEstoque.Bloqueio)]
    [InlineData(2, 3, true, false, false, SituacaoEstoque.Aviso)]
    [InlineData(2, 3, true, true, false, SituacaoEstoque.Bloqueio)]
    public void Saldo_negativo_avisa_ou_bloqueia_conforme_as_chaves(int saldo, int naVenda, bool bloqueia, bool offline, bool online, SituacaoEstoque esperado)
    {
        // O15 do dono: as duas chaves desligadas — vende com aviso âmbar; offline, o bloqueio só com a chave própria.
        var avaliacao = RegrasEstoqueVenda.Avaliar("CERV BRAHMA", saldo, naVenda, new RegrasEstoque(bloqueia, offline), online);
        Assert.Equal(esperado, avaliacao.Situacao);
        if (esperado != SituacaoEstoque.Normal)
        {
            Assert.StartsWith("Estoque insuficiente: CERV BRAHMA (disponível: 2)", avaliacao.Mensagem);
        }
    }

    [Fact]
    public void Tempo_offline_sem_limite_por_padrao_e_sem_confiar_no_relogio_local()
    {
        var pull = new DateTimeOffset(2026, 10, 20, 12, 0, 0, TimeSpan.Zero);
        var agora = pull.AddDays(8);
        Assert.False(TempoOffline.Excedido(TempoOffline.Calcular(null, agora, pull, 0), null));
        Assert.True(TempoOffline.Excedido(TempoOffline.Calcular(null, agora, pull, 0), 7));
        // Atrasar o relógio do Windows não reduz: vale a maior hora já vista (12.3) e o uptime acumulado.
        Assert.True(TempoOffline.Excedido(TempoOffline.Calcular(agora, pull.AddDays(1), pull, 0), 7));
        Assert.True(TempoOffline.Excedido(TempoOffline.Calcular(null, pull, pull, (long)TimeSpan.FromDays(7.5).TotalSeconds), 7));
        Assert.False(TempoOffline.Excedido(TempoOffline.Calcular(null, agora, null, 0), 7));
        Assert.Equal("Terminal sem sincronizar há 7 dias. Conecte à internet.", TempoOffline.Mensagem(7));
    }
}
