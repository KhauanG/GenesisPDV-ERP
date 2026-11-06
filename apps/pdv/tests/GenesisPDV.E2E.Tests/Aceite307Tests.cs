using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Avalonia.Headless.XUnit;
using GenesisPDV.App.Servicos;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.E2E.Tests;

/// <summary>
/// Critério de aceite do PDV 30.7 (Fase 1C, C13; definição de pronto da Fase 1): o caixa perde a rede, vende 200 vendas
/// (lata, fardo pelo DUN, retornável com o casco trazido e combo), faz uma sangria e fecha às cegas, tudo offline; ao
/// reconectar, a resposta do primeiro lote se perde depois da API gravar e o PDV reenvia o mesmo lote; tudo chega sem
/// duplicar e o contador de pendentes cai a 0. O ERP confere pelas próprias consultas: 200 vendas da sessão com o total
/// do caixa, a sangria, a sessão fechada, nenhum evento com erro e o estoque baixado.
/// <para>
/// Duração: no CI as 200 vendas saem em seguida. O único comportamento do PDV que depende do tempo offline é o handshake
/// na volta depois de 1 h (SYNC 18.3; sem limite de dias, O18, e o token do PDV não vence): no modo comprimido o limite
/// cai para 1 s, e o roteiro passa pelo handshake antes do push como o de 4 h. <c>GENESIS_E2E_30_7_MINUTOS</c> (o
/// workflow "Aceite PDV", 240 = as 4 h do critério) espalha as vendas por esse tempo, com o teto de backoff de produção.
/// O token do ERP vence em 15 min e a sessão em 60 min ociosa: o gerente entra de novo no ERP depois da reconexão para
/// conferir. Com <c>GENESIS_E2E_RELATORIOS</c>, o resultado vai para <c>pdv-30-7.json</c> nessa pasta (anexado ao PR
/// como condição de merge).
/// </para>
/// </summary>
public sealed class Aceite307Tests
{
    private const int Vendas = 200;
    private const int VendaDaSangria = 100;

    public static bool Habilitado => EstadoE2E.Habilitado;

    private static double MinutosOffline =>
        double.TryParse(Environment.GetEnvironmentVariable("GENESIS_E2E_30_7_MINUTOS"), NumberStyles.Float, CultureInfo.InvariantCulture, out var m)
            ? Math.Max(0, m)
            : 0;

    [AvaloniaFact(SkipUnless = nameof(Habilitado), Skip = "Defina GENESIS_E2E_API e GENESIS_E2E_ESTADO (servidor de apps/api/test/e2e-pdv).")]
    public async Task Duzentas_vendas_offline_com_sangria_e_fechamento_chegam_todas_sem_duplicar_mesmo_reenviando_o_lote()
    {
        var estado = await EstadoE2E.CarregarAsync(TimeSpan.FromMinutes(3));
        using var erp = await ErpE2E.EntrarAsync(estado);
        var c = estado.Catalogo;
        var lataAntes = (await RoteiroE2E.SaldosAsync(erp, estado, c.Lata.Id, c.Lata.Ean)).Values.Sum();

        var minutos = MinutosOffline;
        var rede = new RedeSimulada();
        using var pdv = await RoteiroE2E.IniciarAsync(rede, backoffCurto: minutos == 0,
            handshakeAposOffline: minutos < 60 ? TimeSpan.FromSeconds(1) : null);
        var terminal = await RoteiroE2E.AtivarECarregarAsync(pdv, estado, await erp.GerarCodigoAsync(estado.LojaId, estado.Caixas[2]));
        var venda = await pdv.LogarAsync(estado.Operador.Login, estado.Operador.Pin, "100");
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixaId!.Value;
        var sync = pdv.Servicos.GetRequiredService<IServicoSincronizacao>();
        await RoteiroE2E.EsperarAsync(() => Task.FromResult(sync.Situacao.Pendentes == 0), "abertura enviada", TimeSpan.FromMinutes(2));

        // Cabo puxado.
        rede.Desligada = true;
        var offline = Stopwatch.StartNew();
        await RoteiroE2E.EsperarOfflineAsync(pdv);
        var intervalo = TimeSpan.FromMinutes(minutos / Vendas);
        var lataVendida = 0;
        for (var i = 0; i < Vendas; i++)
        {
            switch (i % 10)
            {
                case 1:
                    await RoteiroE2E.IncluirAsync(pdv, venda, c.Lata.Dun);
                    lataVendida += 12;
                    break;
                case 2:
                    await RoteiroE2E.IncluirAsync(pdv, venda, c.Retornavel.Ean!, cascosTrazidos: 1);
                    break;
                default:
                    await RoteiroE2E.IncluirAsync(pdv, venda, c.Lata.Ean);
                    lataVendida++;
                    break;
            }

            if (i % 20 == 0)
            {
                await RoteiroE2E.IncluirAsync(pdv, venda, c.Combo.Ean!);
            }

            await RoteiroE2E.PagarEmDinheiroAsync(pdv, venda);
            if (i == VendaDaSangria)
            {
                await RoteiroE2E.SangriaAsync(pdv, venda, "100", "GERENTE");
            }

            if (intervalo > TimeSpan.Zero)
            {
                await RoteiroE2E.PausaAsync(intervalo);
            }
        }

        // Fechamento cego contando exatamente a gaveta estimada (diferença zero).
        var gaveta = await pdv.Servicos.GetRequiredService<RepositorioCaixa>().DinheiroGavetaAsync(sessao) ?? 0m;
        await RoteiroE2E.FecharCaixaAsync(pdv, gaveta.ToString("0.00", CultureInfo.GetCultureInfo("pt-BR")));
        int eventos;
        decimal totalLocal;
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            eventos = await db.EventosSaida.CountAsync(e => e.Status != StatusEventoSaida.Confirmado);
            totalLocal = (await db.Vendas.Where(v => v.SessaoCaixaId == sessao && v.Status == "finalizada").Select(v => v.Total).ToListAsync()).Sum();
            Assert.Equal(Vendas, await db.Vendas.CountAsync(v => v.SessaoCaixaId == sessao && v.Status == "finalizada"));
        }

