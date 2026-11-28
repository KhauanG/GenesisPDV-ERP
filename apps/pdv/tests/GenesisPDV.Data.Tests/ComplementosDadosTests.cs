using System.Text.Json.Nodes;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Complementos no caixa (PDV 10.2; Fase 3, F3-B15), lado do banco: o catálogo monta os grupos vivos com as opções ativas
/// a partir dos espelhos, a venda grava os complementos na tabela local <c>itens_venda_complementos</c> (migração
/// <c>ComplementosVenda</c>) e volta com eles depois de uma queda, com o snapshot achando o vinculado e a ficha.
/// </summary>
public class ComplementosDadosTests
{
    private static readonly Guid Loja = Guid.Parse("019a0005-0000-7000-8000-000000000001");
    private static readonly Guid Un = Guid.CreateVersion7();
    private static readonly Guid Porcao = Guid.CreateVersion7();
    private static readonly Guid Molho = Guid.CreateVersion7();
    private static readonly Guid Cheddar = Guid.CreateVersion7();
    private static readonly Guid Queijo = Guid.CreateVersion7();
    private static readonly Guid Excluido = Guid.CreateVersion7();
    private static readonly Guid GrupoMolhos = Guid.CreateVersion7();
    private static readonly Guid GrupoAdicionais = Guid.CreateVersion7();
    private static readonly Guid GrupoSemOpcao = Guid.CreateVersion7();
    private static readonly Guid GrupoExcluido = Guid.CreateVersion7();
    private static readonly Guid OpcaoBarbecue = Guid.CreateVersion7();
    private static readonly Guid OpcaoRose = Guid.CreateVersion7();
    private static readonly Guid OpcaoInativa = Guid.CreateVersion7();
    private static readonly Guid OpcaoCheddar = Guid.CreateVersion7();
    private static readonly Guid OpcaoBacon = Guid.CreateVersion7();
    private static readonly Guid OpcaoSemProduto = Guid.CreateVersion7();

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<(BancoTemporario Banco, CatalogoLocal Catalogo)> CriarAsync()
    {
        var banco = new BancoTemporario();
        await banco.InicializarAsync();
        await new RepositorioTerminal(banco.Fabrica, banco.Relogio).RegistrarAtivacaoAsync(new IdentidadeTerminal
        {
            TerminalId = Guid.CreateVersion7(),
            LojaId = Loja,
            CaixaId = Guid.CreateVersion7(),
            NumeroCaixa = 2,
            UrlApi = "demonstracao://local",
            AtivadoEm = banco.Relogio.Agora,
            NomeMaquina = "teste",
        }, Ct);
        LinhaEspelho[] linhas =
        [
            new UnidadeMedidaRegistro { Id = Un, Sigla = "UN", Descricao = "Unidade" },
            Produto(Porcao, 300, "PORÇÃO DE FRITAS", 25.00m, p => p.Tipo = TipoProduto.ComComplementos),
            Produto(Molho, 301, "MOLHO BARBECUE 1KG", 18.00m, p => p.Tipo = TipoProduto.MateriaPrima),
            Produto(Cheddar, 302, "CHEDDAR CREMOSO", 0m, p => p.Tipo = TipoProduto.Produzido),
            Produto(Queijo, 303, "QUEIJO CHEDDAR KG", 40.00m, p => p.Tipo = TipoProduto.MateriaPrima),
            Produto(Excluido, 304, "MOLHO DESCONTINUADO", 1.00m, p => p.ExcluidoEm = DateTimeOffset.UnixEpoch),
            new ProdutoComponenteRegistro
            {
                Id = Guid.CreateVersion7(), ProdutoId = Cheddar, Tipo = "ficha_tecnica", ComponenteId = Queijo, Quantidade = 0.080m, PerdaPct = 5m, Ordem = 1,
            },
            new ProdutoGrupoComplementosRegistro { Id = GrupoAdicionais, ProdutoId = Porcao, Nome = "Adicionais", Minimo = 0, Maximo = 2, Ordem = 2 },
            new ProdutoGrupoComplementosRegistro { Id = GrupoMolhos, ProdutoId = Porcao, Nome = "Molhos", Minimo = 1, Maximo = 2, Obrigatorio = true, Ordem = 1 },
            new ProdutoGrupoComplementosRegistro { Id = GrupoSemOpcao, ProdutoId = Porcao, Nome = "Sem opção ativa", Minimo = 0, Maximo = 1, Ordem = 3 },
            new ProdutoGrupoComplementosRegistro
            {
                Id = GrupoExcluido, ProdutoId = Porcao, Nome = "Excluído", Minimo = 0, Maximo = 1, Ordem = 4, ExcluidoEm = DateTimeOffset.UnixEpoch,
            },
            Opcao(OpcaoRose, GrupoMolhos, null, "Rosé", 0m, ordem: 2),
            Opcao(OpcaoBarbecue, GrupoMolhos, Molho, null, 0m, ordem: 1, baixa: true, quantidadeBaixa: 0.050m),
            Opcao(OpcaoInativa, GrupoMolhos, null, "Molho antigo", 0m, ordem: 3, ativo: false),
            Opcao(OpcaoSemProduto, GrupoMolhos, Excluido, null, 0m, ordem: 4),
            Opcao(OpcaoCheddar, GrupoAdicionais, Cheddar, null, 4.50m, ordem: 1, baixa: true),
            Opcao(OpcaoBacon, GrupoAdicionais, null, "Bacon", 3.00m, ordem: 2),
            Opcao(Guid.CreateVersion7(), GrupoSemOpcao, null, "Inativa", 0m, ordem: 1, ativo: false),
            Opcao(Guid.CreateVersion7(), GrupoExcluido, null, "Do grupo excluído", 0m, ordem: 1),
        ];
        foreach (var linha in linhas)
        {
            linha.CriadoEm = linha.AtualizadoEm = banco.Relogio.Agora;
            linha.Versao = 1;
        }

        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(linhas, Ct);
        return (banco, new CatalogoLocal(banco.Fabrica));
    }

