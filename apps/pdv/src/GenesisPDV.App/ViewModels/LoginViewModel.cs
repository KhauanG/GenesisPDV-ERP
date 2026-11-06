using System.Text.Json;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Ativacao;
using GenesisPDV.Sync.Cliente;

namespace GenesisPDV.App.ViewModels;

/// <summary>
/// Login do operador (PDV 7.1): o código da empresa não é digitado; Enter entra, Esc limpa. O PIN do PDV é verificado
/// localmente contra o espelho (<see cref="IAutenticadorOperador"/>), igual online e offline.
/// </summary>
public sealed partial class LoginViewModel : ViewModelBase
{
    private readonly ShellViewModel _shell;
    private readonly SessaoTerminal _sessao;

    public LoginViewModel(ShellViewModel shell)
    {
        _shell = shell;
        _sessao = shell.Servico<SessaoTerminal>();
        var sync = shell.Servico<IServicoSincronizacao>();
        sync.SituacaoAlterada += (_, s) => Dispatcher.UIThread.Post(() => AplicarSituacao(s));
        AplicarSituacao(sync.Situacao);
    }

    /// <summary>Indicador de sincronização do rodapé (PDV 30.2).</summary>
    [ObservableProperty]
    public partial string ConexaoTexto { get; set; } = "● Offline";

    public string Cabecalho => $"{_sessao.NomeLoja}  ·  Caixa {_sessao.Identidade?.NumeroCaixa:00}";

    public string Versao => $"v{VersaoApp.Atual}";

#if MODO_DEMONSTRACAO
    public string? Dica => "Demonstração: usuário 1 (MARIA) senha 1234 · usuário 2 (CARLOS, gerente) senha 4321";
#else
    public string? Dica => null;
#endif

    [ObservableProperty]
    public partial string Usuario { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Senha { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [ObservableProperty]
    public partial int Pendentes { get; set; }

    /// <summary>Verificação do PIN em andamento.</summary>
    [ObservableProperty]
    public partial bool Verificando { get; set; }

    /// <summary>
    /// Versão abaixo da mínima que a nuvem publicou (SYNC 17.3, PDV 32.6; I3): o aviso diz qual instalar e como. Só
    /// avisa: o caixa entra e os eventos sobem (a atualização obrigatória depois da carência é da PDV-2).
    /// </summary>
    [ObservableProperty]
    public partial string? AvisoVersao { get; set; }

    /// <summary>Lê a versão mínima gravada pelo handshake/heartbeat (chamado ao abrir o login).</summary>
    public async Task CarregarAsync()
    {
        var minima = (await _shell.Servico<RepositorioTerminal>().ObterEstadoConexaoAsync()).VersaoMinimaApp;
        AvisoVersao = VersaoApp.AbaixoDe(minima)
            ? $"A nuvem pede o GenesisPDV {minima} (este é o {VersaoApp.Atual}). {MensagensAtivacao.ComoAtualizar(minima)}"
            : null;
    }

    /// <summary>
    /// Ctrl+Alt+C ou o botão ⚙ (Central do PDV, bloco G3): a Central pede o usuário e o PIN; a aba 3 é a antiga
    /// configuração do terminal (impressora, gaveta, tela do caixa e "Restaurar backup", C17). Fora da confirmação de
    /// desativação (D22).
    /// </summary>
    [RelayCommand]
    private void AbrirCentral()
    {
        if (Verificando)
        {
            return;
        }

        if (_shell.Servico<IServicoSincronizacao>().Situacao.ConfirmandoDesativacao)
        {
            Erro = ServicoCaixa.MensagemConfirmandoDesativacao;
            return;
        }

        _shell.IrParaCentralPeloLogin();
    }

    [RelayCommand]
    private async Task EntrarAsync()
    {
        if (Verificando)
        {
            return;
        }

        var relogio = _shell.Servico<IRelogio>();
        ResultadoLogin resultado;
        Verificando = true;
        try
        {
            // argon2id leva centenas de ms: fora da thread da tela, com o Enter repetido ignorado.
            resultado = await _shell.Servico<IAutenticadorOperador>().AutenticarAsync(Usuario, Senha, relogio.Agora);
        }
        finally
        {
            Verificando = false;
        }

        var terminal = _shell.Servico<RepositorioTerminal>();
        // `login_informado` do `historico_logins` na nuvem (SYNC 9.22): vai no `depois` e o lote de auditoria o lê.
        var informado = JsonSerializer.Serialize(new { login_informado = Usuario.Trim() });
        if (resultado.Operador is null)
        {
            Erro = resultado.Erro;
            Senha = string.Empty;
            await terminal.RegistrarAuditoriaAsync(
                "login_negado", resultado.UsuarioId, descricao: $"Login negado para '{Usuario.Trim()}'", localizacao: "pdv.login", motivo: resultado.Motivo,
                depois: informado);
            return;
        }

        _sessao.Operador = resultado.Operador;
        await terminal.RegistrarAuditoriaAsync("login", resultado.Operador.Id, descricao: $"Login de {resultado.Operador.Nome}", localizacao: "pdv.login",
            depois: informado);
        // Sessão de caixa (PDV 8.1): a abertura, o diálogo da sessão de outro operador ou direto a venda. A abertura
        // automática recusada (terminal em desativação, tipo não anunciado pela nuvem) fica no login, com a mensagem.
        try
        {
            await _shell.AposLoginAsync();
        }
        catch (RegraNegocioException e)
        {
            _sessao.Operador = null;
            Erro = e.Message;
            Senha = string.Empty;
        }
    }

    private void AplicarSituacao(SituacaoSincronizacao s)
    {
        ConexaoTexto = IndicadorSync.Calcular(s, DateTimeOffset.UtcNow).Texto;
        Pendentes = s.Pendentes;
    }

    [RelayCommand]
    private void Limpar()
    {
        Usuario = string.Empty;
        Senha = string.Empty;
        Erro = null;
    }
}
