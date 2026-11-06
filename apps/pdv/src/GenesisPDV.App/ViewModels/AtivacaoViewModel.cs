using System.Runtime.InteropServices;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Ativacao;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels;

/// <summary>Um item dos requisitos detectados na boas-vindas (PDV 32.7), com aviso quando abaixo do mínimo.</summary>
public sealed record ItemRequisito(string Nome, string Valor, string? Aviso)
{
    public bool Abaixo => Aviso is not null;
}

/// <summary>
/// Assistente de ativação (PDV 5.3), todo pelo teclado: Enter avança, Esc volta (no passo do código, Esc primeiro limpa
/// os campos). Passos: 1 boas-vindas com os requisitos detectados; 2 conexão (<c>GET /saude</c>, "Tentar novamente");
/// 3 código (empresa + ativação, <c>POST /sync/ativar</c> pelo <see cref="ServicoAtivacao"/>, com a mensagem própria
/// de cada recusa); 4 confirmação (empresa, loja, CNPJ e caixa); Enter segue para a carga inicial (passo 5,
/// <see cref="CargaInicialViewModel"/>). O hardware (passo 6) fica para a configuração local. F8 ativa um terminal de
/// demonstração em qualquer passo, só nos builds de desenvolvimento (<see cref="ConfiguracaoBuild.ModoDemonstracao"/>):
/// no executável publicado (o do instalador) a tecla não faz nada e o botão some (I3, README › decisão 62).
/// </summary>
/// <param name="permiteDemonstracao">O do build; os testes passam <c>false</c> para provar a tela do executável publicado.</param>
public sealed partial class AtivacaoViewModel(ShellViewModel shell, bool permiteDemonstracao = ConfiguracaoBuild.ModoDemonstracao) : ViewModelBase
{
    public const int PassoBoasVindas = 1;
    public const int PassoConexao = 2;
    public const int PassoCodigo = 3;
    public const int PassoConfirmacao = 4;

    /// <summary>
    /// Troca o endereço padrão da API (desenvolvimento, homologação, e2e). Sem ela vale o do build
    /// (<see cref="ConfiguracaoBuild.UrlApiPadrao"/>: o do produto ou o do piloto).
    /// </summary>
    public const string VariavelUrlApi = "GENESISPDV_API";

    public const string MensagemSemInternet = "A ativação exige internet. Depois de ativado, o PDV funciona offline.";

    private static readonly string[] NomesPassos = ["", "Boas-vindas", "Conexão", "Código", "Confirmação"];

