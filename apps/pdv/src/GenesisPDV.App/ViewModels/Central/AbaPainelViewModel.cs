using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Sync.Cliente;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels.Central;

/// <summary>Uma linha do Painel de saúde: a bolinha, o nome, a frase, o que fazer e o botão da ação.</summary>
public sealed class LinhaSaudeViewModel(ItemSaude item) : ViewModelBase
{
    public ItemSaude Item { get; } = item;

    public string Codigo => Item.Codigo;

    public string Nome => Item.Nome;

    public string Frase => Item.Frase;

    public string? OQueFazer => Item.OQueFazer is { } o ? $"O que fazer: {o}" : null;

    public bool Ok => Item.Nivel == NivelSaude.Ok;

    public bool Aviso => Item.Nivel == NivelSaude.Aviso;

    public bool Problema => Item.Nivel == NivelSaude.Problema;

    /// <summary>Para quem não distingue as cores (e o leitor de tela): a palavra ao lado da bolinha.</summary>
    public string NivelTexto => Item.Nivel switch
    {
        NivelSaude.Problema => "PROBLEMA",
        NivelSaude.Aviso => "ATENÇÃO",
        _ => "OK",
    };

    public string? RotuloAcao => Item.Acao?.Rotulo;

    public bool TemAcao => Item.Acao is not null;

    public string Leitura => $"{NivelTexto}: {Nome}. {Frase} {OQueFazer}".Trim();
}

/// <summary>
/// Aba 0 da Central do PDV, o <b>Painel de saúde</b> (bloco G4; plano 4.1; PC-7: qualquer usuário do caixa vê, só
/// leitura, sem PIN): as verificações do <see cref="VerificadorSaude"/> com a bolinha verde, amarela ou vermelha, a frase,
/// o que fazer e o botão (abrir a aba certa ou Sincronizar agora), e o código do terminal para o suporte. Abre já
/// verificando (o vermelho primeiro). Teclas: ↑/↓ escolhem a linha, Enter faz a ação dela, F5 verifica de novo,
/// Ctrl+Alt+S sincroniza agora e Esc volta ao menu; tudo também pelo mouse. Funciona sem internet.
/// </summary>
public sealed partial class AbaPainelViewModel : ViewModelBase
{
    private readonly ShellViewModel _shell;
    private readonly Func<string, string?, Task> _abrirAba;
    private readonly Func<Task> _voltar;
    private int _rodada;

    /// <param name="abrirAba">O botão da linha que leva a outra aba da Central (o código do menu e o filtro, <see cref="AcaoSaude.Filtro"/>).</param>
    /// <param name="voltar">Esc: volta ao menu da Central.</param>
    public AbaPainelViewModel(ShellViewModel shell, Func<string, string?, Task> abrirAba, Func<Task> voltar)
    {
        _shell = shell;
        _abrirAba = abrirAba;
        _voltar = voltar;
        var identidade = shell.Servico<SessaoTerminal>().Identidade;
        CodigoTerminal = identidade?.CodigoCurto ?? "—";
    }

    public string Titulo => AbasCentral.Painel.Rotulo;

    /// <summary>"cx2-9f3a01bc": o código curto que o suporte pede (decisão 67).</summary>
    public string CodigoTerminal { get; }

    public string CodigoTexto => $"Código do terminal para o suporte: {CodigoTerminal}";

    public string Teclas => "↑/↓ escolhem · Enter faz a ação da linha · F5 verifica de novo · Ctrl+Alt+S sincroniza agora · P pacote para o suporte · Esc volta ao menu";

    public ObservableCollection<LinhaSaudeViewModel> Linhas { get; } = [];

    [ObservableProperty]
    public partial LinhaSaudeViewModel? Selecionada { get; set; }

    /// <summary>"Tudo certo" ou "1 problema e 2 avisos", com a hora da verificação.</summary>
    [ObservableProperty]
    public partial string Resumo { get; set; } = "Verificando…";

    [ObservableProperty]
    public partial bool TemProblema { get; set; }

    [ObservableProperty]
    public partial bool Verificando { get; set; }

    [ObservableProperty]
    public partial string? Mensagem { get; set; }

    /// <summary>A tela leva o foco à linha escolhida (Enter ou o 0 de novo no menu).</summary>
    public event EventHandler? FocoSolicitado;

