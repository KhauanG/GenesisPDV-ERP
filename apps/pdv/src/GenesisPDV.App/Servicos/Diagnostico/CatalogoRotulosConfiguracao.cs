using System.Globalization;
using System.Text.Json;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Data.Repositorios;

namespace GenesisPDV.App.Servicos.Diagnostico;

/// <summary>O tipo de uma regra da loja, para mostrar o valor como o ERP mostra.</summary>
public enum TipoRegraLoja
{
    Booleano,
    Inteiro,
    Dinheiro,
    Hora,
    Opcoes,
}

/// <summary>
/// Uma regra da loja lida pelo PDV (as chaves de <see cref="ChavesConfiguracao"/>), como a aba 7 Parâmetros mostra: o
/// rótulo do ERP (<c>apps/erp-web/src/paginas/configuracoes/rotulos.ts</c>), o tipo, o padrão do catálogo (em JSON, como
/// em <c>packages/shared/src/configuracoes.ts</c>; <c>null</c> = sem valor), a aba do ERP onde se muda e, para o vazio, o
/// que ele quer dizer ("sem limite").
/// </summary>
public sealed record RotuloRegraLoja(
    string Chave, string Rotulo, TipoRegraLoja Tipo, string PadraoJson, string AbaErp, string? Vazio = null,
    IReadOnlyDictionary<string, string>? Opcoes = null);

/// <summary>Uma linha da aba 7 (só leitura): o rótulo, o valor que está valendo, de onde vem e onde mudar.</summary>
public sealed record RegraLojaExibida(string Chave, string Rotulo, string Valor, string Origem, string OndeMudar, bool ValorInvalido);

/// <summary>
/// Os rótulos das regras da loja que o PDV lê (Central do PDV, bloco G11; plano 4.5; PC-2; spec 6.9 "campos que vêm da
/// nuvem aparecem bloqueados com o texto definido no ERP"): toda chave de <see cref="ChavesConfiguracao"/> tem o seu (o
/// <c>CatalogoRotulosConfiguracaoTests</c> confere por reflexão; chave nova sem rótulo quebra o teste). O texto do valor
/// segue o tipo, e o valor de outro tipo (o caixa usa o padrão, como cada <c>Obter…Async</c>) aparece como o padrão com o
/// aviso. Nenhuma destas chaves é segredo (decisão 66: o que é segredo não desce ao PDV em claro), e as chaves internas
/// do terminal (<c>ChavesConfiguracaoTerminal.Internas</c>) não são regras da loja: nunca entram aqui.
/// </summary>
public static class CatalogoRotulosConfiguracao
{
    public const string AbaGeral = "Geral";
    public const string AbaParametros = "Parâmetros";
    public const string AbaPdv = "PDV";
    public const string AbaVendas = "Vendas";

    private static readonly Dictionary<string, string> ModosResumo = new(StringComparer.Ordinal)
    {
        [ChavesConfiguracao.ResumoPorDias] = "Intervalo de dias",
        [ChavesConfiguracao.ResumoPorHorario] = "Horário",
    };

