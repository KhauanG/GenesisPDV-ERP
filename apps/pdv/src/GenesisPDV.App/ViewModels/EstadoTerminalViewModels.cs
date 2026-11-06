using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Data;
using GenesisPDV.Sync.Cliente;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels;

/// <summary>
/// Terminal em desativação (SYNC 3.8; PDV 5.3): não vende mais, envia o outbox e confirma. A tela mostra "Terminal em
/// desativação — enviando pendências (N)" e acompanha o ciclo online; confirmada a desativação, o shell vai para a tela
/// de terminal desativado.
/// </summary>
public sealed partial class DesativacaoViewModel : ViewModelBase
{
    private readonly IServicoSincronizacao _sync;

    public DesativacaoViewModel(ShellViewModel shell)
    {
        _sync = shell.Servico<IServicoSincronizacao>();
        Caixa = $"Caixa {shell.Servico<SessaoTerminal>().Identidade?.NumeroCaixa:00}";
        _sync.SituacaoAlterada += (_, s) => Dispatcher.UIThread.Post(() => Aplicar(s));
        Aplicar(_sync.Situacao);
    }

    public string Caixa { get; }

    [ObservableProperty]
    public partial string Titulo { get; set; } = "Terminal em desativação — enviando pendências";

    [ObservableProperty]
    public partial string Detalhe { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [RelayCommand]
    private void SincronizarAgora() => _sync.SincronizarAgora();

    private void Aplicar(SituacaoSincronizacao s)
    {
        Titulo = $"Terminal em desativação — enviando pendências ({s.Pendentes - s.Rejeitados})";
        Detalhe = s.Online
            ? "O ERP pediu a desativação deste caixa. Novas vendas não são permitidas; as pendências estão subindo para a nuvem " +
              "e a desativação se confirma sozinha quando terminar. Não desligue o computador."
            : "Sem conexão com a nuvem: as pendências sobem quando a internet voltar. Não desligue nem formate este computador.";
        Erro = s.Rejeitados > 0
            ? $"{s.Rejeitados} evento(s) ficaram com erro na nuvem: o gerente resolve em ERP › PDVs/Terminais › Eventos com erro."
            : s.Erro;
    }
}

/// <summary>
/// Terminal que não opera (SYNC 2.5, 3.8, 5, 20.5, 22.1): desativado pelo ERP (só diagnóstico; o banco local nunca é
/// apagado), hardware alterado, regressão da sequência, token recusado ou 403 da empresa ou da loja. Nos bloqueios que podem passar (hardware
/// aprovado no ERP, rede), Enter refaz o handshake. F2 (ou o botão) gera o pacote para o suporte sem login, só com os logs e
/// o diagnóstico da tela (<see cref="PacoteSemBancoViewModel"/>; Central do PDV, bloco G9).
/// </summary>
public sealed partial class TerminalBloqueadoViewModel(ShellViewModel shell, string titulo, string mensagem, bool podeTentarDeNovo) : ViewModelBase
{
    public const string TituloDesativado = "Terminal desativado pelo ERP";

    public const string TituloHardware = "Hardware alterado — aguardando aprovação no ERP";

    public const string TituloSuporte = "Sincronização bloqueada — chame o suporte";

    /// <summary>O banco da máquina foi ativado com outra conta do sistema (implantação I3; D21): só ela abre o token.</summary>
    public const string TituloContaDiferente = "Caixa ativado com outra conta";

    /// <summary>Reidratação do banco restaurado ou antigo interrompida (SYNC 22.2): continua sozinha no ciclo online.</summary>
    public const string TituloRecuperando = "Recuperando os dados do caixa…";

    public string Titulo { get; } = titulo;

    public string Mensagem { get; } = mensagem;

    public bool PodeTentarDeNovo { get; } = podeTentarDeNovo;

    public string Diagnostico { get; } = MontarDiagnostico(shell);

    /// <summary>O pacote para o suporte (sem login; aqui o banco abriu, então a ocorrência é gravada nele).</summary>
    public PacoteSemBancoViewModel Pacote { get; } = new(shell, titulo, () => $"{mensagem}\n\n{MontarDiagnostico(shell)}", registrarNoBanco: true);

    public string Rodape => PodeTentarDeNovo
        ? "Enter tenta de novo · F2 gera o pacote para o suporte · Alt+F4 sai"
        : "F2 gera o pacote para o suporte · Alt+F4 sai · o banco local foi mantido para o suporte";

    [ObservableProperty]
    public partial bool Tentando { get; set; }

    [RelayCommand]
    private async Task TentarDeNovoAsync()
    {
        if (!PodeTentarDeNovo || Tentando)
        {
            return;
        }

        Tentando = true;
        try
        {
            await shell.IniciarAsync();
        }
        finally
        {
            Tentando = false;
        }
    }

