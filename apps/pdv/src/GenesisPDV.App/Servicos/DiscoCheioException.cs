using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Comum;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// Abrir caixa novo com o disco quase cheio (Central do PDV, bloco G4; plano 4.1; spec 32.2 revista): abaixo de
/// <see cref="OpcoesSaude.DiscoBloqueioBytes"/> livres o caixa não abre sessão nova — gravar com o disco cheio pode
/// corromper o banco —, mas a venda em curso nunca é bloqueada. O supervisor libera a abertura por
/// <see cref="OpcoesSaude.LiberacaoDisco"/> (<see cref="ServicoCaixa.LiberarDiscoAsync"/>, auditado <c>liberacao</c>).
/// </summary>
public sealed class DiscoCheioException(long livreBytes)
    : RegraNegocioException(
        $"Disco quase cheio ({MedidorDisco.Legivel(livreBytes)} livres): o caixa não abre sessão nova. Apague arquivos que não são do " +
        "caixa ou chame o suporte; o supervisor pode liberar a abertura por 1 h.")
{
    public long LivreBytes { get; } = livreBytes;
}
