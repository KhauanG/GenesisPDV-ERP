using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels.Central;

/// <summary>
/// Aba P da Central do PDV, <b>Pacote de suporte</b> (bloco G9; plano 4 e 4.6; decisões do dono de 04/11/2026: PC-12, o
/// pendrive agora; README › decisão 76): o que entra e o que nunca entra no pacote, onde salvar (os pendrives ligados e,
/// sem nenhum, a pasta <c>Documentos\GenesisPDV-suporte</c>) e o <b>Enter</b> (ou F2, ou o botão) que gera e salva
/// (<see cref="ServicoPacoteSuporte.GerarAsync"/>, fora da thread da tela). Abre com
/// <c>pdv.diagnostico.pacote_suporte</c>, a própria ou a emprestada pelo Ctrl+L (decisão 67: o pacote só lê; quem liberou
/// fica no <c>autorizado_por_id</c> da auditoria <c>exportar</c>). ↑/↓ escolhem o destino, F5 procura o pendrive de novo,
/// Esc volta ao menu. Três cliques do caixa ao pendrive: ⚙, P e "Gerar".
/// </summary>
public sealed partial class AbaPacoteViewModel : ViewModelBase
{
    public const string TextoEntra =
        "Entra: a versão e o código do caixa, o Painel de saúde, a situação do envio à nuvem e a lista do que ainda não " +
        "subiu (sem o conteúdo), os comandos do ERP, as ocorrências dos últimos 30 dias, o arquivo técnico dos últimos 7 " +
        "dias, a configuração da impressora e da tela, as regras da loja, a lista dos backups, a fila de impressão (sem os " +
        "impressos), o disco e quantas vezes cada ação foi feita nos últimos 7 dias.";

    public const string TextoNuncaEntra =
        "Nunca entra: o banco do caixa e os backups, senhas, PINs, chaves e o token; CPFs, CNPJs e o PIX aparecem como ***; " +
        "o conteúdo das vendas e dos registros enviados e os impressos não vão.";

    private readonly ShellViewModel _shell;
    private readonly Func<Task> _voltar;
    private readonly AcessoCentral _acesso;
    private bool? _via;

    /// <summary>Cancela o pacote em curso quando a liberação que emprestou a permissão acaba (o pacote não sai em nome dela).</summary>
    private CancellationTokenSource? _geracao;

    public AbaPacoteViewModel(ShellViewModel shell, Func<Task> voltar)
    {
        _shell = shell;
        _voltar = voltar;
        _acesso = shell.Servico<AcessoCentral>();
    }

    public string Titulo => AbasCentral.Pacote.Rotulo;

    public string Entra => TextoEntra;

    public string NuncaEntra => TextoNuncaEntra;

    public string Aviso => ServicoPacoteSuporte.AvisoEntrega;

    public string Teclas => "↑/↓ escolhem onde salvar · Enter ou F2 gera e salva · F5 procura o pendrive de novo · Esc volta ao menu";

    public ObservableCollection<DestinoPacote> Destinos { get; } = [];

    [ObservableProperty]
    public partial DestinoPacote? DestinoSelecionado { get; set; }

    [ObservableProperty]
    public partial string? DestinosTexto { get; set; }

    [ObservableProperty]
    public partial string? Mensagem { get; set; }

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [ObservableProperty]
    public partial bool Ocupado { get; set; }

    /// <summary>"Gerando o pacote…" enquanto ele é montado (a tela não fica muda).</summary>
    [ObservableProperty]
    public partial string? Andamento { get; set; }

    /// <summary>O último pacote gerado nesta visita (os testes conferem o arquivo).</summary>
    [ObservableProperty]
    public partial ResultadoPacote? Ultimo { get; set; }

    /// <summary>A tela leva o foco à lista dos destinos (↑/↓ e o Enter valem dali).</summary>
    public event EventHandler? FocoSolicitado;

    public void Focar() => FocoSolicitado?.Invoke(this, EventArgs.Empty);

    /// <summary>
    /// A primeira visita e as voltas à aba. Na volta, procura o pendrive de novo sem apagar a frase do último pacote ("Pacote
    /// salvo em …: suporte-…zip"); com um pacote sendo gerado (o Esc volta ao menu sem cancelar), não mexe em nada: o
    /// "gerando…" fica e o Enter continua sem gerar outro.
    /// </summary>
    public async Task CarregarAsync()
    {
        _via = _acesso.Tem(PermissoesPdv.PacoteSuporte);
        if (_via != true)
        {
            Limpar();
            Erro = ServicoPacoteSuporte.MensagemSemPermissao;
            return;
        }

        if (Ocupado)
        {
            return;
        }

        await Ocupar(LerDestinosAsync, limpar: Ultimo is null);
    }

    /// <summary>A liberação da Central que emprestou a permissão acabou: a aba não fica pronta para gerar em nome de quem liberou.</summary>
    public void ConferirPermissoes()
    {
        var antes = _via;
        _via = _acesso.Tem(PermissoesPdv.PacoteSuporte);
        if (antes == true && _via != true)
        {
            _geracao?.Cancel();
            Limpar();
        }
    }

