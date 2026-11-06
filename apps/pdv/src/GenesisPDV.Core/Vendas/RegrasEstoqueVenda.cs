using GenesisPDV.Core.Numeros;

namespace GenesisPDV.Core.Vendas;

/// <summary>Resultado da conferência do saldo estimado na inclusão (PDV 29.1).</summary>
public enum SituacaoEstoque
{
    Normal,

    /// <summary>Saldo estimado negativo, com o bloqueio desligado (O15 do dono): vende com aviso âmbar.</summary>
    Aviso,

    /// <summary>Com <c>pdv.bloqueia_venda_sem_estoque</c> (e online, ou com o bloqueio offline): pede o supervisor.</summary>
    Bloqueio,
}

/// <param name="Mensagem">"Estoque insuficiente: CERV BRAHMA LT 350ML (disponível: 3)"; nula no normal.</param>
public sealed record AvaliacaoEstoque(SituacaoEstoque Situacao, string? Mensagem)
{
    public static AvaliacaoEstoque Normal { get; } = new(SituacaoEstoque.Normal, null);
}

/// <summary>Chaves do bloqueio por saldo (PDV 29.1; SYNC 15.1). O15 do dono: as duas desligadas, só o aviso.</summary>
/// <param name="Bloqueia"><c>pdv.bloqueia_venda_sem_estoque</c> ou <c>vendas.valida_estoque</c>.</param>
/// <param name="BloqueiaOffline"><c>pdv.bloqueio_estoque_offline</c>: sem ela, offline o bloqueio vira aviso.</param>
public sealed record RegrasEstoque(bool Bloqueia, bool BloqueiaOffline)
{
    public static RegrasEstoque Padrao { get; } = new(false, false);
}

/// <summary>
/// Saldo na venda (PDV 29.1; SYNC 15.1–15.2): <c>saldo_estimado − quantidade da venda em andamento</c> negativo avisa
/// (âmbar) ou, com o bloqueio ligado, recusa com a liberação <c>pdv.venda.vender_sem_estoque</c>. A nuvem nunca recusa
/// a venda por saldo (gera <c>ESTOQUE_NEGATIVO</c>); offline, o bloqueio só vale com a chave própria, para o saldo velho
/// não parar a loja.
/// </summary>
public static class RegrasEstoqueVenda
{
    public static AvaliacaoEstoque Avaliar(string descricao, decimal saldoEstimado, decimal naVenda, RegrasEstoque regras, bool online)
    {
        ArgumentNullException.ThrowIfNull(regras);
        var disponivel = saldoEstimado - naVenda;
        if (disponivel >= 0m)
        {
            return AvaliacaoEstoque.Normal;
        }

        var texto = $"Estoque insuficiente: {descricao} (disponível: {NumeroBr.Quantidade(Math.Max(0m, saldoEstimado)).TrimEnd('0').TrimEnd(',')})";
        return regras.Bloqueia && (online || regras.BloqueiaOffline)
            ? new AvaliacaoEstoque(SituacaoEstoque.Bloqueio, texto + " — peça a liberação do supervisor.")
            : new AvaliacaoEstoque(SituacaoEstoque.Aviso, texto + " — confira a prateleira.");
    }
}

/// <summary>A inclusão passaria o saldo com o bloqueio ligado (29.1): a tela oferece a liberação do supervisor.</summary>
public sealed class EstoqueInsuficienteException(string mensagem, Guid produtoId) : Comum.RegraNegocioException(mensagem)
{
    public Guid ProdutoId { get; } = produtoId;
}
