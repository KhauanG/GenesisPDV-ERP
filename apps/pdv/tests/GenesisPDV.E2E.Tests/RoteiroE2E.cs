using System.Globalization;
using System.Text.Json.Nodes;
using Avalonia.Input;
using Avalonia.Threading;
using GenesisPDV.App.Tests;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using Microsoft.Extensions.DependencyInjection;

// Um roteiro por vez contra a mesma API: o tempo da trava, o preço trocado e as revogações de um não pesam no outro.
[assembly: CollectionBehavior(DisableTestParallelization = true)]

namespace GenesisPDV.E2E.Tests;

/// <summary>
/// Passos do caixa pelo teclado, comuns aos roteiros do e2e (Fase 1B, B5; Fase 1C, C13): ativação pelo assistente,
/// inclusão de item com os diálogos do casco e do combo, pagamento em dinheiro, sangria, cancelamento da venda paga pelo
/// F12 com a liberação do gerente e o fechamento cego. Tudo espera por polling com tempo limite.
/// </summary>
internal static class RoteiroE2E
{
    /// <summary>
    /// PDV de verdade com a <paramref name="rede"/> simulada no cliente do sync. <paramref name="backoffCurto"/> põe o teto
    /// do backoff do heartbeat em 5 s (o de produção é 5 min, SYNC 18.3): o roteiro curto não espera minutos para o caixa
    /// perceber que a rede voltou. O de transporte do outbox zera sozinho na reconexão. <paramref name="handshakeAposOffline"/>
    /// troca a 1 h de produção do handshake na volta (o único comportamento que depende do tempo offline): o roteiro
    /// comprimido do 30.7 passa pelo handshake antes do push como o de 4 h.
    /// </summary>
    /// <param name="raiz">Pasta do PDV (o app reaberto na mesma pasta, C17); nula = uma nova, apagada no fim.</param>
    public static Task<AmbienteUi> IniciarAsync(RedeSimulada? rede = null, bool backoffCurto = true, TimeSpan? handshakeAposOffline = null, string? raiz = null) =>
        AmbienteUi.IniciarAsync(raiz, apagar: raiz is null, ajustar: s =>
        {
            rede?.Instalar(s);
            if (backoffCurto || handshakeAposOffline is not null)
            {
                var padrao = new OpcoesSincronizacao();
                s.AddSingleton(new OpcoesSincronizacao
                {
                    TetoBackoff = backoffCurto ? TimeSpan.FromSeconds(5) : padrao.TetoBackoff,
                    HandshakeAposOffline = handshakeAposOffline ?? padrao.HandshakeAposOffline,
                });
            }
        });

    /// <summary>Assistente da PDV 5.3 pelo teclado até a carga concluída e o login; devolve o terminal ativado.</summary>
    public static Task<Guid> AtivarECarregarAsync(AmbienteUi pdv, EstadoE2E estado, string codigo) =>
        AtivarECarregarAsync(pdv, estado.Api, estado.CodigoEmpresa, codigo);

