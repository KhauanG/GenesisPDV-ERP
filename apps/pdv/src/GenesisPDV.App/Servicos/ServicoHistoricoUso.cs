using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Repositorios;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// O período do Histórico de uso, pelo dia operacional da loja (o fuso e a hora de corte, como as abas 1 e 2). No máximo
/// os últimos 30 dias, como as vendas e os caixas da Central (decisão do dono de 04/11/2026 no lugar dos 90 dias da PC-11):
/// o banco guarda o resto, a tela não mostra.
/// </summary>
public enum PeriodoHistoricoUso
{
    Hoje,
    Ontem,
    Ultimos7Dias,
    Ultimos30Dias,
}

/// <summary>
/// Um registro como a aba 6 mostra: a frase ("MARIA cancelou um item · liberado por CARLOS"), o grupo, a descrição e o
/// motivo já mascarados, a marca de envio e os campos exibíveis do antes/depois. <see cref="PorLiberacao"/>: com o filtro
/// "Quem" numa pessoa, a linha entrou porque ela <b>liberou</b> com o PIN a ação de outra (decisão 78), não porque fez.
/// </summary>
public sealed record RegistroHistoricoUso(
    Guid Id,
    DateTimeOffset OcorridoEm,
    string Acao,
    DescricaoAcao Descricao,
    string? Quem,
    string? LiberadoPor,
    string Frase,
    string? Detalhe,
    string? Motivo,
    SituacaoEnvio Envio,
    string? Localizacao,
    Guid? SessaoCaixaId,
    IReadOnlyList<CampoAuditoria> Campos,
    int CamposOcultos,
    bool PorLiberacao = false);

/// <summary>Uma página da aba 6; <see cref="Parcial"/>: a busca parou em <see cref="ServicoHistoricoUso.LimiteBusca"/> registros lidos.</summary>
public sealed record PaginaHistoricoUso(IReadOnlyList<RegistroHistoricoUso> Registros, CursorAuditoria? Proxima, bool Parcial = false);

/// <summary>Uma pessoa no filtro "Quem" (nulo = todos): o que ela fez e o que ela liberou com o PIN (decisão 78).</summary>
public sealed record OpcaoQuem(Guid? Id, string Nome);

/// <summary>
/// O resumo de um operador no período (F6 da aba 6; plano 4.4): logins, a primeira e a última atividade, as vendas pagas,
/// os itens e as vendas cancelados, os descontos (quantas vezes deu, pela auditoria; em quantas vendas pagas e quanto,
/// pelas vendas), as gavetas abertas sem venda e as liberações (as que pediu e as que deu como supervisor).
/// </summary>
public sealed record ResumoOperadorUso(
    Guid UsuarioId,
    string Nome,
    int Logins,
    DateTimeOffset? Primeira,
    DateTimeOffset? Ultima,
    int Vendas,
    int ItensCancelados,
    int VendasCanceladas,
    int CanceladasEmAndamento,
    int Descontos,
    int VendasComDesconto,
    decimal ValorDescontos,
    int GavetasSemVenda,
    int LiberacoesPedidas,
    int LiberacoesDadas);

/// <summary>
/// A aba 6 Histórico de uso da Central do PDV (bloco G10; plano 4.4; README › decisão 74): quem fez o quê neste caixa, em
/// frases, sobre o <see cref="ConsultasAuditoriaLocal"/>. Quem decide é este serviço, pelo <see cref="AcessoCentral"/>:
/// sem <c>pdv.auditoria.ver_local</c> (a própria ou a emprestada pelo Ctrl+L de quem a tem — o Gerente e o Master; o
/// Encarregado não, PC-8), nada. Tudo mascarado pelo <see cref="MascaradorSuporte"/> antes de chegar à tela; o antes e o
/// depois só com os campos exibíveis (<see cref="DescritorAuditoria.CamposExibiveis"/>). Só lê: não grava nem apaga nada
/// (o <c>central_acessada</c> da abertura é da Central). Tudo offline.
/// </summary>
public sealed class ServicoHistoricoUso(ConsultasAuditoriaLocal consultas, AcessoCentral acesso, SessaoTerminal sessao, ServicoCaixa caixa)
{
    public const string MensagemSemPermissao =
        "O histórico de uso pede o gerente ou o dono (pdv.auditoria.ver_local): Ctrl+L Liberar.";

