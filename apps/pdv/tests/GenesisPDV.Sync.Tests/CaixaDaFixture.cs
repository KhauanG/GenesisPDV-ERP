using GenesisPDV.Data.Entidades;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// As linhas locais de caixa das fixtures <c>caixa.*.payload.json</c> e <c>vasilhame.movimentado.payload.json</c> (ids e
/// horários da sincronizacao.md 9.1: Loja 1, Caixa 02, MARIA abrindo às 08:01 de 29/10, CARLOS retirando a sangria).
/// Cada método devolve linhas novas: o teste pode mudá-las sem afetar os outros.
/// </summary>
internal static class CaixaDaFixture
{
    public static readonly Guid Loja = Guid.Parse("01a18752-3782-7bda-ad3c-2d6d1a3d1fa7");
    public static readonly Guid Caixa = Guid.Parse("01a18752-c8a9-7970-9641-9f828b9d2434");
    public static readonly Guid Terminal = Guid.Parse("01a18751-a521-7238-b924-56de3eb13b90");
    public static readonly Guid Maria = Guid.Parse("01a18754-76cb-7b74-b2e7-06298fadc1a6");
    public static readonly Guid Carlos = Guid.Parse("01a18755-09d1-76b6-8b81-48f6b38a088c");
    public static readonly Guid Sessao = Guid.Parse("01a18755-98a1-7472-96da-1dac72ff5d2a");
    public static readonly Guid Fechamento = Guid.Parse("01a18767-aae7-795a-bf3c-4c06434308bc");
    public static readonly Guid Sangria = Guid.Parse("01a18766-8a42-743c-a493-3b83757750a9");
    public static readonly DateTimeOffset AbertaEm = Instante("2026-10-29T11:01:15.000Z");
    public static readonly DateOnly Dia = new(2026, 10, 29);

    /// <summary>"F2 Contar cédulas" da abertura: 150,00 em 1×100, 2×20, 1×5, 3×1 e 4×0,50.</summary>
    public static readonly IReadOnlyDictionary<decimal, int> CedulasAbertura =
        new Dictionary<decimal, int> { [100m] = 1, [20m] = 2, [5m] = 1, [1m] = 3, [0.50m] = 4 };

    public static readonly IReadOnlyDictionary<decimal, int> CedulasSangria = new Dictionary<decimal, int> { [100m] = 8, [50m] = 4 };

    public static DateTimeOffset Instante(string iso) => DateTimeOffset.Parse(iso, System.Globalization.CultureInfo.InvariantCulture);

    public static SessaoCaixaRegistro SessaoAberta() => new()
    {
        Id = Sessao,
        LojaId = Loja,
        CaixaId = Caixa,
        NumeroCaixa = 2,
        TerminalId = Terminal,
        OperadorId = Maria,
        Status = StatusSessaoCaixa.Aberta,
        DiaOperacional = Dia,
        AbertaEm = AbertaEm,
        FundoTroco = 150m,
    };

    public static MovimentoCaixaRegistro Abertura() =>
        Movimento(Guid.Parse("01a18756-2b84-7c24-81a9-e71fde8a774b"), TipoMovimentoCaixa.Abertura, 150m, AbertaEm);

    public static MovimentoCaixaRegistro Reforco()
    {
        var m = Movimento(Guid.Parse("01a18765-1c42-7d3a-9e51-2b6c7d8e9f01"), TipoMovimentoCaixa.Reforco, 50m, Instante("2026-10-29T13:10:02.500Z"));
        m.QuemRetiraUsuarioId = Carlos;
        m.QuemRetiraNome = "CARLOS";
        m.Observacao = "Troco em moedas";
        return m;
    }

    public static MovimentoCaixaRegistro SangriaDoDia()
    {
        var m = Movimento(Sangria, TipoMovimentoCaixa.Sangria, 1000m, Instante("2026-10-29T15:20:44.310Z"));
        m.QuemRetiraUsuarioId = Carlos;
        m.QuemRetiraNome = "CARLOS";
        m.Observacao = "Depósito banco";
        m.InfAdicionais = "Malote 4471";
        return m;
    }

    /// <summary>A sangria de 1.000,00 cancelada às 15:31 (era 100,00), liberada pelo CARLOS.</summary>
    public static MovimentoCaixaRegistro SangriaCancelada()
    {
        var m = SangriaDoDia();
        m.Cancelado = true;
        m.CanceladoEm = Instante("2026-10-29T15:31:02.004Z");
        m.CanceladoPorId = Maria;
        m.AutorizadoCancelamentoPorId = Carlos;
        m.MotivoCancelamento = "Valor digitado errado (era 100,00)";
        return m;
    }

