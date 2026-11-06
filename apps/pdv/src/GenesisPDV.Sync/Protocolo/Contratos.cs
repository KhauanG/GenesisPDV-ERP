using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GenesisPDV.Sync.Protocolo;

// Contratos do protocolo de sincronização (sincronizacao.md), no formato que a API valida: os schemas zod de
// packages/shared/src/sync/contratos.ts. Nomes em snake_case como as colunas (2.3); instantes ficam como texto ISO-8601
// UTC (FormatoProtocolo.DataHora) para não mudar de forma na ida e volta. As fixtures de packages/shared/testes/sync
// passam pelos dois lados (GenesisPDV.Sync.Tests/ContratosTests): um campo novo na API sem record aqui quebra o teste.

/// <summary>Opções de JSON do protocolo: nomes pelos atributos, nulo omitido na escrita (o zod da API recusa <c>null</c> em campo só opcional).</summary>
public static class ContratosJson
{
    public static JsonSerializerOptions Opcoes { get; } = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

/// <summary>Fluxos do <c>/sync/pull</c> na ordem da carga inicial (6.1; <c>FLUXOS</c> do shared).</summary>
public static class FluxosSync
{
    public const string Configuracao = "configuracao";
    public const string Acesso = "acesso";
    public const string Referencia = "referencia";
    public const string Catalogo = "catalogo";
    public const string Estoque = "estoque";
    public const string Pessoas = "pessoas";
    public const string Operacao = "operacao";

    public static IReadOnlyList<string> NaOrdem { get; } = [Configuracao, Acesso, Referencia, Catalogo, Estoque, Pessoas, Operacao];
}

/// <summary>Desfecho de cada evento do push (7.4, 8.1–8.4).</summary>
public static class StatusResultadoEvento
{
    public const string Aplicado = "aplicado";
    public const string Duplicado = "duplicado";
    public const string Rejeitado = "rejeitado";
    public const string Retido = "retido";
    public const string Descartado = "descartado";
    public const string ForaDeOrdem = "fora_de_ordem";

    /// <summary>
    /// A sequência caiu numa lacuna já declarada (placeholder <c>terminal.lacuna</c> na nuvem) e o lote não trouxe a
    /// autorização (8.6): <c>resultado.lacuna</c> traz a faixa declarada; o supervisor libera e o PDV reenvia com
    /// <c>recuperar_lacuna</c>. Fase 1C, C15.
    /// </summary>
    public const string LacunaRecuperavel = "lacuna_recuperavel";

