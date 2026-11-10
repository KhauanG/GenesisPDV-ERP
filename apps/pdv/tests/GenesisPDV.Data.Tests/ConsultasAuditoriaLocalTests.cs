using System.Globalization;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Backup;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using static GenesisPDV.Data.Tests.ConsultasHistoricoLocalTests;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// O <c>log_auditoria_local</c> para a aba 6 Histórico de uso da Central do PDV (bloco G10; plano 4.4; README › decisão
/// 74): os filtros combinados no SQL (período, quem fez, as ações do grupo e o texto com os curingas do <c>LIKE</c>
/// escapados), o cursor sem repetir nem pular (também com vários registros no mesmo instante e um novo entre as páginas),
/// a situação do lote em que o registro subiu, as contagens do resumo por operador e as vendas e os descontos dele (o do
/// item sem a promoção, o do total sem os cascos, só das vendas que continuam pagas, só deste terminal), e o desempenho
/// com um ano de auditoria (200 mil registros) e 120 mil vendas: cada consulta abaixo de 300 ms, pelos índices da
/// migração <c>IndicesHistoricoUso</c>, sem varrer a tabela.
/// </summary>
[Collection(ColecaoVolumeSintetico.Nome)]
public class ConsultasAuditoriaLocalTests
{
    private static readonly DateTimeOffset Agora = new(2026, 11, 5, 15, 0, 0, TimeSpan.Zero);
    private static readonly Guid Terminal = Guid.Parse("019a0000-0000-7000-8000-00000000c002");
    private static readonly Guid OutroTerminal = Guid.Parse("019a0000-0000-7000-8000-00000000c003");
    private static readonly Guid Loja = Guid.Parse("019a0000-0000-7000-8000-00000000a001");
    private static readonly Guid Caixa = Guid.Parse("019a0000-0000-7000-8000-00000000b002");
    private static readonly Guid Maria = Guid.Parse("019a0003-0000-7000-8000-000000000001");
    private static readonly Guid Carlos = Guid.Parse("019a0003-0000-7000-8000-000000000002");
    private static readonly Guid Joao = Guid.Parse("019a0003-0000-7000-8000-000000000003");

    /// <summary>Quem só libera (decisão 78): nunca é o <c>usuario_id</c>, só o <c>autorizado_por_id</c> de poucos registros.</summary>
    private static readonly Guid Supervisor = Guid.Parse("019a0003-0000-7000-8000-000000000006");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static LogAuditoriaLocal Registro(DateTimeOffset quando, string acao, Guid? usuario, string? descricao = null, Guid? autorizado = null,
        string? motivo = null, Guid? evento = null, Guid? registro = null, string? depois = null) => new()
        {
            Id = Guid.CreateVersion7(),
            OcorridoEm = quando,
            UsuarioId = usuario,
            AutorizadoPorId = autorizado,
            Acao = acao,
            Entidade = "pdv",
            RegistroId = registro,
            Localizacao = "pdv.venda",
            Descricao = descricao,
            Motivo = motivo,
            Depois = depois,
            EventoId = evento,
        };

    private static EventoSaida Lote(DateTimeOffset quando, long sequencia, string status, string? resultado = null) => new()
    {
        Id = Guid.CreateVersion7(),
        SequenciaTerminal = sequencia,
        Tipo = "auditoria.registros",
        AgregadoTipo = "auditoria",
        AgregadoId = Guid.CreateVersion7(),
        OcorridoEm = quando,
        CriadoEm = quando,
        Status = status,
        Resultado = resultado,
        PayloadSha256 = new string('0', 64),
    };

    private static async Task GravarAsync(BancoTemporario banco, params object[] linhas)
    {
        await using var db = banco.Fabrica.CreateDbContext();
        db.AddRange(linhas);
        await db.SaveChangesAsync(Ct);
    }

    [Fact]
    public async Task Migracao_dos_indices_roda_depois_do_backup_e_a_auditoria_de_antes_fica()
    {
        using var banco = new BancoTemporario();
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.GetService<IMigrator>().MigrateAsync("20261105030350_IndiceFilaImpressaoDocumento", Ct);
        }

        using (var conexao = banco.AbrirConexao())
        {
            Executar(conexao, "insert into log_auditoria_local (id, ocorrido_em, usuario_id, acao, descricao) values "
                + $"('{Guid.CreateVersion7():D}', '2026-11-04T12:00:00.000Z', '{Maria:D}', 'login', 'Login de MARIA')");
        }

