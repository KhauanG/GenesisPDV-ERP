using Avalonia.Headless.XUnit;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Tests;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.E2E.Tests;

/// <summary>
/// Demonstração da Fase 1B de ponta a ponta (roteiro do bloco B5): o PDV de verdade, sem tela (Avalonia headless), contra a
/// API local com PostgreSQL. Tudo espera por polling com tempo limite (nunca um sleep fixo); os intervalos são os de
/// produção (heartbeat e pull de 30 s), então o preço tem até 60 s para chegar.
/// <list type="number">
/// <item>Código gerado pela API do ERP e ativação pela tela do assistente.</item>
/// <item>Carga inicial dos 7 fluxos e login offline com o PIN definido no ERP.</item>
/// <item>Preço alterado no ERP (<c>PUT /api/produtos/:id</c>) chega ao caixa em até 60 s.</item>
/// <item>O heartbeat informa o <c>cursor_pull</c> do catálogo igual ao teto da nuvem.</item>
/// <item>Revogar aceitando pendências com a venda aberta: a tela fica na venda até ela ser cancelada, depois vai para a
/// desativação; a auditoria do login e a do cancelamento sobem e a nuvem confirma a desativação.</item>
/// <item>Um segundo terminal no mesmo caixa (liberado pela confirmação, sem salto de numeração) revogado imediatamente:
/// a tela mostra "desativado".</item>
/// </list>
/// </summary>
public sealed class PontaAPontaTests
{
    private static readonly TimeSpan PrecoAte = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan CicloAte = TimeSpan.FromSeconds(120);

    public static bool Habilitado => EstadoE2E.Habilitado;

