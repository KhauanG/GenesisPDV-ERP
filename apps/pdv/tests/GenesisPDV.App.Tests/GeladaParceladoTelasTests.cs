using System.Text.Json.Nodes;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Atalhos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Preço gelada (<c>Alt+G</c>, PDV 11.4) e preço parcelado (11.2; D74) no caixa, só pelo teclado (Fase 3, F3-B18): o gelado
/// soma o acréscimo da loja ao unitário do item selecionado e sobe dentro do <c>preco_unitario</c> e do <c>preco_tabela</c>
/// (sem coluna nova); o crédito em mais de uma parcela pede as parcelas antes da maquininha, confirma o total novo e sobe com
/// <c>vendas.tipo_preco = 'parcelado'</c>; o "não aprovado" volta os preços.
/// </summary>
public class GeladaParceladoTelasTests
{
    private static readonly Guid Lata = Guid.Parse("019a0001-0000-7000-8000-000000000420");
    private static readonly Guid Agua = Guid.Parse("019a0001-0000-7000-8000-000000000421");
    private static readonly Guid Credito = Guid.Parse("019a0004-0000-7000-8000-000000000120");
    private static readonly Guid Un = Guid.Parse("019a0006-0000-7000-8000-000000000001");
    private static readonly Guid CreditoSenha = Guid.Parse("019a0004-0000-7000-8000-000000000121");
    private static readonly Guid Debito = Guid.Parse("019a0004-0000-7000-8000-000000000122");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    /// <summary>
    /// "CERV TESTE LT 350ML" 3,49 com a gelada de R$ 1,00 na loja e o parcelado a 3,69, "ÁGUA TESTE 500ML" 2,50 sem nenhum
    /// dos dois, e o crédito na maquininha em até 6×.
    /// </summary>
    private static Task CadastrarAsync(AmbienteUi pdv)
    {
        var agora = DateTimeOffset.UtcNow;
        LinhaEspelho[] linhas =
        [
            new ProdutoRegistro
            {
                Id = Lata, Codigo = 420, CodigoInterno = "0420", Nome = "CERV TESTE LT 350ML", UnidadeId = Un, PrecoVenda = 3.49m,
                PrecoParcelado = 3.69m,
            },
            new ProdutoLojaRegistro { Id = Guid.CreateVersion7(), ProdutoId = Lata, LojaId = CatalogoDemonstracao.LojaDemonstracao, AcrescimoGelada = 1.00m },
            new ProdutoRegistro { Id = Agua, Codigo = 421, CodigoInterno = "0421", Nome = "ÁGUA TESTE 500ML", UnidadeId = Un, PrecoVenda = 2.50m },
            new FormaPagamentoRegistro
            {
                Id = Credito, Descricao = "Cartão de crédito", Ordem = 2, TipoForma = "cartao_credito", MeioPagamentoFiscal = "03",
                Integracao = "pos_externo", PermiteParcelar = true, ParcelasMaximo = 6,
            },
            new FormaPagamentoLojaRegistro { Id = Guid.CreateVersion7(), FormaPagamentoId = Credito },
        ];
        foreach (var linha in linhas)
        {
            linha.CriadoEm = linha.AtualizadoEm = agora;
            linha.Versao = 1;
        }

        return pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(linhas, Ct);
    }

    /// <summary>O crédito que pede a senha de liberação (3ª forma, em até 6×) e o débito na maquininha (4ª).</summary>
    private static Task CadastrarFormasAsync(AmbienteUi pdv)
    {
        var agora = DateTimeOffset.UtcNow;
        LinhaEspelho[] linhas =
        [
            new FormaPagamentoRegistro
            {
                Id = CreditoSenha, Descricao = "Crédito com senha", Ordem = 3, TipoForma = "cartao_credito", MeioPagamentoFiscal = "03",
                Integracao = "pos_externo", PermiteParcelar = true, ParcelasMaximo = 6, ExigeSupervisor = true,
            },
            new FormaPagamentoLojaRegistro { Id = Guid.CreateVersion7(), FormaPagamentoId = CreditoSenha },
            new FormaPagamentoRegistro
            {
                Id = Debito, Descricao = "Cartão de débito", Ordem = 4, TipoForma = "cartao_debito", MeioPagamentoFiscal = "04",
                Integracao = "pos_externo",
            },
            new FormaPagamentoLojaRegistro { Id = Guid.CreateVersion7(), FormaPagamentoId = Debito },
        ];
        foreach (var linha in linhas)
        {
            linha.CriadoEm = linha.AtualizadoEm = agora;
            linha.Versao = 1;
        }

        return pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(linhas, Ct);
    }

