using GenesisPDV.Data.Convencoes;

namespace GenesisPDV.Data.Entidades;

// Tabelas exclusivamente locais do PDV (modelo de dados 4.4). Nomes de coluna = nomes das propriedades em snake_case.

/// <summary><c>identidade_terminal</c> (4.4.1): linha única com o vínculo do terminal.</summary>
public class IdentidadeTerminal
{
    public const int IdUnico = 1;

    /// <summary><c>url_api</c> da ativação de demonstração (F8): sem nuvem, token vazio; o serviço real a ignora.</summary>
    public const string UrlDemonstracao = "demonstracao://local";

    public int Id { get; set; } = IdUnico;
    public Guid TerminalId { get; set; }
    public int EmpresaCodigo { get; set; }
    public Guid LojaId { get; set; }
    public Guid CaixaId { get; set; }
    public int NumeroCaixa { get; set; }
    public string UrlApi { get; set; } = string.Empty;
    public byte[] TokenProtegido { get; set; } = [];
    public string Status { get; set; } = "ativo";
    public DateTimeOffset AtivadoEm { get; set; }
    public string NomeMaquina { get; set; } = string.Empty;
    public int VersaoSchemaLocal { get; set; }
    public DateTimeOffset? UltimoBackupEm { get; set; }

    /// <summary>Gravado por toda restauração de backup; o handshake aplica a regra de restauração (SYNC 5, 22.1).</summary>
    public DateTimeOffset? RestauradoEm { get; set; }

    /// <summary>Terminal de demonstração (F8): não tem token nem nuvem (só leitura; não é coluna).</summary>
    public bool Demonstracao => UrlApi == UrlDemonstracao;

    /// <summary>
    /// Código curto do terminal para o suporte e o log (Central do PDV, bloco G2; README › decisão 67), como
    /// <c>cx2-9f3a01bc</c>: o número do caixa e os 8 <b>últimos</b> dígitos do <c>terminal_id</c> (o UUIDv7 começa pelo
    /// horário, e dois caixas ativados no mesmo minuto teriam o mesmo começo). Só leitura; não é coluna.
    /// </summary>
    public string CodigoCurto => $"cx{NumeroCaixa.ToString(System.Globalization.CultureInfo.InvariantCulture)}-{TerminalId.ToString("N")[^8..]}";
}

/// <summary><c>identidade_terminal.status</c> (SYNC 3.8), na ordem em que avança (nunca volta).</summary>
public static class StatusIdentidade
{
    public const string Ativo = "ativo";
    public const string Desativando = "desativando";
    public const string Revogado = "revogado";

    public static readonly string[] Ordem = [Ativo, Desativando, Revogado];
}

/// <summary>
/// Chaves internas de <c>configuracao_terminal</c>, gravadas pela ativação e pela rotação do token (SYNC 3.5, 3.7; MD
/// 4.4.2): nunca editáveis no Ctrl+Alt+C nem enviadas em <c>terminal.configuracao_alterada</c> (<see cref="Internas"/>).
/// </summary>
public static class ChavesConfiguracaoTerminal
{
    /// <summary>Chave de backup (32 bytes) decifrada do envelope da ativação e re-protegida pelo protetor local (SYNC 3.5).</summary>
    public const string BackupChave = "backup.chave";

    /// <summary>Privada X25519 permanente do terminal (par da <c>chave_publica_terminal</c>), protegida (SYNC 3.2, 20.2).</summary>
    public const string ChavePrivadaTerminal = "terminal.chave_privada";

    /// <summary>Token novo da rotação, protegido, com o <c>requisicao_id</c> do <c>POST /sync/token/renovar</c> (SYNC 3.7).</summary>
    public const string TokenPendente = "token.pendente";

    /// <summary>
    /// Resumo da ativação (empresa, razão social, loja, CNPJ e caixa; nada secreto): cabeçalho do login até os espelhos
    /// de loja e caixa descerem.
    /// </summary>
    public const string ResumoAtivacao = "ativacao.resumo";

    /// <summary>
    /// Restauração de backup ainda não resolvida pelo handshake (<c>Backup.RestauracaoPendente</c>; SYNC 5, 22.1; Fase 1C,
    /// C17): gravada pela restauração no arquivo restaurado e apagada quando o handshake aplica o salto ou a prova.
    /// </summary>
    public const string RestauracaoPendente = "restauracao.pendente";

