using GenesisPDV.App.Servicos;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.E2E.Tests;

/// <summary>
/// O cabo de rede do PDV de verdade no e2e (Fase 1C, C13): um <see cref="DelegatingHandler"/> no cliente HTTP do sync
/// (<see cref="Inicializacao.ClienteHttpSync"/>) que, desligado, falha toda chamada como a rede caída (a mesma
/// <see cref="HttpRequestException"/> de uma conexão recusada) e, com <see cref="PerderRespostasDoPush"/>, deixa o push
/// chegar à API e perde a resposta no caminho de volta — o caso do "reenvio do mesmo lote" do PDV 30.7. Conta os
/// <c>/sync/push</c> por <c>X-Requisicao-Id</c> (o <c>lote_id</c>) para o teste ver o mesmo lote indo duas vezes, e os
/// handshakes (<c>/sync/estado</c>) que chegaram à API, para ver o da volta de um offline longo (SYNC 18.3).
/// </summary>
public sealed class RedeSimulada
{
    private readonly object _trava = new();
    private readonly Dictionary<string, int> _pushes = new(StringComparer.Ordinal);
    private int _respostasAPerder;
    private int _handshakes;

    /// <summary>Cabo puxado: nenhuma chamada sai do PDV.</summary>
    public bool Desligada { get; set; }

    /// <summary>As próximas <paramref name="quantas"/> respostas de <c>/sync/push</c> se perdem depois da API gravar.</summary>
    public void PerderRespostasDoPush(int quantas)
    {
        lock (_trava)
        {
            _respostasAPerder = quantas;
        }
    }

    /// <summary>Quantos lotes (<c>X-Requisicao-Id</c>) foram enviados mais de uma vez.</summary>
    public int LotesReenviados
    {
        get
        {
            lock (_trava)
            {
                return _pushes.Values.Count(n => n > 1);
            }
        }
    }

    /// <summary>Quantos <c>GET /sync/estado</c> (handshake, SYNC 5) saíram com a rede ligada.</summary>
    public int Handshakes
    {
        get
        {
            lock (_trava)
            {
                return _handshakes;
            }
        }
    }

    public int LotesEnviados
    {
        get
        {
            lock (_trava)
            {
                return _pushes.Count;
            }
        }
    }

    /// <summary>Liga a rede simulada no cliente do sync do PDV (pelo <c>ajustar</c> do <c>AmbienteUi</c>).</summary>
    public void Instalar(IServiceCollection servicos) =>
        // Um handler novo por montagem do pipeline (o IHttpClientFactory não reaproveita instância), com o estado aqui.
        servicos.AddHttpClient(Inicializacao.ClienteHttpSync).AddHttpMessageHandler(() => new Cabo(this));

    private sealed class Cabo(RedeSimulada rede) : DelegatingHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (rede.Desligada)
            {
                throw new HttpRequestException("Rede simulada desligada (cabo puxado).");
            }

            var push = request.RequestUri?.AbsolutePath.EndsWith("/sync/push", StringComparison.Ordinal) == true;
            if (request.RequestUri?.AbsolutePath.EndsWith("/sync/estado", StringComparison.Ordinal) == true)
            {
                lock (rede._trava)
                {
                    rede._handshakes++;
                }
            }

            if (push && request.Headers.TryGetValues("X-Requisicao-Id", out var ids) && ids.FirstOrDefault() is { } id)
            {
                lock (rede._trava)
                {
                    rede._pushes[id] = rede._pushes.GetValueOrDefault(id) + 1;
                }
            }

            var resposta = await base.SendAsync(request, cancellationToken);
            if (push)
            {
                lock (rede._trava)
                {
                    if (rede._respostasAPerder > 0)
                    {
                        rede._respostasAPerder--;
                        resposta.Dispose();
                        throw new HttpRequestException("Rede simulada: a resposta do push se perdeu depois da API gravar.");
                    }
                }
            }

            return resposta;
        }
    }
}