    /// <summary>Da tela de pagamento à maquininha no crédito em <paramref name="parcelas"/>×, com o parcelado confirmado.</summary>
    private static async Task<DialogoPosViewModel> ConfirmarParceladoAsync(AmbienteUi pdv, VendaViewModel venda, int parcelas = 3)
    {
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoParcelasCredito");
        var dialogo = Assert.IsType<DialogoParcelasViewModel>(venda.Dialogo);
        dialogo.Parcelas = parcelas.ToString(System.Globalization.CultureInfo.InvariantCulture);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => dialogo.Confirmacao is not null, "confirmação");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoBandeira");
        return Assert.IsType<DialogoPosViewModel>(venda.Dialogo);
    }

    private static async Task<List<LogAuditoriaLocal>> AuditoriaAsync(AmbienteUi pdv, string acao)
    {
        await using var db = Banco(pdv);
        return await db.LogAuditoriaLocal.AsNoTracking().Where(l => l.Acao == acao).ToListAsync(Ct);
    }

    [AvaloniaFact]
    public async Task Alt_G_marca_o_gelado_no_item_e_a_venda_sobe_com_o_preco_de_dentro()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);
        Assert.True(venda.TemAcao(AcoesAtalho.Gelada));

        await pdv.EntrarCodigoAsync("2*0420");
        pdv.Tecla(Key.G, RawInputModifiers.Alt);
        await pdv.EsperarAsync(() => venda.Itens[0].Unitario == "4,49", "gelado");
        Assert.Equal("8,98", venda.Itens[0].Total);
        Assert.Contains("GELADO (+1,00)", venda.Itens[0].Detalhe, StringComparison.Ordinal);
        Assert.Contains("GELADO", venda.Mensagem, StringComparison.Ordinal);
        Assert.Equal("8,98", pdv.Texto("TextoTotal"));
        pdv.Captura("94-gelada");

        // O natural da mesma lata fica noutra linha; a água sem gelada recusa o Alt+G.
        await pdv.EntrarCodigoAsync("0420");
        Assert.Equal(2, venda.Itens.Count);
        Assert.Equal("3,49", venda.Itens[1].Unitario);
        await pdv.EntrarCodigoAsync("0421");
        pdv.Tecla(Key.G, RawInputModifiers.Alt);
        await pdv.EsperarAsync(() => venda.Mensagem?.Contains("não tem preço gelado", StringComparison.Ordinal) == true, "recusa");

        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.CaixaLivre && venda.Dialogo is null, "venda finalizada");
        Assert.Contains("GELADO (+1,00)", venda.UltimoCupom, StringComparison.Ordinal);

        await using var banco = Banco(pdv);
        var evento = await banco.EventosSaida.SingleAsync(e => e.Tipo == "venda.finalizada", Ct);
        var item = JsonNode.Parse(evento.Payload)!["itens_venda"]!.AsArray()[0]!;
        Assert.Equal(("4.4900", "4.4900", "8.98", "varejo"), (item["preco_unitario"]!.GetValue<string>(), item["preco_tabela"]!.GetValue<string>(),
            item["valor_bruto"]!.GetValue<string>(), item["origem_preco"]!.GetValue<string>()));
        // A marca não sobe: nenhuma coluna nova no payload.
        Assert.Null(item["gelado"]);
        Assert.Null(item["acrescimo_gelada"]);
        Assert.Equal(1, await banco.ItensVendaGelados.CountAsync(Ct));
    }

    [AvaloniaFact]
    public async Task Credito_em_3x_confirma_o_parcelado_antes_da_maquininha_e_o_nao_aprovado_volta()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        await pdv.EntrarCodigoAsync("2*0420");
        await pdv.EntrarCodigoAsync("0421");
        Assert.Equal("9,48", pdv.Texto("TextoTotal"));

        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        pdv.Tecla(Key.Down);
        Assert.Equal("Cartão de crédito", pagamento.Forma!.Descricao);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoParcelasCredito");
        var parcelas = Assert.IsType<DialogoParcelasViewModel>(venda.Dialogo);
        parcelas.Parcelas = "9";
        pdv.Tecla(Key.Enter);
        Assert.Equal("Parcelas: de 1 a 6.", parcelas.Erro);
        parcelas.Parcelas = "3";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => parcelas.Confirmacao is not null, "confirmação");
        Assert.Equal("Preço parcelado: total passa de R$ 9,48 para R$ 9,88 — [Enter] Confirmar / [Esc] Voltar", pdv.Texto("TextoConfirmacaoParcelado"));
        // A prévia não muda a venda.
        Assert.Equal((TipoPrecoVenda.Varejo, 9.48m), (servico.Atual!.TipoPreco, servico.Atual.Total));
        pdv.Captura("95-parcelado-confirmacao");

        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoBandeira");
        var pos = Assert.IsType<DialogoPosViewModel>(venda.Dialogo);
        Assert.Equal("Cartão de crédito · R$ 9,88 em 3× (preço parcelado)", pos.Titulo);
        Assert.False(pos.Parcela);
        Assert.Equal(TipoPrecoVenda.Parcelado, servico.Atual!.TipoPreco);
        Assert.Equal("PREÇO PARCELADO (remova o pagamento parcelado para voltar)", venda.TipoPrecoAtivoTexto);
        // O "PARC" a 3,69 não mostra o varejo de 3,49 riscado: não é economia.
        Assert.Equal(("PARC", "3,69"), (venda.Itens[0].Etiqueta, venda.Itens[0].Unitario));
        Assert.Null(venda.Itens[0].VarejoRiscado);

        // Não aprovado: os preços voltam ao varejo, com a auditoria das duas trocas.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoPagamentoViewModel, "volta ao pagamento");
        Assert.Equal((TipoPrecoVenda.Varejo, 9.48m), (servico.Atual!.TipoPreco, servico.Atual.Total));
        Assert.Equal("9,48", pagamento.ValorRecebido);
        Assert.Equal(2, (await AuditoriaAsync(pdv, "tipo_preco_alterado")).Count);

        // De novo, aprovado: a venda finaliza no parcelado.
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoParcelasCredito");
        ((DialogoParcelasViewModel)venda.Dialogo!).Parcelas = "3";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => ((DialogoParcelasViewModel)venda.Dialogo!).Confirmacao is not null, "confirmação");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoBandeira");
        ((DialogoPosViewModel)venda.Dialogo!).Bandeira = "1";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.CaixaLivre && venda.Dialogo is null, "venda finalizada");

        await using var banco = Banco(pdv);
        Assert.Equal("parcelado", (await banco.Vendas.AsNoTracking().SingleAsync(Ct)).TipoPreco);
        var evento = await banco.EventosSaida.SingleAsync(e => e.Tipo == "venda.finalizada", Ct);
        var payload = JsonNode.Parse(evento.Payload)!;
        Assert.Equal(("parcelado", "9.88"), (payload["vendas"]!["tipo_preco"]!.GetValue<string>(), payload["vendas"]!["total"]!.GetValue<string>()));
        var origens = payload["itens_venda"]!.AsArray()
            .Select(i => (i!["descricao"]!.GetValue<string>(), i["origem_preco"]!.GetValue<string>(), i["preco_unitario"]!.GetValue<string>()))
            .ToList();
        Assert.Equal([("CERV TESTE LT 350ML", "parcelado", "3.6900"), ("ÁGUA TESTE 500ML", "varejo", "2.5000")], origens);
        var p = Assert.Single(payload["pagamentos_venda"]!.AsArray())!;
        Assert.Equal((3, "9.88"), (p["parcelas"]!.GetValue<int>(), p["valor"]!.GetValue<string>()));
        Assert.Equal(3, (await AuditoriaAsync(pdv, "tipo_preco_alterado")).Count);
    }

    [AvaloniaFact]
    public async Task Sem_o_recurso_da_onda_as_parcelas_ficam_na_maquininha_e_o_Alt_G_bipa()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);
        await using (var db = Banco(pdv))
        {
            var identidade = await db.IdentidadeTerminal.SingleAsync(Ct);
            identidade.UrlApi = "https://api.exemplo/";
            await db.SaveChangesAsync(Ct);
        }

        await venda.RecarregarAtalhosAsync();
        Assert.False(venda.TemAcao(AcoesAtalho.Gelada));
        await pdv.EntrarCodigoAsync("2*0420");
        pdv.Tecla(Key.G, RawInputModifiers.Alt);
        await pdv.EsperarAsync(() => venda.Mensagem?.Contains(VendaViewModel.MensagemAcaoIndisponivel, StringComparison.Ordinal) == true, "bipe");
        Assert.Equal("3,49", venda.Itens[0].Unitario);

        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Tecla(Key.Down);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoBandeira");
        var pos = Assert.IsType<DialogoPosViewModel>(venda.Dialogo);
        Assert.True(pos.Parcela);
        pos.Bandeira = "1";
        pos.Parcelas = "3";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.CaixaLivre && venda.Dialogo is null, "venda finalizada");

        // Como antes da R3: as parcelas informativas, o preço de varejo e nenhuma auditoria nova.
        await using var banco = Banco(pdv);
        var v = await banco.Vendas.AsNoTracking().SingleAsync(Ct);
        Assert.Equal(("varejo", 6.98m), (v.TipoPreco, v.Total));
        Assert.Equal(3, (await banco.PagamentosVenda.AsNoTracking().SingleAsync(Ct)).Parcelas);
        Assert.Empty(await AuditoriaAsync(pdv, "tipo_preco_alterado"));
    }

    [AvaloniaFact]
    public async Task Liberacao_negada_no_credito_parcelado_volta_os_precos_e_o_F10_cobra_o_debito_a_vista()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);
        await CadastrarFormasAsync(pdv);
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        await pdv.EntrarCodigoAsync("2*0420");
        await pdv.EntrarCodigoAsync("0421");

        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        pagamento.EscolherFormaCommand.Execute("3");
        Assert.Equal("Crédito com senha", pagamento.Forma!.Descricao);
        var pos = await ConfirmarParceladoAsync(pdv, venda);
        Assert.Equal((TipoPrecoVenda.Parcelado, 9.88m), (servico.Atual!.TipoPreco, servico.Atual.Total));

        // A maquininha aprovou, mas a forma pede a senha e o supervisor não libera: a tela fecha e o parcelado sai junto.
        pos.Bandeira = "1";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoSupervisor");
        Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "liberação cancelada");
        Assert.Equal((TipoPrecoVenda.Varejo, 9.48m, StatusVenda.EmPagamento), (servico.Atual!.TipoPreco, servico.Atual.Total, servico.Atual.Status));
        Assert.Equal("9,48", pdv.Texto("TextoTotal"));
        Assert.Null(venda.TipoPrecoAtivoTexto);
        var auditoria = await AuditoriaAsync(pdv, "tipo_preco_alterado");
        Assert.Equal(2, auditoria.Count);
        Assert.Contains(auditoria, a => a.Descricao!.StartsWith("Preço parcelado desfeito", StringComparison.Ordinal));

        // O F10 reabre o pagamento com o "Falta" à vista: o débito sugere e a maquininha cobra 9,48, e o caixa aceita.
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        Assert.Equal("9,48", pagamento.FaltaTexto);
        pagamento.EscolherFormaCommand.Execute("4");
        Assert.Equal(("Cartão de débito", "9,48"), (pagamento.Forma!.Descricao, pagamento.ValorRecebido));
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoBandeira");
        var debito = Assert.IsType<DialogoPosViewModel>(venda.Dialogo);
        Assert.Equal("Cartão de débito · R$ 9,48", debito.Titulo);
        debito.Bandeira = "1";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.CaixaLivre && venda.Dialogo is null, "venda finalizada");

        await using var banco = Banco(pdv);
        var v = await banco.Vendas.AsNoTracking().SingleAsync(Ct);
        Assert.Equal(("varejo", 9.48m), (v.TipoPreco, v.Total));
        var p = await banco.PagamentosVenda.AsNoTracking().SingleAsync(Ct);
        Assert.Equal(("cartao_debito", 9.48m, (short)1), (p.TipoForma, p.Valor, p.Parcelas));
    }

    [AvaloniaFact]
    public async Task Pagamento_a_vista_e_o_F10_reaberto_desfazem_o_parcelado_sem_pagamento_com_a_auditoria()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        await pdv.EntrarCodigoAsync("2*0420");
        await servico.IniciarPagamentoAsync(Ct);
        Assert.True((await servico.AplicarPrecoParceladoAsync(3, ct: Ct)).Aplica);
        Assert.Equal(7.38m, servico.Atual!.Total);

        // O dinheiro à vista sai do parcelado dentro do Core: a saída tem a auditoria no mesmo commit (PDV 11.2).
        Assert.Null(await servico.LancarDinheiroAsync(5m, Ct));
        Assert.Equal((TipoPrecoVenda.Varejo, 6.98m, 1.98m), (servico.Atual!.TipoPreco, servico.Atual.Total, servico.Atual.Falta));
        var saida = (await AuditoriaAsync(pdv, "tipo_preco_alterado")).Single(a => a.Descricao!.Contains("(pagamento à vista)", StringComparison.Ordinal));
        Assert.Contains("R$ 7,38 para R$ 6,98", saida.Descricao, StringComparison.Ordinal);

        // O parcelado confirmado de novo (o dinheiro antes não impede) e a tela de pagamento fechada sem o cartão: o F10 volta
        // os preços antes de mostrar o "Falta".
        await servico.AplicarPrecoParceladoAsync(3, ct: Ct);
        Assert.Equal(2.38m, servico.Atual!.Falta);
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        Assert.Equal(("1,98", "1,98"), (pagamento.FaltaTexto, pagamento.ValorRecebido));
        Assert.Equal(TipoPrecoVenda.Varejo, servico.Atual!.TipoPreco);
        Assert.Equal(4, (await AuditoriaAsync(pdv, "tipo_preco_alterado")).Count);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.CaixaLivre && venda.Dialogo is null, "venda finalizada");
        await using var banco = Banco(pdv);
        Assert.Equal(("varejo", 6.98m), ((await banco.Vendas.AsNoTracking().SingleAsync(Ct)).TipoPreco, (await banco.Vendas.AsNoTracking().SingleAsync(Ct)).Total));
    }

    [AvaloniaFact]
    public async Task Del_no_cartao_parcelado_e_Esc_do_pagamento_voltam_os_precos_com_a_auditoria()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        await pdv.EntrarCodigoAsync("2*0420");
        await pdv.EntrarCodigoAsync("0421");

        // Parte da venda no crédito em 3×: R$ 5,00 informados viram R$ 5,40 na maquininha (com a diferença do parcelado).
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        pdv.Tecla(Key.Down);
        pagamento.ValorRecebido = "5,00";
        var pos = await ConfirmarParceladoAsync(pdv, venda);
        Assert.Equal("Cartão de crédito · R$ 5,40 em 3× (preço parcelado)", pos.Titulo);
        pos.Bandeira = "1";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoPagamentoViewModel && servico.Atual!.PagamentosAtivos.Any(), "cartão lançado");
        Assert.Equal("4,48", pagamento.FaltaTexto);

        // Del: o cartão parcelado sai e os preços voltam ao varejo, com a auditoria da saída.
        await pagamento.RemoverUltimoPagamentoCommand.ExecuteAsync(null);
        Assert.Equal((TipoPrecoVenda.Varejo, 9.48m), (servico.Atual!.TipoPreco, servico.Atual.Total));
        Assert.Equal("9,48", pagamento.FaltaTexto);
        var removido = (await AuditoriaAsync(pdv, "tipo_preco_alterado")).Single(a => a.Descricao!.Contains("(pagamento removido)", StringComparison.Ordinal));
        Assert.Contains("R$ 9,88 para R$ 9,48", removido.Descricao, StringComparison.Ordinal);

        // O Esc do pagamento com o parcelado sem o pagamento parcelado (o serviço o aplica sem a maquininha) também volta.
        await servico.AplicarPrecoParceladoAsync(3, ct: Ct);
        await servico.VoltarParaItensAsync(Ct);
        Assert.Equal((TipoPrecoVenda.Varejo, 9.48m, StatusVenda.EmAndamento), (servico.Atual!.TipoPreco, servico.Atual.Total, servico.Atual.Status));
        Assert.Equal(4, (await AuditoriaAsync(pdv, "tipo_preco_alterado")).Count);
    }

    [AvaloniaFact]
    public async Task Venda_recuperada_entre_a_confirmacao_e_a_maquininha_volta_ao_tipo_do_F8()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        await pdv.EntrarCodigoAsync("2*0420");
        await pdv.EntrarCodigoAsync("0421");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Tecla(Key.Down);
        await ConfirmarParceladoAsync(pdv, venda);
        await using (var db = Banco(pdv))
        {
            Assert.Equal("parcelado", (await db.Vendas.AsNoTracking().SingleAsync(Ct)).TipoPreco);
            Assert.Equal(TipoPrecoVenda.Varejo, (await db.EstadoOperacao.AsNoTracking().SingleAsync(Ct)).TipoPrecoAntesParcelado);
        }

        // A queda veio com a maquininha na tela: a venda relida do banco volta ao varejo, gravada antes de a tela abrir.
        Assert.True(await servico.RecuperarAsync(Ct));
        Assert.Equal((TipoPrecoVenda.Varejo, 9.48m), (servico.Atual!.TipoPreco, servico.Atual.Total));

        await using var banco = Banco(pdv);
        Assert.Equal("varejo", (await banco.Vendas.AsNoTracking().SingleAsync(Ct)).TipoPreco);
        Assert.Null((await banco.EstadoOperacao.AsNoTracking().SingleAsync(Ct)).TipoPrecoAntesParcelado);
        var linhas = await banco.ItensVenda.AsNoTracking().OrderBy(i => i.Sequencia).Select(i => new { i.PrecoUnitario, i.OrigemPreco }).ToListAsync(Ct);
        Assert.Equal([(3.49m, "varejo"), (2.50m, "varejo")], linhas.Select(l => (l.PrecoUnitario, l.OrigemPreco)));
        var auditoria = (await AuditoriaAsync(pdv, "tipo_preco_alterado")).Single(a => a.Descricao!.Contains("recuperada sem o pagamento parcelado", StringComparison.Ordinal));
        Assert.Contains("R$ 9,88 para R$ 9,48", auditoria.Descricao, StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task Recurso_que_some_no_meio_da_venda_com_o_gelado_ainda_deixa_tirar_o_gelado()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);
        await pdv.EntrarCodigoAsync("2*0420");
        pdv.Tecla(Key.G, RawInputModifiers.Alt);
        await pdv.EsperarAsync(() => venda.Itens[0].Unitario == "4,49", "gelado");

        // A API voltou de versão (o handshake deixa de anunciar a R3): desfazer o gelado fica fora do portão (D125, decisão 6).
        await using (var db = Banco(pdv))
        {
            var identidade = await db.IdentidadeTerminal.SingleAsync(Ct);
            identidade.UrlApi = "https://api.exemplo/";
            await db.SaveChangesAsync(Ct);
        }

        await venda.RecarregarAtalhosAsync();
        Assert.True(venda.TemAcao(AcoesAtalho.Gelada));
        Assert.Contains(venda.Atalhos, b => b.Tecla == "Alt+G");
        pdv.Tecla(Key.G, RawInputModifiers.Alt);
        await pdv.EsperarAsync(() => venda.Itens[0].Unitario == "3,49", "gelado desfeito");
        Assert.Equal("6,98", pdv.Texto("TextoTotal"));

        // Sem item gelado, o Alt+G sai da barra e bipa: o natural não vira gelado sem o recurso.
        Assert.False(venda.TemAcao(AcoesAtalho.Gelada));
        Assert.DoesNotContain(venda.Atalhos, b => b.Tecla == "Alt+G");
        pdv.Tecla(Key.G, RawInputModifiers.Alt);
        await pdv.EsperarAsync(() => venda.Mensagem?.Contains(VendaViewModel.MensagemAcaoIndisponivel, StringComparison.Ordinal) == true, "bipe");
        Assert.Equal("3,49", venda.Itens[0].Unitario);
    }
}
