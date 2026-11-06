using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class Inicial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "configuracao_terminal",
                columns: table => new
                {
                    chave = table.Column<string>(type: "TEXT", nullable: false),
                    valor = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_configuracao_terminal", x => x.chave);
                    table.CheckConstraint("ck_configuracao_terminal_valor", "json_valid(valor)");
                });

            migrationBuilder.CreateTable(
                name: "estado_conexao",
                columns: table => new
                {
                    id = table.Column<int>(type: "INTEGER", nullable: false),
                    ultimo_heartbeat_em = table.Column<string>(type: "TEXT", nullable: true),
                    ultimo_push_em = table.Column<string>(type: "TEXT", nullable: true),
                    ultimo_push_sucesso_em = table.Column<string>(type: "TEXT", nullable: true),
                    agora_servidor_ultimo = table.Column<string>(type: "TEXT", nullable: true),
                    desvio_relogio_ms = table.Column<long>(type: "INTEGER", nullable: true),
                    online = table.Column<bool>(type: "INTEGER", nullable: false),
                    offline_desde = table.Column<string>(type: "TEXT", nullable: true),
                    liberacao_offline_ate = table.Column<string>(type: "TEXT", nullable: true),
                    versao_minima_app = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_estado_conexao", x => x.id);
                    table.CheckConstraint("ck_estado_conexao_id", "id = 1");
                    table.CheckConstraint("ck_estado_conexao_online", "online in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "estado_operacao",
                columns: table => new
                {
                    id = table.Column<int>(type: "INTEGER", nullable: false),
                    operador_id = table.Column<string>(type: "TEXT", nullable: true),
                    sessao_caixa_id = table.Column<string>(type: "TEXT", nullable: true),
                    venda_atual_id = table.Column<string>(type: "TEXT", nullable: true),
                    modo = table.Column<string>(type: "TEXT", nullable: true),
                    bloqueado = table.Column<bool>(type: "INTEGER", nullable: false),
                    bloqueado_desde = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_estado_operacao", x => x.id);
                    table.CheckConstraint("ck_estado_operacao_bloqueado", "bloqueado in (0,1)");
                    table.CheckConstraint("ck_estado_operacao_id", "id = 1");
                    table.CheckConstraint("ck_estado_operacao_modo", "modo is null or modo in ('balcao','comanda','delivery','pagamento','fechamento')");
                });

            migrationBuilder.CreateTable(
                name: "estado_sincronizacao",
                columns: table => new
                {
                    fluxo = table.Column<string>(type: "TEXT", nullable: false),
                    cursor = table.Column<long>(type: "INTEGER", nullable: false),
                    carga_inicial_concluida = table.Column<bool>(type: "INTEGER", nullable: false),
                    ultimo_pull_em = table.Column<string>(type: "TEXT", nullable: true),
                    ultimo_pull_sucesso_em = table.Column<string>(type: "TEXT", nullable: true),
                    linhas_recebidas = table.Column<long>(type: "INTEGER", nullable: false),
                    ultimo_erro = table.Column<string>(type: "TEXT", nullable: true),
                    ressincronizar = table.Column<bool>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_estado_sincronizacao", x => x.fluxo);
                    table.CheckConstraint("ck_estado_sincronizacao_carga_inicial_concluida", "carga_inicial_concluida in (0,1)");
                    table.CheckConstraint("ck_estado_sincronizacao_fluxo", "fluxo in ('configuracao','acesso','referencia','catalogo','estoque','pessoas','operacao')");
                    table.CheckConstraint("ck_estado_sincronizacao_ressincronizar", "ressincronizar in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "eventos_saida",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    sequencia_terminal = table.Column<long>(type: "INTEGER", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    versao_schema = table.Column<int>(type: "INTEGER", nullable: false),
                    agregado_tipo = table.Column<string>(type: "TEXT", nullable: false),
                    agregado_id = table.Column<string>(type: "TEXT", nullable: false),
                    ocorrido_em = table.Column<string>(type: "TEXT", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    payload = table.Column<string>(type: "TEXT", nullable: false),
                    payload_sha256 = table.Column<string>(type: "TEXT", nullable: false),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    tentativas = table.Column<int>(type: "INTEGER", nullable: false),
                    proxima_tentativa_em = table.Column<string>(type: "TEXT", nullable: true),
                    ultimo_erro = table.Column<string>(type: "TEXT", nullable: true),
                    lote_envio_id = table.Column<string>(type: "TEXT", nullable: true),
                    enviado_em = table.Column<string>(type: "TEXT", nullable: true),
                    confirmado_em = table.Column<string>(type: "TEXT", nullable: true),
                    resultado = table.Column<string>(type: "TEXT", nullable: true),
                    versao_nuvem = table.Column<long>(type: "INTEGER", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_eventos_saida", x => x.id);
                    table.CheckConstraint("ck_eventos_saida_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_eventos_saida_status", "status in ('pendente','enviando','confirmado','erro_temporario','rejeitado')");
                });

            migrationBuilder.CreateTable(
                name: "fila_impressao",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    tipo_documento = table.Column<string>(type: "TEXT", nullable: false),
                    referencia_id = table.Column<string>(type: "TEXT", nullable: true),
                    impressora = table.Column<string>(type: "TEXT", nullable: false),
                    conteudo = table.Column<byte[]>(type: "BLOB", nullable: false),
                    vias = table.Column<int>(type: "INTEGER", nullable: false),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    tentativas = table.Column<int>(type: "INTEGER", nullable: false),
                    ultimo_erro = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    impresso_em = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_fila_impressao", x => x.id);
                    table.CheckConstraint("ck_fila_impressao_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_fila_impressao_status", "status in ('pendente','imprimindo','impresso','falhou','cancelado')");
                });

            migrationBuilder.CreateTable(
                name: "identidade_terminal",
                columns: table => new
                {
                    id = table.Column<int>(type: "INTEGER", nullable: false),
                    terminal_id = table.Column<string>(type: "TEXT", nullable: false),
                    empresa_codigo = table.Column<int>(type: "INTEGER", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: false),
                    caixa_id = table.Column<string>(type: "TEXT", nullable: false),
                    numero_caixa = table.Column<int>(type: "INTEGER", nullable: false),
                    url_api = table.Column<string>(type: "TEXT", nullable: false),
                    token_protegido = table.Column<byte[]>(type: "BLOB", nullable: false),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    ativado_em = table.Column<string>(type: "TEXT", nullable: false),
                    nome_maquina = table.Column<string>(type: "TEXT", nullable: false),
                    versao_schema_local = table.Column<int>(type: "INTEGER", nullable: false),
                    ultimo_backup_em = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_identidade_terminal", x => x.id);
                    table.CheckConstraint("ck_identidade_terminal_id", "id = 1");
                    table.CheckConstraint("ck_identidade_terminal_status", "status in ('ativo','desativando','revogado')");
                });

            migrationBuilder.CreateTable(
                name: "log_auditoria_local",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    ocorrido_em = table.Column<string>(type: "TEXT", nullable: false),
                    usuario_id = table.Column<string>(type: "TEXT", nullable: true),
                    autorizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    acao = table.Column<string>(type: "TEXT", nullable: false),
                    entidade = table.Column<string>(type: "TEXT", nullable: true),
                    registro_id = table.Column<string>(type: "TEXT", nullable: true),
                    localizacao = table.Column<string>(type: "TEXT", nullable: true),
                    descricao = table.Column<string>(type: "TEXT", nullable: true),
                    antes = table.Column<string>(type: "TEXT", nullable: true),
                    depois = table.Column<string>(type: "TEXT", nullable: true),
                    evento_id = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_log_auditoria_local", x => x.id);
                    table.CheckConstraint("ck_log_auditoria_local_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "log_local",
                columns: table => new
                {
                    id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    ocorrido_em = table.Column<string>(type: "TEXT", nullable: false),
                    nivel = table.Column<string>(type: "TEXT", nullable: false),
                    origem = table.Column<string>(type: "TEXT", nullable: false),
                    mensagem = table.Column<string>(type: "TEXT", nullable: false),
                    detalhes = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_log_local", x => x.id);
                    table.CheckConstraint("ck_log_local_nivel", "nivel in ('debug','info','aviso','erro','critico')");
                });

            migrationBuilder.CreateTable(
                name: "sequencias_locais",
                columns: table => new
                {
                    chave = table.Column<string>(type: "TEXT", nullable: false),
                    ultimo_valor = table.Column<long>(type: "INTEGER", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_sequencias_locais", x => x.chave);
                });

            migrationBuilder.CreateTable(
                name: "vendas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    numero = table.Column<long>(type: "INTEGER", nullable: false),
                    numero_exibicao = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: false),
                    caixa_id = table.Column<string>(type: "TEXT", nullable: false),
                    numero_caixa = table.Column<short>(type: "INTEGER", nullable: false),
                    terminal_id = table.Column<string>(type: "TEXT", nullable: true),
                    sessao_caixa_id = table.Column<string>(type: "TEXT", nullable: true),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    canal = table.Column<string>(type: "TEXT", nullable: false),
                    modo = table.Column<string>(type: "TEXT", nullable: false),
                    id_externo = table.Column<string>(type: "TEXT", nullable: true),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    status_fiscal = table.Column<string>(type: "TEXT", nullable: false),
                    devolucao = table.Column<string>(type: "TEXT", nullable: false),
                    dia_operacional = table.Column<string>(type: "TEXT", nullable: true),
                    operador_id = table.Column<string>(type: "TEXT", nullable: false),
                    vendedor_id = table.Column<string>(type: "TEXT", nullable: true),
                    cliente_id = table.Column<string>(type: "TEXT", nullable: true),
                    cpf_cnpj_nota = table.Column<string>(type: "TEXT", nullable: true),
                    nome_nota = table.Column<string>(type: "TEXT", nullable: true),
                    tipo_preco = table.Column<string>(type: "TEXT", nullable: false),
                    orcamento_id = table.Column<string>(type: "TEXT", nullable: true),
                    comanda_id = table.Column<string>(type: "TEXT", nullable: true),
                    pedido_id = table.Column<string>(type: "TEXT", nullable: true),
                    qtd_itens = table.Column<int>(type: "INTEGER", nullable: false),
                    subtotal_bruto = table.Column<long>(type: "INTEGER", nullable: false),
                    desconto_itens = table.Column<long>(type: "INTEGER", nullable: false),
                    desconto_total = table.Column<long>(type: "INTEGER", nullable: false),
                    desconto_total_pct = table.Column<long>(type: "INTEGER", nullable: true),
                    acrescimo_total = table.Column<long>(type: "INTEGER", nullable: false),
                    taxa_servico = table.Column<long>(type: "INTEGER", nullable: false),
                    taxa_entrega = table.Column<long>(type: "INTEGER", nullable: false),
                    valor_frete = table.Column<long>(type: "INTEGER", nullable: false),
                    total = table.Column<long>(type: "INTEGER", nullable: false),
                    troco = table.Column<long>(type: "INTEGER", nullable: false),
                    custo_total = table.Column<long>(type: "INTEGER", nullable: true),
                    endereco_entrega_id = table.Column<string>(type: "TEXT", nullable: true),
                    endereco_entrega = table.Column<string>(type: "TEXT", nullable: true),
                    endereco_faturamento_id = table.Column<string>(type: "TEXT", nullable: true),
                    data_entrega = table.Column<string>(type: "TEXT", nullable: true),
                    observacao_nfe = table.Column<string>(type: "TEXT", nullable: true),
                    observacao = table.Column<string>(type: "TEXT", nullable: true),
                    frete_modalidade = table.Column<string>(type: "TEXT", nullable: true),
                    frete_tipo = table.Column<string>(type: "TEXT", nullable: true),
                    transportadora_id = table.Column<string>(type: "TEXT", nullable: true),
                    volumes = table.Column<string>(type: "TEXT", nullable: true),
                    qtd_parcelas = table.Column<short>(type: "INTEGER", nullable: true),
                    iniciada_em = table.Column<string>(type: "TEXT", nullable: false),
                    finalizada_em = table.Column<string>(type: "TEXT", nullable: true),
                    cancelada_em = table.Column<string>(type: "TEXT", nullable: true),
                    cancelada_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    cancelamento_autorizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    motivo_cancelamento = table.Column<string>(type: "TEXT", nullable: true),
                    cancelamento_origem = table.Column<string>(type: "TEXT", nullable: true),
                    evento_finalizacao_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_vendas", x => x.id);
                    table.CheckConstraint("ck_vendas_cancelada", "status <> 'cancelada' or (cancelada_em is not null and motivo_cancelamento is not null)");
                    table.CheckConstraint("ck_vendas_devolucao", "devolucao in ('nenhuma','parcial','total')");
                    table.CheckConstraint("ck_vendas_finalizada", "status <> 'finalizada' or finalizada_em is not null");
                    table.CheckConstraint("ck_vendas_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_vendas_modo", "modo in ('balcao','comanda','pedido','delivery')");
                    table.CheckConstraint("ck_vendas_status", "status in ('rascunho','em_andamento','em_pagamento','suspensa','pedido_pendente','finalizada','cancelada')");
                    table.CheckConstraint("ck_vendas_tipo", "tipo in ('pdv','venda')");
                    table.CheckConstraint("ck_vendas_tipo_preco", "tipo_preco in ('varejo','atacado','parcelado')");
                    table.CheckConstraint("ck_vendas_valores", "subtotal_bruto >= 0 and desconto_itens >= 0 and desconto_total >= 0 and acrescimo_total >= 0 and taxa_servico >= 0 and taxa_entrega >= 0 and valor_frete >= 0 and total >= 0 and troco >= 0");
                });

            migrationBuilder.CreateTable(
                name: "itens_venda",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    venda_id = table.Column<string>(type: "TEXT", nullable: false),
                    sequencia = table.Column<int>(type: "INTEGER", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    variacao_id = table.Column<string>(type: "TEXT", nullable: true),
                    codigo_lido = table.Column<string>(type: "TEXT", nullable: true),
                    codigo_barras_id = table.Column<string>(type: "TEXT", nullable: true),
                    descricao = table.Column<string>(type: "TEXT", nullable: false),
                    unidade = table.Column<string>(type: "TEXT", nullable: false),
                    quantidade = table.Column<long>(type: "INTEGER", nullable: false),
                    preco_tabela = table.Column<long>(type: "INTEGER", nullable: false),
                    preco_unitario = table.Column<long>(type: "INTEGER", nullable: false),
                    origem_preco = table.Column<string>(type: "TEXT", nullable: false),
                    valor_bruto = table.Column<long>(type: "INTEGER", nullable: false),
                    desconto_item = table.Column<long>(type: "INTEGER", nullable: false),
                    desconto_rateado = table.Column<long>(type: "INTEGER", nullable: false),
                    acrescimo_rateado = table.Column<long>(type: "INTEGER", nullable: false),
                    frete_rateado = table.Column<long>(type: "INTEGER", nullable: false),
                    valor_liquido = table.Column<long>(type: "INTEGER", nullable: false),
                    lote_id = table.Column<string>(type: "TEXT", nullable: true),
                    lote = table.Column<string>(type: "TEXT", nullable: true),
                    validade_lote = table.Column<string>(type: "TEXT", nullable: true),
                    kit_grupo_id = table.Column<string>(type: "TEXT", nullable: true),
                    kit_produto_id = table.Column<string>(type: "TEXT", nullable: true),
                    item_comanda_id = table.Column<string>(type: "TEXT", nullable: true),
                    item_orcamento_id = table.Column<string>(type: "TEXT", nullable: true),
                    vendedor_id = table.Column<string>(type: "TEXT", nullable: true),
                    comissao_pct = table.Column<long>(type: "INTEGER", nullable: true),
                    valor_comissao = table.Column<long>(type: "INTEGER", nullable: true),
                    custo_unitario = table.Column<long>(type: "INTEGER", nullable: true),
                    cfop = table.Column<string>(type: "TEXT", nullable: true),
                    ncm = table.Column<string>(type: "TEXT", nullable: true),
                    fiscal_snapshot = table.Column<string>(type: "TEXT", nullable: true),
                    v_ibs = table.Column<long>(type: "INTEGER", nullable: true),
                    v_cbs = table.Column<long>(type: "INTEGER", nullable: true),
                    v_is = table.Column<long>(type: "INTEGER", nullable: true),
                    quantidade_devolvida = table.Column<long>(type: "INTEGER", nullable: false),
                    cancelado = table.Column<bool>(type: "INTEGER", nullable: false),
                    cancelado_em = table.Column<string>(type: "TEXT", nullable: true),
                    cancelado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    autorizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    motivo_cancelamento = table.Column<string>(type: "TEXT", nullable: true),
                    incluido_em = table.Column<string>(type: "TEXT", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_itens_venda", x => x.id);
                    table.CheckConstraint("ck_itens_venda_cancelado", "cancelado in (0,1)");
                    table.CheckConstraint("ck_itens_venda_devolvida", "quantidade_devolvida between 0 and quantidade");
                    table.CheckConstraint("ck_itens_venda_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_itens_venda_quantidade", "quantidade > 0");
                    table.CheckConstraint("ck_itens_venda_valores", "valor_bruto >= 0 and desconto_item >= 0 and desconto_rateado >= 0 and valor_liquido >= 0");
                    table.ForeignKey(
                        name: "fk_itens_venda_venda_id",
                        column: x => x.venda_id,
                        principalTable: "vendas",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "pagamentos_venda",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    venda_id = table.Column<string>(type: "TEXT", nullable: false),
                    sequencia = table.Column<short>(type: "INTEGER", nullable: false),
                    forma_pagamento_id = table.Column<string>(type: "TEXT", nullable: false),
                    descricao_forma = table.Column<string>(type: "TEXT", nullable: false),
                    meio_pagamento_fiscal = table.Column<string>(type: "TEXT", nullable: false),
                    tipo_forma = table.Column<string>(type: "TEXT", nullable: false),
                    valor = table.Column<long>(type: "INTEGER", nullable: false),
                    valor_recebido = table.Column<long>(type: "INTEGER", nullable: true),
                    troco = table.Column<long>(type: "INTEGER", nullable: false),
                    parcelas = table.Column<short>(type: "INTEGER", nullable: false),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    lanca_quitada = table.Column<bool>(type: "INTEGER", nullable: false),
                    taxa_pct = table.Column<long>(type: "INTEGER", nullable: false),
                    pessoa_id = table.Column<string>(type: "TEXT", nullable: true),
                    indicador_pagamento = table.Column<short>(type: "INTEGER", nullable: false),
                    data_pagamento = table.Column<string>(type: "TEXT", nullable: true),
                    cnpj_pagamento = table.Column<string>(type: "TEXT", nullable: true),
                    uf_pagamento = table.Column<string>(type: "TEXT", nullable: true),
                    tipo_integracao = table.Column<short>(type: "INTEGER", nullable: true),
                    bandeira = table.Column<string>(type: "TEXT", nullable: true),
                    bandeira_nome = table.Column<string>(type: "TEXT", nullable: true),
                    adquirente = table.Column<string>(type: "TEXT", nullable: true),
                    cnpj_credenciadora = table.Column<string>(type: "TEXT", nullable: true),
                    nsu = table.Column<string>(type: "TEXT", nullable: true),
                    autorizacao = table.Column<string>(type: "TEXT", nullable: true),
                    cartao_mascarado = table.Column<string>(type: "TEXT", nullable: true),
                    cnpj_beneficiario = table.Column<string>(type: "TEXT", nullable: true),
                    id_terminal_pagamento = table.Column<string>(type: "TEXT", nullable: true),
                    tef_transacao_id = table.Column<string>(type: "TEXT", nullable: true),
                    pix_cobranca_id = table.Column<string>(type: "TEXT", nullable: true),
                    vale_id = table.Column<string>(type: "TEXT", nullable: true),
                    autorizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    conta_financeira_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_pagamentos_venda", x => x.id);
                    table.CheckConstraint("ck_pagamentos_venda_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_pagamentos_venda_indicador", "indicador_pagamento in (0,1)");
                    table.CheckConstraint("ck_pagamentos_venda_lanca_quitada", "lanca_quitada in (0,1)");
                    table.CheckConstraint("ck_pagamentos_venda_parcelas", "parcelas >= 1");
                    table.CheckConstraint("ck_pagamentos_venda_status", "status in ('pendente','aprovado','cancelado','estornado')");
                    table.CheckConstraint("ck_pagamentos_venda_valor", "valor > 0 and troco >= 0");
                    table.ForeignKey(
                        name: "fk_pagamentos_venda_venda_id",
                        column: x => x.venda_id,
                        principalTable: "vendas",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "parcelas_venda",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    pagamento_venda_id = table.Column<string>(type: "TEXT", nullable: false),
                    numero = table.Column<short>(type: "INTEGER", nullable: false),
                    vencimento = table.Column<string>(type: "TEXT", nullable: false),
                    valor = table.Column<long>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_parcelas_venda", x => x.id);
                    table.CheckConstraint("ck_parcelas_venda_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_parcelas_venda_valor", "valor > 0");
                    table.ForeignKey(
                        name: "fk_parcelas_venda_pagamento_venda_id",
                        column: x => x.pagamento_venda_id,
                        principalTable: "pagamentos_venda",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_eventos_saida_agregado",
                table: "eventos_saida",
                column: "agregado_id");

            migrationBuilder.CreateIndex(
                name: "ix_eventos_saida_status",
                table: "eventos_saida",
                columns: new[] { "status", "sequencia_terminal" });

            migrationBuilder.CreateIndex(
                name: "uq_eventos_saida_sequencia",
                table: "eventos_saida",
                column: "sequencia_terminal",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_fila_impressao_status",
                table: "fila_impressao",
                columns: new[] { "status", "criado_em" });

            migrationBuilder.CreateIndex(
                name: "ix_itens_venda_produto_id",
                table: "itens_venda",
                column: "produto_id");

            migrationBuilder.CreateIndex(
                name: "uq_itens_venda_sequencia",
                table: "itens_venda",
                columns: new[] { "venda_id", "sequencia" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_log_auditoria_local_evento_id",
                table: "log_auditoria_local",
                column: "evento_id");

            migrationBuilder.CreateIndex(
                name: "ix_log_local_ocorrido_em",
                table: "log_local",
                column: "ocorrido_em");

            migrationBuilder.CreateIndex(
                name: "uq_pagamentos_venda_sequencia",
                table: "pagamentos_venda",
                columns: new[] { "venda_id", "sequencia" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "uq_parcelas_venda",
                table: "parcelas_venda",
                columns: new[] { "pagamento_venda_id", "numero" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_vendas_sessao_caixa_id",
                table: "vendas",
                column: "sessao_caixa_id");

            migrationBuilder.CreateIndex(
                name: "ix_vendas_status",
                table: "vendas",
                column: "status");

            migrationBuilder.CreateIndex(
                name: "uq_vendas_numero",
                table: "vendas",
                columns: new[] { "loja_id", "numero_caixa", "numero" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "configuracao_terminal");

            migrationBuilder.DropTable(
                name: "estado_conexao");

            migrationBuilder.DropTable(
                name: "estado_operacao");

            migrationBuilder.DropTable(
                name: "estado_sincronizacao");

            migrationBuilder.DropTable(
                name: "eventos_saida");

            migrationBuilder.DropTable(
                name: "fila_impressao");

            migrationBuilder.DropTable(
                name: "identidade_terminal");

            migrationBuilder.DropTable(
                name: "itens_venda");

            migrationBuilder.DropTable(
                name: "log_auditoria_local");

            migrationBuilder.DropTable(
                name: "log_local");

            migrationBuilder.DropTable(
                name: "parcelas_venda");

            migrationBuilder.DropTable(
                name: "sequencias_locais");

            migrationBuilder.DropTable(
                name: "pagamentos_venda");

            migrationBuilder.DropTable(
                name: "vendas");
        }
    }
}
