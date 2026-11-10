using System.Text.Json;
using GenesisPDV.Data.Entidades;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Repositorios;

/// <summary>Chaves de <c>configuracoes</c> lidas pelo PDV (MD 3.1.2, coluna PDV = S).</summary>
public static class ChavesConfiguracao
{
    /// <summary>"Usa Produto Preço Volume": habilita as faixas por quantidade do produto e do grupo (mix modo grupo).</summary>
    public const string UsaPrecoVolume = "pdv.usa_preco_volume";

    /// <summary>
    /// Hora de corte do dia operacional (MD 1.2; D7, dono: 05:00 na empresa, ajustável por loja). Venda às 02:30 com corte
    /// 05:00 conta no dia anterior.
    /// </summary>
    public const string HoraCorteDiaOperacional = "geral.dia_operacional_hora_corte";

    /// <summary>Padrão do catálogo (<c>packages/shared/src/configuracoes.ts</c>; conferido pelo teste do PDV).</summary>
    public static readonly TimeOnly HoraCortePadrao = new(5, 0);

    // Caixa (Fase 1C, bloco C10a; PDV 8, 21). Os padrões repetem os do catálogo (conferidos pelo CicloOnlineTests).

    /// <summary>SolicitaAberturaCaixaPDV (8.1): ligada, a abertura com o fundo contado é obrigatória (O4).</summary>
    public const string SolicitaAberturaCaixa = "pdv.solicita_abertura_caixa";

    /// <summary>Rege todos os comprovantes de movimento de caixa, inclusive o da abertura (8.2).</summary>
    public const string ImprimeSangriaAutomaticamente = "pdv.imprime_sangria_automaticamente";

    public const string FechamentoCego = "pdv.fechamento_cego";
    public const string ToleranciaDiferencaCaixa = "pdv.tolerancia_diferenca_caixa";
    public const string PermiteRecontagem = "pdv.permite_recontagem";
    public const string ImprimeCalculadoNoFechamento = "pdv.imprime_calculado_no_fechamento";

    /// <summary>
    /// Mostra Calculado × Digitado × Diferença no PDV depois da contagem (O3 do dono: desligado; README › decisão 52).
    /// </summary>
    public const string FechamentoMostraConferencia = "pdv.fechamento_mostra_conferencia";

    public const string HorasAlertaSessao = "pdv.horas_alerta_sessao";
    public const string BloqueiaSessaoDiaAnterior = "pdv.bloqueia_sessao_dia_anterior";

    /// <summary>Configurações › Geral › Ativa (PDV 8.1): desligada é o modo implantação, e o PDV não abre caixa.</summary>
    public const string EmpresaAtiva = "geral.ativa";

    // Sangria, reforço e limite de gaveta (Fase 1C, bloco C10b; PDV 20, 21.6).

    /// <summary>
    /// "Valor limite para bloquear PDV e fazer sangria" (20.4): vazio ou 0 = sem limite. O5 do dono: sem limite no piloto
    /// (o padrão do catálogo é nulo).
    /// </summary>
    public const string ValorLimiteSangria = "pdv.valor_limite_sangria";

    /// <summary>Sangria não passa do dinheiro estimado na gaveta (20.1; O5 do dono: ligada, o padrão).</summary>
    public const string SangriaLimitadaAoSaldo = "pdv.sangria_limitada_ao_saldo";

    /// <summary>Filtro do resumo diário (21.6): <c>intervalo_dias</c> (padrão) ou <c>horario</c>.</summary>
    public const string ResumoDiarioModo = "pdv.resumo_diario_modo";

    public const string ResumoPorHorario = "horario";
    public const string ResumoPorDias = "intervalo_dias";

    // Venda real (Fase 1C, bloco C11a; PDV 16.7, 29.1, 30.6).

    /// <summary>Bloqueia a venda com saldo estimado negativo (29.1). O15 do dono: desligada, vende com aviso âmbar.</summary>
    public const string BloqueiaVendaSemEstoque = "pdv.bloqueia_venda_sem_estoque";

    /// <summary>"Valida Estoque" da aba Vendas, que o PDV também respeita (29.1).</summary>
    public const string ValidaEstoque = "vendas.valida_estoque";