    /// <summary>
    /// Reidratação (SYNC 22.2; Fase 1C, C17) começada e não concluída (<c>Recuperacao.ReidratacaoPendente</c> do Sync):
    /// gravada no passo 1, junto com as sequências provisórias, e apagada no passo 3. Enquanto existe, o push não manda
    /// nada e o handshake reidrata de novo, também depois de reabrir o app.
    /// </summary>
    public const string ReidratacaoPendente = "reidratacao.pendente";

    /// <summary>
    /// Conta do sistema que ativou o terminal (<c>DOMÍNIO\usuário</c> no Windows; implantação I3): o token só abre nela
    /// (DPAPI CurrentUser, D21), e a tela de outra conta diz com qual entrar. Não é segredo.
    /// </summary>
    public const string ContaAtivacao = "ativacao.conta";

    /// <summary>Todas as chaves internas: a tela de configuração local e o evento de configuração filtram por esta lista.</summary>
    public static readonly IReadOnlySet<string> Internas = new HashSet<string>(StringComparer.Ordinal)
    {
        BackupChave, ChavePrivadaTerminal, TokenPendente, ResumoAtivacao, ContaAtivacao, RestauracaoPendente, ReidratacaoPendente,
    };
}

/// <summary>
/// Chaves de <c>configuracao_terminal</c> que podem aparecer numa tela, no pacote de suporte ou no antes/depois da
/// auditoria (Central do PDV, bloco G2; README › decisão 67): lista de <b>permitidos</b>, ao lado das
/// <see cref="ChavesConfiguracaoTerminal.Internas"/>. Toda chave da tabela está em exatamente uma das duas listas
/// (<c>ChavesTerminalTests</c>); chave fora das duas não é exibida. Os valores são os de <c>ChavesHardware</c> (Hardware),
/// <c>ChavesPreferencias</c> e <c>ServicoTema</c> (App) e <see cref="Backup.BackupLocal.ChavePastaSecundaria"/>: o Data
/// não conhece os dois primeiros projetos, e o teste do App confere que os textos são os mesmos.
/// </summary>
public static class ChavesExibiveis
{
    /// <summary>Impressora e gaveta (PDV 6.2, 6.3; implantação I4).</summary>
    public static IReadOnlyList<string> Hardware { get; } =
    [
        "impressora.modelo", "impressora.conexao", "impressora.nome_spooler", "impressora.ip", "impressora.porta_rede",
        "impressora.porta", "impressora.baud", "impressora.colunas", "impressora.guilhotina", "impressora.linhas_avanco",
        "impressora.codepage", "impressora.qrcode_nativo", "gaveta.modo", "gaveta.pino", "gaveta.tempo_pulso_ms",
        "gaveta.abre_nos_movimentos",
    ];

    /// <summary>
    /// Parâmetros do próprio caixa (PDV 6.2.2 e 6.8; versão 0.9.1, C17 e Central do PDV, bloco G11): tema, barra de
    /// funções, pesquisa só por números, bloqueio da tela por inatividade e a pasta secundária do backup. O caminho da pasta
    /// passa pelo mascarador (perfil do Windows) antes de aparecer.
    /// </summary>
    public static IReadOnlyList<string> Caixa { get; } =
        ["tela.tema", "tela.barra_funcoes", "pesquisa.somente_numeros", "tela.bloqueio_inatividade_min", Backup.BackupLocal.ChavePastaSecundaria];

    public static readonly IReadOnlySet<string> Todas = new HashSet<string>([.. Hardware, .. Caixa], StringComparer.Ordinal);

    /// <summary>A chave pode ser exibida (só as da lista; as internas e as desconhecidas, nunca).</summary>
    public static bool Exibivel(string chave) => Todas.Contains(chave) && !ChavesConfiguracaoTerminal.Internas.Contains(chave);
}

/// <summary><c>configuracao_terminal</c> (4.4.2): hardware e tela deste computador; valor em JSON.</summary>
public class ConfiguracaoTerminal
{
    public string Chave { get; set; } = string.Empty;
    public string Valor { get; set; } = "null";
    public DateTimeOffset AtualizadoEm { get; set; }
    public Guid? AtualizadoPorId { get; set; }
}

