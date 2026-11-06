using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Data.Backup;
using GenesisPDV.Data.Repositorios;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels.Central;

/// <summary>Um backup da lista da aba 8: quando, por quê, o tamanho e onde está (principal, secundária ou as duas).</summary>
public sealed record LinhaBackup(string Nome, string Quando, string Motivo, string Tamanho, string Onde);

/// <summary>
/// Aba 8 da Central do PDV, <b>Backup</b> (bloco G11; plano 4; PDV 32.5; README › decisão 75): os backups deste caixa (da
/// pasta do PDV e da secundária, um por linha com onde está), o último que deu certo e a última falha deste processo, a
/// pasta secundária configurada (na aba 7) e o <b>F5 Fazer backup agora</b> (motivo <c>manual</c>, a mesma cópia e a
/// mesma retenção do periódico; <see cref="ServicoBackup.FazerAgoraAsync"/>), que pede
/// <c>pdv.config.parametros_locais</c> (a própria ou o supervisor na hora, PDV 31.3) e recusa com uma venda em andamento
/// (antes do PIN do supervisor, <see cref="ServicoBackup.ConferirAgoraAsync"/>).
/// O <b>F9 Restaurar backup</b> só aparece na Central aberta pelo login (como na aba 3) e pede o PIN na hora na tela da
/// restauração (C17). Abre com <c>pdv.diagnostico.ver</c>. F6 atualiza, Esc fecha o pedido do supervisor e volta ao menu.
/// </summary>
public sealed partial class AbaBackupViewModel : ViewModelBase
{
    public const string Localizacao = "PDV › Central do PDV › Backup";

    public const string MensagemSemPermissao =
        "Os backups pedem quem pode ver o diagnóstico (pdv.diagnostico.ver): Ctrl+L Liberar.";

    private readonly ShellViewModel _shell;
    private readonly Func<Task> _voltar;
    private readonly AcessoCentral _acesso;
    private bool? _via;

    public AbaBackupViewModel(ShellViewModel shell, OrigemCentral origem, Func<Task> voltar)
    {
        _shell = shell;
        _voltar = voltar;
        _acesso = shell.Servico<AcessoCentral>();
        Origem = origem;
    }

    public OrigemCentral Origem { get; }

    public string Titulo => AbasCentral.Backup.Rotulo;

    /// <summary>O F9 (restaurar) só pela Central aberta no login, com o caixa sem operador (C17).</summary>
    public bool MostraRestaurar => Origem == OrigemCentral.Login;

    public ObservableCollection<LinhaBackup> Backups { get; } = [];

    [ObservableProperty]
    public partial string? UltimoSucessoTexto { get; set; }

    [ObservableProperty]
    public partial string? UltimaFalhaTexto { get; set; }

    [ObservableProperty]
    public partial string? PastaTexto { get; set; }

    [ObservableProperty]
    public partial string? PermissaoTexto { get; set; }

    [ObservableProperty]
    public partial string? Mensagem { get; set; }

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [ObservableProperty]
    public partial bool Ocupado { get; set; }

    /// <summary>"Fazendo o backup agora…" enquanto ele roda (ou espera o backup em curso): a tela não fica muda.</summary>
    [ObservableProperty]
    public partial string? Andamento { get; set; }

    [ObservableProperty]
    public partial PedidoLiberacaoViewModel? Liberacao { get; set; }

    /// <summary>A tela leva o foco à aba (as teclas F valem dali).</summary>
    public event EventHandler? FocoSolicitado;

    public void Focar() => FocoSolicitado?.Invoke(this, EventArgs.Empty);

    public async Task CarregarAsync()
    {
        _via = _acesso.Tem(PermissoesPdv.VerDiagnostico);
        if (_via != true)
        {
            Limpar();
            Erro = MensagemSemPermissao;
            return;
        }

        await Ocupar(LerAsync);
    }

    /// <summary>A liberação da Central que emprestou o ver acabou: a aba não fica com o que mostrava (nem com o pedido do supervisor).</summary>
    public void ConferirPermissoes()
    {
        var antes = _via;
        _via = _acesso.Tem(PermissoesPdv.VerDiagnostico);
        if (antes == true && _via != true)
        {
            Limpar();
        }
    }

    /// <summary>F5: o backup agora (a própria permissão, ou o supervisor na hora).</summary>
    [RelayCommand]
    private Task FazerAgora() => Liberacao is not null || Ocupado ? Task.CompletedTask : Ocupar(async () =>
    {
        Exigir();
        var usuario = _acesso.Usuario ?? throw new RegraNegocioException(AcessoCentral.MensagemFechada);
        if (usuario.Tem(PermissoesPdv.ParametrosLocais))
        {
            await FazerAsync(usuario, null);
            return;
        }

        // A venda em andamento e a restauração recusam antes do PIN: o supervisor não libera o que vai ser recusado.
        await _shell.Servico<ServicoBackup>().ConferirAgoraAsync();
        Liberacao = new PedidoLiberacaoViewModel(
            _shell.Servico<IAutenticadorOperador>(), _shell.Servico<IRelogio>(), usuario, PermissoesPdv.ParametrosLocais, "Fazer backup agora",
            async concedida =>
            {
                Liberacao = null;
                await Ocupar(() => FazerAsync(usuario, concedida));
                Focar();
            },
            erro =>
            {
                Liberacao = null;
                Erro = erro;
                Focar();
                return Task.CompletedTask;
            });
    });

