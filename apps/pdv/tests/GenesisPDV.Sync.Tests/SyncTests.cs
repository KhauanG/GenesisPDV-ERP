using System.Net;
using System.Text.Json.Nodes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Sync.Ativacao;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Eventos;
using GenesisPDV.Sync.Protocolo;

namespace GenesisPDV.Sync.Tests;

public class SyncTests
{
    [Fact]
    public void Jcs_ordena_chaves_por_utf16_e_nao_escapa_acentos()
    {
        var no = new JsonObject
        {
            ["b"] = "ÁGUA <&> 'x' + /",
            ["a"] = 1,
            ["é"] = true,
            ["Z"] = null,
            ["c"] = new JsonArray(2, "\u0001\n\"\\"),
        };
        Assert.Equal("{\"Z\":null,\"a\":1,\"b\":\"ÁGUA <&> 'x' + /\",\"c\":[2,\"\\u0001\\n\\\"\\\\\"],\"é\":true}", Jcs.Serializar(no));
    }

    [Fact]
    public void Jcs_recusa_numero_decimal()
    {
        Assert.Throws<InvalidOperationException>(() => Jcs.Serializar(new JsonObject { ["v"] = 41.88m }));
    }

    [Fact]
    public void Sha256_hex_minusculo()
    {
        Assert.Equal("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", Jcs.Sha256Hex("{}"));
    }

