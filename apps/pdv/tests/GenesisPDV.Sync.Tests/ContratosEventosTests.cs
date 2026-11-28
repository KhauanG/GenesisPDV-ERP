using System.Text.Json.Nodes;
using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Sync.Eventos;
using GenesisPDV.Sync.Protocolo;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// Suíte de contrato dos payloads de evento (SYNC 9, 17.5), lado C#: a <see cref="FabricaEventos"/> gera exatamente a
/// fixture de <c>packages/shared/testes/sync/*.payload.json</c> que o Vitest passa pelo zod (<c>eventos.spec.ts</c>,
/// que também exige todas as chaves do contrato em cada linha). Mudou o payload aqui, muda a fixture, e o zod confere.
/// O que os dois lados precisam conferir igual (o <c>payload_sha256</c> de cada fixture, as bordas do motivo do
/// cancelamento e as ações de liberação) fica em <c>eventos.conferencias.json</c>.
/// </summary>
public class ContratosEventosTests
{
    /// <summary>
    /// Fixtures de payload. As de venda saem da <see cref="FabricaEventos"/> e as de caixa e vasilhame da
    /// <see cref="FabricaEventosCaixa"/> (testes abaixo, Fase 1C, C9), e a forma A do cancelamento da
    /// <see cref="FabricaEventos.VendaCanceladaFinalizada"/> (C11b); o alerta ainda não tem fábrica no PDV e por enquanto
    /// só passa pelo zod e pela conferência do hash JCS com o TS.
    /// </summary>
    public static readonly string[] Payloads =
    [
        "alerta.cadastro.payload.json",
        "auditoria.registros.payload.json",
        "caixa.aberto.payload.json",
        "caixa.fechado.payload.json",
        "caixa.fechado.troca_turno.payload.json",
        "caixa.movimento_cancelado.payload.json",
        "caixa.reforco.payload.json",
        "caixa.sangria.payload.json",
        "vasilhame.movimentado.payload.json",
        "venda.cancelada.em_andamento.payload.json",
        "venda.cancelada.finalizada.payload.json",
        "venda.finalizada.payload.json",
        "venda.finalizada.formas.payload.json",
        "venda.finalizada.cascos.payload.json",
        "venda.finalizada.v2.complementos.payload.json",
        "venda.finalizada.gelada_parcelado.payload.json",
    ];

    private static readonly Guid Loja = Guid.Parse("01a18752-3782-7bda-ad3c-2d6d1a3d1fa7");
    private static readonly Guid Caixa = Guid.Parse("01a18752-c8a9-7970-9641-9f828b9d2434");
    private static readonly Guid Terminal = Guid.Parse("01a18751-a521-7238-b924-56de3eb13b90");
    private static readonly Guid Maria = Guid.Parse("01a18754-76cb-7b74-b2e7-06298fadc1a6");
    private static readonly Guid Carlos = Guid.Parse("01a18755-09d1-76b6-8b81-48f6b38a088c");
    private static readonly Guid Sessao = Guid.Parse("01a18755-98a1-7472-96da-1dac72ff5d2a");
    private static readonly Guid Dinheiro = Guid.Parse("01a1875e-a2ca-7299-9d65-a441d58842de");
    private static readonly DateTimeOffset Inicio = new(2026, 10, 29, 17, 31, 2, 114, TimeSpan.Zero);

    public static TheoryData<string> TodosOsPayloads => [.. Payloads];

    private static JsonObject Conferencias => JsonNode.Parse(Fixtures.Sync("eventos.conferencias.json"))!.AsObject();

    [Theory]
    [MemberData(nameof(TodosOsPayloads))]
    public void Fixture_de_payload_da_o_mesmo_payload_sha256_do_ts(string arquivo)
    {
        // O payload_sha256 é do JCS (SYNC 7.3). O eventos.spec.ts calcula o mesmo hash com o jcs do TS e compara com a
        // mesma conferência: uma diferença de serialização entre as linguagens quebra um dos dois lados.
        var no = JsonNode.Parse(Fixtures.Sync(arquivo))!;
        var jcs = Jcs.Serializar(no);
        Assert.Equal(jcs, Jcs.Serializar(JsonNode.Parse(jcs)));
        Assert.Equal(Conferencias["payload_sha256"]![arquivo]?.GetValue<string>(), Jcs.Sha256Hex(jcs));
    }

    [Fact]
    public void Conferencia_tem_o_hash_de_toda_fixture_de_payload()
    {
        var comHash = Conferencias["payload_sha256"]!.AsObject().Select(p => p.Key).Order(StringComparer.Ordinal);
        Assert.Equal(Payloads.Order(StringComparer.Ordinal), comHash);
    }

    [Fact]
    public void Motivo_do_cancelamento_tem_as_mesmas_bordas_do_zod()
    {
        // O6 (dono): de 15 a 255 sem as pontas. Os mesmos casos passam pelo payloadVendaCanceladaSchema no Vitest; um
        // lado mais rígido que o outro trava o outbox (PAYLOAD_INVALIDO) ou recusa no caixa o que a nuvem aceita.
        var regra = Conferencias["motivo_cancelamento_venda"]!.AsObject();
        Assert.Equal(
            (regra["minimo"]!.GetValue<int>(), regra["maximo"]!.GetValue<int>()),
            (Venda.MotivoCancelamentoMinimo, Venda.MotivoCancelamentoMaximo));
        foreach (var motivo in regra["aceitos"]!.AsArray().Select(m => m!.GetValue<string>()))
        {
            var venda = VendaDaFixture(finalizada: false);
            venda.Cancelar(Maria, motivo, Inicio.AddMinutes(4));
            Assert.Equal(motivo.Trim(), venda.MotivoCancelamento);
        }

        foreach (var motivo in regra["recusados"]!.AsArray().Select(m => m!.GetValue<string>()))
        {
            var venda = VendaDaFixture(finalizada: false);
            Assert.Throws<Core.Comum.RegraNegocioException>(() => venda.Cancelar(Maria, motivo, Inicio.AddMinutes(4)));
        }
    }

