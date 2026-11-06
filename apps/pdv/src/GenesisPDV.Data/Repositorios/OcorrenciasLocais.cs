using System.Text.Json;
using System.Text.Json.Nodes;
using GenesisPDV.Data.Entidades;

namespace GenesisPDV.Data.Repositorios;

/// <summary>
/// As origens padronizadas do <c>log_local</c> (Central do PDV, bloco G8; plano 5.5): de onde veio a ocorrência. O
/// filtro da aba 5 Logs e ocorrências usa estas; cada uma tem ao menos um <see cref="CodigoOcorrencia"/> (caixa e venda
/// entram com o primeiro ponto de gravação delas). As linhas de antes desta versão podem ter <see cref="Legado"/>
/// (<c>app</c>), lida como <see cref="Sistema"/>.
/// </summary>
public static class OrigensOcorrencia
{
    public const string Impressora = "impressora";
    public const string Gaveta = "gaveta";
    public const string Sync = "sync";
    public const string Backup = "backup";
    public const string Login = "login";
    public const string Sistema = "sistema";

    /// <summary>A origem das linhas gravadas antes do G8 pelo erro inesperado da tela (hoje <see cref="Sistema"/>).</summary>
    public const string Legado = "app";

    /// <summary>Na ordem do filtro da aba 5.</summary>
    public static IReadOnlyList<string> Todas { get; } = [Impressora, Gaveta, Sync, Backup, Login, Sistema];

    /// <summary>As origens gravadas no banco que valem como <paramref name="origem"/> (o sistema inclui o legado).</summary>
    public static IReadOnlyList<string> NoBanco(string origem) => origem == Sistema ? [Sistema, Legado] : [origem];

    /// <summary>A origem padronizada de uma linha do banco (o legado vira sistema).</summary>
    public static string Normalizar(string? origem) => origem is null or Legado ? Sistema : origem;
}

/// <summary>Os níveis do <c>log_local</c> (<c>ck_log_local_nivel</c>), do menos ao mais grave.</summary>
public static class NiveisOcorrencia
{
    public const string Debug = "debug";
    public const string Info = "info";
    public const string Aviso = "aviso";
    public const string Erro = "erro";
    public const string Critico = "critico";

    public static IReadOnlyList<string> Todos { get; } = [Debug, Info, Aviso, Erro, Critico];

    /// <summary>O nível e os mais graves que ele (<c>aviso</c> → aviso, erro e crítico).</summary>
    public static IReadOnlyList<string> APartirDe(string minimo)
    {
        var i = Math.Max(0, Todos.ToList().IndexOf(minimo));
        return [.. Todos.Skip(i)];
    }
}

/// <summary>
/// O código curto de uma ocorrência do <c>log_local</c> (Central do PDV, bloco G8; plano 5.5): estável, com a origem
/// dele, gravado no <c>detalhes</c> (JSON, sem mudar o schema). O conjunto é <b>fechado</b> (construtor privado): todo
/// ponto de gravação usa um destes, e o <c>CatalogoOcorrencias</c> do App tem a dica ("o que fazer") de cada um (o teste
/// confere por reflexão). Código novo entra aqui e no catálogo.
/// </summary>
public sealed class CodigoOcorrencia
{
    private CodigoOcorrencia(string codigo, string origem)
    {
        Codigo = codigo;
        Origem = origem;
    }

    public string Codigo { get; }

    public string Origem { get; }

    /// <summary>Um documento (cupom, comprovante, relatório) não saiu na impressora; ficou na fila.</summary>
    public static CodigoOcorrencia ImpressaoFalhou { get; } = new("IMPRESSAO_FALHOU", OrigensOcorrencia.Impressora);

    /// <summary>
    /// Um documento que só vale na hora (o QR do PIX, na frente do cliente) não saiu: fica <c>cancelado</c>, fora da fila
    /// e do F7 (nunca sai horas depois, com a venda encerrada).
    /// </summary>
    public static CodigoOcorrencia ImpressaoFalhouSemFila { get; } = new("IMPRESSAO_FALHOU_SEM_FILA", OrigensOcorrencia.Impressora);

