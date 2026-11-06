using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;

namespace GenesisPDV.Data.Repositorios;

/// <summary>
/// Converte o agregado <see cref="Venda"/> nas linhas de <c>vendas</c>, <c>itens_venda</c>, <c>pagamentos_venda</c> e da
/// tabela local <c>liberacoes_venda</c>, mais as <c>cobrancas_pix</c> do PIX estático/manual (C11a) e a tabela local
/// <c>cascos_descontados_venda</c> (C11c).
/// </summary>
internal static class MapeadorVenda
{
    public static void CopiarPara(Venda v, VendaRegistro r, DateTimeOffset agora)
    {
        if (r.Id == Guid.Empty)
        {
            r.Id = v.Id;
            r.CriadoEm = agora;
        }

        r.AtualizadoEm = agora;
        r.Numero = v.Numero;
        r.NumeroExibicao = v.NumeroExibicao;
        r.LojaId = v.LojaId;
        r.CaixaId = v.CaixaId;
        r.NumeroCaixa = checked((short)v.NumeroCaixa);
        r.TerminalId = v.TerminalId;
        r.SessaoCaixaId = v.SessaoCaixaId;
        r.Tipo = v.Tipo;
        r.Canal = v.Canal;
        r.Modo = v.Modo;
        r.Status = v.Status;
        r.StatusFiscal = v.StatusFiscal;
        r.DiaOperacional = v.DiaOperacional;
        r.OperadorId = v.OperadorId;
        r.VendedorId = v.VendedorId;
        r.ClienteId = v.ClienteId;
        r.CpfCnpjNota = v.CpfCnpjNota;
        r.NomeNota = v.NomeNota;
        r.TipoPreco = v.TipoPreco;
        r.QtdItens = v.QtdItens;
        r.SubtotalBruto = v.SubtotalBruto;
        r.DescontoItens = v.DescontoItens;
        r.DescontoTotal = v.DescontoTotal;
        r.DescontoTotalPct = v.DescontoTotalPct;
        r.DescontoTotalOrigem = v.DescontoTotalOrigem;
        r.AcrescimoTotal = v.AcrescimoTotal;
        r.TaxaServico = v.TaxaServico;
        r.TaxaEntrega = v.TaxaEntrega;
        r.ValorFrete = v.ValorFrete;
        r.Total = v.Total;
        r.Troco = v.Troco;
        r.IniciadaEm = v.IniciadaEm;
        r.FinalizadaEm = v.FinalizadaEm;
        r.CanceladaEm = v.CanceladaEm;
        r.CanceladaPorId = v.CanceladaPorId;
        r.CancelamentoAutorizadoPorId = v.CancelamentoAutorizadoPorId;
        r.MotivoCancelamento = v.MotivoCancelamento;
        r.CancelamentoOrigem = v.CancelamentoOrigem;
        r.EventoFinalizacaoId = v.EventoFinalizacaoId;
        r.Observacao = v.Observacao;
        r.IdadeConfirmadaPorId = v.IdadeConfirmadaPorId;
        r.IdadeConfirmadaEm = v.IdadeConfirmadaEm;

        foreach (var item in v.Itens)
        {
            var linha = r.Itens.FirstOrDefault(i => i.Id == item.Id);
            if (linha is null)
            {
                linha = new ItemVendaRegistro { Id = item.Id, VendaId = v.Id, CriadoEm = agora };
                r.Itens.Add(linha);
            }

            CopiarItem(item, linha, agora);
        }

        foreach (var pagamento in v.Pagamentos)
        {
            var linha = r.Pagamentos.FirstOrDefault(p => p.Id == pagamento.Id);
            if (linha is null)
            {
                linha = new PagamentoVendaRegistro { Id = pagamento.Id, VendaId = v.Id, CriadoEm = agora };
                r.Pagamentos.Add(linha);
            }

            CopiarPagamento(pagamento, linha, agora);
        }
    }