    [Fact]
    public void Acoes_de_liberacao_sao_as_do_contrato()
    {
        // ACOES_LIBERACAO_VENDA (eventos.ts) e AcaoLiberacao listam o mesmo: uma ação nova entra nos dois lados.
        var noPdv = typeof(AcaoLiberacao)
            .GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)
            .Where(f => f.IsLiteral)
            .Select(f => (string)f.GetRawConstantValue()!);
        var noContrato = Conferencias["acoes_liberacao_venda"]!.AsArray().Select(a => a!.GetValue<string>());
        Assert.Equal(noContrato.Order(StringComparer.Ordinal), noPdv.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Movimentos_cancelaveis_sao_os_do_contrato()
    {
        // MOVIMENTOS_CAIXA_CANCELAVEIS (eventos.ts, usado pelo handler da nuvem) e TipoMovimentoCaixa.Cancelaveis listam o
        // mesmo: o PDV não cancela localmente o que a nuvem recusaria com TRANSICAO_INVALIDA.
        var noContrato = Conferencias["movimentos_caixa_cancelaveis"]!.AsArray().Select(a => a!.GetValue<string>());
        Assert.Equal(noContrato.Order(StringComparer.Ordinal), TipoMovimentoCaixa.Cancelaveis.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Venda_finalizada_gera_a_fixture_do_contrato()
    {
        var venda = VendaDaFixture(finalizada: true);
        var eventoId = venda.EventoFinalizacaoId!.Value;

        var evento = FabricaEventos.VendaFinalizada(venda, eventoId);

        Assert.Equal(("venda.finalizada", 1, "venda", venda.Id), (evento.Tipo, evento.VersaoSchema, evento.AgregadoTipo, evento.AgregadoId));
        AssertMesmoPayload("venda.finalizada.payload.json", evento);
    }

    [Fact]
    public void Venda_com_maquininha_pix_cpf_e_ficha_tecnica_gera_a_fixture_do_contrato()
    {
        // C11a: o cartão na maquininha (bandeira, NSU, autorização, tpIntegra 2), o PIX estático confirmado manualmente
        // (cobrança paga, liberação `pix_manual` do supervisor), o CPF e o cliente na nota e o produzido com os insumos da
        // ficha técnica em `componentes_estoque` (D17).
        var venda = VendaComFormas();

        var evento = FabricaEventos.VendaFinalizada(venda, venda.EventoFinalizacaoId!.Value);

        AssertMesmoPayload("venda.finalizada.formas.payload.json", evento);
        var payload = JsonNode.Parse(evento.Payload)!;
        var fixture = JsonNode.Parse(Fixtures.Sync("venda.finalizada.payload.json"))!;
        foreach (var bloco in new[] { "itens_venda", "pagamentos_venda" })
        {
            Assert.All(payload[bloco]!.AsArray(), linha => Assert.Equal(Chaves(fixture[bloco]!.AsArray()[0]!.AsObject()), Chaves(linha!.AsObject())));
        }
    }

    [Fact]
    public void Venda_com_cascos_descontados_gera_a_fixture_do_contrato()
    {
        // C11c (PDV 10.12; O14 do dono): 2 cervejas 600 ml com os 2 vazios trazidos e mais 3 garrafas descontadas pelo
        // valor do casco. O crédito vai no `desconto_total` (origem `cliente`, sem %, rateado nos itens) e os 5 vazios nos
        // `devolvidos` do bloco `vasilhames`: nenhuma chave nova no contrato.
        var venda = VendaComCascos();

        var evento = FabricaEventos.VendaFinalizada(venda, venda.EventoFinalizacaoId!.Value);

        AssertMesmoPayload("venda.finalizada.cascos.payload.json", evento);
        var payload = JsonNode.Parse(evento.Payload)!;
        Assert.Equal(("7.50", "cliente"), (payload["vendas"]!["desconto_total"]!.GetValue<string>(), payload["vendas"]!["desconto_total_origem"]!.GetValue<string>()));
        Assert.Equal(5, Assert.Single(payload["vasilhames"]!.AsArray())!["devolvidos"]!.GetValue<int>());
    }

    [Fact]
    public void Venda_com_complementos_gera_a_fixture_da_v2_e_a_v1_sem_a_baixa_calculada()
    {
        // F3-B15 (PDV 10.2): "PORÇÃO DE FRITAS" com 2 molhos (o barbecue vinculado com baixa, que a nuvem baixa pelo
        // cadastro dela, e o rosé livre) e o cheddar produzido (os insumos da ficha calculados no caixa); uma segunda
        // porção cancelada leva o complemento dela no documento. A v2 tem a `componentes_estoque` em cada linha.
        var venda = VendaComComplementos();

        var evento = FabricaEventos.VendaFinalizada(venda, venda.EventoFinalizacaoId!.Value, FabricaEventos.VersaoVendaFinalizadaComplementos);

        Assert.Equal(("venda.finalizada", 2), (evento.Tipo, evento.VersaoSchema));
        AssertMesmoPayload("venda.finalizada.v2.complementos.payload.json", evento);
        var linhas = JsonNode.Parse(evento.Payload)!["itens_venda_complementos"]!.AsArray();
        Assert.Equal(4, linhas.Count);
        Assert.Equal(["0.168"], linhas.SelectMany(l => l!["componentes_estoque"]!.AsArray()).Select(c => c!["quantidade"]!.GetValue<string>()));

        // A v1 (a v2 não anunciada no último handshake) leva as mesmas linhas, sem a chave só da v2.
        var v1 = FabricaEventos.VendaFinalizada(venda, venda.EventoFinalizacaoId!.Value);
        var semBaixa = JsonNode.Parse(v1.Payload)!["itens_venda_complementos"]!.AsArray();
        Assert.Equal(1, v1.VersaoSchema);
        Assert.Equal(4, semBaixa.Count);
        Assert.All(semBaixa, l => Assert.Null(l!.AsObject()["componentes_estoque"]));
        Assert.Throws<ArgumentOutOfRangeException>(() => FabricaEventos.VendaFinalizada(venda, Guid.CreateVersion7(), 3));
    }

    [Fact]
    public void Venda_gelada_no_parcelado_gera_a_fixture_do_contrato()
    {
        // F3-B18 (PDV 11.2, 11.4): a lata gelada (o acréscimo dentro do preco_unitario e do preco_tabela) e a natural no
        // preço parcelado do crédito em 3×, e a água sem parcelado no varejo. Nenhuma chave nova: a marca "gelado" não sobe,
        // e o parcelado é o `tipo_preco` da venda e o `origem_preco` das linhas. A venda da fixture é a que o caixa monta.
        var venda = VendaGeladaParcelada();
        var pelasOperacoes = VendaGeladaParceladaPelasOperacoes();
        Assert.Equal(
            venda.Itens.Select(i => (i.Descricao, i.Quantidade, i.PrecoTabela, i.PrecoUnitario, i.OrigemPreco, i.ValorBruto, i.ValorLiquido)),
            pelasOperacoes.Itens.Select(i => (i.Descricao, i.Quantidade, i.PrecoTabela, i.PrecoUnitario, i.OrigemPreco, i.ValorBruto, i.ValorLiquido)));
        Assert.Equal((venda.TipoPreco, venda.Total, venda.SubtotalBruto), (pelasOperacoes.TipoPreco, pelasOperacoes.Total, pelasOperacoes.SubtotalBruto));

        var evento = FabricaEventos.VendaFinalizada(venda, venda.EventoFinalizacaoId!.Value);

        Assert.Equal(1, evento.VersaoSchema);
        AssertMesmoPayload("venda.finalizada.gelada_parcelado.payload.json", evento);
        var payload = JsonNode.Parse(evento.Payload)!;
        Assert.Equal("parcelado", payload["vendas"]!["tipo_preco"]!.GetValue<string>());
        Assert.All(payload["itens_venda"]!.AsArray(), i => Assert.Null(i!.AsObject()["gelado"]));
    }

    [Fact]
    public void Venda_em_andamento_cancelada_gera_a_fixture_da_forma_B()
    {
        var venda = VendaDaFixture(finalizada: false);
        venda.Cancelar(Maria, "Cliente desistiu antes de pagar", Inicio.AddMinutes(4));

        var evento = FabricaEventos.VendaCancelada(venda, Guid.Parse("01a18779-1b2c-7d3e-8f40-5a6b7c8d9e10"));

        Assert.Equal(("venda.cancelada", "venda"), (evento.Tipo, evento.AgregadoTipo));
        AssertMesmoPayload("venda.cancelada.em_andamento.payload.json", evento);
    }

    [Fact]
    public void Venda_paga_cancelada_gera_a_fixture_da_forma_A()
    {
        // C11b (PDV 13.3; O22 do dono): o dinheiro devolvido e o débito devolvido em dinheiro somam na linha Dinheiro; o
        // crédito cancelado na maquininha fica na linha dele. Quem cancelou (MARIA) e quem liberou (o gerente CARLOS).
        var venda = VendaPagaDaFormaA();
        var canceladaEm = CaixaDaFixture.Instante("2026-10-29T17:52:11.090Z");
        var devolvido = Guid.Parse("01a18789-2b4c-7d6e-9f80-a1b2c3d4e5f6");
        var cancelamento = venda.CancelarFinalizada(Maria, " Cliente desistiu da compra apos o pagamento ", canceladaEm, Sessao, Dinheiro,
            new Dictionary<Guid, string> { [devolvido] = EstornoPagamento.DevolvidoEmDinheiro }, Carlos);
        var ids = new Queue<Guid>([Guid.Parse("01a18793-b480-79e8-8a2c-827e98326856"), Guid.Parse("01a18793-c5d6-7e8f-9a0b-1c2d3e4f5a60")]);
        var linhas = Data.Repositorios.RepositorioCaixa.LinhasEstorno(CaixaDaFixture.SessaoAberta(), venda, cancelamento, ids.Dequeue);

        var evento = FabricaEventos.VendaCanceladaFinalizada(venda, cancelamento, linhas, Guid.CreateVersion7());

        Assert.Equal(("venda.cancelada", 1, "venda", venda.Id), (evento.Tipo, evento.VersaoSchema, evento.AgregadoTipo, evento.AgregadoId));
        Assert.Equal(((Guid?)Maria, (Guid?)Sessao, canceladaEm), (evento.UsuarioId, evento.SessaoCaixaId, evento.OcorridoEm));
        Assert.Equal(new[] { new DependenciaOutbox("venda", venda.Id), DependenciaOutbox.Sessao(Sessao) }, evento.Dependencias);
        Assert.Equal(40m, cancelamento.SaiDaGaveta);
        AssertMesmoPayload("venda.cancelada.finalizada.payload.json", evento);

        // O que a nuvem recusaria nem vira evento: a forma B não serve à venda paga, nem a forma A sem o estorno_venda.
        Assert.Throws<InvalidOperationException>(() => FabricaEventos.VendaCancelada(venda, Guid.CreateVersion7()));
        Assert.Throws<InvalidOperationException>(() => FabricaEventos.VendaCanceladaFinalizada(venda, cancelamento, [], Guid.CreateVersion7()));
    }

    [Fact]
    public void Venda_montada_pelas_operacoes_leva_as_mesmas_chaves_da_fixture()
    {
        // A fixture sai de uma venda reconstituída; esta passa pelas operações do caixa (atacado, combo, casco, desconto
        // liberado, pagamento) e precisa gerar cada linha com as mesmas chaves, nenhuma a mais nem a menos.
        var agora = Inicio;
        var venda = Venda.Iniciar(Guid.CreateVersion7(), 7, new ContextoVenda(Loja, Caixa, 1, Terminal, 2, Sessao), Maria, agora);
        var lata = venda.AdicionarItem(
            new ProdutoResolvido(new ProdutoVenda(Guid.NewGuid(), 1, null, "CERV", "UN", 3.49m) { Precos = new TabelaPreco(PrecoAtacado: 3.19m, QtdMinimaAtacado: 12m) }),
            12m, "789", agora);
        var combo = new ComboResolvido(
            new ProdutoVenda(Guid.NewGuid(), 3, null, "COMBO", "UN", 129.90m) { Tipo = TipoProduto.Kit },
            [
                new PosicaoCombo(Guid.NewGuid(), "Whisky", 1m, 1, [new OpcaoCombo(null, new ProdutoVenda(Guid.NewGuid(), 4, null, "WHISKY 1L", "UN", 99.90m))]),
                new PosicaoCombo(Guid.NewGuid(), "Energético", 1m, 2, [new OpcaoCombo(Guid.NewGuid(), new ProdutoVenda(Guid.NewGuid(), 5, null, "MONSTER 2L", "UN", 24.90m), 2m)]),
            ]);
        venda.AdicionarCombo(combo, [0, 0], 1m, "0500", agora);
        var casco = new ProdutoVenda(Guid.NewGuid(), 6, null, "GARRAFA", "UN", 2.50m) { Tipo = TipoProduto.Vasilhame };
        var cheio = venda.AdicionarItem(
            new ProdutoResolvido(new ProdutoVenda(Guid.NewGuid(), 7, null, "CERV 600", "UN", 9.90m) { VasilhameProdutoId = casco.Id, VasilhameQuantidade = 1 }),
            2m, "600", agora);
        venda.RegistrarCascosTrazidos(cheio.Sequencia, 1m, casco, agora);
        Assert.True(venda.AplicarDescontoItem(lata.Sequencia, Desconto.EmReais(5m), 1m, new Liberacao(Carlos, 20m, "Cliente fidelidade", agora)).Aplicado);
        venda.IniciarPagamento();
        venda.LancarPagamento(new FormaPagamentoInfo(Dinheiro, "Dinheiro", "01", "dinheiro", true), 500m, agora);
        var eventoId = Guid.CreateVersion7();
        venda.Finalizar(agora, eventoId);

        var gerado = JsonNode.Parse(FabricaEventos.VendaFinalizada(venda, eventoId).Payload)!.AsObject();
        var fixture = JsonNode.Parse(Fixtures.Sync("venda.finalizada.payload.json"))!.AsObject();

        Assert.Equal(Chaves(fixture), Chaves(gerado));
        Assert.Equal(Chaves(fixture["vendas"]!.AsObject()), Chaves(gerado["vendas"]!.AsObject()));
        foreach (var bloco in new[] { "itens_venda", "pagamentos_venda", "liberacoes", "vasilhames" })
        {
            var modelo = Chaves(fixture[bloco]!.AsArray()[0]!.AsObject());
            Assert.NotEmpty(gerado[bloco]!.AsArray());
            Assert.All(gerado[bloco]!.AsArray(), linha => Assert.Equal(modelo, Chaves(linha!.AsObject())));
        }

        var liberacao = Assert.Single(gerado["liberacoes"]!.AsArray())!;
        Assert.Equal(("desconto_item", lata.Id.ToString(), Carlos.ToString()), (
            liberacao["acao"]!.GetValue<string>(), liberacao["item_venda_id"]!.GetValue<string>(), liberacao["autorizado_por_id"]!.GetValue<string>()));
        Assert.Equal("2026-10-29T17:31:02.114Z", liberacao["ocorrido_em"]!.GetValue<string>());
        Assert.Equal(Sessao.ToString(), gerado["vendas"]!["sessao_caixa_id"]!.GetValue<string>());
    }

    [Fact]
    public void Desconto_recusado_ou_dentro_do_limite_nao_registra_a_liberacao_e_a_usada_vai_aparada()
    {
        // A liberação só entra em `liberacoes` quando o desconto passou pelo limite do supervisor, e é o último passo da
        // operação atômica (depois do Recalcular): recusa antes da operação, ou desconto que cabia no limite do operador,
        // não deixa linha nenhuma.
        var venda = Venda.Iniciar(Guid.CreateVersion7(), 8, new ContextoVenda(Loja, Caixa, 1, Terminal, 2, Sessao), Maria, Inicio);
        var item = venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.NewGuid(), 1, null, "ÁGUA", "UN", 2.50m)), 1m, "789", Inicio);
        Assert.True(venda.AplicarDescontoItem(item.Sequencia, Desconto.EmReais(0.10m), 10m, new Liberacao(Carlos, 100m, " ", Inicio)).Aplicado);
        Assert.Empty(venda.Liberacoes);
        Assert.Null(item.AutorizadoPorId);

        // Desconto recusado (todo o valor do item) não registra a liberação, mesmo com o supervisor informado.
        Assert.Throws<Core.Comum.RegraNegocioException>(() =>
            venda.AplicarDescontoItem(item.Sequencia, Desconto.EmReais(2.50m), 0m, new Liberacao(Carlos, 100m, "Avaria", Inicio)));
        Assert.Empty(venda.Liberacoes);

        Assert.True(venda.AplicarDescontoTotal(Desconto.EmReais(0.50m), 0m, new Liberacao(Carlos, 100m, "  Avaria  ", Inicio)).Aplicado);
        var liberacao = Assert.Single(venda.Liberacoes);
        Assert.Equal((AcaoLiberacao.DescontoTotal, (Guid?)null, "Avaria", 24m), (liberacao.Acao, liberacao.ItemVendaId, liberacao.Motivo, liberacao.ValorPct));
    }

