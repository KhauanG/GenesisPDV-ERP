using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.ViewModels.Central;

/// <summary>
/// Uma linha da aba Caixas: o caixa aberto ou um fechado, com a abertura, o fechamento, o operador, o tipo, as vendas, o
/// contado (como no relatório impresso), o envio do fechamento ao ERP e o selo das canceladas depois. Nunca o calculado
/// nem a diferença (PC-9; O3).
/// </summary>
public sealed class LinhaCaixaCentralViewModel(CaixaHistorico caixa, TimeZoneInfo fuso, string operador) : ViewModelBase
{
    public CaixaHistorico Caixa { get; } = caixa;

    /// <summary>"ABERTO", "Fechamento", "Troca de turno" ou "Fechado" (sem o retrato do fechamento neste banco).</summary>
    public string Situacao => Caixa.Aberto ? "ABERTO"
        : Caixa.TipoFechamento switch
        {
            "troca_turno" => "Troca de turno",
            "fechamento" => "Fechamento",
            _ => "Fechado",
        };

    public string Abertura => Hora(Caixa.AbertaEm);

    public string Fechamento => Caixa.FechadaEm is { } f ? Hora(f) : "—";

    public string Operador { get; } = operador;

    public string Vendas => Caixa.QuantidadeVendas == 1 ? "1 venda" : $"{Caixa.QuantidadeVendas} vendas";

    /// <summary>O total contado do relatório impresso ("—" no aberto).</summary>
    public string Contado => Caixa.Contado is { } c ? NumeroBr.Dinheiro(c) : "—";

    /// <summary>O <c>caixa.fechado</c> no outbox: enviado, aguardando, recusado (resolve no ERP) ou sem registro.</summary>
    public string Envio => Caixa.Aberto ? string.Empty : TextoEnvio(Caixa.EnvioFechamento, curto: true);

    public bool EnvioRecusado => Caixa.EnvioFechamento == StatusEventoSaida.Rejeitado;

    /// <summary>"canceladas depois: 1 · R$ 8,00" (vendas do caixa canceladas depois do fechamento; D23: nenhum caminho do PDV faz isso).</summary>
    public string Selo => Caixa.CanceladasDepois > 0 ? $"canceladas depois: {Caixa.CanceladasDepois} · R$ {NumeroBr.Dinheiro(Caixa.TotalCanceladasDepois)}" : string.Empty;

    public bool TemSelo => Caixa.CanceladasDepois > 0;

    public string Leitura =>
        $"Caixa {Caixa.NumeroCaixa:00}, {Situacao}, aberto em {Abertura}, fechado em {Fechamento}, {Operador}, {Vendas}, contado R$ {Contado}. {Envio}. {Selo}".Trim();

    /// <param name="curto">A coluna "Envio ao ERP" da lista (o detalhe diz a frase inteira).</param>
    public static string TextoEnvio(string? status, bool curto = false) => status switch
    {
        null => curto ? "sem registro" : "sem registro de envio neste caixa",
        StatusEventoSaida.Confirmado => curto ? "enviado" : "enviado ao ERP",
        StatusEventoSaida.Rejeitado => "recusado pelo ERP",
        _ => curto ? "aguardando" : "aguardando envio ao ERP",
    };

    private string Hora(DateTimeOffset quando) => TimeZoneInfo.ConvertTime(quando, fuso).ToString("dd/MM HH:mm", NumeroBr.Cultura);
}

/// <summary>Para onde a aba Caixas leva o foco.</summary>
public enum AlvoFocoCaixas
{
    /// <summary>A lista dos caixas (↑/↓, Enter, Ctrl+R e as teclas F funcionam dela).</summary>
    Lista,

    /// <summary>O detalhe do caixa (Esc volta à lista).</summary>
    Detalhe,

    /// <summary>O resumo do dia (F6; Esc volta).</summary>
    Resumo,
}