    /// <summary>O bloqueio por saldo vale também offline (29.1; padrão desligado: offline vira só aviso).</summary>
    public const string BloqueioEstoqueOffline = "pdv.bloqueio_estoque_offline";

    /// <summary>A confirmação manual do PIX sempre pede o supervisor (16.7; O9b, padrão ligado).</summary>
    public const string PixManualExigeSupervisor = "pdv.pix_manual_exige_supervisor";

    /// <summary>Dias máximos sem sincronizar (30.6). O18 do dono: sem limite (o padrão do catálogo é nulo).</summary>
    public const string DiasMaxOffline = "pdv.dias_max_offline";

    /// <summary>
    /// Vazios trazidos voltam ao cliente no cancelamento da venda finalizada (decisão do dono D29; Fase 1C, C11b): a tela
    /// manda devolver os cascos e a nuvem estorna a entrada (a mesma chave da loja que o handler lê).
    /// </summary>
    public const string CancelamentoDevolveVazios = "pdv.cancelamento_devolve_vazios";

    /// <summary>
    /// Crédito dos cascos descontados na venda (F11 › V, C11c) que o operador dá sem o supervisor; 0 = sem teto
    /// (README › decisão 56; roadmap D38, decidida pelo dono: R$ 50,00).
    /// </summary>
    public const string DescontoCascosMaxSemSupervisor = "pdv.desconto_cascos_max_sem_supervisor";

    /// <summary>PDV 13.1: ligada, o cancelamento de item sempre pede a liberação do supervisor, mesmo com a permissão.</summary>
    public const string CancelarItemExigeSupervisor = "pdv.cancelar_item_exige_supervisor";

    public const decimal DescontoCascosMaxSemSupervisorPadrao = 50m;

    /// <summary>
    /// Guarda das variações (Fase 2, F2-B34; F2-Q2 = D44, decidida pelo dono em 05/11/2026: ligada): o código de
    /// uma variação e o pai "Com variações" com variação ativa são recusados (<c>GuardaVariacoes</c>); desligada, vende
    /// o pai.
    /// </summary>
    public const string RecusaProdutoComVariacoes = "pdv.recusa_produto_com_variacoes";

    /// <summary>
    /// F4 "Outras lojas" da pesquisa F2 (Fase 2, F2-B35; F2-Q12 = D53, sem resposta explícita do dono: vale a
    /// recomendação, ligada para qualquer operador): desligada, o F4 avisa sem consultar (a API também recusa).
    /// </summary>
    public const string ConsultaOutrasLojas = "pdv.consulta_outras_lojas";

    /// <summary>
    /// "Exibe estoque na busca" (PDV 10.3; MD 3.1.2, por loja; padrão ligada): a pesquisa F2 mostra a coluna do estoque
    /// estimado (Fase 2, F2-B36).
    /// </summary>
    public const string ExibeEstoqueBusca = "pdv.exibe_estoque_busca";

    /// <summary>Padrões booleanos do catálogo das chaves de caixa.</summary>
    public static readonly IReadOnlyDictionary<string, bool> PadroesBool = new Dictionary<string, bool>(StringComparer.Ordinal)
    {
        [SolicitaAberturaCaixa] = true,
        [ImprimeSangriaAutomaticamente] = true,
        [FechamentoCego] = true,
        [PermiteRecontagem] = false,
        [ImprimeCalculadoNoFechamento] = false,
        [FechamentoMostraConferencia] = false,
        [BloqueiaSessaoDiaAnterior] = false,
        [EmpresaAtiva] = true,
        [SangriaLimitadaAoSaldo] = true,
        [BloqueiaVendaSemEstoque] = false,
        [ValidaEstoque] = false,
        [BloqueioEstoqueOffline] = false,
        [PixManualExigeSupervisor] = true,
        [CancelamentoDevolveVazios] = true,
        [CancelarItemExigeSupervisor] = false,
        [RecusaProdutoComVariacoes] = true,
        [ConsultaOutrasLojas] = true,
        [ExibeEstoqueBusca] = true,
    };

    public const decimal ToleranciaPadrao = 0m;
    public const int HorasAlertaSessaoPadrao = 24;
}