    /// <summary>Enter, F2 ou o botão: gera o pacote e salva no destino escolhido.</summary>
    [RelayCommand]
    private Task Gerar() => Ocupado ? Task.CompletedTask : Ocupar(async () =>
    {
        if (!_acesso.Tem(PermissoesPdv.PacoteSuporte))
        {
            throw new RegraNegocioException(ServicoPacoteSuporte.MensagemSemPermissao);
        }

        if (DestinoSelecionado is not { } destino)
        {
            throw new RegraNegocioException("Escolha onde salvar o pacote (↑/↓; F5 procura o pendrive de novo).");
        }

        var servico = _shell.Servico<ServicoPacoteSuporte>();
        Andamento = servico.Gerando
            ? "Esperando o pacote que já está sendo gerado terminar; depois este é gerado (um por vez)…"
            : $"Gerando o pacote em {destino.Nome} (o caixa continua respondendo)…";
        using var geracao = new CancellationTokenSource();
        _geracao = geracao;
        ResultadoPacote r;
        try
        {
            r = await servico.GerarAsync(destino, geracao.Token);
        }
        catch (OperationCanceledException) when (geracao.IsCancellationRequested)
        {
            throw new RegraNegocioException("A liberação acabou antes de o pacote ficar pronto: ele não foi gerado. Ctrl+L Liberar de novo.");
        }
        finally
        {
            _geracao = null;
        }

        Ultimo = r;
        Mensagem = $"Pacote salvo em {destino.Nome}: {r.Nome} ({MedidorDisco.Legivel(r.Tamanho)}). {ServicoPacoteSuporte.AvisoEntrega}"
                   + (r.Avisos.Count > 0 ? $" {Plural(r.Avisos.Count)} no manifesto (o que ficou de fora e por quê)." : string.Empty)
                   + (r.AvisoRegistro is { } aviso ? $" {aviso}" : string.Empty);
    });

    /// <summary>F5: lê de novo os pendrives (o que acabou de ser ligado aparece).</summary>
    [RelayCommand]
    private Task AtualizarDestinos() => Ocupado ? Task.CompletedTask : Ocupar(async () =>
    {
        if (!_acesso.Tem(PermissoesPdv.PacoteSuporte))
        {
            throw new RegraNegocioException(ServicoPacoteSuporte.MensagemSemPermissao);
        }

        await LerDestinosAsync();
    });

    /// <summary>↑: o destino de cima.</summary>
    [RelayCommand]
    private void Anterior() => Mover(-1);

    /// <summary>↓: o destino de baixo.</summary>
    [RelayCommand]
    private void Proximo() => Mover(1);

    [RelayCommand]
    private Task Voltar() => _voltar();

    private void Mover(int passo)
    {
        if (Destinos.Count == 0 || Ocupado)
        {
            return;
        }

        var atual = DestinoSelecionado is { } d ? Destinos.IndexOf(d) : -1;
        DestinoSelecionado = Destinos[Math.Clamp(atual + passo, 0, Destinos.Count - 1)];
    }

    private async Task LerDestinosAsync()
    {
        var servico = _shell.Servico<ServicoPacoteSuporte>();
        var anterior = DestinoSelecionado?.Pasta;
        var lista = await Task.Run(servico.Destinos);
        Destinos.Clear();
        foreach (var d in lista)
        {
            Destinos.Add(d);
        }

        // O mesmo de antes, se continua ligado; senão o primeiro pendrive (ou os Documentos, sem pendrive).
        DestinoSelecionado = Destinos.FirstOrDefault(d => d.Pasta == anterior) ?? Destinos.FirstOrDefault();
        var pendrives = Destinos.Count(d => d.Removivel);
        DestinosTexto = pendrives switch
        {
            0 => "Nenhum pendrive reconhecido: o pacote fica na pasta Documentos › GenesisPDV-suporte deste computador. Ligue o " +
                 "pendrive e aperte F5; se ele já está ligado e não aparece (o HD externo e alguns pendrives o sistema vê como disco " +
                 "fixo), salve nos Documentos e copie de lá para ele.",
            1 => "Pendrive encontrado: o pacote vai para ele (ou escolha a pasta dos Documentos).",
            _ => $"{pendrives} pendrives ligados: escolha em qual salvar (↑/↓).",
        };
    }

    private static string Plural(int n) => n == 1 ? "1 aviso" : $"{n} avisos";

    private void Limpar()
    {
        Destinos.Clear();
        DestinoSelecionado = null;
        DestinosTexto = null;
        Mensagem = null;
        Erro = null;
        Ultimo = null;
    }

    /// <param name="limpar">Apaga a mensagem e o erro de antes (a volta à aba guarda a frase do último pacote).</param>
    private async Task Ocupar(Func<Task> acao, bool limpar = true)
    {
        Ocupado = true;
        if (limpar)
        {
            Erro = null;
            Mensagem = null;
        }

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
            _shell.Servico<ILogger<AbaPacoteViewModel>>().LogError(e, "Falha na aba Pacote de suporte da Central do PDV");
            Erro = $"O pacote não foi gerado ({MascaradorSuporte.Mascarar(e.Message)}). Confira o pendrive (ligado, com espaço) e tente de novo.";
        }
        finally
        {
            Ocupado = false;
            Andamento = null;
        }
    }
}
