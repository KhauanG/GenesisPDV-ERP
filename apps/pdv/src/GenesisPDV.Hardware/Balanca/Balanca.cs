namespace GenesisPDV.Hardware.Balanca;

/// <param name="PesoKg">Peso líquido em kg, com até 3 casas.</param>
public sealed record LeituraPeso(decimal PesoKg, bool Estavel);

/// <summary>Balança do caixa (PDV 6.5, 10.7): serial Toledo/Filizola na PDV-2.</summary>
public interface IBalanca
{
    /// <exception cref="FalhaBalancaException">Sem comunicação com a balança.</exception>
    Task<LeituraPeso> LerPesoAsync(CancellationToken ct = default);
}

public sealed class FalhaBalancaException(string mensagem) : Exception(mensagem);

/// <summary>Balança simulada: devolve o peso configurado; pode simular peso instável ou falta de comunicação.</summary>
public sealed class BalancaSimulada : IBalanca
{
    public decimal PesoKg { get; set; } = 0.795m;

    public bool Instavel { get; set; }

    public bool SemComunicacao { get; set; }

    public Task<LeituraPeso> LerPesoAsync(CancellationToken ct = default)
    {
        if (SemComunicacao)
        {
            throw new FalhaBalancaException("Balança sem comunicação.");
        }

        if (PesoKg < 0m)
        {
            throw new FalhaBalancaException("Peso negativo: zere (tare) a balança.");
        }

        return Task.FromResult(new LeituraPeso(decimal.Round(PesoKg, 3), !Instavel));
    }
}
