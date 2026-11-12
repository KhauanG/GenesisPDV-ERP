using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class FaseDois : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "logotipo_sha256",
                table: "marcas",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "logotipo_url",
                table: "marcas",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "imagem_sha256",
                table: "categorias",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "imagem_url",
                table: "categorias",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "produtos_complementos",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    grupo_id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: true),
                    descricao = table.Column<string>(type: "TEXT", nullable: true),
                    preco_adicional = table.Column<long>(type: "INTEGER", nullable: false),
                    baixa_estoque = table.Column<bool>(type: "INTEGER", nullable: false),
                    quantidade_baixa = table.Column<long>(type: "INTEGER", nullable: false),
                    ordem = table.Column<int>(type: "INTEGER", nullable: false),
                    ativo = table.Column<bool>(type: "INTEGER", nullable: false),
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
                    table.PrimaryKey("pk_produtos_complementos", x => x.id);
                    table.CheckConstraint("ck_produtos_complementos_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_produtos_complementos_baixa_estoque", "baixa_estoque in (0,1)");
                    table.CheckConstraint("ck_produtos_complementos_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_produtos_complementos_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "produtos_grupos_complementos",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    minimo = table.Column<short>(type: "INTEGER", nullable: false),
                    maximo = table.Column<short>(type: "INTEGER", nullable: false),
                    obrigatorio = table.Column<bool>(type: "INTEGER", nullable: false),
                    ordem = table.Column<int>(type: "INTEGER", nullable: false),
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
                    table.PrimaryKey("pk_produtos_grupos_complementos", x => x.id);
                    table.CheckConstraint("ck_produtos_grupos_complementos_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_produtos_grupos_complementos_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_produtos_grupos_complementos_obrigatorio", "obrigatorio in (0,1)");
                });

            migrationBuilder.CreateIndex(
                name: "ix_produtos_complementos_grupo_id",
                table: "produtos_complementos",
                column: "grupo_id");

            migrationBuilder.CreateIndex(
                name: "ix_produtos_grupos_complementos_produto_id",
                table: "produtos_grupos_complementos",
                column: "produto_id");

            // Release R2 do PDV (Fase 2, F2-B45; SYNC 17.4.2, como a `FormasPagamentoLojas` do C8b): todas as mudanças de
            // Esquema.g.cs da Fase 2 numa migração só, com uma única volta do cursor do `catalogo`. O PDV anterior
            // descartou as colunas novas das marcas e das categorias (`logotipo_*`, `imagem_*`) e as tabelas de
            // complementos (tabela e coluna desconhecidas não travam o cursor), e a API vai para a produção antes dele:
            // o cursor pode já estar além dessas linhas. O cursor volta a 0 e o ciclo baixa o fluxo de novo (upsert por
            // versão, nada local é apagado, a venda segue); a versão local das marcas e das categorias também, senão a
            // mesma versão da nuvem, agora com a imagem, seria ignorada (`excluded.versao > versao`). Os produtos não:
            // `foto_url`/`foto_sha256` já existiam no espelho desde a 1A e o PDV anterior grava os dois assim que a API
            // nova os manda (a foto só existe a partir dela). Não usa `ressincronizar = 1` ("esperar o suporte", SYNC 6.3).
            migrationBuilder.Sql("update marcas set versao = 0;");
            migrationBuilder.Sql("update categorias set versao = 0;");
            migrationBuilder.Sql("update estado_sincronizacao set cursor = 0 where fluxo = 'catalogo';");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "produtos_complementos");

            migrationBuilder.DropTable(
                name: "produtos_grupos_complementos");

            migrationBuilder.DropColumn(
                name: "logotipo_sha256",
                table: "marcas");

            migrationBuilder.DropColumn(
                name: "logotipo_url",
                table: "marcas");

            migrationBuilder.DropColumn(
                name: "imagem_sha256",
                table: "categorias");

            migrationBuilder.DropColumn(
                name: "imagem_url",
                table: "categorias");
        }
    }
}
