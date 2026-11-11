using System.Diagnostics;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Índice FTS5 da pesquisa F2 (Fase 2, F2-B36; PDV 10.3; MD 4.2; README › decisão 83): o SQLite empacotado tem a FTS5, a
/// migração cria a estrutura e a abertura a preenche num banco já em uso (sem voltar o cursor), as regras da pesquisa
/// (trechos, sem acento, palavras curtas, marca e categoria), a gravação dos espelhos mantém o índice, a recuperação com a
/// FTS5 ausente ou corrompida (a busca em memória responde e a abertura refaz) e os 300 ms com 50 mil produtos.
/// </summary>
[Collection(ColecaoVolumeSintetico.Nome)]
public class IndiceBuscaProdutosTests
{
    private const string MigracaoAnterior = "20261105131203_IndiceAuditoriaAutorizadoPor";

    private static readonly Guid Loja = Guid.Parse("019a0005-0000-7000-8000-000000000001");
    private static readonly Guid Estoque = Guid.Parse("019a0005-0000-7000-8000-0000000000e1");
    private static readonly Guid Un = Guid.Parse("019a0005-0000-7000-8000-0000000000a1");
    private static readonly Guid Heineken = Guid.Parse("019a0005-0000-7000-8000-0000000000b1");
    private static readonly Guid Cervejas = Guid.Parse("019a0005-0000-7000-8000-0000000000c1");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static ProdutoRegistro Produto(Guid id, int codigo, string nome, Action<ProdutoRegistro>? ajustar = null)
    {
        var p = new ProdutoRegistro { Id = id, Codigo = codigo, CodigoInterno = $"{codigo:0000}", Nome = nome, UnidadeId = Un, PrecoVenda = 9.90m, Versao = 1 };
        ajustar?.Invoke(p);
        return p;
    }

    private static async Task<BancoTemporario> BancoAsync()
    {
        var banco = new BancoTemporario();
        await banco.InicializarAsync();
        await AtivarAsync(banco);
        return banco;
    }

    private static async Task AtivarAsync(BancoTemporario banco)
    {
        await new RepositorioTerminal(banco.Fabrica, banco.Relogio).RegistrarAtivacaoAsync(new IdentidadeTerminal
        {
            TerminalId = Guid.CreateVersion7(),
            LojaId = Loja,
            CaixaId = Guid.CreateVersion7(),
            NumeroCaixa = 2,
            UrlApi = "demonstracao://local",
            AtivadoEm = banco.Relogio.Agora,
            NomeMaquina = "teste",
        }, Ct);
    }

    /// <summary>O catálogo pequeno das regras: marca, categoria, acento, trecho no meio da palavra e palavra curta.</summary>
    private static LinhaEspelho[] Catalogo() =>
    [
        new UnidadeMedidaRegistro { Id = Un, Sigla = "UN", Descricao = "Unidade" },
        new MarcaRegistro { Id = Heineken, Codigo = 1, Descricao = "Heineken", Versao = 1 },
        new CategoriaRegistro { Id = Cervejas, Nome = "Cervejas", Caminho = "1", CaminhoNomes = "Cervejas", Ativa = true, Versao = 1 },
        Produto(Guid.Parse("019a0005-0000-7000-8000-000000000101"), 101, "CERV LN 600ML", p =>
        {
            p.MarcaId = Heineken;
            p.CategoriaPrincipalId = Cervejas;
            p.Localizacao = "A3-02";
        }),
        Produto(Guid.Parse("019a0005-0000-7000-8000-000000000102"), 102, "CERV BRAHMA LT350ML", p => p.CategoriaPrincipalId = Cervejas),
        Produto(Guid.Parse("019a0005-0000-7000-8000-000000000103"), 103, "AÇAÍ NA TIGELA 500G"),
        Produto(Guid.Parse("019a0005-0000-7000-8000-000000000104"), 104, "COCA COLA PET 2L"),
        Produto(Guid.Parse("019a0005-0000-7000-8000-000000000105"), 105, "COCA COLA ZERO 2L INATIVA", p => p.Ativo = false),
        Produto(Guid.Parse("019a0005-0000-7000-8000-000000000106"), 106, "COCA COLA LATA EXCLUIDA", p => p.ExcluidoEm = DateTimeOffset.UnixEpoch),
    ];

