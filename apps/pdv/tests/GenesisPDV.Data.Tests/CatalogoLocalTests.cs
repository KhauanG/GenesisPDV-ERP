using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Tests;

/// <summary>Catálogo lido dos espelhos locais (MD 4.2) e venda com combo/atacado gravada e relida (PDV 32.3).</summary>
public class CatalogoLocalTests
{
    private static readonly Guid Loja = Guid.Parse("019a0005-0000-7000-8000-000000000001");
    private static readonly Guid OutraLoja = Guid.Parse("019a0005-0000-7000-8000-000000000099");
    private static readonly Guid Un = Guid.CreateVersion7();
    private static readonly Guid Fd = Guid.CreateVersion7();
    private static readonly Guid Mix = Guid.CreateVersion7();
    private static readonly Guid Brahma = Guid.CreateVersion7();
    private static readonly Guid Skol = Guid.CreateVersion7();
    private static readonly Guid Fardo = Guid.CreateVersion7();
    private static readonly Guid Kit = Guid.CreateVersion7();
    private static readonly Guid Whisky = Guid.CreateVersion7();
    private static readonly Guid RedBull = Guid.CreateVersion7();
    private static readonly Guid Monster = Guid.CreateVersion7();
    private static readonly Guid Inativo = Guid.CreateVersion7();
    private static readonly Guid PosEnergetico = Guid.CreateVersion7();
    private static readonly Guid AltMonster = Guid.CreateVersion7();
    private static readonly Guid Casco = Guid.CreateVersion7();
    private static readonly Guid Retornavel = Guid.CreateVersion7();

    private static async Task<(BancoTemporario Banco, CatalogoLocal Catalogo)> CriarAsync()
    {
        var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var ct = TestContext.Current.CancellationToken;
        await new RepositorioTerminal(banco.Fabrica, banco.Relogio).RegistrarAtivacaoAsync(new IdentidadeTerminal
        {
            TerminalId = Guid.CreateVersion7(),
            LojaId = Loja,
            CaixaId = Guid.CreateVersion7(),
            NumeroCaixa = 2,
            UrlApi = "demonstracao://local",
            AtivadoEm = banco.Relogio.Agora,
            NomeMaquina = "teste",
        }, ct);
        var agora = banco.Relogio.Agora;
        LinhaEspelho[] linhas =
        [
            new UnidadeMedidaRegistro { Id = Un, Sigla = "UN", Descricao = "Unidade" },
            new UnidadeMedidaRegistro { Id = Fd, Sigla = "FD", Descricao = "Fardo" },
            new GrupoPrecoQuantidadeRegistro { Id = Mix, Codigo = 1, Nome = "MIX LATAS 350ML", ModoPreco = "grupo" },
            new GrupoPrecoQuantidadeFaixaRegistro { Id = Guid.CreateVersion7(), GrupoId = Mix, QuantidadeInicial = 12m, Preco = 2.99m },
            new GrupoPrecoQuantidadeFaixaRegistro { Id = Guid.CreateVersion7(), GrupoId = Mix, LojaId = OutraLoja, QuantidadeInicial = 12m, Preco = 1.00m },
            Produto(Brahma, 123, "CERV BRAHMA LT 350ML", 3.49m, p =>
            {
                p.PrecoAtacado = 3.19m;
                p.QtdMinimaAtacado = 12m;
                p.GrupoPrecoQuantidadeId = Mix;
            }),
            Produto(Skol, 125, "CERV SKOL LT 350ML", 2.99m, p => p.GrupoPrecoQuantidadeId = Mix),
            new ProdutoCodigoBarrasRegistro { Id = Guid.CreateVersion7(), ProdutoId = Brahma, Codigo = "7891149103102", Principal = true },
            new ProdutoCodigoBarrasRegistro { Id = Fardo, ProdutoId = Brahma, Codigo = "17891149103109", Fator = 12m, Preco = 37.90m, UnidadeId = Fd },
            new ProdutoCodigoBarrasRegistro { Id = Guid.CreateVersion7(), ProdutoId = Brahma, Codigo = "123456", UsaVenda = false },
            new ProdutoLojaRegistro { Id = Guid.CreateVersion7(), ProdutoId = Skol, LojaId = Loja, PrecoVenda = 2.89m },
            new ProdutoLojaRegistro { Id = Guid.CreateVersion7(), ProdutoId = Brahma, LojaId = OutraLoja, PrecoVenda = 0.10m },
            new ProdutoPrecoQuantidadeRegistro { Id = Guid.CreateVersion7(), ProdutoId = Brahma, QuantidadeInicial = 6m, QuantidadeFinal = 11m, Preco = 3.39m },
            new ProdutoPrecoQuantidadeRegistro { Id = Guid.CreateVersion7(), ProdutoId = Brahma, LojaId = OutraLoja, QuantidadeInicial = 6m, Preco = 0.50m },
            Produto(Whisky, 501, "WHISKY 1L", 99.90m),
            Produto(RedBull, 502, "ENERGETICO RED BULL 2L", 22.90m),
            Produto(Monster, 503, "ENERGETICO MONSTER 2L", 24.90m),
            Produto(Inativo, 504, "ENERGETICO FORA DE LINHA", 19.90m, p => p.Ativo = false),
            Produto(Kit, 500, "COMBO DE WHISKY 1L", 129.90m, p => p.Tipo = "kit"),
            new ProdutoComponenteRegistro { Id = Guid.CreateVersion7(), ProdutoId = Kit, ComponenteId = Whisky, Quantidade = 1m, Ordem = 1 },
            new ProdutoComponenteRegistro
            {
                Id = PosEnergetico, ProdutoId = Kit, ComponenteId = RedBull, Quantidade = 1m, Ordem = 2, RotuloPosicao = "Energético 2L", PermiteSubstituicao = true,
            },
            new ProdutoComponenteAlternativaRegistro { Id = AltMonster, ComponenteId = PosEnergetico, ProdutoId = Monster, Acrescimo = 2m, Ordem = 1 },
            new ProdutoComponenteAlternativaRegistro { Id = Guid.CreateVersion7(), ComponenteId = PosEnergetico, ProdutoId = Inativo, Ordem = 2 },
            new ProdutoComponenteAlternativaRegistro { Id = Guid.CreateVersion7(), ComponenteId = PosEnergetico, ProdutoId = Whisky, Ordem = 3, Ativo = false },
            Produto(Casco, 601, "GARRAFA 600ML RETORNÁVEL", 2.50m, p => p.Tipo = "vasilhame"),
            Produto(Retornavel, 600, "CERV ORIGINAL 600ML RET", 9.90m, p =>
            {
                p.VasilhameProdutoId = Casco;
                p.VasilhameQuantidade = 1;
            }),
            new RestricaoHorarioVendaRegistro
            {
                Id = Guid.CreateVersion7(), IdadeMinimaProduto = 18, DiasSemana = [5, 6], HoraInicio = new TimeOnly(22, 0), HoraFim = new TimeOnly(6, 0),
                Descricao = "Lei municipal",
            },
        ];
        foreach (var linha in linhas)
        {
            linha.CriadoEm = linha.AtualizadoEm = agora;
            linha.Versao = 1;
        }

        Assert.Equal(linhas.Length, await new RepositorioEspelhos(banco.Fabrica).GravarAsync(linhas, ct));
        return (banco, new CatalogoLocal(banco.Fabrica));
    }