        Assert.True(eventos >= Vendas + 2, $"{eventos} evento(s) no outbox");
        Assert.Equal(eventos, sync.Situacao.Pendentes);
        offline.Stop();

        // Cabo de volta: a resposta do primeiro lote se perde depois da API gravar; o PDV reenvia o mesmo lote.
        var handshakesAntes = rede.Handshakes;
        rede.PerderRespostasDoPush(1);
        rede.Desligada = false;
        var esvaziar = Stopwatch.StartNew();
        await RoteiroE2E.EsperarAsync(() => Task.FromResult(sync.Situacao.Online), "online de novo", TimeSpan.FromMinutes(10));
        var ateOnline = esvaziar.Elapsed;
        await RoteiroE2E.EsperarAsync(() => Task.FromResult(sync.Situacao is { Online: true, Pendentes: 0 }), "outbox vazio", TimeSpan.FromMinutes(10));
        esvaziar.Stop();
        Assert.True(rede.LotesReenviados >= 1, "o lote sem resposta foi reenviado");
        var handshakesNaVolta = rede.Handshakes - handshakesAntes;
        Assert.True(handshakesNaVolta >= 1, "handshake na volta do offline longo (SYNC 18.3)");

        // O ERP: 200 vendas, o total do caixa, a sangria, a sessão fechada sem diferença e nenhum evento com erro. O
        // gerente entra de novo: depois das 4 h o token do primeiro login venceu e a sessão expirou por inatividade.
        using var erpVolta = await ErpE2E.EntrarAsync(estado);
        var vendas = await erpVolta.ObterAsync($"api/vendas?sessaoCaixaId={sessao:D}&treino=somente&tamanho=20");
        var nuvem = (Quantidade: vendas["totais"]!["quantidade"]!.GetValue<int>(), Canceladas: vendas["totais"]!["canceladas"]!.GetValue<int>(),
            Total: RoteiroE2E.Decimal(vendas["totais"]!["totalLiquido"]));
        var sangrias = (await erpVolta.ObterAsync($"api/movimentos-caixa/sangrias?sessaoCaixaId={sessao:D}&treino=somente"))["itens"]!.AsArray()
            .Select(s => s!["tipo"]!.GetValue<string>()).Order(StringComparer.Ordinal).ToList();
        var sessaoErp = await erpVolta.ObterAsync($"api/sessoes-caixa/{sessao:D}");
        var comErro = (await erpVolta.ObterAsync($"api/terminais/{terminal:D}/eventos-erro"))["total"]!.GetValue<int>();
        var lataDepois = (await RoteiroE2E.SaldosAsync(erpVolta, estado, c.Lata.Id, c.Lata.Ean)).Values.Sum();

        var relatorio = new
        {
            teste = "PDV 30.7 (Fase 1C, C13)",
            quando = DateTimeOffset.UtcNow,
            minutosOfflineSimulados = minutos,
            segundosOffline = Math.Round(offline.Elapsed.TotalSeconds, 1),
            segundosAteOnline = Math.Round(ateOnline.TotalSeconds, 1),
            segundosAteEsvaziar = Math.Round(esvaziar.Elapsed.TotalSeconds, 1),
            vendas = Vendas,
            eventosNoOutbox = eventos,
            lotesEnviados = rede.LotesEnviados,
            lotesReenviados = rede.LotesReenviados,
            handshakesNaVolta,
            pdv = new { totalVendas = totalLocal, gaveta },
            nuvem = new
            {
                vendas = nuvem.Quantidade,
                canceladas = nuvem.Canceladas,
                totalVendas = nuvem.Total,
                sangrias,
                sessao = sessaoErp["situacao"]!.GetValue<string>(),
                totalInformado = RoteiroE2E.Decimal(sessaoErp["totalInformado"]),
                diferenca = sessaoErp["diferenca"]?.GetValue<string>(),
                eventosComErro = comErro,
                lataBaixada = lataAntes - lataDepois,
                lataVendida,
            },
        };
        if (Environment.GetEnvironmentVariable("GENESIS_E2E_RELATORIOS") is { Length: > 0 } pasta)
        {
            Directory.CreateDirectory(pasta);
            await File.WriteAllTextAsync(Path.Combine(pasta, "pdv-30-7.json"),
                JsonSerializer.Serialize(relatorio, new JsonSerializerOptions { WriteIndented = true }));
        }

        Assert.Equal((Vendas, 0, totalLocal), nuvem);
        Assert.Equal(["sangria", "sangria_fechamento"], sangrias);
        Assert.Equal("fechada", relatorio.nuvem.sessao);
        Assert.Equal(gaveta, relatorio.nuvem.totalInformado);
        Assert.Equal(0, comErro);
        Assert.Equal(lataVendida, lataAntes - lataDepois);
        Assert.Equal(0, sync.Situacao.Pendentes);
    }
}
