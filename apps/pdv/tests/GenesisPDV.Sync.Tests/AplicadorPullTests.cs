using System.Text.Json;
using System.Text.Json.Nodes;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Protocolo;
using GenesisPDV.Sync.Pull;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

namespace GenesisPDV.Sync.Tests;

/// <summary>Aplicação local de uma página do pull (SYNC 6.6, 6.10; MD 3.5.4): versão, tombstone, escala, desconhecidos, queda.</summary>
public sealed class AplicadorPullTests
{
    private const string Produto = "01a18760-0b0e-7c1a-9a51-0d9c2f1b7e01";
    private const string Pessoa = "01a18770-0000-7000-8000-000000000001";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static RespostaPull Pagina(string fluxo, long novoCursor, params (string Tabela, long Versao, JsonObject Linha)[] alteracoes) =>
        new(fluxo, 0, novoCursor, TemMais: false, CursorTeto: novoCursor, "2026-10-31T12:00:00.000Z",
            [.. alteracoes.Select(a => new AlteracaoPull(a.Tabela, a.Versao, JsonSerializer.SerializeToElement(a.Linha)))]);

    private static JsonObject ProdutoLinha(string nome, string preco, string? excluido = null) => new()
    {
        ["id"] = Produto,
        ["codigo"] = 1045,
        ["nome"] = nome,
        ["tipo"] = "simples",
        ["ativo"] = true,
        ["unidade_id"] = "01a18760-0000-7000-8000-0000000000aa",
        ["preco_venda"] = preco,
        ["qtd_minima_atacado"] = "12.000",
        ["criado_em"] = "2026-10-01T12:00:00.000Z",
        ["atualizado_em"] = "2026-10-29T17:39:58.311Z",
        ["excluido_em"] = excluido,
    };

    private static async Task<long> CursorAsync(AmbienteSync amb, string fluxo)
    {
        await using var db = amb.Fabrica.CreateDbContext();
        // Sem ativação não há linha do fluxo: cursor 0 (a página que falhou não criou a linha).
        return (await db.EstadoSincronizacao.SingleOrDefaultAsync(e => e.Fluxo == fluxo, Ct))?.Cursor ?? 0;
    }

    [Fact]
    public async Task Fixture_do_contrato_aplica_e_o_cursor_avanca_no_mesmo_commit()
    {
        using var amb = await AmbienteSync.CriarAsync();
        var pagina = Fixtures.Ler<RespostaPull>("pull.catalogo.resposta.json");
        var r = await amb.Aplicador.AplicarAsync(pagina, ct: Ct);
        Assert.Equal(new ResultadoPaginaEsperado(3, 3), new ResultadoPaginaEsperado(r.Recebidas, r.Gravadas));
        await using var db = amb.Fabrica.CreateDbContext();
        var produto = await db.Produtos.SingleAsync(Ct);
        Assert.Equal(4.99m, produto.PrecoVenda);
        Assert.Equal(12m, produto.QtdMinimaAtacado);
        Assert.Equal(1880101, produto.Versao);
        Assert.Equal(4.79m, (await db.ProdutosLojas.SingleAsync(Ct)).PrecoVenda);
        // Tombstone: a linha excluída fica gravada com excluido_em (o PDV filtra nas telas).
        Assert.NotNull((await db.ProdutosCodigosBarras.SingleAsync(Ct)).ExcluidoEm);
        var estado = await db.EstadoSincronizacao.SingleAsync(e => e.Fluxo == "catalogo", Ct);
        Assert.Equal(1880412, estado.Cursor);
        Assert.Equal(3, estado.LinhasRecebidas);
        Assert.NotNull(estado.UltimoPullSucessoEm);
        Assert.False(estado.CargaInicialConcluida);
    }

    private sealed record ResultadoPaginaEsperado(int Recebidas, int Gravadas);