    private static ProdutoRegistro Produto(Guid id, int codigo, string nome, decimal preco, Action<ProdutoRegistro>? ajustar = null)
    {
        var p = new ProdutoRegistro { Id = id, Codigo = codigo, CodigoInterno = $"{codigo:0000}", Nome = nome, UnidadeId = Un, PrecoVenda = preco };
        ajustar?.Invoke(p);
        return p;
    }

    [Fact]
    public async Task Resolve_ean_dun_do_fardo_codigo_interno_e_codigo_numerico()
    {
        var (banco, catalogo) = await CriarAsync();
        using var _ = banco;
        var ct = TestContext.Current.CancellationToken;

        var ean = Assert.Single(await catalogo.ResolverAsync("7891149103102", ct));
        Assert.Equal(Brahma, ean.Produto.Id);
        Assert.Null(ean.Embalagem);
        Assert.Equal("UN", ean.Produto.Unidade);
        Assert.Equal("7891149103102", ean.Produto.CodigoPrincipal);

        var fardo = Assert.Single(await catalogo.ResolverAsync("17891149103109", ct));
        Assert.Equal(new EmbalagemPreco(Fardo, 12m, 37.90m, "FD"), fardo.Embalagem);

        Assert.Equal(Brahma, Assert.Single(await catalogo.ResolverAsync("0123", ct)).Produto.Id);
        Assert.Equal(Brahma, Assert.Single(await catalogo.ResolverAsync("123", ct)).Produto.Id);
        Assert.Empty(await catalogo.ResolverAsync("123456", ct)); // usa_venda = false
        Assert.Empty(await catalogo.ResolverAsync("999999", ct));
    }

    [Fact]
    public async Task Fontes_de_preco_da_loja_do_terminal_sem_as_de_outra_loja()
    {
        var (banco, catalogo) = await CriarAsync();
        using var _ = banco;
        var ct = TestContext.Current.CancellationToken;
        var brahma = (await catalogo.ObterAsync(Brahma, ct))!;
        var t = brahma.Precos!;
        Assert.Null(t.PrecoVendaLoja);
        Assert.Equal(3.19m, t.PrecoAtacado);
        Assert.Equal([new FaixaPreco(6m, 11m, 3.39m)], t.Faixas);
        Assert.Equal("MIX LATAS 350ML", t.Grupo!.Nome);
        Assert.Equal(ModoPrecoGrupo.Grupo, t.Grupo.Modo);
        Assert.Equal([new FaixaPreco(12m, null, 2.99m)], t.Grupo.Faixas);
        Assert.Single(t.Embalagens!);
        Assert.Equal(2.89m, (await catalogo.ObterAsync(Skol, ct))!.PrecoBase);
        Assert.True((await catalogo.ObterAsync(Retornavel, ct))!.Retornavel);
    }

