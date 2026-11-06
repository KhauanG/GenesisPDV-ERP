using System.Text.Json.Nodes;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Fiscal;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// A aba 2 Caixas da Central do PDV (bloco G6; plano 4.3 e 5.2; decisões do dono de 04/11/2026: PC-9 opção A e os 30
/// dias): o caixa aberto deste terminal e os fechados nos últimos <see cref="ConsultasHistoricoLocal.LimiteDias"/> dias,
/// <b>como foram impressos</b>. Fonte única: o retrato do fechamento (<c>fechamentos_caixa</c>, as formas só com o
/// contado, o resumo guardado) e os bytes do relatório na <c>fila_impressao</c>. Nunca apura a sessão de novo (nem o
/// <c>RepositorioCaixa.ApurarAsync</c>, nem os estornos do outbox): o calculado e a diferença de um caixa fechado só no
/// ERP (O3). Quem decide é este serviço, pelo <see cref="AcessoCentral"/>: sem <c>pdv.caixa.consultar_fechamentos</c> (a
/// própria ou a emprestada pelo Ctrl+L), nada. A 2ª via do fechamento pede <c>pdv.documento.reimprimir</c> (a própria ou
/// o supervisor na hora: a liberação da Central só empresta o ver) e o resumo do dia, <c>pdv.relatorio.resumo_diario</c>.
/// Tudo offline.
/// </summary>
public sealed class ServicoHistoricoCaixas(
    ConsultasHistoricoLocal consultas,
    RepositorioImpressao fila,
    ServicoImpressao impressao,
    RepositorioTerminal terminal,
    SessaoTerminal sessao,
    ServicoCaixa caixa,
    ServicoHistoricoVendas vendas,
    AcessoCentral acesso,
    IRelogio relogio)
{
    public const string Localizacao = "PDV › Central do PDV › Caixas";

    /// <summary>O tipo do relatório do fechamento na <c>fila_impressao</c> (gravado por <c>ServicoCaixa.FecharAsync</c>).</summary>
    public const string DocumentoFechamento = "fechamento_caixa";

    /// <summary>O tipo da 2ª via na fila (o original continua o primeiro trabalho de <see cref="DocumentoFechamento"/>).</summary>
    public const string DocumentoReimpressao = "fechamento_caixa_reimpressao";

    public const string MensagemSemPermissao =
        "Os caixas fechados pedem quem pode ver os fechamentos (pdv.caixa.consultar_fechamentos): Ctrl+L Liberar.";

    public const string MensagemForaDoAlcance =
        "Este caixa não está nos últimos 30 dias deste terminal: consulte-o no ERP (Fechamentos de caixa).";

    public const string MensagemCaixaAberto = "O caixa aberto ainda não tem fechamento: o relatório sai quando ele for fechado (F11 › 3).";

    public const string MensagemIndisponivel =
        "Comprovante deste fechamento indisponível neste caixa (o original não está guardado aqui, por exemplo depois de " +
        "recuperar o banco pela nuvem): consulte o fechamento no ERP (Fechamentos de caixa). Nada é montado de novo.";

    public const string MensagemReimpressaoSemImpressora = "Sem impressora configurada neste caixa: a 2ª via ficou só na tela.";

    public const string MensagemComCalculado =
        "Este relatório saiu com o calculado e a diferença: a 2ª via é só de quem os vê no fechamento deste caixa " +
        "(pdv.caixa.ver_calculado_fechamento, pelas regras da loja). Consulte o fechamento no ERP (Fechamentos de caixa).";

    /// <summary>A linha que todo relatório do fechamento com o calculado traz (<c>LayoutsCaixa.Fechamento</c>, desde o C10a).</summary>
    private const string MarcaCalculado = "calculado";

    private Guid TerminalId => sessao.Identidade?.TerminalId ?? throw new InvalidOperationException("Terminal não ativado.");

    /// <summary>A pessoa na Central vê os caixas (a permissão dela ou a emprestada pela liberação ativa).</summary>
    public bool VeCaixas => acesso.Tem(PermissoesPdv.ConsultarFechamentos);

    /// <summary>O caixa aberto (primeiro) e os fechados nos últimos 30 dias, do mais novo ao mais antigo.</summary>
    public async Task<IReadOnlyList<CaixaHistorico>> CaixasAsync(CancellationToken ct = default)
    {
        ExigirCaixas();
        return await consultas.SessoesAsync(TerminalId, vendas.Desde(), ct);
    }

    /// <summary>O detalhe pelo retrato; recusa o caixa fora dos 30 dias (ou de outro terminal), mesmo pedido pelo id.</summary>
    public async Task<RetratoCaixa> RetratoAsync(Guid sessaoId, CancellationToken ct = default)
    {
        ExigirCaixas();
        return await consultas.RetratoAsync(TerminalId, vendas.Desde(), sessaoId, ct) ?? throw new RegraNegocioException(MensagemForaDoAlcance);
    }

    /// <summary>
    /// Ctrl+R (PDV 22.2; plano 4.3): a 2ª via do relatório do fechamento, com os <b>bytes originais</b> da
    /// <c>fila_impressao</c> e a marca "2ª VIA - REIMPRESSÃO dd/mm hh:mm" na frente (como o cupom). Sem o original:
    /// <see cref="MensagemIndisponivel"/> (nunca remonta do resumo nem apura de novo; nada é gravado). A auditoria
    /// <c>reimpressao</c> (entidade <c>fechamentos_caixa</c>) vai antes da impressora, com quem está na Central e quem
    /// liberou: o supervisor na hora (<paramref name="liberacao"/>) ou, sem ele, quem emprestou a consulta dos fechamentos.
    /// O original que saiu com o calculado e a diferença (a loja fora do padrão O3) só sai de novo para quem está na
    /// Central e os veria no próprio fechamento pelas regras de agora (<see cref="MensagemComCalculado"/>): a permissão
    /// <c>pdv.caixa.ver_calculado_fechamento</c> não se empresta, e o supervisor que libera a reimpressão não a passa.
    /// Devolve o texto da 2ª via (a impressora simulada e a tela) e os avisos.
    /// </summary>
    public async Task<(string Texto, IReadOnlyList<string> Avisos)> ReimprimirFechamentoAsync(
        Guid sessaoId, LiberacaoConcedida? liberacao = null, CancellationToken ct = default)
    {
        var usuario = acesso.Usuario ?? throw new RegraNegocioException(AcessoCentral.MensagemFechada);
        if (!usuario.Tem(PermissoesPdv.Reimprimir) && liberacao is null)
        {
            throw new RegraNegocioException(ServicoCaixa.MensagemSemPermissao);
        }

        var (retrato, fechamento, original) = await OriginalAsync(usuario, sessaoId, ct);
        var agora = relogio.Agora;
        var conteudo = LayoutComprovanteVenda.Reimpressao(original, agora, sessao.FusoHorario, impressao.Colunas);
        var fuso = DiaOperacional.ObterFuso(sessao.FusoHorario);
        var quando = TimeZoneInfo.ConvertTime(fechamento.OcorridoEm, fuso).ToString("dd/MM HH:mm", NumeroBr.Cultura);
        await terminal.RegistrarAuditoriaAsync("reimpressao", usuario.Id, "fechamentos_caixa", fechamento.Id,
            $"Reimpressão do fechamento do caixa {retrato.Caixa.NumeroCaixa:00} de {quando}"
            + (liberacao is null ? string.Empty : $", liberada por {liberacao.Supervisor.Nome}"),
            Localizacao, liberacao?.Supervisor.Id ?? acesso.AutorizadoPor(PermissoesPdv.ConsultarFechamentos), ct, liberacao?.Motivo,
            new JsonObject
            {
                ["documento"] = DocumentoFechamento,
                ["sessao_caixa_id"] = sessaoId.ToString(),
                ["tipo"] = fechamento.Tipo,
            }.ToJsonString());
        var avisos = new List<string>();
        if (await impressao.ImprimirAsync(DocumentoReimpressao, fechamento.Id, conteudo, e => $"2ª via não impressa ({e}) — ficou na fila.", ct: ct,
                semImpressora: MensagemReimpressaoSemImpressora) is { } aviso)
        {
            avisos.Add(aviso);
        }

        return (impressao.Texto(conteudo), avisos);
    }

    /// <summary>
    /// Confere, sem gravar nada, que o fechamento tem a 2ª via para quem está na Central (o original na fila e, se ele
    /// saiu com o calculado, quem o veria): a tela pergunta antes de pedir o supervisor, para ninguém digitar o PIN à toa.
    /// </summary>
    public async Task ExigirSegundaViaAsync(Guid sessaoId, CancellationToken ct = default) =>
        await OriginalAsync(acesso.Usuario ?? throw new RegraNegocioException(AcessoCentral.MensagemFechada), sessaoId, ct);

    /// <summary>
    /// O relatório do fechamento saiu com o calculado e a diferença? Pela palavra "calculado", que todo layout do
    /// fechamento com o calculado imprime ("Total calculado:", sempre; a coluna ou a linha "Calculado" de cada forma) e o
    /// cego nunca: na dúvida (a palavra numa forma, na justificativa ou no nome da loja), trata como se trouxesse — a 2ª
    /// via fica para quem vê o calculado, nunca o contrário.
    /// </summary>
    public static bool TrazCalculado(string texto) => texto.Contains(MarcaCalculado, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// F6 (plano 3.1: o resumo diário como atalho da aba): o resumo do dia operacional <paramref name="dia"/> (o do caixa
    /// escolhido), pelas regras do F11 › 6 com quem está na Central (permissão, O3 e o cabeçalho dele).
    /// </summary>
    public Task<ResultadoResumoDiario> ResumoDoDiaAsync(DateOnly dia, bool imprimir, LiberacaoConcedida? liberacao = null, CancellationToken ct = default)
    {
        ExigirCaixas();
        var usuario = acesso.Usuario ?? throw new RegraNegocioException(AcessoCentral.MensagemFechada);
        var (fuso, corte, _) = caixa.DiaOperacionalAtual();
        return caixa.ResumoDiarioAsync(PeriodoResumo.PorDias(dia, dia, fuso, corte), imprimir, liberacao, usuario, ct);
    }

    public Task<string> NomeUsuarioAsync(Guid usuarioId, CancellationToken ct = default) => caixa.NomeUsuarioAsync(usuarioId, ct);

    /// <summary>
    /// O retrato, o fechamento e os bytes originais do relatório que <paramref name="usuario"/> pode ver de novo; sem
    /// eles, a mensagem do porquê.
    /// </summary>
    private async Task<(RetratoCaixa Retrato, FechamentoRetrato Fechamento, byte[] Original)> OriginalAsync(Operador usuario, Guid sessaoId, CancellationToken ct)
    {
        var retrato = await RetratoAsync(sessaoId, ct);
        var fechamento = retrato.Fechamento ?? throw new RegraNegocioException(retrato.Caixa.Aberto ? MensagemCaixaAberto : MensagemIndisponivel);
        var original = await fila.OriginalAsync(DocumentoFechamento, fechamento.Id, ct) ?? throw new RegraNegocioException(MensagemIndisponivel);
        if (TrazCalculado(impressao.Texto(original)))
        {
            // As regras de agora (as chaves podem ter mudado desde o fechamento): o relatório desta pessoa traria o calculado?
            await caixa.CarregarRegrasAsync(ct);
            if (!caixa.Regras.Fechamento.ImprimeCalculadoNoRelatorio(usuario.Tem(PermissoesPdv.VerCalculadoFechamento)))
            {
                throw new RegraNegocioException(MensagemComCalculado);
            }
        }

        return (retrato, fechamento, original);
    }

    private void ExigirCaixas()
    {
        if (!VeCaixas)
        {
            throw new RegraNegocioException(MensagemSemPermissao);
        }
    }
}