    private static async Task<IReadOnlyList<string>> NomesAsync(CatalogoLocal catalogo, string texto) =>
        (await catalogo.PesquisarAsync(texto, ct: Ct)).Select(p => p.Descricao).ToList();

    /// <summary>
    /// Os nomes direto do índice (<see cref="IndiceBuscaProdutos.PesquisarAsync"/>, sem a busca em memória de reserva do
    /// <see cref="CatalogoLocal"/>): um erro no SQL da FTS5 faz o teste falhar em vez de cair na memória.
    /// </summary>
    private static async Task<IReadOnlyList<string>> NomesPeloIndiceAsync(BancoTemporario banco, string texto)
    {
        using var conexao = banco.AbrirConexao();
        var ids = await IndiceBuscaProdutos.PesquisarAsync(conexao, IndiceBuscaProdutos.Palavras(texto), 50, Ct);
        var nomes = new List<string>();
        foreach (var id in ids)
        {
            using var cmd = conexao.CreateCommand();
            cmd.CommandText = "select nome from produtos where id = $id";
            cmd.Parameters.AddWithValue("$id", id.ToString("D"));
            nomes.Add((string)cmd.ExecuteScalar()!);
        }

        return nomes;
    }

    private static async Task<bool> ProntoAsync(BancoTemporario banco)
    {
        using var conexao = banco.AbrirConexao();
        return await IndiceBuscaProdutos.ProntoAsync(conexao, null, Ct);
    }

    private static void Executar(SqliteConnection conexao, string sql)
    {
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static List<string> Esquema(BancoTemporario banco)
    {
        using var conexao = banco.AbrirConexao();
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = "select sql from sqlite_master where name in ('produtos_busca', 'produtos_busca_texto') or name like 'tg_produtos_busca_texto_%' order by name";
        using var leitor = cmd.ExecuteReader();
        var linhas = new List<string>();
        while (leitor.Read())
        {
            linhas.Add(leitor.GetString(0));
        }

        return linhas;
    }

    [Fact]
    public void Sqlite_empacotado_tem_a_fts5()
    {
        // O e_sqlite3 do SQLitePCLRaw é compilado com a FTS5 em todas as plataformas; este teste roda também no job do PDV
        // no Windows da CI, que é o sistema das lojas.
        using var banco = new BancoTemporario();
        using var conexao = banco.AbrirConexao();
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = "select count(*) from pragma_compile_options where compile_options = 'ENABLE_FTS5'";
        Assert.Equal(1L, cmd.ExecuteScalar());
    }

    [Fact]
    public async Task Banco_em_uso_a_migracao_cria_o_indice_e_a_abertura_preenche_com_o_espelho_sem_voltar_o_cursor()
    {
        // O PDV 0.10.0 instalado: o banco no esquema anterior, com o catálogo e os cursores já baixados.
        using var banco = new BancoTemporario();
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.GetService<IMigrator>().MigrateAsync(MigracaoAnterior, Ct);
        }

        await AtivarAsync(banco);
        // Sem a estrutura, a gravação do espelho não mexe no índice (nem falha). A marca e a categoria vão por SQL, no
        // esquema daquela versão: o modelo EF atual já tem as colunas de imagem da `FaseDois` (F2-B45).
        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(Catalogo().Where(l => l is not (MarcaRegistro or CategoriaRegistro)), Ct);
        using (var conexao = banco.AbrirConexao())
        {
            Executar(conexao, "insert into marcas (id, codigo, descricao, sem_marca, exibe_site, ordem, criado_em, atualizado_em, versao) "
                + $"values ('{Heineken:D}', 1, 'Heineken', 0, 0, 0, '2026-11-01T12:00:00.000Z', '2026-11-01T12:00:00.000Z', 1)");
            Executar(conexao, "insert into categorias (id, nome, caminho, caminho_nomes, nivel, ordem, ativa, exibe_pdv, exibe_menu_digital, exibe_totem, exibe_site, criado_em, atualizado_em, versao) "
                + $"values ('{Cervejas:D}', 'Cervejas', '1', 'Cervejas', 0, 0, 1, 0, 0, 0, 0, '2026-11-01T12:00:00.000Z', '2026-11-01T12:00:00.000Z', 1)");
            Executar(conexao, "update estado_sincronizacao set cursor = 7000, carga_inicial_concluida = 1 where fluxo = 'catalogo'");
        }

        // A busca em memória sem o índice não é conferida aqui: o app atual lê o modelo EF atual, que o banco antigo só
        // tem depois da abertura (as colunas da `FaseDois`); o teste da busca em memória × índice cobre o mesmo resultado.
        Assert.Equal(0L, banco.Escalar("select count(*) from sqlite_master where name = 'produtos_busca'"));

        var resultado = await banco.InicializarAsync();
        Assert.Contains(resultado.MigracoesAplicadas, m => m.EndsWith("_BuscaProdutosFts", StringComparison.Ordinal));
        Assert.NotNull(resultado.ArquivoBackup);
        Assert.Equal(new ResultadoIndiceBusca(true, "contagem diferente do espelho", 6), resultado.IndiceBusca);
        Assert.Null(resultado.ErroIndiceBusca);
        // A `BuscaProdutosFts` não volta o cursor (o índice sai do espelho); quem o volta, na mesma abertura, é a
        // `FaseDois` (F2-B45, a volta única da release R2). A carga inicial continua concluída: o caixa segue vendendo.
        Assert.Equal(0L, banco.Escalar("select cursor from estado_sincronizacao where fluxo = 'catalogo'"));
        Assert.Equal(1L, banco.Escalar("select carga_inicial_concluida from estado_sincronizacao where fluxo = 'catalogo'"));
        Assert.Equal(6L, banco.Escalar("select count(*) from produtos_busca_texto"));
        Assert.True(await ProntoAsync(banco));
        Assert.Equal(["CERV LN 600ML"], await NomesAsync(new CatalogoLocal(banco.Fabrica), "heineken 600"));

        // Idempotente: a próxima abertura não refaz nada.
        var segunda = await banco.InicializarAsync();
        Assert.Equal(new ResultadoIndiceBusca(false, null, 0), segunda.IndiceBusca);
    }