    [Fact]
    public void Caixa_aberto_gera_a_fixture_e_declara_o_operador_e_a_sessao()
    {
        var sessao = CaixaDaFixture.SessaoAberta();
        var evento = FabricaEventosCaixa.CaixaAberto(sessao, CaixaDaFixture.Abertura(), CaixaDaFixture.CedulasAbertura, Guid.CreateVersion7());

        Assert.Equal(("caixa.aberto", 1, "sessao_caixa", Sessao), (evento.Tipo, evento.VersaoSchema, evento.AgregadoTipo, evento.AgregadoId));
        Assert.Equal((Maria, (Guid?)Sessao, CaixaDaFixture.AbertaEm), (evento.UsuarioId!.Value, evento.SessaoCaixaId, evento.OcorridoEm));
        // Abertura sem troca de turno não depende de nada deste terminal (SYNC 8.5).
        Assert.Empty(evento.Dependencias);
        AssertMesmoPayload("caixa.aberto.payload.json", evento);
    }

    [Fact]
    public void Caixa_aberto_na_troca_de_turno_depende_da_sessao_anterior_e_sem_fundo_nao_tem_movimento()
    {
        var anterior = Guid.CreateVersion7();
        var sessao = CaixaDaFixture.SessaoAberta();
        sessao.SessaoAnteriorId = anterior;
        sessao.FundoTroco = 0m;
        sessao.ValorRecebidoAnterior = 1734.50m;
        sessao.DiferencaRecebimento = -0.50m;

        var evento = FabricaEventosCaixa.CaixaAberto(sessao, null, null, Guid.CreateVersion7());

        Assert.Equal(new[] { DependenciaOutbox.Sessao(anterior) }, evento.Dependencias);
        var payload = JsonNode.Parse(evento.Payload)!;
        Assert.Empty(payload["movimentos_caixa"]!.AsArray());
        Assert.Null(payload["contagem_cedulas"]);
        Assert.Equal(("1734.50", "-0.50", "0.00"), (
            payload["sessoes_caixa"]!["valor_recebido_anterior"]!.GetValue<string>(),
            payload["sessoes_caixa"]!["diferenca_recebimento"]!.GetValue<string>(),
            payload["sessoes_caixa"]!["fundo_troco"]!.GetValue<string>()));
        Assert.Equal(Chaves(JsonNode.Parse(Fixtures.Sync("caixa.aberto.payload.json"))!["sessoes_caixa"]!.AsObject()), Chaves(payload["sessoes_caixa"]!.AsObject()));
    }

