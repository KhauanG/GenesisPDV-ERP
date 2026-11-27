using System.Text.Json.Nodes;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Complementos no caixa (PDV 10.2; Fase 3, F3-B15), só pelo teclado: "Porção + 2 molhos" escolhida no diálogo, na tela,
/// no cupom e no evento (v2 com a baixa calculada no caixa), o mínimo e o máximo do grupo, o Esc que não inclui nada e o
/// portão do recurso da onda (sem o <c>venda.finalizada</c> v2 anunciado, o produto vende como antes, sem diálogo).
/// </summary>
public class ComplementosTelasTests
{
    private static readonly Guid Porcao = Guid.Parse("019a0001-0000-7000-8000-000000000300");
    private static readonly Guid Molho = Guid.Parse("019a0001-0000-7000-8000-000000000301");
    private static readonly Guid Cheddar = Guid.Parse("019a0001-0000-7000-8000-000000000302");
    private static readonly Guid Queijo = Guid.Parse("019a0001-0000-7000-8000-000000000303");
    private static readonly Guid Un = Guid.Parse("019a0006-0000-7000-8000-000000000001");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    /// <summary>
    /// "PORÇÃO DE FRITAS" 25,00: Molhos (obrigatório, de 1 a 2: o barbecue vinculado à matéria-prima com baixa de 0,050,
    /// rosé e mostarda livres) e Adicionais (opcional, até 2: o cheddar produzido, +4,50, e o bacon, +3,00).
    /// </summary>
    private static Task CadastrarPorcaoAsync(AmbienteUi pdv)
    {
        var agora = DateTimeOffset.UtcNow;
        var molhos = Guid.Parse("019a0013-0000-7000-8000-000000000001");
        var adicionais = Guid.Parse("019a0013-0000-7000-8000-000000000002");
        ProdutoRegistro P(Guid id, int codigo, string nome, decimal preco, string tipo) =>
            new() { Id = id, Codigo = codigo, CodigoInterno = $"{codigo:0000}", Nome = nome, UnidadeId = Un, PrecoVenda = preco, Tipo = tipo };
        ProdutoComplementoRegistro Opcao(int n, Guid grupo, Guid? produto, string? descricao, decimal adicional, bool baixa = false, decimal qtd = 1m) =>
            new()
            {
                Id = Guid.Parse($"019a0014-0000-7000-8000-{n:000000000000}"),
                GrupoId = grupo,
                ProdutoId = produto,
                Descricao = descricao,
                PrecoAdicional = adicional,
                BaixaEstoque = baixa,
                QuantidadeBaixa = qtd,
                Ordem = n,
                Ativo = true,
            };
        LinhaEspelho[] linhas =
        [
            P(Porcao, 300, "PORÇÃO DE FRITAS", 25.00m, "com_complementos"),
            P(Molho, 301, "MOLHO BARBECUE", 0m, "materia_prima"),
            P(Cheddar, 302, "CHEDDAR CREMOSO", 0m, "produzido"),
            P(Queijo, 303, "QUEIJO CHEDDAR KG", 0m, "materia_prima"),
            new ProdutoComponenteRegistro
            {
                Id = Guid.Parse("019a0010-0000-7000-8000-000000000300"), ProdutoId = Cheddar, Tipo = "ficha_tecnica", ComponenteId = Queijo,
                Quantidade = 0.080m, PerdaPct = 5m, Ordem = 1,
            },
            new ProdutoGrupoComplementosRegistro { Id = molhos, ProdutoId = Porcao, Nome = "Molhos", Minimo = 1, Maximo = 2, Obrigatorio = true, Ordem = 1 },
            new ProdutoGrupoComplementosRegistro { Id = adicionais, ProdutoId = Porcao, Nome = "Adicionais", Minimo = 0, Maximo = 2, Ordem = 2 },
            Opcao(1, molhos, Molho, null, 0m, baixa: true, qtd: 0.050m),
            Opcao(2, molhos, null, "Rosé", 0m),
            Opcao(3, molhos, null, "Mostarda e mel", 0m),
            Opcao(4, adicionais, Cheddar, null, 4.50m, baixa: true),
            Opcao(5, adicionais, null, "Bacon", 3.00m),
        ];
        foreach (var linha in linhas)
        {
            linha.CriadoEm = linha.AtualizadoEm = agora;
            linha.Versao = 1;
        }

        return pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(linhas, Ct);
    }

