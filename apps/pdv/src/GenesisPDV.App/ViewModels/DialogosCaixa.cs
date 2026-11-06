using System.Collections.ObjectModel;
using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Sync.Cliente;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.App.ViewModels;

/// <summary>
/// F11 Funções (PDV 28.2; Fase 1C, blocos C10a, C10b e C11b): 1 Sangria, 2 Reforço, 3 Fechamento de caixa, 4 Reimprimir
/// a última venda, 5 Cancelar a última venda, 6 Resumo diário, S Status da sincronização, V Vasilhames (devolução
/// avulsa), 7 bloquear a tela (Central do PDV, bloco G11), 8 a Central do PDV (bloco G3) e 9 a gaveta (I4). O 0 (trocar
/// operador) chega com a tela dele.
/// </summary>
public sealed partial class DialogoFuncoesViewModel(VendaViewModel venda) : DialogoViewModel(venda)
{
    public override string Titulo => "Funções";

    protected override Task AoConfirmarAsync() => Task.CompletedTask;

    [RelayCommand]
    private async Task Escolher(string opcao)
    {
        switch (opcao)
        {
            case "1":
                Venda.FecharDialogo();
                await Venda.AbrirMovimentoCaixaAsync(TipoMovimentoCaixa.Sangria);
                break;
            case "2":
                Venda.FecharDialogo();
                await Venda.AbrirMovimentoCaixaAsync(TipoMovimentoCaixa.Reforco);
                break;
            case "3":
                Venda.FecharDialogo();
                await Venda.FecharCaixaAsync();
                break;
            case "4":
                Venda.FecharDialogo();
                await Venda.ReimprimirUltimaAsync();
                break;
            case "5":
                Venda.FecharDialogo();
                await Venda.CancelarUltimaAsync();
                break;
            case "6":
                Venda.FecharDialogo();
                await Venda.AbrirResumoDiarioAsync();
                break;
            case "S":
                await Venda.AbrirStatusSyncAsync();
                break;
            case "V":
                Venda.FecharDialogo();
                await Venda.AbrirVasilhamesAsync();
                break;
            case "7":
                Venda.FecharDialogo();
                await Venda.BloquearTelaAsync();
                break;
            case "8":
                Venda.FecharDialogo();
                await Venda.AbrirCentralAsync();
                break;
            case "9":
                Venda.FecharDialogo();
                await Venda.AbrirGavetaAvulsaAsync();
                break;
            default:
                Erro = "Opção indisponível nesta versão.";
                break;
        }
    }
}

/// <summary>
/// F11 › 9 (PDV 19.4; I4): abertura avulsa da gaveta, com o motivo (vai na auditoria <c>gaveta_aberta</c> com quem
/// liberou). Enter abre, Esc volta.
/// </summary>
public sealed partial class DialogoAbrirGavetaViewModel(VendaViewModel venda, LiberacaoConcedida? liberacao) : DialogoViewModel(venda)
{
    public override string Titulo => "Abrir a gaveta (sem venda)";

    [ObservableProperty]
    public partial string Motivo { get; set; } = liberacao?.Motivo ?? string.Empty;

    protected override async Task AoConfirmarAsync()
    {
        var operador = Venda.Sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");
        await Venda.Servico<ServicoGaveta>().AbrirManualAsync(operador.Id, liberacao?.Supervisor.Id, Motivo, Venda.Sessao.SessaoCaixaId);
        Venda.GavetaAberta();
    }
}

/// <summary>
/// Sangria (F11 › 1, PDV 20.1) ou reforço (F11 › 2, 20.2): valor, quem retira (obrigatório na sangria; no reforço, quem
/// entrega, opcional), observação e inf. adicionais. F2 busca o usuário, F3 conta as cédulas, F12 lista os movimentos da
/// sessão (20.3), Enter confirma e Esc volta. O dinheiro estimado só aparece quando a regra do fechamento deixa o
/// operador ver o esperado (O3 do dono: no fechamento cego, não aparece).
/// </summary>
public sealed partial class DialogoMovimentoCaixaViewModel : DialogoViewModel
{
    private readonly LiberacaoConcedida? _liberacao;
    private IReadOnlyDictionary<decimal, int>? _cedulas;
    private bool _definindoUsuario;

    public DialogoMovimentoCaixaViewModel(VendaViewModel venda, string tipo, PreparoMovimento preparo, LiberacaoConcedida? liberacao)
        : base(venda)
    {
        Tipo = tipo;
        _liberacao = liberacao;
        EstimadoTexto = preparo.MostraEstimado ? $"Dinheiro estimado na gaveta: R$ {NumeroBr.Dinheiro(preparo.DinheiroEstimado)}" : null;
    }

