using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GenesisPDV.Data.Migracoes
{
    /// <inheritdoc />
    public partial class CatalogoPrecosCombo : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "grupo_preco_quantidade_id",
                table: "itens_venda",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "kit_acrescimo",
                table: "itens_venda",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<string>(
                name: "kit_alternativa_id",
                table: "itens_venda",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "kit_componente_id",
                table: "itens_venda",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "kit_descricao",
                table: "itens_venda",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "kit_preco_unitario",
                table: "itens_venda",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "kit_quantidade",
                table: "itens_venda",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "quantidade_referencia_preco",
                table: "itens_venda",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "v_fcp",
                table: "itens_venda",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "v_fcp_st_ret",
                table: "itens_venda",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "v_icms_st_ret",
                table: "itens_venda",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "formas_pagamento",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    descricao = table.Column<string>(type: "TEXT", nullable: false),
                    ordem = table.Column<int>(type: "INTEGER", nullable: false),
                    tipo_forma = table.Column<string>(type: "TEXT", nullable: false),
                    meio_pagamento_fiscal = table.Column<string>(type: "TEXT", nullable: false),
                    descricao_fiscal = table.Column<string>(type: "TEXT", nullable: true),
                    integracao = table.Column<string>(type: "TEXT", nullable: false),
                    tipo_pinpad = table.Column<string>(type: "TEXT", nullable: true),
                    loja_id = table.Column<string>(type: "TEXT", nullable: true),
                    taxa_pct = table.Column<long>(type: "INTEGER", nullable: false),
                    senha_liberacao_hash = table.Column<string>(type: "TEXT", nullable: true),
                    sempre_zerado_pdv = table.Column<bool>(type: "INTEGER", nullable: false),
                    lanca_quitada = table.Column<bool>(type: "INTEGER", nullable: false),
                    permite_troco = table.Column<bool>(type: "INTEGER", nullable: false),
                    e_boleto = table.Column<bool>(type: "INTEGER", nullable: false),
                    exige_pessoa = table.Column<bool>(type: "INTEGER", nullable: false),
                    ativa = table.Column<bool>(type: "INTEGER", nullable: false),
                    abrir_gaveta = table.Column<bool>(type: "INTEGER", nullable: false),
                    usa_pdv = table.Column<bool>(type: "INTEGER", nullable: false),
                    usa_totem = table.Column<bool>(type: "INTEGER", nullable: false),
                    usa_menu_digital = table.Column<bool>(type: "INTEGER", nullable: false),
                    credito_funcionario = table.Column<bool>(type: "INTEGER", nullable: false),
                    permite_parcelar = table.Column<bool>(type: "INTEGER", nullable: false),
                    parcelas_maximo = table.Column<short>(type: "INTEGER", nullable: false),
                    parcela_valor_minimo = table.Column<long>(type: "INTEGER", nullable: true),
                    gera_qrcode_pix = table.Column<bool>(type: "INTEGER", nullable: false),
                    a_prazo = table.Column<bool>(type: "INTEGER", nullable: false),
                    vale_compra = table.Column<bool>(type: "INTEGER", nullable: false),
                    exige_dados_pos = table.Column<bool>(type: "INTEGER", nullable: false),
                    restringe_idade_minima = table.Column<bool>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_formas_pagamento", x => x.id);
                    table.CheckConstraint("ck_formas_pagamento_a_prazo", "a_prazo in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_abrir_gaveta", "abrir_gaveta in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_ativa", "ativa in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_credito_funcionario", "credito_funcionario in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_e_boleto", "e_boleto in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_exige_dados_pos", "exige_dados_pos in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_exige_pessoa", "exige_pessoa in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_gera_qrcode_pix", "gera_qrcode_pix in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_formas_pagamento_lanca_quitada", "lanca_quitada in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_permite_parcelar", "permite_parcelar in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_permite_troco", "permite_troco in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_restringe_idade_minima", "restringe_idade_minima in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_sempre_zerado_pdv", "sempre_zerado_pdv in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_usa_menu_digital", "usa_menu_digital in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_usa_pdv", "usa_pdv in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_usa_totem", "usa_totem in (0,1)");
                    table.CheckConstraint("ck_formas_pagamento_vale_compra", "vale_compra in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "grupos_preco_quantidade",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    codigo = table.Column<int>(type: "INTEGER", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    modo_preco = table.Column<string>(type: "TEXT", nullable: false),
                    ativo = table.Column<bool>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_grupos_preco_quantidade", x => x.id);
                    table.CheckConstraint("ck_grupos_preco_quantidade_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_grupos_preco_quantidade_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_grupos_preco_quantidade_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "grupos_preco_quantidade_faixas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    grupo_id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: true),
                    quantidade_inicial = table.Column<long>(type: "INTEGER", nullable: false),
                    quantidade_final = table.Column<long>(type: "INTEGER", nullable: true),
                    preco = table.Column<long>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_grupos_preco_quantidade_faixas", x => x.id);
                    table.CheckConstraint("ck_grupos_preco_quantidade_faixas_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_grupos_preco_quantidade_faixas_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "produtos",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    codigo = table.Column<int>(type: "INTEGER", nullable: false),
                    nome = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    ativo = table.Column<bool>(type: "INTEGER", nullable: false),
                    codigo_interno = table.Column<string>(type: "TEXT", nullable: true),
                    unidade_id = table.Column<string>(type: "TEXT", nullable: false),
                    unidade_tributavel_id = table.Column<string>(type: "TEXT", nullable: true),
                    fator_tributavel = table.Column<long>(type: "INTEGER", nullable: true),
                    permite_fracao = table.Column<bool>(type: "INTEGER", nullable: false),
                    ncm = table.Column<string>(type: "TEXT", nullable: true),
                    cest = table.Column<string>(type: "TEXT", nullable: true),
                    preco_venda = table.Column<long>(type: "INTEGER", nullable: false),
                    preco_atacado = table.Column<long>(type: "INTEGER", nullable: true),
                    qtd_minima_atacado = table.Column<long>(type: "INTEGER", nullable: true),
                    preco_promocional = table.Column<long>(type: "INTEGER", nullable: true),
                    promocao_inicio = table.Column<string>(type: "TEXT", nullable: true),
                    promocao_fim = table.Column<string>(type: "TEXT", nullable: true),
                    preco_parcelado = table.Column<long>(type: "INTEGER", nullable: true),
                    grupo_preco_quantidade_id = table.Column<string>(type: "TEXT", nullable: true),
                    usa_ficha_tecnica = table.Column<bool>(type: "INTEGER", nullable: false),
                    peso_g = table.Column<long>(type: "INTEGER", nullable: true),
                    peso_abatimento_g = table.Column<long>(type: "INTEGER", nullable: true),
                    peso_pacote_kg = table.Column<long>(type: "INTEGER", nullable: true),
                    localizacao = table.Column<string>(type: "TEXT", nullable: true),
                    impressora_destino_id = table.Column<string>(type: "TEXT", nullable: true),
                    qtd_minima_venda = table.Column<long>(type: "INTEGER", nullable: true),
                    comissao_pct = table.Column<long>(type: "INTEGER", nullable: true),
                    marca_id = table.Column<string>(type: "TEXT", nullable: true),
                    categoria_principal_id = table.Column<string>(type: "TEXT", nullable: true),
                    solicita_preco_pdv = table.Column<bool>(type: "INTEGER", nullable: false),
                    solicita_lote_pdv = table.Column<bool>(type: "INTEGER", nullable: false),
                    generico = table.Column<bool>(type: "INTEGER", nullable: false),
                    usa_menu_digital = table.Column<bool>(type: "INTEGER", nullable: false),
                    insumo = table.Column<bool>(type: "INTEGER", nullable: false),
                    usa_totem = table.Column<bool>(type: "INTEGER", nullable: false),
                    mais_vendido = table.Column<bool>(type: "INTEGER", nullable: false),
                    descricao_curta = table.Column<string>(type: "TEXT", nullable: true),
                    foto_principal_arquivo_id = table.Column<string>(type: "TEXT", nullable: true),
                    controla_estoque = table.Column<bool>(type: "INTEGER", nullable: false),
                    idade_minima = table.Column<short>(type: "INTEGER", nullable: true),
                    vasilhame_produto_id = table.Column<string>(type: "TEXT", nullable: true),
                    vasilhame_quantidade = table.Column<short>(type: "INTEGER", nullable: true),
                    balanca_tipo = table.Column<string>(type: "TEXT", nullable: false),
                    balanca_plu = table.Column<int>(type: "INTEGER", nullable: true),
                    balanca_validade_dias = table.Column<short>(type: "INTEGER", nullable: true),
                    cfop_venda_estado = table.Column<string>(type: "TEXT", nullable: true),
                    cfop_venda_fora_estado = table.Column<string>(type: "TEXT", nullable: true),
                    icms_situacao = table.Column<string>(type: "TEXT", nullable: true),
                    icms_origem = table.Column<string>(type: "TEXT", nullable: true),
                    icms_modalidade_bc = table.Column<string>(type: "TEXT", nullable: true),
                    icms_modalidade_bcst = table.Column<string>(type: "TEXT", nullable: true),
                    icms_aliquota = table.Column<long>(type: "INTEGER", nullable: true),
                    icms_reducao_bc_pct = table.Column<long>(type: "INTEGER", nullable: true),
                    icms_mva_pct = table.Column<long>(type: "INTEGER", nullable: true),
                    icms_aliquota_st = table.Column<long>(type: "INTEGER", nullable: true),
                    fcp_aliquota = table.Column<long>(type: "INTEGER", nullable: true),
                    fcp_st_aliquota = table.Column<long>(type: "INTEGER", nullable: true),
                    beneficio_fiscal_codigo = table.Column<string>(type: "TEXT", nullable: true),
                    pis_situacao = table.Column<string>(type: "TEXT", nullable: true),
                    cofins_situacao = table.Column<string>(type: "TEXT", nullable: true),
                    ipi_situacao = table.Column<string>(type: "TEXT", nullable: true),
                    pis_aliquota = table.Column<long>(type: "INTEGER", nullable: true),
                    cofins_aliquota = table.Column<long>(type: "INTEGER", nullable: true),
                    ipi_aliquota = table.Column<long>(type: "INTEGER", nullable: true),
                    ipi_enquadramento = table.Column<string>(type: "TEXT", nullable: true),
                    ibs_cbs_cst = table.Column<string>(type: "TEXT", nullable: true),
                    ibs_cbs_classificacao = table.Column<string>(type: "TEXT", nullable: true),
                    is_cst = table.Column<string>(type: "TEXT", nullable: true),
                    is_classificacao = table.Column<string>(type: "TEXT", nullable: true),
                    is_aliquota_pct = table.Column<long>(type: "INTEGER", nullable: true),
                    is_aliquota_especifica = table.Column<long>(type: "INTEGER", nullable: true),
                    is_unidade = table.Column<string>(type: "TEXT", nullable: true),
                    servico_codigo_lc116 = table.Column<string>(type: "TEXT", nullable: true),
                    foto_url = table.Column<string>(type: "TEXT", nullable: true),
                    foto_sha256 = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_produtos", x => x.id);
                    table.CheckConstraint("ck_produtos_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_produtos_controla_estoque", "controla_estoque in (0,1)");
                    table.CheckConstraint("ck_produtos_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_produtos_generico", "generico in (0,1)");
                    table.CheckConstraint("ck_produtos_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_produtos_insumo", "insumo in (0,1)");
                    table.CheckConstraint("ck_produtos_mais_vendido", "mais_vendido in (0,1)");
                    table.CheckConstraint("ck_produtos_permite_fracao", "permite_fracao in (0,1)");
                    table.CheckConstraint("ck_produtos_solicita_lote_pdv", "solicita_lote_pdv in (0,1)");
                    table.CheckConstraint("ck_produtos_solicita_preco_pdv", "solicita_preco_pdv in (0,1)");
                    table.CheckConstraint("ck_produtos_usa_ficha_tecnica", "usa_ficha_tecnica in (0,1)");
                    table.CheckConstraint("ck_produtos_usa_menu_digital", "usa_menu_digital in (0,1)");
                    table.CheckConstraint("ck_produtos_usa_totem", "usa_totem in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "produtos_codigos_barras",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    variacao_id = table.Column<string>(type: "TEXT", nullable: true),
                    codigo = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    principal = table.Column<bool>(type: "INTEGER", nullable: false),
                    descricao = table.Column<string>(type: "TEXT", nullable: true),
                    unidade_id = table.Column<string>(type: "TEXT", nullable: true),
                    fator = table.Column<long>(type: "INTEGER", nullable: false),
                    preco = table.Column<long>(type: "INTEGER", nullable: true),
                    usa_venda = table.Column<bool>(type: "INTEGER", nullable: false),
                    usa_compra = table.Column<bool>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_produtos_codigos_barras", x => x.id);
                    table.CheckConstraint("ck_produtos_codigos_barras_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_produtos_codigos_barras_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_produtos_codigos_barras_principal", "principal in (0,1)");
                    table.CheckConstraint("ck_produtos_codigos_barras_usa_compra", "usa_compra in (0,1)");
                    table.CheckConstraint("ck_produtos_codigos_barras_usa_venda", "usa_venda in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "produtos_componentes",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    tipo = table.Column<string>(type: "TEXT", nullable: false),
                    componente_id = table.Column<string>(type: "TEXT", nullable: false),
                    componente_variacao_id = table.Column<string>(type: "TEXT", nullable: true),
                    quantidade = table.Column<long>(type: "INTEGER", nullable: false),
                    perda_pct = table.Column<long>(type: "INTEGER", nullable: false),
                    rotulo_posicao = table.Column<string>(type: "TEXT", nullable: true),
                    permite_substituicao = table.Column<bool>(type: "INTEGER", nullable: false),
                    ordem = table.Column<int>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_produtos_componentes", x => x.id);
                    table.CheckConstraint("ck_produtos_componentes_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_produtos_componentes_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_produtos_componentes_permite_substituicao", "permite_substituicao in (0,1)");
                });

            migrationBuilder.CreateTable(
                name: "produtos_componentes_alternativas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    componente_id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    variacao_id = table.Column<string>(type: "TEXT", nullable: true),
                    acrescimo = table.Column<long>(type: "INTEGER", nullable: false),
                    ordem = table.Column<int>(type: "INTEGER", nullable: false),
                    ativo = table.Column<bool>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_produtos_componentes_alternativas", x => x.id);
                    table.CheckConstraint("ck_produtos_componentes_alternativas_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_produtos_componentes_alternativas_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_produtos_componentes_alternativas_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "produtos_lojas",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: false),
                    estoque_minimo = table.Column<long>(type: "INTEGER", nullable: true),
                    preco_venda = table.Column<long>(type: "INTEGER", nullable: true),
                    acrescimo_gelada = table.Column<long>(type: "INTEGER", nullable: true),
                    ativo_na_loja = table.Column<bool>(type: "INTEGER", nullable: false),
                    st_bc_retido_unitario = table.Column<long>(type: "INTEGER", nullable: true),
                    st_aliquota_pct = table.Column<long>(type: "INTEGER", nullable: true),
                    st_icms_substituto_unitario = table.Column<long>(type: "INTEGER", nullable: true),
                    st_icms_retido_unitario = table.Column<long>(type: "INTEGER", nullable: true),
                    fcp_st_bc_retido_unitario = table.Column<long>(type: "INTEGER", nullable: true),
                    fcp_st_aliquota_pct = table.Column<long>(type: "INTEGER", nullable: true),
                    fcp_st_retido_unitario = table.Column<long>(type: "INTEGER", nullable: true),
                    st_atualizado_em = table.Column<string>(type: "TEXT", nullable: true),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_produtos_lojas", x => x.id);
                    table.CheckConstraint("ck_produtos_lojas_ativo_na_loja", "ativo_na_loja in (0,1)");
                    table.CheckConstraint("ck_produtos_lojas_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_produtos_lojas_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "produtos_precos_quantidade",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    produto_id = table.Column<string>(type: "TEXT", nullable: false),
                    variacao_id = table.Column<string>(type: "TEXT", nullable: true),
                    loja_id = table.Column<string>(type: "TEXT", nullable: true),
                    quantidade_inicial = table.Column<long>(type: "INTEGER", nullable: false),
                    quantidade_final = table.Column<long>(type: "INTEGER", nullable: true),
                    preco = table.Column<long>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_produtos_precos_quantidade", x => x.id);
                    table.CheckConstraint("ck_produtos_precos_quantidade_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_produtos_precos_quantidade_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "restricoes_horario_venda",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    loja_id = table.Column<string>(type: "TEXT", nullable: true),
                    categoria_id = table.Column<string>(type: "TEXT", nullable: true),
                    idade_minima_produto = table.Column<short>(type: "INTEGER", nullable: true),
                    dias_semana = table.Column<string>(type: "TEXT", nullable: true),
                    hora_inicio = table.Column<string>(type: "TEXT", nullable: false),
                    hora_fim = table.Column<string>(type: "TEXT", nullable: false),
                    data_especifica = table.Column<string>(type: "TEXT", nullable: true),
                    descricao = table.Column<string>(type: "TEXT", nullable: false),
                    ativo = table.Column<bool>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_restricoes_horario_venda", x => x.id);
                    table.CheckConstraint("ck_restricoes_horario_venda_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_restricoes_horario_venda_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_restricoes_horario_venda_dias_semana", "dias_semana is null or json_valid(dias_semana)");
                    table.CheckConstraint("ck_restricoes_horario_venda_id_uuid", "length(id) = 36");
                });

            migrationBuilder.CreateTable(
                name: "unidades_medida",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    sigla = table.Column<string>(type: "TEXT", nullable: false),
                    descricao = table.Column<string>(type: "TEXT", nullable: false),
                    permite_fracao = table.Column<bool>(type: "INTEGER", nullable: false),
                    sistema = table.Column<bool>(type: "INTEGER", nullable: false),
                    ativo = table.Column<bool>(type: "INTEGER", nullable: false),
                    criado_em = table.Column<string>(type: "TEXT", nullable: false),
                    atualizado_em = table.Column<string>(type: "TEXT", nullable: false),
                    excluido_em = table.Column<string>(type: "TEXT", nullable: true),
                    versao = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    criado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    atualizado_por_id = table.Column<string>(type: "TEXT", nullable: true),
                    criado_localmente = table.Column<bool>(type: "INTEGER", nullable: false, defaultValue: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_unidades_medida", x => x.id);
                    table.CheckConstraint("ck_unidades_medida_ativo", "ativo in (0,1)");
                    table.CheckConstraint("ck_unidades_medida_criado_localmente", "criado_localmente in (0,1)");
                    table.CheckConstraint("ck_unidades_medida_id_uuid", "length(id) = 36");
                    table.CheckConstraint("ck_unidades_medida_permite_fracao", "permite_fracao in (0,1)");
                    table.CheckConstraint("ck_unidades_medida_sistema", "sistema in (0,1)");
                });

            migrationBuilder.CreateIndex(
                name: "ix_itens_venda_kit_grupo_id",
                table: "itens_venda",
                column: "kit_grupo_id");

            migrationBuilder.AddCheckConstraint(
                name: "ck_itens_venda_kit",
                table: "itens_venda",
                sql: "(kit_grupo_id is null) = (kit_produto_id is null) and (kit_grupo_id is null) = (kit_componente_id is null) and (kit_grupo_id is null or (kit_quantidade > 0 and kit_preco_unitario >= 0 and kit_descricao is not null)) and (kit_alternativa_id is null or kit_grupo_id is not null) and kit_acrescimo >= 0");

            migrationBuilder.AddCheckConstraint(
                name: "ck_itens_venda_origem_preco",
                table: "itens_venda",
                sql: "origem_preco in ('varejo','loja','promocional','atacado','quantidade','grupo_mix','parcelado','manual','balanca','orcamento','kit_rateio','embalagem')");

            migrationBuilder.CreateIndex(
                name: "ix_grupos_preco_quantidade_faixas_grupo_id",
                table: "grupos_preco_quantidade_faixas",
                column: "grupo_id");

            migrationBuilder.CreateIndex(
                name: "ix_produtos_balanca_plu",
                table: "produtos",
                column: "balanca_plu");

            migrationBuilder.CreateIndex(
                name: "ix_produtos_codigo",
                table: "produtos",
                column: "codigo");

            migrationBuilder.CreateIndex(
                name: "ix_produtos_codigo_interno",
                table: "produtos",
                column: "codigo_interno");

            migrationBuilder.CreateIndex(
                name: "ix_produtos_grupo_preco_quantidade_id",
                table: "produtos",
                column: "grupo_preco_quantidade_id");

            migrationBuilder.CreateIndex(
                name: "ix_produtos_codigos_barras_codigo",
                table: "produtos_codigos_barras",
                column: "codigo");

            migrationBuilder.CreateIndex(
                name: "ix_produtos_codigos_barras_produto_id",
                table: "produtos_codigos_barras",
                column: "produto_id");

            migrationBuilder.CreateIndex(
                name: "ix_produtos_componentes_produto_id",
                table: "produtos_componentes",
                column: "produto_id");

            migrationBuilder.CreateIndex(
                name: "ix_produtos_componentes_alternativas_componente_id",
                table: "produtos_componentes_alternativas",
                column: "componente_id");

            migrationBuilder.CreateIndex(
                name: "ix_produtos_lojas_produto_id_loja_id",
                table: "produtos_lojas",
                columns: new[] { "produto_id", "loja_id" });

            migrationBuilder.CreateIndex(
                name: "ix_produtos_precos_quantidade_produto_id",
                table: "produtos_precos_quantidade",
                column: "produto_id");

            migrationBuilder.CreateIndex(
                name: "ix_restricoes_horario_venda_loja_id",
                table: "restricoes_horario_venda",
                column: "loja_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "formas_pagamento");

            migrationBuilder.DropTable(
                name: "grupos_preco_quantidade");

            migrationBuilder.DropTable(
                name: "grupos_preco_quantidade_faixas");

            migrationBuilder.DropTable(
                name: "produtos");

            migrationBuilder.DropTable(
                name: "produtos_codigos_barras");

            migrationBuilder.DropTable(
                name: "produtos_componentes");

            migrationBuilder.DropTable(
                name: "produtos_componentes_alternativas");

            migrationBuilder.DropTable(
                name: "produtos_lojas");

            migrationBuilder.DropTable(
                name: "produtos_precos_quantidade");

            migrationBuilder.DropTable(
                name: "restricoes_horario_venda");

            migrationBuilder.DropTable(
                name: "unidades_medida");

            migrationBuilder.DropIndex(
                name: "ix_itens_venda_kit_grupo_id",
                table: "itens_venda");

            migrationBuilder.DropCheckConstraint(
                name: "ck_itens_venda_kit",
                table: "itens_venda");

            migrationBuilder.DropCheckConstraint(
                name: "ck_itens_venda_origem_preco",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "grupo_preco_quantidade_id",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "kit_acrescimo",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "kit_alternativa_id",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "kit_componente_id",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "kit_descricao",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "kit_preco_unitario",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "kit_quantidade",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "quantidade_referencia_preco",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "v_fcp",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "v_fcp_st_ret",
                table: "itens_venda");

            migrationBuilder.DropColumn(
                name: "v_icms_st_ret",
                table: "itens_venda");
        }
    }
}
