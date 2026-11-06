using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class TabelasCaixa : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "dependencias",
                table: "eventos_saida",
                type: "TEXT",
                nullable: false,
                defaultValue: "[]");

            migrationBuilder.AddColumn<bool>(
                name: "relogio_regrediu",
                table: "eventos_saida",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "confirmando_desativacao_em",
                table: "estado_conexao",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "versoes_schema_nuvem",
                table: "estado_conexao",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "sessoes_caixa",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: false),
                    caixa_id = table.Column<string>(type: "TEXT", nullable: false),
                    numero_caixa = table.Column<short>(type: "INTEGER", nullable: false),
                    terminal_id = table.Column<string>(type: "TEXT", nullable: false),
                    operador_id = table.Column<string>(type: "TEXT", nullable: false),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    dia_operacional = table.Column<string>(type: "TEXT", nullable: false),
                    aberta_em = table.Column<string>(type: "TEXT", nullable: false),
                    abertura_automatica = table.Column<bool>(type: "INTEGER", nullable: false),
                    fundo_troco = table.Column<long>(type: "INTEGER", nullable: false),
                    sessao_anterior_id = table.Column<string>(type: "TEXT", nullable: true),
                    valor_recebido_anterior = table.Column<long>(type: "INTEGER", nullable: true),
                    diferenca_recebimento = table.Column<long>(type: "INTEGER", nullable: true),
                    fechada_em = table.Column<string>(type: "TEXT", nullable: true),
                    fechamento_forcado = table.Column<bool>(type: "INTEGER", nullable: false),
                    fechamento_forcado_motivo = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_sessoes_caixa", x => x.id);
                    table.CheckConstraint("ck_sessoes_caixa_abertura_automatica", "abertura_automatica in (0,1)");
                    table.CheckConstraint("ck_sessoes_caixa_fechamento_forcado", "fechamento_forcado in (0,1)");
                    table.CheckConstraint("ck_sessoes_caixa_forcado", "not fechamento_forcado or (status = 'fechada' and fechamento_forcado_motivo is not null)");
                    table.CheckConstraint("ck_sessoes_caixa_forcado_motivo", "fechamento_forcado_motivo is null or fechamento_forcado_motivo in ('substituicao_terminal','revogacao_terminal')");
                    table.CheckConstraint("ck_sessoes_caixa_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_sessoes_caixa_status", "status in ('aberta','bloqueada_sangria','em_fechamento','fechada')");
                });

            migrationBuilder.CreateTable(
                name: "fechamentos_caixa",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    sessao_caixa_id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: false),
                    caixa_id = table.Column<string>(type: "TEXT", nullable: false),
                    terminal_id = table.Column<string>(type: "TEXT", nullable: false),
                    numero_caixa = table.Column<short>(type: "INTEGER", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    zera_caixa = table.Column<bool>(type: "INTEGER", nullable: false),
                    usuario_anterior_id = table.Column<string>(type: "TEXT", nullable: false),
                    usuario_subsequente_id = table.Column<string>(type: "TEXT", nullable: true),
                    valor_caixa = table.Column<long>(type: "INTEGER", nullable: false),
                    total_calculado = table.Column<long>(type: "INTEGER", nullable: false),
                    total_digitado = table.Column<long>(type: "INTEGER", nullable: false),
                    diferenca = table.Column<long>(type: "INTEGER", nullable: false, computedColumnSql: "total_digitado - total_calculado", stored: true),
                    justificativa = table.Column<string>(type: "TEXT", nullable: true),
                    recontagem = table.Column<bool>(type: "INTEGER", nullable: false),
                    fechamento_cego = table.Column<bool>(type: "INTEGER", nullable: false),
                    ocorrido_em = table.Column<string>(type: "TEXT", nullable: false),
                    dia_operacional = table.Column<string>(type: "TEXT", nullable: false),
                    resumo = table.Column<string>(type: "TEXT", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_fechamentos_caixa", x => x.id);
                    table.CheckConstraint("ck_fechamentos_caixa_fechamento_cego", "fechamento_cego in (0,1)");
                    table.CheckConstraint("ck_fechamentos_caixa_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_fechamentos_caixa_recontagem", "recontagem in (0,1)");
                    table.CheckConstraint("ck_fechamentos_caixa_resumo", "json_valid(resumo)");
                    table.CheckConstraint("ck_fechamentos_caixa_tipo", "tipo in ('fechamento','troca_turno')");
                    table.CheckConstraint("ck_fechamentos_caixa_zera", "zera_caixa = (tipo = 'fechamento')");
                    table.CheckConstraint("ck_fechamentos_caixa_zera_caixa", "zera_caixa in (0,1)");
                    table.ForeignKey(
                        name: "fk_fechamentos_caixa_sessao_caixa_id",
                        column: x => x.sessao_caixa_id,
                        principalTable: "sessoes_caixa",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "movimentos_caixa",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    sessao_caixa_id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: false),
                    caixa_id = table.Column<string>(type: "TEXT", nullable: false),
                    numero_caixa = table.Column<short>(type: "INTEGER", nullable: false),
                    terminal_id = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    forma_pagamento_id = table.Column<string>(type: "TEXT", nullable: true),
                    valor = table.Column<long>(type: "INTEGER", nullable: false),
                    operador_id = table.Column<string>(type: "TEXT", nullable: false),
                    quem_retira_usuario_id = table.Column<string>(type: "TEXT", nullable: true),
                    quem_retira_nome = table.Column<string>(type: "TEXT", nullable: true),
                    observacao = table.Column<string>(type: "TEXT", nullable: true),
                    inf_adicionais = table.Column<string>(type: "TEXT", nullable: true),
                    ocorrido_em = table.Column<string>(type: "TEXT", nullable: false),
                    autorizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    troca_id = table.Column<string>(type: "TEXT", nullable: true),
                    cancelado = table.Column<bool>(type: "INTEGER", nullable: false),
                    cancelado_em = table.Column<string>(type: "TEXT", nullable: true),
                    cancelado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    autorizado_cancelamento_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    motivo_cancelamento = table.Column<string>(type: "TEXT", nullable: true),
                    movimento_conta_corrente_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_movimentos_caixa", x => x.id);
                    table.CheckConstraint("ck_movimentos_caixa_cancelado", "not cancelado or (cancelado_em is not null and motivo_cancelamento is not null)");
                    table.CheckConstraint("ck_movimentos_caixa_cancelado_bool", "cancelado in (0,1)");
                    table.CheckConstraint("ck_movimentos_caixa_estorno_forma", "tipo <> 'estorno_venda' or forma_pagamento_id is not null");
                    table.CheckConstraint("ck_movimentos_caixa_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_movimentos_caixa_sangria", "tipo <> 'sangria' or quem_retira_usuario_id is not null or quem_retira_nome is not null");
                    table.CheckConstraint("ck_movimentos_caixa_tipo", "tipo in ('abertura','reforco','sangria','sangria_fechamento','devolucao_troca','estorno_venda')");
                    table.CheckConstraint("ck_movimentos_caixa_valor", "valor > 0");
                    table.ForeignKey(
                        name: "fk_movimentos_caixa_sessao_caixa_id",
                        column: x => x.sessao_caixa_id,
                        principalTable: "sessoes_caixa",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "movimentos_vasilhame",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    sessao_caixa_id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: false),
                    caixa_id = table.Column<string>(type: "TEXT", nullable: false),
                    terminal_id = table.Column<string>(type: "TEXT", nullable: false),
                    operador_id = table.Column<string>(type: "TEXT", nullable: false),
                    pessoa_id = table.Column<string>(type: "TEXT", nullable: true),
                    produto_vasilhame_id = table.Column<string>(type: "TEXT", nullable: false),
                    quantidade = table.Column<long>(type: "INTEGER", nullable: false),
                    destino = table.Column<string>(type: "TEXT", nullable: false),
                    vale_id = table.Column<string>(type: "TEXT", nullable: true),
                    ocorrido_em = table.Column<string>(type: "TEXT", nullable: false),
                    cancelado = table.Column<bool>(type: "INTEGER", nullable: false),
                    cancelado_em = table.Column<string>(type: "TEXT", nullable: true),
                    cancelado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    motivo_cancelamento = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_movimentos_vasilhame", x => x.id);
                    table.CheckConstraint("ck_movimentos_vasilhame_cancelado", "not cancelado or (cancelado_em is not null and motivo_cancelamento is not null)");
                    table.CheckConstraint("ck_movimentos_vasilhame_cancelado_bool", "cancelado in (0,1)");
                    table.CheckConstraint("ck_movimentos_vasilhame_comodato", "destino <> 'baixa_comodato' or pessoa_id is not null");
                    table.CheckConstraint("ck_movimentos_vasilhame_destino", "destino in ('entrada','baixa_comodato','vale')");
                    table.CheckConstraint("ck_movimentos_vasilhame_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_movimentos_vasilhame_quantidade", "quantidade > 0");
                    table.CheckConstraint("ck_movimentos_vasilhame_vale", "(destino = 'vale') = (vale_id is not null)");
                    table.ForeignKey(
                        name: "fk_movimentos_vasilhame_sessao_caixa_id",
                        column: x => x.sessao_caixa_id,
                        principalTable: "sessoes_caixa",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "fechamentos_caixa_formas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    fechamento_id = table.Column<string>(type: "TEXT", nullable: false),
                    forma_pagamento_id = table.Column<string>(type: "TEXT", nullable: false),
                    descricao_forma = table.Column<string>(type: "TEXT", nullable: false),
                    tipo_forma = table.Column<string>(type: "TEXT", nullable: false),
                    valor_calculado = table.Column<long>(type: "INTEGER", nullable: false),
                    valor_digitado = table.Column<long>(type: "INTEGER", nullable: false),
                    diferenca = table.Column<long>(type: "INTEGER", nullable: false, computedColumnSql: "valor_digitado - valor_calculado", stored: true),
                    quantidade_pagamentos = table.Column<int>(type: "INTEGER", nullable: false),
                    preenchido_automatico = table.Column<bool>(type: "INTEGER", nullable: false),
                    valor_primeira_contagem = table.Column<long>(type: "INTEGER", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_fechamentos_caixa_formas", x => x.id);
                    table.CheckConstraint("ck_fechamentos_caixa_formas_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_fechamentos_caixa_formas_preenchido_automatico", "preenchido_automatico in (0,1)");
                    table.CheckConstraint("ck_fechamentos_caixa_formas_quantidade", "quantidade_pagamentos >= 0");
                    table.ForeignKey(
                        name: "fk_fechamentos_caixa_formas_fechamento_id",
                        column: x => x.fechamento_id,
                        principalTable: "fechamentos_caixa",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.AddCheckConstraint(
                name: "ck_eventos_saida_dependencias",
                table: "eventos_saida",
                sql: "json_valid(dependencias) and json_type(dependencias) = 'array'");

            migrationBuilder.AddCheckConstraint(
                name: "ck_eventos_saida_relogio_regrediu",
                table: "eventos_saida",
                sql: "relogio_regrediu in (0,1)");

            migrationBuilder.CreateIndex(
                name: "uq_fechamentos_caixa_sessao_caixa_id",
                table: "fechamentos_caixa",
                column: "sessao_caixa_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "uq_fechamentos_caixa_formas",
                table: "fechamentos_caixa_formas",
                columns: new[] { "fechamento_id", "forma_pagamento_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_movimentos_caixa_sessao_caixa_id",
                table: "movimentos_caixa",
                column: "sessao_caixa_id");

            migrationBuilder.CreateIndex(
                name: "ix_movimentos_vasilhame_sessao_caixa_id",
                table: "movimentos_vasilhame",
                column: "sessao_caixa_id");

            migrationBuilder.CreateIndex(
                name: "ix_sessoes_caixa_loja_dia",
                table: "sessoes_caixa",
                columns: new[] { "loja_id", "dia_operacional" });

            migrationBuilder.CreateIndex(
                name: "uq_sessoes_caixa_aberta",
                table: "sessoes_caixa",
                column: "terminal_id",
                unique: true,
                filter: "status <> 'fechada' and excluido_em is null");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "fechamentos_caixa_formas");

            migrationBuilder.DropTable(
                name: "movimentos_caixa");

            migrationBuilder.DropTable(
                name: "movimentos_vasilhame");

            migrationBuilder.DropTable(
                name: "fechamentos_caixa");

            migrationBuilder.DropTable(
                name: "sessoes_caixa");

            migrationBuilder.DropCheckConstraint(
                name: "ck_eventos_saida_dependencias",
                table: "eventos_saida");

            migrationBuilder.DropCheckConstraint(
                name: "ck_eventos_saida_relogio_regrediu",
                table: "eventos_saida");

            migrationBuilder.DropColumn(
                name: "dependencias",
                table: "eventos_saida");

            migrationBuilder.DropColumn(
                name: "relogio_regrediu",
                table: "eventos_saida");

            migrationBuilder.DropColumn(
                name: "confirmando_desativacao_em",
                table: "estado_conexao");

            migrationBuilder.DropColumn(
                name: "versoes_schema_nuvem",
                table: "estado_conexao");
        }
    }
}
