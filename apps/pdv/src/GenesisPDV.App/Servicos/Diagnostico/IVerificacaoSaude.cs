namespace GenesisPDV.App.Servicos.Diagnostico;

/// <summary>A bolinha de cada item do Painel de saúde (plano 4.1): verde, amarela ou vermelha.</summary>
public enum NivelSaude
{
    /// <summary>Verde: nada a fazer.</summary>
    Ok,

    /// <summary>Amarela: o caixa segue, mas vale olhar (offline, fila parada, backup velho).</summary>
    Aviso,

    /// <summary>Vermelha: algo errado com o que fazer (disco quase cheio, registro recusado, lacuna).</summary>
    Problema,
}

/// <summary>
/// O botão de um item do Painel (decisão 65: tudo também pelo mouse): leva à aba da Central (<see cref="Aba"/>, o código
/// do menu) ou pede o "Sincronizar agora" (<see cref="Sincronizar"/>). As ações de hardware (F5 a F8) continuam só na aba
/// 3, que pede ela mesma a permissão de configurar o terminal (PC-7: o Painel é só leitura). <see cref="Filtro"/>: a aba
/// abre já filtrada (os erros recentes abrem a aba 5 nos erros das últimas 24 h, bloco G8).
/// </summary>
public sealed record AcaoSaude(string Rotulo, string? Aba = null, bool Sincronizar = false, string? Filtro = null)
{
    public static AcaoSaude IrPara(AbaCentral aba, string? filtro = null) => new($"Abrir {aba.Rotulo}", aba.Codigo, Filtro: filtro);

    public static AcaoSaude SincronizarAgora { get; } = new("Ctrl+Alt+S  Sincronizar agora", Sincronizar: true);
}

/// <summary>
/// Um item do Painel de saúde: o que foi verificado (<see cref="Nome"/>), a bolinha, a frase do que está acontecendo, o
/// que fazer (nulo no verde) e o botão. <see cref="Codigo"/> é estável (testes e, no G9, o <c>saude.json</c> do pacote).
/// </summary>
public sealed record ItemSaude(string Codigo, string Nome, NivelSaude Nivel, string Frase, string? OQueFazer = null, AcaoSaude? Acao = null);

/// <summary>Uma rodada do <see cref="VerificadorSaude"/>: os itens na ordem do Painel (o vermelho primeiro) e quando.</summary>
public sealed record ResultadoSaude(IReadOnlyList<ItemSaude> Itens, DateTimeOffset VerificadoEm, bool Completa)
{
    public static ResultadoSaude Vazio { get; } = new([], DateTimeOffset.MinValue, false);

    public int Problemas => Itens.Count(i => i.Nivel == NivelSaude.Problema);

    public int Avisos => Itens.Count(i => i.Nivel == NivelSaude.Aviso);

    public NivelSaude Pior => Itens.Count == 0 ? NivelSaude.Ok : Itens.Max(i => i.Nivel);
}

/// <summary>
/// Uma verificação do Painel de saúde (Central do PDV, bloco G4; plano 4.1). Toda verificação é <b>local</b> (nada vai à
/// internet: o Painel funciona offline), só lê (banco local, memória, disco) e nunca roda o <c>PRAGMA integrity_check</c>
/// (o resultado da abertura fica em <see cref="EstadoBanco"/>). O <see cref="VerificadorSaude"/> as roda em paralelo,
/// fora da thread da tela, com o limite de <see cref="OpcoesSaude.LimitePorVerificacao"/> cada.
/// </summary>
public interface IVerificacaoSaude
{
    /// <summary>Código estável do item (<see cref="ItemSaude.Codigo"/>).</summary>
    string Codigo { get; }

    /// <summary>O nome no Painel ("Disco", "Impressora").</summary>
    string Nome { get; }

    /// <param name="completa">
    /// Falso na rodada do ícone da barra (a cada minuto): a verificação faz só o barato (o disco não soma o tamanho das
    /// pastas); verdadeiro no Painel aberto.
    /// </param>
    Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct);
}
