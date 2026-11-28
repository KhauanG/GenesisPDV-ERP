using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using static GenesisPDV.Core.Tests.Fixtures;

namespace GenesisPDV.Core.Tests;

/// <summary>
/// Complementos no caixa (PDV 10.2; Fase 3, F3-B15): a escolha (mínimo, máximo, obrigatório e a F3-Q4 = D75), o preço
/// com a camada de acréscimos (também no atacado), o agrupamento, o cancelamento e a baixa calculada no caixa.
/// </summary>
public class ComplementosTests
{
    public static readonly Guid GrupoMolhos = Guid.Parse("01a19100-0000-7000-8000-000000000001");
    public static readonly Guid GrupoAdicionais = Guid.Parse("01a19100-0000-7000-8000-000000000002");
    public static readonly Guid Barbecue = Guid.Parse("01a19101-0000-7000-8000-000000000001");
    public static readonly Guid Mostarda = Guid.Parse("01a19101-0000-7000-8000-000000000002");
    public static readonly Guid Rose = Guid.Parse("01a19101-0000-7000-8000-000000000003");
    public static readonly Guid Cheddar = Guid.Parse("01a19101-0000-7000-8000-000000000004");
    public static readonly Guid Bacon = Guid.Parse("01a19101-0000-7000-8000-000000000005");
    public static readonly Guid MolhoBarbecueProduto = Guid.Parse("01a19102-0000-7000-8000-000000000001");
    public static readonly Guid CheddarProduzido = Guid.Parse("01a19102-0000-7000-8000-000000000002");
    public static readonly Guid Queijo = Guid.Parse("01a19102-0000-7000-8000-000000000003");

    /// <summary>
    /// "PORÇÃO DE FRITAS" 25,00 (atacado 22,00 a partir de 3): Molhos obrigatório de 1 a 2 (barbecue vinculado com baixa,
    /// mostarda e rosé livres) e Adicionais opcional até 2 (cheddar produzido com ficha, +4,50; bacon livre, +3,00).
    /// </summary>
    public static ProdutoVenda Porcao(TabelaPreco? precos = null) =>
        new(Guid.Parse("01a19103-0000-7000-8000-000000000001"), 300, "0300", "PORÇÃO DE FRITAS", "UN", 25.00m)
        {
            Tipo = TipoProduto.ComComplementos,
            Precos = precos,
            GruposComplementos =
            [
                new GrupoComplementos(GrupoMolhos, "Molhos", 1, 2, true, 1,
                [
                    new OpcaoComplemento(Barbecue, "MOLHO BARBECUE", 0m, MolhoBarbecueProduto, BaixaEstoque: true, QuantidadeBaixa: 0.05m, Ordem: 1)
                    {
                        VinculadoComSaldo = true,
                    },
                    new OpcaoComplemento(Mostarda, "Mostarda e mel", 0m, Ordem: 2),
                    new OpcaoComplemento(Rose, "Rosé", 0m, Ordem: 3),
                ]),
                new GrupoComplementos(GrupoAdicionais, "Adicionais", 0, 2, false, 2,
                [
                    new OpcaoComplemento(Cheddar, "CHEDDAR CREMOSO", 4.50m, CheddarProduzido, BaixaEstoque: true, QuantidadeBaixa: 1m, Ordem: 1)
                    {
                        FichaVinculado = [new ComponenteFicha(Queijo, null, 0.08m, 5m)],
                    },
                    new OpcaoComplemento(Bacon, "Bacon", 3.00m, Ordem: 2),
                ]),
            ],
        };

    private static ItemVenda Incluir(Venda venda, ProdutoVenda produto, decimal quantidade, params Guid[] opcoes) =>
        venda.AdicionarItem(new ProdutoResolvido(produto), quantidade, produto.CodigoInterno, Agora, agrupar: true, complementos: opcoes);

