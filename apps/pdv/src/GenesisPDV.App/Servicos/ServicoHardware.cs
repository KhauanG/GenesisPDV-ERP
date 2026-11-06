using System.Text.Json.Nodes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Hardware.Gaveta;
using GenesisPDV.Hardware.Impressora;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// Configuração local da impressora e da gaveta (PDV 6.2, 6.3; implantação I4, decisão 63 do README), lida de
/// <c>configuracao_terminal</c> na abertura e regravada pela tela de configuração do terminal. Sem nenhuma chave, o
/// build da loja fica **sem impressora** (o PDV vende e avisa) e o de desenvolvimento com a simulada; a gaveta, sempre
/// desligada (dono, I4).
/// </summary>
public sealed class ServicoHardware(RepositorioTerminal terminal, ILogger<ServicoHardware> log)
{
    public const string Localizacao = "PDV › Configuração do terminal";

    public static TipoConexao ConexaoPadrao => ConfiguracaoBuild.ModoDemonstracao ? TipoConexao.Simulada : TipoConexao.Nenhuma;

    public static ConfiguracaoHardware Padrao => ChavesHardware.Ler(new Dictionary<string, string>(), ConexaoPadrao);

    public ConfiguracaoHardware Atual { get; private set; } = Padrao;

    /// <summary>Barra de funções e pesquisa só por números (decisão 65), das mesmas chaves do terminal.</summary>
    public PreferenciasCaixa Preferencias { get; private set; } = PreferenciasCaixa.Padrao;

    public event EventHandler? Alterada;

