using Avalonia.Headless.XUnit;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Tests;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Backup;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Sync.Cliente;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.E2E.Tests;

/// <summary>
/// Critério do roadmap (Fase 1, SYNC 22.1; Fase 1C, bloco C17): "banco local restaurado de um backup de 2 h atrás: o PDV
/// detecta a regressão, recupera pelo <c>GET /sync/recuperar</c> e só então libera vendas, sem duplicar nada", contra a
/// API de verdade, no quarto caixa da loja Treino:
/// <list type="number">
/// <item>Ativação, abertura e uma venda; o backup periódico (o "de 2 h atrás"); mais duas vendas e uma sangria, todas
/// na nuvem.</item>
/// <item>O app fecha e o banco volta ao backup pela restauração (a mesma do Ctrl+Alt+C › Restaurar backup).</item>
/// <item>Reaberto: o handshake vê a regressão, reidrata (as vendas e a sangria voltam ao caixa, os eventos com o mesmo id
/// e a mesma sequência, já confirmados), salta a numeração e libera o login; a sessão aberta continua.</item>
/// <item>Uma venda nova sai com o número saltado e sobe; o ERP tem as quatro vendas, sem repetir nenhuma, e nenhum
/// evento com erro.</item>
/// </list>
/// </summary>
public sealed class RecuperacaoBackupTests
{
    private static readonly TimeSpan Esvaziar = TimeSpan.FromMinutes(3);

    public static bool Habilitado => EstadoE2E.Habilitado;

    private static async Task EsvaziarAsync(AmbienteUi pdv, string descricao)
    {
        var sync = pdv.Servicos.GetRequiredService<IServicoSincronizacao>();
        await RoteiroE2E.EsperarAsync(() => Task.FromResult(sync.Situacao is { Online: true, Pendentes: 0 }), descricao, Esvaziar);
    }

