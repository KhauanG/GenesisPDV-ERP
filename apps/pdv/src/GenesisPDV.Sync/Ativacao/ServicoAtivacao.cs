using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Protocolo;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace GenesisPDV.Sync.Ativacao;

/// <summary>Terminal ativado, para a tela de confirmação do assistente (PDV 5.3 passo 4). Nada aqui é segredo.</summary>
public sealed record TerminalAtivado(
    [property: JsonPropertyName("terminal_id")] Guid TerminalId,
    [property: JsonPropertyName("empresa_codigo")] int EmpresaCodigo,
    [property: JsonPropertyName("razao_social")] string RazaoSocial,
    [property: JsonPropertyName("loja_codigo")] int LojaCodigo,
    [property: JsonPropertyName("loja_nome")] string LojaNome,
    [property: JsonPropertyName("loja_cnpj")] string LojaCnpj,
    [property: JsonPropertyName("numero_caixa")] int NumeroCaixa);

/// <summary>Desfecho de uma tentativa: <see cref="Terminal"/> preenchido no sucesso, <see cref="Mensagem"/> na recusa.</summary>
/// <param name="Codigo">Código do envelope de erro da API (2.5) ou nulo (sem conexão, formato, resposta inválida).</param>
public sealed record ResultadoAtivacao(TerminalAtivado? Terminal, string? Mensagem, string? Codigo)
{
    public bool Ativado => Terminal is not null;

    public static ResultadoAtivacao Falha(string mensagem, string? codigo = null) => new(null, mensagem, codigo);
}