    private static void CopiarItem(ItemVenda i, ItemVendaRegistro r, DateTimeOffset agora)
    {
        r.AtualizadoEm = agora;
        r.Sequencia = i.Sequencia;
        r.ProdutoId = i.ProdutoId;
        r.CodigoLido = i.CodigoLido;
        r.CodigoBarrasId = i.CodigoBarrasId;
        r.OrigemEntrada = i.OrigemEntrada;
        r.PesoDigitado = i.PesoDigitado;
        r.Descricao = i.Descricao;
        r.Unidade = i.Unidade;
        r.Quantidade = i.Quantidade;
        r.PrecoTabela = i.PrecoTabela;
        r.PrecoUnitario = i.PrecoUnitario;
        r.OrigemPreco = i.OrigemPreco;
        r.GrupoPrecoQuantidadeId = i.GrupoPrecoQuantidadeId;
        r.QuantidadeReferenciaPreco = i.QuantidadeReferenciaPreco;
        r.ValorBruto = i.ValorBruto;
        r.DescontoItem = i.DescontoItem;
        r.DescontoPromocao = i.DescontoPromocao;
        r.PromocaoId = i.PromocaoId;
        r.VasilhameItemOrigemId = i.VasilhameItemOrigemId;
        r.KitGrupoId = i.Kit?.GrupoId;
        r.KitProdutoId = i.Kit?.ProdutoId;
        r.KitDescricao = i.Kit?.Descricao;
        r.KitQuantidade = i.Kit?.Quantidade;
        r.KitPrecoUnitario = i.Kit?.PrecoUnitario;
        r.KitComponenteId = i.Kit?.ComponenteId;
        r.KitAlternativaId = i.Kit?.AlternativaId;
        r.KitAcrescimo = i.Kit?.Acrescimo ?? 0m;
        r.DescontoRateado = i.DescontoRateado;
        r.AcrescimoRateado = i.AcrescimoRateado;
        r.FreteRateado = i.FreteRateado;
        r.ValorLiquido = i.ValorLiquido;
        r.Cancelado = i.Cancelado;
        r.CanceladoEm = i.CanceladoEm;
        r.CanceladoPorId = i.CanceladoPorId;
        r.AutorizadoPorId = i.AutorizadoPorId;
        r.MotivoCancelamento = i.MotivoCancelamento;
        r.IncluidoEm = i.IncluidoEm;
    }

    private static void CopiarPagamento(PagamentoVenda p, PagamentoVendaRegistro r, DateTimeOffset agora)
    {
        r.AtualizadoEm = agora;
        r.Sequencia = checked((short)p.Sequencia);
        r.FormaPagamentoId = p.FormaPagamentoId;
        r.DescricaoForma = p.DescricaoForma;
        r.MeioPagamentoFiscal = p.MeioPagamentoFiscal;
        r.TipoForma = p.TipoForma;
        r.Valor = p.Valor;
        r.ValorRecebido = p.ValorRecebido;
        r.Troco = p.Troco;
        r.Parcelas = checked((short)p.Parcelas);
        r.Status = p.Status;
        r.LancaQuitada = p.LancaQuitada;
        r.TaxaPct = p.TaxaPct;
        r.IndicadorPagamento = p.IndicadorPagamento;
        r.DataPagamento = p.DataPagamento;
        r.TipoIntegracao = p.Detalhe.TipoIntegracao;
        r.Bandeira = p.Detalhe.Bandeira;
        r.BandeiraNome = p.Detalhe.BandeiraNome;
        r.Nsu = p.Detalhe.Nsu;
        r.Autorizacao = p.Detalhe.Autorizacao;
        r.PixCobrancaId = p.Detalhe.PixCobrancaId;
        r.AutorizadoPorId = p.Detalhe.AutorizadoPorId;
    }

