using System.Text.Json;
using System.Text.Json.Nodes;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Acesso;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels;

/// <summary>
/// A tela bloqueada (PDV 7.4; Central do PDV, bloco G11; PC-13; README › decisão 75): no lugar da venda, depois do
/// <c>tela.bloqueio_inatividade_min</c> sem tecla nem mouse (desligado por padrão) ou pelo F11 › 7 / Ctrl+Alt+B. A venda
/// em andamento fica como estava (a tela de venda é a mesma, guardada aqui): nada é cancelado nem gravado de novo. Só
/// desbloqueia o <b>PIN do operador logado</b> (as regras e o bloqueio por tentativas do login, sem abrir outra sessão)
/// ou, com F2, o usuário e o PIN de um <b>supervisor</b> (<c>pdv.supervisor</c>, que não seja o próprio operador). O
/// desbloqueio pelo PIN grava a ação local <see cref="BloqueioTela.AcaoDesbloqueio"/>; o do supervisor, a
/// <c>liberacao</c> (sobe, com ele no <c>autorizado_por_id</c>); o PIN recusado, o <c>login_negado</c> (sobe e vira
/// <c>historico_logins</c> no ERP: quem testa PINs num caixa bloqueado aparece lá, como no login e na Central). O que não
/// tem cara de PIN (4 a 8 dígitos; o leitor de código de barras bipando no campo, 13 dígitos e o Enter) é recusado aqui,
/// sem conferir: não conta tentativa nem bloqueia a operadora por tentativas. A auditoria recusada (D22) não prende
/// ninguém na tela. Tudo também pelo mouse; Esc limpa o PIN ou volta do supervisor.
/// </summary>
public sealed partial class TelaBloqueadaViewModel : ViewModelBase
{
    public const string MensagemPinErrado = "PIN incorreto. Digite o PIN de quem está no caixa ou peça ao supervisor (F2).";

    public const string MensagemNaoEPin = "O PIN tem de 4 a 8 números (um código de barras bipado aqui não conta como tentativa). Digite o PIN.";

    public const int PinMinimo = 4;
    public const int PinMaximo = 8;

    private readonly ShellViewModel _shell;
    private readonly VendaViewModel? _venda;
    private bool _desbloqueada;

    /// <param name="venda">A tela de venda que estava na frente (volta a ela, com a venda como estava); nula, a venda é carregada de novo.</param>
    /// <param name="como"><see cref="BloqueioTela.ComoInatividade"/> ou <see cref="BloqueioTela.ComoManual"/>.</param>
    public TelaBloqueadaViewModel(ShellViewModel shell, Operador operador, VendaViewModel? venda, string como, int minutos, DateTimeOffset em)
    {
        _shell = shell;
        _venda = venda;
        Operador = operador;
        Como = como;
        var hora = TimeZoneInfo.ConvertTime(em, DiaOperacional.ObterFuso(shell.Servico<SessaoTerminal>().FusoHorario)).ToString("HH:mm", NumeroBr.Cultura);
        Descricao = como == BloqueioTela.ComoInatividade
            ? $"Bloqueada às {hora}, depois de {minutos} min sem uso."
            : $"Bloqueada por {operador.Nome} às {hora}.";
        VendaTexto = shell.Servico<ServicoVenda>().VendaAberta
            ? "A venda em andamento está guardada: ela continua do mesmo ponto depois do desbloqueio."
            : null;
    }

    public Operador Operador { get; }

    public string Como { get; }

    public string Titulo => "Tela bloqueada";

    public string OperadorTexto => $"Caixa de {Operador.Nome}";

    public string Descricao { get; }

    public string? VendaTexto { get; }

    /// <summary>F2: o supervisor desbloqueia (usuário e PIN).</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(PeloPin), nameof(Rodape))]
    public partial bool PeloSupervisor { get; set; }

    public bool PeloPin => !PeloSupervisor;