    [AvaloniaFact(SkipUnless = nameof(Habilitado), Skip = "Defina GENESIS_E2E_API e GENESIS_E2E_ESTADO (servidor de apps/api/test/e2e-pdv).")]
    public async Task Ativa_pelo_erp_carrega_loga_recebe_o_preco_e_revoga_nos_dois_modos()
    {
        var estado = await EstadoE2E.CarregarAsync(TimeSpan.FromMinutes(3));
        using var erp = await ErpE2E.EntrarAsync(estado);

        // 1–2. Ativação pela tela, carga inicial e login offline com o PIN.
        Guid terminal1;
        long vendaFinal;
        using (var pdv = await AmbienteUi.IniciarAsync())
        {
            terminal1 = await RoteiroE2E.AtivarECarregarAsync(pdv, estado, await erp.GerarCodigoAsync(estado.LojaId, estado.Caixas[0]));
            var venda = await pdv.LogarAsync(estado.Operador.Login, estado.Operador.Pin);
            Assert.Equal(estado.Operador.Nome, pdv.Servicos.GetRequiredService<SessaoTerminal>().Operador!.Nome);

            // Consulta de preço pela venda (D18: o terminal real monta a venda, não finaliza).
            await pdv.EntrarCodigoAsync(estado.Produto.Ean);
            var servicoVenda = pdv.Servicos.GetRequiredService<ServicoVenda>();
            Assert.Equal(decimal.Parse(estado.Produto.Preco, System.Globalization.CultureInfo.InvariantCulture), servicoVenda.Atual!.Itens[^1].PrecoUnitario);
            Assert.Single(venda.Itens);

            // 3. Preço novo no ERP chega pelo pull periódico em até 60 s.
            await erp.AlterarPrecoAsync(estado.Produto.Id, "5.49");
            var catalogo = pdv.Servicos.GetRequiredService<ICatalogoProdutos>();
            await RoteiroE2E.EsperarAsync(async () => (await catalogo.ObterAsync(estado.Produto.Id))?.PrecoBase == 5.49m, "preço novo no caixa", PrecoAte);
            // O item já incluído mantém o preço da inclusão; a venda em andamento cancela sem evento (D18) e a próxima usa o novo.
            await servicoVenda.CancelarVendaAsync("e2e: consulta de preço");
            await venda.RecarregarDoBancoAsync();
            await pdv.EntrarCodigoAsync(estado.Produto.Ean);
            Assert.Equal(5.49m, servicoVenda.Atual!.Itens[^1].PrecoUnitario);
            pdv.Captura("e2e-01-preco-novo");

            // 4. Heartbeat com o cursor do catálogo no teto da nuvem.
            var cliente = pdv.Servicos.GetRequiredService<IClienteSync>();
            await RoteiroE2E.EsperarAsync(async () =>
            {
                var cursor = (await erp.TerminalAsync(terminal1))["cursorPull"]?["catalogo"]?.GetValue<long>();
                var teto = (await cliente.PullAsync("catalogo", cursor ?? 0, 1)).CursorTeto;
                return cursor == teto;
            }, "cursor_pull do catálogo no teto", CicloAte);

            // 5. Revogar aceitando pendências com a venda aberta: a barra avisa, a tela fica na venda e a nuvem não confirma
            // (o cancelamento ainda gera auditoria). Cancelada a venda, a tela vai para a desativação, a auditoria do login e
            // a do `cancelar` sobem e só então a nuvem confirma.
            var telas = new System.Collections.Concurrent.ConcurrentQueue<Type>();
            pdv.Shell.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName == nameof(ShellViewModel.PaginaAtual) && pdv.Shell.PaginaAtual is { } pagina)
                {
                    telas.Enqueue(pagina.GetType());
                }
            };
            await erp.RevogarAsync(terminal1, "aceitar_pendencias");
            await RoteiroE2E.EsperarAsync(() => Task.FromResult(pdv.Texto("TextoConexao")!.StartsWith("▲ Em desativação", StringComparison.Ordinal)),
                "aviso de desativação na barra", CicloAte);
            Assert.IsType<VendaViewModel>(pdv.Shell.PaginaAtual);
            Assert.Equal("desativando", (await erp.TerminalAsync(terminal1))["status"]!.GetValue<string>());
            await servicoVenda.CancelarVendaAsync("e2e: desativação");
            await RoteiroE2E.EsperarAsync(
                () => Task.FromResult(pdv.Shell.PaginaAtual is TerminalBloqueadoViewModel { Titulo: TerminalBloqueadoViewModel.TituloDesativado }),
                "terminal desativado com confirmação", CicloAte);
            var detalhe = await erp.TerminalAsync(terminal1);
            Assert.Equal("revogado", detalhe["status"]!.GetValue<string>());
            Assert.NotNull(detalhe["desativacaoConfirmadaEm"]?.GetValue<string>());
            Assert.Equal([typeof(DesativacaoViewModel), typeof(TerminalBloqueadoViewModel)], telas);
            Assert.True(await erp.AuditoriaAsync("login", "pdv") >= 1, "login do caixa na auditoria da nuvem");
            Assert.True(await erp.AuditoriaAsync("cancelar", "pdv") >= 2, "os dois cancelamentos de venda na auditoria da nuvem");
            Assert.Equal(0, pdv.Servicos.GetRequiredService<IServicoSincronizacao>().Situacao.Pendentes);
            vendaFinal = detalhe["vendaUltimoNumero"]!.GetValue<long>();
            pdv.Captura("e2e-02-desativado-com-confirmacao");
        }

        // 6. Segundo terminal no mesmo caixa: a confirmação liberou o caixa e a numeração continua (sem o salto de +1000).
        using var pdv2 = await AmbienteUi.IniciarAsync();
        var terminal2 = await RoteiroE2E.AtivarECarregarAsync(pdv2, estado, await erp.GerarCodigoAsync(estado.LojaId, estado.Caixas[0]));
        Assert.NotEqual(terminal1, terminal2);
        await using (var db = pdv2.Servicos.GetRequiredService<Data.FabricaPdvDb>().CreateDbContext())
        {
            Assert.Equal(vendaFinal, db.SequenciasLocais.Single(s => s.Chave == SequenciaLocal.Venda).UltimoValor);
        }

        await pdv2.LogarAsync(estado.Operador.Login, estado.Operador.Pin);
        await erp.RevogarAsync(terminal2, "imediato");
        await RoteiroE2E.EsperarAsync(
            () => Task.FromResult(pdv2.Shell.PaginaAtual is TerminalBloqueadoViewModel { Titulo: TerminalBloqueadoViewModel.TituloDesativado }),
            "terminal desativado (revogação imediata)", CicloAte);
        Assert.Equal(TerminalBloqueadoViewModel.TituloDesativado, pdv2.Texto("TituloBloqueio"));
        Assert.Equal(StatusIdentidade.Revogado, (await pdv2.Servicos.GetRequiredService<RepositorioTerminal>().ObterIdentidadeAsync())!.Status);
        pdv2.Captura("e2e-03-revogado-imediato");
    }
}
