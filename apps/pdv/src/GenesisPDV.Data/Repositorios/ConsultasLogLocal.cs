using System.Globalization;
using System.Linq.Expressions;
using System.Text;
using GenesisPDV.Data.Entidades;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Repositorios;

/// <summary>
/// Os filtros da lista de ocorrências (aba 5 da Central, bloco G8), todos no SQL: o nível mínimo, o período (pela hora da
/// ocorrência, <c>[Desde, Ate)</c>), a origem padronizada (<see cref="OrigensOcorrencia"/>; o sistema inclui o legado
/// <c>app</c>) e um texto na mensagem ou no detalhe. O texto no SQL é uma <b>pré-seleção</b> sem diferença de acento nem
/// de maiúscula (<see cref="BuscaSemAcento.PadraoLike"/>: pode trazer a mais, nunca a menos); quem mostra confere de novo
/// em memória (<see cref="BuscaSemAcento.Contem"/>), depois da máscara. <paramref name="CodigosDoTexto"/>: as ocorrências
/// desses códigos também entram (o título da dica, que a lista mostra, tem o texto); <paramref name="OrigensDoTexto"/>: as
/// linhas sem código (de antes do G8) dessas origens, cuja dica vem da origem.
/// </summary>
public sealed record FiltroOcorrencias(
    string? NivelMinimo = null,
    DateTimeOffset? Desde = null,
    DateTimeOffset? Ate = null,
    string? Origem = null,
    string? Texto = null,
    IReadOnlyList<string>? CodigosDoTexto = null,
    IReadOnlyList<string>? OrigensDoTexto = null);

/// <summary>
/// A busca da aba 5 (bloco G8) igual nas duas fontes: sem diferença de maiúscula nem de acento ("nao" acha "não",
/// "IMPRESSÃO" acha "impressão"), como o <c>LeitorLogArquivo</c> do arquivo técnico.
/// </summary>
public static class BuscaSemAcento
{
    /// <summary>As letras que levam acento no português (á, ê, õ, ç…): no <c>LIKE</c>, o curinga de uma letra.</summary>
    private const string ComAcento = "aeioucAEIOUC";

    public static bool Contem(string? onde, string termo) =>
        onde is not null && CultureInfo.InvariantCulture.CompareInfo.IndexOf(onde, termo, CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace) >= 0;

    /// <summary>
    /// O padrão do <c>LIKE</c> (escape <c>\</c>) que acha <b>ao menos</b> o que o <see cref="Contem"/> acha: o <c>LIKE</c> do
    /// SQLite só ignora a maiúscula no ASCII e nunca o acento, então a vogal, o c e toda letra fora do ASCII viram
    /// o <c>_</c> (uma letra qualquer: o "ã" e o "a"); a aspa e a barra viram o <c>%</c> (no <c>detalhes</c> elas vêm
    /// escapadas, <c>\"</c>); o <c>%</c> e o <c>_</c> digitados são letras. "nao" vira <c>%n__%</c>.
    /// </summary>
    public static string PadraoLike(string termo)
    {
        ArgumentNullException.ThrowIfNull(termo);
        var padrao = new StringBuilder(termo.Length + 2).Append('%');
        foreach (var c in termo.Normalize(NormalizationForm.FormC))
        {
            if (c is '%' or '_')
            {
                padrao.Append('\\').Append(c);
            }
            else if (c is '\\' or '"' || char.IsControl(c) || CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark)
            {
                padrao.Append('%');
            }
            else
            {
                padrao.Append(c > '\u007f' || ComAcento.Contains(c, StringComparison.Ordinal) ? '_' : c);
            }
        }

        return padrao.Append('%').ToString();
    }
}

/// <summary>O começo da próxima página: a ocorrência mais antiga da página (a hora e o id, o desempate).</summary>
public sealed record CursorOcorrencias(DateTimeOffset OcorridoEm, long Id);

/// <summary>Uma linha do <c>log_local</c> como a aba 5 a lê (sem tracking); o texto ainda sem máscara.</summary>
public sealed record OcorrenciaLocal(long Id, DateTimeOffset OcorridoEm, string Nivel, string Origem, string Mensagem, string? Detalhes)
{
    /// <summary>O código do PDV gravado no detalhe (nulo nas linhas de antes do G8).</summary>
    public string? Codigo => Ocorrencias.CodigoDe(Detalhes);
}

public sealed record PaginaOcorrencias(IReadOnlyList<OcorrenciaLocal> Ocorrencias, CursorOcorrencias? Proxima);

/// <summary>
/// As ocorrências do <c>log_local</c> para a aba 5 Logs e ocorrências da Central do PDV (bloco G8; plano 4 e 5.5): a
/// mais nova primeiro, <see cref="TamanhoPagina"/> por página, pelo cursor (hora, id) — a ocorrência nova que chega entre
/// as páginas entra na primeira e não repete nem pula nenhuma. Entra pelo <c>ix_log_local_ocorrido_em</c> (o id é o
/// rowid, a mesma ordem do índice: nenhuma ordenação à parte; sem índice novo, sem migração). Um <c>DbContext</c> curto por
/// consulta, sem tracking. A máscara (<c>MascaradorSuporte</c>) é da tela.
/// </summary>
public sealed class ConsultasLogLocal(IDbContextFactory<PdvDbContext> fabrica)
{
    public const int TamanhoPagina = 50;