    [AvaloniaFact(SkipUnless = nameof(Habilitado), Skip = "Defina GENESIS_E2E_API e GENESIS_E2E_ESTADO (servidor de apps/api/test/e2e-pdv).")]
    public async Task Backup_de_2_h_restaurado_recupera_pela_nuvem_e_so_entao_libera_sem_duplicar()
    {
        var estado = await EstadoE2E.CarregarAsync(TimeSpan.FromMinutes(3));
        using var erp = await ErpE2E.EntrarAsync(estado);
        var lata = estado.Catalogo.Lata.Ean;
        var raiz = AmbienteUi.NovaRaiz();
        var caminhos = CaminhosPdv.SobRaiz(raiz);
        try
        {
            Guid terminal;
            Guid sessao;
            string backup;
            long eventosAntes;
            using (var pdv = await RoteiroE2E.IniciarAsync(raiz: raiz))
            {
                terminal = await RoteiroE2E.AtivarECarregarAsync(pdv, estado, await erp.GerarCodigoAsync(estado.LojaId, estado.Caixas[3]));
                var venda = await pdv.LogarAsync(estado.Operador.Login, estado.Operador.Pin, "100");
                sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixaId!.Value;
                await RoteiroE2E.IncluirAsync(pdv, venda, lata);
                await RoteiroE2E.PagarEmDinheiroAsync(pdv, venda);
                await EsvaziarAsync(pdv, "venda 1 na nuvem");

                // O backup "de 2 h atrás" (PDV 32.5: o periódico com o caixa aberto); o que vem depois só a nuvem guarda.
                backup = (await pdv.Servicos.GetRequiredService<ServicoBackup>().TentarAsync(MotivosBackup.Periodico))!.Arquivo;
                for (var i = 0; i < 2; i++)
                {
                    await RoteiroE2E.IncluirAsync(pdv, venda, lata);
                    await RoteiroE2E.PagarEmDinheiroAsync(pdv, venda);
                }

                await RoteiroE2E.SangriaAsync(pdv, venda, "20", "GERENTE");
                await EsvaziarAsync(pdv, "vendas 2 e 3 e a sangria na nuvem");
                await using var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
                eventosAntes = await db.EventosSaida.CountAsync();
            }

            var naNuvem = await erp.ObterAsync($"api/vendas?sessaoCaixaId={sessao:D}&treino=somente&tamanho=50");
            Assert.Equal(3, naNuvem["totais"]!["quantidade"]!.GetValue<int>());

            // O banco volta ao backup (a ação do Ctrl+Alt+C › Restaurar backup, com o app fechado).
            SqliteConnection.ClearAllPools();
            var fabrica = new FabricaPdvDb(caminhos.ArquivoBanco);
            var relogio = new RelogioSistema();
            var restaurado = await new RestauracaoBackup(fabrica, caminhos, new BackupLocal(fabrica, caminhos, relogio), relogio)
                .RestaurarAsync(backup, null, null);
            Assert.False(restaurado.Pendente.BackupDeSaida);
            SqliteConnection.ClearAllPools();

            using (var pdv = await RoteiroE2E.IniciarAsync(raiz: raiz))
            {
                // O handshake reidratou antes do login: sem bloqueio, nada pendente, tudo de novo no caixa.
                await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, $"login depois da recuperação ({pdv.Shell.PaginaAtual?.GetType().Name})", 60_000);
                var sync = pdv.Servicos.GetRequiredService<IServicoSincronizacao>();
                Assert.Equal(EstadoTerminalSync.Ativo, sync.Situacao.Terminal);
                await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
                {
                    Assert.Equal(3, await db.Vendas.CountAsync(v => v.SessaoCaixaId == sessao && v.Status == "finalizada"));
                    Assert.Equal(1, await db.MovimentosCaixa.CountAsync(m => m.SessaoCaixaId == sessao && m.Tipo == TipoMovimentoCaixa.Sangria));
                    // Os eventos de antes da perda voltaram com a mesma sequência, já confirmados; nada repetido, nada pulado.
                    var eventos = await db.EventosSaida.OrderBy(e => e.SequenciaTerminal).ToListAsync();
                    Assert.Equal(eventos.Select((_, i) => (long)i + 1), eventos.Select(e => e.SequenciaTerminal));
                    Assert.All(eventos.Take((int)eventosAntes), e => Assert.Equal(StatusEventoSaida.Confirmado, e.Status));
                    Assert.True(eventos.Count >= eventosAntes);
                    Assert.Null(await db.ConfiguracaoTerminal.FirstOrDefaultAsync(c => c.Chave == ChavesConfiguracaoTerminal.RestauracaoPendente));
                    // Foi a regressão (a nuvem à frente do banco) que o handshake detectou, e não só a restauração pendente,
                    // que sozinha também reidrataria e saltaria (22.1): o motivo fica no log_local.
                    Assert.Equal(1, await db.LogLocal.CountAsync(l => l.Origem == "sync" && l.Mensagem.StartsWith("Recuperação 22.1 (regressao)")));
                    Assert.Equal(0, await db.LogLocal.CountAsync(l => l.Mensagem.StartsWith("Recuperação 22.1 (restauracao)")));
                }

                // A sessão do backup continua aberta (o operador volta à venda) e a venda nova sai com o número saltado.
                var venda = await pdv.LogarAsync(estado.Operador.Login, estado.Operador.Pin, "100");
                Assert.Equal(sessao, pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixaId);
                await RoteiroE2E.IncluirAsync(pdv, venda, lata);
                await RoteiroE2E.PagarEmDinheiroAsync(pdv, venda);
                await EsvaziarAsync(pdv, "venda nova depois da recuperação na nuvem");
                await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
                {
                    var numeros = await db.Vendas.Where(v => v.SessaoCaixaId == sessao).OrderBy(v => v.Numero).Select(v => v.Numero).ToListAsync();
                    Assert.Equal(4, numeros.Count);
                    Assert.True(numeros[3] > numeros[2] + SaltoNumeracao.Margem, $"números {string.Join(", ", numeros)}");
                }
            }

            var vendas = await erp.ObterAsync($"api/vendas?sessaoCaixaId={sessao:D}&treino=somente&tamanho=50");
            Assert.Equal(4, vendas["totais"]!["quantidade"]!.GetValue<int>());
            var numerosErp = vendas["itens"]!.AsArray().Select(v => v!["numero"]!.GetValue<long>()).ToList();
            Assert.Equal(numerosErp.Count, numerosErp.Distinct().Count());
            Assert.Single((await erp.ObterAsync($"api/movimentos-caixa/sangrias?sessaoCaixaId={sessao:D}&treino=somente"))["itens"]!.AsArray());
            Assert.Equal(0, (await erp.ObterAsync($"api/terminais/{terminal:D}/eventos-erro"))["total"]!.GetValue<int>());
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            try
            {
                Directory.Delete(raiz, recursive: true);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // No Windows o SQLite pode segurar o arquivo por alguns ms: a pasta fica no %TEMP%.
            }
        }
    }
}
