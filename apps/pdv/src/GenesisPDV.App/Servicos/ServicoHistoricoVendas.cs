using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Repositorios;

namespace GenesisPDV.App.Servicos;

/// <summary>Um operador ou uma forma de pagamento no filtro da aba Vendas.</summary>
public sealed record OpcaoFiltroVenda(Guid? Id, string Nome);

/// <summary>
/// A aba Vendas da Central do PDV (bloco G5; plano 4.2; decisões do dono de 04/11/2026): a regra de quem vê o quê sobre a
/// <see cref="ConsultasHistoricoLocal"/>. Quem decide é este serviço, pelo <see cref="AcessoCentral"/> (a tela não passa
/// a permissão): sem <c>pdv.venda.consultar_historico</c> na Central (a própria ou a emprestada pela liberação), só o
/// caixa aberto deste terminal, mesmo que a tela peça outro; com ela, também os caixas fechados deste terminal nos últimos
/// <see cref="ConsultasHistoricoLocal.LimiteDias"/> dias, contados pelo dia operacional (o fuso e a hora de corte da loja).
/// A soma das pagas só para quem vê o calculado do caixa (<c>pdv.caixa.ver_calculado_fechamento</c> do próprio usuário,
/// O3; a liberação não empresta). O teto de dias fica no SQL (Data). Tudo offline. Fora da Central (sem usuário), nada
/// além do caixa aberto.
/// </summary>
public sealed class ServicoHistoricoVendas(ConsultasHistoricoLocal consultas, SessaoTerminal sessao, ServicoCaixa caixa, AcessoCentral acesso)
{
    private Guid TerminalId => sessao.Identidade?.TerminalId ?? throw new InvalidOperationException("Terminal não ativado.");

    /// <summary>A pessoa na Central vê os caixas fechados (a permissão dela ou a emprestada pela liberação ativa).</summary>
    public bool VeHistorico => acesso.Tem(PermissoesPdv.ConsultarHistoricoVendas);

    /// <summary>A pessoa na Central vê a soma das pagas (o calculado do caixa, O3): só a permissão do próprio usuário.</summary>
    public bool SomaPagas => acesso.Usuario?.Tem(PermissoesPdv.VerCalculadoFechamento) == true;

    /// <summary>
    /// O começo do dia operacional mais antigo que a Central mostra: hoje e os 29 dias anteriores (30 dias, contando
    /// hoje), a partir da hora de corte.
    /// </summary>
    public DateTimeOffset Desde()
    {
        var (fuso, corte, hoje) = caixa.DiaOperacionalAtual();
        return DiaOperacional.Inicio(hoje.AddDays(-(ConsultasHistoricoLocal.LimiteDias - 1)), fuso, corte);
    }

    /// <summary>O caixa aberto e, com o histórico (<see cref="VeHistorico"/>), os fechados nos últimos 30 dias (o mais novo primeiro).</summary>
    public async Task<IReadOnlyList<CaixaConsultavel>> CaixasAsync(CancellationToken ct = default)
    {
        var historico = VeHistorico;
        var caixas = await consultas.CaixasAsync(TerminalId, Desde(), ct);
        return historico ? caixas : [.. caixas.Where(c => c.Aberto)];
    }

    /// <summary>
    /// Uma página das vendas com o filtro. Sem o histórico (<see cref="VeHistorico"/>), o caixa é sempre o aberto (sem
    /// caixa aberto, nada), seja qual for o <see cref="FiltroVendas.SessaoId"/> pedido. A soma das pagas vem na primeira
    /// página, só para quem vê o calculado do caixa (<see cref="SomaPagas"/>, O3).
    /// </summary>
    public async Task<PaginaVendas> VendasAsync(FiltroVendas filtro, CursorVendas? depois = null, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(filtro);
        var somarPagas = SomaPagas && depois is null;
        if (!VeHistorico)
        {
            if (await consultas.CaixaAbertoAsync(TerminalId, ct) is not { } aberto)
            {
                return new PaginaVendas([], 0, null, somarPagas ? 0m : null);
            }

            filtro = filtro with { SessaoId = aberto };
        }

        return await consultas.VendasAsync(TerminalId, Desde(), filtro, depois, somarPagas: somarPagas, ct: ct);
    }

    /// <summary>"Todos" e os operadores com venda no alcance (só o caixa aberto sem o histórico), pelo nome.</summary>
    public async Task<IReadOnlyList<OpcaoFiltroVenda>> OperadoresAsync(CancellationToken ct = default)
    {
        var (historico, sessaoId) = await AlcanceAsync(ct);
        var ids = !historico && sessaoId is null ? [] : await consultas.OperadoresAsync(TerminalId, Desde(), sessaoId, ct);
        var nomes = new List<OpcaoFiltroVenda>();
        foreach (var id in ids)
        {
            nomes.Add(new OpcaoFiltroVenda(id, await caixa.NomeUsuarioAsync(id, ct)));
        }

        return [new OpcaoFiltroVenda(null, "Todos"), .. nomes.OrderBy(n => n.Nome, StringComparer.CurrentCulture)];
    }

    /// <summary>"Todas" e as formas usadas no alcance (só o caixa aberto sem o histórico).</summary>
    public async Task<IReadOnlyList<OpcaoFiltroVenda>> FormasAsync(CancellationToken ct = default)
    {
        var (historico, sessaoId) = await AlcanceAsync(ct);
        var formas = !historico && sessaoId is null ? [] : await consultas.FormasAsync(TerminalId, Desde(), sessaoId, ct);
        return [new OpcaoFiltroVenda(null, "Todas"), .. formas.Select(f => new OpcaoFiltroVenda(f.Id, f.Descricao))];
    }

    public Task<string> NomeUsuarioAsync(Guid usuarioId, CancellationToken ct = default) => caixa.NomeUsuarioAsync(usuarioId, ct);

    /// <summary>Com o histórico, todos os caixas consultáveis (sessão nula); sem ele, só o aberto (nulo = nenhum).</summary>
    private async Task<(bool Historico, Guid? SessaoId)> AlcanceAsync(CancellationToken ct) =>
        VeHistorico ? (true, null) : (false, await consultas.CaixaAbertoAsync(TerminalId, ct));
}
