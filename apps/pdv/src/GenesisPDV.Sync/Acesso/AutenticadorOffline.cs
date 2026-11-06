using System.Globalization;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.Sync.Acesso;

/// <summary>
/// Operador que passou pelas regras do PDV 7.2, lido do espelho <c>usuarios</c>, com as permissões <c>pdv.*</c>
/// efetivas no momento do login (MD 3.3.4; Fase 1C, C10a): avaliadas localmente, offline (PDV 31.1).
/// </summary>
public sealed record UsuarioAutenticado(
    Guid Id,
    int Codigo,
    string Login,
    string Nome,
    decimal LimiteDescontoPct,
    bool Master,
    bool PdvUtilitario,
    int PermissoesVersao)
{
    public IReadOnlySet<string> Permissoes { get; init; } = new HashSet<string>(StringComparer.Ordinal);

    /// <summary>Permissão efetiva; Usuário Master tem todas (MD 3.3.4).</summary>
    public bool Tem(string permissao) => Master || Permissoes.Contains(permissao);
}

/// <summary>Resultado da liberação por supervisor (PDV 31.3): o supervisor que liberou ou a recusa.</summary>
public sealed record ResultadoLiberacao(UsuarioAutenticado? Supervisor, string? Erro)
{
    public static ResultadoLiberacao Negada(string erro) => new(null, erro);
}

/// <summary>
/// <c>motivo_falha</c> do <c>historico_logins</c> (MD 3.3.6; <c>MOTIVOS_FALHA_LOGIN</c> do shared e o check da nuvem)
/// que o login offline grava. Os três últimos são recusas próprias do caixa. Valor fora da lista da nuvem derrubaria o
/// <c>auditoria.registros</c> inteiro no push: a fixture <c>auditoria.registros.payload.json</c> confere os dois lados.
/// </summary>
public static class MotivoRecusa
{
    public const string SenhaInvalida = "senha_invalida";
    public const string Bloqueado = "bloqueado";
    public const string UsuarioInativo = "usuario_inativo";
    public const string LojaNaoPermitida = "loja_nao_permitida";
    public const string SemAcessoPdv = "sem_acesso_pdv";
    public const string Totem = "totem";
    public const string HashForaDosLimites = "hash_fora_dos_limites";

    public static IReadOnlyList<string> Todos { get; } =
        [SenhaInvalida, Bloqueado, UsuarioInativo, LojaNaoPermitida, SemAcessoPdv, Totem, HashForaDosLimites];
}

/// <summary>Resultado do login offline. <paramref name="Motivo"/> é um dos <see cref="MotivoRecusa"/>.</summary>
public sealed record ResultadoAutenticacao(UsuarioAutenticado? Usuario, string? Erro, string? Motivo, Guid? UsuarioId)
{
    public static ResultadoAutenticacao Recusado(string erro, string motivo, Guid? usuarioId = null) => new(null, erro, motivo, usuarioId);
}