    /// <summary>O último handshake anunciou o <c>venda.finalizada</c> v2 (a release R3, F3-B30).</summary>
    private static async Task AnunciarV2Async(AmbienteUi pdv)
    {
        await using var db = Banco(pdv);
        var estado = await db.EstadoConexao.FirstOrDefaultAsync(Ct);
        if (estado is null)
        {
            estado = new EstadoConexao();
            db.EstadoConexao.Add(estado);
        }

        estado.VersoesSchemaNuvem = """{"venda.finalizada":[1,2],"venda.cancelada":[1]}""";
        await db.SaveChangesAsync(Ct);
    }

    [AvaloniaFact]
    public async Task Porcao_com_dois_molhos_e_cheddar_vende_imprime_e_sobe_na_v2_com_a_baixa_do_caixa()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarPorcaoAsync(pdv);
        await AnunciarV2Async(pdv);

        await pdv.EntrarCodigoAsync("2*0300");
        var dialogo = Assert.IsType<DialogoComplementosViewModel>(venda.Dialogo);
        await pdv.EsperarFocoAsync("DialogoComplementos");
        Assert.Equal("Molhos", dialogo.GrupoEmFoco!.Nome);
        Assert.Equal("Escolha de 1 a 2", dialogo.GrupoEmFoco.Regra);
        Assert.Equal("2 unidades: os mesmos complementos em cada uma", dialogo.QuantidadeTexto);
        Assert.Equal("▸ [ ] 1 MOLHO BARBECUE", dialogo.GrupoEmFoco.Opcoes[0].Texto);

        // Enter sem molho: o obrigatório pede ao menos 1; o terceiro molho passa do máximo.
        pdv.Tecla(Key.Enter);
        Assert.Equal("Escolha ao menos 1 opção em \"Molhos\".", dialogo.Erro);
        pdv.Tecla(Key.D1);
        pdv.Tecla(Key.Down);
        pdv.Tecla(Key.Space);
        pdv.Tecla(Key.D3);
        Assert.Equal("\"Molhos\": no máximo 2 opções.", dialogo.Erro);
        Assert.Equal("2 de no máximo 2", dialogo.GrupoEmFoco.Situacao);
        pdv.Captura("91-complementos-molhos");
        pdv.Tecla(Key.Enter);
        Assert.Equal("Adicionais", dialogo.GrupoEmFoco!.Nome);

