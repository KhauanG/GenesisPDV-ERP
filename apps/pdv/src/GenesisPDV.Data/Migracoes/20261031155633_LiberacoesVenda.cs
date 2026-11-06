using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class LiberacoesVenda : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "liberacoes_venda",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    venda_id = table.Column<string>(type: "TEXT", nullable: false),
                    acao = table.Column<string>(type: "TEXT", maxLength: 60, nullable: false),
                    item_venda_id = table.Column<string>(type: "TEXT", nullable: true),
                    valor_pct = table.Column<long>(type: "INTEGER", nullable: true),
                    autorizado_por_id = table.Column<string>(type: "TEXT", nullable: false),
                    motivo = table.Column<string>(type: "TEXT", maxLength: 255, nullable: false),
                    ocorrido_em = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_liberacoes_venda", x => x.id);
                    table.CheckConstraint("ck_liberacoes_venda_id_uuid", "length(id) = 36");
                    table.ForeignKey(
                        name: "fk_liberacoes_venda_venda_id",
                        column: x => x.venda_id,
                        principalTable: "vendas",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_liberacoes_venda_venda_id",
                table: "liberacoes_venda",
                column: "venda_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "liberacoes_venda");
        }
    }
}
