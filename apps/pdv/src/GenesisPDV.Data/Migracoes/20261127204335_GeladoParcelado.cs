using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <summary>
    /// Fase 3, F3-B18 (README › decisão 105): só local, sem volta de cursor. Cria <c>itens_venda_gelados</c>, a marca do
    /// gelado do item (o <c>Alt+G</c>, PDV 11.4), e a coluna <c>estado_operacao.tipo_preco_antes_parcelado</c>, o tipo do
    /// <c>F8</c> da venda atual no preço parcelado (11.2). Nenhuma das duas sobe nem desce, e nenhum dado existente muda (a
    /// tabela nasce vazia, a coluna nula).
    /// </summary>
    public partial class GeladoParcelado : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "tipo_preco_antes_parcelado",
                table: "estado_operacao",
                type: "TEXT",
                maxLength: 10,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "itens_venda_gelados",
                columns: table => new
                {
                    item_venda_id = table.Column<string>(type: "TEXT", nullable: false),
                    venda_id = table.Column<string>(type: "TEXT", nullable: false),
                    acrescimo_unitario = table.Column<long>(type: "INTEGER", nullable: false),
                    registrado_em = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_itens_venda_gelados", x => x.item_venda_id);
                    table.CheckConstraint("ck_itens_venda_gelados_acrescimo", "acrescimo_unitario > 0");
                    table.ForeignKey(
                        name: "fk_itens_venda_gelados_item_venda_id",
                        column: x => x.item_venda_id,
                        principalTable: "itens_venda",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_itens_venda_gelados_venda_id",
                        column: x => x.venda_id,
                        principalTable: "vendas",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.AddCheckConstraint(
                name: "ck_estado_operacao_tipo_preco_antes_parcelado",
                table: "estado_operacao",
                sql: "tipo_preco_antes_parcelado is null or tipo_preco_antes_parcelado in ('varejo','atacado')");

            migrationBuilder.CreateIndex(
                name: "ix_itens_venda_gelados_venda_id",
                table: "itens_venda_gelados",
                column: "venda_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "itens_venda_gelados");

            migrationBuilder.DropCheckConstraint(
                name: "ck_estado_operacao_tipo_preco_antes_parcelado",
                table: "estado_operacao");

            migrationBuilder.DropColumn(
                name: "tipo_preco_antes_parcelado",
                table: "estado_operacao");
        }
    }
}
