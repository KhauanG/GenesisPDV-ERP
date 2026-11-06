using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Hardware.Impressora;

namespace GenesisPDV.App.Servicos;

/// <summary>Cabeçalho dos comprovantes do caixa (loja, caixa, operador, hora no fuso da loja).</summary>
public sealed record CabecalhoCaixa(string NomeLoja, short NumeroCaixa, string Operador, TimeZoneInfo Fuso);

/// <summary>
/// Comprovantes do caixa (PDV 8.2, 20 e 21; Fase 1C, blocos C10a e C10b): abertura, sangria e reforço, relatório de
/// fechamento e resumo diário, em ESC/POS pelo
/// <see cref="ConstrutorEscPos"/>. O relatório só traz o calculado e a diferença quando
/// <see cref="FechamentoCego.ImprimeCalculado"/> (O3 do dono: não traz; só o digitado, com a assinatura do conferente).
/// </summary>
public static class LayoutsCaixa
{
    public static byte[] Abertura(CabecalhoCaixa c, SessaoCaixaRegistro sessao, string? observacao, int colunas = 48)
    {
        ArgumentNullException.ThrowIfNull(c);
        ArgumentNullException.ThrowIfNull(sessao);
        var p = Cabecalho(new ConstrutorEscPos(colunas), c, "ABERTURA DE CAIXA");
        p.Colunado("Abertura:", Hora(sessao.AbertaEm, c.Fuso));
        p.Colunado("Fundo de troco:", NumeroBr.Dinheiro(sessao.FundoTroco));
        if (sessao.ValorRecebidoAnterior is { } recebido)
        {
            p.Colunado("Recebido do turno anterior:", NumeroBr.Dinheiro(recebido));
            p.Colunado("Diferença no recebimento:", NumeroBr.Dinheiro(sessao.DiferencaRecebimento ?? 0m));
        }

        if (!string.IsNullOrWhiteSpace(observacao))
        {
            p.Linha($"Obs.: {observacao.Trim()}");
        }

        Assinatura(p, "Operador");
        return p.Cortar().ParaBytes();
    }

    public static byte[] Fechamento(
        CabecalhoCaixa c,
        SessaoCaixaRegistro sessao,
        FechamentoCaixaRegistro fechamento,
        FechamentoConferido conferido,
        bool imprimeCalculado,
        DadosApuracaoSessao dados,
        int colunas = 48)
    {
        ArgumentNullException.ThrowIfNull(c);
        ArgumentNullException.ThrowIfNull(sessao);
        ArgumentNullException.ThrowIfNull(fechamento);
        ArgumentNullException.ThrowIfNull(conferido);
        ArgumentNullException.ThrowIfNull(dados);
        var p = Cabecalho(new ConstrutorEscPos(colunas), c, conferido.ZeraCaixa ? "FECHAMENTO DE CAIXA" : "TROCA DE TURNO");
        p.Colunado("Abertura:", Hora(sessao.AbertaEm, c.Fuso));
        p.Colunado("Fechamento:", Hora(fechamento.OcorridoEm, c.Fuso));
        p.Colunado("Fundo de troco:", NumeroBr.Dinheiro(sessao.FundoTroco));
        p.Separador();
        // Com o calculado, as três colunas de valores dividem a largura do papel quando cada valor (e o título) cabe com
        // pelo menos um espaço antes — no 80 mm, sempre na prática; senão (58 mm, valor grande) um valor por linha. Nenhum
        // valor é partido no meio nem encosta no vizinho.
        var largura = (p.Colunas - 3) / 3;
        var valores = conferido.Formas
            .Select(f => (f.Apurada.Forma.Descricao, Calculado: NumeroBr.Dinheiro(f.Apurada.Calculado), Contado: NumeroBr.Dinheiro(f.Digitado), Diferenca: NumeroBr.Dinheiro(f.Diferenca)))
            .ToList();
        var titulos = ("Calculado".PadLeft(largura) + "Contado".PadLeft(largura) + "Diferença".PadLeft(largura)).TrimStart();
        var emTabela = imprimeCalculado && "Calculado".Length < largura && "Forma ".Length + titulos.Length <= p.Colunas
                       && valores.All(v => Math.Max(v.Calculado.Length, Math.Max(v.Contado.Length, v.Diferenca.Length)) < largura);
        if (emTabela)
        {
            p.Linha("Forma" + titulos.PadLeft(p.Colunas - "Forma".Length));
        }
        else if (!imprimeCalculado)
        {
            p.Linha("Forma".PadRight(p.Colunas - 7) + "Contado");
        }

        foreach (var (descricao, calculado, contado, diferenca) in valores)
        {
            p.Linha(descricao);
            if (emTabela)
            {
                p.Linha(new string(' ', p.Colunas - (3 * largura)) + calculado.PadLeft(largura) + contado.PadLeft(largura) + diferenca.PadLeft(largura));
            }
            else if (imprimeCalculado)
            {
                p.Colunado("  Calculado", calculado);
                p.Colunado("  Contado", contado);
                p.Colunado("  Diferença", diferenca);
            }
            else
            {
                p.Linha(contado.PadLeft(p.Colunas));
            }
        }

        p.Colunado("Total contado:", NumeroBr.Dinheiro(conferido.TotalDigitado));
        if (imprimeCalculado)
        {
            p.Colunado("Total calculado:", NumeroBr.Dinheiro(conferido.TotalCalculado));
        }

        p.Colunado(conferido.ZeraCaixa ? "Zera caixa:" : "Fica na gaveta (próximo turno):", conferido.ZeraCaixa ? "SIM" : NumeroBr.Dinheiro(conferido.ValorCaixa));
        if (conferido.Justificativa is { } justificativa)
        {
            p.Linha($"Justificativa: {justificativa}");
        }

        var r = dados.Resumo;
        p.Separador();
        p.Colunado("Vendas:", $"{r.QtdVendas}  R$ {NumeroBr.Dinheiro(r.TotalVendas)}");
        p.Colunado("Ticket médio:", NumeroBr.Dinheiro(r.TicketMedio));
        p.Colunado("Vendas canceladas:", $"{r.QtdCanceladas}  R$ {NumeroBr.Dinheiro(r.TotalCanceladas)}");
        p.Colunado("Itens cancelados:", $"{r.QtdItensCancelados}  R$ {NumeroBr.Dinheiro(r.TotalItensCancelados)}");
        p.Colunado("Descontos:", $"R$ {NumeroBr.Dinheiro(r.TotalDescontos)} ({r.QtdLiberacoes} liberados)");
        var movimentos = dados.Linhas.Where(m => m.Tipo is TipoMovimentoCaixa.Sangria or TipoMovimentoCaixa.Reforco).ToList();
        if (movimentos.Count > 0)
        {
            p.Separador();
            p.Linha("Sangrias e reforços");
            foreach (var m in movimentos)
            {
                p.Colunado($"  {Hora(m.OcorridoEm, c.Fuso)} {(m.Tipo == TipoMovimentoCaixa.Sangria ? "Sangria" : "Reforço")}{(m.Cancelado ? " (cancelado)" : string.Empty)}",
                    NumeroBr.Dinheiro(m.Valor));
            }
        }

        Assinatura(p, "Operador");
        Assinatura(p, "Conferente");
        return p.Cortar().ParaBytes();
    }