    [Fact]
    public async Task A_reconstrucao_da_o_mesmo_esquema_da_migracao()
    {
        using var banco = await BancoAsync();
        var daMigracao = Esquema(banco);
        Assert.Equal(5, daMigracao.Count);
        using (var conexao = banco.AbrirConexao())
        {
            await IndiceBuscaProdutos.MarcarReconstrucaoAsync(conexao, null, banco.Relogio.Agora, Ct);
        }

        Assert.False(await ProntoAsync(banco));
        var r = await IndiceBuscaProdutos.GarantirAsync(banco.Fabrica.StringConexao, banco.Relogio.Agora, Ct);
        Assert.Equal(new ResultadoIndiceBusca(true, "reconstrução pendente", 0), r);
        Assert.Equal(daMigracao, Esquema(banco));
        Assert.True(await ProntoAsync(banco));
        Assert.Equal(0L, banco.Escalar($"select count(*) from configuracao_terminal where chave = '{ChavesConfiguracaoTerminal.BuscaReconstruir}'"));
    }

    [Fact]
    public async Task Pesquisa_casa_trechos_sem_acento_em_qualquer_ordem_marca_categoria_e_palavras_curtas()
    {
        using var banco = await BancoAsync();
        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(Catalogo(), Ct);
        Assert.True(await ProntoAsync(banco));
        var catalogo = new CatalogoLocal(banco.Fabrica);

        // Cada regra direto no índice (o erro de SQL falha aqui) e pela pesquisa do catálogo (que precisa dar o mesmo).
        async Task Confere(string[] esperado, string texto)
        {
            Assert.Equal(esperado, await NomesPeloIndiceAsync(banco, texto));
            Assert.Equal(esperado, await NomesAsync(catalogo, texto));
        }

        // Marca e categoria entram no texto; a ordem das palavras não importa.
        await Confere(["CERV LN 600ML"], "600 heineken");
        await Confere(["CERV BRAHMA LT350ML", "CERV LN 600ML"], "cervejas");
        // Trecho no meio da palavra (o trigrama), sem acento e em minúsculas.
        await Confere(["CERV BRAHMA LT350ML"], "350");
        await Confere(["AÇAÍ NA TIGELA 500G"], "acai tigela");
        await Confere(["AÇAÍ NA TIGELA 500G"], "AÇAÍ");
        // Palavra de menos de 3 letras (o trigrama não indexa): filtrada no SQLite, sozinha ou com outra.
        await Confere(["COCA COLA PET 2L"], "2l");
        await Confere(["COCA COLA PET 2L"], "coca 2l");
        // Código interno e código numérico.
        await Confere(["CERV BRAHMA LT350ML"], "0102");
        // Inativo e excluído não aparecem; aspas na pesquisa não quebram o MATCH.
        await Confere(["COCA COLA PET 2L"], "coca");
        await Confere([], "\"coca");
        await Confere([], "coca \" OR cerv");
        // Sem filtro: os primeiros por nome (como a Fase 1).
        await Confere(["AÇAÍ NA TIGELA 500G", "CERV BRAHMA LT350ML", "CERV LN 600ML", "COCA COLA PET 2L"], " ");

        // A linha traz a marca e a localização (as colunas novas da tela), também na pesquisa só por números.
        var linha = Assert.Single(await catalogo.PesquisarAsync("heineken", ct: Ct));
        Assert.Equal(("Heineken", "A3-02"), (linha.Marca, linha.Localizacao));
        var porCodigo = Assert.Single(await catalogo.PesquisarCodigoAsync("0101", ct: Ct));
        Assert.Equal(("Heineken", "A3-02"), (porCodigo.Marca, porCodigo.Localizacao));
        // Nenhuma busca caiu na memória (a falha da FTS5 marcaria a reconstrução).
        Assert.True(await ProntoAsync(banco));
    }

