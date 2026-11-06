using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using static GenesisPDV.Data.Tests.ConsultasHistoricoLocalTests;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// As consultas da aba 4 Sincronização da Central (bloco G7; o pedido do dono de 04/11/2026, "vendas a copiar"): uma linha
/// por venda não confirmada (as recusadas primeiro, com o motivo; a confirmada e a descartada no ERP fora), o caixa não
/// confirmado, o outbox inteiro por situação e tipo, a paginação estável (sem repetir nem pular, também com eventos novos
/// entre as páginas), o detalhe com as dependências e as ocorrências ligadas, os comandos, <b>nunca o payload nem o
/// contexto</b> (nem nos tipos, nem no SQL) e o desempenho com o volume sintético do G5 (120 mil vendas e o outbox delas) e
/// alguns milhares de vendas ainda na fila, pelo índice da situação.
/// </summary>
[Collection(ColecaoVolumeSintetico.Nome)]
public class ConsultasSincronizacaoTests
{
    private static readonly Guid Terminal = Guid.Parse("019a0000-0000-7000-8000-00000000c002");
    private static readonly Guid Loja = Guid.Parse("019a0000-0000-7000-8000-00000000a001");
    private static readonly Guid Caixa = Guid.Parse("019a0000-0000-7000-8000-00000000b002");
    private static readonly Guid Maria = Guid.Parse("019a0003-0000-7000-8000-000000000001");
    private static readonly Guid Joao = Guid.Parse("019a0003-0000-7000-8000-000000000003");
    private static readonly Guid Dinheiro = Guid.Parse("019a0004-0000-7000-8000-000000000101");
    private static readonly Guid Debito = Guid.Parse("019a0004-0000-7000-8000-000000000102");
    private static readonly DateTimeOffset Agora = new(2026, 11, 5, 15, 0, 0, TimeSpan.Zero);

    private const string Descartado = """{"descartado":true,"justificativa":"Venda de teste"}""";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static long _sequencia = 1_000;
    private static long _numero = 80_000;

    private static SessaoCaixaRegistro Sessao() => new()
    {
        Id = Guid.CreateVersion7(),
        LojaId = Loja,
        CaixaId = Caixa,
        NumeroCaixa = 2,
        TerminalId = Terminal,
        OperadorId = Maria,
        Status = StatusSessaoCaixa.Aberta,
        DiaOperacional = DateOnly.FromDateTime(Agora.UtcDateTime),
        AbertaEm = Agora.AddHours(-6),
        FundoTroco = 100m,
        CriadoEm = Agora.AddHours(-6),
        AtualizadoEm = Agora.AddHours(-6),
        Versao = 1,
    };

    private static VendaRegistro Venda(SessaoCaixaRegistro sessao, decimal total, DateTimeOffset hora)
    {
        var numero = Interlocked.Increment(ref _numero);
        return new VendaRegistro
        {
            Id = Guid.CreateVersion7(),
            Numero = numero,
            NumeroExibicao = $"L01-C02-{numero:000000}",
            LojaId = Loja,
            CaixaId = Caixa,
            NumeroCaixa = 2,
            TerminalId = Terminal,
            SessaoCaixaId = sessao.Id,
            OperadorId = Maria,
            IniciadaEm = hora.AddMinutes(-1),
            FinalizadaEm = hora,
            Status = StatusVenda.Finalizada,
            QtdItens = 1,
            SubtotalBruto = total,
            Total = total,
            CriadoEm = hora,
            AtualizadoEm = hora,
            Versao = 1,
        };
    }