    [ObservableProperty]
    public partial string Pin { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string UsuarioSupervisor { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string PinSupervisor { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [ObservableProperty]
    public partial bool Verificando { get; set; }

    public string Rodape => PeloSupervisor
        ? "Enter desbloqueia com o supervisor · Esc volta ao PIN do operador"
        : "Enter desbloqueia · F2 o supervisor desbloqueia · Esc limpa o PIN";

    /// <summary>A tela leva o foco ao PIN do operador ou ao usuário do supervisor.</summary>
    public event EventHandler? FocoSolicitado;

    [RelayCommand]
    private async Task DesbloquearAsync()
    {
        if (Verificando || _desbloqueada)
        {
            return;
        }

        if (!PareceUmPin(PeloSupervisor ? PinSupervisor : Pin))
        {
            Pin = string.Empty;
            PinSupervisor = string.Empty;
            Erro = MensagemNaoEPin;
            FocoSolicitado?.Invoke(this, EventArgs.Empty);
            return;
        }

        var autenticador = _shell.Servico<IAutenticadorOperador>();
        var agora = _shell.Servico<IRelogio>().Agora;
        Operador? supervisor = null;
        string? erro;
        Verificando = true;
        try
        {
            // argon2id fora da thread da tela; o erro conta no mesmo bloqueio por tentativas do login (PDV 7.2, regra 7).
            if (PeloSupervisor)
            {
                var r = await autenticador.LiberarAsync(UsuarioSupervisor, PinSupervisor, PermissoesPdv.Supervisor, Operador.Id, agora);
                supervisor = r.Supervisor;
                erro = supervisor is null ? r.Erro ?? AutenticadorOffline.MensagemLiberacaoNegada : null;
                if (erro is not null)
                {
                    await RegistrarNegadoAsync(UsuarioSupervisor.Trim(), null, pelo: "no desbloqueio pelo supervisor");
                }
            }
            else
            {
                var r = await autenticador.AutenticarParaCentralAsync(Operador.Login, Pin, agora);
                erro = r.Operador?.Id == Operador.Id ? null : r.Erro is { } e && e != AutenticadorOffline.MensagemInvalido ? e : MensagemPinErrado;
                if (erro is not null)
                {
                    await RegistrarNegadoAsync(Operador.Login, r, pelo: "na tela bloqueada");
                }
            }
        }
        finally
        {
            Verificando = false;
            Pin = string.Empty;
            PinSupervisor = string.Empty;
        }

        if (erro is not null)
        {
            Erro = erro;
            FocoSolicitado?.Invoke(this, EventArgs.Empty);
            return;
        }

        _desbloqueada = true;
        await RegistrarDesbloqueioAsync(supervisor);
        _shell.Servico<MonitorInatividade>().RegistrarAtividade();
        await _shell.VoltarDoBloqueioAsync(this, _venda);
    }

    /// <summary>F2: o supervisor desbloqueia (o botão também).</summary>
    [RelayCommand]
    private void Supervisor()
    {
        if (Verificando)
        {
            return;
        }

        PeloSupervisor = true;
        Erro = null;
        FocoSolicitado?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>Esc: do supervisor volta ao PIN do operador; no PIN, limpa o que foi digitado.</summary>
    [RelayCommand]
    private void Voltar()
    {
        if (Verificando)
        {
            return;
        }

        Erro = null;
        Pin = string.Empty;
        UsuarioSupervisor = string.Empty;
        PinSupervisor = string.Empty;
        PeloSupervisor = false;
        FocoSolicitado?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>4 a 8 dígitos (PDV 7.2: 6 a 8, ou 4 e 5 com o PIN curto da loja); o resto nem vai ao autenticador.</summary>
    public static bool PareceUmPin(string? pin) =>
        pin is { Length: >= PinMinimo and <= PinMaximo } && pin.All(char.IsAsciiDigit);

    /// <summary>
    /// A recusa grava o <c>login_negado</c> (como o <c>AcessoCentral</c> e o login): o login informado no <c>depois</c>
    /// (vira o <c>login_informado</c> do <c>historico_logins</c>), o motivo do autenticador e quem foi identificado. Melhor
    /// esforço: na D22 o gatilho recusa e a recusa do PIN continua valendo.
    /// </summary>
    private async Task RegistrarNegadoAsync(string informado, ResultadoLogin? r, string pelo)
    {
        try
        {
            await _shell.Servico<RepositorioTerminal>().RegistrarAuditoriaAsync(
                "login_negado", r?.UsuarioId, BloqueioTela.Entidade, null, $"Login negado para '{informado}' {pelo}",
                BloqueioTela.Localizacao, null, motivo: r?.Motivo, depois: JsonSerializer.Serialize(new { login_informado = informado }));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            _shell.Servico<ILogger<TelaBloqueadaViewModel>>().LogWarning(e, "PIN recusado na tela bloqueada sem a auditoria local");
        }
    }

    /// <summary>
    /// A auditoria do desbloqueio é melhor esforço: na D22 o gatilho a recusa e o caixa não pode ficar preso. Pelo PIN do
    /// próprio operador, o <c>desbloqueio</c> local; pelo supervisor, a <c>liberacao</c> (sobe para o ERP: é a sessão de
    /// outra pessoa reaberta com o PIN dele).
    /// </summary>
    private async Task RegistrarDesbloqueioAsync(Operador? supervisor)
    {
        try
        {
            await _shell.Servico<RepositorioTerminal>().RegistrarAuditoriaAsync(
                supervisor is null ? BloqueioTela.AcaoDesbloqueio : BloqueioTela.AcaoLiberacao, Operador.Id, BloqueioTela.Entidade,
                descricao: supervisor is null ? $"Tela desbloqueada com o PIN de {Operador.Nome}" : $"Tela de {Operador.Nome} desbloqueada pelo supervisor {supervisor.Nome}",
                localizacao: BloqueioTela.Localizacao, autorizadoPorId: supervisor?.Id,
                depois: new JsonObject { ["como"] = supervisor is null ? BloqueioTela.PeloPin : BloqueioTela.PeloSupervisor }.ToJsonString());
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            _shell.Servico<ILogger<TelaBloqueadaViewModel>>().LogWarning(e, "Desbloqueio da tela sem a auditoria local");
        }
    }
}
