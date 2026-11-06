using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class IndiceAuditoriaAutorizadoPor : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "ix_log_auditoria_local_autorizado_ocorrido_em",
                table: "log_auditoria_local",
                columns: new[] { "autorizado_por_id", "ocorrido_em" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_log_auditoria_local_autorizado_ocorrido_em",
                table: "log_auditoria_local");
        }
    }
}