    [Fact]
    public async Task A_busca_em_memoria_e_o_indice_dao_o_mesmo_resultado()
    {
        using var banco = await BancoAsync();
        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(Catalogo(), Ct);
        var catalogo = new CatalogoLocal(banco.Fabrica);
        string[] filtros = ["600 heineken", "cervejas", "350", "acai", "2l", "coca 2l", "0102", "coca", " ", "x"];
        var peloIndice = new List<IReadOnlyList<string>>();
        Assert.True(await ProntoAsync(banco));
        foreach (var f in filtros)
        {
            // Direto no índice: o erro de SQL falha aqui, e não compara memória com memória.
            peloIndice.Add(await NomesPeloIndiceAsync(banco, f));
            Assert.Equal(peloIndice[^1], await NomesAsync(catalogo, f));
        }

        Assert.True(await ProntoAsync(banco));

        using (var conexao = banco.AbrirConexao())
        {
            await IndiceBuscaProdutos.MarcarReconstrucaoAsync(conexao, null, banco.Relogio.Agora, Ct);
        }

        Assert.False(await ProntoAsync(banco));
        for (var i = 0; i < filtros.Length; i++)
        {
            Assert.Equal(peloIndice[i], await NomesAsync(catalogo, filtros[i]));
        }
    }

    [Fact]
    public async Task Gravar_espelho_atualiza_o_texto_do_produto_e_dos_produtos_da_marca()
    {
        using var banco = await BancoAsync();
        var espelhos = new RepositorioEspelhos(banco.Fabrica);
        await espelhos.GravarAsync(Catalogo(), Ct);
        var catalogo = new CatalogoLocal(banco.Fabrica);

        // A marca renomeada (versão nova) muda o texto dos produtos dela, sem o produto descer de novo.
        await espelhos.GravarAsync([new MarcaRegistro { Id = Heineken, Codigo = 1, Descricao = "Amstel", Versao = 2 }], Ct);
        Assert.Empty(await NomesPeloIndiceAsync(banco, "heineken"));
        Assert.Equal(["CERV LN 600ML"], await NomesPeloIndiceAsync(banco, "amstel"));
        Assert.Equal(["CERV LN 600ML"], await NomesAsync(catalogo, "amstel"));

        // A categoria renomeada também: os dois produtos dela saem do nome antigo.
        await espelhos.GravarAsync(
            [new CategoriaRegistro { Id = Cervejas, Nome = "Bebidas Geladas", Caminho = "1", CaminhoNomes = "Bebidas Geladas", Ativa = true, Versao = 2 }], Ct);
        Assert.Empty(await NomesPeloIndiceAsync(banco, "cervejas"));
        Assert.Equal(["CERV BRAHMA LT350ML", "CERV LN 600ML"], await NomesPeloIndiceAsync(banco, "geladas"));
        Assert.Equal(["CERV BRAHMA LT350ML", "CERV LN 600ML"], await NomesAsync(catalogo, "geladas"));

        // O produto renomeado sai do texto antigo; o excluído sai da pesquisa.
        var id = Guid.Parse("019a0005-0000-7000-8000-000000000104");
        await espelhos.GravarAsync([Produto(id, 104, "GUARANA PET 2L", p => p.Versao = 2)], Ct);
        Assert.Empty(await NomesAsync(catalogo, "coca"));
        Assert.Equal(["GUARANA PET 2L"], await NomesAsync(catalogo, "guarana"));
        await espelhos.GravarAsync([Produto(id, 104, "GUARANA PET 2L", p => (p.Versao, p.ExcluidoEm) = (3, DateTimeOffset.UnixEpoch))], Ct);
        Assert.Empty(await NomesAsync(catalogo, "guarana"));
        Assert.Equal(6L, banco.Escalar("select count(*) from produtos_busca_texto"));
        Assert.True(await ProntoAsync(banco));
    }

