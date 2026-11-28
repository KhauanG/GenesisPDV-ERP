using System.Text.Json.Nodes;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Preço digitado, alteração de preço e acréscimo no total no caixa (PDV 10.4, 10.5, 12.2; Fase 3, F3-B16), só pelo
/// teclado: o genérico e o "Solicita preço PDV" com o diálogo do preço e o limite da loja; o <c>Ctrl+F6</c> com a
/// liberação do supervisor (a MARIA da demonstração não tem <c>pdv.venda.alterar_preco</c>); o F6 › 3 em %; e o portão do
/// recurso da onda (sem o <c>venda.finalizada</c> v2 anunciado, nada disso aparece e o caixa vende como antes).
/// </summary>
public class PrecoManualTelasTests
{
    private static readonly Guid Generico = Guid.Parse("019a0001-0000-7000-8000-000000000400");
    private static readonly Guid Carvao = Guid.Parse("019a0001-0000-7000-8000-000000000401");
    private static readonly Guid SemPreco = Guid.Parse("019a0001-0000-7000-8000-000000000402");
    private static readonly Guid Burguer = Guid.Parse("019a0001-0000-7000-8000-000000000403");
    private static readonly Guid Un = Guid.Parse("019a0006-0000-7000-8000-000000000001");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    /// <summary>
    /// "DIVERSOS" (genérico, preço 0), "CARVÃO 5KG" (solicita preço, tabela 25,00), "GELO 5KG" (preço 0 sem as marcas, de
    /// uma importação) e "X-BURGUER DA CASA" (genérico com complementos: Adicionais opcional, bacon +3,00).
    /// </summary>
    private static Task CadastrarAsync(AmbienteUi pdv)
    {
        var agora = DateTimeOffset.UtcNow;
        var adicionais = Guid.Parse("019a0013-0000-7000-8000-000000000403");
        LinhaEspelho[] linhas =
        [
            new ProdutoRegistro
            {
                Id = Generico, Codigo = 400, CodigoInterno = "0400", Nome = "DIVERSOS", UnidadeId = Un, PrecoVenda = 0m, Generico = true,
            },
            new ProdutoRegistro
            {
                Id = Carvao, Codigo = 401, CodigoInterno = "0401", Nome = "CARVÃO 5KG", UnidadeId = Un, PrecoVenda = 25.00m, SolicitaPrecoPdv = true,
            },
            new ProdutoRegistro { Id = SemPreco, Codigo = 402, CodigoInterno = "0402", Nome = "GELO 5KG", UnidadeId = Un, PrecoVenda = 0m },
            new ProdutoRegistro
            {
                Id = Burguer, Codigo = 403, CodigoInterno = "0403", Nome = "X-BURGUER DA CASA", UnidadeId = Un, PrecoVenda = 0m, Generico = true,
                Tipo = "com_complementos",
            },
            new ProdutoGrupoComplementosRegistro { Id = adicionais, ProdutoId = Burguer, Nome = "Adicionais", Minimo = 0, Maximo = 2, Ordem = 1 },
            new ProdutoComplementoRegistro
            {
                Id = Guid.Parse("019a0014-0000-7000-8000-000000000403"), GrupoId = adicionais, Descricao = "Bacon", PrecoAdicional = 3.00m,
                QuantidadeBaixa = 1m, Ordem = 1, Ativo = true,
            },
        ];
        foreach (var linha in linhas)
        {
            linha.CriadoEm = linha.AtualizadoEm = agora;
            linha.Versao = 1;
        }

        return pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(linhas, Ct);
    }

    /// <summary>Chave da loja de demonstração no espelho <c>configuracoes</c> (como o pull a gravaria).</summary>
    private static Task ConfigurarAsync(AmbienteUi pdv, string chave, string valorJson)
    {
        var agora = DateTimeOffset.UtcNow;
        return pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [
                new ConfiguracaoRegistro
                {
                    Id = Guid.CreateVersion7(), Escopo = "loja", LojaId = CatalogoDemonstracao.LojaDemonstracao, Chave = chave, Valor = valorJson,
                    CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
            ],
            Ct);
    }

