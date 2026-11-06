namespace GenesisPDV.Core.Comum;

/// <summary>
/// Dia operacional (modelo de dados 1.2): data de (instante no fuso da loja − hora de corte).
/// Ex.: com corte 05:00, uma venda às 02:30 de 30/10 pertence ao dia 29/10.
/// </summary>
public static class DiaOperacional
{
    public const string FusoPadrao = "America/Sao_Paulo";

    public static DateOnly Calcular(DateTimeOffset instante, TimeZoneInfo fuso, TimeOnly horaCorte)
    {
        var local = TimeZoneInfo.ConvertTime(instante, fuso);
        var deslocado = local.DateTime - horaCorte.ToTimeSpan();
        return DateOnly.FromDateTime(deslocado);
    }

    /// <summary>
    /// O instante em que o dia operacional <paramref name="dia"/> começa: a hora de corte daquele dia no fuso da loja (o
    /// inverso de <see cref="Calcular"/>). Hora local inexistente (a que o horário de verão pularia) usa o deslocamento de
    /// antes da virada.
    /// </summary>
    public static DateTimeOffset Inicio(DateOnly dia, TimeZoneInfo fuso, TimeOnly horaCorte)
    {
        ArgumentNullException.ThrowIfNull(fuso);
        var local = dia.ToDateTime(horaCorte, DateTimeKind.Unspecified);
        var deslocamento = fuso.IsInvalidTime(local) ? fuso.GetUtcOffset(local.AddHours(-1)) : fuso.GetUtcOffset(local);
        return new DateTimeOffset(local, deslocamento);
    }

    public static TimeZoneInfo ObterFuso(string? id)
    {
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(string.IsNullOrWhiteSpace(id) ? FusoPadrao : id);
        }
        catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            // Sistemas sem a base IANA (Windows antigo sem ICU): Brasília não tem horário de verão desde 2019.
            return TimeZoneInfo.CreateCustomTimeZone(FusoPadrao, TimeSpan.FromHours(-3), FusoPadrao, FusoPadrao);
        }
    }
}
