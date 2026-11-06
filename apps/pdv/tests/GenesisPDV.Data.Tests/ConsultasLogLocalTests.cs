using System.Text.Json.Nodes;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// As ocorrências do <c>log_local</c> para a aba 5 Logs e ocorrências da Central do PDV (bloco G8; plano 5.5; README ›
/// decisão 73): o código e a origem padronizados no <c>detalhes</c>, os filtros combinados no SQL (nível, período, origem
/// com o legado <c>app</c> e texto com os curingas do <c>LIKE</c> escapados), o cursor sem repetir nem pular (também com
/// a mesma hora em várias linhas e uma ocorrência nova entre as páginas) e a consulta pelo índice da hora, sem ordenar à
/// parte nem varrer a tabela.
/// </summary>
public class ConsultasLogLocalTests
{
    /// <summary>"Agora" fixo dos testes: 05/11/2026 15:00 UTC.</summary>
    private static readonly DateTimeOffset Agora = new(2026, 11, 5, 15, 0, 0, TimeSpan.Zero);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task GravarAsync(BancoTemporario banco, params LogLocal[] linhas)
    {
        await using var db = banco.Fabrica.CreateDbContext();
        db.LogLocal.AddRange(linhas);
        await db.SaveChangesAsync(Ct);
    }

    [Fact]
    public void Ocorrencia_nova_leva_o_codigo_a_origem_os_dados_e_o_texto_tecnico_no_detalhe()
    {
        var linha = Ocorrencias.Nova(Agora, NiveisOcorrencia.Aviso, CodigoOcorrencia.ImpressaoFalhou, "Cupom não saiu na impressora: sem papel",
            new JsonObject { ["referencia_id"] = "019a", ["codigo"] = "SOBRESCRITO" }, "FalhaImpressoraException: sem papel");
        Assert.Equal((OrigensOcorrencia.Impressora, NiveisOcorrencia.Aviso), (linha.Origem, linha.Nivel));
        var detalhes = JsonNode.Parse(linha.Detalhes!)!.AsObject();
        // O código é o do PDV (os dados não o trocam); os acentos ficam como texto (a busca da aba 5 acha "não").
        Assert.Equal("IMPRESSAO_FALHOU", detalhes["codigo"]!.GetValue<string>());
        Assert.Equal("019a", detalhes["referencia_id"]!.GetValue<string>());
        Assert.Equal("FalhaImpressoraException: sem papel", detalhes["texto"]!.GetValue<string>());
        Assert.Equal("IMPRESSAO_FALHOU", Ocorrencias.CodigoDe(linha.Detalhes));
        Assert.DoesNotContain("\\u00", Ocorrencias.Nova(Agora, "info", CodigoOcorrencia.MensagemErp, "x", texto: "não").Detalhes!, StringComparison.Ordinal);

        // As linhas de antes do G8: texto solto, JSON sem código, nada.
        Assert.Null(Ocorrencias.CodigoDe("usuario_id=019a"));
        Assert.Null(Ocorrencias.CodigoDe("""{"evento_id":"019a"}"""));
        Assert.Null(Ocorrencias.CodigoDe("{quebrado"));
        Assert.Null(Ocorrencias.CodigoDe(null));
        Assert.Throws<ArgumentOutOfRangeException>(() => Ocorrencias.Nova(Agora, "warning", CodigoOcorrencia.MensagemErp, "x"));
        Assert.Equal(OrigensOcorrencia.Sistema, OrigensOcorrencia.Normalizar(OrigensOcorrencia.Legado));
    }

