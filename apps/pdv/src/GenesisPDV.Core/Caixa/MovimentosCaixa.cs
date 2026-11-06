using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;

namespace GenesisPDV.Core.Caixa;

/// <summary>Faixa do limite de dinheiro na gaveta (PDV 20.4).</summary>
public enum FaixaGaveta
{
    Normal,

    /// <summary>A partir de 80% do limite: faixa âmbar "sangria recomendada".</summary>
    Alerta,

    /// <summary>No limite ou acima: faixa vermelha e nenhuma venda nova começa (a em andamento termina).</summary>
    Bloqueio,
}

/// <param name="Mensagem">Texto da faixa (nulo na faixa normal).</param>
public sealed record AvaliacaoGaveta(FaixaGaveta Faixa, string? Mensagem)
{
    public static AvaliacaoGaveta Normal { get; } = new(FaixaGaveta.Normal, null);
}

/// <summary>Venda nova recusada pelo limite de gaveta: a tela de venda oferece a liberação do supervisor (20.4).</summary>
public sealed class LimiteGavetaAtingidoException(string mensagem) : RegraNegocioException(mensagem);

/// <summary>
/// Limite de dinheiro na gaveta (PDV 20.4; Fase 1C, bloco C10b): "Valor limite para bloquear PDV e fazer sangria"
/// (<c>pdv.valor_limite_sangria</c>; vazio ou 0 = sem limite, que é a decisão O5 do dono para o piloto). O valor estimado
/// só aparece na faixa quando a regra do fechamento deixa o operador ver o esperado (O3 do dono: ninguém vê no PDV) —
/// senão a faixa contaria ao operador quanto ele deveria contar no fechamento cego.
/// </summary>
public static class LimiteGaveta
{
    public const decimal FracaoAlerta = 0.80m;

    public const string MensagemBloqueioVenda =
        "Limite de dinheiro na gaveta atingido: faça a sangria (F11 › 1) ou peça a liberação do supervisor para uma venda.";

    public static AvaliacaoGaveta Avaliar(decimal dinheiroGaveta, decimal? limite, bool mostraValor)
    {
        if (limite is not { } l || l <= 0m)
        {
            return AvaliacaoGaveta.Normal;
        }

        var valor = mostraValor ? $": R$ {NumeroBr.Dinheiro(dinheiroGaveta)}" : string.Empty;
        if (dinheiroGaveta >= l)
        {
            return new AvaliacaoGaveta(FaixaGaveta.Bloqueio,
                $"LIMITE DE DINHEIRO ATINGIDO{valor} — FAÇA SANGRIA (F11 › 1). Nenhuma venda nova começa até a sangria.");
        }

        return dinheiroGaveta >= l * FracaoAlerta
            ? new AvaliacaoGaveta(FaixaGaveta.Alerta,
                mostraValor ? $"Dinheiro na gaveta{valor} — sangria recomendada (F11 › 1)." : "Dinheiro na gaveta perto do limite — sangria recomendada (F11 › 1).")
            : AvaliacaoGaveta.Normal;
    }
}

/// <summary>
/// Campos da sangria, do reforço e do cancelamento de movimento (PDV 20.1–20.3; Fase 1C, bloco C10b), com os limites do
/// contrato (<c>movimentoCaixaBase</c> do shared: quem retira até 60, observação e inf. adicionais até 255, motivo do
/// cancelamento de 1 a 255). Puras: o App lê as chaves e grava pelo <c>RepositorioCaixa</c>.
/// </summary>
public static class RegrasMovimentoCaixa
{
    public const decimal ValorMaximo = 99_999.99m;
    public const int QuemRetiraMaximo = 60;
    public const int TextoMaximo = 255;

    public const string MensagemValorInvalido = "Informe o valor: de 0,01 a 99.999,99.";
    public const string MensagemQuemRetira = "Informe quem retira: o usuário (F2) ou o nome, até 60 caracteres.";
    public const string MensagemMotivo = "Informe o motivo do cancelamento (até 255 caracteres).";

    /// <summary>Valor &gt; 0, em centavos e até R$ 99.999,99 (o <c>ck_movimentos_caixa_valor</c> exige &gt; 0).</summary>
    public static decimal ValidarValor(decimal? valor) =>
        valor is { } v && v > 0m && v <= ValorMaximo && Arredondamento.CabeEm(v, Arredondamento.CasasDinheiro)
            ? v
            : throw new RegraNegocioException(MensagemValorInvalido);

    /// <summary>
    /// Sangria acima do dinheiro estimado (20.1): recusada com <c>pdv.sangria_limitada_ao_saldo</c> (padrão e O5 do dono);
    /// desligada, passa com o aviso devolvido. O valor estimado só entra na mensagem quando o operador pode vê-lo (O3).
    /// </summary>
    public static string? ValidarSangria(decimal valor, decimal dinheiroEstimado, bool limitadaAoSaldo, bool mostraValor)
    {
        if (valor <= dinheiroEstimado)
        {
            return null;
        }

        var estimado = mostraValor ? $" (R$ {NumeroBr.Dinheiro(dinheiroEstimado)})" : string.Empty;
        return limitadaAoSaldo
            ? throw new RegraNegocioException($"Valor acima do dinheiro estimado na gaveta{estimado}: confira o valor da sangria.")
            : $"Sangria acima do dinheiro estimado na gaveta{estimado}.";
    }

    /// <summary>
    /// Quem retira (sangria, obrigatório) ou quem entrega (reforço, opcional). O nome digitado vai até 60 caracteres; com
    /// o usuário escolhido no F2 (<paramref name="usuarioId"/>), o nome no campo é o do cadastro (até 100 em
    /// <c>usuarios</c>) e é cortado nos 60 do <c>quem_retira_nome</c> em vez de recusar: o id é o que identifica.
    /// </summary>
    public static string? QuemRetira(string? nome, Guid? usuarioId, bool obrigatorio)
    {
        var texto = string.IsNullOrWhiteSpace(nome) ? null : nome.Trim();
        if (usuarioId is not null && texto is not null)
        {
            return NomeDoUsuario(texto);
        }

        if (texto is { Length: > QuemRetiraMaximo } || (obrigatorio && texto is null && usuarioId is null))
        {
            throw new RegraNegocioException(MensagemQuemRetira);
        }

        return texto;
    }

    /// <summary>Nome de usuário do cadastro no <c>quem_retira_nome</c> (até 60; o de <c>usuarios</c> vai até 100).</summary>
    public static string NomeDoUsuario(string nome)
    {
        ArgumentNullException.ThrowIfNull(nome);
        var limpo = nome.Trim();
        return limpo.Length <= QuemRetiraMaximo ? limpo : limpo[..QuemRetiraMaximo].TrimEnd();
    }

    /// <summary>Observação e inf. adicionais: opcionais, até 255 (vazio = nulo).</summary>
    public static string? TextoOpcional(string? texto, string campo)
    {
        if (string.IsNullOrWhiteSpace(texto))
        {
            return null;
        }

        var limpo = texto.Trim();
        return limpo.Length <= TextoMaximo ? limpo : throw new RegraNegocioException($"{campo}: até {TextoMaximo} caracteres.");
    }

    /// <summary>Motivo do cancelamento de sangria ou reforço (20.3): obrigatório, até 255.</summary>
    public static string MotivoCancelamento(string? motivo) =>
        TextoOpcional(motivo, "Motivo") ?? throw new RegraNegocioException(MensagemMotivo);
}
