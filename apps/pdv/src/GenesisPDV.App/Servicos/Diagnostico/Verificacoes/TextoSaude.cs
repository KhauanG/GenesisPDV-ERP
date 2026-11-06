using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;

namespace GenesisPDV.App.Servicos.Diagnostico.Verificacoes;

/// <summary>Os textos do Painel de saúde: hora no fuso da loja, duração legível e o corte das mensagens longas.</summary>
internal static class TextoSaude
{
    /// <summary>"04/11 14:32" no fuso da loja do terminal.</summary>
    public static string Hora(DateTimeOffset instante, SessaoTerminal sessao) =>
        TimeZoneInfo.ConvertTime(instante, DiaOperacional.ObterFuso(sessao.FusoHorario)).ToString("dd/MM HH:mm", NumeroBr.Cultura);

    /// <summary>"45 s", "12 min", "3 h", "2 dias" (como o "offline há" da barra).</summary>
    public static string Duracao(TimeSpan duracao)
    {
        var d = duracao.Duration();
        return d.TotalMinutes < 1 ? $"{Math.Max(0, (int)d.TotalSeconds)} s"
            : d.TotalHours < 1 ? $"{(int)d.TotalMinutes} min"
            : d.TotalHours < 48 ? $"{(int)d.TotalHours} h"
            : $"{(int)d.TotalDays} dias";
    }

    /// <summary>Mensagem técnica para a tela: mascarada (G2) e curta.</summary>
    public static string Curto(string? texto, int limite = 160)
    {
        var mascarado = (MascaradorSuporte.Mascarar(texto) ?? string.Empty).ReplaceLineEndings(" ").Trim();
        return mascarado.Length <= limite ? mascarado : string.Concat(mascarado.AsSpan(0, limite - 1), "…");
    }

    public static string Plural(int n, string singular, string plural) => n == 1 ? $"1 {singular}" : $"{n} {plural}";
}