    [RelayCommand]
    private Task Atualizar() => Liberacao is not null || Ocupado ? Task.CompletedTask : CarregarAsync();

    /// <summary>F9 (só pelo login): a tela do "Restaurar backup", que pede o PIN na hora (plano 3.3).</summary>
    [RelayCommand]
    private Task Restaurar() => Liberacao is not null || Ocupado || !MostraRestaurar
        ? Task.CompletedTask
        : Ocupar(() => _shell.IrParaRestaurarBackupAsync(_shell.PaginaAtual));

    [RelayCommand]
    private Task Voltar()
    {
        if (Liberacao is not null)
        {
            Liberacao = null;
            Focar();
            return Task.CompletedTask;
        }

        return Ocupado ? Task.CompletedTask : _voltar();
    }

    private async Task FazerAsync(Operador usuario, LiberacaoConcedida? liberacao)
    {
        Exigir();
        Andamento = BackupLocal.EmCurso
            ? "Esperando o backup que já está em curso terminar; depois este é feito (um por vez)…"
            : "Fazendo o backup agora (o caixa continua respondendo)…";
        var r = await _shell.Servico<ServicoBackup>().FazerAgoraAsync(usuario.Id, liberacao?.Supervisor.Id, liberacao?.Motivo, Localizacao);
        await LerAsync();
        Mensagem = $"Backup feito agora: {Path.GetFileName(r.Backup.Arquivo)} ({MedidorDisco.Legivel(r.Tamanho)})"
                   + (r.Backup.CopiaSecundaria is null ? "." : ", com a cópia na pasta secundária.")
                   + (liberacao is null ? string.Empty : $" Liberado por {liberacao.Supervisor.Nome}.")
                   + (r.Aviso is { } aviso ? $" {aviso}" : string.Empty);
    }

    /// <summary>A lista (os arquivos lidos fora da thread da tela) e o resumo.</summary>
    private async Task LerAsync()
    {
        var backup = _shell.Servico<BackupLocal>();
        var servico = _shell.Servico<ServicoBackup>();
        var sessao = _shell.Servico<SessaoTerminal>();
        var fuso = DiaOperacional.ObterFuso(sessao.FusoHorario);
        string Hora(DateTimeOffset quando) => TimeZoneInfo.ConvertTime(quando, fuso).ToString("dd/MM/yyyy HH:mm", NumeroBr.Cultura);

        var (arquivos, secundaria, identidade) = await Task.Run(async () =>
            (await backup.ListarAsync(), await backup.PastaSecundariaAsync(), await _shell.Servico<RepositorioTerminal>().ObterIdentidadeAsync()));
        Backups.Clear();
        foreach (var grupo in arquivos.GroupBy(a => a.Nome, StringComparer.OrdinalIgnoreCase))
        {
            var a = grupo.First();
            var principal = grupo.Any(x => !x.NaSecundaria);
            var naSecundaria = grupo.Any(x => x.NaSecundaria);
            Backups.Add(new LinhaBackup(a.Nome, Hora(a.FeitoEm), Motivo(a.Motivo), MedidorDisco.Legivel(a.Tamanho),
                principal && naSecundaria ? "pasta do PDV e secundária" : naSecundaria ? "só na secundária" : "pasta do PDV"));
        }

        UltimoSucessoTexto = identidade?.UltimoBackupEm is { } ultimo
            ? $"Último backup que deu certo: {Hora(ultimo)}."
            : "Nenhum backup deste caixa ainda: o primeiro sai sozinho com o caixa aberto (a cada 2 h) e no fechamento.";
        UltimaFalhaTexto = servico.UltimaFalha is { } falha && (identidade?.UltimoBackupEm is not { } sucesso || falha.Em > sucesso)
            ? $"A última tentativa falhou em {Hora(falha.Em)} ({MascaradorSuporte.Mascarar(falha.Mensagem)})."
            : null;
        PastaTexto = secundaria is { } pasta
            ? $"Cópia na pasta secundária: {MascaradorSuporte.Mascarar(pasta)} (muda na aba 7 Parâmetros)."
            : "Sem pasta secundária: os backups ficam só na pasta do PDV (configure um pendrive na aba 7 Parâmetros).";
        PermissaoTexto = _acesso.Usuario?.Tem(PermissoesPdv.ParametrosLocais) == true
            ? "F5 faz o backup agora."
            : "F5 faz o backup agora com a liberação do supervisor (usuário, PIN e motivo).";
    }

    private static string Motivo(string motivo) => MotivosBackup.Rotulo(motivo);

    private void Exigir()
    {
        if (!_acesso.Tem(PermissoesPdv.VerDiagnostico))
        {
            throw new RegraNegocioException(MensagemSemPermissao);
        }
    }

    private void Limpar()
    {
        Liberacao = null;
        Backups.Clear();
        UltimoSucessoTexto = null;
        UltimaFalhaTexto = null;
        PastaTexto = null;
        PermissaoTexto = null;
        Mensagem = null;
        Erro = null;
    }

    private async Task Ocupar(Func<Task> acao)
    {
        Ocupado = true;
        Erro = null;
        Mensagem = null;
        try
        {
            await acao();
        }
        catch (RegraNegocioException e)
        {
            Erro = e.Message;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            _shell.Servico<ILogger<AbaBackupViewModel>>().LogError(e, "Falha na aba Backup da Central do PDV");
            Erro = $"Não deu certo ({MascaradorSuporte.Mascarar(e.Message)}).";
        }
        finally
        {
            Ocupado = false;
            Andamento = null;
        }
    }
}