    [Fact]
    public async Task Rollback_do_ponto_de_salvamento_falho_suspende_o_indice_ate_a_reconstrucao_e_o_cursor_nao_para()
    {
        // Último recurso: a falha desfez a transação inteira (o ROLLBACK TO não acha o ponto de salvamento). A página falha
        // uma vez; nas próximas o índice fica de fora (só marca a reconstrução) até a reconstrução limpar a suspensão.
        using var banco = await BancoAsync();
        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(Catalogo(), Ct);
        const string Id = "019a0005-0000-7000-8000-000000000101";
        using var conexao = banco.AbrirConexao();

        async Task<Exception?> RenomearAsync(string nome)
        {
            using var tx = conexao.BeginTransaction();
            Executar(conexao, $"update produtos set nome = '{nome}' where id = '{Id}'");
            var falha = await IndiceBuscaProdutos.AtualizarAsync(conexao, tx, [Id], [], [], banco.Relogio.Agora, Ct);
            tx.Commit();
            return falha;
        }

        // O gatilho desfaz a transação inteira na escrita do texto (como um disco cheio faria).
        Executar(conexao, "create trigger tg_teste_desfaz before update on produtos_busca_texto begin select raise(rollback, 'teste: desfaz tudo'); end");
        // O Microsoft.Data.Sqlite dá a transação por encerrada (o ROLLBACK TO é recusado com InvalidOperationException).
        await Assert.ThrowsAsync<InvalidOperationException>(() => RenomearAsync("CERV LN 600ML SUSPENSA"));
        Executar(conexao, "drop trigger tg_teste_desfaz");
        Assert.Equal("CERV LN 600ML", banco.Escalar($"select nome from produtos where id = '{Id}'"));

        // Suspenso: a página passa (o cursor anda), o texto do índice não muda e a reconstrução fica marcada.
        Assert.Null(await RenomearAsync("CERV LN 600ML NOVA"));
        Assert.Equal("CERV LN 600ML NOVA", banco.Escalar($"select nome from produtos where id = '{Id}'"));
        Assert.DoesNotContain("NOVA", (string)banco.Escalar($"select texto from produtos_busca_texto where produto_id = '{Id}'")!, StringComparison.Ordinal);
        Assert.False(await ProntoAsync(banco));
        Assert.Equal(["CERV LN 600ML NOVA"], await NomesAsync(new CatalogoLocal(banco.Fabrica), "nova"));

        // A reconstrução refaz o texto e tira a suspensão: a próxima gravação volta a atualizar o índice.
        var r = await IndiceBuscaProdutos.GarantirAsync(banco.Fabrica.StringConexao, banco.Relogio.Agora, Ct);
        Assert.Equal(new ResultadoIndiceBusca(true, "reconstrução pendente", 6), r);
        Assert.Equal(["CERV LN 600ML NOVA"], await NomesPeloIndiceAsync(banco, "nova"));
        Assert.Null(await RenomearAsync("CERV LN 600ML DE VOLTA"));
        Assert.True(await ProntoAsync(banco));
        Assert.Equal(["CERV LN 600ML DE VOLTA"], await NomesPeloIndiceAsync(banco, "volta"));
    }

