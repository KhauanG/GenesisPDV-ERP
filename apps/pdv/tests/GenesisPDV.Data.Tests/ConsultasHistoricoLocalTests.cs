using System.Diagnostics;
using System.Globalization;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Consulta histórica das vendas (Central do PDV, bloco G5; plano 4.2 e 5.3; decisões do dono de 04/11/2026): o caixa
/// aberto primeiro e os fechados nos últimos 30 dias (nunca mais antigos, nem pedidos pelo id, nem de outro terminal), os
/// filtros combinados no SQL, o cursor sem repetir nem pular (também com a mesma hora em várias vendas), o selo "cancelada
/// depois" só pelo dado e o desempenho com 120 mil vendas sintéticas e o outbox delas (página abaixo de 300 ms, sem varrer
/// o histórico; o número novo da nuvem procurado no outbox só na faixa da renumeração).
/// </summary>
[Collection(ColecaoVolumeSintetico.Nome)]
public class ConsultasHistoricoLocalTests
{
    private static readonly Guid Terminal = Guid.Parse("019a0000-0000-7000-8000-00000000c002");
    private static readonly Guid OutroTerminal = Guid.Parse("019a0000-0000-7000-8000-00000000c003");
    private static readonly Guid Loja = Guid.Parse("019a0000-0000-7000-8000-00000000a001");
    private static readonly Guid Caixa = Guid.Parse("019a0000-0000-7000-8000-00000000b002");
    private static readonly Guid Maria = Guid.Parse("019a0003-0000-7000-8000-000000000001");
    private static readonly Guid Joao = Guid.Parse("019a0003-0000-7000-8000-000000000003");
    private static readonly Guid Dinheiro = Guid.Parse("019a0004-0000-7000-8000-000000000101");
    private static readonly Guid Debito = Guid.Parse("019a0004-0000-7000-8000-000000000102");

    /// <summary>"Agora" fixo dos testes: 05/11/2026 15:00 UTC.</summary>
    private static readonly DateTimeOffset Agora = new(2026, 11, 5, 15, 0, 0, TimeSpan.Zero);

    /// <summary>O teto de 30 dias a partir de <see cref="Agora"/> (o App calcula com o fuso e a hora de corte).</summary>
    private static readonly DateTimeOffset Desde = Dia(Agora).AddDays(-(ConsultasHistoricoLocal.LimiteDias - 1));

    private static DateTimeOffset Dia(DateTimeOffset instante) => new(instante.UtcDateTime.Date, TimeSpan.Zero);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static SessaoCaixaRegistro Sessao(DateTimeOffset aberta, DateTimeOffset? fechada, Guid? terminal = null, Guid? operador = null) => new()
    {
        Id = Guid.CreateVersion7(),
        LojaId = Loja,
        CaixaId = Caixa,
        NumeroCaixa = 2,
        TerminalId = terminal ?? Terminal,
        OperadorId = operador ?? Maria,
        Status = fechada is null ? StatusSessaoCaixa.Aberta : StatusSessaoCaixa.Fechada,
        DiaOperacional = DateOnly.FromDateTime(aberta.UtcDateTime),
        AbertaEm = aberta,
        FechadaEm = fechada,
        CriadoEm = aberta,
        AtualizadoEm = fechada ?? aberta,
        Versao = 1,
    };

    private static long _numero;

    /// <summary>Venda encerrada de <paramref name="total"/>, paga em uma forma (finalizada, ou cancelada em <paramref name="cancelada"/>).</summary>
    private static VendaRegistro Venda(SessaoCaixaRegistro sessao, DateTimeOffset hora, decimal total, Guid? forma = null, Guid? operador = null,
        string? cpf = null, DateTimeOffset? cancelada = null, bool paga = true)
    {
        var numero = Interlocked.Increment(ref _numero);
        var id = Guid.CreateVersion7();
        var venda = new VendaRegistro
        {
            Id = id,
            Numero = numero,
            NumeroExibicao = $"L01-C02-{numero:000000}",
            LojaId = Loja,
            CaixaId = Caixa,
            NumeroCaixa = 2,
            TerminalId = sessao.TerminalId,
            SessaoCaixaId = sessao.Id,
            OperadorId = operador ?? sessao.OperadorId,
            CpfCnpjNota = cpf,
            IniciadaEm = hora.AddMinutes(-1),
            FinalizadaEm = paga ? hora : null,
            CanceladaEm = cancelada,
            MotivoCancelamento = cancelada is null ? null : "Cliente desistiu da compra",
            Status = cancelada is null ? StatusVenda.Finalizada : StatusVenda.Cancelada,
            QtdItens = 1,
            SubtotalBruto = total,
            Total = total,
            DiaOperacional = DateOnly.FromDateTime(hora.UtcDateTime),
            CriadoEm = hora,
            AtualizadoEm = hora,
            Versao = 1,
        };
        if (paga)
        {
            var formaId = forma ?? Dinheiro;
            venda.Pagamentos.Add(new PagamentoVendaRegistro
            {
                Id = Guid.CreateVersion7(),
                VendaId = id,
                Sequencia = 1,
                FormaPagamentoId = formaId,
                DescricaoForma = formaId == Debito ? "Cartão de débito" : "Dinheiro",
                MeioPagamentoFiscal = formaId == Debito ? "04" : "01",
                TipoForma = formaId == Debito ? "cartao_debito" : "dinheiro",
                Valor = total,
                LancaQuitada = true,
                Status = cancelada is null ? StatusPagamento.Aprovado : StatusPagamento.Estornado,
                CriadoEm = hora,
                AtualizadoEm = hora,
                Versao = 1,
            });
        }

        return venda;
    }

