using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Pesquisa F2 com as colunas do F2-B36 (PDV 10.3; README › decisão 83): marca, localização, atacado e o promocional
/// vigente destacado; o estoque estimado com <c>pdv.exibe_estoque_busca</c> ligada (no terminal real; "—" no produto sem
/// saldo próprio; na linha da embalagem, com a sigla da unidade do produto) e a coluna inteira some com a chave desligada ou
/// na demonstração. O promocional e o atacado só aparecem quando a venda os cobraria (menores que o varejo da linha; o combo
/// sem atacado). A resposta de um filtro já trocado é descartada. A busca vai pelo índice FTS5 (conferido no fim).
/// </summary>
public class PesquisaTelasTests
{
    private static readonly Guid Brahma = CatalogoDemonstracao.Produto(123);
    private static readonly Guid Marca = Guid.Parse("019a0006-0000-7000-8000-0000000000b1");
    private static readonly Guid Estoque = Guid.Parse("019a0006-0000-7000-8000-0000000000e1");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>A Brahma da demonstração com marca, localização e promoção (versão nova), e a loja com o estoque e o saldo.</summary>
    private static async Task PrepararAsync(AmbienteUi pdv)
    {
        var agora = DateTimeOffset.UtcNow;
        var fabrica = pdv.Servicos.GetRequiredService<FabricaPdvDb>();
        ProdutoRegistro brahma;
        await using (var db = fabrica.CreateDbContext())
        {
            brahma = await db.Produtos.AsNoTracking().SingleAsync(p => p.Id == Brahma, Ct);
            db.Set<SaldoEstoqueRegistro>().Add(new SaldoEstoqueRegistro
            {
                Id = Guid.CreateVersion7(),
                EstoqueId = Estoque,
                ProdutoId = Brahma,
                TipoEstoqueId = Guid.CreateVersion7(),
                Quantidade = 1250m,
                Versao = 10,
                CriadoEm = agora,
                AtualizadoEm = agora,
            });
            await db.SaveChangesAsync(Ct);
        }

        brahma.Versao++;
        brahma.MarcaId = Marca;
        brahma.Localizacao = "A3-02";
        brahma.PrecoPromocional = 2.99m;
        await pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [
                new MarcaRegistro { Id = Marca, Codigo = 1, Descricao = "Ambev Brahma", CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
                brahma,
                new LojaRegistro
                {
                    Id = CatalogoDemonstracao.LojaDemonstracao, Codigo = 1, Nome = "Loja 1", EstoqueId = Estoque, Ativa = true, UsaPdv = true,
                    CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
            ],
            Ct);
    }

    /// <summary>A sessão em memória vira "real" (o estoque é do terminal real; a demonstração não tem saldo), só para a tela.</summary>
    private static void TornarReal(AmbienteUi pdv)
    {
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>();
        sessao.Identidade = new IdentidadeTerminal
        {
            Id = sessao.Identidade!.Id,
            TerminalId = sessao.Identidade.TerminalId,
            LojaId = sessao.Identidade.LojaId,
            CaixaId = sessao.Identidade.CaixaId,
            NumeroCaixa = sessao.Identidade.NumeroCaixa,
            UrlApi = "https://api.exemplo/",
            AtivadoEm = sessao.Identidade.AtivadoEm,
            NomeMaquina = sessao.Identidade.NomeMaquina,
        };
        Assert.True(sessao.IdentidadeReal);
    }

    /// <summary>Produto da demonstração com a versão nova e o <paramref name="ajustar"/> aplicado (como o pull gravaria).</summary>
    private static async Task AjustarProdutoAsync(AmbienteUi pdv, int codigo, Action<ProdutoRegistro> ajustar)
    {
        ProdutoRegistro produto;
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            produto = await db.Produtos.AsNoTracking().SingleAsync(p => p.Id == CatalogoDemonstracao.Produto(codigo), Ct);
        }

        produto.Versao++;
        ajustar(produto);
        await pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync([produto], Ct);
    }

