namespace GenesisPDV.Data.Convencoes;

/// <summary>
/// Escala da coluna <c>numeric(p,s)</c> da nuvem. Todo <see cref="decimal"/> mapeado precisa dela: o valor vai para o
/// SQLite como INTEGER escalado (modelo de dados 4.1).
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class EscalaAttribute(int casas) : Attribute
{
    public int Casas { get; } = casas;
}

/// <summary>Escalas padronizadas do modelo de dados 1.2.</summary>
public static class Escalas
{
    public const int Dinheiro = 2;
    public const int Preco = 4;
    public const int Quantidade = 3;
    public const int Percentual = 4;
}
