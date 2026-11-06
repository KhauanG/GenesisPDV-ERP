using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class IndiceFilaImpressaoDocumento : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "ix_fila_impressao_documento",
                table: "fila_impressao",
                columns: new[] { "tipo_documento", "referencia_id" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_fila_impressao_documento",
                table: "fila_impressao");
        }
    }
}