    public const string NaoProcessado = "nao_processado";
    public const string ErroTemporario = "erro_temporario";
}

// ---------------------------------------------------------------------------------------------------------------------
// Ativação (3.2)
// ---------------------------------------------------------------------------------------------------------------------

/// <summary><c>POST /sync/ativar</c> (3.2), sem <c>Authorization</c>.</summary>
public sealed record RequisicaoAtivacao(
    [property: JsonPropertyName("codigo_empresa")] int CodigoEmpresa,
    [property: JsonPropertyName("codigo_ativacao")] string CodigoAtivacao,
    [property: JsonPropertyName("requisicao_ativacao_id")] Guid RequisicaoAtivacaoId,
    [property: JsonPropertyName("maquina")] MaquinaAtivacao Maquina,
    [property: JsonPropertyName("chave_backup_publica")] string ChaveBackupPublica,
    [property: JsonPropertyName("chave_publica_terminal")] ChavePublicaTerminal ChavePublicaTerminal);

/// <param name="Plataforma"><c>windows_x64</c> ou <c>linux_x64</c> (<see cref="Cliente.ClienteSyncHttp.PlataformaAtual"/>).</param>
public sealed record MaquinaAtivacao(
    [property: JsonPropertyName("nome_maquina")] string NomeMaquina,
    [property: JsonPropertyName("sistema_operacional")] string SistemaOperacional,
    [property: JsonPropertyName("id_hardware")] string IdHardware,
    [property: JsonPropertyName("versao_app")] string VersaoApp,
    [property: JsonPropertyName("plataforma")] string Plataforma,
    [property: JsonPropertyName("versao_schema_local")] int VersaoSchemaLocal);

/// <param name="Algoritmo"><c>x25519</c> ou <c>p256</c> (TPM, 3.6).</param>
/// <param name="Chave">SPKI DER em base64.</param>
public sealed record ChavePublicaTerminal(
    [property: JsonPropertyName("algoritmo")] string Algoritmo,
    [property: JsonPropertyName("chave")] string Chave);

/// <summary>Resposta <c>201</c> da ativação. O <see cref="Token"/> só aparece aqui e nunca vai para log (o <c>ToString</c> o omite).</summary>
public sealed record RespostaAtivacao(
    [property: JsonPropertyName("terminal_id")] Guid TerminalId,
    [property: JsonPropertyName("token")] string Token,
    [property: JsonPropertyName("token_emitido_em")] string TokenEmitidoEm,
    [property: JsonPropertyName("renovar_token_apos_dias")] int RenovarTokenAposDias,
    [property: JsonPropertyName("empresa")] EmpresaAtivacao Empresa,
    [property: JsonPropertyName("loja")] LojaAtivacao Loja,
    [property: JsonPropertyName("caixa")] CaixaAtivacao Caixa,
    [property: JsonPropertyName("numeracoes")] NumeracoesTerminal Numeracoes,
    [property: JsonPropertyName("sequencia_terminal")] SequenciaAtivacao SequenciaTerminal,
    [property: JsonPropertyName("fluxos")] IReadOnlyList<string> Fluxos,
    [property: JsonPropertyName("chave_backup_cifrada")] string ChaveBackupCifrada,
    [property: JsonPropertyName("intervalos")] IntervalosSync Intervalos,
    [property: JsonPropertyName("versao_protocolo")] int VersaoProtocolo,
    [property: JsonPropertyName("agora_servidor")] string AgoraServidor)
{
    private bool PrintMembers(StringBuilder sb)
    {
        sb.Append("TerminalId = ").Append(TerminalId).Append(", Token = ***, Empresa = ").Append(Empresa)
            .Append(", Loja = ").Append(Loja).Append(", Caixa = ").Append(Caixa);
        return true;
    }
}

public sealed record EmpresaAtivacao(
    [property: JsonPropertyName("codigo")] int Codigo,
    [property: JsonPropertyName("razao_social")] string RazaoSocial);

/// <param name="TipoEmissao"><c>nao_fiscal</c>, <c>sat</c>, <c>mfe</c> ou <c>nfce</c>.</param>
public sealed record LojaAtivacao(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("codigo")] int Codigo,
    [property: JsonPropertyName("nome")] string Nome,
    [property: JsonPropertyName("cnpj")] string Cnpj,
    [property: JsonPropertyName("fuso_horario")] string FusoHorario,
    [property: JsonPropertyName("estoque_id")] Guid EstoqueId,
    [property: JsonPropertyName("tipo_emissao")] string TipoEmissao);

public sealed record CaixaAtivacao(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("numero")] int Numero,
    [property: JsonPropertyName("nfce_serie")] int? NfceSerie);

/// <summary>Últimos números do caixa (13.3): na ativação já vêm com o salto de segurança quando houve terminal anterior sem confirmação.</summary>
public sealed record NumeracoesTerminal(
    [property: JsonPropertyName("venda")] UltimoNumeroSequencia Venda,
    [property: JsonPropertyName("nfce")] IReadOnlyList<NumeracaoNfce> Nfce,
    [property: JsonPropertyName("vale")] UltimoNumeroSequencia Vale);

public sealed record UltimoNumeroSequencia([property: JsonPropertyName("ultimo_numero")] long UltimoNumero);

/// <param name="Ambiente">1 = produção, 2 = homologação.</param>
public sealed record NumeracaoNfce(
    [property: JsonPropertyName("serie")] int Serie,
    [property: JsonPropertyName("ambiente")] int Ambiente,
    [property: JsonPropertyName("ultimo_numero")] long UltimoNumero);

/// <summary>Numa ativação é sempre 0: terminal novo, sequência nova.</summary>
public sealed record SequenciaAtivacao([property: JsonPropertyName("ultima_recebida")] long UltimaRecebida);

