using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <summary>
    /// D22 (README › decisão 51): com a confirmação da desativação em voo (<c>estado_conexao.confirmando_desativacao_em</c>),
    /// o banco recusa o que subiria. Migração própria porque o SQLite do EF recria as tabelas no fim da migração (a
    /// <c>TabelasCaixa</c> recria <c>eventos_saida</c> para o CHECK novo) e o gatilho criado antes some na recriação. Uma
    /// migração futura que recrie <c>eventos_saida</c> ou <c>log_auditoria_local</c> precisa recriar o gatilho numa
    /// migração seguinte (o <c>MigracaoTabelasCaixaTests</c> confere no banco atual). O caso inverso quebra a migração:
    /// recriar <c>estado_conexao</c> (a tabela do <c>WHEN</c>) aborta no <c>ALTER TABLE ef_temp_… RENAME</c>, porque o
    /// SQLite revalida os gatilhos no RENAME (<c>legacy_alter_table</c> desligado) e não acha a tabela. Essa migração
    /// precisa de um <c>DROP TRIGGER</c> dos dois gatilhos antes (operação <c>Sql</c> no início dela) e de recriá-los numa
    /// migração seguinte (conferido no <c>MigracaoTabelasCaixaTests</c>). O SQL fica escrito aqui, e não lido de
    /// <c>TravaDesativacao.Gatilho</c>: a migração aplicada não pode mudar depois.
    /// </summary>
    public partial class TravaDesativacao : Migration
    {
        private static readonly string[] Tabelas = ["eventos_saida", "log_auditoria_local"];

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            foreach (var tabela in Tabelas)
            {
                migrationBuilder.Sql(
                    $"CREATE TRIGGER tg_{tabela}_confirmando_desativacao BEFORE INSERT ON {tabela} " +
                    "WHEN EXISTS (SELECT 1 FROM estado_conexao WHERE confirmando_desativacao_em IS NOT NULL) " +
                    "BEGIN SELECT RAISE(ABORT, 'terminal_confirmando_desativacao'); END;");
            }
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            foreach (var tabela in Tabelas)
            {
                migrationBuilder.Sql($"DROP TRIGGER IF EXISTS tg_{tabela}_confirmando_desativacao;");
            }
        }
    }
}