/// <summary>De onde vem o valor que está valendo de uma regra da loja (MD 3.1.2: loja ?? empresa ?? padrão).</summary>
public enum OrigemConfiguracao
{
    /// <summary>A linha da loja do terminal (sobreposição por loja no ERP).</summary>
    Loja,

    /// <summary>A linha da empresa.</summary>
    Empresa,

    /// <summary>Nenhuma linha: vale o padrão do catálogo.</summary>
    Padrao,
}

/// <param name="Valor">O JSON da linha que vale (nulo na <see cref="OrigemConfiguracao.Padrao"/>).</param>
/// <param name="AtualizadoEm">Quando a linha foi alterada no ERP (nulo no padrão).</param>
public sealed record ValorConfiguracao(string Chave, string? Valor, OrigemConfiguracao Origem, DateTimeOffset? AtualizadoEm);

/// <summary>
/// Leitura do espelho <c>configuracoes</c> (MD 3.1.1, fluxo <c>configuracao</c>): a linha da loja do terminal prevalece
/// sobre a da empresa; sem linha (ou valor de outro tipo) vale o padrão do catálogo de chaves.
/// </summary>
public sealed class RepositorioConfiguracoes(IDbContextFactory<PdvDbContext> fabrica)
{
    /// <summary>O fluxo do pull que traz o espelho <c>configuracoes</c> (SYNC 6.1).</summary>
    public const string FluxoConfiguracao = "configuracao";

    public async Task<bool> ObterBoolAsync(string chave, Guid lojaId, bool padrao, CancellationToken ct = default) =>
        await ValorAsync(chave, lojaId, ct) is { } valor && Bool(valor) is { } b ? b : padrao;

    /// <summary>Chave do tipo hora (<c>"HH:MM"</c>, como o zod <c>hora</c> do catálogo); fora do formato vale o padrão.</summary>
    public async Task<TimeOnly> ObterHoraAsync(string chave, Guid lojaId, TimeOnly padrao, CancellationToken ct = default) =>
        await ValorAsync(chave, lojaId, ct) is { } valor && Texto(valor) is { } texto
        && TimeOnly.TryParseExact(texto, "HH:mm", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var hora)
            ? hora
            : padrao;

    /// <summary>Chave de texto (as <c>umDe</c> do catálogo); fora do tipo ou fora de <paramref name="aceitos"/> vale o padrão.</summary>
    public async Task<string> ObterTextoAsync(string chave, Guid lojaId, string padrao, IReadOnlyCollection<string> aceitos, CancellationToken ct = default) =>
        await ValorAsync(chave, lojaId, ct) is { } valor && Texto(valor) is { } texto && aceitos.Contains(texto) ? texto : padrao;

    /// <summary>Chave booleana do caixa com o padrão do catálogo (<see cref="ChavesConfiguracao.PadroesBool"/>).</summary>
    public Task<bool> ObterBoolAsync(string chave, Guid lojaId, CancellationToken ct = default) =>
        ObterBoolAsync(chave, lojaId, ChavesConfiguracao.PadroesBool[chave], ct);

    /// <summary>Chave do tipo dinheiro (texto <c>"0.00"</c> no catálogo; número também vale); nula ou inválida = padrão.</summary>
    public async Task<decimal?> ObterDinheiroAsync(string chave, Guid lojaId, decimal? padrao, CancellationToken ct = default)
    {
        if (await ValorAsync(chave, lojaId, ct) is not { } valor)
        {
            return padrao;
        }

        try
        {
            using var doc = JsonDocument.Parse(valor);
            var raiz = doc.RootElement;
            return raiz.ValueKind switch
            {
                JsonValueKind.Null => null,
                JsonValueKind.Number when raiz.TryGetDecimal(out var n) && n >= 0m => n,
                JsonValueKind.String when decimal.TryParse(raiz.GetString(), System.Globalization.NumberStyles.AllowDecimalPoint,
                    System.Globalization.CultureInfo.InvariantCulture, out var t) => t,
                _ => padrao,
            };
        }
        catch (JsonException)
        {
            return padrao;
        }
    }

