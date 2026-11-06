using System.Text.Json.Nodes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Protocolo;
using F = GenesisPDV.Sync.Protocolo.FormatoProtocolo;

namespace GenesisPDV.Sync.Eventos;

/// <summary>
/// Eventos do caixa e da devolução avulsa de cascos (sincronizacao.md 9.3–9.6, 9.26; Fase 1C, bloco C9), montados das
/// linhas locais (<c>TabelasCaixa</c>) com as mesmas regras da <see cref="FabricaEventos"/>: chaves = tabelas, campos =
/// colunas, sem as colunas padrão nem as que só a nuvem preenche (<c>COLUNAS_FORA_DO_PAYLOAD</c>), todas as chaves do
/// contrato zod em cada linha. Cada evento declara o operador, a sessão (contexto) e as dependências da SYNC 8.5; o
/// <c>ContratosEventosTests</c> confere cada payload contra a fixture <c>caixa.*.payload.json</c>.
/// </summary>
public static class FabricaEventosCaixa
{
    public const int VersaoSchema = 1;

    /// <summary>
    /// <c>caixa.aberto</c> (9.3), agregado <c>sessao_caixa</c>: depende da sessão anterior na troca de turno.
    /// <paramref name="abertura"/> nulo = fundo 0,00 (sem movimento); com movimento, ele vale o fundo (refinamento do
    /// <c>payloadCaixaAbertoSchema</c>, <see cref="RepositorioCaixa.AberturaDoFundo"/>). <paramref name="contagemCedulas"/>
    /// é o "F2 Contar cédulas" (só payload, valor da cédula → quantidade).
    /// </summary>
    public static EventoParaOutbox CaixaAberto(
        SessaoCaixaRegistro sessao, MovimentoCaixaRegistro? abertura, IReadOnlyDictionary<decimal, int>? contagemCedulas, Guid eventoId)
    {
        ArgumentNullException.ThrowIfNull(sessao);
        if (!RepositorioCaixa.AberturaDoFundo(sessao, abertura))
        {
            throw new InvalidOperationException("caixa.aberto leva só o movimento de abertura da própria sessão, no valor do fundo de troco (fundo 0,00 sem movimento).");
        }

        var payload = new JsonObject
        {
            ["sessoes_caixa"] = new JsonObject
            {
                ["id"] = F.Uuid(sessao.Id),
                ["loja_id"] = F.Uuid(sessao.LojaId),
                ["caixa_id"] = F.Uuid(sessao.CaixaId),
                ["numero_caixa"] = sessao.NumeroCaixa,
                ["terminal_id"] = F.Uuid(sessao.TerminalId),
                ["operador_id"] = F.Uuid(sessao.OperadorId),
                ["status"] = StatusSessaoCaixa.Aberta,
                ["dia_operacional"] = F.Data(sessao.DiaOperacional),
                ["aberta_em"] = F.DataHora(sessao.AbertaEm),
                ["abertura_automatica"] = sessao.AberturaAutomatica,
                ["fundo_troco"] = F.Dinheiro(sessao.FundoTroco),
                ["sessao_anterior_id"] = F.Uuid(sessao.SessaoAnteriorId),
                ["valor_recebido_anterior"] = sessao.ValorRecebidoAnterior is { } recebido ? F.Dinheiro(recebido) : null,
                ["diferenca_recebimento"] = sessao.DiferencaRecebimento is { } diferenca ? F.Dinheiro(diferenca) : null,
                ["fechada_em"] = null,
            },
            ["movimentos_caixa"] = abertura is null ? new JsonArray() : new JsonArray(Movimento(abertura)),
            ["contagem_cedulas"] = Cedulas(contagemCedulas),
        };
        List<DependenciaOutbox> dependencias = sessao.SessaoAnteriorId is { } anterior ? [DependenciaOutbox.Sessao(anterior)] : [];
        return Montar("caixa.aberto", "sessao_caixa", sessao.Id, sessao.AbertaEm, payload, eventoId, sessao.OperadorId, sessao.Id, dependencias);
    }

    /// <summary><c>caixa.reforco</c> (9.4), agregado <c>movimento_caixa</c>, depende da sessão.</summary>
    public static EventoParaOutbox CaixaReforco(
        MovimentoCaixaRegistro movimento, decimal? dinheiroEstimadoAntes, IReadOnlyDictionary<decimal, int>? contagemCedulas, Guid eventoId) =>
        MovimentoAvulso("caixa.reforco", TipoMovimentoCaixa.Reforco, movimento, dinheiroEstimadoAntes, contagemCedulas, eventoId);

