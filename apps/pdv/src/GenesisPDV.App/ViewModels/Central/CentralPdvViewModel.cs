using System.Globalization;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Comum;
using GenesisPDV.Sync.Cliente;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels.Central;

/// <summary>Uma linha do menu lateral da Central: a aba, o cadeado e se é a aba aberta.</summary>
public sealed partial class ItemMenuCentralViewModel(AbaCentral aba) : ViewModelBase
{
    public AbaCentral Aba { get; } = aba;

    public string Codigo => Aba.Codigo;

    public string Nome => Aba.Nome;

    /// <summary>Sem a permissão (nem a emprestada pela liberação): o cadeado; o clique pede quem pode.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Dica))]
    public partial bool Bloqueada { get; set; }

    /// <summary>Aberta só pela liberação do supervisor (fecha de novo quando ela acaba).</summary>
    [ObservableProperty]
    public partial bool Emprestada { get; set; }

    [ObservableProperty]
    public partial bool Selecionada { get; set; }

    public string Dica => Bloqueada ? $"{Aba.Rotulo}: pede o usuário e o PIN de quem pode ver" : Aba.Rotulo;
}

/// <summary>
/// Central do PDV, a engrenagem ⚙ (bloco G3; plano 1, 3.3 e 4; decisões do dono de 04/11/2026; README › decisão 68): uma
/// tela só no lugar da antiga configuração do terminal. Abre pelo login (<c>Ctrl+Alt+C</c> ou o botão ⚙: usuário e PIN,
/// sem sessão de operador) ou pela venda (<c>F11 › 8</c> ou o ⚙ da barra, com o caixa livre: o operador logado), e fica
/// fora da confirmação de desativação (D22). Menu lateral com as abas 0 a 9 e P (<see cref="AbasCentral"/>), por clique
/// ou pelo dígito com o foco no menu; a aba que a pessoa não pode ver mostra o cadeado e o clique pede a liberação
/// (Ctrl+L; só as abas de consulta, <see cref="AcessoCentral"/>). A aba 3 (Impressora e gaveta) é a configuração de
/// antes e pede ela mesma a liberação de <c>pdv.config.terminal</c>. As abas dos blocos seguintes mostram o que vão
/// trazer. Abre no Painel de saúde (PC-7; bloco G4, decisão 69: a aba 0 e a 9 Sobre o terminal, só leitura, sem PIN). A
/// aba 1 Vendas (bloco G5, decisão 70) consulta o caixa aberto e os fechados dos últimos 30 dias; a aba 2 Caixas (bloco
/// G6, decisão 71), os mesmos caixas como foram impressos, com a 2ª via do fechamento. O F7 de uma leva à outra. A aba 4
/// Sincronização (bloco G7, decisão 72) mostra as vendas e os registros do caixa que a nuvem ainda não confirmou; a aba 5
/// Logs e ocorrências (bloco G8, decisão 73), as ocorrências do caixa com o que fazer e o arquivo técnico do dia; a aba 6
/// Histórico de uso (bloco G10, decisão 74), quem fez o quê no caixa em frases, com o resumo por operador; a aba 7
/// Parâmetros e a 8 Backup (bloco G11, decisão 75), os ajustes do próprio caixa (o bloqueio da tela, a pasta do backup, o
/// tema) com as regras da loja só para consulta, e os backups com o "Fazer backup agora"; a aba P Pacote de suporte (bloco
/// G9, decisão 76), o zip para o suporte no pendrive, sem segredo (o Painel tem o botão para ela). A Central aberta pela venda
/// bloqueia por inatividade como a venda (o desbloqueio volta à venda).
/// Esc volta: do conteúdo ao menu, do menu ao login ou à venda.
/// </summary>
public sealed partial class CentralPdvViewModel : ViewModelBase
{
    public const string EtapaEntrar = "entrar";
    public const string EtapaAberta = "aberta";

    public const string MensagemLiberacaoAcabou = "A liberação acabou (5 min sem uso): a aba voltou a pedir o supervisor.";

