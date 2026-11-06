using System.Collections.ObjectModel;
using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Backup;
using GenesisPDV.Sync.Cliente;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels;

/// <summary>Um backup na lista da restauração.</summary>
public sealed record LinhaBackup(ArquivoBackup Arquivo)
{
    public string Quando => Arquivo.FeitoEm.ToLocalTime().ToString("dd/MM/yyyy HH:mm:ss", CultureInfo.GetCultureInfo("pt-BR"));

    /// <summary>O motivo como a aba 8 Backup mostra (o "Fazer backup agora" aparece "feito agora (manual)", não cru).</summary>
    public string Motivo => MotivosBackup.Rotulo(Arquivo.Motivo);

    public string Tamanho => string.Create(CultureInfo.GetCultureInfo("pt-BR"), $"{Arquivo.Tamanho / 1024d:N0} KB");

    public string Texto => $"{Quando}  ·  {Motivo}  ·  {Tamanho}  ·  {Arquivo.Nome}";
}

/// <summary>
/// "Restaurar backup" (PDV 32.5; SYNC 22.1; Fase 1C, C17; O12 do dono): Central do PDV pelo login (Ctrl+Alt+C) › 3
/// Impressora e gaveta › F9 (bloco G3) ou a tela do banco corrompido (<c>integrity_check</c> falho). Passos pelo
/// teclado: escolher o arquivo (setas e Enter, do mais novo para o mais antigo, das pastas <c>backup/</c> e secundária;
/// o Enter já confere o arquivo — integridade, terminal — com o caixa funcionando,
/// <see cref="RestauracaoBackup.ConferirAsync"/>), a liberação de quem tem <c>pdv.supervisor</c> e
/// <c>pdv.config.terminal</c> (usuário e PIN digitados na hora, mesmo que a Central já tenha conferido o PIN de quem
/// entrou ou liberado a aba: plano 3.3; na restauração automática não há banco legível para conferir o PIN), a
/// confirmação dupla (digitar <c>RESTAURAR</c>; com eventos ainda não enviados no banco em uso, que o backup não tem e só
/// o <c>antes-restauracao</c> guarda, <c>RESTAURAR</c> e a quantidade deles) e a restauração, com o ciclo de
/// sincronização e o backup parados. No fim, Enter fecha e reabre o aplicativo: o handshake obrigatório aplica a regra da
/// 22.1 (reidratação, salto) antes de liberar as vendas. A restauração que falha depois de parar o caixa também termina
/// no reinício (sem sincronismo nem backup, o caixa não volta ao login). Esc volta ao login (só na ação pela Central,
/// antes de parar; a Central já acabou ao abrir esta tela).
/// </summary>
public sealed partial class RestaurarBackupViewModel : ViewModelBase
{
    public const string EtapaEscolher = "escolher";
    public const string EtapaLiberar = "liberar";
    public const string EtapaConfirmar = "confirmar";
    public const string EtapaConcluida = "concluida";

    /// <summary>O texto da confirmação dupla.</summary>
    public const string PalavraConfirmacao = "RESTAURAR";

    private readonly ShellViewModel _shell;
    private Guid? _autorizadoPor;
    private ConferenciaRestauracao? _conferido;

    public RestaurarBackupViewModel(ShellViewModel shell, bool automatica, string? motivo = null)
    {
        _shell = shell;
        Automatica = automatica;
        Motivo = motivo;
    }

    /// <summary>Depois do <c>integrity_check</c> falho: sem a liberação (o banco não abre) e sem voltar ao login.</summary>
    public bool Automatica { get; }

    /// <summary>Por que a tela abriu sozinha (banco corrompido).</summary>
    public string? Motivo { get; }

    public string Titulo => Automatica ? "Banco local com problema — restaurar backup" : "Central do PDV › Restaurar backup";

    public ObservableCollection<LinhaBackup> Backups { get; } = [];

    [ObservableProperty]
    public partial int Selecionado { get; set; }

    [ObservableProperty]
    public partial string Etapa { get; set; } = EtapaEscolher;

