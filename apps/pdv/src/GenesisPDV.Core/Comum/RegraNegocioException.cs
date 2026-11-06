namespace GenesisPDV.Core.Comum;

/// <summary>Violação de regra de negócio. A mensagem é exibida ao operador: diz o que aconteceu e o que fazer.</summary>
public class RegraNegocioException(string mensagem) : Exception(mensagem);
