using System.Text.Json.Nodes;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Sync.Protocolo;
using F = GenesisPDV.Sync.Protocolo.FormatoProtocolo;

namespace GenesisPDV.Sync.Eventos;

/// <summary>
/// Monta os eventos do outbox (sincronizacao.md 9). Chaves do payload = nomes de tabela, campos = nomes de coluna;
/// linhas de movimento não levam <c>criado_em</c>/<c>atualizado_em</c>/<c>excluido_em</c>/<c>versao</c> nem as colunas
/// que só a nuvem preenche (9.1). O formato é o do contrato zod (<c>packages/shared/src/sync/eventos.ts</c>): cada linha
/// leva <b>todas</b> as chaves do contrato, nulas quando o PDV ainda não tem o dado (fiscal na 1D, lote, comanda,
/// vendedor), e o <c>ContratosEventosTests</c> confere o payload contra a fixture que o Vitest passa pelo zod.
/// </summary>
public static class FabricaEventos
{
    public const int VersaoSchemaVenda = 1;

    public static EventoParaOutbox VendaFinalizada(Venda venda, Guid eventoId)
    {
        ArgumentNullException.ThrowIfNull(venda);
        if (venda.Status != StatusVenda.Finalizada || venda.FinalizadaEm is null)
        {
            throw new InvalidOperationException("venda.finalizada exige venda finalizada.");
        }

        return Montar("venda.finalizada", venda, eventoId, venda.FinalizadaEm.Value, venda.OperadorId);
    }

    /// <summary>
    /// <c>venda.cancelada</c> v1 forma B (SYNC 9.9 B): a venda em andamento cancelada, documento completo. A finalizada
    /// cancelada sai pela forma A (<see cref="VendaCanceladaFinalizada"/>): o documento dela já subiu.
    /// </summary>
    public static EventoParaOutbox VendaCancelada(Venda venda, Guid eventoId)
    {
        ArgumentNullException.ThrowIfNull(venda);
        if (venda.Status != StatusVenda.Cancelada || venda.CanceladaEm is null || venda.FinalizadaEm is not null)
        {
            throw new InvalidOperationException("venda.cancelada forma B exige venda em andamento cancelada.");
        }

        return Montar("venda.cancelada", venda, eventoId, venda.CanceladaEm.Value, venda.CanceladaPorId ?? venda.OperadorId);
    }

