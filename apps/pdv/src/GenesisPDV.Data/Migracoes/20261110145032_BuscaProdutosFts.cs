using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <summary>
    /// Pesquisa F2 com FTS5 (Fase 2, F2-B36; MD 4.2; README do PDV › decisão 83): a tabela de conteúdo
    /// <c>produtos_busca_texto</c> (uma linha por produto, o texto sem acento), a tabela virtual <c>produtos_busca</c>
    /// (FTS5, trigrama, conteúdo externo) e os gatilhos que a mantêm. Fora do modelo do EF e do Esquema.g.cs (não é
    /// espelho). O preenchimento é da abertura (<c>IndiceBuscaProdutos.GarantirAsync</c>, logo depois desta migração): o
    /// texto sem acento sai do C# (o SQLite não tira acento) e a contagem diferente da de <c>produtos</c> dispara a
    /// reconstrução com o espelho que já existe, sem voltar o cursor. O SQL fica escrito aqui, e não lido de
    /// <c>IndiceBuscaProdutos.Ddl</c>: a migração aplicada não pode mudar depois (o <c>IndiceBuscaProdutosTests</c>
    /// confere que os dois dão o mesmo esquema).
    /// </summary>
    public partial class BuscaProdutosFts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Idempotente: o que existir com estes nomes (uma estrutura criada fora da ordem, um banco restaurado) sai antes,
            // e a abertura preenche de novo pelo espelho.
            migrationBuilder.Sql("DROP TABLE IF EXISTS produtos_busca;");
            migrationBuilder.Sql("DROP TRIGGER IF EXISTS tg_produtos_busca_texto_ai;");
            migrationBuilder.Sql("DROP TRIGGER IF EXISTS tg_produtos_busca_texto_ad;");
            migrationBuilder.Sql("DROP TRIGGER IF EXISTS tg_produtos_busca_texto_au;");
            migrationBuilder.Sql("DROP TABLE IF EXISTS produtos_busca_texto;");
            migrationBuilder.Sql(
                "CREATE TABLE produtos_busca_texto (id INTEGER PRIMARY KEY, produto_id TEXT NOT NULL UNIQUE, texto TEXT NOT NULL);");
            migrationBuilder.Sql(
                "CREATE VIRTUAL TABLE produtos_busca USING fts5(texto, content='produtos_busca_texto', content_rowid='id', tokenize='trigram');");
            migrationBuilder.Sql(
                "CREATE TRIGGER tg_produtos_busca_texto_ai AFTER INSERT ON produtos_busca_texto BEGIN " +
                "INSERT INTO produtos_busca (rowid, texto) VALUES (new.id, new.texto); END;");
            migrationBuilder.Sql(
                "CREATE TRIGGER tg_produtos_busca_texto_ad AFTER DELETE ON produtos_busca_texto BEGIN " +
                "INSERT INTO produtos_busca (produtos_busca, rowid, texto) VALUES ('delete', old.id, old.texto); END;");
            migrationBuilder.Sql(
                "CREATE TRIGGER tg_produtos_busca_texto_au AFTER UPDATE ON produtos_busca_texto BEGIN " +
                "INSERT INTO produtos_busca (produtos_busca, rowid, texto) VALUES ('delete', old.id, old.texto); " +
                "INSERT INTO produtos_busca (rowid, texto) VALUES (new.id, new.texto); END;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP TABLE IF EXISTS produtos_busca;");
            migrationBuilder.Sql("DROP TRIGGER IF EXISTS tg_produtos_busca_texto_ai;");
            migrationBuilder.Sql("DROP TRIGGER IF EXISTS tg_produtos_busca_texto_ad;");
            migrationBuilder.Sql("DROP TRIGGER IF EXISTS tg_produtos_busca_texto_au;");
            migrationBuilder.Sql("DROP TABLE IF EXISTS produtos_busca_texto;");
        }
    }
}