    /// <summary>Chave inteira; fora do tipo vale o padrão.</summary>
    public async Task<int> ObterInteiroAsync(string chave, Guid lojaId, int padrao, CancellationToken ct = default)
    {
        if (await ValorAsync(chave, lojaId, ct) is not { } valor)
        {
            return padrao;
        }

        try
        {
            using var doc = JsonDocument.Parse(valor);
            return doc.RootElement.ValueKind == JsonValueKind.Number && doc.RootElement.TryGetInt32(out var n) ? n : padrao;
        }
        catch (JsonException)
        {
            return padrao;
        }
    }

    /// <summary>Chave inteira que pode ser nula (<c>pdv.dias_max_offline</c>): nula, ausente ou fora do tipo = <paramref name="padrao"/>.</summary>
    public async Task<int?> ObterInteiroOuNuloAsync(string chave, Guid lojaId, int? padrao, CancellationToken ct = default)
    {
        if (await ValorAsync(chave, lojaId, ct) is not { } valor)
        {
            return padrao;
        }

        try
        {
            using var doc = JsonDocument.Parse(valor);
            return doc.RootElement.ValueKind switch
            {
                JsonValueKind.Null => null,
                JsonValueKind.Number when doc.RootElement.TryGetInt32(out var n) => n,
                _ => padrao,
            };
        }
        catch (JsonException)
        {
            return padrao;
        }
    }

    /// <summary>
    /// O valor que está valendo de cada uma das <paramref name="chaves"/> e de onde ele vem (aba 7 Parâmetros da Central
    /// do PDV, bloco G11; spec 6.9 "definido no ERP"): a linha da loja do terminal, a da empresa ou, sem nenhuma, o padrão
    /// do catálogo (<see cref="ValorConfiguracao.Valor"/> nulo; quem mostra conhece o padrão). Uma consulta só, sem carregar
    /// as outras chaves. O valor é o JSON do espelho como veio da nuvem (quem lê de verdade continua sendo cada
    /// <c>Obter…Async</c>, que cai no padrão com o tipo errado).
    /// </summary>
    public async Task<IReadOnlyList<ValorConfiguracao>> ValoresEfetivosAsync(
        IReadOnlyCollection<string> chaves, Guid lojaId, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(chaves);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var linhas = await db.Configuracoes.AsNoTracking()
            .Where(c => chaves.Contains(c.Chave) && c.ExcluidoEm == null && (c.Escopo == "empresa" || (c.Escopo == "loja" && c.LojaId == lojaId)))
            .Select(c => new { c.Chave, c.Escopo, c.Valor, c.AtualizadoEm })
            .ToListAsync(ct);
        return
        [
            .. chaves.Select(chave =>
            {
                var daChave = linhas.Where(l => l.Chave == chave).ToList();
                var linha = daChave.FirstOrDefault(l => l.Escopo == "loja") ?? daChave.FirstOrDefault(l => l.Escopo == "empresa");
                return linha is null
                    ? new ValorConfiguracao(chave, null, OrigemConfiguracao.Padrao, null)
                    : new ValorConfiguracao(chave, linha.Valor, linha.Escopo == "loja" ? OrigemConfiguracao.Loja : OrigemConfiguracao.Empresa, linha.AtualizadoEm);
            }),
        ];
    }

    /// <summary>Quando as regras da loja desceram da nuvem pela última vez (o pull do fluxo <c>configuracao</c> com sucesso).</summary>
    public async Task<DateTimeOffset?> UltimoPullAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.EstadoSincronizacao.AsNoTracking().Where(e => e.Fluxo == FluxoConfiguracao)
            .Select(e => e.UltimoPullSucessoEm).FirstOrDefaultAsync(ct);
    }

    /// <summary>Valor JSON da linha da loja ou, sem ela, da empresa.</summary>
    private async Task<string?> ValorAsync(string chave, Guid lojaId, CancellationToken ct)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var linhas = await db.Configuracoes.AsNoTracking()
            .Where(c => c.Chave == chave && c.ExcluidoEm == null && (c.Escopo == "empresa" || (c.Escopo == "loja" && c.LojaId == lojaId)))
            .ToListAsync(ct);
        var linha = linhas.FirstOrDefault(c => c.Escopo == "loja") ?? linhas.FirstOrDefault(c => c.Escopo == "empresa");
        return linha?.Valor;
    }

    private static string? Texto(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.ValueKind == JsonValueKind.String ? doc.RootElement.GetString() : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool? Bool(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => null,
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