    [Fact]
    public void Payload_venda_finalizada_usa_nomes_de_coluna_e_decimais_em_string()
    {
        var agora = new DateTimeOffset(2026, 10, 29, 17, 36, 5, 123, TimeSpan.Zero);
        var venda = Venda.Iniciar(Guid.CreateVersion7(), 123, new ContextoVenda(Guid.NewGuid(), Guid.NewGuid(), 1, Guid.NewGuid(), 2, null), Guid.NewGuid(), agora);
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.NewGuid(), 1, null, "ÁGUA", "UN", 2.5m)), 2m, "789", agora);
        venda.IniciarPagamento();
        venda.LancarPagamento(new FormaPagamentoInfo(Guid.NewGuid(), "Dinheiro", "01", "dinheiro", true), 10m, agora);
        var eventoId = Guid.CreateVersion7();
        venda.Finalizar(agora, eventoId);

        var evento = FabricaEventos.VendaFinalizada(venda, eventoId);
        Assert.Equal("venda.finalizada", evento.Tipo);
        Assert.Equal(Jcs.Sha256Hex(evento.Payload), evento.PayloadSha256);
        var json = JsonNode.Parse(evento.Payload)!;
        Assert.Equal("5.00", json["vendas"]!["total"]!.GetValue<string>());
        Assert.Equal("5.00", json["vendas"]!["troco"]!.GetValue<string>());
        Assert.Equal("2.000", json["itens_venda"]![0]!["quantidade"]!.GetValue<string>());
        Assert.Equal("2.5000", json["itens_venda"]![0]!["preco_unitario"]!.GetValue<string>());
        Assert.Equal("2026-10-29T17:36:05.123Z", json["vendas"]!["finalizada_em"]!.GetValue<string>());
        Assert.Equal(eventoId.ToString(), json["vendas"]!["evento_finalizacao_id"]!.GetValue<string>());
        Assert.Contains("\"descricao\":\"ÁGUA\"", evento.Payload);
        Assert.Null(json["vendas"]!["criado_em"]);
    }

    [Fact]
    public void Payload_leva_combo_atacado_e_vasilhames()
    {
        var agora = new DateTimeOffset(2026, 10, 29, 17, 36, 5, 123, TimeSpan.Zero);
        var venda = Venda.Iniciar(Guid.CreateVersion7(), 1, new ContextoVenda(Guid.NewGuid(), Guid.NewGuid(), 1, Guid.NewGuid(), 2, null), Guid.NewGuid(), agora);
        var lata = new ProdutoVenda(Guid.NewGuid(), 1, null, "CERV", "UN", 3.49m)
        {
            Precos = new Core.Precos.TabelaPreco(PrecoAtacado: 3.19m, QtdMinimaAtacado: 12m),
        };
        venda.AdicionarItem(new ProdutoResolvido(lata), 12m, "789", agora);
        var monster = new ProdutoVenda(Guid.NewGuid(), 2, null, "MONSTER 2L", "UN", 24.90m);
        var alternativa = Guid.NewGuid();
        var posicao = Guid.NewGuid();
        var combo = new ComboResolvido(
            new ProdutoVenda(Guid.NewGuid(), 3, null, "COMBO", "UN", 129.90m) { Tipo = TipoProduto.Kit },
            [
                new PosicaoCombo(Guid.NewGuid(), "Whisky", 1m, 1, [new OpcaoCombo(null, new ProdutoVenda(Guid.NewGuid(), 4, null, "WHISKY 1L", "UN", 99.90m))]),
                new PosicaoCombo(posicao, "Energético", 1m, 2,
                    [new OpcaoCombo(null, new ProdutoVenda(Guid.NewGuid(), 5, null, "RED BULL 2L", "UN", 22.90m)), new OpcaoCombo(alternativa, monster, 2m)]),
            ]);
        venda.AdicionarCombo(combo, [0, 1], 1m, "0500", agora);
        var casco = new ProdutoVenda(Guid.NewGuid(), 6, null, "GARRAFA", "UN", 2.50m) { Tipo = TipoProduto.Vasilhame };
        var cheio = venda.AdicionarItem(
            new ProdutoResolvido(new ProdutoVenda(Guid.NewGuid(), 7, null, "CERV 600", "UN", 9.90m) { VasilhameProdutoId = casco.Id, VasilhameQuantidade = 1 }),
            3m, "600", agora);
        venda.RegistrarCascosTrazidos(cheio.Sequencia, 1m, casco, agora);
        venda.IniciarPagamento();
        venda.LancarPagamento(new FormaPagamentoInfo(Guid.NewGuid(), "Dinheiro", "01", "dinheiro", true), venda.Total, agora);
        var eventoId = Guid.CreateVersion7();
        venda.Finalizar(agora, eventoId);

        var json = JsonNode.Parse(FabricaEventos.VendaFinalizada(venda, eventoId).Payload)!;
        var itens = json["itens_venda"]!.AsArray();
        Assert.Equal("atacado", itens[0]!["origem_preco"]!.GetValue<string>());
        Assert.Equal("12.000", itens[0]!["quantidade_referencia_preco"]!.GetValue<string>());
        Assert.Null(itens[0]!["kit_grupo_id"]);
        Assert.Equal("0.0000", itens[0]!["kit_acrescimo"]!.GetValue<string>());
        Assert.Empty(itens[0]!["componentes_estoque"]!.AsArray());

        var linhaMonster = itens[2]!;
        Assert.Equal("kit_rateio", linhaMonster["origem_preco"]!.GetValue<string>());
        Assert.Equal(monster.Id.ToString(), linhaMonster["produto_id"]!.GetValue<string>());
        Assert.Equal(alternativa.ToString(), linhaMonster["kit_alternativa_id"]!.GetValue<string>());
        Assert.Equal(posicao.ToString(), linhaMonster["kit_componente_id"]!.GetValue<string>());
        Assert.Equal("2.0000", linhaMonster["kit_acrescimo"]!.GetValue<string>());
        Assert.Equal("131.9000", linhaMonster["kit_preco_unitario"]!.GetValue<string>());
        Assert.Equal("1.000", linhaMonster["kit_quantidade"]!.GetValue<string>());
        Assert.Equal("COMBO", linhaMonster["kit_descricao"]!.GetValue<string>());
        Assert.Equal(itens[1]!["kit_grupo_id"]!.GetValue<string>(), linhaMonster["kit_grupo_id"]!.GetValue<string>());

        var vasilhame = Assert.Single(json["vasilhames"]!.AsArray())!;
        Assert.Equal(casco.Id.ToString(), vasilhame["produto_vasilhame_id"]!.GetValue<string>());
        Assert.Equal(1, vasilhame["devolvidos"]!.GetValue<int>());
        Assert.Equal(2, vasilhame["vendidos"]!.GetValue<int>());
        Assert.Equal(0, vasilhame["emprestados"]!.GetValue<int>());
        Assert.Equal(cheio.Id.ToString(), itens[^1]!["vasilhame_item_origem_id"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("100001", true)]
    [InlineData("10001", false)]
    [InlineData("10000a", false)]
    public void Codigo_da_empresa_tem_seis_digitos(string codigo, bool valido) =>
        Assert.Equal(valido, FormatoAtivacao.ValidarCodigoEmpresa(codigo) is null);

    [Theory]
    [InlineData("K7M2-Q9XZ", true)]
    [InlineData("k7m2q9xz", true)]
    [InlineData("K7M2-Q9X", false)]
    [InlineData("K7M2-Q9X0", false)]
    [InlineData("K7M2-Q9XO", false)]
    [InlineData("K7M2-Q9X1", false)]
    [InlineData("K7M2-Q9XL", false)]
    public void Codigo_de_ativacao_usa_alfabeto_sem_caracteres_ambiguos(string codigo, bool valido) =>
        Assert.Equal(valido, FormatoAtivacao.ValidarCodigoAtivacao(codigo) is null);

    [Theory]
    [InlineData("https://api.genesispdv.com.br", true)]
    [InlineData("http://localhost:3000", true)]
    [InlineData("http://api.genesispdv.com.br", false)]
    [InlineData("api.genesispdv.com.br", false)]
    public void Url_do_servidor_exige_https(string url, bool valido) =>
        Assert.Equal(valido, FormatoAtivacao.ValidarUrlServidor(url) is null);

    [Fact]
    public void Normaliza_codigo_de_ativacao()
    {
        Assert.Equal("K7M2-Q9XZ", FormatoAtivacao.NormalizarCodigoAtivacao(" k7m2 q9xz "));
        Assert.Equal("K7M", FormatoAtivacao.NormalizarCodigoAtivacao("k7m"));
    }

    [Fact]
    public async Task Repeticao_de_chamada_que_altera_estado_reusa_o_mesmo_requisicao_id()
    {
        var ct = TestContext.Current.CancellationToken;
        var handler = new HandlerGravador();
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.exemplo/") };
        var cliente = new ClienteSyncHttp(http, new ConfiguracaoClienteSync("0.1.0", "linux_x64", "hw"), new RelogioSistema(), () => "token");

        var operacao = Guid.CreateVersion7();
        await cliente.AlterarAsync<JsonObject>(HttpMethod.Post, "comandas", new { numero = 1 }, operacao, ct);
        await cliente.AlterarAsync<JsonObject>(HttpMethod.Post, "comandas", new { numero = 1 }, operacao, ct);
        await cliente.PullAsync("catalogo", 0, 500, ct: ct);
        await cliente.PullAsync("catalogo", 0, 500, ct: ct);

        Assert.Equal([operacao.ToString("D"), operacao.ToString("D")], handler.Ids.Take(2));
        Assert.NotEqual(handler.Ids[2], handler.Ids[3]);
        Assert.DoesNotContain(operacao.ToString("D"), handler.Ids.Skip(2));
        await Assert.ThrowsAsync<ArgumentException>(() => cliente.AlterarAsync<JsonObject>(HttpMethod.Post, "comandas", null, Guid.Empty, ct));
    }

    private sealed class HandlerGravador : HttpMessageHandler
    {
        public List<string> Ids { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Ids.Add(request.Headers.GetValues("X-Requisicao-Id").Single());
            var corpo = request.RequestUri!.AbsolutePath.EndsWith("pull", StringComparison.Ordinal)
                ? "{\"fluxo\":\"catalogo\",\"desde\":0,\"novo_cursor\":0,\"tem_mais\":false,\"cursor_teto\":0,\"agora_servidor\":\"2026-10-30T00:00:00.000Z\",\"alteracoes\":[]}"
                : "{}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(corpo, System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }
}
