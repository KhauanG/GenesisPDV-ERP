using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <summary>
    /// Fase 3, F3-B15 (README › decisão 102): <c>itens_venda_complementos</c>, a tabela de movimento dos complementos do
    /// item, com as colunas da nuvem (o <c>EsquemaNuvemTests</c> confere). Só cria a tabela, vazia: nenhum cursor volta e
    /// nenhum dado existente muda (a tabela nasce e sobe no caixa, não desce).
    /// </summary>
    public partial class ComplementosVenda : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "itens_venda_complementos",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    item_venda_id = table.Column<string>(type: "TEXT", nullable: false),
                    complemento_id = table.Column<string>(type: "TEXT", nullable: true),
                    grupo_nome = table.Column<string>(type: "TEXT", nullable: false),
                    descricao = table.Column<string>(type: "TEXT", nullable: false),
                    quantidade = table.Column<long>(type: "INTEGER", nullable: false),
                    preco_adicional = table.Column<long>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_itens_venda_complementos", x => x.id);
                    table.CheckConstraint("ck_itens_venda_complementos_id_uuid", "length(id) = 36");
                    table.ForeignKey(
                        name: "fk_itens_venda_complementos_item_venda_id",
                        column: x => x.item_venda_id,
                        principalTable: "itens_venda",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_itens_venda_complementos_item_venda_id",
                table: "itens_venda_complementos",
                column: "item_venda_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "itens_venda_complementos");
        }
    }
}