    public string Versao => $"GenesisPDV v{VersaoApp.Atual}";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(PassoTexto), nameof(EmBoasVindas), nameof(EmConexao), nameof(EmCodigo), nameof(EmConfirmacao), nameof(Rodape),
        nameof(PodeVoltar), nameof(TextoAvancar), nameof(MostraDemonstracao))]
    public partial int Passo { get; set; } = PassoBoasVindas;

    public string PassoTexto => $"Passo {Passo} de 6 · {NomesPassos[Passo]}";

    public bool EmBoasVindas => Passo == PassoBoasVindas;

    public bool EmConexao => Passo == PassoConexao;

    public bool EmCodigo => Passo == PassoCodigo;

    public bool EmConfirmacao => Passo == PassoConfirmacao;

    public bool PodeVoltar => Passo is PassoConexao or PassoCodigo;

    public string TextoAvancar => Passo switch
    {
        PassoBoasVindas => "[Enter] Começar",
        PassoConexao => "[Enter] Testar conexão",
        PassoCodigo => "[Enter] Ativar",
        _ => "[Enter] Baixar os cadastros",
    };

    /// <summary>F8 e o botão do modo demonstração só existem nos builds de desenvolvimento.</summary>
    public bool PermiteDemonstracao { get; } = permiteDemonstracao;

    public bool MostraDemonstracao => PermiteDemonstracao && !EmConfirmacao;

    public string Rodape => Passo switch
    {
        PassoBoasVindas => "Enter começa" + TeclaDemonstracao(" (sem nuvem)"),
        PassoConexao => "Enter testa a conexão · Esc volta" + TeclaDemonstracao(),
        PassoCodigo => "Enter ativa · Esc limpa (e volta, com os campos vazios) · Tab troca de campo" + TeclaDemonstracao(),
        _ => "Enter baixa os cadastros da loja (carga inicial)",
    };

    public IReadOnlyList<ItemRequisito> Requisitos { get; } = DetectarRequisitos(shell.Servico<CaminhosPdv>());

    [ObservableProperty]
    public partial string CodigoEmpresa { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string CodigoAtivacao { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string UrlServidor { get; set; } = ConfiguracaoBuild.UrlApiInicial(Environment.GetEnvironmentVariable(VariavelUrlApi));

    [ObservableProperty]
    public partial string? ErroCodigoEmpresa { get; set; }

    [ObservableProperty]
    public partial string? ErroCodigoAtivacao { get; set; }

    [ObservableProperty]
    public partial string? ErroUrl { get; set; }

    [ObservableProperty]
    public partial string? Mensagem { get; set; }

    /// <summary>Chamada à API em andamento (o assistente ignora Enter/Esc até voltar).</summary>
    [ObservableProperty]
    public partial bool Ocupado { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(EmpresaTexto), nameof(LojaTexto), nameof(CnpjTexto), nameof(CaixaTexto))]
    public partial TerminalAtivado? Ativado { get; set; }

    public string EmpresaTexto => Ativado is { } a ? $"{a.RazaoSocial} (código {a.EmpresaCodigo})" : string.Empty;

    public string LojaTexto => Ativado is { } a ? $"{a.LojaCodigo} - {a.LojaNome}" : string.Empty;

    public string CnpjTexto => Ativado is { } a ? FormatarCnpj(a.LojaCnpj) : string.Empty;

    public string CaixaTexto => Ativado is { } a ? $"Caixa {a.NumeroCaixa:00}" : string.Empty;

    /// <summary>A View foca o primeiro campo do passo (e o próprio assistente nos passos sem campo).</summary>
    public event EventHandler? FocoPedido;

    partial void OnCodigoAtivacaoChanged(string value)
    {
        var normalizado = FormatoAtivacao.NormalizarCodigoAtivacao(value);
        if (normalizado.Length <= 9 && normalizado != value)
        {
            // Postado: alterar a origem durante a escrita da própria ligação não chega de volta ao TextBox.
            Avalonia.Threading.Dispatcher.UIThread.Post(() => CodigoAtivacao = normalizado);
        }
    }

    partial void OnPassoChanged(int value) => FocoPedido?.Invoke(this, EventArgs.Empty);

    [RelayCommand]
    private async Task AvancarAsync()
    {
        if (Ocupado)
        {
            return;
        }

        switch (Passo)
        {
            case PassoBoasVindas:
                Mensagem = null;
                Passo = PassoConexao;
                break;
            case PassoConexao:
                await TestarConexaoAsync();
                break;
            case PassoCodigo:
                await AtivarAsync();
                break;
            case PassoConfirmacao:
                await shell.IrParaCargaInicialAsync();
                break;
        }
    }

    [RelayCommand]
    private void Voltar()
    {
        if (Ocupado)
        {
            return;
        }

        switch (Passo)
        {
            case PassoConexao:
                Mensagem = ErroUrl = null;
                Passo = PassoBoasVindas;
                break;
            case PassoCodigo when CodigoEmpresa.Length > 0 || CodigoAtivacao.Length > 0 || Mensagem is not null:
                Limpar();
                break;
            case PassoCodigo:
                Passo = PassoConexao;
                break;
        }
    }

    /// <summary>Esc no passo do código: limpa e volta o foco ao primeiro campo.</summary>
    private void Limpar()
    {
        CodigoEmpresa = string.Empty;
        CodigoAtivacao = string.Empty;
        ErroCodigoEmpresa = ErroCodigoAtivacao = Mensagem = null;
        FocoPedido?.Invoke(this, EventArgs.Empty);
    }

    private async Task TestarConexaoAsync()
    {
        ErroUrl = FormatoAtivacao.ValidarUrlServidor(UrlServidor);
        if (ErroUrl is not null)
        {
            Mensagem = null;
            return;
        }

        var url = FormatoAtivacao.NormalizarUrl(new Uri(UrlServidor.Trim()));
        Ocupado = true;
        Mensagem = $"Testando a conexão com {url.Authority}…";
        try
        {
            if (await shell.Servico<ServicoAtivacao>().TestarConexaoAsync(url))
            {
                Mensagem = null;
                Passo = PassoCodigo;
            }
            else
            {
                Mensagem = $"{MensagemSemInternet} Não foi possível falar com {url.Authority}: confira a rede e o endereço e pressione Enter para tentar novamente.";
            }
        }
        finally
        {
            Ocupado = false;
        }
    }

    private async Task AtivarAsync()
    {
        ErroCodigoEmpresa = FormatoAtivacao.ValidarCodigoEmpresa(CodigoEmpresa);
        ErroCodigoAtivacao = FormatoAtivacao.ValidarCodigoAtivacao(CodigoAtivacao);
        if (ErroCodigoEmpresa is not null || ErroCodigoAtivacao is not null)
        {
            Mensagem = "Corrija os campos destacados.";
            return;
        }

        Ocupado = true;
        Mensagem = "Ativando o terminal…";
        try
        {
            var url = FormatoAtivacao.NormalizarUrl(new Uri(UrlServidor.Trim()));
            var resultado = await shell.Servico<ServicoAtivacao>().AtivarAsync(url, CodigoEmpresa, CodigoAtivacao);
            if (resultado.Terminal is not { } ativado)
            {
                Mensagem = resultado.Mensagem;
                return;
            }

            await ConfirmarAsync(ativado);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // Falha local depois da resposta (disco, banco). A ativação grava tudo num commit só, mas a falha pode ter
            // vindo depois dele (releitura da identidade): com a identidade gravada, segue para a confirmação; sem ela,
            // nada foi gravado e a repetição usa a mesma requisição.
            shell.Servico<ILogger<AtivacaoViewModel>>().LogError(e, "Falha ao gravar a ativação no banco local");
            if (!await ConfirmarGravadaAsync())
            {
                Mensagem = "O servidor ativou o terminal, mas o banco local não gravou. Pressione Enter para tentar de novo " +
                           "(o mesmo código continua valendo por 15 minutos).";
            }
        }
        finally
        {
            Ocupado = false;
        }
    }

    private async Task ConfirmarAsync(TerminalAtivado ativado)
    {
        var identidade = await shell.Servico<RepositorioTerminal>().ObterIdentidadeAsync();
        var sessao = shell.Servico<SessaoTerminal>();
        sessao.Identidade = identidade;
        sessao.AplicarResumo(ativado);
        Ativado = ativado;
        Mensagem = null;
        Passo = PassoConfirmacao;
    }

    /// <summary>Releitura depois de uma falha: a ativação real já gravada (identidade e resumo) vai para a confirmação.</summary>
    private async Task<bool> ConfirmarGravadaAsync()
    {
        try
        {
            var terminal = shell.Servico<RepositorioTerminal>();
            if (await terminal.ObterIdentidadeAsync() is not { Demonstracao: false }
                || await terminal.ObterConfiguracaoAsync<TerminalAtivado>(ChavesConfiguracaoTerminal.ResumoAtivacao) is not { } resumo)
            {
                return false;
            }

            await ConfirmarAsync(resumo);
            return true;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // O banco segue falhando: a mensagem pede outra tentativa (reiniciar o PDV também resolve se gravou).
            shell.Servico<ILogger<AtivacaoViewModel>>().LogError(e, "Falha ao reler a ativação no banco local");
            return false;
        }
    }

    [RelayCommand]
    private async Task AtivarDemonstracaoAsync()
    {
        if (!PermiteDemonstracao || Ocupado || Passo == PassoConfirmacao)
        {
            return;
        }

        var relogio = shell.Servico<IRelogio>();
        var identidade = new IdentidadeTerminal
        {
            TerminalId = IdGerador.Novo(),
            EmpresaCodigo = 0,
            LojaId = Guid.Parse("019a0005-0000-7000-8000-000000000001"),
            CaixaId = Guid.Parse("019a0005-0000-7000-8000-000000000002"),
            NumeroCaixa = 2,
            UrlApi = IdentidadeTerminal.UrlDemonstracao,
            TokenProtegido = [],
            Status = "ativo",
            AtivadoEm = relogio.Agora,
            NomeMaquina = Environment.MachineName,
        };
        await shell.Servico<RepositorioTerminal>().RegistrarAtivacaoAsync(identidade, new LogAuditoriaLocal
        {
            Id = IdGerador.Novo(),
            OcorridoEm = relogio.Agora,
            Acao = "terminal_ativado_demonstracao",
            Entidade = "terminal",
            RegistroId = identidade.TerminalId,
            Localizacao = "pdv.ativacao",
            Descricao = "Terminal ativado em modo demonstração (sem nuvem)",
        });
        shell.Servico<SessaoTerminal>().Identidade = identidade;
#if MODO_DEMONSTRACAO
        await CatalogoDemonstracao.GarantirAsync(shell.Servico<RepositorioEspelhos>(), relogio.Agora);
#endif
        shell.IrParaLogin();
    }

    private string TeclaDemonstracao(string complemento = "") =>
        PermiteDemonstracao ? $" · F8 modo demonstração{complemento}" : string.Empty;

    private static string FormatarCnpj(string cnpj) =>
        cnpj.Length == 14 ? $"{cnpj[..2]}.{cnpj[2..5]}.{cnpj[5..8]}/{cnpj[8..12]}-{cnpj[12..]}" : cnpj;

    /// <summary>Requisitos mínimos da PDV 32.7 que dá para medir sem tela: sistema, núcleos, memória e disco livre.</summary>
    private static List<ItemRequisito> DetectarRequisitos(CaminhosPdv caminhos)
    {
        var itens = new List<ItemRequisito>
        {
            new("Sistema", RuntimeInformation.OSDescription, RuntimeInformation.OSArchitecture == Architecture.X64 ? null : "precisa ser 64 bits"),
            new("Processador", $"{Environment.ProcessorCount} núcleos", Environment.ProcessorCount < 2 ? "mínimo 2 núcleos" : null),
        };
        var memoriaGb = GC.GetGCMemoryInfo().TotalAvailableMemoryBytes / 1024d / 1024 / 1024;
        itens.Add(new ItemRequisito("Memória", $"{memoriaGb:0.0} GB", memoriaGb < 3.5 ? "mínimo 4 GB" : null));
        try
        {
            var disco = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(caminhos.PastaDados))!);
            var livreGb = disco.AvailableFreeSpace / 1024d / 1024 / 1024;
            itens.Add(new ItemRequisito("Disco livre", $"{livreGb:0} GB", livreGb < 20 ? "mínimo 20 GB livres" : null));
        }
        catch (Exception e) when (e is IOException or ArgumentException or UnauthorizedAccessException)
        {
            itens.Add(new ItemRequisito("Disco livre", "não foi possível medir", null));
        }

        return itens;
    }
}