/// <summary><c>estado_sincronizacao</c> (4.4.3): um cursor por fluxo.</summary>
public class EstadoSincronizacao
{
    public static readonly string[] Fluxos = ["configuracao", "acesso", "referencia", "catalogo", "estoque", "pessoas", "operacao"];

    public string Fluxo { get; set; } = string.Empty;
    public long Cursor { get; set; }
    public bool CargaInicialConcluida { get; set; }
    public DateTimeOffset? UltimoPullEm { get; set; }
    public DateTimeOffset? UltimoPullSucessoEm { get; set; }
    public long LinhasRecebidas { get; set; }
    public string? UltimoErro { get; set; }
    public bool Ressincronizar { get; set; }
}

/// <summary><c>estado_conexao</c> (4.4.4): linha única.</summary>
public class EstadoConexao
{
    public int Id { get; set; } = 1;
    public DateTimeOffset? UltimoHeartbeatEm { get; set; }
    public DateTimeOffset? UltimoPushEm { get; set; }
    public DateTimeOffset? UltimoPushSucessoEm { get; set; }
    public DateTimeOffset? AgoraServidorUltimo { get; set; }
    public long? DesvioRelogioMs { get; set; }
    public DateTimeOffset? DesvioAmostraUtcLocal { get; set; }
    public string? DesvioAmostraBootId { get; set; }
    public bool Online { get; set; }
    public DateTimeOffset? OfflineDesde { get; set; }
    public DateTimeOffset? LiberacaoOfflineAte { get; set; }

    /// <summary>Relógio de alta-água: maior hora já vista (corrigida ou do servidor); nunca diminui (PDV 30.5).</summary>
    public DateTimeOffset? MaiorHoraVista { get; set; }

    /// <summary>Uptime monotônico acumulado desde o último pull com sucesso de <c>acesso</c> e <c>configuracao</c>.</summary>
    public long SegundosOfflineAcumulados { get; set; }

    public string? VersaoMinimaApp { get; set; }

    /// <summary>
    /// <c>versoes_schema</c> do último <c>GET /sync/estado</c> (SYNC 5, 17.5), em JSON (<c>{"tipo": [1]}</c>): o PDV só
    /// grava o tipo e a versão que a nuvem anunciou (decisão técnica T13; <c>GravadorOutbox</c>); o último anúncio vale
    /// offline. Nulo = nenhum handshake desde a migração <c>TabelasCaixa</c>: todo tipo vale como aceito (a implantação é
    /// API primeiro, e o caixa nunca trava por falta de internet, O18); o primeiro handshake passa a restringir.
    /// </summary>
    public string? VersoesSchemaNuvem { get; set; }

    /// <summary>
    /// D22 (dono): instante em que o heartbeat com <c>desativando_confirmado</c> foi montado. Enquanto preenchido, nenhum
    /// evento nem auditoria é gravado (gatilhos <c>tg_*_confirmando_desativacao</c>, <see cref="TravaDesativacao"/>): o que
    /// o caixa gravasse até o <c>revogado</c> ficaria só no banco local. Sem resposta, o ciclo limpa e tenta de novo.
    /// </summary>
    public DateTimeOffset? ConfirmandoDesativacaoEm { get; set; }
}

/// <summary>
/// D22 (dono, 31/10/2026; fecha a lacuna aceita da 1B, README › decisão 44): entre montar o heartbeat com
/// <c>desativando_confirmado</c> e receber o <c>revogado</c>, o caixa não grava nada que precise subir. A trava é do banco
/// (<see cref="EstadoConexao.ConfirmandoDesativacaoEm"/> e gatilhos <c>BEFORE INSERT</c> em <c>eventos_saida</c> e
/// <c>log_auditoria_local</c>), marcada na mesma transação <c>IMMEDIATE</c> que conta as pendências: nenhuma gravação
/// em voo escapa da contagem e nenhuma posterior entra. O <c>PdvDbContext</c> traduz a recusa do gatilho em
/// <see cref="Core.Comum.RegraNegocioException"/> com <see cref="Mensagem"/>.
/// </summary>
public static class TravaDesativacao
{
    /// <summary>Texto do <c>RAISE(ABORT, …)</c> dos gatilhos, reconhecido na exceção do SQLite.</summary>
    public const string Marcador = "terminal_confirmando_desativacao";