/// <summary>
/// Login do operador pelo PIN do PDV, sempre local (PDV 7.2; SYNC 4): lê os espelhos do fluxo <c>acesso</c> e aplica as
/// regras na ordem — 1 usuário existe (login ou código), 7 bloqueio local, 2 PIN confere com <c>senha_pdv_hash</c>
/// (argon2id, <see cref="VerificadorArgon2"/>), 3 ativo (a nuvem já desce <c>ativo = false</c> a partir da demissão,
/// D19), 4 loja do terminal permitida ou Master, 5 <c>pdv.acesso.entrar</c> (negar do usuário vence conceder; Master
/// tem tudo) e 6 não é totem. O bloqueio da regra 7 é <b>deste terminal</b> e persiste em <c>bloqueios_senha_local</c>:
/// 5 PINs errados seguidos (dentro de 5 min) bloqueiam o usuário por 5 min; o acerto zera. Hash fora dos limites vira
/// "Usuário ou senha inválidos", com aviso em <c>log_local</c> e auditoria <c>hash_fora_dos_limites</c>.
/// </summary>
public sealed class AutenticadorOffline(
    IDbContextFactory<PdvDbContext> fabrica,
    RepositorioTerminal terminal,
    ILogger<AutenticadorOffline> log)
{
    public const int TentativasMaximas = 5;

    /// <summary>Ação de auditoria do hash fora dos limites (SYNC 4.2; está em <c>ACOES_AUDITORIA</c> do shared).</summary>
    public const string AcaoHashForaDosLimites = "hash_fora_dos_limites";
    public static readonly TimeSpan JanelaTentativas = TimeSpan.FromMinutes(5);
    public static readonly TimeSpan TempoBloqueio = TimeSpan.FromMinutes(5);

    /// <summary>Contagem de erros sem corrida entre dois Enter seguidos.</summary>
    private static readonly SemaphoreSlim Gravacao = new(1, 1);

    public const string MensagemInvalido = "Usuário ou senha inválidos";
    public const string MensagemBloqueado = "Muitas tentativas. Aguarde 5 min ou peça ao supervisor.";
    public const string MensagemInativo = "Usuário inativo";
    public const string MensagemSemLoja = "Usuário sem permissão nesta loja";
    public const string MensagemSemAcesso = "Usuário sem acesso ao PDV";
    public const string MensagemTotem = "Usuário de totem não opera o PDV";

    public async Task<ResultadoAutenticacao> AutenticarAsync(string usuario, string pin, Guid lojaId, DateTimeOffset agora, CancellationToken ct = default)
    {
        var informado = (usuario ?? string.Empty).Trim();
        if (informado.Length == 0 || string.IsNullOrEmpty(pin))
        {
            return ResultadoAutenticacao.Recusado(MensagemInvalido, MotivoRecusa.SenhaInvalida);
        }

        // Regra 1: login (sem diferenciar maiúsculas) ou código numérico, entre os não excluídos.
        UsuarioRegistro? u;
        await using (var db = await fabrica.CreateDbContextAsync(ct))
        {
            // Usuários são poucas dezenas por empresa (SYNC 4.1): a comparação sem maiúsculas fica em memória.
            var porCodigo = int.TryParse(informado, NumberStyles.None, CultureInfo.InvariantCulture, out var codigo) ? codigo : (int?)null;
            var vivos = await db.Usuarios.AsNoTracking().Where(x => x.ExcluidoEm == null).ToListAsync(ct);
            u = vivos.FirstOrDefault(x => string.Equals(x.Login, informado, StringComparison.OrdinalIgnoreCase))
                ?? vivos.FirstOrDefault(x => porCodigo == x.Codigo);
        }

        if (u is null)
        {
            return ResultadoAutenticacao.Recusado(MensagemInvalido, MotivoRecusa.SenhaInvalida);
        }

        // Regra 7 antes do PIN: bloqueado não chega a verificar (sem força bruta offline pela tela).
        if (await BloqueadoAteAsync(u.Id, ct) is { } ate && ate > agora)
        {
            return ResultadoAutenticacao.Recusado(MensagemBloqueado, MotivoRecusa.Bloqueado, u.Id);
        }

        // Regra 2.
        var verificacao = await VerificadorArgon2.VerificarAsync(u.SenhaPdvHash, pin, ct);
        if (verificacao == ResultadoVerificacao.ForaDosLimites)
        {
            if (u.SenhaPdvHash is not null)
            {
                log.LogWarning("PIN do usuário {Usuario} com hash fora dos limites da SYNC 4.2: não loga offline", u.Id);
                await terminal.RegistrarOcorrenciaAsync(
                    NiveisOcorrencia.Aviso, CodigoOcorrencia.PinForaDosLimites, "Hash do PIN fora dos limites (SYNC 4.2)",
                    dados: new System.Text.Json.Nodes.JsonObject { ["usuario_id"] = u.Id.ToString() }, ct: ct);
                await terminal.RegistrarAuditoriaAsync(
                    AcaoHashForaDosLimites, u.Id, entidade: "usuarios", registroId: u.Id,
                    descricao: "PIN com parâmetros argon2 fora dos limites aceitos pelo PDV", localizacao: "pdv.login", ct: ct);
            }

            // PIN nulo (sem a loja, modo perdido) ou hash recusado: mesma mensagem genérica, sem contar tentativa.
            return ResultadoAutenticacao.Recusado(MensagemInvalido, u.SenhaPdvHash is null ? MotivoRecusa.SenhaInvalida : MotivoRecusa.HashForaDosLimites, u.Id);
        }

        if (verificacao == ResultadoVerificacao.NaoConfere)
        {
            var bloqueou = await RegistrarErroAsync(u.Id, agora, ct);
            return bloqueou
                ? ResultadoAutenticacao.Recusado(MensagemBloqueado, MotivoRecusa.Bloqueado, u.Id)
                : ResultadoAutenticacao.Recusado(MensagemInvalido, MotivoRecusa.SenhaInvalida, u.Id);
        }

        await LimparErrosAsync(u.Id, ct);

        // Regras 3–6 (o PIN já conferiu: a mensagem pode ser específica).
        if (!u.Ativo)
        {
            return ResultadoAutenticacao.Recusado(MensagemInativo, MotivoRecusa.UsuarioInativo, u.Id);
        }

        HashSet<string> permissoes;
        await using (var db = await fabrica.CreateDbContextAsync(ct))
        {
            if (!u.Master && !await db.UsuariosLojas.AsNoTracking().AnyAsync(l => l.UsuarioId == u.Id && l.LojaId == lojaId && l.ExcluidoEm == null, ct))
            {
                return ResultadoAutenticacao.Recusado(MensagemSemLoja, MotivoRecusa.LojaNaoPermitida, u.Id);
            }

            // Um conjunto só: a regra 5 e as permissões do caixa saem da mesma conta (MD 3.3.4).
            permissoes = await PermissoesPdvAsync(db, u, ct);
            if (!u.Master && !permissoes.Contains(PermissoesPdv.Entrar))
            {
                return ResultadoAutenticacao.Recusado(MensagemSemAcesso, MotivoRecusa.SemAcessoPdv, u.Id);
            }
        }

        if (u.Totem)
        {
            return ResultadoAutenticacao.Recusado(MensagemTotem, MotivoRecusa.Totem, u.Id);
        }

        return new ResultadoAutenticacao(Autenticado(u, permissoes), null, null, u.Id);
    }

    public const string MensagemLiberacaoNegada = "Liberação negada";
    public const string MensagemLiberadorSemPermissao = "Liberação negada: o supervisor não tem esta permissão.";
    public const string MensagemLiberadorProprio = "Liberação negada: o supervisor não pode ser o próprio operador.";

    /// <summary>
    /// Liberação por supervisor (PDV 31.3; Fase 1C, C10a), validada <b>só pelo PIN</b> (igual online e offline; a senha do
    /// ERP não vale aqui), com as regras do login (1 usuário, 7 bloqueio local, 2 PIN — o erro conta no mesmo bloqueio —,
    /// 3 ativo, 4 loja permitida) e as do liberador: <c>pdv.supervisor</c>, a permissão da ação e não ser o próprio
    /// operador. A liberação vale só para aquela ação. PIN errado devolve <see cref="MensagemLiberacaoNegada"/> (a tela
    /// fecha o diálogo no terceiro erro).
    /// </summary>
    public async Task<ResultadoLiberacao> LiberarAsync(
        string usuario, string pin, Guid lojaId, string permissao, Guid operadorId, DateTimeOffset agora, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(permissao);
        var login = await AutenticarAsync(usuario, pin, lojaId, agora, ct);
        if (login.Usuario is not { } supervisor)
        {
            // Inativo, sem loja e bloqueado dizem o motivo (o PIN já conferiu ou nem foi tentado); o resto é genérico.
            return ResultadoLiberacao.Negada(login.Motivo is MotivoRecusa.UsuarioInativo or MotivoRecusa.LojaNaoPermitida or MotivoRecusa.Bloqueado
                ? $"{MensagemLiberacaoNegada}: {login.Erro}"
                : MensagemLiberacaoNegada);
        }

        if (supervisor.Id == operadorId)
        {
            return ResultadoLiberacao.Negada(MensagemLiberadorProprio);
        }

        return supervisor.Tem(PermissoesPdv.Supervisor) && supervisor.Tem(permissao)
            ? new ResultadoLiberacao(supervisor, null)
            : ResultadoLiberacao.Negada(MensagemLiberadorSemPermissao);
    }

    /// <summary>
    /// Permissões <c>pdv.*</c> efetivas (MD 3.3.4, <c>calcularPermissoesEfetivas</c> do shared): (perfil ∪ concedidas do
    /// usuário) − negadas do usuário — negar do usuário vence; conceder do usuário ou do perfil vale. O Master tem todas,
    /// mas o conjunto não as lista: quem pergunta confere o <c>Master</c> antes (<c>UsuarioAutenticado.Tem</c>).
    /// </summary>
    public static async Task<HashSet<string>> PermissoesPdvAsync(PdvDbContext db, UsuarioRegistro u, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(u);
        var doUsuario = await db.UsuariosPermissoes.AsNoTracking()
            .Where(p => p.UsuarioId == u.Id && p.ExcluidoEm == null && p.Permissao.StartsWith("pdv."))
            .Select(p => new { p.Permissao, p.Efeito }).ToListAsync(ct);
        var efetivas = new HashSet<string>(StringComparer.Ordinal);
        if (u.PerfilId is { } perfil)
        {
            efetivas.UnionWith(await db.PerfisPermissoes.AsNoTracking()
                .Where(p => p.PerfilId == perfil && p.ExcluidoEm == null && p.Permissao.StartsWith("pdv."))
                .Select(p => p.Permissao).ToListAsync(ct));
        }

        efetivas.UnionWith(doUsuario.Where(p => p.Efeito == "conceder").Select(p => p.Permissao));
        efetivas.ExceptWith(doUsuario.Where(p => p.Efeito == "negar").Select(p => p.Permissao));
        return efetivas;
    }

    private static UsuarioAutenticado Autenticado(UsuarioRegistro u, HashSet<string> permissoes) =>
        new(u.Id, u.Codigo, u.Login, u.Nome, u.LimiteDescontoPct, u.Master, u.PdvUtilitario, u.PermissoesVersao) { Permissoes = permissoes };

    private async Task<DateTimeOffset?> BloqueadoAteAsync(Guid usuarioId, CancellationToken ct)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.BloqueiosSenhaLocal.AsNoTracking()
            .Where(b => b.Tipo == BloqueioSenhaLocal.TipoUsuario && b.RegistroId == usuarioId)
            .Select(b => b.BloqueadoAte).FirstOrDefaultAsync(ct);
    }

    /// <summary>Conta o erro (janela de 5 min desde o primeiro); no quinto, bloqueia por 5 min. Devolve se bloqueou.</summary>
    private async Task<bool> RegistrarErroAsync(Guid usuarioId, DateTimeOffset agora, CancellationToken ct)
    {
        await Gravacao.WaitAsync(ct);
        try
        {
            await using var db = await fabrica.CreateDbContextAsync(ct);
            var linha = await db.BloqueiosSenhaLocal.FirstOrDefaultAsync(b => b.Tipo == BloqueioSenhaLocal.TipoUsuario && b.RegistroId == usuarioId, ct);
            if (linha is null)
            {
                linha = new BloqueioSenhaLocal { Tipo = BloqueioSenhaLocal.TipoUsuario, RegistroId = usuarioId };
                db.BloqueiosSenhaLocal.Add(linha);
            }

            if (linha.PrimeiraFalhaEm is not { } primeira || agora - primeira > JanelaTentativas || linha.BloqueadoAte is not null)
            {
                linha.Tentativas = 0;
                linha.PrimeiraFalhaEm = agora;
                linha.BloqueadoAte = null;
            }

            linha.Tentativas++;
            linha.AtualizadoEm = agora;
            var bloqueou = linha.Tentativas >= TentativasMaximas;
            if (bloqueou)
            {
                linha.BloqueadoAte = agora + TempoBloqueio;
            }

            await db.SaveChangesAsync(ct);
            return bloqueou;
        }
        finally
        {
            Gravacao.Release();
        }
    }

    private async Task LimparErrosAsync(Guid usuarioId, CancellationToken ct)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await db.BloqueiosSenhaLocal
            .Where(b => b.Tipo == BloqueioSenhaLocal.TipoUsuario && b.RegistroId == usuarioId)
            .ExecuteDeleteAsync(ct);
    }
}
