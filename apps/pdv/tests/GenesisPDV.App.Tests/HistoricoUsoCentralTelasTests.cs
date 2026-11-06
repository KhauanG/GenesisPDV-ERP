using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.VisualTree;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.App.ViewModels;
using GenesisPDV.App.ViewModels.Central;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Aba 6 Histórico de uso da Central do PDV (bloco G10; plano 4.4; README › decisão 74): o "pronto quando" do plano — o
/// dono vê o resumo da semana por operador no caixa offline —; a operadora que não vê a aba (o cadeado) e o dono que libera
/// (o Encarregado não vê, PC-8; decisão 68); a lista em frases com a marca "só local / a enviar / enviado"; os filtros de
/// período, grupo, quem (também o que a pessoa liberou com o PIN, com o selo "LIBEROU": resposta do dono de 05/11/2026,
/// decisão 78) e texto (o texto escondido pela máscara não acha nada); o detalhe com o motivo mascarado e só os
/// campos exibíveis (o login digitado e o dinheiro estimado, não); o F6 com os totais por operador e o Enter que volta à
/// lista só com a pessoa; tudo pelo mouse também, com os botões de 44 px em 1024 × 700; olhar não grava nada além do
/// acesso; e a liberação que acaba, que esvazia a aba.
/// </summary>
public class HistoricoUsoCentralTelasTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly Guid Maria = Guid.Parse("019a0003-0000-7000-8000-000000000001");
    private static readonly Guid Carlos = Guid.Parse("019a0003-0000-7000-8000-000000000002");

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    private sealed class Tempo : TimeProvider
    {
        private long _ticks = 1;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => _ticks;

        public void Avancar(TimeSpan tempo) => _ticks += tempo.Ticks;
    }

    [AvaloniaFact]
    public async Task Dono_ve_quem_fez_o_que_e_o_resumo_da_semana_por_operador_offline()
    {
        var tempo = new Tempo();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s =>
        {
            AutenticadorComExtras.Registrar(s);
            s.AddSingleton<TimeProvider>(tempo);
        });
        var venda = await pdv.AtivarDemonstracaoELogarAsync(fundo: "100");

        // A MARIA vende o gelo (12,90) com 10% de desconto no item (1,29) e paga com 20,00.
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "item na venda");
        Assert.True((await pdv.Servicos.GetRequiredService<ServicoVenda>().DescontoItemAsync(1, Desconto.EmPercentual(10m), ct: Ct)).Aplicado);
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");

        // A MARIA cancela uma venda em andamento pelo caminho normal (o Shift+F4, com o CARLOS liberando): grava o mesmo
        // `venda_cancelada` do cancelamento da venda paga.
        var servicoVenda = pdv.Servicos.GetRequiredService<ServicoVenda>();
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "item na venda a cancelar");
        var carlos = new LiberacaoConcedida(AutenticadorOperadorSimulado.Operadores.Single(o => o.Login == "carlos"), "Cliente desistiu", DateTimeOffset.UtcNow);
        await servicoVenda.CancelarVendaAsync("Cliente desistiu da compra", carlos, Ct);
        Assert.False(servicoVenda.VendaAberta);
        Guid paga;
        await using (var db = Banco(pdv))
        {
            Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "venda_cancelada", Ct));
            paga = (await db.Vendas.SingleAsync(v => v.FinalizadaEm != null, Ct)).Id;
        }

        // O que o caixa grava em outros pontos (a venda paga cancelada no F12, a gaveta sem venda com um CPF no motivo, o
        // login negado com o PIN digitado no campo do usuário, o PIX à mão com o nome do pagador, a sangria recusada com o
        // estimado da gaveta), como o código grava.
        var terminal = pdv.Servicos.GetRequiredService<RepositorioTerminal>();
        await terminal.RegistrarAuditoriaAsync("venda_cancelada", Maria, "venda", paga, "Venda L01-C01-000001 finalizada cancelada (R$ 11,61): Cliente devolveu",
            "PDV › Gestão de vendas", null, Ct, "Cliente devolveu", """{"total":"11.61","sai_da_gaveta":"11.61"}""");
        await terminal.RegistrarAuditoriaAsync("pix_confirmado_manual", Maria, "pagamentos_venda", null,
            "PIX de R$ 25,00 confirmado manualmente: JOANA DA SILVA às 14:32", "PDV › Pagamento", null, Ct,
            depois: """{"pagador_nome":"JOANA DA SILVA","valor":"25.00"}""");
        await terminal.RegistrarAuditoriaAsync("gaveta_aberta", Maria, "gaveta", null, "Gaveta aberta sem venda (F11 › 9)", "PDV › Funções", null, Ct,
            "troco para o vizinho 123.456.789-09");
        await terminal.RegistrarAuditoriaAsync("login_negado", null, descricao: "Login negado para '9876'", localizacao: "pdv.login",
            motivo: "senha_invalida", depois: """{"login_informado":"9876"}""", ct: Ct);
        await terminal.RegistrarAuditoriaAsync(ServicoCaixa.AcaoSangriaRecusada, Maria, "sessoes_caixa", null,
            "Sangria de R$ 500,00 recusada: acima do dinheiro estimado na gaveta", "pdv.caixa", ct: Ct,
            depois: """{"valor_tentado":"500.00","dinheiro_estimado":"112.90"}""");
        int antes;
        await using (var db = Banco(pdv))
        {
            antes = await db.LogAuditoriaLocal.CountAsync(Ct);
        }

        // A MARIA não vê o histórico de uso: o 6 com o cadeado pede quem pode; o CARLOS (o dono) libera e a aba abre no texto.
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();
        Assert.True(central.Abas.Single(a => a.Codigo == "6").Bloqueada);
        pdv.Tecla(Key.D6);
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "2";
        central.PinLiberacao = "4321";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => central.Conteudo is AbaHistoricoUsoViewModel, "aba 6 Histórico de uso");
        var aba = (AbaHistoricoUsoViewModel)central.Conteudo!;
        await aba.Atualizacao;
        await pdv.EsperarFocoAsync("CampoFiltroHistoricoUso");
        Assert.Equal((int)PeriodoHistoricoUso.Ultimos7Dias, aba.PeriodoIndice);

        // As frases, a mais nova primeiro, com a marca de envio (o acesso à aba e a liberação já estão lá).
        LinhaHistoricoUsoViewModel Linha(string acao) => aba.Linhas.Single(l => l.Registro.Acao == acao);
        Assert.Equal("MARIA abriu a Central do PDV · liberado por CARLOS", aba.Linhas[0].Frase);
        Assert.Equal(("MARIA deu desconto num item", "Vendas", "só local"), (Linha("desconto_item").Frase, Linha("desconto_item").Grupo, Linha("desconto_item").Envio));
        Assert.Equal(("MARIA entrou no caixa", "a enviar", true), (Linha("login").Frase, Linha("login").Envio, Linha("login").AEnviar));
        Assert.All(aba.Linhas.Where(l => l.Registro.Acao == "liberacao"), l => Assert.Equal("MARIA pediu uma liberação · liberado por CARLOS", l.Frase));
        Assert.Contains("Desconto de R$ 1,29", Linha("desconto_item").Detalhe, StringComparison.Ordinal);
        // A paga e a em andamento, cada uma com a sua frase (as duas gravam `venda_cancelada`).
        Assert.Equal(["MARIA cancelou uma venda em andamento · liberado por CARLOS", "MARIA cancelou uma venda paga"],
            aba.Linhas.Where(l => l.Registro.Acao == "venda_cancelada").Select(l => l.Frase).Order(StringComparer.Ordinal));
        // O PIN digitado no campo do usuário e o nome do pagador do PIX não aparecem na lista.
        Assert.Equal(("Login negado", "Login negado"), (Linha("login_negado").Frase, Linha("login_negado").Detalhe));
        Assert.Equal("PIX de R$ 25,00 confirmado manualmente às 14:32", Linha("pix_confirmado_manual").Detalhe);
        Assert.DoesNotContain(aba.Linhas, l => l.Leitura.Contains("9876", StringComparison.Ordinal) || l.Leitura.Contains("JOANA", StringComparison.Ordinal));
        pdv.Captura("82-central-historico-uso");

        // O lote do login foi confirmado pela nuvem: F5 e a marca vira "✓ enviado".
        await using (var db = Banco(pdv))
        {
            var lote = new EventoSaida
            {
                Id = Guid.CreateVersion7(),
                SequenciaTerminal = 999,
                Tipo = "auditoria.registros",
                AgregadoTipo = "auditoria",
                AgregadoId = Guid.CreateVersion7(),
                OcorridoEm = DateTimeOffset.UtcNow,
                CriadoEm = DateTimeOffset.UtcNow,
                Status = StatusEventoSaida.Confirmado,
                PayloadSha256 = new string('0', 64),
            };
            db.EventosSaida.Add(lote);
            (await db.LogAuditoriaLocal.SingleAsync(l => l.Acao == "login", Ct)).EventoId = lote.Id;
            await db.SaveChangesAsync(Ct);
        }

        pdv.Tecla(Key.F5);
        await aba.Atualizacao;
        Assert.Equal(("✓ enviado", true), (Linha("login").Envio, Linha("login").Enviado));

        // A busca: sem acento nem maiúscula, também pela frase ("gaveta"); o CPF escondido pela máscara não acha nada.
        pdv.Digitar("VIZINHO");
        await aba.Atualizacao;
        Assert.Equal("gaveta_aberta", Assert.Single(aba.Linhas).Registro.Acao);
        aba.Texto = "123.456.789-09";
        await aba.Atualizacao;
        Assert.Empty(aba.Linhas);
        Assert.Equal("Nenhum registro com esses filtros.", aba.Rodape);
        // O PIN e o pagador escondidos também não acham; o texto exibido acha (mesmo o que não está igual no gravado).
        foreach (var escondido in new[] { "9876", "JOANA" })
        {
            aba.Texto = escondido;
            await aba.Atualizacao;
            Assert.Empty(aba.Linhas);
        }

        aba.Texto = "manualmente às";
        await aba.Atualizacao;
        Assert.Equal("pix_confirmado_manual", Assert.Single(aba.Linhas).Registro.Acao);
        aba.Texto = "venda paga";
        await aba.Atualizacao;
        Assert.Equal("MARIA cancelou uma venda paga", Assert.Single(aba.Linhas).Frase);
        // Os nomes da frase não são procurados (a pessoa é o F7): "MARIA" acha o que gravou o nome dela, não o PIX dela.
        aba.Texto = "MARIA";
        await aba.Atualizacao;
        Assert.All(aba.Linhas, l => Assert.Contains("MARIA", l.Detalhe, StringComparison.Ordinal));
        Assert.DoesNotContain(aba.Linhas, l => l.Registro.Acao == "pix_confirmado_manual");
        aba.Texto = "sangria";
        await aba.Atualizacao;
        var sangria = Assert.Single(aba.Linhas);

        // O detalhe da sangria recusada: o valor tentado sim, o estimado da gaveta (O3) não.
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe da sangria");
        await pdv.EsperarFocoAsync("PainelDetalheHistoricoUso");
        Assert.Equal("Sangria recusada · " + sangria.Hora, aba.TituloDetalhe);
        Assert.Contains("  valor_tentado: 500.00", aba.LinhasDetalhe);
        Assert.Contains("  (+1 campo não mostrado aqui)", aba.LinhasDetalhe);
        Assert.DoesNotContain(aba.LinhasDetalhe, l => l.Contains("112.90", StringComparison.Ordinal) || l.Contains("estimado\":", StringComparison.Ordinal));
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => !aba.MostrandoDetalhe, "volta à lista");
        await pdv.EsperarFocoAsync("CampoFiltroHistoricoUso");

        // F8 limpa; F4 vai aos grupos (Acessos, Vendas) e Shift+F4 volta.
        pdv.Tecla(Key.F8);
        await aba.Atualizacao;
        Assert.Equal(string.Empty, aba.Texto);
        pdv.Tecla(Key.F4);
        await aba.Atualizacao;
        Assert.All(aba.Linhas, l => Assert.Equal("Acessos", l.Grupo));
        Assert.Contains(aba.Linhas, l => l.Registro.Acao == "login_negado");
        pdv.Tecla(Key.F4);
        await aba.Atualizacao;
        Assert.Equal(["desconto_item", "pix_confirmado_manual", "venda_cancelada", "venda_cancelada"],
            aba.Linhas.Select(l => l.Registro.Acao).Order(StringComparer.Ordinal));
        pdv.Tecla(Key.F4, RawInputModifiers.Shift);
        await aba.Atualizacao;
        Assert.Equal(1, aba.GrupoIndice);

        // O login negado no detalhe (pelo duplo clique): o login digitado (podia ser um PIN) não aparece.
        aba.Selecionada = Linha("login_negado");
        await aba.DetalharCommand.ExecuteAsync(null);
        Assert.True(aba.MostrandoDetalhe);
        Assert.Contains("Motivo: senha_invalida", aba.LinhasDetalhe);
        Assert.Contains("  (+1 campo não mostrado aqui)", aba.LinhasDetalhe);
        Assert.DoesNotContain(aba.LinhasDetalhe, l => l.Contains("9876", StringComparison.Ordinal));
        pdv.Clicar(pdv.Controle<Button>("BotaoVoltarDetalheHistoricoUso"));
        await pdv.EsperarAsync(() => !aba.MostrandoDetalhe, "volta à lista pelo mouse");
        pdv.Tecla(Key.F8);
        await aba.Atualizacao;

        // F7: quem fez ou liberou (todos, CARLOS, MARIA; o login negado não tem pessoa). O CARLOS não fez nada: as linhas
        // dele são as que a MARIA fez com o PIN dele, e cada uma diz isso com o selo "LIBEROU" (decisão 78).
        Assert.Equal(["Todos", "CARLOS", "MARIA"], aba.Quem);
        pdv.Tecla(Key.F7);
        await aba.Atualizacao;
        Assert.Equal("CARLOS", aba.Quem[aba.QuemIndice]);
        Assert.Contains(aba.Linhas, l => l.Frase == "MARIA cancelou uma venda em andamento · liberado por CARLOS");
        Assert.Contains(aba.Linhas, l => l.Frase == "MARIA abriu a Central do PDV · liberado por CARLOS");
        Assert.All(aba.Linhas, l =>
        {
            Assert.True(l.PorLiberacao, l.Frase);
            Assert.Equal(LinhaHistoricoUsoViewModel.MarcaLiberacao, l.Marca);
            Assert.EndsWith(" · liberado por CARLOS", l.Frase, StringComparison.Ordinal);
            Assert.Contains("CARLOS liberou com o PIN: MARIA ", l.Leitura, StringComparison.Ordinal);
        });
        Assert.Contains("\"LIBEROU\": a ação foi de outra pessoa e CARLOS liberou com o PIN", aba.Rodape, StringComparison.Ordinal);
        // O selo aparece na tela (a palavra, não só a cor).
        List<TextBlock> Selos() => [.. pdv.Controle<ListBox>("ListaHistoricoUso").GetVisualDescendants().OfType<TextBlock>()
            .Where(t => t.Classes.Contains("liberou") && t.IsEffectivelyVisible)];
        await pdv.EsperarAsync(() => Selos().Count > 0, "selo LIBEROU na lista");
        Assert.All(Selos(), t => Assert.Equal("LIBEROU", t.Text));
        aba.Selecionada = Linha("venda_cancelada");
        await aba.DetalharCommand.ExecuteAsync(null);
        Assert.Contains("Na lista porque CARLOS liberou com o PIN (a ação foi de MARIA).", aba.LinhasDetalhe);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => !aba.MostrandoDetalhe, "volta à lista do CARLOS");
        // A MARIA: o que ela fez (com ou sem liberação de outro), nenhuma linha com o selo.
        pdv.Tecla(Key.F7);
        await aba.Atualizacao;
        Assert.Equal("MARIA", aba.Quem[aba.QuemIndice]);
        Assert.All(aba.Linhas, l => Assert.StartsWith("MARIA ", l.Frase, StringComparison.Ordinal));
        Assert.DoesNotContain(aba.Linhas, l => l.PorLiberacao);
        Assert.DoesNotContain("LIBEROU", aba.Rodape, StringComparison.Ordinal);
        Assert.DoesNotContain(aba.Linhas, l => l.Registro.Acao == "login_negado");
        // O motivo do detalhe mascarado (o CPF que a operadora digitou no motivo da gaveta).
        aba.Selecionada = Linha("gaveta_aberta");
        pdv.Tecla(Key.Multiply);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe da gaveta pelo *");
        var motivo = Assert.Single(aba.LinhasDetalhe, l => l.StartsWith("Motivo: ", StringComparison.Ordinal));
        Assert.Contains("troco para o vizinho", motivo, StringComparison.Ordinal);
        Assert.DoesNotContain("123.456.789-09", motivo, StringComparison.Ordinal);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => !aba.MostrandoDetalhe, "volta à lista");
        pdv.Tecla(Key.F8);
        await aba.Atualizacao;

        // F6: o resumo da semana por operador (o pronto quando do plano).
        pdv.Tecla(Key.F6);
        await pdv.EsperarAsync(() => aba.MostrandoResumo, "resumo por operador");
        await aba.Atualizacao;
        await pdv.EsperarFocoAsync("ListaResumoUso");
        Assert.Equal(["CARLOS", "MARIA"], aba.Resumo.Select(r => r.Nome));
        var maria = aba.Resumo.Single(r => r.Nome == "MARIA").Resumo;
        // A venda em andamento cancelada não é paga nem "venda paga cancelada"; as liberações: a do cancelamento e a da Central.
        Assert.Equal((1, 1, 0, 1, 1, 1, 1, 1.29m, 1, 2, 0), (maria.Logins, maria.Vendas, maria.ItensCancelados, maria.VendasCanceladas,
            maria.CanceladasEmAndamento, maria.Descontos, maria.VendasComDesconto, maria.ValorDescontos, maria.GavetasSemVenda, maria.LiberacoesPedidas,
            maria.LiberacoesDadas));
        Assert.NotNull(maria.Primeira);
        Assert.Contains("1 venda paga cancelada · 1 em andamento cancelada", aba.Resumo.Single(r => r.Nome == "MARIA").Cancelamentos, StringComparison.Ordinal);
        Assert.Equal((2, 0), (aba.Resumo.Single(r => r.Nome == "CARLOS").Resumo.LiberacoesDadas, aba.Resumo.Single(r => r.Nome == "CARLOS").Resumo.LiberacoesPedidas));
        Assert.Equal("Resumo por operador · Últimos 7 dias", aba.TituloResumo);
        Assert.Contains("1 venda paga com desconto: R$ 1,29", aba.Resumo.Single(r => r.Nome == "MARIA").Descontos, StringComparison.Ordinal);
        pdv.Captura("83-central-historico-uso-resumo");
        // F3 muda o período do resumo (30 dias, o maior: não há "tudo"; depois volta a hoje): hoje a MARIA continua igual.
        Assert.Equal(["Hoje", "Ontem", "Últimos 7 dias", "Últimos 30 dias"], AbaHistoricoUsoViewModel.Periodos);
        pdv.Tecla(Key.F3);
        await aba.Atualizacao;
        Assert.Equal((int)PeriodoHistoricoUso.Ultimos30Dias, aba.PeriodoIndice);
        Assert.Equal(1, aba.Resumo.Single(r => r.Nome == "MARIA").Resumo.Vendas);
        pdv.Tecla(Key.F3);
        await aba.Atualizacao;
        Assert.Equal((int)PeriodoHistoricoUso.Hoje, aba.PeriodoIndice);
        pdv.Tecla(Key.F3, RawInputModifiers.Shift);
        await aba.Atualizacao;
        pdv.Tecla(Key.F3, RawInputModifiers.Shift);
        await aba.Atualizacao;
        Assert.Equal((int)PeriodoHistoricoUso.Ultimos7Dias, aba.PeriodoIndice);

        // Pelo mouse em 1024 × 700: as ações do resumo e da lista, todas com 44 px.
        pdv.Janela.Width = 1024;
        pdv.Janela.Height = 700;
        foreach (var nome in new[] { "BotaoVerPessoaResumoUso", "BotaoPeriodoResumoUso", "BotaoVoltarListaResumoUso" })
        {
            Assert.True(pdv.Controle<Button>(nome).Bounds.Height >= 44, nome);
        }

        // Enter no CARLOS, que só liberou: a lista com o que ele liberou, cada linha com o selo (decisão 78).
        aba.ResumoSelecionado = aba.Resumo.Single(r => r.Nome == "CARLOS");
        pdv.Clicar(pdv.Controle<Button>("BotaoVerPessoaResumoUso"));
        await pdv.EsperarAsync(() => !aba.MostrandoResumo, "lista do CARLOS");
        await aba.Atualizacao;
        Assert.Equal("CARLOS", aba.Quem[aba.QuemIndice]);
        Assert.Null(aba.Mensagem);
        Assert.NotEmpty(aba.Linhas);
        Assert.All(aba.Linhas, l => Assert.True(l.PorLiberacao, l.Frase));
        pdv.Tecla(Key.F6);
        await pdv.EsperarAsync(() => aba.MostrandoResumo, "resumo de novo");
        await aba.Atualizacao;

        // Enter na MARIA: a lista só com ela.
        aba.ResumoSelecionado = aba.Resumo.Single(r => r.Nome == "MARIA");
        pdv.Clicar(pdv.Controle<Button>("BotaoVerPessoaResumoUso"));
        await pdv.EsperarAsync(() => !aba.MostrandoResumo, "lista da MARIA");
        await aba.Atualizacao;
        Assert.Equal("MARIA", aba.Quem[aba.QuemIndice]);
        Assert.All(aba.Linhas, l => Assert.StartsWith("MARIA ", l.Frase, StringComparison.Ordinal));
        foreach (var nome in new[]
                 {
                     "BotaoDetalheHistoricoUso", "BotaoProximaPaginaHistoricoUso", "BotaoPeriodoHistoricoUso", "BotaoGrupoHistoricoUso",
                     "BotaoQuemHistoricoUso", "BotaoResumoHistoricoUso", "BotaoLimparFiltrosHistoricoUso",
                 })
        {
            Assert.True(pdv.Controle<Button>(nome).Bounds.Height >= 44, nome);
        }

        pdv.Clicar(pdv.Controle<Button>("BotaoLimparFiltrosHistoricoUso"));
        await aba.Atualizacao;
        Assert.Equal(0, aba.QuemIndice);
        pdv.Clicar(pdv.Controle<Button>("BotaoGrupoHistoricoUso"));
        await aba.Atualizacao;
        Assert.Equal(1, aba.GrupoIndice);

        // Esc volta ao menu (com um texto buscado e a MARIA no filtro "Quem"); olhar não gravou nada além da liberação e do
        // acesso à aba.
        aba.Texto = "gaveta";
        await aba.Atualizacao;
        Assert.Contains("MARIA", aba.Quem);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "6", "menu na aba 6");
        await using (var db = Banco(pdv))
        {
            var novos = await db.LogAuditoriaLocal.AsNoTracking().OrderBy(l => l.OcorridoEm).Skip(antes).Select(l => l.Acao).ToListAsync(Ct);
            Assert.Equal(["liberacao", AcessoCentral.AcaoCentralAcessada], novos);
        }

        // A liberação acaba (5 min sem uso): a Central volta ao Painel, a aba guardada fica vazia e o serviço recusa.
        tempo.Avancar(AcessoCentral.ValidadeLiberacao + TimeSpan.FromSeconds(1));
        central.Atualizar();
        Assert.IsType<AbaPainelViewModel>(central.Conteudo);
        Assert.Empty(aba.Linhas);
        Assert.Empty(aba.Resumo);
        // Nem os nomes de quem usou o caixa (o F7) nem o texto buscado ficam.
        Assert.Equal(["Todos"], aba.Quem);
        Assert.Equal((0, string.Empty), (aba.QuemIndice, aba.Texto));
        await Assert.ThrowsAsync<Core.Comum.RegraNegocioException>(() =>
            pdv.Servicos.GetRequiredService<ServicoHistoricoUso>().RegistrosAsync(new FiltroAuditoria(), ct: Ct));
        await Assert.ThrowsAsync<Core.Comum.RegraNegocioException>(() =>
            pdv.Servicos.GetRequiredService<ServicoHistoricoUso>().ResumoAsync(PeriodoHistoricoUso.Hoje, Ct));
    }

    [AvaloniaFact]
    public async Task Busca_que_a_mascara_esvaziaria_enche_a_pagina_pelo_cursor_sem_repetir()
    {
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: AutenticadorComExtras.Registrar);
        await pdv.AtivarDemonstracaoELogarAsync();
        // As 70 mais novas têm o termo só no CPF (a máscara esconde); as 55 mais antigas, à vista.
        var agora = DateTimeOffset.UtcNow;
        await using (var db = Banco(pdv))
        {
            db.LogAuditoriaLocal.AddRange(Enumerable.Range(0, 55).Select(i => new LogAuditoriaLocal
            {
                Id = Guid.CreateVersion7(),
                OcorridoEm = agora.AddHours(-2).AddMinutes(-i),
                UsuarioId = Maria,
                Acao = "reimpressao",
                Descricao = $"Reimpressão {i:00} do cupom 999.888",
            }));
            db.LogAuditoriaLocal.AddRange(Enumerable.Range(0, 70).Select(i => new LogAuditoriaLocal
            {
                Id = Guid.CreateVersion7(),
                OcorridoEm = agora.AddMinutes(-i),
                UsuarioId = Maria,
                Acao = "reimpressao",
                Descricao = $"Reimpressão {i:00} para 111.999.888-00",
            }));
            // O CARLOS (supervisor) libera o próprio caixa com o disco quase cheio: quem pediu e quem autorizou são ele.
            db.LogAuditoriaLocal.Add(new LogAuditoriaLocal
            {
                Id = Guid.CreateVersion7(),
                OcorridoEm = agora.AddHours(-3),
                UsuarioId = Carlos,
                AutorizadoPorId = Carlos,
                Acao = "liberacao",
                Descricao = "Abertura do caixa com o disco quase cheio liberada por 1 h por CARLOS",
            });
            // Mais antiga que 30 dias: o banco guarda, a tela não mostra (como as vendas e os caixas: só no ERP).
            db.LogAuditoriaLocal.Add(new LogAuditoriaLocal
            {
                Id = Guid.CreateVersion7(),
                OcorridoEm = agora.AddDays(-40),
                UsuarioId = Maria,
                Acao = "reimpressao",
                Descricao = "Reimpressão de quarenta dias atrás",
            });
            await db.SaveChangesAsync(Ct);
        }

        // O dono entra pela Central do login (a permissão é dele: abre direto, sem o cadeado).
        pdv.Shell.IrParaLogin();
        await pdv.EsperarFocoAsync("CampoUsuario");
        var central = await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        Assert.False(central.Abas.Single(a => a.Codigo == "6").Bloqueada);
        pdv.Tecla(Key.D6);
        await pdv.EsperarAsync(() => central.Conteudo is AbaHistoricoUsoViewModel, "aba 6 Histórico de uso");
        var aba = (AbaHistoricoUsoViewModel)central.Conteudo!;
        await aba.Atualizacao;
        Assert.Equal("CARLOS abriu a Central do PDV", aba.Linhas[0].Frase);
        // Nem pelo serviço, com o filtro sem período: o mais antigo que 30 dias não volta.
        var servico = pdv.Servicos.GetRequiredService<ServicoHistoricoUso>();
        Assert.Empty((await servico.RegistrosAsync(new FiltroAuditoria(Texto: "quarenta"), ct: Ct)).Registros);
        Assert.Empty((await servico.RegistrosAsync(new FiltroAuditoria(agora.AddDays(-60), Texto: "quarenta"), ct: Ct)).Registros);
        // A liberação dada a si mesmo: nem "pediu" na frase nem "liberação pedida" no resumo.
        var propria = (await servico.RegistrosAsync(new FiltroAuditoria(Acoes: ["liberacao"]), ct: Ct)).Registros.Single();
        Assert.Equal(("CARLOS liberou com a própria permissão de supervisor", null), (propria.Frase, propria.LiberadoPor));
        var carlos = (await servico.ResumoAsync(PeriodoHistoricoUso.Ultimos7Dias, Ct)).Single(r => r.Nome == "CARLOS");
        Assert.Equal((0, 0), (carlos.LiberacoesPedidas, carlos.LiberacoesDadas));
        aba.PeriodoIndice = (int)PeriodoHistoricoUso.Ultimos30Dias;
        await aba.Atualizacao;
        aba.Texto = "quarenta";
        await aba.Atualizacao;
        Assert.Empty(aba.Linhas);
        aba.Texto = string.Empty;
        await aba.Atualizacao;
        aba.PeriodoIndice = (int)PeriodoHistoricoUso.Ultimos7Dias;
        await aba.Atualizacao;

        aba.Texto = "999.888";
        await aba.Atualizacao;
        Assert.Equal(50, aba.Linhas.Count);
        Assert.All(aba.Linhas, l => Assert.Contains("cupom 999.888", l.Detalhe, StringComparison.Ordinal));
        Assert.Equal("Registros 1 a 50 · página 1 · PgDn mais antigos", aba.Rodape);
        pdv.Tecla(Key.PageDown);
        await aba.Atualizacao;
        Assert.Equal(5, aba.Linhas.Count);
        Assert.Equal("Registros 51 a 55 · página 2", aba.Rodape);
        Assert.False(aba.TemProxima);
        pdv.Tecla(Key.PageUp);
        await aba.Atualizacao;
        Assert.Equal("Registros 1 a 50 · página 1 · PgDn mais antigos", aba.Rodape);
        // Sem texto, as 125 mais o acesso, em 3 páginas, sem repetir.
        aba.Texto = string.Empty;
        await aba.Atualizacao;
        var vistos = aba.Linhas.Select(l => l.Registro.Id).ToList();
        while (aba.TemProxima)
        {
            pdv.Tecla(Key.Add);
            await aba.Atualizacao;
            vistos.AddRange(aba.Linhas.Select(l => l.Registro.Id));
        }

        Assert.Equal(3, aba.Pagina);
        Assert.Equal(vistos.Count, vistos.Distinct().Count());
        Assert.True(vistos.Count >= 126);
        Assert.Equal(string.Empty, aba.Texto);
    }
}
