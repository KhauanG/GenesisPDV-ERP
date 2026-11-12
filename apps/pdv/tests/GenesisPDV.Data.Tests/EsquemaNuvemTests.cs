using System.Reflection;
using System.Text.RegularExpressions;
using GenesisPDV.Data.Convencoes;
using GenesisPDV.Data.Entidades;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Metadata;

namespace GenesisPDV.Data.Tests;

/// <summary>O modelo EF do PDV não pode divergir do schema da nuvem gerado em <c>Esquema.g.cs</c> (MD 4.1).</summary>
public class EsquemaNuvemTests
{
    /// <summary>
    /// Colunas que só existem no SQLite (MD 4.2). Os campos calculados do pull (<c>foto_url</c>, <c>foto_sha256</c>…) estão
    /// no Esquema.g.cs como projetados desde o F2-B45 e são conferidos como as demais colunas.
    /// </summary>
    private static readonly HashSet<string> ColunasSoLocais = ["criado_localmente"];

    // As colunas que não descem (MD 6.2) vêm do próprio Esquema.g.cs (DescidaColuna.Omitida), geradas do registro de
    // fluxos da API: nada de lista mantida à mão aqui.

    [Fact]
    public void Esquema_gerado_tem_escala_em_todo_decimal_e_tabelas_unicas()
    {
        Assert.NotEmpty(EsquemaNuvem.Tabelas);
        Assert.Equal(EsquemaNuvem.Tabelas.Count, EsquemaNuvem.Tabelas.Select(t => t.Nome).Distinct().Count());
        Assert.All(EsquemaNuvem.Tabelas.SelectMany(t => t.Colunas), c =>
            Assert.Equal(c.TipoClr == typeof(decimal), c.Escala is not null));
        Assert.Equal(4, EsquemaNuvem.Tabela("usuarios")!.Colunas.Single(c => c.Nome == "limite_desconto_pct").Escala);
    }

    [Fact]
    public void Esquema_gerado_marca_as_colunas_que_nao_descem_e_as_projetadas()
    {
        var produtos = EsquemaNuvem.Tabela("produtos")!;
        foreach (var nome in new[] { "preco_custo", "custo_medio", "markup_pct", "busca", "peso_g", "peso_abatimento_g", "peso_pacote_kg" })
        {
            Assert.Equal(DescidaColuna.Omitida, produtos.Colunas.Single(c => c.Nome == nome).Descida);
        }

        Assert.Equal(DescidaColuna.Desce, produtos.Colunas.Single(c => c.Nome == "preco_venda").Descida);
        Assert.Equal(DescidaColuna.Omitida, EsquemaNuvem.Tabela("usuarios")!.Colunas.Single(c => c.Nome == "senha_hash").Descida);
        Assert.Equal(DescidaColuna.Projetada, EsquemaNuvem.Tabela("usuarios")!.Colunas.Single(c => c.Nome == "senha_pdv_hash").Descida);
        Assert.Equal(DescidaColuna.Projetada, EsquemaNuvem.Tabela("lojas")!.Colunas.Single(c => c.Nome == "nfce_csc_cifrado").Descida);

        // Projetada pode chegar nula (PIN de quem não tem a loja, segredo ainda não cifrado para o terminal), salvo o
        // `usuarios.ativo` calculado com a demissão (D19), que é sempre booleano.
        Assert.All(
            EsquemaNuvem.Tabelas.SelectMany(t => t.Colunas.Select(c => (Tabela: t.Nome, Coluna: c)))
                .Where(x => x.Coluna.Descida == DescidaColuna.Projetada && $"{x.Tabela}.{x.Coluna.Nome}" != "usuarios.ativo"),
            x => Assert.True(x.Coluna.Nulo, $"{x.Tabela}.{x.Coluna.Nome}"));
        var usuarios = EsquemaNuvem.Tabela("usuarios")!;
        Assert.Equal(DescidaColuna.Projetada, usuarios.Colunas.Single(c => c.Nome == "ativo").Descida);
        foreach (var nome in new[] { "telefone", "admissao", "demissao" })
        {
            Assert.Equal(DescidaColuna.Omitida, usuarios.Colunas.Single(c => c.Nome == nome).Descida);
        }
        // Movimento nasce no PDV e sobe inteiro: não tem projeção de descida.
        Assert.All(EsquemaNuvem.Tabelas.Where(t => t.Papel == PapelTabela.Movimento).SelectMany(t => t.Colunas), c => Assert.Equal(DescidaColuna.Desce, c.Descida));
    }

    [Fact]
    public void Imagens_do_catalogo_descem_como_campos_calculados_projetados()
    {
        // Fase 2 (F2-B45; SYNC 6.12): o caminho estável e o sha256 da variante `pdv_256`, sempre anuláveis (sem imagem).
        foreach (var (tabela, campo) in new[] { ("produtos", "foto"), ("categorias", "imagem"), ("marcas", "logotipo") })
        {
            foreach (var nome in new[] { $"{campo}_url", $"{campo}_sha256" })
            {
                var coluna = EsquemaNuvem.Tabela(tabela)!.Colunas.Single(c => c.Nome == nome);
                Assert.Equal(DescidaColuna.Projetada, coluna.Descida);
                Assert.True(coluna.Nulo, $"{tabela}.{nome}");
                Assert.Equal(typeof(string), coluna.TipoClr);
            }
        }
    }