    [Fact]
    public async Task Filtros_de_nivel_periodo_origem_e_texto_combinados_no_sql()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var ontem = Agora.AddDays(-1);
        await GravarAsync(banco,
            Ocorrencias.Nova(ontem, NiveisOcorrencia.Aviso, CodigoOcorrencia.ImpressaoFalhou, "Cupom não saiu na impressora: sem papel"),
            Ocorrencias.Nova(ontem.AddMinutes(5), NiveisOcorrencia.Erro, CodigoOcorrencia.BackupFalhou, "Backup (periodico) não foi feito: disco cheio"),
            Ocorrencias.Nova(Agora.AddMinutes(-10), NiveisOcorrencia.Info, CodigoOcorrencia.GavetaVoltou, "A gaveta voltou a abrir"),
            Ocorrencias.Nova(Agora.AddMinutes(-5), NiveisOcorrencia.Critico, CodigoOcorrencia.ErroInesperado, "Falhou 100% do lote_1"),
            // A linha de antes do G8 (origem "app", sem código): conta como sistema.
            new LogLocal { OcorridoEm = Agora.AddMinutes(-1), Nivel = NiveisOcorrencia.Erro, Origem = OrigensOcorrencia.Legado, Mensagem = "Erro inesperado antigo" },
            Ocorrencias.Nova(Agora.AddDays(-40), NiveisOcorrencia.Erro, CodigoOcorrencia.ImpressaoFalhou, "Muito antiga"));
        var consultas = new ConsultasLogLocal(banco.Fabrica);
        async Task<List<string>> Mensagens(FiltroOcorrencias filtro) => [.. (await consultas.ListarAsync(filtro, ct: Ct)).Ocorrencias.Select(o => o.Mensagem)];

        // A mais nova primeiro; sem filtro, tudo.
        Assert.Equal(6, (await Mensagens(new FiltroOcorrencias())).Count);
        Assert.Equal("Erro inesperado antigo", (await Mensagens(new FiltroOcorrencias()))[0]);
        // "Ontem" pelo intervalo [desde, até).
        Assert.Equal(["Backup (periodico) não foi feito: disco cheio", "Cupom não saiu na impressora: sem papel"],
            await Mensagens(new FiltroOcorrencias(Desde: ontem.AddHours(-1), Ate: Agora.AddHours(-1))));
        // Nível mínimo: aviso traz aviso, erro e crítico; erro, só erro e crítico.
        Assert.Equal(4, (await Mensagens(new FiltroOcorrencias(NiveisOcorrencia.Aviso, Desde: Agora.AddDays(-30)))).Count);
        Assert.Equal(["Erro inesperado antigo", "Falhou 100% do lote_1", "Backup (periodico) não foi feito: disco cheio"],
            await Mensagens(new FiltroOcorrencias(NiveisOcorrencia.Erro, Desde: Agora.AddDays(-30))));
        // Origem: o sistema inclui o legado "app".
        Assert.Equal(["Erro inesperado antigo", "Falhou 100% do lote_1"], await Mensagens(new FiltroOcorrencias(Origem: OrigensOcorrencia.Sistema)));
        Assert.Equal(["Cupom não saiu na impressora: sem papel", "Muito antiga"], await Mensagens(new FiltroOcorrencias(Origem: OrigensOcorrencia.Impressora)));
        // Texto na mensagem ou no detalhe (o código), sem diferença de maiúsculas; o % e o _ digitados são letras.
        Assert.Equal(["Cupom não saiu na impressora: sem papel"], await Mensagens(new FiltroOcorrencias(Texto: "SEM PAPEL", Desde: Agora.AddDays(-30))));
        Assert.Equal(2, (await Mensagens(new FiltroOcorrencias(Texto: "impressao_falhou"))).Count);
        Assert.Equal(["Falhou 100% do lote_1"], await Mensagens(new FiltroOcorrencias(Texto: "100%")));
        Assert.Equal(["Falhou 100% do lote_1"], await Mensagens(new FiltroOcorrencias(Texto: "e_1")));
        Assert.Empty(await Mensagens(new FiltroOcorrencias(Texto: "0_%")));
        // Combinados.
        Assert.Equal(["Backup (periodico) não foi feito: disco cheio"],
            await Mensagens(new FiltroOcorrencias(NiveisOcorrencia.Erro, ontem.AddHours(-1), Agora.AddHours(-1), OrigensOcorrencia.Backup, "disco")));