/// <summary>Intervalos sugeridos pela nuvem, em segundos (18.2).</summary>
public sealed record IntervalosSync(
    [property: JsonPropertyName("heartbeat_s")] int HeartbeatS,
    [property: JsonPropertyName("pull_s")] int PullS,
    [property: JsonPropertyName("pull_com_sse_s")] int PullComSseS,
    [property: JsonPropertyName("push_pendente_s")] int PushPendenteS);

/// <summary>Versão mínima e disponível do app para a plataforma e o canal da empresa (17.3).</summary>
public sealed record VersoesApp(
    [property: JsonPropertyName("versao_minima")] string? VersaoMinima,
    [property: JsonPropertyName("versao_disponivel")] string? VersaoDisponivel,
    [property: JsonPropertyName("url_pacote")] string? UrlPacote,
    [property: JsonPropertyName("sha256")] string? Sha256,
    [property: JsonPropertyName("atualizar_ate")] string? AtualizarAte);

// ---------------------------------------------------------------------------------------------------------------------
// Rotação do token (3.7)
// ---------------------------------------------------------------------------------------------------------------------

/// <summary>
/// <c>POST /sync/token/renovar</c> (3.7): só o SHA-256 (hex) do segredo novo sobe; <see cref="RequisicaoId"/> é o do
/// <c>token.pendente</c> e também vai em <c>X-Requisicao-Id</c>, repetido em toda nova tentativa.
/// </summary>
public sealed record RequisicaoRenovarToken(
    [property: JsonPropertyName("novo_token_hash")] string NovoTokenHash,
    [property: JsonPropertyName("requisicao_id")] Guid RequisicaoId);

public sealed record RespostaRenovarToken([property: JsonPropertyName("token_emitido_em")] string TokenEmitidoEm);

// ---------------------------------------------------------------------------------------------------------------------
// Handshake (5)
// ---------------------------------------------------------------------------------------------------------------------

/// <summary>Resposta do <c>GET /sync/estado</c> (5): regressão, perda provável, status e hardware antes de liberar o login.</summary>
public sealed record RespostaEstado(
    [property: JsonPropertyName("terminal")] TerminalEstado Terminal,
    [property: JsonPropertyName("empresa_status")] string EmpresaStatus,
    [property: JsonPropertyName("loja")] LojaEstado Loja,
    [property: JsonPropertyName("sequencia_terminal")] SequenciaEstado SequenciaTerminal,
    [property: JsonPropertyName("numeracoes")] NumeracoesTerminal Numeracoes,
    [property: JsonPropertyName("informado_pelo_terminal")] InformadoPeloTerminal InformadoPeloTerminal,
    [property: JsonPropertyName("sessao_caixa_aberta")] SessaoCaixaAberta? SessaoCaixaAberta,
    [property: JsonPropertyName("eventos")] EventosEstado Eventos,
    [property: JsonPropertyName("protocolo")] ProtocoloEstado Protocolo,
    [property: JsonPropertyName("versoes_schema")] IReadOnlyDictionary<string, IReadOnlyList<int>> VersoesSchema,
    [property: JsonPropertyName("app")] VersoesApp App,
    [property: JsonPropertyName("agora_servidor")] string AgoraServidor);

/// <param name="Status"><c>ativo</c> ou <c>desativando</c> (revogado é 401 <c>TERMINAL_REVOGADO</c>).</param>
public sealed record TerminalEstado(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("loja_id")] Guid LojaId,
    [property: JsonPropertyName("caixa_id")] Guid CaixaId,
    [property: JsonPropertyName("numero_caixa")] int NumeroCaixa,
    [property: JsonPropertyName("carencia_ate")] string? CarenciaAte,
    [property: JsonPropertyName("id_hardware_confere")] bool IdHardwareConfere);

public sealed record LojaEstado(
    [property: JsonPropertyName("ativa")] bool Ativa,
    [property: JsonPropertyName("usa_pdv")] bool UsaPdv,
    [property: JsonPropertyName("estoque_id")] Guid? EstoqueId,
    [property: JsonPropertyName("tipo_emissao")] string? TipoEmissao);

