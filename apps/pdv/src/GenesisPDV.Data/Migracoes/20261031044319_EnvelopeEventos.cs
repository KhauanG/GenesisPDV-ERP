using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class EnvelopeEventos : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "contexto",
                table: "eventos_saida",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "desvio_relogio_ms",
                table: "eventos_saida",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ocorrido_em_local",
                table: "eventos_saida",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "relogio_confiavel",
                table: "eventos_saida",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "usuario_id",
                table: "eventos_saida",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddCheckConstraint(
                name: "ck_eventos_saida_contexto",
                table: "eventos_saida",
                sql: "contexto is null or json_valid(contexto)");

            migrationBuilder.AddCheckConstraint(
                name: "ck_eventos_saida_relogio_confiavel",
                table: "eventos_saida",
                sql: "relogio_confiavel in (0,1)");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_eventos_saida_contexto",
                table: "eventos_saida");

            migrationBuilder.DropCheckConstraint(
                name: "ck_eventos_saida_relogio_confiavel",
                table: "eventos_saida");

            migrationBuilder.DropColumn(
                name: "contexto",
                table: "eventos_saida");

            migrationBuilder.DropColumn(
                name: "desvio_relogio_ms",
                table: "eventos_saida");

            migrationBuilder.DropColumn(
                name: "ocorrido_em_local",
                table: "eventos_saida");

            migrationBuilder.DropColumn(
                name: "relogio_confiavel",
                table: "eventos_saida");

            migrationBuilder.DropColumn(
                name: "usuario_id",
                table: "eventos_saida");
        }
    }
}
