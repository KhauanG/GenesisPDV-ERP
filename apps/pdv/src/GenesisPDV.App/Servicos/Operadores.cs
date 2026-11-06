using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Sync.Acesso;

namespace GenesisPDV.App.Servicos;

/// <param name="Permissoes">Permissões <c>pdv.*</c> efetivas no login (Fase 1C, C10a); nulo = nenhuma.</param>
public sealed record Operador(
    Guid Id, int Codigo, string Login, string Nome, decimal LimiteDescontoPct, bool Master = false, bool PdvUtilitario = false,
    IReadOnlySet<string>? Permissoes = null)
{
    /// <summary>Limite usado na venda: Master = 100% (PDV 12.3).</summary>
    public decimal LimiteDescontoEfetivoPct => LimiteDesconto.DoUsuario(LimiteDescontoPct, Master);

    /// <summary>Permissão efetiva, avaliada localmente (PDV 31.1); Usuário Master tem todas.</summary>
    public bool Tem(string permissao) => Master || (Permissoes?.Contains(permissao) ?? false);

    public static Operador De(UsuarioAutenticado u)
    {
        ArgumentNullException.ThrowIfNull(u);
        return new Operador(u.Id, u.Codigo, u.Login, u.Nome, u.LimiteDescontoPct, u.Master, u.PdvUtilitario, u.Permissoes);
    }
}

/// <summary>Liberação concedida (PDV 31.3): o supervisor e o motivo, para <c>autorizado_por_id</c> e a auditoria.</summary>
public sealed record LiberacaoConcedida(Operador Supervisor, string Motivo, DateTimeOffset ConcedidaEm);

/// <summary>Resultado do diálogo de liberação: o supervisor ou a mensagem de recusa.</summary>
public sealed record ResultadoLiberacaoSupervisor(Operador? Supervisor, string? Erro);

/// <param name="Motivo">Motivo da recusa para a auditoria local (<c>motivo_falha</c>, MD 3.3.6); nulo no sucesso.</param>
/// <param name="UsuarioId">Usuário identificado mesmo na recusa (auditoria de <c>login_negado</c>).</param>
public sealed record ResultadoLogin(Operador? Operador, string? Erro, string? Motivo = null, Guid? UsuarioId = null);

/// <summary>Login do operador (PDV 7.2): sempre validado localmente, igual online e offline.</summary>
public interface IAutenticadorOperador
{
    Task<ResultadoLogin> AutenticarAsync(string usuario, string senha, DateTimeOffset agora, CancellationToken ct = default);

    /// <summary>
    /// Liberação por supervisor (PDV 31.3): login/código e PIN de quem tem <c>pdv.supervisor</c> e a
    /// <paramref name="permissao"/> da ação, que não seja o próprio <paramref name="operadorId"/>; só pelo PIN, offline.
    /// </summary>
    Task<ResultadoLiberacaoSupervisor> LiberarAsync(
        string usuario, string pin, string permissao, Guid operadorId, DateTimeOffset agora, CancellationToken ct = default);

    /// <summary>
    /// Quem entra na Central do PDV pelo login ou libera abas nela (Central do PDV, bloco G2; README › decisão 67): o PIN
    /// pelas mesmas regras do <see cref="AutenticarAsync"/> (usuário, bloqueio por tentativas — o erro conta no mesmo
    /// bloqueio do login —, PIN, ativo, loja, <c>pdv.acesso.entrar</c>, não totem), devolvendo o operador com o conjunto
    /// de permissões efetivas. <b>Não abre sessão de operador</b>: não troca o operador logado, não grava o <c>login</c>
    /// nem mexe no caixa; quem decide as abas e grava a auditoria é o <see cref="Diagnostico.AcessoCentral"/>.
    /// </summary>
    Task<ResultadoLogin> AutenticarParaCentralAsync(string usuario, string pin, DateTimeOffset agora, CancellationToken ct = default);
}

/// <summary>
/// Login pelo PIN do PDV contra o espelho do fluxo <c>acesso</c> (<see cref="AutenticadorOffline"/>: regras 1–7 do PDV
/// 7.2, argon2id e bloqueio persistido), na loja do terminal ativado. O terminal de demonstração (F8) usa os operadores
/// simulados quando o build tem <c>MODO_DEMONSTRACAO</c>; sem eles, ninguém entra nele.
/// </summary>
public sealed class AutenticadorEspelho(AutenticadorOffline offline, SessaoTerminal sessao, IAutenticadorOperador? demonstracao = null)
    : IAutenticadorOperador
{
    public async Task<ResultadoLogin> AutenticarAsync(string usuario, string senha, DateTimeOffset agora, CancellationToken ct = default)
    {
        if (sessao.Identidade is not { } identidade)
        {
            return new ResultadoLogin(null, "Terminal não ativado.");
        }

        if (identidade.Demonstracao)
        {
            return demonstracao is null
                ? new ResultadoLogin(null, AutenticadorOffline.MensagemInvalido, "senha_invalida")
                : await demonstracao.AutenticarAsync(usuario, senha, agora, ct);
        }

        var r = await offline.AutenticarAsync(usuario, senha, identidade.LojaId, agora, ct);
        return r.Usuario is { } u
            ? new ResultadoLogin(Operador.De(u), null, null, u.Id)
            : new ResultadoLogin(null, r.Erro, r.Motivo, r.UsuarioId);
    }

    public async Task<ResultadoLiberacaoSupervisor> LiberarAsync(
        string usuario, string pin, string permissao, Guid operadorId, DateTimeOffset agora, CancellationToken ct = default)
    {
        if (sessao.Identidade is not { } identidade)
        {
            return new ResultadoLiberacaoSupervisor(null, "Terminal não ativado.");
        }

        if (identidade.Demonstracao)
        {
            return demonstracao is null
                ? new ResultadoLiberacaoSupervisor(null, AutenticadorOffline.MensagemLiberacaoNegada)
                : await demonstracao.LiberarAsync(usuario, pin, permissao, operadorId, agora, ct);
        }

        var r = await offline.LiberarAsync(usuario, pin, identidade.LojaId, permissao, operadorId, agora, ct);
        return new ResultadoLiberacaoSupervisor(r.Supervisor is { } s ? Operador.De(s) : null, r.Erro);
    }

    /// <summary>
    /// As mesmas regras e o mesmo bloqueio do <see cref="AutenticarAsync"/>: aqui ele só confere o PIN e monta o operador
    /// (quem abre a sessão, grava o <c>login</c> e segue para o caixa é o <c>LoginViewModel</c>).
    /// </summary>
    public Task<ResultadoLogin> AutenticarParaCentralAsync(string usuario, string pin, DateTimeOffset agora, CancellationToken ct = default) =>
        AutenticarAsync(usuario, pin, agora, ct);
}