    [Fact]
    public void Caixa_aberto_com_a_abertura_diferente_do_fundo_nem_vira_evento()
    {
        // payloadCaixaAbertoSchema: o movimento de abertura é o fundo de troco (PAYLOAD_INVALIDO na nuvem, permanente, e
        // tudo da sessão ficaria retido); fundo maior que zero sem movimento também não fecha com a gaveta.
        var sessao = CaixaDaFixture.SessaoAberta();
        var aMais = CaixaDaFixture.Abertura();
        aMais.Valor = 200m;
        Assert.Throws<InvalidOperationException>(() => FabricaEventosCaixa.CaixaAberto(sessao, aMais, null, Guid.CreateVersion7()));
        Assert.Throws<InvalidOperationException>(() => FabricaEventosCaixa.CaixaAberto(sessao, null, null, Guid.CreateVersion7()));
        sessao.FundoTroco = 0m;
        Assert.Throws<InvalidOperationException>(() => FabricaEventosCaixa.CaixaAberto(sessao, CaixaDaFixture.Abertura(), null, Guid.CreateVersion7()));
    }

    [Fact]
    public void Reforco_sangria_e_cancelamento_geram_as_fixtures_e_dependem_da_sessao_ou_do_movimento()
    {
        var reforco = FabricaEventosCaixa.CaixaReforco(CaixaDaFixture.Reforco(), 412.30m, null, Guid.CreateVersion7());
        AssertMesmoPayload("caixa.reforco.payload.json", reforco);
        Assert.Equal(new[] { DependenciaOutbox.Sessao(Sessao) }, reforco.Dependencias);

        var sangria = FabricaEventosCaixa.CaixaSangria(CaixaDaFixture.SangriaDoDia(), 1284.50m, CaixaDaFixture.CedulasSangria, Guid.CreateVersion7());
        AssertMesmoPayload("caixa.sangria.payload.json", sangria);
        Assert.Equal(("caixa.sangria", "movimento_caixa", CaixaDaFixture.Sangria, (Guid?)Maria), (sangria.Tipo, sangria.AgregadoTipo, sangria.AgregadoId, sangria.UsuarioId));

        var cancelado = FabricaEventosCaixa.CaixaMovimentoCancelado(CaixaDaFixture.SangriaCancelada(), Guid.CreateVersion7());
        AssertMesmoPayload("caixa.movimento_cancelado.payload.json", cancelado);
        Assert.Equal(new[] { new DependenciaOutbox("movimento_caixa", CaixaDaFixture.Sangria) }, cancelado.Dependencias);
        Assert.Equal(((Guid?)Sessao, CaixaDaFixture.Instante("2026-10-29T15:31:02.004Z")), (cancelado.SessaoCaixaId, cancelado.OcorridoEm));

        // O que a nuvem recusaria (ck_movimentos_caixa_sangria, cancelamento sem motivo) nem vira evento.
        var semQuemRetira = CaixaDaFixture.SangriaDoDia();
        semQuemRetira.QuemRetiraUsuarioId = null;
        semQuemRetira.QuemRetiraNome = " ";
        Assert.Throws<InvalidOperationException>(() => FabricaEventosCaixa.CaixaSangria(semQuemRetira, null, null, Guid.CreateVersion7()));
        Assert.Throws<InvalidOperationException>(() => FabricaEventosCaixa.CaixaMovimentoCancelado(CaixaDaFixture.SangriaDoDia(), Guid.CreateVersion7()));
        Assert.Throws<InvalidOperationException>(() => FabricaEventosCaixa.CaixaReforco(CaixaDaFixture.SangriaDoDia(), null, null, Guid.CreateVersion7()));

        // Só sangria e reforço se cancelam (a nuvem recusa o resto com TRANSICAO_INVALIDA, permanente).
        foreach (var tipo in new[] { TipoMovimentoCaixa.Abertura, TipoMovimentoCaixa.SangriaFechamento, TipoMovimentoCaixa.EstornoVenda, TipoMovimentoCaixa.DevolucaoTroca })
        {
            var outro = CaixaDaFixture.SangriaCancelada();
            outro.Tipo = tipo;
            var recusa = Assert.Throws<Core.Comum.RegraNegocioException>(() => FabricaEventosCaixa.CaixaMovimentoCancelado(outro, Guid.CreateVersion7()));
            Assert.Equal(Data.Repositorios.RepositorioCaixa.MensagemMovimentoNaoCancelavel, recusa.Message);
        }
    }

    [Theory]
    [InlineData(false, "caixa.fechado.payload.json")]
    [InlineData(true, "caixa.fechado.troca_turno.payload.json")]
    public void Caixa_fechado_gera_a_fixture_do_fechamento_e_da_troca_de_turno(bool trocaTurno, string arquivo)
    {
        var (fechamento, formas, sangria, fechadaEm) = CaixaDaFixture.Fechado(trocaTurno);

        var evento = FabricaEventosCaixa.CaixaFechado(fechamento, formas, sangria, fechadaEm, Guid.CreateVersion7());

        Assert.Equal(("caixa.fechado", "sessao_caixa", Sessao), (evento.Tipo, evento.AgregadoTipo, evento.AgregadoId));
        Assert.Equal(new[] { DependenciaOutbox.Sessao(Sessao) }, evento.Dependencias);
        AssertMesmoPayload(arquivo, evento);
        if (trocaTurno)
        {
            // ck_fechamentos_caixa_zera e "troca de turno sem sangria" do zod: o PDV não monta o que a nuvem recusa.
            var (_, _, sangriaDoFechamento, _) = CaixaDaFixture.Fechado();
            Assert.Throws<InvalidOperationException>(() => FabricaEventosCaixa.CaixaFechado(fechamento, formas, sangriaDoFechamento, fechadaEm, Guid.CreateVersion7()));
        }
    }

    [Fact]
    public void Devolucao_avulsa_de_cascos_gera_a_fixture_e_depende_da_sessao()
    {
        var evento = FabricaEventosCaixa.VasilhameMovimentado(CaixaDaFixture.DevolucaoAvulsa(), Guid.CreateVersion7());

        Assert.Equal(("vasilhame.movimentado", "movimento_vasilhame"), (evento.Tipo, evento.AgregadoTipo));
        Assert.Equal(new[] { DependenciaOutbox.Sessao(Sessao) }, evento.Dependencias);
        AssertMesmoPayload("vasilhame.movimentado.payload.json", evento);
    }