    [Fact]
    public async Task Combo_traz_posicoes_em_ordem_e_so_alternativas_ativas()
    {
        var (banco, catalogo) = await CriarAsync();
        using var _ = banco;
        var combo = (await catalogo.ObterComboAsync(Kit, TestContext.Current.CancellationToken))!;
        Assert.True(combo.Kit.EhKit);
        Assert.Equal(["WHISKY 1L", "Energético 2L"], combo.Posicoes.Select(p => p.Rotulo));
        Assert.False(combo.Posicoes[0].TemAlternativas);
        var energetico = combo.Posicoes[1];
        Assert.Equal([RedBull, Monster], energetico.Opcoes.Select(o => o.Produto.Id));
        Assert.Equal(AltMonster, energetico.Opcoes[1].AlternativaId);
        Assert.Equal(2m, energetico.Opcoes[1].Acrescimo);
        Assert.True(combo.ExigeEscolha);
    }

    [Fact]
    public async Task Pesquisa_sem_acento_e_restricao_com_dias_em_json()
    {
        var (banco, catalogo) = await CriarAsync();
        using var _ = banco;
        var ct = TestContext.Current.CancellationToken;
        var achados = await catalogo.PesquisarAsync("energetico", 50, ct);
        Assert.Equal(["ENERGETICO MONSTER 2L", "ENERGETICO RED BULL 2L"], achados.Select(p => p.Descricao));
        Assert.Equal("[5,6]", banco.Escalar("select dias_semana from restricoes_horario_venda"));
        Assert.Equal("22:00:00", banco.Escalar("select hora_inicio from restricoes_horario_venda"));
        Assert.Equal(0L, banco.Escalar("select criado_localmente from produtos limit 1"));
    }

    [Fact]
    public async Task Pesquisa_so_por_codigo_poe_exato_antes_de_comeca_e_de_contem_e_ignora_letras_inativos_e_codigos_fora_da_venda()
    {
        // Decisão 65 (pesquisa só por números): código interno, código numérico e códigos de barras de venda (EAN e os
        // adicionais das embalagens); o nome não conta para a ordem, só a posição do código.
        var (banco, catalogo) = await CriarAsync();
        using var _ = banco;
        var ct = TestContext.Current.CancellationToken;
        Guid exato = Guid.CreateVersion7(), comeca = Guid.CreateVersion7(), contem = Guid.CreateVersion7(), adicional = Guid.CreateVersion7();
        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(
            [
                Produto(exato, 900, "ZZZ EXATO", 1m, p => p.CodigoInterno = "777"),
                Produto(comeca, 901, "AAA COMECA", 1m, p => p.CodigoInterno = "7771"),
                Produto(contem, 902, "BBB CONTEM", 1m),
                Produto(adicional, 903, "CCC ADICIONAL", 1m),
                Produto(Guid.CreateVersion7(), 904, "AAA INATIVO", 1m, p =>
                {
                    p.CodigoInterno = "777";
                    p.Ativo = false;
                }),
                new ProdutoCodigoBarrasRegistro { Id = Guid.CreateVersion7(), ProdutoId = contem, Codigo = "1777000", Principal = true },
                new ProdutoCodigoBarrasRegistro { Id = Guid.CreateVersion7(), ProdutoId = adicional, Codigo = "7770001", Fator = 6m, UnidadeId = Fd },
                // Código só de compra: nunca acha (a Skol ficaria em primeiro).
                new ProdutoCodigoBarrasRegistro { Id = Guid.CreateVersion7(), ProdutoId = Skol, Codigo = "777", UsaVenda = false },
            ],
            ct);

        var achados = await catalogo.PesquisarCodigoAsync("777", 50, ct);
        Assert.Equal(["ZZZ EXATO", "AAA COMECA", "CCC ADICIONAL", "BBB CONTEM"], achados.Select(p => p.Descricao));

        // O código adicional de fator 6 dá a linha da embalagem (o código que bateu e a sigla).
        var adicionalAchado = achados.Single(a => a.Descricao == "CCC ADICIONAL");
        Assert.Equal(("7770001", 6m, "FD 6"), (adicionalAchado.Codigo, adicionalAchado.Resolvido.Fator, adicionalAchado.Unidade));
        Assert.All(achados.Where(a => a != adicionalAchado), a => Assert.False(a.EhEmbalagem));

        // O DUN do fardo acha a Brahma já resolvida no fardo (como o bipe); o código só de compra, não; letras, nada.
        var fardo = Assert.Single(await catalogo.PesquisarCodigoAsync("17891149103109", 50, ct));
        Assert.Equal(("CERV BRAHMA LT 350ML", Fardo, 12m, 37.90m, "FD"),
            (fardo.Descricao, fardo.Resolvido.CodigoBarrasId, fardo.Resolvido.Fator, fardo.Resolvido.PrecoEmbalagem, fardo.Resolvido.SiglaEmbalagem));
        Assert.Equal(("17891149103109", "FD 12", 37.90m), (fardo.Codigo, fardo.Unidade, fardo.Preco));
        Assert.Equal((await catalogo.ResolverAsync("17891149103109", ct)).Single().Embalagem, fardo.Resolvido.Embalagem);

        // Parte comum ao EAN e ao DUN: duas linhas, a unidade (começa) antes do fardo (contém).
        var ambos = await catalogo.PesquisarCodigoAsync("789114910", 50, ct);
        Assert.Equal([(false, "7891149103102"), (true, "17891149103109")], ambos.Select(a => (a.EhEmbalagem, a.Codigo)));
        Assert.Empty(await catalogo.PesquisarCodigoAsync("123456", 50, ct));
        Assert.Empty(await catalogo.PesquisarCodigoAsync("77a", 50, ct));
        Assert.Empty(await catalogo.PesquisarCodigoAsync(" ", 50, ct));
        Assert.Equal(2, (await catalogo.PesquisarCodigoAsync("777", 2, ct)).Count);
    }