public sealed record SequenciaEstado(
    [property: JsonPropertyName("ultima_recebida")] long UltimaRecebida,
    [property: JsonPropertyName("ultimo_evento_id")] Guid? UltimoEventoId,
    [property: JsonPropertyName("ultima_recebida_em")] string? UltimaRecebidaEm);

public sealed record InformadoPeloTerminal(
    [property: JsonPropertyName("ultimo_heartbeat_em")] string? UltimoHeartbeatEm,
    [property: JsonPropertyName("ultima_sequencia_gerada")] long UltimaSequenciaGerada,
    [property: JsonPropertyName("eventos_pendentes")] int EventosPendentes,
    [property: JsonPropertyName("nfce_contingencia_pendentes")] int NfceContingenciaPendentes);

/// <summary>Sessão aberta na nuvem (chega com o caixa na Fase 1C; até lá vem nula).</summary>
public sealed record SessaoCaixaAberta(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("operador_id")] Guid OperadorId,
    [property: JsonPropertyName("aberta_em")] string AbertaEm);

public sealed record EventosEstado(
    [property: JsonPropertyName("com_erro")] int ComErro,
    [property: JsonPropertyName("retidos")] int Retidos);

public sealed record ProtocoloEstado(
    [property: JsonPropertyName("atual")] int Atual,
    [property: JsonPropertyName("minimo")] int Minimo);

// ---------------------------------------------------------------------------------------------------------------------
// Descida (6.3)
// ---------------------------------------------------------------------------------------------------------------------

/// <summary>
/// <c>GET /sync/pull</c> (6.3). Página não cortada → <see cref="NovoCursor"/> = <see cref="CursorTeto"/>; na carga inicial
/// o PDV repete o teto da 1ª página em <c>teto</c> até <see cref="TemMais"/> = false.
/// </summary>
public sealed record RespostaPull(
    [property: JsonPropertyName("fluxo")] string Fluxo,
    [property: JsonPropertyName("desde")] long Desde,
    [property: JsonPropertyName("novo_cursor")] long NovoCursor,
    [property: JsonPropertyName("tem_mais")] bool TemMais,
    [property: JsonPropertyName("cursor_teto")] long CursorTeto,
    [property: JsonPropertyName("agora_servidor")] string AgoraServidor,
    [property: JsonPropertyName("alteracoes")] IReadOnlyList<AlteracaoPull> Alteracoes);

/// <summary>Linha inteira na projeção do fluxo (datas ISO UTC, decimais em texto); tombstone = <c>excluido_em</c> preenchido.</summary>
public sealed record AlteracaoPull(
    [property: JsonPropertyName("tabela")] string Tabela,
    [property: JsonPropertyName("versao")] long Versao,
    [property: JsonPropertyName("linha")] JsonElement Linha);

// ---------------------------------------------------------------------------------------------------------------------
// Subida (7.3, 7.4)
// ---------------------------------------------------------------------------------------------------------------------

/// <summary>
/// <c>POST /sync/push</c> (7.4): o mesmo <see cref="LoteId"/> (e o mesmo <c>X-Requisicao-Id</c>) em todo reenvio do lote.
/// Fase 1C, C15 (8.6): <see cref="DeclararLacuna"/> vai num lote sem eventos; <see cref="RecuperarLacuna"/>, no lote cujo
/// evento da frente caiu num placeholder de lacuna. Os dois nunca vão juntos.
/// </summary>
public sealed record RequisicaoPush(
    [property: JsonPropertyName("lote_id")] Guid LoteId,
    [property: JsonPropertyName("terminal_id")] Guid TerminalId,
    [property: JsonPropertyName("enviado_em")] string EnviadoEm,
    [property: JsonPropertyName("eventos_pendentes_total")] int? EventosPendentesTotal,
    [property: JsonPropertyName("eventos")] IReadOnlyList<EnvelopeEvento> Eventos,
    [property: JsonPropertyName("declarar_lacuna")] DeclaracaoLacuna? DeclararLacuna = null,
    [property: JsonPropertyName("recuperar_lacuna")] RecuperacaoLacuna? RecuperarLacuna = null);

/// <summary>Motivos da declaração de lacuna (<c>MOTIVOS_LACUNA</c> do shared; SYNC 8.6).</summary>
public static class MotivosLacuna
{
    /// <summary>As sequências não existem mais no banco local (linhas perdidas, bug).</summary>
    public const string BancoLocalPerdido = "banco_local_perdido";

