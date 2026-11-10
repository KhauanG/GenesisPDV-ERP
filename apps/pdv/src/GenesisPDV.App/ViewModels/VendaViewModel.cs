using System.Collections.ObjectModel;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Sync.Cliente;

namespace GenesisPDV.App.ViewModels;

/// <summary>Tela principal de venda (PDV 9): campo de código sempre com foco; tudo pelo teclado.</summary>
public sealed partial class VendaViewModel : ViewModelBase
{
    private readonly ShellViewModel _shell;
    private readonly IServicoSincronizacao _sync;
    private readonly TimeZoneInfo _fuso = DiaOperacional.ObterFuso(null);
    private readonly DispatcherTimer _relogio;

    public VendaViewModel(ShellViewModel shell)
    {
        _shell = shell;
        ServicoVenda = shell.Servico<ServicoVenda>();
        Sessao = shell.Servico<SessaoTerminal>();
        _sync = shell.Servico<IServicoSincronizacao>();
        var preferencias = shell.Servico<ServicoHardware>().Preferencias;
        BarraBotoes = preferencias.BarraBotoes;
        PesquisaSoNumeros = preferencias.PesquisaSoNumeros;
        Atalhos =
        [
            new("F1", "Ajuda", AjudaCommand),
            new("F2", "Pesquisar", PesquisarCommand),
            new("F3", "Quantidade", QuantidadeCommand),
            new("F4", "Remover item", RemoverItemCommand),
            new("F5", "Cliente / CPF", ClienteCommand),
            new("F6", "Desconto", DescontoCommand),
            new("F7", "Vendedor", FuturoCommand, "F7 Vendedor", Futuro: true),
            new("F8", "Tipo de preço", FuturoCommand, "F8 Tipo de preço", Futuro: true),
            new("F9", "Pedidos/Orç.", FuturoCommand, "F9 Pedidos/Orçamentos", Futuro: true),
            new("F10", "CONCLUIR", ConcluirCommand, Destaque: true),
            new("F11", "Funções", FuncoesCommand),
            new("F12", "Gestão de vendas", GestaoVendasCommand),
            new("Ctrl+N", "Nova venda", FuturoCommand, "Ctrl+N Nova venda", Futuro: true),
            new("Ctrl+T", "Troca", FuturoCommand, "Ctrl+T Troca", Futuro: true),
            new("Shift+F4", "Cancelar venda", CancelarVendaCommand),
            // A engrenagem no fim da barra (Central do PDV, bloco G3): o mesmo do F11 › 8.
            new(TeclaCentral, "⚙ Central", CentralCommand),
        ];
        _sync.SituacaoAlterada += (_, s) => Dispatcher.UIThread.Post(() => AplicarSituacao(s));
        AplicarSituacao(_sync.Situacao);
        _relogio = new DispatcherTimer(TimeSpan.FromSeconds(1), DispatcherPriority.Background, (_, _) => AtualizarHora());
        _relogio.Start();
        AtualizarHora();
        AtualizarTela();
    }

    public ServicoVenda ServicoVenda { get; }

    /// <summary>Caixa da sessão aberta (sangria, reforço, movimentos, limite de gaveta, cascos, resumo; C10a/C10b).</summary>
    public ServicoCaixa ServicoCaixa => _shell.Servico<ServicoCaixa>();

    public T Servico<T>() where T : notnull => _shell.Servico<T>();

    public const string MensagemCaixaLivre = "Finalize ou cancele a venda atual antes: a função exige o caixa livre.";

    /// <summary>A tecla do botão ⚙ da barra (Central do PDV): o F11 › 8.</summary>
    public const string TeclaCentral = "F11 › 8";

    public SessaoTerminal Sessao { get; }

    public ObservableCollection<ItemLinhaViewModel> Itens { get; } = [];

    public string Loja => Sessao.NomeLoja;

    public string Caixa => $"Caixa {Sessao.Identidade?.NumeroCaixa:00}";

    public string Operador => $"Op.: {Sessao.Operador?.Nome ?? "-"}";

    public string Legenda1 => "F1 Ajuda  F2 Pesquisar  F3 Qtd  F4 Remover  F5 Cliente  F6 Desconto  F7 Vendedor  F8 Tipo preço";

    public string Legenda2 => "F9 Pedidos/Orç.  F10 CONCLUIR  F11 Funções  F12 Gestão vendas  Ctrl+N Nova  Ctrl+T Troca  Shift+F4 Cancelar venda  F11›8 ⚙ Central";

    /// <summary>
    /// Barra de funções com botões (padrão; decisão 65): cada botão dispara o mesmo comando da tecla — as permissões e as
    /// liberações são as mesmas. Desligada na configuração do terminal, a legenda em texto (<see cref="Legenda1"/>).
    /// </summary>
    public bool BarraBotoes { get; }

    public bool BarraTexto => !BarraBotoes;

    /// <summary>Pesquisa de produto só por números (configuração do terminal; padrão desligada).</summary>
    public bool PesquisaSoNumeros { get; }

    /// <summary>Os botões da barra, na ordem da legenda (PDV 9.1, 28).</summary>
    public IReadOnlyList<AtalhoBarraViewModel> Atalhos { get; }

    [ObservableProperty]
    public partial ItemLinhaViewModel? ItemSelecionado { get; set; }

