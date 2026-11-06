using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using static GenesisPDV.Data.Tests.ConsultasHistoricoLocalTests;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Os caixas antigos da Central (bloco G6; plano 4.3 e 5.2; decisões do dono de 04/11/2026: PC-9 opção A e os 30 dias): o
/// aberto primeiro e os fechados nos últimos 30 dias deste terminal, pelo retrato do fechamento (tipo, o contado, o
/// resumo guardado, as sangrias e os reforços), as canceladas depois e o envio do <c>caixa.fechado</c>, nunca o
/// calculado nem a diferença; o original do relatório na fila de impressão; e o desempenho com o volume sintético do
/// G5 (120 mil vendas, o outbox e um cupom na fila por venda), pelo índice novo da fila.
/// </summary>
[Collection(ColecaoVolumeSintetico.Nome)]
public class ConsultasHistoricoCaixasTests
{
    private static readonly Guid Terminal = Guid.Parse("019a0000-0000-7000-8000-00000000c002");
    private static readonly Guid OutroTerminal = Guid.Parse("019a0000-0000-7000-8000-00000000c003");
    private static readonly Guid Loja = Guid.Parse("019a0000-0000-7000-8000-00000000a001");
    private static readonly Guid Caixa = Guid.Parse("019a0000-0000-7000-8000-00000000b002");
    private static readonly Guid Maria = Guid.Parse("019a0003-0000-7000-8000-000000000001");
    private static readonly Guid Joao = Guid.Parse("019a0003-0000-7000-8000-000000000003");
    private static readonly Guid Dinheiro = Guid.Parse("019a0004-0000-7000-8000-000000000101");
    private static readonly Guid Debito = Guid.Parse("019a0004-0000-7000-8000-000000000102");

    private static readonly DateTimeOffset Agora = new(2026, 11, 5, 15, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset Desde = new DateTimeOffset(Agora.UtcDateTime.Date, TimeSpan.Zero).AddDays(-(ConsultasHistoricoLocal.LimiteDias - 1));

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static long _numero = 50_000;

    private static SessaoCaixaRegistro Sessao(DateTimeOffset aberta, DateTimeOffset? fechada, Guid? terminal = null, Guid? operador = null, decimal fundo = 100m) => new()
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
        FundoTroco = fundo,
        FechadaEm = fechada,
        CriadoEm = aberta,
        AtualizadoEm = fechada ?? aberta,
        Versao = 1,
    };

