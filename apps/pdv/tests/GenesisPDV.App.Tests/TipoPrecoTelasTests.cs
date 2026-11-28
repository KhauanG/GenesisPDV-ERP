using System.Text.Json.Nodes;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Atalhos;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// <c>F8</c> Tipo de preço no caixa (PDV 11.2; Fase 3, F3-B17; F3-Q2), só pelo teclado: a MARIA da demonstração não tem
/// <c>pdv.venda.tipo_preco_atacado</c> (o supervisor libera o Atacado), a tela marca o tipo ativo, a venda finalizada leva
/// <c>vendas.tipo_preco = 'atacado'</c> e a liberação <c>tipo_preco</c>; sem o recurso da onda a tecla bipa.
/// </summary>
public class TipoPrecoTelasTests
{
    private static readonly Guid Lata = Guid.Parse("019a0001-0000-7000-8000-000000000410");
    private static readonly Guid Agua = Guid.Parse("019a0001-0000-7000-8000-000000000411");
    private static readonly Guid Un = Guid.Parse("019a0006-0000-7000-8000-000000000001");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    /// <summary>"CERV TESTE LT 350ML" 3,49 com atacado 12+ a 3,19 e "ÁGUA TESTE 500ML" 2,50 sem atacado.</summary>
    private static Task CadastrarAsync(AmbienteUi pdv)
    {
        var agora = DateTimeOffset.UtcNow;
        LinhaEspelho[] linhas =
        [
            new ProdutoRegistro
            {
                Id = Lata, Codigo = 410, CodigoInterno = "0410", Nome = "CERV TESTE LT 350ML", UnidadeId = Un, PrecoVenda = 3.49m,
                PrecoAtacado = 3.19m, QtdMinimaAtacado = 12m,
            },
            new ProdutoRegistro { Id = Agua, Codigo = 411, CodigoInterno = "0411", Nome = "ÁGUA TESTE 500ML", UnidadeId = Un, PrecoVenda = 2.50m },
        ];
        foreach (var linha in linhas)
        {
            linha.CriadoEm = linha.AtualizadoEm = agora;
            linha.Versao = 1;
        }

        return pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(linhas, Ct);
    }

    private static async Task<List<LogAuditoriaLocal>> AuditoriaAsync(AmbienteUi pdv, string acao)
    {
        await using var db = Banco(pdv);
        return await db.LogAuditoriaLocal.AsNoTracking().Where(l => l.Acao == acao).ToListAsync(Ct);
    }

    private static void PerfilDaMaria(AmbienteUi pdv, Func<IReadOnlySet<string>, IEnumerable<string>> mudar)
    {
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>();
        var maria = sessao.Operador!;
        sessao.Operador = maria with { Permissoes = new HashSet<string>(mudar(maria.Permissoes ?? new HashSet<string>()), StringComparer.Ordinal) };
    }