    [Fact]
    public void Venda_declara_o_operador_a_sessao_e_a_dependencia_dela()
    {
        var finalizada = FabricaEventos.VendaFinalizada(VendaDaFixture(finalizada: true), Guid.CreateVersion7());
        Assert.Equal(((Guid?)Maria, (Guid?)Sessao), (finalizada.UsuarioId, finalizada.SessaoCaixaId));
        Assert.Equal(new[] { DependenciaOutbox.Sessao(Sessao) }, finalizada.Dependencias);

        var venda = VendaDaFixture(finalizada: false);
        venda.Cancelar(Carlos, "Cliente desistiu antes de pagar", Inicio.AddMinutes(4));
        Assert.Equal((Guid?)Carlos, FabricaEventos.VendaCancelada(venda, Guid.CreateVersion7()).UsuarioId);
    }

    /// <summary>
    /// A venda da fixture <c>venda.finalizada.payload.json</c> (ids e horários de sincronizacao.md 9.1, Loja 1, Caixa 02,
    /// MARIA): Brahma em atacado com desconto liberado pelo CARLOS, água cancelada, o "COMBO DE WHISKY 1L" do 9.7 com a
    /// troca pelo Monster, uma cerveja 600 ml com o casco cobrado e dinheiro com troco.
    /// </summary>
    private static Venda VendaDaFixture(bool finalizada)
    {
        var vendaId = Guid.Parse("01a18756-bc09-76c2-b2b9-437a28df6ec4");
        var brahma = Guid.Parse("01a18757-4ab4-7370-a7cd-813047229389");
        var cheio = Guid.Parse("01a18759-8eb2-775a-bacf-b3d00b1f9163");
        var grupo = Guid.Parse("01a18772-4e1d-7a93-b5c0-8d2f6e1a3b44");
        var comboId = Guid.Parse("01a18770-9a2e-7c11-9f3d-5b7e0c4d2a10");
        DadosKit Kit(string posicao, string? alternativa, decimal acrescimo) =>
            new(grupo, comboId, "COMBO DE WHISKY 1L", 1m, 131.90m, Guid.Parse(posicao), alternativa is null ? null : Guid.Parse(alternativa), acrescimo);

        var itens = new List<ItemVenda>
        {
            new(brahma, 1, Guid.Parse("01a1875b-4061-7e2a-9e57-4f7aa0ee89ae"), "7891149103102", Guid.Parse("01a1875e-101f-7741-8729-4739614ff3d7"),
                "CERV BRAHMA LT 350ML", "UN", false, 12m, 3.49m, 3.19m, OrigemPreco.Atacado, 38.28m, 1.28m, Inicio,
                autorizadoPorId: Carlos, origemEntrada: "leitor", quantidadeReferenciaPreco: 12m),
            new(Guid.Parse("01a18757-ddb4-71a1-962b-0f79c37459ee"), 2, Guid.Parse("01a1875b-d10a-7312-93cd-59bf5c941cf0"), "7896045506873", null,
                "ÁGUA CRYSTAL 500ML", "UN", false, 2m, 2.50m, 2.50m, OrigemPreco.Loja, 5.00m, 0m, Inicio.AddSeconds(38),
                cancelado: true, canceladoEm: Inicio.AddSeconds(52), canceladoPorId: Maria, motivoCancelamento: "Cliente desistiu", origemEntrada: "leitor"),
            new(Guid.Parse("01a18758-6ac6-75bc-98c2-67976142ea7d"), 3, Guid.Parse("01a18771-0b3c-7d42-8a6e-2f9c1d7e5a01"), "0500", null,
                "WHISKY 1L", "UN", false, 1m, 99.90m, 98.48m, OrigemPreco.KitRateio, 98.48m, 0m, Inicio.AddSeconds(70),
                origemEntrada: "teclado", kit: Kit("01a18773-1c5f-7e08-a2b4-6d9e3f0c7a21", null, 0m)),
            new(Guid.Parse("01a18758-fe53-743a-9a8d-ca03580d7b71"), 4, Guid.Parse("01a18774-7d20-7b6a-9c8e-0e1f4a2b5c32"), "0500", null,
                "ENERGETICO MONSTER 2L", "UN", false, 1m, 24.90m, 24.55m, OrigemPreco.KitRateio, 24.55m, 0m, Inicio.AddSeconds(70),
                origemEntrada: "teclado", kit: Kit("01a18775-3f8a-7c2d-8e61-1a0b9d4c6e43", "01a18776-5a9b-7f3e-b7d2-2c1e0f5a8d54", 2m)),
            new(Guid.Parse("01a18759-1f2e-7a3b-8c4d-5e6f7a8b9c01"), 5, Guid.Parse("01a18777-8b0c-7a4f-9d13-3e2f1a6b9c65"), "0500", null,
                "GELO DE COCO", "UN", false, 2m, 4.50m, 4.435m, OrigemPreco.KitRateio, 8.87m, 0m, Inicio.AddSeconds(70),
                origemEntrada: "teclado", kit: Kit("01a18778-2d1e-7b5a-a4c3-4f3a2b7c0d76", null, 0m)),
            new(cheio, 6, Guid.Parse("01a1875d-7f81-7ddc-bb98-2ef8daf61a26"), "7891149200603", null,
                "CERV BRAHMA 600ML", "UN", false, 1m, 9.90m, 9.90m, OrigemPreco.Loja, 9.90m, 0m, Inicio.AddSeconds(90), origemEntrada: "leitor"),
            new(Guid.Parse("01a18759-c3d4-7e5f-a6b7-c8d9e0f1a2b3"), 7, Guid.Parse("01a1875d-11aa-7b2c-9d3e-4f5a6b7c8d04"), null, null,
                "GARRAFA 600ML", "UN", false, 1m, 2.50m, 2.50m, OrigemPreco.Loja, 2.50m, 0m, Inicio.AddSeconds(95), vasilhameItemOrigemId: cheio),
        };

        var finalizadaEm = Inicio.AddMinutes(5).AddSeconds(3).AddMilliseconds(9);
        List<PagamentoVenda> pagamentos = finalizada
            ? [new PagamentoVenda(Guid.Parse("01a1875a-ae0b-74b2-8d52-88f1142c3fe8"), 1, Dinheiro, "Dinheiro", "01", "dinheiro", 181.30m, 200m, 18.70m, StatusPagamento.Aprovado, true, 0m)]
            : [];
        var estado = new EstadoVenda(
            Id: vendaId,
            Numero: 123,
            NumeroExibicao: "L01-C02-000123",
            LojaId: Loja,
            CaixaId: Caixa,
            NumeroCaixa: 2,
            TerminalId: Terminal,
            SessaoCaixaId: Sessao,
            Modo: "balcao",
            Status: finalizada ? StatusVenda.Finalizada : StatusVenda.EmAndamento,
            StatusFiscal: StatusFiscal.NaoAplicavel,
            OperadorId: Maria,
            TipoPreco: "varejo",
            DescontoTotal: 0m,
            DescontoTotalPct: null,
            AcrescimoTotal: 0m,
            IniciadaEm: Inicio,
            FinalizadaEm: finalizada ? finalizadaEm : null,
            DiaOperacional: finalizada ? new DateOnly(2026, 10, 29) : null,
            CpfCnpjNota: "12345678909",
            EventoFinalizacaoId: finalizada ? Guid.Parse("01a18778-08ab-7f25-b9ac-1b1ea8e56e0c") : null);
        var liberacoes = new[]
        {
            new LiberacaoVenda(Guid.Parse("01a18779-0a1b-7c2d-8e3f-4a5b6c7d8e9f"), AcaoLiberacao.DescontoItem, brahma, 3.3438m, Carlos, "Cliente fidelidade", Inicio.AddSeconds(25)),
        };
        return Venda.Restaurar(estado, itens, pagamentos, liberacoes: liberacoes);
    }