    [Fact]
    public async Task Sem_a_tabela_fts5_a_pesquisa_segue_em_memoria_e_a_abertura_recria()
    {
        using var banco = await BancoAsync();
        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(Catalogo(), Ct);
        using (var conexao = banco.AbrirConexao())
        {
            Executar(conexao, "drop table produtos_busca");
        }

        var catalogo = new CatalogoLocal(banco.Fabrica);
        Assert.False(await ProntoAsync(banco));
        Assert.Equal(["CERV LN 600ML"], await NomesAsync(catalogo, "heineken"));
        // Os gatilhos apontam para a FTS5 que sumiu: a gravação do espelho deixa o índice e grava o produto.
        await new RepositorioEspelhos(banco.Fabrica).GravarAsync([Produto(Guid.CreateVersion7(), 200, "CERV HEINEKEN LATA")], Ct);
        Assert.Equal(["CERV HEINEKEN LATA", "CERV LN 600ML"], await NomesAsync(catalogo, "heineken"));

        var resultado = await banco.InicializarAsync();
        Assert.Equal(new ResultadoIndiceBusca(true, "estrutura ausente", 7), resultado.IndiceBusca);
        Assert.True(await ProntoAsync(banco));
        Assert.Equal(["CERV HEINEKEN LATA", "CERV LN 600ML"], await NomesAsync(catalogo, "heineken"));
    }

    [Fact]
    public async Task Fts5_corrompida_a_pesquisa_segue_em_memoria_e_a_abertura_descarta_e_refaz_sem_bloquear_o_caixa()
    {
        using var banco = await BancoAsync();
        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(Catalogo(), Ct);
        using (var conexao = banco.AbrirConexao())
        {
            // O índice invertido perde os blocos: a consulta acusa "fts5: corruption".
            Executar(conexao, "delete from produtos_busca_data where id > 10");
        }

        var catalogo = new CatalogoLocal(banco.Fabrica);
        Assert.Equal(["CERV LN 600ML"], await NomesAsync(catalogo, "heineken"));
        // A falha da consulta marcou a reconstrução: as próximas já vão direto à memória.
        Assert.False(await ProntoAsync(banco));
        Assert.Equal(["CERV BRAHMA LT350ML", "CERV LN 600ML"], await NomesAsync(catalogo, "cerv"));

        // A abertura: o integrity_check acusa só a FTS5, que é descartada e refeita (o caixa abre).
        var resultado = await banco.InicializarAsync();
        Assert.True(resultado.IndiceDescartado);
        Assert.Equal(new ResultadoIndiceBusca(true, "estrutura ausente", 6), resultado.IndiceBusca);
        Assert.True(await ProntoAsync(banco));
        Assert.Equal("ok", banco.Escalar("pragma integrity_check"));
        Assert.Equal(["CERV LN 600ML"], await NomesAsync(catalogo, "heineken"));
    }