    /// <summary>
    /// A lista vai ser refeita (o item com o foco some): a tela anota se o foco estava na aba, para devolvê-lo à linha
    /// escolhida em <see cref="LinhasAtualizadas"/> (foco previsível: ↑/↓, Enter e F5 seguem sem clique).
    /// </summary>
    public event EventHandler? AtualizandoLinhas;

    /// <summary>A lista foi refeita com a rodada nova.</summary>
    public event EventHandler? LinhasAtualizadas;

    /// <summary>Roda as verificações (em paralelo, até 2 s cada) e redesenha a lista; uma rodada nova ganha da anterior.</summary>
    public async Task AtualizarAsync()
    {
        var rodada = ++_rodada;
        Verificando = true;
        Resumo = "Verificando…";
        try
        {
            var resultado = await _shell.Servico<VerificadorSaude>().VerificarAsync(completa: true);
            if (rodada != _rodada)
            {
                return;
            }

            var codigo = Selecionada?.Codigo;
            AtualizandoLinhas?.Invoke(this, EventArgs.Empty);
            Linhas.Clear();
            foreach (var item in resultado.Itens)
            {
                Linhas.Add(new LinhaSaudeViewModel(item));
            }

            Selecionada = Linhas.FirstOrDefault(l => l.Codigo == codigo) ?? Linhas.FirstOrDefault();
            LinhasAtualizadas?.Invoke(this, EventArgs.Empty);
            TemProblema = resultado.Problemas > 0;
            var hora = TimeZoneInfo.ConvertTime(resultado.VerificadoEm, DiaOperacional.ObterFuso(_shell.Servico<SessaoTerminal>().FusoHorario))
                .ToString("HH:mm:ss", NumeroBr.Cultura);
            Resumo = (resultado.Problemas, resultado.Avisos) switch
            {
                (0, 0) => $"Tudo certo · verificado às {hora}",
                (var p, 0) => $"{Plural(p, "problema", "problemas")} · verificado às {hora}",
                (0, var a) => $"{Plural(a, "ponto de atenção", "pontos de atenção")} · verificado às {hora}",
                (var p, var a) => $"{Plural(p, "problema", "problemas")} e {Plural(a, "ponto de atenção", "pontos de atenção")} · verificado às {hora}",
            };
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            _shell.Servico<ILogger<AbaPainelViewModel>>().LogError(e, "Falha no Painel de saúde");
            Resumo = $"Não deu para verificar agora ({MascaradorSuporte.Mascarar(e.Message)}). F5 tenta de novo.";
        }
        finally
        {
            if (rodada == _rodada)
            {
                Verificando = false;
            }
        }
    }

    /// <summary>A Central pede o foco no conteúdo (o 0 de novo no menu): vai à linha escolhida.</summary>
    public void Focar() => FocoSolicitado?.Invoke(this, EventArgs.Empty);

    [RelayCommand]
    private Task Verificar()
    {
        Mensagem = null;
        return AtualizarAsync();
    }

    /// <summary>Ctrl+Alt+S (o mesmo da venda, PDV 30.2): push, heartbeat e pull na hora; depois verifica de novo.</summary>
    [RelayCommand]
    private Task Sincronizar()
    {
        var sync = _shell.Servico<IServicoSincronizacao>();
        if (sync.Situacao.SemNuvem)
        {
            Mensagem = "Terminal de demonstração: nada sobe nem desce.";
            return Task.CompletedTask;
        }

        sync.SincronizarAgora();
        Mensagem = "Sincronizando agora… (F5 verifica de novo)";
        return AtualizarAsync();
    }

    /// <summary>O botão da linha (ou o Enter nela): a aba certa da Central, ou Sincronizar agora.</summary>
    [RelayCommand]
    private Task ExecutarAcao(LinhaSaudeViewModel? linha)
    {
        linha ??= Selecionada;
        if (linha?.Item.Acao is not { } acao)
        {
            return Task.CompletedTask;
        }

        Selecionada = linha;
        return acao.Sincronizar ? Sincronizar() : acao.Aba is { } aba ? _abrirAba(aba, acao.Filtro) : Task.CompletedTask;
    }

    /// <summary>P ou o botão do rodapé: a aba P Pacote de suporte (bloco G9), pelo mesmo caminho do menu (com o cadeado, pede quem pode).</summary>
    [RelayCommand]
    private Task AbrirPacote() => _abrirAba(AbasCentral.Pacote.Codigo, null);

    [RelayCommand]
    private Task Voltar() => _voltar();

    private static string Plural(int n, string singular, string plural) => n == 1 ? $"1 {singular}" : $"{n} {plural}";
}