    public const string Mensagem = "Terminal confirmando a desativação com a nuvem: aguarde alguns segundos e tente de novo.";

    /// <summary>Tabelas cujo <c>INSERT</c> a trava recusa (o que sobe para a nuvem).</summary>
    public static readonly string[] Tabelas = ["eventos_saida", "log_auditoria_local"];

    public static string Gatilho(string tabela) =>
        $"CREATE TRIGGER tg_{tabela}_confirmando_desativacao BEFORE INSERT ON {tabela} " +
        "WHEN EXISTS (SELECT 1 FROM estado_conexao WHERE confirmando_desativacao_em IS NOT NULL) " +
        $"BEGIN SELECT RAISE(ABORT, '{Marcador}'); END;";
}

/// <summary><c>eventos_saida</c> (4.4.5): outbox, gravado na mesma transação do fato.</summary>
public class EventoSaida
{
    public Guid Id { get; set; }
    public long SequenciaTerminal { get; set; }
    public string Tipo { get; set; } = string.Empty;
    public int VersaoSchema { get; set; } = 1;
    public string AgregadoTipo { get; set; } = string.Empty;
    public Guid AgregadoId { get; set; }
    public DateTimeOffset OcorridoEm { get; set; }
    public DateTimeOffset CriadoEm { get; set; }
    public string Payload { get; set; } = "{}";
    public string PayloadSha256 { get; set; } = string.Empty;
    public string Status { get; set; } = StatusEventoSaida.Pendente;
    public int Tentativas { get; set; }
    public DateTimeOffset? ProximaTentativaEm { get; set; }
    public string? UltimoErro { get; set; }
    public Guid? LoteEnvioId { get; set; }
    public DateTimeOffset? EnviadoEm { get; set; }
    public DateTimeOffset? ConfirmadoEm { get; set; }
    public string? Resultado { get; set; }
    public long? VersaoNuvem { get; set; }
    public long? VersaoNuvemFim { get; set; }

    /// <summary>Hora do SO no momento do fato, sem correção (envelope <c>ocorrido_em_local</c>, SYNC 7.3).</summary>
    public DateTimeOffset? OcorridoEmLocal { get; set; }

    /// <summary>Desvio aplicado em <see cref="OcorridoEm"/> (SYNC 12.2); nulo = sem amostra (a hora é a do SO).</summary>
    public long? DesvioRelogioMs { get; set; }

    /// <summary><c>relogio_confiavel</c> do envelope (SYNC 12.3): houve amostra no mesmo boot do PC.</summary>
    public bool? RelogioConfiavel { get; set; }

    /// <summary>Operador que executou o fato (envelope <c>usuario_id</c>); nulo nos lotes de auditoria.</summary>
    public Guid? UsuarioId { get; set; }

    /// <summary>
    /// <c>contexto</c> do envelope (SYNC 7.3) no momento do fato, em JSON: loja, caixa, estoque vigente, sessão e
    /// versões. Nulo nos eventos gravados antes da coluna (o envio monta com a identidade).
    /// </summary>
    public string? Contexto { get; set; }

    /// <summary>
    /// <c>dependencias</c> do envelope (SYNC 7.3, 8.5) em JSON: <c>[{"agregado_tipo", "agregado_id"}]</c>, os agregados
    /// deste terminal que precisam estar aplicados antes (a sessão, para venda e movimento de caixa). <c>[]</c> nos
    /// eventos gravados antes da coluna e nos que não dependem de nada.
    /// </summary>
    public string Dependencias { get; set; } = "[]";

    /// <summary><c>relogio_regrediu</c> do envelope (SYNC 12.3): <c>true</c> quando a monotonicidade não foi aplicada.</summary>
    public bool? RelogioRegrediu { get; set; }
}

public static class StatusEventoSaida
{
    public const string Pendente = "pendente";
    public const string Enviando = "enviando";
    public const string Confirmado = "confirmado";
    public const string ErroTemporario = "erro_temporario";
    public const string Rejeitado = "rejeitado";

    public static readonly string[] Todos = [Pendente, Enviando, Confirmado, ErroTemporario, Rejeitado];
}

