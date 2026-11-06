using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Vendas;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// Diminuir a quantidade (F3, janela do item, "−") sem poder cancelar item sozinho (PDV 13.1, decisão 65): a redução é um
/// cancelamento parcial e a tela pede o supervisor (<c>pdv.venda.cancelar_item</c>); liberado, cancela
/// <see cref="Quantidade"/> do item <see cref="Sequencia"/> com a liberação (<see cref="ServicoVenda.CancelarItemAsync"/>).
/// </summary>
public sealed class ReducaoExigeLiberacaoException(ItemVenda item, decimal quantidade)
    : RegraNegocioException(
        $"Tirar {NumeroBr.Quantidade(quantidade)} {item?.Unidade} do item {item?.Sequencia} é cancelar parte do item: sem a permissão de cancelar item, o supervisor libera.")
{
    public int Sequencia { get; } = item?.Sequencia ?? throw new ArgumentNullException(nameof(item));

    /// <summary>Quantidade a cancelar (a atual menos a nova).</summary>
    public decimal Quantidade { get; } = quantidade;

    /// <summary>O que o supervisor vê no pedido: o item, a descrição, o que sai e quanto vale hoje.</summary>
    public string Acao { get; } =
        $"Cancelar {NumeroBr.Quantidade(quantidade)} {item!.Unidade} do item {item.Sequencia} — {item.Descricao} (de {NumeroBr.Quantidade(item.Quantidade)}, R$ {NumeroBr.Dinheiro(item.ValorLiquido)})";
}