    [ObservableProperty]
    public partial string CodigoEntrada { get; set; } = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(MultiplicadorTexto))]
    public partial decimal? MultiplicadorPendente { get; set; }

    public string MultiplicadorTexto => $"Qtd: {NumeroBr.Quantidade(MultiplicadorPendente ?? 1m).TrimEnd('0').TrimEnd(',')}";

    [ObservableProperty]
    public partial string UltimoItemTexto { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string CabecalhoVenda { get; set; } = string.Empty;

    [ObservableProperty]
    public partial bool CaixaLivre { get; set; } = true;

    [ObservableProperty]
    public partial string ItensTexto { get; set; } = "Itens: 0";

    [ObservableProperty]
    public partial string SubtotalTexto { get; set; } = "0,00";

    [ObservableProperty]
    public partial string DescontosTexto { get; set; } = "0,00";

    [ObservableProperty]
    public partial string AcrescimosTexto { get; set; } = "0,00";

    [ObservableProperty]
    public partial string TotalTexto { get; set; } = "0,00";

    /// <summary>"Economia atacado: R$ 3,60" no rodapé dos totais (11.3.1); nulo sem atacado/mix.</summary>
    [ObservableProperty]
    public partial string? EconomiaTexto { get; set; }

    /// <summary>"Cascos descontados: 3 GARRAFA 600ML -7,50" (PDV 10.12, O14; C11c), já dentro dos descontos.</summary>
    [ObservableProperty]
    public partial string? CascosDescontadosTexto { get; set; }

    /// <summary>Dica informativa da barra: "Faltam 3 para o preço de atacado de …" (11.3.1).</summary>
    [ObservableProperty]
    public partial string? DicaPrecoTexto { get; set; }

    [ObservableProperty]
    public partial string PainelDescricao { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string PainelDetalhe { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string? Mensagem { get; set; }

    [ObservableProperty]
    public partial bool MensagemEhErro { get; set; }

    [ObservableProperty]
    public partial bool VendaRecuperada { get; set; }

    [ObservableProperty]
    public partial string? TrocoTexto { get; set; }

    [ObservableProperty]
    public partial string? UltimoCupom { get; set; }

    [ObservableProperty]
    public partial DialogoViewModel? Dialogo { get; set; }

    [ObservableProperty]
    public partial string ConexaoTexto { get; set; } = "● Offline";

    /// <summary>Nível do indicador (PDV 30.2): verde (<see cref="ConexaoOk"/>), vermelho (<see cref="ConexaoFalha"/>) ou âmbar.</summary>
    [ObservableProperty]
    public partial bool ConexaoOk { get; set; }

    [ObservableProperty]
    public partial bool ConexaoFalha { get; set; }

    /// <summary>Último erro do sync, na dica do indicador.</summary>
    [ObservableProperty]
    public partial string? ConexaoDetalhe { get; set; }

    [ObservableProperty]
    public partial bool Online { get; set; }

    [ObservableProperty]
    public partial string PendentesTexto { get; set; } = "⇅ 0";

    [ObservableProperty]
    public partial string Hora { get; set; } = string.Empty;

    /// <summary>
    /// Aviso discreto da barra quando o caixa não tem impressora (PDV 6.2; I4): a venda segue normalmente e o cupom fica
    /// registrado para a reimpressão.
    /// </summary>
    public string? ImpressoraTexto => _shell.Servico<ServicoImpressao>().Configurada ? null : "🖶 Sem impressora";

    /// <summary>
    /// Ícone ⚠ da barra de status (Central do PDV, bloco G4; plano 4.1): o Painel de saúde tem item vermelho na última
    /// rodada (a barata, a cada minuto, ou a do Painel aberto). O clique abre a Central no Painel (com o caixa livre, como
    /// o ⚙). Nulo sem problema.
    /// </summary>
    [ObservableProperty]
    public partial string? SaudeTexto { get; set; }

    /// <summary>Os itens vermelhos, na dica do ícone.</summary>
    [ObservableProperty]
    public partial string? SaudeDica { get; set; }

    /// <summary>Selecionar outro item ou fechar um diálogo devolve o foco ao campo de código (a View observa).</summary>
    public event EventHandler? FocoNoCodigoSolicitado;

    /// <param name="mensagem">Aviso de quem trouxe à venda (abertura do caixa, operar no caixa de outro).</param>
    public async Task CarregarAsync(string? mensagem = null)
    {
        VendaRecuperada = await ServicoVenda.RecuperarAsync();
        await _sync.AcordarAsync();
        AtualizarTela();
        if (VendaRecuperada)
        {
            MostrarMensagem("Venda recuperada após interrupção.", erro: false);
        }
        else if (mensagem is not null)
        {
            MostrarMensagem(mensagem, erro: false);
        }
    }

    /// <summary>
    /// Faixa amarela da sessão antiga (PDV 8.1): "Caixa aberto desde 28/10 08:02 — faça o fechamento"; com
    /// <c>pdv.bloqueia_sessao_dia_anterior</c>, avisa que nenhuma venda nova começa.
    /// </summary>
    [ObservableProperty]
    public partial string? AlertaSessao { get; set; }

    /// <summary>Faixa âmbar do limite de gaveta (PDV 20.4): a partir de 80% do limite, "sangria recomendada".</summary>
    [ObservableProperty]
    public partial string? AlertaGavetaAmbar { get; set; }

    /// <summary>Faixa âmbar do saldo estimado (PDV 29.1; O15 do dono): o último item deixou o saldo negativo.</summary>
    [ObservableProperty]
    public partial string? AlertaEstoque { get; set; }

    /// <summary>Faixa vermelha do limite de gaveta (20.4): no limite, nenhuma venda nova começa até a sangria.</summary>
    [ObservableProperty]
    public partial string? AlertaGavetaVermelho { get; set; }

    /// <summary>
    /// F11 › 1/2 (PDV 20.1–20.2): sangria ou reforço com o caixa livre. Sem a permissão (o perfil do operador tem as duas,
    /// O5 do dono), pede a liberação; o tipo não anunciado pela nuvem e a D22 recusam antes de abrir o diálogo.
    /// </summary>
    public Task AbrirMovimentoCaixaAsync(string tipo) => Executar(async () =>
    {
        if (ServicoVenda.VendaAberta)
        {
            throw new RegraNegocioException(MensagemCaixaLivre);
        }

        var operador = Sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");
        var sangria = tipo == Data.Entidades.TipoMovimentoCaixa.Sangria;
        var permissao = sangria ? Core.Caixa.PermissoesPdv.Sangria : Core.Caixa.PermissoesPdv.Reforco;
        if (operador.Tem(permissao))
        {
            await AbrirMovimentoAsync(tipo, null);
            return;
        }

        PedirLiberacao(permissao, sangria ? "Sangria" : "Reforço", liberacao => AbrirMovimentoAsync(tipo, liberacao));
    });

    private async Task AbrirMovimentoAsync(string tipo, LiberacaoConcedida? liberacao)
    {
        var preparo = await ServicoCaixa.PrepararMovimentoAsync(tipo);
        AbrirDialogo(new DialogoMovimentoCaixaViewModel(this, tipo, preparo, liberacao));
    }

    /// <summary>Sangria ou reforço gravado: fecha o diálogo, mostra o comprovante na impressora simulada e a faixa nova.</summary>
    public void MovimentoRegistrado(ResultadoMovimentoCaixa resultado)
    {
        ArgumentNullException.ThrowIfNull(resultado);
        var m = resultado.Movimento;
        Dialogo = null;
        TrocoTexto = null;
        UltimoCupom = resultado.Relatorio;
        AtualizarTela();
        AtualizarGaveta();
        var texto = $"{(m.Tipo == Data.Entidades.TipoMovimentoCaixa.Sangria ? "Sangria" : "Reforço")} de R$ {NumeroBr.Dinheiro(m.Valor)} registrado(a).";
        MostrarMensagem(resultado.Avisos.Count > 0 ? $"{texto} {string.Join(" ", resultado.Avisos)}" : texto, erro: resultado.Avisos.Count > 0);
        FocoNoCodigoSolicitado?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>F12 Movimentos (20.3), a partir da sangria ou do reforço; Esc volta a <paramref name="voltarPara"/>.</summary>
    public async Task AbrirMovimentosAsync(DialogoViewModel? voltarPara)
    {
        var lista = new DialogoMovimentosViewModel(this, voltarPara);
        await lista.AtualizarAsync();
        AbrirDialogo(lista);
    }

    /// <summary>
    /// F11 › 6 (21.6): com <c>pdv.relatorio.resumo_diario</c> (perfil do operador) ou a liberação; relê as chaves (o filtro
    /// segue <c>pdv.resumo_diario_modo</c>).
    /// </summary>
    public Task AbrirResumoDiarioAsync() => Executar(async () =>
    {
        await ServicoCaixa.CarregarRegrasAsync();
        var operador = Sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");
        if (operador.Tem(Core.Caixa.PermissoesPdv.ResumoDiario))
        {
            AbrirDialogo(new DialogoResumoDiarioViewModel(this, null));
            return;
        }

        PedirLiberacao(Core.Caixa.PermissoesPdv.ResumoDiario, "Resumo diário", liberacao =>
        {
            AbrirDialogo(new DialogoResumoDiarioViewModel(this, liberacao));
            return Task.CompletedTask;
        });
    });

    /// <summary>F11 › S (30.2): status detalhado da sincronização.</summary>
    public async Task AbrirStatusSyncAsync()
    {
        var status = new DialogoStatusSyncViewModel(this, _sync, _shell.Servico<Microsoft.EntityFrameworkCore.IDbContextFactory<Data.PdvDbContext>>());
        await status.AtualizarAsync();
        AbrirDialogo(status);
    }

    /// <summary>
    /// F11 › V (10.12): devolução avulsa de cascos. Com o caixa livre, a entrada dos vazios; com a venda em andamento
    /// (C11c), também o desconto nela pelo valor do casco — só antes do pagamento (F10), como os demais descontos.
    /// </summary>
    public Task AbrirVasilhamesAsync() => Executar(async () =>
    {
        if (ServicoVenda.Atual is { Status: StatusVenda.EmPagamento })
        {
            throw new RegraNegocioException("Volte aos itens (Esc no pagamento) para registrar cascos nesta venda.");
        }

        var dialogo = new DialogoVasilhamesViewModel(this);
        await dialogo.AtualizarAsync();
        AbrirDialogo(dialogo);
    });

    /// <summary>F11 › 3 (PDV 21.2): fechamento de caixa, só com o caixa livre; sem a permissão, pede a liberação.</summary>
    public Task FecharCaixaAsync() => Executar(async () =>
    {
        if (ServicoVenda.VendaAberta)
        {
            throw new RegraNegocioException(Data.Repositorios.RepositorioCaixa.MensagemVendaAberta);
        }

        var operador = Sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");
        if (operador.Tem(Core.Caixa.PermissoesPdv.FecharCaixa))
        {
            await _shell.IrParaFechamentoAsync();
            return;
        }

        PedirLiberacao(Core.Caixa.PermissoesPdv.FecharCaixa, "Fechar caixa", liberacao => _shell.IrParaFechamentoAsync(liberacao: liberacao));
    });

    /// <summary>
    /// F11 › 8 ou o ⚙ da barra (Central do PDV, bloco G3; PDV 6): a Central com o operador logado e as permissões dele,
    /// só com o caixa livre e fora da confirmação de desativação (D22). A aba 3 (Impressora e gaveta, a configuração de
    /// antes) pede ela mesma a liberação de <c>pdv.config.terminal</c> a quem não a tem.
    /// </summary>
    /// <param name="aba">A aba em que a Central abre (nula = o Painel de saúde).</param>
    public Task AbrirCentralAsync(string? aba = null) => Executar(() =>
    {
        if (ServicoVenda.VendaAberta)
        {
            throw new RegraNegocioException(MensagemCaixaLivre);
        }

        if (_sync.Situacao.ConfirmandoDesativacao)
        {
            throw new RegraNegocioException(ServicoCaixa.MensagemConfirmandoDesativacao);
        }

        var operador = Sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");
        _shell.IrParaCentralPelaVenda(operador, aba);
        return Task.CompletedTask;
    });

    /// <summary>
    /// F3 no F12 (Central do PDV, bloco G5): as vendas dos caixas anteriores, na Central › 1 Vendas (as mesmas regras do
    /// ⚙: o caixa livre e fora da confirmação da desativação). Com a venda em andamento, o F12 fica com a mensagem.
    /// </summary>
    public Task AbrirVendasNaCentralAsync()
    {
        if (ServicoVenda.VendaAberta)
        {
            throw new RegraNegocioException(MensagemCaixaLivre);
        }

        if (_sync.Situacao.ConfirmandoDesativacao)
        {
            throw new RegraNegocioException(ServicoCaixa.MensagemConfirmandoDesativacao);
        }

        FecharDialogo();
        return AbrirCentralAsync(Servicos.Diagnostico.AbasCentral.Vendas.Codigo);
    }

    /// <summary>
    /// F3 no F11 › S (Central do PDV, bloco G7): a lista completa na Central › 4 Sincronização (as mesmas regras do ⚙: o
    /// caixa livre e fora da confirmação da desativação). Com a venda em andamento, o F11 › S fica com a mensagem.
    /// </summary>
    public Task AbrirSincronizacaoNaCentralAsync()
    {
        if (ServicoVenda.VendaAberta)
        {
            throw new RegraNegocioException(MensagemCaixaLivre);
        }

        if (_sync.Situacao.ConfirmandoDesativacao)
        {
            throw new RegraNegocioException(ServicoCaixa.MensagemConfirmandoDesativacao);
        }

        FecharDialogo();
        return AbrirCentralAsync(Servicos.Diagnostico.AbasCentral.Sincronizacao.Codigo);
    }

    /// <summary>
    /// Ctrl+Del na aba Vendas da Central, numa venda paga do caixa aberto: o F12 com essa venda escolhida e o cancelamento
    /// de sempre (13.3; o gerente ou o encarregado, os demais pedem a liberação de um deles). Se ela não estiver na lista do F12, nada é aberto.
    /// </summary>
    public Task CancelarVendaDaCentralAsync(Guid vendaId) => AbrirGestaoVendasAsync(async lista =>
    {
        if (lista.Linhas.FirstOrDefault(l => l.Venda.Id == vendaId) is not { } linha)
        {
            lista.Erro = "A venda escolhida na Central não está no caixa aberto.";
            return;
        }

        lista.Selecionada = linha;
        await lista.CancelarSelecionadaCommand.ExecuteAsync(null);
    });

    /// <summary>
    /// F11 › 9 (PDV 19.4; dono, I4): abrir a gaveta sem venda, com <c>pdv.gaveta.abrir_avulsa</c> (fora do perfil do
    /// operador: o supervisor libera) e o motivo, auditado. Com a gaveta desligada, só o aviso (nada é enviado).
    /// </summary>
    public Task AbrirGavetaAvulsaAsync() => Executar(() =>
    {
        if (!_shell.Servico<ServicoGaveta>().Ligada)
        {
            throw new RegraNegocioException(ServicoGaveta.MensagemDesligada);
        }

        var operador = Sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");
        if (operador.Tem(Core.Caixa.PermissoesPdv.AbrirGavetaAvulsa))
        {
            AbrirDialogo(new DialogoAbrirGavetaViewModel(this, null));
            return Task.CompletedTask;
        }

        PedirLiberacao(Core.Caixa.PermissoesPdv.AbrirGavetaAvulsa, "Abrir a gaveta", liberacao =>
        {
            AbrirDialogo(new DialogoAbrirGavetaViewModel(this, liberacao));
            return Task.CompletedTask;
        });
        return Task.CompletedTask;
    });

    /// <summary>Gaveta aberta pelo F11 › 9: fecha o diálogo e avisa na barra.</summary>
    public void GavetaAberta()
    {
        FecharDialogo();
        MostrarMensagem("Gaveta aberta.", erro: false);
        FocoNoCodigoSolicitado?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>Abre o diálogo de liberação do supervisor (PDV 31.3); concedida, executa a ação com ela.</summary>
    public void PedirLiberacao(string permissao, string acao, Func<LiberacaoConcedida, Task> aoLiberar)
    {
        var operador = Sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");
        DialogoLiberacaoViewModel? dialogo = null;
        var pedido = new PedidoLiberacaoViewModel(
            _shell.Servico<IAutenticadorOperador>(), _shell.Servico<IRelogio>(), operador, permissao, acao,
            async concedida =>
            {
                try
                {
                    await aoLiberar(concedida);
                }
                catch (RegraNegocioException e)
                {
                    if (Dialogo == dialogo)
                    {
                        FecharDialogo();
                    }

                    MostrarMensagem(e.Message, erro: true);
                }
            },
            erro =>
            {
                FecharDialogo();
                if (erro is not null)
                {
                    MostrarMensagem(erro, erro: true);
                }

                return Task.CompletedTask;
            });
        dialogo = new DialogoLiberacaoViewModel(this, pedido);
        AbrirDialogo(dialogo);
    }

    public async Task RecarregarDoBancoAsync()
    {
        await ServicoVenda.RecarregarAsync();
        Dialogo = null;
        AtualizarTela();
        FocoNoCodigoSolicitado?.Invoke(this, EventArgs.Empty);
    }

    public void AbrirDialogo(DialogoViewModel dialogo) => Dialogo = dialogo;

    public void FecharDialogo(int? selecionar = null, string? mensagem = null)
    {
        Dialogo = null;
        AtualizarTela(selecionar);
        if (mensagem is not null)
        {
            MostrarMensagem(mensagem, erro: false);
        }

        FocoNoCodigoSolicitado?.Invoke(this, EventArgs.Empty);
    }

    public void DefinirMultiplicador(decimal quantidade) => MultiplicadorPendente = quantidade;

    public void VendaFinalizada(ResultadoFinalizacao resultado)
    {
        Dialogo = null;
        VendaRecuperada = false;
        TrocoTexto = resultado.Venda.Troco > 0m ? $"TROCO R$ {NumeroBr.Dinheiro(resultado.Venda.Troco)}" : "VENDA CONCLUÍDA";
        UltimoCupom = resultado.TextoCupom;
        AtualizarTela();
        AtualizarGaveta();
        if (resultado.Avisos.Count > 0)
        {
            MostrarMensagem(string.Join(" ", resultado.Avisos), erro: true);
        }
        else
        {
            MostrarMensagem($"Venda {resultado.Venda.NumeroExibicao} concluída. Cupom enviado à impressora.", erro: false);
        }

        FocoNoCodigoSolicitado?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>Enter/duplo clique na pesquisa: inclui a linha escolhida, na embalagem dela (o fardo achado pelo DUN entra como fardo).</summary>
    public async Task IncluirDaPesquisaAsync(ProdutoPesquisado pesquisado)
    {
        ArgumentNullException.ThrowIfNull(pesquisado);
        var codigo = pesquisado.Codigo;
        var resultado = await ServicoVenda.IncluirResolvidoAsync(pesquisado.Resolvido, MultiplicadorPendente ?? 1m, codigo, "busca");
        MultiplicadorPendente = null;
        LimparPosVenda();
        if (resultado.Tipo == TipoResultadoEntrada.MontarCombo)
        {
            AbrirDialogo(new DialogoMontarComboViewModel(this, resultado.Combo!, resultado.Multiplicador ?? 1m, codigo, "busca"));
            return;
        }

        FecharDialogo(resultado.Item?.Sequencia);
        AbrirCascosSeNecessario(resultado.Item);
    }

    /// <summary>Enter na última posição do Montar combo: inclui o combo com as escolhas (10.9.1).</summary>
    public async Task IncluirComboAsync(ComboResolvido combo, IReadOnlyList<int> escolhas, decimal quantidade, string? codigo, string? origemEntrada)
    {
        var linhas = await ServicoVenda.IncluirComboAsync(combo, escolhas, quantidade, codigo, origemEntrada);
        MultiplicadorPendente = null;
        LimparPosVenda();
        FecharDialogo(linhas[0].Sequencia, $"{combo.Kit.Descricao} incluído.");
    }

    /// <summary>Produto cheio retornável incluído ou alterado: pergunta os cascos trazidos (10.12). Devolve se abriu.</summary>
    public bool AbrirCascosSeNecessario(ItemVenda? item)
    {
        if (item is null || !ServicoVenda.ExigeCascos(item))
        {
            return false;
        }

        AbrirDialogo(new DialogoCascosViewModel(this, item.Sequencia));
        return true;
    }

    public async Task RemoverDescontoItemAsync(int sequencia)
    {
        await Executar(async () =>
        {
            await ServicoVenda.RemoverDescontoItemAsync(sequencia);
            FecharDialogo(sequencia, $"Desconto do item {sequencia} removido.");
        });
    }

    public async Task RemoverDescontoTotalAsync()
    {
        await Executar(async () =>
        {
            await ServicoVenda.RemoverDescontoTotalAsync();
            FecharDialogo(mensagem: "Desconto no total removido.");
        });
    }

    [RelayCommand]
    private Task ProcessarEntrada() => Executar(async () =>
    {
        var texto = CodigoEntrada;
        var resultado = await ServicoVenda.ProcessarEntradaAsync(texto, MultiplicadorPendente, pesquisaSoNumeros: PesquisaSoNumeros);
        CodigoEntrada = string.Empty;
        switch (resultado.Tipo)
        {
            case TipoResultadoEntrada.MultiplicadorDefinido:
                MultiplicadorPendente = resultado.Multiplicador;
                break;
            case TipoResultadoEntrada.AbrirPesquisa:
                // Dígitos que não acharam produto na pesquisa só por números: o "3*44" vale para o escolhido.
                if (resultado.Multiplicador is { } multiplicador && multiplicador != 1m)
                {
                    MultiplicadorPendente = multiplicador;
                }

                await AbrirPesquisaAsync(resultado.TextoPesquisa ?? string.Empty);
                break;
            case TipoResultadoEntrada.MontarCombo:
                MultiplicadorPendente = null;
                AbrirDialogo(new DialogoMontarComboViewModel(this, resultado.Combo!, resultado.Multiplicador ?? 1m, resultado.Codigo, null));
                break;
            case TipoResultadoEntrada.ItemIncluido:
                MultiplicadorPendente = null;
                LimparPosVenda();
                Mensagem = null;
                AtualizarTela(resultado.Item?.Sequencia);
                AbrirCascosSeNecessario(resultado.Item);
                break;
        }
    }, limparCodigoEmErro: true);

    [RelayCommand]
    private Task Pesquisar() => Dialogo is null ? AbrirPesquisaAsync(CodigoEntrada) : Task.CompletedTask;

    [RelayCommand]
    private void Quantidade()
    {
        if (Dialogo is not null)
        {
            return;
        }

        var item = ItemSelecionado is { Cancelado: false } i && ServicoVenda.VendaAberta ? i : null;
        AbrirDialogo(new DialogoQuantidadeViewModel(this, item));
    }

    [RelayCommand]
    private Task RemoverItem() =>
        Dialogo is not null ? Task.CompletedTask : RemoverItemAsync(ItemSelecionado is { Cancelado: false } i ? i.Sequencia : null);

    /// <summary>
    /// F4 Remover item e o "Remover item" da janela do item (PDV 13.1): com <c>pdv.venda.cancelar_item</c> (perfil do
    /// operador) abre o diálogo do cancelamento; sem ela, ou com <c>pdv.cancelar_item_exige_supervisor</c> ligada, o
    /// supervisor libera antes (PIN de outra pessoa, motivo; a liberação vai no item e na auditoria).
    /// </summary>
    public Task RemoverItemAsync(int? sequencia) => Executar(async () =>
    {
        if (!ServicoVenda.VendaAberta)
        {
            throw new RegraNegocioException("Não há venda em andamento.");
        }

        if (!await ServicoVenda.CancelarItemExigeLiberacaoAsync())
        {
            AbrirDialogo(new DialogoRemoverItemViewModel(this, sequencia, null));
            return;
        }

        // O supervisor libera ESTE item (o pedido mostra qual e quanto vale); no diálogo, a sequência fica travada.
        var item = sequencia is { } seq ? ServicoVenda.Atual!.ObterItem(seq) : null;
        if (item is not { Cancelado: false })
        {
            throw new RegraNegocioException("Selecione o item a cancelar (setas ↑/↓ ou clique) antes de pedir a liberação.");
        }

        PedirLiberacao(Core.Caixa.PermissoesPdv.CancelarItem, DescreverCancelamento(item), concedida =>
        {
            AbrirDialogo(new DialogoRemoverItemViewModel(this, item.Sequencia, concedida));
            return Task.CompletedTask;
        });
    });

    /// <summary>"Cancelar item 2 — CERV BRAHMA LT 350ML (12,000 UN, R$ 38,28)" (o combo, com o total das linhas).</summary>
    private string DescreverCancelamento(ItemVenda item)
    {
        if (item.Kit is { } kit)
        {
            var linhas = ServicoVenda.Atual!.LinhasDoCombo(kit.GrupoId);
            return $"Cancelar o combo do item {item.Sequencia} — {kit.Descricao} (R$ {NumeroBr.Dinheiro(linhas.Sum(l => l.ValorLiquido))})";
        }

        return $"Cancelar item {item.Sequencia} — {item.Descricao} ({NumeroBr.Quantidade(item.Quantidade)} {item.Unidade}, R$ {NumeroBr.Dinheiro(item.ValorLiquido)})";
    }

    /// <summary>
    /// Diminuir a quantidade sem poder cancelar item sozinho (F3, janela do item, "−"; PDV 13.1): o supervisor libera e a
    /// redução vira o cancelamento parcial liberado (linha cancelada, <c>autorizado_por_id</c> e as auditorias).
    /// </summary>
    public void PedirLiberacaoReducao(ReducaoExigeLiberacaoException e)
    {
        ArgumentNullException.ThrowIfNull(e);
        AtualizarTela();
        MostrarMensagem(e.Message, erro: true);
        PedirLiberacao(Core.Caixa.PermissoesPdv.CancelarItem, e.Acao, async concedida =>
        {
            var restante = await ServicoVenda.CancelarItemAsync(e.Sequencia, e.Quantidade, concedida);
            FecharDialogo(restante?.Sequencia,
                $"{NumeroBr.Quantidade(e.Quantidade)} do item {e.Sequencia} cancelado(s) com liberação de {concedida.Supervisor.Nome}.");
            AbrirCascosSeNecessario(restante);
        });
    }

    /// <summary>
    /// Duplo clique num item lançado (decisão 65): a janela do item, com a quantidade, o desconto e o "Remover item" —
    /// as mesmas regras do F3, do F6 e do F4. Item cancelado não abre.
    /// </summary>
    [RelayCommand]
    private void AbrirItem(ItemLinhaViewModel? linha)
    {
        if (Dialogo is not null || linha is null || !ServicoVenda.VendaAberta)
        {
            return;
        }

        if (linha.Cancelado)
        {
            MostrarMensagem($"Item {linha.Sequencia} cancelado: não pode ser alterado.", erro: true);
            FocoNoCodigoSolicitado?.Invoke(this, EventArgs.Empty);
            return;
        }

        ItemSelecionado = Itens.FirstOrDefault(i => i.Sequencia == linha.Sequencia && !i.EhComponente) ?? linha;
        AbrirDialogo(new DialogoItemViewModel(this, linha.Sequencia));
    }

    /// <summary>
    /// Botão da barra de funções: o mesmo comando da tecla; depois, sem diálogo aberto, o foco volta ao campo de código
    /// (o leitor de código de barras digita no campo focado).
    /// </summary>
    [RelayCommand]
    private async Task AcionarAtalho(AtalhoBarraViewModel? atalho)
    {
        if (atalho is null || Dialogo is not null)
        {
            return;
        }

        if (atalho.Comando is IAsyncRelayCommand assincrono)
        {
            await assincrono.ExecuteAsync(atalho.Parametro);
        }
        else if (atalho.Comando.CanExecute(atalho.Parametro))
        {
            atalho.Comando.Execute(atalho.Parametro);
        }

        if (Dialogo is null)
        {
            FocoNoCodigoSolicitado?.Invoke(this, EventArgs.Empty);
        }
    }

    /// <summary>
    /// F3 e a janela do item: muda a quantidade (regras do Core: inteiro fora das unidades fracionáveis, fator da embalagem,
    /// combo e casco não mudam, desconto e limite). Devolve se o diálogo dos cascos trazidos abriu (10.12).
    /// </summary>
    public async Task<bool> AlterarQuantidadeAsync(ItemVenda item, decimal quantidade)
    {
        ArgumentNullException.ThrowIfNull(item);
        await ServicoVenda.AlterarQuantidadeAsync(item.Sequencia, quantidade);
        AtualizarTela(item.Sequencia);

        // Alterar a quantidade do item cheio pergunta de novo os cascos trazidos (10.12).
        return AbrirCascosSeNecessario(item);
    }

    /// <summary>
    /// F6 e a janela do item (PDV 12.2, 12.3): aplica o desconto no item (<paramref name="sequencia"/>) ou no total (nulo);
    /// acima do limite do operador, o supervisor libera (PIN, motivo e o limite dele) e a liberação entra em
    /// <c>liberacoes</c> da venda (C10a). <paramref name="aoAplicar"/> recebe a mensagem do desconto aplicado.
    /// </summary>
    public async Task AplicarDescontoAsync(int? sequencia, Desconto desconto, Action<string> aoAplicar)
    {
        ArgumentNullException.ThrowIfNull(desconto);
        ArgumentNullException.ThrowIfNull(aoAplicar);
        var resultado = sequencia is { } seq
            ? await ServicoVenda.DescontoItemAsync(seq, desconto)
            : await ServicoVenda.DescontoTotalAsync(desconto);
        if (resultado.Situacao == SituacaoDesconto.ExigeLiberacao)
        {
            var permissao = sequencia is null ? Core.Caixa.PermissoesPdv.DescontoTotal : Core.Caixa.PermissoesPdv.DescontoItem;
            var limite = Sessao.Operador?.LimiteDescontoEfetivoPct ?? 0m;
            var pedido = resultado.PercentualPedido;
            var porque = Sessao.Operador?.Tem(permissao) == true
                ? $"seu limite: {NumeroBr.Percentual(limite)}%"
                : "sem a permissão de desconto";
            PedirLiberacao(
                permissao,
                $"Desconto de {NumeroBr.Percentual(pedido)}% ({porque})",
                async concedida =>
                {
                    var liberacao = new Liberacao(concedida.Supervisor.Id, concedida.Supervisor.LimiteDescontoPct, concedida.Motivo,
                        concedida.ConcedidaEm, concedida.Supervisor.Master);
                    var liberado = sequencia is { } s
                        ? await ServicoVenda.DescontoItemAsync(s, desconto, liberacao)
                        : await ServicoVenda.DescontoTotalAsync(desconto, liberacao);
                    if (!liberado.Aplicado)
                    {
                        throw new RegraNegocioException(
                            $"Desconto de {NumeroBr.Percentual(pedido)}% excede também o limite do supervisor ({NumeroBr.Percentual(liberacao.LimiteEfetivoPct)}%).");
                    }

                    aoAplicar($"Desconto de R$ {NumeroBr.Dinheiro(liberado.Valor)} aplicado com liberação de {concedida.Supervisor.Nome}.");
                });
            return;
        }

        if (!resultado.Aplicado)
        {
            throw new RegraNegocioException($"Desconto de {NumeroBr.Percentual(resultado.PercentualPedido)}% não aplicado.");
        }

        aoAplicar($"Desconto de R$ {NumeroBr.Dinheiro(resultado.Valor)} aplicado.");
    }

    [RelayCommand]
    private void Desconto()
    {
        if (Dialogo is not null)
        {
            return;
        }

        if (!ServicoVenda.VendaAberta)
        {
            MostrarMensagem("Não há venda em andamento.", erro: true);
            return;
        }

        AbrirDialogo(new DialogoMenuDescontoViewModel(this, ItemSelecionado));
    }

    [RelayCommand]
    private Task Concluir() => Executar(async () =>
    {
        if (Dialogo is not null)
        {
            return;
        }

        if (!ServicoVenda.VendaAberta)
        {
            throw new RegraNegocioException("Inclua itens antes de concluir a venda.");
        }

        if (ServicoVenda.Atual!.Status == StatusVenda.EmAndamento)
        {
            await ServicoVenda.IniciarPagamentoAsync();
        }
        else
        {
            await ServicoVenda.CarregarRegrasPagamentoAsync();
        }

        AbrirDialogo(await DialogoPagamentoViewModel.CriarAsync(this));
    });

    /// <summary>F5 Cliente (PDV 14.1–14.2; O8 do dono): só quando o cliente pede; nada é perguntado no fluxo padrão.</summary>
    [RelayCommand]
    private void Cliente()
    {
        if (Dialogo is not null)
        {
            return;
        }

        if (!ServicoVenda.VendaAberta)
        {
            MostrarMensagem("Não há venda em andamento: registre um item antes de identificar o cliente.", erro: true);
            return;
        }

        AbrirDialogo(new DialogoClienteViewModel(this, null));
    }

    /// <summary>
    /// Venda sem estoque com o bloqueio ligado (PDV 29.1): o supervisor com <c>pdv.venda.vender_sem_estoque</c> libera o
    /// produto nesta venda; o operador registra o item de novo.
    /// </summary>
    public void PedirLiberacaoEstoque(EstoqueInsuficienteException e)
    {
        ArgumentNullException.ThrowIfNull(e);
        MostrarMensagem(e.Message, erro: true);
        CodigoEntrada = string.Empty;
        PedirLiberacao(Core.Caixa.PermissoesPdv.VenderSemEstoque, "Venda sem estoque", async concedida =>
        {
            await ServicoVenda.LiberarSemEstoqueAsync(e.ProdutoId, concedida);
            FecharDialogo(mensagem: $"Venda sem estoque liberada por {concedida.Supervisor.Nome}: registre o item de novo.");
        });
    }

    /// <summary>
    /// Shift+F4 (PDV 13.2; O6 do dono): cancela a venda em andamento com o motivo em texto livre (15 a 255). Sem
    /// <c>pdv.venda.cancelar_venda_aberta</c> (fora do perfil do operador), o supervisor libera antes do motivo.
    /// </summary>
    [RelayCommand]
    private void CancelarVenda()
    {
        if (Dialogo is not null)
        {
            return;
        }

        if (!ServicoVenda.VendaAberta)
        {
            MostrarMensagem("Não há venda em andamento.", erro: true);
            return;
        }

        var operador = Sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");
        var titulo = $"Cancelar a venda inteira {ServicoVenda.Atual!.NumeroExibicao} (R$ {NumeroBr.Dinheiro(ServicoVenda.Atual.Total)})";
        if (operador.Tem(Core.Caixa.PermissoesPdv.CancelarVendaAberta))
        {
            AbrirDialogo(new DialogoMotivoCancelamentoViewModel(this, titulo, motivo => CancelarVendaEmAndamentoAsync(motivo, null)));
            return;
        }

        PedirLiberacao(Core.Caixa.PermissoesPdv.CancelarVendaAberta, "Cancelar a venda em andamento", concedida =>
        {
            AbrirDialogo(new DialogoMotivoCancelamentoViewModel(this, titulo, motivo => CancelarVendaEmAndamentoAsync(motivo, concedida)));
            return Task.CompletedTask;
        });
    }

    private async Task CancelarVendaEmAndamentoAsync(string motivo, LiberacaoConcedida? liberacao)
    {
        await ServicoVenda.CancelarVendaAsync(motivo, liberacao);
        VendaRecuperada = false;
        FecharDialogo(mensagem: liberacao is null ? "Venda cancelada." : $"Venda cancelada com liberação de {liberacao.Supervisor.Nome}.");
        // Desativação pedida durante a venda: com o caixa livre, vai para a tela de desativação (SYNC 3.8).
        _shell.AoMudarSituacao(_sync.Situacao);
    }

    /// <summary>
    /// F12 Gestão de vendas (PDV 22.1; C11b): as vendas da sessão aberta, com a reimpressão e o cancelamento da venda
    /// paga. <c>pdv.venda.consultar</c> está no perfil do operador; sem ela, a liberação do supervisor.
    /// </summary>
    [RelayCommand]
    private Task GestaoVendas() => Dialogo is not null ? Task.CompletedTask : AbrirGestaoVendasAsync();

    /// <param name="depois">O que fazer com a lista aberta (F11 › 4 e 5: a última venda já escolhida).</param>
    public Task AbrirGestaoVendasAsync(Func<DialogoGestaoVendasViewModel, Task>? depois = null) => Executar(async () =>
    {
        if (Sessao.SessaoCaixa is null)
        {
            throw new RegraNegocioException(Data.Repositorios.RepositorioCaixa.MensagemSemSessao);
        }

        var operador = Sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");
        async Task Abrir()
        {
            var lista = new DialogoGestaoVendasViewModel(this);
            await lista.AtualizarAsync();
            AbrirDialogo(lista);
            if (depois is not null)
            {
                await depois(lista);
            }
        }

        if (operador.Tem(Core.Caixa.PermissoesPdv.ConsultarVendas))
        {
            await Abrir();
            return;
        }

        PedirLiberacao(Core.Caixa.PermissoesPdv.ConsultarVendas, "Gestão de vendas", _ => Abrir());
    });

    /// <summary>F11 › 4 (22.2): reimprime direto a última venda paga da sessão.</summary>
    public Task ReimprimirUltimaAsync() => AbrirGestaoVendasAsync(async lista =>
    {
        lista.Selecionada = lista.Linhas.FirstOrDefault(l => l.Ativa) ?? lista.Selecionada;
        await lista.ReimprimirCommand.ExecuteAsync(null);
    });

    /// <summary>F11 › 5 (13.3): "Cancelar última venda" — a última venda paga da sessão, no diálogo do cancelamento.</summary>
    public Task CancelarUltimaAsync() => AbrirGestaoVendasAsync(async lista =>
    {
        lista.Selecionada = lista.Linhas.FirstOrDefault(l => l.Ativa) ?? lista.Selecionada;
        await lista.CancelarSelecionadaCommand.ExecuteAsync(null);
    });

    /// <summary>Reimpressão (22.2): o comprovante aparece na impressora simulada, como o da venda.</summary>
    public void MostrarCupom(string texto)
    {
        TrocoTexto = null;
        UltimoCupom = texto;
    }

    /// <summary>Venda paga cancelada (13.3): o dinheiro devolvido sai da gaveta estimada (a faixa do limite acompanha).</summary>
    public void VendaFinalizadaCancelada(ResultadoCancelamentoFinalizada resultado)
    {
        ArgumentNullException.ThrowIfNull(resultado);
        TrocoTexto = resultado.Cancelamento.SaiDaGaveta > 0m ? $"DEVOLVER R$ {NumeroBr.Dinheiro(resultado.Cancelamento.SaiDaGaveta)}" : null;
        AtualizarGaveta();
        MostrarMensagem(string.Join(" ", [$"Venda {resultado.Venda.NumeroExibicao} cancelada.", .. resultado.Instrucoes, .. resultado.Avisos]),
            erro: resultado.Avisos.Count > 0);
    }

    [RelayCommand]
    private void Ajuda()
    {
        if (Dialogo is null)
        {
            AbrirDialogo(new DialogoAjudaViewModel(this));
        }
    }

    /// <summary>O ⚙ da barra: o mesmo do F11 › 8.</summary>
    [RelayCommand]
    private Task Central() => Dialogo is not null ? Task.CompletedTask : AbrirCentralAsync();

    /// <summary>O ícone ⚠ da barra: a Central, que abre no Painel de saúde (as mesmas regras do ⚙).</summary>
    [RelayCommand]
    private Task PainelSaude() => Central();

    /// <summary>
    /// O "⇅ N" da barra (Central do PDV, bloco G7; pedido do dono de 04/11/2026): a Central › 4 Sincronização, nas vendas
    /// que a nuvem ainda não confirmou (as regras do ⚙: o caixa livre, fora da D22). Sem <c>pdv.diagnostico.ver</c>, a aba
    /// pede o supervisor (Ctrl+L) e abre depois do PIN.
    /// </summary>
    [RelayCommand]
    private Task Pendentes() => Dialogo is not null ? Task.CompletedTask : AbrirCentralAsync(Servicos.Diagnostico.AbasCentral.Sincronizacao.Codigo);

    [RelayCommand]
    private void Futuro(string funcao) => MostrarMensagem($"{funcao}: disponível nas próximas fases.", erro: false);

    /// <summary>F11 Funções (PDV 28.2): sangria, reforço, fechamento, resumo diário, status do sync e vasilhames.</summary>
    [RelayCommand]
    private void Funcoes()
    {
        if (Dialogo is null)
        {
            AbrirDialogo(new DialogoFuncoesViewModel(this));
        }
    }

    [RelayCommand]
    private void Mover(string direcao)
    {
        if (Itens.Count == 0)
        {
            return;
        }

        var i = ItemSelecionado is null ? Itens.Count : Itens.IndexOf(ItemSelecionado);
        i = direcao switch
        {
            "acima" => Math.Max(0, i - 1),
            "abaixo" => Math.Min(Itens.Count - 1, i + 1),
            "inicio" => 0,
            _ => Itens.Count - 1,
        };
        ItemSelecionado = Itens[i];
    }

    /// <summary>Ctrl+Alt+T (PDV 6.8): sem permissão, com a auditoria <c>editar</c> (Central do PDV, bloco G11).</summary>
    [RelayCommand]
    private Task AlternarTema() => Executar(() => _shell.Servico<ServicoParametrosLocais>().AlternarTemaAsync(Sessao.Operador?.Id));

    /// <summary>
    /// F11 › 7 ou Ctrl+Alt+B (PDV 7.4; bloco G11): bloqueia a tela agora, com a venda em andamento guardada; só o PIN do
    /// operador ou um supervisor desbloqueia. Com um diálogo aberto, o diálogo fica como estava atrás do bloqueio.
    /// </summary>
    [RelayCommand]
    private Task BloquearTela() => BloquearTelaAsync();

    public Task BloquearTelaAsync() => _shell.BloquearTelaAsync(this, BloqueioTela.ComoManual);

    /// <summary>De volta do bloqueio: o foco volta ao campo de código (ou ao diálogo, que pede o foco ao aparecer).</summary>
    public void AposDesbloqueio()
    {
        AtualizarHora();
        if (Dialogo is null)
        {
            FocoNoCodigoSolicitado?.Invoke(this, EventArgs.Empty);
        }
    }

    partial void OnItemSelecionadoChanged(ItemLinhaViewModel? value)
    {
        if (value is null)
        {
            PainelDescricao = string.Empty;
            PainelDetalhe = string.Empty;
            return;
        }

        PainelDescricao = value.EhComponente ? value.Item.Descricao : value.Descricao;
        PainelDetalhe = value.EhComponente
            ? $"{value.Quantidade} no combo {value.Item.Kit!.Descricao}"
            : $"{value.Quantidade} x {value.Unitario}" + (value.Etiqueta is { } e ? $"  {e}" : string.Empty)
              + (value.Cancelado ? "  (CANCELADO)" : string.Empty);
    }

    public void AtualizarTela(int? selecionar = null)
    {
        var venda = ServicoVenda.Atual;
        var selecionadoAntes = selecionar ?? ItemSelecionado?.Sequencia;
        Itens.Clear();
        AlertaEstoque = ServicoVenda.AvisoEstoque;
        if (venda is null || !venda.Aberta)
        {
            CaixaLivre = true;
            CabecalhoVenda = $"CAIXA LIVRE · {Sessao.Operador?.Nome}";
            ItensTexto = "Itens: 0";
            SubtotalTexto = DescontosTexto = AcrescimosTexto = TotalTexto = "0,00";
            EconomiaTexto = DicaPrecoTexto = CascosDescontadosTexto = null;
            ItemSelecionado = null;
            return;
        }

        var combos = new HashSet<Guid>();
        foreach (var item in venda.Itens)
        {
            var quemCancelou = item.CanceladoPorId == Sessao.Operador?.Id ? Sessao.Operador?.Nome : null;
            if (item.Kit is { } kit)
            {
                // Combo: título + componentes indentados (Desmembra Produto Kit ligado; o recolhido entra com a chave).
                if (combos.Add(kit.GrupoId))
                {
                    var linhas = venda.LinhasDoCombo(kit.GrupoId, incluirCanceladas: item.Cancelado);
                    Itens.Add(new ItemLinhaViewModel(item, quemCancelou, _fuso, TipoLinha.TituloCombo, linhas));
                    foreach (var linha in linhas)
                    {
                        Itens.Add(new ItemLinhaViewModel(linha, quemCancelou, _fuso, TipoLinha.ComponenteCombo, linhas));
                    }
                }

                continue;
            }

            Itens.Add(new ItemLinhaViewModel(item, quemCancelou, _fuso, cascos: venda.ExigeCascos(item) ? venda.Cascos(item.Sequencia) : null));
        }

        CaixaLivre = false;
        CabecalhoVenda = $"VENDA {venda.NumeroExibicao}  ·  Balcão  ·  Preço: {venda.TipoPreco.ToUpperInvariant()}"
                         + (venda.CpfCnpjNota is { } doc ? $"  ·  {(doc.Length == 11 ? "CPF" : "CNPJ")} {doc}" : venda.ClienteId is not null ? "  ·  CLIENTE" : string.Empty)
                         + (venda.Status == StatusVenda.EmPagamento ? "  ·  EM PAGAMENTO" : string.Empty);
        ItensTexto = $"Itens: {venda.QtdItens} ({NumeroBr.Quantidade(venda.VolumeTotal)} vol.)";
        SubtotalTexto = NumeroBr.Dinheiro(venda.SubtotalBruto);
        var descontos = venda.DescontoItens + venda.DescontoTotal;
        DescontosTexto = descontos > 0m ? "-" + NumeroBr.Dinheiro(descontos) : "0,00";
        AcrescimosTexto = NumeroBr.Dinheiro(venda.AcrescimoTotal);
        TotalTexto = NumeroBr.Dinheiro(venda.Total);
        EconomiaTexto = venda.EconomiaAtacado > 0m ? $"Economia atacado: R$ {NumeroBr.Dinheiro(venda.EconomiaAtacado)}" : null;
        CascosDescontadosTexto = venda.CascosDescontados.Count == 0
            ? null
            : "Cascos descontados: " + string.Join(" · ", venda.CascosDescontados.Select(c => $"{c.Quantidade} {c.Descricao}"))
              + $"  -{NumeroBr.Dinheiro(venda.DescontoCascos)}";
        ItemSelecionado = Itens.FirstOrDefault(i => i.Sequencia == selecionadoAntes && !i.EhComponente) ?? Itens.LastOrDefault(i => !i.EhComponente);
        if (venda.ItensAtivos.LastOrDefault() is { } ultimo)
        {
            UltimoItemTexto = $"Último: {ultimo.Descricao} {NumeroBr.Dinheiro(ultimo.ValorBruto)}";
        }

        DicaPrecoTexto = Dica(venda);

        foreach (var aviso in venda.ConsumirAvisos())
        {
            MostrarMensagem(aviso, erro: true);
        }
    }

    /// <summary>Dica do último item com uma faixa de preço ao alcance (até metade do limiar, 11.3.1).</summary>
    private static string? Dica(Venda venda)
    {
        foreach (var item in venda.ItensAtivos.Reverse())
        {
            if (venda.DicaPreco(item) is not { } dica)
            {
                continue;
            }

            var faltam = dica.Faltam.ToString("0.###", NumeroBr.Cultura);
            return dica.Origem == OrigemPreco.GrupoMix || dica.GrupoNome is not null
                ? $"Faltam {faltam} do {dica.GrupoNome} para {item.Descricao} a R$ {NumeroBr.Preco(dica.Preco)}"
                : $"Faltam {faltam} para o preço de atacado de {item.Descricao} (R$ {NumeroBr.Preco(dica.Preco)})";
        }

        return null;
    }

    /// <summary>F4 na pesquisa (F2-B35): o diálogo dos saldos online do produto; Esc volta à <paramref name="pesquisa"/>.</summary>
    public async Task AbrirOutrasLojasAsync(DialogoPesquisaViewModel pesquisa, ProdutoVenda produto)
    {
        var dialogo = new DialogoOutrasLojasViewModel(this, pesquisa, produto);
        AbrirDialogo(dialogo);
        await dialogo.ConsultarAsync();
    }

    private async Task AbrirPesquisaAsync(string filtro)
    {
        var dialogo = new DialogoPesquisaViewModel(this, filtro);
        AbrirDialogo(dialogo);
        await dialogo.AtualizarAsync(filtro);
        CodigoEntrada = string.Empty;
    }

    private void LimparPosVenda()
    {
        TrocoTexto = null;
        UltimoCupom = null;
    }

    private void MostrarMensagem(string texto, bool erro)
    {
        Mensagem = texto;
        MensagemEhErro = erro;
    }

    /// <summary>Indicador da barra (PDV 30.2) e, em desativação com o caixa livre, a troca para a tela de desativação.</summary>
    private void AplicarSituacao(SituacaoSincronizacao s)
    {
        Online = s.Online;
        var (texto, nivel) = IndicadorSync.Calcular(s, DateTimeOffset.UtcNow);
        ConexaoTexto = texto;
        ConexaoOk = nivel == NivelIndicador.Ok;
        ConexaoFalha = nivel == NivelIndicador.Erro;
        ConexaoDetalhe = s.Erro;
        PendentesTexto = $"⇅ {s.Pendentes}";
    }

    /// <summary>Ctrl+Alt+S "Sincronizar agora" (PDV 30.2).</summary>
    [RelayCommand]
    private void SincronizarAgora()
    {
        _sync.SincronizarAgora();
        MostrarMensagem("Sincronizando agora…", erro: false);
    }

    private void AtualizarHora()
    {
        Hora = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, _fuso).ToString("HH:mm", NumeroBr.Cultura);
        AlertaSessao = ServicoCaixa.AvaliarSessao().Mensagem;
        if (ReferenceEquals(_shell.PaginaAtual, this))
        {
            // Bloqueio por inatividade (bloco G11; desligado por padrão): só a tela que está na frente confere.
            _shell.ConferirInatividade(this);
        }

        AtualizarGaveta();
        AtualizarSaude();
        // "Offline há N min" e "Cadastros de N dias atrás" andam com o relógio, sem esperar o ciclo.
        AplicarSituacao(_sync.Situacao);
    }

    /// <summary>O ícone ⚠ lê a última rodada do Painel de saúde (em memória: nada roda aqui).</summary>
    private void AtualizarSaude()
    {
        var problemas = _shell.Servico<Servicos.Diagnostico.VerificadorSaude>().Ultimo.Itens
            .Where(i => i.Nivel == Servicos.Diagnostico.NivelSaude.Problema).ToList();
        SaudeTexto = problemas.Count == 0 ? null : problemas.Count == 1 ? $"⚠ {problemas[0].Nome}" : $"⚠ {problemas.Count} problemas";
        SaudeDica = problemas.Count == 0
            ? null
            : $"{string.Join(" · ", problemas.Select(p => $"{p.Nome}: {p.Frase}"))} Clique (ou F11 › 8) para ver o Painel de saúde e o que fazer.";
    }

    /// <summary>Faixa do limite de gaveta da última apuração do caixa (20.4).</summary>
    private void AtualizarGaveta()
    {
        var gaveta = ServicoCaixa.Gaveta;
        AlertaGavetaAmbar = gaveta.Faixa == Core.Caixa.FaixaGaveta.Alerta ? gaveta.Mensagem : null;
        AlertaGavetaVermelho = gaveta.Faixa == Core.Caixa.FaixaGaveta.Bloqueio ? gaveta.Mensagem : null;
    }

    private async Task Executar(Func<Task> acao, bool limparCodigoEmErro = false)
    {
        try
        {
            await acao();
        }
        catch (EstoqueInsuficienteException e)
        {
            AtualizarTela();
            PedirLiberacaoEstoque(e);
        }
        catch (ReducaoExigeLiberacaoException e)
        {
            if (limparCodigoEmErro)
            {
                CodigoEntrada = string.Empty;
            }

            PedirLiberacaoReducao(e);
        }
        catch (Core.Caixa.LimiteGavetaAtingidoException e)
        {
            // PDV 20.4: a venda nova não começa; o supervisor pode liberar uma venda (`pdv.caixa.ignorar_limite_sangria`).
            MostrarMensagem(e.Message, erro: true);
            CodigoEntrada = string.Empty;
            AtualizarTela();
            AtualizarGaveta();
            PedirLiberacao(Core.Caixa.PermissoesPdv.IgnorarLimiteSangria, "Venda acima do limite de dinheiro na gaveta", async concedida =>
            {
                await ServicoCaixa.LiberarLimiteGavetaAsync(concedida);
                FecharDialogo(mensagem: $"Uma venda liberada acima do limite de gaveta por {concedida.Supervisor.Nome}: registre o item de novo.");
            });
        }
        catch (RegraNegocioException e)
        {
            MostrarMensagem(e.Message, erro: true);
            if (limparCodigoEmErro)
            {
                CodigoEntrada = string.Empty;
            }

            AtualizarTela();
        }
        catch (Exception e)
        {
            await _shell.TratarErroInesperadoAsync(e);
        }
    }
}
