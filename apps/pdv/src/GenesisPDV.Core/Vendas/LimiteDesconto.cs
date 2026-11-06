namespace GenesisPDV.Core.Vendas;

/// <summary>Limite de desconto de um usuário (operador ou supervisor), PDV 12.3.</summary>
public static class LimiteDesconto
{
    public const decimal Master = 100m;

    /// <summary>Usuário Master = 100%, qualquer que seja <c>usuarios.limite_desconto_pct</c> (padrão 0 no MD).</summary>
    public static decimal DoUsuario(decimal limiteDescontoPct, bool master) => master ? Master : limiteDescontoPct;
}