    /// <summary>Fechamento das 20:05 (zera, com a <c>sangria_fechamento</c>) ou a troca de turno das 14:00 (não zera).</summary>
    public static (FechamentoCaixaRegistro Fechamento, List<FechamentoCaixaFormaRegistro> Formas, MovimentoCaixaRegistro? Sangria, DateTimeOffset FechadaEm) Fechado(bool trocaTurno = false)
    {
        var em = Instante(trocaTurno ? "2026-10-29T17:00:12.640Z" : "2026-10-29T23:05:40.118Z");
        var fechamento = new FechamentoCaixaRegistro
        {
            Id = Fechamento,
            SessaoCaixaId = Sessao,
            LojaId = Loja,
            CaixaId = Caixa,
            TerminalId = Terminal,
            NumeroCaixa = 2,
            Tipo = trocaTurno ? "troca_turno" : "fechamento",
            ZeraCaixa = !trocaTurno,
            UsuarioAnteriorId = Maria,
            ValorCaixa = trocaTurno ? 1734.50m : 0m,
            TotalCalculado = 6761.40m,
            TotalDigitado = 6759.90m,
            FechamentoCego = true,
            OcorridoEm = em,
            DiaOperacional = Dia,
            Resumo = """
                     {"qtd_vendas":212,"total_vendas":"9421.40","ticket_medio":"44.44","qtd_canceladas":3,"total_canceladas":"88.30",
                      "qtd_itens_cancelados":9,"total_itens_cancelados":"61.70","total_descontos":"73.15","qtd_liberacoes":4,"qtd_trocas":0,
                      "total_vales_emitidos":"0.00","nfce_emitidas":0,"nfce_contingencia":0,"nfce_pendentes":0,"ultima_sequencia_evento":1288}
                     """,
        };
        List<FechamentoCaixaFormaRegistro> formas =
        [
            Forma("01a18768-3afe-7662-9562-69f0e5d7b875", "01a1875e-a2ca-7299-9d65-a441d58842de", "Dinheiro", "dinheiro", 1736.00m, 1734.50m, 96),
            Forma("01a18768-cb42-7ff7-bf50-bde4382567b8", "01a1875f-3243-7ab8-b5a2-40ae5af30553", "PIX", "pix", 1105.00m, 1105.00m, 31),
            Forma("01a18769-5ae5-7175-be57-0ddf827050a8", "01a1875f-c261-7aef-afc8-9849b3aa7efe", "Cartão de Crédito", "cartao_credito", 3920.40m, 3920.40m, 54),
        ];
        MovimentoCaixaRegistro? sangria = null;
        if (!trocaTurno)
        {
            sangria = Movimento(Guid.Parse("01a18769-ede5-71c3-9c71-3d960c0fd195"), TipoMovimentoCaixa.SangriaFechamento, 1734.50m, em);
            sangria.QuemRetiraUsuarioId = Maria;
            sangria.QuemRetiraNome = "MARIA";
            sangria.Observacao = "Fechamento";
        }

        return (fechamento, formas, sangria, em);
    }

    /// <summary>Devolução avulsa de 6 garrafas 600 ml vazias (F11 › V), destino <c>entrada</c>.</summary>
    public static MovimentoVasilhameRegistro DevolucaoAvulsa() => new()
    {
        Id = Guid.Parse("01a187a2-3d4e-7f60-9a1b-2c3d4e5f6a03"),
        SessaoCaixaId = Sessao,
        LojaId = Loja,
        CaixaId = Caixa,
        TerminalId = Terminal,
        OperadorId = Maria,
        ProdutoVasilhameId = Guid.Parse("01a1875d-11aa-7b2c-9d3e-4f5a6b7c8d04"),
        Quantidade = 6m,
        Destino = "entrada",
        OcorridoEm = Instante("2026-10-29T15:20:00.000Z"),
    };

    private static MovimentoCaixaRegistro Movimento(Guid id, string tipo, decimal valor, DateTimeOffset em) => new()
    {
        Id = id,
        SessaoCaixaId = Sessao,
        LojaId = Loja,
        CaixaId = Caixa,
        NumeroCaixa = 2,
        TerminalId = Terminal,
        Tipo = tipo,
        Valor = valor,
        OperadorId = Maria,
        OcorridoEm = em,
    };

    private static FechamentoCaixaFormaRegistro Forma(string id, string forma, string descricao, string tipo, decimal calculado, decimal digitado, int quantidade) => new()
    {
        Id = Guid.Parse(id),
        FechamentoId = Fechamento,
        FormaPagamentoId = Guid.Parse(forma),
        DescricaoForma = descricao,
        TipoForma = tipo,
        ValorCalculado = calculado,
        ValorDigitado = digitado,
        QuantidadePagamentos = quantidade,
    };
}