    [Fact]
    public void Porcao_com_dois_molhos_e_cheddar_soma_o_adicional_no_preco_unitario_e_no_de_tabela()
    {
        var venda = NovaVenda();
        var item = Incluir(venda, Porcao(), 2m, Rose, Barbecue, Cheddar);

        Assert.Equal((29.50m, 29.50m, 59.00m, 4.50m), (item.PrecoUnitario, item.PrecoTabela, item.ValorBruto, item.AcrescimoUnitario));
        Assert.Equal(OrigemPreco.Varejo, item.OrigemPreco);
        // Na ordem do cadastro (grupo, depois a opção), uma por unidade do item (F3-Q4).
        Assert.Equal(["Molhos:MOLHO BARBECUE", "Molhos:Rosé", "Adicionais:CHEDDAR CREMOSO"], item.Complementos.Select(c => $"{c.GrupoNome}:{c.Descricao}"));
        Assert.All(item.Complementos, c => Assert.Equal(1m, c.Quantidade));
        Assert.Equal([Barbecue, Rose, Cheddar], item.Complementos.Select(c => c.ComplementoId!.Value));
        Assert.Equal(59.00m, venda.Total);
    }

    public static TheoryData<Guid[], string> EscolhasRecusadas => new()
    {
        { [], "Escolha ao menos 1 opção em \"Molhos\"." },
        { [Cheddar], "Escolha ao menos 1 opção em \"Molhos\"." },
        { [Barbecue, Mostarda, Rose], "\"Molhos\": no máximo 2 opções." },
        { [Barbecue, Barbecue], "Cada complemento entra uma vez só por unidade do item." },
        { [Barbecue, Guid.Parse("01a19101-0000-7000-8000-0000000000ff")], "Complemento fora do cadastro deste produto — escolha de novo." },
    };

    [Theory]
    [MemberData(nameof(EscolhasRecusadas))]
    public void Escolha_fora_do_minimo_do_maximo_ou_repetida_e_recusada_sem_mudar_a_venda(Guid[] opcoes, string mensagem)
    {
        var venda = NovaVenda();
        var erro = Assert.Throws<RegraNegocioException>(() => Incluir(venda, Porcao(), 1m, opcoes));

        Assert.Equal(mensagem, erro.Message);
        Assert.Empty(venda.Itens);
    }

    [Fact]
    public void Grupo_opcional_aceita_nenhuma_e_o_maximo_conta_opcoes_diferentes()
    {
        var venda = NovaVenda();
        var item = Incluir(venda, Porcao(), 1m, Mostarda, Cheddar, Bacon);

        Assert.Equal(32.50m, item.PrecoUnitario);
        Assert.Equal("\"Adicionais\": no máximo 2 opções.", RegrasComplementos.MotivoDoGrupo(Porcao().GruposComplementos![1], 3));
        Assert.Null(RegrasComplementos.MotivoDoGrupo(Porcao().GruposComplementos![1], 0));
        Assert.Equal(["Escolha de 1 a 2", "Opcional, até 2"], Porcao().GruposComplementos!.Select(g => g.Regra));
    }

    [Fact]
    public void Grupo_obrigatorio_com_menos_opcoes_ativas_que_o_minimo_pede_o_gerente()
    {
        var produto = Porcao() with { };
        produto = produto with
        {
            GruposComplementos = [new GrupoComplementos(GrupoMolhos, "Molhos", 2, 2, true, 1, [new OpcaoComplemento(Rose, "Rosé", 0m)])],
        };

        var erro = Assert.Throws<RegraNegocioException>(() => Incluir(NovaVenda(), produto, 1m, Rose));

        Assert.Equal("\"Molhos\" pede 2 opção(ões) e só tem 1 ativa(s) — procure o gerente.", erro.Message);
    }

    [Fact]
    public void Sem_a_escolha_o_produto_com_complementos_vende_como_antes()
    {
        // Sem o recurso da onda (venda.finalizada v2 não anunciado), o serviço não abre o diálogo e manda nulo.
        var venda = NovaVenda();
        var item = venda.AdicionarItem(new ProdutoResolvido(Porcao()), 1m, "0300", Agora);

        Assert.Equal((25.00m, 0), (item.PrecoUnitario, item.Complementos.Count));
    }

