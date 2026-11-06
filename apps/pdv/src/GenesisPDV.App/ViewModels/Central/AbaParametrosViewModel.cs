using System.Collections.ObjectModel;
using System.Globalization;
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

/// <summary>Para onde a aba 7 leva o foco.</summary>
public enum AlvoFocoParametros
{
    /// <summary>O campo dos minutos do bloqueio (o primeiro que o teclado numérico preenche).</summary>
    Bloqueio,

    /// <summary>O campo da pasta secundária.</summary>
    Pasta,
}

/// <summary>
/// Aba 7 da Central do PDV, <b>Parâmetros</b> (bloco G11; plano 4.5; PC-2 e PC-13; spec 6.2.2, 6.8 e 6.9; README › decisão
/// 75). Duas partes:
/// <list type="bullet">
/// <item><b>Do caixa</b> (editáveis, <see cref="ServicoParametrosLocais"/>): o tema, o bloqueio da tela por inatividade (0 a
/// 120 min, 0 = desligado, o padrão) e a pasta secundária do backup (com o "Testar pasta" e o aviso de que o backup é o
/// banco inteiro, sem cifra). F2 grava com a auditoria antes/depois; sem <c>pdv.config.parametros_locais</c> (a liberação
/// da Central só empresta o ver), o supervisor libera na hora (usuário, PIN e motivo, PDV 31.3), sobre a aba.</item>
/// <item><b>Da loja</b> (só leitura): cada regra que o caixa lê (<see cref="CatalogoRotulosConfiguracao"/>) com o valor que
/// está valendo, a origem (a loja, a empresa ou o padrão), o selo "definido no ERP" e onde mudar no ERP, e quando as
/// regras desceram da nuvem pela última vez. Nada se edita aqui (PC-2: os caixas da mesma loja não divergem).</item>
/// </list>
/// Abre com <c>pdv.diagnostico.ver</c> (a própria ou a emprestada pelo Ctrl+L). Teclas: F2 Salvar, F6 Testar pasta, F5
/// Atualizar, Esc fecha o pedido do supervisor e volta ao menu; os botões fazem o mesmo (decisão 65). O F6 grava um
/// arquivo de teste na pasta: pede a própria <c>pdv.config.parametros_locais</c> (o ver emprestado não grava em disco);
/// sem ela, o F2 testa a pasta depois da liberação do supervisor. Antes do PIN do supervisor vem tudo o que se confere
/// sem gravar (<see cref="ServicoParametrosLocais.PrepararAsync"/>).
/// </summary>
public sealed partial class AbaParametrosViewModel : ViewModelBase
{
    public const string MensagemSalvo = "Parâmetros do caixa gravados.";

    public const string MensagemSemPermissao =
        "Os parâmetros pedem quem pode ver o diagnóstico (pdv.diagnostico.ver): Ctrl+L Liberar.";

    public const string MensagemTestarSemPermissao =
        "Testar a pasta grava um arquivo nela e pede quem pode editar os parâmetros (pdv.config.parametros_locais). Sem ela, o F2 Salvar testa a pasta depois da liberação do supervisor.";

    /// <summary>0 = escuro (padrão), 1 = claro.</summary>
    public static IReadOnlyList<string> Temas { get; } = ["Escuro (padrão)", "Claro"];

    private readonly ShellViewModel _shell;
    private readonly Func<Task> _voltar;
    private readonly AcessoCentral _acesso;
    private bool? _via;

    public AbaParametrosViewModel(ShellViewModel shell, Func<Task> voltar)
    {
        _shell = shell;
        _voltar = voltar;
        _acesso = shell.Servico<AcessoCentral>();
    }

    public string Titulo => AbasCentral.Parametros.Rotulo;

    public string AvisoPasta => ServicoParametrosLocais.AvisoPastaSecundaria;

    public string AjudaBloqueio => string.Create(CultureInfo.InvariantCulture,
        $"Minutos sem tecla nem mouse até a tela da venda bloquear (de {ServicoParametrosLocais.BloqueioMinimo} a {ServicoParametrosLocais.BloqueioMaximo}; 0 = nunca, o padrão). Desbloqueia com o PIN de quem está no caixa ou do supervisor; a venda em andamento fica guardada.");

    [ObservableProperty]
    public partial int TemaIndice { get; set; }

    [ObservableProperty]
    public partial string BloqueioMinutos { get; set; } = "0";

    [ObservableProperty]
    public partial string PastaSecundaria { get; set; } = string.Empty;

    /// <summary>"Você grava" ou "O supervisor libera na hora (F2)": o que acontece no Salvar.</summary>
    [ObservableProperty]
    public partial string? PermissaoTexto { get; set; }

    public ObservableCollection<RegraLojaExibida> Regras { get; } = [];

    [ObservableProperty]
    public partial string? UltimoPullTexto { get; set; }

