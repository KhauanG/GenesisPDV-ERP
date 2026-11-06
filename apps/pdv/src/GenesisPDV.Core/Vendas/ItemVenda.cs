using GenesisPDV.Core.Precos;

namespace GenesisPDV.Core.Vendas;

/// <summary>Colunas do combo (kit) em <c>itens_venda</c> (modelo 3.11.3): iguais em todo o grupo, salvo a posição.</summary>
/// <param name="GrupoId"><c>kit_grupo_id</c>: as linhas de um combo vendido compartilham o id.</param>
/// <param name="ComponenteId"><c>kit_componente_id</c>: a posição (<c>produtos_componentes.id</c>) que a linha preenche.</param>
/// <param name="AlternativaId"><c>kit_alternativa_id</c>: alternativa escolhida; nulo = produto padrão.</param>
/// <param name="Acrescimo"><c>kit_acrescimo</c>: acréscimo da alternativa por combo (já somado em <paramref name="PrecoUnitario"/>).</param>
public sealed record DadosKit(
    Guid GrupoId,
    Guid ProdutoId,
    string Descricao,
    decimal Quantidade,
    decimal PrecoUnitario,
    Guid ComponenteId,
    Guid? AlternativaId,
    decimal Acrescimo);

/// <summary>
/// Linha de <c>itens_venda</c>. Só a <see cref="Venda"/> altera o item; o construtor público existe para reconstituir
/// a venda gravada no banco local (recuperação após queda, PDV 32.3).
/// </summary>
public sealed class ItemVenda
{
    public ItemVenda(
        Guid id,
        int sequencia,
        Guid produtoId,
        string? codigoLido,
        Guid? codigoBarrasId,
        string descricao,
        string unidade,
        bool fracionavel,
        decimal quantidade,
        decimal precoTabela,
        decimal precoUnitario,
        string origemPreco,
        decimal valorBruto,
        decimal descontoItem,
        DateTimeOffset incluidoEm,
        decimal descontoRateado = 0m,
        decimal acrescimoRateado = 0m,
        decimal freteRateado = 0m,
        decimal? valorLiquido = null,
        bool cancelado = false,
        DateTimeOffset? canceladoEm = null,
        Guid? canceladoPorId = null,
        Guid? autorizadoPorId = null,
        string? motivoCancelamento = null,
        decimal descontoPromocao = 0m,
        Guid? promocaoId = null,
        string? origemEntrada = null,
        bool pesoDigitado = false,
        Guid? vasilhameItemOrigemId = null,
        Guid? grupoPrecoQuantidadeId = null,
        decimal? quantidadeReferenciaPreco = null,
        DadosKit? kit = null)
    {
        Id = id;
        Sequencia = sequencia;
        ProdutoId = produtoId;
        CodigoLido = codigoLido;
        CodigoBarrasId = codigoBarrasId;
        Descricao = descricao;
        Unidade = unidade;
        Fracionavel = fracionavel;
        Quantidade = quantidade;
        PrecoTabela = precoTabela;
        PrecoUnitario = precoUnitario;
        OrigemPreco = origemPreco;
        GrupoPrecoQuantidadeId = grupoPrecoQuantidadeId;
        QuantidadeReferenciaPreco = quantidadeReferenciaPreco;
        ValorBruto = valorBruto;
        DescontoItem = descontoItem;
        DescontoPromocao = descontoPromocao;
        PromocaoId = promocaoId;
        OrigemEntrada = origemEntrada;
        PesoDigitado = pesoDigitado;
        VasilhameItemOrigemId = vasilhameItemOrigemId;
        Kit = kit;
        DescontoRateado = descontoRateado;
        AcrescimoRateado = acrescimoRateado;
        FreteRateado = freteRateado;
        ValorLiquido = valorLiquido ?? (valorBruto - descontoItem - descontoPromocao - descontoRateado + acrescimoRateado + freteRateado);
        IncluidoEm = incluidoEm;
        Cancelado = cancelado;
        CanceladoEm = canceladoEm;
        CanceladoPorId = canceladoPorId;
        AutorizadoPorId = autorizadoPorId;
        MotivoCancelamento = motivoCancelamento;
    }

    public Guid Id { get; }
    public int Sequencia { get; }
    public Guid ProdutoId { get; }
    public string? CodigoLido { get; }
    public Guid? CodigoBarrasId { get; }
    public string Descricao { get; }
    public string Unidade { get; }

    /// <summary>Não é coluna: derivado da unidade (KG, L, M, M2, M3) para validar quantidade decimal.</summary>
    public bool Fracionavel { get; }

