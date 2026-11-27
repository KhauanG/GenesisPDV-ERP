using System.Text.Json;
using System.Text.RegularExpressions;
using GenesisPDV.Core.Atalhos;

namespace GenesisPDV.Core.Tests;

/// <summary>
/// O mapa de atalhos do caixa (F3-B13; PDV 28.1–28.3; MD 3.10.2, 7.8): o padrão de cada ação é o seed da nuvem, a tecla
/// é a mesma regra do ERP (os vetores do shared), a linha da loja vale sobre a da empresa, a tecla recusada ou repetida
/// que chegar da nuvem cai na padrão com o alerta, e o CONCLUIR e o menu de Funções não se desligam.
/// </summary>
public class MapaAtalhosTests
{
    private static readonly Guid Loja = Guid.Parse("019a0001-0000-7000-8000-000000000001");
    private static readonly Guid OutraLoja = Guid.Parse("019a0001-0000-7000-8000-000000000002");

    private static string Fixture(params string[] caminho) =>
        File.ReadAllText(Path.Combine([AppContext.BaseDirectory, "fixtures", .. caminho]));

    public static TheoryData<string> Entradas()
    {
        var d = new TheoryData<string>();
        foreach (var v in JsonDocument.Parse(Fixture("sync", "atalhos.teclas.vetores.json")).RootElement.GetProperty("teclas").EnumerateArray())
        {
            d.Add(v.GetProperty("entrada").GetString()!);
        }

        return d;
    }

    [Theory]
    [MemberData(nameof(Entradas))]
    public void A_tecla_e_a_mesma_que_o_erp_grava(string entrada)
    {
        var vetor = JsonDocument.Parse(Fixture("sync", "atalhos.teclas.vetores.json")).RootElement.GetProperty("teclas").EnumerateArray()
            .First(v => v.GetProperty("entrada").GetString() == entrada);
        var esperado = vetor.GetProperty("esperado").ValueKind == JsonValueKind.Null ? null : vetor.GetProperty("esperado").GetString();
        Assert.Equal(esperado, MapaAtalhos.NormalizarTecla(entrada));
    }

    [Fact]
    public void Concluir_venda_e_menu_de_funcoes_nao_se_desligam_e_sao_as_mesmas_do_erp()
    {
        // As mesmas do ACOES_ATALHO_ESSENCIAIS do shared (que o ERP e a API recusam desligar).
        var vetores = JsonDocument.Parse(Fixture("sync", "atalhos.teclas.vetores.json")).RootElement.GetProperty("acoesEssenciais")
            .EnumerateArray().Select(v => v.GetString()!).ToList();
        Assert.Equal(vetores.Order(StringComparer.Ordinal), MapaAtalhos.Essenciais.Order(StringComparer.Ordinal));

        // Desligadas na nuvem (a da loja sobre a da empresa, ou gravada fora do ERP): ficam ligadas, na barra, com o alerta;
        // a tecla trocada vale, e a recusada cai na padrão com os dois alertas. A Ajuda desligada continua desligada.
        var mapa = MapaAtalhos.Montar(
            [
                new LinhaAtalho(null, AcoesAtalho.ConcluirVenda, "F10", false, 5),
                new LinhaAtalho(Loja, AcoesAtalho.MenuFuncoes, "Ctrl+U", false, 26),
                new LinhaAtalho(null, AcoesAtalho.Ajuda, "F1", false, 19),
            ],
            Loja);
        Assert.True(mapa.Da(AcoesAtalho.ConcluirVenda).Habilitado);
        Assert.Equal(("Ctrl+U", true), (mapa.Da(AcoesAtalho.MenuFuncoes).Tecla, mapa.Da(AcoesAtalho.MenuFuncoes).Habilitado));
        Assert.False(mapa.Da(AcoesAtalho.Ajuda).Habilitado);
        var barra = mapa.Barra(_ => true, 99).Select(a => a.Acao).ToList();
        Assert.Contains(AcoesAtalho.ConcluirVenda, barra);
        Assert.Contains(AcoesAtalho.MenuFuncoes, barra);
        Assert.Equal(
            [(AcoesAtalho.ConcluirVenda, "F10", "F10"), (AcoesAtalho.MenuFuncoes, "Ctrl+U", "Ctrl+U")],
            mapa.Alertas.Select(a => (a.Acao, a.TeclaRecebida, a.TeclaAplicada)));
        Assert.All(mapa.Alertas, a => Assert.Equal(MapaAtalhos.MotivoEssencial, a.Motivo));

        var recusada = MapaAtalhos.Montar([new LinhaAtalho(null, AcoesAtalho.MenuFuncoes, "Alt+F4", false, 26)], Loja);
        Assert.Equal(("F11", true), (recusada.Da(AcoesAtalho.MenuFuncoes).Tecla, recusada.Da(AcoesAtalho.MenuFuncoes).Habilitado));
        Assert.Equal([MapaAtalhos.MotivoInvalida, MapaAtalhos.MotivoEssencial], recusada.Alertas.Select(a => a.Motivo));
        Assert.Equal("F11", recusada.Alertas[1].TeclaAplicada);

        // Ligada à força, entra na conta da tecla repetida: quem a usava fora da padrão volta à padrão dela.
        var repetida = MapaAtalhos.Montar(
            [
                new LinhaAtalho(null, AcoesAtalho.MenuFuncoes, "F11", false, 26),
                new LinhaAtalho(null, AcoesAtalho.GestaoVendas, "F11", true, 6),
            ],
            Loja);
        Assert.Equal(AcoesAtalho.MenuFuncoes, repetida.DaTecla("F11")!.Acao);
        Assert.Equal("F12", repetida.Da(AcoesAtalho.GestaoVendas).Tecla);
    }

