using System.Globalization;
using GenesisPDV.Data.Convencoes;

namespace GenesisPDV.Sync.Protocolo;

/// <summary>Formatos do JSON do protocolo (sincronizacao.md 2.3): decimal como string na escala da coluna, UUID minúsculo, ISO-8601 UTC.</summary>
public static class FormatoProtocolo
{
    public static string Decimal(decimal valor, int casas) =>
        decimal.Round(valor, casas).ToString("F" + casas.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);

    public static string Dinheiro(decimal valor) => Decimal(valor, Escalas.Dinheiro);

    public static string Preco(decimal valor) => Decimal(valor, Escalas.Preco);

    public static string Quantidade(decimal valor) => Decimal(valor, Escalas.Quantidade);

    public static string Percentual(decimal valor) => Decimal(valor, Escalas.Percentual);

    public static string Uuid(Guid id) => id.ToString("D");

    public static string? Uuid(Guid? id) => id?.ToString("D");

    public static string DataHora(DateTimeOffset instante) => DataHoraUtcTexto.Formatar(instante);

    public static string? DataHora(DateTimeOffset? instante) => instante is { } i ? DataHoraUtcTexto.Formatar(i) : null;

    public static string? Data(DateOnly? data) => data?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