    [Fact]
    public async Task Versao_maior_substitui_menor_ou_igual_e_ignorada_e_tombstone_grava_a_exclusao()
    {
        using var amb = await AmbienteSync.CriarAsync();
        await amb.Aplicador.AplicarAsync(Pagina("catalogo", 10, ("produtos", 10, ProdutoLinha("CERVEJA", "4.9900"))), ct: Ct);
        await amb.Aplicador.AplicarAsync(Pagina("catalogo", 20, ("produtos", 20, ProdutoLinha("CERVEJA NOVA", "5.4900"))), ct: Ct);
        // Reentrega de uma versão velha (página repetida depois de queda, ou fora de ordem): não volta o cadastro.
        var velha = await amb.Aplicador.AplicarAsync(Pagina("catalogo", 20, ("produtos", 15, ProdutoLinha("CERVEJA VELHA", "1.0000"))), ct: Ct);
        Assert.Equal(0, velha.Gravadas);
        Assert.Equal(1, velha.Ignoradas);
        Assert.Equal("CERVEJA NOVA", amb.Escalar($"select nome from produtos where id = '{Produto}'"));
        Assert.Equal(54900L, amb.Escalar($"select preco_venda from produtos where id = '{Produto}'"));

        await amb.Aplicador.AplicarAsync(Pagina("catalogo", 30, ("produtos", 30, ProdutoLinha("CERVEJA NOVA", "5.4900", "2026-10-31T10:00:00.000Z"))), ct: Ct);
        Assert.Equal(1L, amb.Contar("produtos"));
        Assert.Equal("2026-10-31T10:00:00.000Z", amb.Escalar($"select excluido_em from produtos where id = '{Produto}'"));
        Assert.Equal(30L, amb.Escalar($"select versao from produtos where id = '{Produto}'"));
    }