    /// <summary>
    /// A venda da fixture <c>venda.finalizada.formas.payload.json</c>: 2 caipirinhas (produzido com a ficha técnica: limão
    /// com 10% de perda e a dose de cachaça) e um gelo, R$ 48,90, pagos com débito na maquininha (Elo) e PIX estático
    /// confirmado pelo CARLOS, com o CPF e o cliente na nota.
    /// </summary>
    private static Venda VendaComFormas()
    {
        var vendaId = Guid.Parse("01a187a0-1c2d-7e3f-8a4b-5c6d7e8f9a01");
        var caipirinha = new ProdutoVenda(Guid.Parse("01a187a1-2d3e-7f40-9b5c-6d7e8f9a0b12"), 30, null, "CAIPIRINHA DE LIMAO", "UN", 18m)
        {
            Tipo = TipoProduto.Produzido,
            FichaTecnica =
            [
                new ComponenteFicha(Guid.Parse("01a187a2-3e4f-7051-8c6d-7e8f9a0b1c23"), null, 0.25m, 10m),
                new ComponenteFicha(Guid.Parse("01a187a3-4f50-7162-9d7e-8f9a0b1c2d34"), null, 0.05m, 0m),
            ],
        };
        var itens = new List<ItemVenda>
        {
            new(Guid.Parse("01a187a4-5061-7273-8e8f-9a0b1c2d3e45"), 1, caipirinha.Id, "30", null, caipirinha.Descricao, "UN", false, 2m, 18m, 18m,
                OrigemPreco.Varejo, 36m, 0m, Inicio, origemEntrada: "teclado"),
            new(Guid.Parse("01a187a5-6172-7384-9f90-0a1b2c3d4e56"), 2, Guid.Parse("01a187a6-7283-7495-80a1-1b2c3d4e5f67"), "0044", null,
                "GELO ESCAMA 5KG", "UN", false, 1m, 12.90m, 12.90m, OrigemPreco.Varejo, 12.90m, 0m, Inicio.AddSeconds(20), origemEntrada: "teclado"),
        };
        var finalizadaEm = Inicio.AddMinutes(3);
        var pix = Guid.Parse("01a187a7-8394-75a6-91b2-2c3d4e5f6a78");
        var cobranca = Guid.Parse("01a187a8-94a5-76b7-a2c3-3d4e5f6a7b89");
        var pagamentos = new List<PagamentoVenda>
        {
            new(Guid.Parse("01a187a9-a5b6-77c8-b3d4-4e5f6a7b8c9a"), 1, Guid.Parse("01a187aa-b6c7-78d9-84e5-5f6a7b8c9dab"), "Cartão de débito", "04",
                "cartao_debito", 20m, null, 0m, StatusPagamento.Aprovado, false, 1.99m, dataPagamento: new DateOnly(2026, 10, 29),
                detalhe: new DetalhePagamento(2, "06", "Elo", "000123", "A1B2C3")),
            new(pix, 2, Guid.Parse("01a187ab-c7d8-79ea-95f6-6a7b8c9daebc"), "PIX", "20", "pix", 28.90m, null, 0m, StatusPagamento.Aprovado, true, 0m,
                dataPagamento: new DateOnly(2026, 10, 29), detalhe: new DetalhePagamento(PixCobrancaId: cobranca, AutorizadoPorId: Carlos)),
        };
        var qr = PixEstatico.Gerar("pix@icebeer.com.br", "ICE BEER", "CURITIBA", 28.90m, PixEstatico.Txid("L01-C02-000124"));
        var cobrancas = new[]
        {
            new CobrancaPixVenda(cobranca, PixEstatico.Txid("L01-C02-000124"), 28.90m, qr, finalizadaEm.AddSeconds(-40), "JOSE DA SILVA", pix),
        };
        var estado = new EstadoVenda(
            Id: vendaId, Numero: 124, NumeroExibicao: "L01-C02-000124", LojaId: Loja, CaixaId: Caixa, NumeroCaixa: 2, TerminalId: Terminal,
            SessaoCaixaId: Sessao, Modo: "balcao", Status: StatusVenda.Finalizada, StatusFiscal: StatusFiscal.NaoAplicavel, OperadorId: Maria,
            TipoPreco: "varejo", DescontoTotal: 0m, DescontoTotalPct: null, AcrescimoTotal: 0m, IniciadaEm: Inicio, FinalizadaEm: finalizadaEm,
            DiaOperacional: new DateOnly(2026, 10, 29), ClienteId: Guid.Parse("01a187ac-d8e9-7afb-a607-7b8c9daebfcd"), CpfCnpjNota: "52998224725",
            NomeNota: "MARIA CLIENTE", EventoFinalizacaoId: Guid.Parse("01a187ad-e9fa-7b0c-b718-8c9daebfc0de"));
        var liberacoes = new[]
        {
            new LiberacaoVenda(Guid.Parse("01a187ae-fa0b-7c1d-8829-9daebfc0d1ef"), AcaoLiberacao.PixManual, null, null, Carlos, "PIX conferido no extrato",
                finalizadaEm.AddSeconds(-10)),
        };
        var venda = Venda.Restaurar(estado, itens, pagamentos, liberacoes: liberacoes, cobrancasPix: cobrancas);
        venda.RegistrarProdutos([new ProdutoRegistrado(caipirinha, false)], null, Inicio);
        return venda;
    }

    /// <summary>
    /// A venda da fixture <c>venda.finalizada.cascos.payload.json</c> (C11c): 2 CERV BRAHMA 600ML retornáveis com os 2
    /// cascos trazidos, 6 latas e 3 GARRAFA 600ML descontadas a 2,50 (R$ 7,50); R$ 33,24 em dinheiro, com troco de 40,00.
    /// </summary>
    private static Venda VendaComCascos()
    {
        var garrafa = new ProdutoVenda(Guid.Parse("01a1875d-11aa-7b2c-9d3e-4f5a6b7c8d04"), 601, null, "GARRAFA 600ML", "UN", 2.50m)
        {
            Tipo = TipoProduto.Vasilhame,
        };
        var brahma600 = new ProdutoVenda(Guid.Parse("01a1875d-7f81-7ddc-bb98-2ef8daf61a26"), 600, null, "CERV BRAHMA 600ML", "UN", 9.90m)
        {
            VasilhameProdutoId = garrafa.Id,
            VasilhameQuantidade = 1,
        };
        var vendaId = Guid.Parse("01a187b0-1d2e-7f30-8a41-5b6c7d8e9f02");
        var itens = new List<ItemVenda>
        {
            new(Guid.Parse("01a187b1-2e3f-7041-9b52-6c7d8e9f0a13"), 1, brahma600.Id, "7891149200603", null, brahma600.Descricao, "UN", false, 2m,
                9.90m, 9.90m, OrigemPreco.Loja, 19.80m, 0m, Inicio, origemEntrada: "leitor"),
            new(Guid.Parse("01a187b2-3f40-7152-8c63-7d8e9f0a1b24"), 2, Guid.Parse("01a1875b-4061-7e2a-9e57-4f7aa0ee89ae"), "7891149103102", null,
                "CERV BRAHMA LT 350ML", "UN", false, 6m, 3.49m, 3.49m, OrigemPreco.Varejo, 20.94m, 0m, Inicio.AddSeconds(15), origemEntrada: "leitor"),
        };
        var finalizadaEm = Inicio.AddMinutes(2);
        var pagamentos = new List<PagamentoVenda>
        {
            new(Guid.Parse("01a187b3-4051-7263-9d74-8e9f0a1b2c35"), 1, Dinheiro, "Dinheiro", "01", "dinheiro", 33.24m, 40m, 6.76m, StatusPagamento.Aprovado, true, 0m),
        };
        var estado = new EstadoVenda(
            Id: vendaId, Numero: 125, NumeroExibicao: "L01-C02-000125", LojaId: Loja, CaixaId: Caixa, NumeroCaixa: 2, TerminalId: Terminal,
            SessaoCaixaId: Sessao, Modo: "balcao", Status: StatusVenda.Finalizada, StatusFiscal: StatusFiscal.NaoAplicavel, OperadorId: Maria,
            TipoPreco: "varejo", DescontoTotal: 7.50m, DescontoTotalPct: null, AcrescimoTotal: 0m, IniciadaEm: Inicio, FinalizadaEm: finalizadaEm,
            DiaOperacional: new DateOnly(2026, 10, 29), DescontoTotalOrigem: Venda.OrigemDescontoCliente,
            EventoFinalizacaoId: Guid.Parse("01a187b4-5162-7374-8e85-9f0a1b2c3d46"));
        var cascos = new[] { new CascoDescontado(garrafa.Id, garrafa.Descricao, 3, 2.50m, Inicio.AddSeconds(40)) };
        var venda = Venda.Restaurar(estado, itens, pagamentos, cascosDescontados: cascos);
        venda.RegistrarProdutos([new ProdutoRegistrado(brahma600, false)], null, Inicio);
        return venda;
    }