    /// <summary>A nuvem foi restaurada de backup (22.5) e o caixa não tem mais o payload.</summary>
    public const string RestauracaoBackup = "restauracao_backup";

    public const string Outro = "outro";
}

/// <summary>
/// <c>declarar_lacuna</c> (8.6): as sequências <see cref="De"/>..<see cref="Ate"/> não existem mais em lugar nenhum; a
/// nuvem só aceita a faixa que começa na <c>proxima_sequencia_esperada</c> e grava um placeholder por sequência. O
/// supervisor (com <c>pdv.config.fiscal</c>, conferido na nuvem) em <see cref="AutorizadoPorId"/>, o motivo da
/// liberação em <see cref="Observacao"/>.
/// </summary>
public sealed record DeclaracaoLacuna(
    [property: JsonPropertyName("de")] long De,
    [property: JsonPropertyName("ate")] long Ate,
    [property: JsonPropertyName("motivo")] string Motivo,
    [property: JsonPropertyName("observacao")] string? Observacao,
    [property: JsonPropertyName("autorizado_por_id")] Guid AutorizadoPorId);

/// <summary><c>recuperar_lacuna</c> (8.6): o supervisor autorizou substituir os placeholders da faixa pelos eventos reais.</summary>
public sealed record RecuperacaoLacuna(
    [property: JsonPropertyName("de")] long De,
    [property: JsonPropertyName("ate")] long Ate,
    [property: JsonPropertyName("autorizado_por_id")] Guid AutorizadoPorId);

/// <summary>Envelope de cada evento (7.3). <see cref="Payload"/> é o JSON gravado no outbox; o hash é o do JCS dele.</summary>
public sealed record EnvelopeEvento(
    [property: JsonPropertyName("evento_id")] Guid EventoId,
    [property: JsonPropertyName("terminal_id")] Guid? TerminalId,
    [property: JsonPropertyName("sequencia")] long Sequencia,
    [property: JsonPropertyName("tipo")] string Tipo,
    [property: JsonPropertyName("versao_schema")] int VersaoSchema,
    [property: JsonPropertyName("agregado_tipo")] string AgregadoTipo,
    [property: JsonPropertyName("agregado_id")] Guid AgregadoId,
    [property: JsonPropertyName("dependencias")] IReadOnlyList<DependenciaEvento> Dependencias,
    [property: JsonPropertyName("ocorrido_em")] string OcorridoEm,
    [property: JsonPropertyName("ocorrido_em_local")] string? OcorridoEmLocal,
    [property: JsonPropertyName("desvio_relogio_ms")] long? DesvioRelogioMs,
    [property: JsonPropertyName("relogio_confiavel")] bool? RelogioConfiavel,
    [property: JsonPropertyName("relogio_regrediu")] bool? RelogioRegrediu,
    [property: JsonPropertyName("usuario_id")] Guid? UsuarioId,
    [property: JsonPropertyName("contexto")] ContextoEvento Contexto,
    [property: JsonPropertyName("payload")] JsonElement Payload,
    [property: JsonPropertyName("payload_sha256")] string PayloadSha256);

public sealed record DependenciaEvento(
    [property: JsonPropertyName("agregado_tipo")] string AgregadoTipo,
    [property: JsonPropertyName("agregado_id")] Guid AgregadoId);

/// <summary>Estado local no momento do fato (7.3): <see cref="EstoqueId"/> é o <c>lojas.estoque_id</c> vigente no PDV.</summary>
public sealed record ContextoEvento(
    [property: JsonPropertyName("loja_id")] Guid LojaId,
    [property: JsonPropertyName("caixa_id")] Guid CaixaId,
    [property: JsonPropertyName("numero_caixa")] int? NumeroCaixa,
    [property: JsonPropertyName("estoque_id")] Guid? EstoqueId,
    [property: JsonPropertyName("sessao_caixa_id")] Guid? SessaoCaixaId,
    [property: JsonPropertyName("versao_app")] string? VersaoApp,
    [property: JsonPropertyName("versao_schema_local")] int? VersaoSchemaLocal);