    /// <summary>Na ordem da tela: o que o caixa usa no dia a dia primeiro (abertura, fechamento, sangria, estoque, venda).</summary>
    public static IReadOnlyList<RotuloRegraLoja> Todos { get; } =
    [
        new(ChavesConfiguracao.EmpresaAtiva, "Ativa (Não = modo implantação: o PDV não abre caixa)", TipoRegraLoja.Booleano, "true", AbaGeral),
        new(ChavesConfiguracao.HoraCorteDiaOperacional, "Hora de corte do dia operacional", TipoRegraLoja.Hora, "\"05:00\"", AbaGeral),
        new(ChavesConfiguracao.SolicitaAberturaCaixa, "Solicita abertura de caixa no PDV", TipoRegraLoja.Booleano, "true", AbaParametros),
        new(ChavesConfiguracao.FechamentoCego, "Fechamento cego", TipoRegraLoja.Booleano, "true", AbaPdv),
        new(ChavesConfiguracao.ToleranciaDiferencaCaixa, "Tolerância de diferença no fechamento", TipoRegraLoja.Dinheiro, "\"0.00\"", AbaPdv),
        new(ChavesConfiguracao.PermiteRecontagem, "Permite recontagem no fechamento", TipoRegraLoja.Booleano, "false", AbaPdv),
        new(ChavesConfiguracao.FechamentoMostraConferencia, "Mostra o calculado × contado no PDV depois da contagem", TipoRegraLoja.Booleano, "false", AbaPdv),
        new(ChavesConfiguracao.ImprimeCalculadoNoFechamento, "Imprime o calculado no relatório de fechamento", TipoRegraLoja.Booleano, "false", AbaPdv),
        new(ChavesConfiguracao.HorasAlertaSessao, "Alerta de sessão aberta há mais de (h)", TipoRegraLoja.Inteiro, "24", AbaPdv),
        new(ChavesConfiguracao.BloqueiaSessaoDiaAnterior, "Bloqueia sessão de dia anterior", TipoRegraLoja.Booleano, "false", AbaPdv),
        new(ChavesConfiguracao.ImprimeSangriaAutomaticamente, "Imprime sangria automaticamente", TipoRegraLoja.Booleano, "true", AbaParametros),
        new(ChavesConfiguracao.ValorLimiteSangria, "Valor limite para bloquear o PDV e fazer sangria", TipoRegraLoja.Dinheiro, "null", AbaParametros, "desligado"),
        new(ChavesConfiguracao.SangriaLimitadaAoSaldo, "Sangria limitada ao saldo da gaveta", TipoRegraLoja.Booleano, "true", AbaPdv),
        new(ChavesConfiguracao.ResumoDiarioModo, "Resumo diário por", TipoRegraLoja.Opcoes, "\"intervalo_dias\"", AbaParametros, Opcoes: ModosResumo),
        new(ChavesConfiguracao.BloqueiaVendaSemEstoque, "Bloqueia venda sem estoque", TipoRegraLoja.Booleano, "false", AbaParametros),
        new(ChavesConfiguracao.ValidaEstoque, "Valida estoque (aba Vendas)", TipoRegraLoja.Booleano, "false", AbaVendas),
        new(ChavesConfiguracao.BloqueioEstoqueOffline, "Bloqueio de estoque também offline", TipoRegraLoja.Booleano, "false", AbaPdv),
        new(ChavesConfiguracao.UsaPrecoVolume, "Usa produto preço volume (atacarejo)", TipoRegraLoja.Booleano, "false", AbaParametros),
        new(ChavesConfiguracao.CancelarItemExigeSupervisor, "Cancelar item sempre pede supervisor", TipoRegraLoja.Booleano, "false", AbaPdv),
        new(ChavesConfiguracao.CancelamentoDevolveVazios, "Cancelar venda devolve os vazios trazidos", TipoRegraLoja.Booleano, "true", AbaPdv),
        new(ChavesConfiguracao.DescontoCascosMaxSemSupervisor, "Desconto pelos cascos sem supervisor até (R$ por venda)", TipoRegraLoja.Dinheiro, "\"50.00\"", AbaPdv, "sem teto"),
        new(ChavesConfiguracao.PixManualExigeSupervisor, "PIX manual exige supervisor", TipoRegraLoja.Booleano, "true", AbaPdv),
        new(ChavesConfiguracao.DiasMaxOffline, "Dias máximos offline", TipoRegraLoja.Inteiro, "null", AbaPdv, "sem limite"),
    ];

    private static readonly Dictionary<string, RotuloRegraLoja> PorChave = Todos.ToDictionary(r => r.Chave, StringComparer.Ordinal);

    public static RotuloRegraLoja? De(string chave) => PorChave.GetValueOrDefault(chave);