    private static async Task GravarAsync(BancoTemporario banco, params object[] linhas)
    {
        await using var db = banco.Fabrica.CreateDbContext();
        db.AddRange(linhas);
        await db.SaveChangesAsync(Ct);
    }

    /// <summary>
    /// O aberto (hoje), um fechado de 3 dias atrás, um fechado de 29 dias atrás (dentro do teto), um de 31 dias (fora), um
    /// de outro terminal e um aberto há 40 dias num terminal que nunca fechou (a sessão aberta conta sempre).
    /// </summary>
    private static async Task<Cenario> CenarioAsync(BancoTemporario banco)
    {
        await banco.InicializarAsync();
        var aberta = Sessao(Agora.AddHours(-6), null);
        var tresDias = Sessao(Agora.AddDays(-3).AddHours(-8), Agora.AddDays(-3), operador: Joao);
        var vinteNove = Sessao(Desde.AddHours(1), Desde.AddHours(10));
        var trintaUm = Sessao(Agora.AddDays(-31).AddHours(-8), Agora.AddDays(-31));
        var outro = Sessao(Agora.AddDays(-1).AddHours(-8), Agora.AddDays(-1), terminal: OutroTerminal);
        var c = new Cenario(aberta, tresDias, vinteNove, trintaUm, outro);
        await GravarAsync(banco, aberta, tresDias, vinteNove, trintaUm, outro);
        await GravarAsync(banco,
            c.Add(Venda(aberta, Agora.AddHours(-1), 12.90m)),
            c.Add(Venda(aberta, Agora.AddMinutes(-30), 50m, Debito, cpf: "12345678909")),
            c.Add(Venda(aberta, Agora.AddMinutes(-20), 8m, cancelada: Agora.AddMinutes(-19))),
            c.Add(Venda(aberta, Agora.AddMinutes(-10), 0m, cancelada: Agora.AddMinutes(-10), paga: false)),
            c.Add(Venda(tresDias, Agora.AddDays(-3).AddHours(-2), 100m, operador: Joao)),
            c.Add(Venda(tresDias, Agora.AddDays(-3).AddHours(-1), 30m, Debito, operador: Joao, cpf: "12345678909")),
            // Cancelada depois do fechamento do caixa dela (nenhum caminho do PDV faz isso; o dado pode chegar assim).
            c.Add(Venda(tresDias, Agora.AddDays(-3).AddHours(-3), 45m, operador: Joao, cancelada: Agora.AddDays(-2))),
            c.Add(Venda(vinteNove, Desde.AddHours(5), 77m)),
            c.Add(Venda(trintaUm, Agora.AddDays(-31).AddHours(-1), 99m)),
            c.Add(Venda(outro, Agora.AddDays(-1).AddHours(-1), 66m)));
        return c;
    }

    private sealed record Cenario(SessaoCaixaRegistro Aberta, SessaoCaixaRegistro TresDias, SessaoCaixaRegistro VinteNove,
        SessaoCaixaRegistro TrintaUm, SessaoCaixaRegistro Outro)
    {
        public List<VendaRegistro> Vendas { get; } = [];

        public VendaRegistro Add(VendaRegistro v)
        {
            Vendas.Add(v);
            return v;
        }

        public VendaRegistro De(SessaoCaixaRegistro s, decimal total) => Vendas.Single(v => v.SessaoCaixaId == s.Id && v.Total == total);
    }

