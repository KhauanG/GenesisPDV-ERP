using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Fase 1C (bloco C9): a sessão de caixa no banco local. Cada fato grava as linhas e o evento num commit; as regras que
/// protegem o banco e o protocolo ficam aqui (uma sessão aberta por terminal, abertura recusada em desativação, movimento
/// só na sessão aberta, abertura = fundo de troco, cancelamento só de sangria e reforço). O payload e o envelope são
/// conferidos no <c>GravadorOutboxTests</c> (Sync.Tests).
/// </summary>
public class RepositorioCaixaTests
{
    private static readonly Guid Terminal = Guid.CreateVersion7();
    private static readonly Guid Operador = Guid.CreateVersion7();

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<(BancoTemporario Banco, RepositorioCaixa Repo)> CriarAsync()
    {
        var banco = new BancoTemporario();
        await banco.InicializarAsync();
        return (banco, new RepositorioCaixa(banco.Fabrica, banco.Relogio));
    }

    private static SessaoCaixaRegistro Sessao(DateTimeOffset agora) => new()
    {
        Id = IdGerador.Novo(),
        LojaId = Guid.CreateVersion7(),
        CaixaId = Guid.CreateVersion7(),
        NumeroCaixa = 2,
        TerminalId = Terminal,
        OperadorId = Operador,
        DiaOperacional = new DateOnly(2026, 10, 29),
        AbertaEm = agora,
        FundoTroco = 150m,
    };

    /// <summary>Sessão com fundo 0,00: abre sem movimento de abertura.</summary>
    private static SessaoCaixaRegistro SemFundo(DateTimeOffset agora)
    {
        var sessao = Sessao(agora);
        sessao.FundoTroco = 0m;
        return sessao;
    }

    private static MovimentoCaixaRegistro Movimento(SessaoCaixaRegistro s, string tipo, decimal valor, DateTimeOffset agora) => new()
    {
        Id = IdGerador.Novo(),
        SessaoCaixaId = s.Id,
        LojaId = s.LojaId,
        CaixaId = s.CaixaId,
        NumeroCaixa = s.NumeroCaixa,
        TerminalId = s.TerminalId,
        Tipo = tipo,
        Valor = valor,
        OperadorId = Operador,
        QuemRetiraNome = tipo == TipoMovimentoCaixa.Sangria ? "CARLOS" : null,
        OcorridoEm = agora,
    };

    private static MovimentoVasilhameRegistro Devolucao(SessaoCaixaRegistro s, DateTimeOffset agora) => new()
    {
        Id = IdGerador.Novo(),
        SessaoCaixaId = s.Id,
        LojaId = s.LojaId,
        CaixaId = s.CaixaId,
        TerminalId = s.TerminalId,
        OperadorId = Operador,
        ProdutoVasilhameId = Guid.CreateVersion7(),
        Quantidade = 6m,
        Destino = "entrada",
        OcorridoEm = agora,
    };

    private static FechamentoCaixaRegistro TrocaTurno(SessaoCaixaRegistro s, DateTimeOffset agora) => new()
    {
        Id = IdGerador.Novo(),
        SessaoCaixaId = s.Id,
        LojaId = s.LojaId,
        CaixaId = s.CaixaId,
        TerminalId = Terminal,
        NumeroCaixa = 2,
        Tipo = "troca_turno",
        UsuarioAnteriorId = Operador,
        ValorCaixa = s.FundoTroco,
        TotalCalculado = s.FundoTroco,
        TotalDigitado = s.FundoTroco,
        FechamentoCego = true,
        OcorridoEm = agora,
        DiaOperacional = s.DiaOperacional,
        Resumo = """{"ultima_sequencia_evento":1}""",
    };

    private static void Cancelar(MovimentoCaixaRegistro movimento, DateTimeOffset agora)
    {
        movimento.Cancelado = true;
        movimento.CanceladoEm = agora;
        movimento.CanceladoPorId = Operador;
        movimento.MotivoCancelamento = "Valor digitado errado";
    }

