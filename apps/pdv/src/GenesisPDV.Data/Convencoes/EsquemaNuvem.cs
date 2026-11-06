namespace GenesisPDV.Data.Convencoes;

public enum PapelTabela
{
    /// <summary>Desce da nuvem por algum fluxo do pull (MD 4.2).</summary>
    Espelho,

    /// <summary>Nasce no PDV e sobe por evento (MD 4.3).</summary>
    Movimento,
}

/// <summary>Como a coluna de um espelho chega pelo <c>/sync/pull</c> (MD 6.2), lido do registro de fluxos da API.</summary>
public enum DescidaColuna
{
    /// <summary>Desce com o valor da coluna.</summary>
    Desce,

    /// <summary>Nunca desce ("Colunas que não descem", MD 6.2): não existe no espelho local.</summary>
    Omitida,

    /// <summary>Desce com outra expressão (projeção condicional ou segredo sempre nulo): pode chegar nula.</summary>
    Projetada,
}

/// <summary>
/// Coluna da nuvem: <paramref name="Escala"/> é o <c>s</c> do <c>numeric(p,s)</c>, usado pelo INTEGER escalado (MD 4.1);
/// <paramref name="Descida"/> só é diferente de <see cref="DescidaColuna.Desce"/> nas tabelas espelho.
/// <paramref name="Gerada"/> marca a coluna <c>generated always as (...) stored</c> da nuvem (ex.:
/// <c>fechamentos_caixa.diferenca</c>): no PDV ela é calculada (<c>HasComputedColumnSql</c>), e o handler da nuvem
/// nunca a inclui no INSERT (o PostgreSQL recusa com 428C9).
/// </summary>
public sealed record ColunaEsquema(string Nome, string TipoNuvem, Type TipoClr, bool Nulo, int? Escala, DescidaColuna Descida = DescidaColuna.Desce, bool Gerada = false);

/// <summary>CHECK como está no PostgreSQL (nem toda expressão vale no SQLite, ex.: <c>~</c>).</summary>
public sealed record CheckEsquema(string Nome, string ExpressaoPostgres);

/// <summary>
/// Tabela da nuvem: <paramref name="Fluxo"/> é o fluxo do pull que a lê (nulo nas de movimento) e
/// <paramref name="Chave"/> as colunas da chave primária (<c>id</c>, ou a chave natural das referências, como
/// <c>ufs.sigla</c>), usadas no <c>on conflict</c> do aplicador do pull.
/// </summary>
public sealed record TabelaEsquema(
    string Nome,
    PapelTabela Papel,
    string? Fluxo,
    IReadOnlyList<string> Chave,
    IReadOnlyList<ColunaEsquema> Colunas,
    IReadOnlyList<CheckEsquema> Checks);

/// <summary>Esquema da nuvem para o PDV; o conteúdo vem do <c>Esquema.g.cs</c> gerado pela API.</summary>
public static partial class EsquemaNuvem
{
    public static TabelaEsquema? Tabela(string nome) => Tabelas.FirstOrDefault(t => t.Nome == nome);
}