/// <summary>
/// Aba 2 da Central do PDV, <b>Caixas</b> (bloco G6; plano 4.3 e 5.2; decisões do dono de 04/11/2026: PC-9 opção A, os 30
/// dias, D23 mantida): o <b>caixa aberto</b> primeiro e os fechados deste terminal nos <b>últimos 30 dias</b>, como foram
/// impressos; mais antigos, só no ERP. Pede <c>pdv.caixa.consultar_fechamentos</c> (a própria ou a emprestada pelo Ctrl+L
/// da Central). O detalhe vem do retrato do fechamento (o contado por forma, o resumo do turno guardado, as sangrias e os
/// reforços, as vendas canceladas depois); o calculado e a diferença ficam no ERP. Ctrl+R reimprime o relatório pelos
/// bytes originais com a marca da 2ª via (sem eles: "indisponível, consulte no ERP"; nada é montado de novo), com
/// <c>pdv.documento.reimprimir</c> ou o supervisor na hora. F7 abre as vendas do caixa na aba 1, F6 o resumo do dia do
/// caixa. Teclas: ↑/↓ escolhem, Enter (ou o * do numérico) detalhe, F5 atualiza, Esc fecha o pedido do supervisor, o
/// resumo, o detalhe e volta ao menu; tudo também pelo mouse.
/// </summary>
public sealed partial class AbaCaixasViewModel : ViewModelBase
{
    public const string Localizacao = ServicoHistoricoCaixas.Localizacao;

    public const string MensagemSoNoErp =
        "Calculado e diferença: só no ERP (Fechamentos de caixa). Aqui o caixa aparece como foi impresso.";

    public const string MensagemDepoisDoFechamento = "O fechamento impresso deste caixa não mudou com essas vendas canceladas depois.";

    public const string MensagemLiberacaoAcabou = "A liberação acabou: os caixas pedem o supervisor de novo (Ctrl+L).";

    private readonly ShellViewModel _shell;
    private readonly AcessoCentral _acesso;
    private readonly ServicoHistoricoCaixas _servico;
    private readonly TimeZoneInfo _fuso;
    private readonly Func<Guid, Task> _verVendas;
    private readonly Func<Task> _voltar;
    private readonly Dictionary<Guid, string> _nomes = [];
    private int _versao;

    /// <summary>Os caixas valiam na última conferência (a leitura ou o relógio da Central); nulo antes da primeira.</summary>
    private bool? _viaCaixas;

    /// <summary>O caixa do detalhe aberto: Ctrl+R, F6 e F7 agem sobre ele (não sobre a linha que a releitura pode trocar).</summary>
    private LinhaCaixaCentralViewModel? _linhaDetalhe;

    /// <summary>A liberação do supervisor para o resumo do dia (vale enquanto o resumo fica na tela, como o F11 › 6).</summary>
    private LiberacaoConcedida? _liberacaoResumo;

    private DateOnly _diaResumo;

    /// <param name="verVendas">F7: abre a aba 1 Vendas com o caixa escolhido.</param>
    /// <param name="voltar">Esc: volta ao menu da Central.</param>
    public AbaCaixasViewModel(ShellViewModel shell, Func<Guid, Task> verVendas, Func<Task> voltar)
    {
        _shell = shell;
        _acesso = shell.Servico<AcessoCentral>();
        _servico = shell.Servico<ServicoHistoricoCaixas>();
        _fuso = DiaOperacional.ObterFuso(shell.Servico<SessaoTerminal>().FusoHorario);
        _verVendas = verVendas;
        _voltar = voltar;
    }

    public string Titulo => AbasCentral.Caixas.Rotulo;

    public string Teclas =>
        "↑/↓ escolhem · Enter (ou *) detalhe · Ctrl+R reimprime o fechamento · F7 vendas do caixa · F6 resumo do dia · F5 atualiza · Esc volta ao menu";

