using System.Text.Json.Nodes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Banco local da venda real (Fase 1C, C11a): pagamento com POS e PIX (cobrança) que volta igual depois de uma queda,
/// a venda só encerra na sessão aberta, o saldo estimado (SYNC 15.2), o cabeçalho da loja, o cliente do F5 e a ficha
/// técnica do produzido lida do espelho.
/// </summary>
public class VendaRealDadosTests
{
    private static readonly Guid Terminal = Guid.CreateVersion7();
    private static readonly Guid Loja = Guid.CreateVersion7();
    private static readonly Guid Estoque = Guid.CreateVersion7();
    private static readonly Guid Operador = Guid.CreateVersion7();

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly FormaPagamentoInfo Debito = new(Guid.CreateVersion7(), "Cartão de débito", "04", "cartao_debito", false,
        Integracao: IntegracaoForma.PosExterno);

    private static readonly FormaPagamentoInfo Pix = new(Guid.CreateVersion7(), "PIX", "20", "pix", false, Integracao: IntegracaoForma.PixEstatico);

    private static async Task<BancoTemporario> BancoAsync()
    {
        var banco = new BancoTemporario();
        await banco.InicializarAsync();
        await using var db = banco.Fabrica.CreateDbContext();
        db.IdentidadeTerminal.Add(new IdentidadeTerminal
        {
            TerminalId = Terminal,
            LojaId = Loja,
            CaixaId = Guid.CreateVersion7(),
            NumeroCaixa = 2,
            UrlApi = "https://api.exemplo/",
            AtivadoEm = banco.Relogio.Agora,
        });
        await db.SaveChangesAsync(Ct);
        return banco;
    }

    private static async Task<SessaoCaixaRegistro> AbrirSessaoAsync(BancoTemporario banco)
    {
        var agora = banco.Relogio.Agora;
        var sessao = new SessaoCaixaRegistro
        {
            Id = IdGerador.Novo(),
            LojaId = Loja,
            CaixaId = Guid.CreateVersion7(),
            NumeroCaixa = 2,
            TerminalId = Terminal,
            OperadorId = Operador,
            DiaOperacional = DateOnly.FromDateTime(agora.UtcDateTime),
            AbertaEm = agora,
        };
        var caixa = new RepositorioCaixa(banco.Fabrica, banco.Relogio, new Outbox.GravadorOutbox(new Outbox.RelogioOutboxLocal(banco.Relogio)));
        await caixa.AbrirAsync(sessao, null, new EventoParaOutbox(Guid.CreateVersion7(), "caixa.aberto", 1, "sessao_caixa", sessao.Id, agora, "{}", new string('0', 64)), Ct);
        return sessao;
    }

    private static Venda Venda(BancoTemporario banco, Guid? sessao, long numero) =>
        Core.Vendas.Venda.Iniciar(Guid.CreateVersion7(), numero, new ContextoVenda(Terminal, Loja, 1, Guid.CreateVersion7(), 2, sessao), Operador,
            banco.Relogio.Agora);