    [Fact]
    public async Task Caixas_trazem_o_aberto_primeiro_e_os_fechados_nos_ultimos_30_dias_deste_terminal()
    {
        using var banco = new BancoTemporario();
        var c = await CenarioAsync(banco);
        var consultas = new ConsultasHistoricoLocal(banco.Fabrica);

        var caixas = await consultas.CaixasAsync(Terminal, Desde, Ct);
        Assert.Equal([c.Aberta.Id, c.TresDias.Id, c.VinteNove.Id], caixas.Select(x => x.SessaoId));
        Assert.True(caixas[0].Aberto);
        Assert.Equal([4, 3, 1], caixas.Select(x => x.QuantidadeVendas));
        Assert.Equal(Joao, caixas[1].OperadorId);
        Assert.Equal(c.TresDias.FechadaEm, caixas[1].FechadaEm);

        // O caixa aberto há 40 dias (nunca fechado) aparece: o teto é pelo fechamento.
        var antiga = Sessao(Agora.AddDays(-40), null, terminal: OutroTerminal);
        await GravarAsync(banco, antiga);
        Assert.Equal([antiga.Id], (await consultas.CaixasAsync(OutroTerminal, Desde, Ct)).Where(x => x.Aberto).Select(x => x.SessaoId));
        // A consulta curta do caixa aberto (quem vê só ele): a mesma sessão, sem contar vendas; terminal sem caixa aberto, nada.
        Assert.Equal(((Guid?)c.Aberta.Id, (Guid?)antiga.Id), (await consultas.CaixaAbertoAsync(Terminal, Ct), await consultas.CaixaAbertoAsync(OutroTerminal, Ct)));
        Assert.Null(await consultas.CaixaAbertoAsync(Guid.CreateVersion7(), Ct));
        Assert.Equal([Maria, Joao], (await consultas.OperadoresAsync(Terminal, Desde, ct: Ct)).Order());
        // As formas usadas nos caixas consultáveis, pelo nome (o filtro "Forma" da aba Vendas).
        Assert.Equal([(Debito, "Cartão de débito"), (Dinheiro, "Dinheiro")], await consultas.FormasAsync(Terminal, Desde, ct: Ct));
        Assert.Equal([Joao], await consultas.OperadoresAsync(Terminal, Desde, c.TresDias.Id, Ct));
        Assert.Empty(await consultas.FormasAsync(Terminal, Desde, c.TrintaUm.Id, Ct));
    }