    private static string MontarDiagnostico(ShellViewModel shell)
    {
        var identidade = shell.Servico<SessaoTerminal>().Identidade;
        var caminhos = shell.Servico<CaminhosPdv>();
        var pendentes = shell.Servico<IServicoSincronizacao>().Situacao.Pendentes;
        return identidade is null
            ? $"Dados locais: {caminhos.PastaDados}"
            : $"Terminal {identidade.TerminalId} · empresa {identidade.EmpresaCodigo} · caixa {identidade.NumeroCaixa:00}\n" +
              $"Eventos não confirmados no banco local: {pendentes}\nDados locais (backup e diagnóstico): {caminhos.PastaDados}";
    }
}

/// <summary>
/// Erro que impede o caixa de abrir (PDV 32.2): o banco corrompido sem backup, o banco de uma versão mais nova, a falha
/// inesperada na abertura. F2 (ou o botão) gera o pacote para o suporte <b>sem login e sem abrir o banco</b> (o banco pode
/// ser o problema): o manifesto, os logs mascarados e o texto desta tela (Central do PDV, bloco G9; plano 4.6).
/// </summary>
public sealed class ErroFatalViewModel(ShellViewModel shell, string titulo, string mensagem) : ViewModelBase
{
    public string Titulo { get; } = titulo;

    public string Mensagem { get; } = mensagem;

    /// <summary>O pacote sem banco: nada é gravado no banco (nem a ocorrência), só o log de texto.</summary>
    public PacoteSemBancoViewModel Pacote { get; } = new(shell, titulo, () => mensagem, registrarNoBanco: false);

    public string Rodape => "F2 gera o pacote para o suporte (no pendrive, ou em Documentos › GenesisPDV-suporte) · Alt+F4 sai";
}

/// <summary>
/// O "Gerar pacote para o suporte" das telas sem login (erro fatal e terminal bloqueado; Central do PDV, bloco G9; plano
/// 4.6): salva no primeiro pendrive ligado ou, sem pendrive, em <c>Documentos\GenesisPDV-suporte</c>
/// (<see cref="ServicoPacoteSuporte.GerarSemBancoAsync"/>, fora da tela). Só o manifesto (sem o "gerado por"), os logs
/// mascarados e o texto da tela, com o aviso de entregar só ao suporte.
/// </summary>
/// <param name="texto">O que a tela mostra (lido na hora: o diagnóstico pode ter mudado).</param>
/// <param name="registrarNoBanco">A ocorrência <c>PACOTE_GERADO</c> só onde o banco abriu.</param>
public sealed partial class PacoteSemBancoViewModel(ShellViewModel shell, string titulo, Func<string> texto, bool registrarNoBanco) : ViewModelBase
{
    public string Aviso => ServicoPacoteSuporte.AvisoEntrega;

    [ObservableProperty]
    public partial string? Mensagem { get; set; }

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [ObservableProperty]
    public partial bool Ocupado { get; set; }

    /// <summary>O último pacote gerado (os testes conferem o arquivo).</summary>
    [ObservableProperty]
    public partial ResultadoPacote? Ultimo { get; set; }

    [RelayCommand]
    private async Task GerarAsync()
    {
        if (Ocupado)
        {
            return;
        }

        Ocupado = true;
        Erro = null;
        Mensagem = "Gerando o pacote para o suporte…";
        try
        {
            var servico = shell.Servico<ServicoPacoteSuporte>();
            var destino = (await Task.Run(servico.Destinos))[0];
            var r = await servico.GerarSemBancoAsync(destino, titulo, texto(), registrarNoBanco);
            Ultimo = r;
            Mensagem = $"Pacote salvo em {destino.Nome}: {r.Nome}. {Aviso}" + (r.AvisoRegistro is { } aviso ? $" {aviso}" : string.Empty);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Registrar(e);
            Mensagem = null;
            // Só a falha de disco fala do pendrive; a outra (a mesma que impediu o caixa de abrir, por exemplo) não manda o
            // dono procurar o problema no lugar errado.
            Erro = e is IOException or UnauthorizedAccessException
                ? $"O pacote não foi gerado ({MascaradorSuporte.Mascarar(e.Message)}). Ligue um pendrive com espaço e aperte F2 de novo."
                : $"O pacote não foi gerado ({MascaradorSuporte.Mascarar(e.Message)}). Chame o suporte e diga esta mensagem.";
        }
        finally
        {
            Ocupado = false;
        }
    }

    /// <summary>O log de texto, se ele mesmo responder (a tela de erro fatal pode ter nascido de um serviço que não abre).</summary>
    private void Registrar(Exception e)
    {
        try
        {
            shell.Servico<ILogger<PacoteSemBancoViewModel>>().LogError(e, "Falha ao gerar o pacote de suporte sem banco");
        }
        catch (Exception falha) when (falha is InvalidOperationException or ObjectDisposedException)
        {
            // Sem o log: a mensagem da tela basta.
        }
    }
}