    /// <summary>"ERP › Cadastros › Configurações › PDV (por loja: Lojas › Parâmetros)".</summary>
    public static string OndeMudar(RotuloRegraLoja rotulo)
    {
        ArgumentNullException.ThrowIfNull(rotulo);
        return rotulo.AbaErp == AbaVendas
            ? "ERP › Configurações › Vendas (a aba chega numa próxima versão do ERP)"
            : $"ERP › Cadastros › Configurações › {rotulo.AbaErp}" + (rotulo.AbaErp == AbaGeral && rotulo.Chave == ChavesConfiguracao.EmpresaAtiva
                ? string.Empty
                : " (por loja: Lojas › Parâmetros)");
    }

    /// <summary>A linha da tela: o valor que está valendo (o da linha do espelho ou o padrão) em português e a origem.</summary>
    public static RegraLojaExibida Exibir(RotuloRegraLoja rotulo, ValorConfiguracao valor)
    {
        ArgumentNullException.ThrowIfNull(rotulo);
        ArgumentNullException.ThrowIfNull(valor);
        var origem = valor.Origem switch
        {
            OrigemConfiguracao.Loja => "definido no ERP para esta loja",
            OrigemConfiguracao.Empresa => "definido no ERP para a empresa",
            _ => "padrão do sistema (ninguém mudou no ERP)",
        };
        if (valor.Valor is { } json && Texto(rotulo, json) is { } texto)
        {
            return new RegraLojaExibida(rotulo.Chave, rotulo.Rotulo, texto, origem, OndeMudar(rotulo), false);
        }

        var padrao = Texto(rotulo, rotulo.PadraoJson) ?? "—";
        return valor.Valor is null
            ? new RegraLojaExibida(rotulo.Chave, rotulo.Rotulo, padrao, origem, OndeMudar(rotulo), false)
            : new RegraLojaExibida(rotulo.Chave, rotulo.Rotulo, $"{padrao} (o valor do ERP não é válido: vale o padrão)", origem, OndeMudar(rotulo), true);
    }

    /// <summary>
    /// O valor em JSON como texto de balcão; nulo se não é do tipo (o caixa usa o padrão). O <c>null</c> só vale nas chaves
    /// em que ele quer dizer algo (<see cref="RotuloRegraLoja.Vazio"/>: "desligado", "sem limite"); nas outras (as
    /// booleanas, as horas, a tolerância do fechamento) o caixa cai no padrão, e a tela mostra o padrão com o aviso.
    /// </summary>
    private static string? Texto(RotuloRegraLoja rotulo, string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var raiz = doc.RootElement;
            if (raiz.ValueKind == JsonValueKind.Null)
            {
                return rotulo.Vazio;
            }

            return rotulo.Tipo switch
            {
                TipoRegraLoja.Booleano => raiz.ValueKind switch
                {
                    JsonValueKind.True => "Sim",
                    JsonValueKind.False => "Não",
                    _ => null,
                },
                TipoRegraLoja.Inteiro => raiz.ValueKind == JsonValueKind.Number && raiz.TryGetInt32(out var n)
                    ? n.ToString(CultureInfo.InvariantCulture)
                    : null,
                TipoRegraLoja.Dinheiro => Dinheiro(raiz) is { } d ? (d == 0m && rotulo.Vazio is { } vazio ? $"R$ 0,00 ({vazio})" : $"R$ {NumeroBr.Dinheiro(d)}") : null,
                TipoRegraLoja.Hora => raiz.ValueKind == JsonValueKind.String
                    && TimeOnly.TryParseExact(raiz.GetString(), "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var h)
                        ? h.ToString("HH:mm", CultureInfo.InvariantCulture)
                        : null,
                _ => raiz.ValueKind == JsonValueKind.String && rotulo.Opcoes?.GetValueOrDefault(raiz.GetString() ?? string.Empty) is { } opcao ? opcao : null,
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static decimal? Dinheiro(JsonElement raiz) => raiz.ValueKind switch
    {
        JsonValueKind.Number when raiz.TryGetDecimal(out var n) && n >= 0m => n,
        JsonValueKind.String when decimal.TryParse(raiz.GetString(), NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var t) && t >= 0m => t,
        _ => null,
    };
}