    [Fact]
    public void Tabelas_da_nuvem_mapeadas_no_pdv_tem_as_mesmas_colunas_tipos_escalas_e_nulidade()
    {
        using var db = new PdvDbContext(FabricaPdvDb.Opcoes("Data Source=:memory:"));
        foreach (var entidade in db.Model.GetEntityTypes())
        {
            var tabela = EsquemaNuvem.Tabela(entidade.GetTableName()!);
            if (tabela is null)
            {
                continue;
            }

            var locais = entidade.GetProperties().ToDictionary(p => p.GetColumnName());
            foreach (var coluna in tabela.Colunas)
            {
                if (coluna.Descida == DescidaColuna.Omitida)
                {
                    Assert.False(locais.ContainsKey(coluna.Nome), $"{tabela.Nome}.{coluna.Nome} não desce (MD 6.2) e não deve estar no espelho");
                    continue;
                }

                Assert.True(locais.TryGetValue(coluna.Nome, out var propriedade), $"{tabela.Nome}.{coluna.Nome} falta no modelo EF");
                var tipo = Nullable.GetUnderlyingType(propriedade.ClrType) ?? propriedade.ClrType;
                Assert.True(tipo == coluna.TipoClr, $"{tabela.Nome}.{coluna.Nome}: {tipo.Name} ≠ {coluna.TipoClr.Name}");
                Assert.True(propriedade.IsNullable == coluna.Nulo, $"{tabela.Nome}.{coluna.Nome}: nulidade diferente");
                if (coluna.Escala is { } escala)
                {
                    Assert.Equal(escala, propriedade.PropertyInfo!.GetCustomAttribute<EscalaAttribute>()!.Casas);
                }
            }

            var sobrando = locais.Keys.Except(tabela.Colunas.Select(c => c.Nome)).Except(ColunasSoLocais).ToList();
            Assert.True(sobrando.Count == 0, $"{tabela.Nome}: colunas fora do schema da nuvem: {string.Join(", ", sobrando)}");
        }
    }

    /// <summary>
    /// CHECKs da nuvem que o SQLite não aceita como estão e que o PDV reescreve com o mesmo efeito: só o nome é
    /// conferido. Qualquer outro é comparado também pela expressão.
    /// </summary>
    private static readonly HashSet<string> ChecksReescritosParaSqlite =
    [
        // `~ '^[0-9]{11}$|^[0-9A-Z]{12}[0-9]{2}$'` do PostgreSQL vira GLOB (o SQLite não tem `~`).
        "ck_vendas_cpf_cnpj_nota",
    ];

    [Fact]
    public void Tabelas_de_movimento_mapeadas_no_pdv_tem_os_mesmos_checks_da_nuvem()
    {
        // Fase 1C (bloco C3): o que a nuvem recusaria (PAYLOAD_INVALIDO, SYNC 11.2) o SQLite recusa antes de virar evento.
        // Confere o nome (MD 1.8) e a expressão (com os espaços normalizados): uma enumeração estreitada na nuvem
        // (`CANAIS_VENDA`, `STATUS_FISCAL_VENDA`) regenera o Esquema.g.cs e quebra aqui até o PDV acompanhar. A
        // expressão do PostgreSQL nem sempre vale no SQLite: as reescritas ficam em ChecksReescritosParaSqlite.
        using var db = new PdvDbContext(FabricaPdvDb.Opcoes("Data Source=:memory:"));
        var mapeadas = 0;
        var comparadas = 0;
        foreach (var entidade in db.GetService<IDesignTimeModel>().Model.GetEntityTypes())
        {
            var tabela = EsquemaNuvem.Tabela(entidade.GetTableName()!);
            if (tabela is not { Papel: PapelTabela.Movimento })
            {
                continue;
            }

            mapeadas++;
            var locais = entidade.GetCheckConstraints().ToDictionary(c => c.ModelName, c => c.Sql);
            var faltando = tabela.Checks.Select(c => c.Nome).Except(locais.Keys).ToList();
            Assert.True(faltando.Count == 0, $"{tabela.Nome}: CHECKs da nuvem ausentes no PDV: {string.Join(", ", faltando)}");
            foreach (var check in tabela.Checks.Where(c => !ChecksReescritosParaSqlite.Contains(c.Nome)))
            {
                comparadas++;
                Assert.True(
                    Normalizar(check.ExpressaoPostgres) == Normalizar(locais[check.Nome]),
                    $"{tabela.Nome}.{check.Nome}: expressão diferente da nuvem\n  nuvem: {check.ExpressaoPostgres}\n  PDV:   {locais[check.Nome]}");
            }
        }

        Assert.True(mapeadas >= 4, $"{mapeadas} tabelas de movimento mapeadas");
        Assert.True(comparadas >= 25, $"{comparadas} expressões comparadas");
        // A lista de exceções não pode guardar nome que nenhuma tabela mapeada tem (exceção esquecida).
        var nomes = EsquemaNuvem.Tabelas.SelectMany(t => t.Checks).Select(c => c.Nome).ToHashSet();
        Assert.All(ChecksReescritosParaSqlite, n => Assert.Contains(n, nomes));
    }