    [ObservableProperty]
    public partial string Usuario { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Pin { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Confirmacao { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [ObservableProperty]
    public partial string? Resultado { get; set; }

    [ObservableProperty]
    public partial bool Ocupado { get; set; }

    public LinhaBackup? Escolhido => Selecionado >= 0 && Selecionado < Backups.Count ? Backups[Selecionado] : null;

    /// <summary>
    /// O que digitar na confirmação: <see cref="PalavraConfirmacao"/>, seguida da quantidade de eventos não enviados do
    /// banco em uso quando há (a confirmação específica de que eles saem do caixa e ficam só no arquivo guardado).
    /// </summary>
    public string PalavraExigida => _conferido?.EventosPendentesEmUso is > 0 and var n
        ? string.Create(CultureInfo.InvariantCulture, $"{PalavraConfirmacao} {n}")
        : PalavraConfirmacao;

    /// <summary>Texto da confirmação, com o aviso dos eventos não enviados.</summary>
    public string TextoConfirmacao => (_conferido?.EventosPendentesEmUso switch
    {
        > 0 and var n => string.Create(CultureInfo.GetCultureInfo("pt-BR"),
            $"Atenção: o banco em uso tem {n} evento(s) ainda não enviado(s) à nuvem (vendas, caixa). Eles não estão no backup: depois da troca ficam só no arquivo guardado (antes-restauracao) e o supervisor declara a lacuna. "),
        null => "O banco em uso não pôde ser lido: o que ele não enviou à nuvem não é recuperado (o arquivo fica guardado ao lado). ",
        _ => string.Empty,
    }) + $"Digite {PalavraExigida} e Enter para confirmar. Depois o aplicativo reabre e só libera as vendas depois de conferir com a nuvem.";

    public string Rodape => Etapa switch
    {
        EtapaConcluida => "Enter fecha e reabre o aplicativo",
        _ when Automatica => "Setas escolhem · Enter avança",
        _ => "Setas escolhem · Enter avança · Esc volta ao login",
    };

    public bool Escolhendo => Etapa == EtapaEscolher;

    public bool Liberando => Etapa == EtapaLiberar;

    public bool Confirmando => Etapa == EtapaConfirmar;

    public bool Concluida => Etapa == EtapaConcluida;

    partial void OnEtapaChanged(string value)
    {
        OnPropertyChanged(nameof(Escolhendo));
        OnPropertyChanged(nameof(Liberando));
        OnPropertyChanged(nameof(Confirmando));
        OnPropertyChanged(nameof(Concluida));
        OnPropertyChanged(nameof(Rodape));
    }

    public async Task CarregarAsync()
    {
        Backups.Clear();
        foreach (var a in await _shell.Servico<BackupLocal>().ListarAsync())
        {
            Backups.Add(new LinhaBackup(a));
        }

        Selecionado = Backups.Count > 0 ? 0 : -1;
        Erro = Backups.Count == 0 ? $"Nenhum backup em {_shell.Servico<Data.CaminhosPdv>().PastaBackup} (nem na pasta secundária)." : null;
    }

    [RelayCommand]
    private void Mover(string passo)
    {
        if (Etapa != EtapaEscolher || Backups.Count == 0)
        {
            return;
        }

        Selecionado = Math.Clamp(Selecionado + int.Parse(passo, CultureInfo.InvariantCulture), 0, Backups.Count - 1);
    }

    [RelayCommand]
    private async Task AvancarAsync()
    {
        if (Ocupado)
        {
            return;
        }

        Erro = null;
        switch (Etapa)
        {
            case EtapaEscolher when Escolhido is not null:
                await ConferirAsync(Escolhido);
                break;
            case EtapaLiberar:
                await LiberarAsync();
                break;
            case EtapaConfirmar:
                await RestaurarAsync();
                break;
            case EtapaConcluida:
                _shell.Reiniciar();
                break;
        }
    }

    [RelayCommand]
    private void Voltar()
    {
        if (Ocupado || Etapa == EtapaConcluida)
        {
            return;
        }

        if (Etapa != EtapaEscolher)
        {
            Etapa = EtapaEscolher;
            Erro = null;
            return;
        }

        if (!Automatica)
        {
            _shell.IrParaLogin();
        }
    }

    /// <summary>O arquivo escolhido conferido com o caixa funcionando: o recusado nunca para o sincronismo nem o backup.</summary>
    private async Task ConferirAsync(LinhaBackup escolhido)
    {
        Ocupado = true;
        try
        {
            _conferido = await _shell.Servico<RestauracaoBackup>().ConferirAsync(escolhido.Arquivo.Caminho);
            OnPropertyChanged(nameof(PalavraExigida));
            OnPropertyChanged(nameof(TextoConfirmacao));
            Confirmacao = string.Empty;
            Etapa = Automatica ? EtapaConfirmar : EtapaLiberar;
        }
        catch (Exception e) when (e is RegraNegocioException or IOException or UnauthorizedAccessException or InvalidDataException)
        {
            _shell.Servico<ILogger<RestaurarBackupViewModel>>().LogWarning(e, "Backup {Arquivo} recusado na conferência", escolhido.Arquivo.Caminho);
            Erro = e is RegraNegocioException ? e.Message : RestauracaoBackup.MensagemInvalido;
        }
        finally
        {
            Ocupado = false;
        }
    }

    private async Task LiberarAsync()
    {
        Ocupado = true;
        try
        {
            var r = await _shell.Servico<IAutenticadorOperador>()
                .LiberarAsync(Usuario, Pin, PermissoesPdv.ConfigTerminal, Guid.Empty, _shell.Servico<IRelogio>().Agora);
            Pin = string.Empty;
            if (r.Supervisor is not { } supervisor)
            {
                Erro = r.Erro;
                return;
            }

            _autorizadoPor = supervisor.Id;
            Etapa = EtapaConfirmar;
        }
        finally
        {
            Ocupado = false;
        }
    }

    private async Task RestaurarAsync()
    {
        if (!string.Equals(Confirmacao.Trim(), PalavraExigida, StringComparison.Ordinal))
        {
            Erro = $"Digite {PalavraExigida} para confirmar: o banco em uso é substituído pelo backup (ele fica guardado).";
            return;
        }

        if (Escolhido is not { } escolhido || _conferido?.Arquivo != escolhido.Arquivo.Caminho)
        {
            return;
        }

        Ocupado = true;
        try
        {
            // Nada grava no banco durante a troca: o ciclo para, e o backup de saída não sai (o arquivo é o restaurado).
            // Nem lê: o Painel de saúde (G4) para e espera a rodada em curso (a conexão aberta no Windows impediria a troca).
            var backup = _shell.Servico<ServicoBackup>();
            backup.SuspenderParaRestauracao();
            await _shell.Servico<Servicos.Diagnostico.MonitorSaude>().SuspenderParaRestauracaoAsync();
            // O pacote de suporte (Central do PDV, bloco G9) também: a parte em curso termina, e nada mais lê nem grava no banco.
            await _shell.Servico<Servicos.Diagnostico.ServicoPacoteSuporte>().SuspenderParaRestauracaoAsync();
            if (_shell.Servico<IServicoSincronizacao>() is IAsyncDisposable sync)
            {
                await sync.DisposeAsync();
            }

            var r = await _shell.Servico<RestauracaoBackup>().RestaurarAsync(escolhido.Arquivo.Caminho, _autorizadoPor, _autorizadoPor);
            Resultado =
                $"Backup de {escolhido.Quando} restaurado. O banco que estava em uso ficou guardado em {r.BancoAnterior ?? "(não havia)"}. " +
                "Ao reabrir, o caixa confere com a nuvem e recupera o que ela já recebeu deste terminal antes de liberar as vendas" +
                (r.Pendente.BackupDeSaida ? " (backup de saída conferido)." : "; a numeração de venda salta 1.000 (SYNC 22.1).");
            Etapa = EtapaConcluida;
        }
        catch (Exception e) when (e is RegraNegocioException or IOException or UnauthorizedAccessException or InvalidDataException)
        {
            _shell.Servico<ILogger<RestaurarBackupViewModel>>().LogError(e, "Restauração do backup {Arquivo} falhou", escolhido.Arquivo.Caminho);
            Erro = e.Message;
            // O sincronismo e o backup já pararam (e não religam neste processo): o caixa não volta ao login assim, só o
            // reinício (o banco em uso não foi trocado; a troca é o último passo).
            Resultado = "A restauração não foi feita e o banco em uso não foi alterado. Enter fecha e reabre o aplicativo.";
            Etapa = EtapaConcluida;
        }
        finally
        {
            Ocupado = false;
        }
    }
}
