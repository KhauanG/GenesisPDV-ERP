using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class ProdutosSemPeso : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "peso_abatimento_g",
                table: "produtos");

            migrationBuilder.DropColumn(
                name: "peso_g",
                table: "produtos");

            migrationBuilder.DropColumn(
                name: "peso_pacote_kg",
                table: "produtos");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "peso_abatimento_g",
                table: "produtos",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "peso_g",
                table: "produtos",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "peso_pacote_kg",
                table: "produtos",
                type: "INTEGER",
                nullable: true);
        }
    }
}
