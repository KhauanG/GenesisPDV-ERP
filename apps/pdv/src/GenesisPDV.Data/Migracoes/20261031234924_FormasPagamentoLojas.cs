using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class FormasPagamentoLojas : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "loja_id",
                table: "formas_pagamento");

            migrationBuilder.AddColumn<bool>(
                name: "exige_supervisor",
                table: "formas_pagamento",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "formas_pagamento_lojas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    forma_pagamento_id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_formas_pagamento_lojas", x => x.id);
                    table.CheckConstraint("ck_formas_pagamento_lojas_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_lojas_id_uuid", "length(id) = 36");
                });

            migrationBuilder.AddCheckConstraint(
                name: "ck_formas_pagamento_exige_supervisor",
                table: "formas_pagamento",
                sql: "exige_supervisor in (0,1)");

            migrationBuilder.CreateIndex(
                name: "ix_formas_pagamento_lojas_forma_pagamento_id",
                table: "formas_pagamento_lojas",
                column: "forma_pagamento_id");

            // SYNC 17.4.2: espelho novo (`formas_pagamento_lojas`) e coluna nova cujo valor o caixa precisa
            // (`exige_supervisor`) num fluxo que já existia. O PDV anterior descartou as duas (tabela e coluna
            // desconhecidas não travam o cursor) e o cursor de `configuracao` pode já estar além dos vínculos que a 0014
            // da API criou: sem isto a tabela nasce vazia e o caixa não oferece forma nenhuma. O cursor volta a 0 e o
            // ciclo baixa o fluxo de novo (upsert por versão, nada local é apagado, como o comando
            // `ressincronizar_fluxo`); a versão local das formas também, senão a mesma versão da nuvem, agora com o
            // `exige_supervisor` real, seria ignorada (`excluded.versao > versao`). Não usa `ressincronizar = 1`: aqui
            // ele quer dizer "esperar o suporte" (teto menor que o cursor, SYNC 6.3) e o pull pularia o fluxo.
            migrationBuilder.Sql("update formas_pagamento set versao = 0;");
            migrationBuilder.Sql("update estado_sincronizacao set cursor = 0 where fluxo = 'configuracao';");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "formas_pagamento_lojas");

            migrationBuilder.DropCheckConstraint(
                name: "ck_formas_pagamento_exige_supervisor",
                table: "formas_pagamento");

            migrationBuilder.DropColumn(
                name: "exige_supervisor",
                table: "formas_pagamento");

            migrationBuilder.AddColumn<string>(
                name: "loja_id",
                table: "formas_pagamento",
                type: "TEXT",
                nullable: true);
        }
    }
}