    /// <summary>Linha de <c>cobrancas_pix</c> da venda (PIX estático/manual, 16.7); o status muda no cancelamento.</summary>
    public static void CopiarCobranca(Venda v, CobrancaPixVenda c, CobrancaPixRegistro r, DateTimeOffset agora)
    {
        if (r.Id == Guid.Empty)
        {
            r.Id = c.Id;
            r.CriadoEm = agora;
        }

        r.AtualizadoEm = agora;
        r.Txid = c.Txid;
        r.Tipo = c.Tipo;
        r.LojaId = v.LojaId;
        r.TerminalId = v.TerminalId ?? Guid.Empty;
        r.VendaId = v.Id;
        r.PagamentoVendaId = c.PagamentoVendaId;
        r.Valor = c.Valor;
        r.Status = c.Status;
        r.QrcodePayload = c.QrcodePayload;
        r.PagaEm = c.PagaEm;
        r.PagadorNome = c.PagadorNome;
    }

    public static LiberacaoVendaLocal ParaLinha(Guid vendaId, LiberacaoVenda l) => new()
    {
        Id = l.Id,
        VendaId = vendaId,
        Acao = l.Acao,
        ItemVendaId = l.ItemVendaId,
        ValorPct = l.ValorPct,
        AutorizadoPorId = l.AutorizadoPorId,
        Motivo = l.Motivo,
        OcorridoEm = l.OcorridoEm,
    };

    /// <summary>Linha local do casco descontado na venda (C11c).</summary>
    public static CascoDescontadoVendaLocal ParaLinha(Guid vendaId, CascoDescontado c) => new()
    {
        VendaId = vendaId,
        ProdutoVasilhameId = c.ProdutoVasilhameId,
        Descricao = c.Descricao,
        Quantidade = c.Quantidade,
        PrecoUnitario = c.PrecoUnitario,
        RegistradoEm = c.RegistradoEm,
    };

