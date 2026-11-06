using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class CobrancasPix : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "cobrancas_pix",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    txid = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: false),
                    terminal_id = table.Column<string>(type: "TEXT", nullable: false),
                    venda_id = table.Column<string>(type: "TEXT", nullable: true),
                    pagamento_venda_id = table.Column<string>(type: "TEXT", nullable: true),
                    psp = table.Column<string>(type: "TEXT", nullable: true),
                    valor = table.Column<long>(type: "INTEGER", nullable: false),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    qrcode_payload = table.Column<string>(type: "TEXT", nullable: false),
                    expira_em = table.Column<string>(type: "TEXT", nullable: true),
                    paga_em = table.Column<string>(type: "TEXT", nullable: true),
                    e2e_id = table.Column<string>(type: "TEXT", nullable: true),
                    pagador_nome = table.Column<string>(type: "TEXT", nullable: true),
                    pagador_documento = table.Column<string>(type: "TEXT", nullable: true),
                    valor_devolvido = table.Column<long>(type: "INTEGER", nullable: false),
                    devolvida_em = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_cobrancas_pix", x => x.id);
                    table.CheckConstraint("ck_cobrancas_pix_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_cobrancas_pix_status", "status in ('ativa','paga','expirada','cancelada','devolvida','paga_sem_venda')");
                    table.CheckConstraint("ck_cobrancas_pix_tipo", "tipo in ('dinamico','estatico')");
                    table.ForeignKey(
                        name: "fk_cobrancas_pix_pagamento_venda_id",
                        column: x => x.pagamento_venda_id,
                        principalTable: "pagamentos_venda",
                        principalColumn: "id");
                    table.ForeignKey(
                        name: "fk_cobrancas_pix_venda_id",
                        column: x => x.venda_id,
                        principalTable: "vendas",
                        principalColumn: "id");
                });

            migrationBuilder.CreateIndex(
                name: "ix_cobrancas_pix_pagamento_venda_id",
                table: "cobrancas_pix",
                column: "pagamento_venda_id");

            migrationBuilder.CreateIndex(
                name: "ix_cobrancas_pix_txid",
                table: "cobrancas_pix",
                column: "txid");

            migrationBuilder.CreateIndex(
                name: "ix_cobrancas_pix_venda_id",
                table: "cobrancas_pix",
                column: "venda_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "cobrancas_pix");
        }
    }
}