    private static ProdutoRegistro Produto(Guid id, int codigo, string nome, decimal preco, Action<ProdutoRegistro>? ajustar = null)
    {
        var p = new ProdutoRegistro { Id = id, Codigo = codigo, CodigoInterno = $"{codigo:0000}", Nome = nome, UnidadeId = Un, PrecoVenda = preco };
        ajustar?.Invoke(p);
        return p;
    }

    private static ProdutoComplementoRegistro Opcao(
        Guid id, Guid grupo, Guid? produto, string? descricao, decimal adicional, int ordem, bool baixa = false, decimal quantidadeBaixa = 1m,
        bool ativo = true) =>
        new()
        {
            Id = id,
            GrupoId = grupo,
            ProdutoId = produto,
            Descricao = descricao,
            PrecoAdicional = adicional,
            BaixaEstoque = baixa,
            QuantidadeBaixa = quantidadeBaixa,
            Ordem = ordem,
            Ativo = ativo,
        };

    [Fact]
    public async Task Catalogo_traz_os_grupos_vivos_com_as_opcoes_ativas_o_nome_do_vinculado_e_a_ficha_do_produzido()
    {
        var (banco, catalogo) = await CriarAsync();
        using var _ = banco;

        var porcao = Assert.Single(await catalogo.ResolverAsync("0300", Ct)).Produto;

        Assert.True(RegrasComplementos.TemComplementos(porcao));
        // O grupo sem opção ativa e o excluído ficam de fora; a ordem é a do cadastro.
        Assert.Equal(["Molhos", "Adicionais"], porcao.GruposComplementos!.Select(g => g.Nome));
        var molhos = porcao.GruposComplementos![0];
        Assert.Equal((1, 2, true, 1), (molhos.Minimo, molhos.Maximo, molhos.Obrigatorio, molhos.MinimoEfetivo));
        // O vinculado sem descrição leva o nome do produto; a inativa e a do vinculado excluído não aparecem.
        Assert.Equal(["MOLHO BARBECUE 1KG", "Rosé"], molhos.Opcoes.Select(o => o.Descricao));
        var barbecue = molhos.Opcoes[0];
        Assert.Equal((Molho, true, 0.050m, true, (IReadOnlyList<ComponenteFicha>?)null),
            (barbecue.ProdutoId!.Value, barbecue.BaixaEstoque, barbecue.QuantidadeBaixa, barbecue.VinculadoComSaldo, barbecue.FichaVinculado));
        var cheddar = porcao.GruposComplementos![1].Opcoes[0];
        Assert.Equal((4.50m, false), (cheddar.PrecoAdicional, cheddar.VinculadoComSaldo));
        Assert.Equal([new ComponenteFicha(Queijo, null, 0.080m, 5m)], cheddar.FichaVinculado);
        // Produto que não é "com complementos" não carrega grupo.
        Assert.Null((await catalogo.ObterAsync(Molho, Ct))!.GruposComplementos);
    }

