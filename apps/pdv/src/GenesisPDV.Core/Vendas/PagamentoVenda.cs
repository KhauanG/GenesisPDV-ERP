namespace GenesisPDV.Core.Vendas;

/// <summary>Snapshot da forma de pagamento usada (espelho <c>formas_pagamento</c>).</summary>
/// <param name="Integracao"><c>formas_pagamento.integracao</c>: <c>nenhuma</c>, <c>pos_externo</c>, <c>pix_estatico</c>…</param>
/// <param name="ExigeSupervisor">"Exige supervisor" da forma (C8b) ou senha de liberação: lançar pede a liberação (31.3).</param>
/// <param name="GeraQrPix"><c>formas_pagamento.gera_qrcode_pix</c>: o PIX mostra o QR estático com o valor (16.7).</param>
/// <param name="PermiteParcelar">Crédito na maquininha com parcelas informativas (16.2; PDV-1).</param>
/// <param name="ExigePessoa">Na PDV-1 só bloqueia sem o cliente identificado (F5), 16.2.</param>
/// <param name="RestringeIdadeMinima">
/// <c>formas_pagamento.restringe_idade_minima</c> (VA/VR, MD 3.10.1): paga só até os itens sem idade mínima.
/// </param>
public sealed record FormaPagamentoInfo(
    Guid Id,
    string Descricao,
    string MeioPagamentoFiscal,
    string TipoForma,
    bool PermiteTroco,
    bool LancaQuitada = true,
    bool AbreGaveta = false,
    decimal TaxaPct = 0m,
    bool SempreZeradoNoPdv = false,
    string Integracao = IntegracaoForma.Nenhuma,
    bool ExigeSupervisor = false,
    bool GeraQrPix = false,
    bool PermiteParcelar = false,
    int ParcelasMaximo = 1,
    bool ExigePessoa = false,
    bool RestringeIdadeMinima = false)
{
    /// <summary>
    /// "Dá troco" que vale no caixa (16.4; O23 do dono): só a forma marcada, sem integração e fora de cartão e PIX — a
    /// marca num cartão ou PIX (cadastro antigo) não faz o cartão passar do total.
    /// </summary>
    public bool DaTroco => PermiteTroco && Integracao == IntegracaoForma.Nenhuma && !RegrasFormaPagamento.EhCartao(TipoForma)
                           && TipoForma != "pix";

    /// <summary>Como o caixa lança a forma na Fase 1C (PDV 16.4, 16.5, 16.7).</summary>
    public FluxoPagamento Fluxo => RegrasFormaPagamento.Fluxo(this);
}

/// <summary>Valores de <c>formas_pagamento.integracao</c> (<c>INTEGRACOES_FORMA</c> do shared).</summary>
public static class IntegracaoForma
{
    public const string Nenhuma = "nenhuma";
    public const string Tef = "tef";
    public const string PosExterno = "pos_externo";
    public const string PixDinamico = "pix_dinamico";
    public const string PixEstatico = "pix_estatico";
}

/// <summary>Como o caixa lança a forma (Fase 1C, C11a).</summary>
public enum FluxoPagamento
{
    /// <summary>Lança o valor direto (dinheiro, vale-refeição, "outros" sem integração).</summary>
    Direto,

    /// <summary>Cartão na maquininha (16.5): "Aprovado?", bandeira obrigatória, NSU e autorização opcionais (O9c).</summary>
    Pos,

    /// <summary>PIX estático ou confirmação manual (16.7): nome do pagador e horário do app do banco.</summary>
    PixManual,

    /// <summary>Forma que o caixa da 1C não lança (TEF, crediário, boleto, vale…): não aparece na tela.</summary>
    Indisponivel,
}

/// <summary>Regras das formas de pagamento no caixa da Fase 1C (PDV 16; O9a, O9c e O23 do dono).</summary>
public static class RegrasFormaPagamento
{
    /// <summary>Tipos que a 1C lança: dinheiro, cartões na maquininha, PIX manual/estático, VA/VR e "outros" (O9a).</summary>
    public static readonly IReadOnlySet<string> TiposDaFase =
        new HashSet<string>(StringComparer.Ordinal) { "dinheiro", "cartao_credito", "cartao_debito", "pix", "vale_alimentacao", "vale_refeicao", "outros" };

    public const int NsuMaximo = 12;
    public const int AutorizacaoMaxima = 6;
    public const int PagadorNomeMaximo = 60;