    private static EventoSaida Evento(string tipo, string agregadoTipo, Guid agregadoId, string status, DateTimeOffset quando,
        string? erro = null, string? resultado = null, string dependencias = "[]", int tentativas = 0, DateTimeOffset? proxima = null) => new()
        {
            Id = Guid.CreateVersion7(),
            SequenciaTerminal = Interlocked.Increment(ref _sequencia),
            Tipo = tipo,
            AgregadoTipo = agregadoTipo,
            AgregadoId = agregadoId,
            OcorridoEm = quando,
            CriadoEm = quando,
            // O conteúdo do evento (com um CPF e um token plantados): nunca pode chegar à aba.
            Payload = """{"venda":{"cpf_cnpj_nota":"12345678909"},"token":"segredo-do-payload"}""",
            PayloadSha256 = new string('a', 64),
            Contexto = """{"segredo_do_contexto":true}""",
            Status = status,
            Tentativas = tentativas,
            ProximaTentativaEm = proxima,
            UltimoErro = erro,
            ConfirmadoEm = status == StatusEventoSaida.Confirmado ? quando.AddSeconds(5) : null,
            Resultado = resultado ?? (status == StatusEventoSaida.Confirmado ? "{}" : null),
            Dependencias = dependencias,
        };

    [Fact]
    public async Task Uma_linha_por_venda_nao_confirmada_recusadas_primeiro_sem_as_confirmadas_e_as_descartadas()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var sessao = Sessao();
        var confirmada = Venda(sessao, 10m, Agora.AddHours(-5));
        var pendente = Venda(sessao, 12.90m, Agora.AddHours(-4));
        var recusada = Venda(sessao, 30m, Agora.AddHours(-3));
        var descartada = Venda(sessao, 7m, Agora.AddHours(-2));
        var cancelada = Venda(sessao, 15m, Agora.AddHours(-1));
        var divergente = Venda(sessao, 8m, Agora.AddMinutes(-30));
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            db.AddRange(sessao, confirmada, pendente, recusada, descartada, cancelada, divergente);
            db.EventosSaida.AddRange(
                Evento("caixa.aberto", "sessao_caixa", sessao.Id, StatusEventoSaida.Confirmado, sessao.AbertaEm),
                Evento("venda.finalizada", "venda", confirmada.Id, StatusEventoSaida.Confirmado, confirmada.FinalizadaEm!.Value),
                Evento("venda.finalizada", "venda", pendente.Id, StatusEventoSaida.ErroTemporario, pendente.FinalizadaEm!.Value,
                    erro: "transporte: sem rede", tentativas: 3, proxima: Agora.AddMinutes(2)),
                Evento("venda.finalizada", "venda", recusada.Id, StatusEventoSaida.Rejeitado, recusada.FinalizadaEm!.Value,
                    erro: "PRODUTO_INEXISTENTE: O produto 123 não existe na nuvem.", tentativas: 1),
                Evento("venda.finalizada", "venda", descartada.Id, StatusEventoSaida.Rejeitado, descartada.FinalizadaEm!.Value,
                    erro: "PAYLOAD_INVALIDO: x", resultado: Descartado),
                // A finalizada já confirmada e o cancelamento ainda na fila: a venda continua não confirmada (uma linha só).
                Evento("venda.finalizada", "venda", cancelada.Id, StatusEventoSaida.Confirmado, cancelada.FinalizadaEm!.Value),
                Evento("venda.cancelada", "venda", cancelada.Id, StatusEventoSaida.Pendente, Agora.AddMinutes(-50)),
                Evento("venda.finalizada", "venda", divergente.Id, StatusEventoSaida.Rejeitado, divergente.FinalizadaEm!.Value,
                    erro: "EVENTO_DIVERGENTE: outro conteúdo com o mesmo id."));
            await db.SaveChangesAsync(Ct);
        }

        var consultas = new ConsultasSincronizacaoLocal(banco.Fabrica);
        var pagina = await consultas.VendasNaoConfirmadasAsync(ct: Ct);

        Assert.Equal((4, 2, 1), (pagina.Quantidade, pagina.Recusadas, pagina.Descartadas));
        Assert.Equal([recusada.Id, divergente.Id, pendente.Id, cancelada.Id], pagina.Vendas.Select(v => v.VendaId));
        var r = pagina.Vendas[0];
        Assert.Equal((true, false, recusada.NumeroExibicao, 30m), (r.Recusada, r.Divergente, r.Numero, r.Total!.Value));
        Assert.Equal("PRODUTO_INEXISTENTE: O produto 123 não existe na nuvem.", r.Motivo);
        Assert.True(pagina.Vendas[1].Divergente);
        var p = pagina.Vendas[2];
        Assert.Equal((false, 3, "transporte: sem rede"), (p.Recusada, p.Tentativas, p.Motivo));
        Assert.Equal(Agora.AddMinutes(2), p.ProximaTentativaEm);
        Assert.Equal(["venda.cancelada"], pagina.Vendas[3].Tipos);
        Assert.Null(pagina.Proxima);
        // O resumo: o vermelho só com o que espera a decisão do ERP (a recusada e a divergente); a descartada à parte.
        Assert.Equal(new ContagemRecusados(2, 1), await consultas.ContagemRecusadosAsync(Ct));

        // Das que estavam na tela, as que a nuvem confirmou ficam verdes; a descartada no ERP fica à parte (a nuvem não a
        // tem: nunca verde); a pendente, nenhuma das duas.
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.EventosSaida.Where(e => e.AgregadoId == recusada.Id)
                .ExecuteUpdateAsync(u => u.SetProperty(e => e.Status, StatusEventoSaida.Confirmado), Ct);
        }

        var resolvidas = await consultas.VendasResolvidasAsync([recusada.Id, pendente.Id, descartada.Id, confirmada.Id], Ct);
        Assert.Equal(new HashSet<Guid> { recusada.Id, confirmada.Id }, resolvidas.Confirmadas.ToHashSet());
        Assert.Equal(new HashSet<Guid> { descartada.Id }, resolvidas.Descartadas.ToHashSet());
        Assert.DoesNotContain(recusada.Id, (await consultas.VendasNaoConfirmadasAsync(ct: Ct)).Vendas.Select(v => v.VendaId));
    }

    [Fact]
    public async Task Paginacao_estavel_sem_repetir_nem_pular_tambem_com_vendas_novas_entre_as_paginas()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var sessao = Sessao();
        var vendas = Enumerable.Range(0, 137).Select(i => Venda(sessao, 10m + i, Agora.AddMinutes(-200 + i))).ToList();
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            db.Add(sessao);
            db.AddRange(vendas);
            db.EventosSaida.AddRange(vendas.Select((v, i) => Evento("venda.finalizada", "venda", v.Id,
                i % 10 == 3 ? StatusEventoSaida.Rejeitado : StatusEventoSaida.Pendente, v.FinalizadaEm!.Value, erro: i % 10 == 3 ? "X: recusada" : null)));
            await db.SaveChangesAsync(Ct);
        }

        var consultas = new ConsultasSincronizacaoLocal(banco.Fabrica);
        var vistas = new List<Guid>();
        CursorNaoConfirmados? cursor = null;
        var paginas = 0;
        do
        {
            var pagina = await consultas.VendasNaoConfirmadasAsync(cursor, ct: Ct);
            vistas.AddRange(pagina.Vendas.Select(v => v.VendaId));
            cursor = pagina.Proxima;
            if (paginas == 0)
            {
                // Uma venda nova entra na fila entre a primeira e a segunda página: vai para o fim, sem empurrar ninguém.
                var nova = Venda(sessao, 99m, Agora);
                vendas.Add(nova);
                await using var db = banco.Fabrica.CreateDbContext();
                db.Add(nova);
                db.EventosSaida.Add(Evento("venda.finalizada", "venda", nova.Id, StatusEventoSaida.Pendente, Agora));
                await db.SaveChangesAsync(Ct);
            }

            paginas++;
        }
        while (cursor is not null);

        Assert.Equal(3, paginas);
        Assert.Equal(138, vistas.Count);
        Assert.Equal(138, vistas.Distinct().Count());
        // As recusadas (14) primeiro, depois as pendentes na ordem de envio.
        var recusadas = vendas.Where((_, i) => i % 10 == 3 && i < 137).Select(v => v.Id).ToList();
        Assert.Equal(recusadas, vistas.Take(recusadas.Count));
        Assert.Equal(vendas.Last().Id, vistas.Last());
    }

    [Fact]
    public async Task Paginacao_nao_repete_a_venda_que_tem_um_evento_confirmado_entre_as_paginas()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var sessao = Sessao();
        var vendas = Enumerable.Range(0, 5).Select(i => Venda(sessao, 10m + i, Agora.AddMinutes(-50 + i))).ToList();
        EventoSaida finalizadaDaPrimeira;
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            db.Add(sessao);
            db.AddRange(vendas);
            var finalizadas = vendas.Select(v => Evento("venda.finalizada", "venda", v.Id, StatusEventoSaida.Pendente, v.FinalizadaEm!.Value)).ToList();
            finalizadaDaPrimeira = finalizadas[0];
            db.EventosSaida.AddRange(finalizadas);
            // O cancelamento da primeira, gravado bem depois (a maior sequência da fila).
            db.EventosSaida.Add(Evento("venda.cancelada", "venda", vendas[0].Id, StatusEventoSaida.Pendente, Agora));
            await db.SaveChangesAsync(Ct);
        }

        var consultas = new ConsultasSincronizacaoLocal(banco.Fabrica);
        var primeira = await consultas.VendasNaoConfirmadasAsync(tamanho: 2, ct: Ct);
        Assert.Equal([vendas[0].Id, vendas[1].Id], primeira.Vendas.Select(v => v.VendaId));

        // Entre as páginas a nuvem confirma a finalizada da primeira venda (o cancelamento continua na fila): ela não muda
        // de lugar na ordem (o primeiro evento dela continua o mesmo) e não aparece de novo no fim.
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.EventosSaida.Where(e => e.Id == finalizadaDaPrimeira.Id)
                .ExecuteUpdateAsync(u => u.SetProperty(e => e.Status, StatusEventoSaida.Confirmado), Ct);
        }

        var vistas = primeira.Vendas.Select(v => v.VendaId).ToList();
        var cursor = primeira.Proxima;
        while (cursor is not null)
        {
            var pagina = await consultas.VendasNaoConfirmadasAsync(cursor, tamanho: 2, ct: Ct);
            vistas.AddRange(pagina.Vendas.Select(v => v.VendaId));
            cursor = pagina.Proxima;
        }

        Assert.Equal(vendas.Select(v => v.Id), vistas);
        // Na primeira página relida, ela continua no começo, só com o cancelamento.
        var relida = await consultas.VendasNaoConfirmadasAsync(tamanho: 2, ct: Ct);
        Assert.Equal((vendas[0].Id, finalizadaDaPrimeira.SequenciaTerminal), (relida.Vendas[0].VendaId, relida.Vendas[0].PrimeiraSequencia));
        Assert.Equal(["venda.cancelada"], relida.Vendas[0].Tipos);
    }

    [Fact]
    public async Task Caixa_nao_confirmado_e_o_outbox_por_situacao_e_tipo_na_ordem_certa()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var sessao = Sessao();
        var sangria = new MovimentoCaixaRegistro
        {
            Id = Guid.CreateVersion7(),
            SessaoCaixaId = sessao.Id,
            LojaId = Loja,
            CaixaId = Caixa,
            NumeroCaixa = 2,
            TerminalId = Terminal,
            Tipo = TipoMovimentoCaixa.Sangria,
            Valor = 150m,
            OperadorId = Maria,
            QuemRetiraNome = "JOÃO",
            OcorridoEm = Agora.AddHours(-2),
            CriadoEm = Agora.AddHours(-2),
            AtualizadoEm = Agora.AddHours(-2),
            Versao = 1,
        };
        var reforco = new MovimentoCaixaRegistro
        {
            Id = Guid.CreateVersion7(),
            SessaoCaixaId = sessao.Id,
            LojaId = Loja,
            CaixaId = Caixa,
            NumeroCaixa = 2,
            TerminalId = Terminal,
            Tipo = TipoMovimentoCaixa.Reforco,
            Valor = 50m,
            OperadorId = Maria,
            OcorridoEm = Agora.AddHours(-1),
            CriadoEm = Agora.AddHours(-1),
            AtualizadoEm = Agora.AddHours(-1),
            Versao = 1,
        };
        var venda = Venda(sessao, 20m, Agora.AddMinutes(-30));
        var aberto = Evento("caixa.aberto", "sessao_caixa", sessao.Id, StatusEventoSaida.Confirmado, sessao.AbertaEm);
        var eSangria = Evento("caixa.sangria", "movimento_caixa", sangria.Id, StatusEventoSaida.Pendente, sangria.OcorridoEm);
        var eReforco = Evento("caixa.reforco", "movimento_caixa", reforco.Id, StatusEventoSaida.Rejeitado, reforco.OcorridoEm, erro: "DEPENDENCIA_PENDENTE: a abertura");
        var eVenda = Evento("venda.finalizada", "venda", venda.Id, StatusEventoSaida.Pendente, venda.FinalizadaEm!.Value);
        var auditoria = Evento("auditoria.registros", "lote_auditoria", Guid.CreateVersion7(), StatusEventoSaida.Pendente, Agora);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            db.AddRange(sessao, sangria, reforco, venda);
            db.EventosSaida.AddRange(aberto, eSangria, eReforco, eVenda, auditoria);
            await db.SaveChangesAsync(Ct);
        }

        var consultas = new ConsultasSincronizacaoLocal(banco.Fabrica);
        var caixa = await consultas.CaixaNaoConfirmadoAsync(ct: Ct);
        Assert.Equal((2, 1, 0), (caixa.Quantidade, caixa.Recusados, caixa.Descartados));
        Assert.Equal([eReforco.Id, eSangria.Id], caixa.Eventos.Select(e => e.Id));
        var agregados = await consultas.AgregadosAsync(caixa.Eventos, Ct);
        Assert.Equal((TipoMovimentoCaixa.Sangria, 150m), (agregados[sangria.Id].TipoMovimento, agregados[sangria.Id].Valor!.Value));

        // "Todos": a enviar na ordem de envio; confirmados e todos, o mais novo primeiro; o tipo filtra.
        var aEnviar = await consultas.EventosAsync(new FiltroEventos(SituacaoFiltroEvento.AEnviar), ct: Ct);
        Assert.Equal([eSangria.Id, eVenda.Id, auditoria.Id], aEnviar.Eventos.Select(e => e.Id));
        var todos = await consultas.EventosAsync(new FiltroEventos(SituacaoFiltroEvento.Todos), ct: Ct);
        Assert.Equal([auditoria.Id, eVenda.Id, eReforco.Id, eSangria.Id, aberto.Id], todos.Eventos.Select(e => e.Id));
        Assert.Equal([aberto.Id], (await consultas.EventosAsync(new FiltroEventos(SituacaoFiltroEvento.Confirmados), ct: Ct)).Eventos.Select(e => e.Id));
        Assert.Equal([eVenda.Id], (await consultas.EventosAsync(new FiltroEventos(SituacaoFiltroEvento.AEnviar, "venda.finalizada"), ct: Ct)).Eventos.Select(e => e.Id));
        Assert.Equal(["auditoria.registros", "caixa.sangria", "venda.finalizada"], await consultas.TiposAsync(SituacaoFiltroEvento.AEnviar, Ct));
        Assert.Empty(await consultas.TiposAsync(SituacaoFiltroEvento.Confirmados, Ct));

        // A paginação do "todos" pela sequência: duas de 2 e uma de 1, sem repetir.
        var vistos = new List<Guid>();
        long? depois = null;
        do
        {
            var pagina = await consultas.EventosAsync(new FiltroEventos(SituacaoFiltroEvento.Todos), depois, tamanho: 2, ct: Ct);
            Assert.Equal(5, pagina.Quantidade);
            vistos.AddRange(pagina.Eventos.Select(e => e.Id));
            depois = pagina.Proxima;
        }
        while (depois is not null);

        Assert.Equal(todos.Eventos.Select(e => e.Id), vistos);
    }

    [Fact]
    public async Task Detalhe_com_as_dependencias_e_as_ocorrencias_ligadas_e_os_comandos()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var sessao = Sessao();
        var venda = Venda(sessao, 20m, Agora.AddMinutes(-30));
        var outra = Venda(sessao, 5m, Agora.AddMinutes(-20));
        var aberto = Evento("caixa.aberto", "sessao_caixa", sessao.Id, StatusEventoSaida.Pendente, sessao.AbertaEm);
        var finalizada = Evento("venda.finalizada", "venda", venda.Id, StatusEventoSaida.Rejeitado, venda.FinalizadaEm!.Value,
            erro: "DEPENDENCIA_PENDENTE: o caixa ainda não chegou", dependencias: $$"""[{"agregado_tipo":"sessao_caixa","agregado_id":"{{sessao.Id}}"}]""");
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            db.AddRange(sessao, venda, outra);
            db.EventosSaida.AddRange(aberto, finalizada);
            db.LogLocal.AddRange(
                new LogLocal { OcorridoEm = Agora.AddMinutes(-29), Nivel = "aviso", Origem = "sync", Mensagem = "A nuvem recusou o registro", Detalhes = $$"""{"evento_id":"{{finalizada.Id}}"}""" },
                new LogLocal { OcorridoEm = Agora.AddMinutes(-28), Nivel = "erro", Origem = "impressora", Mensagem = $"Cupom da venda {venda.NumeroExibicao} não saiu" },
                new LogLocal { OcorridoEm = Agora.AddMinutes(-19), Nivel = "erro", Origem = "impressora", Mensagem = $"Cupom da venda {outra.NumeroExibicao} não saiu" },
                new LogLocal { OcorridoEm = Agora.AddDays(-3), Nivel = "aviso", Origem = "sync", Mensagem = "antiga", Detalhes = venda.Id.ToString() });
            db.ComandosRecebidos.AddRange(
                new ComandoRecebido { ComandoId = Guid.CreateVersion7(), Tipo = "mensagem", RecebidoEm = Agora.AddHours(-2), Status = "executado", Resultado = "{}" },
                new ComandoRecebido { ComandoId = Guid.CreateVersion7(), Tipo = "enviar_logs", RecebidoEm = Agora.AddHours(-1), Status = "falhou", Resultado = """{"erro":"não suportado"}""" });
            await db.SaveChangesAsync(Ct);
        }

        var consultas = new ConsultasSincronizacaoLocal(banco.Fabrica);
        var detalhe = await consultas.DetalheAsync(venda.Id, Ct);
        Assert.NotNull(detalhe);
        Assert.Equal((venda.NumeroExibicao, 20m), (detalhe.Agregado!.NumeroVenda, detalhe.Agregado.Valor!.Value));
        var e = Assert.Single(detalhe.Eventos);
        Assert.True(e.Recusado);
        var dependencia = Assert.Single(detalhe.Dependencias[e.Id]);
        Assert.Equal(("sessao_caixa", sessao.Id, StatusEventoSaida.Pendente), (dependencia.AgregadoTipo, dependencia.AgregadoId, dependencia.Status));
        // As ocorrências da venda (pelo id do evento e pelo número), não as de outra venda nem as de antes dela.
        Assert.Equal(["Cupom da venda " + venda.NumeroExibicao + " não saiu", "A nuvem recusou o registro"], detalhe.Ocorrencias.Select(o => o.Mensagem));
        Assert.Null(await consultas.DetalheAsync(Guid.CreateVersion7(), Ct));

        var (comandos, quantidade) = await consultas.ComandosAsync(Ct);
        Assert.Equal(2, quantidade);
        Assert.Equal(["enviar_logs", "mensagem"], comandos.Select(c => c.Tipo));
    }

    [Fact]
    public void Os_tipos_da_aba_nao_tem_payload_nem_contexto()
    {
        var tipos = new[]
        {
            typeof(EventoSincronizacao), typeof(VendaNaoConfirmada), typeof(PaginaVendasNaoConfirmadas), typeof(PaginaCaixaNaoConfirmado),
            typeof(PaginaEventos), typeof(DetalheSincronizacao), typeof(DependenciaSincronizacao), typeof(AgregadoSincronizacao),
            typeof(ComandoSincronizacao), typeof(OcorrenciaSincronizacao),
        };
        Assert.All(tipos.SelectMany(t => t.GetProperties()), p =>
        {
            Assert.DoesNotContain("Payload", p.Name, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("Contexto", p.Name, StringComparison.OrdinalIgnoreCase);
        });
    }

    [Fact]
    public async Task Volume_sintetico_com_milhares_na_fila_fica_abaixo_de_300_ms_pelo_indice_e_sem_ler_o_payload()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        const int dias = 90;
        const int total = 120_000;
        const int pendentes = 3_000;
        var porDia = (total + dias - 1) / dias;
        var inicio = new DateTimeOffset(Agora.UtcDateTime.Date, TimeSpan.Zero).AddDays(-(dias - 1)).AddHours(8);
        using (var conexao = banco.AbrirConexao())
        {
            Executar(conexao, Sql.Sessoes, ("@dias", (object)dias), ("@inicio", (object)inicio.ToUnixTimeSeconds()), ("@terminal", (object)Terminal.ToString()),
                ("@loja", (object)Loja.ToString()), ("@caixa", (object)Caixa.ToString()), ("@operador", (object)Maria.ToString()));
            Executar(conexao, Sql.Vendas, ("@total", (object)total), ("@porDia", (object)porDia), ("@inicio", (object)inicio.ToUnixTimeSeconds()), ("@terminal", (object)Terminal.ToString()),
                ("@loja", (object)Loja.ToString()), ("@caixa", (object)Caixa.ToString()), ("@maria", (object)Maria.ToString()), ("@joao", (object)Joao.ToString()));
            Executar(conexao, Sql.Pagamentos, ("@dinheiro", (object)Dinheiro.ToString()), ("@debito", (object)Debito.ToString()));
            // O outbox da loja com as 3 mil vendas mais novas ainda na fila (uns dias sem internet) e 40 recusadas.
            Executar(conexao, Sql.Eventos, ("@renumerada", (object)4_000), ("@pendentes", (object)pendentes));
            Executar(conexao, """
                update eventos_saida set status = 'rejeitado', ultimo_erro = 'PRODUTO_INEXISTENTE: teste', tentativas = 1
                where tipo = 'venda.finalizada' and status = 'pendente' and sequencia_terminal % 75 = 0
                """);
            Executar(conexao, "analyze");
        }

        var planos = new PlanosDasConsultas();
        var consultas = new ConsultasSincronizacaoLocal(planos.Fabrica(banco.Fabrica.StringConexao));
        PaginaVendasNaoConfirmadas? primeira = null;
        PaginaEventos? confirmados = null;
        var tempos = new Dictionary<string, TimeSpan>
        {
            ["vendas não confirmadas, primeira página"] = await MedirAsync(async () => primeira = await consultas.VendasNaoConfirmadasAsync(ct: Ct)),
            ["vendas não confirmadas, página seguinte"] = await MedirAsync(() => consultas.VendasNaoConfirmadasAsync(primeira!.Proxima, ct: Ct)),
            ["caixa não confirmado"] = await MedirAsync(() => consultas.CaixaNaoConfirmadoAsync(ct: Ct)),
            ["todos, a enviar"] = await MedirAsync(() => consultas.EventosAsync(new FiltroEventos(SituacaoFiltroEvento.AEnviar), ct: Ct)),
            ["todos, a enviar de um tipo"] = await MedirAsync(() => consultas.EventosAsync(new FiltroEventos(SituacaoFiltroEvento.AEnviar, "venda.finalizada"), ct: Ct)),
            ["todos, recusados"] = await MedirAsync(() => consultas.EventosAsync(new FiltroEventos(SituacaoFiltroEvento.Recusados), ct: Ct)),
            ["todos, confirmados"] = await MedirAsync(async () => confirmados = await consultas.EventosAsync(new FiltroEventos(SituacaoFiltroEvento.Confirmados), ct: Ct)),
            ["todos, confirmados, página seguinte"] = await MedirAsync(() => consultas.EventosAsync(new FiltroEventos(SituacaoFiltroEvento.Confirmados), confirmados!.Proxima, ct: Ct)),
            ["todos, todas as situações"] = await MedirAsync(() => consultas.EventosAsync(new FiltroEventos(SituacaoFiltroEvento.Todos), ct: Ct)),
            ["tipos a enviar"] = await MedirAsync(() => consultas.TiposAsync(SituacaoFiltroEvento.AEnviar, Ct)),
            ["detalhe de uma venda"] = await MedirAsync(() => consultas.DetalheAsync(primeira!.Vendas[0].VendaId, Ct)),
            ["verdes"] = await MedirAsync(() => consultas.VendasResolvidasAsync([.. primeira!.Vendas.Select(v => v.VendaId)], Ct)),
            ["recusados do resumo"] = await MedirAsync(() => consultas.ContagemRecusadosAsync(Ct)),
            ["comandos"] = await MedirAsync(() => consultas.ComandosAsync(Ct)),
        };

        Assert.Equal(pendentes, primeira!.Quantidade);
        Assert.InRange(primeira.Recusadas, 30, 50);
        Assert.True(primeira.Vendas[0].Recusada);
        Assert.Equal(ConsultasSincronizacaoLocal.TamanhoPagina, confirmados!.Eventos.Count);
        TestContext.Current.SendDiagnosticMessage(string.Join("; ", tempos.Select(t => $"{t.Key} {t.Value.TotalMilliseconds:0} ms")));
        Assert.All(tempos, t => Assert.True(t.Value < ColecaoVolumeSintetico.TetoConsulta, $"{t.Key}: {t.Value.TotalMilliseconds:0} ms"));

        // Nada que cresce com o histórico é varrido: o outbox entra pela situação, pela sequência, pelo agregado ou pelo id.
        var outbox = planos.Planos.Where(p => p.Sql.Contains("FROM \"eventos_saida\"", StringComparison.Ordinal)).ToList();
        Assert.NotEmpty(outbox);
        // A tabela nunca é varrida; o índice da sequência só é percorrido com o LIMIT da página (a visão "todos", do mais novo).
        Assert.All(outbox, p => Assert.DoesNotMatch(@"SCAN e($| \|)", p.Plano));
        Assert.All(outbox.Where(p => p.Plano.Contains("SCAN e USING INDEX", StringComparison.Ordinal)), p => Assert.Contains("LIMIT", p.Sql, StringComparison.Ordinal));
        // E nenhuma consulta lê o conteúdo do evento (o payload, que passa da página do SQLite) nem o contexto.
        Assert.All(planos.Planos, p =>
        {
            Assert.DoesNotContain("\"payload\"", p.Sql, StringComparison.Ordinal);
            Assert.DoesNotContain("\"contexto\"", p.Sql, StringComparison.Ordinal);
        });
    }
}