    [Fact]
    public void Linhas_com_complementos_diferentes_nao_se_agrupam_e_as_iguais_sim()
    {
        var venda = NovaVenda();
        var primeira = Incluir(venda, Porcao(), 1m, Barbecue);
        var outra = Incluir(venda, Porcao(), 1m, Rose);
        var igual = Incluir(venda, Porcao(), 1m, Barbecue);

        Assert.NotSame(primeira, outra);
        Assert.Same(primeira, igual);
        Assert.Equal((2, 2m, 1m), (venda.ItensAtivos.Count(), primeira.Quantidade, outra.Quantidade));
        Assert.Single(primeira.Complementos);
    }

    [Fact]
    public void Atacado_por_quantidade_preserva_o_adicional_e_cancelar_volta_ao_varejo_com_ele()
    {
        var produto = Porcao(new TabelaPreco(PrecoAtacado: 22.00m, QtdMinimaAtacado: 3m));
        var venda = NovaVenda();
        var comBacon = Incluir(venda, produto, 1m, Barbecue, Bacon);
        var simples = Incluir(venda, produto, 2m, Rose);

        // A 3ª porção (as duas linhas somam 3) leva as duas ao atacado; o bacon continua somado só na dele.
        Assert.Equal((25.00m, OrigemPreco.Atacado, 22.00m), (comBacon.PrecoUnitario, comBacon.OrigemPreco, simples.PrecoUnitario));
        Assert.Equal((25.00m, 44.00m), (comBacon.ValorBruto, simples.ValorBruto));
        // Economia no atacado sobre o varejo com o adicional (28,00 − 25,00) e sobre o varejo sem (2 × 3,00).
        Assert.Equal((3.00m, 6.00m), (comBacon.EconomiaAtacado, simples.EconomiaAtacado));
        Assert.Equal(28.00m, comBacon.PrecoVarejoComAcrescimos);

        venda.CancelarItem(simples.Sequencia, Operador, Agora, 100m, quantidade: 1m);
        Assert.Equal((28.00m, OrigemPreco.Varejo), (comBacon.PrecoUnitario, comBacon.OrigemPreco));
        Assert.Equal(25.00m, venda.ItensAtivos.Single(i => i.Sequencia != comBacon.Sequencia).PrecoUnitario);
    }

    [Fact]
    public void Cancelamento_parcial_leva_os_complementos_para_o_restante_com_ids_novos()
    {
        var venda = NovaVenda();
        var item = Incluir(venda, Porcao(), 3m, Barbecue, Cheddar);

        var restante = venda.CancelarItem(item.Sequencia, Operador, Agora, 100m, quantidade: 1m)!;

        Assert.True(item.Cancelado);
        Assert.Equal((2m, 29.50m, 59.00m), (restante.Quantidade, restante.PrecoUnitario, restante.ValorBruto));
        Assert.Equal(item.Complementos.Select(c => c.ComplementoId), restante.Complementos.Select(c => c.ComplementoId));
        Assert.Empty(item.Complementos.Select(c => c.Id).Intersect(restante.Complementos.Select(c => c.Id)));
        Assert.Equal(59.00m, venda.Total);
    }

    [Fact]
    public void Cancelar_o_item_cancela_os_complementos_e_tira_a_baixa_estimada()
    {
        var venda = NovaVenda();
        var item = Incluir(venda, Porcao(), 2m, Barbecue, Cheddar);
        var baixas = venda.BaixasEstimadas();
        // Barbecue: 2 porções × 1 × 0,050; o cheddar produzido sai pelos insumos (2 × 0,080 × 1,05); a porção, o item.
        Assert.Equal(0.100m, baixas[MolhoBarbecueProduto]);
        Assert.Equal(0.168m, baixas[Queijo]);
        Assert.False(baixas.ContainsKey(CheddarProduzido));
        Assert.Equal(2m, baixas[item.ProdutoId]);

        venda.CancelarItem(item.Sequencia, Operador, Agora, 100m);

        Assert.Empty(venda.BaixasEstimadas());
        Assert.Equal(0m, venda.Total);
    }

    [Fact]
    public void Componentes_de_estoque_do_complemento_saem_so_do_vinculado_produzido_com_baixa()
    {
        var venda = NovaVenda();
        var item = Incluir(venda, Porcao(), 2m, Barbecue, Rose, Cheddar);

        var porComplemento = item.Complementos.ToDictionary(c => c.ComplementoId!.Value, c => venda.ComponentesEstoque(item, c));

        Assert.Empty(porComplemento[Barbecue]);
        Assert.Empty(porComplemento[Rose]);
        Assert.Equal([new ComponenteBaixa(Queijo, null, 0.168m)], porComplemento[Cheddar]);
        Assert.Empty(venda.ComponentesEstoque(item));
    }