    /// <summary><c>caixa.sangria</c> (9.4): exige quem retira (usuário ou nome), como o <c>ck_movimentos_caixa_sangria</c>.</summary>
    public static EventoParaOutbox CaixaSangria(
        MovimentoCaixaRegistro movimento, decimal? dinheiroEstimadoAntes, IReadOnlyDictionary<decimal, int>? contagemCedulas, Guid eventoId)
    {
        ArgumentNullException.ThrowIfNull(movimento);
        if (movimento.QuemRetiraUsuarioId is null && string.IsNullOrWhiteSpace(movimento.QuemRetiraNome))
        {
            throw new InvalidOperationException("Sangria exige quem retira.");
        }

        return MovimentoAvulso("caixa.sangria", TipoMovimentoCaixa.Sangria, movimento, dinheiroEstimadoAntes, contagemCedulas, eventoId);
    }

    /// <summary>
    /// <c>caixa.movimento_cancelado</c> (9.5): só as colunas de cancelamento, agregado e dependência = o movimento. Só
    /// sangria e reforço (<see cref="TipoMovimentoCaixa.Cancelaveis"/>): a nuvem recusa os outros para sempre.
    /// </summary>
    public static EventoParaOutbox CaixaMovimentoCancelado(MovimentoCaixaRegistro movimento, Guid eventoId)
    {
        ArgumentNullException.ThrowIfNull(movimento);
        if (!TipoMovimentoCaixa.Cancelaveis.Contains(movimento.Tipo))
        {
            throw new RegraNegocioException(RepositorioCaixa.MensagemMovimentoNaoCancelavel);
        }

        if (movimento is not { Cancelado: true, CanceladoEm: { } canceladoEm, CanceladoPorId: { } canceladoPor } || string.IsNullOrWhiteSpace(movimento.MotivoCancelamento))
        {
            throw new InvalidOperationException("caixa.movimento_cancelado exige o movimento cancelado, com quem, quando e o motivo.");
        }

        var payload = new JsonObject
        {
            ["movimentos_caixa"] = new JsonObject
            {
                ["id"] = F.Uuid(movimento.Id),
                ["cancelado"] = true,
                ["cancelado_em"] = F.DataHora(canceladoEm),
                ["cancelado_por_id"] = F.Uuid(canceladoPor),
                ["autorizado_cancelamento_por_id"] = F.Uuid(movimento.AutorizadoCancelamentoPorId),
                ["motivo_cancelamento"] = movimento.MotivoCancelamento,
            },
        };
        return Montar("caixa.movimento_cancelado", "movimento_caixa", movimento.Id, canceladoEm, payload, eventoId, canceladoPor,
            movimento.SessaoCaixaId, [new DependenciaOutbox("movimento_caixa", movimento.Id)]);
    }