    /// <summary>Folga do horário que o operador lê no app do banco em relação ao relógio do caixa.</summary>
    public static readonly TimeSpan FolgaHorarioPix = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Até onde o horário à frente vira o da véspera: só perto da meia-noite (o PIX das 23:58 confirmado às 00:03; a
    /// véspera fica no máximo 2 h antes do relógio). Fora disso o horário à frente é erro de digitação ou comprovante de
    /// outro dia, e é recusado (16.7).
    /// </summary>
    public static readonly TimeSpan JanelaVesperaPix = TimeSpan.FromHours(2);

    /// <summary>Quanto antes do início da venda o PIX ainda é aceito (o cliente que paga na chave enquanto a venda é montada).</summary>
    public static readonly TimeSpan FolgaAntesDaVendaPix = TimeSpan.FromMinutes(30);

    public static bool EhCartao(string tipoForma) => tipoForma is "cartao_credito" or "cartao_debito";

    public static FluxoPagamento Fluxo(FormaPagamentoInfo forma)
    {
        ArgumentNullException.ThrowIfNull(forma);
        if (!TiposDaFase.Contains(forma.TipoForma) || forma.Integracao == IntegracaoForma.Tef)
        {
            return FluxoPagamento.Indisponivel;
        }

        // O PIX dinâmico (PSP) é da Fase 6: na 1C a forma vira confirmação manual, o fallback da 16.7.
        if (forma.TipoForma == "pix" || forma.Integracao is IntegracaoForma.PixEstatico or IntegracaoForma.PixDinamico)
        {
            return FluxoPagamento.PixManual;
        }

        // Cartão sem integração é cartão na maquininha (16.5: "forma sem Tipo de Pin Pad").
        return forma.Integracao == IntegracaoForma.PosExterno || EhCartao(forma.TipoForma) ? FluxoPagamento.Pos : FluxoPagamento.Direto;
    }

    /// <summary>Bandeiras do grupo <c>card</c> (<c>tBand</c> da NFC-e) oferecidas na maquininha.</summary>
    public static IReadOnlyList<(string Codigo, string Nome)> Bandeiras { get; } =
    [
        ("01", "Visa"), ("02", "Mastercard"), ("03", "American Express"), ("04", "Sorocred"), ("05", "Diners Club"),
        ("06", "Elo"), ("07", "Hipercard"), ("08", "Aura"), ("09", "Cabal"), ("10", "Alelo"), ("23", "Sodexo"),
        ("26", "VR"), ("27", "Ticket"), ("99", "Outros"),
    ];

    /// <summary>
    /// Dados do POS (16.5; O9c do dono): bandeira obrigatória, NSU (até 12 dígitos) e autorização (até 6 letras ou
    /// dígitos) opcionais, parcelas só no crédito com "Permite parcelar" (informativas).
    /// </summary>
    public static DetalhePagamento ValidarPos(FormaPagamentoInfo forma, string? bandeira, string? nsu, string? autorizacao, int parcelas)
    {
        ArgumentNullException.ThrowIfNull(forma);
        var escolhida = Bandeiras.FirstOrDefault(b => b.Codigo == (bandeira ?? string.Empty).Trim());
        if (escolhida.Codigo is null)
        {
            throw new Comum.RegraNegocioException("Escolha a bandeira do cartão (o número da lista).");
        }

        var n = Vazio(nsu);
        if (n is not null && (n.Length > NsuMaximo || !n.All(char.IsAsciiDigit)))
        {
            throw new Comum.RegraNegocioException($"NSU/CV: só dígitos, até {NsuMaximo}.");
        }

        var a = Vazio(autorizacao)?.ToUpperInvariant();
        if (a is not null && (a.Length > AutorizacaoMaxima || !a.All(char.IsAsciiLetterOrDigit)))
        {
            throw new Comum.RegraNegocioException($"Código de autorização: letras ou dígitos, até {AutorizacaoMaxima}.");
        }

        var maximo = forma.TipoForma == "cartao_credito" && forma.PermiteParcelar ? Math.Max(1, forma.ParcelasMaximo) : 1;
        if (parcelas < 1 || parcelas > maximo)
        {
            throw new Comum.RegraNegocioException(maximo == 1 ? "Esta forma não parcela: informe 1." : $"Parcelas: de 1 a {maximo}.");
        }

        return new DetalhePagamento(TipoIntegracao: 2, Bandeira: escolhida.Codigo, BandeiraNome: escolhida.Nome, Nsu: n, Autorizacao: a,
            Parcelas: parcelas);
    }

    /// <summary>
    /// Confirmação do PIX manual (16.7): nome de quem pagou (1 a 60) e o horário que aparece no app do banco da loja,
    /// que não pode estar à frente do relógio do caixa (folga de 5 min) nem antes do início da venda
    /// (<paramref name="iniciadaEm"/>, com a folga de <see cref="FolgaAntesDaVendaPix"/>): o <c>paga_em</c> errado vai para
    /// <c>cobrancas_pix</c> e a conciliação com o extrato não casa.
    /// </summary>
    public static (string Nome, DateTimeOffset PagaEm) ValidarPix(
        string? pagadorNome, DateTimeOffset? pagaEm, DateTimeOffset agora, DateTimeOffset? iniciadaEm = null)
    {
        var nome = Vazio(pagadorNome);
        if (nome is null || nome.Length > PagadorNomeMaximo)
        {
            throw new Comum.RegraNegocioException($"Informe o nome de quem pagou, como aparece no app do banco (até {PagadorNomeMaximo}).");
        }

        if (pagaEm is not { } quando)
        {
            throw new Comum.RegraNegocioException("Informe o horário do PIX que aparece no app do banco (HH:MM).");
        }

        if (quando > agora + FolgaHorarioPix)
        {
            throw new Comum.RegraNegocioException("O horário do PIX está à frente do relógio do caixa: confira no app do banco.");
        }

        if (iniciadaEm is { } inicio && quando < inicio - FolgaAntesDaVendaPix)
        {
            throw new Comum.RegraNegocioException("O horário do PIX é anterior ao início desta venda: confira no app do banco (PIX de outro dia?).");
        }

        return (nome, quando);
    }

    /// <summary>
    /// Horário do PIX que o operador lê no app do banco (<c>HH:MM</c> ou <c>HHMM</c>), no dia do caixa e no fuso da loja.
    /// À frente do relógio, é do dia anterior só perto da virada (o PIX das 23:58 confirmado às 00:03, dentro de
    /// <see cref="JanelaVesperaPix"/>); os demais à frente ficam no dia do caixa, para o <see cref="ValidarPix"/> recusar.
    /// Fora do formato, nulo.
    /// </summary>
    public static DateTimeOffset? HorarioDoBanco(string? texto, DateTimeOffset agora, TimeZoneInfo fuso)
    {
        ArgumentNullException.ThrowIfNull(fuso);
        var t = (texto ?? string.Empty).Trim().Replace(":", string.Empty, StringComparison.Ordinal).Replace("h", string.Empty, StringComparison.OrdinalIgnoreCase);
        if (t.Length is < 3 or > 4 || !t.All(char.IsAsciiDigit))
        {
            return null;
        }

        var hora = int.Parse(t[..^2], System.Globalization.CultureInfo.InvariantCulture);
        var minuto = int.Parse(t[^2..], System.Globalization.CultureInfo.InvariantCulture);
        if (hora > 23 || minuto > 59)
        {
            return null;
        }

        var local = TimeZoneInfo.ConvertTime(agora, fuso);
        var dia = local.Date.AddHours(hora).AddMinutes(minuto);
        var candidato = new DateTimeOffset(dia, fuso.GetUtcOffset(dia));
        if (candidato <= agora + FolgaHorarioPix)
        {
            return candidato;
        }

        var vespera = candidato.AddDays(-1);
        return vespera >= agora - JanelaVesperaPix ? vespera : candidato;
    }

    private static string? Vazio(string? texto) => string.IsNullOrWhiteSpace(texto) ? null : texto.Trim();
}

/// <summary>
/// Dados do pagamento além do valor (colunas do grupo <c>card</c>/<c>detPag</c> e da liberação, MD 3.11.4): o POS da
/// 16.5, a cobrança do PIX e o supervisor que liberou a forma.
/// </summary>
/// <param name="TipoIntegracao"><c>tpIntegra</c>: 2 = POS não integrado.</param>
public sealed record DetalhePagamento(
    short? TipoIntegracao = null,
    string? Bandeira = null,
    string? BandeiraNome = null,
    string? Nsu = null,
    string? Autorizacao = null,
    int Parcelas = 1,
    Guid? PixCobrancaId = null,
    Guid? AutorizadoPorId = null)
{
    public static DetalhePagamento Vazio { get; } = new();
}

/// <summary>PIX confirmado manualmente (16.7): o QR estático (ou só a chave) e o que o operador conferiu no banco.</summary>
/// <param name="QrcodePayload">BR Code mostrado (vazio na confirmação manual sem QR: loja sem chave PIX).</param>
public sealed record ConfirmacaoPix(string PagadorNome, DateTimeOffset PagaEm, string QrcodePayload, string Txid);

/// <summary>Linha de <c>cobrancas_pix</c> (MD 3.11.6) da venda: no PDV-1 só a estática/manual, já paga.</summary>
public sealed class CobrancaPixVenda(
    Guid id,
    string txid,
    decimal valor,
    string qrcodePayload,
    DateTimeOffset? pagaEm,
    string? pagadorNome,
    Guid? pagamentoVendaId,
    string status = StatusCobrancaPix.Paga,
    string tipo = "estatico")
{
    public Guid Id { get; } = id;
    public string Txid { get; } = txid;
    public string Tipo { get; } = tipo;
    public decimal Valor { get; } = valor;
    public string QrcodePayload { get; } = qrcodePayload;
    public DateTimeOffset? PagaEm { get; } = pagaEm;
    public string? PagadorNome { get; } = pagadorNome;
    public Guid? PagamentoVendaId { get; } = pagamentoVendaId;
    public string Status { get; internal set; } = status;
}

/// <summary>Valores de <c>cobrancas_pix.status</c> usados no PDV-1.</summary>
public static class StatusCobrancaPix
{
    public const string Paga = "paga";
    public const string Cancelada = "cancelada";