    /// <summary>O mesmo assistente com a API e a empresa à parte (o ensaio do piloto, I5, tem um estado próprio).</summary>
    public static async Task<Guid> AtivarECarregarAsync(AmbienteUi pdv, string api, int codigoEmpresa, string codigo)
    {
        var vm = Assert.IsType<AtivacaoViewModel>(pdv.Shell.PaginaAtual);
        vm.UrlServidor = api;
        await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is App.Views.AtivacaoView, "foco no assistente");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoUrl");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => vm.Passo == AtivacaoViewModel.PassoCodigo, "conexão com a API", 30_000);
        await pdv.EsperarFocoAsync("CampoCodigoEmpresa");
        pdv.Digitar(codigoEmpresa.ToString(CultureInfo.InvariantCulture));
        pdv.Tecla(Key.Tab);
        pdv.Digitar(codigo.Replace("-", string.Empty, StringComparison.Ordinal));
        await AmbienteUi.Pausa();
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => vm.Passo == AtivacaoViewModel.PassoConfirmacao || vm.Mensagem is { } m && !vm.Ocupado && m != "Ativando o terminal…",
            "ativação", 30_000);
        Assert.True(vm.Passo == AtivacaoViewModel.PassoConfirmacao, vm.Mensagem);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is CargaInicialViewModel { Concluida: true } or CargaInicialViewModel { Erro: not null },
            "carga inicial", 120_000);
        var carga = (CargaInicialViewModel)pdv.Shell.PaginaAtual!;
        Assert.True(carga.Concluida, carga.Erro);
        await AmbienteUi.Pausa();
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "login");
        return (await pdv.Servicos.GetRequiredService<RepositorioTerminal>().ObterIdentidadeAsync())!.TerminalId;
    }

    /// <summary>
    /// Bipa o código e responde os diálogos que ele abrir: cascos trazidos (o padrão é o devido; aqui
    /// <paramref name="cascosTrazidos"/>) e Montar combo (Enter aceita os padrões em cada posição).
    /// </summary>
    public static async Task IncluirAsync(AmbienteUi pdv, VendaViewModel venda, string codigo, int cascosTrazidos = 0)
    {
        var antes = venda.Itens.Count;
        await pdv.EntrarCodigoAsync(codigo);
        for (var i = 0; i < 10 && venda.Dialogo is not null; i++)
        {
            switch (venda.Dialogo)
            {
                case DialogoCascosViewModel:
                    await pdv.EsperarFocoAsync("CampoCascosTrazidos");
                    pdv.Tecla(Key.A, RawInputModifiers.Control);
                    pdv.Digitar(cascosTrazidos.ToString(CultureInfo.InvariantCulture));
                    pdv.Tecla(Key.Enter);
                    break;
                case DialogoMontarComboViewModel:
                    await pdv.EsperarFocoAsync("DialogoMontarCombo");
                    pdv.Tecla(Key.Enter);
                    break;
                default:
                    throw new InvalidOperationException($"Diálogo inesperado ao incluir {codigo}: {venda.Dialogo.GetType().Name}.");
            }

            await AmbienteUi.Pausa();
        }

        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.Itens.Count > antes, $"item {codigo} incluído ({pdv.Texto("TextoMensagem")})");
    }

    /// <summary>
    /// F10, a forma Dinheiro, o valor exato do que falta (a forma pode vir zerada, "sempre zerado no PDV") e Enter: a
    /// venda finaliza e o caixa fica livre.
    /// </summary>
    public static async Task PagarEmDinheiroAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        var dinheiro = pagamento.Formas.ToList().FindIndex(f => f.Forma.TipoForma == "dinheiro");
        Assert.True(dinheiro >= 0, "forma Dinheiro na loja");
        pagamento.EscolherFormaCommand.Execute((dinheiro + 1).ToString(CultureInfo.InvariantCulture));
        pagamento.ValorRecebido = pagamento.FaltaTexto;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, $"venda finalizada ({pagamento.Erro} valor '{pagamento.ValorRecebido}' falta {pagamento.FaltaTexto} total {pagamento.TotalTexto})");
    }

    /// <summary>F11 › 1: sangria com quem retira pelo nome (O5: o operador faz sozinho, limitada ao estimado da gaveta).</summary>
    public static async Task SangriaAsync(AmbienteUi pdv, VendaViewModel venda, string valor, string quemRetira)
    {
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.D1);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoMovimentoCaixaViewModel, "sangria");
        await pdv.EsperarFocoAsync("CampoValorMovimento");
        var sangria = (DialogoMovimentoCaixaViewModel)venda.Dialogo!;
        sangria.Valor = valor;
        sangria.QuemRetira = quemRetira;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, $"sangria gravada ({sangria.Erro})");
    }

    /// <summary>
    /// F12 › Ctrl+Del na venda mais nova da sessão (forma A do <c>venda.cancelada</c>, C11b): o motivo livre (O6) e, sem a
    /// permissão no perfil do operador, a liberação do gerente pelo login e PIN; Esc fecha a lista.
    /// </summary>
    public static async Task CancelarUltimaVendaPagaAsync(AmbienteUi pdv, VendaViewModel venda, OperadorE2E gerente, string motivo)
    {
        pdv.Tecla(Key.F12);
        await pdv.EsperarFocoAsync("CampoFiltroVendas");
        var lista = Assert.IsType<DialogoGestaoVendasViewModel>(venda.Dialogo);
        pdv.Tecla(Key.Delete, RawInputModifiers.Control);
        await pdv.EsperarFocoAsync("CampoMotivoCancelamentoVenda");
        var cancelar = Assert.IsType<DialogoCancelarVendaFinalizadaViewModel>(venda.Dialogo);
        cancelar.Motivo = motivo;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var liberacao = Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
        liberacao.Pedido.Usuario = gerente.Login;
        liberacao.Pedido.Pin = gerente.Pin;
        liberacao.Pedido.Motivo = motivo;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoGestaoVendasViewModel, $"volta à lista ({liberacao.Pedido.Erro ?? cancelar.Erro})");
        Assert.StartsWith("CANCELADA", lista.Linhas[0].Situacao, StringComparison.Ordinal);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "lista fechada");
    }

    /// <summary>F11 › 3: fechamento cego (O3) com o dinheiro contado, Enter confirma e o Enter do relatório volta ao login.</summary>
    public static async Task FecharCaixaAsync(AmbienteUi pdv, string dinheiroContado)
    {
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.D3);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is FechamentoCaixaViewModel, "tela de fechamento");
        await pdv.EsperarFocoAsync("CampoValorForma");
        var fechamento = (FechamentoCaixaViewModel)pdv.Shell.PaginaAtual!;
        pdv.Digitar(dinheiroContado);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Concluido, "fechamento confirmado", 30_000);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "volta ao login");
    }

    /// <summary>Cabo puxado: espera o indicador da barra mostrar "Offline" (2 falhas de transporte, SYNC 18.3).</summary>
    public static async Task EsperarOfflineAsync(AmbienteUi pdv)
    {
        var sync = pdv.Servicos.GetRequiredService<IServicoSincronizacao>();
        await EsperarAsync(() =>
        {
            if (sync.Situacao.Online || sync.Situacao.OfflineDesde is null)
            {
                sync.SincronizarAgora();
                return Task.FromResult(false);
            }

            return Task.FromResult(true);
        }, "caixa offline", TimeSpan.FromSeconds(90));
    }

    /// <summary>Soma de <c>quantidade</c> do produto no estoque, por tipo de estoque (ERP 9.3, <c>GET /api/saldos-estoque</c>).</summary>
    public static async Task<Dictionary<string, decimal>> SaldosAsync(ErpE2E erp, EstadoE2E estado, Guid produtoId, string busca)
    {
        var pagina = await erp.ObterAsync(
            $"api/saldos-estoque?estoqueId={estado.EstoqueId:D}&nome={Uri.EscapeDataString(busca)}&situacao=todos&tamanho=50");
        return pagina["itens"]!.AsArray()
            .Where(i => i!["produtoId"]!.GetValue<string>() == produtoId.ToString("D"))
            .GroupBy(i => i!["tipoEstoqueNome"]?.GetValue<string>() ?? "?")
            .ToDictionary(g => g.Key, g => g.Sum(i => decimal.Parse(i!["quantidade"]!.GetValue<string>(), CultureInfo.InvariantCulture)));
    }

    public static decimal Decimal(JsonNode? valor) => decimal.Parse(valor!.GetValue<string>(), CultureInfo.InvariantCulture);

    /// <summary>Polling com tempo limite (a tela continua sendo processada entre as tentativas).</summary>
    public static async Task EsperarAsync(Func<Task<bool>> condicao, string descricao, TimeSpan limite)
    {
        var fim = DateTime.UtcNow + limite;
        while (!await condicao())
        {
            if (DateTime.UtcNow > fim)
            {
                throw new TimeoutException($"Condição não atingida em {limite.TotalSeconds:0} s: {descricao}.");
            }

            await PausaAsync(TimeSpan.FromMilliseconds(500));
        }
    }

    /// <summary>Espera processando a tela (nunca um sleep que congela o despachante).</summary>
    public static async Task PausaAsync(TimeSpan duracao)
    {
        var fim = DateTime.UtcNow + duracao;
        do
        {
            Dispatcher.UIThread.RunJobs();
            await Task.Delay(50);
        }
        while (DateTime.UtcNow < fim);
    }
}