    [Fact]
    public async Task Venda_com_complementos_gravada_volta_com_eles_e_o_snapshot_acha_a_ficha()
    {
        var (banco, catalogo) = await CriarAsync();
        using var _ = banco;
        var agora = banco.Relogio.Agora;
        var repo = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var contexto = new ContextoVenda(Guid.CreateVersion7(), Loja, 1, Guid.CreateVersion7(), 2, null);
        var venda = Venda.Iniciar(Guid.CreateVersion7(), await repo.ReservarNumeroVendaAsync(Ct), contexto, Guid.CreateVersion7(), agora);
        var porcao = Assert.Single(await catalogo.ResolverAsync("0300", Ct));

        var item = venda.AdicionarItem(porcao, 2m, "0300", agora, complementos: [OpcaoRose, OpcaoBarbecue, OpcaoCheddar]);
        venda.AdicionarItem(porcao, 1m, "0300", agora, complementos: [OpcaoRose]);
        await repo.SalvarEmAndamentoAsync(venda, ct: Ct);

        Assert.Equal(4L, banco.Escalar("select count(*) from itens_venda_complementos"));
        Assert.Equal(45000L, banco.Escalar($"select preco_adicional from itens_venda_complementos where complemento_id = '{OpcaoCheddar}'"));
        Assert.Equal(1000L, banco.Escalar($"select quantidade from itens_venda_complementos where complemento_id = '{OpcaoCheddar}'"));
        Assert.Equal("Adicionais", banco.Escalar($"select grupo_nome from itens_venda_complementos where complemento_id = '{OpcaoCheddar}'"));

        var recuperada = (await repo.ObterVendaAtualAsync(Ct))!;
        var volta = recuperada.ObterItem(item.Sequencia);
        Assert.Equal((29.50m, 59.00m, 84.00m), (volta.PrecoUnitario, volta.ValorBruto, recuperada.Total));
        // A ordem do cadastro (grupo, depois a opção) volta igual: os ids das linhas seguem a ordem da escolha.
        Assert.Equal(item.Complementos, volta.Complementos);
        Assert.Equal(["MOLHO BARBECUE 1KG", "Rosé", "CHEDDAR CREMOSO"], volta.Complementos.Select(c => c.Descricao));
        recuperada.RegistrarProdutos(await repo.ObterSnapshotsAsync(recuperada.Id, Ct), null, agora);
        var cheddar = volta.Complementos.Single(c => c.ComplementoId == OpcaoCheddar);
        Assert.Equal([new ComponenteBaixa(Queijo, null, 0.168m)], recuperada.ComponentesEstoque(volta, cheddar));
        Assert.Equal(0.100m, recuperada.BaixasEstimadas()[Molho]);

        // Uma inclusão depois da queda com a mesma escolha agrupa na linha recuperada.
        Assert.Same(volta, recuperada.AdicionarItem(porcao, 1m, "0300", agora, agrupar: true, complementos: [OpcaoBarbecue, OpcaoCheddar, OpcaoRose]));
        await repo.SalvarEmAndamentoAsync(recuperada, ct: Ct);
        Assert.Equal(4L, banco.Escalar("select count(*) from itens_venda_complementos"));
    }