    [Fact]
    public void O_catalogo_e_o_seed_da_nuvem_com_as_padroes_unicas_e_validas()
    {
        // O ATALHOS_PDV_PADRAO da API (MD 7.8): a mesma ação, tecla, habilitado e ordem, na mesma ordem.
        var seed = Fixture("api", "tabelas-md.ts");
        var bloco = seed[seed.IndexOf("ATALHOS_PDV_PADRAO", StringComparison.Ordinal)..];
        bloco = bloco[..bloco.IndexOf("];", StringComparison.Ordinal)];
        var linhas = Regex.Matches(bloco, @"ordem:\s*(\d+),\s*acao:\s*'([a-z_]+)',\s*tecla:\s*'([^']+)',\s*habilitado:\s*(true|false)")
            .Select(m => (Ordem: int.Parse(m.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture), Acao: m.Groups[2].Value,
                Tecla: m.Groups[3].Value, Habilitado: m.Groups[4].Value == "true"))
            .ToList();
        Assert.Equal(36, linhas.Count);
        Assert.Equal(linhas, MapaAtalhos.Catalogo.Select(a => (a.Ordem, a.Acao, a.Tecla, a.Habilitado)));
        Assert.All(MapaAtalhos.Catalogo, a => Assert.Equal(a.Tecla, MapaAtalhos.NormalizarTecla(a.Tecla)));
        Assert.Equal(MapaAtalhos.Catalogo.Count, MapaAtalhos.Catalogo.Select(a => a.Tecla.ToUpperInvariant()).Distinct().Count());
    }

    [Fact]
    public void Sem_linhas_vale_o_padrao_por_ordem()
    {
        var mapa = MapaAtalhos.Montar([], Loja);
        Assert.Empty(mapa.Alertas);
        Assert.All(mapa.Atalhos, a => Assert.Equal(OrigemAtalho.Padrao, a.Origem));
        Assert.Equal(AcoesAtalho.PesquisarProduto, mapa.Atalhos[0].Acao);
        Assert.Equal(AcoesAtalho.RemoverItem, mapa.DaTecla("F4")!.Acao);
        Assert.Equal(AcoesAtalho.CancelarVenda, mapa.DaTecla("Shift+F4")!.Acao);
        // F9 desabilitado: a tecla continua da ação (só bipa), e ela não entra na barra.
        Assert.False(mapa.DaTecla("F9")!.Habilitado);
        Assert.DoesNotContain(mapa.Barra(_ => true, 99), a => a.Acao == AcoesAtalho.PedidosOrcamentos);
        Assert.Equal(MapaAtalhos.Padrao.Assinatura, mapa.Assinatura);
    }

    [Fact]
    public void Remover_item_em_Ctrl_R_tira_o_F4_e_a_loja_vale_sobre_a_empresa()
    {
        // Critério 28.4: a tecla trocada no ERP vale depois do pull, e o F4 deixa de fazer a ação.
        var mapa = MapaAtalhos.Montar([new LinhaAtalho(null, AcoesAtalho.RemoverItem, "Ctrl+R", true, 2)], Loja);
        Assert.Equal(("Ctrl+R", OrigemAtalho.Empresa), (mapa.Da(AcoesAtalho.RemoverItem).Tecla, mapa.Da(AcoesAtalho.RemoverItem).Origem));
        Assert.Equal(AcoesAtalho.RemoverItem, mapa.DaTecla("ctrl+r")!.Acao);
        Assert.Null(mapa.DaTecla("F4"));
        Assert.NotEqual(MapaAtalhos.Padrao.Assinatura, mapa.Assinatura);

        var comLoja = MapaAtalhos.Montar(
            [
                new LinhaAtalho(null, AcoesAtalho.RemoverItem, "Ctrl+R", true, 2),
                new LinhaAtalho(Loja, AcoesAtalho.RemoverItem, "Ctrl+E", false, 40),
                new LinhaAtalho(OutraLoja, AcoesAtalho.RemoverItem, "Ctrl+K", true, 2),
            ],
            Loja);
        var remover = comLoja.Da(AcoesAtalho.RemoverItem);
        Assert.Equal(("Ctrl+E", false, 40, OrigemAtalho.Loja), (remover.Tecla, remover.Habilitado, remover.Ordem, remover.Origem));
        Assert.Equal(AcoesAtalho.RemoverItem, comLoja.Atalhos[^1].Acao);
        Assert.Null(comLoja.DaTecla("Ctrl+K"));
        Assert.Empty(comLoja.Alertas);
    }

