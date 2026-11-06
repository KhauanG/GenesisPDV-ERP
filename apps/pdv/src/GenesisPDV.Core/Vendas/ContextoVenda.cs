namespace GenesisPDV.Core.Vendas;

/// <summary>Dados do terminal e da sessão de caixa que toda venda carrega (identidade_terminal + sessão aberta).</summary>
/// <param name="UsaPrecoVolume"><c>pdv.usa_preco_volume</c> ("Usa Produto Preço Volume"): habilita as faixas de preço por
/// quantidade do produto e do grupo (PDV 11.3 passos 6 e 6a).</param>
public sealed record ContextoVenda(
    Guid TerminalId,
    Guid LojaId,
    int LojaCodigo,
    Guid CaixaId,
    int NumeroCaixa,
    Guid? SessaoCaixaId,
    string FusoHorario = Comum.DiaOperacional.FusoPadrao,
    TimeOnly HoraCorteDiaOperacional = default,
    bool UsaPrecoVolume = false);
