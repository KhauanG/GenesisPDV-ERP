using System.Data.Common;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.App.ViewModels.Central;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Fiscal;
using GenesisPDV.Hardware.Gaveta;
using GenesisPDV.Hardware.Impressora;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Aba 2 Caixas da Central do PDV (bloco G6; README › decisão 71; decisões do dono de 04/11/2026: PC-9 opção A e os 30
/// dias): o fechamento de 15 dias atrás reimpresso idêntico (os bytes originais com a marca da 2ª via), offline, sem
/// apurar a sessão de novo (nenhuma consulta da apuração no banco), sem o calculado nem a diferença na tela, com a
/// auditoria <c>reimpressao</c>; o de 40 dias de fora; o F7 que vai às vendas do caixa e volta; sem o original,
/// "indisponível" sem gravar nada; o ENCARREGADO que reimprime e vê o resumo do dia com o supervisor na hora; a
/// operadora que vê os caixas só pela liberação da Central, o caixa aberto primeiro, o selo das canceladas depois, o
/// numérico e os botões de 44 px em 1024 × 700; o relatório que saiu com o calculado, que só sai de novo para quem o
/// veria; e a liberação da Central que acaba (nada fica na aba, nenhuma ação passa).
/// </summary>
public class CaixasCentralTelasTests
{
    private static readonly Guid Carlos = Guid.Parse("019a0003-0000-7000-8000-000000000002");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    /// <summary>
    /// O relatório de um fechamento fora do padrão O3 (a loja ligou a conferência ou o calculado no relatório), comprido
    /// como o de verdade (uma forma por linha): a 2ª via passa da dobra em 1024 × 700.
    /// </summary>
    private static readonly string RelatorioComCalculado = "FECHAMENTO ANTIGO\n"
        + string.Concat(Enumerable.Range(1, 30).Select(i => $"Forma {i:00}\n  Calculado  10,00\n  Contado  10,00\n"))
        + "Total contado:  300,00\nTotal calculado:  321,09\n";

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

    private static async Task LiberarNaCentralAsync(AmbienteUi pdv, CentralPdvViewModel central)
    {
        pdv.Tecla(Key.L, RawInputModifiers.Control);
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "2";
        central.PinLiberacao = "4321";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => !central.Liberando && central.LiberacaoTexto is not null, "liberado pelo CARLOS");
    }

    /// <summary>Gelo (12,90) pago com 20,00 em dinheiro.</summary>
    private static async Task VenderAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
    }

    /// <summary>F11 › 3, o dinheiro contado e Enter (fechamento cego); Enter de novo no relatório volta ao login.</summary>
    private static async Task FecharCaixaAsync(AmbienteUi pdv, string contado)
    {
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.D3);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is FechamentoCaixaViewModel, "tela de fechamento");
        await pdv.EsperarFocoAsync("CampoValorForma");
        var fechamento = (FechamentoCaixaViewModel)pdv.Shell.PaginaAtual!;
        pdv.Digitar(contado);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => fechamento.Concluido, "fechamento confirmado");
        await pdv.Servicos.GetRequiredService<ServicoBackup>().AguardarAsync();
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "volta ao login");
    }

    /// <summary>Leva o caixa fechado (e o fechamento dele) <paramref name="dias"/> dias para trás.</summary>
    private static async Task<(SessaoCaixaRegistro Sessao, FechamentoCaixaRegistro Fechamento)> EnvelhecerAsync(AmbienteUi pdv, int dias)
    {
        await using var db = Banco(pdv);
        var sessao = await db.SessoesCaixa.SingleAsync(s => s.Status == StatusSessaoCaixa.Fechada, Ct);
        var fechamento = await db.FechamentosCaixa.SingleAsync(f => f.SessaoCaixaId == sessao.Id, Ct);
        var d = TimeSpan.FromDays(dias);
        sessao.AbertaEm -= d;
        sessao.FechadaEm -= d;
        sessao.DiaOperacional = sessao.DiaOperacional.AddDays(-dias);
        fechamento.OcorridoEm -= d;
        fechamento.DiaOperacional = fechamento.DiaOperacional.AddDays(-dias);
        await db.SaveChangesAsync(Ct);
        return (sessao, fechamento);
    }

    /// <summary>
    /// Um caixa fechado há <paramref name="dias"/> dias, com o fechamento e o relatório dele na fila; com
    /// <paramref name="canceladaDepois"/>, uma venda de R$ 5,00 cancelada depois do fechamento (o dado pode chegar assim);
    /// com <paramref name="comCalculado"/>, o relatório saiu com o calculado.
    /// </summary>
    private static async Task<SessaoCaixaRegistro> CaixaFechadoAsync(AmbienteUi pdv, int dias, bool canceladaDepois = false, bool comCalculado = false)
    {
        var identidade = pdv.Servicos.GetRequiredService<SessaoTerminal>().Identidade!;
        var fechada = DateTimeOffset.UtcNow.AddDays(-dias);
        var sessao = new SessaoCaixaRegistro
        {
            Id = Guid.CreateVersion7(),
            LojaId = identidade.LojaId,
            CaixaId = identidade.CaixaId,
            NumeroCaixa = (short)identidade.NumeroCaixa,
            TerminalId = identidade.TerminalId,
            OperadorId = Carlos,
            Status = StatusSessaoCaixa.Fechada,
            DiaOperacional = DateOnly.FromDateTime(fechada.UtcDateTime),
            AbertaEm = fechada.AddHours(-8),
            FundoTroco = 50m,
            FechadaEm = fechada,
            CriadoEm = fechada,
            AtualizadoEm = fechada,
            Versao = 1,
        };
        var fechamento = new FechamentoCaixaRegistro
        {
            Id = Guid.CreateVersion7(),
            SessaoCaixaId = sessao.Id,
            LojaId = sessao.LojaId,
            CaixaId = sessao.CaixaId,
            TerminalId = sessao.TerminalId,
            NumeroCaixa = sessao.NumeroCaixa,
            Tipo = "fechamento",
            ZeraCaixa = true,
            UsuarioAnteriorId = Carlos,
            TotalCalculado = 321.09m,
            TotalDigitado = 300m,
            FechamentoCego = true,
            OcorridoEm = fechada,
            DiaOperacional = sessao.DiaOperacional,
            CriadoEm = fechada,
            AtualizadoEm = fechada,
            Versao = 1,
        };
        await using var db = Banco(pdv);
        db.AddRange(sessao, fechamento);
        db.FilaImpressao.Add(new FilaImpressao
        {
            Id = Guid.CreateVersion7(),
            TipoDocumento = ServicoHistoricoCaixas.DocumentoFechamento,
            ReferenciaId = fechamento.Id,
            Conteudo = System.Text.Encoding.ASCII.GetBytes(comCalculado ? RelatorioComCalculado : "FECHAMENTO ANTIGO\n"),
            Status = "impresso",
            CriadoEm = fechada,
        });
        if (canceladaDepois)
        {
            var paga = await db.Vendas.AsNoTracking().OrderBy(v => v.Numero).FirstAsync(Ct);
            db.Vendas.Add(new VendaRegistro
            {
                Id = Guid.CreateVersion7(),
                Numero = 7001,
                NumeroExibicao = "L01-C02-007001",
                LojaId = paga.LojaId,
                CaixaId = paga.CaixaId,
                NumeroCaixa = paga.NumeroCaixa,
                TerminalId = paga.TerminalId,
                SessaoCaixaId = sessao.Id,
                OperadorId = Carlos,
                Status = StatusVenda.Cancelada,
                IniciadaEm = fechada.AddHours(-2),
                FinalizadaEm = fechada.AddHours(-2),
                CanceladaEm = fechada.AddDays(1),
                MotivoCancelamento = "Cancelada pelo ERP depois do fechamento",
                QtdItens = 1,
                SubtotalBruto = 5m,
                Total = 5m,
                CriadoEm = fechada,
                AtualizadoEm = fechada,
                Versao = 1,
            });
        }

        await db.SaveChangesAsync(Ct);
        return sessao;
    }

    private static async Task<AbaCaixasViewModel> AbrirAbaCaixasAsync(AmbienteUi pdv, CentralPdvViewModel central)
    {
        pdv.Tecla(Key.D2);
        await pdv.EsperarAsync(() => central.Conteudo is AbaCaixasViewModel, "aba 2 Caixas");
        await pdv.EsperarFocoAsync("PainelListaCaixasCentral");
        var aba = (AbaCaixasViewModel)central.Conteudo!;
        await aba.Atualizacao;
        return aba;
    }

    /// <summary>A linha "Vendas:" do resumo diário (só a quantidade, ou com o valor).</summary>
    private static string LinhaDeVendas(string? resumo) =>
        (resumo ?? string.Empty).Split('\n').Single(l => l.StartsWith("Vendas:", StringComparison.Ordinal));

    private static async Task<List<LogAuditoriaLocal>> AuditoriaAsync(AmbienteUi pdv, string acao)
    {
        await using var db = Banco(pdv);
        return await db.LogAuditoriaLocal.AsNoTracking().Where(l => l.Acao == acao).OrderBy(l => l.OcorridoEm).ToListAsync(Ct);
    }

    [AvaloniaFact]
    public async Task Fechamento_de_15_dias_reimpresso_identico_offline_sem_recalcular_nem_mostrar_o_calculado()
    {
        var sql = new ComandosSql();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<IDbContextFactory<PdvDbContext>>(sp => sql.Fabrica(sp.GetRequiredService<FabricaPdvDb>())));
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await VenderAsync(pdv, venda);
        // Esperado 112,90; o contado 110 (o relatório cego não mostra o esperado, O3).
        await FecharCaixaAsync(pdv, "110");
        var (sessao, fechamento) = await EnvelhecerAsync(pdv, 15);
        var velho = await CaixaFechadoAsync(pdv, 40);
        byte[] original;
        await using (var db = Banco(pdv))
        {
            original = await db.FilaImpressao.Where(f => f.TipoDocumento == "fechamento_caixa" && f.ReferenciaId == fechamento.Id).Select(f => f.Conteudo).SingleAsync(Ct);
        }

        // Pelo login, o CARLOS: o 2 abre a aba com o foco na lista, só com o caixa de 15 dias (o de 40 fica no ERP).
        var central = await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        sql.Limpar();
        var aba = await AbrirAbaCaixasAsync(pdv, central);
        var linha = Assert.Single(aba.Linhas);
        Assert.Equal((sessao.Id, "Fechamento", "110,00", "MARIA", "1 venda"), (linha.Caixa.SessaoId, linha.Situacao, linha.Contado, linha.Operador, linha.Vendas));
        Assert.Equal("aguardando", linha.Envio);
        Assert.DoesNotContain(aba.Linhas, l => l.Caixa.SessaoId == velho.Id);
        Assert.Equal(ConsultasHistoricoLocal.MensagemMaisAntigas, aba.AvisoMaisAntigos);
        pdv.Captura("72-central-caixas");

        // Enter: o detalhe pelo retrato, com o contado e o resumo do turno, sem o calculado (112,90) nem a diferença.
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe");
        await pdv.EsperarFocoAsync("PainelDetalheCaixaCentral");
        Assert.Contains("  Dinheiro: R$ 110,00", aba.LinhasDetalhe);
        Assert.Contains("Total contado: R$ 110,00", aba.LinhasDetalhe);
        Assert.Contains(aba.LinhasDetalhe, l => l.StartsWith("Vendas do turno: 1 · R$ 12,90", StringComparison.Ordinal));
        Assert.Contains(AbaCaixasViewModel.MensagemSoNoErp, aba.LinhasDetalhe);
        Assert.DoesNotContain(aba.LinhasDetalhe, l => l.Contains("112,90", StringComparison.Ordinal) || l.Contains("R$ 2,90", StringComparison.Ordinal) || l.Contains("-2,90", StringComparison.Ordinal));
        Assert.All(aba.LinhasDetalhe.Where(l => l != AbaCaixasViewModel.MensagemSoNoErp), l =>
        {
            Assert.DoesNotContain("alculado", l, StringComparison.Ordinal);
            Assert.DoesNotContain("iferença", l, StringComparison.Ordinal);
        });

        // Ctrl+R: a 2ª via = a marca + os bytes originais do relatório daquele dia (nada montado de novo), auditada.
        pdv.Tecla(Key.R, RawInputModifiers.Control);
        await pdv.EsperarAsync(() => aba.TextoSegundaVia is not null, "2ª via");
        pdv.Captura("73-central-caixas-2a-via");
        Assert.Contains(LayoutComprovanteVenda.MarcaReimpressao, aba.TextoSegundaVia, StringComparison.Ordinal);
        Assert.Contains("FECHAMENTO DE CAIXA", aba.TextoSegundaVia, StringComparison.Ordinal);
        await using (var db = Banco(pdv))
        {
            var segunda = await db.FilaImpressao.Where(f => f.TipoDocumento == ServicoHistoricoCaixas.DocumentoReimpressao).Select(f => f.Conteudo).SingleAsync(Ct);
            Assert.True(segunda.Length > original.Length);
            Assert.Equal(original, segunda[^original.Length..]);
            // O original continua o primeiro trabalho do documento (a 3ª via sai igual à 2ª).
            Assert.Equal(original, await pdv.Servicos.GetRequiredService<RepositorioImpressao>().OriginalAsync("fechamento_caixa", fechamento.Id, Ct));
        }

        var reimpressao = Assert.Single(await AuditoriaAsync(pdv, "reimpressao"));
        Assert.Equal(("fechamentos_caixa", fechamento.Id, Carlos, (Guid?)null, AbaCaixasViewModel.Localizacao),
            (reimpressao.Entidade, reimpressao.RegistroId!.Value, reimpressao.UsuarioId!.Value, reimpressao.AutorizadoPorId, reimpressao.Localizacao));
        Assert.Contains("fechamento do caixa", reimpressao.Descricao, StringComparison.Ordinal);

        // Nenhuma consulta da apuração (RepositorioCaixa.ApurarAsync: os itens e as liberações das vendas; os estornos
        // escolhidos no payload do venda.cancelada): a lista, o detalhe e a 2ª via só leem o retrato e a fila.
        Assert.NotEmpty(sql.Comandos);
        Assert.DoesNotContain(sql.Comandos, ComandosSql.DaApuracao);

        // F7: as vendas deste caixa na aba 1 (o filtro no caixa); o F7 de lá volta ao detalhe dele aqui.
        pdv.Tecla(Key.F7);
        await pdv.EsperarAsync(() => central.Conteudo is AbaVendasViewModel, "aba 1 Vendas");
        var vendas = (AbaVendasViewModel)central.Conteudo!;
        await pdv.EsperarAsync(() => vendas.CaixaEscolhido?.SessaoId == sessao.Id && !vendas.Carregando, "vendas do caixa");
        await vendas.Atualizacao;
        Assert.Equal("12,90", Assert.Single(vendas.Linhas).Total);
        await pdv.EsperarFocoAsync("CampoFiltroVendasCentral");
        pdv.Tecla(Key.F7);
        await pdv.EsperarAsync(() => central.Conteudo is AbaCaixasViewModel { MostrandoDetalhe: true }, "de volta ao detalhe do caixa");
        await pdv.EsperarFocoAsync("PainelDetalheCaixaCentral");
        Assert.StartsWith("Caixa 02 · fechamento em ", aba.TituloDetalhe, StringComparison.Ordinal);

        // Sem o original (por exemplo depois de recuperar o banco pela nuvem): "indisponível", e nada é gravado nem sai.
        await using (var db = Banco(pdv))
        {
            await db.FilaImpressao.Where(f => f.ReferenciaId == fechamento.Id).ExecuteDeleteAsync(Ct);
        }

        pdv.Clicar(pdv.Controle<Button>("BotaoReimprimirDetalheCaixa"));
        await pdv.EsperarAsync(() => aba.Erro is not null, "indisponível", timeoutMs: 30_000);
        Assert.Equal(ServicoHistoricoCaixas.MensagemIndisponivel, aba.Erro);
        Assert.Single(await AuditoriaAsync(pdv, "reimpressao"));
        await using (var db = Banco(pdv))
        {
            Assert.Equal(0, await db.FilaImpressao.CountAsync(f => f.ReferenciaId == fechamento.Id, Ct));
        }

        // Esc: o detalhe fecha (o foco na lista); Esc de novo volta ao menu.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("PainelListaCaixasCentral");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "2", "menu");

        // O detector pega a apuração de verdade (a prova de que a ausência acima vale alguma coisa).
        sql.Limpar();
        await pdv.Servicos.GetRequiredService<RepositorioCaixa>().ApurarAsync(sessao.Id, Ct);
        Assert.Contains(sql.Comandos, ComandosSql.DaApuracao);
    }

    [AvaloniaFact]
    public async Task Encarregado_reimprime_e_ve_o_resumo_do_dia_com_o_supervisor_na_hora()
    {
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: AutenticadorComExtras.Registrar);
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await VenderAsync(pdv, venda);
        await FecharCaixaAsync(pdv, "110");
        var (sessao, fechamento) = await EnvelhecerAsync(pdv, 3);

        // O ENCARREGADO (PC-8) vê os caixas, mas não reimprime nem tira o resumo sozinho: o CARLOS libera na hora.
        var central = await pdv.EntrarNaCentralPeloLoginAsync("encarregado", AutenticadorComExtras.PinEncarregado);
        Assert.False(central.Abas.Single(a => a.Codigo == "2").Bloqueada);
        var aba = await AbrirAbaCaixasAsync(pdv, central);
        Assert.Equal(sessao.Id, Assert.Single(aba.Linhas).Caixa.SessaoId);

        // O pedido do supervisor deixado aberto (a pessoa foi à aba Vendas pelo mouse) não segura o F7 de lá: o detalhe abre.
        pdv.Clicar(pdv.Controle<Button>("BotaoReimprimirCaixaCentral"));
        await pdv.EsperarAsync(() => aba.Liberacao is not null, "pedido do supervisor");
        await aba.DetalharSessaoAsync(sessao.Id);
        Assert.Null(aba.Liberacao);
        Assert.True(aba.MostrandoDetalhe);
        await pdv.EsperarFocoAsync("PainelDetalheCaixaCentral");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("PainelListaCaixasCentral");
        Assert.Empty(await AuditoriaAsync(pdv, "reimpressao"));

        pdv.Clicar(pdv.Controle<Button>("BotaoReimprimirCaixaCentral"));
        await pdv.EsperarAsync(() => aba.Liberacao is not null, "pedido do supervisor");
        await pdv.EsperarFocoAsync("CampoSupervisor");
        aba.Liberacao!.Usuario = "2";
        aba.Liberacao.Pin = "4321";
        aba.Liberacao.Motivo = "Conferência do fechamento";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.Liberacao is null && aba.Mensagem is not null, "reimpresso com o CARLOS");
        await pdv.EsperarFocoAsync("PainelListaCaixasCentral");
        var reimpressao = Assert.Single(await AuditoriaAsync(pdv, "reimpressao"));
        Assert.Equal((AutenticadorComExtras.Encarregado.Id, Carlos, "Conferência do fechamento", fechamento.Id),
            (reimpressao.UsuarioId!.Value, reimpressao.AutorizadoPorId!.Value, reimpressao.Motivo, reimpressao.RegistroId!.Value));

        // F6: o resumo do dia do caixa, pelas regras do F11 › 6 (sem a permissão, o supervisor libera; a liberação uma vez).
        pdv.Tecla(Key.F6);
        await pdv.EsperarAsync(() => aba.Liberacao is not null, "pedido do resumo");
        aba.Liberacao!.Usuario = "2";
        aba.Liberacao.Pin = "4321";
        aba.Liberacao.Motivo = "Resumo do dia para a conferência";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.MostrandoResumo, "resumo do dia");
        await pdv.EsperarFocoAsync("PainelResumoCaixaCentral");
        Assert.Contains("RESUMO DIÁRIO", aba.TextoResumo, StringComparison.Ordinal);
        // O3 de quem está na Central (o ENCARREGADO não vê o calculado; ninguém logado no caixa): só as quantidades.
        Assert.Contains("Fechamento cego:", aba.TextoResumo, StringComparison.Ordinal);
        Assert.DoesNotContain("R$", LinhaDeVendas(aba.TextoResumo), StringComparison.Ordinal);
        pdv.Captura("74-central-caixas-resumo");
        pdv.Tecla(Key.P, RawInputModifiers.Control);
        await pdv.EsperarAsync(() => aba.Mensagem?.Contains("Resumo", StringComparison.Ordinal) == true
                                     || aba.Mensagem?.Contains("impressora", StringComparison.Ordinal) == true, "resumo impresso");
        var liberacoes = (await AuditoriaAsync(pdv, "liberacao")).Where(l => l.Descricao?.Contains("Resumo diário", StringComparison.Ordinal) == true).ToList();
        Assert.Equal(Carlos, Assert.Single(liberacoes).AutorizadoPorId);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => !aba.MostrandoResumo, "resumo fechado");
        await pdv.EsperarFocoAsync("PainelListaCaixasCentral");
        // A mensagem do resumo ("enviado à impressora") não fica na lista.
        Assert.Null(aba.Mensagem);

        // A loja que tira o fechamento cego: o mesmo F6 já mostra os valores (as regras de agora, para quem está aqui).
        await ConfigurarAsync(pdv, (ChavesConfiguracao.FechamentoCego, "false"));
        pdv.Tecla(Key.F6);
        await pdv.EsperarAsync(() => aba.Liberacao is not null, "pedido do resumo de novo");
        aba.Liberacao!.Usuario = "2";
        aba.Liberacao.Pin = "4321";
        aba.Liberacao.Motivo = "Resumo com os valores";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.MostrandoResumo, "resumo com os valores");
        Assert.DoesNotContain("Fechamento cego:", aba.TextoResumo, StringComparison.Ordinal);
        Assert.Contains("R$", LinhaDeVendas(aba.TextoResumo), StringComparison.Ordinal);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => !aba.MostrandoResumo, "resumo fechado de novo");
        await pdv.EsperarFocoAsync("PainelListaCaixasCentral");

        // Sem o original, "indisponível" antes de pedir o PIN (nada sairia): o pedido do supervisor nem abre.
        await using (var db = Banco(pdv))
        {
            await db.FilaImpressao.Where(f => f.ReferenciaId == fechamento.Id).ExecuteDeleteAsync(Ct);
        }

        pdv.Tecla(Key.R, RawInputModifiers.Control);
        await pdv.EsperarAsync(() => aba.Erro is not null, "indisponível", timeoutMs: 30_000);
        Assert.Equal(ServicoHistoricoCaixas.MensagemIndisponivel, aba.Erro);
        Assert.Null(aba.Liberacao);

        // F7 sem a aba 1 (o ENCARREGADO de teste não tem pdv.venda.consultar): o cadeado pede quem pode; Esc fecha.
        pdv.Tecla(Key.F7);
        await pdv.EsperarAsync(() => central.Liberando, "a aba 1 pede o supervisor");
        Assert.Equal("Liberar a aba 1 Vendas", central.TituloLiberacao);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => !central.Liberando, "pedido fechado");
        Assert.IsType<AbaCaixasViewModel>(central.Conteudo);
    }

    [AvaloniaFact]
    public async Task Operadora_ve_os_caixas_pela_liberacao_com_o_aberto_primeiro_e_as_canceladas_depois()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await VenderAsync(pdv, venda);
        var fechado = await CaixaFechadoAsync(pdv, 3, canceladaDepois: true, comCalculado: true);
        pdv.Janela.Width = 1024;
        pdv.Janela.Height = 700;

        // A MARIA (operadora) não vê os fechamentos: o 2 com cadeado pede o supervisor (Ctrl+L da Central).
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();
        Assert.True(central.Abas.Single(a => a.Codigo == "2").Bloqueada);
        pdv.Clicar(pdv.BotaoDaAba("2"));
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "2";
        central.PinLiberacao = "4321";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => central.Conteudo is AbaCaixasViewModel, "aba 2 pela liberação");
        await pdv.EsperarFocoAsync("PainelListaCaixasCentral");
        var aba = (AbaCaixasViewModel)central.Conteudo!;
        await aba.Atualizacao;
        Assert.True(central.Abas.Single(a => a.Codigo == "2").Emprestada);

        // O caixa aberto primeiro (sem contado nem envio), depois o fechado com o selo das canceladas depois.
        Assert.Equal([true, false], aba.Linhas.Select(l => l.Caixa.Aberto));
        Assert.Equal(("ABERTO", "—", "—", string.Empty), (aba.Linhas[0].Situacao, aba.Linhas[0].Fechamento, aba.Linhas[0].Contado, aba.Linhas[0].Envio));
        Assert.Equal(("canceladas depois: 1 · R$ 5,00", "300,00", "sem registro"), (aba.Linhas[1].Selo, aba.Linhas[1].Contado, aba.Linhas[1].Envio));
        // A primeira coluna diz a situação do caixa (o número está no título do detalhe e na leitura da linha).
        Assert.Equal("Situação", pdv.Controle<TextBlock>("CabecalhoSituacaoCaixas").Text);
        Assert.StartsWith("Caixa 02, Fechamento, ", aba.Linhas[1].Leitura, StringComparison.Ordinal);
        pdv.Captura("75-central-caixas-1024");

        // O caixa aberto não tem fechamento a reimprimir.
        pdv.Tecla(Key.R, RawInputModifiers.Control);
        await pdv.EsperarAsync(() => aba.Erro is not null, "aberto sem fechamento");
        Assert.Equal(ServicoHistoricoCaixas.MensagemCaixaAberto, aba.Erro);

        // ↓ e o * do numérico: o detalhe do fechado, com o bloco "depois do fechamento".
        pdv.Tecla(Key.Down);
        Assert.Equal(fechado.Id, aba.Selecionada!.Caixa.SessaoId);
        pdv.Tecla(Key.Multiply);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe pelo *");
        Assert.Contains("Depois do fechamento:", aba.LinhasDetalhe);
        Assert.Contains(aba.LinhasDetalhe, l => l.StartsWith("  Venda L01-C02-007001 · R$ 5,00 · cancelada em ", StringComparison.Ordinal));
        Assert.Contains(AbaCaixasViewModel.MensagemDepoisDoFechamento, aba.LinhasDetalhe);
        Assert.Contains("Envio do fechamento: sem registro de envio neste caixa", aba.LinhasDetalhe);
        Assert.DoesNotContain(aba.LinhasDetalhe, l => l.Contains("321,09", StringComparison.Ordinal));
        Assert.True(pdv.Controle<Button>("BotaoVoltarDetalheCaixa").Bounds.Height >= 44);

        // O relatório daquele dia saiu com o calculado e a diferença (a loja fora do padrão O3): a MARIA reimprime por
        // conta própria e vê os caixas pela liberação, mas não vê o calculado (que não se empresta). Nada sai nem é gravado.
        pdv.Tecla(Key.R, RawInputModifiers.Control);
        await pdv.EsperarAsync(() => aba.Erro is not null, "2ª via com o calculado recusada");
        Assert.Equal(ServicoHistoricoCaixas.MensagemComCalculado, aba.Erro);
        Assert.Null(aba.TextoSegundaVia);
        Assert.Null(aba.Liberacao);
        Assert.Empty(await AuditoriaAsync(pdv, "reimpressao"));
        await using (var db = Banco(pdv))
        {
            Assert.Equal(0, await db.FilaImpressao.CountAsync(f => f.TipoDocumento == ServicoHistoricoCaixas.DocumentoReimpressao, Ct));
        }

        pdv.Clicar(pdv.Controle<Button>("BotaoVoltarDetalheCaixa"));
        await pdv.EsperarFocoAsync("PainelListaCaixasCentral");

        // Tudo pelo mouse também (decisão 65), em 1024 × 700: os botões de 44 px e o duplo clique na linha.
        Assert.True(pdv.Controle<ListBox>("ListaCaixasCentral").Bounds.Height >= 120, "a lista com espaço para alguns caixas");
        foreach (var nome in new[] { "BotaoDetalheCaixaCentral", "BotaoReimprimirCaixaCentral", "BotaoVendasCaixaCentral", "BotaoResumoCaixaCentral" })
        {
            Assert.True(pdv.Controle<Button>(nome).Bounds.Height >= 44, nome);
        }

        pdv.DuploClique(pdv.LinhaDaLista("ListaCaixasCentral", l => l is LinhaCaixaCentralViewModel { Caixa.Aberto: true }));
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe pelo duplo clique");
        Assert.Contains(aba.LinhasDetalhe, l => l.StartsWith("Caixa aberto: o fechamento ainda não foi feito", StringComparison.Ordinal));
        Assert.DoesNotContain(AbaCaixasViewModel.MensagemSoNoErp, aba.LinhasDetalhe);
    }

    [AvaloniaFact]
    public async Task Relatorio_com_o_calculado_so_sai_de_novo_para_quem_o_ve_e_a_2a_via_rola_ate_a_vista()
    {
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: AutenticadorComExtras.Registrar);
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await VenderAsync(pdv, venda);
        var fechado = await CaixaFechadoAsync(pdv, 3, comCalculado: true);
        // Sem impressora configurada: a 2ª via só na tela.
        await pdv.Servicos.GetRequiredService<ServicoHardware>().GravarAsync(
            new ConfiguracaoHardware(new ConfiguracaoImpressora { Conexao = TipoConexao.Nenhuma }, new ConfiguracaoGaveta()), null, null, Ct);
        pdv.Shell.IrParaLogin();
        pdv.Janela.Width = 1024;
        pdv.Janela.Height = 700;

        // O CONFERENTE (perfil personalizado) vê os fechamentos e reimprime, mas não vê o calculado: a 2ª via do
        // relatório que saiu com ele é recusada antes de tudo ("consulte no ERP").
        var central = await pdv.EntrarNaCentralPeloLoginAsync("conferente", AutenticadorComExtras.PinConferente);
        var aba = await AbrirAbaCaixasAsync(pdv, central);
        pdv.Tecla(Key.Down);
        Assert.Equal(fechado.Id, aba.Selecionada!.Caixa.SessaoId);
        pdv.Tecla(Key.R, RawInputModifiers.Control);
        await pdv.EsperarAsync(() => aba.Erro is not null, "recusada");
        Assert.Equal(ServicoHistoricoCaixas.MensagemComCalculado, aba.Erro);
        Assert.Empty(await AuditoriaAsync(pdv, "reimpressao"));

        // F7 com a aba 1, mas sem o histórico de vendas: a aba 1 diz como liberar (o caixa fechado não entra no filtro).
        pdv.Tecla(Key.F7);
        await pdv.EsperarAsync(() => central.Conteudo is AbaVendasViewModel { Mensagem: not null }, "aba 1 sem o histórico");
        var vendas = (AbaVendasViewModel)central.Conteudo!;
        Assert.Equal(AbaVendasViewModel.MensagemSemHistorico, vendas.Mensagem);
        Assert.NotEqual(fechado.Id, vendas.CaixaEscolhido?.SessaoId);

        // A loja liga o calculado no relatório (pdv.imprime_calculado_no_fechamento): o fechamento de qualquer um sai com
        // ele, então a 2ª via também. Pela lista e sem impressora, o detalhe abre com o texto dela (a única cópia).
        await ConfigurarAsync(pdv, (ChavesConfiguracao.ImprimeCalculadoNoFechamento, "true"));
        pdv.Clicar(pdv.BotaoDaAba("2"));
        await pdv.EsperarAsync(() => central.Conteudo is AbaCaixasViewModel, "de volta à aba 2");
        await pdv.EsperarFocoAsync("PainelListaCaixasCentral");
        await aba.Atualizacao;
        aba.Selecionada = aba.Linhas.Single(l => l.Caixa.SessaoId == fechado.Id);
        pdv.Clicar(pdv.Controle<Button>("BotaoReimprimirCaixaCentral"));
        await pdv.EsperarAsync(() => aba.TextoSegundaVia is not null, "2ª via no detalhe");
        Assert.True(aba.MostrandoDetalhe);
        Assert.Equal(ServicoHistoricoCaixas.MensagemReimpressaoSemImpressora, aba.Mensagem);
        Assert.Contains("Total calculado:", aba.TextoSegundaVia, StringComparison.Ordinal);
        Assert.Single(await AuditoriaAsync(pdv, "reimpressao"));

        // Em 1024 × 700 a 2ª via fica abaixo da dobra: a tela rola até ela, e o teclado rola o detalhe (PgUp/PgDn, as setas).
        var rolagem = pdv.Controle<ScrollViewer>("RolagemDetalheCaixaCentral");
        await pdv.EsperarAsync(() => rolagem.Offset.Y > 0, "rolou até a 2ª via");
        await pdv.EsperarFocoAsync("PainelDetalheCaixaCentral");
        var embaixo = rolagem.Offset.Y;
        pdv.Tecla(Key.PageUp);
        await pdv.EsperarAsync(() => rolagem.Offset.Y < embaixo, "PgUp rola para cima");
        var meio = rolagem.Offset.Y;
        pdv.Tecla(Key.Down);
        await pdv.EsperarAsync(() => rolagem.Offset.Y > meio, "↓ rola para baixo");
        pdv.Tecla(Key.NumPad9);
        await pdv.EsperarAsync(() => rolagem.Offset.Y < meio + 1, "9 do numérico rola para cima");
        pdv.Captura("76-central-caixas-2a-via-1024");

        // Esc: a lista sem a mensagem da 2ª via (era do detalhe daquele caixa).
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("PainelListaCaixasCentral");
        Assert.Null(aba.Mensagem);
        Assert.Null(aba.Erro);
    }

    [AvaloniaFact]
    public async Task Liberacao_que_acaba_fecha_o_que_a_aba_mostrava_e_nenhuma_acao_passa()
    {
        var tempo = new Tempo();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s =>
        {
            AutenticadorComExtras.Registrar(s);
            s.AddSingleton<TimeProvider>(tempo);
        });
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");
        await VenderAsync(pdv, venda);
        var fechado = await CaixaFechadoAsync(pdv, 3);
        pdv.Shell.IrParaLogin();

        // O TECNICO (sem ver os caixas nem reimprimir) pelo login; o CARLOS empresta os caixas pelo Ctrl+L.
        var central = await pdv.EntrarNaCentralPeloLoginAsync("tecnico", AutenticadorComExtras.PinTecnico);
        await LiberarNaCentralAsync(pdv, central);
        var aba = await AbrirAbaCaixasAsync(pdv, central);
        aba.Selecionada = aba.Linhas.Single(l => l.Caixa.SessaoId == fechado.Id);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe");
        pdv.Tecla(Key.R, RawInputModifiers.Control);
        await pdv.EsperarAsync(() => aba.Liberacao is not null, "pedido do supervisor para reimprimir");

        // 5 min sem uso: a Central volta ao Painel e a aba guardada não fica com o detalhe nem com o pedido do supervisor.
        tempo.Avancar(AcessoCentral.ValidadeLiberacao + TimeSpan.FromSeconds(1));
        central.Atualizar();
        Assert.Equal("0", central.AbaSelecionada!.Codigo);
        Assert.Null(aba.Liberacao);
        Assert.False(aba.MostrandoDetalhe);
        Assert.Null(aba.TextoSegundaVia);
        Assert.Empty(aba.Linhas);

        // Outra liberação: a aba lê de novo, sem o pedido velho.
        await pdv.EsperarAsync(() => pdv.AbaFocada() is not null, "foco no menu");
        await LiberarNaCentralAsync(pdv, central);
        pdv.Tecla(Key.D2);
        await pdv.EsperarAsync(() => central.Conteudo is AbaCaixasViewModel, "aba 2 de novo");
        await aba.Atualizacao;
        Assert.Null(aba.Liberacao);
        Assert.False(aba.MostrandoDetalhe);
        Assert.Contains(aba.Linhas, l => l.Caixa.SessaoId == fechado.Id);
        aba.Selecionada = aba.Linhas.Single(l => l.Caixa.SessaoId == fechado.Id);

        // A liberação acaba entre o relógio de 1 s e a tecla: F6 e F7 também são recusados na hora (e o serviço confere).
        tempo.Avancar(AcessoCentral.ValidadeLiberacao + TimeSpan.FromSeconds(1));
        await aba.ResumoDoDiaCommand.ExecuteAsync(null);
        Assert.Equal(AbaCaixasViewModel.MensagemLiberacaoAcabou, aba.Erro);
        Assert.Null(aba.Liberacao);
        Assert.False(aba.MostrandoResumo);
        await aba.VerVendasCommand.ExecuteAsync(null);
        Assert.Equal(AbaCaixasViewModel.MensagemLiberacaoAcabou, aba.Erro);
        Assert.False(central.Conteudo is AbaVendasViewModel);
        var servico = pdv.Servicos.GetRequiredService<ServicoHistoricoCaixas>();
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() => servico.ResumoDoDiaAsync(fechado.DiaOperacional, imprimir: false, ct: Ct));
        Assert.Equal(ServicoHistoricoCaixas.MensagemSemPermissao, recusa.Message);
        Assert.Empty(await AuditoriaAsync(pdv, "reimpressao"));
    }

    /// <summary>O relógio monotônico da liberação, avançado à mão.</summary>
    private sealed class Tempo : TimeProvider
    {
        private long _ticks = 1;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => _ticks;

        public void Avancar(TimeSpan quanto) => _ticks += quanto.Ticks;
    }

    /// <summary>
    /// Guarda o SQL de toda consulta do PDV (troca a fábrica de contextos pelo <c>ajustar</c>): a prova de que a aba
    /// Caixas não chama a apuração da sessão (<c>RepositorioCaixa.ApurarAsync</c> e os estornos escolhidos).
    /// </summary>
    private sealed class ComandosSql : DbCommandInterceptor
    {
        private readonly List<string> _comandos = [];

        public IReadOnlyList<string> Comandos
        {
            get
            {
                lock (_comandos)
                {
                    return [.. _comandos];
                }
            }
        }

        /// <summary>A apuração lê os itens e as liberações das vendas da sessão e o payload dos <c>venda.cancelada</c>.</summary>
        public static bool DaApuracao(string sql) =>
            sql.Contains("\"itens_venda\"", StringComparison.Ordinal)
            || sql.Contains("\"liberacoes_venda\"", StringComparison.Ordinal)
            || sql.Contains("'venda.cancelada'", StringComparison.Ordinal);

        public void Limpar()
        {
            lock (_comandos)
            {
                _comandos.Clear();
            }
        }

        public IDbContextFactory<PdvDbContext> Fabrica(FabricaPdvDb real) => new FabricaRegistrando(
            new DbContextOptionsBuilder<PdvDbContext>(FabricaPdvDb.Opcoes(real.StringConexao)).AddInterceptors(this).Options);

        public override InterceptionResult<DbDataReader> ReaderExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result)
        {
            Guardar(command);
            return result;
        }

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            Guardar(command);
            return ValueTask.FromResult(result);
        }

        private void Guardar(DbCommand command)
        {
            lock (_comandos)
            {
                _comandos.Add(command.CommandText);
            }
        }

        private sealed class FabricaRegistrando(DbContextOptions<PdvDbContext> opcoes) : IDbContextFactory<PdvDbContext>
        {
            public PdvDbContext CreateDbContext() => new(opcoes);
        }
    }
}
