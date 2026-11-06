using GenesisPDV.App.Servicos;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Fase 1C (bloco C9): o contexto de toda venda vem do terminal, da sessão aberta e da loja — fuso do espelho
/// <c>lojas</c> e hora de corte de <c>geral.dia_operacional_hora_corte</c> (D7: 05:00 na empresa, ajustável por loja).
/// </summary>
public sealed class SessaoTerminalTests : IDisposable
{
    private readonly string _raiz = Path.Combine(Path.GetTempPath(), "genesispdv-sessao", Guid.NewGuid().ToString("N"));
    private readonly FabricaPdvDb _fabrica;
    private readonly IRelogio _relogio = new RelogioSistema();

    public SessaoTerminalTests()
    {
        var caminhos = CaminhosPdv.SobRaiz(_raiz);
        caminhos.CriarPastas();
        _fabrica = new FabricaPdvDb(caminhos.ArquivoBanco);
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Contexto_leva_a_sessao_aberta_o_fuso_da_loja_e_a_hora_de_corte()
    {
        await InicializadorBanco.InicializarAsync(_fabrica, Path.Combine(_raiz, "backup"), _relogio.Agora, Ct);
        var loja = Guid.CreateVersion7();
        var identidade = new IdentidadeTerminal
        {
            TerminalId = Guid.CreateVersion7(),
            LojaId = loja,
            CaixaId = Guid.CreateVersion7(),
            NumeroCaixa = 2,
            UrlApi = "https://api.exemplo/",
            AtivadoEm = _relogio.Agora,
        };
        await using (var db = _fabrica.CreateDbContext())
        {
            db.IdentidadeTerminal.Add(identidade);
            db.Lojas.Add(new LojaRegistro { Id = loja, Codigo = 3, Nome = "Loja 3", FusoHorario = "America/Manaus", Versao = 1 });
            await db.SaveChangesAsync(Ct);
        }

        var sessao = new SessaoTerminal { Identidade = identidade };
        var configuracoes = new RepositorioConfiguracoes(_fabrica);
        await sessao.CarregarDoEspelhoAsync(_fabrica, Ct);
        await sessao.CarregarConfiguracoesAsync(configuracoes, Ct);
        // Sem a chave no espelho, o padrão do catálogo (D7); sem sessão aberta, a venda não tem sessão.
        Assert.Equal((new TimeOnly(5, 0), "America/Manaus", (Guid?)null), (sessao.HoraCorteDiaOperacional, sessao.FusoHorario, sessao.Contexto().SessaoCaixaId));

        // A empresa com valor diferente do padrão: a linha de escopo `empresa` vale sobre o padrão.
        await using (var db = _fabrica.CreateDbContext())
        {
            db.Configuracoes.Add(new ConfiguracaoRegistro
            {
                Id = Guid.CreateVersion7(),
                Chave = ChavesConfiguracao.HoraCorteDiaOperacional,
                Valor = "\"04:00\"",
                Versao = 1,
            });
            await db.SaveChangesAsync(Ct);
        }

        await sessao.CarregarConfiguracoesAsync(configuracoes, Ct);
        Assert.Equal(new TimeOnly(4, 0), sessao.HoraCorteDiaOperacional);

        // E a da loja vale sobre a da empresa.
        await using (var db = _fabrica.CreateDbContext())
        {
            db.Configuracoes.Add(new ConfiguracaoRegistro
            {
                Id = Guid.CreateVersion7(),
                Escopo = "loja",
                LojaId = loja,
                Chave = ChavesConfiguracao.HoraCorteDiaOperacional,
                Valor = "\"03:30\"",
                Versao = 1,
            });
            await db.SaveChangesAsync(Ct);
        }

        var caixa = new RepositorioCaixa(_fabrica, _relogio);
        var aberta = new SessaoCaixaRegistro
        {
            Id = IdGerador.Novo(),
            LojaId = loja,
            CaixaId = identidade.CaixaId,
            NumeroCaixa = 2,
            TerminalId = identidade.TerminalId,
            OperadorId = Guid.CreateVersion7(),
            DiaOperacional = new DateOnly(2026, 10, 29),
            AbertaEm = _relogio.Agora,
            FundoTroco = 0m,
        };
        // Handshake com uma API que não anuncia o caixa.aberto: recusado (T13). Sem handshake nenhum (nulo) ou com o
        // anúncio, abre.
        await using (var db = _fabrica.CreateDbContext())
        {
            await db.EstadoConexao.ExecuteUpdateAsync(c => c.SetProperty(e => e.VersoesSchemaNuvem, """{"auditoria.registros":[1]}"""), Ct);
        }

        await Assert.ThrowsAsync<RegraNegocioException>(() => caixa.AbrirAsync(aberta, null, Evento(aberta), Ct));
        await using (var db = _fabrica.CreateDbContext())
        {
            await db.EstadoConexao.ExecuteUpdateAsync(c => c.SetProperty(e => e.VersoesSchemaNuvem, """{"caixa.aberto":[1]}"""), Ct);
        }

        await caixa.AbrirAsync(aberta, null, Evento(aberta), Ct);
        await sessao.CarregarConfiguracoesAsync(configuracoes, Ct);
        await sessao.CarregarSessaoCaixaAsync(caixa, Ct);

        var contexto = sessao.Contexto();
        Assert.Equal((aberta.Id, "America/Manaus", new TimeOnly(3, 30)), (contexto.SessaoCaixaId!.Value, contexto.FusoHorario, contexto.HoraCorteDiaOperacional));
        // 07:45 UTC de 30/10 = 03:45 em Manaus: depois do corte da loja (03:30), conta no dia 30. Com o corte da empresa
        // (04:00) ou o padrão (05:00), ficaria no dia 29.
        var instante = new DateTimeOffset(2026, 10, 30, 7, 45, 0, TimeSpan.Zero);
        var venda = Venda.Iniciar(Guid.CreateVersion7(), 1, contexto, aberta.OperadorId, instante);
        venda.AdicionarItem(new Core.Produtos.ProdutoResolvido(new Core.Produtos.ProdutoVenda(Guid.CreateVersion7(), 1, null, "ÁGUA", "UN", 2.50m)), 1m, "789", instante);
        venda.IniciarPagamento();
        venda.LancarPagamento(new FormaPagamentoInfo(Guid.CreateVersion7(), "Dinheiro", "01", "dinheiro", true), 2.50m, instante);
        venda.Finalizar(instante, Guid.CreateVersion7());
        Assert.Equal((new DateOnly(2026, 10, 30), (Guid?)aberta.Id), (venda.DiaOperacional, venda.SessaoCaixaId));
    }

    private static EventoParaOutbox Evento(SessaoCaixaRegistro s) =>
        new(IdGerador.Novo(), "caixa.aberto", 1, "sessao_caixa", s.Id, s.AbertaEm, "{}", "x") { UsuarioId = s.OperadorId, SessaoCaixaId = s.Id };

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try
        {
            Directory.Delete(_raiz, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // No Windows o arquivo pode seguir aberto por alguns ms (WAL/shm); a pasta fica no %TEMP%.
        }
    }
}
