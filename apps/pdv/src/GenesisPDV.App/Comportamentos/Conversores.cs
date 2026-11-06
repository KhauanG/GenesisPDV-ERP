using Avalonia.Data.Converters;
using Avalonia.Media;

namespace GenesisPDV.App.Comportamentos;

/// <summary>Conversores simples usados nos modelos de linha (combo, etiquetas de preço).</summary>
public static class Conversores
{
    /// <summary>Opção indisponível aparece esmaecida ("desabilitada", PDV 10.9.1).</summary>
    public static readonly IValueConverter OpacoSeVerdadeiro = new FuncValueConverter<bool, double>(v => v ? 1.0 : 0.45);

    public static readonly IValueConverter NegritoSeVerdadeiro = new FuncValueConverter<bool, FontWeight>(v => v ? FontWeight.Bold : FontWeight.Normal);
}