/// <summary>
/// Ativação real do terminal (SYNC 3.2–3.5; PDV 5.3). Uma <b>tentativa</b> (mesmo servidor, empresa e código) guarda em
/// memória o <c>requisicao_ativacao_id</c> e os pares de chaves: repetir depois de uma resposta perdida, de um 503 ou de
/// uma falha local leva o mesmo id e as mesmas chaves, e a API devolve o mesmo terminal com token novo (3.4). Mudou
/// algum dos três, nova tentativa. Só a resposta <c>201</c> conferida (token do terminal, chave de backup que abre)
/// grava algo, numa única transação com a auditoria local (<see cref="RepositorioTerminal.RegistrarAtivacaoAsync(DadosAtivacao, CancellationToken)"/>);
/// qualquer recusa deixa o banco local como estava. Token, chave de backup e privada do terminal são gravados já
/// protegidos (<see cref="IProtetorSegredos"/>) e nunca vão para log.
/// </summary>
public sealed class ServicoAtivacao(
    IClienteSync cliente,
    RepositorioTerminal terminal,
    IProtetorSegredos protetor,
    IRelogio relogio,
    MaquinaLocal maquina,
    ILogger<ServicoAtivacao>? log = null)
{
    /// <summary>SYNC 12.2: ida e volta mais longa que isso não serve de amostra de desvio do relógio (o meio erra demais).</summary>
    public static readonly TimeSpan IdaEVoltaMaximaAmostra = TimeSpan.FromSeconds(3);

    private readonly ILogger _log = log ?? NullLogger<ServicoAtivacao>.Instance;
    private Tentativa? _tentativa;

    /// <summary><c>requisicao_ativacao_id</c> da tentativa em andamento (para diagnóstico e testes), ou nulo.</summary>
    public Guid? RequisicaoEmAndamento => _tentativa?.RequisicaoId;

    /// <summary>Passo 2 do assistente: <c>GET /saude</c> do servidor informado.</summary>
    public Task<bool> TestarConexaoAsync(Uri urlApi, CancellationToken ct = default) => cliente.SaudeAsync(urlApi, ct);

    public async Task<ResultadoAtivacao> AtivarAsync(Uri urlApi, string codigoEmpresa, string codigoAtivacao, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(urlApi);
        if ((FormatoAtivacao.ValidarCodigoEmpresa(codigoEmpresa) ?? FormatoAtivacao.ValidarCodigoAtivacao(codigoAtivacao)) is { } invalido)
        {
            return ResultadoAtivacao.Falha(invalido);
        }

        var url = FormatoAtivacao.NormalizarUrl(urlApi);
        var empresa = int.Parse(codigoEmpresa.Trim(), CultureInfo.InvariantCulture);
        var codigo = FormatoAtivacao.NormalizarCodigoAtivacao(codigoAtivacao);
        var tentativa = _tentativa is { } t && t.Mesma(url, empresa, codigo)
            ? t
            : new Tentativa(url, empresa, codigo, IdGerador.Novo(), ChavesTerminal.Gerar());
        _tentativa = tentativa;

        var requisicao = new RequisicaoAtivacao(
            empresa,
            codigo,
            tentativa.RequisicaoId,
            maquina.ParaAtivacao(await terminal.VersaoSchemaLocalAsync(ct).ConfigureAwait(false)),
            tentativa.Chaves.Backup.PublicaSpkiBase64,
            new ChavePublicaTerminal(ChavesTerminal.Algoritmo, tentativa.Chaves.Terminal.PublicaSpkiBase64));
        var enviadaEm = relogio.Agora;
        RespostaAtivacao resposta;
        try
        {
            resposta = await cliente.AtivarAsync(url, requisicao, ct).ConfigureAwait(false);
        }
        catch (ErroSyncException e)
        {
            _log.LogWarning("Ativação recusada pela API: HTTP {Status} {Codigo} (requisição {Requisicao})", (int)e.Status, e.Codigo, tentativa.RequisicaoId);
            return ResultadoAtivacao.Falha(MensagensAtivacao.Para(e), e.Codigo);
        }
        catch (JsonException)
        {
            _log.LogError("Resposta da ativação fora do contrato (requisição {Requisicao})", tentativa.RequisicaoId);
            return ResultadoAtivacao.Falha(MensagensAtivacao.RespostaInvalida);
        }
        catch (Exception e) when (e is HttpRequestException || (e is TaskCanceledException && !ct.IsCancellationRequested))
        {
            _log.LogWarning("Ativação sem resposta do servidor ({Tipo}); a repetição usa a requisição {Requisicao}", e.GetType().Name, tentativa.RequisicaoId);
            return ResultadoAtivacao.Falha(MensagensAtivacao.SemConexao);
        }

        var recebidaEm = relogio.Agora;
        DadosAtivacao dados;
        TerminalAtivado ativado;
        try
        {
            (dados, ativado) = Montar(url, resposta, tentativa.Chaves, enviadaEm, recebidaEm);
        }
        catch (Exception e) when (e is CryptographicException or FormatException or ArgumentException)
        {
            _log.LogError("Resposta da ativação não confere ({Tipo}) para o terminal {Terminal}", e.GetType().Name, resposta.TerminalId);
            return ResultadoAtivacao.Falha(MensagensAtivacao.RespostaInvalida);
        }

        // A auditoria local vai na mesma transação: depois do commit nada mais grava, e uma falha aqui significa que
        // nada ficou gravado (a repetição usa a mesma tentativa).
        await terminal.RegistrarAtivacaoAsync(dados, ct).ConfigureAwait(false);
        _tentativa = null;
        _log.LogInformation("Terminal {Terminal} ativado: empresa {Empresa}, loja {Loja}, caixa {Caixa}",
            ativado.TerminalId, ativado.EmpresaCodigo, ativado.LojaCodigo, ativado.NumeroCaixa);
        return new ResultadoAtivacao(ativado, null, null);
    }

    /// <summary>Monta o estado local da 3.5 a partir da resposta conferida: lança se o token ou a chave de backup não conferem.</summary>
    private (DadosAtivacao, TerminalAtivado) Montar(Uri url, RespostaAtivacao r, ChavesTerminal chaves, DateTimeOffset enviadaEm, DateTimeOffset recebidaEm)
    {
        if (!r.Token.StartsWith($"{r.TerminalId:D}.", StringComparison.Ordinal))
        {
            throw new ArgumentException("Token de outro terminal na resposta da ativação.");
        }

        var chaveBackup = Ecies.Decifrar(Convert.FromBase64String(r.ChaveBackupCifrada), chaves.Backup);
        var tokenProtegido = protetor.Proteger(Encoding.UTF8.GetBytes(r.Token), ProtetorSegredos.FinalidadeToken(r.TerminalId));
        var backupProtegido = protetor.Proteger(chaveBackup, ProtetorSegredos.FinalidadeBackup(r.TerminalId));
        var privadaProtegida = protetor.Proteger(chaves.Terminal.Privada, ProtetorSegredos.FinalidadeChaveTerminal(r.TerminalId));
        CryptographicOperations.ZeroMemory(chaveBackup);

        var identidade = new IdentidadeTerminal
        {
            TerminalId = r.TerminalId,
            EmpresaCodigo = r.Empresa.Codigo,
            LojaId = r.Loja.Id,
            CaixaId = r.Caixa.Id,
            NumeroCaixa = r.Caixa.Numero,
            UrlApi = url.ToString(),
            TokenProtegido = tokenProtegido,
            Status = "ativo",
            AtivadoEm = recebidaEm,
            NomeMaquina = maquina.NomeMaquina,
        };
        var sequencias = new Dictionary<string, long>
        {
            [SequenciaLocal.Venda] = r.Numeracoes.Venda.UltimoNumero,
            [SequenciaLocal.Vale] = r.Numeracoes.Vale.UltimoNumero,
        };
        foreach (var nfce in r.Numeracoes.Nfce)
        {
            sequencias[SequenciaLocal.Nfce(nfce.Serie, nfce.Ambiente)] = nfce.UltimoNumero;
        }

        // Desvio do relógio (12.2): hora do servidor contra o meio da ida e volta, com o par da amostra. A ida e volta
        // mais longa que 3 s (link lento, conexão e TLS contados) é descartada: fica sem desvio e o primeiro
        // heartbeat ou /sync/estado mede.
        var agoraServidor = DateTimeOffset.Parse(r.AgoraServidor, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);
        var idaEVolta = recebidaEm - enviadaEm;
        var amostraValida = idaEVolta >= TimeSpan.Zero && idaEVolta <= IdaEVoltaMaximaAmostra;
        var conexao = new EstadoConexao
        {
            Online = true,
            AgoraServidorUltimo = agoraServidor,
            DesvioRelogioMs = amostraValida ? (long)Math.Round((agoraServidor - (enviadaEm + (idaEVolta / 2))).TotalMilliseconds) : null,
            DesvioAmostraUtcLocal = amostraValida ? recebidaEm : null,
            DesvioAmostraBootId = amostraValida ? IdBoot.Atual() : null,
            MaiorHoraVista = agoraServidor > recebidaEm ? agoraServidor : recebidaEm,
        };
        var ativado = new TerminalAtivado(
            r.TerminalId, r.Empresa.Codigo, r.Empresa.RazaoSocial, r.Loja.Codigo, r.Loja.Nome, r.Loja.Cnpj, r.Caixa.Numero);
        var configuracoes = new Dictionary<string, string>
        {
            [ChavesConfiguracaoTerminal.BackupChave] = JsonSerializer.Serialize(Convert.ToBase64String(backupProtegido)),
            [ChavesConfiguracaoTerminal.ChavePrivadaTerminal] = JsonSerializer.Serialize(
                new ChavePrivadaGravada(ChavesTerminal.Algoritmo, Convert.ToBase64String(privadaProtegida))),
            [ChavesConfiguracaoTerminal.ResumoAtivacao] = JsonSerializer.Serialize(ativado),
            [ChavesConfiguracaoTerminal.ContaAtivacao] = JsonSerializer.Serialize(ContaSistema.Atual()),
        };
        var auditoria = new LogAuditoriaLocal
        {
            Id = IdGerador.Novo(),
            OcorridoEm = recebidaEm,
            Acao = "terminal_ativado",
            Entidade = "terminal",
            RegistroId = r.TerminalId,
            Localizacao = "pdv.ativacao",
            Descricao = $"Terminal ativado: loja {ativado.LojaCodigo} - {ativado.LojaNome}, caixa {ativado.NumeroCaixa:00}",
        };
        return (new DadosAtivacao(identidade, sequencias, conexao, configuracoes, auditoria), ativado);
    }

    private sealed record Tentativa(Uri Url, int Empresa, string Codigo, Guid RequisicaoId, ChavesTerminal Chaves)
    {
        public bool Mesma(Uri url, int empresa, string codigo) => Url == url && Empresa == empresa && Codigo == codigo;
    }
}

/// <summary><c>configuracao_terminal['terminal.chave_privada']</c>: algoritmo e privada protegida (base64).</summary>
public sealed record ChavePrivadaGravada(
    [property: JsonPropertyName("algoritmo")] string Algoritmo,
    [property: JsonPropertyName("protegida")] string Protegida);
