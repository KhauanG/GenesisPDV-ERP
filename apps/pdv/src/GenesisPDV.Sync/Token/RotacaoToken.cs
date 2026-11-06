using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Protocolo;

namespace GenesisPDV.Sync.Token;

/// <summary>
/// Rotação do token (SYNC 3.7), lado do PDV: gera o segredo novo (32 bytes de CSPRNG em base64url sem <c>=</c>), grava
/// <c>token.pendente</c> <b>antes</b> do <c>POST /sync/token/renovar</c> e manda só o SHA-256 do segredo. Com pendente já
/// gravado (resposta perdida, queda do PDV), repete com o mesmo <c>requisicao_id</c> e o mesmo hash. A promoção
/// acontece no <see cref="CofreToken"/>, na primeira chamada que der 200 com o novo. Quem chama é o ciclo online
/// (<see cref="Cliente.ServicoSincronizacaoHttp"/>) quando o heartbeat responde <c>renovar_token: true</c>; falhou, repete
/// no heartbeat seguinte com o mesmo pendente.
/// </summary>
public sealed class RotacaoToken(IClienteSync cliente, RepositorioTerminal terminal, CofreToken cofre)
{
    public const string Rota = "sync/token/renovar";

    /// <returns><c>false</c> sem identidade real (assistente aberto ou terminal de demonstração).</returns>
    public async Task<bool> RenovarAsync(CancellationToken ct = default)
    {
        var identidade = await terminal.ObterIdentidadeAsync(ct).ConfigureAwait(false);
        if (identidade is null || identidade.Demonstracao)
        {
            return false;
        }

        var pendente = await cofre.PendenteAsync(ct).ConfigureAwait(false)
                       ?? await cofre.GravarPendenteAsync(NovoToken(identidade.TerminalId), IdGerador.Novo(), ct).ConfigureAwait(false);
        var corpo = new RequisicaoRenovarToken(HashDoSegredo(pendente.Token), pendente.RequisicaoId);
        // O 200 desta chamada com o atual é o que aplica o pendente na API: ele não pode contar para o descarte de 24 h.
        using (cofre.IniciarRenovacao())
        {
            await cliente.AlterarAsync<RespostaRenovarToken>(HttpMethod.Post, Rota, corpo, pendente.RequisicaoId, ct).ConfigureAwait(false);
            cofre.RenovacaoConfirmada();
        }

        return true;
    }

    /// <summary><c>&lt;terminal_id&gt;.&lt;segredo&gt;</c> com 32 bytes aleatórios (43 caracteres base64url), SYNC 3.6.</summary>
    public static string NovoToken(Guid terminalId) =>
        $"{terminalId:D}.{Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32))}";

    /// <summary><c>sha256_hex(segredo)</c>: o mesmo cálculo de <c>terminais_pdv.token_hash</c> na API.</summary>
    public static string HashDoSegredo(string token)
    {
        var ponto = token.IndexOf('.', StringComparison.Ordinal);
        if (ponto < 0)
        {
            throw new ArgumentException("Token sem o separador do terminal.", nameof(token));
        }

        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token[(ponto + 1)..])));
    }
}