    /// <summary>PIX devolvido no cancelamento da venda finalizada (13.3, <c>pix_devolucao_manual</c>).</summary>
    public const string Devolvida = "devolvida";
}

/// <summary>Linha de <c>pagamentos_venda</c>.</summary>
public sealed class PagamentoVenda
{
    public PagamentoVenda(
        Guid id,
        int sequencia,
        Guid formaPagamentoId,
        string descricaoForma,
        string meioPagamentoFiscal,
        string tipoForma,
        decimal valor,
        decimal? valorRecebido,
        decimal troco,
        string status,
        bool lancaQuitada,
        decimal taxaPct,
        int parcelas = 1,
        short indicadorPagamento = 0,
        DateOnly? dataPagamento = null,
        DetalhePagamento? detalhe = null,
        bool restringeIdadeMinima = false,
        bool exigePessoa = false)
    {
        Id = id;
        Sequencia = sequencia;
        FormaPagamentoId = formaPagamentoId;
        DescricaoForma = descricaoForma;
        MeioPagamentoFiscal = meioPagamentoFiscal;
        TipoForma = tipoForma;
        Valor = valor;
        ValorRecebido = valorRecebido;
        Troco = troco;
        Status = status;
        LancaQuitada = lancaQuitada;
        TaxaPct = taxaPct;
        Parcelas = parcelas;
        IndicadorPagamento = indicadorPagamento;
        DataPagamento = dataPagamento;
        Detalhe = detalhe ?? DetalhePagamento.Vazio;
        RestringeIdadeMinima = restringeIdadeMinima;
        ExigePessoa = exigePessoa;
    }