    public string Tipo { get; }

    public bool EhSangria => Tipo == TipoMovimentoCaixa.Sangria;

    public override string Titulo => EhSangria ? "Sangria" : "Reforço";

    public string RotuloQuem => EhSangria ? "Quem retira (obrigatório; F2 busca o usuário)" : "Quem entrega (opcional; F2 busca o usuário)";

    public string? EstimadoTexto { get; }

    [ObservableProperty]
    public partial string Valor { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string QuemRetira { get; set; } = string.Empty;

    /// <summary>Usuário escolhido no F2; digitar outro nome desfaz a escolha (vale o texto livre).</summary>
    [ObservableProperty]
    public partial Guid? QuemRetiraUsuarioId { get; set; }

    [ObservableProperty]
    public partial string Observacao { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string InfAdicionais { get; set; } = string.Empty;

    partial void OnValorChanged(string value) => _cedulas = null;

    partial void OnQuemRetiraChanged(string value)
    {
        if (!_definindoUsuario)
        {
            QuemRetiraUsuarioId = null;
        }
    }

    /// <summary>Escolha do F2: o nome do usuário vai no campo e o id no movimento.</summary>
    public void DefinirUsuario(UsuarioRetirada usuario)
    {
        ArgumentNullException.ThrowIfNull(usuario);
        _definindoUsuario = true;
        QuemRetira = usuario.Nome;
        QuemRetiraUsuarioId = usuario.Id;
        _definindoUsuario = false;
    }

    /// <summary>Total do "F3 Contar cédulas" no valor; o detalhamento vai no <c>contagem_cedulas</c> do evento.</summary>
    public void DefinirCedulas(decimal total, IReadOnlyDictionary<decimal, int> quantidades)
    {
        Valor = NumeroBr.Dinheiro(total);
        _cedulas = quantidades;
    }

    protected override async Task AoConfirmarAsync()
    {
        decimal? valor = string.IsNullOrWhiteSpace(Valor) ? null : LerNumero(Valor, RegrasMovimentoCaixa.MensagemValorInvalido);
        var resultado = await Venda.ServicoCaixa.RegistrarMovimentoAsync(
            new DadosMovimentoCaixa(Tipo, valor, QuemRetiraUsuarioId, QuemRetira, Observacao, InfAdicionais, _cedulas), _liberacao);
        Venda.MovimentoRegistrado(resultado);
    }

    [RelayCommand]
    private async Task BuscarUsuario()
    {
        var busca = new DialogoBuscaUsuarioViewModel(Venda, this, QuemRetiraUsuarioId is null ? QuemRetira : string.Empty);
        Venda.AbrirDialogo(busca);
        await busca.AtualizarAsync();
    }

    [RelayCommand]
    private void ContarCedulas() => Venda.AbrirDialogo(new DialogoCedulasViewModel(Venda, this));

    [RelayCommand]
    private Task Movimentos() => Venda.AbrirMovimentosAsync(this);
}

/// <summary>"Quem retira" (F2 da sangria e do reforço, 20.1): busca incremental nos usuários da loja; Enter escolhe.</summary>
public sealed partial class DialogoBuscaUsuarioViewModel : DialogoViewModel
{
    private readonly DialogoMovimentoCaixaViewModel _origem;

    public DialogoBuscaUsuarioViewModel(VendaViewModel venda, DialogoMovimentoCaixaViewModel origem, string filtro)
        : base(venda)
    {
        _origem = origem;
        Filtro = filtro;
    }

    public override string Titulo => _origem.EhSangria ? "Quem retira" : "Quem entrega";

    public ObservableCollection<UsuarioRetirada> Resultados { get; } = [];

    [ObservableProperty]
    public partial string Filtro { get; set; }

    [ObservableProperty]
    public partial UsuarioRetirada? Selecionado { get; set; }

    partial void OnFiltroChanged(string value) => _ = AtualizarAsync();

    public async Task AtualizarAsync()
    {
        var lista = await Venda.ServicoCaixa.BuscarUsuariosAsync(Filtro);
        Resultados.Clear();
        foreach (var u in lista)
        {
            Resultados.Add(u);
        }

        Selecionado = Resultados.FirstOrDefault();
        Erro = Resultados.Count == 0 ? "Nenhum usuário encontrado: Esc volta e o nome pode ser digitado." : null;
    }

    [RelayCommand]
    private void Mover(string direcao)
    {
        if (Resultados.Count == 0)
        {
            return;
        }

        var i = Selecionado is null ? -1 : Resultados.IndexOf(Selecionado);
        Selecionado = Resultados[direcao == "acima" ? Math.Max(0, i - 1) : Math.Min(Resultados.Count - 1, i + 1)];
    }

    protected override Task AoConfirmarAsync()
    {
        var usuario = Selecionado ?? throw new RegraNegocioException("Nenhum usuário selecionado.");
        _origem.DefinirUsuario(usuario);
        Venda.AbrirDialogo(_origem);
        return Task.CompletedTask;
    }

    protected override Task AoCancelarAsync()
    {
        Venda.AbrirDialogo(_origem);
        return Task.CompletedTask;
    }
}

/// <summary>"F3 Contar cédulas" da sangria e do reforço: o contador da abertura (8.2) sobre o diálogo do movimento.</summary>
public sealed class DialogoCedulasViewModel : DialogoViewModel
{
    public DialogoCedulasViewModel(VendaViewModel venda, DialogoMovimentoCaixaViewModel origem)
        : base(venda)
    {
        Contador = new ContadorCedulasViewModel(
            (total, quantidades) =>
            {
                origem.DefinirCedulas(total, quantidades);
                Venda.AbrirDialogo(origem);
            },
            () => Venda.AbrirDialogo(origem));
    }

    public ContadorCedulasViewModel Contador { get; }

    public override string Titulo => "Contar cédulas e moedas";

    protected override Task AoConfirmarAsync()
    {
        Contador.AplicarCommand.Execute(null);
        return Task.CompletedTask;
    }

    protected override Task AoCancelarAsync()
    {
        Contador.VoltarCommand.Execute(null);
        return Task.CompletedTask;
    }
}

/// <summary>Uma linha da lista de movimentos da sessão (20.3).</summary>
public sealed class LinhaMovimentoCaixaViewModel(MovimentoCaixaRegistro movimento, TimeZoneInfo fuso)
{
    public MovimentoCaixaRegistro Movimento { get; } = movimento;

    public string Hora => TimeZoneInfo.ConvertTime(Movimento.OcorridoEm, fuso).ToString("HH:mm", NumeroBr.Cultura);

    public string TipoTexto => Movimento.Tipo switch
    {
        TipoMovimentoCaixa.Abertura => "Abertura",
        TipoMovimentoCaixa.Sangria => "Sangria",
        TipoMovimentoCaixa.Reforco => "Reforço",
        TipoMovimentoCaixa.SangriaFechamento => "Sangria do fechamento",
        TipoMovimentoCaixa.EstornoVenda => "Estorno de venda",
        TipoMovimentoCaixa.DevolucaoTroca => "Devolução (troca)",
        _ => Movimento.Tipo,
    };

    public string Valor => NumeroBr.Dinheiro(Movimento.Valor);

    public string Quem => Movimento.QuemRetiraNome ?? string.Empty;

    public bool Cancelavel => TipoMovimentoCaixa.Cancelaveis.Contains(Movimento.Tipo) && !Movimento.Cancelado;

    public string Situacao => Movimento.Cancelado ? $"CANCELADO: {Movimento.MotivoCancelamento}" : string.Empty;
}

/// <summary>
/// F12 Movimentos (PDV 20.3, a partir da sangria ou do reforço): os movimentos da sessão aberta; ↑/↓ escolhem e
/// Ctrl+Del cancela a sangria ou o reforço (motivo obrigatório; sem <c>pdv.caixa.cancelar_movimento</c>, a liberação do
/// supervisor, que fica como autorizador). Esc volta ao diálogo de origem.
/// </summary>
public sealed partial class DialogoMovimentosViewModel(VendaViewModel venda, DialogoViewModel? voltarPara) : DialogoViewModel(venda)
{
    private readonly TimeZoneInfo _fuso = venda.ServicoCaixa.DiaOperacionalAtual().Fuso;

    public override string Titulo => "Movimentos da sessão";

    public ObservableCollection<LinhaMovimentoCaixaViewModel> Linhas { get; } = [];

    [ObservableProperty]
    public partial LinhaMovimentoCaixaViewModel? Selecionada { get; set; }

    [ObservableProperty]
    public partial string? Aviso { get; set; }

    public async Task AtualizarAsync(Guid? selecionar = null)
    {
        var movimentos = await Venda.ServicoCaixa.MovimentosAsync();
        Linhas.Clear();
        foreach (var m in movimentos)
        {
            Linhas.Add(new LinhaMovimentoCaixaViewModel(m, _fuso));
        }

        Selecionada = Linhas.FirstOrDefault(l => l.Movimento.Id == selecionar) ?? Linhas.LastOrDefault(l => l.Cancelavel) ?? Linhas.LastOrDefault();
    }

    [RelayCommand]
    private void Mover(string direcao)
    {
        if (Linhas.Count == 0)
        {
            return;
        }

        var i = Selecionada is null ? Linhas.Count : Linhas.IndexOf(Selecionada);
        Selecionada = Linhas[direcao == "acima" ? Math.Max(0, i - 1) : Math.Min(Linhas.Count - 1, i + 1)];
    }

    [RelayCommand]
    private void CancelarSelecionado()
    {
        Erro = null;
        if (Selecionada is not { } linha)
        {
            Erro = "Selecione um movimento (setas ↑/↓).";
            return;
        }

        if (!linha.Cancelavel)
        {
            Erro = linha.Movimento.Cancelado ? "Este movimento já foi cancelado." : Data.Repositorios.RepositorioCaixa.MensagemMovimentoNaoCancelavel;
            return;
        }

        Venda.AbrirDialogo(new DialogoCancelarMovimentoViewModel(Venda, this, linha));
    }

    /// <summary>Volta à lista depois do cancelamento, com a linha atualizada e o aviso.</summary>
    public async Task VoltarComAvisoAsync(Guid movimentoId, string aviso)
    {
        await AtualizarAsync(movimentoId);
        Aviso = aviso;
        Venda.AbrirDialogo(this);
    }

    protected override Task AoConfirmarAsync() => Task.CompletedTask;

    protected override Task AoCancelarAsync()
    {
        if (voltarPara is null)
        {
            Venda.FecharDialogo();
        }
        else
        {
            Venda.AbrirDialogo(voltarPara);
        }

        return Task.CompletedTask;
    }
}

/// <summary>Motivo do cancelamento de sangria ou reforço (20.3): obrigatório; Enter cancela (ou pede a liberação).</summary>
public sealed partial class DialogoCancelarMovimentoViewModel(VendaViewModel venda, DialogoMovimentosViewModel lista, LinhaMovimentoCaixaViewModel linha)
    : DialogoViewModel(venda)
{
    public override string Titulo => $"Cancelar {linha.TipoTexto.ToLowerInvariant()} das {linha.Hora} (R$ {linha.Valor})";

    [ObservableProperty]
    public partial string Motivo { get; set; } = string.Empty;

    protected override async Task AoConfirmarAsync()
    {
        var motivo = RegrasMovimentoCaixa.MotivoCancelamento(Motivo);
        var id = linha.Movimento.Id;
        var operador = Venda.Sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");
        if (operador.Tem(PermissoesPdv.CancelarMovimento))
        {
            await Venda.ServicoCaixa.CancelarMovimentoAsync(id, motivo, null);
            await lista.VoltarComAvisoAsync(id, $"{linha.TipoTexto} das {linha.Hora} cancelado(a).");
            return;
        }

        Venda.PedirLiberacao(PermissoesPdv.CancelarMovimento, $"Cancelar {linha.TipoTexto.ToLowerInvariant()} de R$ {linha.Valor}", async concedida =>
        {
            await Venda.ServicoCaixa.CancelarMovimentoAsync(id, motivo, concedida);
            await lista.VoltarComAvisoAsync(id, $"{linha.TipoTexto} das {linha.Hora} cancelado(a) com liberação de {concedida.Supervisor.Nome}.");
        });
    }

    protected override Task AoCancelarAsync()
    {
        Venda.AbrirDialogo(lista);
        return Task.CompletedTask;
    }
}

/// <summary>
/// Resumo diário (F11 › 6, PDV 21.6): o filtro segue <c>pdv.resumo_diario_modo</c> — intervalo de dias operacionais
/// (padrão: hoje a hoje) ou horário dentro de um dia operacional. Enter mostra, Ctrl+P imprime, Esc volta.
/// </summary>
public sealed partial class DialogoResumoDiarioViewModel : DialogoViewModel
{
    private readonly LiberacaoConcedida? _liberacao;
    private readonly TimeZoneInfo _fuso;
    private readonly TimeOnly _corte;

    public DialogoResumoDiarioViewModel(VendaViewModel venda, LiberacaoConcedida? liberacao)
        : base(venda)
    {
        _liberacao = liberacao;
        var (fuso, corte, hoje) = venda.ServicoCaixa.DiaOperacionalAtual();
        (_fuso, _corte) = (fuso, corte);
        PorHorario = venda.ServicoCaixa.Regras.ResumoDiarioModo == Data.Repositorios.ChavesConfiguracao.ResumoPorHorario;
        De = Ate = hoje.ToString("dd/MM/yyyy", NumeroBr.Cultura);
        Das = corte.ToString("HH:mm", CultureInfo.InvariantCulture);
        As = "23:59";
    }

    public override string Titulo => "Resumo diário";

    /// <summary>Filtro por horário (<c>pdv.resumo_diario_modo = horario</c>); senão por intervalo de dias.</summary>
    public bool PorHorario { get; }

    public bool PorDias => !PorHorario;

    public string RotuloDe => PorHorario ? "Dia operacional (dd/mm/aaaa)" : "De (dd/mm/aaaa)";

    [ObservableProperty]
    public partial string De { get; set; }

    [ObservableProperty]
    public partial string Ate { get; set; }

    [ObservableProperty]
    public partial string Das { get; set; }

    [ObservableProperty]
    public partial string As { get; set; }

    [ObservableProperty]
    public partial string? Texto { get; set; }

    [ObservableProperty]
    public partial string? Aviso { get; set; }

    protected override async Task AoConfirmarAsync() => Texto = (await GerarAsync(imprimir: false)).Texto;

    [RelayCommand]
    private async Task Imprimir()
    {
        try
        {
            Erro = null;
            var resultado = await GerarAsync(imprimir: true);
            Texto = resultado.Texto;
            Aviso = resultado.Avisos.Count > 0 ? string.Join(" ", resultado.Avisos) : "Resumo enviado à impressora.";
        }
        catch (RegraNegocioException e)
        {
            Erro = e.Message;
        }
    }

    private Task<ResultadoResumoDiario> GerarAsync(bool imprimir)
    {
        Aviso = null;
        var de = LerData(De);
        var periodo = PorHorario
            ? PeriodoResumo.PorHorario(de, LerHora(Das), LerHora(As), _fuso, _corte)
            : PeriodoResumo.PorDias(de, LerData(Ate), _fuso, _corte);
        return Venda.ServicoCaixa.ResumoDiarioAsync(periodo, imprimir, _liberacao);
    }

    private static DateOnly LerData(string texto) =>
        DateOnly.TryParseExact((texto ?? string.Empty).Trim(), "dd/MM/yyyy", NumeroBr.Cultura, DateTimeStyles.None, out var data)
            ? data
            : throw new RegraNegocioException("Data inválida: use dd/mm/aaaa, por exemplo 29/10/2026.");

    private static TimeOnly LerHora(string texto) =>
        TimeOnly.TryParseExact((texto ?? string.Empty).Trim(), "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var hora)
            ? hora
            : throw new RegraNegocioException("Horário inválido: use hh:mm, por exemplo 08:00.");
}

/// <summary>
/// As linhas do status detalhado da sincronização (PDV 30.2): o F11 › S da venda e a "Situação completa" (F9) da aba 4
/// Sincronização da Central (bloco G7; plano 4: a aba traz tudo do F11 › S) usam as mesmas.
/// </summary>
public static class TextoStatusSync
{
    public static List<string> Linhas(SituacaoSincronizacao s, StatusDetalhadoSync status, Func<DateTimeOffset?, string> hora)
    {
        ArgumentNullException.ThrowIfNull(s);
        ArgumentNullException.ThrowIfNull(status);
        ArgumentNullException.ThrowIfNull(hora);
        var (indicador, _) = IndicadorSync.Calcular(s, DateTimeOffset.UtcNow);
        var linhas = new List<string>
        {
            $"Situação:            {indicador}",
            $"Último pull com sucesso: {hora(status.UltimoPullSucessoEm)}",
            $"Último push confirmado:  {hora(status.UltimoPushSucessoEm)}",
            $"Último heartbeat:        {hora(status.UltimoHeartbeatEm)}",
            $"Desvio do relógio:       {(status.DesvioRelogioMs is { } ms ? $"{ms / 1000m:+0.0;-0.0;0.0} s" : "sem amostra")}",
            "Cursores:            " + (status.Cursores.Count == 0
                ? "nenhum (sem carga)"
                : string.Join(" · ", status.Cursores.Select(c => $"{c.Fluxo} {c.Cursor}"))),
        };
        var pendentes = status.PendentesPorTipo.Values.Sum();
        linhas.Add(pendentes == 0
            ? "Pendentes de envio:  nenhum"
            : $"Pendentes de envio:  {pendentes} ({string.Join(", ", status.PendentesPorTipo.Select(p => $"{p.Key} {p.Value}"))})");
        linhas.Add($"Em quarentena:       {status.QuarentenaTotal}" + (status.QuarentenaTotal > status.Quarentena.Count ? $" (os {status.Quarentena.Count} primeiros)" : string.Empty));
        linhas.AddRange(status.Quarentena.Select(q => $"  #{q.Sequencia} {q.Tipo} {hora(q.OcorridoEm)} — {q.Erro ?? "sem mensagem"}"));
        if (s.Lacuna is { } lacuna)
        {
            linhas.Add(lacuna.Recuperavel
                ? $"Lacuna de eventos:   {lacuna.Faixa} já declarada; os eventos foram encontrados e esperam a liberação do reenvio"
                : $"Lacuna de eventos:   {lacuna.Faixa} — a nuvem espera estes eventos e o caixa não os tem mais (vendas bloqueadas)");
        }

        linhas.Add($"Fila de impressão:   {status.FilaImpressao} pendente(s)");
        linhas.Add("NFC-e em contingência: — (a NFC-e chega na Fase 1D)");
        if (s.Erro is { } erro)
        {
            linhas.Add($"Último erro:         {erro}");
        }

        return linhas;
    }
}

/// <summary>
/// Status detalhado da sincronização (F11 › S, PDV 30.2): o indicador, último pull e push, cursores, pendentes por tipo,
/// eventos em quarentena com o erro, desvio do relógio e a fila de impressão. Enter sincroniza agora e relê; Esc volta.
/// Com lacuna de eventos (SYNC 8.6; Fase 1C, C15), F4 declara a lacuna ou libera o reenvio dos eventos dela, com
/// <c>pdv.config.fiscal</c>: o próprio operador que a tem, ou o PIN de um supervisor que a tem (31.3).
/// </summary>
public sealed partial class DialogoStatusSyncViewModel(VendaViewModel venda, IServicoSincronizacao sincronizacao, IDbContextFactory<PdvDbContext> fabrica)
    : DialogoViewModel(venda)
{
    private readonly TimeZoneInfo _fuso = venda.ServicoCaixa.DiaOperacionalAtual().Fuso;

    public override string Titulo => "Status da sincronização";

    /// <summary>O atalho para a lista completa (o F3 abre direto; não é um caminho de menu).</summary>
    public const string MensagemListaCompleta =
        "F3  Lista completa: as vendas e o caixa ainda não confirmados, com o motivo (abre a Central › 4 Sincronização; caixa livre)";

    [ObservableProperty]
    public partial IReadOnlyList<string> Linhas { get; set; } = [];

    /// <summary>A tecla da lacuna (F4), quando há uma; nulo esconde a linha.</summary>
    [ObservableProperty]
    public partial string? AcaoLacuna { get; set; }

    /// <summary>
    /// F4 (SYNC 8.6): declarar a lacuna (o caixa admite que os eventos se perderam; as vendas voltam) ou liberar o reenvio
    /// dos eventos de uma lacuna já declarada. O motivo da liberação vai junto como observação.
    /// </summary>
    [RelayCommand]
    private async Task LacunaAsync()
    {
        if (sincronizacao.Situacao.Lacuna is not { } lacuna)
        {
            return;
        }

        var acao = lacuna.Recuperavel ? $"Reenviar os eventos da lacuna {lacuna.Faixa}" : $"Declarar a lacuna de eventos {lacuna.Faixa}";
        var operador = Venda.Sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");
        async Task ExecutarAsync(Guid autorizadoPorId, string? motivo, string? quem)
        {
            if (lacuna.Recuperavel)
            {
                await sincronizacao.AutorizarRecuperacaoLacunaAsync(autorizadoPorId);
            }
            else
            {
                await sincronizacao.DeclararLacunaAsync(autorizadoPorId, motivo);
            }

            Venda.FecharDialogo(mensagem: lacuna.Recuperavel
                ? $"Reenvio dos eventos da lacuna {lacuna.Faixa} liberado{(quem is null ? string.Empty : $" por {quem}")}."
                : $"Lacuna de eventos {lacuna.Faixa} declarada na nuvem{(quem is null ? string.Empty : $" com liberação de {quem}")}. Vendas liberadas.");
        }

        if (operador.Tem(PermissoesPdv.ConfigFiscal))
        {
            try
            {
                Erro = null;
                await ExecutarAsync(operador.Id, null, null);
            }
            catch (RegraNegocioException e)
            {
                Erro = e.Message;
            }

            return;
        }

        Venda.PedirLiberacao(PermissoesPdv.ConfigFiscal, acao, concedida => ExecutarAsync(concedida.Supervisor.Id, concedida.Motivo, concedida.Supervisor.Nome));
    }

    public async Task AtualizarAsync()
    {
        StatusDetalhadoSync status;
        await using (var db = await fabrica.CreateDbContextAsync())
        {
            status = await StatusDetalhadoSync.LerAsync(db);
        }

        var s = sincronizacao.Situacao;
        var linhas = TextoStatusSync.Linhas(s, status, Hora);
        linhas.Add(MensagemListaCompleta);
        Linhas = linhas;
        AcaoLacuna = s.Lacuna switch
        {
            { Recuperavel: false } l => $"[F4] Declarar a lacuna de eventos {l.Faixa} (supervisor com pdv.config.fiscal)",
            { Recuperavel: true } l => $"[F4] Liberar o reenvio dos eventos da lacuna {l.Faixa} (supervisor com pdv.config.fiscal)",
            _ => null,
        };
    }

    protected override async Task AoConfirmarAsync()
    {
        sincronizacao.SincronizarAgora();
        await AtualizarAsync();
        Erro = sincronizacao.Situacao.SemNuvem ? "Terminal de demonstração: nada sobe nem desce." : null;
    }

    /// <summary>
    /// F3 (Central do PDV, bloco G7): a lista completa — as vendas e os registros do caixa que a nuvem ainda não confirmou,
    /// com o motivo e o detalhe — na Central › 4 Sincronização, com o caixa livre. Com a venda em andamento, a mensagem.
    /// </summary>
    [RelayCommand]
    private async Task ListaCompleta()
    {
        try
        {
            Erro = null;
            await Venda.AbrirSincronizacaoNaCentralAsync();
        }
        catch (RegraNegocioException e)
        {
            Erro = e.Message;
        }
    }

    private string Hora(DateTimeOffset? instante) =>
        instante is { } i ? TimeZoneInfo.ConvertTime(i, _fuso).ToString("dd/MM HH:mm:ss", NumeroBr.Cultura) : "—";
}

/// <summary>
/// Vasilhames (F11 › V, PDV 10.12): devolução avulsa de cascos vazios. ↑/↓ escolhem o casco, a quantidade é inteira;
/// Enter registra, Esc volta. Com o caixa livre, só a entrada dos vazios (O14 do dono; C10b). Com a venda em andamento
/// (C11c), F3 alterna o destino: <b>descontar na venda</b> (o padrão: quantidade × preço do casco sai do total; a
/// quantidade substitui a já descontada do casco e 0 tira o desconto) ou só a entrada dos vazios, sem mexer na venda.
/// </summary>
public sealed partial class DialogoVasilhamesViewModel(VendaViewModel venda) : DialogoViewModel(venda)
{
    public const string MensagemQuantidadeDescontar = Core.Vendas.Venda.MensagemQuantidadeCascosDescontados;

    public override string Titulo => ComVenda ? "Vasilhames · cascos devolvidos na venda" : "Vasilhames · devolução avulsa de cascos";

    public ObservableCollection<ProdutoRegistro> Cascos { get; } = [];

    /// <summary>Há venda em andamento: o destino pode ser o desconto nela (C11c).</summary>
    public bool ComVenda { get; private set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(DestinoTexto), nameof(TeclasTexto), nameof(RotuloQuantidade))]
    public partial bool Descontar { get; set; }

    [ObservableProperty]
    public partial ProdutoRegistro? Selecionado { get; set; }

    [ObservableProperty]
    public partial string Quantidade { get; set; } = "1";

    /// <summary>"Já descontados nesta venda: 3 (R$ 7,50)" do casco escolhido, quando há.</summary>
    [ObservableProperty]
    public partial string? DescontadoTexto { get; set; }

    public string? DestinoTexto => !ComVenda
        ? null
        : Descontar
            ? "Destino: DESCONTAR NA VENDA pelo valor do casco (cascos além dos devidos pelos itens)"
            : "Destino: SÓ A ENTRADA dos vazios, sem desconto (a venda não muda)";

    public string RotuloQuantidade => ComVenda && Descontar ? "Cascos a descontar (0 tira o desconto do casco)" : "Cascos devolvidos";

    public string TeclasTexto => ComVenda
        ? $"[↑↓] Casco   [F3] {(Descontar ? "Só a entrada" : "Descontar na venda")}   [Enter] {(Descontar ? "Descontar" : "Registrar a entrada")}   [Esc] Voltar"
        : "[↑↓] Casco   [Enter] Registrar a entrada   [Esc] Voltar";

    public async Task AtualizarAsync()
    {
        ComVenda = Venda.ServicoVenda.VendaAberta;
        Descontar = ComVenda;
        OnPropertyChanged(nameof(ComVenda));
        OnPropertyChanged(nameof(Titulo));
        OnPropertyChanged(nameof(DestinoTexto));
        OnPropertyChanged(nameof(TeclasTexto));
        OnPropertyChanged(nameof(RotuloQuantidade));
        Cascos.Clear();
        foreach (var casco in await Venda.ServicoCaixa.VasilhamesAsync())
        {
            Cascos.Add(casco);
        }

        Selecionado = Cascos.FirstOrDefault();
        Erro = Cascos.Count == 0 ? "Nenhum casco vazio no cadastro (ERP › Produtos, tipo Vasilhame)." : null;
    }

    partial void OnSelecionadoChanged(ProdutoRegistro? value) => MostrarDescontado();

    partial void OnDescontarChanged(bool value) => MostrarDescontado();

    /// <summary>O casco já descontado aparece com a quantidade dele, para alterar ou tirar (0).</summary>
    private void MostrarDescontado()
    {
        var atual = ComVenda && Descontar && Selecionado is { } casco
            ? Venda.ServicoVenda.Atual?.CascosDescontados.FirstOrDefault(c => c.ProdutoVasilhameId == casco.Id)
            : null;
        DescontadoTexto = atual is null
            ? null
            : $"Já descontados nesta venda: {atual.Quantidade} (R$ {NumeroBr.Dinheiro(atual.Valor)}). A quantidade substitui; 0 tira o desconto.";
        Quantidade = atual?.Quantidade.ToString(CultureInfo.InvariantCulture) ?? "1";
    }

    [RelayCommand]
    private void Mover(string direcao)
    {
        if (Cascos.Count == 0)
        {
            return;
        }

        var i = Selecionado is null ? -1 : Cascos.IndexOf(Selecionado);
        Selecionado = Cascos[direcao == "acima" ? Math.Max(0, i - 1) : Math.Min(Cascos.Count - 1, i + 1)];
    }

    [RelayCommand]
    private void AlternarDestino()
    {
        if (ComVenda)
        {
            Descontar = !Descontar;
            Erro = null;
        }
    }

    protected override async Task AoConfirmarAsync()
    {
        var casco = Selecionado ?? throw new RegraNegocioException(ServicoCaixa.MensagemVasilhameInvalido);
        if (ComVenda && Descontar)
        {
            var pedido = LerNumero(Quantidade, MensagemQuantidadeDescontar);
            if (pedido is < 0m or > Core.Vendas.Venda.MaximoCascosDescontados || decimal.Truncate(pedido) != pedido)
            {
                throw new RegraNegocioException(MensagemQuantidadeDescontar);
            }

            var resultado = await Venda.ServicoVenda.DescontarCascosAsync(casco.Id, (int)pedido);
            if (resultado.ExigeLiberacao is { } acao)
            {
                // README › decisão 56 (D38): sem pdv.venda.desconto_total ou acima do teto sem supervisor, ele libera.
                Venda.PedirLiberacao(PermissoesPdv.DescontoTotal, acao, async concedida =>
                {
                    var liberado = await Venda.ServicoVenda.DescontarCascosAsync(casco.Id, (int)pedido, concedida);
                    Venda.FecharDialogo(mensagem: MensagemDescontados(casco, liberado.Descontado) + $" Liberado por {concedida.Supervisor.Nome}.");
                });
                return;
            }

            Venda.FecharDialogo(mensagem: MensagemDescontados(casco, resultado.Descontado));
            return;
        }

        var quantidade = LerNumero(Quantidade, ServicoCaixa.MensagemQuantidadeCascos);
        await Venda.ServicoCaixa.DevolverVasilhamesAsync(casco.Id, quantidade);
        Venda.FecharDialogo(mensagem: $"Devolução de {quantidade:0} casco(s) {casco.Nome} registrada.");
    }

    private static string MensagemDescontados(ProdutoRegistro casco, Core.Vendas.CascoDescontado? descontado) => descontado is null
        ? $"Desconto dos cascos {casco.Nome} retirado da venda."
        : $"{descontado.Quantidade} casco(s) {casco.Nome} descontado(s) na venda: -R$ {NumeroBr.Dinheiro(descontado.Valor)}.";
}
