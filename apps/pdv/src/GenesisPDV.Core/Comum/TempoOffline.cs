namespace GenesisPDV.Core.Comum;

/// <summary>
/// Tempo máximo offline (PDV 30.6, <c>pdv.dias_max_offline</c>). O18 do dono: **sem limite** — o padrão do catálogo é
/// nulo e o caixa nunca trava por falta de internet; o ERP continua alertando o terminal sem contato. Com a chave
/// preenchida, o tempo é medido sem confiar no relógio local:
/// <c>max(maior_hora_vista − último pull com sucesso, segundos offline acumulados)</c>, com o pull mais antigo entre os
/// fluxos <c>acesso</c> e <c>configuracao</c>.
/// </summary>
public static class TempoOffline
{
    public static string Mensagem(int dias) => $"Terminal sem sincronizar há {dias} dias. Conecte à internet.";

    /// <param name="maiorHoraVista"><c>estado_conexao.maior_hora_vista</c> (só cresce, 12.3).</param>
    /// <param name="agora">Hora corrigida do caixa: a maior das duas vale (atrasar o Windows não reduz nada).</param>
    /// <param name="ultimoPullSucesso">O mais antigo entre <c>acesso</c> e <c>configuracao</c>; nulo = nunca.</param>
    public static TimeSpan Calcular(DateTimeOffset? maiorHoraVista, DateTimeOffset agora, DateTimeOffset? ultimoPullSucesso, long segundosAcumulados)
    {
        var referencia = maiorHoraVista is { } m && m > agora ? m : agora;
        var porRelogio = ultimoPullSucesso is { } u && referencia > u ? referencia - u : TimeSpan.Zero;
        var porUptime = TimeSpan.FromSeconds(Math.Max(0, segundosAcumulados));
        return porRelogio > porUptime ? porRelogio : porUptime;
    }

    /// <summary>Venda nova bloqueada? Nulo ou ≤ 0 = sem limite (O18). Terminal que nunca puxou não conta (carga inicial).</summary>
    public static bool Excedido(TimeSpan offline, int? limiteDias) => limiteDias is > 0 && offline > TimeSpan.FromDays(limiteDias.Value);
}
