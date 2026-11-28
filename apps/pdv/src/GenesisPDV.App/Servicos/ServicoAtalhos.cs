using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Avalonia.Input;
using GenesisPDV.Core.Atalhos;
using GenesisPDV.Data.Repositorios;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// O mapa de atalhos que está valendo no caixa (F3-B13; PDV 28.1–28.3): relido do espelho <c>atalhos_pdv</c> ao abrir a
/// venda e depois de cada pull (<see cref="RecarregarAsync"/>), com a ocorrência <c>ATALHO_INVALIDO</c> quando uma tecla da
/// nuvem não valeu ou uma ação essencial chegou desligada (uma vez por conjunto de alertas, não a cada pull), e o bipe da
/// ação indisponível.
/// </summary>
public sealed class ServicoAtalhos(
    RepositorioConfiguracoes configuracoes, RepositorioTerminal terminal, SessaoTerminal sessao, ILogger<ServicoAtalhos> log) : IDisposable
{
    private readonly SemaphoreSlim _leitura = new(1, 1);
    private string? _alertasRegistrados;

    /// <summary>O mapa atual (o padrão do catálogo até a primeira leitura).</summary>
    public MapaAtalhos Mapa { get; private set; } = MapaAtalhos.Padrao;

    /// <summary>Quantos bipes de "Ação indisponível" o caixa deu (o teste confere; o som real só sai no Windows).</summary>
    public int Bipes { get; private set; }

    /// <summary>
    /// Relê o espelho da loja do terminal. Uma falha de leitura mantém o mapa que já valia (a venda não para por um atalho);
    /// sem identidade (antes da ativação), o padrão.
    /// </summary>
    public async Task<MapaAtalhos> RecarregarAsync(CancellationToken ct = default)
    {
        // Uma leitura por vez: a ocorrência do mesmo conjunto de alertas não sai duas vezes de duas leituras seguidas.
        await _leitura.WaitAsync(ct);
        try
        {
            try
            {
                Mapa = sessao.Identidade is { } identidade
                    ? await configuracoes.MapaAtalhosAsync(identidade.LojaId, ct)
                    : MapaAtalhos.Padrao;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                log.LogWarning(e, "Falha ao ler os atalhos do caixa; continua valendo o mapa anterior");
                return Mapa;
            }

            await RegistrarAlertasAsync(Mapa, ct);
            return Mapa;
        }
        finally
        {
            _leitura.Release();
        }
    }

    /// <summary>O bipe da ação desabilitada, sem permissão ou que este caixa ainda não tem (PDV 28.3).</summary>
    public void Bipe()
    {
        Bipes++;
        if (OperatingSystem.IsWindows())
        {
            // MB_OK: o som padrão do Windows (o do painel de som); sem alto-falante configurado, nada acontece.
            _ = MessageBeep(0);
        }
    }

    /// <summary>
    /// O gesto do Avalonia de uma tecla canônica do mapa (<c>Ctrl+Shift+T</c>, <c>F4</c>, <c>Ctrl+Espaço</c>, <c>Alt+1</c>):
    /// o dígito liga também o do teclado numérico. Vazio para um texto fora do formato (o mapa nunca entrega um).
    /// </summary>
    public static IReadOnlyList<KeyGesture> Gestos(string tecla)
    {
        ArgumentNullException.ThrowIfNull(tecla);
        var partes = tecla.Split('+');
        var mods = KeyModifiers.None;
        foreach (var p in partes[..^1])
        {
            mods |= p switch
            {
                "Ctrl" => KeyModifiers.Control,
                "Alt" => KeyModifiers.Alt,
                "Shift" => KeyModifiers.Shift,
                _ => throw new ArgumentException($"Modificador fora do formato: {tecla}", nameof(tecla)),
            };
        }

        var chave = partes[^1];
        if (chave == "Espaço")
        {
            return [new KeyGesture(Key.Space, mods)];
        }

        if (chave.Length == 1 && char.IsAsciiDigit(chave[0]))
        {
            var d = chave[0] - '0';
            return [new KeyGesture(Key.D0 + d, mods), new KeyGesture(Key.NumPad0 + d, mods)];
        }

        if (chave.Length == 1 && char.IsAsciiLetterUpper(chave[0]))
        {
            return [new KeyGesture(Key.A + (chave[0] - 'A'), mods)];
        }

        if (chave.Length > 1 && chave[0] == 'F' && int.TryParse(chave.AsSpan(1), System.Globalization.CultureInfo.InvariantCulture, out var n) && n is >= 1 and <= 12)
        {
            return [new KeyGesture(Key.F1 + (n - 1), mods)];
        }

        return [];
    }

    private async Task RegistrarAlertasAsync(MapaAtalhos mapa, CancellationToken ct)
    {
        var texto = mapa.Alertas.Count == 0 ? null : string.Join("; ", mapa.Alertas.Select(a => a.Texto));
        if (texto is null || texto == _alertasRegistrados)
        {
            _alertasRegistrados = texto;
            return;
        }

        try
        {
            var dados = new JsonObject
            {
                ["atalhos"] = new JsonArray([.. mapa.Alertas.Select(a => (JsonNode)new JsonObject
                {
                    ["acao"] = a.Acao, ["tecla_recebida"] = a.TeclaRecebida, ["tecla_aplicada"] = a.TeclaAplicada, ["motivo"] = a.Motivo,
                })]),
            };
            await terminal.RegistrarOcorrenciaAsync(
                NiveisOcorrencia.Aviso, CodigoOcorrencia.AtalhoInvalido,
                $"{mapa.Alertas.Count} atalho(s) da nuvem não valeram como vieram neste caixa: ficaram na tecla padrão ou ligados (ação essencial).",
                texto, dados, ct);
            _alertasRegistrados = texto;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogWarning(e, "Falha ao registrar a ocorrência dos atalhos: {Alertas}", texto);
        }
    }

    public void Dispose() => _leitura.Dispose();

    [DllImport("user32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MessageBeep(uint tipo);
}