    [Fact]
    public void Desconto_no_item_e_alterar_quantidade_seguem_o_preco_com_o_adicional()
    {
        var venda = NovaVenda();
        var item = Incluir(venda, Porcao(), 1m, Barbecue, Bacon);

        venda.AlterarQuantidade(item.Sequencia, 3m, 100m);
        var r = venda.AplicarDescontoItem(item.Sequencia, Desconto.EmPercentual(10m), 100m);

        Assert.Equal((84.00m, 8.40m, 75.60m), (item.ValorBruto, item.DescontoItem, venda.Total));
        Assert.True(r.Aplicado);
    }

    [Fact]
    public void Complemento_de_produto_sem_grupo_e_recusado()
    {
        var erro = Assert.Throws<RegraNegocioException>(() =>
            NovaVenda().AdicionarItem(Produto(10m, "REFRI"), 1m, "1", Agora, complementos: [Barbecue]));

        Assert.Equal("REFRI não tem complementos a escolher.", erro.Message);
    }

    [Fact]
    public void Venda_recuperada_refaz_o_preco_com_o_adicional_e_acha_a_ficha_pelo_snapshot()
    {
        var produto = Porcao(new TabelaPreco(PrecoAtacado: 22.00m, QtdMinimaAtacado: 3m));
        var venda = NovaVenda();
        var item = Incluir(venda, produto, 1m, Barbecue, Cheddar);
        var estado = new EstadoVenda(venda.Id, venda.Numero, venda.NumeroExibicao, venda.LojaId, venda.CaixaId, venda.NumeroCaixa, venda.TerminalId,
            null, venda.Modo, venda.Status, venda.StatusFiscal, venda.OperadorId, venda.TipoPreco, 0m, null, 0m, venda.IniciadaEm);
        var copia = new ItemVenda(item.Id, item.Sequencia, item.ProdutoId, item.CodigoLido, null, item.Descricao, item.Unidade, false, item.Quantidade,
            item.PrecoTabela, item.PrecoUnitario, item.OrigemPreco, item.ValorBruto, 0m, item.IncluidoEm, complementos: item.Complementos);

        var recuperada = Venda.Restaurar(estado, [copia], []);
        recuperada.RegistrarProdutos(venda.Snapshots.Select(s => s.Value), null, Agora);
        var depois = recuperada.AdicionarItem(new ProdutoResolvido(produto), 2m, "0300", Agora, complementos: [Rose]);

        Assert.Equal((26.50m, OrigemPreco.Atacado, 22.00m), (recuperada.ObterItem(1).PrecoUnitario, recuperada.ObterItem(1).OrigemPreco, depois.PrecoUnitario));
        Assert.Equal([new ComponenteBaixa(Queijo, null, 0.084m)], recuperada.ComponentesEstoque(copia, copia.Complementos.Single(c => c.ComplementoId == Cheddar)));
    }