    /// <summary>
    /// <c>venda.cancelada</c> v1 forma A (SYNC 9.9 A; PDV 13.3; Fase 1C, bloco C11b): a venda finalizada cancelada na
    /// sessão aberta. Só as colunas de cancelamento da venda, o estorno de cada pagamento (<c>estornado</c> + o campo de
    /// payload <c>estorno</c>) e as linhas <c>estorno_venda</c> da sessão do cancelamento (uma por forma); TEF é da Fase
    /// 6 (<c>transacoes_tef</c> vazio). O agregado é a venda; depende dela (o <c>venda.finalizada</c> retido retém o
    /// cancelamento) e da sessão do cancelamento (SYNC 8.5). Quem executou é quem cancelou; o gerente que liberou vai em
    /// <c>cancelamento_autorizado_por_id</c> e no <c>autorizado_por_id</c> de cada estorno.
    /// </summary>
    public static EventoParaOutbox VendaCanceladaFinalizada(
        Venda venda, CancelamentoFinalizada cancelamento, IReadOnlyList<MovimentoCaixaRegistro> estornos, Guid eventoId)
    {
        ArgumentNullException.ThrowIfNull(venda);
        ArgumentNullException.ThrowIfNull(cancelamento);
        ArgumentNullException.ThrowIfNull(estornos);
        if (venda is not { Status: StatusVenda.Cancelada, FinalizadaEm: not null, CanceladaEm: { } canceladaEm, CanceladaPorId: { } canceladaPor }
            || string.IsNullOrWhiteSpace(venda.MotivoCancelamento))
        {
            throw new InvalidOperationException("venda.cancelada forma A exige a venda finalizada cancelada, com quem, quando e o motivo.");
        }

        var sessao = cancelamento.SessaoCaixaCancelamentoId;
        // Os mesmos refinamentos do payloadVendaCanceladaFinalizadaSchema: estorno_venda só (e sempre) com estorno
        // efetivado, todos da sessão do cancelamento e com a forma; o PDV não monta o que a nuvem recusaria.
        var efetivados = cancelamento.Estornos.Any(e => EstornoPagamento.GeraMovimento(e.Estorno));
        if (efetivados != (estornos.Count > 0)
            || estornos.Any(m => m.Tipo != TipoMovimentoCaixa.EstornoVenda || m.SessaoCaixaId != sessao || m.FormaPagamentoId is null))
        {
            throw new InvalidOperationException("venda.cancelada forma A: estorno_venda só com estorno efetivado, na sessão do cancelamento e com a forma.");
        }

        var pagamentos = new JsonArray();
        foreach (var e in cancelamento.Estornos)
        {
            pagamentos.Add(new JsonObject
            {
                ["id"] = F.Uuid(e.PagamentoVendaId),
                ["status"] = StatusPagamento.Estornado,
                ["estorno"] = e.Estorno,
            });
        }

        var movimentos = new JsonArray();
        foreach (var m in estornos)
        {
            movimentos.Add(FabricaEventosCaixa.Movimento(m));
        }

        var payload = new JsonObject
        {
            ["vendas"] = new JsonObject
            {
                ["id"] = F.Uuid(venda.Id),
                ["status"] = StatusVenda.Cancelada,
                ["status_fiscal"] = venda.StatusFiscal,
                ["cancelada_em"] = F.DataHora(canceladaEm),
                ["cancelada_por_id"] = F.Uuid(canceladaPor),
                ["cancelamento_autorizado_por_id"] = F.Uuid(venda.CancelamentoAutorizadoPorId),
                ["motivo_cancelamento"] = venda.MotivoCancelamento,
                ["cancelamento_origem"] = venda.CancelamentoOrigem ?? "pdv",
            },
            ["sessao_caixa_cancelamento_id"] = F.Uuid(sessao),
            ["pagamentos_venda"] = pagamentos,
            ["movimentos_caixa"] = movimentos,
            ["transacoes_tef"] = new JsonArray(),
        };
        var jcs = Jcs.Serializar(payload);
        return new EventoParaOutbox(eventoId, "venda.cancelada", VersaoSchemaVenda, "venda", venda.Id, canceladaEm, jcs, Jcs.Sha256Hex(jcs))
        {
            UsuarioId = canceladaPor,
            SessaoCaixaId = sessao,
            Dependencias = [new DependenciaOutbox("venda", venda.Id), DependenciaOutbox.Sessao(sessao)],
        };
    }

    /// <summary>
    /// Envelope da venda (SYNC 7.3, 8.5): quem executou (o operador; no cancelamento, quem cancelou), a sessão no contexto
    /// e a dependência dela (a venda da sessão retida espera o <c>caixa.aberto</c>).
    /// </summary>
    private static EventoParaOutbox Montar(string tipo, Venda venda, Guid eventoId, DateTimeOffset ocorridoEm, Guid usuarioId)
    {
        var payload = PayloadVenda(venda);
        var jcs = Jcs.Serializar(payload);
        return new EventoParaOutbox(eventoId, tipo, VersaoSchemaVenda, "venda", venda.Id, ocorridoEm, jcs, Jcs.Sha256Hex(jcs))
        {
            UsuarioId = usuarioId,
            SessaoCaixaId = venda.SessaoCaixaId,
            Dependencias = venda.SessaoCaixaId is { } sessao ? [DependenciaOutbox.Sessao(sessao)] : [],
        };
    }