    /// <summary>As buscas da tela foram pela FTS5 (a falha dela cairia na busca em memória e marcaria a reconstrução).</summary>
    private static async Task ConferirIndiceAsync(AmbienteUi pdv)
    {
        await using var conexao = new Microsoft.Data.Sqlite.SqliteConnection(pdv.Servicos.GetRequiredService<FabricaPdvDb>().StringConexao);
        await conexao.OpenAsync(Ct);
        Assert.True(await IndiceBuscaProdutos.ProntoAsync(conexao, null, Ct));
    }

    private static async Task<DialogoPesquisaViewModel> PesquisarAsync(AmbienteUi pdv, VendaViewModel venda, string texto, int linhas)
    {
        pdv.Tecla(Key.F2);
        await pdv.EsperarFocoAsync("CampoPesquisa");
        pdv.Digitar(texto);
        var pesquisa = Assert.IsType<DialogoPesquisaViewModel>(venda.Dialogo);
        await pdv.EsperarAsync(() => pesquisa.Resultados.Count == linhas, $"{linhas} linha(s) para \"{texto}\"");
        return pesquisa;
    }

    private static async Task FecharAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "pesquisa fechada");
        Assert.Empty(venda.Itens);
    }

    [AvaloniaFact]
    public async Task Linha_mostra_marca_localizacao_atacado_e_promocional_e_a_demonstracao_nao_tem_coluna_de_estoque()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await PrepararAsync(pdv);

        // Pela marca (o texto do índice tem a marca), sem acento e em qualquer ordem.
        var pesquisa = await PesquisarAsync(pdv, venda, "350 ambev", 1);
        var linha = Assert.Single(pesquisa.Resultados);
        Assert.Equal(("CERV BRAHMA LT 350ML", "Ambev Brahma", "A3-02"), (linha.Descricao, linha.Marca, linha.Localizacao));
        Assert.Equal((3.49m, 3.19m, 2.99m), (linha.Preco, linha.PrecoAtacado, linha.PrecoPromocional));
        Assert.Null(linha.EstoqueTexto);
        Assert.False(pesquisa.ExibeEstoque);
        Assert.False(pdv.Controle<TextBlock>("CabecalhoEstoque").IsVisible);
        pdv.Captura("83-pesquisa-colunas");
        await FecharAsync(pdv, venda);
        await ConferirIndiceAsync(pdv);
    }

    [AvaloniaFact]
    public async Task Terminal_real_mostra_o_estoque_estimado_e_a_chave_desligada_esconde_a_coluna()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await PrepararAsync(pdv);
        TornarReal(pdv);

        var pesquisa = await PesquisarAsync(pdv, venda, "cerv lt", 3);
        Assert.True(pesquisa.ExibeEstoque);
        Assert.True(pdv.Controle<TextBlock>("CabecalhoEstoque").IsVisible);
        Assert.Equal("1.250", pesquisa.Resultados.Single(l => l.Produto.Id == Brahma).EstoqueTexto);
        // Sem linha no espelho: o estimado é zero.
        Assert.All(pesquisa.Resultados.Where(l => l.Produto.Id != Brahma), l => Assert.Equal("0", l.EstoqueTexto));
        pdv.Captura("83-pesquisa-estoque");
        await FecharAsync(pdv, venda);

        // O combo não tem saldo próprio: "—".
        pesquisa = await PesquisarAsync(pdv, venda, "combo de whisky", 1);
        Assert.Equal("—", Assert.Single(pesquisa.Resultados).EstoqueTexto);
        await FecharAsync(pdv, venda);

        // "Exibe estoque na busca" desligada na loja: a coluna some (cabeçalho e linhas).
        var agora = DateTimeOffset.UtcNow;
        await pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [
                new ConfiguracaoRegistro
                {
                    Id = Guid.CreateVersion7(), Escopo = "loja", LojaId = CatalogoDemonstracao.LojaDemonstracao,
                    Chave = ChavesConfiguracao.ExibeEstoqueBusca, Valor = "false", CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
            ],
            Ct);
        pesquisa = await PesquisarAsync(pdv, venda, "cerv lt", 3);
        Assert.False(pesquisa.ExibeEstoque);
        Assert.All(pesquisa.Resultados, l => Assert.Null(l.EstoqueTexto));
        Assert.False(pdv.Controle<TextBlock>("CabecalhoEstoque").IsVisible);
        await FecharAsync(pdv, venda);
        await ConferirIndiceAsync(pdv);
    }

    [AvaloniaFact]
    public async Task Linha_da_embalagem_mostra_o_estoque_com_a_sigla_da_unidade_e_sem_atacado_nem_promocional()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        await PrepararAsync(pdv);
        TornarReal(pdv);
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();

        // O DUN do fardo de 12 (só números): o saldo é em latas, e a linha diz isso ("1.250 UN", não 1.250 fardos).
        var fardo = Assert.Single(await servico.PesquisarAsync("17891149103109", soNumeros: true, Ct));
        Assert.True(fardo.EhEmbalagem);
        Assert.Equal(("FD 12", 37.90m, "1.250 UN"), (fardo.Unidade, fardo.Preco, fardo.EstoqueTexto));
        Assert.Equal((null, null), (fardo.PrecoAtacado, fardo.PrecoPromocional));
        // A linha da unidade do mesmo produto: o número sozinho.
        var lata = Assert.Single(await servico.PesquisarAsync("7891149103102", soNumeros: true, Ct));
        Assert.Equal(("UN", "1.250", 2.99m), (lata.Unidade, lata.EstoqueTexto, lata.PrecoPromocional));
    }

    [AvaloniaFact]
    public async Task Promocional_e_atacado_so_aparecem_quando_a_venda_os_cobraria()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        async Task<ProdutoPesquisado> Linha(string texto) => Assert.Single(await servico.PesquisarAsync(texto, ct: Ct));
        var agora = DateTimeOffset.UtcNow;

        // Varejo 3,49: o promocional de 2,99 vigente aparece; o vencido, o que ainda não começou e o maior não.
        await AjustarProdutoAsync(pdv, 123, p => p.PrecoPromocional = 2.99m);
        Assert.Equal((3.49m, 2.99m), ((await Linha("brahma")).Preco, (await Linha("brahma")).PrecoPromocional));
        await AjustarProdutoAsync(pdv, 123, p => (p.PromocaoInicio, p.PromocaoFim) = (agora.AddDays(-10), agora.AddDays(-1)));
        Assert.Null((await Linha("brahma")).PrecoPromocional);
        await AjustarProdutoAsync(pdv, 123, p => (p.PromocaoInicio, p.PromocaoFim) = (agora.AddDays(1), null));
        Assert.Null((await Linha("brahma")).PrecoPromocional);
        await AjustarProdutoAsync(pdv, 123, p => (p.PrecoPromocional, p.PromocaoInicio) = (3.99m, null));
        Assert.Null((await Linha("brahma")).PrecoPromocional);
        await AjustarProdutoAsync(pdv, 123, p => p.PrecoPromocional = 3.49m);
        Assert.Null((await Linha("brahma")).PrecoPromocional);

        // Varejo geral 6,99 e o da loja 6,49: a promoção geral de 6,79 não é cobrada (a loja já é menor) e não aparece;
        // a de 5,99 aparece. O atacado igual ou maior que o preço da loja também não.
        await AjustarProdutoAsync(pdv, 124, p => (p.PrecoPromocional, p.PrecoAtacado, p.QtdMinimaAtacado) = (6.79m, 6.59m, 12m));
        var heineken = await Linha("heineken");
        Assert.Equal((6.49m, null, null), (heineken.Preco, heineken.PrecoPromocional, heineken.PrecoAtacado));
        await AjustarProdutoAsync(pdv, 124, p => (p.PrecoPromocional, p.PrecoAtacado) = (5.99m, 6.19m));
        heineken = await Linha("heineken");
        Assert.Equal((5.99m, 6.19m), (heineken.PrecoPromocional, heineken.PrecoAtacado));

        // O combo não recebe atacado (PDV 10.9.1): o atacado do cadastro fica fora da linha.
        await AjustarProdutoAsync(pdv, 500, p => (p.PrecoAtacado, p.QtdMinimaAtacado) = (119.90m, 2m));
        Assert.Null((await Linha("combo de whisky")).PrecoAtacado);
        await ConferirIndiceAsync(pdv);
    }

    [AvaloniaFact]
    public async Task Resposta_de_um_filtro_velho_que_chega_depois_e_descartada()
    {
        CatalogoComTrava? trava = null;
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<ICatalogoProdutos>(sp =>
            trava = new CatalogoComTrava(sp.GetRequiredService<CatalogoLocal>())));
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Tecla(Key.F2);
        await pdv.EsperarFocoAsync("CampoPesquisa");
        var pesquisa = Assert.IsType<DialogoPesquisaViewModel>(venda.Dialogo);
        await pdv.EsperarAsync(() => pesquisa.Resultados.Count > 0, "a lista inicial");

        // "cer" fica presa no catálogo (o índice lento); o operador digita mais e "cerv lt" responde antes.
        var segura = trava!.Segurar("cer");
        var velha = pesquisa.AtualizarAsync("cer");
        await pesquisa.AtualizarAsync("cerv lt");
        Assert.Equal(3, pesquisa.Resultados.Count);

        // A resposta de "cer" (5 cervejas) chega por último: é descartada, a lista fica com a do último filtro.
        segura.SetResult();
        await velha;
        Assert.Equal(1, trava.Respondidas("cer"));
        Assert.Equal(3, pesquisa.Resultados.Count);
        Assert.All(pesquisa.Resultados, l => Assert.Contains("LT", l.Descricao, StringComparison.Ordinal));
        Assert.Same(pesquisa.Resultados[0], pesquisa.Selecionado);
        Assert.Null(pesquisa.Erro);
        Assert.False(pesquisa.ExibeEstoque);
    }

    /// <summary>O catálogo local com a pesquisa de um texto presa até o teste soltar (a resposta que chega fora de ordem).</summary>
    private sealed class CatalogoComTrava(CatalogoLocal real) : ICatalogoProdutos
    {
        private readonly Dictionary<string, TaskCompletionSource> _presas = new(StringComparer.Ordinal);
        private readonly Dictionary<string, int> _respondidas = new(StringComparer.Ordinal);

        public TaskCompletionSource Segurar(string texto)
        {
            var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            _presas[texto] = tcs;
            return tcs;
        }

        public int Respondidas(string texto) => _respondidas.GetValueOrDefault(texto);

        public async Task<IReadOnlyList<ProdutoPesquisado>> PesquisarAsync(string texto, int limite = 50, CancellationToken ct = default)
        {
            var linhas = await real.PesquisarAsync(texto, limite, ct);
            if (_presas.Remove(texto, out var presa))
            {
                await presa.Task;
            }

            _respondidas[texto] = Respondidas(texto) + 1;
            return linhas;
        }

        public Task<IReadOnlyList<ProdutoResolvido>> ResolverAsync(string codigo, CancellationToken ct = default) => real.ResolverAsync(codigo, ct);

        public Task<IReadOnlyList<ProdutoPesquisado>> PesquisarCodigoAsync(string digitos, int limite = 50, CancellationToken ct = default) =>
            real.PesquisarCodigoAsync(digitos, limite, ct);

        public Task<ProdutoVenda?> ObterAsync(Guid produtoId, CancellationToken ct = default) => real.ObterAsync(produtoId, ct);

        public Task<ComboResolvido?> ObterComboAsync(Guid kitId, CancellationToken ct = default) => real.ObterComboAsync(kitId, ct);
    }
}