    public string TeclasDetalhe =>
        "↑/↓ (ou 8/2) e PgUp/PgDn (ou 9/3) rolam · Ctrl+R reimprime · F7 vendas do caixa · F6 resumo do dia · Esc volta à lista";

    public ObservableCollection<LinhaCaixaCentralViewModel> Linhas { get; } = [];

    [ObservableProperty]
    public partial LinhaCaixaCentralViewModel? Selecionada { get; set; }

    [ObservableProperty]
    public partial string Rodape { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string? Mensagem { get; set; }

    [ObservableProperty]
    public partial string? Erro { get; set; }

    [ObservableProperty]
    public partial bool Carregando { get; set; }

    /// <summary>Mais antigo que 30 dias, só no ERP (PC-11; decisão do dono).</summary>
    public string AvisoMaisAntigos => ConsultasHistoricoLocal.MensagemMaisAntigas;

    // --- Detalhe (Enter) ---

    [ObservableProperty]
    public partial bool MostrandoDetalhe { get; set; }

    [ObservableProperty]
    public partial string TituloDetalhe { get; set; } = string.Empty;

    public ObservableCollection<string> LinhasDetalhe { get; } = [];

    /// <summary>O texto da última 2ª via (como saiu, para conferir na tela; sem impressora, a única cópia).</summary>
    [ObservableProperty]
    public partial string? TextoSegundaVia { get; set; }

    // --- Resumo do dia (F6) ---

    [ObservableProperty]
    public partial bool MostrandoResumo { get; set; }

    [ObservableProperty]
    public partial string TituloResumo { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string? TextoResumo { get; set; }

    /// <summary>A reimpressão ou o resumo sem a permissão: usuário, PIN e motivo do supervisor, na hora (31.3).</summary>
    [ObservableProperty]
    public partial PedidoLiberacaoViewModel? Liberacao { get; set; }

    /// <summary>A leitura em curso (os testes a aguardam).</summary>
    public Task Atualizacao { get; private set; } = Task.CompletedTask;

    public event EventHandler<AlvoFocoCaixas>? FocoSolicitado;

    /// <summary>A Central pede o foco no conteúdo (o 2 de novo no menu).</summary>
    public void Focar() => FocoSolicitado?.Invoke(this, Alvo);

    private AlvoFocoCaixas Alvo => MostrandoResumo ? AlvoFocoCaixas.Resumo : MostrandoDetalhe ? AlvoFocoCaixas.Detalhe : AlvoFocoCaixas.Lista;

    /// <summary>Abre a aba (e a cada visita): o caixa aberto e os fechados dos últimos 30 dias.</summary>
    public Task CarregarAsync(Guid? selecionar = null) => Atualizacao = LerAsync(selecionar);

    private async Task LerAsync(Guid? selecionar)
    {
        var versao = ++_versao;
        Erro = null;
        Carregando = true;
        try
        {
            var conhecidos = _nomes.Keys.ToHashSet();
            var (caixas, nomes) = await Task.Run(async () =>
            {
                var c = await _servico.CaixasAsync();
                var n = new List<(Guid, string)>();
                foreach (var id in c.Select(x => x.OperadorId).Distinct().Where(id => !conhecidos.Contains(id)))
                {
                    n.Add((id, await _servico.NomeUsuarioAsync(id)));
                }

                return (c, n);
            });
            if (versao != _versao)
            {
                return;
            }

            foreach (var (id, nome) in nomes)
            {
                _nomes[id] = nome;
            }

            _viaCaixas = true;

            var escolhida = selecionar ?? Selecionada?.Caixa.SessaoId;
            Linhas.Clear();
            foreach (var c in caixas)
            {
                Linhas.Add(new LinhaCaixaCentralViewModel(c, _fuso, Nome(c.OperadorId)));
            }

            Selecionada = Linhas.FirstOrDefault(l => l.Caixa.SessaoId == escolhida) ?? Linhas.FirstOrDefault();
            var fechados = caixas.Count(c => !c.Aberto);
            Rodape = caixas.Count == 0
                ? "Nenhum caixa aberto nem fechado neste terminal nos últimos 30 dias."
                : (caixas.Any(c => c.Aberto) ? "Caixa aberto e " : string.Empty)
                  + (fechados == 1 ? "1 caixa fechado" : $"{fechados} caixas fechados") + $" nos últimos {ConsultasHistoricoLocal.LimiteDias} dias";
            // O caixa do detalhe saiu da lista (passou dos 30 dias): o detalhe fecha, para nada agir sobre o que não se vê.
            if (_linhaDetalhe is { } aberta && Linhas.All(l => l.Caixa.SessaoId != aberta.Caixa.SessaoId))
            {
                FecharDetalhe();
                Mensagem = ServicoHistoricoCaixas.MensagemForaDoAlcance;
            }
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Tratar(e);
        }
        finally
        {
            if (versao == _versao)
            {
                Carregando = false;
            }
        }
    }

    [RelayCommand]
    private void Mover(string direcao)
    {
        if (Linhas.Count == 0 || MostrandoDetalhe || MostrandoResumo || Liberacao is not null)
        {
            return;
        }

        var i = Selecionada is null ? -1 : Linhas.IndexOf(Selecionada);
        Selecionada = Linhas[direcao == "acima" ? Math.Max(0, i - 1) : Math.Min(Linhas.Count - 1, i + 1)];
    }

    /// <summary>F5: lê de novo; com o detalhe, o resumo ou o pedido do supervisor aberto, nada.</summary>
    [RelayCommand]
    private Task Atualizar()
    {
        if (MostrandoDetalhe || MostrandoResumo || Liberacao is not null)
        {
            return Task.CompletedTask;
        }

        Mensagem = null;
        return CarregarAsync();
    }

    /// <summary>
    /// O relógio da Central (1 s): a liberação que emprestou os caixas acabou. Nada do que ela mostrava fica na aba (a
    /// lista, o detalhe, a 2ª via, o resumo, o pedido do supervisor): a próxima visita lê de novo, com quem pode então.
    /// </summary>
    public void ConferirPermissoes()
    {
        var antes = _viaCaixas;
        _viaCaixas = _servico.VeCaixas;
        if (antes != true || _viaCaixas == true)
        {
            return;
        }

        // A leitura em curso (com a liberação de antes) não volta para a tela.
        _versao++;
        Carregando = false;
        Liberacao = null;
        FecharResumo(focar: false);
        FecharDetalhe(focar: false);
        Linhas.Clear();
        Selecionada = null;
        Rodape = string.Empty;
        Mensagem = null;
        Erro = null;
    }

    /// <summary>Abre o detalhe do caixa <paramref name="sessaoId"/> (o F7 da aba Vendas: "o caixa desta venda").</summary>
    public async Task DetalharSessaoAsync(Guid sessaoId)
    {
        await Atualizacao;
        // O pedido do supervisor deixado aberto aqui (a pessoa foi à aba Vendas pelo mouse) era para outra coisa.
        Liberacao = null;
        if (Linhas.FirstOrDefault(l => l.Caixa.SessaoId == sessaoId) is not { } linha)
        {
            Erro = ServicoHistoricoCaixas.MensagemForaDoAlcance;
            FocoSolicitado?.Invoke(this, AlvoFocoCaixas.Lista);
            return;
        }

        FecharResumo(focar: false);
        if (MostrandoDetalhe)
        {
            FecharDetalhe(focar: false);
        }

        await DetalharCommand.ExecuteAsync(linha);
    }

    /// <summary>Enter (ou o duplo clique, ou o *): o detalhe do caixa escolhido pelo retrato; de novo, fecha.</summary>
    [RelayCommand]
    private Task Detalhar(LinhaCaixaCentralViewModel? linha) => Tentar(async () =>
    {
        if (Liberacao is not null || MostrandoResumo)
        {
            return;
        }

        if (MostrandoDetalhe)
        {
            FecharDetalhe();
            return;
        }

        await AbrirDetalheAsync(linha ?? Escolhida());
    });

    /// <summary>O detalhe de <paramref name="pedida"/> pelo retrato; falso quando ele não abriu (a lista mudou no meio).</summary>
    private async Task<bool> AbrirDetalheAsync(LinhaCaixaCentralViewModel pedida)
    {
        Selecionada = pedida;
        var retrato = await Task.Run(() => _servico.RetratoAsync(pedida.Caixa.SessaoId));
        if (MostrandoDetalhe || Linhas.FirstOrDefault(l => l.Caixa.SessaoId == pedida.Caixa.SessaoId) is not { } atual)
        {
            return false;
        }

        _linhaDetalhe = atual;
        Selecionada = atual;
        TextoSegundaVia = null;
        // A mensagem e o erro da lista (de outro caixa) não seguem para o detalhe.
        Mensagem = null;
        Erro = null;
        TituloDetalhe = atual.Caixa.Aberto
            ? $"Caixa {atual.Caixa.NumeroCaixa:00} · aberto desde {Hora(atual.Caixa.AbertaEm)}"
            : $"Caixa {atual.Caixa.NumeroCaixa:00} · {atual.Situacao.ToLowerInvariant()} em {atual.Fechamento}";
        LinhasDetalhe.Clear();
        foreach (var l in LinhasDoDetalhe(retrato, atual))
        {
            LinhasDetalhe.Add(l);
        }

        MostrandoDetalhe = true;
        FocoSolicitado?.Invoke(this, AlvoFocoCaixas.Detalhe);
        return true;
    }

    /// <summary>As linhas do detalhe: só o que o relatório do fechamento trouxe (PC-9), mais o envio e as canceladas depois.</summary>
    private IEnumerable<string> LinhasDoDetalhe(RetratoCaixa retrato, LinhaCaixaCentralViewModel linha)
    {
        var caixa = retrato.Caixa;
        yield return $"Operador: {linha.Operador}";
        yield return $"Abertura: {Hora(caixa.AbertaEm)} · fundo de troco R$ {NumeroBr.Dinheiro(caixa.FundoTroco)}";
        yield return $"Vendas: {linha.Vendas}";
        if (caixa.Aberto)
        {
            yield return "Caixa aberto: o fechamento ainda não foi feito (F11 › 3 na venda). As vendas dele ficam na aba 1 (F7).";
        }
        else if (retrato.Fechamento is not { } f)
        {
            yield return $"Fechado em {linha.Fechamento}, sem o retrato do fechamento neste caixa: consulte no ERP (Fechamentos de caixa).";
        }
        else
        {
            yield return f.ZeraCaixa
                ? $"Fechamento: {Hora(f.OcorridoEm)} · zerou o caixa"
                : $"Troca de turno: {Hora(f.OcorridoEm)} · ficou na gaveta R$ {NumeroBr.Dinheiro(f.ValorCaixa)}";
            yield return "Contado por forma (como no relatório impresso):";
            foreach (var forma in f.Formas)
            {
                yield return $"  {forma.Descricao}: R$ {NumeroBr.Dinheiro(forma.Contado)}";
            }

            yield return $"Total contado: R$ {NumeroBr.Dinheiro(f.TotalContado)}";
            if (f.Justificativa is { Length: > 0 } justificativa)
            {
                yield return $"Justificativa: {justificativa}";
            }

            if (f.Resumo is { } r)
            {
                yield return $"Vendas do turno: {r.QtdVendas} · R$ {NumeroBr.Dinheiro(r.TotalVendas)} · ticket médio R$ {NumeroBr.Dinheiro(r.TicketMedio)}";
                yield return $"Vendas canceladas: {r.QtdCanceladas} · R$ {NumeroBr.Dinheiro(r.TotalCanceladas)}";
                yield return $"Itens cancelados: {r.QtdItensCancelados} · R$ {NumeroBr.Dinheiro(r.TotalItensCancelados)}";
                yield return $"Descontos: R$ {NumeroBr.Dinheiro(r.TotalDescontos)} ({r.QtdLiberacoes} liberados)";
            }

            yield return $"Envio do fechamento: {LinhaCaixaCentralViewModel.TextoEnvio(caixa.EnvioFechamento)}"
                         + (caixa.EnvioFechamento == StatusEventoSaida.Rejeitado ? " (quem resolve é o ERP, em Cadastros › PDVs / Terminais)" : string.Empty);
        }

        if (retrato.Movimentos.Count == 0)
        {
            yield return "Sangrias e reforços: nenhum.";
        }
        else
        {
            yield return "Sangrias e reforços:";
            foreach (var m in retrato.Movimentos)
            {
                var tipo = m.Tipo == TipoMovimentoCaixa.Sangria ? "Sangria" : "Reforço";
                yield return $"  {Hora(m.OcorridoEm)} {tipo}{(m.Cancelado ? " (cancelado)" : string.Empty)}: R$ {NumeroBr.Dinheiro(m.Valor)}";
            }
        }

        if (retrato.CanceladasDepois.Count > 0)
        {
            yield return "Depois do fechamento:";
            foreach (var v in retrato.CanceladasDepois)
            {
                yield return $"  Venda {v.NumeroExibicao} · R$ {NumeroBr.Dinheiro(v.Total)} · cancelada em {Hora(v.CanceladaEm)}";
            }

            yield return MensagemDepoisDoFechamento;
        }

        if (!caixa.Aberto)
        {
            yield return MensagemSoNoErp;
        }
    }

    /// <summary>
    /// Ctrl+R (22.2; plano 4.3): a 2ª via do relatório do fechamento pelos bytes originais; sem
    /// <c>pdv.documento.reimprimir</c>, o supervisor libera na hora (a liberação da Central só empresta o ver).
    /// </summary>
    [RelayCommand]
    private Task Reimprimir() => Tentar(async () =>
    {
        if (Liberacao is not null || MostrandoResumo)
        {
            return;
        }

        var linha = AlvoDaAcao();
        ExigirAlcance();
        if (linha.Caixa.Aberto)
        {
            throw new RegraNegocioException(ServicoHistoricoCaixas.MensagemCaixaAberto);
        }

        var usuario = _acesso.Usuario ?? throw new RegraNegocioException(AcessoCentral.MensagemFechada);
        if (usuario.Tem(PermissoesPdv.Reimprimir))
        {
            await ReimprimirAsync(linha, null);
            return;
        }

        // Sem o original, "indisponível" antes de pedir o PIN do supervisor (nada sairia).
        await Task.Run(() => _servico.ExigirSegundaViaAsync(linha.Caixa.SessaoId));
        if (Liberacao is null)
        {
            PedirSupervisor(usuario, PermissoesPdv.Reimprimir, $"Reimprimir o fechamento de {linha.Fechamento}", concedida => ReimprimirAsync(linha, concedida));
        }
    });

    private async Task ReimprimirAsync(LinhaCaixaCentralViewModel linha, LiberacaoConcedida? liberacao)
    {
        ExigirAlcance();
        var (texto, avisos) = await Task.Run(() => _servico.ReimprimirFechamentoAsync(linha.Caixa.SessaoId, liberacao));
        var noDetalhe = MostrandoDetalhe && _linhaDetalhe == linha;
        if (!noDetalhe && !MostrandoDetalhe && avisos.Contains(ServicoHistoricoCaixas.MensagemReimpressaoSemImpressora))
        {
            // Pela lista, sem impressora: a única cópia é a da tela, então o detalhe abre com ela.
            noDetalhe = await AbrirDetalheAsync(linha);
        }

        TextoSegundaVia = noDetalhe ? texto : null;
        Mensagem = avisos.Count > 0
            ? string.Join(" ", avisos)
            : $"Fechamento de {linha.Fechamento} reimpresso (2ª via)" + (liberacao is null ? "." : $", liberado por {liberacao.Supervisor.Nome}.");
    }

    /// <summary>F7: as vendas do caixa escolhido, na aba 1 (com o filtro nesse caixa).</summary>
    [RelayCommand]
    private Task VerVendas() => Tentar(() =>
    {
        if (Liberacao is not null || MostrandoResumo)
        {
            return Task.CompletedTask;
        }

        ExigirAlcance();
        var linha = AlvoDaAcao();
        return _verVendas(linha.Caixa.SessaoId);
    });

    /// <summary>
    /// F6 (plano 3.1): o resumo diário do dia operacional do caixa escolhido, pelas regras do F11 › 6 (sem
    /// <c>pdv.relatorio.resumo_diario</c>, o supervisor libera na hora; O3: só as quantidades para quem não vê o calculado).
    /// </summary>
    [RelayCommand]
    private Task ResumoDoDia() => Tentar(() =>
    {
        if (Liberacao is not null || MostrandoResumo)
        {
            return Task.CompletedTask;
        }

        ExigirAlcance();
        var linha = AlvoDaAcao();
        var usuario = _acesso.Usuario ?? throw new RegraNegocioException(AcessoCentral.MensagemFechada);
        var dia = linha.Caixa.DiaOperacional;
        if (usuario.Tem(PermissoesPdv.ResumoDiario))
        {
            return MostrarResumoAsync(dia, null);
        }

        PedirSupervisor(usuario, PermissoesPdv.ResumoDiario, $"Resumo do dia {dia:dd/MM}", concedida => MostrarResumoAsync(dia, concedida));
        return Task.CompletedTask;
    });

    private async Task MostrarResumoAsync(DateOnly dia, LiberacaoConcedida? liberacao)
    {
        var resultado = await Task.Run(() => _servico.ResumoDoDiaAsync(dia, imprimir: false, liberacao));
        _liberacaoResumo = liberacao;
        _diaResumo = dia;
        Mensagem = null;
        TituloResumo = $"Resumo do dia {dia.ToString("dd/MM/yyyy", NumeroBr.Cultura)}";
        TextoResumo = resultado.Texto;
        MostrandoResumo = true;
        FocoSolicitado?.Invoke(this, AlvoFocoCaixas.Resumo);
    }

    /// <summary>Ctrl+P no resumo do dia: manda à impressora (como o F11 › 6).</summary>
    [RelayCommand]
    private Task ImprimirResumo() => Tentar(async () =>
    {
        if (!MostrandoResumo || Liberacao is not null)
        {
            return;
        }

        var (dia, liberacao) = (_diaResumo, _liberacaoResumo);
        var resultado = await Task.Run(() => _servico.ResumoDoDiaAsync(dia, imprimir: true, liberacao));
        TextoResumo = resultado.Texto;
        Mensagem = resultado.Avisos.Count > 0 ? string.Join(" ", resultado.Avisos) : "Resumo do dia enviado à impressora.";
    });

    /// <summary>Esc: fecha o pedido do supervisor, depois o resumo, depois o detalhe, depois volta ao menu da Central.</summary>
    [RelayCommand]
    private Task Voltar()
    {
        if (Liberacao is not null)
        {
            Liberacao = null;
            FocoSolicitado?.Invoke(this, Alvo);
            return Task.CompletedTask;
        }

        if (MostrandoResumo)
        {
            FecharResumo();
            return Task.CompletedTask;
        }

        if (MostrandoDetalhe)
        {
            FecharDetalhe();
            return Task.CompletedTask;
        }

        return _voltar();
    }

    private void PedirSupervisor(Operador usuario, string permissao, string acao, Func<LiberacaoConcedida, Task> aoLiberar)
    {
        PedidoLiberacaoViewModel? pedido = null;
        pedido = new PedidoLiberacaoViewModel(
            _shell.Servico<IAutenticadorOperador>(), _shell.Servico<IRelogio>(), usuario, permissao, acao,
            async concedida =>
            {
                if (!ReferenceEquals(Liberacao, pedido))
                {
                    // O pedido foi fechado antes do PIN (Esc, o F7 da aba Vendas ou a liberação da Central que acabou,
                    // ConferirPermissoes).
                    return;
                }

                Liberacao = null;
                await Tentar(() => aoLiberar(concedida));
                FocoSolicitado?.Invoke(this, Alvo);
            },
            erro =>
            {
                if (ReferenceEquals(Liberacao, pedido))
                {
                    Liberacao = null;
                    Erro = erro;
                    FocoSolicitado?.Invoke(this, Alvo);
                }

                return Task.CompletedTask;
            });
        Liberacao = pedido;
    }

    private void FecharDetalhe(bool focar = true)
    {
        MostrandoDetalhe = false;
        _linhaDetalhe = null;
        TituloDetalhe = string.Empty;
        TextoSegundaVia = null;
        LinhasDetalhe.Clear();
        // O que o detalhe disse (a 2ª via, o "indisponível") era sobre aquele caixa: não fica na lista.
        Mensagem = null;
        Erro = null;
        if (focar)
        {
            FocoSolicitado?.Invoke(this, AlvoFocoCaixas.Lista);
        }
    }

    private void FecharResumo(bool focar = true)
    {
        if (!MostrandoResumo)
        {
            return;
        }

        MostrandoResumo = false;
        TextoResumo = null;
        _liberacaoResumo = null;
        Mensagem = null;
        Erro = null;
        if (focar)
        {
            FocoSolicitado?.Invoke(this, Alvo);
        }
    }

    /// <summary>
    /// A liberação que emprestou os caixas pode ter acabado depois da última conferência do relógio da Central (1 s) e
    /// antes da tecla: a ação é recusada na hora (o relógio da Central devolve a tela ao Painel).
    /// </summary>
    private void ExigirAlcance()
    {
        if (!_servico.VeCaixas)
        {
            throw new RegraNegocioException(MensagemLiberacaoAcabou);
        }
    }

    private LinhaCaixaCentralViewModel Escolhida() =>
        Selecionada ?? throw new RegraNegocioException(Linhas.Count == 0 ? "Nenhum caixa na lista." : "Escolha um caixa (setas ↑/↓ ou clique).");

    /// <summary>O caixa das ações (Ctrl+R, F6, F7): o do detalhe aberto ou, na lista, o escolhido.</summary>
    private LinhaCaixaCentralViewModel AlvoDaAcao() => MostrandoDetalhe && _linhaDetalhe is { } aberta ? aberta : Escolhida();

    private async Task Tentar(Func<Task> acao)
    {
        try
        {
            Erro = null;
            await acao();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Tratar(e);
        }
    }

    private void Tratar(Exception e)
    {
        if (e is RegraNegocioException regra)
        {
            Erro = regra.Message;
            return;
        }

        // Nada aqui derruba o caixa: a falha vai para o log e para a tela (mascarada).
        _shell.Servico<ILogger<AbaCaixasViewModel>>().LogError(e, "Falha na aba Caixas da Central");
        Erro = $"Não deu certo ({MascaradorSuporte.Mascarar(e.Message)}). F5 tenta de novo.";
    }

    private string Nome(Guid usuarioId) => _nomes.GetValueOrDefault(usuarioId, "outro operador");

    private string Hora(DateTimeOffset quando) => TimeZoneInfo.ConvertTime(quando, _fuso).ToString("dd/MM HH:mm", NumeroBr.Cultura);
}