    [Fact]
    public async Task Upsert_so_substitui_versao_maior_e_a_versao_da_nuvem_desmarca_criado_localmente()
    {
        var (banco, _) = await CriarAsync();
        using var __ = banco;
        var ct = TestContext.Current.CancellationToken;
        var espelhos = new RepositorioEspelhos(banco.Fabrica);
        var agora = banco.Relogio.Agora;
        banco.Escalar($"update produtos set criado_localmente = 1 where id = '{Whisky}'");
        var velha = Produto(Whisky, 501, "WHISKY VELHO", 1m);
        velha.CriadoEm = velha.AtualizadoEm = agora;
        velha.Versao = 1;
        Assert.Equal(0, await espelhos.GravarAsync([velha], ct));
        Assert.Equal(1L, banco.Escalar($"select criado_localmente from produtos where id = '{Whisky}'"));
        var nova = Produto(Whisky, 501, "WHISKY 1L NOVO", 109.90m);
        nova.CriadoEm = nova.AtualizadoEm = agora;
        nova.Versao = 2;
        nova.CriadoLocalmente = true;
        Assert.Equal(1, await espelhos.GravarAsync([nova], ct));
        Assert.Equal("WHISKY 1L NOVO", banco.Escalar($"select nome from produtos where id = '{Whisky}'"));
        Assert.Equal(1099000L, banco.Escalar($"select preco_venda from produtos where id = '{Whisky}'"));
        // MD 4.2: a versão da nuvem chegou, a linha deixa de ser local (nem o valor da linha recebida conta).
        Assert.Equal(0L, banco.Escalar($"select criado_localmente from produtos where id = '{Whisky}'"));
    }