    private static EventoParaOutbox Evento(string tipo, Guid agregado, DateTimeOffset agora) =>
        new(IdGerador.Novo(), tipo, 1, tipo == "caixa.aberto" || tipo == "caixa.fechado" ? "sessao_caixa" : "movimento_caixa", agregado, agora, "{}", "x");

    private static long Contar(BancoTemporario banco, string sql) => (long)banco.Escalar(sql)!;

    [Fact]
    public async Task Abre_movimenta_e_fecha_num_commit_por_fato_com_a_diferenca_calculada_pelo_sqlite()
    {
        var (banco, repo) = await CriarAsync();
        using var _ = banco;
        var agora = banco.Relogio.Agora;
        var sessao = Sessao(agora);
        Assert.Equal(1, await repo.AbrirAsync(sessao, Movimento(sessao, TipoMovimentoCaixa.Abertura, 150m, agora), Evento("caixa.aberto", sessao.Id, agora), Ct));
        Assert.Equal(sessao.Id, (await repo.SessaoAbertaAsync(Ct))!.Id);
        Assert.Equal(sessao.Id.ToString("D"), banco.Escalar("select sessao_caixa_id from estado_operacao"));

        var sangria = Movimento(sessao, TipoMovimentoCaixa.Sangria, 100m, agora);
        Assert.Equal(2, await repo.RegistrarMovimentoAsync(sangria, Evento("caixa.sangria", sangria.Id, agora), Ct));
        Cancelar(sangria, agora);
        Assert.Equal(3, await repo.CancelarMovimentoAsync(sangria, Evento("caixa.movimento_cancelado", sangria.Id, agora), Ct));
        await Assert.ThrowsAsync<RegraNegocioException>(() => repo.CancelarMovimentoAsync(sangria, Evento("caixa.movimento_cancelado", sangria.Id, agora), Ct));

        var fechamento = new FechamentoCaixaRegistro
        {
            Id = IdGerador.Novo(),
            SessaoCaixaId = sessao.Id,
            LojaId = sessao.LojaId,
            CaixaId = sessao.CaixaId,
            TerminalId = Terminal,
            NumeroCaixa = 2,
            Tipo = "fechamento",
            ZeraCaixa = true,
            UsuarioAnteriorId = Operador,
            TotalCalculado = 150m,
            TotalDigitado = 148.50m,
            FechamentoCego = true,
            OcorridoEm = agora,
            DiaOperacional = sessao.DiaOperacional,
            Resumo = """{"ultima_sequencia_evento":3}""",
        };
        var forma = new FechamentoCaixaFormaRegistro
        {
            Id = IdGerador.Novo(),
            FechamentoId = fechamento.Id,
            FormaPagamentoId = Guid.CreateVersion7(),
            DescricaoForma = "Dinheiro",
            TipoForma = "dinheiro",
            ValorCalculado = 150m,
            ValorDigitado = 148.50m,
        };
        var sangriaFechamento = Movimento(sessao, TipoMovimentoCaixa.SangriaFechamento, 148.50m, agora);
        sangriaFechamento.QuemRetiraUsuarioId = Operador;
        Assert.Equal(4, await repo.FecharAsync(fechamento, [forma], sangriaFechamento, agora, Evento("caixa.fechado", sessao.Id, agora), Ct));

        Assert.Null(await repo.SessaoAbertaAsync(Ct));
        Assert.Equal(DBNull.Value, banco.Escalar("select sessao_caixa_id from estado_operacao"));
        await using var db = banco.Fabrica.CreateDbContext();
        Assert.Equal(-1.50m, (await db.FechamentosCaixa.SingleAsync(Ct)).Diferenca);
        Assert.Equal(-1.50m, (await db.FechamentosCaixaFormas.SingleAsync(Ct)).Diferenca);
        Assert.True((await db.MovimentosCaixa.SingleAsync(m => m.Id == sangria.Id, Ct)).Cancelado);
        Assert.Equal(4, await db.EventosSaida.CountAsync(Ct));
        Assert.Equal(4L, banco.Escalar("select ultimo_valor from sequencias_locais where chave = 'evento'"));
    }