/// <summary>Resposta <c>200</c> do push: sempre 200 quando o lote foi lido; o resultado é por evento (7.4).</summary>
public sealed record RespostaPush(
    [property: JsonPropertyName("lote_id")] Guid LoteId,
    [property: JsonPropertyName("recebido_em")] string RecebidoEm,
    [property: JsonPropertyName("agora_servidor")] string AgoraServidor,
    [property: JsonPropertyName("proxima_sequencia_esperada")] long ProximaSequenciaEsperada,
    [property: JsonPropertyName("resultados")] IReadOnlyList<ResultadoEventoPush> Resultados,
    [property: JsonPropertyName("comandos")] IReadOnlyList<ComandoTerminal> Comandos);

/// <param name="Status">Um de <see cref="StatusResultadoEvento"/>.</param>
public sealed record ResultadoEventoPush(
    [property: JsonPropertyName("evento_id")] Guid EventoId,
    [property: JsonPropertyName("sequencia")] long Sequencia,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("versao_nuvem")] long? VersaoNuvem,
    [property: JsonPropertyName("versao_nuvem_fim")] long? VersaoNuvemFim,
    [property: JsonPropertyName("resultado")] JsonElement? Resultado,
    [property: JsonPropertyName("erro")] ErroEvento? Erro);

public sealed record ErroEvento(
    [property: JsonPropertyName("codigo")] string Codigo,
    [property: JsonPropertyName("mensagem")] string Mensagem);

/// <summary>Comando da nuvem para o terminal (21.1), repetido até o ack em <c>comandos_resultado</c>.</summary>
public sealed record ComandoTerminal(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("tipo")] string Tipo,
    [property: JsonPropertyName("parametros")] JsonElement Parametros);

// ---------------------------------------------------------------------------------------------------------------------
// Heartbeat (21.1)
// ---------------------------------------------------------------------------------------------------------------------

/// <summary><c>POST /sync/heartbeat</c> (21.1): telemetria, números informados e acks. Campo nulo não é enviado.</summary>
public sealed record RequisicaoHeartbeat
{
    [JsonPropertyName("versao_app")] public string? VersaoApp { get; init; }

    /// <summary><c>ativo</c>, <c>desativando</c> ou <c>desativando_confirmado</c> (3.8).</summary>
    [JsonPropertyName("estado_local")] public string EstadoLocal { get; init; } = "ativo";

    [JsonPropertyName("so")] public string? So { get; init; }
    [JsonPropertyName("hora_local")] public string? HoraLocal { get; init; }
    [JsonPropertyName("desvio_relogio_ms")] public long? DesvioRelogioMs { get; init; }
    [JsonPropertyName("relogio_confiavel")] public bool? RelogioConfiavel { get; init; }
    [JsonPropertyName("cursor_pull")] public IReadOnlyDictionary<string, long>? CursorPull { get; init; }
    [JsonPropertyName("ultimo_pull_sucesso_em")] public string? UltimoPullSucessoEm { get; init; }
    [JsonPropertyName("eventos_pendentes")] public int EventosPendentes { get; init; }
    [JsonPropertyName("evento_mais_antigo_em")] public string? EventoMaisAntigoEm { get; init; }
    [JsonPropertyName("eventos_rejeitados")] public int EventosRejeitados { get; init; }
    [JsonPropertyName("ultima_sequencia_gerada")] public long? UltimaSequenciaGerada { get; init; }
    [JsonPropertyName("venda_ultimo_numero")] public long? VendaUltimoNumero { get; init; }
    [JsonPropertyName("vale_ultimo_numero")] public long? ValeUltimoNumero { get; init; }
    [JsonPropertyName("nfce_ultimo_numero")] public IReadOnlyList<NfceUltimoNumero>? NfceUltimoNumero { get; init; }
    [JsonPropertyName("nfce_contingencia_pendentes")] public int NfceContingenciaPendentes { get; init; }
    [JsonPropertyName("nfce_contingencia_mais_antiga_em")] public string? NfceContingenciaMaisAntigaEm { get; init; }
    [JsonPropertyName("inutilizacoes_pendentes")] public int InutilizacoesPendentes { get; init; }
    [JsonPropertyName("sessao_caixa_id")] public Guid? SessaoCaixaId { get; init; }
    [JsonPropertyName("operador_id")] public Guid? OperadorId { get; init; }

