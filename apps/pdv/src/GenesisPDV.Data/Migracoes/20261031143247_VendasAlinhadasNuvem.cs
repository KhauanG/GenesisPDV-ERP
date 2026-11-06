using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class VendasAlinhadasNuvem : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "relogio_confiavel",
                table: "vendas",
                type: "INTEGER",
                nullable: false,
                defaultValue: true);

            migrationBuilder.AddCheckConstraint(
                name: "ck_vendas_canal",
                table: "vendas",
                sql: "canal in ('pdv','erp','ifood','99food','woocommerce','nuvemshop','menu_digital','totem')");

            migrationBuilder.AddCheckConstraint(
                name: "ck_vendas_cancelamento_origem",
                table: "vendas",
                sql: "cancelamento_origem is null or cancelamento_origem in ('pdv','erp')");

            migrationBuilder.AddCheckConstraint(
                name: "ck_vendas_cpf_cnpj_nota",
                table: "vendas",
                sql: "cpf_cnpj_nota is null or (length(cpf_cnpj_nota) = 11 and cpf_cnpj_nota not glob '*[^0-9]*') or (length(cpf_cnpj_nota) = 14 and substr(cpf_cnpj_nota, 1, 12) not glob '*[^0-9A-Z]*' and substr(cpf_cnpj_nota, 13, 2) not glob '*[^0-9]*')");

            migrationBuilder.AddCheckConstraint(
                name: "ck_vendas_relogio_confiavel",
                table: "vendas",
                sql: "relogio_confiavel in (0,1)");

            migrationBuilder.AddCheckConstraint(
                name: "ck_vendas_status_fiscal",
                table: "vendas",
                sql: "status_fiscal in ('nao_aplicavel','pendente','transmitindo','autorizada','contingencia','rejeitada','denegada','cancelamento_pendente','cancelada','inutilizada','nfe_solicitada')");

            migrationBuilder.AddCheckConstraint(
                name: "ck_pagamentos_venda_tipo_integracao",
                table: "pagamentos_venda",
                sql: "tipo_integracao is null or tipo_integracao in (1,2)");

            migrationBuilder.AddCheckConstraint(
                name: "ck_pagamentos_venda_uf_pagamento",
                table: "pagamentos_venda",
                sql: "(cnpj_pagamento is null) = (uf_pagamento is null)");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_vendas_canal",
                table: "vendas");

            migrationBuilder.DropCheckConstraint(
                name: "ck_vendas_cancelamento_origem",
                table: "vendas");

            migrationBuilder.DropCheckConstraint(
                name: "ck_vendas_cpf_cnpj_nota",
                table: "vendas");

            migrationBuilder.DropCheckConstraint(
                name: "ck_vendas_relogio_confiavel",
                table: "vendas");

            migrationBuilder.DropCheckConstraint(
                name: "ck_vendas_status_fiscal",
                table: "vendas");

            migrationBuilder.DropCheckConstraint(
                name: "ck_pagamentos_venda_tipo_integracao",
                table: "pagamentos_venda");

            migrationBuilder.DropCheckConstraint(
                name: "ck_pagamentos_venda_uf_pagamento",
                table: "pagamentos_venda");

            migrationBuilder.DropColumn(
                name: "relogio_confiavel",
                table: "vendas");
        }
    }
}
