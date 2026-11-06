using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.Data;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Pull;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels;

/// <summary>Uma linha da tela de progresso: um fluxo da carga inicial (SYNC 6.1).</summary>
public sealed partial class ItemFluxoCarga(string fluxo, string nome, bool bloqueante) : ObservableObject
{
    public string Fluxo { get; } = fluxo;

    public string Nome { get; } = nome;

    /// <summary>Bloqueia o login até concluir (configuração, acesso, referência, catálogo e estoque).</summary>
    public bool Bloqueante { get; } = bloqueante;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Situacao))]
    public partial int Percentual { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Situacao))]
    public partial long Linhas { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Situacao))]
    public partial bool Concluido { get; set; }

    public string Situacao => Concluido ? $"concluído ({Linhas:N0} linhas)" : Linhas > 0 ? $"{Percentual}% · {Linhas:N0} linhas" : "aguardando";
}

/// <summary>
/// Passo 5 do assistente (PDV 5.3) e retomada na abertura: carga inicial dos 7 fluxos com uma barra por fluxo
/// (<see cref="CargaInicial"/>). Interrompida, a próxima abertura retoma do cursor salvo; um erro mostra a mensagem e
/// Enter tenta de novo, menos o 401: <c>TERMINAL_REVOGADO</c> vai para "Terminal desativado" (a carga já gravou o
/// <c>revogado</c>) e <c>TOKEN_INVALIDO</c> para o bloqueio "chame o suporte" do handshake. Concluídos os fluxos que bloqueiam as vendas, Enter vai para o login e <c>pessoas</c>/
/// <c>operacao</c> continuam em segundo plano.
/// </summary>
public sealed partial class CargaInicialViewModel(ShellViewModel shell) : ViewModelBase
{
    private static readonly Dictionary<string, string> Nomes = new(StringComparer.Ordinal)
    {
        ["configuracao"] = "Configurações da loja",
        ["acesso"] = "Usuários e permissões",
        ["referencia"] = "Tabelas fiscais",
        ["catalogo"] = "Produtos e preços",
        ["estoque"] = "Estoque da loja",
        ["pessoas"] = "Clientes e funcionários",
        ["operacao"] = "Operação",
    };

    private Task? _execucao;

    public ObservableCollection<ItemFluxoCarga> Fluxos { get; } =
        [.. CargaInicial.Ordem.Select(f => new ItemFluxoCarga(f, Nomes.GetValueOrDefault(f, f), CargaInicial.Bloqueantes.Contains(f)))];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Rodape))]
    public partial bool LoginLiberado { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Rodape))]
    public partial bool Executando { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Rodape))]
    public partial bool Concluida { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Rodape))]
    public partial string? Erro { get; set; }

    public string Rodape => Erro is not null
        ? "Enter tenta de novo (continua de onde parou)"
        : LoginLiberado
            ? Concluida ? "Carga concluída · Enter entra no caixa" : "Enter entra no caixa · clientes continuam baixando em segundo plano"
            : "Baixando os cadastros da nuvem… o caixa libera ao fim do estoque";

    /// <summary>Começa (ou retoma) a carga; volta quando ela termina ou falha.</summary>
    public Task IniciarAsync()
    {
        if (_execucao is { IsCompleted: false })
        {
            return _execucao;
        }

        _execucao = ExecutarAsync();
        return _execucao;
    }

    private async Task ExecutarAsync()
    {
        Erro = null;
        Executando = true;
        var progresso = new Progress<ProgressoCarga>(Aplicar);
        try
        {
            await shell.Servico<CargaInicial>().ExecutarAsync(progresso);
            Concluida = true;
            LoginLiberado = true;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            shell.Servico<ILogger<CargaInicialViewModel>>().LogWarning(e, "Carga inicial interrompida");
            if (CargaInicial.Revogado(e))
            {
                shell.IrParaDesativado();
                return;
            }

            if (CargaInicial.TokenRecusado(e))
            {
                shell.IrParaBloqueioSuporte(MensagensBloqueioNuvem.TokenRecusado);
                return;
            }

            Erro = e is ErroSyncException { Transitorio: true } or HttpRequestException or TaskCanceledException
                ? "Sem conexão com a nuvem. Confira a internet e pressione Enter para continuar de onde parou."
                : $"A carga parou: {e.Message} Pressione Enter para tentar de novo.";
            LoginLiberado = await CargaInicial.LoginLiberadoAsync(shell.Servico<IDbContextFactory<PdvDbContext>>());
        }
        finally
        {
            Executando = false;
        }

        if (LoginLiberado)
        {
            await shell.Servico<SessaoTerminal>().CarregarDoEspelhoAsync(shell.Servico<IDbContextFactory<PdvDbContext>>());
        }
    }

    private void Aplicar(ProgressoCarga p)
    {
        var item = Fluxos[p.Indice];
        item.Linhas = Math.Max(item.Linhas, p.Linhas);
        item.Percentual = p.Percentual;
        item.Concluido = p.FluxoConcluido;
        LoginLiberado |= p.LoginLiberado;
    }

    [RelayCommand]
    private async Task AvancarAsync()
    {
        if (LoginLiberado)
        {
            await shell.Servico<SessaoTerminal>().CarregarDoEspelhoAsync(shell.Servico<IDbContextFactory<PdvDbContext>>());
            shell.IrParaLogin();
            return;
        }

        if (!Executando && Erro is not null)
        {
            await IniciarAsync();
        }
    }
}