    [Fact]
    public async Task Venda_com_mix_combo_e_casco_gravada_volta_igual_e_recalcula_com_o_espelho()
    {
        var (banco, catalogo) = await CriarAsync();
        using var _ = banco;
        var ct = TestContext.Current.CancellationToken;
        var agora = banco.Relogio.Agora;
        var repo = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var contexto = new ContextoVenda(Guid.CreateVersion7(), Loja, 1, Guid.CreateVersion7(), 2, null, UsaPrecoVolume: true);
        var operador = Guid.CreateVersion7();
        var venda = Venda.Iniciar(Guid.CreateVersion7(), await repo.ReservarNumeroVendaAsync(ct), contexto, operador, agora);

        venda.AdicionarItem(Assert.Single(await catalogo.ResolverAsync("7891149103102", ct)), 6m, "7891149103102", agora);
        venda.AdicionarItem(new Core.Produtos.ProdutoResolvido((await catalogo.ObterAsync(Skol, ct))!), 6m, "0125", agora);
        var combo = (await catalogo.ObterComboAsync(Kit, ct))!;
        venda.AdicionarCombo(combo, [0, 1], 1m, "0500", agora);
        var cheio = venda.AdicionarItem(new Core.Produtos.ProdutoResolvido((await catalogo.ObterAsync(Retornavel, ct))!), 2m, "0600", agora);
        venda.RegistrarCascosTrazidos(cheio.Sequencia, 1m, (await catalogo.ObterAsync(Casco, ct))!, agora);
        await repo.SalvarEmAndamentoAsync(venda, ct: ct);
        Assert.Equal(2.99m, venda.Itens[0].PrecoUnitario);
        Assert.Equal(OrigemPreco.GrupoMix, venda.Itens[0].OrigemPreco);

        var recuperada = (await repo.ObterVendaAtualAsync(ct))!;
        Assert.Equal(venda.Total, recuperada.Total);
        Assert.Equal(Mix, recuperada.Itens[0].GrupoPrecoQuantidadeId);
        Assert.Equal(12m, recuperada.Itens[0].QuantidadeReferenciaPreco);
        var linhasCombo = recuperada.Itens.Where(i => i.Kit is not null).ToList();
        Assert.Equal(2, linhasCombo.Count);
        Assert.Equal(AltMonster, linhasCombo[1].Kit!.AlternativaId);
        Assert.Equal(2.0000m, linhasCombo[1].Kit!.Acrescimo);
        Assert.Equal(131.90m, linhasCombo.Sum(l => l.ValorBruto));
        Assert.Equal(PosEnergetico, linhasCombo[1].Kit!.ComponenteId);
        Assert.Equal("COMBO DE WHISKY 1L", linhasCombo[0].Kit!.Descricao);
        var casco = recuperada.Itens.Single(i => i.VasilhameItemOrigemId is not null);
        Assert.Equal(cheio.Id, casco.VasilhameItemOrigemId);

        // Recuperada: registra o snapshot da primeira inclusão e volta a recalcular (cancelar uma Brahma derruba o mix).
        var snapshots = await repo.ObterSnapshotsAsync(recuperada.Id, ct);
        Assert.Equal(venda.Snapshots.Select(s => s.Key).Order(), snapshots.Select(s => s.Produto.Id).Order());
        recuperada.RegistrarProdutos(snapshots, null, agora, usaPrecoVolume: true);
        Assert.Equal([new ResumoVasilhame(Casco, 1m, 1m, 0m, null)], recuperada.ResumoVasilhames());
        recuperada.CancelarItem(1, operador, agora, 0m, quantidade: 1m);
        Assert.Equal(3.49m, recuperada.ItensAtivos.First(i => i.ProdutoId == Brahma).PrecoUnitario);
        Assert.Equal(2.89m, recuperada.ItensAtivos.First(i => i.ProdutoId == Skol).PrecoUnitario);
        await repo.SalvarEmAndamentoAsync(recuperada, ct: ct);
        Assert.Equal("kit_rateio", banco.Escalar($"select origem_preco from itens_venda where kit_alternativa_id = '{AltMonster}'"));
        Assert.Equal(1319000L, banco.Escalar($"select kit_preco_unitario from itens_venda where kit_alternativa_id = '{AltMonster}'"));
    }
    [Fact]
    public async Task Pull_no_meio_da_venda_nao_muda_os_itens_na_recuperacao_e_o_snapshot_some_ao_encerrar()
    {
        var (banco, catalogo) = await CriarAsync();
        using var _ = banco;
        var ct = TestContext.Current.CancellationToken;
        var agora = banco.Relogio.Agora;
        var repo = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var contexto = new ContextoVenda(Guid.CreateVersion7(), Loja, 1, Guid.CreateVersion7(), 2, null);
        var operador = Guid.CreateVersion7();
        var venda = Venda.Iniciar(Guid.CreateVersion7(), await repo.ReservarNumeroVendaAsync(ct), contexto, operador, agora);

        // 5 latas no atacado (17 ≥ 12) + o fardo de 12 a 37,90.
        venda.AdicionarItem(Assert.Single(await catalogo.ResolverAsync("7891149103102", ct)), 5m, "7891149103102", agora);
        venda.AdicionarItem(Assert.Single(await catalogo.ResolverAsync("17891149103109", ct)), 1m, "17891149103109", agora);
        await repo.SalvarEmAndamentoAsync(venda, ct: ct);
        Assert.Equal([15.95m, 37.90m], venda.Itens.Select(i => i.ValorBruto));
        Assert.Equal(1L, banco.Escalar($"select count(*) from produtos_venda_snapshot where venda_id = '{venda.Id}'"));

        // Pull: varejo 3,99, atacado 3,59 e o DUN do fardo excluído.
        var espelhos = new RepositorioEspelhos(banco.Fabrica);
        var nova = Produto(Brahma, 123, "CERV BRAHMA LT 350ML", 3.99m, p =>
        {
            p.PrecoAtacado = 3.59m;
            p.QtdMinimaAtacado = 12m;
        });
        var dunExcluido = new ProdutoCodigoBarrasRegistro
        {
            Id = Fardo,
            ProdutoId = Brahma,
            Codigo = "17891149103109",
            Fator = 12m,
            Preco = 37.90m,
            UnidadeId = Fd,
            ExcluidoEm = agora,
        };
        foreach (var linha in new LinhaEspelho[] { nova, dunExcluido })
        {
            linha.CriadoEm = linha.AtualizadoEm = agora;
            linha.Versao = 2;
        }

        Assert.Equal(2, await espelhos.GravarAsync([nova, dunExcluido], ct));

        var recuperada = (await repo.ObterVendaAtualAsync(ct))!;
        recuperada.RegistrarProdutos(await repo.ObterSnapshotsAsync(recuperada.Id, ct), null, agora);
        Assert.Equal(new EmbalagemPreco(Fardo, 12m, 37.90m, "FD"), recuperada.Itens[1].Embalagem);
        Assert.Equal(3.49m, recuperada.Itens[0].PrecoVarejo);
        recuperada.AdicionarItem(new Core.Produtos.ProdutoResolvido((await catalogo.ObterAsync(Skol, ct))!), 1m, "0125", agora);
        Assert.Equal([15.95m, 37.90m, 2.89m], recuperada.Itens.Select(i => i.ValorBruto));
        Assert.Equal(56.74m, recuperada.Total);
        await repo.SalvarEmAndamentoAsync(recuperada, ct: ct);
        Assert.Equal(2L, banco.Escalar($"select count(*) from produtos_venda_snapshot where venda_id = '{venda.Id}'"));

        recuperada.Cancelar(operador, "Teste de cancelamento", agora);
        var evento = new EventoParaOutbox(Guid.CreateVersion7(), "venda.cancelada", 1, "venda", recuperada.Id, agora, "{}", new string('0', 64));
        await repo.EncerrarAsync(recuperada, evento, ct: ct);
        Assert.Equal(0L, banco.Escalar("select count(*) from produtos_venda_snapshot"));
    }

