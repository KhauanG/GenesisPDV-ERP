using System.Text.Json.Nodes;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Hardware.Gaveta;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Caixa pelo teclado (Fase 1C, bloco C10a; PDV 8, 21, 31.3), no terminal de demonstração: abertura com o contador de
/// cédulas, fechamento às cegas pela regra O3 do dono (ninguém vê o esperado no PDV, sem recontagem), a conferência da
/// especificação quando a loja liga a chave, troca de turno com o fundo herdado, sessão de outro operador, sessão antiga
/// e a liberação do supervisor.
/// </summary>
public class CaixaTelasTests
{
    /// <summary>Operadora MARIA da demonstração (<c>AutenticadorOperadorSimulado</c>).</summary>
    private static readonly Guid Maria = Guid.Parse("019a0003-0000-7000-8000-000000000001");

    /// <summary>CARLOS, o Master da demonstração (supervisor nas liberações).</summary>
    private static readonly Guid Carlos = Guid.Parse("019a0003-0000-7000-8000-000000000002");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    /// <summary>Grava chaves da loja de demonstração no espelho <c>configuracoes</c> (como o pull faria).</summary>
    private static async Task ConfigurarAsync(AmbienteUi pdv, params (string Chave, string ValorJson)[] chaves)
    {
        var agora = DateTimeOffset.UtcNow;
        await pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [.. chaves.Select(c => (LinhaEspelho)new ConfiguracaoRegistro
            {
                Id = Guid.CreateVersion7(), Escopo = "loja", LojaId = CatalogoDemonstracao.LojaDemonstracao, Chave = c.Chave, Valor = c.ValorJson,
                CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
            })],
            Ct);
    }

    /// <summary>Ativa a demonstração e só faz o login (a tela seguinte fica para o teste).</summary>
    private static async Task EntrarNaDemonstracaoAsync(AmbienteUi pdv, string usuario = "1", string senha = "1234")
    {
        if (pdv.Shell.PaginaAtual is AtivacaoViewModel)
        {
            await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is not null, "foco no assistente");
            pdv.Tecla(Key.F8);
            await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel);
        }

        await pdv.EntrarAsync(usuario, senha);
    }

    /// <summary>
    /// Venda em andamento gravada na sessão aberta por fora da tela (como a que fica de uma queda de energia): o commit do
    /// fechamento a encontra no banco e recusa (21.2).
    /// </summary>
    private static async Task<Venda> GravarVendaPendenteAsync(AmbienteUi pdv)
    {
        var repositorio = pdv.Servicos.GetRequiredService<IRepositorioVendas>();
        var contexto = pdv.Servicos.GetRequiredService<SessaoTerminal>().Contexto();
        var venda = Venda.Iniciar(Guid.CreateVersion7(), await repositorio.ReservarNumeroVendaAsync(Ct), contexto, Maria, DateTimeOffset.UtcNow);
        await repositorio.SalvarEmAndamentoAsync(venda, ct: Ct);
        return venda;
    }

    /// <summary>Cancela a venda pendente direto no banco (a causa da recusa sai).</summary>
    private static async Task CancelarPendenteAsync(AmbienteUi pdv, Venda venda)
    {
        venda.Cancelar(Maria, "Cliente desistiu da compra", DateTimeOffset.UtcNow);
        await pdv.Servicos.GetRequiredService<IRepositorioVendas>().EncerrarAsync(venda, null, ct: Ct);
    }

    private static async Task<FechamentoCaixaViewModel> AbrirFechamentoAsync(AmbienteUi pdv)
    {
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.D3);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is FechamentoCaixaViewModel, "tela de fechamento");
        await pdv.EsperarAsync(() => pdv.NomeFocado() == "CampoValorForma", "foco no dinheiro");
        return (FechamentoCaixaViewModel)pdv.Shell.PaginaAtual!;
    }

    [AvaloniaFact]
    public async Task Abre_com_o_contador_de_cedulas_vende_e_fecha_as_cegas_sem_ver_o_esperado()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await EntrarNaDemonstracaoAsync(pdv);
        await pdv.EsperarFocoAsync("CampoFundo");
        var abertura = Assert.IsType<AberturaCaixaViewModel>(pdv.Shell.PaginaAtual);
        Assert.Equal(string.Empty, abertura.Fundo);

        // O4: sem o fundo contado, não abre.
        pdv.Tecla(Key.Enter);
        await AmbienteUi.Pausa();
        Assert.Equal(Core.Caixa.RegrasSessaoCaixa.MensagemFundoInvalido, pdv.Texto("TextoErroAbertura"));

        // F2: 1 × 100 + 1 × 50 preenche o fundo; o detalhamento vai no contagem_cedulas do evento.
        pdv.Tecla(Key.F2);
        await pdv.EsperarAsync(() => abertura.Contador is not null);
        abertura.Contador!.Linhas[1].Quantidade = "1";
        abertura.Contador.Linhas[2].Quantidade = "1";
        Assert.Equal("150,00", abertura.Contador.TotalTexto);
        abertura.Contador.AplicarCommand.Execute(null);
        await pdv.EsperarFocoAsync("CampoFundo");
        Assert.Equal("150,00", abertura.Fundo);
        pdv.Captura("20-abertura-caixa");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "venda");
        var venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        await pdv.EsperarFocoAsync("CampoCodigo");
        Assert.Equal("Caixa aberto com fundo de R$ 150,00.", pdv.Texto("TextoMensagem"));
        // A gaveta é desligada por padrão (dono, I4): nada é enviado a ela na abertura.
        Assert.Equal(0, pdv.Servicos.GetRequiredService<GavetaSimulada>().Aberturas);

        // Uma venda de R$ 12,90 em dinheiro: a gaveta esperada fica em R$ 162,90.
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");

        var fechamento = await AbrirFechamentoAsync(pdv);
        Assert.False(fechamento.CalculadoVisivel);
        Assert.All(fechamento.Formas, f => Assert.Null(f.CalculadoTexto));
        Assert.True(fechamento.ZeraCaixa);
        Assert.True(fechamento.JustificativaNaContagem);
        Assert.Equal("Dinheiro", fechamento.Formas[0].Descricao);
        pdv.Digitar("160");
        pdv.Captura("21-fechamento-cego");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Concluido, "fechamento confirmado");
        // PDV 32.5 (C17): todo fechamento de caixa deixa um backup local, em segundo plano.
        await pdv.Servicos.GetRequiredService<ServicoBackup>().AguardarAsync();
        Assert.Contains(Data.Backup.BackupLocal.Listar(pdv.Caminhos.PastaBackup), a => a.Motivo == Data.Backup.MotivosBackup.Fechamento);

        // O relatório do operador não traz o esperado (O3): só o contado.
        Assert.Contains("FECHAMENTO DE CAIXA", fechamento.Relatorio);
        Assert.Contains("160,00", fechamento.Relatorio);
        Assert.DoesNotContain("162,90", fechamento.Relatorio);
        Assert.DoesNotContain("Calculado", fechamento.Relatorio);
        await using (var db = Banco(pdv))
        {
            var sessao = await db.SessoesCaixa.SingleAsync(Ct);
            Assert.Equal((StatusSessaoCaixa.Fechada, 150m), (sessao.Status, sessao.FundoTroco));
            var f = await db.FechamentosCaixa.SingleAsync(Ct);
            Assert.Equal(("fechamento", true, 162.90m, 160m, -2.90m, true, false, (string?)null, 0m),
                (f.Tipo, f.ZeraCaixa, f.TotalCalculado, f.TotalDigitado, f.Diferenca, f.FechamentoCego, f.Recontagem, f.Justificativa, f.ValorCaixa));
            var resumo = JsonNode.Parse(f.Resumo)!;
            Assert.Equal((1, "12.90", 2L), (resumo["qtd_vendas"]!.GetValue<int>(), resumo["total_vendas"]!.GetValue<string>(),
                resumo["ultima_sequencia_evento"]!.GetValue<long>()));
            // As chaves do resumo são as da fixture do contrato (SYNC 9.6): o schema da nuvem é solto, e um nome errado
            // passaria lá sem aviso.
            var fixture = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "fixtures", "sync", "caixa.fechado.payload.json"), Ct))!;
            Assert.Equal(
                fixture["fechamentos_caixa"]!["resumo"]!.AsObject().Select(c => c.Key).Order(StringComparer.Ordinal),
                resumo.AsObject().Select(c => c.Key).Order(StringComparer.Ordinal));
            var forma = await db.FechamentosCaixaFormas.SingleAsync(Ct);
            Assert.Equal((162.90m, 160m, 1, (decimal?)null), (forma.ValorCalculado, forma.ValorDigitado, forma.QuantidadePagamentos, forma.ValorPrimeiraContagem));
            var sangria = await db.MovimentosCaixa.SingleAsync(m => m.Tipo == TipoMovimentoCaixa.SangriaFechamento, Ct);
            Assert.Equal((160m, "MARIA"), (sangria.Valor, sangria.QuemRetiraNome));
            Assert.Equal(["caixa.aberto", "venda.finalizada", "caixa.fechado"],
                await db.EventosSaida.OrderBy(e => e.SequenciaTerminal).Select(e => e.Tipo).ToListAsync(Ct));
            var aberto = JsonNode.Parse(await db.EventosSaida.Where(e => e.Tipo == "caixa.aberto").Select(e => e.Payload).SingleAsync(Ct))!;
            Assert.Equal(1, aberto["contagem_cedulas"]!["100.00"]!.GetValue<int>());
            var vendida = await db.Vendas.SingleAsync(Ct);
            Assert.Equal(sessao.Id, vendida.SessaoCaixaId);
            Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "logout" && l.SessaoCaixaId == sessao.Id, Ct));
        }

        pdv.Captura("22-relatorio-fechamento");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "volta ao login");
        Assert.Null(pdv.Servicos.GetRequiredService<SessaoTerminal>().Operador);
        Assert.Null(pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixaId);
    }

    [AvaloniaFact]
    public async Task Troca_de_turno_deixa_o_dinheiro_e_o_proximo_operador_abre_com_o_valor_herdado()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        var fechamento = await AbrirFechamentoAsync(pdv);
        // F5: zera caixa = não (troca de turno), o dinheiro contado fica como fundo do próximo.
        pdv.Tecla(Key.F5);
        Assert.False(fechamento.ZeraCaixa);
        pdv.Digitar("100");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Concluido, "troca de turno");
        Assert.Contains("TROCA DE TURNO", fechamento.Relatorio);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel);

        // CARLOS abre com o fundo herdado; contar outro valor pede confirmação e grava a diferença de recebimento.
        await pdv.EntrarAsync("2", "4321");
        await pdv.EsperarFocoAsync("CampoFundo");
        var abertura = Assert.IsType<AberturaCaixaViewModel>(pdv.Shell.PaginaAtual);
        Assert.Equal("100,00", abertura.Fundo);
        Assert.Equal("Herdado do turno anterior: R$ 100,00", pdv.Texto("TextoHerdado"));
        // PDV 8.2: o primeiro Enter só avisa; nada é aberto até o segundo.
        abertura.Fundo = string.Empty;
        pdv.Digitar("90");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => abertura.Aviso is not null, "aviso da diferença");
        Assert.Equal(AberturaCaixaViewModel.MensagemConfirmarDiferenca, pdv.Texto("TextoAvisoAbertura"));
        Assert.IsType<AberturaCaixaViewModel>(pdv.Shell.PaginaAtual);
        await using (var antes = Banco(pdv))
        {
            Assert.Equal(1, await antes.SessoesCaixa.CountAsync(Ct));
        }

        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "abertura confirmada");
        await using var db = Banco(pdv);
        var sessoes = await db.SessoesCaixa.OrderBy(s => s.AbertaEm).ToListAsync(Ct);
        Assert.Equal(2, sessoes.Count);
        Assert.Equal((sessoes[0].Id, 100m, -10m, 90m), (sessoes[1].SessaoAnteriorId!.Value, sessoes[1].ValorRecebidoAnterior!.Value,
            sessoes[1].DiferencaRecebimento!.Value, sessoes[1].FundoTroco));
        var f = await db.FechamentosCaixa.SingleAsync(Ct);
        Assert.Equal(("troca_turno", false, 100m), (f.Tipo, f.ZeraCaixa, f.ValorCaixa));
        Assert.False(await db.MovimentosCaixa.AnyAsync(m => m.Tipo == TipoMovimentoCaixa.SangriaFechamento, Ct));
        // O caixa.aberto da troca de turno depende da sessão anterior (SYNC 8.5).
        var dependencias = await db.EventosSaida.Where(e => e.Tipo == "caixa.aberto").OrderBy(e => e.SequenciaTerminal).Select(e => e.Dependencias).ToListAsync(Ct);
        Assert.Contains(sessoes[0].Id.ToString("D"), dependencias[1], StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task Sessao_de_outro_operador_oferece_troca_de_turno_ou_operar_no_caixa_dele()
    {
        var raiz = AmbienteUi.NovaRaiz();
        using (var primeiro = await AmbienteUi.IniciarAsync(raiz, apagar: false))
        {
            await primeiro.AtivarDemonstracaoELogarAsync(fundo: "50");
        }

        // MARIA saiu sem fechar: CARLOS (com a permissão) opera no caixa dela, auditado.
        using (var segundo = await AmbienteUi.IniciarAsync(raiz, apagar: false))
        {
            await segundo.EntrarAsync("2", "4321");
            await segundo.EsperarFocoAsync("PainelSessaoOutro");
            Assert.StartsWith("O caixa está aberto por MARIA desde", segundo.Texto("TextoSessaoOutro"), StringComparison.Ordinal);
            segundo.Captura("23-sessao-outro-operador");
            segundo.Tecla(Key.D2);
            await segundo.EsperarAsync(() => segundo.Shell.PaginaAtual is VendaViewModel, "operando no caixa da MARIA");
            await using var db = Banco(segundo);
            Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "caixa_operar_de_outro", Ct));
        }

        // A própria MARIA volta direto para a venda; depois CARLOS faz a troca de turno e abre o caixa dele.
        using (var terceiro = await AmbienteUi.IniciarAsync(raiz, apagar: false))
        {
            await terceiro.AtivarDemonstracaoELogarAsync();
        }

        using var quarto = await AmbienteUi.IniciarAsync(raiz);
        await quarto.EntrarAsync("2", "4321");
        await quarto.EsperarFocoAsync("PainelSessaoOutro");
        quarto.Tecla(Key.D1);
        await quarto.EsperarAsync(() => quarto.Shell.PaginaAtual is FechamentoCaixaViewModel, "troca de turno");
        var fechamento = (FechamentoCaixaViewModel)quarto.Shell.PaginaAtual!;
        Assert.False(fechamento.PodeEscolherZera);
        Assert.False(fechamento.ZeraCaixa);
        await quarto.EsperarAsync(() => quarto.NomeFocado() == "CampoValorForma", "foco no dinheiro");
        quarto.Digitar("50");
        quarto.Tecla(Key.Enter);
        await quarto.EsperarAsync(() => fechamento.Concluido);
        quarto.Tecla(Key.Enter);
        await quarto.EsperarFocoAsync("CampoFundo");
        Assert.Equal("50,00", ((AberturaCaixaViewModel)quarto.Shell.PaginaAtual!).Fundo);
        await quarto.AbrirCaixaAsync("50");
        await using var banco = Banco(quarto);
        var f = await banco.FechamentosCaixa.SingleAsync(Ct);
        // O fechamento é da sessão da MARIA (usuário anterior), contado pelo CARLOS, sem o logout dele: o envelope leva
        // quem executou (SYNC 7.3), e a auditoria da nuvem fica com ele.
        Assert.Equal((Maria, "troca_turno"), (f.UsuarioAnteriorId, f.Tipo));
        Assert.Equal(Carlos, await banco.EventosSaida.Where(e => e.Tipo == "caixa.fechado").Select(e => e.UsuarioId).SingleAsync(Ct));
        Assert.Equal(0, await banco.LogAuditoriaLocal.CountAsync(l => l.Acao == "logout", Ct));
        Assert.Equal("CARLOS", quarto.Servicos.GetRequiredService<SessaoTerminal>().Operador!.Nome);
    }

    [AvaloniaFact]
    public async Task Conferencia_ligada_mostra_o_calculado_pede_justificativa_e_permite_recontar_uma_vez()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await ConfigurarAsync(pdv,
            (ChavesConfiguracao.FechamentoMostraConferencia, "true"),
            (ChavesConfiguracao.PermiteRecontagem, "true"),
            (ChavesConfiguracao.ToleranciaDiferencaCaixa, "\"0.50\""));
        var fechamento = await AbrirFechamentoAsync(pdv);
        // A MARIA (operador) não tem pdv.caixa.ver_calculado_fechamento: não vê o calculado durante a contagem.
        Assert.False(fechamento.CalculadoVisivel);
        Assert.False(fechamento.JustificativaNaContagem);
        pdv.Digitar("98");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Conferindo, "conferência");
        Assert.Equal(("100,00", "-2,00"), (fechamento.Formas[0].CalculadoTexto, fechamento.Formas[0].DiferencaTexto));
        Assert.True(fechamento.PodeRecontar);
        Assert.Equal(Core.Caixa.FechamentoCego.MensagemJustificativa, pdv.Texto("TextoAvisoFechamento"));
        pdv.Captura("24-conferencia-fechamento");
        pdv.Tecla(Key.Enter);
        await AmbienteUi.Pausa();
        Assert.Equal(Core.Caixa.FechamentoCego.MensagemJustificativa, pdv.Texto("TextoErroFechamento"));

        // Reconta uma vez: a primeira contagem fica registrada.
        pdv.Tecla(Key.F4);
        await pdv.EsperarAsync(() => pdv.NomeFocado() == "CampoValorForma", "recontagem");
        Assert.All(fechamento.Formas, f => Assert.Null(f.CalculadoTexto));
        pdv.Digitar("99,60");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Conferindo);
        Assert.False(fechamento.PodeRecontar);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Concluido);
        await using var db = Banco(pdv);
        var f = await db.FechamentosCaixa.SingleAsync(Ct);
        Assert.Equal((true, -0.40m), (f.Recontagem, f.Diferenca));
        Assert.Equal(98m, (await db.FechamentosCaixaFormas.SingleAsync(Ct)).ValorPrimeiraContagem);
    }

    [AvaloniaFact]
    public async Task Sem_abertura_obrigatoria_o_login_abre_sozinho_e_sessao_de_dia_anterior_bloqueia_a_venda_nova()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await EntrarNaDemonstracaoAsync(pdv);
        await pdv.EsperarFocoAsync("CampoFundo");
        await ConfigurarAsync(pdv,
            (ChavesConfiguracao.SolicitaAberturaCaixa, "false"),
            (ChavesConfiguracao.BloqueiaSessaoDiaAnterior, "true"));
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "Esc volta ao login");
        await pdv.EntrarAsync("1", "1234");
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "abertura automática");
        await pdv.EsperarFocoAsync("CampoCodigo");
        await using (var db = Banco(pdv))
        {
            var sessao = await db.SessoesCaixa.SingleAsync(Ct);
            Assert.Equal((true, 0m), (sessao.AberturaAutomatica, sessao.FundoTroco));
            Assert.False(await db.MovimentosCaixa.AnyAsync(Ct));
            // A sessão ficou de ontem (o operador esqueceu de fechar).
            sessao.DiaOperacional = sessao.DiaOperacional.AddDays(-1);
            sessao.AbertaEm = sessao.AbertaEm.AddDays(-1);
            await db.SaveChangesAsync(Ct);
        }

        await pdv.Shell.IrParaVendaAsync();
        await pdv.EsperarFocoAsync("CampoCodigo");
        var venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        Assert.StartsWith("Caixa aberto desde", venda.AlertaSessao, StringComparison.Ordinal);
        await pdv.EntrarCodigoAsync("0044");
        Assert.Empty(venda.Itens);
        Assert.Contains("feche o caixa (F11 › 3)", pdv.Texto("TextoMensagem"), StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task Supervisor_libera_o_desconto_acima_do_limite_e_a_liberacao_entra_na_venda()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("10*0044");
        pdv.Tecla(Key.F6);
        await AmbienteUi.Pausa();
        pdv.Tecla(Key.D2);
        await pdv.EsperarFocoAsync("CampoDesconto");
        pdv.Digitar("15%");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var dialogo = Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);

        // A própria MARIA não libera; PIN errado é recusado; o motivo é obrigatório.
        pdv.Digitar("1");
        dialogo.Pedido.Pin = "1234";
        dialogo.Pedido.Motivo = "cliente antigo";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => dialogo.Pedido.Erro is not null);
        Assert.Equal(Sync.Acesso.AutenticadorOffline.MensagemLiberadorProprio, pdv.Texto("TextoErroLiberacao"));
        dialogo.Pedido.Usuario = "2";
        dialogo.Pedido.Pin = "4321";
        dialogo.Pedido.Motivo = " ";
        pdv.Tecla(Key.Enter);
        await AmbienteUi.Pausa();
        Assert.StartsWith("Informe o motivo", dialogo.Pedido.Erro, StringComparison.Ordinal);
        dialogo.Pedido.Motivo = "Cliente antigo da loja";
        pdv.Captura("25-liberacao-supervisor");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "desconto liberado");
        Assert.Equal("109,65", pdv.Texto("TextoTotal"));
        Assert.Contains("liberação de CARLOS", pdv.Texto("TextoMensagem"), StringComparison.Ordinal);
        await using var db = Banco(pdv);
        var liberacao = await db.LiberacoesVenda.SingleAsync(Ct);
        Assert.Equal(("desconto_total", Carlos, "Cliente antigo da loja"),
            (liberacao.Acao, liberacao.AutorizadoPorId, liberacao.Motivo));
        // PDV 31.3 / SYNC 9.7: no mesmo commit, a auditoria `liberacao` (do catálogo da nuvem, sobe no lote) no formato da
        // fixture da 9.22, além do `desconto_total` local com o autorizador.
        var auditoria = await db.LogAuditoriaLocal.SingleAsync(l => l.Acao == "liberacao", Ct);
        Assert.Equal(("vendas", Maria, Carlos, "PDV › Desconto", "Cliente antigo da loja"),
            (auditoria.Entidade, auditoria.UsuarioId!.Value, auditoria.AutorizadoPorId!.Value, auditoria.Localizacao, auditoria.Motivo));
        Assert.Equal(pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixaId, auditoria.SessaoCaixaId);
        Assert.Equal("19.35", JsonNode.Parse(auditoria.Depois!)!["desconto_total"]!.GetValue<string>());
        Assert.Equal(Carlos, (await db.LogAuditoriaLocal.SingleAsync(l => l.Acao == "desconto_total", Ct)).AutorizadoPorId);

        // Três recusas fecham o pedido.
        pdv.Tecla(Key.F6);
        await AmbienteUi.Pausa();
        pdv.Tecla(Key.D2);
        await pdv.EsperarFocoAsync("CampoDesconto");
        pdv.Digitar("20%");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var outro = Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
        outro.Pedido.Usuario = "2";
        outro.Pedido.Motivo = "teste";
        for (var i = 0; i < PedidoLiberacaoViewModel.TentativasMaximas; i++)
        {
            outro.Pedido.Pin = "0000";
            await outro.Pedido.ConfirmarCommand.ExecuteAsync(null);
        }

        await pdv.EsperarAsync(() => venda.Dialogo is null, "pedido fechado");
        Assert.Equal(Sync.Acesso.AutenticadorOffline.MensagemLiberacaoNegada, pdv.Texto("TextoMensagem"));
    }

    [AvaloniaFact]
    public async Task Fechamento_recusado_na_gravacao_fica_na_tela_e_o_enter_seguinte_fecha_sem_recontar()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        var fechamento = await AbrirFechamentoAsync(pdv);
        pdv.Digitar("100");

        // A venda aparece na sessão depois da preparação: o commit recusa e a máquina não fica "confirmada".
        var pendente = await GravarVendaPendenteAsync(pdv);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Erro is not null, "recusa do commit");
        Assert.Equal(RepositorioCaixa.MensagemVendaAberta, pdv.Texto("TextoErroFechamento"));
        Assert.False(fechamento.Concluido);

        // O Enter seguinte repete a mesma recusa, sem o erro genérico (nada de "Ocorreu um erro").
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Erro is not null, "recusa de novo");
        Assert.Equal(RepositorioCaixa.MensagemVendaAberta, fechamento.Erro);
        Assert.Null(pdv.Shell.ErroGlobal);

        // Resolvida a causa, o Enter fecha com a contagem que estava na tela.
        await CancelarPendenteAsync(pdv, pendente);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Concluido, "fechamento gravado");
        await using var db = Banco(pdv);
        Assert.Equal(100m, (await db.FechamentosCaixa.SingleAsync(Ct)).TotalDigitado);
        Assert.False(await db.LogLocal.AnyAsync(l => l.Nivel == "erro", Ct));
    }

    [AvaloniaFact]
    public async Task Na_conferencia_os_valores_ficam_so_leitura_e_depois_da_recusa_o_esc_sai()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await ConfigurarAsync(pdv, (ChavesConfiguracao.FechamentoMostraConferencia, "true"));
        var fechamento = await AbrirFechamentoAsync(pdv);
        Assert.False(pdv.Controle<TextBox>("CampoValorForma").IsReadOnly);
        pdv.Digitar("100");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Conferindo, "conferência");
        // O Enter grava o que foi contado: o campo não aceita outro valor na conferência.
        Assert.True(pdv.Controle<TextBox>("CampoValorForma").IsReadOnly);
        Assert.DoesNotContain("[Esc]", fechamento.Teclas, StringComparison.Ordinal);
        // Antes da recusa o Esc não sai da conferência (o operador já viu o calculado).
        pdv.Tecla(Key.Escape);
        await AmbienteUi.Pausa();
        Assert.Same(fechamento, pdv.Shell.PaginaAtual);

        await GravarVendaPendenteAsync(pdv);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Erro is not null, "recusa do commit");
        Assert.Equal(RepositorioCaixa.MensagemVendaAberta, fechamento.Erro);
        Assert.True(fechamento.Conferindo);
        Assert.Contains("[Esc] Voltar", fechamento.Teclas, StringComparison.Ordinal);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "Esc sai depois da recusa");
        await using var db = Banco(pdv);
        Assert.False(await db.FechamentosCaixa.AnyAsync(Ct));
        Assert.Equal(StatusSessaoCaixa.Aberta, (await db.SessoesCaixa.SingleAsync(Ct)).Status);
    }

    [AvaloniaFact]
    public async Task Troca_de_turno_com_venda_pendente_recusa_antes_da_contagem_e_a_abertura_recusada_volta_ao_login()
    {
        var raiz = AmbienteUi.NovaRaiz();
        using (var primeiro = await AmbienteUi.IniciarAsync(raiz, apagar: false))
        {
            await primeiro.AtivarDemonstracaoELogarAsync(fundo: "50");
            // A energia cai com a venda da MARIA em andamento.
            await primeiro.EntrarCodigoAsync("0044");
        }

        using var pdv = await AmbienteUi.IniciarAsync(raiz);
        await pdv.EntrarAsync("2", "4321");
        await pdv.EsperarFocoAsync("PainelSessaoOutro");
        var dialogo = (SessaoOutroOperadorViewModel)pdv.Shell.PaginaAtual!;
        pdv.Tecla(Key.D1);
        await pdv.EsperarAsync(() => dialogo.Erro is not null, "recusa antes da contagem");
        // PDV 21.2: o CARLOS não conta a gaveta à toa; a mensagem diz como chegar à venda da MARIA.
        Assert.Equal(ServicoCaixa.MensagemVendaAbertaDeOutro("MARIA"), pdv.Texto("TextoErroSessaoOutro"));
        Assert.Same(dialogo, pdv.Shell.PaginaAtual);

        // A venda deixada pela MARIA sai (como se ela voltasse e a cancelasse); a troca de turno segue.
        await CancelarPendenteAsync(pdv, (await pdv.Servicos.GetRequiredService<IRepositorioVendas>().ObterVendaAtualAsync(Ct))!);

        pdv.Tecla(Key.D1);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is FechamentoCaixaViewModel, "troca de turno");
        var fechamento = (FechamentoCaixaViewModel)pdv.Shell.PaginaAtual!;
        await pdv.EsperarAsync(() => pdv.NomeFocado() == "CampoValorForma", "foco no dinheiro");
        pdv.Digitar("50");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Concluido, "troca registrada");

        // A abertura automática do CARLOS é recusada (a empresa voltou à implantação): o login mostra o motivo.
        await ConfigurarAsync(pdv, (ChavesConfiguracao.SolicitaAberturaCaixa, "false"), (ChavesConfiguracao.EmpresaAtiva, "false"));
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "volta ao login");
        Assert.Equal(ServicoCaixa.MensagemEmpresaEmImplantacao, pdv.Texto("TextoErroLogin"));
        Assert.Null(pdv.Servicos.GetRequiredService<SessaoTerminal>().Operador);
        await using var banco = Banco(pdv);
        Assert.Equal(1, await banco.SessoesCaixa.CountAsync(Ct));
    }

    [AvaloniaFact]
    public async Task Empresa_em_implantacao_ou_loja_sem_pdv_nao_abrem_sessao_nova()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await EntrarNaDemonstracaoAsync(pdv);
        await pdv.EsperarFocoAsync("CampoFundo");
        await ConfigurarAsync(pdv, (ChavesConfiguracao.EmpresaAtiva, "false"));

        // A tela de abertura relê as regras no Enter (o pull pode ter mudado a empresa depois do login).
        pdv.Digitar("10");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Texto("TextoErroAbertura") is not null, "recusa da abertura");
        Assert.Equal(ServicoCaixa.MensagemEmpresaEmImplantacao, pdv.Texto("TextoErroAbertura"));
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "Esc volta ao login");
        await pdv.EntrarAsync("1", "1234");
        await pdv.EsperarAsync(() => pdv.Texto("TextoErroLogin") is not null, "login recusa");
        Assert.Equal(ServicoCaixa.MensagemEmpresaEmImplantacao, pdv.Texto("TextoErroLogin"));

        // Empresa ativa de novo, mas a loja com "Usa PDV" desligado no ERP.
        var agora = DateTimeOffset.UtcNow;
        await using (var db = Banco(pdv))
        {
            await db.Database.ExecuteSqlRawAsync("update configuracoes set valor = 'true' where chave = 'geral.ativa'", Ct);
        }

        await pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [(LinhaEspelho)new LojaRegistro { Id = CatalogoDemonstracao.LojaDemonstracao, Codigo = 1, Nome = "Loja 1", UsaPdv = false, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 }],
            Ct);
        var login = (LoginViewModel)pdv.Shell.PaginaAtual!;
        (login.Usuario, login.Senha, login.Erro) = ("1", "1234", null);
        await login.EntrarCommand.ExecuteAsync(null);
        Assert.Equal(ServicoCaixa.MensagemLojaSemPdv, login.Erro);
        await using var banco = Banco(pdv);
        Assert.False(await banco.SessoesCaixa.AnyAsync(Ct));
    }

    [AvaloniaFact]
    public async Task Forma_dinheiro_desativada_no_meio_do_turno_nao_prende_a_sessao()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await using (var db = Banco(pdv))
        {
            await db.Database.ExecuteSqlRawAsync("update formas_pagamento set ativa = 0 where tipo_forma = 'dinheiro'", Ct);
        }

        // Sem a forma oferecida nem pagamento em dinheiro na sessão, vale a do espelho (a nuvem tem a linha).
        var fechamento = await AbrirFechamentoAsync(pdv);
        Assert.Equal("Dinheiro", fechamento.Formas[0].Descricao);
        pdv.Digitar("100");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Concluido, "fechamento gravado");
        await using var banco = Banco(pdv);
        Assert.Equal((Guid?)ServicoVenda.Dinheiro.Id, (await banco.FechamentosCaixaFormas.SingleAsync(Ct)).FormaPagamentoId);
    }

    [AvaloniaFact]
    public async Task Sem_nenhuma_forma_dinheiro_no_espelho_o_fechamento_aponta_o_cadastro()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await using (var db = Banco(pdv))
        {
            await db.Database.ExecuteSqlRawAsync("update formas_pagamento set tipo_forma = 'outros' where tipo_forma = 'dinheiro'", Ct);
        }

        var recusa = await Assert.ThrowsAsync<Core.Comum.RegraNegocioException>(
            () => pdv.Servicos.GetRequiredService<ServicoCaixa>().PrepararFechamentoAsync(ct: Ct));
        Assert.Equal(ServicoCaixa.MensagemSemFormaDinheiro, recusa.Message);
    }

    [AvaloniaFact]
    public async Task Liberacao_do_supervisor_no_caixa_fica_na_auditoria_do_mesmo_commit_com_o_motivo()
    {
        var raiz = AmbienteUi.NovaRaiz();
        using (var primeiro = await AmbienteUi.IniciarAsync(raiz, apagar: false))
        {
            await primeiro.AtivarDemonstracaoELogarAsync("2", "4321", fundo: "50");
        }

        // MARIA não tem pdv.caixa.operar_de_outro: o [2] pede a liberação, e o CARLOS libera pelo PIN.
        using var pdv = await AmbienteUi.IniciarAsync(raiz);
        await pdv.EntrarAsync("1", "1234");
        await pdv.EsperarFocoAsync("PainelSessaoOutro");
        var dialogo = (SessaoOutroOperadorViewModel)pdv.Shell.PaginaAtual!;
        pdv.Tecla(Key.D2);
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var pedido = dialogo.Liberacao!;
        pedido.Usuario = "2";
        pedido.Pin = "4321";
        pedido.Motivo = "Operador novo, treinamento";
        await pedido.ConfirmarCommand.ExecuteAsync(null);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "operando no caixa do CARLOS");
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixaId!.Value;
        await using (var db = Banco(pdv))
        {
            var operar = await db.LogAuditoriaLocal.SingleAsync(l => l.Acao == "caixa_operar_de_outro", Ct);
            Assert.Equal((Maria, Carlos, sessao), (operar.UsuarioId!.Value, operar.AutorizadoPorId!.Value, operar.SessaoCaixaId!.Value));
            var liberacao = await db.LogAuditoriaLocal.SingleAsync(l => l.Acao == "liberacao", Ct);
            Assert.Equal((Maria, Carlos, sessao, "Operador novo, treinamento"),
                (liberacao.UsuarioId!.Value, liberacao.AutorizadoPorId!.Value, liberacao.SessaoCaixaId!.Value, liberacao.Motivo));
        }

        // Fechamento e abertura com a liberação (o que a tela passa quando o operador não tem a permissão): a auditoria
        // `liberacao` vai no commit de cada um, com o fato e a sessão.
        var caixa = pdv.Servicos.GetRequiredService<ServicoCaixa>();
        var supervisor = new Operador(Carlos, 2, "carlos", "CARLOS", 100m, Master: true);
        var preparado = await caixa.PrepararFechamentoAsync(new LiberacaoConcedida(supervisor, "Fechamento no fim do expediente", DateTimeOffset.UtcNow), Ct);
        preparado.Fechamento.Contar(new Dictionary<Guid, decimal> { [preparado.Fechamento.Formas[0].Forma.Id] = 50m });
        var fechado = await caixa.FecharAsync(preparado, preparado.Fechamento.Confirmar(zeraCaixa: true, null),
            new LiberacaoConcedida(supervisor, "Fechamento no fim do expediente", DateTimeOffset.UtcNow), sair: false, Ct);
        await caixa.AbrirAsync(30m, null, null, null, new LiberacaoConcedida(supervisor, "Abertura do turno da noite", DateTimeOffset.UtcNow), ct: Ct);
        var nova = pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixaId!.Value;
        await using var banco = Banco(pdv);
        // A primeira liberação (operar no caixa de outro) é a da sessão do CARLOS; ficam as do fechamento e da abertura.
        var linhas = (await banco.LogAuditoriaLocal.Where(l => l.Acao == "liberacao" && l.RegistroId != sessao).ToListAsync(Ct))
            .OrderBy(l => l.Entidade, StringComparer.Ordinal).ToList();
        Assert.Equal(
            [("fechamentos_caixa", fechado.Fechamento.Id, sessao, "Fechamento no fim do expediente"), ("sessoes_caixa", nova, nova, "Abertura do turno da noite")],
            linhas.Select(l => (l.Entidade!, l.RegistroId!.Value, l.SessaoCaixaId!.Value, l.Motivo!)));
        Assert.All(linhas, l => Assert.Equal(Carlos, l.AutorizadoPorId));
    }
}