    /// <summary>
    /// <c>caixa.fechado</c> (9.6), agregado <c>sessao_caixa</c>, depende da sessão: fechamento (zera, com a
    /// <c>sangria_fechamento</c>) ou troca de turno (não zera, sem sangria).
    /// </summary>
    /// <param name="executadoPorId">
    /// Quem contou e confirmou (o <c>usuario_id</c> do envelope, SYNC 7.3): na troca de turno pedida pelo próximo
    /// operador (PDV 8.1) é ele, não o dono da sessão (<c>usuario_anterior_id</c>). Nulo = o dono da sessão.
    /// </param>
    public static EventoParaOutbox CaixaFechado(
        FechamentoCaixaRegistro fechamento,
        IReadOnlyList<FechamentoCaixaFormaRegistro> formas,
        MovimentoCaixaRegistro? sangriaFechamento,
        DateTimeOffset fechadaEm,
        Guid eventoId,
        Guid? executadoPorId = null)
    {
        ArgumentNullException.ThrowIfNull(fechamento);
        ArgumentNullException.ThrowIfNull(formas);
        if (fechamento.ZeraCaixa != (fechamento.Tipo == "fechamento")
            || (sangriaFechamento is not null && (!fechamento.ZeraCaixa || sangriaFechamento.Tipo != TipoMovimentoCaixa.SangriaFechamento
                                                  || sangriaFechamento.SessaoCaixaId != fechamento.SessaoCaixaId))
            || formas.Any(f => f.FechamentoId != fechamento.Id))
        {
            throw new InvalidOperationException("caixa.fechado: só o fechamento zera e leva a sangria_fechamento da sessão; as formas são dele.");
        }

        var linhasFormas = new JsonArray();
        foreach (var forma in formas)
        {
            linhasFormas.Add(new JsonObject
            {
                ["id"] = F.Uuid(forma.Id),
                ["fechamento_id"] = F.Uuid(forma.FechamentoId),
                ["forma_pagamento_id"] = F.Uuid(forma.FormaPagamentoId),
                ["descricao_forma"] = forma.DescricaoForma,
                ["tipo_forma"] = forma.TipoForma,
                ["valor_calculado"] = F.Dinheiro(forma.ValorCalculado),
                ["valor_digitado"] = F.Dinheiro(forma.ValorDigitado),
                ["quantidade_pagamentos"] = forma.QuantidadePagamentos,
                ["preenchido_automatico"] = forma.PreenchidoAutomatico,
                ["valor_primeira_contagem"] = forma.ValorPrimeiraContagem is { } primeira ? F.Dinheiro(primeira) : null,
            });
        }

        var payload = new JsonObject
        {
            ["sessoes_caixa"] = new JsonObject
            {
                ["id"] = F.Uuid(fechamento.SessaoCaixaId),
                ["status"] = StatusSessaoCaixa.Fechada,
                ["fechada_em"] = F.DataHora(fechadaEm),
            },
            ["fechamentos_caixa"] = new JsonObject
            {
                ["id"] = F.Uuid(fechamento.Id),
                ["sessao_caixa_id"] = F.Uuid(fechamento.SessaoCaixaId),
                ["loja_id"] = F.Uuid(fechamento.LojaId),
                ["caixa_id"] = F.Uuid(fechamento.CaixaId),
                ["terminal_id"] = F.Uuid(fechamento.TerminalId),
                ["numero_caixa"] = fechamento.NumeroCaixa,
                ["tipo"] = fechamento.Tipo,
                ["zera_caixa"] = fechamento.ZeraCaixa,
                ["usuario_anterior_id"] = F.Uuid(fechamento.UsuarioAnteriorId),
                ["usuario_subsequente_id"] = F.Uuid(fechamento.UsuarioSubsequenteId),
                ["valor_caixa"] = F.Dinheiro(fechamento.ValorCaixa),
                ["total_calculado"] = F.Dinheiro(fechamento.TotalCalculado),
                ["total_digitado"] = F.Dinheiro(fechamento.TotalDigitado),
                ["justificativa"] = fechamento.Justificativa,
                ["recontagem"] = fechamento.Recontagem,
                ["fechamento_cego"] = fechamento.FechamentoCego,
                ["ocorrido_em"] = F.DataHora(fechamento.OcorridoEm),
                ["dia_operacional"] = F.Data(fechamento.DiaOperacional),
                ["resumo"] = JsonNode.Parse(fechamento.Resumo),
            },
            ["fechamentos_caixa_formas"] = linhasFormas,
            ["movimentos_caixa"] = sangriaFechamento is null ? new JsonArray() : new JsonArray(Movimento(sangriaFechamento)),
        };
        return Montar("caixa.fechado", "sessao_caixa", fechamento.SessaoCaixaId, fechamento.OcorridoEm, payload, eventoId,
            executadoPorId ?? fechamento.UsuarioAnteriorId, fechamento.SessaoCaixaId, [DependenciaOutbox.Sessao(fechamento.SessaoCaixaId)]);
    }

    /// <summary>
    /// <c>vasilhame.movimentado</c> (9.26), agregado <c>movimento_vasilhame</c>, depende da sessão. <c>vales</c> e
    /// <c>movimentos_vale</c> chegam com o vale (Fase 3) e vão vazios.
    /// </summary>
    public static EventoParaOutbox VasilhameMovimentado(MovimentoVasilhameRegistro movimento, Guid eventoId)
    {
        ArgumentNullException.ThrowIfNull(movimento);
        var payload = new JsonObject
        {
            ["movimentos_vasilhame"] = new JsonObject
            {
                ["id"] = F.Uuid(movimento.Id),
                ["sessao_caixa_id"] = F.Uuid(movimento.SessaoCaixaId),
                ["loja_id"] = F.Uuid(movimento.LojaId),
                ["caixa_id"] = F.Uuid(movimento.CaixaId),
                ["terminal_id"] = F.Uuid(movimento.TerminalId),
                ["operador_id"] = F.Uuid(movimento.OperadorId),
                ["pessoa_id"] = F.Uuid(movimento.PessoaId),
                ["produto_vasilhame_id"] = F.Uuid(movimento.ProdutoVasilhameId),
                ["quantidade"] = F.Quantidade(movimento.Quantidade),
                ["destino"] = movimento.Destino,
                ["vale_id"] = F.Uuid(movimento.ValeId),
                ["ocorrido_em"] = F.DataHora(movimento.OcorridoEm),
            },
            ["vales"] = new JsonArray(),
            ["movimentos_vale"] = new JsonArray(),
        };
        return Montar("vasilhame.movimentado", "movimento_vasilhame", movimento.Id, movimento.OcorridoEm, payload, eventoId,
            movimento.OperadorId, movimento.SessaoCaixaId, [DependenciaOutbox.Sessao(movimento.SessaoCaixaId)]);
    }

