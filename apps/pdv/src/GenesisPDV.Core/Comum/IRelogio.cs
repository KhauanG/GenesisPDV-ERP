namespace GenesisPDV.Core.Comum;

public interface IRelogio
{
    /// <summary>Hora atual em UTC, truncada em milissegundos (precisão do formato gravado no SQLite).</summary>
    DateTimeOffset Agora { get; }
}

public sealed class RelogioSistema : IRelogio
{
    public DateTimeOffset Agora
    {
        get
        {
            var agora = DateTimeOffset.UtcNow;
            return new DateTimeOffset(agora.Ticks - (agora.Ticks % TimeSpan.TicksPerMillisecond), TimeSpan.Zero);
        }
    }
}