    /// <summary>
    /// A venda da fixture <c>venda.finalizada.v2.complementos.payload.json</c> (F3-B15): 2 PORÇÃO DE FRITAS a 25,00 com MOLHO
    /// BARBECUE (vinculado à matéria-prima, baixa de 0,050 por porção), Rosé (livre) e CHEDDAR CREMOSO (+4,50, produzido:
    /// 0,080 de queijo com 5% de perda), e 1 porção só com o Rosé, cancelada; R$ 59,00 em dinheiro.
    /// </summary>
    private static Venda VendaComComplementos()
    {
        var molhos = Guid.Parse("01a187c0-1a2b-7c3d-8e4f-5a6b7c8d9e01");
        var adicionais = Guid.Parse("01a187c0-2b3c-7d4e-9f50-6b7c8d9e0f12");
        var barbecue = Guid.Parse("01a187c1-3c4d-7e5f-8061-7c8d9e0f1a23");
        var rose = Guid.Parse("01a187c1-4d5e-7f60-9172-8d9e0f1a2b34");
        var cheddar = Guid.Parse("01a187c1-5e6f-7071-8283-9e0f1a2b3c45");
        var porcao = new ProdutoVenda(Guid.Parse("01a187c2-6f70-7182-9394-0f1a2b3c4d56"), 300, "0300", "PORÇÃO DE FRITAS", "UN", 25m)
        {
            Tipo = TipoProduto.ComComplementos,
            GruposComplementos =
            [
                new GrupoComplementos(molhos, "Molhos", 1, 2, true, 1,
                [
                    new OpcaoComplemento(barbecue, "MOLHO BARBECUE", 0m, Guid.Parse("01a187c3-7081-7293-84a5-1a2b3c4d5e67"), true, 0.05m, 1)
                    {
                        VinculadoComSaldo = true,
                    },
                    new OpcaoComplemento(rose, "Rosé", 0m, Ordem: 2),
                ]),
                new GrupoComplementos(adicionais, "Adicionais", 0, 2, false, 2,
                [
                    new OpcaoComplemento(cheddar, "CHEDDAR CREMOSO", 4.5m, Guid.Parse("01a187c3-8192-73a4-95b6-2b3c4d5e6f78"), true, 1m, 1)
                    {
                        FichaVinculado = [new ComponenteFicha(Guid.Parse("01a187c4-92a3-74b5-86c7-3c4d5e6f7089"), null, 0.08m, 5m)],
                    },
                ]),
            ],
        };
        ComplementoItem Complemento(string id, Guid opcao, string grupo, string descricao, decimal adicional) =>
            new(Guid.Parse(id), opcao, grupo, descricao, 1m, adicional);
        var itens = new List<ItemVenda>
        {
            new(Guid.Parse("01a187c5-a3b4-75c6-97d8-4d5e6f708192"), 1, porcao.Id, "0300", null, porcao.Descricao, "UN", false, 2m, 29.50m, 29.50m,
                OrigemPreco.Varejo, 59m, 0m, Inicio, origemEntrada: "teclado",
                complementos:
                [
                    Complemento("01a187c6-b4c5-76d7-a8e9-5e6f708192a3", barbecue, "Molhos", "MOLHO BARBECUE", 0m),
                    Complemento("01a187c6-c5d6-77e8-b9fa-6f708192a3b4", rose, "Molhos", "Rosé", 0m),
                    Complemento("01a187c6-d6e7-78f9-8a0b-708192a3b4c5", cheddar, "Adicionais", "CHEDDAR CREMOSO", 4.5m),
                ]),
            new(Guid.Parse("01a187c5-e7f8-790a-9b1c-8192a3b4c5d6"), 2, porcao.Id, "0300", null, porcao.Descricao, "UN", false, 1m, 25m, 25m,
                OrigemPreco.Varejo, 25m, 0m, Inicio.AddSeconds(30), cancelado: true, canceladoEm: Inicio.AddSeconds(45), canceladoPorId: Maria,
                motivoCancelamento: "Cliente desistiu", origemEntrada: "teclado",
                complementos: [Complemento("01a187c6-f809-7a1b-ac2d-92a3b4c5d6e7", rose, "Molhos", "Rosé", 0m)]),
        };
        var finalizadaEm = Inicio.AddMinutes(2);
        var pagamentos = new List<PagamentoVenda>
        {
            new(Guid.Parse("01a187c7-091a-7b2c-bd3e-a3b4c5d6e7f8"), 1, Dinheiro, "Dinheiro", "01", "dinheiro", 59m, 60m, 1m, StatusPagamento.Aprovado, true, 0m),
        };
        var estado = new EstadoVenda(
            Id: Guid.Parse("01a187c8-1a2b-7c3d-8e4f-b4c5d6e7f809"), Numero: 126, NumeroExibicao: "L01-C02-000126", LojaId: Loja, CaixaId: Caixa,
            NumeroCaixa: 2, TerminalId: Terminal, SessaoCaixaId: Sessao, Modo: "balcao", Status: StatusVenda.Finalizada,
            StatusFiscal: StatusFiscal.NaoAplicavel, OperadorId: Maria, TipoPreco: "varejo", DescontoTotal: 0m, DescontoTotalPct: null,
            AcrescimoTotal: 0m, IniciadaEm: Inicio, FinalizadaEm: finalizadaEm, DiaOperacional: new DateOnly(2026, 10, 29),
            EventoFinalizacaoId: Guid.Parse("01a187c9-2b3c-7d4e-9f50-c5d6e7f8091a"));
        var venda = Venda.Restaurar(estado, itens, pagamentos);
        venda.RegistrarProdutos([new ProdutoRegistrado(porcao, false)], null, Inicio);
        return venda;
    }

    private static readonly Guid CreditoFixture = Guid.Parse("01a1875f-c261-7aef-afc8-9849b3aa7efe");

    /// <summary>"CERV BRAHMA LT 350ML" 3,49, gelada R$ 1,00 na loja e parcelado 3,69; "AGUA MINERAL 500ML" 2,50 sem os dois.</summary>
    private static (ProdutoVenda Lata, ProdutoVenda Agua) ProdutosGeladaParcelado() => (
        new ProdutoVenda(Guid.Parse("01a187d0-1a2b-7c3d-8e4f-5a6b7c8d9e01"), 123, "0123", "CERV BRAHMA LT 350ML", "UN", 3.49m)
        {
            Precos = new TabelaPreco(AcrescimoGelada: 1.00m, PrecoParcelado: 3.69m),
        },
        new ProdutoVenda(Guid.Parse("01a187d0-2b3c-7d4e-9f50-6b7c8d9e0f12"), 130, "0130", "AGUA MINERAL 500ML", "UN", 2.50m));

