using System.Text.Json;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Acesso;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.Servicos.Diagnostico;

/// <summary>De onde a Central do PDV foi aberta (plano 3.3).</summary>
public enum OrigemCentral
{
    /// <summary>Da venda (F11 › 8, a engrenagem da barra): o operador logado, com as permissões dele.</summary>
    Venda,

    /// <summary>Do login (Ctrl+Alt+C, a engrenagem do login): quem digitou usuário e PIN, sem sessão de operador.</summary>
    Login,
}

/// <summary>
/// Quem está na Central do PDV e o que pode ver (Central do PDV, bloco G2; plano 3.3; decisões do dono de 04/11/2026;
/// README › decisão 67). Uma Central aberta por vez no caixa (o app tem uma janela só), do <see cref="AbrirPelaVenda"/>
/// ou do <see cref="AbrirPeloLoginAsync"/> até o <see cref="Encerrar"/>.
/// <list type="bullet">
/// <item><b>Permissões:</b> as do usuário da Central (<see cref="Usuario"/>); com a liberação ativa, também as do
/// <see cref="Liberador"/>, só as <see cref="AbasCentral.PermissoesLiberaveis"/> (as de <b>ver</b> as abas; nunca as de
/// ação nem as sem liberação do catálogo). O Painel de saúde e o Sobre ficam com <c>pdv.acesso.entrar</c> (PC-7), que
/// todo usuário que entra tem. <see cref="Tem"/> e <see cref="PodeAbrir"/> só consultam (a tela pode chamar à vontade).</item>
/// <item><b>Liberação</b> ("Liberar", Ctrl+L na Central; <see cref="LiberarAsync"/>): usuário e PIN de quem tem
/// <c>pdv.supervisor</c> (como toda liberação, PDV 31.3) e alguma permissão liberável que o usuário não tem; não pode ser
/// o próprio usuário. Vale até sair da Central ou <see cref="ValidadeLiberacao"/> sem uso, medidos pelo relógio
/// monotônico (o do Windows pode ser acertado para trás). Só o uso renova: <see cref="RegistrarUso"/> (tecla, clique) e
/// abrir uma aba (<see cref="RegistrarAberturaAsync"/>). Grava a auditoria <c>liberacao</c> (sobe para a nuvem) com as
/// abas e as permissões no <c>depois</c>; sem a auditoria (D22), não libera. A ação que a tela grava com uma permissão
/// emprestada leva o <see cref="AutorizadoPor"/> no <c>autorizado_por_id</c>.</item>
/// <item><b>Acesso:</b> abrir uma aba com <see cref="AbaCentral.RegistraAcesso"/> e entrar pelo login gravam o
/// <see cref="AcaoCentralAcessada"/>, <b>só local</b>: fica fora do <c>CatalogosNuvem.AcoesAuditoria</c>, o
/// <c>OutboxSync</c> não a põe no lote e nada depende da nuvem conhecer a ação. O PIN recusado ao entrar pelo login grava
/// o <c>login_negado</c>, como o login do caixa (sobe e vira <c>historico_logins</c>).</item>
/// <item><b>Desativação (D22):</b> o gatilho recusa a auditoria; o <see cref="RegraNegocioException"/> vira
/// <see cref="SomenteLeitura"/> (a Central continua só para ver) em vez de derrubar a tela, e a liberação é recusada
/// sem conferir o PIN.</item>
/// <item><b>Ordem:</b> a resposta de um <c>await</c> que chega depois de sair (ou de reabrir) a Central é descartada:
/// nada é emprestado nem gravado em nome da Central que já acabou.</item>
/// </list>
/// "PIN na hora" das ações que pedem (restaurar backup) não passa por aqui: a ação pede o PIN dela mesmo com a liberação
/// ativa. As ações que mudam algo (configurar a impressora, abrir a gaveta, reimprimir, editar os parâmetros do caixa)
/// também não: pedem a própria liberação (31.3), como fora da Central.
/// </summary>
public sealed class AcessoCentral(
    IAutenticadorOperador autenticador, RepositorioTerminal terminal, IRelogio relogio, ILogger<AcessoCentral> log, TimeProvider? tempo = null)
{
    /// <summary>Ação local de auditoria do acesso (não está no catálogo da nuvem e não sobe).</summary>
    public const string AcaoCentralAcessada = "central_acessada";

    public const string Entidade = "central_pdv";
    public const string Localizacao = "pdv.central";

    /// <summary>Liberação sem uso por este tempo volta às permissões do usuário (constante do código, plano 3.3).</summary>
    public static readonly TimeSpan ValidadeLiberacao = TimeSpan.FromMinutes(5);

    public const string MensagemFechada = "Abra a Central do PDV primeiro.";
    public const string MensagemLiberadorProprio = "Liberação negada: digite o usuário de outra pessoa.";
    public const string MensagemLiberadorNaoSupervisor = "Liberação negada: o usuário não é supervisor.";
    public const string MensagemNadaALiberar = "Liberação negada: o usuário não tem nenhuma aba a mais para liberar.";

    private readonly TimeProvider _tempo = tempo ?? TimeProvider.System;
    private readonly HashSet<string> _abasRegistradas = new(StringComparer.Ordinal);
    private IReadOnlyList<string> _abasLiberadas = [];
    private Operador? _liberador;

    /// <summary>Marca monotônica (<see cref="TimeProvider.GetTimestamp"/>) do último uso da liberação.</summary>
    private long _ultimoUso;

    /// <summary>Muda a cada abertura e saída: a continuação de um <c>await</c> confere se ainda é a mesma Central.</summary>
    private long _abertura;

    private string? _mensagemSomenteLeitura;

    public bool Aberta => Usuario is not null;

    public OrigemCentral Origem { get; private set; }

    /// <summary>Quem está na Central: o operador logado (venda) ou quem digitou o PIN (login).</summary>
    public Operador? Usuario { get; private set; }

    /// <summary>Quem liberou, enquanto a liberação vale (nulo depois de expirar ou sem liberação).</summary>
    public Operador? Liberador => LiberacaoAtiva ? _liberador : null;

    public bool LiberacaoAtiva => _liberador is not null && SemUso <= ValidadeLiberacao;

    /// <summary>Quando a liberação expira se ninguém mais usar (nulo sem liberação ativa), para a contagem na tela.</summary>
    public DateTimeOffset? LiberacaoExpiraEm => LiberacaoAtiva ? relogio.Agora + (ValidadeLiberacao - SemUso) : null;

    /// <summary>Rótulos das abas que a liberação ativa abriu (vazio sem liberação ou depois de expirar).</summary>
    public IReadOnlyList<string> AbasLiberadas => LiberacaoAtiva ? _abasLiberadas : [];

    /// <summary>Terminal em desativação (D22): a auditoria foi recusada e a Central fica só para ver.</summary>
    public bool SomenteLeitura => _mensagemSomenteLeitura is not null;

    private TimeSpan SemUso => _tempo.GetElapsedTime(_ultimoUso);

    /// <summary>A Central aberta da venda, com o operador logado (as checagens de caixa livre e D22 são da tela).</summary>
    public void AbrirPelaVenda(Operador operador)
    {
        ArgumentNullException.ThrowIfNull(operador);
        Encerrar();
        Usuario = operador;
        Origem = OrigemCentral.Venda;
    }

    /// <summary>
    /// A Central aberta do login: o PIN pelas regras do login (<see cref="IAutenticadorOperador.AutenticarParaCentralAsync"/>,
    /// com o mesmo bloqueio por tentativas), sem sessão de operador. Grava o <see cref="AcaoCentralAcessada"/>; na recusa,
    /// o <c>login_negado</c>. Devolve a mensagem de recusa ou nulo.
    /// </summary>
    public async Task<string?> AbrirPeloLoginAsync(string usuario, string pin, CancellationToken ct = default)
    {
        Encerrar();
        var abertura = _abertura;
        var r = await autenticador.AutenticarParaCentralAsync(usuario, pin, relogio.Agora, ct);
        if (r.Operador is not { } operador)
        {
            // Como o LoginViewModel: quem testa PINs pela engrenagem do login aparece no historico_logins do ERP.
            await RegistrarLoginNegadoAsync(usuario, r, ct);
            return r.Erro ?? AutenticadorOffline.MensagemInvalido;
        }

        if (abertura != _abertura)
        {
            // Saiu (ou reabriu) enquanto o PIN era conferido: a resposta é de uma Central que já acabou.
            return MensagemFechada;
        }

        Usuario = operador;
        Origem = OrigemCentral.Login;
        await RegistrarAcessoAsync(operador, null, null, ct);
        return null;
    }

    /// <summary>
    /// A permissão vale na Central agora: do usuário ou, com a liberação ativa, emprestada do liberador (só as
    /// <see cref="AbasCentral.PermissoesLiberaveis"/>). Só consulta: não renova a liberação.
    /// </summary>
    public bool Tem(string permissao)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(permissao);
        return Usuario is { } usuario && (usuario.Tem(permissao) || Emprestada(permissao));
    }

    public bool PodeAbrir(AbaCentral aba)
    {
        ArgumentNullException.ThrowIfNull(aba);
        return Tem(aba.Permissao);
    }

    /// <summary>
    /// Quem autorizou a <paramref name="permissao"/>: o liberador quando ela só vale emprestada (vai no
    /// <c>autorizado_por_id</c> da auditoria da ação); nulo quando é do próprio usuário ou não vale.
    /// </summary>
    public Guid? AutorizadoPor(string permissao)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(permissao);
        return Usuario is { } usuario && !usuario.Tem(permissao) && Emprestada(permissao) ? _liberador!.Id : null;
    }

    /// <summary>Uso da Central (tecla, clique): renova a liberação ativa; a expirada não volta.</summary>
    public void RegistrarUso()
    {
        if (LiberacaoAtiva)
        {
            _ultimoUso = _tempo.GetTimestamp();
        }
        else
        {
            _liberador = null;
        }
    }

    /// <summary>
    /// Liberação na Central (Ctrl+L): ver o comentário da classe. Devolve a mensagem de recusa ou nulo; liberado, as abas
    /// a mais ficam em <see cref="AbasLiberadas"/>.
    /// </summary>
    public async Task<string?> LiberarAsync(string usuario, string pin, CancellationToken ct = default)
    {
        if (Usuario is not { } atual)
        {
            return MensagemFechada;
        }

        if (_mensagemSomenteLeitura is { } trava)
        {
            // D22: a liberação não grava a auditoria; nem confere o PIN (não gasta tentativa do bloqueio).
            return trava;
        }

        var abertura = _abertura;
        var r = await autenticador.AutenticarParaCentralAsync(usuario, pin, relogio.Agora, ct);
        if (abertura != _abertura)
        {
            return MensagemFechada;
        }

        if (r.Operador is not { } liberador)
        {
            // Inativo, sem loja e bloqueado dizem o motivo (o PIN já conferiu ou nem foi tentado), como na liberação 31.3.
            return r.Motivo is MotivoRecusa.UsuarioInativo or MotivoRecusa.LojaNaoPermitida or MotivoRecusa.Bloqueado
                ? $"{AutenticadorOffline.MensagemLiberacaoNegada}: {r.Erro}"
                : AutenticadorOffline.MensagemLiberacaoNegada;
        }

        if (liberador.Id == atual.Id)
        {
            return MensagemLiberadorProprio;
        }

        if (!liberador.Tem(PermissoesPdv.Supervisor))
        {
            return MensagemLiberadorNaoSupervisor;
        }

        var ganhas = Ganhas(atual, liberador);
        if (ganhas.Count == 0)
        {
            return MensagemNadaALiberar;
        }

        var abas = AbasCentral.Todas.Where(a => !atual.Tem(a.Permissao) && ganhas.Contains(a.Permissao)).Select(a => a.Rotulo).ToList();
        var depois = JsonSerializer.Serialize(new { origem = OrigemTexto, abas, permissoes = ganhas.Order(StringComparer.Ordinal) });
        try
        {
            await terminal.RegistrarAuditoriaAsync(
                "liberacao", atual.Id, Entidade, null,
                $"Central do PDV liberada por {liberador.Nome}" + (abas.Count > 0 ? $": {string.Join(", ", abas)}" : string.Empty),
                Localizacao, liberador.Id, ct, depois: depois);
        }
        catch (RegraNegocioException e)
        {
            // D22: sem a auditoria da liberação, não libera (a Central segue com o que o usuário já via).
            MarcarSomenteLeitura(abertura, e);
            return e.Message;
        }

        if (abertura != _abertura)
        {
            // Saiu da Central durante a gravação: a liberação acabou junto (o registro fica, como o de quem sai logo depois).
            return MensagemFechada;
        }

        _liberador = liberador;
        _ultimoUso = _tempo.GetTimestamp();
        _abasLiberadas = abas;
        // Um liberador novo vale como um acesso novo: a aba sensível aberta com ele grava de novo o central_acessada.
        _abasRegistradas.Clear();
        log.LogInformation("Central do PDV liberada ({Abas})", string.Join(", ", abas));
        return null;
    }

    /// <summary>
    /// A aba foi aberta: conta como uso da liberação (renova) e a sensível (<see cref="AbaCentral.RegistraAcesso"/>) grava
    /// o <see cref="AcaoCentralAcessada"/> uma vez por abertura da Central (e de novo depois de outra liberação), com quem
    /// liberou se a aba só abriu pela liberação; sem a permissão (a aba não abre), nada. Na desativação (D22) não grava e
    /// deixa a Central <see cref="SomenteLeitura"/>.
    /// </summary>
    public async Task RegistrarAberturaAsync(AbaCentral aba, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(aba);
        if (Usuario is not { } usuario || !PodeAbrir(aba))
        {
            return;
        }

        var propria = usuario.Tem(aba.Permissao);
        if (!propria)
        {
            RegistrarUso();
        }

        // Marca antes do await: a mesma aba apertada duas vezes seguidas não grava dois acessos.
        if (!aba.RegistraAcesso || !_abasRegistradas.Add(aba.Codigo))
        {
            return;
        }

        var abertura = _abertura;
        var gravado = false;
        try
        {
            gravado = await RegistrarAcessoAsync(usuario, aba, propria ? null : _liberador, ct);
        }
        finally
        {
            if (!gravado && abertura == _abertura)
            {
                _abasRegistradas.Remove(aba.Codigo);
            }
        }
    }

    /// <summary>Saiu da Central: a liberação acaba junto.</summary>
    public void Encerrar()
    {
        _abertura++;
        Usuario = null;
        _liberador = null;
        _abasRegistradas.Clear();
        _abasLiberadas = [];
        _mensagemSomenteLeitura = null;
    }

    private string OrigemTexto => Origem == OrigemCentral.Venda ? "venda" : "login";

    private bool Emprestada(string permissao) =>
        LiberacaoAtiva && AbasCentral.PermissoesLiberaveis.Contains(permissao) && _liberador!.Tem(permissao);

    private static List<string> Ganhas(Operador atual, Operador liberador) =>
        [.. AbasCentral.PermissoesLiberaveis.Where(p => !atual.Tem(p) && liberador.Tem(p))];

    private void MarcarSomenteLeitura(long abertura, RegraNegocioException e)
    {
        log.LogWarning("Central do PDV só leitura: terminal em desativação ({Erro})", e.Message);
        if (abertura == _abertura)
        {
            _mensagemSomenteLeitura = e.Message;
        }
    }

    private async Task<bool> RegistrarAcessoAsync(Operador usuario, AbaCentral? aba, Operador? liberador, CancellationToken ct)
    {
        var abertura = _abertura;
        var descricao = aba is null
            ? $"Central do PDV aberta pelo login por {usuario.Nome}"
            : $"Central do PDV: aba {aba.Rotulo} aberta" + (liberador is null ? string.Empty : $", liberada por {liberador.Nome}");
        var depois = JsonSerializer.Serialize(new { origem = OrigemTexto, aba = aba?.Rotulo });
        try
        {
            await terminal.RegistrarAuditoriaAsync(
                AcaoCentralAcessada, usuario.Id, Entidade, null, descricao, Localizacao, liberador?.Id, ct, depois: depois);
            return true;
        }
        catch (RegraNegocioException e)
        {
            MarcarSomenteLeitura(abertura, e);
            return false;
        }
    }

    private async Task RegistrarLoginNegadoAsync(string usuario, ResultadoLogin r, CancellationToken ct)
    {
        var informado = (usuario ?? string.Empty).Trim();
        try
        {
            // `login_informado` do `historico_logins` na nuvem (SYNC 9.22), como no LoginViewModel.
            await terminal.RegistrarAuditoriaAsync(
                "login_negado", r.UsuarioId, Entidade, null, $"Login negado para '{informado}' na Central do PDV", Localizacao, null, ct,
                motivo: r.Motivo, depois: JsonSerializer.Serialize(new { login_informado = informado }));
        }
        catch (RegraNegocioException e)
        {
            // D22: o gatilho recusa a auditoria; a recusa continua valendo (a Central não abre).
            log.LogWarning("Login negado na Central sem auditoria: terminal em desativação ({Erro})", e.Message);
        }
    }
}