    [Theory]
    [InlineData("Alt+F4")]
    [InlineData("Ctrl+Alt+Del")]
    [InlineData("Ctrl+Alt+T")]
    [InlineData("Enter")]
    [InlineData("R")]
    [InlineData("")]
    public void Tecla_proibida_ou_invalida_cai_na_padrao_com_alerta(string tecla)
    {
        var mapa = MapaAtalhos.Montar([new LinhaAtalho(null, AcoesAtalho.GestaoVendas, tecla, true, 6)], Loja);
        var gestao = mapa.Da(AcoesAtalho.GestaoVendas);
        Assert.Equal(("F12", tecla), (gestao.Tecla, gestao.TeclaRecusada));
        var alerta = Assert.Single(mapa.Alertas);
        Assert.Equal((AcoesAtalho.GestaoVendas, tecla, "F12", MapaAtalhos.MotivoInvalida), (alerta.Acao, alerta.TeclaRecebida, alerta.TeclaAplicada, alerta.Motivo));
    }

    [Fact]
    public void Tecla_repetida_entre_loja_e_empresa_volta_a_padrao_de_quem_mudou()
    {
        // A loja põe a Gestão de vendas no F4, que o Remover item da empresa já usa: a Gestão (fora da padrão) volta ao F12.
        var mapa = MapaAtalhos.Montar([new LinhaAtalho(Loja, AcoesAtalho.GestaoVendas, "F4", true, 6)], Loja);
        Assert.Equal("F12", mapa.Da(AcoesAtalho.GestaoVendas).Tecla);
        Assert.Equal(AcoesAtalho.RemoverItem, mapa.DaTecla("F4")!.Acao);
        var alerta = Assert.Single(mapa.Alertas);
        Assert.Equal((AcoesAtalho.GestaoVendas, "F4", "F12", "tecla repetida com remover_item"), (alerta.Acao, alerta.TeclaRecebida, alerta.TeclaAplicada, alerta.Motivo));

        // As duas fora da padrão com a mesma tecla: as duas voltam; a desabilitada nunca briga.
        var duas = MapaAtalhos.Montar(
            [
                new LinhaAtalho(null, AcoesAtalho.RemoverItem, "Ctrl+R", true, 2),
                new LinhaAtalho(Loja, AcoesAtalho.GestaoVendas, "ctrl+r", true, 6),
                new LinhaAtalho(null, AcoesAtalho.Agenda, "Ctrl+R", false, 18),
            ],
            Loja);
        Assert.Equal(("F4", "F12"), (duas.Da(AcoesAtalho.RemoverItem).Tecla, duas.Da(AcoesAtalho.GestaoVendas).Tecla));
        Assert.Equal(2, duas.Alertas.Count);
        Assert.Equal(AcoesAtalho.Agenda, duas.DaTecla("Ctrl+R")!.Acao);

        // A troca em cadeia: o Remover vai para o F12 da Gestão, que fica na padrão; o Remover volta ao F4.
        var cadeia = MapaAtalhos.Montar([new LinhaAtalho(null, AcoesAtalho.RemoverItem, "F12", true, 2)], Loja);
        Assert.Equal(("F4", "F12"), (cadeia.Da(AcoesAtalho.RemoverItem).Tecla, cadeia.Da(AcoesAtalho.GestaoVendas).Tecla));
        Assert.All(cadeia.Atalhos.Where(a => a.Habilitado).GroupBy(a => a.Tecla, StringComparer.OrdinalIgnoreCase), g => Assert.Single(g));
    }

    [Fact]
    public void Acao_desconhecida_e_ignorada_e_a_barra_segue_a_ordem_ate_caber()
    {
        var mapa = MapaAtalhos.Montar(
            [
                new LinhaAtalho(null, "acao_de_outra_versao", "F2", true, 0),
                new LinhaAtalho(null, AcoesAtalho.MenuFuncoes, "F11", true, 0),
                new LinhaAtalho(null, AcoesAtalho.Ajuda, "F1", false, 19),
            ],
            Loja);
        Assert.Empty(mapa.Alertas);
        Assert.Equal(MapaAtalhos.Catalogo.Count, mapa.Atalhos.Count);
        Assert.Equal(AcoesAtalho.PesquisarProduto, mapa.DaTecla("F2")!.Acao);
        var barra = mapa.Barra(a => a.Acao != AcoesAtalho.TipoPreco, 3);
        Assert.Equal([AcoesAtalho.MenuFuncoes, AcoesAtalho.PesquisarProduto, AcoesAtalho.RemoverItem], barra.Select(a => a.Acao));
        Assert.DoesNotContain(mapa.Barra(_ => true, 99), a => a.Acao == AcoesAtalho.Ajuda);
    }
}