    /// <summary>
    /// Comprovante da sangria ou do reforço (PDV 20.1–20.2; C10b): uma via por cópia, cada uma cortada, com a linha de
    /// assinatura do operador e de quem retira (ou entrega). Nunca traz o dinheiro estimado (O3 do dono).
    /// </summary>
    public static byte[] Movimento(CabecalhoCaixa c, MovimentoCaixaRegistro movimento, int vias = 1, int colunas = 48)
    {
        ArgumentNullException.ThrowIfNull(c);
        ArgumentNullException.ThrowIfNull(movimento);
        var sangria = movimento.Tipo == TipoMovimentoCaixa.Sangria;
        var p = new ConstrutorEscPos(colunas);
        for (var via = 1; via <= vias; via++)
        {
            Cabecalho(p, c, sangria ? "SANGRIA" : "REFORÇO");
            if (vias > 1)
            {
                p.Centro(via == 1 ? "1ª VIA - CAIXA" : $"{via}ª VIA - {(sangria ? "QUEM RETIRA" : "QUEM ENTREGA")}");
            }

            p.Colunado("Data/hora:", Hora(movimento.OcorridoEm, c.Fuso));
            p.Colunado("Valor:", $"R$ {NumeroBr.Dinheiro(movimento.Valor)}");
            if (movimento.QuemRetiraNome is { } quem)
            {
                p.Linha($"{(sangria ? "Quem retira" : "Quem entrega")}: {quem}");
            }

            if (movimento.Observacao is { } observacao)
            {
                p.Linha($"Obs.: {observacao}");
            }

            if (movimento.InfAdicionais is { } adicionais)
            {
                p.Linha($"Inf. adicionais: {adicionais}");
            }

            Assinatura(p, "Operador");
            Assinatura(p, sangria ? "Quem retira" : "Quem entrega");
            p.Cortar();
        }

        return p.ParaBytes();
    }

    /// <summary>Linha do resumo diário no fechamento cego (O3): os valores ficam só no ERP.</summary>
    public const string MensagemValoresOcultos = "Fechamento cego: valores de vendas, sangrias e reforços só no ERP (gerente).";

