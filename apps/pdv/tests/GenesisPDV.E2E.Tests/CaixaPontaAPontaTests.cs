using Avalonia.Headless.XUnit;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Sync.Cliente;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.E2E.Tests;

/// <summary>
/// E2E curto do caixa da Fase 1C (bloco C13), o PDV de verdade sem tela contra a API local, pelo teclado:
/// <list type="number">
/// <item>Ativação e carga, login e abertura do caixa com o fundo contado (O4).</item>
/// <item>Uma venda com o fardo de 12 pelo DUN, a retornável sem o casco (casco cobrado) e o combo de whisky.</item>
/// <item>Sangria pelo F11 com quem retira (O5).</item>
/// <item>Uma venda paga cancelada pelo F12 com a liberação do gerente (forma A do <c>venda.cancelada</c>, O6).</item>
/// <item>Cabo puxado: uma venda com o casco trazido e o fechamento cego (O3) offline; o outbox espera.</item>
/// <item>Cabo de volta: o outbox esvazia sozinho (o backoff de transporte zera na reconexão, SYNC 18.3) e o ERP confere pelas próprias
/// consultas: vendas da sessão (15.4) só com o filtro da loja de treino (O10), a sangria (15.3), a sessão fechada
/// (14.9), nenhum evento com erro (12.5) e o estoque baixado pelo fardo, pelo casco cobrado, pelos componentes do combo
/// e devolvido pelo cancelamento.</item>
/// </list>
/// </summary>
public sealed class CaixaPontaAPontaTests
{
    private static readonly TimeSpan Esvaziar = TimeSpan.FromMinutes(3);

    public static bool Habilitado => EstadoE2E.Habilitado;

    [AvaloniaFact(SkipUnless = nameof(Habilitado), Skip = "Defina GENESIS_E2E_API e GENESIS_E2E_ESTADO (servidor de apps/api/test/e2e-pdv).")]
    public async Task Abre_vende_fardo_combo_e_casco_sangra_cancela_fecha_offline_e_o_erp_confere_tudo()
    {
        var estado = await EstadoE2E.CarregarAsync(TimeSpan.FromMinutes(3));
        using var erp = await ErpE2E.EntrarAsync(estado);
        var c = estado.Catalogo;
        var antes = new
        {
            Lata = await RoteiroE2E.SaldosAsync(erp, estado, c.Lata.Id, c.Lata.Ean),
            Retornavel = await RoteiroE2E.SaldosAsync(erp, estado, c.Retornavel.Id, c.Retornavel.Ean!),
            Casco = await RoteiroE2E.SaldosAsync(erp, estado, c.Casco.Id, "CASCO 600ML"),
            Gelo = await RoteiroE2E.SaldosAsync(erp, estado, c.ComponentesCombo[2], "GELO DE COCO"),
        };

        var rede = new RedeSimulada();
        using var pdv = await RoteiroE2E.IniciarAsync(rede);
        var terminal = await RoteiroE2E.AtivarECarregarAsync(pdv, estado, await erp.GerarCodigoAsync(estado.LojaId, estado.Caixas[1]));

        // 1. Login e abertura com o fundo de R$ 100,00.
        var venda = await pdv.LogarAsync(estado.Operador.Login, estado.Operador.Pin, "100");
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixaId!.Value;

        // 2. Fardo pelo DUN (12 UN numa linha), retornável sem o vazio (casco cobrado) e o combo com os padrões.
        await RoteiroE2E.IncluirAsync(pdv, venda, c.Lata.Dun);
        var fardo = pdv.Servicos.GetRequiredService<ServicoVenda>().Atual!.ItensAtivos.Last();
        Assert.Equal(12m, fardo.Quantidade);
        await RoteiroE2E.IncluirAsync(pdv, venda, c.Retornavel.Ean!, cascosTrazidos: 0);
        Assert.Contains(venda.Itens, l => l.Descricao.EndsWith("(casco)", StringComparison.Ordinal));
        await RoteiroE2E.IncluirAsync(pdv, venda, c.Combo.Ean!);
        Assert.Contains(venda.Itens, l => l.EhTituloCombo && l.Descricao == "COMBO DE WHISKY 1L");
        pdv.Captura("e2e-10-fardo-casco-combo");
        await RoteiroE2E.PagarEmDinheiroAsync(pdv, venda);

        // 3. Sangria de R$ 50,00.
        await RoteiroE2E.SangriaAsync(pdv, venda, "50", "GERENTE");

        // 4. Venda paga cancelada pelo F12, liberada pelo gerente.
        await RoteiroE2E.IncluirAsync(pdv, venda, c.Lata.Ean);
        await RoteiroE2E.PagarEmDinheiroAsync(pdv, venda);
        await RoteiroE2E.CancelarUltimaVendaPagaAsync(pdv, venda, estado.Gerente, "Cliente desistiu da compra no balcão");
        var sync = pdv.Servicos.GetRequiredService<IServicoSincronizacao>();
        await RoteiroE2E.EsperarAsync(() => Task.FromResult(sync.Situacao.Pendentes == 0), "online: tudo enviado", Esvaziar);

        // 5. Cabo puxado: venda com o casco trazido e o fechamento cego, offline.
        rede.Desligada = true;
        await RoteiroE2E.EsperarOfflineAsync(pdv);
        Assert.StartsWith("● Offline", pdv.Texto("TextoConexao"), StringComparison.Ordinal);
        await RoteiroE2E.IncluirAsync(pdv, venda, c.Retornavel.Ean!, cascosTrazidos: 1);
        await RoteiroE2E.IncluirAsync(pdv, venda, c.Lata.Ean);
        await RoteiroE2E.PagarEmDinheiroAsync(pdv, venda);
        pdv.Captura("e2e-11-venda-offline");
        await RoteiroE2E.FecharCaixaAsync(pdv, "150");
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            var naoEnviados = await db.EventosSaida.Where(e => e.Status != StatusEventoSaida.Confirmado).Select(e => e.Tipo).ToListAsync();
            Assert.Contains("venda.finalizada", naoEnviados);
            Assert.Contains("caixa.fechado", naoEnviados);
        }

