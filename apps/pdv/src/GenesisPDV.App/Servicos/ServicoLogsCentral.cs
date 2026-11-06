using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Repositorios;

namespace GenesisPDV.App.Servicos;

/// <summary>O período da lista de ocorrências (pelo dia do calendário da loja; "Últimas 24 h" é o do Painel de saúde).</summary>
public enum PeriodoOcorrencias
{
    Ultimas24Horas,
    Hoje,
    Ontem,
    Ultimos7Dias,
    Ultimos30Dias,
    Tudo,
}

/// <summary>Uma ocorrência como a aba 5 mostra: o texto já mascarado, com a dica do catálogo.</summary>
public sealed record OcorrenciaCentral(
    long Id, DateTimeOffset OcorridoEm, string Nivel, string Origem, string? Codigo, string Mensagem, string? Detalhes, DicaOcorrencia Dica);

/// <summary>
/// Uma página da aba 5. <see cref="Parcial"/>: a busca pelo texto parou em <see cref="ServicoLogsCentral.LimiteBusca"/>
/// linhas lidas sem encher a página (o PgDn continua de <see cref="Proxima"/>), como o arquivo técnico.
/// </summary>
public sealed record PaginaOcorrenciasCentral(IReadOnlyList<OcorrenciaCentral> Ocorrencias, CursorOcorrencias? Proxima, bool Parcial = false);