    public async Task<PaginaOcorrencias> ListarAsync(FiltroOcorrencias filtro, CursorOcorrencias? depois = null, int tamanho = TamanhoPagina, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(filtro);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var consulta = db.LogLocal.AsNoTracking().AsQueryable();
        if (filtro.Desde is { } desde)
        {
            consulta = consulta.Where(l => l.OcorridoEm >= desde);
        }

        if (filtro.Ate is { } ate)
        {
            consulta = consulta.Where(l => l.OcorridoEm < ate);
        }

        if (filtro.NivelMinimo is { } minimo && minimo != NiveisOcorrencia.Debug)
        {
            var niveis = NiveisOcorrencia.APartirDe(minimo).ToList();
            consulta = consulta.Where(l => niveis.Contains(l.Nivel));
        }

        if (filtro.Origem is { Length: > 0 } origem)
        {
            var origens = OrigensOcorrencia.NoBanco(origem).ToList();
            consulta = consulta.Where(l => origens.Contains(l.Origem));
        }

        if (filtro.Texto?.Trim() is { Length: > 0 } texto)
        {
            consulta = consulta.Where(Texto(texto, filtro.CodigosDoTexto ?? [], filtro.OrigensDoTexto ?? []));
        }

        if (depois is { } c)
        {
            consulta = consulta.Where(l => l.OcorridoEm < c.OcorridoEm || (l.OcorridoEm == c.OcorridoEm && l.Id < c.Id));
        }

        var linhas = await consulta
            .OrderByDescending(l => l.OcorridoEm)
            .ThenByDescending(l => l.Id)
            .Take(tamanho + 1)
            .Select(l => new OcorrenciaLocal(l.Id, l.OcorridoEm, l.Nivel, l.Origem, l.Mensagem, l.Detalhes))
            .ToListAsync(ct);
        var proxima = linhas.Count > tamanho ? new CursorOcorrencias(linhas[tamanho - 1].OcorridoEm, linhas[tamanho - 1].Id) : null;
        return new PaginaOcorrencias(linhas.Count > tamanho ? linhas.GetRange(0, tamanho) : linhas, proxima);
    }

    /// <summary>Uma ocorrência pelo id (o detalhe; nula se não existe).</summary>
    public async Task<OcorrenciaLocal?> ObterAsync(long id, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.LogLocal.AsNoTracking().Where(l => l.Id == id)
            .Select(l => new OcorrenciaLocal(l.Id, l.OcorridoEm, l.Nivel, l.Origem, l.Mensagem, l.Detalhes))
            .FirstOrDefaultAsync(ct);
    }

    /// <summary>
    /// O texto na mensagem ou no detalhe (<see cref="BuscaSemAcento.PadraoLike"/>), ou um dos códigos (o <c>detalhes</c>
    /// do <c>Ocorrencias.Nova</c> começa pelo código), ou a linha sem código de uma das origens.
    /// </summary>
    private static Expression<Func<LogLocal, bool>> Texto(string texto, IReadOnlyList<string> codigos, IReadOnlyList<string> origens)
    {
        var padrao = BuscaSemAcento.PadraoLike(texto);
        var condicoes = new List<Expression<Func<LogLocal, bool>>>
        {
            l => EF.Functions.Like(l.Mensagem, padrao, "\\") || (l.Detalhes != null && EF.Functions.Like(l.Detalhes, padrao, "\\")),
        };
        foreach (var codigo in codigos.Distinct(StringComparer.Ordinal))
        {
            var doCodigo = "{\"" + Ocorrencias.CampoCodigo + "\":\"" + Escapar(codigo) + "\"%";
            condicoes.Add(l => l.Detalhes != null && EF.Functions.Like(l.Detalhes, doCodigo, "\\"));
        }

        if (origens.Count > 0)
        {
            var noBanco = origens.SelectMany(OrigensOcorrencia.NoBanco).Distinct(StringComparer.Ordinal).ToList();
            var comCodigo = "{\"" + Ocorrencias.CampoCodigo + "\":%";
            condicoes.Add(l => noBanco.Contains(l.Origem) && (l.Detalhes == null || !EF.Functions.Like(l.Detalhes, comCodigo)));
        }

        var linha = Expression.Parameter(typeof(LogLocal), "l");
        var corpo = condicoes.Select(c => new TrocarParametro(c.Parameters[0], linha).Visit(c.Body)).Aggregate(Expression.OrElse);
        return Expression.Lambda<Func<LogLocal, bool>>(corpo, linha);
    }

    /// <summary>O <c>%</c> e o <c>_</c> (o código tem <c>_</c>) são letras, não curingas do <c>LIKE</c>.</summary>
    private static string Escapar(string texto) => texto.Replace("\\", "\\\\", StringComparison.Ordinal)
        .Replace("%", "\\%", StringComparison.Ordinal).Replace("_", "\\_", StringComparison.Ordinal);

    private sealed class TrocarParametro(ParameterExpression de, ParameterExpression para) : ExpressionVisitor
    {
        protected override Expression VisitParameter(ParameterExpression node) => node == de ? para : base.VisitParameter(node);
    }
}