    /// <param name="formas">
    /// Espelho das formas usadas (C11a): <c>restringe_idade_minima</c> e "exige pessoa" não têm coluna em
    /// <c>pagamentos_venda</c> e voltam ao pagamento pela forma, para a venda recuperada manter as duas regras.
    /// </param>
    public static Venda ParaDominio(
        VendaRegistro r,
        IEnumerable<LiberacaoVendaLocal>? liberacoes = null,
        IEnumerable<CobrancaPixRegistro>? cobrancas = null,
        IReadOnlyDictionary<Guid, FormaPagamentoRegistro>? formas = null,
        IEnumerable<CascoDescontadoVendaLocal>? cascosDescontados = null)
    {
        var estado = new EstadoVenda(
            Id: r.Id,
            Numero: r.Numero,
            NumeroExibicao: r.NumeroExibicao,
            LojaId: r.LojaId,
            CaixaId: r.CaixaId,
            NumeroCaixa: r.NumeroCaixa,
            TerminalId: r.TerminalId,
            SessaoCaixaId: r.SessaoCaixaId,
            Modo: r.Modo,
            Status: r.Status,
            StatusFiscal: r.StatusFiscal,
            OperadorId: r.OperadorId,
            TipoPreco: r.TipoPreco,
            DescontoTotal: r.DescontoTotal,
            DescontoTotalPct: r.DescontoTotalPct,
            AcrescimoTotal: r.AcrescimoTotal,
            IniciadaEm: r.IniciadaEm,
            FinalizadaEm: r.FinalizadaEm,
            DiaOperacional: r.DiaOperacional,
            VendedorId: r.VendedorId,
            ClienteId: r.ClienteId,
            CpfCnpjNota: r.CpfCnpjNota,
            NomeNota: r.NomeNota,
            CanceladaEm: r.CanceladaEm,
            CanceladaPorId: r.CanceladaPorId,
            CancelamentoAutorizadoPorId: r.CancelamentoAutorizadoPorId,
            MotivoCancelamento: r.MotivoCancelamento,
            CancelamentoOrigem: r.CancelamentoOrigem,
            EventoFinalizacaoId: r.EventoFinalizacaoId,
            Observacao: r.Observacao,
            DescontoTotalOrigem: r.DescontoTotalOrigem,
            IdadeConfirmadaPorId: r.IdadeConfirmadaPorId,
            IdadeConfirmadaEm: r.IdadeConfirmadaEm);

        var itens = r.Itens.Select(i => new ItemVenda(
            id: i.Id,
            sequencia: i.Sequencia,
            produtoId: i.ProdutoId,
            codigoLido: i.CodigoLido,
            codigoBarrasId: i.CodigoBarrasId,
            descricao: i.Descricao,
            unidade: i.Unidade,
            fracionavel: new Core.Produtos.ProdutoVenda(i.ProdutoId, null, null, i.Descricao, i.Unidade, 0m).Fracionavel,
            quantidade: i.Quantidade,
            precoTabela: i.PrecoTabela,
            precoUnitario: i.PrecoUnitario,
            origemPreco: i.OrigemPreco,
            valorBruto: i.ValorBruto,
            descontoItem: i.DescontoItem,
            incluidoEm: i.IncluidoEm,
            descontoRateado: i.DescontoRateado,
            acrescimoRateado: i.AcrescimoRateado,
            freteRateado: i.FreteRateado,
            valorLiquido: i.ValorLiquido,
            cancelado: i.Cancelado,
            canceladoEm: i.CanceladoEm,
            canceladoPorId: i.CanceladoPorId,
            autorizadoPorId: i.AutorizadoPorId,
            motivoCancelamento: i.MotivoCancelamento,
            descontoPromocao: i.DescontoPromocao,
            promocaoId: i.PromocaoId,
            origemEntrada: i.OrigemEntrada,
            pesoDigitado: i.PesoDigitado,
            vasilhameItemOrigemId: i.VasilhameItemOrigemId,
            grupoPrecoQuantidadeId: i.GrupoPrecoQuantidadeId,
            quantidadeReferenciaPreco: i.QuantidadeReferenciaPreco,
            kit: i.KitGrupoId is { } grupo
                ? new DadosKit(
                    grupo,
                    i.KitProdutoId!.Value,
                    i.KitDescricao ?? string.Empty,
                    i.KitQuantidade ?? 0m,
                    i.KitPrecoUnitario ?? 0m,
                    i.KitComponenteId!.Value,
                    i.KitAlternativaId,
                    i.KitAcrescimo)
                : null));

        var pagamentos = r.Pagamentos.Select(p => new PagamentoVenda(
            id: p.Id,
            sequencia: p.Sequencia,
            formaPagamentoId: p.FormaPagamentoId,
            descricaoForma: p.DescricaoForma,
            meioPagamentoFiscal: p.MeioPagamentoFiscal,
            tipoForma: p.TipoForma,
            valor: p.Valor,
            valorRecebido: p.ValorRecebido,
            troco: p.Troco,
            status: p.Status,
            lancaQuitada: p.LancaQuitada,
            taxaPct: p.TaxaPct,
            parcelas: p.Parcelas,
            indicadorPagamento: p.IndicadorPagamento,
            dataPagamento: p.DataPagamento,
            detalhe: new DetalhePagamento(p.TipoIntegracao, p.Bandeira, p.BandeiraNome, p.Nsu, p.Autorizacao, p.Parcelas, p.PixCobrancaId,
                p.AutorizadoPorId),
            restringeIdadeMinima: formas?.GetValueOrDefault(p.FormaPagamentoId)?.RestringeIdadeMinima ?? false,
            exigePessoa: formas?.GetValueOrDefault(p.FormaPagamentoId)?.ExigePessoa ?? false));

        var usadas = (liberacoes ?? []).Select(l =>
            new LiberacaoVenda(l.Id, l.Acao, l.ItemVendaId, l.ValorPct, l.AutorizadoPorId, l.Motivo, l.OcorridoEm));
        var pix = (cobrancas ?? []).Select(c =>
            new CobrancaPixVenda(c.Id, c.Txid, c.Valor, c.QrcodePayload, c.PagaEm, c.PagadorNome, c.PagamentoVendaId, c.Status, c.Tipo));
        var cascos = (cascosDescontados ?? []).Select(c =>
            new CascoDescontado(c.ProdutoVasilhameId, c.Descricao, c.Quantidade, c.PrecoUnitario, c.RegistradoEm));
        return Venda.Restaurar(estado, itens, pagamentos, liberacoes: usadas, cobrancasPix: pix, cascosDescontados: cascos);
    }
}
