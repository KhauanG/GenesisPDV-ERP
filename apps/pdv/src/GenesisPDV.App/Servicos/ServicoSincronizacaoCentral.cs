using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// A aba 4 Sincronização da Central do PDV (bloco G7; plano 4; o pedido do dono de 04/11/2026, "vendas a copiar"): o que
/// ainda não foi confirmado pela nuvem, por que e desde quando, sem tocar no que é do ERP. Quem decide é este serviço, pelo
/// <see cref="AcessoCentral"/>: sem <c>pdv.diagnostico.ver</c> (a própria ou a emprestada pelo Ctrl+L), nada. A única ação
/// é <see cref="ReenviarAgora"/>, que só força o ciclo de envio que já existe (o "Sincronizar agora": idempotente, nada se
/// duplica). Não há descartar nem reprocessar no PDV: a recusada é decidida no ERP (Cadastros › PDVs / Terminais › este
/// caixa › Eventos com erro) e fica verde sozinha quando o ERP resolve. Os itens e os pagamentos de uma venda no detalhe
/// (<see cref="VendaDoDetalheAsync"/>) seguem a regra da aba 1 Vendas para o que já está na nuvem: a venda "a copiar"
/// (algum evento ainda não confirmado nem descartado) sempre, que é o pedido do dono; a confirmada (ou descartada) só com
/// <c>pdv.venda.consultar_historico</c> e dentro dos últimos <see cref="ConsultasHistoricoLocal.LimiteDias"/> dias (mais
/// antiga só no ERP): a visão "Todos os registros" pagina o outbox inteiro, que nunca é expurgado. Tudo offline.
/// </summary>
public sealed class ServicoSincronizacaoCentral(
    ConsultasSincronizacaoLocal consultas,
    IDbContextFactory<PdvDbContext> fabrica,
    IServicoSincronizacao sync,
    AcessoCentral acesso,
    ServicoHistoricoVendas historico,
    ServicoVenda vendas)
{
    public const string MensagemSemPermissao =
        "A sincronização detalhada pede quem pode ver o diagnóstico (pdv.diagnostico.ver): Ctrl+L Liberar.";

    public const string MensagemDemonstracao = "Terminal de demonstração: nada sobe nem desce.";

    public const string MensagemReenvio =
        "Reenvio pedido: o caixa manda agora o que está na fila, na ordem em que aconteceu, e confere no ERP as recusadas. " +
        "Nada se duplica (a nuvem reconhece o que já recebeu). A lista se atualiza sozinha.";

    /// <summary>Onde a recusada se resolve (C8): o PDV não descarta nem reprocessa.</summary>
    public const string OndeResolver =
        "Quem decide é o ERP: Cadastros › PDVs / Terminais › este caixa › Eventos com erro (reprocessar ou descartar). " +
        "Quando o ERP resolver, a venda fica verde aqui sozinha.";

    /// <summary>A venda que já está na nuvem, sem a permissão do histórico ou com mais de 30 dias: os itens ficam fora.</summary>
    public const string MensagemItensForaDoAlcance =
        "Itens e pagamentos: esta venda já está na nuvem. Veja na aba 1 Vendas (o caixa aberto e, com a permissão do " +
        "histórico, os últimos 30 dias) ou no ERP (Vendas).";

    /// <summary>O recusado por conteúdo divergente (SYNC 8.4) não passa pela fila de decisão: é com o suporte.</summary>
    public const string OndeResolverDivergente =
        "A nuvem tem outro registro com o mesmo número: chame o suporte com o código do terminal (aba 9 Sobre o terminal).";

    /// <summary>A pessoa na Central vê a sincronização detalhada (a permissão dela ou a emprestada pela liberação ativa).</summary>
    public bool VeDiagnostico => acesso.Tem(PermissoesPdv.VerDiagnostico);

    public SituacaoSincronizacao Situacao => sync.Situacao;

    public async Task<PaginaVendasNaoConfirmadas> VendasNaoConfirmadasAsync(CursorNaoConfirmados? depois = null, CancellationToken ct = default)
    {
        Exigir();
        return await consultas.VendasNaoConfirmadasAsync(depois, ct: ct);
    }

    public async Task<VendasResolvidas> VendasResolvidasAsync(IReadOnlyCollection<Guid> vendas, CancellationToken ct = default)
    {
        Exigir();
        return await consultas.VendasResolvidasAsync(vendas, ct);
    }

    public async Task<ContagemRecusados> ContagemRecusadosAsync(CancellationToken ct = default)
    {
        Exigir();
        return await consultas.ContagemRecusadosAsync(ct);
    }

    /// <summary>
    /// A venda do detalhe (itens e pagamentos), ou o porquê de não vir: a "a copiar" (<paramref name="aCopiar"/>: algum
    /// evento dela ainda não confirmado nem descartado) sempre; a que a nuvem já tem, só com o histórico
    /// (<c>pdv.venda.consultar_historico</c>, a própria ou a emprestada) e de <paramref name="hora"/> dentro dos últimos
    /// 30 dias, contados pelo dia operacional como na aba 1 (<see cref="ServicoHistoricoVendas.Desde"/>).
    /// </summary>
    public async Task<(Core.Vendas.Venda? Venda, string? SemVenda)> VendaDoDetalheAsync(
        Guid vendaId, bool aCopiar, DateTimeOffset? hora, CancellationToken ct = default)
    {
        Exigir();
        if (!aCopiar && !(historico.VeHistorico && hora is { } h && h >= historico.Desde()))
        {
            return (null, MensagemItensForaDoAlcance);
        }

        try
        {
            return (await vendas.ObterVendaAsync(vendaId, ct), null);
        }
        catch (RegraNegocioException e)
        {
            return (null, e.Message);
        }
    }

    public async Task<PaginaCaixaNaoConfirmado> CaixaNaoConfirmadoAsync(CursorNaoConfirmados? depois = null, CancellationToken ct = default)
    {
        Exigir();
        return await consultas.CaixaNaoConfirmadoAsync(depois, ct: ct);
    }

    public async Task<PaginaEventos> EventosAsync(FiltroEventos filtro, long? depois = null, CancellationToken ct = default)
    {
        Exigir();
        return await consultas.EventosAsync(filtro, depois, ct: ct);
    }

    public async Task<IReadOnlyList<string>> TiposAsync(SituacaoFiltroEvento situacao, CancellationToken ct = default)
    {
        Exigir();
        return await consultas.TiposAsync(situacao, ct);
    }

    public async Task<IReadOnlyDictionary<Guid, AgregadoSincronizacao>> AgregadosAsync(IReadOnlyCollection<EventoSincronizacao> eventos, CancellationToken ct = default)
    {
        Exigir();
        return await consultas.AgregadosAsync(eventos, ct);
    }

    public async Task<DetalheSincronizacao?> DetalheAsync(Guid agregadoId, CancellationToken ct = default)
    {
        Exigir();
        return await consultas.DetalheAsync(agregadoId, ct);
    }

    public async Task<(IReadOnlyList<ComandoSincronizacao> Comandos, int Quantidade)> ComandosAsync(CancellationToken ct = default)
    {
        Exigir();
        return await consultas.ComandosAsync(ct);
    }

    /// <summary>O status do F11 › S (últimas trocas com a nuvem, cursores, quarentena), do banco local.</summary>
    public async Task<StatusDetalhadoSync> StatusAsync(CancellationToken ct = default)
    {
        Exigir();
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await StatusDetalhadoSync.LerAsync(db, ct);
    }

    /// <summary>
    /// "Reenviar agora": o mesmo "Sincronizar agora" da venda (Ctrl+Alt+S, PDV 30.2) — push, heartbeat, pull e a consulta
    /// das recusadas no ERP na hora. Não muda nenhum evento: o envio é o de sempre (o mesmo lote, a mesma ordem; a espera
    /// que a nuvem pediu continua valendo). Devolve a frase para a tela.
    /// </summary>
    public string ReenviarAgora()
    {
        Exigir();
        if (sync.Situacao.SemNuvem)
        {
            return MensagemDemonstracao;
        }

        sync.SincronizarAgora();
        return MensagemReenvio;
    }

    private void Exigir()
    {
        if (!VeDiagnostico)
        {
            throw new RegraNegocioException(MensagemSemPermissao);
        }
    }
}