    [Fact]
    public async Task Pagamento_com_maquininha_e_pix_volta_igual_depois_de_uma_queda()
    {
        using var banco = await BancoAsync();
        var sessao = await AbrirSessaoAsync(banco);
        var repo = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var agora = banco.Relogio.Agora;
        var venda = Venda(banco, sessao.Id, await repo.ReservarNumeroVendaAsync(Ct));
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.CreateVersion7(), 1, null, "GELO", "UN", 12.90m)), 1m, "44", agora);
        venda.IniciarPagamento();
        venda.LancarPagamento(Debito, 5m, agora, RegrasFormaPagamento.ValidarPos(Debito, "06", "998877", "A1B2", 1));
        var supervisor = Guid.CreateVersion7();
        venda.LancarPagamento(Pix, 7.90m, agora, pix: new ConfirmacaoPix("JOSE DA SILVA", agora.AddMinutes(-1), "000201xyz", "L01C02000001"),
            liberacao: new Liberacao(supervisor, 0m, "PIX conferido no extrato", agora));
        await repo.SalvarEmAndamentoAsync(venda, ct: Ct);

        var recuperada = (await repo.ObterVendaAtualAsync(Ct))!;
        var (pos, pix) = (recuperada.Pagamentos[0], recuperada.Pagamentos[1]);
        Assert.Equal(((short?)2, "06", "Elo", "998877", "A1B2"), (pos.Detalhe.TipoIntegracao, pos.Detalhe.Bandeira, pos.Detalhe.BandeiraNome, pos.Detalhe.Nsu,
            pos.Detalhe.Autorizacao));
        Assert.Equal((Guid?)supervisor, pix.Detalhe.AutorizadoPorId);
        var cobranca = Assert.Single(recuperada.CobrancasPix);
        Assert.Equal((pix.Detalhe.PixCobrancaId, (Guid?)pix.Id, "JOSE DA SILVA", "000201xyz", StatusCobrancaPix.Paga),
            ((Guid?)cobranca.Id, cobranca.PagamentoVendaId, cobranca.PagadorNome, cobranca.QrcodePayload, cobranca.Status));

        // Removido o PIX, a cobrança fica cancelada no banco (a venda antiga a cita).
        recuperada.RemoverPagamento(pix.Sequencia);
        await repo.SalvarEmAndamentoAsync(recuperada, ct: Ct);
        await using var db = banco.Fabrica.CreateDbContext();
        var linha = await db.CobrancasPix.SingleAsync(Ct);
        Assert.Equal((StatusCobrancaPix.Cancelada, Terminal, Loja, 7.90m), (linha.Status, linha.TerminalId, linha.LojaId, linha.Valor));
    }

    [Fact]
    public async Task Venda_so_encerra_na_sessao_aberta_deste_terminal()
    {
        using var banco = await BancoAsync();
        var repo = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var agora = banco.Relogio.Agora;
        var venda = Venda(banco, Guid.CreateVersion7(), await repo.ReservarNumeroVendaAsync(Ct));
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.CreateVersion7(), 1, null, "GELO", "UN", 12.90m)), 1m, "44", agora);
        await repo.SalvarEmAndamentoAsync(venda, ct: Ct);
        venda.Cancelar(Operador, "Cliente desistiu da compra", agora);

        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() =>
            repo.EncerrarAsync(venda, new EventoParaOutbox(Guid.CreateVersion7(), "venda.cancelada", 1, "venda", venda.Id, agora, "{}", new string('0', 64)), ct: Ct));
        Assert.Equal(RepositorioVendas.MensagemSessaoDaVendaFechada, recusa.Message);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            Assert.Equal(StatusVenda.EmAndamento, (await db.Vendas.SingleAsync(Ct)).Status);
            Assert.Empty(await db.EventosSaida.ToListAsync(Ct));
        }

        // Sem evento (venda fora da sessão aberta, T13) a venda sai da tela: o caixa não fica preso nela.
        await repo.EncerrarAsync(venda, null, ct: Ct);
        await using var depois = banco.Fabrica.CreateDbContext();
        Assert.Equal(StatusVenda.Cancelada, (await depois.Vendas.SingleAsync(Ct)).Status);
        Assert.Empty(await depois.EventosSaida.ToListAsync(Ct));
    }

    [Fact]
    public async Task Ficha_do_produzido_idade_minima_e_regras_da_forma_voltam_depois_de_uma_queda()
    {
        // A venda recuperada é refeita pelo `produtos_venda_snapshot` (32.3): a ficha (D17), o controle de estoque e a
        // idade mínima atravessam o JSON; a restrição de idade e o "exige pessoa" da forma voltam do espelho dela.
        using var banco = await BancoAsync();
        var sessao = await AbrirSessaoAsync(banco);
        var repo = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var agora = banco.Relogio.Agora;
        var (limao, cachaca) = (Guid.CreateVersion7(), Guid.CreateVersion7());
        var caipirinha = new ProdutoVenda(Guid.CreateVersion7(), 30, null, "CAIPIRINHA", "UN", 18m)
        {
            Tipo = TipoProduto.Produzido,
            ControlaEstoque = false,
            IdadeMinima = 18,
            FichaTecnica = [new ComponenteFicha(limao, null, 0.25m, 10m), new ComponenteFicha(cachaca, null, 0.05m, 0m)],
        };
        var va = new FormaPagamentoInfo(Guid.CreateVersion7(), "Vale Alimentação", "10", "vale_alimentacao", false, RestringeIdadeMinima: true,
            ExigePessoa: true);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            db.FormasPagamento.Add(new FormaPagamentoRegistro
            {
                Id = va.Id,
                Descricao = va.Descricao,
                Ordem = 5,
                TipoForma = va.TipoForma,
                MeioPagamentoFiscal = "10",
                RestringeIdadeMinima = true,
                ExigePessoa = true,
                CriadoEm = agora,
                AtualizadoEm = agora,
                Versao = 1,
            });
            await db.SaveChangesAsync(Ct);
        }

        var venda = Venda(banco, sessao.Id, await repo.ReservarNumeroVendaAsync(Ct));
        venda.AdicionarItem(new ProdutoResolvido(caipirinha), 2m, "30", agora);
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.CreateVersion7(), 1, null, "GELO", "UN", 12.90m)), 1m, "44", agora);
        venda.IniciarPagamento();
        venda.IdentificarCliente("52998224725", null, Guid.CreateVersion7());
        venda.LancarPagamento(va, 12.90m, agora);
        await repo.SalvarEmAndamentoAsync(venda, ct: Ct);

        var recuperada = (await repo.ObterVendaAtualAsync(Ct))!;
        recuperada.RegistrarProdutos(await repo.ObterSnapshotsAsync(recuperada.Id, Ct), null, agora);
        var produto = recuperada.ProdutosRegistrados.Single(p => p.Id == caipirinha.Id);
        Assert.Equal((false, (short?)18), (produto.ControlaEstoque, produto.IdadeMinima));
        Assert.Equal(
            [new ComponenteBaixa(limao, null, 0.55m), new ComponenteBaixa(cachaca, null, 0.1m)],
            recuperada.ComponentesEstoque(recuperada.Itens.Single(i => i.ProdutoId == caipirinha.Id)));

        // O VA já pagou o gelo inteiro: a caipirinha (18 anos) não cabe nele, e o cliente do VA fica preso à venda.
        var pagamento = Assert.Single(recuperada.PagamentosAtivos);
        Assert.Equal((true, true), (pagamento.RestringeIdadeMinima, pagamento.ExigePessoa));
        Assert.Equal(0m, recuperada.MaximoFormasRestritas());
        Assert.Throws<RegraNegocioException>(() => recuperada.RemoverCliente());
    }

    [Fact]
    public async Task Saldo_estimado_desconta_as_vendas_nao_refletidas_e_os_insumos_da_ficha()
    {
        using var banco = await BancoAsync();
        var espelhos = new RepositorioEspelhos(banco.Fabrica);
        var agora = banco.Relogio.Agora;
        var (gelo, limao, outra) = (Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7());
        await espelhos.GravarAsync(
            [
                new LojaRegistro { Id = Loja, Codigo = 1, Nome = "Loja 1", EstoqueId = Estoque, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
            ],
            Ct);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            db.Set<SaldoEstoqueRegistro>().AddRange(
                new SaldoEstoqueRegistro { Id = Guid.CreateVersion7(), EstoqueId = Estoque, ProdutoId = gelo, TipoEstoqueId = Guid.CreateVersion7(), Quantidade = 40m, Versao = 1_000, CriadoEm = agora, AtualizadoEm = agora },
                new SaldoEstoqueRegistro { Id = Guid.CreateVersion7(), EstoqueId = Estoque, ProdutoId = limao, TipoEstoqueId = Guid.CreateVersion7(), Quantidade = 2m, Versao = 1_000, CriadoEm = agora, AtualizadoEm = agora },
                // Outro estoque (outra loja) não conta.
                new SaldoEstoqueRegistro { Id = Guid.CreateVersion7(), EstoqueId = Guid.CreateVersion7(), ProdutoId = gelo, TipoEstoqueId = Guid.CreateVersion7(), Quantidade = 99m, Versao = 1_000, CriadoEm = agora, AtualizadoEm = agora });
            db.EstadoSincronizacao.Add(new EstadoSincronizacao { Fluxo = "estoque", Cursor = 1_000 });
            var seq = 0L;
            EventoSaida Evento(string status, string payload, long? versao = null, long? fim = null, string? resultado = null) => new()
            {
                Id = Guid.CreateVersion7(),
                SequenciaTerminal = ++seq,
                Tipo = "venda.finalizada",
                AgregadoTipo = "venda",
                AgregadoId = Guid.CreateVersion7(),
                OcorridoEm = agora,
                CriadoEm = agora,
                Payload = payload,
                PayloadSha256 = new string('0', 64),
                Status = status,
                VersaoNuvem = versao,
                VersaoNuvemFim = fim,
                Resultado = resultado,
            };
            string Itens(params JsonObject[] itens) => new JsonObject { ["itens_venda"] = new JsonArray(itens) }.ToJsonString();
            JsonObject Item(Guid produto, string qtd, bool cancelado = false, JsonArray? componentes = null) => new()
            {
                ["produto_id"] = produto.ToString(),
                ["quantidade"] = qtd,
                ["cancelado"] = cancelado,
                ["componentes_estoque"] = componentes ?? [],
            };
            db.EventosSaida.AddRange(
                // Pendente: 12 gelos (e um item cancelado que não conta).
                Evento(StatusEventoSaida.Pendente, Itens(Item(gelo, "12.000"), Item(gelo, "3.000", cancelado: true))),
                // Confirmado e ainda não refletido (cursor 1.000 < fim 1.010; linha 1.000 ≤ versão 1.005): conta.
                Evento(StatusEventoSaida.Confirmado, Itens(Item(gelo, "2.000")), 1_005, 1_010),
                // Confirmado e refletido (o cursor passou do fim): não conta.
                Evento(StatusEventoSaida.Confirmado, Itens(Item(gelo, "5.000")), 900, 950),
                // Rejeitado conta; descartado no ERP, não.
                Evento(StatusEventoSaida.Rejeitado, Itens(Item(gelo, "1.000"))),
                Evento(StatusEventoSaida.Rejeitado, Itens(Item(gelo, "7.000")), resultado: "{\"descartado\":true,\"justificativa\":\"teste\"}"),
                // Produzido: o item não baixa; os insumos de componentes_estoque, sim.
                Evento(StatusEventoSaida.Pendente, Itens(Item(outra, "2.000", componentes: [new JsonObject { ["produto_id"] = limao.ToString(), ["quantidade"] = "0.550" }]))));
            await db.SaveChangesAsync(Ct);
        }

        var saldos = await new ConsultasVendaLocal(banco.Fabrica).SaldosEstimadosAsync([gelo, limao, outra], Ct);

        Assert.Equal((25m, 1.45m, 0m), (saldos[gelo], saldos[limao], saldos[outra]));
    }

    [Fact]
    public async Task Saldo_estimado_ignora_a_linha_de_tipo_que_deixou_de_ser_vendavel()
    {
        using var banco = await BancoAsync();
        var espelhos = new RepositorioEspelhos(banco.Fabrica);
        var agora = banco.Relogio.Agora;
        var gelo = Guid.CreateVersion7();
        var (disponivel, mostruario, semEspelho) = (Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7());
        await espelhos.GravarAsync(
            [
                new LojaRegistro { Id = Loja, Codigo = 1, Nome = "Loja 1", EstoqueId = Estoque, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
                new TipoEstoqueRegistro { Id = disponivel, Nome = "Disponível", Vendavel = true, Padrao = true, Ativo = true, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
                // Deixou de ser vendável na nuvem: a linha do saldo saiu do filtro do pull, mas ficou no espelho.
                new TipoEstoqueRegistro { Id = mostruario, Nome = "Mostruário", Vendavel = false, Ativo = true, CriadoEm = agora, AtualizadoEm = agora, Versao = 2 },
            ],
            Ct);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            SaldoEstoqueRegistro Saldo(Guid tipo, decimal quantidade) => new()
            {
                Id = Guid.CreateVersion7(),
                EstoqueId = Estoque,
                ProdutoId = gelo,
                TipoEstoqueId = tipo,
                Quantidade = quantidade,
                Versao = 1_000,
                CriadoEm = agora,
                AtualizadoEm = agora,
            };
            // O tipo que ainda não desceu no fluxo `configuracao` conta: a linha só desce se o tipo era vendável.
            db.Set<SaldoEstoqueRegistro>().AddRange(Saldo(disponivel, 40m), Saldo(mostruario, 10m), Saldo(semEspelho, 3m));
            await db.SaveChangesAsync(Ct);
        }

        var saldos = await new ConsultasVendaLocal(banco.Fabrica).SaldosEstimadosAsync([gelo], Ct);

        Assert.Equal(43m, saldos[gelo]);
    }

    [Fact]
    public async Task Dados_da_loja_cliente_do_f5_e_ficha_tecnica_vem_dos_espelhos()
    {
        using var banco = await BancoAsync();
        var espelhos = new RepositorioEspelhos(banco.Fabrica);
        var agora = banco.Relogio.Agora;
        var (caipirinha, limao) = (Guid.CreateVersion7(), Guid.CreateVersion7());
        var unidade = Guid.CreateVersion7();
        await espelhos.GravarAsync(
            [
                new LojaRegistro
                {
                    Id = Loja, Codigo = 1, Nome = "Loja 1", RazaoSocial = "ICE BEER COMÉRCIO DE BEBIDAS LTDA", NomeFantasia = "Ice Beer", Cnpj = "12345678000195",
                    Logradouro = "Rua XV de Novembro", Numero = "1000", Bairro = "Centro", Uf = "PR", MunicipioIbge = 4106902, ChavePix = " pix@icebeer.com.br ",
                    FraseRodapeCupom = "Volte sempre!", EstoqueId = Estoque, CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
                new PessoaRegistro { Id = Guid.CreateVersion7(), Codigo = 10, Nome = "JOÃO CLIENTE", CpfCnpj = "52998224725", Ativa = true, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
                new PessoaRegistro { Id = Guid.CreateVersion7(), Codigo = 11, Nome = "JOANA INATIVA", Ativa = false, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
                new UnidadeMedidaRegistro { Id = unidade, Sigla = "UN", Descricao = "Unidade", CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
                new ProdutoRegistro { Id = caipirinha, Codigo = 30, Nome = "CAIPIRINHA", Tipo = TipoProduto.Produzido, UnidadeId = unidade, PrecoVenda = 18m, UsaFichaTecnica = true, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
                new ProdutoComponenteRegistro { Id = Guid.CreateVersion7(), ProdutoId = caipirinha, Tipo = "ficha_tecnica", ComponenteId = limao, Quantidade = 0.25m, PerdaPct = 10m, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
            ],
            Ct);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            db.Set<MunicipioRegistro>().Add(new MunicipioRegistro { CodigoIbge = 4106902, Nome = "Curitiba", Uf = "PR", CriadoEm = agora, AtualizadoEm = agora, Versao = 1 });
            await db.SaveChangesAsync(Ct);
        }

        var consultas = new ConsultasVendaLocal(banco.Fabrica);
        var loja = (await consultas.DadosLojaAsync(Loja, Ct))!;
        Assert.Equal(("Ice Beer", "12.345.678/0001-95", "Rua XV de Novembro, 1000 - Centro - Curitiba/PR", "pix@icebeer.com.br", "Volte sempre!"),
            (loja.NomeLoja, loja.Cnpj, loja.Endereco, loja.ChavePix, loja.FraseRodape));
        Assert.Equal("Curitiba", loja.PixCidadeRecebedor);

        Assert.Equal("JOÃO CLIENTE", (await consultas.ClientePorDocumentoAsync("52998224725", Ct))!.Nome);
        Assert.Equal(["JOÃO CLIENTE"], (await consultas.BuscarClientesAsync("joao", Ct)).Select(c => c.Nome));
        Assert.Equal(["JOÃO CLIENTE"], (await consultas.BuscarClientesAsync("529.982", Ct)).Select(c => c.Nome));
        Assert.Equal([("JOANA INATIVA", false)], (await consultas.BuscarClientesAsync("11", Ct)).Select(c => (c.Nome, c.Ativa)));
        Assert.Empty(await consultas.BuscarClientesAsync("j", Ct));

        var produto = (await new CatalogoLocal(banco.Fabrica).ObterAsync(caipirinha, Ct))!;
        Assert.Equal([new ComponenteFicha(limao, null, 0.25m, 10m)], produto.FichaTecnica);
        Assert.True(produto.ControlaEstoque);
    }
}