    [Fact]
    public async Task Uma_sessao_aberta_por_terminal_e_movimento_so_na_sessao_aberta()
    {
        var (banco, repo) = await CriarAsync();
        using var _ = banco;
        var agora = banco.Relogio.Agora;
        var sessao = SemFundo(agora);
        await repo.AbrirAsync(sessao, null, Evento("caixa.aberto", sessao.Id, agora), Ct);
        var outra = SemFundo(agora);
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() => repo.AbrirAsync(outra, null, Evento("caixa.aberto", outra.Id, agora), Ct));
        Assert.Equal(RepositorioCaixa.MensagemSessaoAberta, recusa.Message);

        var deOutra = Movimento(outra, TipoMovimentoCaixa.Reforco, 10m, agora);
        var semSessao = await Assert.ThrowsAsync<RegraNegocioException>(() => repo.RegistrarMovimentoAsync(deOutra, Evento("caixa.reforco", deOutra.Id, agora), Ct));
        Assert.Equal(RepositorioCaixa.MensagemSemSessao, semSessao.Message);

        // Nada da recusa ficou gravado: só a abertura e o evento dela.
        Assert.Equal(1L, banco.Escalar("select count(*) from sessoes_caixa"));
        Assert.Equal(0L, banco.Escalar("select count(*) from movimentos_caixa"));
        Assert.Equal(1L, banco.Escalar("select count(*) from eventos_saida"));