/// <summary><c>sequencias_locais</c> (4.4.6): números que nunca voltam (venda, evento, NFC-e, vale, comanda).</summary>
public class SequenciaLocal
{
    public const string Venda = "venda";
    public const string Evento = "evento";
    public const string Vale = "vale";

    /// <summary>Numeração NFC-e por série e ambiente (1 = produção, 2 = homologação): <c>nfce:&lt;serie&gt;:&lt;ambiente&gt;</c>.</summary>
    public static string Nfce(int serie, int ambiente) => string.Create(System.Globalization.CultureInfo.InvariantCulture, $"nfce:{serie}:{ambiente}");

    public string Chave { get; set; } = string.Empty;
    public long UltimoValor { get; set; }
    public DateTimeOffset? AtualizadoEm { get; set; }
}

/// <summary><c>estado_operacao</c> (4.4.7): ponto de retomada após queda de energia/travamento.</summary>
public class EstadoOperacao
{
    public int Id { get; set; } = 1;
    public Guid? OperadorId { get; set; }
    public Guid? SessaoCaixaId { get; set; }
    public Guid? VendaAtualId { get; set; }
    public string? Modo { get; set; }
    public bool Bloqueado { get; set; }
    public DateTimeOffset? BloqueadoDesde { get; set; }
    public DateTimeOffset? AtualizadoEm { get; set; }
}

/// <summary><c>fila_impressao</c> (4.4.8): toda impressão passa pela fila; nunca bloqueia a venda.</summary>
public class FilaImpressao
{
    public Guid Id { get; set; }
    public string TipoDocumento { get; set; } = "cupom";
    public Guid? ReferenciaId { get; set; }
    public string Impressora { get; set; } = "principal";
    public byte[] Conteudo { get; set; } = [];
    public int Vias { get; set; } = 1;
    public string Status { get; set; } = "pendente";
    public int Tentativas { get; set; }
    public string? UltimoErro { get; set; }
    public DateTimeOffset CriadoEm { get; set; }
    public DateTimeOffset? ImpressoEm { get; set; }
}

/// <summary><c>log_local</c> (4.4.10): diagnóstico técnico; não sobe.</summary>
public class LogLocal
{
    public long Id { get; set; }
    public DateTimeOffset OcorridoEm { get; set; }
    public string Nivel { get; set; } = "info";
    public string Origem { get; set; } = "app";
    public string Mensagem { get; set; } = string.Empty;
    public string? Detalhes { get; set; }
}

/// <summary><c>log_auditoria_local</c> (4.4.10): sobe em lotes pelo evento <c>auditoria.registros</c>.</summary>
public class LogAuditoriaLocal
{
    public Guid Id { get; set; }
    public DateTimeOffset OcorridoEm { get; set; }
    public Guid? UsuarioId { get; set; }
    public Guid? AutorizadoPorId { get; set; }
    public Guid? SessaoCaixaId { get; set; }
    public string Acao { get; set; } = string.Empty;
    public string? Entidade { get; set; }
    public Guid? RegistroId { get; set; }
    public string? Localizacao { get; set; }
    public string? Descricao { get; set; }
    public string? Motivo { get; set; }
    public string? Antes { get; set; }
    public string? Depois { get; set; }
    public Guid? EventoId { get; set; }
}

/// <summary>
/// <c>produtos_venda_snapshot</c> (só local, não sobe; README › decisão 21): o produto como estava na <b>primeira
/// inclusão</b> na venda em andamento (preço base, loja, atacado, faixas, grupo/mix, embalagens e a vigência da
/// promoção nesse instante), gravado no mesmo commit do item. Na recuperação após queda a venda é reconstituída com
/// ele, nunca com o espelho atual (PDV 11.3.1, 32.3). As linhas da venda são apagadas quando ela é encerrada.
/// </summary>
public class ProdutoVendaSnapshot
{
    public Guid VendaId { get; set; }
    public Guid ProdutoId { get; set; }

    /// <summary>A promoção do produto estava vigente na primeira inclusão (fixada para a venda inteira).</summary>
    public bool PromocaoVigente { get; set; }

    /// <summary><c>ProdutoVenda</c> (Core) em JSON, com a <c>TabelaPreco</c>; <c>CHECK (json_valid(dados))</c>.</summary>
    public string Dados { get; set; } = "{}";

    public DateTimeOffset RegistradoEm { get; set; }
}