    /// <summary>Quantos registros uma página lê no máximo procurando o texto (o PgDn continua dali).</summary>
    public const int LimiteBusca = 2_000;

    private const string AcaoLiberacao = "liberacao";

    private static readonly string[] AcoesDoResumo = ["login", "item_cancelado", "desconto_item", "desconto_total", "gaveta_aberta"];

    /// <summary>A pessoa na Central vê o histórico de uso (a permissão dela ou a emprestada pela liberação ativa).</summary>
    public bool VeHistorico => acesso.Tem(PermissoesPdv.VerAuditoriaLocal);

    public TimeZoneInfo Fuso => DiaOperacional.ObterFuso(sessao.FusoHorario);

    /// <summary>O intervalo <c>[desde, até)</c> do período, pelo começo do dia operacional (a hora de corte da loja).</summary>
    public (DateTimeOffset Desde, DateTimeOffset? Ate) Intervalo(PeriodoHistoricoUso periodo)
    {
        var (fuso, corte, hoje) = caixa.DiaOperacionalAtual();
        DateTimeOffset Inicio(int diasAtras) => DiaOperacional.Inicio(hoje.AddDays(-diasAtras), fuso, corte);
        return periodo switch
        {
            PeriodoHistoricoUso.Hoje => (Inicio(0), null),
            PeriodoHistoricoUso.Ontem => (Inicio(1), Inicio(0)),
            PeriodoHistoricoUso.Ultimos7Dias => (Inicio(6), null),
            PeriodoHistoricoUso.Ultimos30Dias => (Inicio(29), null),
            _ => throw new ArgumentOutOfRangeException(nameof(periodo), periodo, "Período do histórico de uso desconhecido."),
        };
    }

    /// <summary>
    /// Os registros do filtro, o mais novo primeiro, em frases e mascarados, <see cref="ConsultasAuditoriaLocal.TamanhoPagina"/>
    /// por página. Com texto, a busca não liga para acento nem maiúscula e olha também a frase da ação ("gaveta" acha a
    /// gaveta aberta); o SQL só pré-seleciona e o registro fica se o texto aparece <b>depois da máscara</b> (procurar um
    /// CPF pontuado não "acha" onde ele foi escondido). As linhas descartadas não deixam buraco: lê mais até encher a
    /// página, até <paramref name="limite"/> registros lidos (então a página volta <see cref="PaginaHistoricoUso.Parcial"/>).
    /// Nunca antes dos últimos 30 dias (<see cref="PeriodoHistoricoUso"/>), seja qual for o filtro pedido. Com a pessoa
    /// (<see cref="FiltroAuditoria.UsuarioId"/>), vêm o que ela fez e o que ela liberou para outra; esta última sai com
    /// <see cref="RegistroHistoricoUso.PorLiberacao"/> (decisão 78).
    /// </summary>
    public async Task<PaginaHistoricoUso> RegistrosAsync(
        FiltroAuditoria filtro, CursorAuditoria? depois = null, CancellationToken ct = default, int limite = LimiteBusca)
    {
        ArgumentNullException.ThrowIfNull(filtro);
        Exigir();
        var limite30 = Intervalo(PeriodoHistoricoUso.Ultimos30Dias).Desde;
        if (filtro.Desde is not { } desdePedido || desdePedido < limite30)
        {
            filtro = filtro with { Desde = limite30 };
        }

        var nomes = new Dictionary<Guid, string>();
        var texto = filtro.Texto?.Trim() is { Length: > 0 } t ? t : null;
        if (texto is null)
        {
            var pagina = await consultas.ListarAsync(filtro with { Texto = null }, depois, ct: ct);
            return new PaginaHistoricoUso(await DescreverAsync(pagina.Registros, nomes, ct, filtro.UsuarioId), pagina.Proxima);
        }

        // As ações cuja descrição a tela troca entram sempre (o texto exibido pode não estar no gravado): a conferência é depois.
        var sql = filtro with
        {
            Texto = texto,
            AcoesDoTexto = [.. DescritorAuditoria.AcoesComTexto(texto), .. DescritorAuditoria.AcoesComDescricaoTrocada],
        };
        var achados = new List<RegistroHistoricoUso>();
        var cursor = depois;
        var lidos = 0;
        while (true)
        {
            var lote = await consultas.ListarAsync(sql, cursor, ct: ct);
            var descritos = await DescreverAsync(lote.Registros, nomes, ct, filtro.UsuarioId);
            for (var i = 0; i < descritos.Count; i++)
            {
                if (!Acha(descritos[i], texto))
                {
                    continue;
                }

                achados.Add(descritos[i]);
                if (achados.Count == ConsultasAuditoriaLocal.TamanhoPagina)
                {
                    var haMais = i < descritos.Count - 1 || lote.Proxima is not null;
                    return new PaginaHistoricoUso(achados, haMais ? CursorAte(lote.Registros, i, cursor) : null);
                }
            }

            lidos += lote.Registros.Count;
            if (lote.Proxima is null)
            {
                return new PaginaHistoricoUso(achados, null);
            }

            cursor = lote.Proxima;
            if (lidos >= limite)
            {
                return new PaginaHistoricoUso(achados, cursor, Parcial: true);
            }
        }
    }

