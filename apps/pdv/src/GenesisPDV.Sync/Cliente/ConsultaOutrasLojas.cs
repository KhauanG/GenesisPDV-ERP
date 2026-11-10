using System.Net;
using System.Text.Json;
using GenesisPDV.Sync.Protocolo;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace GenesisPDV.Sync.Cliente;

/// <summary>Textos do F4 "Outras lojas" (Fase 2, F2-B35; PDV 10.3).</summary>
public static class MensagensConsultaOutrasLojas
{
    /// <summary>Offline, sem resposta em 3 s, API antiga (404 da rota) ou fora do ar: a venda segue, só a consulta não.</summary>
    public const string RequerConexao = "Consulta indisponível (requer conexão)";

    public const string Desligada = "Consulta do estoque das outras lojas desligada no ERP para esta loja.";

    public const string Limite = "Muitas consultas seguidas deste caixa: aguarde um minuto.";

    public const string ProdutoNaoEncontrado = "Produto não encontrado na nuvem (o cadastro pode ter sido excluído no ERP).";

    public const string HardwareAlterado = "Consulta indisponível: hardware alterado — aguardando aprovação no ERP.";
}

/// <summary>
/// Desfecho da consulta: os <see cref="Saldos"/>, ou o <see cref="Aviso"/> que a tela mostra no lugar. Nunca exceção
/// para a tela: a consulta é um extra do balcão e não pode travar a venda.
/// </summary>
public sealed record ResultadoConsultaOutrasLojas(RespostaSaldosOutrasLojas? Saldos, string? Aviso)
{
    public static ResultadoConsultaOutrasLojas Indisponivel(string aviso) => new(null, aviso);
}

/// <summary>F4 "Outras lojas" da pesquisa F2: o saldo online do produto nas lojas e no CD (Fase 2, F2-B35).</summary>
public interface IConsultaOutrasLojas
{
    /// <summary>
    /// Consulta online (<c>GET /sync/consultas/saldos-outras-lojas</c>, até 3 s). Sem nuvem, offline, prazo estourado,
    /// API antiga ou recusa → <see cref="ResultadoConsultaOutrasLojas.Aviso"/>. Só o cancelamento de quem chamou (o
    /// diálogo fechado) sai como <see cref="OperationCanceledException"/>.
    /// </summary>
    Task<ResultadoConsultaOutrasLojas> ConsultarAsync(Guid produtoId, CancellationToken ct = default);
}

/// <summary>
/// A consulta pelo <see cref="IClienteSync"/>, com a situação do ciclo (<see cref="IServicoSincronizacao.Situacao"/>):
/// o terminal de demonstração (sem nuvem) e o caixa já dado como offline (2 falhas seguidas, SYNC 18.3) nem tentam —
/// "requer conexão" na hora. O 404 sem <c>detalhes.produto_id</c> é a rota que a API anterior ao F2-B35 não tem (o PDV
/// pode chegar à loja antes da API): o mesmo aviso. A chave <c>pdv.consulta_outras_lojas</c> é conferida pela tela antes
/// (o espelho local) e pela API (403 <c>ESCOPO_INVALIDO</c> com <c>detalhes.chave</c>, o caso do espelho atrasado); o
/// mesmo 403 sem <c>detalhes.chave</c> é outra recusa de escopo (o terminal em desativação, SYNC 3.8) e mostra a
/// mensagem da API.
/// </summary>
public sealed class ConsultaOutrasLojasHttp(IClienteSync cliente, IServicoSincronizacao sincronizacao, ILogger<ConsultaOutrasLojasHttp>? log = null)
    : IConsultaOutrasLojas
{
    private readonly ILogger _log = log ?? NullLogger<ConsultaOutrasLojasHttp>.Instance;

    public async Task<ResultadoConsultaOutrasLojas> ConsultarAsync(Guid produtoId, CancellationToken ct = default)
    {
        var situacao = sincronizacao.Situacao;
        if (situacao.SemNuvem || situacao is { Online: false, OfflineDesde: not null })
        {
            return ResultadoConsultaOutrasLojas.Indisponivel(MensagensConsultaOutrasLojas.RequerConexao);
        }

        try
        {
            return new ResultadoConsultaOutrasLojas(await cliente.SaldosOutrasLojasAsync(produtoId, ct).ConfigureAwait(false), null);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException)
        {
            // Sem rede, o prazo de 3 s (TaskCanceledException com TimeoutException dentro) ou resposta que não é o contrato.
            _log.LogInformation("Consulta de outras lojas indisponível: {Erro}", e.Message);
            return ResultadoConsultaOutrasLojas.Indisponivel(MensagensConsultaOutrasLojas.RequerConexao);
        }
        catch (ErroSyncException e)
        {
            _log.LogInformation("Consulta de outras lojas recusada: {Status} {Codigo}", (int)e.Status, e.Codigo);
            return ResultadoConsultaOutrasLojas.Indisponivel(Aviso(e));
        }
    }

    private static string Aviso(ErroSyncException e) => e switch
    {
        { Status: HttpStatusCode.NotFound } when Detalhe(e, "produto_id") => MensagensConsultaOutrasLojas.ProdutoNaoEncontrado,
        { Status: HttpStatusCode.NotFound } => MensagensConsultaOutrasLojas.RequerConexao,
        { Status: HttpStatusCode.Forbidden, Codigo: "ESCOPO_INVALIDO" } when Detalhe(e, "chave") => MensagensConsultaOutrasLojas.Desligada,
        { Status: HttpStatusCode.TooManyRequests } => MensagensConsultaOutrasLojas.Limite,
        { Codigo: "HARDWARE_ALTERADO" } => MensagensConsultaOutrasLojas.HardwareAlterado,
        { Transitorio: true } => MensagensConsultaOutrasLojas.RequerConexao,
        _ => $"Consulta indisponível: {e.Message}",
    };

    /// <summary>
    /// O detalhe que separa as recusas de mesmo código: o 404 do produto desconhecido traz <c>detalhes.produto_id</c> (o da
    /// rota inexistente, não) e o 403 da chave desligada, <c>detalhes.chave</c> (o do terminal em desativação, não).
    /// </summary>
    private static bool Detalhe(ErroSyncException e, string nome) =>
        e.Erro?.Detalhes is { ValueKind: JsonValueKind.Object } d && d.TryGetProperty(nome, out _);
}