    [Fact]
    public async Task Fts5_corrompida_num_banco_de_versao_mais_nova_a_abertura_recusa_sem_descartar_nada()
    {
        using var banco = await BancoAsync();
        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(Catalogo(), Ct);
        using (var conexao = banco.AbrirConexao())
        {
            Executar(conexao, "delete from produtos_busca_data where id > 10");
            Executar(conexao, "insert into __ef_migracoes (MigrationId, ProductVersion) values ('29991231235959_VersaoFutura', '10.0.0')");
        }

        await Assert.ThrowsAsync<BancoDeVersaoMaisNovaException>(banco.InicializarAsync);
        // O banco da versão nova ficou como estava: a FTS5 e os gatilhos no lugar, sem a marca de reconstrução.
        Assert.Equal((long)IndiceBuscaProdutos.Objetos.Count,
            banco.Escalar($"select count(*) from sqlite_master where name in ('{string.Join("', '", IndiceBuscaProdutos.Objetos)}')"));
        Assert.Equal(0L, banco.Escalar($"select count(*) from configuracao_terminal where chave = '{ChavesConfiguracaoTerminal.BuscaReconstruir}'"));
        Assert.NotEqual("ok", banco.Escalar("pragma integrity_check"));
    }

    [Fact]
    public async Task Backup_com_a_fts5_corrompida_e_restauravel_e_a_abertura_refaz_o_indice()
    {
        // A FTS5 se corrompe com o caixa offline: os backups do dia levam o índice corrompido junto. Se depois o banco em
        // uso estragar de verdade, esses backups (os mais novos) continuam valendo.
        using var banco = await BancoAsync();
        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(Catalogo(), Ct);
        using (var conexao = banco.AbrirConexao())
        {
            Executar(conexao, "delete from produtos_busca_data where id > 10");
        }

        Assert.NotEqual("ok", banco.Escalar("pragma integrity_check"));
        var backup = new Backup.BackupLocal(banco.Fabrica, banco.Caminhos, banco.Relogio);
        var arquivo = await backup.FazerAsync(Backup.MotivosBackup.Periodico, Ct);
        var restauracao = new Backup.RestauracaoBackup(banco.Fabrica, banco.Caminhos, backup, banco.Relogio);
        await restauracao.ConferirAsync(arquivo.Arquivo, Ct);
        await restauracao.RestaurarAsync(arquivo.Arquivo, null, null, Ct);

        // O arquivo restaurado já sai sem a FTS5 e com a reconstrução marcada: íntegro, e a abertura refaz o índice.
        Assert.Equal("ok", banco.Escalar("pragma integrity_check"));
        Assert.Equal(0L, banco.Escalar("select count(*) from sqlite_master where name = 'produtos_busca'"));
        Assert.Equal("true", banco.Escalar($"select valor from configuracao_terminal where chave = '{ChavesConfiguracaoTerminal.BuscaReconstruir}'"));
        var resultado = await banco.InicializarAsync();
        Assert.False(resultado.IndiceDescartado);
        Assert.Equal(new ResultadoIndiceBusca(true, "estrutura ausente", 6), resultado.IndiceBusca);
        Assert.True(await ProntoAsync(banco));
        Assert.Equal(["CERV LN 600ML"], await NomesPeloIndiceAsync(banco, "heineken"));
    }