    [Fact]
    public async Task Filtros_combinados_no_sql_e_o_teto_de_30_dias_mesmo_pedindo_o_caixa_pelo_id()
    {
        using var banco = new BancoTemporario();
        var c = await CenarioAsync(banco);
        var consultas = new ConsultasHistoricoLocal(banco.Fabrica);
        async Task<List<decimal>> TotaisAsync(FiltroVendas filtro) =>
            (await consultas.VendasAsync(Terminal, Desde, filtro, ct: Ct)).Vendas.Select(v => v.Total).ToList();

        // Todos os caixas consultáveis: o aberto e os dois fechados dentro do teto, da mais nova à mais antiga.
        var todas = await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(), ct: Ct);
        Assert.Equal(8, todas.Quantidade);
        Assert.Equal([0m, 8m, 50m, 12.90m, 30m, 100m, 45m, 77m], todas.Vendas.Select(v => v.Total));
        Assert.Null(todas.Proxima);
        Assert.Null(todas.TotalPagas);
        // A soma das pagas do filtro só quando pedida (a tela a mostra só com o calculado do caixa, O3).
        Assert.Equal(269.90m, (await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(), somarPagas: true, ct: Ct)).TotalPagas);
        Assert.Equal(0m, (await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(c.TrintaUm.Id), somarPagas: true, ct: Ct)).TotalPagas);
        Assert.DoesNotContain(todas.Vendas, v => v.Total is 99m or 66m);

        // Um caixa só; o de 31 dias e o de outro terminal ficam vazios mesmo pedidos pelo id.
        Assert.Equal([0m, 8m, 50m, 12.90m], await TotaisAsync(new FiltroVendas(c.Aberta.Id)));
        Assert.Equal([30m, 100m, 45m], await TotaisAsync(new FiltroVendas(c.TresDias.Id)));
        Assert.Empty(await TotaisAsync(new FiltroVendas(c.TrintaUm.Id)));
        Assert.Empty(await TotaisAsync(new FiltroVendas(c.Outro.Id)));
        Assert.Equal(0, (await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(c.TrintaUm.Id), ct: Ct)).Quantidade);

        // Situação, operador, forma, valor e texto, sozinhos e combinados.
        Assert.Equal([50m, 12.90m, 30m, 100m, 77m], await TotaisAsync(new FiltroVendas(Situacao: SituacaoFiltroVenda.Pagas)));
        Assert.Equal([0m, 8m, 45m], await TotaisAsync(new FiltroVendas(Situacao: SituacaoFiltroVenda.Canceladas)));
        Assert.Equal([30m, 100m, 45m], await TotaisAsync(new FiltroVendas(OperadorId: Joao)));
        Assert.Equal([50m, 30m], await TotaisAsync(new FiltroVendas(FormaPagamentoId: Debito)));
        Assert.Equal([50m, 30m, 45m], await TotaisAsync(new FiltroVendas(ValorMinimo: 30m, ValorMaximo: 50m)));
        Assert.Equal([30m], await TotaisAsync(new FiltroVendas(OperadorId: Joao, FormaPagamentoId: Debito, Situacao: SituacaoFiltroVenda.Pagas)));
        Assert.Equal([50m, 30m], await TotaisAsync(new FiltroVendas(Texto: "123.456.789-09")));
        Assert.Equal([30m], await TotaisAsync(new FiltroVendas(c.TresDias.Id, "12345678909")));
        var numero = c.De(c.TresDias, 100m).Numero;
        Assert.Equal([100m], await TotaisAsync(new FiltroVendas(Texto: numero.ToString(CultureInfo.InvariantCulture))));
        Assert.Equal([100m], await TotaisAsync(new FiltroVendas(Texto: $"00{numero}")));
        Assert.Equal([100m], await TotaisAsync(new FiltroVendas(Texto: $"l01-c02-{numero:000000}")));
        Assert.Empty(await TotaisAsync(new FiltroVendas(Texto: "C02")));
        Assert.Empty(await TotaisAsync(new FiltroVendas(Texto: c.De(c.TrintaUm, 99m).Numero.ToString(CultureInfo.InvariantCulture))));
        Assert.Empty(await TotaisAsync(new FiltroVendas(c.Aberta.Id, numero.ToString(CultureInfo.InvariantCulture))));
    }

    [Fact]
    public async Task Detalhes_da_linha_formas_numero_da_nuvem_e_o_selo_cancelada_depois_so_pelo_dado()
    {
        using var banco = new BancoTemporario();
        var c = await CenarioAsync(banco);
        var renumerada = c.De(c.TresDias, 30m);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            db.EventosSaida.Add(new EventoSaida
            {
                Id = Guid.CreateVersion7(),
                SequenciaTerminal = 1,
                Tipo = "venda.finalizada",
                VersaoSchema = 1,
                AgregadoTipo = "venda",
                AgregadoId = renumerada.Id,
                OcorridoEm = Agora,
                CriadoEm = Agora,
                Payload = "{}",
                PayloadSha256 = new string('0', 64),
                Status = StatusEventoSaida.Confirmado,
                Resultado = $$"""{"numero_original":{{renumerada.Numero}},"numero":9000001,"numero_exibicao":"L01-C02-9000001"}""",
            });
            await db.SaveChangesAsync(Ct);
        }

        var consultas = new ConsultasHistoricoLocal(banco.Fabrica);
        var linhas = (await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(c.TresDias.Id), ct: Ct)).Vendas;
        var trinta = linhas.Single(v => v.Total == 30m);
        Assert.Equal(("Cartão de débito", "L01-C02-9000001", c.TresDias.Id, c.TresDias.FechadaEm), (trinta.Formas, trinta.NumeroNuvem, trinta.SessaoCaixaId, trinta.CaixaFechadoEm));
        Assert.Equal([45m], linhas.Where(v => v.CanceladaDepois).Select(v => v.Total));
        // Cancelada na sessão aberta (antes de qualquer fechamento): não é "depois".
        Assert.DoesNotContain((await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(c.Aberta.Id), ct: Ct)).Vendas, v => v.CanceladaDepois);
        Assert.Equal([30m], (await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(Texto: "9000001"), ct: Ct)).Vendas.Select(v => v.Total));
        Assert.Equal([30m], (await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(Texto: "l01-c02-9000001"), ct: Ct)).Vendas.Select(v => v.Total));
        // A venda em andamento cancelada não tem forma e não é "finalizada".
        var semPagamento = Assert.Single((await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(c.Aberta.Id), ct: Ct)).Vendas, v => v.Total == 0m);
        Assert.Equal((string.Empty, false), (semPagamento.Formas, semPagamento.Finalizada));
    }

    [Fact]
    public async Task Cursor_percorre_tudo_sem_repetir_nem_pular_tambem_com_a_mesma_hora()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var aberta = Sessao(Agora.AddHours(-6), null);
        var fechada = Sessao(Agora.AddDays(-2).AddHours(-8), Agora.AddDays(-2));
        await GravarAsync(banco, aberta, fechada);
        // 137 vendas: grupos de 7 com a mesma hora (o desempate é o número), nos dois caixas.
        var vendas = Enumerable.Range(0, 137)
            .Select(i => Venda(i % 2 == 0 ? aberta : fechada, (i % 2 == 0 ? Agora : Agora.AddDays(-2)).AddMinutes(-(i / 7)), 10m + i))
            .ToArray();
        await GravarAsync(banco, vendas);
        var consultas = new ConsultasHistoricoLocal(banco.Fabrica);

        var vistas = new List<Guid>();
        CursorVendas? cursor = null;
        var paginas = 0;
        do
        {
            var pagina = await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(), cursor, tamanho: 20, ct: Ct);
            Assert.Equal(137, pagina.Quantidade);
            Assert.True(pagina.Vendas.Count is > 0 and <= 20);
            vistas.AddRange(pagina.Vendas.Select(v => v.Id));
            cursor = pagina.Proxima;
            paginas++;
        }
        while (cursor is not null);

        Assert.Equal(7, paginas);
        Assert.Equal(137, vistas.Count);
        Assert.Equal(137, vistas.Distinct().Count());
        var esperada = vendas.OrderByDescending(v => v.FinalizadaEm).ThenByDescending(v => v.Numero).Select(v => v.Id);
        Assert.Equal(esperada, vistas);

        // A página exata (20 de 20) não deixa uma página vazia depois.
        var exata = await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(fechada.Id, Situacao: SituacaoFiltroVenda.Pagas), tamanho: 68, ct: Ct);
        Assert.Equal((68, 68, (CursorVendas?)null), (exata.Vendas.Count, exata.Quantidade, exata.Proxima));
    }

    [Fact]
    public async Task Pagina_com_120_mil_vendas_sinteticas_fica_abaixo_de_300_ms()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        const int dias = 90;
        const int total = 120_000;
        var porDia = (total + dias - 1) / dias;
        var inicio = Dia(Agora).AddDays(-(dias - 1)).AddHours(8);
        using (var conexao = banco.AbrirConexao())
        {
            Executar(conexao, Sql.Sessoes, ("@dias", (object)dias), ("@inicio", (object)inicio.ToUnixTimeSeconds()), ("@terminal", (object)Terminal.ToString()),
                ("@loja", (object)Loja.ToString()), ("@caixa", (object)Caixa.ToString()), ("@operador", (object)Maria.ToString()));
            Executar(conexao, Sql.Vendas, ("@total", (object)total), ("@porDia", (object)porDia), ("@inicio", (object)inicio.ToUnixTimeSeconds()), ("@terminal", (object)Terminal.ToString()),
                ("@loja", (object)Loja.ToString()), ("@caixa", (object)Caixa.ToString()), ("@maria", (object)Maria.ToString()), ("@joao", (object)Joao.ToString()));
            Executar(conexao, Sql.Pagamentos, ("@dinheiro", (object)Dinheiro.ToString()), ("@debito", (object)Debito.ToString()));
            Executar(conexao, Sql.Eventos, ("@renumerada", (object)RenumeradaACada), ("@pendentes", (object)EventosPendentes));
            Executar(conexao, "analyze");
        }

        Assert.Equal((long)total, banco.Escalar("select count(*) from vendas"));
        // O outbox como o da loja (não é expurgado): um venda.finalizada por venda (e o venda.cancelada das canceladas),
        // com o payload de alguns KB, e os eventos de caixa.
        Assert.True((long)banco.Escalar("select count(*) from eventos_saida")! > total);
        var planos = new PlanosDasConsultas();
        var consultas = new ConsultasHistoricoLocal(planos.Fabrica(banco.Fabrica.StringConexao));
        var caixas = await consultas.CaixasAsync(Terminal, Desde, Ct);
        Assert.InRange(caixas.Count, 29, 31);
        Assert.True(caixas[0].Aberto);
        var meio = caixas[caixas.Count / 2].SessaoId;

        PaginaVendas? primeira = null;
        PaginaVendas? renumerada = null;
        var tempos = new Dictionary<string, TimeSpan>
        {
            ["todos, primeira página"] = await MedirAsync(async () => primeira = await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(), ct: Ct)),
            ["todos, página do meio"] = await MedirAsync(async () =>
            {
                CursorVendas? c = primeira!.Proxima;
                for (var i = 0; i < 3; i++)
                {
                    c = (await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(), c, ct: Ct)).Proxima;
                }
            }, vezes: 1, porRepeticao: 3),
            ["um caixa fechado"] = await MedirAsync(() => consultas.VendasAsync(Terminal, Desde, new FiltroVendas(meio), ct: Ct)),
            ["número"] = await MedirAsync(() => consultas.VendasAsync(Terminal, Desde, new FiltroVendas(Texto: "110000"), ct: Ct)),
            ["CPF"] = await MedirAsync(() => consultas.VendasAsync(Terminal, Desde, new FiltroVendas(Texto: "00000097000"), ct: Ct)),
            ["CPF com máscara"] = await MedirAsync(() => consultas.VendasAsync(Terminal, Desde, new FiltroVendas(Texto: "000.000.970-00"), ct: Ct)),
            ["número sendo digitado"] = await MedirAsync(() => consultas.VendasAsync(Terminal, Desde, new FiltroVendas(Texto: "11"), ct: Ct)),
            ["número de exibição"] = await MedirAsync(() => consultas.VendasAsync(Terminal, Desde, new FiltroVendas(Texto: "l01-c02-110000"), ct: Ct)),
            ["número novo da nuvem"] = await MedirAsync(async () => renumerada = await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(Texto: "9100000"), ct: Ct)),
            ["operador + forma + valor"] = await MedirAsync(() =>
                consultas.VendasAsync(Terminal, Desde, new FiltroVendas(OperadorId: Joao, FormaPagamentoId: Debito, ValorMinimo: 10m, ValorMaximo: 20m), ct: Ct)),
            ["canceladas"] = await MedirAsync(() => consultas.VendasAsync(Terminal, Desde, new FiltroVendas(Situacao: SituacaoFiltroVenda.Canceladas), ct: Ct)),
            ["nada encontrado"] = await MedirAsync(() => consultas.VendasAsync(Terminal, Desde, new FiltroVendas(Texto: "98765432100"), ct: Ct)),
            ["forma que ninguém usou"] = await MedirAsync(() => consultas.VendasAsync(Terminal, Desde, new FiltroVendas(FormaPagamentoId: Guid.CreateVersion7()), ct: Ct)),
            ["caixas"] = await MedirAsync(() => consultas.CaixasAsync(Terminal, Desde, Ct)),
            ["caixa aberto"] = await MedirAsync(() => consultas.CaixaAbertoAsync(Terminal, Ct)),
            ["operadores e formas do filtro"] = await MedirAsync(async () =>
            {
                await consultas.OperadoresAsync(Terminal, Desde, ct: Ct);
                await consultas.FormasAsync(Terminal, Desde, ct: Ct);
            }),
        };

        Assert.Equal(ConsultasHistoricoLocal.TamanhoPagina, primeira!.Vendas.Count);
        Assert.InRange(primeira.Quantidade, 38_000, 42_000);
        var nova = Assert.Single(renumerada!.Vendas);
        Assert.Equal((100_000L, "L01-C02-9100000"), (nova.Numero, nova.NumeroNuvem));
        Assert.All(tempos, t => Assert.True(t.Value < ColecaoVolumeSintetico.TetoConsulta, $"{t.Key}: {t.Value.TotalMilliseconds:0} ms"));
        TestContext.Current.SendDiagnosticMessage(string.Join("; ", tempos.Select(t => $"{t.Key} {t.Value.TotalMilliseconds:0} ms")));

        // O custo fica no tamanho dos 30 dias, nunca no do histórico inteiro: toda leitura de vendas, pagamentos e eventos
        // entra por um índice (a sessão, a venda ou o agregado), sem varrer a tabela. Um índice pela hora
        // (coalesce da finalização) faria a primeira página instantânea, mas o filtro que acha pouco (CPF, forma rara)
        // varreria anos de vendas: o plano que cresce com o histórico é recusado aqui (README do PDV › decisão 70).
        var leituras = planos.Planos.Where(p => p.Sql.Contains("FROM \"vendas\"", StringComparison.Ordinal)
                                               || p.Sql.Contains("FROM \"pagamentos_venda\"", StringComparison.Ordinal)
                                               || p.Sql.Contains("FROM \"eventos_saida\"", StringComparison.Ordinal)).ToList();
        Assert.NotEmpty(leituras);
        // Só a lista de sessões (sessoes_caixa, "s": algumas por dia) pode ser lida inteira.
        Assert.All(leituras, p => Assert.DoesNotMatch(@"SCAN (?!s( |$))", p.Plano));

        // O número novo da nuvem só é procurado no outbox quando o texto cabe na faixa da renumeração (acima de 9.000.000):
        // o CPF, o CNPJ e o número do caixa (inteiro ou de exibição) não leem o resultado de dezenas de milhares de eventos.
        planos.Planos.Clear();
        foreach (var texto in new[] { "12345678909", "123.456.789-09", "12345678000195", "110000", "11", "l01-c02-110000" })
        {
            await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(Texto: texto), ct: Ct);
        }

        Assert.DoesNotContain(planos.Planos, p => p.Sql.Contains("numero_original", StringComparison.Ordinal));
        await consultas.VendasAsync(Terminal, Desde, new FiltroVendas(Texto: "L01-C02-9100000"), ct: Ct);
        Assert.Contains(planos.Planos, p => p.Sql.Contains("numero_original", StringComparison.Ordinal));
        Assert.Equal(caixas[0].SessaoId, await consultas.CaixaAbertoAsync(Terminal, Ct));
    }

    /// <summary>Guarda o SQL de cada consulta do EF e o plano do SQLite para ele (EXPLAIN QUERY PLAN com os mesmos parâmetros).</summary>
    internal sealed class PlanosDasConsultas : DbCommandInterceptor
    {
        public List<(string Sql, string Plano)> Planos { get; } = [];

        public IDbContextFactory<PdvDbContext> Fabrica(string conexao) => new FabricaComPlanos(
            new DbContextOptionsBuilder<PdvDbContext>().UseSqlite(conexao).AddInterceptors(PragmasSqlite.Instancia, this).Options);

        public override async ValueTask<InterceptionResult<System.Data.Common.DbDataReader>> ReaderExecutingAsync(
            System.Data.Common.DbCommand command, CommandEventData eventData, InterceptionResult<System.Data.Common.DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            await using var explicar = command.Connection!.CreateCommand();
            explicar.CommandText = "EXPLAIN QUERY PLAN " + command.CommandText;
            foreach (System.Data.Common.DbParameter p in command.Parameters)
            {
                var copia = explicar.CreateParameter();
                copia.ParameterName = p.ParameterName;
                copia.Value = p.Value;
                explicar.Parameters.Add(copia);
            }

            var linhas = new List<string>();
            await using (var leitor = await explicar.ExecuteReaderAsync(cancellationToken))
            {
                while (await leitor.ReadAsync(cancellationToken))
                {
                    linhas.Add(leitor.GetString(3));
                }
            }

            lock (Planos)
            {
                Planos.Add((command.CommandText, string.Join(" | ", linhas)));
            }

            return result;
        }

        private sealed class FabricaComPlanos(DbContextOptions<PdvDbContext> opcoes) : IDbContextFactory<PdvDbContext>
        {
            public PdvDbContext CreateDbContext() => new(opcoes);
        }
    }

    /// <summary>Uma venda em quantas foi renumerada pela nuvem no volume sintético (rara: a fila de decisão do ERP).</summary>
    private const int RenumeradaACada = 4_000;

    /// <summary>As vendas mais novas ainda sem confirmação (sem resultado) no volume sintético.</summary>
    private const int EventosPendentes = 30;

    /// <summary>O melhor de algumas medições (a máquina de teste roda outras coisas ao mesmo tempo), por página.</summary>
    internal static async Task<TimeSpan> MedirAsync(Func<Task> acao, int vezes = 3, int porRepeticao = 1)
    {
        await acao();
        var melhor = TimeSpan.MaxValue;
        for (var i = 0; i < vezes; i++)
        {
            var relogio = Stopwatch.StartNew();
            await acao();
            melhor = TimeSpan.FromTicks(Math.Min(melhor.Ticks, relogio.Elapsed.Ticks / porRepeticao));
        }

        return melhor;
    }

    internal static void Executar(SqliteConnection conexao, string sql, params (string Nome, object Valor)[] parametros)
    {
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (nome, valor) in parametros)
        {
            cmd.Parameters.AddWithValue(nome, valor);
        }

        cmd.ExecuteNonQuery();
    }

    /// <summary>
    /// Volume sintético do plano (120 mil vendas em 90 dias, um caixa por dia, o de hoje aberto): o teto de 30 dias alcança
    /// cerca de 40 mil. Uma venda em 50 cancelada; uma em 4 no débito; uma em 97 com CPF; três operadores alternados.
    /// </summary>
    internal static class Sql
    {
        private const string Data = "strftime('%Y-%m-%dT%H:%M:%S.000Z', {0}, 'unixepoch')";

        public static readonly string Sessoes = $"""
            with recursive n(d) as (select 0 union all select d + 1 from n where d < @dias - 1)
            insert into sessoes_caixa (id, loja_id, caixa_id, numero_caixa, terminal_id, operador_id, status, dia_operacional, aberta_em,
                abertura_automatica, fundo_troco, fechada_em, fechamento_forcado, criado_em, atualizado_em, versao)
            select printf('00000000-0000-7000-9000-%012d', d), @loja, @caixa, 2, @terminal, @operador,
                case when d = @dias - 1 then 'aberta' else 'fechada' end,
                date(@inicio + d * 86400, 'unixepoch'), {string.Format(CultureInfo.InvariantCulture, Data, "@inicio + d * 86400")}, 0, 0,
                case when d = @dias - 1 then null else {string.Format(CultureInfo.InvariantCulture, Data, "@inicio + d * 86400 + 86399")} end, 0,
                {string.Format(CultureInfo.InvariantCulture, Data, "@inicio + d * 86400")}, {string.Format(CultureInfo.InvariantCulture, Data, "@inicio + d * 86400")}, 1
            from n
            """;

        public static readonly string Vendas = $"""
            with recursive n(i) as (select 0 union all select i + 1 from n where i < @total - 1),
            v(i, d, h) as (select i, i / @porDia, @inicio + (i / @porDia) * 86400 + (i % @porDia) * 64 from n)
            insert into vendas (id, acrescimo_total, atualizado_em, caixa_id, canal, criado_em, desconto_itens, desconto_total, devolucao,
                finalizada_em, cancelada_em, motivo_cancelamento, iniciada_em, loja_id, modo, numero, numero_caixa, numero_exibicao,
                operador_id, qtd_itens, relogio_confiavel, sessao_caixa_id, status, status_fiscal, subtotal_bruto, taxa_entrega,
                taxa_servico, terminal_id, tipo, tipo_preco, total, troco, valor_frete, versao, cpf_cnpj_nota, dia_operacional)
            select printf('00000000-0000-7000-8000-%012d', i + 1), 0, {string.Format(CultureInfo.InvariantCulture, Data, "h")}, @caixa, 'pdv',
                {string.Format(CultureInfo.InvariantCulture, Data, "h")}, 0, 0, 'nenhuma',
                {string.Format(CultureInfo.InvariantCulture, Data, "h")},
                case when i % 50 = 0 then {string.Format(CultureInfo.InvariantCulture, Data, "h + 30")} end,
                case when i % 50 = 0 then 'Cliente desistiu da compra' end,
                {string.Format(CultureInfo.InvariantCulture, Data, "h - 60")}, @loja, 'balcao', i + 1, 2, printf('L01-C02-%06d', i + 1),
                case i % 3 when 0 then @maria when 1 then @joao else '019a0003-0000-7000-8000-000000000009' end, 1, 1,
                printf('00000000-0000-7000-9000-%012d', d), case when i % 50 = 0 then 'cancelada' else 'finalizada' end, 'nao_aplicavel',
                100 + (i % 5000), 0, 0, @terminal, 'pdv', 'varejo', 100 + (i % 5000), 0, 0, 1,
                case when i % 97 = 0 then printf('%011d', i) end, date(h, 'unixepoch')
            from v
            """;

        public static readonly string Pagamentos = """
            insert into pagamentos_venda (id, atualizado_em, criado_em, descricao_forma, forma_pagamento_id, indicador_pagamento, lanca_quitada,
                meio_pagamento_fiscal, parcelas, sequencia, status, taxa_pct, tipo_forma, troco, valor, valor_taxa_servico, venda_id, versao)
            select printf('00000000-0000-7000-a000-%s', substr(id, 25)), atualizado_em, criado_em,
                case when numero % 4 = 0 then 'Cartão de débito' else 'Dinheiro' end,
                case when numero % 4 = 0 then @debito else @dinheiro end, 0, 1,
                case when numero % 4 = 0 then '04' else '01' end, 1, 1,
                case when status = 'cancelada' then 'estornado' else 'aprovado' end, 0,
                case when numero % 4 = 0 then 'cartao_debito' else 'dinheiro' end, 0, total, 0, id, 1
            from vendas
            """;

        /// <summary>
        /// O outbox da loja (não é expurgado; spec 8.6): um <c>venda.finalizada</c> por venda e um <c>venda.cancelada</c> por
        /// cancelada, com o payload de cerca de 5 KB (a venda com itens e pagamentos passa da página do SQLite, e o
        /// <c>resultado</c> fica depois dele), confirmados com o resultado <c>{}</c> (o de <c>EnvioPush</c>) e, uma venda em
        /// <c>@renumerada</c>, o resultado do "Aplicar com novo número" (T27); as <c>@pendentes</c> mais novas sem
        /// resultado; e a abertura e o fechamento de cada caixa.
        /// </summary>
        public static readonly string Eventos = """
            insert into eventos_saida (id, sequencia_terminal, tipo, versao_schema, agregado_tipo, agregado_id, ocorrido_em, criado_em,
                payload, payload_sha256, status, tentativas, confirmado_em, resultado, dependencias)
            select printf('00000000-0000-7000-b000-%012d', numero * 2), numero * 2, 'venda.finalizada', 1, 'venda', id, finalizada_em,
                finalizada_em, printf('{"venda":{"id":"%s","numero":%d},"itens":"%s"}', id, numero, hex(zeroblob(2500))),
                lower(hex(randomblob(32))),
                case when numero > (select max(numero) from vendas) - @pendentes then 'pendente' else 'confirmado' end, 0,
                case when numero > (select max(numero) from vendas) - @pendentes then null else finalizada_em end,
                case when numero > (select max(numero) from vendas) - @pendentes then null
                     when numero % @renumerada = 0
                         then printf('{"numero_original":%d,"numero":%d,"numero_exibicao":"L01-C02-%07d"}', numero, 9000000 + numero, 9000000 + numero)
                     else '{}' end,
                '[]'
            from vendas;
            insert into eventos_saida (id, sequencia_terminal, tipo, versao_schema, agregado_tipo, agregado_id, ocorrido_em, criado_em,
                payload, payload_sha256, status, tentativas, confirmado_em, resultado, dependencias)
            select printf('00000000-0000-7000-b000-%012d', numero * 2 + 1), numero * 2 + 1, 'venda.cancelada', 1, 'venda', id, cancelada_em,
                cancelada_em, printf('{"venda_id":"%s","pagamentos":"%s"}', id, hex(zeroblob(800))), lower(hex(randomblob(32))), 'confirmado', 0,
                cancelada_em, '{}', '[]'
            from vendas where status = 'cancelada';
            insert into eventos_saida (id, sequencia_terminal, tipo, versao_schema, agregado_tipo, agregado_id, ocorrido_em, criado_em,
                payload, payload_sha256, status, tentativas, confirmado_em, resultado, dependencias)
            select printf('00000000-0000-7000-c000-%012d', rowid * 2 + e.f), 1000000000 + rowid * 2 + e.f,
                case e.f when 0 then 'caixa.aberto' else 'caixa.fechado' end, 1, 'sessao_caixa', id,
                case e.f when 0 then aberta_em else coalesce(fechada_em, aberta_em) end, aberta_em,
                printf('{"sessao_id":"%s","formas":"%s"}', id, hex(zeroblob(600))), lower(hex(randomblob(32))), 'confirmado', 0, aberta_em, '{}', '[]'
            from sessoes_caixa, (select 0 as f union all select 1) e
            where e.f = 0 or status = 'fechada';
            """;
    }
}
