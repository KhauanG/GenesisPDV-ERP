using GenesisPDV.App.Servicos;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Sync.Acesso;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// O autenticador do terminal de demonstração com mais dois usuários, para os perfis que a MARIA (operadora) e o CARLOS
/// (Master) não cobrem: o TECNICO, com <c>pdv.config.terminal</c> sem <c>pdv.supervisor</c> (um perfil personalizado), e
/// o ENCARREGADO (PC-8), supervisor que vê os caixas fechados e o diagnóstico e cancela a venda paga do caixa aberto (dono,
/// 05/11/2026; decisão 78), mas não vê o Histórico de uso; o CONFERENTE, um perfil personalizado que vê as vendas do caixa
/// aberto e os fechamentos e reimprime, sem o histórico de vendas nem o calculado; e o SUPERVISOR, o Supervisor de caixa
/// que libera a venda em andamento, mas não a paga. As mesmas regras do <see cref="AutenticadorOffline.LiberarAsync"/>; o resto vai para o
/// autenticador de verdade.
/// </summary>
internal sealed class AutenticadorComExtras(IAutenticadorOperador real) : IAutenticadorOperador
{
    public const string PinTecnico = "5555";
    public const string PinEncarregado = "6666";
    public const string PinConferente = "7777";
    public const string PinSupervisor = "8888";

    public static readonly Operador Tecnico = new(
        Guid.Parse("019a0003-0000-7000-8000-000000000003"), 3, "tecnico", "TECNICO", 0m,
        Permissoes: new HashSet<string>(StringComparer.Ordinal) { PermissoesPdv.Entrar, PermissoesPdv.ConfigTerminal });

    public static readonly Operador Encarregado = new(
        Guid.Parse("019a0003-0000-7000-8000-000000000004"), 4, "encarregado", "ENCARREGADO", 0m,
        Permissoes: new HashSet<string>(StringComparer.Ordinal)
        {
            PermissoesPdv.Entrar, PermissoesPdv.Supervisor, PermissoesPdv.ConsultarFechamentos, PermissoesPdv.VerDiagnostico,
            PermissoesPdv.CancelarVendaFinalizada,
        });

    public static readonly Operador Conferente = new(
        Guid.Parse("019a0003-0000-7000-8000-000000000005"), 5, "conferente", "CONFERENTE", 0m,
        Permissoes: new HashSet<string>(StringComparer.Ordinal)
        {
            PermissoesPdv.Entrar, PermissoesPdv.ConsultarVendas, PermissoesPdv.ConsultarFechamentos, PermissoesPdv.Reimprimir,
        });

    public static readonly Operador SupervisorCaixa = new(
        Guid.Parse("019a0003-0000-7000-8000-000000000006"), 6, "supervisor", "SUPERVISOR", 0m,
        Permissoes: new HashSet<string>(StringComparer.Ordinal)
        {
            PermissoesPdv.Entrar, PermissoesPdv.Supervisor, PermissoesPdv.CancelarVendaAberta, PermissoesPdv.CancelarItem,
        });

    private static readonly (Operador Operador, string Pin)[] Extras =
        [(Tecnico, PinTecnico), (Encarregado, PinEncarregado), (Conferente, PinConferente), (SupervisorCaixa, PinSupervisor)];

    /// <summary>Troca o <see cref="IAutenticadorOperador"/> pelo <c>ajustar</c> do <see cref="AmbienteUi"/>.</summary>
    public static void Registrar(IServiceCollection servicos) =>
        servicos.AddSingleton<IAutenticadorOperador>(sp => new AutenticadorComExtras(new AutenticadorEspelho(
            sp.GetRequiredService<AutenticadorOffline>(), sp.GetRequiredService<SessaoTerminal>(),
            sp.GetRequiredService<AutenticadorOperadorSimulado>())));

    public Task<ResultadoLogin> AutenticarAsync(string usuario, string senha, DateTimeOffset agora, CancellationToken ct = default) =>
        Extra(usuario) is { } e
            ? Task.FromResult(e.Pin == senha ? new ResultadoLogin(e.Operador, null) : new ResultadoLogin(null, AutenticadorOffline.MensagemInvalido))
            : real.AutenticarAsync(usuario, senha, agora, ct);

    public Task<ResultadoLogin> AutenticarParaCentralAsync(string usuario, string pin, DateTimeOffset agora, CancellationToken ct = default) =>
        Extra(usuario) is not null ? AutenticarAsync(usuario, pin, agora, ct) : real.AutenticarParaCentralAsync(usuario, pin, agora, ct);

    public Task<ResultadoLiberacaoSupervisor> LiberarAsync(
        string usuario, string pin, string permissao, Guid operadorId, DateTimeOffset agora, CancellationToken ct = default)
    {
        if (Extra(usuario) is not { } e)
        {
            return real.LiberarAsync(usuario, pin, permissao, operadorId, agora, ct);
        }

        var erro = e.Pin != pin ? AutenticadorOffline.MensagemLiberacaoNegada
            : e.Operador.Id == operadorId ? AutenticadorOffline.MensagemLiberadorProprio
            : e.Operador.Tem(PermissoesPdv.Supervisor) && e.Operador.Tem(permissao) ? null
            : AutenticadorOffline.MensagemLiberadorSemPermissao;
        return Task.FromResult(new ResultadoLiberacaoSupervisor(erro is null ? e.Operador : null, erro));
    }

    private static (Operador Operador, string Pin)? Extra(string usuario)
    {
        var u = (usuario ?? string.Empty).Trim();
        foreach (var e in Extras)
        {
            if (string.Equals(e.Operador.Login, u, StringComparison.OrdinalIgnoreCase)
                || e.Operador.Codigo.ToString(System.Globalization.CultureInfo.InvariantCulture) == u)
            {
                return e;
            }
        }

        return null;
    }
}