#if MODO_DEMONSTRACAO
/// <summary>
/// Operadores de demonstração da Fase 0 (só compilados com <c>MODO_DEMONSTRACAO</c>; nunca num <c>dotnet publish</c>
/// padrão), só para o terminal de demonstração (F8). O terminal ativado de verdade usa o <see cref="AutenticadorEspelho"/>.
/// </summary>
public sealed class AutenticadorOperadorSimulado : IAutenticadorOperador
{
    public const int TentativasMaximas = 5;
    public static readonly TimeSpan TempoBloqueio = TimeSpan.FromMinutes(5);

    private static readonly (Operador Operador, string Senha)[] Usuarios =
    [
        (new Operador(Guid.Parse("019a0003-0000-7000-8000-000000000001"), 1, "maria", "MARIA", 10m, Permissoes: PermissoesPdv.PerfilOperador), "1234"),
        (new Operador(Guid.Parse("019a0003-0000-7000-8000-000000000002"), 2, "carlos", "CARLOS", 100m, Master: true), "4321"),
    ];

    private readonly Dictionary<Guid, (int Erros, DateTimeOffset? BloqueadoAte)> _tentativas = [];

    /// <summary>Os operadores simulados ("Quem retira" pelo F2 da sangria no terminal de demonstração).</summary>
    public static IReadOnlyList<Operador> Operadores => [.. Usuarios.Select(u => u.Operador)];

    /// <summary>Nome do operador simulado (diálogo da sessão de outro operador e relatório do fechamento).</summary>
    public static string? NomeDe(Guid id) => Usuarios.FirstOrDefault(u => u.Operador.Id == id).Operador?.Nome;

    public Task<ResultadoLogin> AutenticarAsync(string usuario, string senha, DateTimeOffset agora, CancellationToken ct = default) =>
        Task.FromResult(Autenticar(usuario, senha, agora));

    public Task<ResultadoLogin> AutenticarParaCentralAsync(string usuario, string pin, DateTimeOffset agora, CancellationToken ct = default) =>
        Task.FromResult(Autenticar(usuario, pin, agora));

    private ResultadoLogin Autenticar(string usuario, string senha, DateTimeOffset agora)
    {
        var u = (usuario ?? string.Empty).Trim();
        var encontrado = Usuarios.FirstOrDefault(x =>
            string.Equals(x.Operador.Login, u, StringComparison.OrdinalIgnoreCase)
            || x.Operador.Codigo.ToString(System.Globalization.CultureInfo.InvariantCulture) == u);
        if (encontrado.Operador is null)
        {
            return new ResultadoLogin(null, "Usuário ou senha inválidos");
        }

        var id = encontrado.Operador.Id;
        _tentativas.TryGetValue(id, out var t);
        if (t.BloqueadoAte is { } ate && ate > agora)
        {
            return new ResultadoLogin(null, "Muitas tentativas. Aguarde 5 min ou peça ao supervisor.");
        }

        if (encontrado.Senha != senha)
        {
            var erros = t.Erros + 1;
            _tentativas[id] = erros >= TentativasMaximas ? (0, agora + TempoBloqueio) : (erros, null);
            return new ResultadoLogin(null, erros >= TentativasMaximas
                ? "Muitas tentativas. Aguarde 5 min ou peça ao supervisor."
                : "Usuário ou senha inválidos");
        }

        _tentativas.Remove(id);
        return new ResultadoLogin(encontrado.Operador, null);
    }

    /// <summary>Mesmas regras do <see cref="AutenticadorOffline.LiberarAsync"/>, com os operadores simulados (CARLOS libera).</summary>
    public Task<ResultadoLiberacaoSupervisor> LiberarAsync(
        string usuario, string pin, string permissao, Guid operadorId, DateTimeOffset agora, CancellationToken ct = default)
    {
        var login = Autenticar(usuario, pin, agora);
        if (login.Operador is not { } supervisor)
        {
            return Task.FromResult(new ResultadoLiberacaoSupervisor(null, AutenticadorOffline.MensagemLiberacaoNegada));
        }

        var erro = supervisor.Id == operadorId ? AutenticadorOffline.MensagemLiberadorProprio
            : supervisor.Tem(PermissoesPdv.Supervisor) && supervisor.Tem(permissao) ? null
            : AutenticadorOffline.MensagemLiberadorSemPermissao;
        return Task.FromResult(new ResultadoLiberacaoSupervisor(erro is null ? supervisor : null, erro));
    }
}
#endif