        Assert.False(sync.Situacao.Online);

        // 6. Cabo de volta: o outbox esvazia sem ninguém pedir.
        rede.Desligada = false;
        await RoteiroE2E.EsperarAsync(() => Task.FromResult(sync.Situacao is { Online: true, Pendentes: 0 }), "reconexão: outbox vazio", Esvaziar);
        pdv.Captura("e2e-12-reconectado");

        // O ERP pelas consultas da tela. Loja de treino (O10): fora por padrão, dentro com o filtro.
        Assert.Equal(0, (await erp.ObterAsync($"api/vendas?sessaoCaixaId={sessao:D}"))["total"]!.GetValue<int>());
        var vendas = await erp.ObterAsync($"api/vendas?sessaoCaixaId={sessao:D}&treino=somente&tamanho=50");
        Assert.Equal((3, 1), (vendas["totais"]!["quantidade"]!.GetValue<int>(), vendas["totais"]!["canceladas"]!.GetValue<int>()));
        Assert.All(vendas["itens"]!.AsArray(), v => Assert.True(v!["lojaTreino"]!.GetValue<bool>()));
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            var locais = (await db.Vendas.Where(v => v.SessaoCaixaId == sessao && v.Status == "finalizada").Select(v => v.Total).ToListAsync()).Sum();
            Assert.Equal(locais, RoteiroE2E.Decimal(vendas["totais"]!["totalLiquido"]));
        }

        var sangrias = (await erp.ObterAsync($"api/movimentos-caixa/sangrias?sessaoCaixaId={sessao:D}&treino=somente"))["itens"]!.AsArray();
        Assert.Equal(["sangria", "sangria_fechamento"], sangrias.Select(s => s!["tipo"]!.GetValue<string>()).Order(StringComparer.Ordinal));
        Assert.Equal(50m, RoteiroE2E.Decimal(sangrias.Single(s => s!["tipo"]!.GetValue<string>() == "sangria")!["valor"]));

        var sessaoErp = await erp.ObterAsync($"api/sessoes-caixa/{sessao:D}");
        Assert.Equal("fechada", sessaoErp["situacao"]!.GetValue<string>());
        Assert.Equal(150m, RoteiroE2E.Decimal(sessaoErp["totalInformado"]));
        Assert.Equal(0, (await erp.ObterAsync($"api/terminais/{terminal:D}/eventos-erro"))["total"]!.GetValue<int>());

        // Estoque: o fardo baixa 12 e a lata da venda offline 1 (a cancelada voltou); a retornável 2; o casco cobrado sai
        // do disponível e o trazido entra nos vazios; o combo baixa os componentes (2 gelos).
        var lata = await RoteiroE2E.SaldosAsync(erp, estado, c.Lata.Id, c.Lata.Ean);
        var retornavel = await RoteiroE2E.SaldosAsync(erp, estado, c.Retornavel.Id, c.Retornavel.Ean!);
        var casco = await RoteiroE2E.SaldosAsync(erp, estado, c.Casco.Id, "CASCO 600ML");
        var gelo = await RoteiroE2E.SaldosAsync(erp, estado, c.ComponentesCombo[2], "GELO DE COCO");
        Assert.Equal(-13m, lata.Values.Sum() - antes.Lata.Values.Sum());
        Assert.Equal(-2m, retornavel.Values.Sum() - antes.Retornavel.Values.Sum());
        Assert.Equal(-2m, gelo.Values.Sum() - antes.Gelo.Values.Sum());
        var vazios = casco.Keys.Single(k => k.Contains("vazio", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(1m, casco[vazios] - antes.Casco.GetValueOrDefault(vazios));
        Assert.Equal(-1m, casco.Where(k => k.Key != vazios).Sum(k => k.Value) - antes.Casco.Where(k => k.Key != vazios).Sum(k => k.Value));
    }
}