    [Fact]
    public async Task Liberacao_do_supervisor_volta_com_a_venda_recuperada_e_fica_depois_do_encerramento()
    {
        var (banco, catalogo) = await CriarAsync();
        using var _ = banco;
        var ct = TestContext.Current.CancellationToken;
        var agora = banco.Relogio.Agora;
        var repo = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var contexto = new ContextoVenda(Guid.CreateVersion7(), Loja, 1, Guid.CreateVersion7(), 2, null);
        var operador = Guid.CreateVersion7();
        var supervisor = Guid.CreateVersion7();
        var venda = Venda.Iniciar(Guid.CreateVersion7(), await repo.ReservarNumeroVendaAsync(ct), contexto, operador, agora);
        var item = venda.AdicionarItem(Assert.Single(await catalogo.ResolverAsync("7891149103102", ct)), 6m, "7891149103102", agora);
        Assert.True(venda.AplicarDescontoItem(item.Sequencia, Desconto.EmReais(4m), 1m, new Liberacao(supervisor, 30m, "Cliente fidelidade", agora)).Aplicado);
        await repo.SalvarEmAndamentoAsync(venda, ct: ct);
        await repo.SalvarEmAndamentoAsync(venda, ct: ct);

        // Queda no meio da venda (PDV 32.3): a liberação volta com ela e sobe no venda.finalizada.
        var recuperada = (await repo.ObterVendaAtualAsync(ct))!;
        var liberacao = Assert.Single(recuperada.Liberacoes);
        Assert.Equal(venda.Liberacoes[0], liberacao);
        Assert.Equal((AcaoLiberacao.DescontoItem, item.Id, supervisor), (liberacao.Acao, liberacao.ItemVendaId, liberacao.AutorizadoPorId));

        recuperada.Cancelar(operador, "Teste de cancelamento", agora);
        await repo.EncerrarAsync(recuperada, null, ct: ct);
        Assert.Equal(1L, banco.Escalar($"select count(*) from liberacoes_venda where venda_id = '{venda.Id}'"));
        Assert.Single((await repo.ObterAsync(venda.Id, ct))!.Liberacoes);
    }

    [Fact]
    public void Snapshot_do_produto_volta_igual_do_json()
    {
        var produto = new Core.Produtos.ProdutoVenda(Brahma, 123, "0123", "CERV BRAHMA LT 350ML", "UN", 3.49m, Ativo: true, Vendavel: true)
        {
            Tipo = "simples",
            PermiteFracao = false,
            VasilhameProdutoId = Casco,
            VasilhameQuantidade = 1,
            CodigoPrincipal = "7891149103102",
            Precos = new TabelaPreco(
                PrecoVendaLoja: 3.29m,
                PrecoPromocional: 2.9999m,
                PromocaoInicio: new DateTimeOffset(2026, 10, 1, 3, 0, 0, TimeSpan.Zero),
                PromocaoFim: new DateTimeOffset(2026, 11, 1, 2, 59, 59, TimeSpan.Zero),
                PrecoAtacado: 3.19m,
                QtdMinimaAtacado: 12m,
                Faixas: [new FaixaPreco(6m, 11m, 3.39m, Loja), new FaixaPreco(12m, null, 3.09m)],
                Grupo: new GrupoPrecoQuantidade(Mix, "MIX LATAS 350ML", ModoPrecoGrupo.Grupo, true, [new FaixaPreco(12m, null, 2.99m)]),
                Embalagens: [new EmbalagemPreco(Fardo, 12m, 37.90m, "FD")]),
        };
        var json = SnapshotProdutoJson.Serializar(produto);
        Assert.DoesNotContain("preco_base", json, StringComparison.Ordinal);
        Assert.Contains("\"grupo\"", json, StringComparison.Ordinal);
        var volta = SnapshotProdutoJson.Desserializar(json);
        Assert.Equal(json, SnapshotProdutoJson.Serializar(volta));
        Assert.Equal(produto.PrecoBase, volta.PrecoBase);
        Assert.Equal(produto.Precos.Faixas, volta.Precos!.Faixas);
        Assert.Equal(produto.Precos.Embalagens, volta.Precos.Embalagens);
        Assert.Equal(ModoPrecoGrupo.Grupo, volta.Precos.GrupoAtivo!.Modo);
        Assert.Equal(produto.Precos.Grupo!.Faixas, volta.Precos.Grupo!.Faixas);
        Assert.True(volta.Retornavel);
        Assert.Equal(produto with { Precos = null }, volta with { Precos = null });
    }