    public static JsonObject PayloadVenda(Venda v)
    {
        var itens = new JsonArray();
        foreach (var i in v.Itens)
        {
            itens.Add(new JsonObject
            {
                ["id"] = F.Uuid(i.Id),
                ["venda_id"] = F.Uuid(v.Id),
                ["sequencia"] = i.Sequencia,
                ["produto_id"] = F.Uuid(i.ProdutoId),
                ["variacao_id"] = null,
                ["codigo_lido"] = i.CodigoLido,
                ["codigo_barras_id"] = F.Uuid(i.CodigoBarrasId),
                ["origem_entrada"] = i.OrigemEntrada,
                ["peso_digitado"] = i.PesoDigitado,
                ["descricao"] = i.Descricao,
                ["unidade"] = i.Unidade,
                ["quantidade"] = F.Quantidade(i.Quantidade),
                ["preco_tabela"] = F.Preco(i.PrecoTabela),
                ["preco_unitario"] = F.Preco(i.PrecoUnitario),
                ["origem_preco"] = i.OrigemPreco,
                ["grupo_preco_quantidade_id"] = F.Uuid(i.GrupoPrecoQuantidadeId),
                ["quantidade_referencia_preco"] = i.QuantidadeReferenciaPreco is { } qr ? F.Quantidade(qr) : null,
                ["valor_bruto"] = F.Dinheiro(i.ValorBruto),
                ["desconto_item"] = F.Dinheiro(i.DescontoItem),
                ["desconto_promocao"] = F.Dinheiro(i.DescontoPromocao),
                ["promocao_id"] = F.Uuid(i.PromocaoId),
                ["desconto_rateado"] = F.Dinheiro(i.DescontoRateado),
                ["acrescimo_rateado"] = F.Dinheiro(i.AcrescimoRateado),
                ["frete_rateado"] = F.Dinheiro(i.FreteRateado),
                ["valor_liquido"] = F.Dinheiro(i.ValorLiquido),
                ["kit_grupo_id"] = F.Uuid(i.Kit?.GrupoId),
                ["kit_produto_id"] = F.Uuid(i.Kit?.ProdutoId),
                ["kit_descricao"] = i.Kit?.Descricao,
                ["kit_quantidade"] = i.Kit is { } kq ? F.Quantidade(kq.Quantidade) : null,
                ["kit_preco_unitario"] = i.Kit is { } kp ? F.Preco(kp.PrecoUnitario) : null,
                ["kit_componente_id"] = F.Uuid(i.Kit?.ComponenteId),
                ["kit_alternativa_id"] = F.Uuid(i.Kit?.AlternativaId),
                ["kit_acrescimo"] = F.Preco(i.Kit?.Acrescimo ?? 0m),
                ["vasilhame_item_origem_id"] = F.Uuid(i.VasilhameItemOrigemId),

                // Lote/validade (PDV 10.8), comanda e orçamento (PDV-3) e vendedor (O24: não há na 1C) ainda sem dado.
                ["lote_id"] = null,
                ["lote"] = null,
                ["validade_lote"] = null,
                ["item_comanda_id"] = null,
                ["item_orcamento_id"] = null,
                ["vendedor_id"] = null,

                // Snapshot fiscal (modelo 3.11.3, schema_fiscal 2): chega com a NFC-e (1D); a loja não fiscal manda nulo.
                ["cfop"] = null,
                ["ncm"] = null,
                ["fiscal_snapshot"] = null,
                ["v_ibs"] = null,
                ["v_cbs"] = null,
                ["v_is"] = null,
                ["v_fcp"] = null,
                ["v_icms_st_ret"] = null,
                ["v_fcp_st_ret"] = null,
                ["cancelado"] = i.Cancelado,
                ["cancelado_em"] = F.DataHora(i.CanceladoEm),
                ["cancelado_por_id"] = F.Uuid(i.CanceladoPorId),
                ["autorizado_por_id"] = F.Uuid(i.AutorizadoPorId),
                ["motivo_cancelamento"] = i.MotivoCancelamento,
                ["incluido_em"] = F.DataHora(i.IncluidoEm),

                // Só payload (sincronizacao.md 9.7): os insumos da ficha técnica do produzido (D17), já multiplicados e com
                // a perda; vazio para os demais, inclusive os itens de combo — cada componente já é um item.
                ["componentes_estoque"] = ComponentesEstoque(v, i),
            });
        }

        var pagamentos = new JsonArray();
        foreach (var p in v.Pagamentos)
        {
            pagamentos.Add(new JsonObject
            {
                ["id"] = F.Uuid(p.Id),
                ["venda_id"] = F.Uuid(v.Id),
                ["sequencia"] = p.Sequencia,
                ["forma_pagamento_id"] = F.Uuid(p.FormaPagamentoId),
                ["descricao_forma"] = p.DescricaoForma,
                ["meio_pagamento_fiscal"] = p.MeioPagamentoFiscal,
                ["tipo_forma"] = p.TipoForma,
                ["valor"] = F.Dinheiro(p.Valor),
                ["valor_recebido"] = p.ValorRecebido is { } r ? F.Dinheiro(r) : null,
                ["troco"] = F.Dinheiro(p.Troco),
                ["valor_taxa_servico"] = F.Dinheiro(0m),
                ["parcelas"] = p.Parcelas,
                ["status"] = p.Status,
                ["lanca_quitada"] = p.LancaQuitada,
                ["taxa_pct"] = F.Percentual(p.TaxaPct),
                ["indicador_pagamento"] = (int)p.IndicadorPagamento,
                ["data_pagamento"] = F.Data(p.DataPagamento),

                // POS (16.5: tpIntegra 2, bandeira, NSU, autorização; O9c), a cobrança do PIX estático/manual (16.7) e o
                // supervisor que liberou a forma (C11a). Cliente da forma (crediário), CNPJ do pagamento, credenciadora, TEF
                // e vale chegam com cada forma (PDV-2, Fase 6, Fase 3).
                ["pessoa_id"] = null,
                ["cnpj_pagamento"] = null,
                ["uf_pagamento"] = null,
                ["tipo_integracao"] = p.Detalhe.TipoIntegracao is { } ti ? (int)ti : null,
                ["bandeira"] = p.Detalhe.Bandeira,
                ["bandeira_nome"] = p.Detalhe.BandeiraNome,
                ["adquirente"] = null,
                ["cnpj_credenciadora"] = null,
                ["nsu"] = p.Detalhe.Nsu,
                ["autorizacao"] = p.Detalhe.Autorizacao,
                ["cartao_mascarado"] = null,
                ["cnpj_beneficiario"] = null,
                ["id_terminal_pagamento"] = null,
                ["tef_transacao_id"] = null,
                ["pix_cobranca_id"] = F.Uuid(p.Detalhe.PixCobrancaId),
                ["vale_id"] = null,
                ["autorizado_por_id"] = F.Uuid(p.Detalhe.AutorizadoPorId),
                ["transferido_de_id"] = null,
            });
        }

        return new JsonObject
        {
            ["vendas"] = new JsonObject
            {
                ["id"] = F.Uuid(v.Id),
                ["numero"] = v.Numero,
                ["numero_exibicao"] = v.NumeroExibicao,
                ["loja_id"] = F.Uuid(v.LojaId),
                ["caixa_id"] = F.Uuid(v.CaixaId),
                ["numero_caixa"] = v.NumeroCaixa,
                ["terminal_id"] = F.Uuid(v.TerminalId),
                ["sessao_caixa_id"] = F.Uuid(v.SessaoCaixaId),
                ["tipo"] = v.Tipo,
                ["canal"] = v.Canal,
                ["modo"] = v.Modo,
                ["id_externo"] = null,
                ["status"] = v.Status,
                ["status_fiscal"] = v.StatusFiscal,
                ["devolucao"] = "nenhuma",
                ["dia_operacional"] = F.Data(v.DiaOperacional),
                ["operador_id"] = F.Uuid(v.OperadorId),
                ["vendedor_id"] = F.Uuid(v.VendedorId),
                ["cliente_id"] = F.Uuid(v.ClienteId),
                ["cpf_cnpj_nota"] = v.CpfCnpjNota,
                ["nome_nota"] = v.NomeNota,
                ["tipo_preco"] = v.TipoPreco,
                ["orcamento_id"] = null,
                ["comanda_id"] = null,
                ["pedido_id"] = null,
                ["qtd_itens"] = v.QtdItens,
                ["subtotal_bruto"] = F.Dinheiro(v.SubtotalBruto),
                ["desconto_itens"] = F.Dinheiro(v.DescontoItens),
                ["desconto_total"] = F.Dinheiro(v.DescontoTotal),
                ["desconto_total_pct"] = v.DescontoTotalPctDocumento is { } pct ? F.Percentual(pct) : null,
                ["desconto_total_origem"] = v.DescontoTotalOrigem,
                ["acrescimo_total"] = F.Dinheiro(v.AcrescimoTotal),
                ["taxa_servico"] = F.Dinheiro(v.TaxaServico),
                ["taxa_entrega"] = F.Dinheiro(v.TaxaEntrega),
                ["valor_frete"] = F.Dinheiro(v.ValorFrete),
                ["total"] = F.Dinheiro(v.Total),
                ["troco"] = F.Dinheiro(v.Troco),
                ["endereco_entrega"] = null,
                ["observacao"] = v.Observacao,
                ["iniciada_em"] = F.DataHora(v.IniciadaEm),
                ["finalizada_em"] = F.DataHora(v.FinalizadaEm),
                ["cancelada_em"] = F.DataHora(v.CanceladaEm),
                ["cancelada_por_id"] = F.Uuid(v.CanceladaPorId),
                ["cancelamento_autorizado_por_id"] = F.Uuid(v.CancelamentoAutorizadoPorId),
                ["motivo_cancelamento"] = v.MotivoCancelamento,
                ["cancelamento_origem"] = v.CancelamentoOrigem,
                ["idade_confirmada_por_id"] = F.Uuid(v.IdadeConfirmadaPorId),
                ["idade_confirmada_em"] = F.DataHora(v.IdadeConfirmadaEm),
                ["evento_finalizacao_id"] = F.Uuid(v.EventoFinalizacaoId),
            },
            ["itens_venda"] = itens,
            ["itens_venda_complementos"] = new JsonArray(),
            ["pagamentos_venda"] = pagamentos,
            ["parcelas_venda"] = new JsonArray(),
            ["transacoes_tef"] = new JsonArray(),
            ["cobrancas_pix"] = CobrancasPix(v),
            ["liberacoes"] = Liberacoes(v),
            ["vasilhames"] = Vasilhames(v),

            // NF-e para PJ contribuinte (PDV 14.4) é da 1D.
            ["nfe_solicitada"] = false,
            ["nfe_pendente_erp"] = false,
        };
    }