    public decimal Quantidade { get; internal set; }
    public decimal PrecoTabela { get; internal set; }
    public decimal PrecoUnitario { get; internal set; }
    public string OrigemPreco { get; internal set; }

    /// <summary>Grupo de preço por quantidade (mix) cuja soma definiu o preço (PDV 11.3.1).</summary>
    public Guid? GrupoPrecoQuantidadeId { get; internal set; }

    /// <summary>Quantidade (do produto ou do grupo) que definiu o preço de atacado/faixa/mix.</summary>
    public decimal? QuantidadeReferenciaPreco { get; internal set; }

    public decimal ValorBruto { get; internal set; }
    public decimal DescontoItem { get; internal set; }

    /// <summary>Desconto de promoção (PDV 11.4): vai em <c>vDesc</c> e não consome o limite do operador.</summary>
    public decimal DescontoPromocao { get; internal set; }

    public Guid? PromocaoId { get; internal set; }

    /// <summary><c>leitor</c>, <c>teclado</c>, <c>balanca</c>, <c>etiqueta</c>, <c>busca</c> ou <c>cardapio</c> (PDV 6.4, 10.7).</summary>
    public string? OrigemEntrada { get; }

    public bool PesoDigitado { get; }

    /// <summary>Item de casco cobrado: aponta para o item do produto cheio (PDV 10.12).</summary>
    public Guid? VasilhameItemOrigemId { get; }

    /// <summary>Linha de um combo (kit); nulo para item avulso.</summary>
    public DadosKit? Kit { get; }

    public decimal DescontoRateado { get; internal set; }
    public decimal AcrescimoRateado { get; internal set; }
    public decimal FreteRateado { get; internal set; }
    public decimal ValorLiquido { get; internal set; }
    public DateTimeOffset IncluidoEm { get; }
    public bool Cancelado { get; internal set; }
    public DateTimeOffset? CanceladoEm { get; internal set; }
    public Guid? CanceladoPorId { get; internal set; }
    public Guid? AutorizadoPorId { get; internal set; }
    public string? MotivoCancelamento { get; internal set; }

    // ------------------------------------------------ não são colunas (refeitos a partir do espelho local)

    /// <summary>Embalagem lida (fator e preço do fardo); reconhecida pelo <see cref="CodigoBarrasId"/> na recuperação.</summary>
    public EmbalagemPreco? Embalagem { get; internal set; }

    /// <summary>Varejo (loja ?? produto) para "ATACADO 12+ (varejo 3,49)"; nulo se a regra não rodou nesta sessão.</summary>
    public decimal? PrecoVarejo { get; internal set; }

    /// <summary>Limiar da faixa/atacado aplicado ("12" de "ATAC 12+").</summary>
    public decimal? LimiarPreco { get; internal set; }

    /// <summary>Nome do grupo (mix) para "MIX 12+" e o cupom.</summary>
    public string? NomeGrupoPreco { get; internal set; }

    /// <summary>% digitado no desconto do item: reaplicado quando o preço muda (11.3.1). Só em memória (o MD não tem coluna).</summary>
    public decimal? DescontoItemPct { get; internal set; }

    /// <summary>
    /// Teto (%) do desconto em R$ do item: o limite do operador ou o % aceito (liberado), o que for maior. Um recálculo de
    /// preço que leve o mesmo R$ acima disso reduz o desconto (decisão 27). Só em memória; refeito na recuperação.
    /// </summary>
    public decimal? TetoDescontoPct { get; internal set; }

    /// <summary>
    /// Linha recuperada sem o snapshot da primeira inclusão (venda gravada antes de <c>produtos_venda_snapshot</c>): o
    /// preço gravado fica fixo, nunca é recalculado com o espelho atual (PDV 11.3.1).
    /// </summary>
    public bool PrecoFixado { get; internal set; }

    public bool EhKit => Kit is not null;

    public bool EhCasco => VasilhameItemOrigemId is not null;

    /// <summary>Base do rateio do total (PDV 12.4): <c>valor_bruto − desconto_item − desconto_promocao</c>.</summary>
    public decimal BaseRateio => ValorBruto - DescontoItem - DescontoPromocao;

    /// <summary>arred2(quantidade × preço de tabela): base do cálculo do % de desconto (PDV 12.3).</summary>
    public decimal ValorTabela => Numeros.Arredondamento.Arred2(Quantidade * PrecoTabela);

