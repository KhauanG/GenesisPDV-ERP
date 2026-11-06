using System.Text.Json.Nodes;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Hardware.Gaveta;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Venda real pelo teclado (Fase 1C, bloco C11a; PDV 14, 16, 19.2): as formas da loja do espelho (débito na maquininha e
/// PIX estático com o QR), o PIX confirmado com a liberação do supervisor (O9b), o cartão que não passa do total (O23),
/// a gaveta só com dinheiro, o CPF e o cliente pelo F5 (O8) e a venda recusada sem o caixa aberto (8.1).
/// </summary>
public class VendaRealTelasTests
{
    private static readonly Guid Debito = Guid.Parse("019a0004-0000-7000-8000-000000000102");
    private static readonly Guid Pix = Guid.Parse("019a0004-0000-7000-8000-000000000103");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    /// <summary>Débito na maquininha e PIX estático (com QR) para a loja de demonstração, e a loja com a chave PIX.</summary>
    private static Task FormasDaLojaAsync(AmbienteUi pdv)
    {
        var agora = DateTimeOffset.UtcNow;
        return pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [
                new FormaPagamentoRegistro
                {
                    Id = Debito, Descricao = "Cartão de débito", Ordem = 2, TipoForma = "cartao_debito", MeioPagamentoFiscal = "04",
                    Integracao = "pos_externo", TaxaPct = 1.99m, CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
                new FormaPagamentoRegistro
                {
                    Id = Pix, Descricao = "PIX", Ordem = 3, TipoForma = "pix", MeioPagamentoFiscal = "20", Integracao = "pix_estatico",
                    GeraQrcodePix = true, LancaQuitada = true, CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
                new FormaPagamentoLojaRegistro { Id = Guid.CreateVersion7(), FormaPagamentoId = Debito, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
                new FormaPagamentoLojaRegistro { Id = Guid.CreateVersion7(), FormaPagamentoId = Pix, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
                new LojaRegistro
                {
                    Id = CatalogoDemonstracao.LojaDemonstracao, Codigo = 1, Nome = "Loja 1", RazaoSocial = "ICE BEER COMÉRCIO DE BEBIDAS LTDA",
                    NomeFantasia = "Ice Beer", Cnpj = "12345678000195", ChavePix = "pix@icebeer.com.br", PixNomeRecebedor = "ICE BEER",
                    PixCidadeRecebedor = "CURITIBA", Ativa = true, UsaPdv = true, CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
            ],
            Ct);
    }

    private static async Task LiberarAsync(AmbienteUi pdv, VendaViewModel venda, string motivo)
    {
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var dialogo = Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
        dialogo.Pedido.Usuario = "2";
        dialogo.Pedido.Pin = "4321";
        dialogo.Pedido.Motivo = motivo;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is not DialogoLiberacaoViewModel, "liberação concedida");
    }

    [AvaloniaFact]
    public async Task Debito_na_maquininha_e_pix_estatico_com_supervisor_quitam_a_venda_sem_abrir_a_gaveta()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await FormasDaLojaAsync(pdv);
        // Com a gaveta ligada (decisão 63): o débito e o PIX não são formas "Abrir gaveta".
        await pdv.LigarGavetaAsync();
        var gaveta = pdv.Servicos.GetRequiredService<GavetaSimulada>();
        var aberturasAntes = gaveta.Aberturas;
        await pdv.EntrarCodigoAsync("0044");

        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        Assert.Equal(["Dinheiro", "Cartão de débito", "PIX"], pagamento.Formas.Select(f => f.Forma.Descricao));
        // ↓ escolhe o débito; o cartão não passa do total (O23).
        pdv.Tecla(Key.Down);
        Assert.Equal("Cartão de débito", pagamento.Forma!.Descricao);
        pagamento.ValorRecebido = "20,00";
        Assert.Contains("não permite troco", pagamento.Erro);
        pagamento.ValorRecebido = "5,00";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoBandeira");
        var pos = Assert.IsType<DialogoPosViewModel>(venda.Dialogo);
        pdv.Tecla(Key.Enter);
        Assert.Equal("Escolha a bandeira do cartão (o número da lista).", pos.Erro);
        pos.Bandeira = "6";
        pos.Nsu = "000123";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoPagamentoViewModel, "volta ao pagamento");
        Assert.Equal("7,90", pagamento.FaltaTexto);

        // PIX estático: o QR com a chave da loja; a confirmação manual pede o supervisor (O9b, chave ligada por padrão).
        pagamento.EscolherFormaCommand.Execute("3");
        Assert.Equal("7,90", pagamento.ValorRecebido);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoPagadorPix");
        var pix = Assert.IsType<DialogoPixViewModel>(venda.Dialogo);
        Assert.NotNull(pix.Qr);
        Assert.StartsWith("000201", pix.CopiaECola);
        Assert.Contains("pix@icebeer.com.br", pix.CopiaECola);
        pix.PagadorNome = "JOSE DA SILVA";
        pix.Horario = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow.AddMinutes(-1), pdv.Servicos.GetRequiredService<ServicoVenda>().Fuso).ToString("HH:mm");
        pdv.Tecla(Key.Enter);
        await LiberarAsync(pdv, venda, "PIX conferido no extrato");
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");

        // 16.12: só PIX e cartão (sem "Abrir gaveta") e sem troco: a gaveta não abre.
        Assert.Equal(aberturasAntes, gaveta.Aberturas);
        Assert.Contains("Cartão de débito ELO", venda.UltimoCupom);
        Assert.Contains("ICE BEER COMÉRCIO DE BEBIDAS LTDA", venda.UltimoCupom);
        await using var db = Banco(pdv);
        var evento = await db.EventosSaida.SingleAsync(e => e.Tipo == "venda.finalizada", Ct);
        var payload = JsonNode.Parse(evento.Payload)!;
        var pagamentos = payload["pagamentos_venda"]!.AsArray();
        Assert.Equal(("06", "Elo", "000123", 2), (pagamentos[0]!["bandeira"]!.GetValue<string>(), pagamentos[0]!["bandeira_nome"]!.GetValue<string>(),
            pagamentos[0]!["nsu"]!.GetValue<string>(), pagamentos[0]!["tipo_integracao"]!.GetValue<int>()));
        var cobranca = Assert.Single(payload["cobrancas_pix"]!.AsArray())!;
        Assert.Equal((pagamentos[1]!["pix_cobranca_id"]!.GetValue<string>(), "paga", "JOSE DA SILVA"),
            (cobranca["id"]!.GetValue<string>(), cobranca["status"]!.GetValue<string>(), cobranca["pagador_nome"]!.GetValue<string>()));
        var carlos = "019a0003-0000-7000-8000-000000000002";
        Assert.Equal(carlos, pagamentos[1]!["autorizado_por_id"]!.GetValue<string>());
        var liberacao = Assert.Single(payload["liberacoes"]!.AsArray())!;
        Assert.Equal(("pix_manual", carlos), (liberacao["acao"]!.GetValue<string>(), liberacao["autorizado_por_id"]!.GetValue<string>()));
        Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "pix_confirmado_manual", Ct));
        Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "liberacao" && l.Entidade == "pagamentos_venda", Ct));
    }

    [AvaloniaFact]
    public async Task F5_poe_o_cpf_na_nota_e_vincula_o_cliente_cadastrado()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        var agora = DateTimeOffset.UtcNow;
        var cliente = Guid.CreateVersion7();
        await pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [new PessoaRegistro { Id = cliente, Codigo = 10, Nome = "JOAO CLIENTE", CpfCnpj = "52998224725", Ativa = true, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 }],
            Ct);

        // Sem venda o F5 não abre (o fluxo padrão não pergunta nada, O8).
        pdv.Tecla(Key.F5);
        Assert.Null(venda.Dialogo);
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F5);
        await pdv.EsperarFocoAsync("CampoDocumentoCliente");
        var dialogo = Assert.IsType<DialogoClienteViewModel>(venda.Dialogo);
        pdv.Digitar("111.111.111-11");
        pdv.Tecla(Key.Enter);
        await AmbienteUi.Pausa();
        Assert.Equal(ServicoVenda.MensagemDocumentoInvalido, dialogo.Erro);
        dialogo.Documento = "529.982.247-25";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "cliente identificado");
        Assert.Equal("Cliente JOAO CLIENTE na venda.", pdv.Texto("TextoMensagem"));
        Assert.Contains("CPF 52998224725", venda.CabecalhoVenda);

        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        Assert.Equal("CPF 52998224725", pdv.Texto("TextoClientePagamento"));
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
        Assert.Contains("Cliente: CPF 52998224725", venda.UltimoCupom);
        await using var db = Banco(pdv);
        var gravada = await db.Vendas.SingleAsync(Ct);
        Assert.Equal(("52998224725", (Guid?)cliente), (gravada.CpfCnpjNota, gravada.ClienteId));

        // A busca encontra pelo nome; o cliente escolhido vai sem digitar o documento.
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F5);
        await pdv.EsperarFocoAsync("CampoDocumentoCliente");
        var busca = Assert.IsType<DialogoClienteViewModel>(venda.Dialogo);
        busca.Busca = "joao";
        await pdv.EsperarAsync(() => busca.Selecionado is not null, "cliente encontrado");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "cliente escolhido");
        Assert.Equal((Guid?)cliente, pdv.Servicos.GetRequiredService<ServicoVenda>().Atual!.ClienteId);
    }

    [AvaloniaFact]
    public async Task Sem_caixa_aberto_nenhum_item_entra_e_o_numero_nao_e_gasto()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Servicos.GetRequiredService<SessaoTerminal>().DefinirSessaoCaixa(null);

        await pdv.EntrarCodigoAsync("0044");

        Assert.Equal(ServicoVenda.MensagemCaixaFechado, pdv.Texto("TextoMensagem"));
        Assert.False(pdv.Servicos.GetRequiredService<ServicoVenda>().VendaAberta);
        await using var db = Banco(pdv);
        Assert.Equal(0L, (await db.SequenciasLocais.Where(s => s.Chave == SequenciaLocal.Venda).Select(s => (long?)s.UltimoValor).FirstOrDefaultAsync(Ct)) ?? 0L);
    }
}