    /// <summary>
    /// Bloco <c>liberacoes</c> (só payload, sincronizacao.md 9.7): as liberações de supervisor usadas na venda, ligadas
    /// ao item (ou à venda toda). Também sobem na auditoria; aqui contam no <c>qtd_liberacoes</c> do fechamento.
    /// </summary>
    private static JsonArray Liberacoes(Venda v)
    {
        var lista = new JsonArray();
        foreach (var l in v.Liberacoes)
        {
            lista.Add(new JsonObject
            {
                ["acao"] = l.Acao,
                ["item_venda_id"] = F.Uuid(l.ItemVendaId),
                ["valor_pct"] = l.ValorPct is { } pct ? F.Percentual(pct) : null,
                ["autorizado_por_id"] = F.Uuid(l.AutorizadoPorId),
                ["motivo"] = l.Motivo,
                ["ocorrido_em"] = F.DataHora(l.OcorridoEm),
            });
        }

        return lista;
    }

    /// <summary><c>componentes_estoque</c> do item (sincronizacao.md 9.7): a ficha técnica do produzido (D17 do dono).</summary>
    private static JsonArray ComponentesEstoque(Venda v, ItemVenda i)
    {
        var lista = new JsonArray();
        foreach (var c in v.ComponentesEstoque(i))
        {
            lista.Add(new JsonObject
            {
                ["produto_id"] = F.Uuid(c.ProdutoId),
                ["variacao_id"] = F.Uuid(c.VariacaoId),
                ["quantidade"] = F.Quantidade(c.Quantidade),
                ["origem"] = "ficha_tecnica",
            });
        }

        return lista;
    }