    /// <summary>Dinheiro em texto com 2 casas (<see cref="FormatoProtocolo.Dinheiro"/>).</summary>
    [JsonPropertyName("dinheiro_estimado_gaveta")] public string? DinheiroEstimadoGaveta { get; init; }

    [JsonPropertyName("certificado_validade")] public string? CertificadoValidade { get; init; }
    [JsonPropertyName("disco_livre_mb")] public int? DiscoLivreMb { get; init; }
    [JsonPropertyName("tamanho_banco_mb")] public int? TamanhoBancoMb { get; init; }
    [JsonPropertyName("fila_impressao_pendentes")] public int FilaImpressaoPendentes { get; init; }
    [JsonPropertyName("sse_conectado")] public bool? SseConectado { get; init; }
    [JsonPropertyName("versao_schema_local")] public int? VersaoSchemaLocal { get; init; }
    [JsonPropertyName("ultimo_erro")] public string? UltimoErro { get; init; }
    [JsonPropertyName("vendas_cancelamento_pendente")] public IReadOnlyList<Guid> VendasCancelamentoPendente { get; init; } = [];
    [JsonPropertyName("eventos_resolvidos_ack")] public IReadOnlyList<Guid> EventosResolvidosAck { get; init; } = [];
    [JsonPropertyName("comandos_resultado")] public IReadOnlyList<ResultadoComando> ComandosResultado { get; init; } = [];
}

public sealed record NfceUltimoNumero(
    [property: JsonPropertyName("serie")] int Serie,
    [property: JsonPropertyName("ambiente")] int Ambiente,
    [property: JsonPropertyName("numero")] long Numero);

/// <param name="Status"><c>recebido</c> (continua sendo reenviado), <c>executado</c> ou <c>falhou</c>.</param>
public sealed record ResultadoComando(
    [property: JsonPropertyName("comando_id")] Guid ComandoId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("resultado")] JsonElement? Resultado = null);

/// <summary>Resposta do heartbeat (21.1).</summary>
/// <param name="StatusTerminal"><c>ativo</c>, <c>desativando</c>, <c>revogado</c> (desativação confirmada) ou <c>hardware_alterado</c>.</param>
public sealed record RespostaHeartbeat(
    [property: JsonPropertyName("agora_servidor")] string AgoraServidor,
    [property: JsonPropertyName("status_terminal")] string StatusTerminal,
    [property: JsonPropertyName("comandos")] IReadOnlyList<ComandoTerminal> Comandos,
    [property: JsonPropertyName("eventos_resolvidos")] IReadOnlyList<EventoResolvido> EventosResolvidos,
    [property: JsonPropertyName("renovar_token")] bool RenovarToken,
    [property: JsonPropertyName("app")] VersoesApp App,
    [property: JsonPropertyName("intervalos")] IntervalosSync Intervalos);

/// <summary>Evento resolvido depois do push (reprocessado ou descartado no ERP); o PDV confirma em <c>eventos_resolvidos_ack</c>.</summary>
public sealed record EventoResolvido(
    [property: JsonPropertyName("evento_id")] Guid EventoId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("versao_nuvem")] long? VersaoNuvem,
    [property: JsonPropertyName("versao_nuvem_fim")] long? VersaoNuvemFim,
    [property: JsonPropertyName("resultado")] JsonElement? Resultado);

/// <summary>
/// Resposta do <c>GET /sync/eventos-status?ids=</c> (7.2, 21.1): a rede de segurança dos <c>rejeitado</c>, consultada a cada
/// 1 h. Só os ids que a nuvem tem deste terminal, na ordem da sequência; nada é confirmado (o ack é o do heartbeat).
/// </summary>
public sealed record RespostaEventosStatus(
    [property: JsonPropertyName("agora_servidor")] string AgoraServidor,
    [property: JsonPropertyName("eventos")] IReadOnlyList<StatusEventoNuvem> Eventos);