    public const string MensagemSomenteLeitura =
        "Terminal confirmando a desativação pedida no ERP: a Central fica só para consulta (nada é gravado).";

    private readonly ShellViewModel _shell;
    private readonly AcessoCentral _acesso;
    private readonly IServicoSincronizacao _sync;
    private readonly DispatcherTimer _relogio;
    private readonly Dictionary<string, ViewModelBase> _conteudos = new(StringComparer.Ordinal);

    /// <summary>As abas já abertas nesta Central (a volta a uma delas lê de novo o que pode ter mudado).</summary>
    private readonly HashSet<string> _visitadas = new(StringComparer.Ordinal);

    /// <summary>A aba que pediu a liberação (abre sozinha depois do PIN do supervisor).</summary>
    private AbaCentral? _abaPendente;

    /// <summary>O filtro com que a aba pendente abre (o "Erros recentes" do Painel leva à aba 5 nos erros de 24 h).</summary>
    private string? _filtroPendente;

    private bool _encerrada;

    /// <summary>Voltando à venda (a tela de venda carrega antes de trocar a página): o segundo Esc não sai duas vezes.</summary>
    private bool _saindo;

    public CentralPdvViewModel(ShellViewModel shell, OrigemCentral origem)
    {
        _shell = shell;
        _acesso = shell.Servico<AcessoCentral>();
        _sync = shell.Servico<IServicoSincronizacao>();
        Origem = origem;
        Abas = [.. AbasCentral.Todas.Select(a => new ItemMenuCentralViewModel(a))];
        _relogio = new DispatcherTimer(TimeSpan.FromSeconds(1), DispatcherPriority.Background, (_, _) => Atualizar());
        Etapa = origem == OrigemCentral.Login ? EtapaEntrar : EtapaAberta;
        if (Aberta)
        {
            Iniciar();
        }
    }

    public OrigemCentral Origem { get; }

    public bool PeloLogin => Origem == OrigemCentral.Login;

    /// <summary>"Ice Beer Hermes · Caixa 02".</summary>
    public string Cabecalho
    {
        get
        {
            var sessao = _shell.Servico<SessaoTerminal>();
            return $"{sessao.NomeLoja}  ·  Caixa {sessao.Identidade?.NumeroCaixa:00}";
        }
    }

    [ObservableProperty]
    public partial string Etapa { get; set; }

    public bool Entrando => Etapa == EtapaEntrar;

    public bool Aberta => Etapa == EtapaAberta;