    /// <summary>A nova tentativa dos documentos da fila (F7 na aba 3) parou num que não saiu.</summary>
    public static CodigoOcorrencia FilaImpressaoParou { get; } = new("FILA_IMPRESSAO_PAROU", OrigensOcorrencia.Impressora);

    /// <summary>A configuração da impressora, da gaveta ou da tela do caixa foi gravada (aba 3; a auditoria tem o antes e o depois).</summary>
    public static CodigoOcorrencia ConfiguracaoAlterada { get; } = new("CONFIGURACAO_ALTERADA", OrigensOcorrencia.Impressora);

    /// <summary>O pulso da gaveta não saiu (na venda, no movimento, no F11 › 9 ou no teste).</summary>
    public static CodigoOcorrencia GavetaFalhou { get; } = new("GAVETA_FALHOU", OrigensOcorrencia.Gaveta);

    /// <summary>A gaveta voltou a abrir depois de uma falha registrada.</summary>
    public static CodigoOcorrencia GavetaVoltou { get; } = new("GAVETA_VOLTOU", OrigensOcorrencia.Gaveta);

    /// <summary>A nuvem recusou (rejeitou, reteve ou descartou) um registro enviado; o código dela fica em <c>codigo_nuvem</c>.</summary>
    public static CodigoOcorrencia RegistroRecusado { get; } = new("REGISTRO_RECUSADO", OrigensOcorrencia.Sync);

    /// <summary>O ERP decidiu um registro recusado (reprocessou e a nuvem aceitou, ou descartou).</summary>
    public static CodigoOcorrencia RegistroResolvidoErp { get; } = new("REGISTRO_RESOLVIDO_ERP", OrigensOcorrencia.Sync);

    /// <summary>Um comando do ERP (ressincronizar, mensagem, enviar logs…) não pôde ser feito neste caixa.</summary>
    public static CodigoOcorrencia ComandoFalhou { get; } = new("COMANDO_FALHOU", OrigensOcorrencia.Sync);

    /// <summary>O ERP mandou uma mensagem ao operador (comando <c>mensagem</c>).</summary>
    public static CodigoOcorrencia MensagemErp { get; } = new("MENSAGEM_ERP", OrigensOcorrencia.Sync);

    /// <summary>A recuperação da 22.1 no handshake (regressão, perda provável ou restauração): o salto da numeração.</summary>
    public static CodigoOcorrencia Recuperacao { get; } = new("RECUPERACAO_NUMERACAO", OrigensOcorrencia.Sync);

    /// <summary>O backup (periódico, do fechamento ou da saída) não foi feito.</summary>
    public static CodigoOcorrencia BackupFalhou { get; } = new("BACKUP_FALHOU", OrigensOcorrencia.Backup);

    /// <summary>O backup principal foi feito, mas a cópia para a pasta secundária (pendrive, rede) falhou.</summary>
    public static CodigoOcorrencia BackupCopiaFalhou { get; } = new("BACKUP_COPIA_FALHOU", OrigensOcorrencia.Backup);

    /// <summary>"Fazer backup agora" da aba 8 Backup da Central (bloco G11): o backup manual foi feito.</summary>
    public static CodigoOcorrencia BackupManual { get; } = new("BACKUP_MANUAL", OrigensOcorrencia.Backup);

    /// <summary>
    /// Os parâmetros do caixa (tema, bloqueio da tela por inatividade, pasta secundária do backup) foram gravados (aba 7
    /// Parâmetros da Central ou o Ctrl+Alt+T, bloco G11; a auditoria tem o antes e o depois).
    /// </summary>
    public static CodigoOcorrencia ParametroAlterado { get; } = new("PARAMETRO_ALTERADO", OrigensOcorrencia.Sistema);

    /// <summary>
    /// O pacote de suporte foi gerado (aba P da Central, ou a tela de erro com o banco aberto; bloco G9): o arquivo, o
    /// SHA-256 e o destino (pendrive ou Documentos); quem gerou fica na auditoria <c>exportar</c>.
    /// </summary>
    public static CodigoOcorrencia PacoteGerado { get; } = new("PACOTE_GERADO", OrigensOcorrencia.Sistema);