/// <summary>
/// Situação atual na nuvem de um evento do terminal: o formato de <see cref="EventoResolvido"/>, mais <c>erro</c> e
/// <c>retido</c> (ainda sem decisão no ERP; o PDV não muda nada), estes com o <see cref="Erro"/> gravado.
/// </summary>
/// <param name="Status"><c>aplicado</c>, <c>descartado</c>, <c>erro</c> ou <c>retido</c>.</param>
public sealed record StatusEventoNuvem(
    [property: JsonPropertyName("evento_id")] Guid EventoId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("versao_nuvem")] long? VersaoNuvem,
    [property: JsonPropertyName("versao_nuvem_fim")] long? VersaoNuvemFim,
    [property: JsonPropertyName("resultado")] JsonElement? Resultado,
    [property: JsonPropertyName("erro")] ErroEvento? Erro = null)
{
    /// <summary>Decidido no ERP (<c>aplicado</c> ou <c>descartado</c>): vira o mesmo <see cref="EventoResolvido"/> do heartbeat.</summary>
    public EventoResolvido? ComoResolvido() => Status is StatusResultadoEvento.Aplicado or StatusResultadoEvento.Descartado
        ? new EventoResolvido(EventoId, Status, VersaoNuvem, VersaoNuvemFim, Resultado)
        : null;
}

/// <summary>
/// Resposta do <c>GET /sync/recuperar?desde_sequencia=&amp;limite=</c> (22.1, 22.2; Fase 1C, C17): a re-hidratação, os
/// eventos deste terminal depois da sequência pedida, em ordem. <see cref="UltimaRecebida"/> é a maior sequência que a
/// nuvem tem (placeholders incluídos); com <see cref="TemMais"/>, a próxima página começa na última sequência desta.
/// </summary>
public sealed record RespostaRecuperar(
    [property: JsonPropertyName("agora_servidor")] string AgoraServidor,
    [property: JsonPropertyName("desde_sequencia")] long DesdeSequencia,
    [property: JsonPropertyName("ultima_recebida")] long UltimaRecebida,
    [property: JsonPropertyName("tem_mais")] bool TemMais,
    [property: JsonPropertyName("eventos")] IReadOnlyList<EventoRecuperado> Eventos);

/// <summary>
/// Um evento da re-hidratação: o envelope original (o <see cref="EnvelopeEvento.Payload"/> vem <c>null</c> quando a nuvem
/// já o anulou, 13 meses) e a situação na nuvem, no formato do <see cref="StatusEventoNuvem"/>. <see cref="Lacuna"/>
/// marca o placeholder de uma lacuna declarada (<c>terminal.lacuna</c>, 8.6; T7): não há o que recriar.
/// </summary>
/// <param name="Status"><c>aplicado</c>, <c>descartado</c>, <c>erro</c> ou <c>retido</c>.</param>
public sealed record EventoRecuperado(
    [property: JsonPropertyName("envelope")] EnvelopeEvento Envelope,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("versao_nuvem")] long? VersaoNuvem,
    [property: JsonPropertyName("versao_nuvem_fim")] long? VersaoNuvemFim,
    [property: JsonPropertyName("resultado")] JsonElement? Resultado,
    [property: JsonPropertyName("lacuna")] bool Lacuna,
    [property: JsonPropertyName("erro")] ErroEvento? Erro = null)
{
    /// <summary>A nuvem ainda tem o payload (não é placeholder nem anulado): dá para recriar o fato no caixa.</summary>
    [JsonIgnore]
    public bool TemPayload => !Lacuna && Envelope.Payload.ValueKind == JsonValueKind.Object;
}

// ---------------------------------------------------------------------------------------------------------------------
// Erro (2.4)
// ---------------------------------------------------------------------------------------------------------------------

/// <summary>Envelope de erro HTTP (2.4).</summary>
public sealed record ErroApi(
    [property: JsonPropertyName("codigo")] string Codigo,
    [property: JsonPropertyName("mensagem")] string Mensagem,
    [property: JsonPropertyName("detalhes")] JsonElement? Detalhes,
    [property: JsonPropertyName("requisicao_id")] Guid? RequisicaoId);

public sealed record EnvelopeErro([property: JsonPropertyName("erro")] ErroApi Erro);