    [ObservableProperty]
    public partial string? Mensagem { get; set; }

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [ObservableProperty]
    public partial bool Ocupado { get; set; }

    /// <summary>O que está em curso ("Testando a pasta…"), enquanto a tela espera: o disco ou a rede lentos não ficam mudos.</summary>
    [ObservableProperty]
    public partial string? Andamento { get; set; }

    /// <summary>Gravar sem a permissão: o supervisor libera na hora, sobre a aba (PDV 31.3).</summary>
    [ObservableProperty]
    public partial PedidoLiberacaoViewModel? Liberacao { get; set; }

    public event EventHandler<AlvoFocoParametros>? FocoSolicitado;

    public void Focar() => FocoSolicitado?.Invoke(this, AlvoFocoParametros.Bloqueio);

    /// <summary>Lê os parâmetros do caixa e as regras da loja (a cada visita; o que está sendo digitado é lido de novo).</summary>
    public async Task CarregarAsync()
    {
        _via = _acesso.Tem(PermissoesPdv.VerDiagnostico);
        if (_via != true)
        {
            Limpar();
            Erro = MensagemSemPermissao;
            return;
        }

        await Ocupar(async () =>
        {
            var parametros = _shell.Servico<ServicoParametrosLocais>();
            var atuais = await parametros.LerAsync();
            TemaIndice = atuais.Tema == ServicoTema.Claro ? 1 : 0;
            BloqueioMinutos = atuais.BloqueioInatividadeMin.ToString(CultureInfo.InvariantCulture);
            PastaSecundaria = atuais.PastaSecundaria ?? string.Empty;
            PermissaoTexto = _acesso.Usuario?.Tem(PermissoesPdv.ParametrosLocais) == true
                ? "Você pode gravar os parâmetros do caixa (F2)."
                : "Para gravar, o supervisor libera na hora (F2 pede o usuário, o PIN e o motivo).";

            var sessao = _shell.Servico<SessaoTerminal>();
            var configuracoes = _shell.Servico<RepositorioConfiguracoes>();
            var lojaId = sessao.Identidade?.LojaId ?? Guid.Empty;
            var chaves = CatalogoRotulosConfiguracao.Todos.Select(r => r.Chave).ToList();
            var (valores, pull) = await Task.Run(async () => (await configuracoes.ValoresEfetivosAsync(chaves, lojaId), await configuracoes.UltimoPullAsync()));
            Regras.Clear();
            foreach (var valor in valores)
            {
                Regras.Add(CatalogoRotulosConfiguracao.Exibir(CatalogoRotulosConfiguracao.De(valor.Chave)!, valor));
            }

            var fuso = DiaOperacional.ObterFuso(sessao.FusoHorario);
            UltimoPullTexto = sessao.Identidade is { Demonstracao: true }
                ? "Terminal de demonstração: as regras são as padrão (sem nuvem)."
                : pull is { } quando
                    ? $"Regras da loja recebidas do ERP em {TimeZoneInfo.ConvertTime(quando, fuso).ToString("dd/MM/yyyy HH:mm", NumeroBr.Cultura)}."
                    : "As regras da loja ainda não desceram do ERP (vale o padrão até a primeira sincronização).";
        });
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

    /// <summary>F2: grava (a própria permissão, ou o supervisor na hora).</summary>
    [RelayCommand]
    private Task Salvar() => Liberacao is not null || Ocupado ? Task.CompletedTask : Ocupar(async () =>
    {
        Exigir();
        var novos = Montar();
        var usuario = _acesso.Usuario ?? throw new RegraNegocioException(AcessoCentral.MensagemFechada);
        if (usuario.Tem(PermissoesPdv.ParametrosLocais))
        {
            await GravarAsync(novos, null);
            return;
        }

        // Tudo o que se confere sem gravar vem antes do PIN (a faixa, o "nada mudou", a regra da pasta e o pendrive
        // ligado): o supervisor não libera o que não vai gravar. O teste de escrita da pasta vem com a liberação.
        Andamento = "Conferindo antes de chamar o supervisor…";
        await _shell.Servico<ServicoParametrosLocais>().PrepararAsync(novos);
        Liberacao = new PedidoLiberacaoViewModel(
            _shell.Servico<IAutenticadorOperador>(), _shell.Servico<IRelogio>(), usuario, PermissoesPdv.ParametrosLocais,
            "Gravar os parâmetros do caixa",
            async concedida =>
            {
                Liberacao = null;
                await Ocupar(() => GravarAsync(novos, concedida));
                FocoSolicitado?.Invoke(this, AlvoFocoParametros.Bloqueio);
            },
            erro =>
            {
                Liberacao = null;
                Erro = erro;
                FocoSolicitado?.Invoke(this, AlvoFocoParametros.Bloqueio);
                return Task.CompletedTask;
            });
    });

    /// <summary>F6: grava e apaga um arquivo de teste na pasta secundária (não grava o parâmetro).</summary>
    [RelayCommand]
    private Task TestarPasta() => Liberacao is not null || Ocupado ? Task.CompletedTask : Ocupar(async () =>
    {
        Exigir();
        // A liberação Ctrl+L só empresta o ver: criar pasta e gravar arquivo pede a permissão da própria pessoa.
        if (_acesso.Usuario?.Tem(PermissoesPdv.ParametrosLocais) != true)
        {
            throw new RegraNegocioException(MensagemTestarSemPermissao);
        }

        var pasta = PastaSecundaria.Trim();
        Andamento = "Testando a pasta (grava, lê e apaga um arquivo pequeno)…";
        if (await _shell.Servico<ServicoParametrosLocais>().TestarPastaAsync(pasta) is { } erro)
        {
            throw new RegraNegocioException(erro);
        }

        Mensagem = $"A pasta {MascaradorSuporte.Mascarar(pasta)} funciona: o caixa gravou e apagou um arquivo de teste nela. F2 grava o parâmetro.";
    });

    [RelayCommand]
    private Task Atualizar() => Liberacao is not null || Ocupado ? Task.CompletedTask : LimparMensagensECarregarAsync();

    /// <summary>Esc: fecha o pedido do supervisor; sem ele, volta ao menu.</summary>
    [RelayCommand]
    private Task Voltar()
    {
        if (Liberacao is not null)
        {
            Liberacao = null;
            FocoSolicitado?.Invoke(this, AlvoFocoParametros.Bloqueio);
            return Task.CompletedTask;
        }

        return Ocupado ? Task.CompletedTask : _voltar();
    }

    private async Task LimparMensagensECarregarAsync()
    {
        Mensagem = null;
        Erro = null;
        await CarregarAsync();
    }

    private async Task GravarAsync(ParametrosCaixa novos, LiberacaoConcedida? liberacao)
    {
        Exigir();
        var usuario = _acesso.Usuario ?? throw new RegraNegocioException(AcessoCentral.MensagemFechada);
        Andamento = "Gravando os parâmetros do caixa…";
        var mudaram = await _shell.Servico<ServicoParametrosLocais>().GravarAsync(novos, usuario, liberacao);
        // Só o que mudou: a pasta só aparece "testada agora" quando ela mudou (e o teste de escrita rodou).
        Mensagem = MensagemSalvo
                   + (!mudaram.Contains(ServicoTema.Chave) ? string.Empty : novos.Tema == ServicoTema.Claro ? " Tema claro." : " Tema escuro.")
                   + (!mudaram.Contains(ServicoParametrosLocais.ChaveBloqueioInatividade)
                       ? string.Empty
                       : novos.BloqueioInatividadeMin == 0 ? " Bloqueio da tela desligado." : $" A tela da venda bloqueia depois de {novos.BloqueioInatividadeMin} min sem uso.")
                   + (!mudaram.Contains(BackupLocal.ChavePastaSecundaria)
                       ? string.Empty
                       : novos.PastaSecundaria is null ? " Sem cópia do backup em pasta secundária." : " A cópia do backup vai para a pasta secundária (testada agora).")
                   + (liberacao is null ? string.Empty : $" Liberado por {liberacao.Supervisor.Nome}.");
    }

    /// <summary>Os parâmetros como estão na tela (sem gravar); minutos fora do número viram a mensagem.</summary>
    private ParametrosCaixa Montar()
    {
        if (!int.TryParse(BloqueioMinutos.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var minutos))
        {
            throw new RegraNegocioException("Bloqueio da tela: informe os minutos (0 = desligado).");
        }

        return new ParametrosCaixa(TemaIndice == 1 ? ServicoTema.Claro : ServicoTema.Escuro, minutos, string.IsNullOrWhiteSpace(PastaSecundaria) ? null : PastaSecundaria.Trim());
    }

    private void Exigir()
    {
        if (!_acesso.Tem(PermissoesPdv.VerDiagnostico))
        {
            throw new RegraNegocioException(MensagemSemPermissao);
        }
    }

    /// <summary>A aba não fica com o que mostrava: os campos do caixa (a pasta com o perfil do Windows), as regras e o pedido.</summary>
    private void Limpar()
    {
        Liberacao = null;
        TemaIndice = 0;
        BloqueioMinutos = string.Empty;
        PastaSecundaria = string.Empty;
        PermissaoTexto = null;
        Regras.Clear();
        UltimoPullTexto = null;
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
            // Nada aqui derruba o caixa: a falha vai para o log e para a tela.
            _shell.Servico<ILogger<AbaParametrosViewModel>>().LogError(e, "Falha na aba Parâmetros da Central do PDV");
            Erro = $"Não deu certo ({MascaradorSuporte.Mascarar(e.Message)}).";
        }
        finally
        {
            Ocupado = false;
            Andamento = null;
        }
    }
}