        // O índice parcial da nuvem também vale no SQLite (uq_sessoes_caixa_aberta).
        await using var db = banco.Fabrica.CreateDbContext();
        outra.CriadoEm = outra.AtualizadoEm = agora;
        db.SessoesCaixa.Add(outra);
        await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync(Ct));
    }

    [Fact]
    public async Task Em_desativacao_nao_abre_o_caixa_mas_fecha()
    {
        var (banco, repo) = await CriarAsync();
        using var _ = banco;
        var agora = banco.Relogio.Agora;
        var sessao = Sessao(agora);
        await repo.AbrirAsync(sessao, Movimento(sessao, TipoMovimentoCaixa.Abertura, 150m, agora), Evento("caixa.aberto", sessao.Id, agora), Ct);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            db.IdentidadeTerminal.Add(new IdentidadeTerminal
            {
                TerminalId = Terminal,
                LojaId = sessao.LojaId,
                CaixaId = sessao.CaixaId,
                NumeroCaixa = 2,
                UrlApi = IdentidadeTerminal.UrlDemonstracao,
                Status = StatusIdentidade.Desativando,
                AtivadoEm = agora,
            });
            await db.SaveChangesAsync(Ct);
        }

        // SYNC 3.8: em desativação o fechamento continua (e sobe); a abertura não.
        Assert.Equal(2, await repo.FecharAsync(TrocaTurno(sessao, agora), [], null, agora, Evento("caixa.fechado", sessao.Id, agora), Ct));
        var nova = SemFundo(agora);
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() => repo.AbrirAsync(nova, null, Evento("caixa.aberto", nova.Id, agora), Ct));
        Assert.Equal(RepositorioCaixa.MensagemTerminalDesativando, recusa.Message);
    }

    [Fact]
    public async Task Abertura_diferente_do_fundo_de_troco_e_recusada_sem_gravar_nada()
    {
        // payloadCaixaAbertoSchema: o movimento de abertura é o fundo. A nuvem recusaria com PAYLOAD_INVALIDO
        // (permanente) e tudo da sessão ficaria retido com DEPENDENCIA_PENDENTE.
        var (banco, repo) = await CriarAsync();
        using var _ = banco;
        var agora = banco.Relogio.Agora;
        var sessao = Sessao(agora);
        var semFundo = SemFundo(agora);
        (SessaoCaixaRegistro Sessao, MovimentoCaixaRegistro? Abertura)[] recusadas =
        [
            (sessao, Movimento(sessao, TipoMovimentoCaixa.Abertura, 100m, agora)),
            (sessao, null),
            (sessao, Movimento(sessao, TipoMovimentoCaixa.Reforco, 150m, agora)),
            (sessao, Movimento(semFundo, TipoMovimentoCaixa.Abertura, 150m, agora)),
            (semFundo, Movimento(semFundo, TipoMovimentoCaixa.Abertura, 150m, agora)),
        ];
        foreach (var (s, abertura) in recusadas)
        {
            var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() => repo.AbrirAsync(s, abertura, Evento("caixa.aberto", s.Id, agora), Ct));
            Assert.Equal(RepositorioCaixa.MensagemAberturaSemFundo, recusa.Message);
        }

        Assert.Equal((0L, 0L, 0L), (
            Contar(banco, "select count(*) from sessoes_caixa"),
            Contar(banco, "select count(*) from movimentos_caixa"),
            Contar(banco, "select count(*) from eventos_saida")));
    }

    [Theory]
    [InlineData(TipoMovimentoCaixa.Abertura)]
    [InlineData(TipoMovimentoCaixa.EstornoVenda)]
    [InlineData(TipoMovimentoCaixa.DevolucaoTroca)]
    public async Task So_sangria_e_reforco_se_cancelam_pelo_caixa(string tipo)
    {
        // A nuvem recusa o resto com TRANSICAO_INVALIDA (permanente): cancelado aqui, a gaveta estimada perderia o valor
        // e o caixa divergiria da nuvem para sempre.
        var (banco, repo) = await CriarAsync();
        using var _ = banco;
        var agora = banco.Relogio.Agora;
        var sessao = Sessao(agora);
        var movimento = Movimento(sessao, TipoMovimentoCaixa.Abertura, 150m, agora);
        await repo.AbrirAsync(sessao, movimento, Evento("caixa.aberto", sessao.Id, agora), Ct);
        if (tipo != TipoMovimentoCaixa.Abertura)
        {
            // Estorno e devolução nascem com a venda e a troca (C11b): gravados direto, com a forma de onde o dinheiro saiu.
            movimento = Movimento(sessao, tipo, 20m, agora);
            movimento.FormaPagamentoId = Guid.CreateVersion7();
            movimento.CriadoEm = movimento.AtualizadoEm = agora;
            await using var db = banco.Fabrica.CreateDbContext();
            db.MovimentosCaixa.Add(movimento);
            await db.SaveChangesAsync(Ct);
        }

        Cancelar(movimento, agora);
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() =>
            repo.CancelarMovimentoAsync(movimento, Evento("caixa.movimento_cancelado", movimento.Id, agora), Ct));

        Assert.Equal(RepositorioCaixa.MensagemMovimentoNaoCancelavel, recusa.Message);
        Assert.Equal(0L, banco.Escalar("select count(*) from movimentos_caixa where cancelado = 1"));
        Assert.Equal(1L, banco.Escalar("select count(*) from eventos_saida"));
    }

    [Fact]
    public async Task Cancelamento_de_movimento_depois_do_fechamento_e_recusado()
    {
        var (banco, repo) = await CriarAsync();
        using var _ = banco;
        var agora = banco.Relogio.Agora;
        var sessao = Sessao(agora);
        await repo.AbrirAsync(sessao, Movimento(sessao, TipoMovimentoCaixa.Abertura, 150m, agora), Evento("caixa.aberto", sessao.Id, agora), Ct);
        var reforco = Movimento(sessao, TipoMovimentoCaixa.Reforco, 50m, agora);
        await repo.RegistrarMovimentoAsync(reforco, Evento("caixa.reforco", reforco.Id, agora), Ct);
        await repo.FecharAsync(TrocaTurno(sessao, agora), [], null, agora, Evento("caixa.fechado", sessao.Id, agora), Ct);

        Cancelar(reforco, agora);
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() =>
            repo.CancelarMovimentoAsync(reforco, Evento("caixa.movimento_cancelado", reforco.Id, agora), Ct));

        Assert.Equal(RepositorioCaixa.MensagemSemSessao, recusa.Message);
        Assert.Equal(0L, banco.Escalar("select count(*) from movimentos_caixa where cancelado = 1"));
        Assert.Equal(3L, banco.Escalar("select count(*) from eventos_saida"));
    }

    [Fact]
    public async Task Devolucao_avulsa_de_cascos_grava_a_linha_e_o_evento_num_commit_so_na_sessao_aberta()
    {
        var (banco, repo) = await CriarAsync();
        using var _ = banco;
        var agora = banco.Relogio.Agora;
        var sessao = Sessao(agora);
        var devolucao = Devolucao(sessao, agora);
        // Sem sessão aberta, nada é gravado.
        var semSessao = await Assert.ThrowsAsync<RegraNegocioException>(() =>
            repo.RegistrarVasilhameAsync(devolucao, Evento("vasilhame.movimentado", devolucao.Id, agora), Ct));
        Assert.Equal(RepositorioCaixa.MensagemSemSessao, semSessao.Message);

        await repo.AbrirAsync(sessao, Movimento(sessao, TipoMovimentoCaixa.Abertura, 150m, agora), Evento("caixa.aberto", sessao.Id, agora), Ct);
        Assert.Equal(2, await repo.RegistrarVasilhameAsync(devolucao, Evento("vasilhame.movimentado", devolucao.Id, agora), Ct));

        // A linha passa pela FK da sessão e pelos CHECKs da migração; o evento e a sequência vão no mesmo commit.
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            var linha = await db.MovimentosVasilhame.AsNoTracking().SingleAsync(Ct);
            Assert.Equal((devolucao.Id, sessao.Id, 6m, "entrada", false), (linha.Id, linha.SessaoCaixaId, linha.Quantidade, linha.Destino, linha.Cancelado));
            var evento = await db.EventosSaida.AsNoTracking().SingleAsync(e => e.SequenciaTerminal == 2, Ct);
            Assert.Equal(("vasilhame.movimentado", devolucao.Id), (evento.Tipo, evento.AgregadoId));
        }

        Assert.Equal(2L, banco.Escalar("select ultimo_valor from sequencias_locais where chave = 'evento'"));

        // De outra sessão, ou depois do fechamento: recusada.
        var deOutra = Devolucao(SemFundo(agora), agora);
        await Assert.ThrowsAsync<RegraNegocioException>(() => repo.RegistrarVasilhameAsync(deOutra, Evento("vasilhame.movimentado", deOutra.Id, agora), Ct));
        await repo.FecharAsync(TrocaTurno(sessao, agora), [], null, agora, Evento("caixa.fechado", sessao.Id, agora), Ct);
        var depois = Devolucao(sessao, agora);
        await Assert.ThrowsAsync<RegraNegocioException>(() => repo.RegistrarVasilhameAsync(depois, Evento("vasilhame.movimentado", depois.Id, agora), Ct));
        Assert.Equal(1L, banco.Escalar("select count(*) from movimentos_vasilhame"));
        Assert.Equal(3L, banco.Escalar("select count(*) from eventos_saida"));
    }

    [Fact]
    public async Task Checks_e_fk_da_devolucao_avulsa_valem_numa_gravacao_real()
    {
        // ck_movimentos_vasilhame_quantidade, _vale (vale só com destino vale), _comodato e a FK da sessão.
        var (banco, repo) = await CriarAsync();
        using var _ = banco;
        var agora = banco.Relogio.Agora;
        var sessao = Sessao(agora);
        await repo.AbrirAsync(sessao, Movimento(sessao, TipoMovimentoCaixa.Abertura, 150m, agora), Evento("caixa.aberto", sessao.Id, agora), Ct);
        var semQuantidade = Devolucao(sessao, agora);
        semQuantidade.Quantidade = 0m;
        var valeSemDestino = Devolucao(sessao, agora);
        valeSemDestino.ValeId = Guid.CreateVersion7();
        var comodatoSemPessoa = Devolucao(sessao, agora);
        comodatoSemPessoa.Destino = "baixa_comodato";
        var semSessao = Devolucao(SemFundo(agora), agora);
        foreach (var invalida in new[] { semQuantidade, valeSemDestino, comodatoSemPessoa, semSessao })
        {
            await using var db = banco.Fabrica.CreateDbContext();
            invalida.CriadoEm = invalida.AtualizadoEm = agora;
            db.MovimentosVasilhame.Add(invalida);
            await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync(Ct));
        }

        Assert.Equal(0L, banco.Escalar("select count(*) from movimentos_vasilhame"));
    }

    [Fact]
    public async Task Apuracao_le_os_pagamentos_das_vendas_da_sessao_e_o_turno_herdado_sai_da_troca_de_turno_sem_sucessora()
    {
        // Fase 1C, C10a (PDV 20.4, 21.2, 21.3): a apuração só olha a sessão; a venda aberta bloqueia o fechamento.
        var (banco, repo) = await CriarAsync();
        using var _ = banco;
        var vendas = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var agora = banco.Relogio.Agora;
        var sessao = Sessao(agora);
        await repo.AbrirAsync(sessao, Movimento(sessao, TipoMovimentoCaixa.Abertura, 150m, agora), Evento("caixa.aberto", sessao.Id, agora), Ct);
        await repo.RegistrarMovimentoAsync(Movimento(sessao, TipoMovimentoCaixa.Reforco, 50m, agora), Evento("caixa.reforco", sessao.Id, agora), Ct);
        var dinheiro = new FormaPagamentoInfo(Guid.CreateVersion7(), "Dinheiro", "01", "dinheiro", PermiteTroco: true);
        var contexto = new ContextoVenda(Terminal, sessao.LojaId, 1, sessao.CaixaId, 2, sessao.Id);
        var produto = new ProdutoResolvido(new ProdutoVenda(Guid.CreateVersion7(), 1, null, "ÁGUA", "UN", 10m));

        // Uma venda finalizada (R$ 20 com troco de 5 de 25) e uma em andamento na mesma sessão.
        var paga = Venda.Iniciar(Guid.CreateVersion7(), await vendas.ReservarNumeroVendaAsync(Ct), contexto, Operador, agora);
        paga.AdicionarItem(produto, 2m, "1", agora);
        await vendas.SalvarEmAndamentoAsync(paga, ct: Ct);
        paga.IniciarPagamento();
        paga.LancarPagamento(dinheiro, 25m, agora);
        var eventoId = Guid.CreateVersion7();
        paga.Finalizar(agora, eventoId);
        await vendas.EncerrarAsync(paga, new EventoParaOutbox(eventoId, "venda.finalizada", 1, "venda", paga.Id, agora, "{}", new string('0', 64)), ct: Ct);
        var aberta = Venda.Iniciar(Guid.CreateVersion7(), await vendas.ReservarNumeroVendaAsync(Ct), contexto, Operador, agora);
        aberta.AdicionarItem(produto, 1m, "1", agora);
        await vendas.SalvarEmAndamentoAsync(aberta, ct: Ct);

        var dados = await repo.ApurarAsync(sessao.Id, Ct);
        Assert.Equal([("dinheiro", 20m)], dados.Pagamentos.Select(p => (p.Forma.TipoForma, p.Valor)));
        Assert.Equal((1, 20m, 0, 0), (dados.Resumo.QtdVendas, dados.Resumo.TotalVendas, dados.Resumo.QtdCanceladas, dados.Resumo.QtdLiberacoes));
        var apuracao = ApuracaoCaixa.Calcular(sessao.FundoTroco, dados.Pagamentos, dados.Movimentos, new FormaCaixa(dinheiro.Id, "Dinheiro", "dinheiro"));
        Assert.Equal(220m, apuracao.DinheiroGaveta);
        Assert.Equal(3L, await repo.UltimaSequenciaEventoAsync(Ct));

        // A tela confere antes da contagem (venda de qualquer operador, do banco); o commit repete a guarda.
        Assert.True(await repo.VendaPendenteAsync(sessao.Id, Ct));
        var fechamento = TrocaTurno(sessao, agora);
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() =>
            repo.FecharAsync(fechamento, [], null, agora, Evento("caixa.fechado", sessao.Id, agora), Ct));
        Assert.Equal(RepositorioCaixa.MensagemVendaAberta, recusa.Message);
        Assert.Null(await repo.TurnoHerdadoAsync(Ct));

        aberta.Cancelar(Operador, "Cliente desistiu da compra", agora);
        await vendas.EncerrarAsync(aberta, null, ct: Ct);
        Assert.False(await repo.VendaPendenteAsync(sessao.Id, Ct));
        await repo.FecharAsync(fechamento, [], null, agora, Evento("caixa.fechado", sessao.Id, agora), Ct,
            [new RegistroAuditoria("logout", Operador, Localizacao: "pdv.caixa")]);
        Assert.Equal(sessao.Id.ToString("D"), banco.Escalar("select sessao_caixa_id from log_auditoria_local where acao = 'logout'"));
        Assert.Equal(1, (await repo.ApurarAsync(sessao.Id, Ct)).Resumo.QtdCanceladas);
        var herdado = await repo.TurnoHerdadoAsync(Ct);
        Assert.Equal((sessao.Id, 150m, Operador), (herdado!.SessaoAnteriorId, herdado.ValorCaixa, herdado.UsuarioAnteriorId));

        // A sessão seguinte nasce do turno: o herdado acaba.
        var proxima = Sessao(agora);
        proxima.SessaoAnteriorId = sessao.Id;
        proxima.ValorRecebidoAnterior = 150m;
        await repo.AbrirAsync(proxima, Movimento(proxima, TipoMovimentoCaixa.Abertura, 150m, agora), Evento("caixa.aberto", proxima.Id, agora), Ct);
        Assert.Null(await repo.TurnoHerdadoAsync(Ct));
    }

    [Fact]
    public async Task Gaveta_estimada_movimentos_da_sessao_e_resumo_diario_saem_do_banco_com_o_periodo_e_a_sessao_omitida()
    {
        // Fase 1C, C10b (PDV 20.4, 20.3, 21.6): o estimado é o mesmo da apuração; a sangria leva a auditoria no commit; o
        // resumo filtra pelo instante no SQLite (texto UTC de largura fixa) e deixa a sessão omitida de fora.
        var (banco, repo) = await CriarAsync();
        using var _ = banco;
        var vendas = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var agora = banco.Relogio.Agora;
        var sessao = Sessao(agora);
        await repo.AbrirAsync(sessao, Movimento(sessao, TipoMovimentoCaixa.Abertura, 150m, agora), Evento("caixa.aberto", sessao.Id, agora), Ct);
        var dinheiro = new FormaPagamentoInfo(Guid.CreateVersion7(), "Dinheiro", "01", "dinheiro", PermiteTroco: true);
        var contexto = new ContextoVenda(Terminal, sessao.LojaId, 1, sessao.CaixaId, 2, sessao.Id);
        var produto = new ProdutoResolvido(new ProdutoVenda(Guid.CreateVersion7(), 1, null, "ÁGUA", "UN", 10m));
        var paga = Venda.Iniciar(Guid.CreateVersion7(), await vendas.ReservarNumeroVendaAsync(Ct), contexto, Operador, agora);
        paga.AdicionarItem(produto, 3m, "1", agora);
        await vendas.SalvarEmAndamentoAsync(paga, ct: Ct);
        paga.IniciarPagamento();
        paga.LancarPagamento(dinheiro, 30m, agora);
        var eventoId = Guid.CreateVersion7();
        paga.Finalizar(agora, eventoId);
        await vendas.EncerrarAsync(paga, new EventoParaOutbox(eventoId, "venda.finalizada", 1, "venda", paga.Id, agora, "{}", new string('0', 64)), ct: Ct);

        var sangria = Movimento(sessao, TipoMovimentoCaixa.Sangria, 100m, agora);
        await repo.RegistrarMovimentoAsync(sangria, Evento("caixa.sangria", sangria.Id, agora), Ct,
            [new RegistroAuditoria("liberacao", Operador, "movimentos_caixa", sangria.Id, "Sangria liberada", Guid.CreateVersion7(), "pdv.caixa", "Teste")]);
        Assert.Equal(sessao.Id.ToString("D"), banco.Escalar("select sessao_caixa_id from log_auditoria_local where acao = 'liberacao'"));
        var antiga = Movimento(sessao, TipoMovimentoCaixa.Reforco, 40m, agora.AddDays(-2));
        await repo.RegistrarMovimentoAsync(antiga, Evento("caixa.reforco", antiga.Id, agora), Ct);
        var cancelado = Movimento(sessao, TipoMovimentoCaixa.Reforco, 999m, agora);
        await repo.RegistrarMovimentoAsync(cancelado, Evento("caixa.reforco", cancelado.Id, agora), Ct);
        Cancelar(cancelado, agora);
        await repo.CancelarMovimentoAsync(cancelado, Evento("caixa.movimento_cancelado", cancelado.Id, agora), Ct);

        // Só sangria e reforço são movimentos avulsos (a abertura vai com a sessão).
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            repo.RegistrarMovimentoAsync(Movimento(sessao, TipoMovimentoCaixa.Abertura, 10m, agora), Evento("caixa.reforco", sessao.Id, agora), Ct));

        // 150 + 30 − 100 + 40 (o reforço cancelado não conta) = a linha Dinheiro da apuração.
        var dados = await repo.ApurarAsync(sessao.Id, Ct);
        var apurado = ApuracaoCaixa.Calcular(sessao.FundoTroco, dados.Pagamentos, dados.Movimentos, new FormaCaixa(dinheiro.Id, "Dinheiro", "dinheiro"));
        Assert.Equal(120m, await repo.DinheiroGavetaAsync(sessao.Id, Ct));
        Assert.Equal(apurado.DinheiroGaveta, await repo.DinheiroGavetaAsync(sessao.Id, Ct));
        Assert.Null(await repo.DinheiroGavetaAsync(Guid.CreateVersion7(), Ct));
        Assert.Equal([TipoMovimentoCaixa.Reforco, TipoMovimentoCaixa.Abertura, TipoMovimentoCaixa.Sangria, TipoMovimentoCaixa.Reforco],
            (await repo.MovimentosDaSessaoAsync(sessao.Id, Ct)).Select(m => m.Tipo));

        var periodo = new PeriodoResumo(agora.AddHours(-1), agora.AddHours(1), "Hoje");
        var resumo = await repo.ResumoDiarioAsync(periodo, valoresOcultos: false, Ct);
        Assert.Equal((1, 30m), (resumo.QtdVendas, resumo.TotalVendas));
        Assert.Equal([new FormaResumo("Dinheiro", 1, 30m)], resumo.Formas);
        Assert.Equal((1, 100m, 0, 0m, 1), (resumo.QtdSangrias, resumo.TotalSangrias, resumo.QtdReforcos, resumo.TotalReforcos, resumo.QtdMovimentosCancelados));
        // O3: no fechamento cego só as quantidades (os valores compõem o esperado).
        var oculto = await repo.ResumoDiarioAsync(periodo, valoresOcultos: true, Ct);
        Assert.Equal((1, 0m, 1, 0m, true), (oculto.QtdVendas, oculto.TotalVendas, oculto.QtdSangrias, oculto.TotalSangrias, oculto.ValoresOcultos));
        Assert.Equal([new FormaResumo("Dinheiro", 1, 0m)], oculto.Formas);
        var anteontem = await repo.ResumoDiarioAsync(new PeriodoResumo(agora.AddDays(-2).AddMinutes(-1), agora.AddDays(-1), "Anteontem"), valoresOcultos: false, Ct);
        Assert.Equal((0, 1, 40m), (anteontem.QtdVendas, anteontem.QtdReforcos, anteontem.TotalReforcos));
    }
}