        var resultado = await banco.InicializarAsync();
        Assert.Equal(["20261105074432_IndicesHistoricoUso"], resultado.MigracoesAplicadas.Where(m => m.EndsWith("_IndicesHistoricoUso", StringComparison.Ordinal)));
        // O backup "antes-migracao" de sempre (C17) foi feito antes de criar os índices.
        Assert.Contains(MotivosBackup.AntesMigracao, resultado.ArquivoBackup, StringComparison.Ordinal);
        foreach (var indice in new[] { "ix_log_auditoria_local_ocorrido_em", "ix_log_auditoria_local_usuario_ocorrido_em", "ix_log_auditoria_local_acao_ocorrido_em" })
        {
            Assert.Equal(1L, banco.Escalar($"select count(*) from sqlite_master where type = 'index' and name = '{indice}'"));
        }

        var registro = Assert.Single((await new ConsultasAuditoriaLocal(banco.Fabrica).ListarAsync(new FiltroAuditoria(UsuarioId: Maria), ct: Ct)).Registros);
        Assert.Equal("Login de MARIA", registro.Descricao);
    }

    [Fact]
    public async Task Migracao_do_indice_de_quem_liberou_roda_depois_do_backup_e_a_liberacao_de_antes_entra_no_filtro()
    {
        // Decisão 78: o filtro "Quem" também pelo que a pessoa liberou com o PIN, pelo (autorizado_por_id, ocorrido_em).
        using var banco = new BancoTemporario();
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.GetService<IMigrator>().MigrateAsync("20261105074432_IndicesHistoricoUso", Ct);
        }

        using (var conexao = banco.AbrirConexao())
        {
            Executar(conexao, "insert into log_auditoria_local (id, ocorrido_em, usuario_id, autorizado_por_id, acao, descricao) values "
                + $"('{Guid.CreateVersion7():D}', '2026-11-04T12:00:00.000Z', '{Maria:D}', '{Carlos:D}', 'liberacao', 'Desconto liberado')");
        }

        var resultado = await banco.InicializarAsync();
        // A migração do índice e as seguintes (a do F2-B36, a FTS5 da pesquisa, veio depois).
        Assert.Equal("20261105131203_IndiceAuditoriaAutorizadoPor", resultado.MigracoesAplicadas[0]);
        Assert.Contains(MotivosBackup.AntesMigracao, resultado.ArquivoBackup, StringComparison.Ordinal);
        Assert.Equal(1L, banco.Escalar("select count(*) from sqlite_master where type = 'index' and name = 'ix_log_auditoria_local_autorizado_ocorrido_em'"));
        var registro = Assert.Single((await new ConsultasAuditoriaLocal(banco.Fabrica).ListarAsync(new FiltroAuditoria(UsuarioId: Carlos), ct: Ct)).Registros);
        Assert.Equal(("Desconto liberado", (Guid?)Maria), (registro.Descricao, registro.UsuarioId));
    }

    [Fact]
    public async Task Filtros_de_periodo_quem_grupo_e_texto_combinados_no_sql_com_a_situacao_do_lote()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var ontem = Agora.AddDays(-1);
        var confirmado = Lote(ontem, 1, StatusEventoSaida.Confirmado);
        // O lote que o ERP descartou fica `rejeitado`; só o `resultado` diz que foi descartado.
        var descartado = Lote(ontem, 2, StatusEventoSaida.Rejeitado, """{"descartado":true}""");
        await GravarAsync(banco, confirmado, descartado,
            Registro(ontem, "login", Maria, "Login de MARIA", evento: confirmado.Id),
            Registro(ontem.AddMinutes(5), "desconto_item", Maria, "Desconto de R$ 2,00 (10,00%) no item 1"),
            Registro(ontem.AddMinutes(9), "gaveta_aberta", Joao, "Gaveta aberta sem venda (F11 › 9)", motivo: "troco para o vizinho", evento: descartado.Id),
            Registro(Agora.AddMinutes(-10), "item_cancelado", Maria, "Item 2 cancelado: 100% do lote_1", Carlos),
            Registro(Agora.AddMinutes(-5), "liberacao", Maria, "Desconto no total liberado pelo supervisor", Carlos),
            Registro(Agora.AddMinutes(-1), "relogio_regrediu", null, "Relógio voltou"),
            Registro(Agora.AddDays(-40), "login", Joao, "Login antigo"));
        var consultas = new ConsultasAuditoriaLocal(banco.Fabrica);
        async Task<List<string?>> Descricoes(FiltroAuditoria filtro) => [.. (await consultas.ListarAsync(filtro, ct: Ct)).Registros.Select(r => r.Descricao)];

        // O mais novo primeiro; sem filtro, tudo.
        var todos = (await consultas.ListarAsync(new FiltroAuditoria(), ct: Ct)).Registros;
        Assert.Equal(7, todos.Count);
        Assert.Equal("relogio_regrediu", todos[0].Acao);
        // A situação do lote vem do outbox (o login subiu e foi confirmado; a gaveta foi num lote que o ERP descartou).
        Assert.Equal(StatusEventoSaida.Confirmado, todos.Single(r => r.Descricao == "Login de MARIA").StatusEvento);
        var gaveta = todos.Single(r => r.Acao == "gaveta_aberta");
        Assert.Equal((StatusEventoSaida.Rejeitado, true), (gaveta.StatusEvento, ConsultasVendaLocal.Descartado(gaveta.ResultadoEvento)));
        Assert.All(todos.Where(r => r.Descricao != "Login de MARIA" && r.Acao != "gaveta_aberta"), r => Assert.Null(r.StatusEvento));
        Assert.All(todos, r => Assert.Null(r.VendaPaga));
        // "Ontem" pelo intervalo [desde, até).
        Assert.Equal(["Gaveta aberta sem venda (F11 › 9)", "Desconto de R$ 2,00 (10,00%) no item 1", "Login de MARIA"],
            await Descricoes(new FiltroAuditoria(ontem.AddHours(-1), Agora.AddHours(-1))));
        // A pessoa: o que ela fez e o que ela liberou com o PIN (dono, 05/11/2026; decisão 78) — o CARLOS não fez nada, mas
        // liberou o item cancelado e o desconto no total da MARIA; quem liberou continua no AutorizadoPorId.
        Assert.Equal(4, (await Descricoes(new FiltroAuditoria(UsuarioId: Maria))).Count);
        var doCarlos = (await consultas.ListarAsync(new FiltroAuditoria(UsuarioId: Carlos), ct: Ct)).Registros;
        Assert.Equal(["Desconto no total liberado pelo supervisor", "Item 2 cancelado: 100% do lote_1"], doCarlos.Select(r => r.Descricao));
        Assert.All(doCarlos, r => Assert.Equal((Maria, Carlos), (r.UsuarioId!.Value, r.AutorizadoPorId!.Value)));
        Assert.Empty(await Descricoes(new FiltroAuditoria(UsuarioId: Joao, Acoes: ["item_cancelado", "liberacao"])));
        // O grupo é a lista de ações.
        Assert.Equal(["Gaveta aberta sem venda (F11 › 9)"], await Descricoes(new FiltroAuditoria(Acoes: ["gaveta_aberta", "reimpressao"])));
        // O texto na descrição ou no motivo, sem diferença de acento nem de maiúscula (a pré-seleção); o % e o _ são letras.
        Assert.Equal(["Gaveta aberta sem venda (F11 › 9)"], await Descricoes(new FiltroAuditoria(Texto: "VIZINHO")));
        Assert.Contains("Relógio voltou", await Descricoes(new FiltroAuditoria(Texto: "relogio")));
        Assert.Equal(["Item 2 cancelado: 100% do lote_1"], await Descricoes(new FiltroAuditoria(Texto: "100%")));
        Assert.Equal(["Item 2 cancelado: 100% do lote_1"], await Descricoes(new FiltroAuditoria(Texto: "lote_1")));
        Assert.Empty(await Descricoes(new FiltroAuditoria(Texto: "lote_2")));
        // As ações cuja frase tem o texto também entram (a "gaveta" da frase, mesmo sem a palavra na descrição).
        Assert.Equal(2, (await Descricoes(new FiltroAuditoria(Texto: "xyz", AcoesDoTexto: ["login"]))).Count);
        // Combinados: Maria, ontem, vendas.
        Assert.Equal(["Desconto de R$ 2,00 (10,00%) no item 1"],
            await Descricoes(new FiltroAuditoria(ontem.AddHours(-1), Agora.AddHours(-1), Maria, ["desconto_item", "item_cancelado"])));
        // O detalhe pelo id.
        var um = todos[3];
        Assert.Equal(um, await consultas.ObterAsync(um.Id, Ct));
        Assert.Null(await consultas.ObterAsync(Guid.CreateVersion7(), Ct));
        // Quem fez ou liberou alguma coisa no período (o caixa sozinho fica de fora; o CARLOS só liberou e entra).
        Assert.Equal([Joao, Carlos, Maria], (await consultas.UsuariosAsync(Agora.AddDays(-2), null, Ct)).OrderByDescending(g => g.ToString()));
        Assert.Equal([Maria], await consultas.UsuariosAsync(ontem.AddHours(-1), ontem.AddMinutes(6), Ct));
    }

    [Fact]
    public async Task Cursor_percorre_tudo_sem_repetir_nem_pular_com_a_mesma_hora_e_um_registro_novo_entre_as_paginas()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        // 137 registros em grupos de 7 com a mesma hora (o desempate é o id).
        var registros = Enumerable.Range(0, 137).Select(i => Registro(Agora.AddMinutes(-(i / 7)), "login", Maria, $"r{i}")).ToArray();
        await GravarAsync(banco, registros.Cast<object>().ToArray());
        var consultas = new ConsultasAuditoriaLocal(banco.Fabrica);
        var vistos = new List<Guid>();
        CursorAuditoria? cursor = null;
        LogAuditoriaLocal? mesmoInstante = null;
        var paginas = 0;
        do
        {
            var pagina = await consultas.ListarAsync(new FiltroAuditoria(), cursor, tamanho: 20, ct: Ct);
            Assert.True(pagina.Registros.Count is > 0 and <= 20);
            vistos.AddRange(pagina.Registros.Select(r => r.Id));
            cursor = pagina.Proxima;
            paginas++;
            if (paginas == 2)
            {
                // Um registro novo entre as páginas entra na primeira, não na seguinte.
                await GravarAsync(banco, Registro(Agora.AddMinutes(1), "logout", Maria, "novo"));
            }

            if (paginas == 3)
            {
                // Mais um no mesmo milissegundo do cursor (raro: dois registros gravados no mesmo instante): aparece uma vez
                // na página seguinte, e nenhum dos de antes se repete nem some.
                mesmoInstante = Registro(cursor!.OcorridoEm, "logout", Maria, "mesmo instante");
                await GravarAsync(banco, mesmoInstante);
            }
        }
        while (cursor is not null);

        Assert.Equal(7, paginas);
        Assert.Equal(138, vistos.Count);
        Assert.Equal(138, vistos.Distinct().Count());
        Assert.Contains(mesmoInstante!.Id, vistos);
        Assert.Equal(registros.OrderByDescending(r => r.OcorridoEm).ThenByDescending(r => r.Id.ToString()).Select(r => r.Id), vistos.Where(v => v != mesmoInstante.Id));

        // A página exata (137 de 137) não deixa uma página vazia depois.
        var exata = await consultas.ListarAsync(new FiltroAuditoria(Acoes: ["login"]), tamanho: 137, ct: Ct);
        Assert.Equal((137, (CursorAuditoria?)null), (exata.Registros.Count, exata.Proxima));
    }

    [Fact]
    public async Task Resumo_por_operador_conta_as_acoes_as_liberacoes_dadas_a_atividade_e_os_descontos_das_vendas_pagas()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var desde = Agora.AddDays(-7);
        await GravarAsync(banco,
            Registro(Agora.AddHours(-5), "login", Maria),
            Registro(Agora.AddHours(-4), "login", Maria),
            Registro(Agora.AddHours(-3), "desconto_item", Maria),
            Registro(Agora.AddHours(-2), "liberacao", Maria, autorizado: Carlos),
            Registro(Agora.AddHours(-2), "liberacao", Joao, autorizado: Carlos),
            // A liberação "dada" a si mesmo (o gerente que entra pela Central com a permissão, o supervisor que libera o
            // próprio caixa com o disco cheio) não conta como dada nem como pedida.
            Registro(Agora.AddHours(-1), "liberacao", Carlos, autorizado: Carlos),
            Registro(Agora.AddHours(-1), "gaveta_aberta", Joao),
            // Fora do período.
            Registro(Agora.AddDays(-9), "login", Maria));
        var consultas = new ConsultasAuditoriaLocal(banco.Fabrica);
        var contagens = await consultas.ContagensAsync(desde, null, ["login", "desconto_item", "liberacao", "gaveta_aberta"], Ct);
        Assert.Equal(2, contagens.Single(c => c.UsuarioId == Maria && c.Acao == "login").Quantidade);
        Assert.Equal(1, contagens.Single(c => c.UsuarioId == Joao && c.Acao == "gaveta_aberta").Quantidade);
        Assert.Equal(new Dictionary<Guid, int> { [Carlos] = 2 }, await consultas.LiberacoesDadasAsync(desde, null, "liberacao", Ct));
        Assert.Equal(new Dictionary<Guid, int> { [Maria] = 1, [Joao] = 1 }, await consultas.LiberacoesPedidasAsync(desde, null, "liberacao", Ct));
        var atividade = Assert.Single(await consultas.AtividadeAsync([Maria], desde, null, Ct));
        Assert.Equal((Agora.AddHours(-5), Agora.AddHours(-2)), (atividade.Primeira, atividade.Ultima));
        Assert.Empty(await consultas.AtividadeAsync([Guid.CreateVersion7()], desde, null, Ct));

        // As vendas: a sessão deste terminal na semana, uma antiga, e uma de outro terminal.
        var sessao = SessaoDe(Agora.AddDays(-2), Agora.AddDays(-1), Terminal);
        var aberta = SessaoDe(Agora.AddHours(-6), null, Terminal);
        var antiga = SessaoDe(Agora.AddDays(-20), Agora.AddDays(-19), Terminal);
        var outra = SessaoDe(Agora.AddHours(-6), null, OutroTerminal);
        await GravarAsync(banco, sessao, aberta, antiga, outra);
        // Maria: uma com desconto no item (2,00) e promoção (5,00: é da loja, não conta), uma com desconto no total de 8,00
        // com 3,00 de cascos (conta 5,00), uma sem desconto, uma paga e cancelada depois (conta como venda, o desconto não).
        var comItem = VendaDe(sessao, Agora.AddDays(-2).AddHours(1), Maria, descontoItem: 2m, promocao: 5m);
        var comTotal = VendaDe(aberta, Agora.AddHours(-1), Maria, descontoTotal: 8m);
        var cascos = new CascoDescontadoVendaLocal
        {
            VendaId = comTotal.Id,
            ProdutoVasilhameId = Guid.CreateVersion7(),
            Descricao = "Casco 600",
            Quantidade = 2,
            PrecoUnitario = 1.5m,
            RegistradoEm = Agora,
        };
        var semDesconto = VendaDe(aberta, Agora.AddMinutes(-50), Maria);
        var cancelada = VendaDe(aberta, Agora.AddMinutes(-40), Maria, descontoItem: 4m, cancelada: Agora.AddMinutes(-30));
        // O item cancelado não conta o desconto dele.
        var itemCancelado = VendaDe(aberta, Agora.AddMinutes(-20), Joao, descontoItem: 1m, itemCancelado: true);
        // Fora: a de 20 dias atrás e a de outro terminal.
        var velha = VendaDe(antiga, Agora.AddDays(-20).AddHours(1), Maria, descontoItem: 9m);
        var deOutro = VendaDe(outra, Agora.AddHours(-1), Maria, descontoItem: 9m);
        await GravarAsync(banco, comItem, comTotal, cascos, semDesconto, cancelada, itemCancelado, velha, deOutro);
        var vendas = (await consultas.VendasPorOperadorAsync(Terminal, desde, null, Ct)).ToDictionary(v => v.OperadorId);
        Assert.Equal(new VendasDoOperador(Maria, 4, 2, 7m), vendas[Maria]);
        Assert.Equal(new VendasDoOperador(Joao, 1, 0, 0m), vendas[Joao]);
        // "Ontem" pela hora do pagamento.
        var soAntesDeOntem = await consultas.VendasPorOperadorAsync(Terminal, Agora.AddDays(-3), Agora.AddDays(-1), Ct);
        Assert.Equal(new VendasDoOperador(Maria, 1, 1, 2m), Assert.Single(soAntesDeOntem));
        Assert.Empty(await consultas.VendasPorOperadorAsync(Guid.CreateVersion7(), desde, null, Ct));
    }

    [Fact]
    public async Task Cancelamento_de_venda_paga_e_em_andamento_se_separam_pela_venda()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var aberta = SessaoDe(Agora.AddHours(-6), null, Terminal);
        // A paga e depois cancelada (F12: finalizada_em fica) e a em andamento cancelada (Shift+F4: nunca foi paga).
        var paga = VendaDe(aberta, Agora.AddHours(-3), Maria, cancelada: Agora.AddHours(-2));
        var emAndamento = VendaDe(aberta, Agora.AddHours(-2), Maria);
        emAndamento.FinalizadaEm = null;
        emAndamento.Status = StatusVenda.Cancelada;
        emAndamento.CanceladaEm = Agora.AddHours(-2);
        emAndamento.MotivoCancelamento = "Cliente desistiu da compra";
        await GravarAsync(banco, aberta, paga, emAndamento);
        var semVenda = Guid.CreateVersion7();
        await GravarAsync(banco,
            // As duas pelo caminho normal: a mesma ação `venda_cancelada`.
            Registro(Agora.AddHours(-2), "venda_cancelada", Maria, "Venda paga cancelada", registro: paga.Id, depois: """{"sai_da_gaveta":"50.00"}"""),
            Registro(Agora.AddHours(-2).AddMinutes(1), "venda_cancelada", Maria, "Venda em andamento cancelada", Carlos, registro: emAndamento.Id),
            // A em andamento sem o evento (fora da sessão, T13).
            Registro(Agora.AddHours(-1), "cancelar", Joao, "Venda em andamento cancelada (1B)", registro: Guid.CreateVersion7()),
            // Sem a venda no banco: pelo `sai_da_gaveta`, que só o cancelamento da paga grava.
            Registro(Agora.AddMinutes(-30), "venda_cancelada", Joao, "Venda paga de outro banco", registro: semVenda, depois: """{"sai_da_gaveta":"10.00"}"""),
            Registro(Agora.AddMinutes(-20), "venda_cancelada", Joao, "Venda em andamento de outro banco", registro: Guid.CreateVersion7()),
            // Fora do período.
            Registro(Agora.AddDays(-9), "venda_cancelada", Maria, "Antiga", registro: paga.Id));
        var consultas = new ConsultasAuditoriaLocal(banco.Fabrica);
        var desde = Agora.AddDays(-7);
        var cancelamentos = (await consultas.CancelamentosDeVendaAsync(desde, null, Ct)).ToDictionary(c => c.UsuarioId);
        Assert.Equal(new CancelamentosDeVenda(Maria, 1, 1), cancelamentos[Maria]);
        Assert.Equal(new CancelamentosDeVenda(Joao, 1, 2), cancelamentos[Joao]);

        // A lista e o detalhe trazem a marca; as outras ações ficam sem.
        var lista = (await consultas.ListarAsync(new FiltroAuditoria(desde), ct: Ct)).Registros.ToDictionary(r => r.Descricao!);
        Assert.Equal(true, lista["Venda paga cancelada"].VendaPaga);
        Assert.Equal(false, lista["Venda em andamento cancelada"].VendaPaga);
        Assert.Equal(true, lista["Venda paga de outro banco"].VendaPaga);
        Assert.Equal(false, lista["Venda em andamento de outro banco"].VendaPaga);
        Assert.Null(lista["Venda em andamento cancelada (1B)"].VendaPaga);
        Assert.Equal(false, (await consultas.ObterAsync(lista["Venda em andamento cancelada"].Id, Ct))!.VendaPaga);
    }

    [Fact]
    public async Task Um_ano_de_auditoria_e_120_mil_vendas_ficam_abaixo_de_300_ms_pelos_indices()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        const int dias = 90;
        const int vendas = 120_000;
        const int registros = 200_000;
        var inicioVendas = new DateTimeOffset(Agora.UtcDateTime.Date, TimeSpan.Zero).AddDays(-(dias - 1)).AddHours(8);
        var inicioAuditoria = Agora.AddDays(-365);
        using (var conexao = banco.AbrirConexao())
        {
            Executar(conexao, Sql.Sessoes, ("@dias", (object)dias), ("@inicio", (object)inicioVendas.ToUnixTimeSeconds()), ("@terminal", (object)Terminal.ToString()),
                ("@loja", (object)Loja.ToString()), ("@caixa", (object)Caixa.ToString()), ("@operador", (object)Maria.ToString()));
            Executar(conexao, Sql.Vendas, ("@total", (object)vendas), ("@porDia", (object)((vendas + dias - 1) / dias)), ("@inicio", (object)inicioVendas.ToUnixTimeSeconds()),
                ("@terminal", (object)Terminal.ToString()), ("@loja", (object)Loja.ToString()), ("@caixa", (object)Caixa.ToString()),
                ("@maria", (object)Maria.ToString()), ("@joao", (object)Joao.ToString()));
            Executar(conexao, Auditoria, ("@total", (object)registros), ("@inicio", (object)inicioAuditoria.ToUnixTimeSeconds()),
                ("@passo", (object)(365 * 86400 / registros)), ("@maria", (object)Maria.ToString()), ("@joao", (object)Joao.ToString()),
                ("@carlos", (object)Carlos.ToString()), ("@supervisor", (object)Supervisor.ToString()));
            Executar(conexao, "analyze");
        }

        Assert.Equal((long)registros, banco.Escalar("select count(*) from log_auditoria_local"));
        var planos = new PlanosDasConsultas();
        var consultas = new ConsultasAuditoriaLocal(planos.Fabrica(banco.Fabrica.StringConexao));
        var semana = Agora.AddDays(-7);
        var mes = Agora.AddDays(-30);
        PaginaAuditoria? primeira = null;
        var tempos = new Dictionary<string, TimeSpan>
        {
            ["7 dias"] = await MedirAsync(async () => primeira = await consultas.ListarAsync(new FiltroAuditoria(semana), ct: Ct)),
            ["página seguinte"] = await MedirAsync(() => consultas.ListarAsync(new FiltroAuditoria(semana), primeira!.Proxima, ct: Ct)),
            ["tudo"] = await MedirAsync(() => consultas.ListarAsync(new FiltroAuditoria(), ct: Ct)),
            ["30 dias, quem"] = await MedirAsync(() => consultas.ListarAsync(new FiltroAuditoria(mes, UsuarioId: Joao), ct: Ct)),
            ["30 dias, quem liberou"] = await MedirAsync(() => consultas.ListarAsync(new FiltroAuditoria(mes, UsuarioId: Supervisor), ct: Ct)),
            ["30 dias, grupo"] = await MedirAsync(() => consultas.ListarAsync(new FiltroAuditoria(mes, Acoes: ["gaveta_aberta", "reimpressao"]), ct: Ct)),
            ["tudo, grupo raro"] = await MedirAsync(() => consultas.ListarAsync(new FiltroAuditoria(Acoes: ["sangria_recusada"]), ct: Ct)),
            ["7 dias, texto que não existe"] = await MedirAsync(() => consultas.ListarAsync(new FiltroAuditoria(semana, Texto: "não existe"), ct: Ct)),
            ["quem no mês"] = await MedirAsync(() => consultas.UsuariosAsync(mes, null, Ct)),
            ["contagens do mês"] = await MedirAsync(() => consultas.ContagensAsync(mes, null, ["login", "desconto_item", "item_cancelado", "gaveta_aberta", "liberacao"], Ct)),
            ["liberações dadas no mês"] = await MedirAsync(() => consultas.LiberacoesDadasAsync(mes, null, "liberacao", Ct)),
            ["liberações pedidas no mês"] = await MedirAsync(() => consultas.LiberacoesPedidasAsync(mes, null, "liberacao", Ct)),
            ["cancelamentos de venda no mês"] = await MedirAsync(() => consultas.CancelamentosDeVendaAsync(mes, null, Ct)),
            ["atividade no mês"] = await MedirAsync(() => consultas.AtividadeAsync([Maria, Joao, Carlos], mes, null, Ct)),
            ["vendas da semana"] = await MedirAsync(() => consultas.VendasPorOperadorAsync(Terminal, semana, null, Ct)),
            ["vendas do mês"] = await MedirAsync(() => consultas.VendasPorOperadorAsync(Terminal, mes, null, Ct)),
        };
        Assert.Equal(ConsultasAuditoriaLocal.TamanhoPagina, primeira!.Registros.Count);
        Assert.All(tempos, x => Assert.True(x.Value < ColecaoVolumeSintetico.TetoConsulta, $"{x.Key}: {x.Value.TotalMilliseconds:0} ms"));
        TestContext.Current.SendDiagnosticMessage(string.Join("; ", tempos.Select(x => $"{x.Key} {x.Value.TotalMilliseconds:0} ms")));

        // O log_auditoria_local entra sempre por um dos índices novos (nunca a tabela inteira); a lista pelo período sai na
        // ordem do (ocorrido_em, id), sem ordenar à parte; as vendas pelas sessões do período (algumas por dia).
        var auditoria = planos.Planos.Where(p => p.Sql.Contains("FROM \"log_auditoria_local\"", StringComparison.Ordinal)).ToList();
        Assert.NotEmpty(auditoria);
        Assert.All(auditoria, p => Assert.Contains("ix_log_auditoria_local_", p.Plano, StringComparison.Ordinal));
        Assert.All(auditoria, p => Assert.DoesNotMatch(@"SCAN l( |$)(?!USING)", p.Plano));
        Assert.Contains(auditoria, p => p.Plano.Contains("ix_log_auditoria_local_usuario_ocorrido_em", StringComparison.Ordinal));
        Assert.Contains(auditoria, p => p.Plano.Contains("ix_log_auditoria_local_autorizado_ocorrido_em", StringComparison.Ordinal));
        Assert.Contains(auditoria, p => p.Plano.Contains("ix_log_auditoria_local_acao_ocorrido_em", StringComparison.Ordinal));
        Assert.Contains(auditoria, p => p.Plano.Contains("ix_log_auditoria_local_ocorrido_em", StringComparison.Ordinal) && !p.Plano.Contains("TEMP B-TREE", StringComparison.Ordinal));
        var leituraVendas = planos.Planos.Where(p => p.Sql.Contains("FROM \"vendas\"", StringComparison.Ordinal) || p.Sql.Contains("FROM \"itens_venda\"", StringComparison.Ordinal)).ToList();
        Assert.NotEmpty(leituraVendas);
        Assert.All(leituraVendas, p => Assert.DoesNotMatch(@"SCAN (?!s( |$))", p.Plano));
    }

    /// <summary>
    /// Um ano de auditoria (cerca de 550 registros por dia), três pessoas alternadas, oito ações (a sangria recusada não
    /// aparece: o grupo raro), uma liberação em dez pelo CARLOS e uma em mil pelo SUPERVISOR, que só libera.
    /// </summary>
    private static readonly string Auditoria = """
        with recursive n(i) as (select 0 union all select i + 1 from n where i < @total - 1)
        insert into log_auditoria_local (id, ocorrido_em, usuario_id, autorizado_por_id, acao, entidade, localizacao, descricao)
        select printf('00000000-0000-7000-c000-%012d', i), strftime('%Y-%m-%dT%H:%M:%S.000Z', @inicio + i * @passo, 'unixepoch'),
            case i % 3 when 0 then @maria when 1 then @joao else @carlos end, case when i % 10 = 0 then @carlos when i % 1000 = 7 then @supervisor end,
            case i % 8 when 0 then 'login' when 1 then 'desconto_item' when 2 then 'item_cancelado' when 3 then 'gaveta_aberta'
                when 4 then 'liberacao' when 5 then 'central_acessada' when 6 then 'reimpressao' else 'logout' end,
            'pdv', 'pdv.venda', printf('Registro sintético %d da venda L01-C02-%06d', i, i)
        from n
        """;

    private static SessaoCaixaRegistro SessaoDe(DateTimeOffset aberta, DateTimeOffset? fechada, Guid terminal) => new()
    {
        Id = Guid.CreateVersion7(),
        LojaId = Loja,
        CaixaId = Caixa,
        NumeroCaixa = 2,
        TerminalId = terminal,
        OperadorId = Maria,
        Status = fechada is null ? StatusSessaoCaixa.Aberta : StatusSessaoCaixa.Fechada,
        DiaOperacional = DateOnly.FromDateTime(aberta.UtcDateTime),
        AbertaEm = aberta,
        FechadaEm = fechada,
        CriadoEm = aberta,
        AtualizadoEm = fechada ?? aberta,
        Versao = 1,
    };

    private static long _numero = 700_000;

    /// <summary>Uma venda paga de 50,00 com um item (o desconto do item, a promoção e o desconto no total como pedidos).</summary>
    private static VendaRegistro VendaDe(SessaoCaixaRegistro sessao, DateTimeOffset hora, Guid operador, decimal descontoItem = 0m, decimal promocao = 0m,
        decimal descontoTotal = 0m, DateTimeOffset? cancelada = null, bool itemCancelado = false)
    {
        var numero = Interlocked.Increment(ref _numero);
        var id = Guid.CreateVersion7();
        var bruto = 50m;
        var venda = new VendaRegistro
        {
            Id = id,
            Numero = numero,
            NumeroExibicao = string.Create(CultureInfo.InvariantCulture, $"L01-C02-{numero:000000}"),
            LojaId = Loja,
            CaixaId = Caixa,
            NumeroCaixa = 2,
            TerminalId = sessao.TerminalId,
            SessaoCaixaId = sessao.Id,
            OperadorId = operador,
            IniciadaEm = hora.AddMinutes(-1),
            FinalizadaEm = hora,
            CanceladaEm = cancelada,
            MotivoCancelamento = cancelada is null ? null : "Cliente desistiu da compra",
            Status = cancelada is null ? StatusVenda.Finalizada : StatusVenda.Cancelada,
            QtdItens = 1,
            SubtotalBruto = bruto,
            DescontoItens = descontoItem + promocao,
            DescontoTotal = descontoTotal,
            Total = bruto - descontoItem - promocao - descontoTotal,
            DiaOperacional = DateOnly.FromDateTime(hora.UtcDateTime),
            CriadoEm = hora,
            AtualizadoEm = hora,
            Versao = 1,
        };
        venda.Itens.Add(new ItemVendaRegistro
        {
            Id = Guid.CreateVersion7(),
            VendaId = id,
            Sequencia = 1,
            ProdutoId = Guid.CreateVersion7(),
            Descricao = "Cerveja",
            Unidade = "UN",
            Quantidade = 1m,
            PrecoTabela = bruto,
            PrecoUnitario = bruto,
            ValorBruto = bruto,
            DescontoItem = descontoItem,
            DescontoPromocao = promocao,
            PromocaoId = promocao > 0m ? Guid.CreateVersion7() : null,
            ValorLiquido = bruto - descontoItem - promocao,
            Cancelado = itemCancelado,
            CanceladoEm = itemCancelado ? hora.AddSeconds(-30) : null,
            CriadoEm = hora,
            AtualizadoEm = hora,
            Versao = 1,
        });
        return venda;
    }
}