    [Fact]
    public void Opcao_e_grupo_novos_no_meio_da_venda_entram_no_snapshot_e_baixam_pelo_cadastro_deles()
    {
        var cheddar2 = Guid.Parse("01a19101-0000-7000-8000-000000000006");
        var grupoBebida = Guid.Parse("01a19100-0000-7000-8000-000000000003");
        var lata = Guid.Parse("01a19101-0000-7000-8000-000000000007");
        var lataProduto = Guid.Parse("01a19102-0000-7000-8000-000000000004");
        var venda = NovaVenda();
        Incluir(venda, Porcao(), 1m, Barbecue);
        var original = Porcao();
        // O pull traz uma opção nova (produzido com ficha) em Adicionais e um grupo novo com o vinculado com saldo.
        var atualizada = original with
        {
            GruposComplementos =
            [
                original.GruposComplementos![0],
                original.GruposComplementos![1] with
                {
                    Opcoes =
                    [
                        .. original.GruposComplementos![1].Opcoes,
                        new OpcaoComplemento(cheddar2, "CHEDDAR 2", 5.00m, CheddarProduzido, BaixaEstoque: true, QuantidadeBaixa: 1m, Ordem: 3)
                        {
                            FichaVinculado = [new ComponenteFicha(Queijo, null, 0.10m, 0m)],
                        },
                    ],
                },
                new GrupoComplementos(grupoBebida, "Bebida", 0, 1, false, 3,
                [
                    new OpcaoComplemento(lata, "REFRIGERANTE LATA", 0m, lataProduto, BaixaEstoque: true, QuantidadeBaixa: 1m, Ordem: 1)
                    {
                        VinculadoComSaldo = true,
                    },
                ]),
            ],
        };

        var item = Incluir(venda, atualizada, 2m, Rose, cheddar2, lata);

        Assert.Equal(30.00m, item.PrecoUnitario);
        Assert.Equal(
            [new ComponenteBaixa(Queijo, null, 0.200m)],
            venda.ComponentesEstoque(item, item.Complementos.Single(c => c.ComplementoId == cheddar2)));
        var baixas = venda.BaixasEstimadas();
        Assert.Equal((0.200m, 2m, 0.050m), (baixas[Queijo], baixas[lataProduto], baixas[MolhoBarbecueProduto]));
        Assert.Equal(["Molhos", "Adicionais", "Bebida"], venda.Snapshots.Single(s => s.Key == original.Id).Value.Produto.GruposComplementos!.Select(g => g.Nome));
    }

    [Fact]
    public void Opcao_alterada_no_meio_da_venda_segue_o_preco_e_a_baixa_da_primeira_inclusao()
    {
        var venda = NovaVenda();
        Incluir(venda, Porcao(), 1m, Barbecue, Cheddar);
        var original = Porcao();
        // O pull muda o cheddar: adicional 6,00, baixa 2 e outra ficha. O snapshot continua com o da primeira inclusão.
        var alterada = original with
        {
            GruposComplementos =
            [
                original.GruposComplementos![0],
                original.GruposComplementos![1] with
                {
                    Opcoes =
                    [
                        new OpcaoComplemento(Cheddar, "CHEDDAR CREMOSO", 6.00m, CheddarProduzido, BaixaEstoque: true, QuantidadeBaixa: 2m, Ordem: 1)
                        {
                            FichaVinculado = [new ComponenteFicha(Queijo, null, 0.20m, 0m)],
                        },
                        original.GruposComplementos![1].Opcoes[1],
                    ],
                },
            ],
        };

        var segunda = Incluir(venda, alterada, 1m, Rose, Cheddar);

        var cheddar = segunda.Complementos.Single(c => c.ComplementoId == Cheddar);
        Assert.Equal((4.50m, 29.50m), (cheddar.PrecoAdicional, segunda.PrecoUnitario));
        Assert.Equal([new ComponenteBaixa(Queijo, null, 0.084m)], venda.ComponentesEstoque(segunda, cheddar));
        var snapshot = venda.Snapshots.Single(s => s.Key == original.Id).Value.Produto.GruposComplementos![1].Opcoes.Single(o => o.Id == Cheddar);
        Assert.Equal((4.50m, 1m), (snapshot.PrecoAdicional, snapshot.QuantidadeBaixa));
        // A mesma escolha agrupa com a linha da primeira inclusão: o adicional é o mesmo.
        Assert.Same(segunda, Incluir(venda, alterada, 1m, Rose, Cheddar));
    }

    [Fact]
    public void Linhas_e_a_copia_tem_ids_na_ordem_da_escolha()
    {
        var porcao = Porcao();
        for (var vez = 0; vez < 50; vez++)
        {
            var linhas = RegrasComplementos.Linhas(RegrasComplementos.Conferir(porcao, [Rose, Cheddar, Barbecue, Bacon]));
            var copia = RegrasComplementos.Copiar(linhas);

            Assert.Equal([Barbecue, Rose, Cheddar, Bacon], linhas.OrderBy(c => c.Id).Select(c => c.ComplementoId!.Value));
            Assert.Equal([Barbecue, Rose, Cheddar, Bacon], copia.OrderBy(c => c.Id).Select(c => c.ComplementoId!.Value));
        }
    }
}