    /// <summary>Um registro pelo id (o detalhe), em frase e mascarado; nulo se não existe.</summary>
    public async Task<RegistroHistoricoUso?> RegistroAsync(Guid id, CancellationToken ct = default)
    {
        Exigir();
        return await consultas.ObterAsync(id, ct) is { } r ? (await DescreverAsync([r], [], ct))[0] : null;
    }

    /// <summary>"Todos" e quem fez ou liberou com o PIN alguma coisa no período, pelo nome.</summary>
    public async Task<IReadOnlyList<OpcaoQuem>> QuemAsync(PeriodoHistoricoUso periodo, CancellationToken ct = default)
    {
        Exigir();
        var (desde, ate) = Intervalo(periodo);
        var opcoes = new List<OpcaoQuem>();
        foreach (var id in await consultas.UsuariosAsync(desde, ate, ct))
        {
            opcoes.Add(new OpcaoQuem(id, await caixa.NomeUsuarioAsync(id, ct)));
        }

        return [new OpcaoQuem(null, "Todos"), .. opcoes.OrderBy(o => o.Nome, StringComparer.CurrentCulture)];
    }

    /// <summary>
    /// F6: o resumo por operador no período, pelo nome. Entra quem fez alguma coisa (na auditoria) ou vendeu (nas vendas
    /// pagas deste terminal) no período.
    /// </summary>
    public async Task<IReadOnlyList<ResumoOperadorUso>> ResumoAsync(PeriodoHistoricoUso periodo, CancellationToken ct = default)
    {
        Exigir();
        var (desde, ate) = Intervalo(periodo);
        var terminal = sessao.Identidade?.TerminalId ?? throw new InvalidOperationException("Terminal não ativado.");
        var contagens = await consultas.ContagensAsync(desde, ate, AcoesDoResumo, ct);
        var cancelamentos = (await consultas.CancelamentosDeVendaAsync(desde, ate, ct)).ToDictionary(c => c.UsuarioId);
        var pedidas = await consultas.LiberacoesPedidasAsync(desde, ate, AcaoLiberacao, ct);
        var dadas = await consultas.LiberacoesDadasAsync(desde, ate, AcaoLiberacao, ct);
        var vendas = (await consultas.VendasPorOperadorAsync(terminal, desde, ate, ct)).ToDictionary(v => v.OperadorId);
        var usuarios = (await consultas.UsuariosAsync(desde, ate, ct)).Concat(vendas.Keys).Concat(dadas.Keys).Distinct().ToList();
        var atividade = (await consultas.AtividadeAsync(usuarios, desde, ate, ct)).ToDictionary(a => a.UsuarioId);
        var resumo = new List<ResumoOperadorUso>();
        foreach (var u in usuarios)
        {
            int Conta(params string[] acoes) => contagens.Where(c => c.UsuarioId == u && acoes.Contains(c.Acao, StringComparer.Ordinal)).Sum(c => c.Quantidade);
            var v = vendas.GetValueOrDefault(u);
            var a = atividade.GetValueOrDefault(u);
            var c = cancelamentos.GetValueOrDefault(u);
            resumo.Add(new ResumoOperadorUso(
                u,
                await caixa.NomeUsuarioAsync(u, ct),
                Conta("login"),
                a?.Primeira,
                a?.Ultima,
                v?.Vendas ?? 0,
                Conta("item_cancelado"),
                c?.Pagas ?? 0,
                c?.EmAndamento ?? 0,
                Conta("desconto_item", "desconto_total"),
                v?.VendasComDesconto ?? 0,
                v?.ValorDescontos ?? 0m,
                Conta("gaveta_aberta"),
                pedidas.GetValueOrDefault(u),
                dadas.GetValueOrDefault(u)));
        }

        return [.. resumo.OrderBy(r => r.Nome, StringComparer.CurrentCulture)];
    }