    private static async Task LiberarComCarlosAsync(AmbienteUi pdv, VendaViewModel venda, string motivo)
    {
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var liberacao = Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
        liberacao.Pedido.Usuario = "2";
        liberacao.Pedido.Pin = "4321";
        liberacao.Pedido.Motivo = motivo;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is not DialogoLiberacaoViewModel, "liberação concedida");
    }

    private static async Task<List<LogAuditoriaLocal>> AuditoriaAsync(AmbienteUi pdv, string acao)
    {
        await using var db = Banco(pdv);
        return await db.LogAuditoriaLocal.AsNoTracking().Where(l => l.Acao == acao).ToListAsync(Ct);
    }

    /// <summary>O dono mudou o perfil da MARIA no ERP (a permissão do login fica em <c>Operador.Permissoes</c>).</summary>
    private static void PerfilDaMaria(AmbienteUi pdv, Func<IReadOnlySet<string>, IEnumerable<string>> mudar)
    {
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>();
        var maria = sessao.Operador!;
        sessao.Operador = maria with { Permissoes = new HashSet<string>(mudar(maria.Permissoes ?? new HashSet<string>()), StringComparer.Ordinal) };
    }

    /// <summary>O F1 aberto e fechado: as linhas da ajuda.</summary>
    private static async Task<IReadOnlyList<string>> AjudaAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        pdv.Tecla(Key.F1);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoAjudaViewModel, "ajuda");
        var linhas = ((DialogoAjudaViewModel)venda.Dialogo!).Atalhos;
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "ajuda fechada");
        return linhas;
    }

    [AvaloniaFact]
    public async Task Generico_pede_descricao_e_preco_recusa_zero_e_confirma_acima_do_limite()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);
        await ConfigurarAsync(pdv, ChavesConfiguracao.LimitePrecoDigitado, "\"100.00\"");

        await pdv.EntrarCodigoAsync("2*0400");
        var dialogo = Assert.IsType<DialogoPrecoDigitadoViewModel>(venda.Dialogo);
        await pdv.EsperarFocoAsync("CampoDescricaoGenerico");
        Assert.Equal(("DIVERSOS", string.Empty), (dialogo.Descricao, dialogo.Preco));
        dialogo.Descricao = "BOIA INFLÁVEL";
        pdv.Tecla(Key.Tab);
        await pdv.EsperarFocoAsync("CampoPrecoDigitado");

        // Preço zero é recusado (10.4: obrigatório > 0); acima do limite da loja, o primeiro Enter avisa e o segundo confirma.
        pdv.Digitar("0");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => dialogo.Erro is not null, "preço zero recusado");
        Assert.Equal(RegrasPrecoManual.MensagemPrecoInvalido, dialogo.Erro);
        dialogo.Preco = "150,00";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => dialogo.Erro?.Contains("limite", StringComparison.Ordinal) == true, "aviso do limite");
        Assert.Empty(venda.Itens);
        pdv.Captura("92-preco-digitado-limite");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "genérico incluído");

        var linha = Assert.Single(venda.Itens);
        Assert.Equal(("BOIA INFLÁVEL", "150,00", "300,00"), (linha.Descricao, linha.Unitario, linha.Total));
        Assert.Equal("300,00", pdv.Texto("TextoTotal"));
        Assert.Equal(OrigemPreco.Manual, linha.Item.OrigemPreco);
        var auditoria = Assert.Single(await AuditoriaAsync(pdv, "preco_alterado"));
        Assert.Equal("generico", JsonNode.Parse(auditoria.Depois!)!["origem"]!.GetValue<string>());
    }

    [AvaloniaFact]
    public async Task Solicita_preco_vem_com_o_de_tabela_e_o_digitado_nao_conta_como_desconto()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);

        await pdv.EntrarCodigoAsync("0401");
        var dialogo = Assert.IsType<DialogoPrecoDigitadoViewModel>(venda.Dialogo);
        await pdv.EsperarFocoAsync("CampoPrecoDigitado");
        Assert.False(dialogo.Generico);
        Assert.Equal("25,00", dialogo.Preco);
        dialogo.Preco = "19,90";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "carvão incluído");

        var item = Assert.Single(venda.Itens).Item;
        Assert.Equal(("CARVÃO 5KG", 19.90m, 19.90m, 0m), (item.Descricao, item.PrecoTabela, item.PrecoUnitario, item.ReducaoPrecoManual));
        // O Esc do diálogo não inclui nada.
        await pdv.EntrarCodigoAsync("0401");
        await pdv.EsperarFocoAsync("CampoPrecoDigitado");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "Esc");
        Assert.Single(venda.Itens);
    }

    [AvaloniaFact]
    public async Task Ctrl_F6_so_com_a_chave_da_loja_e_a_reducao_sem_a_permissao_pede_o_supervisor()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1);

        // pdv.altera_preco_pdv desligada (o padrão): a ação não aparece e a tecla bipa.
        Assert.False(venda.TemAcao(Core.Atalhos.AcoesAtalho.AlterarPreco));
        pdv.Tecla(Key.F6, RawInputModifiers.Control);
        await pdv.EsperarAsync(() => pdv.Texto("TextoMensagem")?.StartsWith(VendaViewModel.MensagemAcaoIndisponivel, StringComparison.Ordinal) == true, "bipe");
        Assert.Null(venda.Dialogo);

        // Com o recurso da onda (na demonstração, sempre) e a chave desligada, o F1 aponta a loja, não uma próxima versão.
        var ajuda = await AjudaAsync(pdv, venda);
        Assert.Contains(ajuda, l => l.StartsWith("Desligadas na loja: Ctrl+F6 Alterar preço", StringComparison.Ordinal) && l.EndsWith("(ERP › Configurações › PDV)", StringComparison.Ordinal));
        Assert.DoesNotContain(ajuda, l => l.StartsWith("Chegam numa próxima versão:", StringComparison.Ordinal) && l.Contains("Ctrl+F6", StringComparison.Ordinal));

        await ConfigurarAsync(pdv, ChavesConfiguracao.AlteraPrecoPdv, "true");
        await venda.RecarregarAtalhosAsync();
        Assert.True(venda.TemAcao(Core.Atalhos.AcoesAtalho.AlterarPreco));
        pdv.Tecla(Key.F6, RawInputModifiers.Control);
        var dialogo = Assert.IsType<DialogoAlterarPrecoViewModel>(venda.Dialogo);
        await pdv.EsperarFocoAsync("CampoAlterarPreco");
        Assert.StartsWith("Preço de tabela R$ 12,90", dialogo.Dica, StringComparison.Ordinal);
        pdv.Digitar("10,00");
        pdv.Tecla(Key.Enter);

        // A MARIA não tem pdv.venda.alterar_preco: o supervisor libera (o CARLOS, Master).
        await LiberarComCarlosAsync(pdv, venda, "Produto com a embalagem amassada");
        await pdv.EsperarAsync(() => venda.Dialogo is null, "preço alterado");
        Assert.StartsWith("Preço do item 1 alterado para R$ 10,00 com liberação de ", pdv.Texto("TextoMensagem"), StringComparison.Ordinal);
        Assert.Equal("10,00", pdv.Texto("TextoTotal"));
        var linha = Assert.Single(venda.Itens);
        Assert.Equal("└ preço alterado (tabela 12,90)", linha.Detalhe);

        var atual = pdv.Servicos.GetRequiredService<ServicoVenda>().Atual!;
        var lib = Assert.Single(atual.Liberacoes);
        Assert.Equal((AcaoLiberacao.AlterarPreco, linha.Item.Id), (lib.Acao, lib.ItemVendaId));
        var auditoria = Assert.Single(await AuditoriaAsync(pdv, "preco_alterado"));
        Assert.NotNull(auditoria.AutorizadoPorId);
        Assert.Equal("12.9000", JsonNode.Parse(auditoria.Antes!)!["preco_unitario"]!.GetValue<string>());
        Assert.Single(await AuditoriaAsync(pdv, "liberacao"));

        // A liberação sobe com a venda (liberacoes do venda.finalizada) e a linha vai com o preço alterado e a tabela mantida.
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.CaixaLivre && venda.Dialogo is null, "venda finalizada");
        await using var banco = Banco(pdv);
        var payload = JsonNode.Parse((await banco.EventosSaida.SingleAsync(e => e.Tipo == "venda.finalizada", Ct)).Payload)!;
        var itemPayload = payload["itens_venda"]![0]!;
        Assert.Equal(("12.9000", "10.0000", "manual"),
            (itemPayload["preco_tabela"]!.GetValue<string>(), itemPayload["preco_unitario"]!.GetValue<string>(), itemPayload["origem_preco"]!.GetValue<string>()));
        Assert.Equal("alterar_preco", payload["liberacoes"]![0]!["acao"]!.GetValue<string>());
    }

    [AvaloniaFact]
    public async Task F6_3_acrescimo_em_percentual_soma_no_total_e_o_F6_4_tira()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1);

        pdv.Tecla(Key.F6);
        var menu = Assert.IsType<DialogoMenuDescontoViewModel>(venda.Dialogo);
        Assert.True(menu.TemAcrescimo);
        await AmbienteUi.Pausa();
        pdv.Tecla(Key.D3);
        await pdv.EsperarFocoAsync("CampoAcrescimo");
        pdv.Digitar("10%");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "acréscimo aplicado");
        Assert.Equal("Acréscimo de R$ 1,29 aplicado.", pdv.Texto("TextoMensagem"));
        Assert.Equal(("1,29", "14,19"), (venda.AcrescimosTexto, pdv.Texto("TextoTotal")));
        var registro = Assert.Single(await AuditoriaAsync(pdv, "acrescimo_total"));
        Assert.Equal("1.29", JsonNode.Parse(registro.Depois!)!["acrescimo_total"]!.GetValue<string>());

        pdv.Tecla(Key.F6);
        await AmbienteUi.Pausa();
        pdv.Tecla(Key.D4);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "acréscimo removido");
        Assert.Equal("Acréscimo no total removido.", pdv.Texto("TextoMensagem"));
        Assert.Equal("12,90", pdv.Texto("TextoTotal"));

        // De novo em R$, e o cupom traz a linha dos acréscimos.
        pdv.Tecla(Key.F6);
        await AmbienteUi.Pausa();
        pdv.Tecla(Key.D3);
        await pdv.EsperarFocoAsync("CampoAcrescimo");
        pdv.Digitar("2,10");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "acréscimo em R$");
        Assert.Equal("15,00", pdv.Texto("TextoTotal"));
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        Assert.Equal("15,00", pagamento.FaltaTexto);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.CaixaLivre && venda.Dialogo is null, "venda finalizada");
        Assert.Contains("Acréscimos", venda.UltimoCupom!, StringComparison.Ordinal);
        Assert.Contains("2,10", venda.UltimoCupom!, StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task Sem_o_recurso_da_onda_nada_aparece_e_o_caixa_vende_como_antes()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);
        await ConfigurarAsync(pdv, ChavesConfiguracao.AlteraPrecoPdv, "true");

        // Um terminal real sem o v2 no último handshake (o caixa diante da nuvem de hoje).
        await using (var db = Banco(pdv))
        {
            var identidade = await db.IdentidadeTerminal.SingleAsync(Ct);
            identidade.UrlApi = "https://api.exemplo/";
            await db.SaveChangesAsync(Ct);
        }

        await venda.RecarregarAtalhosAsync();
        Assert.False(venda.TemAcao(Core.Atalhos.AcoesAtalho.AlterarPreco));
        Assert.False(venda.AcrescimoDisponivel);

        // A chave da loja está ligada: sem o recurso, o F1 não culpa a loja (a ação é de uma próxima versão deste caixa).
        var ajuda = await AjudaAsync(pdv, venda);
        Assert.Contains(ajuda, l => l.StartsWith("Chegam numa próxima versão:", StringComparison.Ordinal) && l.Contains("Ctrl+F6 Alterar preço", StringComparison.Ordinal));
        Assert.DoesNotContain(ajuda, l => l.StartsWith("Desligadas na loja", StringComparison.Ordinal));

        // O "Solicita preço" vende pelo de tabela, sem diálogo; o genérico de preço zero continua recusado.
        await pdv.EntrarCodigoAsync("0401");
        Assert.Null(venda.Dialogo);
        Assert.Equal((25.00m, OrigemPreco.Varejo), (Assert.Single(venda.Itens).Item.PrecoUnitario, venda.Itens[0].Item.OrigemPreco));
        await pdv.EntrarCodigoAsync("0400");
        await pdv.EsperarAsync(() => pdv.Texto("TextoMensagem")?.Contains("sem preço", StringComparison.Ordinal) == true, "sem preço");
        Assert.Single(venda.Itens);

        // O de preço zero sem as marcas também, mesmo com pdv.venda.alterar_preco (o diálogo é do recurso da onda).
        PerfilDaMaria(pdv, p => p.Append(PermissoesPdv.AlterarPreco));
        venda.Mensagem = null;
        await pdv.EntrarCodigoAsync("0402");
        await pdv.EsperarAsync(() => pdv.Texto("TextoMensagem")?.Contains("GELO 5KG", StringComparison.Ordinal) == true, "sem preço (0402)");
        Assert.Contains("Produto sem preço", pdv.Texto("TextoMensagem"), StringComparison.Ordinal);
        Assert.Null(venda.Dialogo);
        Assert.Single(venda.Itens);

        pdv.Tecla(Key.F6);
        var menu = Assert.IsType<DialogoMenuDescontoViewModel>(venda.Dialogo);
        Assert.False(menu.TemAcrescimo);
        await AmbienteUi.Pausa();
        pdv.Tecla(Key.D3);
        await AmbienteUi.Pausa();
        Assert.Same(menu, venda.Dialogo);
    }

    [AvaloniaFact]
    public async Task Produto_de_preco_zero_pede_o_preco_so_a_quem_pode_alterar_preco()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);

        // Tabela da PDV 10.1: a MARIA (sem pdv.venda.alterar_preco) lê "Produto sem preço — procure o supervisor".
        await pdv.EntrarCodigoAsync("0402");
        await pdv.EsperarAsync(() => pdv.Texto("TextoMensagem")?.Contains("Produto sem preço — procure o supervisor (GELO 5KG)", StringComparison.Ordinal) == true, "sem preço");
        Assert.Null(venda.Dialogo);
        Assert.Empty(venda.Itens);

        // Com a permissão, o caixa trata como "Solicita preço PDV": o diálogo vazio, sem descrição (não é genérico).
        PerfilDaMaria(pdv, p => p.Append(PermissoesPdv.AlterarPreco));
        venda.Mensagem = null;
        await pdv.EntrarCodigoAsync("0402");
        var dialogo = Assert.IsType<DialogoPrecoDigitadoViewModel>(venda.Dialogo);
        await pdv.EsperarFocoAsync("CampoPrecoDigitado");
        Assert.False(dialogo.Generico);
        Assert.Equal(string.Empty, dialogo.Preco);
        pdv.Digitar("8,00");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "gelo incluído");

        var item = Assert.Single(venda.Itens).Item;
        Assert.Equal(("GELO 5KG", OrigemPreco.Manual, 8.00m, 8.00m), (item.Descricao, item.OrigemPreco, item.PrecoTabela, item.PrecoUnitario));
        var auditoria = Assert.Single(await AuditoriaAsync(pdv, "preco_alterado"));
        Assert.Equal("sem_preco", JsonNode.Parse(auditoria.Depois!)!["origem"]!.GetValue<string>());

        // O serviço confere a permissão do logado (sem confiar só na tela): tirada, o preço digitado volta a ser recusado.
        PerfilDaMaria(pdv, p => p.Where(x => x != PermissoesPdv.AlterarPreco));
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        Assert.Equal(SemPreco, item.ProdutoId);
        var resolvido = new Core.Produtos.ProdutoResolvido(new Core.Produtos.ProdutoVenda(SemPreco, 402, "0402", "GELO 5KG", "UN", 0m));
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() =>
            servico.IncluirAsync(resolvido, 1m, "0402", ct: Ct, precoDigitado: new PrecoDigitado(8.00m)));
        Assert.Contains("Produto sem preço", recusa.Message, StringComparison.Ordinal);
        Assert.Single(venda.Itens);
    }

    [AvaloniaFact]
    public async Task Generico_com_complementos_abre_os_complementos_e_depois_o_preco()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);

        await pdv.EntrarCodigoAsync("0403");
        Assert.IsType<DialogoComplementosViewModel>(venda.Dialogo);
        await pdv.EsperarFocoAsync("DialogoComplementos");
        pdv.Tecla(Key.D1);
        pdv.Tecla(Key.Enter);

        // O último grupo confirmado abre o preço (o genérico pede a descrição e o preço), e a inclusão leva os dois.
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoPrecoDigitadoViewModel, "diálogo do preço");
        var dialogo = (DialogoPrecoDigitadoViewModel)venda.Dialogo!;
        await pdv.EsperarFocoAsync("CampoDescricaoGenerico");
        Assert.Empty(venda.Itens);
        dialogo.Preco = "10,00";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "x-burguer incluído");

        var linha = Assert.Single(venda.Itens);
        Assert.Equal(("13,00", "13,00"), (linha.Unitario, linha.Total));
        Assert.Equal((13.00m, 13.00m, OrigemPreco.Manual), (linha.Item.PrecoTabela, linha.Item.PrecoUnitario, linha.Item.OrigemPreco));
        Assert.Equal("Bacon", Assert.Single(linha.Item.Complementos).Descricao);
        Assert.Equal("X-BURGUER DA CASA incluído por R$ 13,00.", pdv.Texto("TextoMensagem"));
    }

    [AvaloniaFact]
    public async Task F6_3_sem_a_permissao_de_acrescimo_o_supervisor_libera_e_fica_na_auditoria()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        PerfilDaMaria(pdv, p => p.Where(x => x != PermissoesPdv.Acrescimo));
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1);

        // O serviço não aplica o acréscimo sem a permissão nem a liberação (sem confiar só na tela).
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() => servico.AcrescimoAsync(Desconto.EmReais(1.00m), ct: Ct));
        Assert.Equal("Sem a permissão de acréscimo: o supervisor libera.", recusa.Message);

        pdv.Tecla(Key.F6);
        Assert.IsType<DialogoMenuDescontoViewModel>(venda.Dialogo);
        await AmbienteUi.Pausa();
        pdv.Tecla(Key.D3);

        // O supervisor libera antes de o valor abrir; o diálogo do valor diz quem liberou.
        await LiberarComCarlosAsync(pdv, venda, "Entrega fora do horário");
        await pdv.EsperarFocoAsync("CampoAcrescimo");
        var dialogo = Assert.IsType<DialogoValorAcrescimoViewModel>(venda.Dialogo);
        Assert.StartsWith("Acréscimo no total (liberado por ", dialogo.Titulo, StringComparison.Ordinal);
        Assert.Equal(0m, servico.Atual!.AcrescimoTotal);
        pdv.Digitar("2,00");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "acréscimo aplicado");

        Assert.StartsWith("Acréscimo de R$ 2,00 aplicado com liberação de ", pdv.Texto("TextoMensagem"), StringComparison.Ordinal);
        Assert.Equal("14,90", pdv.Texto("TextoTotal"));
        var acrescimo = Assert.Single(await AuditoriaAsync(pdv, "acrescimo_total"));
        var liberacao = Assert.Single(await AuditoriaAsync(pdv, "liberacao"));
        Assert.NotNull(acrescimo.AutorizadoPorId);
        Assert.Equal(acrescimo.AutorizadoPorId, liberacao.AutorizadoPorId);
        Assert.Equal("Entrega fora do horário", liberacao.Motivo);
        Assert.Equal("2.00", JsonNode.Parse(liberacao.Depois!)!["acrescimo_total"]!.GetValue<string>());
        // O acréscimo não tem linha em liberacoes da venda (a SYNC 9.7 não tem a ação): a liberação fica na auditoria.
        Assert.Empty(servico.Atual!.Liberacoes);
    }

    [AvaloniaFact]
    public async Task F6_4_com_desconto_e_acrescimo_no_total_tira_os_dois()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1);

        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        var supervisor = new Liberacao(Guid.CreateVersion7(), 100m, "Cliente fidelidade", DateTimeOffset.UtcNow);
        Assert.True((await servico.DescontoTotalAsync(Desconto.EmReais(0.90m), supervisor, Ct)).Aplicado);
        Assert.Equal(2.00m, await servico.AcrescimoAsync(Desconto.EmReais(2.00m), ct: Ct));
        Assert.Equal(14.00m, servico.Atual!.Total);

        pdv.Tecla(Key.F6);
        await AmbienteUi.Pausa();
        pdv.Tecla(Key.D4);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "removidos");
        Assert.Equal("Desconto e acréscimo no total removidos.", pdv.Texto("TextoMensagem"));
        Assert.Equal("12,90", pdv.Texto("TextoTotal"));
        Assert.Equal((0m, 0m), (servico.Atual!.DescontoTotal, servico.Atual.AcrescimoTotal));

        // Gravado num commit só: a venda relida do banco também está sem os dois.
        await using var db = Banco(pdv);
        var gravada = await db.Vendas.AsNoTracking().SingleAsync(v => v.Id == servico.Atual.Id, Ct);
        Assert.Equal((0m, 0m, 12.90m), (gravada.DescontoTotal, gravada.AcrescimoTotal, gravada.Total));
    }
}
