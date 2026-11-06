using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class ColunasMdAtualizado : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_pagamentos_venda_valor",
                table: "pagamentos_venda");

            migrationBuilder.DropCheckConstraint(
                name: "ck_itens_venda_valores",
                table: "itens_venda");

            migrationBuilder.AddColumn<string>(
                name: "desconto_total_origem",
                table: "vendas",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "idade_confirmada_em",
                table: "vendas",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "idade_confirmada_por_id",
                table: "vendas",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "transferido_de_id",
                table: "pagamentos_venda",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "valor_taxa_servico",
                table: "pagamentos_venda",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<string>(
                name: "motivo",
                table: "log_auditoria_local",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "sessao_caixa_id",
                table: "log_auditoria_local",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "desconto_promocao",
                table: "itens_venda",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<string>(
                name: "origem_entrada",
                table: "itens_venda",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "peso_digitado",
                table: "itens_venda",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "promocao_id",
                table: "itens_venda",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "vasilhame_item_origem_id",
                table: "itens_venda",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "restaurado_em",
                table: "identidade_terminal",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "versao_nuvem_fim",
                table: "eventos_saida",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "desvio_amostra_boot_id",
                table: "estado_conexao",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "desvio_amostra_utc_local",
                table: "estado_conexao",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "maior_hora_vista",
                table: "estado_conexao",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "segundos_offline_acumulados",
                table: "estado_conexao",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddCheckConstraint(
                name: "ck_vendas_desconto_total_origem",
                table: "vendas",
                sql: "desconto_total_origem is null or desconto_total_origem in ('operador','cliente','orcamento')");

            migrationBuilder.AddCheckConstraint(
                name: "ck_vendas_idade_confirmada",
                table: "vendas",
                sql: "(idade_confirmada_por_id is null) = (idade_confirmada_em is null)");

            migrationBuilder.AddCheckConstraint(
                name: "ck_pagamentos_venda_valor",
                table: "pagamentos_venda",
                sql: "valor > 0 and troco >= 0 and valor_taxa_servico between 0 and valor");

            migrationBuilder.AddCheckConstraint(
                name: "ck_itens_venda_origem_entrada",
                table: "itens_venda",
                sql: "origem_entrada is null or origem_entrada in ('leitor','teclado','balanca','etiqueta','busca','cardapio')");

            migrationBuilder.AddCheckConstraint(
                name: "ck_itens_venda_peso_digitado",
                table: "itens_venda",
                sql: "peso_digitado in (0,1)");

            migrationBuilder.AddCheckConstraint(
                name: "ck_itens_venda_promocao",
                table: "itens_venda",
                sql: "desconto_promocao = 0 or promocao_id is not null");

            migrationBuilder.AddCheckConstraint(
                name: "ck_itens_venda_valores",
                table: "itens_venda",
                sql: "valor_bruto >= 0 and desconto_item >= 0 and desconto_promocao >= 0 and desconto_rateado >= 0 and valor_liquido >= 0");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_vendas_desconto_total_origem",
                table: "vendas");

            migrationBuilder.DropCheckConstraint(
                name: "ck_vendas_idade_confirmada",
                table: "vendas");

            migrationBuilder.DropCheckConstraint(
                name: "ck_pagamentos_venda_valor",
                table: "pagamentos_venda");

            migrationBuilder.DropCheckConstraint(
                name: "ck_itens_venda_origem_entrada",
                table: "itens_venda");

            migrationBuilder.DropCheckConstraint(
                name: "ck_itens_venda_peso_digitado",
                table: "itens_venda");

            migrationBuilder.DropCheckConstraint(
                name: "ck_itens_venda_promocao",
                table: "itens_venda");

            migrationBuilder.DropCheckConstraint(
                name: "ck_itens_venda_valores",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "desconto_total_origem",
                table: "vendas");

            migrationBuilder.DropColumn(
                name: "idade_confirmada_em",
                table: "vendas");

            migrationBuilder.DropColumn(
                name: "idade_confirmada_por_id",
                table: "vendas");

            migrationBuilder.DropColumn(
                name: "transferido_de_id",
                table: "pagamentos_venda");

            migrationBuilder.DropColumn(
                name: "valor_taxa_servico",
                table: "pagamentos_venda");

            migrationBuilder.DropColumn(
                name: "motivo",
                table: "log_auditoria_local");

            migrationBuilder.DropColumn(
                name: "sessao_caixa_id",
                table: "log_auditoria_local");

            migrationBuilder.DropColumn(
                name: "desconto_promocao",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "origem_entrada",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "peso_digitado",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "promocao_id",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "vasilhame_item_origem_id",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "restaurado_em",
                table: "identidade_terminal");

            migrationBuilder.DropColumn(
                name: "versao_nuvem_fim",
                table: "eventos_saida");

            migrationBuilder.DropColumn(
                name: "desvio_amostra_boot_id",
                table: "estado_conexao");

            migrationBuilder.DropColumn(
                name: "desvio_amostra_utc_local",
                table: "estado_conexao");

            migrationBuilder.DropColumn(
                name: "maior_hora_vista",
                table: "estado_conexao");

            migrationBuilder.DropColumn(
                name: "segundos_offline_acumulados",
                table: "estado_conexao");

            migrationBuilder.AddCheckConstraint(
                name: "ck_pagamentos_venda_valor",
                table: "pagamentos_venda",
                sql: "valor > 0 and troco >= 0");

            migrationBuilder.AddCheckConstraint(
                name: "ck_itens_venda_valores",
                table: "itens_venda",
                sql: "valor_bruto >= 0 and desconto_item >= 0 and desconto_rateado >= 0 and valor_liquido >= 0");
        }
    }
}