        var uma = (await consultas.ListarAsync(new FiltroOcorrencias(Origem: OrigensOcorrencia.Backup), ct: Ct)).Ocorrencias.Single();
        Assert.Equal(CodigoOcorrencia.BackupFalhou.Codigo, uma.Codigo);
        Assert.Equal(uma, await consultas.ObterAsync(uma.Id, Ct));
        Assert.Null(await consultas.ObterAsync(-1, Ct));
    }

    [Fact]
    public async Task Paginas_pelo_cursor_sem_repetir_nem_pular_com_a_mesma_hora_e_uma_nova_entre_as_paginas()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        // 137 linhas, de 3 em 3 com a mesma hora (o id desempata).
        await GravarAsync(banco, [.. Enumerable.Range(0, 137).Select(i =>
            Ocorrencias.Nova(Agora.AddMinutes(-(i / 3)), NiveisOcorrencia.Aviso, CodigoOcorrencia.GavetaFalhou, $"linha {i:000}"))]);
        var consultas = new ConsultasLogLocal(banco.Fabrica);
        var vistas = new List<string>();
        CursorOcorrencias? cursor = null;
        var paginas = 0;
        do
        {
            var pagina = await consultas.ListarAsync(new FiltroOcorrencias(), cursor, ct: Ct);
            vistas.AddRange(pagina.Ocorrencias.Select(o => o.Mensagem));
            cursor = pagina.Proxima;
            paginas++;
            if (paginas == 1)
            {
                // A que chega entre as páginas entra no começo (a primeira página, no F5), sem empurrar as outras.
                await GravarAsync(banco, Ocorrencias.Nova(Agora.AddMinutes(1), NiveisOcorrencia.Erro, CodigoOcorrencia.ErroInesperado, "nova"));
            }
        }
        while (cursor is not null);

        Assert.Equal(3, paginas);
        Assert.Equal(137, vistas.Count);
        Assert.Equal(137, vistas.Distinct().Count());
        Assert.DoesNotContain("nova", vistas);
        // Dentro da mesma hora, a gravada depois (o id maior) primeiro.
        Assert.Equal(["linha 002", "linha 001", "linha 000", "linha 005"], vistas.Take(4));
        Assert.Equal("nova", (await consultas.ListarAsync(new FiltroOcorrencias(), ct: Ct)).Ocorrencias[0].Mensagem);
    }

    [Fact]
    public async Task Consulta_entra_pelo_indice_da_hora_sem_ordenar_a_parte()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        await GravarAsync(banco, [.. Enumerable.Range(0, 2_000).Select(i =>
            Ocorrencias.Nova(Agora.AddMinutes(-i), i % 7 == 0 ? NiveisOcorrencia.Erro : NiveisOcorrencia.Info, CodigoOcorrencia.GavetaVoltou, $"linha {i}"))]);
        using (var conexao = banco.AbrirConexao())
        using (var analisar = conexao.CreateCommand())
        {
            analisar.CommandText = "ANALYZE";
            analisar.ExecuteNonQuery();
        }

        var planos = new ConsultasHistoricoLocalTests.PlanosDasConsultas();
        var consultas = new ConsultasLogLocal(planos.Fabrica(banco.Fabrica.StringConexao));
        var primeira = await consultas.ListarAsync(new FiltroOcorrencias(NiveisOcorrencia.Erro, Agora.AddDays(-1)), ct: Ct);
        await consultas.ListarAsync(new FiltroOcorrencias(NiveisOcorrencia.Erro, Agora.AddDays(-1)), primeira.Proxima, ct: Ct);
        await consultas.ListarAsync(new FiltroOcorrencias(Texto: "linha 5"), ct: Ct);
        var doLog = planos.Planos.Where(p => p.Sql.Contains("FROM \"log_local\"", StringComparison.Ordinal)).ToList();
        Assert.Equal(3, doLog.Count);
        Assert.All(doLog, p =>
        {
            Assert.Contains("ix_log_local_ocorrido_em", p.Plano, StringComparison.Ordinal);
            Assert.DoesNotContain("TEMP B-TREE", p.Plano, StringComparison.Ordinal);
        });
    }
}
