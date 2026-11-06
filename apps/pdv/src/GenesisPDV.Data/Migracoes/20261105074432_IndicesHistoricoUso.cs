using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class IndicesHistoricoUso : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "ix_log_auditoria_local_acao_ocorrido_em",
                table: "log_auditoria_local",
                columns: new[] { "acao", "ocorrido_em" });

            migrationBuilder.CreateIndex(
                name: "ix_log_auditoria_local_ocorrido_em",
                table: "log_auditoria_local",
                columns: new[] { "ocorrido_em", "id" });

            migrationBuilder.CreateIndex(
                name: "ix_log_auditoria_local_usuario_ocorrido_em",
                table: "log_auditoria_local",
                columns: new[] { "usuario_id", "ocorrido_em" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_log_auditoria_local_acao_ocorrido_em",
                table: "log_auditoria_local");

            migrationBuilder.DropIndex(
                name: "ix_log_auditoria_local_ocorrido_em",
                table: "log_auditoria_local");

            migrationBuilder.DropIndex(
                name: "ix_log_auditoria_local_usuario_ocorrido_em",
                table: "log_auditoria_local");
        }
    }
}