    private static EventoParaOutbox MovimentoAvulso(
        string tipo, string tipoMovimento, MovimentoCaixaRegistro movimento, decimal? dinheiroEstimadoAntes,
        IReadOnlyDictionary<decimal, int>? contagemCedulas, Guid eventoId)
    {
        ArgumentNullException.ThrowIfNull(movimento);
        if (movimento.Tipo != tipoMovimento)
        {
            throw new InvalidOperationException($"{tipo} exige movimento do tipo {tipoMovimento}.");
        }

        var payload = new JsonObject
        {
            ["movimentos_caixa"] = Movimento(movimento),
            ["dinheiro_estimado_antes"] = dinheiroEstimadoAntes is { } estimado ? F.Dinheiro(estimado) : null,
            ["contagem_cedulas"] = Cedulas(contagemCedulas),
        };
        return Montar(tipo, "movimento_caixa", movimento.Id, movimento.OcorridoEm, payload, eventoId, movimento.OperadorId,
            movimento.SessaoCaixaId, [DependenciaOutbox.Sessao(movimento.SessaoCaixaId)]);
    }

    /// <summary>
    /// Linha de <c>movimentos_caixa</c> (MD 3.12.2) sem as colunas de cancelamento e de conta corrente; também a do
    /// <c>estorno_venda</c> do <c>venda.cancelada</c> forma A (<see cref="FabricaEventos.VendaCanceladaFinalizada"/>).
    /// </summary>
    internal static JsonObject Movimento(MovimentoCaixaRegistro m) => new()
    {
        ["id"] = F.Uuid(m.Id),
        ["sessao_caixa_id"] = F.Uuid(m.SessaoCaixaId),
        ["loja_id"] = F.Uuid(m.LojaId),
        ["caixa_id"] = F.Uuid(m.CaixaId),
        ["numero_caixa"] = m.NumeroCaixa,
        ["terminal_id"] = F.Uuid(m.TerminalId),
        ["tipo"] = m.Tipo,
        ["forma_pagamento_id"] = F.Uuid(m.FormaPagamentoId),
        ["valor"] = F.Dinheiro(m.Valor),
        ["operador_id"] = F.Uuid(m.OperadorId),
        ["quem_retira_usuario_id"] = F.Uuid(m.QuemRetiraUsuarioId),
        ["quem_retira_nome"] = m.QuemRetiraNome,
        ["observacao"] = m.Observacao,
        ["inf_adicionais"] = m.InfAdicionais,
        ["ocorrido_em"] = F.DataHora(m.OcorridoEm),
        ["autorizado_por_id"] = F.Uuid(m.AutorizadoPorId),
        ["troca_id"] = F.Uuid(m.TrocaId),
        ["cancelado"] = false,
    };

    /// <summary>"F2 Contar cédulas" (PDV 8.2): <c>{"100.00": 1}</c>, ou nulo sem contagem.</summary>
    private static JsonObject? Cedulas(IReadOnlyDictionary<decimal, int>? contagem)
    {
        if (contagem is null)
        {
            return null;
        }

        var objeto = new JsonObject();
        foreach (var (valor, quantidade) in contagem.OrderByDescending(c => c.Key))
        {
            objeto[F.Dinheiro(valor)] = quantidade;
        }

        return objeto;
    }

    private static EventoParaOutbox Montar(
        string tipo, string agregadoTipo, Guid agregadoId, DateTimeOffset ocorridoEm, JsonObject payload, Guid eventoId, Guid usuarioId,
        Guid sessaoCaixaId, IReadOnlyList<DependenciaOutbox> dependencias)
    {
        var jcs = Jcs.Serializar(payload);
        return new EventoParaOutbox(eventoId, tipo, VersaoSchema, agregadoTipo, agregadoId, ocorridoEm, jcs, Jcs.Sha256Hex(jcs))
        {
            UsuarioId = usuarioId,
            SessaoCaixaId = sessaoCaixaId,
            Dependencias = dependencias,
        };
    }
}
