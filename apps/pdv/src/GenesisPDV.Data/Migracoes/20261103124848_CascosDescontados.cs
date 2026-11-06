using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class CascosDescontados : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "cascos_descontados_venda",
                columns: table => new
                {
                    venda_id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_vasilhame_id = table.Column<string>(type: "TEXT", nullable: false),
                    descricao = table.Column<string>(type: "TEXT", maxLength: 120, nullable: false),
                    quantidade = table.Column<int>(type: "INTEGER", nullable: false),
                    preco_unitario = table.Column<long>(type: "INTEGER", nullable: false),
                    registrado_em = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_cascos_descontados_venda", x => new { x.venda_id, x.produto_vasilhame_id });
                    table.CheckConstraint("ck_cascos_descontados_venda_preco", "preco_unitario > 0");
                    table.CheckConstraint("ck_cascos_descontados_venda_quantidade", "quantidade between 1 and 9999");
                    table.ForeignKey(
                        name: "fk_cascos_descontados_venda_venda_id",
                        column: x => x.venda_id,
                        principalTable: "vendas",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "cascos_descontados_venda");
        }
    }
}