        // Esc volta ao grupo anterior com as marcas; Enter de novo segue.
        pdv.Tecla(Key.Escape);
        Assert.Equal("Molhos", dialogo.GrupoEmFoco!.Nome);
        Assert.Equal(2, dialogo.GrupoEmFoco.QuantasMarcadas);
        pdv.Tecla(Key.Enter);
        pdv.Tecla(Key.NumPad1);
        Assert.Equal("Adicionais: +R$ 4,50 por unidade", pdv.Texto("TextoAdicionalComplementos"));
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "porção incluída");

        Assert.Equal("59,00", pdv.Texto("TextoTotal"));
        var linha = Assert.Single(venda.Itens);
        Assert.Equal(("29,50", "59,00"), (linha.Unitario, linha.Total));
        Assert.Equal("└ + MOLHO BARBECUE, + Rosé, + CHEDDAR CREMOSO (+4,50)", linha.Detalhe);
        Assert.Equal("PORÇÃO DE FRITAS incluído com 3 complemento(s).", pdv.Texto("TextoMensagem"));
        await using (var db = Banco(pdv))
        {
            Assert.Equal(3, await db.ItensVendaComplementos.CountAsync(Ct));
        }

        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.CaixaLivre && venda.Dialogo is null, "venda finalizada");
        var cupom = venda.UltimoCupom!;
        Assert.Contains("   + MOLHO BARBECUE\n   + Rosé\n   + CHEDDAR CREMOSO (+4,50)\n   2,000 UN x 29,50", cupom.Replace("\r", string.Empty, StringComparison.Ordinal));

        await using var banco = Banco(pdv);
        var evento = await banco.EventosSaida.SingleAsync(e => e.Tipo == "venda.finalizada", Ct);
        Assert.Equal(2, evento.VersaoSchema);
        var complementos = JsonNode.Parse(evento.Payload)!["itens_venda_complementos"]!.AsArray();
        Assert.Equal(["MOLHO BARBECUE", "Rosé", "CHEDDAR CREMOSO"], complementos.Select(c => c!["descricao"]!.GetValue<string>()));
        var baixa = Assert.Single(complementos.SelectMany(c => c!["componentes_estoque"]!.AsArray()))!;
        Assert.Equal((Queijo.ToString(), "0.168"), (baixa["produto_id"]!.GetValue<string>(), baixa["quantidade"]!.GetValue<string>()));
        Assert.Equal(["0.0000", "0.0000", "4.5000"], complementos.Select(c => c!["preco_adicional"]!.GetValue<string>()));
    }

    [AvaloniaFact]
    public async Task Tab_pula_o_obrigatorio_e_o_Enter_do_ultimo_grupo_volta_a_ele_sem_incluir()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarPorcaoAsync(pdv);
        await AnunciarV2Async(pdv);

        await pdv.EntrarCodigoAsync("0300");
        var dialogo = Assert.IsType<DialogoComplementosViewModel>(venda.Dialogo);
        await pdv.EsperarFocoAsync("DialogoComplementos");

        // Tab sai de Molhos sem marcar nada (não confere o grupo); o foco do teclado continua no diálogo.
        pdv.Tecla(Key.Tab);
        Assert.Equal("Adicionais", dialogo.GrupoEmFoco!.Nome);
        Assert.Equal("DialogoComplementos", pdv.NomeFocado());
        pdv.Tecla(Key.Tab, RawInputModifiers.Shift);
        Assert.Equal("Molhos", dialogo.GrupoEmFoco!.Nome);
        pdv.Tecla(Key.Tab);
        Assert.Equal("Adicionais", dialogo.GrupoEmFoco!.Nome);

        // Enter no último grupo confere os pulados: volta a Molhos com o motivo dele, e nada é incluído.
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => dialogo.Erro is not null, "motivo do grupo pulado");
        Assert.Equal("Escolha ao menos 1 opção em \"Molhos\".", dialogo.Erro);
        Assert.Equal("Molhos", dialogo.GrupoEmFoco!.Nome);
        Assert.Same(dialogo, venda.Dialogo);
        Assert.Empty(venda.Itens);
        Assert.Equal("DialogoComplementos", pdv.NomeFocado());

        // Marcado o molho, o Enter segue para Adicionais e o seguinte inclui.
        pdv.Tecla(Key.D2);
        pdv.Tecla(Key.Enter);
        Assert.Equal("Adicionais", dialogo.GrupoEmFoco!.Nome);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "porção incluída");
        Assert.Equal("└ + Rosé", Assert.Single(venda.Itens).Detalhe);
    }

    [AvaloniaFact]
    public async Task Esc_no_primeiro_grupo_nao_inclui_nada_e_sem_o_recurso_da_onda_vende_como_antes()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarPorcaoAsync(pdv);

        await pdv.EntrarCodigoAsync("0300");
        Assert.IsType<DialogoComplementosViewModel>(venda.Dialogo);
        await pdv.EsperarFocoAsync("DialogoComplementos");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "diálogo fechado");
        Assert.Empty(venda.Itens);
        Assert.True(venda.CaixaLivre);

        // Um terminal real sem o v2 no último handshake (o 0.13.0 da nuvem de hoje): sem diálogo, sem complementos.
        await using (var db = Banco(pdv))
        {
            var identidade = await db.IdentidadeTerminal.SingleAsync(Ct);
            identidade.UrlApi = "https://api.exemplo/";
            await db.SaveChangesAsync(Ct);
        }

        Assert.False(await pdv.Servicos.GetRequiredService<ServicoVenda>().ComplementosDisponiveisAsync(Ct));
        await pdv.EntrarCodigoAsync("0300");
        Assert.Null(venda.Dialogo);
        var item = Assert.Single(pdv.Servicos.GetRequiredService<ServicoVenda>().Atual!.ItensAtivos);
        Assert.Equal((25.00m, 0), (item.PrecoUnitario, item.Complementos.Count));
    }
}
