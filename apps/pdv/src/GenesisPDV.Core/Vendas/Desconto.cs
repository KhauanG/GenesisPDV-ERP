using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;

namespace GenesisPDV.Core.Vendas;

/// <summary>Desconto (ou acréscimo) informado pelo operador, em R$ ou em % (PDV 12.2).</summary>
public sealed record Desconto(TipoDesconto Tipo, decimal Valor)
{
    public static Desconto EmReais(decimal valor) => new(TipoDesconto.Valor, valor);

    public static Desconto EmPercentual(decimal percentual) => new(TipoDesconto.Percentual, percentual);

    /// <summary>Valor em R$ sobre a base: o % vira valor com arred2(base × pct ÷ 100) no momento da aplicação.</summary>
    public decimal ValorSobre(decimal baseCalculo) =>
        Tipo == TipoDesconto.Percentual ? Arredondamento.ValorDoPercentual(baseCalculo, Valor) : Valor;

    /// <summary>
    /// Lê "10%", "10 %", "2,50" ou "R$ 2,50". Com <paramref name="tipo"/> (os botões "Aplicar R$" e "Aplicar %" da janela do
    /// item e do F6, para o caixa só com teclado numérico, que não tem a tecla %; decisão 65), o número vale nesse tipo:
    /// "10" com <see cref="TipoDesconto.Percentual"/> é 10%; o "%" digitado com o botão do R$ é recusado (não adivinha).
    /// </summary>
    public static Desconto Ler(string texto, TipoDesconto? tipo = null)
    {
        var t = (texto ?? string.Empty).Trim();
        var digitouPercentual = t.EndsWith('%');
        if (digitouPercentual)
        {
            t = t[..^1].Trim();
        }

        if (digitouPercentual && tipo == TipoDesconto.Valor)
        {
            throw new RegraNegocioException("Desconto em R$: digite só o valor (2,50) ou use o botão do %.");
        }

        var percentual = tipo is { } forcado ? forcado == TipoDesconto.Percentual : digitouPercentual;
        if (!NumeroBr.TentarLer(t, out var valor) || valor <= 0m)
        {
            throw new RegraNegocioException("Informe um valor de desconto válido, por exemplo 10% ou 2,50.");
        }

        if (percentual)
        {
            if (valor >= 100m || !Arredondamento.CabeEm(valor, Arredondamento.CasasPercentual))
            {
                throw new RegraNegocioException("Percentual de desconto deve ser menor que 100% e ter até 4 casas.");
            }

            return EmPercentual(valor);
        }

        if (!Arredondamento.CabeEm(valor, Arredondamento.CasasDinheiro))
        {
            throw new RegraNegocioException("Valor de desconto deve ter no máximo 2 casas decimais.");
        }

        return EmReais(valor);
    }
}

/// <summary>
/// Supervisor que liberou uma ação acima do limite do operador (PDV 12.3, 31.3), no instante em que digitou o PIN
/// (<c>ConcedidaEm</c>, que vira o <c>ocorrido_em</c> da linha de <c>liberacoes</c> do payload).
/// </summary>
public sealed record Liberacao(Guid SupervisorId, decimal LimiteDescontoPct, string Motivo, DateTimeOffset ConcedidaEm, bool SupervisorMaster = false)
{
    public decimal LimiteEfetivoPct => LimiteDesconto.DoUsuario(LimiteDescontoPct, SupervisorMaster);
}

/// <summary>
/// Liberação usada na venda: uma linha de <c>liberacoes</c> do payload (sincronizacao.md 9.7), com a ação
/// (<see cref="AcaoLiberacao"/>), o item (nulo = a venda toda), o % pedido, o supervisor, o motivo e o instante. O
/// <c>Id</c> é só local (<c>liberacoes_venda</c>, para a venda em andamento voltar com ela depois de uma queda).
/// </summary>
public sealed record LiberacaoVenda(
    Guid Id,
    string Acao,
    Guid? ItemVendaId,
    decimal? ValorPct,
    Guid AutorizadoPorId,
    string Motivo,
    DateTimeOffset OcorridoEm);

public enum SituacaoDesconto
{
    Aplicado,
    ExigeLiberacao,
    LiberacaoInsuficiente,
}

/// <summary>
/// Resultado da avaliação do limite (PDV 12.3). <c>PorLiberacao</c> só é verdadeiro quando o desconto passou pelo limite
/// do supervisor: dentro do limite do próprio operador a <see cref="Liberacao"/> informada é ignorada (não vira linha de
/// <c>liberacoes</c>, não preenche <c>autorizado_por_id</c> nem conta no <c>qtd_liberacoes</c>).
/// </summary>
public sealed record ResultadoDesconto(SituacaoDesconto Situacao, decimal PercentualPedido, decimal Valor, bool PorLiberacao = false)
{
    public bool Aplicado => Situacao == SituacaoDesconto.Aplicado;
}