/// <summary>
/// <c>liberacoes_venda</c> (só local, não sobe como tabela; README › decisão 49): as liberações de supervisor usadas na
/// venda (<c>LiberacaoVenda</c> do Core: desconto acima do limite do operador, PDV 12.3, 31.3), gravadas no mesmo commit
/// da operação. A venda em andamento volta com elas depois de uma queda (PDV 32.3), o <c>venda.finalizada</c> as leva em
/// <c>liberacoes</c> (sincronizacao.md 9.7) e o fechamento as conta no <c>qtd_liberacoes</c>. Não são apagadas no
/// encerramento da venda.
/// </summary>
public class LiberacaoVendaLocal
{
    public Guid Id { get; set; }
    public Guid VendaId { get; set; }

    /// <summary><c>desconto_item</c>, <c>desconto_total</c>, <c>pix_manual</c>, <c>forma_pagamento</c>, <c>desconto_cascos</c> (<c>AcaoLiberacao</c> do Core).</summary>
    public string Acao { get; set; } = string.Empty;

    /// <summary>Item liberado; nulo = a venda toda (desconto no total).</summary>
    public Guid? ItemVendaId { get; set; }

    [Escala(Escalas.Percentual)] public decimal? ValorPct { get; set; }
    public Guid AutorizadoPorId { get; set; }
    public string Motivo { get; set; } = string.Empty;
    public DateTimeOffset OcorridoEm { get; set; }
}

/// <summary>
/// <c>cascos_descontados_venda</c> (só local, não sobe como tabela; README › decisão 56): os cascos vazios trazidos além
/// dos devidos e descontados na venda pelo valor do casco (<c>CascoDescontado</c> do Core; PDV 10.12, O14 do dono; Fase
/// 1C, C11c), um por casco, gravados no mesmo commit da operação. Não têm coluna no MD: na nuvem viram parte do
/// <c>desconto_total</c> e dos <c>devolvidos</c> do bloco <c>vasilhames</c>. A venda em andamento volta com eles depois de
/// uma queda (PDV 32.3) e a encerrada também (o cancelamento devolve os vazios, D29, e a reimpressão refaz o cupom): não
/// são apagados no encerramento.
/// </summary>
public class CascoDescontadoVendaLocal
{
    public Guid VendaId { get; set; }
    public Guid ProdutoVasilhameId { get; set; }
    public string Descricao { get; set; } = string.Empty;
    public int Quantidade { get; set; }
    [Escala(Escalas.Preco)] public decimal PrecoUnitario { get; set; }
    public DateTimeOffset RegistradoEm { get; set; }
}

/// <summary>
/// <c>bloqueios_senha_local</c> (4.4.11): erros de senha <b>neste terminal</b>, sem depender da nuvem. PK
/// <c>(tipo, registro_id)</c>. Usuário: 5 erros seguidos em até 5 min bloqueiam o PIN por 5 min (PDV 7.2 regra 7);
/// cliente (crediário): 5 erros, 30 min. Acerto zera a linha.
/// </summary>
public class BloqueioSenhaLocal
{
    public const string TipoUsuario = "usuario";
    public const string TipoCliente = "cliente";

    public string Tipo { get; set; } = TipoUsuario;
    public Guid RegistroId { get; set; }
    public int Tentativas { get; set; }
    public DateTimeOffset? PrimeiraFalhaEm { get; set; }
    public DateTimeOffset? BloqueadoAte { get; set; }
    public DateTimeOffset AtualizadoEm { get; set; }
}

/// <summary>
/// <c>comandos_recebidos</c> (4.4.13): dedupe e ack dos comandos do heartbeat (entrega ao menos uma vez, SYNC 21.1).
/// Comando repetido pela nuvem não é executado de novo: o PDV responde o resultado gravado aqui.
/// </summary>
public class ComandoRecebido
{
    public static readonly string[] StatusValidos = ["recebido", "executado", "falhou"];

    public Guid ComandoId { get; set; }
    public string Tipo { get; set; } = string.Empty;
    public DateTimeOffset RecebidoEm { get; set; }
    public string Status { get; set; } = "recebido";

    /// <summary>JSON do resultado (<c>CHECK (json_valid)</c>).</summary>
    public string? Resultado { get; set; }
}
