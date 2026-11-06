namespace GenesisPDV.Core.Vendas;

/// <summary>
/// Valores de <c>pagamentos_venda[].estorno</c> do <c>venda.cancelada</c> forma A (<c>ESTORNOS_PAGAMENTO</c> do contrato,
/// sincronizacao.md 9.9; PDV 13.3). Só os que o caixa da Fase 1C escolhe: sem TEF (Fase 6), sem PIX pela API (PDV-2),
/// sem vale (Fase 3).
/// </summary>
public static class EstornoPagamento
{
    /// <summary>Pagamento em dinheiro devolvido ao cliente: sai da gaveta (linha <c>estorno_venda</c> na forma dele).</summary>
    public const string DinheiroDevolvido = "dinheiro_devolvido";

    /// <summary>"Valor não devolvido" (cancelamento técnico, 13.3): nada sai da gaveta e nada vira movimento.</summary>
    public const string DinheiroNaoDevolvido = "dinheiro_nao_devolvido";

    /// <summary>
    /// Cartão, vale ou PIX devolvido em dinheiro (O22 do dono): sai da gaveta, na forma Dinheiro; a transação original
    /// continua valendo (a credenciadora/PSP ainda paga).
    /// </summary>
    public const string DevolvidoEmDinheiro = "devolvido_em_dinheiro";

    /// <summary>Transação cancelada pelo operador na maquininha (16.5): linha <c>estorno_venda</c> na forma do cartão.</summary>
    public const string PosCanceladoNaMaquininha = "pos_cancelado_na_maquininha";

    /// <summary>PIX devolvido pelo app do banco da loja e registrado no caixa (16.7): linha na forma PIX.</summary>
    public const string PixDevolucaoManual = "pix_devolucao_manual";

    /// <summary>Forma sem dinheiro na mão (fiado, crediário, "outros" a prazo): a nuvem cancela a conta a receber.</summary>
    public const string CreditoCancelado = "credito_cancelado";

    /// <summary>
    /// Estornos efetivados no caixa: cada um vira linha <c>estorno_venda</c> (<c>ESTORNOS_COM_MOVIMENTO_CAIXA</c> do
    /// contrato, só os que o caixa da 1C gera).
    /// </summary>
    public static bool GeraMovimento(string estorno) => estorno is DinheiroDevolvido or DevolvidoEmDinheiro or PosCanceladoNaMaquininha or PixDevolucaoManual;

    /// <summary>O estorno tira dinheiro da gaveta (entra no esperado do fechamento, 20.4 e 21.2).</summary>
    public static bool SaiDaGaveta(string estorno) => estorno is DinheiroDevolvido or DevolvidoEmDinheiro;

    /// <summary>
    /// O pagamento estornado deixa de contar no calculado da forma no fechamento (21.2): só o lançamento cancelado da forma
    /// a prazo (<c>credito_cancelado</c> sem quitação no caixa, <paramref name="lancaQuitada"/> falso). Ele não gera
    /// <c>estorno_venda</c> e nada dele fica no caixa para contar (a conta a receber é cancelada). Os demais continuam
    /// somando: o efetivado é descontado pela linha <c>estorno_venda</c>, e o <c>dinheiro_nao_devolvido</c> e o
    /// <c>credito_cancelado</c> da forma quitada deixam o valor (ou o documento) na gaveta.
    /// </summary>
    public static bool SaiDoCalculado(string estorno, bool lancaQuitada) => estorno == CreditoCancelado && !lancaQuitada;
}

/// <summary>Uma opção de estorno para o pagamento, como a tela a mostra (a primeira é o padrão).</summary>
public sealed record OpcaoEstorno(string Estorno, string Descricao);

/// <summary>
/// Como cada pagamento volta ao cliente no cancelamento da venda finalizada (PDV 13.3; O22 do dono: no cartão e no PIX o
/// operador escolhe na hora entre o estorno no meio original e a devolução em dinheiro). As combinações são as que o
/// handler da nuvem aceita (<c>estornosInvalidos</c> do <c>cancelamento.ts</c>): <c>dinheiro_*</c> só na forma dinheiro,
/// <c>devolvido_em_dinheiro</c> fora dela, <c>pos_*</c> em cartão e vale (maquininha) e <c>pix_*</c> em PIX.
/// </summary>
public static class RegrasEstorno
{
    public static IReadOnlyList<OpcaoEstorno> Opcoes(PagamentoVenda pagamento)
    {
        ArgumentNullException.ThrowIfNull(pagamento);
        var emDinheiro = new OpcaoEstorno(EstornoPagamento.DevolvidoEmDinheiro, "Devolver em dinheiro (sai da gaveta)");
        return pagamento.TipoForma switch
        {
            "dinheiro" =>
            [
                new OpcaoEstorno(EstornoPagamento.DinheiroDevolvido, "Devolver o dinheiro (sai da gaveta)"),
                new OpcaoEstorno(EstornoPagamento.DinheiroNaoDevolvido, "Valor não devolvido (nada sai da gaveta)"),
            ],
            "cartao_credito" or "cartao_debito" or "vale_alimentacao" or "vale_refeicao" =>
            [
                new OpcaoEstorno(EstornoPagamento.PosCanceladoNaMaquininha, "Cancelar na maquininha (nada sai da gaveta)"),
                emDinheiro,
            ],
            "pix" =>
            [
                new OpcaoEstorno(EstornoPagamento.PixDevolucaoManual, "Devolver o PIX pelo banco (nada sai da gaveta)"),
                emDinheiro,
            ],
            // "Outros" e as formas personalizadas (C8b): a prazo (sem quitação no caixa) cancela a conta; quitada, o
            // caixa devolve em dinheiro.
            _ when !pagamento.LancaQuitada =>
            [
                new OpcaoEstorno(EstornoPagamento.CreditoCancelado, "Cancelar o lançamento (conta a receber)"),
                emDinheiro,
            ],
            _ =>
            [
                emDinheiro,
                new OpcaoEstorno(EstornoPagamento.CreditoCancelado, "Cancelar o lançamento (nada sai da gaveta)"),
            ],
        };
    }

    /// <summary>A opção padrão (a primeira) do pagamento.</summary>
    public static string Padrao(PagamentoVenda pagamento) => Opcoes(pagamento)[0].Estorno;
}

/// <summary>O estorno escolhido para um pagamento (<c>pagamentos_venda[]</c> do payload da forma A).</summary>
public sealed record EstornoEscolhido(Guid PagamentoVendaId, int Sequencia, string DescricaoForma, decimal Valor, string Estorno);

/// <summary>
/// Uma linha <c>estorno_venda</c> (MD 3.12.2): o valor estornado numa forma, na sessão do cancelamento. Só as linhas da
/// forma do tipo dinheiro saem da gaveta (20.4).
/// </summary>
public sealed record EstornoPorForma(Guid FormaPagamentoId, decimal Valor);

/// <summary>
/// Resultado do cancelamento da venda finalizada (PDV 13.3): o estorno de cada pagamento e as linhas por forma que o
/// caixa grava em <c>movimentos_caixa</c>, na sessão do cancelamento, no mesmo commit da venda e do evento.
/// </summary>
public sealed record CancelamentoFinalizada(
    Guid SessaoCaixaCancelamentoId,
    IReadOnlyList<EstornoEscolhido> Estornos,
    IReadOnlyList<EstornoPorForma> Movimentos)
{
    /// <summary>Quanto sai da gaveta (as linhas na forma Dinheiro).</summary>
    public decimal SaiDaGaveta => Estornos.Where(e => EstornoPagamento.SaiDaGaveta(e.Estorno)).Sum(e => e.Valor);
}