    /// <summary>Falha ao ler fica no padrão: a impressora nunca impede o caixa de abrir.</summary>
    public async Task CarregarAsync(CancellationToken ct = default)
    {
        try
        {
            var valores = await terminal.LerConfiguracoesAsync([.. ChavesHardware.Todas, .. ChavesPreferencias.Todas], ct);
            Atual = ChavesHardware.Ler(valores, ConexaoPadrao);
            Preferencias = ChavesPreferencias.Ler(valores);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogError(e, "Configuração da impressora ilegível; o caixa segue com a padrão");
            Atual = Padrao;
            Preferencias = PreferenciasCaixa.Padrao;
        }

        Alterada?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>Só a impressora e a gaveta (as preferências da tela ficam como estão).</summary>
    public Task GravarAsync(ConfiguracaoHardware nova, Guid? usuarioId, Guid? autorizadoPorId, CancellationToken ct = default) =>
        GravarAsync(nova, Preferencias, usuarioId, autorizadoPorId, ct);

    /// <summary>
    /// Grava as chaves (impressora, gaveta e as preferências da tela) e a auditoria <c>editar</c> de
    /// <c>configuracao_terminal</c> (antes/depois; nada secreto) num commit e passa a usar a nova. Recusa a configuração
    /// inválida antes de gravar.
    /// </summary>
    public async Task GravarAsync(
        ConfiguracaoHardware nova, PreferenciasCaixa preferencias, Guid? usuarioId, Guid? autorizadoPorId, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(nova);
        ArgumentNullException.ThrowIfNull(preferencias);
        if ((nova.Impressora.Validar() ?? nova.Gaveta.Validar()) is { } erro)
        {
            throw new RegraNegocioException(erro);
        }

        var auditoria = new LogAuditoriaLocal
        {
            Acao = "editar",
            Entidade = "configuracao_terminal",
            UsuarioId = usuarioId,
            AutorizadoPorId = autorizadoPorId,
            Localizacao = Localizacao,
            Descricao = $"Impressora e gaveta: {nova.Impressora.Perfil.Nome}, {nova.Impressora.DescricaoConexao}, " +
                        $"{nova.Impressora.Colunas} colunas; gaveta {(nova.Gaveta.Ligada ? $"ligada (pino {nova.Gaveta.Pino}, {nova.Gaveta.PulsoMs} ms)" : "desligada")}; " +
                        $"barra de funções em {(preferencias.BarraBotoes ? "botões" : "texto")}; pesquisa {(preferencias.PesquisaSoNumeros ? "só por números" : "por nome e números")}",
            Antes = Json(Atual, Preferencias),
            Depois = Json(nova, preferencias),
        };
        var chaves = new Dictionary<string, string>(ChavesHardware.Escrever(nova));
        foreach (var (chave, valor) in ChavesPreferencias.Escrever(preferencias))
        {
            chaves[chave] = valor;
        }

        await terminal.GravarConfiguracoesAsync(chaves, usuarioId, auditoria, ct);
        log.LogInformation("Configuração do terminal alterada: {Descricao}", auditoria.Descricao);
        Atual = nova;
        Preferencias = preferencias;
        Alterada?.Invoke(this, EventArgs.Empty);
        try
        {
            // Para a aba 5 da Central (bloco G8): "a impressora parou depois que mudaram a configuração às 14:32". O antes e
            // o depois ficam na auditoria; aqui só o resumo (nada secreto).
            await terminal.RegistrarOcorrenciaAsync(NiveisOcorrencia.Info, CodigoOcorrencia.ConfiguracaoAlterada,
                $"Configuração do caixa gravada. {auditoria.Descricao}", ct: ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogError(e, "Falha ao registrar no log local a configuração gravada");
        }
    }

    private static string Json(ConfiguracaoHardware c, PreferenciasCaixa p)
    {
        var objeto = new JsonObject();
        foreach (var (chave, valor) in ChavesHardware.Escrever(c).Concat(ChavesPreferencias.Escrever(p)))
        {
            objeto[chave] = JsonNode.Parse(valor);
        }

        return objeto.ToJsonString();
    }
}

/// <summary>
/// A impressora do terminal como os serviços a veem (<see cref="IImpressora"/>): segue a configuração atual do
/// <see cref="ServicoHardware"/> — a simulada em arquivo, a real (<see cref="ImpressoraEscPos"/> com o transporte da
/// conexão) ou nenhuma. O transporte vem da <see cref="FabricaTransporteImpressora"/> (os testes trocam pela que guarda
/// os bytes).
/// </summary>
public sealed class ImpressoraDoTerminal(ServicoHardware hardware, ImpressoraArquivoSimulada simulada, FabricaTransporteImpressora transportes) : IImpressora
{
    public int Colunas => hardware.Atual.Impressora.Colunas;

    public bool Configurada => hardware.Atual.Impressora.Configurada;

    public bool Simulada => hardware.Atual.Impressora.Conexao == TipoConexao.Simulada;

    public Task<SituacaoImpressora> ObterSituacaoAsync(CancellationToken ct = default) => Simulada
        ? simulada.ObterSituacaoAsync(ct)
        : Task.FromResult(Configurada ? SituacaoImpressora.Pronta : SituacaoImpressora.Offline);

    public Task ImprimirAsync(byte[] escPos, CancellationToken ct = default) => ImprimirAsync(escPos, hardware.Atual.Impressora, ct);

    /// <summary>Com uma configuração ainda não gravada (o "Imprimir teste" da tela).</summary>
    public Task ImprimirAsync(byte[] escPos, ConfiguracaoImpressora configuracao, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(configuracao);
        if (configuracao.Conexao == TipoConexao.Simulada)
        {
            simulada.Colunas = configuracao.Colunas;
        }

        return configuracao.Conexao switch
        {
            TipoConexao.Simulada => simulada.ImprimirAsync(escPos, ct),
            TipoConexao.Nenhuma => throw new FalhaImpressoraException("Nenhuma impressora configurada neste caixa."),
            _ => new ImpressoraEscPos(configuracao, transportes(configuracao)).ImprimirAsync(escPos, ct),
        };
    }

    /// <summary>Bytes sem adaptação (o pulso da gaveta) pela conexão real.</summary>
    public Task EnviarComandoAsync(byte[] bytes, ConfiguracaoImpressora configuracao, CancellationToken ct = default) =>
        configuracao.Conexao is TipoConexao.Nenhuma or TipoConexao.Simulada
            ? throw new FalhaImpressoraException("Nenhuma impressora configurada neste caixa.")
            : new ImpressoraEscPos(configuracao, transportes(configuracao)).EnviarBrutoAsync(bytes, ct);
}

/// <summary>
/// Toda impressão do caixa passa por aqui (PDV 19.1): o trabalho é gravado na <c>fila_impressao</c> antes de ir à
/// impressora, a falha fica na fila com o erro (nova tentativa na configuração do terminal, reimpressão no F12) e
/// **nunca** trava nem desfaz a venda; sem impressora configurada o trabalho fica registrado como cancelado e nada é
/// avisado a cada venda (a barra mostra "Sem impressora").
/// </summary>
public sealed class ServicoImpressao(IImpressora impressora, RepositorioImpressao fila, ILogger<ServicoImpressao> log, RepositorioTerminal? terminal = null)
{
    public int Colunas => impressora.Colunas;

    public bool Configurada => impressora.Configurada;

    /// <summary>
    /// Devolve o aviso para a tela: nulo = impresso, ou sem impressora quando <paramref name="semImpressora"/> é nulo (o
    /// cupom e os comprovantes do caixa, sem aviso por documento).
    /// </summary>
    /// <param name="aviso">O aviso da falha a partir da mensagem da impressora.</param>
    /// <param name="semImpressora">
    /// O aviso sem impressora configurada, para o que o operador pediu de propósito e espera ver sair (o F4 do PIX, a
    /// reimpressão): sem ele a tela diria "enviado" sem nada ter saído.
    /// </param>
    /// <param name="novaTentativa">Falso = a falha fica <c>cancelado</c>, fora do F7 (<see cref="RepositorioImpressao.MarcarResultadoAsync"/>).</param>
    public async Task<string?> ImprimirAsync(
        string tipo,
        Guid? referencia,
        byte[] conteudo,
        Func<string, string> aviso,
        int vias = 1,
        CancellationToken ct = default,
        string? semImpressora = null,
        bool novaTentativa = true)
    {
        ArgumentNullException.ThrowIfNull(aviso);
        var trabalho = await fila.EnfileirarAsync(tipo, referencia, conteudo, vias, ct);
        if (!impressora.Configurada)
        {
            await fila.MarcarSemImpressoraAsync(trabalho, ct);
            return semImpressora;
        }

        try
        {
            await impressora.ImprimirAsync(conteudo, ct);
            await fila.MarcarResultadoAsync(trabalho, impresso: true, ct: ct);
            return null;
        }
        catch (FalhaImpressoraException e)
        {
            log.LogWarning(e, "Documento {Tipo} não impresso", tipo);
            await fila.MarcarResultadoAsync(trabalho, impresso: false, e.Message, ct, novaTentativa);
            // A dica do IMPRESSAO_FALHOU manda o F7; o que não fica na fila (o QR do PIX) tem a sua.
            await RegistrarFalhaAsync(novaTentativa ? CodigoOcorrencia.ImpressaoFalhou : CodigoOcorrencia.ImpressaoFalhouSemFila,
                $"{NomeDocumento(tipo)} não saiu na impressora: {e.Message}", tipo, referencia, ct);
            return aviso(e.Message);
        }
    }

    public string Texto(byte[] conteudo) => RenderizadorEscPos.RenderizarTexto(conteudo, impressora.Colunas);

    public Task<int> ContarPendentesAsync(CancellationToken ct = default) => fila.ContarPendentesAsync(ct);

    /// <summary>
    /// Nova tentativa dos trabalhos que não saíram, do mais antigo ao mais novo; para no primeiro que falhar (a
    /// impressora continua com problema). Devolve quantos saíram e o erro, se houve.
    /// </summary>
    public async Task<(int Impressos, string? Erro)> ImprimirPendentesAsync(CancellationToken ct = default)
    {
        if (!impressora.Configurada)
        {
            return (0, "Nenhuma impressora configurada neste caixa.");
        }

        var impressos = 0;
        foreach (var trabalho in await fila.PendentesAsync(ct))
        {
            try
            {
                await impressora.ImprimirAsync(trabalho.Conteudo, ct);
                await fila.MarcarResultadoAsync(trabalho.Id, impresso: true, ct: ct);
                impressos++;
            }
            catch (FalhaImpressoraException e)
            {
                await fila.MarcarResultadoAsync(trabalho.Id, impresso: false, e.Message, ct);
                await RegistrarFalhaAsync(CodigoOcorrencia.FilaImpressaoParou,
                    $"Nova tentativa da fila parou ({impressos} impressos): {e.Message}", null, null, ct);
                return (impressos, e.Message);
            }
        }

        return (impressos, null);
    }

    /// <summary>O nome do documento na ocorrência do log ("O que aconteceu" da aba 5), pelo tipo da fila (o cru fica no detalhe).</summary>
    private static readonly Dictionary<string, string> NomesDocumento = new(StringComparer.Ordinal)
    {
        ["cupom"] = "Cupom da venda",
        ["cupom_reimpressao"] = "Reimpressão do cupom",
        ["cobranca_pix"] = "QR do PIX",
        ["abertura_caixa"] = "Comprovante de abertura do caixa",
        ["fechamento_caixa"] = "Relatório de fechamento do caixa",
        [ServicoHistoricoCaixas.DocumentoReimpressao] = "2ª via do fechamento do caixa",
        ["sangria"] = "Comprovante de sangria",
        ["reforco"] = "Comprovante de reforço",
        ["resumo_diario"] = "Resumo do dia",
    };

    /// <summary>"cupom" → "Cupom da venda"; o tipo desconhecido, "Documento".</summary>
    internal static string NomeDocumento(string tipo) => NomesDocumento.GetValueOrDefault(tipo, "Documento");

    /// <summary>
    /// A ocorrência do <c>log_local</c> (aba 5 da Central, bloco G8): o documento e o erro da impressora, com o tipo e a
    /// referência (a venda, o fechamento) no detalhe, para achar "o erro de impressão de ontem". Falha só no log.
    /// </summary>
    private async Task RegistrarFalhaAsync(CodigoOcorrencia codigo, string mensagem, string? tipo, Guid? referencia, CancellationToken ct)
    {
        if (terminal is null)
        {
            return;
        }

        try
        {
            // "tipo_impressao", não "tipo_documento": o MascaradorSuporte esconde todo campo com "documento" no nome (o CPF).
            var dados = new System.Text.Json.Nodes.JsonObject();
            if (tipo is not null)
            {
                dados["tipo_impressao"] = tipo;
            }

            if (referencia is { } r)
            {
                dados["referencia_id"] = r.ToString();
            }

            await terminal.RegistrarOcorrenciaAsync(NiveisOcorrencia.Aviso, codigo, mensagem, dados: dados, ct: ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogError(e, "Falha ao registrar no log local o documento que não saiu");
        }
    }

    public Task<int> DescartarPendentesAsync(CancellationToken ct = default) => fila.DescartarPendentesAsync(ct);
}

/// <summary>
/// Gaveta (PDV 6.3, 19.4; dono, I4 — decisão 63 do README): **desligada por padrão**, e desligada nenhum comando de
/// gaveta sai, nunca. Ligada, abre na finalização com forma "Abrir gaveta" (<see cref="AbrirNaVendaAsync"/>) e pelo
/// comando manual com <c>pdv.gaveta.abrir_avulsa</c> (F11 › 9, auditado); nos movimentos do caixa só com
/// <c>gaveta.abre_nos_movimentos</c> (padrão: não, como o dono decidiu). Na conexão simulada usa a
/// <see cref="GavetaSimulada"/>; nas reais, o pulso <c>ESC p</c> vai pela impressora.
/// </summary>
public sealed class ServicoGaveta(
    ServicoHardware hardware,
    ImpressoraDoTerminal impressora,
    GavetaSimulada simulada,
    RepositorioTerminal terminal,
    ILogger<ServicoGaveta> log,
    IRelogio? relogio = null)
{
    public const string MensagemNaoAbriu = "Gaveta não abriu — abra manualmente.";
    public const string MensagemDesligada = "A gaveta está desligada na Central do PDV (⚙ › 3 Impressora e gaveta).";

    public bool Ligada => hardware.Atual.Gaveta.Ligada && hardware.Atual.Impressora.Configurada;

    /// <summary>Origem dos registros da gaveta no <c>log_local</c>.</summary>
    public const string OrigemLog = OrigensOcorrencia.Gaveta;

    /// <summary>Nível do registro "a gaveta voltou a abrir" no <c>log_local</c> (as falhas são <c>aviso</c>).</summary>
    public const string NivelVoltou = NiveisOcorrencia.Info;

    /// <summary>
    /// Último pulso que saiu bem e o último que falhou neste processo (Painel de saúde, Central do PDV, bloco G4). A
    /// falha também fica no <c>log_local</c> (origem <c>gaveta</c>), que o Painel lê depois de reabrir o caixa; e o
    /// primeiro pulso bom depois de uma falha registrada grava "a gaveta voltou a abrir" (<see cref="NivelVoltou"/>): o
    /// app reaberto não acusa uma falha que já passou.
    /// </summary>
    public DateTimeOffset? UltimoPulsoOkEm { get; private set; }

    public DateTimeOffset? UltimaFalhaEm { get; private set; }

    /// <summary>O último registro da gaveta no <c>log_local</c> é uma falha (nulo: ainda não consultado neste processo).</summary>
    private bool? _falhaNoLog;

    /// <summary>Finalização ou cancelamento: abre só com forma "Abrir gaveta" e a gaveta ligada. Devolve o aviso.</summary>
    public Task<string?> AbrirNaVendaAsync(bool temFormaQueAbre, CancellationToken ct = default) =>
        temFormaQueAbre ? TentarAsync(ct) : Task.FromResult<string?>(null);

    /// <summary>Abertura, sangria, reforço, fechamento e devolução em dinheiro: só com "abre nos movimentos".</summary>
    public Task<string?> AbrirNoMovimentoAsync(CancellationToken ct = default) =>
        hardware.Atual.Gaveta.AbreNosMovimentos ? TentarAsync(ct) : Task.FromResult<string?>(null);

    public const string MotivoTeste = "teste na configuração do terminal";

    /// <summary>
    /// Abertura avulsa (PDV 19.4, F11 › 9): a permissão já foi conferida por quem chama (ou liberada pelo supervisor);
    /// o motivo e quem liberou vão na auditoria <c>gaveta_aberta</c> (sobe no lote para o ERP), gravada **antes** do
    /// pulso: nenhuma abertura física fica sem o registro já commitado (se a auditoria falhar, a gaveta não abre).
    /// </summary>
    public async Task AbrirManualAsync(Guid operadorId, Guid? autorizadoPorId, string motivo, Guid? sessaoCaixaId, CancellationToken ct = default)
    {
        if (!Ligada)
        {
            throw new RegraNegocioException(MensagemDesligada);
        }

        if (string.IsNullOrWhiteSpace(motivo) || motivo.Trim().Length < 3)
        {
            throw new RegraNegocioException("Informe o motivo da abertura da gaveta.");
        }

        await terminal.RegistrarAuditoriaAsync("gaveta_aberta", operadorId, "gaveta", sessaoCaixaId,
            "Gaveta aberta sem venda (F11 › 9)", "PDV › Funções", autorizadoPorId, ct, motivo.Trim());
        await AbrirOuRecusarAsync(hardware.Atual, ct);
    }

    /// <summary>
    /// "Abrir gaveta (teste)" (F6) da configuração, com a configuração da tela (ainda não gravada). O pulso é real e a tela
    /// abre também com o caixa aberto (F11 › 8): como no F11 › 9, a auditoria <c>gaveta_aberta</c> (motivo
    /// <see cref="MotivoTeste"/>, quem está na tela e quem liberou, a sessão do caixa) é gravada antes do pulso.
    /// </summary>
    public async Task TestarAsync(ConfiguracaoHardware configuracao, Guid? usuarioId, Guid? autorizadoPorId, Guid? sessaoCaixaId, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(configuracao);
        if (!configuracao.Gaveta.Ligada || !configuracao.Impressora.Configurada)
        {
            throw new RegraNegocioException("Ligue a gaveta (e configure a impressora) para testar.");
        }

        await terminal.RegistrarAuditoriaAsync("gaveta_aberta", usuarioId, "gaveta", sessaoCaixaId,
            "Gaveta aberta no teste da configuração do terminal (F6)", ServicoHardware.Localizacao, autorizadoPorId, ct, MotivoTeste);
        await AbrirOuRecusarAsync(configuracao, ct);
    }

    /// <summary>O pulso que não saiu depois da auditoria fica no log local (a auditoria registra o pedido de abertura).</summary>
    private async Task AbrirOuRecusarAsync(ConfiguracaoHardware c, CancellationToken ct)
    {
        try
        {
            await AbrirAsync(c, ct);
        }
        catch (Exception e) when (e is FalhaImpressoraException or InvalidOperationException)
        {
            log.LogWarning(e, "Gaveta não abriu");
            try
            {
                await terminal.RegistrarOcorrenciaAsync(
                    NiveisOcorrencia.Aviso, CodigoOcorrencia.GavetaFalhou, "A gaveta não abriu depois da auditoria gaveta_aberta", e.Message, ct: ct);
                _falhaNoLog = true;
            }
            catch (Exception registro) when (registro is not OperationCanceledException)
            {
                log.LogError(registro, "Falha ao registrar a gaveta que não abriu");
            }

            throw new RegraNegocioException($"A gaveta não abriu ({e.Message}).");
        }
    }

    private async Task<string?> TentarAsync(CancellationToken ct)
    {
        if (!Ligada)
        {
            return null;
        }

        try
        {
            await AbrirAsync(hardware.Atual, ct);
            return null;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogWarning(e, "Gaveta não abriu");
            try
            {
                // O Painel de saúde (G4) lê a falha do log local também depois de reabrir o caixa.
                await terminal.RegistrarOcorrenciaAsync(
                    NiveisOcorrencia.Aviso, CodigoOcorrencia.GavetaFalhou, "A gaveta não abriu na venda ou no movimento do caixa", e.Message, ct: ct);
                _falhaNoLog = true;
            }
            catch (Exception registro) when (registro is not OperationCanceledException)
            {
                log.LogError(registro, "Falha ao registrar a gaveta que não abriu");
            }

            return MensagemNaoAbriu;
        }
    }

    private async Task AbrirAsync(ConfiguracaoHardware c, CancellationToken ct)
    {
        try
        {
            await (c.Impressora.Conexao == TipoConexao.Simulada
                ? simulada.AbrirAsync(ct)
                : new GavetaImpressora(() => c.Gaveta, (bytes, t) => impressora.EnviarComandoAsync(bytes, c.Impressora, t)).AbrirAsync(ct));
            UltimoPulsoOkEm = relogio?.Agora ?? DateTimeOffset.UtcNow;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            UltimaFalhaEm = relogio?.Agora ?? DateTimeOffset.UtcNow;
            throw;
        }

        await RegistrarQueVoltouAsync(ct);
    }

    /// <summary>
    /// O primeiro pulso bom depois de uma falha registrada no <c>log_local</c> grava "a gaveta voltou a abrir" (uma linha
    /// por recuperação; a consulta, uma vez por processo): o Painel do app reaberto compara o último registro da gaveta.
    /// Falha só no log (a gaveta já abriu).
    /// </summary>
    private async Task RegistrarQueVoltouAsync(CancellationToken ct)
    {
        if (_falhaNoLog == false)
        {
            return;
        }

        try
        {
            _falhaNoLog ??= await terminal.UltimoLogAsync(OrigemLog, ct) is { Nivel: not NivelVoltou };
            if (_falhaNoLog == true)
            {
                await terminal.RegistrarOcorrenciaAsync(NivelVoltou, CodigoOcorrencia.GavetaVoltou, "A gaveta voltou a abrir", ct: ct);
                _falhaNoLog = false;
            }
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogError(e, "Falha ao registrar que a gaveta voltou a abrir");
        }
    }
}