    /// <summary>
    /// <c>reducao_preco_manual</c> (12.3): só preço digitado reduz em relação à tabela. Atacado, mix, embalagem e o
    /// rateio do combo não são desconto (11.3) — no combo e na embalagem o valor autoritativo pode diferir 1 centavo
    /// de <c>arred2(qtd × preço)</c>.
    /// </summary>
    public decimal ReducaoPrecoManual => OrigemPreco == Vendas.OrigemPreco.Manual ? Math.Max(0m, ValorTabela - ValorBruto) : 0m;

    /// <summary>Etiqueta da coluna de preço: "ATAC 12+" (atacado/faixa) ou "MIX 12+" (grupo), PDV 11.3.1.</summary>
    public string? EtiquetaPreco => OrigemPreco switch
    {
        Vendas.OrigemPreco.GrupoMix => LimiarPreco is null ? "MIX" : $"MIX {Limiar()}+",
        Vendas.OrigemPreco.Atacado or Vendas.OrigemPreco.Quantidade => LimiarPreco is null ? "ATAC" : $"ATAC {Limiar()}+",
        _ => null,
    };

    /// <summary>Economia em relação ao varejo nas linhas de atacado/faixa/mix ("Economia atacado").</summary>
    public decimal EconomiaAtacado =>
        !Cancelado && Vendas.OrigemPreco.PorQuantidade(OrigemPreco) && PrecoVarejo is { } varejo
            ? Math.Max(0m, Numeros.Arredondamento.Arred2(Quantidade * varejo) - ValorBruto)
            : 0m;

    /// <summary>Só o limiar do snapshot: a quantidade do cliente (<c>quantidade_referencia_preco</c>) não é o "12+".</summary>
    private string Limiar() => (LimiarPreco ?? 0m).ToString("0.###", Numeros.NumeroBr.Cultura);

    internal EstadoItem Capturar() => new(
        Quantidade, PrecoTabela, PrecoUnitario, OrigemPreco, GrupoPrecoQuantidadeId, QuantidadeReferenciaPreco,
        ValorBruto, DescontoItem, DescontoPromocao, PromocaoId, DescontoRateado, AcrescimoRateado, FreteRateado,
        ValorLiquido, Cancelado, CanceladoEm, CanceladoPorId, AutorizadoPorId, MotivoCancelamento,
        Embalagem, PrecoVarejo, LimiarPreco, NomeGrupoPreco, DescontoItemPct, TetoDescontoPct);

    internal void Restaurar(EstadoItem e)
    {
        Quantidade = e.Quantidade;
        PrecoTabela = e.PrecoTabela;
        PrecoUnitario = e.PrecoUnitario;
        OrigemPreco = e.OrigemPreco;
        GrupoPrecoQuantidadeId = e.GrupoPrecoQuantidadeId;
        QuantidadeReferenciaPreco = e.QuantidadeReferenciaPreco;
        ValorBruto = e.ValorBruto;
        DescontoItem = e.DescontoItem;
        DescontoPromocao = e.DescontoPromocao;
        PromocaoId = e.PromocaoId;
        DescontoRateado = e.DescontoRateado;
        AcrescimoRateado = e.AcrescimoRateado;
        FreteRateado = e.FreteRateado;
        ValorLiquido = e.ValorLiquido;
        Cancelado = e.Cancelado;
        CanceladoEm = e.CanceladoEm;
        CanceladoPorId = e.CanceladoPorId;
        AutorizadoPorId = e.AutorizadoPorId;
        MotivoCancelamento = e.MotivoCancelamento;
        Embalagem = e.Embalagem;
        PrecoVarejo = e.PrecoVarejo;
        LimiarPreco = e.LimiarPreco;
        NomeGrupoPreco = e.NomeGrupoPreco;
        DescontoItemPct = e.DescontoItemPct;
        TetoDescontoPct = e.TetoDescontoPct;
    }

    internal readonly record struct EstadoItem(
        decimal Quantidade,
        decimal PrecoTabela,
        decimal PrecoUnitario,
        string OrigemPreco,
        Guid? GrupoPrecoQuantidadeId,
        decimal? QuantidadeReferenciaPreco,
        decimal ValorBruto,
        decimal DescontoItem,
        decimal DescontoPromocao,
        Guid? PromocaoId,
        decimal DescontoRateado,
        decimal AcrescimoRateado,
        decimal FreteRateado,
        decimal ValorLiquido,
        bool Cancelado,
        DateTimeOffset? CanceladoEm,
        Guid? CanceladoPorId,
        Guid? AutorizadoPorId,
        string? MotivoCancelamento,
        EmbalagemPreco? Embalagem,
        decimal? PrecoVarejo,
        decimal? LimiarPreco,
        string? NomeGrupoPreco,
        decimal? DescontoItemPct,
        decimal? TetoDescontoPct);
}