    /// <summary>O cursor que continua logo depois do registro <paramref name="i"/> do lote (a busca que encheu a página no meio dele).</summary>
    private static CursorAuditoria CursorAte(IReadOnlyList<RegistroAuditoriaLocal> lote, int i, CursorAuditoria? anterior)
    {
        var hora = lote[i].OcorridoEm;
        var ids = lote.Take(i + 1).Where(r => r.OcorridoEm == hora).Select(r => r.Id).ToList();
        if (anterior is { } a && a.OcorridoEm == hora)
        {
            ids.AddRange(a.IdsNoInstante);
        }

        return new CursorAuditoria(hora, ids);
    }

    /// <param name="pessoa">A do filtro "Quem": a linha que ela não fez, mas liberou, sai com <see cref="RegistroHistoricoUso.PorLiberacao"/>.</param>
    private async Task<IReadOnlyList<RegistroHistoricoUso>> DescreverAsync(
        IReadOnlyList<RegistroAuditoriaLocal> registros, Dictionary<Guid, string> nomes, CancellationToken ct, Guid? pessoa = null)
    {
        async Task<string?> NomeAsync(Guid? id)
        {
            if (id is not { } i)
            {
                return null;
            }

            if (!nomes.TryGetValue(i, out var nome))
            {
                nome = await caixa.NomeUsuarioAsync(i, ct);
                nomes[i] = nome;
            }

            return nome;
        }

        var lista = new List<RegistroHistoricoUso>(registros.Count);
        foreach (var r in registros)
        {
            var quem = await NomeAsync(r.UsuarioId);
            var liberadoPor = r.AutorizadoPorId is { } aut && aut != r.UsuarioId ? await NomeAsync(aut) : null;
            var (campos, ocultos) = DescritorAuditoria.Campos(r.Antes, r.Depois);
            var descricao = DescritorAuditoria.Descrever(r);
            lista.Add(new RegistroHistoricoUso(
                r.Id,
                r.OcorridoEm,
                r.Acao,
                descricao,
                quem,
                liberadoPor,
                DescritorAuditoria.Frase(descricao, quem, liberadoPor),
                MascaradorSuporte.Mascarar(DescritorAuditoria.DescricaoExibivel(r.Acao, r.Descricao)),
                MascaradorSuporte.Mascarar(r.Motivo),
                DescritorAuditoria.Envio(r.Acao, r.EventoId, r.StatusEvento, r.ResultadoEvento),
                r.Localizacao,
                r.SessaoCaixaId,
                campos,
                ocultos,
                PorLiberacao: pessoa is { } p && r.UsuarioId != p && r.AutorizadoPorId == p));
        }

        return lista;
    }

    /// <summary>
    /// O texto no que a tela mostra, já mascarado: o verbo e o nome curto da ação, a descrição e o motivo. Os nomes da frase
    /// (quem fez, quem liberou) não: o SQL não os pré-seleciona (a busca acharia às vezes), e a pessoa é o filtro F7.
    /// </summary>
    private static bool Acha(RegistroHistoricoUso r, string termo) =>
        BuscaSemAcento.Contem(r.Descricao.Verbo, termo)
        || BuscaSemAcento.Contem(r.Descricao.Titulo, termo)
        || BuscaSemAcento.Contem(r.Detalhe, termo)
        || BuscaSemAcento.Contem(r.Motivo, termo);

    private void Exigir()
    {
        if (!VeHistorico)
        {
            throw new RegraNegocioException(MensagemSemPermissao);
        }
    }
}