    /// <summary>Usuário da entrada pelo login.</summary>
    [ObservableProperty]
    public partial string Usuario { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Pin { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [ObservableProperty]
    public partial string? Mensagem { get; set; }

    [ObservableProperty]
    public partial bool Ocupado { get; set; }

    public IReadOnlyList<ItemMenuCentralViewModel> Abas { get; }

    [ObservableProperty]
    public partial ItemMenuCentralViewModel? AbaSelecionada { get; set; }

    /// <summary>O conteúdo da aba aberta.</summary>
    [ObservableProperty]
    public partial ViewModelBase? Conteudo { get; set; }

    /// <summary>"MARIA (operador do caixa)" ou "CARLOS (entrou pelo login)".</summary>
    [ObservableProperty]
    public partial string? UsuarioTexto { get; set; }

    /// <summary>"Liberado por CARLOS: 2 Caixas, 4 Sincronização · até 14:35 se ninguém usar" (nulo sem liberação).</summary>
    [ObservableProperty]
    public partial string? LiberacaoTexto { get; set; }

    [ObservableProperty]
    public partial string? SomenteLeituraTexto { get; set; }

    // --- Liberação (Ctrl+L) ---

    [ObservableProperty]
    public partial bool Liberando { get; set; }

    [ObservableProperty]
    public partial string TituloLiberacao { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string UsuarioLiberacao { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string PinLiberacao { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string? ErroLiberacao { get; set; }

    public string Rodape => Entrando
        ? "Enter entra · Esc volta ao login"
        : "0 a 9 e P escolhem a aba (com o foco no menu) · Ctrl+L Liberar (supervisor) · Esc volta da aba ao menu e do menu"
          + (PeloLogin ? " ao login" : " à venda");

    /// <summary>A tela leva o foco ao menu (na aba aberta), ao campo da entrada ou ao da liberação.</summary>
    public event EventHandler<AlvoFocoCentral>? FocoSolicitado;

    partial void OnEtapaChanged(string value)
    {
        OnPropertyChanged(nameof(Entrando));
        OnPropertyChanged(nameof(Aberta));
        OnPropertyChanged(nameof(Rodape));
    }

    /// <summary>Tecla ou clique na Central: renova a liberação ativa (a expirada não volta; <see cref="AcessoCentral.RegistrarUso"/>).</summary>
    public void RegistrarUso()
    {
        if (Aberta && !_encerrada)
        {
            _acesso.RegistrarUso();
        }
    }

    /// <summary>Esc dentro de uma aba: o foco volta ao menu, na aba aberta.</summary>
    public Task VoltarAoMenuAsync()
    {
        FocoSolicitado?.Invoke(this, AlvoFocoCentral.Menu);
        return Task.CompletedTask;
    }

    /// <summary>Saiu da Central (o shell chama ao trocar de tela): para o relógio e acaba a liberação.</summary>
    public void Encerrar()
    {
        if (_encerrada)
        {
            return;
        }

        _encerrada = true;
        _relogio.Stop();
        _acesso.Encerrar();
    }

    private void Iniciar()
    {
        UsuarioTexto = _acesso.Usuario is { } u ? $"{u.Nome} ({(PeloLogin ? "entrou pelo login" : "operador do caixa")})" : null;
        var painel = Painel();
        Mostrar(Abas[0], painel);
        // Abre já verificando (até 2 s por verificação, fora da tela); o foco fica no menu.
        _ = painel.AtualizarAsync();
        _relogio.Start();
        Atualizar();
        FocoSolicitado?.Invoke(this, AlvoFocoCentral.Menu);
    }

    /// <summary>Cadeados, a liberação e a faixa da desativação; a aba que só abriu pela liberação fecha quando ela acaba.</summary>
    public void Atualizar()
    {
        if (!Aberta || _encerrada || _acesso.Usuario is not { } usuario)
        {
            return;
        }

        if (!PeloLogin && ReferenceEquals(_shell.PaginaAtual, this))
        {
            // Bloqueio por inatividade (bloco G11): a Central aberta pela venda é do operador logado e bloqueia como a venda
            // (a troca de página encerra a Central e a liberação; o desbloqueio volta à venda).
            _shell.ConferirInatividade(null);
            if (_encerrada)
            {
                return;
            }
        }

        foreach (var item in Abas)
        {
            if (item.Aba == AbasCentral.ImpressoraGaveta)
            {
                // A aba 3 segue a regra dela (pelo login, pdv.config.terminal sem pdv.supervisor também pede a liberação):
                // o cadeado some quando ela está editável, e fica aberto (🔓) quando só abriu pela liberação dada nela.
                var hardware = _conteudos.GetValueOrDefault(item.Codigo) as AbaHardwareViewModel;
                var direto = AbaHardwareViewModel.AbreDireto(usuario, Origem);
                item.Bloqueada = !direto && hardware is not { Editando: true };
                item.Emprestada = hardware is { Editando: true, PorLiberacao: true };
                continue;
            }

            var pode = _acesso.PodeAbrir(item.Aba);
            item.Bloqueada = !pode;
            item.Emprestada = pode && !usuario.Tem(item.Aba.Permissao);
        }

        // A liberação que empresta o histórico de vendas começou ou acabou: a aba Vendas refaz a lista de caixas; a que
        // emprestou os caixas acabou: a aba Caixas guardada não fica com o que mostrava (nem com o pedido do supervisor).
        (_conteudos.GetValueOrDefault(AbasCentral.Vendas.Codigo) as AbaVendasViewModel)?.ConferirPermissoes();
        (_conteudos.GetValueOrDefault(AbasCentral.Caixas.Codigo) as AbaCaixasViewModel)?.ConferirPermissoes();
        (_conteudos.GetValueOrDefault(AbasCentral.Logs.Codigo) as AbaLogsViewModel)?.ConferirPermissoes();
        (_conteudos.GetValueOrDefault(AbasCentral.HistoricoUso.Codigo) as AbaHistoricoUsoViewModel)?.ConferirPermissoes();
        (_conteudos.GetValueOrDefault(AbasCentral.Parametros.Codigo) as AbaParametrosViewModel)?.ConferirPermissoes();
        (_conteudos.GetValueOrDefault(AbasCentral.Backup.Codigo) as AbaBackupViewModel)?.ConferirPermissoes();
        (_conteudos.GetValueOrDefault(AbasCentral.Pacote.Codigo) as AbaPacoteViewModel)?.ConferirPermissoes();
        if (_conteudos.GetValueOrDefault(AbasCentral.Sincronizacao.Codigo) is AbaSincronizacaoViewModel sincronizacao)
        {
            // A liberação que emprestou o diagnóstico acabou: a aba não fica com o que mostrava. Na tela, a lista
            // acompanha o sync sozinha (a venda que a nuvem confirmou fica verde).
            sincronizacao.ConferirPermissoes();
            if (ReferenceEquals(Conteudo, sincronizacao))
            {
                sincronizacao.Tique();
            }
        }

        LiberacaoTexto = _acesso.Liberador is { } liberador
            ? $"Liberado por {liberador.Nome}: {string.Join(", ", _acesso.AbasLiberadas)} · até {Hora(_acesso.LiberacaoExpiraEm)} se ninguém usar"
            : null;
        SomenteLeituraTexto = _acesso.SomenteLeitura ? MensagemSomenteLeitura : null;
        if (AbaSelecionada is { } atual && atual.Aba != AbasCentral.ImpressoraGaveta && !_acesso.PodeAbrir(atual.Aba))
        {
            Mostrar(Abas[0], Painel());
            Mensagem = MensagemLiberacaoAcabou;
            FocoSolicitado?.Invoke(this, AlvoFocoCentral.Menu);
        }
    }

    /// <summary>Entrada pelo login: usuário e PIN pelas regras do login, sem sessão de operador (<see cref="AcessoCentral.AbrirPeloLoginAsync"/>).</summary>
    [RelayCommand]
    private async Task EntrarAsync()
    {
        if (Ocupado || !Entrando || _encerrada)
        {
            return;
        }

        if (_sync.Situacao.ConfirmandoDesativacao)
        {
            Erro = ServicoCaixa.MensagemConfirmandoDesativacao;
            return;
        }

        string? erro = null;
        await Ocupar(async () => erro = await _acesso.AbrirPeloLoginAsync(Usuario, Pin), e => erro = e);
        Pin = string.Empty;
        if (_encerrada)
        {
            return;
        }

        if (erro is not null)
        {
            Erro = erro;
            FocoSolicitado?.Invoke(this, AlvoFocoCentral.Entrada);
            return;
        }

        Erro = null;
        Usuario = string.Empty;
        Etapa = EtapaAberta;
        Iniciar();
    }

    /// <summary>Clique no menu ou o dígito com o foco nele.</summary>
    [RelayCommand]
    private async Task AbrirAbaAsync(string? codigo)
    {
        if (!Aberta || Liberando || Ocupado || _encerrada
            || Abas.FirstOrDefault(i => string.Equals(i.Codigo, codigo, StringComparison.OrdinalIgnoreCase)) is not { } item)
        {
            return;
        }

        _acesso.RegistrarUso();
        Mensagem = null;
        Erro = null;
        var aba = item.Aba;
        var hardware = aba == AbasCentral.ImpressoraGaveta;
        if (!_acesso.PodeAbrir(aba) && !hardware)
        {
            // Aba de consulta sem a permissão: o cadeado pede o supervisor (Ctrl+L) e a aba abre depois do PIN.
            AbrirLiberacao(aba);
            return;
        }

        ViewModelBase? conteudo = null;
        await Ocupar(async () =>
        {
            // A sensível grava o central_acessada (uma vez por abertura); na D22 a Central fica só leitura.
            await _acesso.RegistrarAberturaAsync(aba);
            conteudo = await ConteudoDeAsync(aba);
        });
        if (_encerrada || conteudo is null)
        {
            return;
        }

        var mesma = ReferenceEquals(Conteudo, conteudo);
        Mostrar(item, conteudo);
        Atualizar();
        // O Painel e o Sobre verificam de novo a cada visita (é barato e local); o dígito da aba já aberta leva o foco a ela.
        if (!mesma)
        {
            _ = conteudo switch
            {
                AbaPainelViewModel painel => painel.AtualizarAsync(),
                AbaSobreViewModel sobre => sobre.AtualizarAsync(),
                // A aba Vendas lê de novo a cada visita (os filtros ficam): vendas e caixas podem ter mudado desde a última.
                AbaVendasViewModel vendas when _visitadas.Contains(aba.Codigo) => vendas.Recarregar(),
                AbaCaixasViewModel caixas when _visitadas.Contains(aba.Codigo) => caixas.CarregarAsync(),
                AbaSincronizacaoViewModel sincronizacao when _visitadas.Contains(aba.Codigo) => sincronizacao.CarregarAsync(),
                AbaLogsViewModel logs when _visitadas.Contains(aba.Codigo) => logs.CarregarAsync(),
                AbaHistoricoUsoViewModel historico when _visitadas.Contains(aba.Codigo) => historico.CarregarAsync(),
                AbaParametrosViewModel parametros when _visitadas.Contains(aba.Codigo) => parametros.CarregarAsync(),
                AbaBackupViewModel backup when _visitadas.Contains(aba.Codigo) => backup.CarregarAsync(),
                // A volta ao pacote procura o pendrive de novo (pode ter sido ligado ou tirado nesse meio-tempo).
                AbaPacoteViewModel pacote when _visitadas.Contains(aba.Codigo) => pacote.CarregarAsync(),
                _ => Task.CompletedTask,
            };
        }

        _visitadas.Add(aba.Codigo);
        FocoSolicitado?.Invoke(this, conteudo switch
        {
            // A aba 3, a Vendas, a Caixas, a Sincronização, a Logs e a Histórico de uso levam o foco ao próprio campo (o número
            // da venda ou o texto da busca já podem ser digitados; ↑/↓ nos caixas).
            AbaHardwareViewModel or AbaVendasViewModel or AbaCaixasViewModel or AbaSincronizacaoViewModel or AbaLogsViewModel
                or AbaHistoricoUsoViewModel or AbaParametrosViewModel or AbaBackupViewModel or AbaPacoteViewModel
                => mesma ? AlvoFocoCentral.Conteudo : AlvoFocoCentral.Nenhum,
            AbaPainelViewModel or AbaSobreViewModel when mesma => AlvoFocoCentral.Conteudo,
            _ => AlvoFocoCentral.Menu,
        });
    }

    /// <summary>Ctrl+L: o supervisor libera as abas de consulta que ele vê e o usuário não (5 min sem uso).</summary>
    [RelayCommand]
    private void Liberar()
    {
        if (Aberta && !Liberando && !Ocupado && !_encerrada)
        {
            AbrirLiberacao(null);
        }
    }

    [RelayCommand]
    private async Task ConfirmarLiberacaoAsync()
    {
        if (!Liberando || Ocupado || _encerrada)
        {
            return;
        }

        string? erro = null;
        await Ocupar(async () => erro = await _acesso.LiberarAsync(UsuarioLiberacao, PinLiberacao), e => erro = e);
        PinLiberacao = string.Empty;
        if (_encerrada)
        {
            return;
        }

        if (erro is not null)
        {
            ErroLiberacao = erro;
            Atualizar();
            FocoSolicitado?.Invoke(this, AlvoFocoCentral.Liberacao);
            return;
        }

        Liberando = false;
        var pendente = _abaPendente;
        var filtro = _filtroPendente;
        _abaPendente = null;
        _filtroPendente = null;
        // Quem liberou, as abas e até quando ficam na faixa azul (LiberacaoTexto).
        Atualizar();
        if (pendente is not null && _acesso.PodeAbrir(pendente))
        {
            await AbrirAbaComFiltroAsync(pendente.Codigo, filtro);
        }
        else
        {
            if (pendente is not null)
            {
                // Liberou outras abas (a faixa azul diz quais), mas não a pedida: o Encarregado não vê o Histórico de uso (PC-8).
                Mensagem = $"{_acesso.Liberador?.Nome ?? "Quem liberou"} não vê a aba {pendente.Rotulo}: ela continua pedindo quem pode.";
            }

            FocoSolicitado?.Invoke(this, AlvoFocoCentral.Menu);
        }
    }

    [RelayCommand]
    private void CancelarLiberacao()
    {
        if (!Liberando || Ocupado)
        {
            return;
        }

        Liberando = false;
        _abaPendente = null;
        _filtroPendente = null;
        PinLiberacao = string.Empty;
        FocoSolicitado?.Invoke(this, AlvoFocoCentral.Menu);
    }

    /// <summary>Esc na Central (fora de uma aba): fecha a liberação, ou sai para o login ou a venda.</summary>
    [RelayCommand]
    private Task VoltarAsync()
    {
        if (Liberando)
        {
            CancelarLiberacao();
            return Task.CompletedTask;
        }

        return SairAsync();
    }

    /// <summary>
    /// Sai para o login ou a venda. Quem encerra a Central é o shell ao trocar de página (<see cref="Encerrar"/>): se a
    /// venda não carregar (banco ocupado, erro de leitura), a Central continua ativa com a mensagem e o Esc tenta de novo.
    /// </summary>
    [RelayCommand]
    private async Task SairAsync()
    {
        if (_encerrada || _saindo)
        {
            return;
        }

        if (PeloLogin)
        {
            _shell.IrParaLogin();
            return;
        }

        _saindo = true;
        try
        {
            await Ocupar(() => _shell.IrParaVendaAsync());
        }
        finally
        {
            _saindo = false;
        }
    }

    private void AbrirLiberacao(AbaCentral? aba)
    {
        _abaPendente = aba;
        _filtroPendente = null;
        TituloLiberacao = aba is null ? "Liberar abas da Central" : $"Liberar a aba {aba.Rotulo}";
        UsuarioLiberacao = string.Empty;
        PinLiberacao = string.Empty;
        ErroLiberacao = null;
        Liberando = true;
        FocoSolicitado?.Invoke(this, AlvoFocoCentral.Liberacao);
    }

    private void Mostrar(ItemMenuCentralViewModel item, ViewModelBase conteudo)
    {
        if (Conteudo is AbaHardwareViewModel { PorLiberacao: true } hardware && !ReferenceEquals(hardware, conteudo))
        {
            // A liberação de pdv.config.terminal dada na aba 3 é de uma visita (como sair da configuração de antes): ao
            // trocar de aba, a aba é descartada e a volta pede o supervisor de novo (o cadeado volta no Atualizar).
            _conteudos.Remove(AbasCentral.ImpressoraGaveta.Codigo);
        }

        foreach (var i in Abas)
        {
            i.Selecionada = ReferenceEquals(i, item);
        }

        AbaSelecionada = item;
        Conteudo = conteudo;
    }

    private async Task<ViewModelBase> ConteudoDeAsync(AbaCentral aba)
    {
        if (_conteudos.TryGetValue(aba.Codigo, out var pronto))
        {
            return pronto;
        }

        ViewModelBase conteudo;
        if (aba == AbasCentral.ImpressoraGaveta)
        {
            // A mesma aba enquanto a Central dura (o que está na tela fica ao trocar de aba e voltar); a que só abriu pela
            // liberação dada nela é descartada ao trocar de aba (Mostrar).
            var hardware = new AbaHardwareViewModel(_shell, _acesso.Usuario!, Origem, VoltarAoMenuAsync);
            hardware.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName == nameof(AbaHardwareViewModel.Etapa))
                {
                    Atualizar();
                }
            };
            await hardware.CarregarAsync();
            conteudo = hardware;
        }
        else if (aba == AbasCentral.Painel)
        {
            conteudo = Painel();
        }
        else if (aba == AbasCentral.Sobre)
        {
            conteudo = new AbaSobreViewModel(_shell, VoltarAoMenuAsync);
        }
        else if (aba == AbasCentral.Vendas)
        {
            // Pela venda, o Ctrl+Del da venda paga do caixa aberto volta à venda com o F12 nela (o cancelamento de sempre).
            var vendas = new AbaVendasViewModel(_shell, PeloLogin ? null : CancelarNaVendaAsync, VoltarAoMenuAsync, CaixaDaVendaAsync);
            await vendas.CarregarAsync();
            conteudo = vendas;
        }
        else if (aba == AbasCentral.Caixas)
        {
            var caixas = new AbaCaixasViewModel(_shell, VendasDoCaixaAsync, VoltarAoMenuAsync);
            await caixas.CarregarAsync();
            conteudo = caixas;
        }
        else if (aba == AbasCentral.Sincronizacao)
        {
            var sincronizacao = new AbaSincronizacaoViewModel(_shell, VoltarAoMenuAsync);
            await sincronizacao.CarregarAsync();
            conteudo = sincronizacao;
        }
        else if (aba == AbasCentral.Logs)
        {
            var logs = new AbaLogsViewModel(_shell, VoltarAoMenuAsync);
            await logs.CarregarAsync();
            conteudo = logs;
        }
        else if (aba == AbasCentral.HistoricoUso)
        {
            var historico = new AbaHistoricoUsoViewModel(_shell, VoltarAoMenuAsync);
            await historico.CarregarAsync();
            conteudo = historico;
        }
        else if (aba == AbasCentral.Parametros)
        {
            var parametros = new AbaParametrosViewModel(_shell, VoltarAoMenuAsync);
            await parametros.CarregarAsync();
            conteudo = parametros;
        }
        else if (aba == AbasCentral.Backup)
        {
            var backup = new AbaBackupViewModel(_shell, Origem, VoltarAoMenuAsync);
            await backup.CarregarAsync();
            conteudo = backup;
        }
        else if (aba == AbasCentral.Pacote)
        {
            var pacote = new AbaPacoteViewModel(_shell, VoltarAoMenuAsync);
            await pacote.CarregarAsync();
            conteudo = pacote;
        }
        else
        {
            throw new InvalidOperationException($"Aba sem conteúdo: {aba.Rotulo}.");
        }

        _conteudos[aba.Codigo] = conteudo;
        return conteudo;
    }

    /// <summary>
    /// Ctrl+Del na aba Vendas, na venda paga do caixa aberto (Central aberta pela venda): sai da Central para a venda, com o
    /// F12 Gestão de vendas nessa venda e o diálogo do cancelamento (o gerente ou o encarregado, só do caixa aberto, D23; nada muda no fluxo de sempre).
    /// </summary>
    private async Task CancelarNaVendaAsync(Guid vendaId)
    {
        if (_encerrada || _saindo)
        {
            return;
        }

        _saindo = true;
        try
        {
            await Ocupar(() => _shell.IrParaVendaAsync(depois: venda => venda.CancelarVendaDaCentralAsync(vendaId)));
        }
        finally
        {
            _saindo = false;
        }
    }

    /// <summary>
    /// F7 na aba Caixas: a aba 1 Vendas com o filtro no caixa escolhido (os outros filtros limpos). Sem o histórico de
    /// vendas, a aba diz como liberar (o caixa fechado não entra).
    /// </summary>
    private async Task VendasDoCaixaAsync(Guid sessaoId)
    {
        await AbrirAbaAsync(AbasCentral.Vendas.Codigo);
        if (Conteudo is AbaVendasViewModel vendas)
        {
            await vendas.MostrarCaixaAsync(sessaoId);
        }
    }

    /// <summary>
    /// F7 no detalhe (ou na lista) da aba Vendas: a aba 2 Caixas com o detalhe do caixa da venda. Sem a permissão de ver os
    /// caixas, o cadeado pede o supervisor (Ctrl+L) e a aba abre na lista depois do PIN.
    /// </summary>
    private async Task CaixaDaVendaAsync(Guid sessaoId)
    {
        await AbrirAbaAsync(AbasCentral.Caixas.Codigo);
        if (Conteudo is AbaCaixasViewModel caixas)
        {
            await caixas.DetalharSessaoAsync(sessaoId);
        }
    }

    /// <summary>
    /// O botão de uma linha do Painel: a aba pelo mesmo caminho do menu e, com <paramref name="filtro"/>, já filtrada (o
    /// "Erros recentes" abre a aba 5 nos erros das últimas 24 h). Com o cadeado, o filtro espera o PIN do supervisor.
    /// </summary>
    private async Task AbrirAbaComFiltroAsync(string codigo, string? filtro)
    {
        await AbrirAbaAsync(codigo);
        if (filtro is null)
        {
            return;
        }

        if (Liberando && _abaPendente?.Codigo == codigo)
        {
            _filtroPendente = filtro;
        }
        else if (AbaSelecionada?.Codigo == codigo && Conteudo is AbaLogsViewModel logs)
        {
            await logs.AplicarFiltroAsync(filtro);
        }
    }

    /// <summary>A aba 0 (a mesma enquanto a Central dura); o botão de uma linha leva à aba certa pelo mesmo caminho do menu.</summary>
    private AbaPainelViewModel Painel()
    {
        if (_conteudos.GetValueOrDefault(AbasCentral.Painel.Codigo) is not AbaPainelViewModel painel)
        {
            painel = new AbaPainelViewModel(_shell, AbrirAbaComFiltroAsync, VoltarAoMenuAsync);
            _conteudos[AbasCentral.Painel.Codigo] = painel;
        }

        return painel;
    }

    private string Hora(DateTimeOffset? quando) => quando is { } q
        ? TimeZoneInfo.ConvertTime(q, DiaOperacional.ObterFuso(_shell.Servico<SessaoTerminal>().FusoHorario))
            .ToString("HH:mm", CultureInfo.GetCultureInfo("pt-BR"))
        : string.Empty;

    private async Task Ocupar(Func<Task> acao, Action<string>? aoFalhar = null)
    {
        Ocupado = true;
        try
        {
            await acao();
        }
        catch (RegraNegocioException e)
        {
            (aoFalhar ?? (m => Erro = m))(e.Message);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // Nada aqui derruba o caixa: a falha vai para o log e para a tela.
            _shell.Servico<ILogger<CentralPdvViewModel>>().LogError(e, "Falha na Central do PDV");
            (aoFalhar ?? (m => Erro = m))($"Não deu certo ({e.Message}).");
        }
        finally
        {
            Ocupado = false;
        }
    }
}

/// <summary>Para onde a tela da Central leva o foco.</summary>
public enum AlvoFocoCentral
{
    /// <summary>A aba nova focou o próprio campo ao aparecer.</summary>
    Nenhum,

    /// <summary>O botão da aba aberta no menu lateral.</summary>
    Menu,

    /// <summary>O campo da aba já aberta (o dígito da mesma aba de novo).</summary>
    Conteudo,

    /// <summary>O usuário da entrada pelo login.</summary>
    Entrada,

    /// <summary>O usuário da liberação (Ctrl+L).</summary>
    Liberacao,
}