    [AvaloniaFact]
    public async Task F8_sem_a_permissao_o_supervisor_libera_o_atacado_e_a_venda_sobe_com_o_tipo()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);
        Assert.False(pdv.Servicos.GetRequiredService<SessaoTerminal>().Operador!.Tem(PermissoesPdv.TipoPrecoAtacado));
        Assert.True(venda.TemAcao(AcoesAtalho.TipoPreco));
        Assert.Contains(venda.Atalhos, b => b.Tecla == "F8");

        await pdv.EntrarCodigoAsync("3*0410");
        await pdv.EntrarCodigoAsync("0411");
        Assert.Equal("12,97", pdv.Texto("TextoTotal"));
        Assert.Null(venda.TipoPrecoAtivoTexto);

        pdv.Tecla(Key.F8);
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var liberacao = Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
        Assert.Contains("ATACADO", liberacao.Pedido.Titulo, StringComparison.Ordinal);
        Assert.Equal(PermissoesPdv.TipoPrecoAtacado, liberacao.Pedido.Permissao);
        liberacao.Pedido.Usuario = "2";
        liberacao.Pedido.Pin = "4321";
        liberacao.Pedido.Motivo = "Bar do bairro";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "atacado liberado");

        // As latas no atacado sem o "12+"; a água sem atacado fica no varejo; a tela marca o tipo.
        Assert.Equal(("3,19", "9,57"), (venda.Itens[0].Unitario, venda.Itens[0].Total));
        Assert.Equal("2,50", venda.Itens[1].Unitario);
        Assert.Equal("12,07", pdv.Texto("TextoTotal"));
        Assert.Equal("PREÇO ATACADO (F8 volta ao varejo)", pdv.Texto("TextoTipoPrecoAtivo"));
        Assert.Contains("Preço: ATACADO", venda.CabecalhoVenda, StringComparison.Ordinal);
        Assert.Contains("1 item recalculado", venda.Mensagem, StringComparison.Ordinal);
        Assert.Contains("CARLOS", venda.Mensagem, StringComparison.OrdinalIgnoreCase);
        var alterado = Assert.Single(await AuditoriaAsync(pdv, "tipo_preco_alterado"));
        Assert.Equal("Bar do bairro", alterado.Motivo);
        Assert.Equal("atacado", JsonNode.Parse(alterado.Depois!)!["tipo_preco"]!.GetValue<string>());
        Assert.Equal("varejo", JsonNode.Parse(alterado.Antes!)!["tipo_preco"]!.GetValue<string>());
        Assert.Single(await AuditoriaAsync(pdv, "liberacao"));
        pdv.Captura("93-tipo-preco-atacado");

        // Um item novo entra no atacado; a venda finalizada leva o tipo e a liberação.
        await pdv.EntrarCodigoAsync("0410");
        Assert.Equal("3,19", venda.Itens[2].Unitario);
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.CaixaLivre && venda.Dialogo is null, "venda finalizada");
        Assert.Null(venda.TipoPrecoAtivoTexto);

        await using var banco = Banco(pdv);
        Assert.Equal("atacado", (await banco.Vendas.AsNoTracking().SingleAsync(Ct)).TipoPreco);
        var evento = await banco.EventosSaida.SingleAsync(e => e.Tipo == "venda.finalizada", Ct);
        var payload = JsonNode.Parse(evento.Payload)!;
        Assert.Equal("atacado", payload["vendas"]!["tipo_preco"]!.GetValue<string>());
        var l = Assert.Single(payload["liberacoes"]!.AsArray())!;
        Assert.Equal(AcaoLiberacao.TipoPreco, l["acao"]!.GetValue<string>());
        Assert.Null(l["item_venda_id"]);
        var origens = payload["itens_venda"]!.AsArray()
            .Select(i => (i!["descricao"]!.GetValue<string>(), i["origem_preco"]!.GetValue<string>()))
            .ToList();
        Assert.Equal(
            [("CERV TESTE LT 350ML", "atacado"), ("ÁGUA TESTE 500ML", "varejo"), ("CERV TESTE LT 350ML", "atacado")],
            origens);
    }

    [AvaloniaFact]
    public async Task F8_com_a_permissao_alterna_sem_supervisor_e_a_proxima_venda_volta_ao_varejo()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);
        PerfilDaMaria(pdv, p => p.Append(PermissoesPdv.TipoPrecoAtacado));

        // Caixa livre: o F8 avisa (o tipo vale para a venda em andamento).
        pdv.Tecla(Key.F8);
        await pdv.EsperarAsync(() => venda.Mensagem?.Contains("primeiro item", StringComparison.Ordinal) == true, "caixa livre");

        await pdv.EntrarCodigoAsync("2*0410");
        pdv.Tecla(Key.F8);
        await pdv.EsperarAsync(() => venda.TipoPrecoAtivoTexto is not null, "atacado");
        Assert.Null(venda.Dialogo);
        Assert.Equal("6,38", pdv.Texto("TextoTotal"));
        Assert.Empty(await AuditoriaAsync(pdv, "liberacao"));

        // F8 de novo volta ao varejo, sem permissão nem supervisor.
        pdv.Tecla(Key.F8);
        await pdv.EsperarAsync(() => venda.TipoPrecoAtivoTexto is null, "varejo");
        Assert.Equal("6,98", pdv.Texto("TextoTotal"));
        Assert.Equal(2, (await AuditoriaAsync(pdv, "tipo_preco_alterado")).Count);

        // No atacado de novo, a venda finalizada não leva o tipo para a próxima.
        pdv.Tecla(Key.F8);
        await pdv.EsperarAsync(() => venda.TipoPrecoAtivoTexto is not null, "atacado de novo");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.CaixaLivre && venda.Dialogo is null, "venda finalizada");
        await pdv.EntrarCodigoAsync("0410");
        Assert.Equal("3,49", Assert.Single(venda.Itens).Unitario);
        Assert.Null(venda.TipoPrecoAtivoTexto);
        Assert.Contains("Preço: VAREJO", venda.CabecalhoVenda, StringComparison.Ordinal);

        // Nem a cancelada (Ctrl+N › C): a venda seguinte começa no varejo.
        PerfilDaMaria(pdv, p => p.Append(PermissoesPdv.CancelarVendaAberta));
        pdv.Tecla(Key.F8);
        await pdv.EsperarAsync(() => venda.TipoPrecoAtivoTexto is not null, "atacado na segunda venda");
        Assert.Equal("3,19", Assert.Single(venda.Itens).Unitario);
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        pdv.Tecla(Key.N, RawInputModifiers.Control);
        await pdv.EsperarFocoAsync("DialogoNovaVenda");
        pdv.Tecla(Key.C);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoMotivoCancelamentoViewModel, "motivo do cancelamento");
        pdv.Digitar("Cliente desistiu da compra no caixa");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && !servico.VendaAberta, "venda cancelada");
        Assert.Null(venda.TipoPrecoAtivoTexto);
        await pdv.EntrarCodigoAsync("0410");
        Assert.Equal("3,49", Assert.Single(venda.Itens).Unitario);
        Assert.Equal(TipoPrecoVenda.Varejo, servico.Atual!.TipoPreco);
        Assert.Contains("Preço: VAREJO", venda.CabecalhoVenda, StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task F8_com_pagamento_lancado_e_recusado()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);
        PerfilDaMaria(pdv, p => p.Append(PermissoesPdv.TipoPrecoAtacado));
        await pdv.EntrarCodigoAsync("10*0410");
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        await servico.IniciarPagamentoAsync(Ct);
        var dinheiro = (await servico.FormasPagamentoAsync(Ct)).First(f => f.TipoForma == "dinheiro");
        await servico.LancarPagamentoAsync(dinheiro, 10m, ct: Ct);
        await servico.VoltarParaItensAsync(Ct);
        venda.AtualizarTela();

        pdv.Tecla(Key.F8);
        await pdv.EsperarAsync(() => venda.Mensagem?.Contains("pagamentos", StringComparison.Ordinal) == true, "recusado");
        Assert.True(venda.MensagemEhErro);
        Assert.Null(venda.TipoPrecoAtivoTexto);
        Assert.Equal("3,49", venda.Itens[0].Unitario);
    }

    [AvaloniaFact]
    public async Task Sem_o_recurso_da_onda_o_F8_bipa_e_fica_fora_da_barra()
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
        Assert.False(venda.TemAcao(AcoesAtalho.TipoPreco));
        Assert.DoesNotContain(venda.Atalhos, b => b.Tecla == "F8");

        await pdv.EntrarCodigoAsync("0410");
        pdv.Tecla(Key.F8);
        await pdv.EsperarAsync(() => venda.Mensagem?.Contains(VendaViewModel.MensagemAcaoIndisponivel, StringComparison.Ordinal) == true, "bipe");
        Assert.Equal(TipoPrecoVenda.Varejo, pdv.Servicos.GetRequiredService<ServicoVenda>().Atual!.TipoPreco);
        Assert.Empty(await AuditoriaAsync(pdv, "tipo_preco_alterado"));
    }

    [AvaloniaFact]
    public async Task Recurso_que_some_no_meio_da_venda_no_atacado_ainda_deixa_voltar_ao_varejo()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await CadastrarAsync(pdv);
        PerfilDaMaria(pdv, p => p.Append(PermissoesPdv.TipoPrecoAtacado));
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        await pdv.EntrarCodigoAsync("2*0410");
        pdv.Tecla(Key.F8);
        await pdv.EsperarAsync(() => venda.TipoPrecoAtivoTexto is not null, "atacado");
        Assert.Equal("6,38", pdv.Texto("TextoTotal"));

        // A API voltou de versão (o handshake deixa de anunciar a R3): o próximo pull relê o recurso, desligado.
        await using (var db = Banco(pdv))
        {
            var identidade = await db.IdentidadeTerminal.SingleAsync(Ct);
            identidade.UrlApi = "https://api.exemplo/";
            await db.SaveChangesAsync(Ct);
        }

        await venda.RecarregarAtalhosAsync();
        // A volta ao Varejo continua: a tecla e o botão ficam enquanto a venda está no Atacado.
        Assert.True(venda.TemAcao(AcoesAtalho.TipoPreco));
        var botao = Assert.Single(venda.Atalhos, b => b.Tecla == "F8");
        pdv.Tecla(Key.F8);
        await pdv.EsperarAsync(() => venda.TipoPrecoAtivoTexto is null, "varejo");
        Assert.Equal(TipoPrecoVenda.Varejo, servico.Atual!.TipoPreco);
        Assert.Equal("6,98", pdv.Texto("TextoTotal"));
        Assert.Equal("3,49", venda.Itens[0].Unitario);
        // A auditoria da volta fica no caixa até o recurso voltar (AcoesAuditoriaFase3).
        Assert.Equal(2, (await AuditoriaAsync(pdv, "tipo_preco_alterado")).Count);

        // De volta ao Varejo, o Atacado fecha de novo: o F8 sai da barra e bipa; o botão de antes não liga o Atacado.
        Assert.False(venda.TemAcao(AcoesAtalho.TipoPreco));
        Assert.DoesNotContain(venda.Atalhos, b => b.Tecla == "F8");
        pdv.Tecla(Key.F8);
        await pdv.EsperarAsync(() => venda.Mensagem?.Contains(VendaViewModel.MensagemAcaoIndisponivel, StringComparison.Ordinal) == true, "bipe");
        Assert.Equal(TipoPrecoVenda.Varejo, servico.Atual!.TipoPreco);
        venda.Mensagem = null;
        botao.Comando.Execute(null);
        await pdv.EsperarAsync(() => venda.Mensagem == VendaViewModel.MensagemAcaoIndisponivel, "botão antigo");
        Assert.Equal(TipoPrecoVenda.Varejo, servico.Atual!.TipoPreco);
        Assert.Equal(2, (await AuditoriaAsync(pdv, "tipo_preco_alterado")).Count);
    }
}
