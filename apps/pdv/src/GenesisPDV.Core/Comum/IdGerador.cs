namespace GenesisPDV.Core.Comum;

/// <summary>UUID v7 (ADR-04): ordenado por tempo e gerado offline sem risco de colisão.</summary>
public static class IdGerador
{
    public static Guid Novo() => Guid.CreateVersion7();
}
