using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Ativacao;

namespace GenesisPDV.Sync.Token;

/// <summary>
/// O token gravado não abre com o protetor desta conta do sistema (SYNC 3.6, D21; implantação I3): o banco é da máquina
/// (ProgramData no Windows, <c>/var/lib/genesispdv</c> no Linux), mas a DPAPI CurrentUser e a chave local são da conta que
/// ativou. O handshake devolve <c>DesfechoHandshake.ContaDiferente</c> e a tela explica com qual conta entrar.
/// </summary>
public sealed class TokenIlegivelException(CryptographicException causa)
    : CryptographicException("O token deste terminal não abre com esta conta do sistema (foi protegido por outra conta).", causa);

/// <summary>Tokens que o cliente HTTP tenta, na ordem da SYNC 3.7, e o retorno de cada tentativa.</summary>
public interface IFonteToken
{
    /// <summary>Pendente da rotação (se houver) e depois o atual; vazio sem identidade ou no terminal de demonstração.</summary>
    Task<IReadOnlyList<string>> CandidatosAsync(CancellationToken ct = default);

    /// <summary>A chamada com <paramref name="token"/> deu certo: promove o pendente no primeiro 200 obtido com ele.</summary>
    Task SucessoAsync(string token, CancellationToken ct = default);

    /// <summary><c>401 TOKEN_INVALIDO</c> com <paramref name="token"/> (o cliente tenta o próximo candidato).</summary>
    Task RecusadoAsync(string token, CancellationToken ct = default);
}

/// <summary>Token fixo (testes e chamadas sem identidade); nulo = sem <c>Authorization</c>.</summary>
public sealed class FonteTokenFixa(Func<string?> token) : IFonteToken
{
    public Task<IReadOnlyList<string>> CandidatosAsync(CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<string>>(token() is { } t ? [t] : []);

    public Task SucessoAsync(string token, CancellationToken ct = default) => Task.CompletedTask;

    public Task RecusadoAsync(string token, CancellationToken ct = default) => Task.CompletedTask;
}

/// <summary><c>configuracao_terminal['token.pendente']</c>: o token novo protegido e o id da renovação (3.7).</summary>
internal sealed record TokenPendenteGravado(
    [property: JsonPropertyName("token_protegido")] string TokenProtegido,
    [property: JsonPropertyName("requisicao_id")] Guid RequisicaoId,
    [property: JsonPropertyName("criado_em")] DateTimeOffset CriadoEm);

/// <summary>Pendente decifrado em memória: nunca vai para log (o <c>ToString</c> esconde o token).</summary>
public sealed record TokenPendente(string Token, Guid RequisicaoId, DateTimeOffset CriadoEm)
{
    public override string ToString() => $"TokenPendente {{ RequisicaoId = {RequisicaoId}, CriadoEm = {CriadoEm:O}, Token = *** }}";
}

/// <summary>
/// Guarda dos tokens do terminal (SYNC 3.6, 3.7): decifra <c>identidade_terminal.token_protegido</c> e
/// <c>token.pendente</c> com o <see cref="IProtetorSegredos"/> só quando precisa e os mantém em memória, nunca em log.
/// Ordem de tentativa: com pendente, ele primeiro; <c>401</c> → o atual. O pendente é promovido (atual = pendente, sem
/// pendente, no mesmo commit) no primeiro <c>200</c> obtido com ele. É descartado só quando o atual responde <c>200</c>
/// fora de uma renovação, o pendente vem sendo recusado há mais de 24 h e nenhuma renovação foi confirmada pela API
/// nesse meio-tempo (sinal de que ela nunca a aplicou; descartar antes disso poderia deixar o PDV só com o token
/// anterior, que vence em 7 dias). O <c>200</c> da própria renovação, obtido com o atual, é justamente o que instala o
/// pendente na API: enquanto uma renovação está em andamento (<see cref="IniciarRenovacao"/>), nada é descartado.
/// </summary>
public sealed class CofreToken(RepositorioTerminal terminal, IProtetorSegredos protetor, IRelogio relogio) : IFonteToken
{
    public static readonly TimeSpan DescartePendente = TimeSpan.FromHours(24);

    private readonly SemaphoreSlim _trava = new(1, 1);
    private bool _carregado;
    private Guid _terminalId;
    private string? _atual;
    private TokenPendente? _pendente;
    private DateTimeOffset? _pendenteRecusadoDesde;
    private int _renovacoesEmAndamento;

    public async Task<IReadOnlyList<string>> CandidatosAsync(CancellationToken ct = default)
    {
        await _trava.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await CarregarAsync(ct).ConfigureAwait(false);
            if (_atual is null)
            {
                return [];
            }

            return _pendente is { } p ? [p.Token, _atual] : [_atual];
        }
        finally
        {
            _trava.Release();
        }
    }