    [Fact]
    public async Task Configuracao_da_loja_prevalece_sobre_a_da_empresa_e_sem_linha_vale_o_padrao()
    {
        var (banco, _) = await CriarAsync();
        using var __ = banco;
        var ct = TestContext.Current.CancellationToken;
        var configuracoes = new RepositorioConfiguracoes(banco.Fabrica);
        Assert.False(await configuracoes.ObterBoolAsync(ChavesConfiguracao.UsaPrecoVolume, Loja, padrao: false, ct));

        var agora = banco.Relogio.Agora;
        var empresa = new ConfiguracaoRegistro { Id = Guid.CreateVersion7(), Chave = ChavesConfiguracao.UsaPrecoVolume, Valor = "true" };
        var outraLoja = new ConfiguracaoRegistro
        {
            Id = Guid.CreateVersion7(),
            Escopo = "loja",
            LojaId = OutraLoja,
            Chave = ChavesConfiguracao.UsaPrecoVolume,
            Valor = "false",
        };
        var daLoja = new ConfiguracaoRegistro
        {
            Id = Guid.CreateVersion7(),
            Escopo = "loja",
            LojaId = Loja,
            Chave = ChavesConfiguracao.UsaPrecoVolume,
            Valor = "false",
        };
        foreach (var linha in new[] { empresa, outraLoja, daLoja })
        {
            linha.CriadoEm = linha.AtualizadoEm = agora;
            linha.Versao = 1;
        }

        var espelhos = new RepositorioEspelhos(banco.Fabrica);
        await espelhos.GravarAsync([empresa, outraLoja], ct);
        Assert.True(await configuracoes.ObterBoolAsync(ChavesConfiguracao.UsaPrecoVolume, Loja, padrao: false, ct));
        await espelhos.GravarAsync([daLoja], ct);
        Assert.False(await configuracoes.ObterBoolAsync(ChavesConfiguracao.UsaPrecoVolume, Loja, padrao: false, ct));

        daLoja.Versao = 2;
        daLoja.ExcluidoEm = agora;
        await espelhos.GravarAsync([daLoja], ct);
        Assert.True(await configuracoes.ObterBoolAsync(ChavesConfiguracao.UsaPrecoVolume, Loja, padrao: false, ct));
    }

    /// <summary>
    /// Central do PDV, bloco G11 (aba 7 Parâmetros; spec 6.9): o valor que está valendo de cada chave e de onde vem — a
    /// loja, a empresa ou o padrão —, numa consulta, sem a linha de outra loja nem a excluída; e o último pull das regras.
    /// </summary>
    [Fact]
    public async Task Valor_efetivo_diz_a_origem_loja_empresa_ou_padrao_e_o_ultimo_pull()
    {
        var (banco, _) = await CriarAsync();
        using var __ = banco;
        var ct = TestContext.Current.CancellationToken;
        var configuracoes = new RepositorioConfiguracoes(banco.Fabrica);
        var agora = banco.Relogio.Agora;
        ConfiguracaoRegistro Linha(string chave, string valor, Guid? loja = null, DateTimeOffset? excluido = null) => new()
        {
            Id = Guid.CreateVersion7(),
            Escopo = loja is null ? "empresa" : "loja",
            LojaId = loja,
            Chave = chave,
            Valor = valor,
            CriadoEm = agora,
            AtualizadoEm = agora,
            ExcluidoEm = excluido,
            Versao = 1,
        };

        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(
        [
            Linha(ChavesConfiguracao.FechamentoCego, "false"),
            Linha(ChavesConfiguracao.FechamentoCego, "true", Loja),
            Linha(ChavesConfiguracao.HorasAlertaSessao, "12"),
            Linha(ChavesConfiguracao.HorasAlertaSessao, "6", OutraLoja),
            Linha(ChavesConfiguracao.PermiteRecontagem, "true", Loja, excluido: agora),
        ], ct);
        var valores = await configuracoes.ValoresEfetivosAsync(
            [ChavesConfiguracao.FechamentoCego, ChavesConfiguracao.HorasAlertaSessao, ChavesConfiguracao.PermiteRecontagem, ChavesConfiguracao.DiasMaxOffline],
            Loja, ct);
        Assert.Equal(
            [
                (ChavesConfiguracao.FechamentoCego, "true", OrigemConfiguracao.Loja),
                (ChavesConfiguracao.HorasAlertaSessao, "12", OrigemConfiguracao.Empresa),
                (ChavesConfiguracao.PermiteRecontagem, (string?)null, OrigemConfiguracao.Padrao),
                (ChavesConfiguracao.DiasMaxOffline, (string?)null, OrigemConfiguracao.Padrao),
            ],
            valores.Select(v => (v.Chave, v.Valor, v.Origem)));
        Assert.Equal(agora, valores[0].AtualizadoEm);
        Assert.Null(valores[2].AtualizadoEm);

        Assert.Null(await configuracoes.UltimoPullAsync(ct));
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            var estado = await db.EstadoSincronizacao.FirstOrDefaultAsync(e => e.Fluxo == RepositorioConfiguracoes.FluxoConfiguracao, ct);
            if (estado is null)
            {
                estado = new EstadoSincronizacao { Fluxo = RepositorioConfiguracoes.FluxoConfiguracao };
                db.EstadoSincronizacao.Add(estado);
            }

            estado.UltimoPullSucessoEm = agora;
            await db.SaveChangesAsync(ct);
        }