    [Fact]
    public void Colunas_geradas_da_nuvem_sao_calculadas_no_pdv()
    {
        // Fase 1C (bloco C3): `diferenca` dos fechamentos é `generated ... stored` na nuvem. Quando a tabela entrar no
        // modelo do PDV (C9), ela precisa ser calculada também aqui (nunca gravada pelo código nem enviada como valor).
        Assert.True(EsquemaNuvem.Tabela("fechamentos_caixa")!.Colunas.Single(c => c.Nome == "diferenca").Gerada);
        Assert.True(EsquemaNuvem.Tabela("fechamentos_caixa_formas")!.Colunas.Single(c => c.Nome == "diferenca").Gerada);
        Assert.False(EsquemaNuvem.Tabela("vendas")!.Colunas.Single(c => c.Nome == "total").Gerada);
        using var db = new PdvDbContext(FabricaPdvDb.Opcoes("Data Source=:memory:"));
        foreach (var entidade in db.GetService<IDesignTimeModel>().Model.GetEntityTypes())
        {
            var tabela = EsquemaNuvem.Tabela(entidade.GetTableName()!);
            foreach (var coluna in tabela?.Colunas.Where(c => c.Gerada) ?? [])
            {
                var propriedade = entidade.GetProperties().SingleOrDefault(p => p.GetColumnName() == coluna.Nome);
                Assert.True(
                    propriedade?.GetComputedColumnSql() is not null,
                    $"{tabela!.Nome}.{coluna.Nome} é gerada na nuvem: no PDV deve ser HasComputedColumnSql");
            }
        }
    }

    /// <summary>Espaços em sequência viram um só (o C# concatena trechos; o gerador da API escreve numa linha).</summary>
    private static string Normalizar(string expressao) => Regex.Replace(expressao, @"\s+", " ").Trim();

    [Fact]
    public void Espelhos_do_catalogo_e_itens_de_combo_estao_no_esquema_gerado()
    {
        // Fase 1A: as tabelas que a regra de preço e o combo leem já descem da nuvem; o teste acima confere as colunas.
        // Fase 1C (C8b): as lojas em que cada forma de pagamento vale (`formas_pagamento_lojas`).
        using var db = new PdvDbContext(FabricaPdvDb.Opcoes("Data Source=:memory:"));
        string[] espelhos =
        [
            "produtos", "produtos_codigos_barras", "produtos_lojas", "produtos_precos_quantidade", "grupos_preco_quantidade",
            "grupos_preco_quantidade_faixas", "produtos_componentes", "produtos_componentes_alternativas", "restricoes_horario_venda",
            "formas_pagamento", "formas_pagamento_lojas", "unidades_medida",
            // Fase 2 (F2-B45; F2-Q1 = D43): os complementos.
            "produtos_grupos_complementos", "produtos_complementos",
        ];
        var mapeadas = db.Model.GetEntityTypes().Select(t => t.GetTableName()).ToHashSet();
        foreach (var nome in espelhos)
        {
            Assert.Contains(nome, mapeadas);
            Assert.Equal(PapelTabela.Espelho, EsquemaNuvem.Tabela(nome)?.Papel);
        }
    }

    [Fact]
    public void Todo_espelho_do_esquema_gerado_esta_mapeado_com_a_mesma_chave_e_fluxo()
    {
        // Fase 1B (bloco B4): os 6 fluxos descem inteiros; tabela nova na nuvem sem espelho aqui falha este teste (o
        // aplicador do pull a ignoraria com log, sem travar o cursor).
        using var db = new PdvDbContext(FabricaPdvDb.Opcoes("Data Source=:memory:"));
        var mapeadas = db.Model.GetEntityTypes().ToDictionary(t => t.GetTableName()!);
        var espelhos = EsquemaNuvem.Tabelas.Where(t => t.Papel == PapelTabela.Espelho).ToList();
        Assert.True(espelhos.Count >= 58, $"{espelhos.Count} espelhos no Esquema.g.cs");
        foreach (var tabela in espelhos)
        {
            Assert.True(mapeadas.TryGetValue(tabela.Nome, out var entidade), $"{tabela.Nome} sem espelho no PDV");
            Assert.Equal(tabela.Chave, entidade.FindPrimaryKey()!.Properties.Select(p => p.GetColumnName()));
            Assert.Contains(tabela.Fluxo, EstadoSincronizacao.Fluxos);
        }
    }
}