    [Fact]
    public async Task Cinquenta_mil_produtos_heineken_600_volta_em_menos_de_300_ms_com_marca_e_estoque()
    {
        using var banco = await BancoAsync();
        var agora = banco.Relogio.Agora;
        var alvo = Guid.Parse("019a0005-0000-7000-8000-000000000101");
        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(
            [
                .. Catalogo(),
                new LojaRegistro { Id = Loja, Codigo = 1, Nome = "Loja 1", EstoqueId = Estoque, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
            ],
            Ct);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            db.Set<SaldoEstoqueRegistro>().Add(new SaldoEstoqueRegistro
            {
                Id = Guid.CreateVersion7(),
                EstoqueId = Estoque,
                ProdutoId = alvo,
                TipoEstoqueId = Guid.CreateVersion7(),
                Quantidade = 240m,
                Versao = 10,
                CriadoEm = agora,
                AtualizadoEm = agora,
            });
            await db.SaveChangesAsync(Ct);
        }

        // 50 mil produtos clonados do primeiro (SQL direto, como o pull grava), metade com a marca, nomes variados.
        string[] nomes = ["CERV LN 600ML", "CERV LATA 350ML", "REFRI PET 2L", "AGUA MINERAL 500ML", "ENERGETICO LATA 473ML", "VINHO TINTO 750ML"];
        using (var conexao = banco.AbrirConexao())
        {
            var colunas = new List<string>();
            using (var info = conexao.CreateCommand())
            {
                info.CommandText = "select name from pragma_table_info('produtos')";
                using var leitor = info.ExecuteReader();
                while (leitor.Read())
                {
                    colunas.Add(leitor.GetString(0));
                }
            }

            var valores = colunas.Select(c => c switch
            {
                "id" => "$id",
                "codigo" => "$codigo",
                "codigo_interno" => "$interno",
                "nome" => "$nome",
                "marca_id" => "$marca",
                _ => c,
            });
            using var tx = conexao.BeginTransaction();
            using var cmd = conexao.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText = $"insert into produtos ({string.Join(", ", colunas)}) select {string.Join(", ", valores)} from produtos where id = '{alvo:D}'";
            var id = cmd.Parameters.Add("$id", SqliteType.Text);
            var codigo = cmd.Parameters.Add("$codigo", SqliteType.Integer);
            var interno = cmd.Parameters.Add("$interno", SqliteType.Text);
            var nome = cmd.Parameters.Add("$nome", SqliteType.Text);
            var marca = cmd.Parameters.Add("$marca", SqliteType.Text);
            cmd.Prepare();
            for (var i = 0; i < 50_000; i++)
            {
                id.Value = Guid.CreateVersion7().ToString("D");
                codigo.Value = 10_000 + i;
                interno.Value = $"P{10_000 + i}";
                nome.Value = $"{nomes[i % nomes.Length]} {i}";
                marca.Value = i % 2 == 0 ? Heineken.ToString("D") : DBNull.Value;
                cmd.ExecuteNonQuery();
            }

            tx.Commit();
        }

        // A abertura acha a contagem diferente e reconstrói em lotes.
        var montagem = Stopwatch.StartNew();
        var resultado = await IndiceBuscaProdutos.GarantirAsync(banco.Fabrica.StringConexao, agora, Ct);
        montagem.Stop();
        Assert.Equal(50_006, resultado.Produtos);
        Assert.True(await ProntoAsync(banco));

        var catalogo = new CatalogoLocal(banco.Fabrica);
        var consultas = new ConsultasVendaLocal(banco.Fabrica);
        await catalogo.PesquisarAsync("aquecimento", ct: Ct);
        Assert.True(await ProntoAsync(banco));
        var tempos = new List<TimeSpan>();
        IReadOnlyList<GenesisPDV.Core.Produtos.ProdutoPesquisado> linhas = [];
        IReadOnlyDictionary<Guid, decimal> saldos = new Dictionary<Guid, decimal>();
        for (var i = 0; i < 5; i++)
        {
            var relogio = Stopwatch.StartNew();
            linhas = await catalogo.PesquisarAsync("heineken 600", ct: Ct);
            saldos = await consultas.SaldosEstimadosAsync(linhas.Select(l => l.Produto.Id).ToList(), Ct);
            tempos.Add(relogio.Elapsed);
        }

        // As medições foram pela FTS5 (a falha dela cairia na memória e marcaria a reconstrução).
        Assert.True(await ProntoAsync(banco));
        Assert.Equal(50, linhas.Count);
        Assert.All(linhas, l => Assert.Equal("Heineken", l.Marca));
        Assert.Equal("CERV LN 600ML", linhas[0].Descricao);
        Assert.Equal(240m, saldos[alvo]);
        var mediana = tempos.Order().ElementAt(tempos.Count / 2);
        Assert.True(mediana < ColecaoVolumeSintetico.TetoConsulta,
            $"pesquisa: {mediana.TotalMilliseconds:0} ms (montagem do índice: {montagem.ElapsedMilliseconds} ms)");
    }
}