        Assert.Equal(agora, await configuracoes.UltimoPullAsync(ct));
    }

    [Fact]
    public async Task Componente_retornavel_aparece_indisponivel_no_combo()
    {
        var (banco, catalogo) = await CriarAsync();
        using var _ = banco;
        var ct = TestContext.Current.CancellationToken;
        var agora = banco.Relogio.Agora;
        var kit = Guid.CreateVersion7();
        LinhaEspelho[] linhas =
        [
            Produto(kit, 700, "KIT 6 ORIGINAL 600 RET", 59.90m, p => p.Tipo = "kit"),
            new ProdutoComponenteRegistro { Id = Guid.CreateVersion7(), ProdutoId = kit, ComponenteId = Retornavel, Quantidade = 6m, Ordem = 1 },
        ];
        foreach (var linha in linhas)
        {
            linha.CriadoEm = linha.AtualizadoEm = agora;
            linha.Versao = 1;
        }

        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(linhas, ct);
        var combo = (await catalogo.ObterComboAsync(kit, ct))!;
        var opcao = Assert.Single(Assert.Single(combo.Posicoes).Opcoes);
        Assert.False(opcao.Disponivel);
        Assert.Equal("retornável", opcao.Motivo);
    }

    [Fact]
    public async Task Codigo_de_variacao_e_pai_com_variacao_ativa_saem_marcados_para_a_guarda()
    {
        // F2-B34 (D44): o catálogo só marca; quem recusa é a venda, pela chave pdv.recusa_produto_com_variacoes.
        var (banco, catalogo) = await CriarAsync();
        using var _ = banco;
        var ct = TestContext.Current.CancellationToken;
        var agora = banco.Relogio.Agora;
        var camiseta = Guid.CreateVersion7();
        var legado = Guid.CreateVersion7();
        var porcao = Guid.CreateVersion7();
        var azul = Guid.CreateVersion7();
        var codigoAzul = Guid.CreateVersion7();
        LinhaEspelho[] linhas =
        [
            Produto(camiseta, 800, "CAMISETA ICE BEER", 49.90m, p => p.Tipo = TipoProduto.ComVariacoes),
            new ProdutoVariacaoRegistro { Id = azul, ProdutoId = camiseta, Nome = "AZUL", Ativo = true },
            new ProdutoVariacaoRegistro { Id = Guid.CreateVersion7(), ProdutoId = camiseta, Nome = "VERDE", Ativo = false },
            new ProdutoCodigoBarrasRegistro { Id = Guid.CreateVersion7(), ProdutoId = camiseta, Codigo = "7890000080001", Principal = true },
            new ProdutoCodigoBarrasRegistro { Id = codigoAzul, ProdutoId = camiseta, VariacaoId = azul, Codigo = "7890000080018" },
            // Legado do Nuvem3: "Com variações" só com variação inativa e outra excluída — vende como simples.
            Produto(legado, 801, "CAMISA LEGADO", 39.90m, p => p.Tipo = TipoProduto.ComVariacoes),
            new ProdutoVariacaoRegistro { Id = Guid.CreateVersion7(), ProdutoId = legado, Nome = "P", Ativo = false },
            new ProdutoVariacaoRegistro { Id = Guid.CreateVersion7(), ProdutoId = legado, Nome = "M", Ativo = true, ExcluidoEm = agora },
            Produto(porcao, 802, "PORCAO DE FRITAS", 29.90m, p => p.Tipo = TipoProduto.ComComplementos),
        ];
        foreach (var linha in linhas)
        {
            linha.CriadoEm = linha.AtualizadoEm = agora;
            linha.Versao = 1;
        }

        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(linhas, ct);

        var variacao = Assert.Single(await catalogo.ResolverAsync("7890000080018", ct));
        Assert.Equal(camiseta, variacao.Produto.Id);
        Assert.Equal(azul, variacao.VariacaoId);
        Assert.Equal(codigoAzul, variacao.CodigoBarrasId);
        Assert.True(variacao.ExigeVariacao);

        var pai = Assert.Single(await catalogo.ResolverAsync("7890000080001", ct));
        Assert.Null(pai.VariacaoId);
        Assert.True(pai.Produto.TemVariacoesAtivas);
        Assert.True(pai.ExigeVariacao);
        Assert.True(Assert.Single(await catalogo.ResolverAsync("0800", ct)).ExigeVariacao);

        // O pai sem variação ativa, o "Com complementos" e o simples entram.
        Assert.False(Assert.Single(await catalogo.ResolverAsync("801", ct)).ExigeVariacao);
        Assert.False(Assert.Single(await catalogo.ResolverAsync("0802", ct)).ExigeVariacao);
        Assert.False(Assert.Single(await catalogo.ResolverAsync("7891149103102", ct)).ExigeVariacao);

        // Pela pesquisa por nome: o mesmo produto marcado; pela só por números, a linha do código da variação leva a variação.
        var porNome = Assert.Single(await catalogo.PesquisarAsync("camiseta", ct: ct));
        Assert.True(porNome.Produto.TemVariacoesAtivas);
        var porCodigo = await catalogo.PesquisarCodigoAsync("789000008", ct: ct);
        Assert.Equal(["7890000080001", "7890000080018"], porCodigo.Select(l => l.Codigo).Order(StringComparer.Ordinal));
        var linhaAzul = porCodigo.Single(l => l.Codigo == "7890000080018");
        Assert.Equal(azul, linhaAzul.Resolvido.VariacaoId);
        Assert.False(linhaAzul.EhEmbalagem);
        Assert.Equal("UN", linhaAzul.Unidade);
        Assert.All(porCodigo, l => Assert.True(l.Resolvido.ExigeVariacao));
    }
}