    public Guid Id { get; }
    public int Sequencia { get; }
    public Guid FormaPagamentoId { get; }
    public string DescricaoForma { get; }
    public string MeioPagamentoFiscal { get; }
    public string TipoForma { get; }

    /// <summary>Valor aplicado à venda (em dinheiro, já sem o troco): Σ valor = total da venda.</summary>
    public decimal Valor { get; }

    /// <summary>Valor entregue pelo cliente (dinheiro).</summary>
    public decimal? ValorRecebido { get; }

    public decimal Troco { get; }
    public string Status { get; internal set; }
    public bool LancaQuitada { get; }
    public decimal TaxaPct { get; }
    public int Parcelas { get; }
    public short IndicadorPagamento { get; }
    public DateOnly? DataPagamento { get; }

    /// <summary>POS (bandeira, NSU, autorização), a cobrança PIX e o supervisor que liberou a forma.</summary>
    public DetalhePagamento Detalhe { get; }

    /// <summary>
    /// A forma tinha <c>restringe_idade_minima</c> no lançamento (MD 3.10.1): o pagamento conta no máximo das formas
    /// restritas. Não tem coluna própria: a venda relida do banco o recebe do espelho da forma.
    /// </summary>
    public bool RestringeIdadeMinima { get; }

    /// <summary>
    /// A forma tinha "Exige pessoa" no lançamento (16.2): com o pagamento ativo, o cliente da venda não sai nem é trocado.
    /// Como a restrição de idade, a venda relida do banco o recebe do espelho da forma.
    /// </summary>
    public bool ExigePessoa { get; }

    public bool Ativo => Status is StatusPagamento.Aprovado or StatusPagamento.Pendente;
}