    private static VendaRegistro Venda(SessaoCaixaRegistro sessao, DateTimeOffset hora, decimal total, DateTimeOffset? cancelada = null)
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
            TerminalId = sessao.TerminalId,
            SessaoCaixaId = sessao.Id,
            OperadorId = sessao.OperadorId,
            IniciadaEm = hora.AddMinutes(-1),
            FinalizadaEm = hora,
            CanceladaEm = cancelada,
            MotivoCancelamento = cancelada is null ? null : "Cliente desistiu da compra",
            Status = cancelada is null ? StatusVenda.Finalizada : StatusVenda.Cancelada,
            QtdItens = 1,
            SubtotalBruto = total,
            Total = total,
            CriadoEm = hora,
            AtualizadoEm = hora,
            Versao = 1,
        };
    }

    /// <summary>O fechamento como o <c>ServicoCaixa.FecharAsync</c> grava: o calculado e a diferença também (só não aparecem).</summary>
    private static (FechamentoCaixaRegistro Fechamento, FechamentoCaixaFormaRegistro[] Formas) Fechamento(
        SessaoCaixaRegistro sessao, bool zera, decimal calculado, (Guid Forma, string Descricao, string Tipo, decimal Contado)[] formas,
        string? justificativa = null)
    {
        var id = Guid.CreateVersion7();
        var contado = formas.Sum(f => f.Contado);
        var fechamento = new FechamentoCaixaRegistro
        {
            Id = id,
            SessaoCaixaId = sessao.Id,
            LojaId = Loja,
            CaixaId = Caixa,
            TerminalId = sessao.TerminalId,
            NumeroCaixa = 2,
            Tipo = zera ? "fechamento" : "troca_turno",
            ZeraCaixa = zera,
            UsuarioAnteriorId = sessao.OperadorId,
            ValorCaixa = zera ? 0m : contado,
            TotalCalculado = calculado,
            TotalDigitado = contado,
            Justificativa = justificativa,
            FechamentoCego = true,
            OcorridoEm = sessao.FechadaEm!.Value,
            DiaOperacional = sessao.DiaOperacional,
            Resumo = """{"qtd_vendas":2,"total_vendas":"130.00","ticket_medio":"65.00","qtd_canceladas":1,"total_canceladas":"45.00","qtd_itens_cancelados":1,"total_itens_cancelados":"3.50","total_descontos":"2.00","qtd_liberacoes":1,"qtd_trocas":0,"total_vales_emitidos":"0.00","nfce_emitidas":0,"nfce_contingencia":0,"nfce_pendentes":0,"ultima_sequencia_evento":12}""",
            CriadoEm = sessao.FechadaEm.Value,
            AtualizadoEm = sessao.FechadaEm.Value,
            Versao = 1,
        };
        return (fechamento, [.. formas.Select(f => new FechamentoCaixaFormaRegistro
        {
            Id = Guid.CreateVersion7(),
            FechamentoId = id,
            FormaPagamentoId = f.Forma,
            DescricaoForma = f.Descricao,
            TipoForma = f.Tipo,
            ValorCalculado = f.Contado + 7.77m,
            ValorDigitado = f.Contado,
            QuantidadePagamentos = 3,
            CriadoEm = fechamento.CriadoEm,
            AtualizadoEm = fechamento.CriadoEm,
            Versao = 1,
        })]);
    }

    private static MovimentoCaixaRegistro Movimento(SessaoCaixaRegistro sessao, string tipo, decimal valor, DateTimeOffset quando, bool cancelado = false) => new()
    {
        Id = Guid.CreateVersion7(),
        SessaoCaixaId = sessao.Id,
        LojaId = Loja,
        CaixaId = Caixa,
        NumeroCaixa = 2,
        TerminalId = sessao.TerminalId,
        Tipo = tipo,
        Valor = valor,
        OperadorId = sessao.OperadorId,
        QuemRetiraNome = tipo == TipoMovimentoCaixa.Sangria ? "JOAO" : null,
        OcorridoEm = quando,
        Cancelado = cancelado,
        CanceladoEm = cancelado ? quando.AddMinutes(5) : null,
        MotivoCancelamento = cancelado ? "Lançada errado" : null,
        CriadoEm = quando,
        AtualizadoEm = quando,
        Versao = 1,
    };

    private static EventoSaida CaixaFechado(SessaoCaixaRegistro sessao, string status, long sequencia) => new()
    {
        Id = Guid.CreateVersion7(),
        SequenciaTerminal = sequencia,
        Tipo = "caixa.fechado",
        VersaoSchema = 1,
        AgregadoTipo = "sessao_caixa",
        AgregadoId = sessao.Id,
        OcorridoEm = sessao.FechadaEm!.Value,
        CriadoEm = sessao.FechadaEm.Value,
        Payload = "{}",
        PayloadSha256 = new string('a', 64),
        Status = status,
    };

    private static async Task GravarAsync(BancoTemporario banco, params object[] linhas)
    {
        await using var db = banco.Fabrica.CreateDbContext();
        db.AddRange(linhas);
        await db.SaveChangesAsync(Ct);
    }

    [Fact]
    public async Task Caixas_pelo_retrato_o_aberto_primeiro_e_os_fechados_nos_30_dias_sem_calculado_nem_diferenca()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var aberta = Sessao(Agora.AddHours(-6), null, fundo: 50m);
        var tresDias = Sessao(Agora.AddDays(-3).AddHours(-8), Agora.AddDays(-3), operador: Joao);
        var vinteNove = Sessao(Desde.AddHours(1), Desde.AddHours(10));
        var semRetrato = Sessao(Agora.AddDays(-10).AddHours(-8), Agora.AddDays(-10));
        var trintaUm = Sessao(Agora.AddDays(-31).AddHours(-8), Agora.AddDays(-31));
        var outro = Sessao(Agora.AddDays(-1).AddHours(-8), Agora.AddDays(-1), terminal: OutroTerminal);
        await GravarAsync(banco, aberta, tresDias, vinteNove, semRetrato, trintaUm, outro);
        var (f3, formas3) = Fechamento(tresDias, zera: true, calculado: 999.99m,
            [(Debito, "Cartão de débito", "cartao_debito", 30m), (Dinheiro, "Dinheiro", "dinheiro", 160m)], justificativa: "Faltou troco");
        var (f29, formas29) = Fechamento(vinteNove, zera: false, calculado: 80m, [(Dinheiro, "Dinheiro", "dinheiro", 77m)]);
        var (f31, formas31) = Fechamento(trintaUm, zera: true, calculado: 99m, [(Dinheiro, "Dinheiro", "dinheiro", 99m)]);
        var (fOutro, formasOutro) = Fechamento(outro, zera: true, calculado: 66m, [(Dinheiro, "Dinheiro", "dinheiro", 66m)]);
        var depois = Venda(tresDias, Agora.AddDays(-3).AddHours(-3), 45m, cancelada: Agora.AddDays(-2));
        await GravarAsync(banco, [f3, .. formas3, f29, .. formas29, f31, .. formas31, fOutro, .. formasOutro,
            Venda(aberta, Agora.AddHours(-1), 12.90m),
            Venda(tresDias, Agora.AddDays(-3).AddHours(-2), 100m),
            // Cancelada na própria sessão (antes do fechamento): não é "depois".
            Venda(tresDias, Agora.AddDays(-3).AddHours(-1), 8m, cancelada: Agora.AddDays(-3).AddMinutes(-30)),
            depois,
            Venda(vinteNove, Desde.AddHours(5), 77m),
            Movimento(tresDias, TipoMovimentoCaixa.Abertura, 100m, tresDias.AbertaEm),
            Movimento(tresDias, TipoMovimentoCaixa.Sangria, 200m, Agora.AddDays(-3).AddHours(-4)),
            Movimento(tresDias, TipoMovimentoCaixa.Reforco, 20m, Agora.AddDays(-3).AddHours(-5), cancelado: true),
            Movimento(tresDias, TipoMovimentoCaixa.SangriaFechamento, 160m, tresDias.FechadaEm!.Value),
            CaixaFechado(tresDias, StatusEventoSaida.Confirmado, 10),
            CaixaFechado(vinteNove, StatusEventoSaida.Rejeitado, 11)]);
        var consultas = new ConsultasHistoricoLocal(banco.Fabrica);

        var caixas = await consultas.SessoesAsync(Terminal, Desde, Ct);
        Assert.Equal([aberta.Id, tresDias.Id, semRetrato.Id, vinteNove.Id], caixas.Select(c => c.SessaoId));
        var a = caixas[0];
        Assert.Equal((true, 1, 50m, (Guid?)null, (string?)null, (decimal?)null, (string?)null, 0), (a.Aberto, a.QuantidadeVendas, a.FundoTroco, a.FechamentoId,
            a.TipoFechamento, a.Contado, a.EnvioFechamento, a.CanceladasDepois));
        var t = caixas[1];
        Assert.Equal((f3.Id, "fechamento", (decimal?)190m, StatusEventoSaida.Confirmado, 3, 1, 45m, Joao),
            (t.FechamentoId, t.TipoFechamento, t.Contado, t.EnvioFechamento, t.QuantidadeVendas, t.CanceladasDepois, t.TotalCanceladasDepois, t.OperadorId));
        Assert.Equal(((Guid?)null, (string?)null, (string?)null), (caixas[2].FechamentoId, caixas[2].TipoFechamento, caixas[2].EnvioFechamento));
        Assert.Equal(("troca_turno", StatusEventoSaida.Rejeitado), (caixas[3].TipoFechamento, caixas[3].EnvioFechamento));

        // PC-9: o calculado e a diferença não existem no que a aba lê (só o contado do relatório impresso).
        foreach (var tipo in new[] { typeof(CaixaHistorico), typeof(FechamentoRetrato), typeof(FormaContada), typeof(RetratoCaixa) })
        {
            Assert.DoesNotContain(tipo.GetProperties(), p => p.Name.Contains("Calculado", StringComparison.Ordinal) || p.Name.Contains("Diferenca", StringComparison.Ordinal));
        }

        var retrato = await consultas.RetratoAsync(Terminal, Desde, tresDias.Id, Ct);
        var f = retrato!.Fechamento!;
        Assert.Equal(("fechamento", true, 190m, 0m, "Faltou troco", tresDias.FechadaEm), (f.Tipo, f.ZeraCaixa, f.TotalContado, f.ValorCaixa, f.Justificativa, f.OcorridoEm));
        Assert.Equal([("Dinheiro", 160m), ("Cartão de débito", 30m)], f.Formas.Select(x => (x.Descricao, x.Contado)));
        Assert.Equal(new ResumoTurno(2, 130m, 1, 45m, 1, 3.50m, 2m, 1), f.Resumo);
        // Como o relatório: só sangrias e reforços (a abertura e a sangria do fechamento ficam de fora), na ordem.
        Assert.Equal([(TipoMovimentoCaixa.Reforco, 20m, true), (TipoMovimentoCaixa.Sangria, 200m, false)],
            retrato.Movimentos.Select(m => (m.Tipo, m.Valor, m.Cancelado)));
        // Como o relatório também: sem quem retirou nem a observação (ficam no comprovante do movimento e no ERP).
        Assert.DoesNotContain(typeof(MovimentoRetrato).GetProperties(), p => p.Name.Contains("Quem", StringComparison.Ordinal) || p.Name.Contains("Observacao", StringComparison.Ordinal));
        var cancelada = Assert.Single(retrato.CanceladasDepois);
        Assert.Equal((depois.Id, depois.NumeroExibicao, 45m, Agora.AddDays(-2)), (cancelada.VendaId, cancelada.NumeroExibicao, cancelada.Total, cancelada.CanceladaEm));

        var daTroca = (await consultas.RetratoAsync(Terminal, Desde, vinteNove.Id, Ct))!.Fechamento!;
        Assert.Equal(("troca_turno", false, 77m), (daTroca.Tipo, daTroca.ZeraCaixa, daTroca.ValorCaixa));
        var doAberto = await consultas.RetratoAsync(Terminal, Desde, aberta.Id, Ct);
        Assert.Null(doAberto!.Fechamento);
        Assert.Empty(doAberto.CanceladasDepois);
        // O teto fica no SQL: o de 31 dias e o de outro terminal não voltam nem pedidos pelo id.
        Assert.Null(await consultas.RetratoAsync(Terminal, Desde, trintaUm.Id, Ct));
        Assert.Null(await consultas.RetratoAsync(Terminal, Desde, outro.Id, Ct));
    }

    [Fact]
    public async Task Resumo_fora_do_contrato_nao_derruba_o_retrato()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var sessao = Sessao(Agora.AddDays(-2).AddHours(-8), Agora.AddDays(-2));
        var (f, formas) = Fechamento(sessao, zera: true, calculado: 10m, [(Dinheiro, "Dinheiro", "dinheiro", 10m)]);
        f.Resumo = """{"qtd_vendas":2}""";
        await GravarAsync(banco, [sessao, f, .. formas]);
        var retrato = await new ConsultasHistoricoLocal(banco.Fabrica).RetratoAsync(Terminal, Desde, sessao.Id, Ct);
        Assert.Null(retrato!.Fechamento!.Resumo);
        Assert.Equal(10m, retrato.Fechamento.TotalContado);
    }

    [Fact]
    public async Task Original_do_documento_e_o_primeiro_trabalho_da_fila_e_a_2a_via_nao_o_troca()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var relogio = new RelogioFixo(Agora.AddDays(-15));
        var fila = new RepositorioImpressao(banco.Fabrica, relogio);
        var fechamento = Guid.CreateVersion7();
        await fila.EnfileirarAsync("cupom", fechamento, [9, 9], ct: Ct);
        await fila.EnfileirarAsync("fechamento_caixa", fechamento, [1, 2, 3], ct: Ct);
        relogio.Agora = Agora;
        await fila.EnfileirarAsync("fechamento_caixa_reimpressao", fechamento, [7, 1, 2, 3], ct: Ct);
        await fila.EnfileirarAsync("fechamento_caixa", Guid.CreateVersion7(), [4], ct: Ct);

        Assert.Equal([1, 2, 3], await fila.OriginalAsync("fechamento_caixa", fechamento, Ct));
        Assert.Equal([9, 9], await fila.OriginalAsync("cupom", fechamento, Ct));
        Assert.Null(await fila.OriginalAsync("fechamento_caixa", Guid.CreateVersion7(), Ct));
    }

    [Fact]
    public async Task Caixas_e_o_original_com_o_volume_sintetico_ficam_abaixo_de_300_ms_pelo_indice()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        const int dias = 90;
        const int total = 120_000;
        var porDia = (total + dias - 1) / dias;
        var inicio = new DateTimeOffset(Agora.UtcDateTime.Date, TimeSpan.Zero).AddDays(-(dias - 1)).AddHours(8);
        using (var conexao = banco.AbrirConexao())
        {
            Executar(conexao, Sql.Sessoes, ("@dias", (object)dias), ("@inicio", (object)inicio.ToUnixTimeSeconds()), ("@terminal", (object)Terminal.ToString()),
                ("@loja", (object)Loja.ToString()), ("@caixa", (object)Caixa.ToString()), ("@operador", (object)Maria.ToString()));
            Executar(conexao, Sql.Vendas, ("@total", (object)total), ("@porDia", (object)porDia), ("@inicio", (object)inicio.ToUnixTimeSeconds()), ("@terminal", (object)Terminal.ToString()),
                ("@loja", (object)Loja.ToString()), ("@caixa", (object)Caixa.ToString()), ("@maria", (object)Maria.ToString()), ("@joao", (object)Joao.ToString()));
            Executar(conexao, Sql.Pagamentos, ("@dinheiro", (object)Dinheiro.ToString()), ("@debito", (object)Debito.ToString()));
            Executar(conexao, Sql.Eventos, ("@renumerada", (object)4_000), ("@pendentes", (object)30));
            // A fila de impressão como a da loja (também não é expurgada): o cupom de cada venda, com os bytes ESC/POS.
            Executar(conexao, """
                insert into fila_impressao (id, tipo_documento, referencia_id, impressora, conteudo, vias, status, tentativas, criado_em, impresso_em)
                select printf('00000000-0000-7000-d000-%012d', numero), 'cupom', id, 'principal', randomblob(1500), 1, 'impresso', 1, finalizada_em, finalizada_em
                from vendas
                """);
        }

        // O fechamento de cada caixa fechado, com as formas e o relatório na fila (no meio dos cupons do dia).
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            var fechadas = await db.SessoesCaixa.Where(s => s.Status == StatusSessaoCaixa.Fechada).ToListAsync(Ct);
            foreach (var s in fechadas)
            {
                var (f, formas) = Fechamento(s, zera: true, calculado: 5000m, [(Dinheiro, "Dinheiro", "dinheiro", 4000m), (Debito, "Cartão de débito", "cartao_debito", 1000m)]);
                db.AddRange([f, .. formas]);
                db.FilaImpressao.Add(new FilaImpressao
                {
                    Id = Guid.CreateVersion7(),
                    TipoDocumento = "fechamento_caixa",
                    ReferenciaId = f.Id,
                    Conteudo = [.. Enumerable.Repeat((byte)0x41, 3000)],
                    Status = "impresso",
                    CriadoEm = f.OcorridoEm,
                });
            }

            await db.SaveChangesAsync(Ct);
        }

        using (var conexao = banco.AbrirConexao())
        {
            Executar(conexao, "analyze");
        }

        Assert.True((long)banco.Escalar("select count(*) from fila_impressao")! > total);
        var planos = new PlanosDasConsultas();
        var consultas = new ConsultasHistoricoLocal(planos.Fabrica(banco.Fabrica.StringConexao));
        var fila = new RepositorioImpressao(planos.Fabrica(banco.Fabrica.StringConexao), new RelogioFixo(Agora));
        var caixas = await consultas.SessoesAsync(Terminal, Desde, Ct);
        Assert.InRange(caixas.Count, 29, 31);
        Assert.True(caixas[0].Aberto);
        Assert.All(caixas.Skip(1), c => Assert.Equal(5000m, c.Contado));
        var meio = caixas[caixas.Count / 2];
        byte[]? original = null;
        var tempos = new Dictionary<string, TimeSpan>
        {
            ["caixas"] = await MedirAsync(() => consultas.SessoesAsync(Terminal, Desde, Ct)),
            ["detalhe de um fechado"] = await MedirAsync(() => consultas.RetratoAsync(Terminal, Desde, meio.SessaoId, Ct)),
            ["detalhe do aberto"] = await MedirAsync(() => consultas.RetratoAsync(Terminal, Desde, caixas[0].SessaoId, Ct)),
            ["original do fechamento"] = await MedirAsync(async () => original = await fila.OriginalAsync("fechamento_caixa", meio.FechamentoId!.Value, Ct)),
        };
        Assert.Equal(3000, original!.Length);
        Assert.All(tempos, x => Assert.True(x.Value < ColecaoVolumeSintetico.TetoConsulta, $"{x.Key}: {x.Value.TotalMilliseconds:0} ms"));
        TestContext.Current.SendDiagnosticMessage(string.Join("; ", tempos.Select(x => $"{x.Key} {x.Value.TotalMilliseconds:0} ms")));

        // Nada que cresce com as vendas é varrido: a fila (mais de 120 mil trabalhos com os bytes) pelo índice novo, as
        // vendas pela sessão, o outbox pelo agregado, as formas e os movimentos pelo fechamento e pela sessão. Só as
        // tabelas de uma linha por caixa (algumas por dia) podem ser lidas inteiras: a lista de sessões ("s") e, na lista
        // da aba, os fechamentos ("f"; com poucos caixas o SQLite prefere varrer a usar o uq_fechamentos_caixa_sessao_caixa_id).
        var leituras = planos.Planos.Where(p => new[] { "fila_impressao", "vendas", "eventos_saida", "fechamentos_caixa", "fechamentos_caixa_formas", "movimentos_caixa" }
            .Any(t => p.Sql.Contains($"FROM \"{t}\"", StringComparison.Ordinal))).ToList();
        Assert.NotEmpty(leituras);
        Assert.All(leituras, p => Assert.DoesNotMatch(
            p.Sql.Contains("FROM \"fechamentos_caixa\" AS \"f\"", StringComparison.Ordinal) ? @"SCAN (?!(s|f)( |$))" : @"SCAN (?!s( |$))", p.Plano));
        Assert.All(planos.Planos.Where(p => p.Sql.Contains("FROM \"fila_impressao\"", StringComparison.Ordinal)), p => Assert.DoesNotContain("SCAN", p.Plano, StringComparison.Ordinal));
        Assert.Contains(planos.Planos, p => p.Plano.Contains("ix_fila_impressao_documento", StringComparison.Ordinal));
    }

    private sealed class RelogioFixo(DateTimeOffset agora) : Core.Comum.IRelogio
    {
        public DateTimeOffset Agora { get; set; } = agora;
    }
}