    [Fact]
    public void Snapshot_com_os_complementos_volta_igual_do_json()
    {
        var produto = new ProdutoVenda(Porcao, 300, "0300", "PORÇÃO DE FRITAS", "UN", 25m)
        {
            Tipo = TipoProduto.ComComplementos,
            GruposComplementos =
            [
                new GrupoComplementos(GrupoMolhos, "Molhos", 1, 2, true, 1,
                [
                    new OpcaoComplemento(OpcaoCheddar, "CHEDDAR", 4.5m, Cheddar, true, 1m, 1)
                    {
                        FichaVinculado = [new ComponenteFicha(Queijo, null, 0.08m, 5m)],
                    },
                    new OpcaoComplemento(OpcaoBarbecue, "BARBECUE", 0m, Molho, true, 0.05m, 2) { VinculadoComSaldo = true },
                ]),
            ],
        };

        var json = SnapshotProdutoJson.Serializar(produto);
        var volta = SnapshotProdutoJson.Desserializar(json);

        Assert.Equal(json, SnapshotProdutoJson.Serializar(volta));
        Assert.DoesNotContain("minimo_efetivo", json, StringComparison.Ordinal);
        var opcoes = volta.GruposComplementos!.Single().Opcoes;
        Assert.Equal([new ComponenteFicha(Queijo, null, 0.08m, 5m)], opcoes[0].FichaVinculado);
        Assert.True(opcoes[1].VinculadoComSaldo);
        Assert.Equal((4.5m, 0.05m), (opcoes[0].PrecoAdicional, opcoes[1].QuantidadeBaixa));
    }

    [Fact]
    public async Task Itens_venda_complementos_e_tabela_de_movimento_ligada_ao_item()
    {
        var (banco, _) = await CriarAsync();
        using var _b = banco;
        await using var db = banco.Fabrica.CreateDbContext();
        var tipo = db.Model.FindEntityType(typeof(ItemVendaComplementoRegistro))!;

        Assert.Equal("itens_venda_complementos", tipo.GetTableName());
        Assert.Equal("fk_itens_venda_complementos_item_venda_id", Assert.Single(tipo.GetForeignKeys()).GetConstraintName());
        Assert.Contains("20261127155707_ComplementosVenda", await db.Database.GetAppliedMigrationsAsync(Ct));
    }

