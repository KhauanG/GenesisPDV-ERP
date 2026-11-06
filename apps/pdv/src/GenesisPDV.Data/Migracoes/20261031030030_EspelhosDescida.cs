using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class EspelhosDescida : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "atalhos_pdv",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: true),
                    acao = table.Column<string>(type: "TEXT", nullable: false),
                    tecla = table.Column<string>(type: "TEXT", nullable: false),
                    habilitado = table.Column<bool>(type: "INTEGER", nullable: false),
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
                    table.PrimaryKey("pk_atalhos_pdv", x => x.id);
                    table.CheckConstraint("ck_atalhos_pdv_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_atalhos_pdv_habilitado", "habilitado in (0,1)");
                    table.CheckConstraint("ck_atalhos_pdv_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "atributos_variacao",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
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
                    table.PrimaryKey("pk_atributos_variacao", x => x.id);
                    table.CheckConstraint("ck_atributos_variacao_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_atributos_variacao_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "atributos_variacao_valores",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    atributo_id = table.Column<string>(type: "TEXT", nullable: false),
                    valor = table.Column<string>(type: "TEXT", nullable: false),
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
                    table.PrimaryKey("pk_atributos_variacao_valores", x => x.id);
                    table.CheckConstraint("ck_atributos_variacao_valores_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_atributos_variacao_valores_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "bloqueios_senha_local",
                columns: table => new
                {
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    registro_id = table.Column<string>(type: "TEXT", nullable: false),
                    tentativas = table.Column<int>(type: "INTEGER", nullable: false),
                    primeira_falha_em = table.Column<string>(type: "TEXT", nullable: true),
                    bloqueado_ate = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_bloqueios_senha_local", x => new { x.tipo, x.registro_id });
                    table.CheckConstraint("ck_bloqueios_senha_local_tipo", "tipo in ('usuario','cliente')");
                });

            migrationBuilder.CreateTable(
                name: "caixas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: false),
                    numero = table.Column<short>(type: "INTEGER", nullable: false),
                    descricao = table.Column<string>(type: "TEXT", nullable: true),
                    sistema = table.Column<bool>(type: "INTEGER", nullable: false),
                    nfce_serie = table.Column<int>(type: "INTEGER", nullable: true),
                    tef_terminal = table.Column<string>(type: "TEXT", nullable: true),
                    pos_id_terminal = table.Column<string>(type: "TEXT", nullable: true),
                    terminal_id = table.Column<string>(type: "TEXT", nullable: true),
                    terminal_anterior_id = table.Column<string>(type: "TEXT", nullable: true),
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
                    table.PrimaryKey("pk_caixas", x => x.id);
                    table.CheckConstraint("ck_caixas_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_caixas_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_caixas_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_caixas_sistema", "sistema in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "categorias",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    categoria_pai_id = table.Column<string>(type: "TEXT", nullable: true),
                    caminho = table.Column<string>(type: "TEXT", nullable: false),
                    caminho_nomes = table.Column<string>(type: "TEXT", nullable: false),
                    nivel = table.Column<short>(type: "INTEGER", nullable: false),
                    ordem = table.Column<int>(type: "INTEGER", nullable: false),
                    ativa = table.Column<bool>(type: "INTEGER", nullable: false),
                    exibe_pdv = table.Column<bool>(type: "INTEGER", nullable: false),
                    exibe_menu_digital = table.Column<bool>(type: "INTEGER", nullable: false),
                    exibe_totem = table.Column<bool>(type: "INTEGER", nullable: false),
                    exibe_site = table.Column<bool>(type: "INTEGER", nullable: false),
                    imagem_arquivo_id = table.Column<string>(type: "TEXT", nullable: true),
                    cor = table.Column<string>(type: "TEXT", nullable: true),
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
                    table.PrimaryKey("pk_categorias", x => x.id);
                    table.CheckConstraint("ck_categorias_ativa", "ativa in (0,1)");
                    table.CheckConstraint("ck_categorias_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_categorias_exibe_menu_digital", "exibe_menu_digital in (0,1)");
                    table.CheckConstraint("ck_categorias_exibe_pdv", "exibe_pdv in (0,1)");
                    table.CheckConstraint("ck_categorias_exibe_site", "exibe_site in (0,1)");
                    table.CheckConstraint("ck_categorias_exibe_totem", "exibe_totem in (0,1)");
                    table.CheckConstraint("ck_categorias_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "certificados_digitais",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    arquivo_cifrado = table.Column<byte[]>(type: "BLOB", nullable: true),
                    senha_cifrada = table.Column<byte[]>(type: "BLOB", nullable: true),
                    titular = table.Column<string>(type: "TEXT", nullable: false),
                    cnpj = table.Column<string>(type: "TEXT", nullable: false),
                    numero_serie = table.Column<string>(type: "TEXT", nullable: false),
                    emissor = table.Column<string>(type: "TEXT", nullable: true),
                    valido_de = table.Column<string>(type: "TEXT", nullable: false),
                    valido_ate = table.Column<string>(type: "TEXT", nullable: false),
                    impressao_digital = table.Column<string>(type: "TEXT", nullable: false),
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
                    table.PrimaryKey("pk_certificados_digitais", x => x.id);
                    table.CheckConstraint("ck_certificados_digitais_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_certificados_digitais_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_certificados_digitais_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "cfops",
                columns: table => new
                {
                    codigo = table.Column<string>(type: "TEXT", nullable: false),
                    descricao = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    abrangencia = table.Column<string>(type: "TEXT", nullable: false),
                    ativo = table.Column<bool>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_cfops", x => x.codigo);
                    table.CheckConstraint("ck_cfops_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_cfops_criado_localmente", "criado_localmente in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "cfops_grupos",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    grupo = table.Column<string>(type: "TEXT", nullable: false),
                    cfop = table.Column<string>(type: "TEXT", nullable: false),
                    padrao = table.Column<bool>(type: "INTEGER", nullable: false),
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
                    table.PrimaryKey("pk_cfops_grupos", x => x.id);
                    table.CheckConstraint("ck_cfops_grupos_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_cfops_grupos_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_cfops_grupos_padrao", "padrao in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "comandos_recebidos",
                columns: table => new
                {
                    comando_id = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    recebido_em = table.Column<string>(type: "TEXT", nullable: false),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    resultado = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_comandos_recebidos", x => x.comando_id);
                    table.CheckConstraint("ck_comandos_recebidos_resultado", "resultado is null or json_valid(resultado)");
                    table.CheckConstraint("ck_comandos_recebidos_status", "status in ('recebido','executado','falhou')");
                });

            migrationBuilder.CreateTable(
                name: "empresa",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    unica = table.Column<bool>(type: "INTEGER", nullable: false),
                    codigo = table.Column<int>(type: "INTEGER", nullable: false),
                    razao_social = table.Column<string>(type: "TEXT", nullable: false),
                    nome_fantasia = table.Column<string>(type: "TEXT", nullable: true),
                    cnpj = table.Column<string>(type: "TEXT", nullable: false),
                    ie = table.Column<string>(type: "TEXT", nullable: true),
                    inscricao_municipal = table.Column<string>(type: "TEXT", nullable: true),
                    cep = table.Column<string>(type: "TEXT", nullable: true),
                    logradouro = table.Column<string>(type: "TEXT", nullable: true),
                    numero = table.Column<string>(type: "TEXT", nullable: true),
                    complemento = table.Column<string>(type: "TEXT", nullable: true),
                    bairro = table.Column<string>(type: "TEXT", nullable: true),
                    municipio_ibge = table.Column<int>(type: "INTEGER", nullable: true),
                    uf = table.Column<string>(type: "TEXT", nullable: true),
                    telefone = table.Column<string>(type: "TEXT", nullable: true),
                    email = table.Column<string>(type: "TEXT", nullable: true),
                    email_contador = table.Column<string>(type: "TEXT", nullable: true),
                    fuso_horario = table.Column<string>(type: "TEXT", nullable: false),
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
                    table.PrimaryKey("pk_empresa", x => x.id);
                    table.CheckConstraint("ck_empresa_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_empresa_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_empresa_unica", "unica in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "estoques",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    codigo = table.Column<int>(type: "INTEGER", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    endereco = table.Column<string>(type: "TEXT", nullable: true),
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
                    table.PrimaryKey("pk_estoques", x => x.id);
                    table.CheckConstraint("ck_estoques_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_estoques_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_estoques_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "impressoras_destino",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    descricao = table.Column<string>(type: "TEXT", nullable: true),
                    loja_id = table.Column<string>(type: "TEXT", nullable: true),
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
                    table.PrimaryKey("pk_impressoras_destino", x => x.id);
                    table.CheckConstraint("ck_impressoras_destino_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_impressoras_destino_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_impressoras_destino_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "lojas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    codigo = table.Column<short>(type: "INTEGER", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    razao_social = table.Column<string>(type: "TEXT", nullable: false),
                    nome_fantasia = table.Column<string>(type: "TEXT", nullable: false),
                    cnpj = table.Column<string>(type: "TEXT", nullable: false),
                    ie = table.Column<string>(type: "TEXT", nullable: true),
                    inscricao_municipal = table.Column<string>(type: "TEXT", nullable: true),
                    telefone = table.Column<string>(type: "TEXT", nullable: true),
                    celular = table.Column<string>(type: "TEXT", nullable: true),
                    email = table.Column<string>(type: "TEXT", nullable: true),
                    estoque_id = table.Column<string>(type: "TEXT", nullable: false),
                    cep = table.Column<string>(type: "TEXT", nullable: false),
                    logradouro = table.Column<string>(type: "TEXT", nullable: false),
                    numero = table.Column<string>(type: "TEXT", nullable: false),
                    complemento = table.Column<string>(type: "TEXT", nullable: true),
                    bairro = table.Column<string>(type: "TEXT", nullable: false),
                    municipio_ibge = table.Column<int>(type: "INTEGER", nullable: false),
                    uf = table.Column<string>(type: "TEXT", nullable: false),
                    fuso_horario = table.Column<string>(type: "TEXT", nullable: false),
                    frase_rodape_cupom = table.Column<string>(type: "TEXT", nullable: true),
                    ordem = table.Column<int>(type: "INTEGER", nullable: false),
                    ativa = table.Column<bool>(type: "INTEGER", nullable: false),
                    usa_pdv = table.Column<bool>(type: "INTEGER", nullable: false),
                    usa_menu_digital = table.Column<bool>(type: "INTEGER", nullable: false),
                    chave_publica = table.Column<string>(type: "TEXT", nullable: true),
                    logotipo_arquivo_id = table.Column<string>(type: "TEXT", nullable: true),
                    foto_arquivo_id = table.Column<string>(type: "TEXT", nullable: true),
                    regime = table.Column<string>(type: "TEXT", nullable: true),
                    nfe_serie = table.Column<int>(type: "INTEGER", nullable: true),
                    nfce_ambiente = table.Column<short>(type: "INTEGER", nullable: false),
                    tipo_emissao = table.Column<string>(type: "TEXT", nullable: false),
                    certificado_tipo = table.Column<string>(type: "TEXT", nullable: true),
                    nfce_csc_id = table.Column<string>(type: "TEXT", nullable: true),
                    nfce_csc_cifrado = table.Column<byte[]>(type: "BLOB", nullable: true),
                    nfce_csc_homologacao_id = table.Column<string>(type: "TEXT", nullable: true),
                    nfce_csc_homologacao_cifrado = table.Column<byte[]>(type: "BLOB", nullable: true),
                    nfce_qrcode_versao = table.Column<short>(type: "INTEGER", nullable: true),
                    nfce_prazo_cancelamento_min = table.Column<short>(type: "INTEGER", nullable: false),
                    nfce_valor_exige_identificacao = table.Column<long>(type: "INTEGER", nullable: false),
                    sat_codigo_ativacao_cifrado = table.Column<byte[]>(type: "BLOB", nullable: true),
                    tef_provedor = table.Column<string>(type: "TEXT", nullable: true),
                    tef_codigo_loja = table.Column<string>(type: "TEXT", nullable: true),
                    tef_servidor = table.Column<string>(type: "TEXT", nullable: true),
                    tef_token_cifrado = table.Column<byte[]>(type: "BLOB", nullable: true),
                    tef_cnpj_credenciadora = table.Column<string>(type: "TEXT", nullable: true),
                    chave_pix = table.Column<string>(type: "TEXT", nullable: true),
                    pix_nome_recebedor = table.Column<string>(type: "TEXT", nullable: true),
                    pix_cidade_recebedor = table.Column<string>(type: "TEXT", nullable: true),
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
                    table.PrimaryKey("pk_lojas", x => x.id);
                    table.CheckConstraint("ck_lojas_ativa", "ativa in (0,1)");
                    table.CheckConstraint("ck_lojas_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_lojas_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_lojas_usa_menu_digital", "usa_menu_digital in (0,1)");
                    table.CheckConstraint("ck_lojas_usa_pdv", "usa_pdv in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "lojas_banners",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: false),
                    arquivo_id = table.Column<string>(type: "TEXT", nullable: false),
                    titulo = table.Column<string>(type: "TEXT", nullable: true),
                    ordem = table.Column<int>(type: "INTEGER", nullable: false),
                    exibir_em = table.Column<string>(type: "TEXT", nullable: false),
                    inicio = table.Column<string>(type: "TEXT", nullable: true),
                    fim = table.Column<string>(type: "TEXT", nullable: true),
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
                    table.PrimaryKey("pk_lojas_banners", x => x.id);
                    table.CheckConstraint("ck_lojas_banners_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_lojas_banners_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_lojas_banners_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "marcas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    codigo = table.Column<int>(type: "INTEGER", nullable: false),
                    descricao = table.Column<string>(type: "TEXT", nullable: false),
                    sem_marca = table.Column<bool>(type: "INTEGER", nullable: false),
                    exibe_site = table.Column<bool>(type: "INTEGER", nullable: false),
                    ordem = table.Column<int>(type: "INTEGER", nullable: false),
                    logotipo_arquivo_id = table.Column<string>(type: "TEXT", nullable: true),
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
                    table.PrimaryKey("pk_marcas", x => x.id);
                    table.CheckConstraint("ck_marcas_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_marcas_exibe_site", "exibe_site in (0,1)");
                    table.CheckConstraint("ck_marcas_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_marcas_sem_marca", "sem_marca in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "meios_pagamento_fiscais",
                columns: table => new
                {
                    codigo = table.Column<string>(type: "TEXT", nullable: false),
                    descricao = table.Column<string>(type: "TEXT", nullable: false),
                    exige_descricao = table.Column<bool>(type: "INTEGER", nullable: false),
                    ativo = table.Column<bool>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_meios_pagamento_fiscais", x => x.codigo);
                    table.CheckConstraint("ck_meios_pagamento_fiscais_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_meios_pagamento_fiscais_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_meios_pagamento_fiscais_exige_descricao", "exige_descricao in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "municipios",
                columns: table => new
                {
                    codigo_ibge = table.Column<int>(type: "INTEGER", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    uf = table.Column<string>(type: "TEXT", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_municipios", x => x.codigo_ibge);
                    table.CheckConstraint("ck_municipios_criado_localmente", "criado_localmente in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "ncms",
                columns: table => new
                {
                    codigo = table.Column<string>(type: "TEXT", nullable: false),
                    descricao = table.Column<string>(type: "TEXT", nullable: false),
                    vigencia_inicio = table.Column<string>(type: "TEXT", nullable: true),
                    vigencia_fim = table.Column<string>(type: "TEXT", nullable: true),
                    unidade_tributavel = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_ncms", x => x.codigo);
                    table.CheckConstraint("ck_ncms_criado_localmente", "criado_localmente in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "numeracoes_faixas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    numeracao_id = table.Column<string>(type: "TEXT", nullable: false),
                    terminal_id = table.Column<string>(type: "TEXT", nullable: false),
                    inicio = table.Column<long>(type: "INTEGER", nullable: false),
                    fim = table.Column<long>(type: "INTEGER", nullable: false),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    ultimo_usado = table.Column<long>(type: "INTEGER", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_numeracoes_faixas", x => x.id);
                    table.CheckConstraint("ck_numeracoes_faixas_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_numeracoes_faixas_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "paises",
                columns: table => new
                {
                    codigo_bacen = table.Column<string>(type: "TEXT", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_paises", x => x.codigo_bacen);
                    table.CheckConstraint("ck_paises_criado_localmente", "criado_localmente in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "parametros_fiscais_uf",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    uf = table.Column<string>(type: "TEXT", nullable: false),
                    vigencia_inicio = table.Column<string>(type: "TEXT", nullable: false),
                    vigencia_fim = table.Column<string>(type: "TEXT", nullable: true),
                    tipos_emissao_permitidos = table.Column<string>(type: "TEXT", nullable: false),
                    regimes_dispensados_nfce = table.Column<string>(type: "TEXT", nullable: false),
                    autorizador = table.Column<string>(type: "TEXT", nullable: false),
                    versao_leiaute = table.Column<string>(type: "TEXT", nullable: false),
                    webservices = table.Column<string>(type: "TEXT", nullable: true),
                    url_qrcode_producao = table.Column<string>(type: "TEXT", nullable: false),
                    url_qrcode_homologacao = table.Column<string>(type: "TEXT", nullable: false),
                    url_consulta_producao = table.Column<string>(type: "TEXT", nullable: false),
                    url_consulta_homologacao = table.Column<string>(type: "TEXT", nullable: false),
                    qrcode_versoes_aceitas = table.Column<string>(type: "TEXT", nullable: false),
                    qrcode_versao_padrao = table.Column<short>(type: "INTEGER", nullable: false),
                    csc_max_ativos_por_ambiente = table.Column<short>(type: "INTEGER", nullable: true),
                    csc_por_cnpj_base = table.Column<bool>(type: "INTEGER", nullable: false),
                    prazo_cancelamento_min = table.Column<short>(type: "INTEGER", nullable: false),
                    prazo_cancelamento_substituicao_h = table.Column<short>(type: "INTEGER", nullable: false),
                    aceita_cancelamento_extemporaneo = table.Column<bool>(type: "INTEGER", nullable: true),
                    prazo_transmissao_contingencia_h = table.Column<short>(type: "INTEGER", nullable: false),
                    modalidades_contingencia_nfce = table.Column<string>(type: "TEXT", nullable: false),
                    contingencia_vias_danfe = table.Column<short>(type: "INTEGER", nullable: false),
                    inutilizacao_prazo_dia = table.Column<short>(type: "INTEGER", nullable: false),
                    identificacao_obrigatoria_valor = table.Column<long>(type: "INTEGER", nullable: false),
                    identificacao_obrigatoria_nao_presencial = table.Column<bool>(type: "INTEGER", nullable: false),
                    nfce_valor_maximo = table.Column<long>(type: "INTEGER", nullable: true),
                    danfe_modos_permitidos = table.Column<string>(type: "TEXT", nullable: false),
                    danfe_resumido_exige_concordancia = table.Column<bool>(type: "INTEGER", nullable: false),
                    programa_cidadania = table.Column<string>(type: "TEXT", nullable: true),
                    programa_cidadania_substitui_danfe = table.Column<bool>(type: "INTEGER", nullable: true),
                    intervalo_minimo_status_s = table.Column<int>(type: "INTEGER", nullable: true),
                    atraso_max_emissao_min = table.Column<short>(type: "INTEGER", nullable: false),
                    fcp_nome = table.Column<string>(type: "TEXT", nullable: true),
                    exige_st_retido_nfce = table.Column<bool>(type: "INTEGER", nullable: false),
                    exige_vinculacao_pagamento = table.Column<bool>(type: "INTEGER", nullable: false),
                    exige_cbenef = table.Column<bool>(type: "INTEGER", nullable: false),
                    exige_cest_bem_listado = table.Column<bool>(type: "INTEGER", nullable: false),
                    exige_resp_tec = table.Column<bool>(type: "INTEGER", nullable: false),
                    exige_csrt_nfce = table.Column<bool>(type: "INTEGER", nullable: false),
                    conferido_em = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_parametros_fiscais_uf", x => x.id);
                    table.CheckConstraint("ck_parametros_fiscais_uf_aceita_cancelamento_extemporaneo", "aceita_cancelamento_extemporaneo in (0,1)");
                    table.CheckConstraint("ck_parametros_fiscais_uf_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_parametros_fiscais_uf_csc_por_cnpj_base", "csc_por_cnpj_base in (0,1)");
                    table.CheckConstraint("ck_parametros_fiscais_uf_danfe_resumido_exige_concordancia", "danfe_resumido_exige_concordancia in (0,1)");
                    table.CheckConstraint("ck_parametros_fiscais_uf_exige_cbenef", "exige_cbenef in (0,1)");
                    table.CheckConstraint("ck_parametros_fiscais_uf_exige_cest_bem_listado", "exige_cest_bem_listado in (0,1)");
                    table.CheckConstraint("ck_parametros_fiscais_uf_exige_csrt_nfce", "exige_csrt_nfce in (0,1)");
                    table.CheckConstraint("ck_parametros_fiscais_uf_exige_resp_tec", "exige_resp_tec in (0,1)");
                    table.CheckConstraint("ck_parametros_fiscais_uf_exige_st_retido_nfce", "exige_st_retido_nfce in (0,1)");
                    table.CheckConstraint("ck_parametros_fiscais_uf_exige_vinculacao_pagamento", "exige_vinculacao_pagamento in (0,1)");
                    table.CheckConstraint("ck_parametros_fiscais_uf_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_parametros_fiscais_uf_identificacao_obrigatoria_nao_presencial", "identificacao_obrigatoria_nao_presencial in (0,1)");
                    table.CheckConstraint("ck_parametros_fiscais_uf_programa_cidadania_substitui_danfe", "programa_cidadania_substitui_danfe in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "parcelas_credito_pessoas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    pessoa_id = table.Column<string>(type: "TEXT", nullable: false),
                    parcela_financeira_id = table.Column<string>(type: "TEXT", nullable: false),
                    documento = table.Column<string>(type: "TEXT", nullable: false),
                    numero = table.Column<short>(type: "INTEGER", nullable: false),
                    vencimento = table.Column<string>(type: "TEXT", nullable: false),
                    valor = table.Column<long>(type: "INTEGER", nullable: false),
                    saldo = table.Column<long>(type: "INTEGER", nullable: false),
                    dias_atraso = table.Column<int>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_parcelas_credito_pessoas", x => x.id);
                    table.CheckConstraint("ck_parcelas_credito_pessoas_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_parcelas_credito_pessoas_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "perfis",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    descricao = table.Column<string>(type: "TEXT", nullable: true),
                    chave_sistema = table.Column<string>(type: "TEXT", nullable: true),
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
                    table.PrimaryKey("pk_perfis", x => x.id);
                    table.CheckConstraint("ck_perfis_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_perfis_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "perfis_permissoes",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    perfil_id = table.Column<string>(type: "TEXT", nullable: false),
                    permissao = table.Column<string>(type: "TEXT", nullable: false),
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
                    table.PrimaryKey("pk_perfis_permissoes", x => x.id);
                    table.CheckConstraint("ck_perfis_permissoes_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_perfis_permissoes_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "permissoes",
                columns: table => new
                {
                    chave = table.Column<string>(type: "TEXT", nullable: false),
                    modulo = table.Column<string>(type: "TEXT", nullable: false),
                    grupo = table.Column<string>(type: "TEXT", nullable: false),
                    descricao = table.Column<string>(type: "TEXT", nullable: false),
                    ordem = table.Column<int>(type: "INTEGER", nullable: false),
                    permite_liberacao = table.Column<bool>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_permissoes", x => x.chave);
                    table.CheckConstraint("ck_permissoes_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_permissoes_permite_liberacao", "permite_liberacao in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "pessoas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    codigo = table.Column<int>(type: "INTEGER", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    apelido = table.Column<string>(type: "TEXT", nullable: true),
                    ativa = table.Column<bool>(type: "INTEGER", nullable: false),
                    cpf_cnpj = table.Column<string>(type: "TEXT", nullable: true),
                    rg_ie = table.Column<string>(type: "TEXT", nullable: true),
                    indicador_ie = table.Column<string>(type: "TEXT", nullable: false),
                    nascimento = table.Column<string>(type: "TEXT", nullable: true),
                    sexo = table.Column<string>(type: "TEXT", nullable: false),
                    senha_hash = table.Column<string>(type: "TEXT", nullable: true),
                    limite_compras = table.Column<long>(type: "INTEGER", nullable: true),
                    desconto_pct = table.Column<long>(type: "INTEGER", nullable: false),
                    bloqueada_credito = table.Column<bool>(type: "INTEGER", nullable: false),
                    observacao_pdv = table.Column<string>(type: "TEXT", nullable: true),
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
                    table.PrimaryKey("pk_pessoas", x => x.id);
                    table.CheckConstraint("ck_pessoas_ativa", "ativa in (0,1)");
                    table.CheckConstraint("ck_pessoas_bloqueada_credito", "bloqueada_credito in (0,1)");
                    table.CheckConstraint("ck_pessoas_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_pessoas_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "pessoas_aliases",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    alias_id = table.Column<string>(type: "TEXT", nullable: false),
                    pessoa_id = table.Column<string>(type: "TEXT", nullable: false),
                    terminal_id = table.Column<string>(type: "TEXT", nullable: true),
                    motivo = table.Column<string>(type: "TEXT", nullable: false),
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
                    table.PrimaryKey("pk_pessoas_aliases", x => x.id);
                    table.CheckConstraint("ck_pessoas_aliases_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_pessoas_aliases_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "pessoas_categorias",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    pessoa_id = table.Column<string>(type: "TEXT", nullable: false),
                    categoria = table.Column<string>(type: "TEXT", nullable: false),
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
                    table.PrimaryKey("pk_pessoas_categorias", x => x.id);
                    table.CheckConstraint("ck_pessoas_categorias_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_pessoas_categorias_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "pessoas_enderecos",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    pessoa_id = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    cep = table.Column<string>(type: "TEXT", nullable: true),
                    logradouro = table.Column<string>(type: "TEXT", nullable: true),
                    numero = table.Column<string>(type: "TEXT", nullable: true),
                    complemento = table.Column<string>(type: "TEXT", nullable: true),
                    bairro = table.Column<string>(type: "TEXT", nullable: true),
                    uf = table.Column<string>(type: "TEXT", nullable: true),
                    municipio_ibge = table.Column<int>(type: "INTEGER", nullable: true),
                    exterior = table.Column<bool>(type: "INTEGER", nullable: false),
                    pais_codigo = table.Column<string>(type: "TEXT", nullable: true),
                    cidade_exterior = table.Column<string>(type: "TEXT", nullable: true),
                    referencia = table.Column<string>(type: "TEXT", nullable: true),
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
                    table.PrimaryKey("pk_pessoas_enderecos", x => x.id);
                    table.CheckConstraint("ck_pessoas_enderecos_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_pessoas_enderecos_exterior", "exterior in (0,1)");
                    table.CheckConstraint("ck_pessoas_enderecos_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "pessoas_relevancia_loja",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    pessoa_id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: true),
                    motivo = table.Column<string>(type: "TEXT", nullable: false),
                    ultima_ocorrencia_em = table.Column<string>(type: "TEXT", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_pessoas_relevancia_loja", x => x.id);
                    table.CheckConstraint("ck_pessoas_relevancia_loja_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_pessoas_relevancia_loja_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "pessoas_telefones",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    pessoa_id = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    ddd = table.Column<string>(type: "TEXT", nullable: false),
                    numero = table.Column<string>(type: "TEXT", nullable: false),
                    contato = table.Column<string>(type: "TEXT", nullable: true),
                    principal = table.Column<bool>(type: "INTEGER", nullable: false),
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
                    table.PrimaryKey("pk_pessoas_telefones", x => x.id);
                    table.CheckConstraint("ck_pessoas_telefones_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_pessoas_telefones_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_pessoas_telefones_principal", "principal in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "produtos_categorias",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    categoria_id = table.Column<string>(type: "TEXT", nullable: false),
                    principal = table.Column<bool>(type: "INTEGER", nullable: false),
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
                    table.PrimaryKey("pk_produtos_categorias", x => x.id);
                    table.CheckConstraint("ck_produtos_categorias_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_produtos_categorias_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_produtos_categorias_principal", "principal in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "produtos_lotes",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    variacao_id = table.Column<string>(type: "TEXT", nullable: true),
                    estoque_id = table.Column<string>(type: "TEXT", nullable: true),
                    lote = table.Column<string>(type: "TEXT", nullable: false),
                    validade = table.Column<string>(type: "TEXT", nullable: true),
                    fabricacao = table.Column<string>(type: "TEXT", nullable: true),
                    fornecedor_id = table.Column<string>(type: "TEXT", nullable: true),
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
                    table.PrimaryKey("pk_produtos_lotes", x => x.id);
                    table.CheckConstraint("ck_produtos_lotes_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_produtos_lotes_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_produtos_lotes_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "produtos_relacionados",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    relacionado_id = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
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
                    table.PrimaryKey("pk_produtos_relacionados", x => x.id);
                    table.CheckConstraint("ck_produtos_relacionados_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_produtos_relacionados_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "produtos_tributacao_uf",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    uf = table.Column<string>(type: "TEXT", nullable: false),
                    cfop_venda_estado = table.Column<string>(type: "TEXT", nullable: true),
                    icms_situacao = table.Column<string>(type: "TEXT", nullable: true),
                    icms_modalidade_bc = table.Column<string>(type: "TEXT", nullable: true),
                    icms_aliquota = table.Column<long>(type: "INTEGER", nullable: true),
                    icms_reducao_bc_pct = table.Column<long>(type: "INTEGER", nullable: true),
                    icms_modalidade_bcst = table.Column<string>(type: "TEXT", nullable: true),
                    icms_mva_pct = table.Column<long>(type: "INTEGER", nullable: true),
                    icms_aliquota_st = table.Column<long>(type: "INTEGER", nullable: true),
                    fcp_aliquota = table.Column<long>(type: "INTEGER", nullable: true),
                    fcp_st_aliquota = table.Column<long>(type: "INTEGER", nullable: true),
                    beneficio_fiscal_codigo = table.Column<string>(type: "TEXT", nullable: true),
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
                    table.PrimaryKey("pk_produtos_tributacao_uf", x => x.id);
                    table.CheckConstraint("ck_produtos_tributacao_uf_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_produtos_tributacao_uf_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "produtos_variacoes",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    codigo_interno = table.Column<string>(type: "TEXT", nullable: true),
                    preco_venda = table.Column<long>(type: "INTEGER", nullable: true),
                    ativo = table.Column<bool>(type: "INTEGER", nullable: false),
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
                    table.PrimaryKey("pk_produtos_variacoes", x => x.id);
                    table.CheckConstraint("ck_produtos_variacoes_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_produtos_variacoes_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_produtos_variacoes_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "produtos_variacoes_valores",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    variacao_id = table.Column<string>(type: "TEXT", nullable: false),
                    atributo_valor_id = table.Column<string>(type: "TEXT", nullable: false),
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
                    table.PrimaryKey("pk_produtos_variacoes_valores", x => x.id);
                    table.CheckConstraint("ck_produtos_variacoes_valores_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_produtos_variacoes_valores_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "saldos_credito_pessoas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    pessoa_id = table.Column<string>(type: "TEXT", nullable: false),
                    limite = table.Column<long>(type: "INTEGER", nullable: false),
                    saldo_aberto = table.Column<long>(type: "INTEGER", nullable: false),
                    saldo_vencido = table.Column<long>(type: "INTEGER", nullable: false),
                    maior_atraso_dias = table.Column<int>(type: "INTEGER", nullable: false),
                    parcelas_abertas = table.Column<int>(type: "INTEGER", nullable: false),
                    calculado_em = table.Column<string>(type: "TEXT", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_saldos_credito_pessoas", x => x.id);
                    table.CheckConstraint("ck_saldos_credito_pessoas_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_saldos_credito_pessoas_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "saldos_estoque",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    estoque_id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    variacao_id = table.Column<string>(type: "TEXT", nullable: true),
                    tipo_estoque_id = table.Column<string>(type: "TEXT", nullable: false),
                    quantidade = table.Column<long>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_saldos_estoque", x => x.id);
                    table.CheckConstraint("ck_saldos_estoque_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_saldos_estoque_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "saldos_lote",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    estoque_id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    variacao_id = table.Column<string>(type: "TEXT", nullable: true),
                    lote_id = table.Column<string>(type: "TEXT", nullable: false),
                    tipo_estoque_id = table.Column<string>(type: "TEXT", nullable: false),
                    quantidade = table.Column<long>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_saldos_lote", x => x.id);
                    table.CheckConstraint("ck_saldos_lote_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_saldos_lote_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "saldos_vasilhame_pessoas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    pessoa_id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_vasilhame_id = table.Column<string>(type: "TEXT", nullable: false),
                    quantidade = table.Column<long>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_saldos_vasilhame_pessoas", x => x.id);
                    table.CheckConstraint("ck_saldos_vasilhame_pessoas_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_saldos_vasilhame_pessoas_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "taxas_entrega",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: false),
                    bairro = table.Column<string>(type: "TEXT", nullable: false),
                    municipio_ibge = table.Column<int>(type: "INTEGER", nullable: false),
                    valor = table.Column<long>(type: "INTEGER", nullable: false),
                    tempo_estimado_min = table.Column<short>(type: "INTEGER", nullable: true),
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
                    table.PrimaryKey("pk_taxas_entrega", x => x.id);
                    table.CheckConstraint("ck_taxas_entrega_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_taxas_entrega_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_taxas_entrega_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "templates_documentos",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    descricao = table.Column<string>(type: "TEXT", nullable: true),
                    assunto = table.Column<string>(type: "TEXT", nullable: true),
                    formato = table.Column<string>(type: "TEXT", nullable: false),
                    conteudo = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: true),
                    padrao = table.Column<bool>(type: "INTEGER", nullable: false),
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
                    table.PrimaryKey("pk_templates_documentos", x => x.id);
                    table.CheckConstraint("ck_templates_documentos_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_templates_documentos_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_templates_documentos_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_templates_documentos_padrao", "padrao in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "tipos_estoque",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    vendavel = table.Column<bool>(type: "INTEGER", nullable: false),
                    padrao = table.Column<bool>(type: "INTEGER", nullable: false),
                    ativo = table.Column<bool>(type: "INTEGER", nullable: false),
                    chave_sistema = table.Column<string>(type: "TEXT", nullable: true),
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
                    table.PrimaryKey("pk_tipos_estoque", x => x.id);
                    table.CheckConstraint("ck_tipos_estoque_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_tipos_estoque_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_tipos_estoque_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_tipos_estoque_padrao", "padrao in (0,1)");
                    table.CheckConstraint("ck_tipos_estoque_vendavel", "vendavel in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "ufs",
                columns: table => new
                {
                    sigla = table.Column<string>(type: "TEXT", nullable: false),
                    codigo_ibge = table.Column<short>(type: "INTEGER", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_ufs", x => x.sigla);
                    table.CheckConstraint("ck_ufs_criado_localmente", "criado_localmente in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "usuarios",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    codigo = table.Column<int>(type: "INTEGER", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    login = table.Column<string>(type: "TEXT", nullable: false),
                    senha_alterada_em = table.Column<string>(type: "TEXT", nullable: true),
                    senha_pdv_hash = table.Column<string>(type: "TEXT", nullable: true),
                    ativo = table.Column<bool>(type: "INTEGER", nullable: false),
                    perfil_id = table.Column<string>(type: "TEXT", nullable: true),
                    master = table.Column<bool>(type: "INTEGER", nullable: false),
                    limite_desconto_pct = table.Column<long>(type: "INTEGER", nullable: false),
                    comissao_pct = table.Column<long>(type: "INTEGER", nullable: false),
                    vendedor = table.Column<bool>(type: "INTEGER", nullable: false),
                    entregador = table.Column<bool>(type: "INTEGER", nullable: false),
                    tecnico = table.Column<bool>(type: "INTEGER", nullable: false),
                    pdv_utilitario = table.Column<bool>(type: "INTEGER", nullable: false),
                    comanda_eletronica = table.Column<bool>(type: "INTEGER", nullable: false),
                    totem = table.Column<bool>(type: "INTEGER", nullable: false),
                    pessoa_id = table.Column<string>(type: "TEXT", nullable: true),
                    permissoes_versao = table.Column<int>(type: "INTEGER", nullable: false),
                    ultimo_login_em = table.Column<string>(type: "TEXT", nullable: true),
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
                    table.PrimaryKey("pk_usuarios", x => x.id);
                    table.CheckConstraint("ck_usuarios_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_usuarios_comanda_eletronica", "comanda_eletronica in (0,1)");
                    table.CheckConstraint("ck_usuarios_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_usuarios_entregador", "entregador in (0,1)");
                    table.CheckConstraint("ck_usuarios_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_usuarios_master", "master in (0,1)");
                    table.CheckConstraint("ck_usuarios_pdv_utilitario", "pdv_utilitario in (0,1)");
                    table.CheckConstraint("ck_usuarios_tecnico", "tecnico in (0,1)");
                    table.CheckConstraint("ck_usuarios_totem", "totem in (0,1)");
                    table.CheckConstraint("ck_usuarios_vendedor", "vendedor in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "usuarios_lojas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    usuario_id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: false),
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
                    table.PrimaryKey("pk_usuarios_lojas", x => x.id);
                    table.CheckConstraint("ck_usuarios_lojas_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_usuarios_lojas_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "usuarios_permissoes",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    usuario_id = table.Column<string>(type: "TEXT", nullable: false),
                    permissao = table.Column<string>(type: "TEXT", nullable: false),
                    efeito = table.Column<string>(type: "TEXT", nullable: false),
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
                    table.PrimaryKey("pk_usuarios_permissoes", x => x.id);
                    table.CheckConstraint("ck_usuarios_permissoes_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_usuarios_permissoes_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateIndex(
                name: "ix_parcelas_credito_pessoas_pessoa_id",
                table: "parcelas_credito_pessoas",
                column: "pessoa_id");

            migrationBuilder.CreateIndex(
                name: "ix_perfis_permissoes_perfil_id",
                table: "perfis_permissoes",
                column: "perfil_id");

            migrationBuilder.CreateIndex(
                name: "ix_pessoas_categorias_pessoa_id",
                table: "pessoas_categorias",
                column: "pessoa_id");

            migrationBuilder.CreateIndex(
                name: "ix_pessoas_enderecos_pessoa_id",
                table: "pessoas_enderecos",
                column: "pessoa_id");

            migrationBuilder.CreateIndex(
                name: "ix_pessoas_relevancia_loja_pessoa_id",
                table: "pessoas_relevancia_loja",
                column: "pessoa_id");

            migrationBuilder.CreateIndex(
                name: "ix_pessoas_telefones_pessoa_id",
                table: "pessoas_telefones",
                column: "pessoa_id");

            migrationBuilder.CreateIndex(
                name: "ix_saldos_credito_pessoas_pessoa_id",
                table: "saldos_credito_pessoas",
                column: "pessoa_id");

            migrationBuilder.CreateIndex(
                name: "ix_saldos_estoque_produto_id",
                table: "saldos_estoque",
                column: "produto_id");

            migrationBuilder.CreateIndex(
                name: "ix_saldos_vasilhame_pessoas_pessoa_id",
                table: "saldos_vasilhame_pessoas",
                column: "pessoa_id");

            migrationBuilder.CreateIndex(
                name: "ix_usuarios_codigo",
                table: "usuarios",
                column: "codigo");

            migrationBuilder.CreateIndex(
                name: "ix_usuarios_login",
                table: "usuarios",
                column: "login");

            migrationBuilder.CreateIndex(
                name: "ix_usuarios_lojas_usuario_id",
                table: "usuarios_lojas",
                column: "usuario_id");

            migrationBuilder.CreateIndex(
                name: "ix_usuarios_permissoes_usuario_id",
                table: "usuarios_permissoes",
                column: "usuario_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "atalhos_pdv");

            migrationBuilder.DropTable(
                name: "atributos_variacao");

            migrationBuilder.DropTable(
                name: "atributos_variacao_valores");

            migrationBuilder.DropTable(
                name: "bloqueios_senha_local");

            migrationBuilder.DropTable(
                name: "caixas");

            migrationBuilder.DropTable(
                name: "categorias");

            migrationBuilder.DropTable(
                name: "certificados_digitais");

            migrationBuilder.DropTable(
                name: "cfops");

            migrationBuilder.DropTable(
                name: "cfops_grupos");

            migrationBuilder.DropTable(
                name: "comandos_recebidos");

            migrationBuilder.DropTable(
                name: "empresa");

            migrationBuilder.DropTable(
                name: "estoques");

            migrationBuilder.DropTable(
                name: "impressoras_destino");

            migrationBuilder.DropTable(
                name: "lojas");

            migrationBuilder.DropTable(
                name: "lojas_banners");

            migrationBuilder.DropTable(
                name: "marcas");

            migrationBuilder.DropTable(
                name: "meios_pagamento_fiscais");

            migrationBuilder.DropTable(
                name: "municipios");

            migrationBuilder.DropTable(
                name: "ncms");

            migrationBuilder.DropTable(
                name: "numeracoes_faixas");

            migrationBuilder.DropTable(
                name: "paises");

            migrationBuilder.DropTable(
                name: "parametros_fiscais_uf");

            migrationBuilder.DropTable(
                name: "parcelas_credito_pessoas");

            migrationBuilder.DropTable(
                name: "perfis");

            migrationBuilder.DropTable(
                name: "perfis_permissoes");

            migrationBuilder.DropTable(
                name: "permissoes");

            migrationBuilder.DropTable(
                name: "pessoas");

            migrationBuilder.DropTable(
                name: "pessoas_aliases");

            migrationBuilder.DropTable(
                name: "pessoas_categorias");

            migrationBuilder.DropTable(
                name: "pessoas_enderecos");

            migrationBuilder.DropTable(
                name: "pessoas_relevancia_loja");

            migrationBuilder.DropTable(
                name: "pessoas_telefones");

            migrationBuilder.DropTable(
                name: "produtos_categorias");

            migrationBuilder.DropTable(
                name: "produtos_lotes");

            migrationBuilder.DropTable(
                name: "produtos_relacionados");

            migrationBuilder.DropTable(
                name: "produtos_tributacao_uf");

            migrationBuilder.DropTable(
                name: "produtos_variacoes");

            migrationBuilder.DropTable(
                name: "produtos_variacoes_valores");

            migrationBuilder.DropTable(
                name: "saldos_credito_pessoas");

            migrationBuilder.DropTable(
                name: "saldos_estoque");

            migrationBuilder.DropTable(
                name: "saldos_lote");

            migrationBuilder.DropTable(
                name: "saldos_vasilhame_pessoas");

            migrationBuilder.DropTable(
                name: "taxas_entrega");

            migrationBuilder.DropTable(
                name: "templates_documentos");

            migrationBuilder.DropTable(
                name: "tipos_estoque");

            migrationBuilder.DropTable(
                name: "ufs");

            migrationBuilder.DropTable(
                name: "usuarios");

            migrationBuilder.DropTable(
                name: "usuarios_lojas");

            migrationBuilder.DropTable(
                name: "usuarios_permissoes");
        }
    }
}