    /// <summary>
    /// A venda da fixture <c>venda.finalizada.gelada_parcelado.payload.json</c> (F3-B18): 2 latas geladas a 4,69 (o parcelado
    /// 3,69 + a gelada 1,00), 1 lata natural a 3,69 e 1 água a 2,50 no varejo; R$ 15,57 no crédito em 3× (Visa).
    /// </summary>
    private static Venda VendaGeladaParcelada()
    {
        var (lata, agua) = ProdutosGeladaParcelado();
        var itens = new List<ItemVenda>
        {
            new(Guid.Parse("01a187d1-3c4d-7e5f-8061-7c8d9e0f1a23"), 1, lata.Id, "0123", null, lata.Descricao, "UN", false, 2m, 4.69m, 4.69m,
                OrigemPreco.Parcelado, 9.38m, 0m, Inicio, origemEntrada: "teclado", acrescimoGelada: 1.00m),
            new(Guid.Parse("01a187d1-4d5e-7f60-9172-8d9e0f1a2b34"), 2, lata.Id, "0123", null, lata.Descricao, "UN", false, 1m, 3.69m, 3.69m,
                OrigemPreco.Parcelado, 3.69m, 0m, Inicio.AddSeconds(20), origemEntrada: "teclado"),
            new(Guid.Parse("01a187d1-5e6f-7071-8283-9e0f1a2b3c45"), 3, agua.Id, "0130", null, agua.Descricao, "UN", false, 1m, 2.50m, 2.50m,
                OrigemPreco.Varejo, 2.50m, 0m, Inicio.AddSeconds(30), origemEntrada: "teclado"),
        };
        var pagamentos = new List<PagamentoVenda>
        {
            new(Guid.Parse("01a187d2-6f70-7182-9394-0f1a2b3c4d56"), 1, CreditoFixture, "Cartão de crédito", "03", "cartao_credito", 15.57m, null, 0m,
                StatusPagamento.Aprovado, false, 2.99m, parcelas: 3, detalhe: new DetalhePagamento(2, "01", "Visa", Parcelas: 3)),
        };
        var estado = new EstadoVenda(
            Id: Guid.Parse("01a187d3-7081-7293-84a5-1a2b3c4d5e67"), Numero: 127, NumeroExibicao: "L01-C02-000127", LojaId: Loja, CaixaId: Caixa,
            NumeroCaixa: 2, TerminalId: Terminal, SessaoCaixaId: Sessao, Modo: "balcao", Status: StatusVenda.Finalizada,
            StatusFiscal: StatusFiscal.NaoAplicavel, OperadorId: Maria, TipoPreco: TipoPrecoVenda.Parcelado, DescontoTotal: 0m,
            DescontoTotalPct: null, AcrescimoTotal: 0m, IniciadaEm: Inicio, FinalizadaEm: Inicio.AddMinutes(2),
            DiaOperacional: new DateOnly(2026, 10, 29), EventoFinalizacaoId: Guid.Parse("01a187d4-8192-73a4-95b6-2b3c4d5e6f78"));
        return Venda.Restaurar(estado, itens, pagamentos);
    }

    /// <summary>A mesma venda pelas operações do caixa: Alt+G na primeira linha, a natural, a água e o crédito em 3×.</summary>
    private static Venda VendaGeladaParceladaPelasOperacoes()
    {
        var (lata, agua) = ProdutosGeladaParcelado();
        var contexto = new ContextoVenda(Terminal, Loja, 1, Caixa, 2, Sessao);
        var venda = Venda.Iniciar(Guid.CreateVersion7(), 127, contexto, Maria, Inicio);
        var gelada = venda.AdicionarItem(new ProdutoResolvido(lata), 2m, "0123", Inicio, origemEntrada: "teclado");
        venda.AlternarGelado(gelada.Sequencia);
        venda.AdicionarItem(new ProdutoResolvido(lata), 1m, "0123", Inicio, agrupar: true, origemEntrada: "teclado");
        venda.AdicionarItem(new ProdutoResolvido(agua), 1m, "0130", Inicio, origemEntrada: "teclado");
        venda.IniciarPagamento();
        var r = venda.AplicarPrecoParcelado();
        Assert.Equal((14.97m, 15.57m), (r.TotalAntes, r.TotalDepois));
        var credito = new FormaPagamentoInfo(CreditoFixture, "Cartão de crédito", "03", "cartao_credito", PermiteTroco: false, LancaQuitada: false,
            TaxaPct: 2.99m, Integracao: IntegracaoForma.PosExterno, PermiteParcelar: true, ParcelasMaximo: 6);
        venda.LancarPagamento(credito, 15.57m, Inicio, RegrasFormaPagamento.ValidarPos(credito, "01", null, null, 3));
        venda.Finalizar(Inicio.AddMinutes(2), Guid.CreateVersion7());
        return venda;
    }

    /// <summary>
    /// A venda paga da fixture <c>venda.cancelada.finalizada.payload.json</c> (L01-C02-000131, R$ 80,00, sessão da fixture
    /// de caixa): 25,00 em dinheiro, 40,00 no crédito da maquininha e 15,00 no débito, que o cliente recebe em dinheiro.
    /// </summary>
    private static Venda VendaPagaDaFormaA()
    {
        var inicio = CaixaDaFixture.Instante("2026-10-29T17:40:00.000Z");
        var credito = Guid.Parse("01a1875f-c261-7aef-afc8-9849b3aa7efe");
        var debito = Guid.Parse("01a187aa-b6c7-78d9-84e5-5f6a7b8c9dab");
        var itens = new List<ItemVenda>
        {
            new(Guid.Parse("01a18787-5b42-7c11-9d20-1e2f3a4b5c6d"), 1, Guid.Parse("01a18771-0b3c-7d42-8a6e-2f9c1d7e5a01"), "0501", null,
                "WHISKY 1L", "UN", false, 1m, 80m, 80m, OrigemPreco.Varejo, 80m, 0m, inicio, origemEntrada: "teclado"),
        };
        var pagamentos = new List<PagamentoVenda>
        {
            new(Guid.Parse("01a18788-67c3-78a7-bfd0-f9d5a6f2f7b8"), 1, Dinheiro, "Dinheiro", "01", "dinheiro", 25m, 25m, 0m, StatusPagamento.Aprovado, true, 0m),
            new(Guid.Parse("01a18788-f3a1-7c5e-8d24-6b7a8c9d0e12"), 2, credito, "Cartão de crédito", "03", "cartao_credito", 40m, null, 0m,
                StatusPagamento.Aprovado, false, 2.99m, detalhe: new DetalhePagamento(2, "01", "Visa")),
            new(Guid.Parse("01a18789-2b4c-7d6e-9f80-a1b2c3d4e5f6"), 3, debito, "Cartão de débito", "04", "cartao_debito", 15m, null, 0m,
                StatusPagamento.Aprovado, false, 1.99m, detalhe: new DetalhePagamento(2, "06", "Elo")),
        };
        var estado = new EstadoVenda(
            Id: Guid.Parse("01a18787-4a31-7ced-b171-0434134c6c92"), Numero: 131, NumeroExibicao: "L01-C02-000131", LojaId: Loja, CaixaId: Caixa,
            NumeroCaixa: 2, TerminalId: Terminal, SessaoCaixaId: Sessao, Modo: "balcao", Status: StatusVenda.Finalizada,
            StatusFiscal: StatusFiscal.NaoAplicavel, OperadorId: Maria, TipoPreco: "varejo", DescontoTotal: 0m, DescontoTotalPct: null,
            AcrescimoTotal: 0m, IniciadaEm: inicio, FinalizadaEm: inicio.AddMinutes(2), DiaOperacional: new DateOnly(2026, 10, 29),
            EventoFinalizacaoId: Guid.Parse("01a18787-6c53-7d22-8e31-2f3a4b5c6d7e"));
        return Venda.Restaurar(estado, itens, pagamentos);
    }

    private static void AssertMesmoPayload(string arquivo, EventoParaOutbox evento)
    {
        // Comparação exata, com os nulos: a fixture documenta todas as chaves que o PDV manda.
        var esperado = JsonNode.Parse(Fixtures.Sync(arquivo));
        var obtido = JsonNode.Parse(evento.Payload);
        Assert.True(JsonNode.DeepEquals(esperado, obtido), $"{arquivo}: payload diferente da fixture.\nobtido: {evento.Payload}");
        Assert.Equal(Jcs.Sha256Hex(Jcs.Serializar(esperado)), evento.PayloadSha256);
    }

    private static List<string> Chaves(JsonObject objeto) => [.. objeto.Select(p => p.Key).Order(StringComparer.Ordinal)];
}
