using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class FaseTres : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "itens_orcamento",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    orcamento_id = table.Column<string>(type: "TEXT", nullable: false),
                    sequencia = table.Column<int>(type: "INTEGER", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    variacao_id = table.Column<string>(type: "TEXT", nullable: true),
                    descricao = table.Column<string>(type: "TEXT", nullable: false),
                    unidade = table.Column<string>(type: "TEXT", nullable: false),
                    quantidade = table.Column<long>(type: "INTEGER", nullable: false),
                    preco_unitario = table.Column<long>(type: "INTEGER", nullable: false),
                    desconto_item = table.Column<long>(type: "INTEGER", nullable: false),
                    valor_total = table.Column<long>(type: "INTEGER", nullable: false),
                    observacao = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_itens_orcamento", x => x.id);
                    table.CheckConstraint("ck_itens_orcamento_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_itens_orcamento_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "orcamentos",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    codigo = table.Column<int>(type: "INTEGER", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: false),
                    pessoa_id = table.Column<string>(type: "TEXT", nullable: true),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    email = table.Column<string>(type: "TEXT", nullable: true),
                    telefone = table.Column<string>(type: "TEXT", nullable: true),
                    data = table.Column<string>(type: "TEXT", nullable: false),
                    dias_validade = table.Column<short>(type: "INTEGER", nullable: false),
                    valido_ate = table.Column<string>(type: "TEXT", nullable: false, computedColumnSql: "date(data, '+' || dias_validade || ' days')", stored: true),
                    ativo = table.Column<bool>(type: "INTEGER", nullable: false),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    respondido = table.Column<string>(type: "TEXT", nullable: false),
                    respondido_em = table.Column<string>(type: "TEXT", nullable: true),
                    resposta_observacao = table.Column<string>(type: "TEXT", nullable: true),
                    vendedor_id = table.Column<string>(type: "TEXT", nullable: true),
                    desconto_tipo = table.Column<string>(type: "TEXT", nullable: true),
                    desconto_valor = table.Column<long>(type: "INTEGER", nullable: false),
                    desconto_pct = table.Column<long>(type: "INTEGER", nullable: true),
                    subtotal_bruto = table.Column<long>(type: "INTEGER", nullable: false),
                    total = table.Column<long>(type: "INTEGER", nullable: false),
                    condicoes_pagamento = table.Column<string>(type: "TEXT", nullable: true),
                    observacoes = table.Column<string>(type: "TEXT", nullable: true),
                    origem = table.Column<string>(type: "TEXT", nullable: false),
                    origem_terminal_id = table.Column<string>(type: "TEXT", nullable: true),
                    venda_id = table.Column<string>(type: "TEXT", nullable: true),
                    convertido_em = table.Column<string>(type: "TEXT", nullable: true),
                    reservado_terminal_id = table.Column<string>(type: "TEXT", nullable: true),
                    reservado_ate = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_orcamentos", x => x.id);
                    table.CheckConstraint("ck_orcamentos_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_orcamentos_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_orcamentos_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "promocoes",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    parametros = table.Column<string>(type: "TEXT", nullable: false),
                    inicio = table.Column<string>(type: "TEXT", nullable: true),
                    fim = table.Column<string>(type: "TEXT", nullable: true),
                    dias_semana = table.Column<string>(type: "TEXT", nullable: true),
                    hora_inicio = table.Column<string>(type: "TEXT", nullable: true),
                    hora_fim = table.Column<string>(type: "TEXT", nullable: true),
                    lojas = table.Column<string>(type: "TEXT", nullable: true),
                    prioridade = table.Column<short>(type: "INTEGER", nullable: false),
                    acumulativa = table.Column<bool>(type: "INTEGER", nullable: false),
                    ativo = table.Column<bool>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_promocoes", x => x.id);
                    table.CheckConstraint("ck_promocoes_acumulativa", "acumulativa in (0,1)");
                    table.CheckConstraint("ck_promocoes_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_promocoes_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_promocoes_dias_semana_json", "dias_semana is null or json_valid(dias_semana)");
                    table.CheckConstraint("ck_promocoes_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_promocoes_lojas_json", "lojas is null or json_valid(lojas)");
                    table.CheckConstraint("ck_promocoes_parametros_json", "json_valid(parametros)");
                });

            migrationBuilder.CreateTable(
                name: "promocoes_itens",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    promocao_id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: true),
                    categoria_id = table.Column<string>(type: "TEXT", nullable: true),
                    quantidade = table.Column<long>(type: "INTEGER", nullable: false),
                    papel = table.Column<string>(type: "TEXT", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_promocoes_itens", x => x.id);
                    table.CheckConstraint("ck_promocoes_itens_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_promocoes_itens_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "vales",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    codigo = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    pessoa_id = table.Column<string>(type: "TEXT", nullable: true),
                    loja_emissao_id = table.Column<string>(type: "TEXT", nullable: false),
                    terminal_emissao_id = table.Column<string>(type: "TEXT", nullable: true),
                    valor_original = table.Column<long>(type: "INTEGER", nullable: false),
                    saldo = table.Column<long>(type: "INTEGER", nullable: false),
                    validade = table.Column<string>(type: "TEXT", nullable: false),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    origem_tipo = table.Column<string>(type: "TEXT", nullable: false),
                    origem_id = table.Column<string>(type: "TEXT", nullable: true),
                    conferencia_hash = table.Column<string>(type: "TEXT", nullable: true),
                    emitido_em = table.Column<string>(type: "TEXT", nullable: false),
                    emitido_por_id = table.Column<string>(type: "TEXT", nullable: false),
                    cancelado_em = table.Column<string>(type: "TEXT", nullable: true),
                    cancelado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    motivo_cancelamento = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_vales", x => x.id);
                    table.CheckConstraint("ck_vales_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_vales_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "vendas_status_pdv",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    caixa_id = table.Column<string>(type: "TEXT", nullable: false),
                    terminal_id = table.Column<string>(type: "TEXT", nullable: false),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    status_fiscal = table.Column<string>(type: "TEXT", nullable: false),
                    devolucao = table.Column<string>(type: "TEXT", nullable: false),
                    cancelada_em = table.Column<string>(type: "TEXT", nullable: true),
                    cancelamento_origem = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_vendas_status_pdv", x => x.id);
                    table.CheckConstraint("ck_vendas_status_pdv_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_vendas_status_pdv_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateIndex(
                name: "ix_itens_orcamento_orcamento_id",
                table: "itens_orcamento",
                column: "orcamento_id");

            migrationBuilder.CreateIndex(
                name: "ix_orcamentos_codigo",
                table: "orcamentos",
                column: "codigo");

            migrationBuilder.CreateIndex(
                name: "ix_promocoes_itens_categoria_id",
                table: "promocoes_itens",
                column: "categoria_id");

            migrationBuilder.CreateIndex(
                name: "ix_promocoes_itens_produto_id",
                table: "promocoes_itens",
                column: "produto_id");

            migrationBuilder.CreateIndex(
                name: "ix_promocoes_itens_promocao_id",
                table: "promocoes_itens",
                column: "promocao_id");

            migrationBuilder.CreateIndex(
                name: "ix_vales_atualizado_em",
                table: "vales",
                column: "atualizado_em");

            migrationBuilder.CreateIndex(
                name: "ix_vales_codigo",
                table: "vales",
                column: "codigo");

            migrationBuilder.CreateIndex(
                name: "ix_vales_pessoa_id",
                table: "vales",
                column: "pessoa_id");

            migrationBuilder.CreateIndex(
                name: "ix_vendas_status_pdv_atualizado_em",
                table: "vendas_status_pdv",
                column: "atualizado_em");

            // Release R3 do PDV (Fase 3, F3-B7; SYNC 17.4.2; padrões da Fase 3 › "uma volta de cursor por release";
            // README do PDV › decisão 99): todas as tabelas que descem na Fase 3 entram nesta migração, com uma única
            // volta dos cursores dos fluxos que elas ampliam. O PDV anterior descartou as linhas de `promocoes`,
            // `promocoes_itens` (catalogo), `vales` (pessoas), `orcamentos`, `itens_orcamento` e `vendas_status_pdv`
            // (operacao) — tabela desconhecida não trava o cursor — e a API vai para a produção antes dele: o cursor já
            // passou delas. O `configuracao` volta também porque o filtro dos `templates_documentos` ganhou `recibo_venda`
            // e `orcamento_*` (MD 3.1.3), cujas linhas do seed são antigas. Cursor a 0 e o ciclo baixa o fluxo de novo
            // (upsert por versão: as linhas iguais às locais são ignoradas, nada local é apagado, a venda segue); a carga
            // inicial continua concluída e a marca de "esperar o suporte" (`ressincronizar`) fica como estava (SYNC 6.3).
            // Nenhuma coluna nova em tabela existente, então nenhuma versão local volta. O `recibo_receber` saiu do filtro
            // (não é impresso no caixa) e a saída de filtro não tem tombstone (SYNC 4.1): as cópias locais saem aqui.
            migrationBuilder.Sql("delete from templates_documentos where tipo = 'recibo_receber';");
            migrationBuilder.Sql("update estado_sincronizacao set cursor = 0 where fluxo in ('configuracao', 'catalogo', 'pessoas', 'operacao');");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "itens_orcamento");

            migrationBuilder.DropTable(
                name: "orcamentos");

            migrationBuilder.DropTable(
                name: "promocoes");

            migrationBuilder.DropTable(
                name: "promocoes_itens");

            migrationBuilder.DropTable(
                name: "vales");

            migrationBuilder.DropTable(
                name: "vendas_status_pdv");
        }
    }
}