    /// <summary>
    /// <c>cobrancas_pix</c> (MD 3.11.6): o PIX estático/manual da venda (16.7), já pago, com o QR (ou vazio na
    /// confirmação sem chave), o nome de quem pagou e o horário do app do banco. A do pagamento removido vai cancelada.
    /// </summary>
    private static JsonArray CobrancasPix(Venda v)
    {
        var lista = new JsonArray();
        foreach (var c in v.CobrancasPix)
        {
            lista.Add(new JsonObject
            {
                ["id"] = F.Uuid(c.Id),
                ["txid"] = c.Txid,
                ["tipo"] = c.Tipo,
                ["loja_id"] = F.Uuid(v.LojaId),
                ["terminal_id"] = F.Uuid(v.TerminalId ?? Guid.Empty),
                ["venda_id"] = F.Uuid(v.Id),
                ["pagamento_venda_id"] = F.Uuid(c.PagamentoVendaId),
                ["psp"] = null,
                ["valor"] = F.Dinheiro(c.Valor),
                ["status"] = c.Status,
                ["qrcode_payload"] = c.QrcodePayload,
                ["expira_em"] = null,
                ["paga_em"] = F.DataHora(c.PagaEm),
                ["e2e_id"] = null,
                ["pagador_nome"] = c.PagadorNome,
                ["pagador_documento"] = null,
                ["valor_devolvido"] = F.Dinheiro(0m),
                ["devolvida_em"] = null,
            });
        }

        return lista;
    }

    /// <summary>
    /// Bloco <c>vasilhames</c> (só payload, PDV 10.12): cascos trazidos e cobrados por casco; os descontados na venda
    /// (C11c) vão nos <c>devolvidos</c>, e o valor deles no <c>desconto_total</c>.
    /// </summary>
    private static JsonArray Vasilhames(Venda v)
    {
        var lista = new JsonArray();
        foreach (var r in v.ResumoVasilhames())
        {
            lista.Add(new JsonObject
            {
                ["produto_vasilhame_id"] = F.Uuid(r.ProdutoVasilhameId),
                ["devolvidos"] = (int)r.Devolvidos,
                ["vendidos"] = (int)r.Vendidos,
                ["emprestados"] = (int)r.Emprestados,
                ["pessoa_id"] = F.Uuid(r.PessoaId),
            });
        }

        return lista;
    }
}
