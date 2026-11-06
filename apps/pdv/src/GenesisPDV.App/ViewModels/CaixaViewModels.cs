using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;

namespace GenesisPDV.App.ViewModels;

/// <summary>
/// Liberação por supervisor (PDV 31.3; Fase 1C, C10a): login/código, PIN e motivo de quem tem <c>pdv.supervisor</c> e a
/// permissão da ação. Validada só pelo PIN, offline; vale só para aquela ação. Três recusas fecham o pedido ("Liberação
/// negada"). Sobreposto às telas do caixa e, como <see cref="DialogoLiberacaoViewModel"/>, à de venda.
/// </summary>
public sealed partial class PedidoLiberacaoViewModel(
    IAutenticadorOperador autenticador,
    IRelogio relogio,
    Operador operador,
    string permissao,
    string acao,
    Func<LiberacaoConcedida, Task> aoLiberar,
    Func<string?, Task> aoDesistir) : ViewModelBase
{
    public const int TentativasMaximas = 3;
    public const int MotivoMaximo = 255;

    private int _recusas;

    public string Titulo => $"Liberação do supervisor · {acao}";

    public string Permissao => permissao;

    [ObservableProperty]
    public partial string Usuario { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Pin { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Motivo { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [ObservableProperty]
    public partial bool Verificando { get; set; }

    [RelayCommand]
    private async Task ConfirmarAsync()
    {
        if (Verificando)
        {
            return;
        }

        var motivo = Motivo.Trim();
        if (motivo.Length is 0 or > MotivoMaximo)
        {
            Erro = $"Informe o motivo da liberação (até {MotivoMaximo} caracteres).";
            return;
        }

        ResultadoLiberacaoSupervisor resultado;
        Verificando = true;
        try
        {
            // argon2id fora da thread da tela, como no login.
            resultado = await autenticador.LiberarAsync(Usuario, Pin, permissao, operador.Id, relogio.Agora);
        }
        finally
        {
            Verificando = false;
        }

        if (resultado.Supervisor is not { } supervisor)
        {
            Pin = string.Empty;
            if (++_recusas >= TentativasMaximas)
            {
                await aoDesistir(resultado.Erro ?? "Liberação negada");
                return;
            }

            Erro = resultado.Erro ?? "Liberação negada";
            return;
        }

        await aoLiberar(new LiberacaoConcedida(supervisor, motivo, relogio.Agora));
    }

    [RelayCommand]
    private Task CancelarAsync() => aoDesistir(null);
}

/// <summary>Uma linha do "F2 Contar cédulas" (8.2, 21.2).</summary>
public sealed partial class LinhaCedulaViewModel(decimal valor) : ViewModelBase
{
    public decimal Valor { get; } = valor;

    public string Rotulo => $"R$ {NumeroBr.Dinheiro(Valor)}";

    [ObservableProperty]
    public partial string Quantidade { get; set; } = string.Empty;
}

/// <summary>
/// "F2 Contar cédulas" (PDV 8.2): quantidade por cédula e moeda, soma e preenche o campo; o detalhamento vai no
/// <c>contagem_cedulas</c> do evento. Enter aplica, Esc volta sem mudar o campo.
/// </summary>
public sealed partial class ContadorCedulasViewModel : ViewModelBase
{
    private readonly Action<decimal, IReadOnlyDictionary<decimal, int>> _aplicar;
    private readonly Action _voltar;

    public ContadorCedulasViewModel(Action<decimal, IReadOnlyDictionary<decimal, int>> aplicar, Action voltar)
    {
        _aplicar = aplicar;
        _voltar = voltar;
        foreach (var valor in ContagemCedulas.Valores)
        {
            var linha = new LinhaCedulaViewModel(valor);
            linha.PropertyChanged += (_, _) => Recalcular();
            Linhas.Add(linha);
        }
    }

    public ObservableCollection<LinhaCedulaViewModel> Linhas { get; } = [];

    [ObservableProperty]
    public partial string TotalTexto { get; set; } = "0,00";

    [ObservableProperty]
    public partial string? Erro { get; set; }

    public IReadOnlyDictionary<decimal, int> Quantidades()
    {
        var quantidades = new Dictionary<decimal, int>();
        foreach (var linha in Linhas)
        {
            if (string.IsNullOrWhiteSpace(linha.Quantidade))
            {
                continue;
            }

            if (!int.TryParse(linha.Quantidade.Trim(), System.Globalization.NumberStyles.None, NumeroBr.Cultura, out var q))
            {
                throw new RegraNegocioException($"Quantidade inválida para {linha.Rotulo}.");
            }

            quantidades[linha.Valor] = q;
        }

        return ContagemCedulas.Normalizar(quantidades);
    }

    private void Recalcular()
    {
        try
        {
            Erro = null;
            TotalTexto = NumeroBr.Dinheiro(ContagemCedulas.Somar(Quantidades()));
        }
        catch (RegraNegocioException e)
        {
            Erro = e.Message;
        }
    }

    [RelayCommand]
    private void Aplicar()
    {
        try
        {
            var quantidades = Quantidades();
            _aplicar(ContagemCedulas.Somar(quantidades), quantidades);
        }
        catch (RegraNegocioException e)
        {
            Erro = e.Message;
        }
    }

    [RelayCommand]
    private void Voltar() => _voltar();
}

/// <summary>Base das telas do caixa: operador, cabeçalho, liberação sobreposta e o contador de cédulas.</summary>
public abstract partial class TelaCaixaViewModel : ViewModelBase
{
    protected TelaCaixaViewModel(ShellViewModel shell)
    {
        Shell = shell;
        Sessao = shell.Servico<SessaoTerminal>();
        Caixa = shell.Servico<ServicoCaixa>();
        Operador = Sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");
    }

    protected ShellViewModel Shell { get; }

    protected SessaoTerminal Sessao { get; }

    protected ServicoCaixa Caixa { get; }

    protected Operador Operador { get; }

    public string Cabecalho => $"{Sessao.NomeLoja} · Caixa {Sessao.Identidade?.NumeroCaixa:00} · Operador: {Operador.Nome}";

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [ObservableProperty]
    public partial string? Aviso { get; set; }

    /// <summary>Pedido de liberação aberto sobre a tela (PDV 31.3).</summary>
    [ObservableProperty]
    public partial PedidoLiberacaoViewModel? Liberacao { get; set; }

    /// <summary>Executa a ação; sem a permissão, pede a liberação do supervisor e, concedida, executa com ela.</summary>
    protected Task ComPermissaoAsync(string permissao, string acao, Func<LiberacaoConcedida?, Task> executar)
    {
        if (Operador.Tem(permissao))
        {
            return ExecutarAsync(() => executar(null));
        }

        if (PermissoesPdv.SemLiberacao.Contains(permissao))
        {
            Erro = ServicoCaixa.MensagemSemPermissao;
            return Task.CompletedTask;
        }

        Liberacao = new PedidoLiberacaoViewModel(
            Shell.Servico<IAutenticadorOperador>(), Shell.Servico<IRelogio>(), Operador, permissao, acao,
            async concedida =>
            {
                Liberacao = null;
                await ExecutarAsync(() => executar(concedida));
            },
            erro =>
            {
                Liberacao = null;
                Erro = erro;
                return Task.CompletedTask;
            });
        return Task.CompletedTask;
    }

    protected async Task ExecutarAsync(Func<Task> acao)
    {
        try
        {
            Erro = null;
            await acao();
        }
        catch (RegraNegocioException e)
        {
            Erro = e.Message;
        }
        catch (Exception e)
        {
            await Shell.TratarErroInesperadoAsync(e);
        }
    }

    protected static decimal? LerValor(string texto) =>
        string.IsNullOrWhiteSpace(texto) ? null : NumeroBr.TentarLer(texto, out var valor) ? valor : throw new RegraNegocioException("Valor inválido, por exemplo 150,00.");
}

/// <summary>
/// Abertura de caixa (PDV 8.2): fundo de troco obrigatório (O4 do dono: abertura com o fundo contado), pré-preenchido com
/// o valor deixado pela troca de turno; contar outro valor pede uma segunda confirmação e grava a diferença de
/// recebimento. F2 conta cédulas. Enter abre; Esc volta ao login (o operador sai). Com o disco quase cheio (Central do
/// PDV, bloco G4; spec 32.2), depois do fundo conferido, a abertura pede o supervisor, que libera por 1 h (o supervisor
/// logado confirma com outro Enter), e então abre. Quando a tela só apareceu pelo disco (<see cref="Automatica"/>: a
/// abertura seria a automática, <c>pdv.solicita_abertura_caixa</c> desligada), o fundo é o herdado, só leitura, e a
/// abertura liberada é a automática (sem <c>pdv.caixa.abrir</c>, sem a gaveta).
/// </summary>
public sealed partial class AberturaCaixaViewModel : TelaCaixaViewModel
{
    public const string MensagemConfirmarDiferenca = "O valor contado difere do deixado pelo turno anterior: Enter de novo para confirmar.";

    public const string MensagemConfirmarDisco =
        "Você é supervisor: Enter de novo libera a abertura com o disco quase cheio por 1 h (fica registrado) e segue com a abertura.";

    public const string AcaoLiberarDisco = "Abrir o caixa com o disco quase cheio (vale 1 h)";

    /// <summary>O supervisor logado já viu o aviso do disco: o próximo Enter libera e abre.</summary>
    private bool _discoConfirmar;

    private readonly TurnoHerdado? _herdado;
    private IReadOnlyDictionary<decimal, int>? _cedulas;
    private decimal? _diferencaConfirmada;

    /// <param name="automatica">A tela apareceu só pelo disco quase cheio: a abertura seria a automática (G4).</param>
    public AberturaCaixaViewModel(ShellViewModel shell, TurnoHerdado? herdado, bool automatica = false)
        : base(shell)
    {
        _herdado = herdado;
        Automatica = automatica;
        Fundo = herdado is null ? automatica ? NumeroBr.Dinheiro(0m) : string.Empty : NumeroBr.Dinheiro(herdado.ValorCaixa);
        if (automatica && Caixa.DiscoBloqueiaAbertura() is { } livre)
        {
            Erro = new DiscoCheioException(livre).Message;
        }
    }

    /// <summary>A abertura automática que o disco quase cheio parou: o fundo herdado não se edita (G4).</summary>
    public bool Automatica { get; }

    public string? AutomaticaTexto => Automatica
        ? "Este caixa abre sozinho com o fundo herdado; com o disco quase cheio, a abertura precisa do supervisor."
        : null;

    public string DataHora => TimeZoneInfo.ConvertTime(Shell.Servico<IRelogio>().Agora, DiaOperacional.ObterFuso(Sessao.FusoHorario))
        .ToString("dd/MM/yyyy HH:mm", NumeroBr.Cultura);

    public string? HerdadoTexto => _herdado is null ? null : $"Herdado do turno anterior: R$ {NumeroBr.Dinheiro(_herdado.ValorCaixa)}";

    [ObservableProperty]
    public partial string Fundo { get; set; }

    [ObservableProperty]
    public partial string Observacao { get; set; } = string.Empty;

    [ObservableProperty]
    public partial ContadorCedulasViewModel? Contador { get; set; }

    partial void OnFundoChanged(string value)
    {
        _cedulas = null;
        _diferencaConfirmada = null;
        _discoConfirmar = false;
        Aviso = null;
    }

    [RelayCommand]
    private Task Abrir() => ExecutarAsync(async () =>
    {
        if (Automatica)
        {
            // A abertura automática (PDV 8.1) depois da liberação do disco: o fundo herdado, sem pedir pdv.caixa.abrir.
            if (await LiberarDiscoSeNecessarioAsync())
            {
                return;
            }

            var avisosAutomatica = await Caixa.AbrirAsync(_herdado?.ValorCaixa ?? 0m, null, null, _herdado, liberacao: null, automatica: true);
            await Shell.IrParaVendaAsync(avisosAutomatica.Count > 0 ? string.Join(" ", avisosAutomatica) : null);
            return;
        }

        // O fundo e a diferença do turno herdado antes do disco: liberado o disco, a abertura segue sem outro Enter.
        var fundo = RegrasSessaoCaixa.ValidarFundo(LerValor(Fundo) ?? throw new RegraNegocioException(RegrasSessaoCaixa.MensagemFundoInvalido));
        if (_herdado is { } herdado && fundo != herdado.ValorCaixa && _diferencaConfirmada != fundo)
        {
            _diferencaConfirmada = fundo;
            Aviso = MensagemConfirmarDiferenca;
            return;
        }

        if (await LiberarDiscoSeNecessarioAsync())
        {
            return;
        }

        var cedulas = _cedulas;
        await ComPermissaoAsync(PermissoesPdv.AbrirCaixa, "Abrir caixa", async liberacao =>
        {
            var avisos = await Caixa.AbrirAsync(fundo, Observacao, cedulas, _herdado, liberacao);
            await Shell.IrParaVendaAsync(avisos.Count > 0 ? string.Join(" ", avisos) : $"Caixa aberto com fundo de R$ {NumeroBr.Dinheiro(fundo)}.");
        });
    });

    /// <summary>
    /// Disco quase cheio (G4): antes de abrir, a liberação de 1 h — o supervisor logado confirma com outro Enter (ou o
    /// clique); os demais pedem o PIN e o motivo do supervisor (<c>pdv.supervisor</c>) e, liberado, a abertura segue
    /// sozinha. Esc no pedido deixa o aviso do disco na tela e nada é gravado. Devolve se parou para isso.
    /// </summary>
    private async Task<bool> LiberarDiscoSeNecessarioAsync()
    {
        if (Caixa.DiscoBloqueiaAbertura() is not { } livre)
        {
            return false;
        }

        Erro = new DiscoCheioException(livre).Message;
        if (Operador.Tem(PermissoesPdv.Supervisor))
        {
            if (!_discoConfirmar)
            {
                _discoConfirmar = true;
                Aviso = MensagemConfirmarDisco;
                return true;
            }

            _discoConfirmar = false;
            await Caixa.LiberarDiscoAsync(null);
            Erro = null;
            Aviso = null;
            return false;
        }

        Liberacao = new PedidoLiberacaoViewModel(
            Shell.Servico<IAutenticadorOperador>(), Shell.Servico<IRelogio>(), Operador, PermissoesPdv.Supervisor, AcaoLiberarDisco,
            async concedida =>
            {
                Liberacao = null;
                await ExecutarAsync(async () =>
                {
                    await Caixa.LiberarDiscoAsync(concedida);
                    Erro = null;
                    Aviso = $"Abertura com o disco quase cheio liberada por 1 h por {concedida.Supervisor.Nome}.";
                });
                if (Caixa.DiscoLiberado)
                {
                    await Abrir();
                }
            },
            erro =>
            {
                Liberacao = null;
                Erro = erro ?? Erro;
                return Task.CompletedTask;
            });
        return true;
    }

    /// <summary>F2 (a abertura automática parada pelo disco não conta: o fundo é o herdado).</summary>
    [RelayCommand]
    private void ContarCedulas()
    {
        if (Automatica)
        {
            return;
        }

        Contador = new ContadorCedulasViewModel(
            (total, quantidades) =>
            {
                Fundo = NumeroBr.Dinheiro(total);
                _cedulas = quantidades;
                Contador = null;
            },
            () => Contador = null);
    }

    [RelayCommand]
    private void Sair()
    {
        Sessao.Operador = null;
        Shell.IrParaLogin();
    }
}

/// <summary>
/// Login com a sessão aberta por outro operador (PDV 8.1): "[1] Fazer troca de turno  [2] Operar no caixa de FULANO
/// (exige permissão)  [Esc] Sair". A troca de turno fecha a sessão dele sem zerar (o novo operador conta a gaveta às
/// cegas) e segue para a abertura com o valor herdado.
/// </summary>
public sealed partial class SessaoOutroOperadorViewModel(ShellViewModel shell, Data.Entidades.SessaoCaixaRegistro aberta, string nomeOperador)
    : TelaCaixaViewModel(shell)
{
    public string NomeOperador => nomeOperador;

    public string Mensagem =>
        $"O caixa está aberto por {nomeOperador} desde {TimeZoneInfo.ConvertTime(aberta.AbertaEm, DiaOperacional.ObterFuso(Sessao.FusoHorario)).ToString("dd/MM HH:mm", NumeroBr.Cultura)}.";

    public string OpcaoOperar => $"2  Operar no caixa de {nomeOperador} (exige permissão)";

    [RelayCommand]
    private Task Escolher(string opcao) => opcao switch
    {
        "1" => ComPermissaoAsync(PermissoesPdv.FecharCaixa, "Troca de turno", liberacao => Shell.IrParaFechamentoAsync(trocaDeTurno: true, liberacao)),
        "2" => ComPermissaoAsync(PermissoesPdv.OperarDeOutro, $"Operar no caixa de {nomeOperador}", async liberacao =>
        {
            await Caixa.OperarDeOutroAsync(liberacao);
            await Shell.IrParaVendaAsync($"Operando no caixa aberto por {nomeOperador}.");
        }),
        _ => Task.CompletedTask,
    };

    [RelayCommand]
    private void Sair()
    {
        Sessao.Operador = null;
        Shell.IrParaLogin();
    }
}

/// <summary>Uma forma no fechamento: o que o operador digita e, só quando a regra permite, o calculado.</summary>
public sealed partial class FormaFechamentoViewModel(FormaApurada apurada, bool calculadoVisivel) : ViewModelBase
{
    public FormaApurada Apurada { get; } = apurada;

    public string Descricao => Apurada.Forma.Descricao;

    /// <summary>Nunca preenchido no fechamento cego sem a conferência (O3): a tela não tem como mostrar o esperado.</summary>
    [ObservableProperty]
    public partial string? CalculadoTexto { get; set; } = calculadoVisivel ? NumeroBr.Dinheiro(apurada.Calculado) : null;

    [ObservableProperty]
    public partial string? DiferencaTexto { get; set; }

    [ObservableProperty]
    public partial string Valor { get; set; } = string.Empty;

    /// <summary>
    /// Fora da contagem (conferência, fim) o campo não se edita: o Enter da conferência grava o que foi contado, e um
    /// valor trocado na tela divergiria do gravado sem aviso.
    /// </summary>
    [ObservableProperty]
    public partial bool SomenteLeitura { get; set; }
}

/// <summary>
/// Fechamento de caixa e troca de turno (PDV 21.2–21.4): contagem cega por forma (Dinheiro sempre, as formas da loja e
/// as que tiveram movimento), "Zera caixa? S/N", conferência e recontagem só quando a regra da loja permite (O3 do dono:
/// não), confirmação, relatório e volta ao login. Na troca de turno pedida pelo próximo operador (8.1, opção 1) o zera
/// fica em "não" e o fim leva à abertura dele.
/// </summary>
public sealed partial class FechamentoCaixaViewModel : TelaCaixaViewModel
{
    private readonly FechamentoPreparado _preparado;
    private readonly LiberacaoConcedida? _liberacao;
    private readonly bool _trocaDeTurno;

    /// <summary>A gravação recusou (venda aberta, D22, tipo não anunciado): o Esc da conferência pode sair.</summary>
    private bool _gravacaoRecusada;

    public FechamentoCaixaViewModel(ShellViewModel shell, FechamentoPreparado preparado, LiberacaoConcedida? liberacao, bool trocaDeTurno, int pendentes)
        : base(shell)
    {
        _preparado = preparado;
        _liberacao = liberacao;
        _trocaDeTurno = trocaDeTurno;
        ZeraCaixa = !trocaDeTurno;
        MontarFormas();
        AvisoPendentes = pendentes > 0 ? $"{pendentes} evento(s) ainda não sincronizado(s): o fechamento será enviado quando houver conexão." : null;
    }

    private FechamentoCego Cego => _preparado.Fechamento;

    public string Titulo => $"{(_trocaDeTurno ? "Troca de turno" : "Fechamento de caixa")} · Caixa {Sessao.Identidade?.NumeroCaixa:00} · " +
                            $"{_preparado.NomeOperadorSessao} · aberto {TimeZoneInfo.ConvertTime(_preparado.Sessao.AbertaEm, DiaOperacional.ObterFuso(Sessao.FusoHorario)).ToString("HH:mm", NumeroBr.Cultura)}";

    public ObservableCollection<FormaFechamentoViewModel> Formas { get; } = [];

    public bool CalculadoVisivel => Cego.CalculadoVisivel || Conferindo;

    /// <summary>O zera não é escolhido na troca de turno pedida pelo próximo operador.</summary>
    public bool PodeEscolherZera => !_trocaDeTurno;

    /// <summary>Sem a conferência, a justificativa é opcional e fica na própria contagem (pedir só com diferença a revelaria).</summary>
    public bool JustificativaNaContagem => !Cego.Regras.TemConferencia;

    public string? AvisoPendentes { get; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ZeraTexto))]
    public partial bool ZeraCaixa { get; set; }

    public string ZeraTexto => ZeraCaixa ? "Zera caixa: SIM (todo o dinheiro sai da gaveta)" : "Zera caixa: NÃO (troca de turno: o dinheiro contado fica como fundo do próximo)";

    [ObservableProperty]
    public partial string Justificativa { get; set; } = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CalculadoVisivel))]
    [NotifyPropertyChangedFor(nameof(Contando))]
    public partial bool Conferindo { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Contando))]
    public partial bool Concluido { get; set; }

    public bool Contando => !Conferindo && !Concluido;

    [ObservableProperty]
    public partial bool PodeRecontar { get; set; }

    [ObservableProperty]
    public partial string? Relatorio { get; set; }

    [ObservableProperty]
    public partial string? Resultado { get; set; }

    [ObservableProperty]
    public partial ContadorCedulasViewModel? Contador { get; set; }

    /// <summary>F5: alterna o "Zera caixa?" (não na troca de turno pedida pelo próximo operador).</summary>
    [RelayCommand]
    private void AlternarZera()
    {
        if (PodeEscolherZera && Contando)
        {
            ZeraCaixa = !ZeraCaixa;
        }
    }

    /// <summary>Campo da justificativa: na contagem sem conferência (opcional) ou na conferência.</summary>
    public bool JustificativaVisivel => (Contando && JustificativaNaContagem) || Conferindo;

    public string RotuloJustificativa => Conferindo
        ? Cego.ExigeJustificativa ? "Justificativa (obrigatória: diferença no dinheiro)" : "Justificativa (opcional)"
        : "Justificativa / observação (opcional)";

    public string Teclas => Conferindo
        ? "[Enter] Confirmar o fechamento" + (PodeRecontar ? "   [F4] Recontar (uma vez)" : string.Empty) + (_gravacaoRecusada ? "   [Esc] Voltar" : string.Empty)
        : "[Enter] " + (Cego.Regras.TemConferencia ? "Conferir" : "Confirmar o fechamento") + "   [F3] Contar cédulas" +
          (PodeEscolherZera ? "   [F5] Zera caixa sim/não" : string.Empty) + "   [Esc] Voltar";

    /// <summary>O botão do Enter: o mesmo rótulo da legenda ("Conferir", "Confirmar o fechamento").</summary>
    public string RotuloAvancar => Conferindo || !Cego.Regras.TemConferencia ? "Confirmar o fechamento [Enter]" : "Conferir [Enter]";

    public bool BotaoZeraVisivel => Contando && PodeEscolherZera;

    public bool BotaoRecontarVisivel => Conferindo && PodeRecontar;

    /// <summary>O Esc volta (botão "Voltar"): na contagem, ou na conferência depois de uma gravação recusada.</summary>
    public bool PodeVoltar => Contando || (Conferindo && _gravacaoRecusada);

    partial void OnConferindoChanged(bool value) => AtualizarRotulos();

    partial void OnConcluidoChanged(bool value) => AtualizarRotulos();

    partial void OnPodeRecontarChanged(bool value) => AtualizarRotulos();

    private void AtualizarRotulos()
    {
        foreach (var forma in Formas)
        {
            forma.SomenteLeitura = !Contando;
        }

        OnPropertyChanged(nameof(JustificativaVisivel));
        OnPropertyChanged(nameof(RotuloJustificativa));
        OnPropertyChanged(nameof(Teclas));
        OnPropertyChanged(nameof(RotuloAvancar));
        OnPropertyChanged(nameof(BotaoZeraVisivel));
        OnPropertyChanged(nameof(BotaoRecontarVisivel));
        OnPropertyChanged(nameof(PodeVoltar));
    }

    /// <summary>Enter: na contagem, conta (e confirma, sem conferência); na conferência, confirma; no fim, segue.</summary>
    [RelayCommand]
    private Task Avancar() => ExecutarAsync(async () =>
    {
        if (Concluido)
        {
            await SeguirAsync();
            return;
        }

        if (Contando)
        {
            var valores = new Dictionary<Guid, decimal>();
            foreach (var forma in Formas)
            {
                valores[forma.Apurada.Forma.Id] = LerValor(forma.Valor) ?? 0m;
            }

            Cego.Contar(valores);
            if (Cego.Etapa == EtapaFechamento.Conferencia)
            {
                MostrarConferencia();
                return;
            }
        }

        await ConfirmarAsync();
    });

    [RelayCommand]
    private void Recontar()
    {
        if (!PodeRecontar || !Cego.PodeRecontar)
        {
            PodeRecontar = Cego.PodeRecontar;
            return;
        }

        Erro = null;
        _gravacaoRecusada = false;
        Cego.Recontar();
        Conferindo = false;
        PodeRecontar = false;
        foreach (var forma in Formas)
        {
            forma.Valor = string.Empty;
            forma.DiferencaTexto = null;
            forma.CalculadoTexto = Cego.CalculadoVisivel ? NumeroBr.Dinheiro(forma.Apurada.Calculado) : null;
        }
    }

    [RelayCommand]
    private void ContarCedulas()
    {
        if (Contando && Formas.Count > 0)
        {
            Contador = new ContadorCedulasViewModel(
                (total, _) =>
                {
                    Formas[0].Valor = NumeroBr.Dinheiro(total);
                    Contador = null;
                },
                () => Contador = null);
        }
    }

    /// <summary>
    /// Esc: na contagem, desiste (a sessão continua aberta); no fim, segue. Na conferência só sai depois de uma gravação
    /// recusada (o operador já viu o calculado e não volta a contar; preso na tela, só restaria reiniciar o app).
    /// </summary>
    [RelayCommand]
    private Task Voltar() => ExecutarAsync(async () =>
    {
        if (Concluido)
        {
            await SeguirAsync();
            return;
        }

        if (Conferindo && !_gravacaoRecusada)
        {
            return;
        }

        if (_trocaDeTurno)
        {
            Sessao.Operador = null;
            Shell.IrParaLogin();
            return;
        }

        await Shell.IrParaVendaAsync();
    });

    private void MontarFormas()
    {
        Formas.Clear();
        foreach (var forma in Cego.Formas)
        {
            Formas.Add(new FormaFechamentoViewModel(forma, Cego.CalculadoVisivel));
        }
    }

    private void MostrarConferencia()
    {
        foreach (var forma in Formas)
        {
            forma.CalculadoTexto = NumeroBr.Dinheiro(forma.Apurada.Calculado);
            forma.DiferencaTexto = NumeroBr.Dinheiro(Cego.Digitado(forma.Apurada.Forma.Id) - forma.Apurada.Calculado);
        }

        Conferindo = true;
        PodeRecontar = Cego.PodeRecontar;
        Aviso = Cego.ExigeJustificativa ? FechamentoCego.MensagemJustificativa : null;
    }

    /// <summary>
    /// Passo 3: grava e só então marca a máquina confirmada. Recusada a gravação, a tela continua onde estava (contagem
    /// pronta ou conferência) com a mensagem, e o Enter seguinte tenta de novo sem recontar.
    /// </summary>
    private async Task ConfirmarAsync()
    {
        var operador = Operador;
        var conferido = Cego.Confirmar(ZeraCaixa, Justificativa);
        ResultadoFechamentoCaixa resultado;
        try
        {
            resultado = await Caixa.FecharAsync(_preparado, conferido, _liberacao, sair: !_trocaDeTurno);
        }
        catch (RegraNegocioException)
        {
            _gravacaoRecusada = true;
            AtualizarRotulos();
            throw;
        }

        Cego.MarcarConfirmado();
        _gravacaoRecusada = false;
        Relatorio = resultado.Relatorio;
        Resultado = (conferido.ZeraCaixa ? "Caixa fechado." : "Troca de turno registrada.")
                    + (resultado.Avisos.Count > 0 ? " " + string.Join(" ", resultado.Avisos) : string.Empty)
                    + (_trocaDeTurno ? $" Enter: abrir o caixa para {operador.Nome}." : " Enter: próximo operador (login).");
        Aviso = null;
        Conferindo = false;
        Concluido = true;
    }

    /// <summary>
    /// Fim: volta ao login, ou, na troca de turno pedida pelo próximo operador, segue para a abertura dele. A abertura
    /// automática recusada (empresa em implantação, loja sem PDV, D22, tipo não anunciado) leva ao login com a mensagem,
    /// como no <see cref="LoginViewModel"/>.
    /// </summary>
    private async Task SeguirAsync()
    {
        if (!_trocaDeTurno)
        {
            Shell.IrParaLogin();
            return;
        }

        try
        {
            await Shell.AposLoginAsync();
        }
        catch (RegraNegocioException e)
        {
            Sessao.Operador = null;
            Shell.IrParaLogin(e.Message);
        }
    }
}