    /// <summary>
    /// Resumo diário / leitura do caixa (PDV 21.6; C10b): vendas por forma, cancelamentos, descontos, sangrias e reforços
    /// do período, só deste terminal. Com os valores ocultos (fechamento cego da O3), só as quantidades de vendas, formas,
    /// sangrias e reforços, e a linha avisa.
    /// </summary>
    public static byte[] ResumoDiario(CabecalhoCaixa c, ResumoDiario r, int colunas = 48)
    {
        ArgumentNullException.ThrowIfNull(c);
        ArgumentNullException.ThrowIfNull(r);
        var p = Cabecalho(new ConstrutorEscPos(colunas), c, "RESUMO DIÁRIO");
        p.Linha(r.Periodo.Descricao);
        if (r.ValoresOcultos)
        {
            // O3 do dono: os valores de vendas, sangrias e reforços compõem o esperado do fechamento cego.
            p.Linha(MensagemValoresOcultos);
        }

        p.Separador();
        p.Colunado("Vendas:", r.ValoresOcultos ? r.QtdVendas.ToString(NumeroBr.Cultura) : $"{r.QtdVendas}  R$ {NumeroBr.Dinheiro(r.TotalVendas)}");
        if (!r.ValoresOcultos)
        {
            p.Colunado("Ticket médio:", NumeroBr.Dinheiro(r.TicketMedio));
        }

        p.Linha("Por forma de pagamento");
        if (r.Formas.Count == 0)
        {
            p.Linha("  (nenhuma venda no período)");
        }

        foreach (var forma in r.Formas)
        {
            if (r.ValoresOcultos)
            {
                p.Linha($"  {forma.Descricao} ({forma.Quantidade})");
            }
            else
            {
                p.Colunado($"  {forma.Descricao} ({forma.Quantidade})", NumeroBr.Dinheiro(forma.Valor));
            }
        }

        p.Separador();
        p.Colunado("Vendas canceladas:", $"{r.QtdCanceladas}  R$ {NumeroBr.Dinheiro(r.TotalCanceladas)}");
        p.Colunado("Itens cancelados:", $"{r.QtdItensCancelados}  R$ {NumeroBr.Dinheiro(r.TotalItensCancelados)}");
        p.Colunado("Descontos:", $"R$ {NumeroBr.Dinheiro(r.TotalDescontos)}");
        p.Colunado("Sangrias:", r.ValoresOcultos ? r.QtdSangrias.ToString(NumeroBr.Cultura) : $"{r.QtdSangrias}  R$ {NumeroBr.Dinheiro(r.TotalSangrias)}");
        p.Colunado("Reforços:", r.ValoresOcultos ? r.QtdReforcos.ToString(NumeroBr.Cultura) : $"{r.QtdReforcos}  R$ {NumeroBr.Dinheiro(r.TotalReforcos)}");
        if (r.QtdMovimentosCancelados > 0)
        {
            p.Colunado("Sangrias/reforços cancelados:", r.QtdMovimentosCancelados.ToString(NumeroBr.Cultura));
        }

        return p.Cortar().ParaBytes();
    }

    /// <summary>
    /// Cobrança PIX impressa (PDV 16.7; I4): valor, o QR do BR Code estático e o "copia e cola". Não é comprovante: o
    /// pagamento só vale depois de conferido no app do banco da loja.
    /// </summary>
    public static byte[] CobrancaPix(string nomeLoja, string numeroVenda, decimal valor, string payload, string? chave, int colunas = 48)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(payload);
        var p = new ConstrutorEscPos(colunas);
        p.Centro(nomeLoja.ToUpperInvariant(), negrito: true);
        p.Centro("PAGAMENTO PIX", negrito: true);
        p.Colunado($"Venda: {numeroVenda}", $"R$ {NumeroBr.Dinheiro(valor)}");
        p.Separador();
        p.QrCode(payload);
        if (chave is not null)
        {
            p.Centro($"Chave: {chave}");
        }

        // O "copia e cola" em pedaços da largura exata (sem quebrar na palavra: nenhum caractere se perde).
        p.Linha("Copia e cola:");
        for (var i = 0; i < payload.Length; i += colunas)
        {
            p.Linha(payload.Substring(i, Math.Min(colunas, payload.Length - i)));
        }

        p.Separador();
        p.Centro("NÃO É COMPROVANTE DE PAGAMENTO");
        return p.Cortar().ParaBytes();
    }

    private static ConstrutorEscPos Cabecalho(ConstrutorEscPos p, CabecalhoCaixa c, string titulo)
    {
        p.Centro(c.NomeLoja.ToUpperInvariant(), negrito: true);
        p.Centro(titulo, negrito: true);
        p.Linha($"Caixa: {c.NumeroCaixa:00}  Operador: {c.Operador.ToUpperInvariant()}");
        p.Separador();
        return p;
    }

    private static void Assinatura(ConstrutorEscPos p, string quem)
    {
        p.Avancar(2);
        p.Centro(new string('_', Math.Min(36, p.Colunas)));
        p.Centro(quem);
    }

    private static string Hora(DateTimeOffset instante, TimeZoneInfo fuso) =>
        TimeZoneInfo.ConvertTime(instante, fuso).ToString("dd/MM/yyyy HH:mm", NumeroBr.Cultura);
}