    /// <summary>"Modo restaurado" offline: a numeração saltou sem o handshake (22.1).</summary>
    public static CodigoOcorrencia RestauradoOffline { get; } = new("RESTAURADO_OFFLINE", OrigensOcorrencia.Backup);

    /// <summary>O PIN de um usuário veio da nuvem com o argon2 fora dos limites (SYNC 4.2): não loga offline.</summary>
    public static CodigoOcorrencia PinForaDosLimites { get; } = new("PIN_FORA_DOS_LIMITES", OrigensOcorrencia.Login);

    /// <summary>Erro não tratado na tela (32.2): a venda foi preservada e recarregada do banco.</summary>
    public static CodigoOcorrencia ErroInesperado { get; } = new("ERRO_INESPERADO", OrigensOcorrencia.Sistema);

    /// <summary>Todos os códigos (o catálogo e o teste).</summary>
    public static IReadOnlyList<CodigoOcorrencia> Todos { get; } =
    [
        ImpressaoFalhou, ImpressaoFalhouSemFila, FilaImpressaoParou, ConfiguracaoAlterada, GavetaFalhou, GavetaVoltou, RegistroRecusado, RegistroResolvidoErp,
        ComandoFalhou, MensagemErp, Recuperacao, BackupFalhou, BackupCopiaFalhou, BackupManual, RestauradoOffline, PinForaDosLimites,
        ParametroAlterado, PacoteGerado, ErroInesperado,
    ];

    public override string ToString() => Codigo;
}

/// <summary>
/// Monta as linhas do <c>log_local</c> (Central do PDV, bloco G8; plano 5.5): o único lugar do código que cria um
/// <see cref="LogLocal"/> (o teste confere). A origem vem do <see cref="CodigoOcorrencia"/>; o <c>detalhes</c> é um JSON
/// com o <c>codigo</c>, os dados que ligam a ocorrência (ids do evento, da venda) e, em <c>texto</c>, o detalhe técnico
/// (a mensagem da exceção). Nada de payload, PIN ou token: a tela mascara de novo (<c>MascaradorSuporte</c>), mas a
/// primeira barreira é não gravar.
/// </summary>
public static class Ocorrencias
{
    public const string CampoCodigo = "codigo";

    /// <summary>Acentos como texto (o "não" procurado na aba 5 acha o detalhe; o JSON fica só no banco local, nunca numa página).</summary>
    private static readonly JsonSerializerOptions Json = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    public const string CampoTexto = "texto";

    public static LogLocal Nova(
        DateTimeOffset agora, string nivel, CodigoOcorrencia codigo, string mensagem, JsonObject? dados = null, string? texto = null)
    {
        ArgumentNullException.ThrowIfNull(codigo);
        ArgumentException.ThrowIfNullOrWhiteSpace(mensagem);
        if (!NiveisOcorrencia.Todos.Contains(nivel))
        {
            throw new ArgumentOutOfRangeException(nameof(nivel), nivel, "Nível fora do ck_log_local_nivel.");
        }

        var detalhes = new JsonObject { [CampoCodigo] = codigo.Codigo };
        if (dados is not null)
        {
            foreach (var (chave, valor) in dados)
            {
                if (chave != CampoCodigo)
                {
                    detalhes[chave] = valor?.DeepClone();
                }
            }
        }

        if (!string.IsNullOrWhiteSpace(texto))
        {
            detalhes[CampoTexto] = texto;
        }

        return new LogLocal { OcorridoEm = agora, Nivel = nivel, Origem = codigo.Origem, Mensagem = mensagem, Detalhes = detalhes.ToJsonString(Json) };
    }

    /// <summary>O código gravado no <c>detalhes</c> (nulo nas linhas de antes do G8, com texto solto ou sem detalhes).</summary>
    public static string? CodigoDe(string? detalhes)
    {
        if (string.IsNullOrWhiteSpace(detalhes) || !detalhes.TrimStart().StartsWith('{'))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(detalhes) is JsonObject o && o[CampoCodigo] is JsonValue v && v.TryGetValue<string>(out var codigo) ? codigo : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
