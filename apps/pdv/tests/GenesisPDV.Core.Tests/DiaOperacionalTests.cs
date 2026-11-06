using GenesisPDV.Core.Comum;

namespace GenesisPDV.Core.Tests;

public class DiaOperacionalTests
{
    [Fact]
    public void Corte_as_cinco_horas_joga_madrugada_para_o_dia_anterior()
    {
        var fuso = DiaOperacional.ObterFuso("America/Sao_Paulo");
        // 02:30 em São Paulo de 30/10 = 05:30 UTC.
        var instante = new DateTimeOffset(2026, 10, 30, 5, 30, 0, TimeSpan.Zero);
        Assert.Equal(new DateOnly(2026, 10, 29), DiaOperacional.Calcular(instante, fuso, new TimeOnly(5, 0)));
        Assert.Equal(new DateOnly(2026, 10, 30), DiaOperacional.Calcular(instante, fuso, TimeOnly.MinValue));
    }

    [Fact]
    public void Inicio_do_dia_operacional_e_a_hora_de_corte_no_fuso_da_loja()
    {
        // Central do PDV (G5): o teto de 30 dias começa na hora de corte do dia mais antigo.
        var fuso = DiaOperacional.ObterFuso("America/Sao_Paulo");
        var inicio = DiaOperacional.Inicio(new DateOnly(2026, 10, 7), fuso, new TimeOnly(5, 0));
        Assert.Equal(new DateTimeOffset(2026, 10, 7, 8, 0, 0, TimeSpan.Zero), inicio.ToUniversalTime());
        Assert.Equal(new DateOnly(2026, 10, 7), DiaOperacional.Calcular(inicio, fuso, new TimeOnly(5, 0)));
        Assert.Equal(new DateOnly(2026, 10, 6), DiaOperacional.Calcular(inicio.AddMilliseconds(-1), fuso, new TimeOnly(5, 0)));
    }

    [Fact]
    public void Relogio_trunca_em_milissegundos()
    {
        var agora = new RelogioSistema().Agora;
        Assert.Equal(0, agora.Ticks % TimeSpan.TicksPerMillisecond);
        Assert.Equal(TimeSpan.Zero, agora.Offset);
    }

    [Fact]
    public void Id_e_uuid_v7()
    {
        Assert.Equal(7, IdGerador.Novo().Version);
    }
}