    [Fact]
    public async Task Saldo_estimado_desconta_os_complementos_das_vendas_finalizadas_nao_refletidas()
    {
        var (banco, _) = await CriarAsync();
        using var _b = banco;
        var agora = banco.Relogio.Agora;
        var estoque = Guid.CreateVersion7();
        var refrigerante = Guid.CreateVersion7();
        var opcaoRefrigerante = Guid.CreateVersion7();
        var opcaoSemEstoque = Guid.CreateVersion7();
        var semEstoque = Guid.CreateVersion7();
        LinhaEspelho[] linhas =
        [
            new LojaRegistro { Id = Loja, Codigo = 1, Nome = "Loja 1", EstoqueId = estoque },
            Produto(refrigerante, 305, "REFRIGERANTE LATA", 6.00m),
            Produto(semEstoque, 306, "GUARDANAPO", 0m, p => p.ControlaEstoque = false),
            Opcao(opcaoRefrigerante, GrupoAdicionais, refrigerante, null, 5.00m, ordem: 3, baixa: true),
            Opcao(opcaoSemEstoque, GrupoAdicionais, semEstoque, null, 0m, ordem: 4, baixa: true),
        ];
        foreach (var linha in linhas)
        {
            linha.CriadoEm = linha.AtualizadoEm = agora;
            linha.Versao = 1;
        }

        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(linhas, Ct);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            SaldoEstoqueRegistro Saldo(Guid produto, decimal quantidade) => new()
            {
                Id = Guid.CreateVersion7(),
                EstoqueId = estoque,
                ProdutoId = produto,
                TipoEstoqueId = Guid.CreateVersion7(),
                Quantidade = quantidade,
                Versao = 1_000,
                CriadoEm = agora,
                AtualizadoEm = agora,
            };
            db.Set<SaldoEstoqueRegistro>().AddRange(Saldo(Molho, 10m), Saldo(Queijo, 5m), Saldo(refrigerante, 10m), Saldo(semEstoque, 3m));
            (await db.EstadoSincronizacao.SingleAsync(e => e.Fluxo == "estoque", Ct)).Cursor = 1_000;
            var seq = 0L;
            EventoSaida Evento(string tipo, Guid venda, int versao, string payload, string status = StatusEventoSaida.Pendente, long? fim = null) => new()
            {
                Id = Guid.CreateVersion7(),
                SequenciaTerminal = ++seq,
                Tipo = tipo,
                VersaoSchema = versao,
                AgregadoTipo = "venda",
                AgregadoId = venda,
                OcorridoEm = agora,
                CriadoEm = agora,
                Payload = payload,
                PayloadSha256 = new string('0', 64),
                Status = status,
                VersaoNuvem = fim is null ? null : fim - 10,
                VersaoNuvemFim = fim,
            };
            JsonObject Item(Guid id, string quantidade, bool cancelado = false) => new()
            {
                ["id"] = id.ToString(),
                ["produto_id"] = Porcao.ToString(),
                ["quantidade"] = quantidade,
                ["cancelado"] = cancelado,
                ["componentes_estoque"] = new JsonArray(),
            };
            JsonObject Linha(Guid item, Guid opcao, JsonArray? componentes = null)
            {
                var l = new JsonObject
                {
                    ["id"] = Guid.CreateVersion7().ToString(),
                    ["item_venda_id"] = item.ToString(),
                    ["complemento_id"] = opcao.ToString(),
                    ["quantidade"] = "1.000",
                    ["preco_adicional"] = "0.0000",
                };
                if (componentes is not null)
                {
                    l["componentes_estoque"] = componentes;
                }

                return l;
            }

            string Payload(JsonObject[] itens, JsonObject[] complementos) =>
                new JsonObject { ["itens_venda"] = new JsonArray(itens), ["itens_venda_complementos"] = new JsonArray(complementos) }.ToJsonString();
            var (a, b, c, d) = (Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7());
            var queijo = new JsonArray(new JsonObject { ["produto_id"] = Queijo.ToString(), ["quantidade"] = "0.168", ["variacao_id"] = null });
            var vendaCancelada = Guid.CreateVersion7();
            db.EventosSaida.AddRange(
                // v2 pendente: 2 porções com barbecue (2 × 1 × 0,050), cheddar (os insumos da linha), o refrigerante (2) e o
                // vinculado sem controle de estoque (não baixa); o item cancelado não baixa os complementos dele.
                Evento("venda.finalizada", Guid.CreateVersion7(), 2, Payload(
                    [Item(a, "2.000"), Item(b, "1.000", cancelado: true)],
                    [
                        Linha(a, OpcaoBarbecue, []), Linha(a, OpcaoCheddar, queijo), Linha(a, opcaoRefrigerante, []), Linha(a, opcaoSemEstoque, []),
                        Linha(a, OpcaoRose, []), Linha(b, OpcaoBarbecue, []), Linha(b, opcaoRefrigerante, []),
                    ])),
                // v1: a nuvem grava os complementos sem baixa nenhuma (o item continua contando).
                Evento("venda.finalizada", Guid.CreateVersion7(), 1, Payload([Item(c, "3.000")], [Linha(c, OpcaoBarbecue), Linha(c, opcaoRefrigerante)])),
                // Forma A: a finalizada já refletida, cancelada no caixa; até o estorno se refletir, o refrigerante volta.
                Evento("venda.finalizada", vendaCancelada, 2, Payload([Item(d, "1.000")], [Linha(d, opcaoRefrigerante, [])]), StatusEventoSaida.Confirmado, 900),
                Evento("venda.cancelada", vendaCancelada, 1, "{}"));
            await db.SaveChangesAsync(Ct);
        }

        var saldos = await new ConsultasVendaLocal(banco.Fabrica).SaldosEstimadosAsync([Molho, Queijo, refrigerante, semEstoque, Porcao], Ct);

        Assert.Equal((9.900m, 4.832m, 9m, 3m), (saldos[Molho], saldos[Queijo], saldos[refrigerante], saldos[semEstoque]));
        // A porção: 2 (v2) + 3 (v1) baixam, e a cancelada devolve 1.
        Assert.Equal(-4m, saldos[Porcao]);
    }
}