    public async Task SucessoAsync(string token, CancellationToken ct = default)
    {
        await _trava.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_pendente is { } p && p.Token == token)
            {
                await terminal.PromoverTokenPendenteAsync(Proteger(token), ct).ConfigureAwait(false);
                _atual = token;
                _pendente = null;
                _pendenteRecusadoDesde = null;
            }
            else if (_pendente is not null && token == _atual && _pendenteRecusadoDesde is { } desde
                     && relogio.Agora - desde > DescartePendente && Volatile.Read(ref _renovacoesEmAndamento) == 0)
            {
                await terminal.RemoverConfiguracaoAsync(ChavesConfiguracaoTerminal.TokenPendente, ct).ConfigureAwait(false);
                _pendente = null;
                _pendenteRecusadoDesde = null;
            }
        }
        finally
        {
            _trava.Release();
        }
    }

    public async Task RecusadoAsync(string token, CancellationToken ct = default)
    {
        await _trava.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_pendente is { } p && p.Token == token)
            {
                _pendenteRecusadoDesde ??= relogio.Agora;
            }
        }
        finally
        {
            _trava.Release();
        }
    }

    /// <summary>Pendente atual (para repetir a renovação com o mesmo id e o mesmo hash), ou nulo.</summary>
    public async Task<TokenPendente?> PendenteAsync(CancellationToken ct = default)
    {
        await _trava.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await CarregarAsync(ct).ConfigureAwait(false);
            return _pendente;
        }
        finally
        {
            _trava.Release();
        }
    }

    /// <summary>Grava o pendente (protegido) numa transação <b>antes</b> do <c>POST /sync/token/renovar</c> (3.7).</summary>
    public async Task<TokenPendente> GravarPendenteAsync(string token, Guid requisicaoId, CancellationToken ct = default)
    {
        await _trava.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await CarregarAsync(ct).ConfigureAwait(false);
            if (_pendente is not null)
            {
                throw new InvalidOperationException("Já existe um token pendente: nunca há dois (SYNC 3.7).");
            }

            var pendente = new TokenPendente(token, requisicaoId, relogio.Agora);
            var gravado = new TokenPendenteGravado(Convert.ToBase64String(Proteger(token)), requisicaoId, pendente.CriadoEm);
            await terminal.GravarConfiguracaoAsync(ChavesConfiguracaoTerminal.TokenPendente, gravado, ct: ct).ConfigureAwait(false);
            _pendente = pendente;
            _pendenteRecusadoDesde = null;
            return pendente;
        }
        finally
        {
            _trava.Release();
        }
    }

    /// <summary>
    /// Marca uma renovação em andamento até o descarte do retorno: o <c>200</c> obtido com o atual nessa chamada não
    /// descarta o pendente (é ele que acabou de valer na API).
    /// </summary>
    public IDisposable IniciarRenovacao()
    {
        Interlocked.Increment(ref _renovacoesEmAndamento);
        return new FimRenovacao(this);
    }

    /// <summary>A API respondeu <c>200</c> à renovação: o pendente vale lá e não pode mais ser descartado.</summary>
    public void RenovacaoConfirmada() => _pendenteRecusadoDesde = null;

    private async Task CarregarAsync(CancellationToken ct)
    {
        if (_carregado)
        {
            return;
        }

        var identidade = await terminal.ObterIdentidadeAsync(ct).ConfigureAwait(false);
        if (identidade is null || identidade.Demonstracao || identidade.TokenProtegido.Length == 0)
        {
            // Sem identidade ainda (assistente aberto): não marca como carregado, a ativação pode acontecer a seguir.
            return;
        }

        _terminalId = identidade.TerminalId;
        var gravado = await terminal.ObterConfiguracaoAsync<TokenPendenteGravado>(ChavesConfiguracaoTerminal.TokenPendente, ct).ConfigureAwait(false);
        try
        {
            _atual = Encoding.UTF8.GetString(protetor.Desproteger(identidade.TokenProtegido, ProtetorSegredos.FinalidadeToken(_terminalId)));
            _pendente = gravado is null
                ? null
                : new TokenPendente(
                    Encoding.UTF8.GetString(protetor.Desproteger(Convert.FromBase64String(gravado.TokenProtegido), ProtetorSegredos.FinalidadeToken(_terminalId))),
                    gravado.RequisicaoId,
                    gravado.CriadoEm);
        }
        catch (CryptographicException e)
        {
            // Banco compartilhado (ProgramData, /var/lib) aberto por outra conta do sistema: a DPAPI CurrentUser e a chave em
            // ~/.config são da conta que ativou (D21). O ciclo trata como estado próprio, nunca como erro solto.
            _atual = null;
            _pendente = null;
            throw new TokenIlegivelException(e);
        }

        _carregado = true;
    }

    private sealed class FimRenovacao(CofreToken cofre) : IDisposable
    {
        private int _encerrada;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _encerrada, 1) == 0)
            {
                Interlocked.Decrement(ref cofre._renovacoesEmAndamento);
            }
        }
    }

    private byte[] Proteger(string token) => protetor.Proteger(Encoding.UTF8.GetBytes(token), ProtetorSegredos.FinalidadeToken(_terminalId));
}