/// <summary>
/// A aba 5 Logs e ocorrências da Central do PDV (bloco G8; plano 4 e 5.5; README › decisão 73): as duas fontes — as
/// <b>ocorrências</b> do <c>log_local</c> (<see cref="ConsultasLogLocal"/>, com a dica do <see cref="CatalogoOcorrencias"/>)
/// e o <b>arquivo técnico</b> do Serilog do dia escolhido (<see cref="LeitorLogArquivo"/>, pelo final) —, tudo mascarado
/// pelo <see cref="MascaradorSuporte"/> antes de chegar à tela. Quem decide é este serviço, pelo <see cref="AcessoCentral"/>:
/// sem <c>pdv.diagnostico.ver</c> (a própria ou a emprestada pelo Ctrl+L), nada. Só lê: não apaga nem grava nada (nem na
/// D22). Tudo offline.
/// </summary>
public sealed class ServicoLogsCentral(
    ConsultasLogLocal consultas, LeitorLogArquivo leitor, AcessoCentral acesso, SessaoTerminal sessao, IRelogio relogio)
{
    public const string MensagemSemPermissao =
        "Os logs e as ocorrências pedem quem pode ver o diagnóstico (pdv.diagnostico.ver): Ctrl+L Liberar.";

    /// <summary>A pessoa na Central vê o diagnóstico (a permissão dela ou a emprestada pela liberação ativa).</summary>
    public bool VeDiagnostico => acesso.Tem(PermissoesPdv.VerDiagnostico);

    public TimeZoneInfo Fuso => DiaOperacional.ObterFuso(sessao.FusoHorario);

    /// <summary>Quantas linhas do banco uma página lê no máximo procurando o texto (o PgDn continua dali).</summary>
    public const int LimiteBusca = 2_000;

    /// <summary>
    /// As ocorrências do filtro, a mais nova primeiro, mascaradas, <see cref="ConsultasLogLocal.TamanhoPagina"/> por página.
    /// Com texto, a busca não liga para acento nem maiúscula (como no arquivo técnico) e olha também o título da dica (a
    /// coluna "Resumo"); o SQL só pré-seleciona (<see cref="BuscaSemAcento.PadraoLike"/>) e a linha fica se o texto
    /// aparece <b>depois da máscara</b> (procurar um CPF ou um token não "acha" onde ele foi escondido). As linhas que a
    /// conferência descarta não deixam buraco: o serviço lê mais do banco até encher a página, até
    /// <paramref name="limite"/> linhas lidas (então a página volta <see cref="PaginaOcorrenciasCentral.Parcial"/>). O
    /// cursor é o da última linha olhada, e só vem quando há mais linhas depois dela: nada se pula nem se repete.
    /// </summary>
    public async Task<PaginaOcorrenciasCentral> OcorrenciasAsync(
        FiltroOcorrencias filtro, CursorOcorrencias? depois = null, CancellationToken ct = default, int limite = LimiteBusca)
    {
        ArgumentNullException.ThrowIfNull(filtro);
        Exigir();
        var texto = filtro.Texto?.Trim() is { Length: > 0 } t ? t : null;
        if (texto is null)
        {
            var pagina = await consultas.ListarAsync(filtro with { Texto = null }, depois, ct: ct);
            return new PaginaOcorrenciasCentral([.. pagina.Ocorrencias.Select(Mascarar)], pagina.Proxima);
        }

        var sql = filtro with
        {
            Texto = texto,
            CodigosDoTexto = CatalogoOcorrencias.CodigosComTitulo(texto),
            OrigensDoTexto = CatalogoOcorrencias.OrigensComTitulo(texto),
        };
        var achadas = new List<OcorrenciaCentral>();
        var cursor = depois;
        var lidas = 0;
        while (true)
        {
            var lote = await consultas.ListarAsync(sql, cursor, ct: ct);
            for (var i = 0; i < lote.Ocorrencias.Count; i++)
            {
                var o = lote.Ocorrencias[i];
                var mascarada = Mascarar(o);
                if (!Acha(mascarada, texto))
                {
                    continue;
                }

                achadas.Add(mascarada);
                if (achadas.Count == ConsultasLogLocal.TamanhoPagina)
                {
                    var haMais = i < lote.Ocorrencias.Count - 1 || lote.Proxima is not null;
                    return new PaginaOcorrenciasCentral(achadas, haMais ? new CursorOcorrencias(o.OcorridoEm, o.Id) : null);
                }
            }

            lidas += lote.Ocorrencias.Count;
            if (lote.Proxima is null)
            {
                return new PaginaOcorrenciasCentral(achadas, null);
            }

            cursor = lote.Proxima;
            if (lidas >= limite)
            {
                return new PaginaOcorrenciasCentral(achadas, cursor, Parcial: true);
            }
        }
    }

    /// <summary>Uma ocorrência pelo id (o detalhe), mascarada; nula se não existe mais.</summary>
    public async Task<OcorrenciaCentral?> OcorrenciaAsync(long id, CancellationToken ct = default)
    {
        Exigir();
        return await consultas.ObterAsync(id, ct) is { } o ? Mascarar(o) : null;
    }

    /// <summary>Os dias com arquivo de log (o mais novo primeiro).</summary>
    public IReadOnlyList<DiaLog> DiasDoArquivo()
    {
        Exigir();
        return leitor.Dias();
    }

    /// <summary>Uma página do arquivo técnico do dia (já mascarada pelo leitor).</summary>
    public PaginaLog Arquivo(DiaLog dia, FiltroLogArquivo filtro, CursorLog? depois = null, CancellationToken ct = default)
    {
        Exigir();
        return leitor.Ler(dia, filtro, depois, ct: ct);
    }

    /// <summary>O intervalo <c>[desde, até)</c> do período, pelo dia do calendário da loja.</summary>
    public (DateTimeOffset? Desde, DateTimeOffset? Ate) Intervalo(PeriodoOcorrencias periodo)
    {
        var agora = relogio.Agora;
        var hoje = TimeZoneInfo.ConvertTime(agora, Fuso).Date;
        DateTimeOffset Meia(DateTime dia) => new(dia, Fuso.GetUtcOffset(dia));
        return periodo switch
        {
            PeriodoOcorrencias.Ultimas24Horas => (agora.AddHours(-24), null),
            PeriodoOcorrencias.Hoje => (Meia(hoje), null),
            PeriodoOcorrencias.Ontem => (Meia(hoje.AddDays(-1)), Meia(hoje)),
            PeriodoOcorrencias.Ultimos7Dias => (Meia(hoje.AddDays(-6)), null),
            PeriodoOcorrencias.Ultimos30Dias => (Meia(hoje.AddDays(-29)), null),
            _ => (null, null),
        };
    }

    private static OcorrenciaCentral Mascarar(OcorrenciaLocal o)
    {
        var codigo = o.Codigo;
        return new OcorrenciaCentral(
            o.Id,
            o.OcorridoEm,
            o.Nivel,
            OrigensOcorrencia.Normalizar(o.Origem),
            codigo,
            MascaradorSuporte.Mascarar(o.Mensagem) ?? string.Empty,
            MascaradorSuporte.MascararDetalhes(o.Detalhes),
            CatalogoOcorrencias.Dica(codigo, o.Origem));
    }

    /// <summary>
    /// O texto no que a tela mostra, já mascarado: a mensagem, o título da dica, o detalhe (o JSON, pelos nomes e ids) e
    /// cada texto dele decodificado (o técnico com as quebras de linha e as aspas de verdade).
    /// </summary>
    private static bool Acha(OcorrenciaCentral o, string termo) =>
        BuscaSemAcento.Contem(o.Mensagem, termo)
        || BuscaSemAcento.Contem(o.Dica.Titulo, termo)
        || BuscaSemAcento.Contem(o.Detalhes, termo)
        || MascaradorSuporte.TextosDoJson(o.Detalhes).Any(v => BuscaSemAcento.Contem(v, termo));

    private void Exigir()
    {
        if (!VeDiagnostico)
        {
            throw new RegraNegocioException(MensagemSemPermissao);
        }
    }
}