    [Fact]
    public async Task Coluna_e_tabela_desconhecidas_sao_ignoradas_com_log_e_o_cursor_avanca()
    {
        using var amb = await AmbienteSync.CriarAsync();
        var linha = ProdutoLinha("CERVEJA", "4.9900");
        linha["coluna_da_api_nova"] = "x";
        var r = await amb.Aplicador.AplicarAsync(Pagina(
            "catalogo", 50,
            ("produtos", 10, linha),
            ("promocoes", 11, new JsonObject { ["id"] = Guid.CreateVersion7().ToString("D"), ["nome"] = "Leve 3" }),
            ("vendas", 12, new JsonObject { ["id"] = Guid.CreateVersion7().ToString("D") })), ct: Ct);
        Assert.Equal(1, r.Gravadas);
        Assert.Equal(2, r.Ignoradas);
        Assert.Equal(1L, amb.Contar("produtos"));
        Assert.Equal(0L, amb.Contar("vendas"));
        Assert.Equal(50, await CursorAsync(amb, "catalogo"));
        Assert.Contains(amb.Log.Linhas, l => l.Contains("promocoes", StringComparison.Ordinal) && l.Contains("desconhecida", StringComparison.Ordinal));
        Assert.Contains(amb.Log.Linhas, l => l.Contains("coluna_da_api_nova", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Coluna_ausente_mantem_o_valor_local_e_criado_localmente_nunca_vem_da_nuvem()
    {
        using var amb = await AmbienteSync.CriarAsync();
        await amb.Aplicador.AplicarAsync(Pagina("catalogo", 10, ("produtos", 10, ProdutoLinha("CERVEJA", "4.9900"))), ct: Ct);
        amb.Escalar($"update produtos set criado_localmente = 1 where id = '{Produto}'");

        // Versão não maior: nada muda, nem a marca local (mesmo com a coluna na linha).
        await amb.Aplicador.AplicarAsync(Pagina("catalogo", 20, ("produtos", 10, new JsonObject { ["id"] = Produto, ["nome"] = "VELHO", ["criado_localmente"] = false })), ct: Ct);
        Assert.Equal(1L, amb.Escalar($"select criado_localmente from produtos where id = '{Produto}'"));
        Assert.Equal("CERVEJA", amb.Escalar($"select nome from produtos where id = '{Produto}'"));

        // Versão maior: a linha passa a ser a da nuvem (MD 4.2, `criado_localmente = 0`), o valor que veio na linha é
        // ignorado e a coluna ausente mantém o valor local.
        await amb.Aplicador.AplicarAsync(Pagina("catalogo", 30, ("produtos", 30, new JsonObject { ["id"] = Produto, ["nome"] = "SÓ O NOME", ["criado_localmente"] = true })), ct: Ct);
        Assert.Equal("SÓ O NOME", amb.Escalar($"select nome from produtos where id = '{Produto}'"));
        Assert.Equal(49900L, amb.Escalar($"select preco_venda from produtos where id = '{Produto}'"));
        Assert.Equal(0L, amb.Escalar($"select criado_localmente from produtos where id = '{Produto}'"));
        Assert.Contains(amb.Log.Linhas, l => l.Contains("produtos.criado_localmente", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Decimal_vira_inteiro_na_escala_da_coluna_e_casa_a_mais_desfaz_a_pagina_inteira()
    {
        using var amb = await AmbienteSync.CriarAsync();
        await amb.Aplicador.AplicarAsync(Pagina("acesso", 5, ("usuarios", 5, new JsonObject
        {
            ["id"] = Guid.CreateVersion7().ToString("D"),
            ["codigo"] = 7,
            ["nome"] = "MARIA",
            ["login"] = "maria",
            ["limite_desconto_pct"] = "12.5000",
            ["comissao_pct"] = "0.0000",
            ["ativo"] = true,
            ["master"] = false,
        })), ct: Ct);
        Assert.Equal(125000L, amb.Escalar("select limite_desconto_pct from usuarios"));
        Assert.Equal(1L, amb.Escalar("select ativo from usuarios"));

        // preco_venda tem escala 4: "4.99001" não grava sem arredondar → a página toda volta e o cursor fica.
        var ruim = Pagina("catalogo", 99,
            ("produtos_lojas", 90, new JsonObject { ["id"] = Guid.CreateVersion7().ToString("D"), ["produto_id"] = Produto, ["loja_id"] = ApiFalsa.LojaId.ToString("D"), ["preco_venda"] = "4.7900" }),
            ("produtos", 91, ProdutoLinha("CERVEJA", "4.99001")));
        await Assert.ThrowsAsync<InvalidOperationException>(() => amb.Aplicador.AplicarAsync(ruim, ct: Ct));
        Assert.Equal(0L, amb.Contar("produtos_lojas"));
        Assert.Equal(0, await CursorAsync(amb, "catalogo"));
    }

    [Fact]
    public async Task Queda_entre_paginas_mantem_a_primeira_e_a_segunda_vem_de_novo_do_cursor_salvo()
    {
        using var amb = await AmbienteSync.CriarAsync();
        Assert.True((await amb.AtivarAsync()).Ativado);
        for (var i = 0; i < 5; i++)
        {
            amb.Api.Publicar("catalogo", "marcas", new JsonObject { ["id"] = Guid.CreateVersion7().ToString("D"), ["descricao"] = $"MARCA {i}", ["excluido_em"] = null });
        }

        // 1ª página (2 linhas) grava; a 2ª cai na rede.
        var paginas = 0;
        amb.Api.AoPuxar = e => ++paginas == 2 ? throw new HttpRequestException("rede caiu") : null;
        var primeira = await amb.Cliente.PullAsync("catalogo", 0, 2, ct: Ct);
        await amb.Aplicador.AplicarAsync(primeira, cargaInicial: true, ct: Ct);
        await Assert.ThrowsAsync<HttpRequestException>(() => amb.Cliente.PullAsync("catalogo", primeira.NovoCursor, 2, primeira.CursorTeto, Ct));
        Assert.Equal(2L, amb.Contar("marcas"));
        Assert.Equal(primeira.NovoCursor, await CursorAsync(amb, "catalogo"));

        // Volta: continua do cursor; reentregar a 1ª página (idempotente) não duplica nada.
        await amb.Aplicador.AplicarAsync(primeira, ct: Ct);
        var resto = await amb.Cliente.PullAsync("catalogo", await CursorAsync(amb, "catalogo"), 10, primeira.CursorTeto, Ct);
        await amb.Aplicador.AplicarAsync(resto, ct: Ct);
        Assert.Equal(5L, amb.Contar("marcas"));
        Assert.Equal(resto.CursorTeto, await CursorAsync(amb, "catalogo"));
    }

    [Fact]
    public async Task Relevancia_excluida_purga_a_pessoa_e_so_funcionario_purga_o_contato()
    {
        using var amb = await AmbienteSync.CriarAsync();
        var relManual = Guid.CreateVersion7().ToString("D");
        var relFuncionario = Guid.CreateVersion7().ToString("D");
        JsonObject Relevancia(string id, string motivo, string? excluido = null) => new()
        {
            ["id"] = id,
            ["pessoa_id"] = Pessoa,
            ["loja_id"] = null,
            ["motivo"] = motivo,
            ["ultima_ocorrencia_em"] = "2026-10-31T12:00:00.000Z",
            ["excluido_em"] = excluido,
        };
        JsonObject Filha(string extra) => new() { ["id"] = Guid.CreateVersion7().ToString("D"), ["pessoa_id"] = Pessoa, [extra] = extra == "ddd" ? "41" : "funcionario" };
        var telefone = Filha("ddd");
        telefone["numero"] = "999990000";
        await amb.Aplicador.AplicarAsync(Pagina("pessoas", 10,
            ("pessoas_relevancia_loja", 1, Relevancia(relManual, "manual")),
            ("pessoas_relevancia_loja", 2, Relevancia(relFuncionario, "funcionario")),
            ("pessoas", 3, new JsonObject { ["id"] = Pessoa, ["nome"] = "JOÃO", ["tipo"] = "PF" }),
            ("pessoas_telefones", 4, telefone),
            ("pessoas_categorias", 5, Filha("categoria"))), ct: Ct);
        Assert.Equal(1L, amb.Contar("pessoas_telefones"));

        // Sai a relevância manual: sobra a de funcionário → pessoa fica, telefone sai (D19).
        var r = await amb.Aplicador.AplicarAsync(Pagina("pessoas", 20, ("pessoas_relevancia_loja", 11, Relevancia(relManual, "manual", "2026-10-31T13:00:00.000Z"))), ct: Ct);
        Assert.Equal(0, r.PessoasPurgadas);
        Assert.Equal(1L, amb.Contar("pessoas"));
        Assert.Equal(0L, amb.Contar("pessoas_telefones"));
        Assert.Equal(1L, amb.Contar("pessoas_categorias"));

        // Evento local pendente da pessoa (ex.: cadastro rápido ainda não confirmado) a segura no espelho; confirmado,
        // a última relevância excluída purga a pessoa e as filhas.
        var evento = new EventoSaida
        {
            Id = Guid.CreateVersion7(),
            SequenciaTerminal = 1,
            Tipo = "pessoa.criada_no_caixa",
            AgregadoTipo = "pessoa",
            AgregadoId = Guid.Parse(Pessoa),
            OcorridoEm = DateTimeOffset.UtcNow,
            CriadoEm = DateTimeOffset.UtcNow,
            PayloadSha256 = new string('0', 64),
        };
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            db.EventosSaida.Add(evento);
            await db.SaveChangesAsync(Ct);
        }

        var semPurga = await amb.Aplicador.AplicarAsync(Pagina("pessoas", 30, ("pessoas_relevancia_loja", 21, Relevancia(relFuncionario, "funcionario", "2026-10-31T14:00:00.000Z"))), ct: Ct);
        Assert.Equal(0, semPurga.PessoasPurgadas);
        Assert.Equal(1L, amb.Contar("pessoas"));
        amb.Escalar($"update eventos_saida set status = 'confirmado' where id = '{evento.Id:D}'");
        // A versão igual não regrava a relevância, mas a página reaplica a regra da purga.
        var purga = await amb.Aplicador.AplicarAsync(Pagina("pessoas", 40, ("pessoas_relevancia_loja", 21, Relevancia(relFuncionario, "funcionario", "2026-10-31T14:00:00.000Z"))), ct: Ct);
        Assert.Equal(0, purga.Gravadas);
        Assert.Equal(1, purga.PessoasPurgadas);
        Assert.Equal(0L, amb.Contar("pessoas"));
        Assert.Equal(0L, amb.Contar("pessoas_categorias"));
        Assert.Equal(2L, amb.Contar("pessoas_relevancia_loja"));
    }

    private const string Fiado = "01a18780-0000-7000-8000-000000000001";
    private const string Dinheiro = "01a18780-0000-7000-8000-000000000002";

    private static JsonObject Forma(string id, string descricao, int ordem, bool ativa = true) => new()
    {
        ["id"] = id,
        ["descricao"] = descricao,
        ["ordem"] = ordem,
        ["tipo_forma"] = "outros",
        ["meio_pagamento_fiscal"] = "99",
        ["integracao"] = "nenhuma",
        ["taxa_pct"] = "0.0000",
        ["lanca_quitada"] = true,
        ["ativa"] = ativa,
        ["usa_pdv"] = true,
        ["parcelas_maximo"] = 1,
        ["exige_supervisor"] = true,
        ["criado_em"] = "2026-10-31T12:00:00.000Z",
        ["atualizado_em"] = "2026-10-31T12:00:00.000Z",
        ["excluido_em"] = null,
    };

    private static JsonObject Vinculo(string id, string formaId, string? lojaId, string? excluido = null) => new()
    {
        ["id"] = id,
        ["forma_pagamento_id"] = formaId,
        ["loja_id"] = lojaId,
        ["criado_em"] = "2026-10-31T12:00:00.000Z",
        ["atualizado_em"] = "2026-10-31T12:00:00.000Z",
        ["excluido_em"] = excluido,
    };

    [Fact]
    public async Task Formas_da_loja_o_pull_aplica_o_vinculo_e_a_exclusao_do_vinculo_tira_a_forma_do_caixa()
    {
        // Fase 1C (C8b, O9a/D25): a forma vale no caixa com um vínculo vivo de "todas" (loja nula) ou da loja do
        // terminal; a exclusão do vínculo desce e a forma some da tela, sem apagar a linha (as vendas antigas a citam).
        using var amb = await AmbienteSync.CriarAsync();
        var catalogo = new CatalogoLocal(amb.Fabrica);
        const string loja = "01a18780-0000-7000-8000-0000000000a9";
        var vTodas = Guid.CreateVersion7().ToString("D");
        var vLoja = Guid.CreateVersion7().ToString("D");
        await amb.Aplicador.AplicarAsync(Pagina(
            "configuracao", 40,
            ("formas_pagamento", 10, Forma(Dinheiro, "Dinheiro", 1)),
            ("formas_pagamento_lojas", 11, Vinculo(vTodas, Dinheiro, null)),
            ("formas_pagamento_lojas", 20, Vinculo(vLoja, Fiado, loja)),
            ("formas_pagamento", 21, Forma(Fiado, "Fiado Balcão", 20))), ct: Ct);
        var formas = await catalogo.FormasPagamentoAsync(Ct);
        Assert.Equal(["Dinheiro", "Fiado Balcão"], formas.Select(f => f.Descricao));
        Assert.True(formas[1].ExigeSupervisor);

        // A loja saiu da forma (e a forma inativa também não aparece): o vínculo chega excluído.
        await amb.Aplicador.AplicarAsync(Pagina(
            "configuracao", 60,
            ("formas_pagamento_lojas", 50, Vinculo(vLoja, Fiado, loja, "2026-10-31T15:00:00.000Z"))), ct: Ct);
        Assert.Equal(["Dinheiro"], (await catalogo.FormasPagamentoAsync(Ct)).Select(f => f.Descricao));
        Assert.Equal(2L, amb.Contar("formas_pagamento"));
        await amb.Aplicador.AplicarAsync(Pagina("configuracao", 70, ("formas_pagamento", 61, Forma(Dinheiro, "Dinheiro", 1, ativa: false))), ct: Ct);
        Assert.Empty(await catalogo.FormasPagamentoAsync(Ct));
    }

    [Fact]
    public async Task Pdv_anterior_descartou_vinculo_e_coluna_e_avancou_o_cursor_a_migracao_faz_o_pull_baixar_de_novo()
    {
        // SYNC 17.4.2 (C8b): a API com a 0014 chega antes do app novo. O PDV anterior descarta a tabela e a coluna que
        // não conhece e avança o cursor; a migração EF volta o cursor de `configuracao` e a versão das formas a 0, e o
        // pull do app novo grava de novo a mesma página (vínculo e `exige_supervisor`).
        using var amb = await AmbienteSync.CriarAteAsync("20261031155633_LiberacoesVenda");
        var pagina = Pagina(
            "configuracao", 40,
            ("formas_pagamento", 10, Forma(Fiado, "PIX manual", 1)),
            ("formas_pagamento_lojas", 11, Vinculo(Guid.CreateVersion7().ToString("D"), Fiado, null)));
        var antiga = await amb.Aplicador.AplicarAsync(pagina, ct: Ct);
        Assert.Equal((1, 1), (antiga.Gravadas, antiga.Ignoradas));
        Assert.Equal(40L, await CursorAsync(amb, "configuracao"));

        await amb.MigrarAsync();
        Assert.Equal(0L, await CursorAsync(amb, "configuracao"));
        var catalogo = new CatalogoLocal(amb.Fabrica);
        Assert.Empty(await catalogo.FormasPagamentoAsync(Ct));

        // O app novo é outro processo: outro aplicador, sem as colunas locais em cache da versão anterior.
        var aplicador = new AplicadorPull(amb.Fabrica, amb.Relogio, NullLogger<AplicadorPull>.Instance);
        var nova = await aplicador.AplicarAsync(pagina, ct: Ct);
        Assert.Equal((2, 0), (nova.Gravadas, nova.Ignoradas));
        var formas = await catalogo.FormasPagamentoAsync(Ct);
        Assert.Equal(["PIX manual"], formas.Select(f => f.Descricao));
        Assert.True(formas[0].ExigeSupervisor);
        Assert.Equal(40L, await CursorAsync(amb, "configuracao"));
    }

    [Fact]
    public async Task Lotes_e_saldo_por_lote_descidos_sao_gravados_e_a_venda_dividida_em_FEFO_na_nuvem_atualiza_cada_lote()
    {
        // Fase 2 (F2-B6): o motor da nuvem passa a gravar `saldos_lote` (a venda do PDV-1, sem lote, é dividida em FEFO
        // por lote); o PDV só espelha, sem tabela nem coluna nova e sem volta de cursor. Este teste confere a gravação
        // do que desce (o lote do estoque da loja e o sem estoque, e os saldos de cada um). O filtro (só os lotes da
        // loja ou sem estoque; só o saldo do estoque da loja e de tipo vendável) é da API e é conferido lá
        // (`lotes-motor.test.ts`): aqui as páginas já chegam filtradas.
        using var amb = await AmbienteSync.CriarAsync();
        const string estoque = "01a18790-0000-7000-8000-0000000000e1";
        const string tipo = "01a18790-0000-7000-8000-0000000000d1";
        var loteA = Guid.CreateVersion7().ToString("D");
        var loteB = Guid.CreateVersion7().ToString("D");
        JsonObject Lote(string id, string codigo, string? estoqueId, string validade) => new()
        {
            ["id"] = id,
            ["produto_id"] = Produto,
            ["variacao_id"] = null,
            ["estoque_id"] = estoqueId,
            ["lote"] = codigo,
            ["validade"] = validade,
            ["fabricacao"] = null,
            ["fornecedor_id"] = null,
            ["ativo"] = true,
            ["criado_em"] = "2026-11-04T12:00:00.000Z",
            ["atualizado_em"] = "2026-11-04T12:00:00.000Z",
            ["excluido_em"] = null,
        };
        JsonObject Saldo(string id, string lote, string quantidade) => new()
        {
            ["id"] = id,
            ["estoque_id"] = estoque,
            ["produto_id"] = Produto,
            ["variacao_id"] = null,
            ["lote_id"] = lote,
            ["tipo_estoque_id"] = tipo,
            ["quantidade"] = quantidade,
            ["criado_em"] = "2026-11-04T12:00:00.000Z",
            ["atualizado_em"] = "2026-11-04T12:30:00.000Z",
        };
        var saldoA = Guid.CreateVersion7().ToString("D");
        var saldoB = Guid.CreateVersion7().ToString("D");
        await amb.Aplicador.AplicarAsync(Pagina(
            "catalogo", 20,
            ("produtos_lotes", 10, Lote(loteA, "A-2612", estoque, "2026-12-01")),
            ("produtos_lotes", 11, Lote(loteB, "B-2701", null, "2027-01-10"))), ct: Ct);
        await amb.Aplicador.AplicarAsync(Pagina(
            "estoque", 30,
            ("saldos_lote", 21, Saldo(saldoA, loteA, "6.000")),
            ("saldos_lote", 22, Saldo(saldoB, loteB, "8.000"))), ct: Ct);
        // A venda de 10 na nuvem: 6 de A (vence antes) e 4 de B; as duas linhas sobem de versão e descem de novo.
        var r = await amb.Aplicador.AplicarAsync(Pagina(
            "estoque", 40,
            ("saldos_lote", 31, Saldo(saldoA, loteA, "0.000")),
            ("saldos_lote", 32, Saldo(saldoB, loteB, "4.000"))), ct: Ct);
        Assert.Equal(2, r.Gravadas);
        await using var db = amb.Fabrica.CreateDbContext();
        var lotes = await db.Set<ProdutoLoteRegistro>().OrderBy(l => l.Validade).ToListAsync(Ct);
        Assert.Equal(["A-2612", "B-2701"], lotes.Select(l => l.Lote));
        Assert.Null(lotes[1].EstoqueId);
        var saldos = await db.Set<SaldoLoteRegistro>().ToDictionaryAsync(s => s.LoteId.ToString("D"), s => s.Quantidade, Ct);
        Assert.Equal(new Dictionary<string, decimal> { [loteA] = 0m, [loteB] = 4m }, saldos);
        Assert.Equal(40, await CursorAsync(amb, "estoque"));
    }
}
