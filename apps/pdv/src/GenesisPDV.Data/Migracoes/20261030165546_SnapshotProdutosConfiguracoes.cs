using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class SnapshotProdutosConfiguracoes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "configuracoes",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    escopo = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: true),
                    chave = table.Column<string>(type: "TEXT", nullable: false),
                    valor = table.Column<string>(type: "TEXT", nullable: true),
                    valor_cifrado = table.Column<byte[]>(type: "BLOB", nullable: true),
                    segredo_definido_em = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_configuracoes", x => x.id);
                    table.CheckConstraint("ck_configuracoes_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_configuracoes_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_configuracoes_valor_json", "valor is null or json_valid(valor)");
                });

            migrationBuilder.CreateTable(
                name: "produtos_venda_snapshot",
                columns: table => new
                {
                    venda_id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    promocao_vigente = table.Column<bool>(type: "INTEGER", nullable: false),
                    dados = table.Column<string>(type: "TEXT", nullable: false),
                    registrado_em = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_produtos_venda_snapshot", x => new { x.venda_id, x.produto_id });
                    table.CheckConstraint("ck_produtos_venda_snapshot_dados", "json_valid(dados)");
                    table.CheckConstraint("ck_produtos_venda_snapshot_promocao_vigente", "promocao_vigente in (0,1)");
                    table.ForeignKey(
                        name: "fk_produtos_venda_snapshot_venda_id",
                        column: x => x.venda_id,
                        principalTable: "vendas",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_configuracoes_chave",
                table: "configuracoes",
                column: "chave");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "configuracoes");

            migrationBuilder.DropTable(
                name: "produtos_venda_snapshot");
        }
    }
}
