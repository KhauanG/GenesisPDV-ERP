using System.Text.Json.Nodes;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Outbox;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Hardware.Gaveta;
using GenesisPDV.Hardware.Impressora;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Eventos;
using GenesisPDV.Sync.Protocolo;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// Chaves <c>pdv.*</c> do caixa lidas do espelho <c>configuracoes</c> (loja sobre empresa; PDV 8, 21), mais as duas que
/// bloqueiam a sessão nova (8.1): <c>geral.ativa</c> (modo implantação) e <c>lojas.usa_pdv</c> do espelho da loja.
/// </summary>
/// <param name="ValorLimiteSangria">Limite de dinheiro na gaveta (20.4); nulo ou 0 = sem limite (O5 do dono).</param>
/// <param name="ResumoDiarioModo">Filtro do resumo diário (21.6): <c>intervalo_dias</c> ou <c>horario</c>.</param>
public sealed record RegrasCaixa(
    bool SolicitaAbertura,
    bool ImprimeComprovantes,
    RegrasFechamento Fechamento,
    int HorasAlertaSessao,
    bool BloqueiaSessaoDiaAnterior,
    bool EmpresaAtiva = true,
    bool LojaUsaPdv = true,
    decimal? ValorLimiteSangria = null,
    bool SangriaLimitadaAoSaldo = true,
    string ResumoDiarioModo = ChavesConfiguracao.ResumoPorDias)
{
    public static RegrasCaixa Padrao { get; } = new(true, true, RegrasFechamento.PadraoDono, ChavesConfiguracao.HorasAlertaSessaoPadrao, false);
}

/// <summary>O que o login encontra no caixa (PDV 7.2, 8.1).</summary>
public enum SituacaoAposLogin
{
    /// <summary>Sem sessão aberta, com a abertura obrigatória: tela de abertura.</summary>
    Abrir,

    /// <summary>Sessão do mesmo operador (ou recém-aberta sozinha): direto para a venda.</summary>
    Vender,

    /// <summary>Sessão de outro operador: diálogo da troca de turno ou de operar no caixa dele.</summary>
    SessaoDeOutro,
}

/// <param name="NomeOperadorSessao">Quem abriu a sessão encontrada (diálogo "aberto por FULANO desde 08:02").</param>
/// <param name="AberturaAutomatica">
/// <see cref="SituacaoAposLogin.Abrir"/> só porque o disco está quase cheio (G4): a abertura seria a automática
/// (<c>pdv.solicita_abertura_caixa</c> desligada), e a tela a faz assim depois da liberação.
/// </param>
public sealed record ResultadoAposLogin(
    SituacaoAposLogin Situacao,
    TurnoHerdado? Herdado = null,
    SessaoCaixaRegistro? Sessao = null,
    string? NomeOperadorSessao = null,
    bool AberturaAutomatica = false);

/// <summary>Fechamento preparado: a apuração da sessão e a máquina do fechamento cego.</summary>
public sealed record FechamentoPreparado(SessaoCaixaRegistro Sessao, DadosApuracaoSessao Dados, FechamentoCego Fechamento, string NomeOperadorSessao);

/// <summary>Sangria ou reforço pedido na tela (PDV 20.1–20.2): o que o operador digitou, ainda sem validar.</summary>
/// <param name="QuemRetiraUsuarioId">Usuário escolhido no F2 (quem retira; no reforço, quem entrega).</param>
/// <param name="Cedulas">"F3 Contar cédulas" (só payload, <c>contagem_cedulas</c>).</param>
public sealed record DadosMovimentoCaixa(
    string Tipo,
    decimal? Valor,
    Guid? QuemRetiraUsuarioId,
    string? QuemRetiraNome,
    string? Observacao,
    string? InfAdicionais,
    IReadOnlyDictionary<decimal, int>? Cedulas = null);

/// <param name="Relatorio">Texto do comprovante impresso (impressora simulada e testes); nulo sem impressão.</param>
public sealed record ResultadoMovimentoCaixa(MovimentoCaixaRegistro Movimento, string? Relatorio, IReadOnlyList<string> Avisos);

/// <summary>Antes de abrir a sangria ou o reforço: o dinheiro estimado e se o operador pode vê-lo (O3).</summary>
public sealed record PreparoMovimento(decimal DinheiroEstimado, bool MostraEstimado);

/// <summary>Usuário do espelho para o "Quem retira" (F2, PDV 20.1).</summary>
public sealed record UsuarioRetirada(Guid Id, int Codigo, string Nome);

/// <param name="Texto">O resumo como sai na impressora (a tela mostra o mesmo texto).</param>
public sealed record ResultadoResumoDiario(ResumoDiario Resumo, string Texto, IReadOnlyList<string> Avisos);

/// <param name="Relatorio">Texto do relatório impresso (impressora simulada e testes).</param>
public sealed record ResultadoFechamentoCaixa(FechamentoCaixaRegistro Fechamento, string? Relatorio, IReadOnlyList<string> Avisos);

/// <summary>
/// Caixa do PDV (Fase 1C, bloco C10a; PDV 7.2, 8, 21, 31): o que o login encontra, a abertura (manual, automática e na
/// troca de turno, com o fundo herdado), o fechamento cego por forma e a troca de turno. Cada fato vai ao banco com o
/// evento num commit (<see cref="RepositorioCaixa"/>) e só depois imprime e abre a gaveta, como a venda (17.1). As
/// permissões são as do operador logado; sem ela, a tela pede a liberação do supervisor (31.3), que entra aqui como
/// <see cref="LiberacaoConcedida"/> e fica na auditoria <c>liberacao</c> do mesmo commit.
/// </summary>
public sealed class ServicoCaixa(
    RepositorioCaixa caixa,
    RepositorioConfiguracoes configuracoes,
    CatalogoLocal catalogo,
    IDbContextFactory<PdvDbContext> fabrica,
    IRelogio relogio,
    SessaoTerminal sessao,
    ServicoImpressao impressao,
    ServicoGaveta gaveta,
    IServicoSincronizacao sincronizacao,
    ILogger<ServicoCaixa> log,
    ServicoBackup? backupLocal = null,
    MedidorDisco? disco = null,
    OpcoesSaude? opcoesSaude = null,
    TimeProvider? tempo = null)
{
    public const string MensagemSemPermissao = "Operação exige permissão ou liberação do supervisor.";
    public const string MensagemSemFormaDinheiro =
        "Nenhuma forma de pagamento do tipo Dinheiro no cadastro (ERP › Formas de pagamento): cadastre uma e sincronize para fechar o caixa.";
    public const string MensagemConfirmandoDesativacao = "O terminal está confirmando a desativação pedida no ERP: aguarde a resposta.";
    public const string MensagemEmpresaEmImplantacao = "Empresa em implantação: o caixa só abre depois que o ERP ligar Configurações › Geral › Ativa.";
    public const string MensagemLojaSemPdv = "Esta loja não usa PDV (ERP › Lojas › Usa PDV desligado): o caixa não abre nova sessão.";

    /// <summary>Troca de turno com venda pendente do operador anterior (21.2): só ele, ou quem opera no caixa dele, a resolve.</summary>
    public static string MensagemVendaAbertaDeOutro(string nomeOperador) =>
        $"Há venda em andamento ou suspensa na sessão de {nomeOperador}: escolha [2] Operar no caixa de {nomeOperador} para finalizá-la " +
        "ou cancelá-la antes da troca de turno.";

    public const string MensagemVasilhameInvalido = "Escolha o casco vazio na lista (produto do tipo vasilhame).";
    public const string MensagemQuantidadeCascos = "Informe a quantidade de cascos devolvidos: de 1 a 9.999, sem fração.";

    /// <summary>Auditoria da sangria recusada acima do estimado (20.1; está em <c>ACOES_AUDITORIA</c> do shared).</summary>
    public const string AcaoSangriaRecusada = "sangria_recusada";

    /// <summary>
    /// Venda liberada acima do limite de gaveta (20.4): vale para a próxima venda desta sessão <b>e deste operador</b>,
    /// enquanto a gaveta continuar no vermelho. Some no login seguinte (outro operador, ou o mesmo de novo) e quando a
    /// gaveta sai do bloqueio (a sangria que o vermelho pede): a liberação antiga nunca cobre uma venda de outro momento.
    /// </summary>
    private (Guid Sessao, Guid Operador)? _limiteLiberado;

    /// <summary>
    /// Liberação do resumo diário já auditada (31.3): a do diálogo aberto vale para as consultas e impressões dele até o
    /// Esc, com uma auditoria <c>liberacao</c> só (a comparação é por referência: cada pedido ao supervisor é outra).
    /// </summary>
    private LiberacaoConcedida? _liberacaoResumoAuditada;

    private readonly OpcoesSaude _opcoesSaude = opcoesSaude ?? new OpcoesSaude();
    private readonly TimeProvider _tempo = tempo ?? TimeProvider.System;

    /// <summary>
    /// Marca monotônica (<see cref="TimeProvider.GetTimestamp"/>) da liberação do disco quase cheio: vale
    /// <see cref="OpcoesSaude.LiberacaoDisco"/> para qualquer abertura deste caixa, medida pelo relógio monotônico (acertar a
    /// hora do Windows não a estica); some ao fechar o app.
    /// </summary>
    private long? _discoLiberadoEm;

    public RegrasCaixa Regras { get; private set; } = RegrasCaixa.Padrao;

    /// <summary>Faixa do limite de gaveta da última apuração (PDV 20.4; a tela de venda mostra a cada segundo).</summary>
    public AvaliacaoGaveta Gaveta { get; private set; } = AvaliacaoGaveta.Normal;

    /// <summary>A liberação do disco quase cheio (1 h) ainda vale.</summary>
    public bool DiscoLiberado => _discoLiberadoEm is { } marca && _tempo.GetElapsedTime(marca) < _opcoesSaude.LiberacaoDisco;

    /// <summary>
    /// Disco abaixo do bloqueio sem a liberação de 1 h: o livre em bytes (nulo quando pode abrir). Sem como medir, não
    /// bloqueia (o caixa nunca para por falta de medida).
    /// </summary>
    public long? DiscoBloqueiaAbertura() =>
        !DiscoLiberado && disco?.LivreBytes() is { } livre && livre < _opcoesSaude.DiscoBloqueioBytes ? livre : null;

    /// <summary>
    /// O operador logado pode ver o dinheiro estimado (na sangria, na faixa da gaveta, no resumo da sessão aberta)? Só
    /// quando a regra do fechamento o deixaria ver o calculado (O3 do dono: ninguém, no fechamento cego sem conferência):
    /// o estimado é o esperado da linha Dinheiro do fechamento.
    /// </summary>
    public bool EstimadoVisivel => sessao.Operador is { } op && VeEstimado(op);

    private bool VeEstimado(Operador operador) => Regras.Fechamento.VeCalculadoNaContagem(operador.Tem(PermissoesPdv.VerCalculadoFechamento));

    /// <summary>Relê as chaves do caixa (antes do login seguir para a abertura ou a venda).</summary>
    public async Task CarregarRegrasAsync(CancellationToken ct = default)
    {
        if (sessao.Identidade is not { } identidade)
        {
            Regras = RegrasCaixa.Padrao;
            return;
        }

        var loja = identidade.LojaId;
        Regras = new RegrasCaixa(
            await configuracoes.ObterBoolAsync(ChavesConfiguracao.SolicitaAberturaCaixa, loja, ct),
            await configuracoes.ObterBoolAsync(ChavesConfiguracao.ImprimeSangriaAutomaticamente, loja, ct),
            new RegrasFechamento(
                await configuracoes.ObterBoolAsync(ChavesConfiguracao.FechamentoCego, loja, ct),
                await configuracoes.ObterDinheiroAsync(ChavesConfiguracao.ToleranciaDiferencaCaixa, loja, ChavesConfiguracao.ToleranciaPadrao, ct)
                ?? ChavesConfiguracao.ToleranciaPadrao,
                await configuracoes.ObterBoolAsync(ChavesConfiguracao.PermiteRecontagem, loja, ct),
                await configuracoes.ObterBoolAsync(ChavesConfiguracao.ImprimeCalculadoNoFechamento, loja, ct),
                await configuracoes.ObterBoolAsync(ChavesConfiguracao.FechamentoMostraConferencia, loja, ct)),
            await configuracoes.ObterInteiroAsync(ChavesConfiguracao.HorasAlertaSessao, loja, ChavesConfiguracao.HorasAlertaSessaoPadrao, ct),
            await configuracoes.ObterBoolAsync(ChavesConfiguracao.BloqueiaSessaoDiaAnterior, loja, ct),
            await configuracoes.ObterBoolAsync(ChavesConfiguracao.EmpresaAtiva, loja, ct),
            await LojaUsaPdvAsync(loja, ct),
            await configuracoes.ObterDinheiroAsync(ChavesConfiguracao.ValorLimiteSangria, loja, null, ct),
            await configuracoes.ObterBoolAsync(ChavesConfiguracao.SangriaLimitadaAoSaldo, loja, ct),
            await configuracoes.ObterTextoAsync(ChavesConfiguracao.ResumoDiarioModo, loja, ChavesConfiguracao.ResumoPorDias,
                [ChavesConfiguracao.ResumoPorDias, ChavesConfiguracao.ResumoPorHorario], ct));
    }

    /// <summary><c>lojas.usa_pdv</c> do espelho; sem a linha (carga ainda não feita, demonstração), não bloqueia.</summary>
    private async Task<bool> LojaUsaPdvAsync(Guid lojaId, CancellationToken ct)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.Lojas.AsNoTracking().Where(l => l.Id == lojaId && l.ExcluidoEm == null).Select(l => (bool?)l.UsaPdv).FirstOrDefaultAsync(ct) ?? true;
    }

    /// <summary>
    /// Depois do login (PDV 8.1): sessão do mesmo operador → venda; de outro → diálogo; sem sessão → abertura, ou a
    /// abertura automática com o fundo herdado (ou 0,00) quando <c>pdv.solicita_abertura_caixa</c> está desligada. Sem
    /// sessão, a empresa em implantação ou a loja sem PDV recusam já aqui (o login mostra a mensagem); a sessão já aberta
    /// segue até o fechamento.
    /// </summary>
    public async Task<ResultadoAposLogin> AposLoginAsync(CancellationToken ct = default)
    {
        var operador = Operador;
        // 20.4: a liberação de uma venda acima do limite é de quem a pediu, naquele momento; o login seguinte a descarta.
        _limiteLiberado = null;
        await CarregarRegrasAsync(ct);
        await sessao.CarregarSessaoCaixaAsync(caixa, ct);
        if (sessao.SessaoCaixa is { } aberta)
        {
            await AtualizarGavetaAsync(ct, recarregarRegras: false);
            return aberta.OperadorId == operador.Id
                ? new ResultadoAposLogin(SituacaoAposLogin.Vender, Sessao: aberta)
                : new ResultadoAposLogin(SituacaoAposLogin.SessaoDeOutro, Sessao: aberta, NomeOperadorSessao: await NomeUsuarioAsync(aberta.OperadorId, ct));
        }

        GarantirAberturaPermitida();
        var herdado = await caixa.TurnoHerdadoAsync(ct);
        if (Regras.SolicitaAbertura)
        {
            return new ResultadoAposLogin(SituacaoAposLogin.Abrir, herdado);
        }

        // Disco quase cheio (G4): a abertura automática vai para a tela de abertura, que pede o supervisor para liberar
        // por 1 h e então abre como a automática (o fundo herdado, sem pdv.caixa.abrir, sem a gaveta).
        if (DiscoBloqueiaAbertura() is not null)
        {
            return new ResultadoAposLogin(SituacaoAposLogin.Abrir, herdado, AberturaAutomatica: true);
        }

        await AbrirAsync(herdado?.ValorCaixa ?? 0m, null, null, herdado, liberacao: null, automatica: true, ct);
        return new ResultadoAposLogin(SituacaoAposLogin.Vender, herdado, sessao.SessaoCaixa);
    }

    /// <summary>
    /// <c>caixa.aberto</c> (8.2): sessão, movimento <c>abertura</c> (nenhum com fundo 0,00) e evento num commit; depois o
    /// comprovante (com <c>pdv.imprime_sangria_automaticamente</c>) e a gaveta. Devolve os avisos de hardware.
    /// </summary>
    public async Task<IReadOnlyList<string>> AbrirAsync(
        decimal fundo,
        string? observacao,
        IReadOnlyDictionary<decimal, int>? cedulas,
        TurnoHerdado? herdado,
        LiberacaoConcedida? liberacao,
        bool automatica = false,
        CancellationToken ct = default)
    {
        var operador = Operador;
        var identidade = sessao.Identidade ?? throw new InvalidOperationException("Terminal não ativado.");
        ExigirPermissao(operador, PermissoesPdv.AbrirCaixa, liberacao, automatica);
        GarantirForaDaConfirmacao();
        // PDV 8.1: relê as regras (o pull pode ter desligado a empresa ou o PDV da loja desde o login).
        await CarregarRegrasAsync(ct);
        GarantirAberturaPermitida();
        RegrasSessaoCaixa.ValidarFundo(fundo);
        // Spec 32.2 (G4): com o disco quase cheio, sessão nova só com a liberação de 1 h do supervisor.
        if (DiscoBloqueiaAbertura() is { } livre)
        {
            throw new DiscoCheioException(livre);
        }

        if (!await caixa.TipoAceitoAsync("caixa.aberto", FabricaEventosCaixa.VersaoSchema, ct))
        {
            throw new RegraNegocioException(GravadorOutbox.MensagemTipoNaoAnunciado("caixa.aberto", FabricaEventosCaixa.VersaoSchema));
        }

        var agora = relogio.Agora;
        var contexto = sessao.Contexto();
        var registro = new SessaoCaixaRegistro
        {
            Id = IdGerador.Novo(),
            LojaId = identidade.LojaId,
            CaixaId = identidade.CaixaId,
            NumeroCaixa = (short)identidade.NumeroCaixa,
            TerminalId = identidade.TerminalId,
            OperadorId = operador.Id,
            Status = StatusSessaoCaixa.Aberta,
            DiaOperacional = DiaOperacional.Calcular(agora, DiaOperacional.ObterFuso(contexto.FusoHorario), contexto.HoraCorteDiaOperacional),
            AbertaEm = agora,
            AberturaAutomatica = automatica,
            FundoTroco = fundo,
            SessaoAnteriorId = herdado?.SessaoAnteriorId,
            ValorRecebidoAnterior = herdado?.ValorCaixa,
            DiferencaRecebimento = RegrasSessaoCaixa.DiferencaRecebimento(fundo, herdado?.ValorCaixa),
        };
        var texto = string.IsNullOrWhiteSpace(observacao) ? null : observacao.Trim();
        var movimento = fundo == 0m ? null : NovoMovimento(registro, TipoMovimentoCaixa.Abertura, fundo, operador, agora, texto);
        var normalizadas = cedulas is null || cedulas.Count == 0 ? null : ContagemCedulas.Normalizar(cedulas);
        var evento = FabricaEventosCaixa.CaixaAberto(registro, movimento, normalizadas, IdGerador.Novo());
        var auditoria = new List<RegistroAuditoria>();
        if (liberacao is not null)
        {
            auditoria.Add(Liberacao(operador, liberacao, "sessoes_caixa", registro.Id, $"Abertura do caixa {identidade.NumeroCaixa:00} liberada"));
        }

        await caixa.AbrirAsync(registro, movimento, evento, ct, auditoria);
        sessao.DefinirSessaoCaixa(registro);
        _limiteLiberado = null;
        await AtualizarGavetaAsync(ct, recarregarRegras: false);
        log.LogInformation("Caixa aberto: sessão {Sessao}, fundo {Fundo}{Automatica}", registro.Id, fundo, automatica ? " (automática)" : string.Empty);

        var avisos = new List<string>();
        if (Regras.ImprimeComprovantes)
        {
            await ImprimirAsync("abertura_caixa", registro.Id, LayoutsCaixa.Abertura(Cabecalho(operador.Nome), registro, texto, impressao.Colunas), avisos, ct);
        }

        if (!automatica)
        {
            await AbrirGavetaAsync(avisos, ct);
        }

        await sincronizacao.AcordarAsync(ct);
        return avisos;
    }

    /// <summary>
    /// Passo 0 do fechamento (21.2): a sessão aberta, a apuração por forma (Dinheiro primeiro, depois as formas da loja e
    /// as que tiveram movimento) e o <see cref="FechamentoCego"/> com as regras da loja e a permissão de quem fecha. As
    /// recusas que o commit faria (venda em andamento, em pagamento ou suspensa da sessão, no banco; D22) vêm antes da
    /// contagem: o operador não conta a gaveta à toa.
    /// </summary>
    public async Task<FechamentoPreparado> PrepararFechamentoAsync(LiberacaoConcedida? liberacao = null, CancellationToken ct = default)
    {
        var operador = Operador;
        ExigirPermissao(operador, PermissoesPdv.FecharCaixa, liberacao, automatica: false);
        GarantirForaDaConfirmacao();
        await CarregarRegrasAsync(ct);
        await sessao.CarregarSessaoCaixaAsync(caixa, ct);
        var aberta = sessao.SessaoCaixa ?? throw new RegraNegocioException(RepositorioCaixa.MensagemSemSessao);
        var nomeOperadorSessao = await NomeUsuarioAsync(aberta.OperadorId, ct);
        if (await caixa.VendaPendenteAsync(aberta.Id, ct))
        {
            throw new RegraNegocioException(aberta.OperadorId == operador.Id
                ? RepositorioCaixa.MensagemVendaAberta
                : MensagemVendaAbertaDeOutro(nomeOperadorSessao));
        }

        var dados = await caixa.ApurarAsync(aberta.Id, ct);
        var oferecidas = (await catalogo.FormasPagamentoAsync(ct)).Select(f => new FormaCaixa(f.Id, f.Descricao, f.TipoForma)).ToList();
        // A forma Dinheiro desativada ou desvinculada no meio do turno não prende a sessão: vale a do espelho.
        var dinheiro = oferecidas.FirstOrDefault(ApuracaoCaixa.EhDinheiro)
                       ?? dados.Pagamentos.Select(p => p.Forma).FirstOrDefault(ApuracaoCaixa.EhDinheiro)
                       ?? (await catalogo.FormaDinheiroDoEspelhoAsync(ct) is { } doEspelho
                           ? new FormaCaixa(doEspelho.Id, doEspelho.Descricao, doEspelho.TipoForma)
                           : throw new RegraNegocioException(MensagemSemFormaDinheiro));
        var apuracao = ApuracaoCaixa.Calcular(aberta.FundoTroco, dados.Pagamentos, dados.Movimentos, dinheiro, oferecidas);
        var cego = new FechamentoCego(apuracao, Regras.Fechamento, operador.Tem(PermissoesPdv.VerCalculadoFechamento));
        return new FechamentoPreparado(aberta, dados, cego, nomeOperadorSessao);
    }

    /// <summary>
    /// Passo 3 (21.2): fechamento, formas, <c>sangria_fechamento</c> (só quando zera e há dinheiro contado), sessão
    /// <c>fechada</c>, evento <c>caixa.fechado</c> e o <c>logout</c> num commit; depois o relatório (21.4) e a gaveta. O
    /// operador sai: a tela volta ao login (o próximo operador da troca de turno entra por ele).
    /// </summary>
    /// <param name="sair">
    /// Falso na troca de turno pedida pelo próximo operador (8.1, opção 1): ele fechou a sessão do anterior e continua
    /// logado para abrir a dele (sem o <c>logout</c>). O <c>usuario_anterior_id</c> continua o dono da sessão; o
    /// <c>usuario_id</c> do envelope é quem contou e confirmou (SYNC 7.3: quem executou), e a nuvem audita por ele.
    /// </param>
    public async Task<ResultadoFechamentoCaixa> FecharAsync(
        FechamentoPreparado preparado, FechamentoConferido conferido, LiberacaoConcedida? liberacao, bool sair = true, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(preparado);
        ArgumentNullException.ThrowIfNull(conferido);
        var operador = Operador;
        ExigirPermissao(operador, PermissoesPdv.FecharCaixa, liberacao, automatica: false);
        GarantirForaDaConfirmacao();
        var identidade = sessao.Identidade ?? throw new InvalidOperationException("Terminal não ativado.");
        var aberta = preparado.Sessao;
        var agora = relogio.Agora;
        var contexto = sessao.Contexto();
        var ultimaSequencia = await caixa.UltimaSequenciaEventoAsync(ct);
        var fechamento = new FechamentoCaixaRegistro
        {
            Id = IdGerador.Novo(),
            SessaoCaixaId = aberta.Id,
            LojaId = aberta.LojaId,
            CaixaId = aberta.CaixaId,
            TerminalId = aberta.TerminalId,
            NumeroCaixa = aberta.NumeroCaixa,
            Tipo = conferido.ZeraCaixa ? "fechamento" : "troca_turno",
            ZeraCaixa = conferido.ZeraCaixa,
            UsuarioAnteriorId = aberta.OperadorId,
            ValorCaixa = conferido.ValorCaixa,
            TotalCalculado = conferido.TotalCalculado,
            TotalDigitado = conferido.TotalDigitado,
            Justificativa = conferido.Justificativa,
            Recontagem = conferido.Recontagem,
            FechamentoCego = conferido.FechamentoCego,
            OcorridoEm = agora,
            // MD 3.12.3: o dia operacional do próprio fechamento (`ocorrido_em` pela regra 1.2, com a hora de corte da loja).
            DiaOperacional = DiaOperacional.Calcular(agora, DiaOperacional.ObterFuso(contexto.FusoHorario), contexto.HoraCorteDiaOperacional),
            Resumo = Resumo(preparado.Dados.Resumo, ultimaSequencia),
        };
        var formas = conferido.Formas.Select(f => new FechamentoCaixaFormaRegistro
        {
            Id = IdGerador.Novo(),
            FechamentoId = fechamento.Id,
            FormaPagamentoId = f.Apurada.Forma.Id,
            DescricaoForma = f.Apurada.Forma.Descricao,
            TipoForma = f.Apurada.Forma.TipoForma,
            ValorCalculado = f.Apurada.Calculado,
            ValorDigitado = f.Digitado,
            QuantidadePagamentos = f.Apurada.QuantidadePagamentos,
            PreenchidoAutomatico = false,
            ValorPrimeiraContagem = f.PrimeiraContagem,
        }).ToList();
        MovimentoCaixaRegistro? sangria = null;
        if (conferido.ZeraCaixa && conferido.DinheiroDigitado > 0m)
        {
            sangria = NovoMovimento(aberta, TipoMovimentoCaixa.SangriaFechamento, conferido.DinheiroDigitado, operador, agora, "Fechamento");
            sangria.QuemRetiraUsuarioId = operador.Id;
            sangria.QuemRetiraNome = RegrasMovimentoCaixa.NomeDoUsuario(operador.Nome);
        }

        var evento = FabricaEventosCaixa.CaixaFechado(fechamento, formas, sangria, agora, IdGerador.Novo(), executadoPorId: operador.Id);
        var auditoria = new List<RegistroAuditoria>();
        if (liberacao is not null)
        {
            auditoria.Add(Liberacao(operador, liberacao, "fechamentos_caixa", fechamento.Id, $"Fechamento do caixa {identidade.NumeroCaixa:00} liberado"));
        }

        if (sair)
        {
            auditoria.Add(new RegistroAuditoria("logout", operador.Id, Descricao: $"Logout de {operador.Nome} depois do fechamento do caixa", Localizacao: "pdv.caixa"));
        }
        await caixa.FecharAsync(fechamento, formas, sangria, agora, evento, ct, auditoria);
        sessao.DefinirSessaoCaixa(null);
        Gaveta = AvaliacaoGaveta.Normal;
        _limiteLiberado = null;
        log.LogInformation("Caixa fechado ({Tipo}): sessão {Sessao}, contado {Contado}", fechamento.Tipo, aberta.Id, conferido.TotalDigitado);

        var avisos = new List<string>();
        var bytes = LayoutsCaixa.Fechamento(Cabecalho(preparado.NomeOperadorSessao), aberta, fechamento, conferido,
            preparado.Fechamento.ImprimeCalculado, preparado.Dados, impressao.Colunas);
        var relatorio = await ImprimirAsync("fechamento_caixa", fechamento.Id, bytes, avisos, ct);
        await AbrirGavetaAsync(avisos, ct);
        if (sair)
        {
            sessao.Operador = null;
        }

        await sincronizacao.AcordarAsync(ct);
        // PDV 32.5: backup a cada fechamento de caixa (em segundo plano; falha só no log).
        backupLocal?.AgendarAposFechamento();
        return new ResultadoFechamentoCaixa(fechamento, relatorio, avisos);
    }

    /// <summary>"Operar no caixa de FULANO" (8.1, 7.4): exige <c>pdv.caixa.operar_de_outro</c> ou a liberação; auditado.</summary>
    public async Task OperarDeOutroAsync(LiberacaoConcedida? liberacao, CancellationToken ct = default)
    {
        var operador = Operador;
        ExigirPermissao(operador, PermissoesPdv.OperarDeOutro, liberacao, automatica: false);
        var aberta = sessao.SessaoCaixa ?? throw new RegraNegocioException(RepositorioCaixa.MensagemSemSessao);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        // Ação só local (fica no caixa); a liberação do supervisor também sobe no lote de auditoria.
        db.LogAuditoriaLocal.Add(Auditoria(operador.Id, liberacao?.Supervisor.Id, aberta.Id, "caixa_operar_de_outro",
            $"{operador.Nome} opera o caixa aberto por {await NomeUsuarioAsync(aberta.OperadorId, ct)}", null));
        if (liberacao is not null)
        {
            db.LogAuditoriaLocal.Add(Auditoria(operador.Id, liberacao.Supervisor.Id, aberta.Id, "liberacao",
                $"Operar no caixa de outro operador liberado por {liberacao.Supervisor.Nome}", liberacao.Motivo));
        }

        await db.SaveChangesAsync(ct);
    }

    /// <summary>Situação da sessão aberta para a tela de venda (8.1): alerta de sessão antiga ou bloqueio da venda nova.</summary>
    public AvaliacaoSessao AvaliarSessao()
    {
        if (sessao.SessaoCaixa is not { } aberta || sessao.Identidade is null)
        {
            return new AvaliacaoSessao(SituacaoSessao.Normal, null);
        }

        var contexto = sessao.Contexto();
        return RegrasSessaoCaixa.Avaliar(aberta.AbertaEm, aberta.DiaOperacional, relogio.Agora, DiaOperacional.ObterFuso(contexto.FusoHorario),
            contexto.HoraCorteDiaOperacional, Regras.HorasAlertaSessao, Regras.BloqueiaSessaoDiaAnterior);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Sangria, reforço, movimentos, limite de gaveta, devolução de cascos e resumo diário (Fase 1C, bloco C10b; PDV 20,
    // 10.12, 21.6). Mesma ordem dos fatos do C10a: permissão (ou liberação), D22, sessão aberta, tipo anunciado pela
    // nuvem (T13), o fato e o evento num commit; depois o comprovante e a gaveta.
    // ---------------------------------------------------------------------------------------------------------------

    /// <summary>
    /// Reapura o dinheiro estimado da sessão aberta e a faixa do limite (20.4). Chamada depois de abrir, de cada venda
    /// finalizada, de cada movimento e antes de cada venda nova; relê as chaves (o pull pode ter mudado o limite no meio
    /// do turno). Sem sessão, a faixa é a normal. Fora do vermelho, a liberação de uma venda guardada cai: ela era para
    /// a venda recusada naquele bloqueio, não para o próximo.
    /// </summary>
    public async Task<AvaliacaoGaveta> AtualizarGavetaAsync(CancellationToken ct = default, bool recarregarRegras = true)
    {
        if (sessao.SessaoCaixa is not { } aberta || sessao.Identidade is null)
        {
            Gaveta = AvaliacaoGaveta.Normal;
            _limiteLiberado = null;
            return Gaveta;
        }

        if (recarregarRegras)
        {
            await CarregarRegrasAsync(ct);
        }

        var dinheiro = await caixa.DinheiroGavetaAsync(aberta.Id, ct) ?? 0m;
        Gaveta = LimiteGaveta.Avaliar(dinheiro, Regras.ValorLimiteSangria, EstimadoVisivel);
        if (Gaveta.Faixa != FaixaGaveta.Bloqueio)
        {
            _limiteLiberado = null;
        }

        return Gaveta;
    }

    /// <summary>
    /// Nova venda com a gaveta no limite (20.4): recusada, salvo com <c>pdv.caixa.ignorar_limite_sangria</c> do operador ou
    /// com a liberação de uma venda pelo supervisor (<see cref="LiberarLimiteGavetaAsync"/>), que esta chamada consome.
    /// </summary>
    public async Task GarantirLimiteParaNovaVendaAsync(CancellationToken ct = default)
    {
        if ((await AtualizarGavetaAsync(ct)).Faixa != FaixaGaveta.Bloqueio || Operador.Tem(PermissoesPdv.IgnorarLimiteSangria))
        {
            return;
        }

        if (_limiteLiberado is { } liberada && liberada.Sessao == sessao.SessaoCaixa?.Id && liberada.Operador == Operador.Id)
        {
            _limiteLiberado = null;
            return;
        }

        throw new LimiteGavetaAtingidoException(LimiteGaveta.MensagemBloqueioVenda);
    }

    /// <summary>
    /// Liberação temporária do limite de gaveta (20.4): uma venda — a próxima deste operador, com a gaveta ainda no
    /// vermelho (<c>_limiteLiberado</c>) —, auditada (<c>liberacao</c>, que sobe no lote, com o supervisor e o motivo).
    /// </summary>
    public async Task LiberarLimiteGavetaAsync(LiberacaoConcedida liberacao, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(liberacao);
        var operador = Operador;
        GarantirForaDaConfirmacao();
        var aberta = sessao.SessaoCaixa ?? throw new RegraNegocioException(RepositorioCaixa.MensagemSemSessao);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        db.LogAuditoriaLocal.Add(Auditoria(operador.Id, liberacao.Supervisor.Id, aberta.Id, "liberacao",
            $"Venda acima do limite de dinheiro na gaveta liberada por {liberacao.Supervisor.Nome}", liberacao.Motivo));
        await db.SaveChangesAsync(ct);
        _limiteLiberado = (aberta.Id, operador.Id);
    }

    /// <summary>Motivo da <c>liberacao</c> do disco pelo próprio supervisor logado (o motivo é obrigatório, PDV 31.3).</summary>
    public const string MotivoDiscoProprioSupervisor = "Disco quase cheio: abertura liberada pelo próprio supervisor logado";

    /// <summary>
    /// Libera a abertura do caixa com o disco quase cheio por <see cref="OpcoesSaude.LiberacaoDisco"/> (Central do PDV,
    /// bloco G4; spec 32.2): o supervisor (<c>pdv.supervisor</c>, PIN e motivo na hora, 31.3) ou, sem
    /// <paramref name="liberacao"/>, o próprio operador logado que é supervisor (com o motivo fixo
    /// <see cref="MotivoDiscoProprioSupervisor"/>). Auditado <c>liberacao</c> (sobe no lote) com o livre e a validade no
    /// <c>depois</c>; na D22 nada é gravado e nada é liberado.
    /// </summary>
    public async Task LiberarDiscoAsync(LiberacaoConcedida? liberacao, CancellationToken ct = default)
    {
        var operador = Operador;
        if (liberacao is null && !operador.Tem(PermissoesPdv.Supervisor))
        {
            throw new RegraNegocioException(MensagemSemPermissao);
        }

        GarantirForaDaConfirmacao();
        var autorizador = liberacao?.Supervisor ?? operador;
        var livre = disco?.LivreBytes();
        var depois = new JsonObject
        {
            ["livre_mb"] = livre is { } l ? l / 1024 / 1024 : null,
            ["validade_min"] = (int)_opcoesSaude.LiberacaoDisco.TotalMinutes,
        }.ToJsonString();
        await using var db = await fabrica.CreateDbContextAsync(ct);
        db.LogAuditoriaLocal.Add(Auditoria(operador.Id, autorizador.Id, null, "liberacao",
            $"Abertura do caixa com o disco quase cheio liberada por {(int)_opcoesSaude.LiberacaoDisco.TotalHours} h por {autorizador.Nome}",
            liberacao?.Motivo ?? MotivoDiscoProprioSupervisor, depois));
        await db.SaveChangesAsync(ct);
        _discoLiberadoEm = _tempo.GetTimestamp();
        // O id, nunca o nome (dado pessoal; o log de texto vai no pacote de suporte): o nome fica na auditoria.
        log.LogWarning("Abertura do caixa com o disco quase cheio ({Livre} bytes livres) liberada pelo supervisor {Supervisor}", livre, autorizador.Id);
    }

    /// <summary>
    /// Antes de abrir a sangria ou o reforço (F11 › 1/2): D22, sessão aberta e o tipo anunciado pela nuvem (T13: a
    /// função nem abre), mais o dinheiro estimado (mostrado só quando <see cref="EstimadoVisivel"/>).
    /// </summary>
    public async Task<PreparoMovimento> PrepararMovimentoAsync(string tipo, CancellationToken ct = default)
    {
        GarantirForaDaConfirmacao();
        await CarregarRegrasAsync(ct);
        var aberta = sessao.SessaoCaixa ?? throw new RegraNegocioException(RepositorioCaixa.MensagemSemSessao);
        await GarantirTipoAceitoAsync(TipoEvento(tipo), ct);
        return new PreparoMovimento(await caixa.DinheiroGavetaAsync(aberta.Id, ct) ?? 0m, EstimadoVisivel);
    }

    /// <summary>
    /// <c>caixa.sangria</c>/<c>caixa.reforco</c> (20.1–20.2, SYNC 9.4): valor &gt; 0; na sangria, quem retira é
    /// obrigatório (usuário do F2 ou o nome) e o valor não passa do estimado com <c>pdv.sangria_limitada_ao_saldo</c>
    /// (O5 do dono: ligada); no reforço, quem entrega é opcional. O operador faz sozinho (as permissões estão no perfil);
    /// sem elas, a liberação vira o <c>autorizado_por_id</c> do movimento e a auditoria <c>liberacao</c> do mesmo commit.
    /// Depois: o comprovante (2 vias na sangria, com <c>pdv.imprime_sangria_automaticamente</c>), a gaveta e a faixa.
    /// </summary>
    public async Task<ResultadoMovimentoCaixa> RegistrarMovimentoAsync(DadosMovimentoCaixa dados, LiberacaoConcedida? liberacao, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(dados);
        var sangria = dados.Tipo == TipoMovimentoCaixa.Sangria;
        if (!sangria && dados.Tipo != TipoMovimentoCaixa.Reforco)
        {
            throw new ArgumentException("Só sangria e reforço.", nameof(dados));
        }

        var operador = Operador;
        ExigirPermissao(operador, sangria ? PermissoesPdv.Sangria : PermissoesPdv.Reforco, liberacao, automatica: false);
        var preparo = await PrepararMovimentoAsync(dados.Tipo, ct);
        var aberta = sessao.SessaoCaixa!;
        var valor = RegrasMovimentoCaixa.ValidarValor(dados.Valor);
        var nome = RegrasMovimentoCaixa.QuemRetira(dados.QuemRetiraNome, dados.QuemRetiraUsuarioId, obrigatorio: sangria);
        if (dados.QuemRetiraUsuarioId is { } usuarioId && nome is null)
        {
            nome = RegrasMovimentoCaixa.NomeDoUsuario(await NomeUsuarioAsync(usuarioId, ct));
        }

        var observacao = RegrasMovimentoCaixa.TextoOpcional(dados.Observacao, "Observação");
        var infAdicionais = RegrasMovimentoCaixa.TextoOpcional(dados.InfAdicionais, "Inf. adicionais");
        var avisos = new List<string>();
        if (sangria && await ValidarSangriaAsync(operador, aberta, valor, preparo, ct) is { } aviso)
        {
            avisos.Add(aviso);
        }

        var agora = relogio.Agora;
        var movimento = NovoMovimento(aberta, dados.Tipo, valor, operador, agora, observacao);
        movimento.QuemRetiraUsuarioId = dados.QuemRetiraUsuarioId;
        movimento.QuemRetiraNome = nome;
        movimento.InfAdicionais = infAdicionais;
        movimento.AutorizadoPorId = liberacao?.Supervisor.Id;
        var cedulas = dados.Cedulas is null || dados.Cedulas.Count == 0 ? null : ContagemCedulas.Normalizar(dados.Cedulas);
        var evento = sangria
            ? FabricaEventosCaixa.CaixaSangria(movimento, preparo.DinheiroEstimado, cedulas, IdGerador.Novo())
            : FabricaEventosCaixa.CaixaReforco(movimento, preparo.DinheiroEstimado, cedulas, IdGerador.Novo());
        List<RegistroAuditoria> auditoria = liberacao is null
            ? []
            : [Liberacao(operador, liberacao, "movimentos_caixa", movimento.Id, $"{(sangria ? "Sangria" : "Reforço")} de R$ {NumeroBr.Dinheiro(valor)} liberado(a)")];
        await caixa.RegistrarMovimentoAsync(movimento, evento, ct, auditoria);
        log.LogInformation("{Tipo} de {Valor} na sessão {Sessao}", dados.Tipo, valor, aberta.Id);

        string? relatorio = null;
        if (Regras.ImprimeComprovantes)
        {
            var vias = sangria ? 2 : 1;
            relatorio = await ImprimirAsync(sangria ? "sangria" : "reforco", movimento.Id,
                LayoutsCaixa.Movimento(Cabecalho(operador.Nome), movimento, vias, impressao.Colunas), avisos, ct, vias);
        }

        await AbrirGavetaAsync(avisos, ct);
        await AtualizarGavetaAsync(ct);
        await sincronizacao.AcordarAsync(ct);
        return new ResultadoMovimentoCaixa(movimento, relatorio, avisos);
    }

    /// <summary>
    /// Sangria acima do estimado (20.1, O5 do dono). A recusa grava a auditoria <c>sangria_recusada</c> (valor tentado e
    /// estimado no <c>depois</c>; sobe no lote e o gerente vê no ERP) antes de devolver a mensagem: com o estimado oculto
    /// (O3), a própria recusa conta ao operador que o valor passou do esperado, e as tentativas repetidas para achá-lo
    /// ficam à vista de quem confere o caixa.
    /// </summary>
    private async Task<string?> ValidarSangriaAsync(Operador operador, SessaoCaixaRegistro aberta, decimal valor, PreparoMovimento preparo, CancellationToken ct)
    {
        try
        {
            return RegrasMovimentoCaixa.ValidarSangria(valor, preparo.DinheiroEstimado, Regras.SangriaLimitadaAoSaldo, preparo.MostraEstimado);
        }
        catch (RegraNegocioException)
        {
            await using var db = await fabrica.CreateDbContextAsync(ct);
            var depois = new JsonObject
            {
                ["valor_tentado"] = FormatoProtocolo.Dinheiro(valor),
                ["dinheiro_estimado"] = FormatoProtocolo.Dinheiro(preparo.DinheiroEstimado),
            };
            db.LogAuditoriaLocal.Add(Auditoria(operador.Id, null, aberta.Id, AcaoSangriaRecusada,
                $"Sangria de R$ {NumeroBr.Dinheiro(valor)} recusada: acima do dinheiro estimado na gaveta", null, depois.ToJsonString()));
            await db.SaveChangesAsync(ct);
            log.LogInformation("Sangria de {Valor} recusada na sessão {Sessao}: acima do estimado", valor, aberta.Id);
            throw;
        }
    }

    /// <summary>Movimentos da sessão aberta (F12 Movimentos, 20.3), do mais antigo ao mais novo.</summary>
    public async Task<IReadOnlyList<MovimentoCaixaRegistro>> MovimentosAsync(CancellationToken ct = default)
    {
        var aberta = sessao.SessaoCaixa ?? throw new RegraNegocioException(RepositorioCaixa.MensagemSemSessao);
        return await caixa.MovimentosDaSessaoAsync(aberta.Id, ct);
    }

    /// <summary>
    /// <c>caixa.movimento_cancelado</c> (20.3, SYNC 9.5): só sangria e reforço da sessão aberta, com motivo; exige
    /// <c>pdv.caixa.cancelar_movimento</c> (O5 do dono: cancelar pede o supervisor — a permissão não está no perfil do
    /// operador), e o supervisor que liberou vira o <c>autorizado_cancelamento_por_id</c>.
    /// </summary>
    public async Task<MovimentoCaixaRegistro> CancelarMovimentoAsync(Guid movimentoId, string? motivo, LiberacaoConcedida? liberacao, CancellationToken ct = default)
    {
        var operador = Operador;
        ExigirPermissao(operador, PermissoesPdv.CancelarMovimento, liberacao, automatica: false);
        GarantirForaDaConfirmacao();
        var texto = RegrasMovimentoCaixa.MotivoCancelamento(motivo);
        var movimento = (await MovimentosAsync(ct)).FirstOrDefault(m => m.Id == movimentoId)
                        ?? throw new RegraNegocioException("Movimento não encontrado na sessão aberta.");
        if (!TipoMovimentoCaixa.Cancelaveis.Contains(movimento.Tipo))
        {
            throw new RegraNegocioException(RepositorioCaixa.MensagemMovimentoNaoCancelavel);
        }

        if (movimento.Cancelado)
        {
            throw new RegraNegocioException("Este movimento já foi cancelado.");
        }

        await GarantirTipoAceitoAsync("caixa.movimento_cancelado", ct);
        movimento.Cancelado = true;
        movimento.CanceladoEm = relogio.Agora;
        movimento.CanceladoPorId = operador.Id;
        movimento.AutorizadoCancelamentoPorId = liberacao?.Supervisor.Id;
        movimento.MotivoCancelamento = texto;
        var evento = FabricaEventosCaixa.CaixaMovimentoCancelado(movimento, IdGerador.Novo());
        List<RegistroAuditoria> auditoria = liberacao is null
            ? []
            : [Liberacao(operador, liberacao, "movimentos_caixa", movimento.Id,
                $"Cancelamento de {(movimento.Tipo == TipoMovimentoCaixa.Sangria ? "sangria" : "reforço")} de R$ {NumeroBr.Dinheiro(movimento.Valor)} liberado")];
        await caixa.CancelarMovimentoAsync(movimento, evento, ct, auditoria);
        log.LogInformation("Movimento {Movimento} ({Tipo}) cancelado", movimento.Id, movimento.Tipo);
        await AtualizarGavetaAsync(ct);
        await sincronizacao.AcordarAsync(ct);
        return movimento;
    }

    /// <summary>
    /// "Quem retira" pelo F2 (20.1): usuários ativos do espelho com acesso à loja do terminal, por nome, login ou código.
    /// No terminal de demonstração, os operadores simulados.
    /// </summary>
    public async Task<IReadOnlyList<UsuarioRetirada>> BuscarUsuariosAsync(string? texto, CancellationToken ct = default)
    {
        var filtro = (texto ?? string.Empty).Trim();
        var loja = sessao.Identidade?.LojaId;
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var usuarios = await db.Usuarios.AsNoTracking()
            .Where(u => u.ExcluidoEm == null && u.Ativo && !u.Totem
                        && (u.Master || db.UsuariosLojas.Any(l => l.UsuarioId == u.Id && l.LojaId == loja && l.ExcluidoEm == null)))
            .Select(u => new UsuarioRetirada(u.Id, u.Codigo, u.Nome))
            .ToListAsync(ct);
#if MODO_DEMONSTRACAO
        if (usuarios.Count == 0 && sessao.Identidade is { Demonstracao: true })
        {
            usuarios = [.. AutenticadorOperadorSimulado.Operadores.Select(o => new UsuarioRetirada(o.Id, o.Codigo, o.Nome))];
        }
#endif
        return usuarios
            .Where(u => filtro.Length == 0 || u.Nome.Contains(filtro, StringComparison.OrdinalIgnoreCase)
                        || u.Codigo.ToString(System.Globalization.CultureInfo.InvariantCulture) == filtro)
            .OrderBy(u => u.Nome, StringComparer.Ordinal)
            .Take(50)
            .ToList();
    }

    /// <summary>Cascos vazios do espelho para a devolução avulsa (F11 › V).</summary>
    public Task<IReadOnlyList<ProdutoRegistro>> VasilhamesAsync(CancellationToken ct = default) => catalogo.VasilhamesAsync(ct);

    /// <summary>
    /// Devolução avulsa de cascos, destino "só a entrada" do F11 › V (10.12; O14 do dono): <c>movimentos_vasilhame</c>
    /// com destino <c>entrada</c> e o <c>vasilhame.movimentado</c> num commit; a nuvem gera o <c>VASILHAME_DEVOLVIDO</c>
    /// no tipo <c>vasilhame_vazio</c> da loja. Sem dinheiro: a gaveta não abre e nada sai no comprovante. O desconto na
    /// venda atual pelo valor do casco, o outro destino do mesmo diálogo, é o <see cref="ServicoVenda.DescontarCascosAsync"/>
    /// (C11c, README › decisão 56).
    /// </summary>
    public async Task<MovimentoVasilhameRegistro> DevolverVasilhamesAsync(Guid produtoVasilhameId, decimal quantidade, CancellationToken ct = default)
    {
        var operador = Operador;
        GarantirForaDaConfirmacao();
        var aberta = sessao.SessaoCaixa ?? throw new RegraNegocioException(RepositorioCaixa.MensagemSemSessao);
        if (quantidade is < 1m or > 9_999m || decimal.Truncate(quantidade) != quantidade)
        {
            throw new RegraNegocioException(MensagemQuantidadeCascos);
        }

        if ((await VasilhamesAsync(ct)).All(v => v.Id != produtoVasilhameId))
        {
            throw new RegraNegocioException(MensagemVasilhameInvalido);
        }

        await GarantirTipoAceitoAsync("vasilhame.movimentado", ct);
        var movimento = new MovimentoVasilhameRegistro
        {
            Id = IdGerador.Novo(),
            SessaoCaixaId = aberta.Id,
            LojaId = aberta.LojaId,
            CaixaId = aberta.CaixaId,
            TerminalId = aberta.TerminalId,
            OperadorId = operador.Id,
            ProdutoVasilhameId = produtoVasilhameId,
            Quantidade = quantidade,
            Destino = "entrada",
            OcorridoEm = relogio.Agora,
        };
        await caixa.RegistrarVasilhameAsync(movimento, FabricaEventosCaixa.VasilhameMovimentado(movimento, IdGerador.Novo()), ct);
        log.LogInformation("Devolução avulsa de {Quantidade} casco(s) {Produto}", quantidade, produtoVasilhameId);
        await sincronizacao.AcordarAsync(ct);
        return movimento;
    }

    /// <summary>Fuso, hora de corte e dia operacional de agora (padrão do filtro do resumo diário, 21.6).</summary>
    public (TimeZoneInfo Fuso, TimeOnly HoraCorte, DateOnly Hoje) DiaOperacionalAtual()
    {
        var contexto = sessao.Contexto();
        var fuso = DiaOperacional.ObterFuso(contexto.FusoHorario);
        return (fuso, contexto.HoraCorteDiaOperacional, DiaOperacional.Calcular(relogio.Agora, fuso, contexto.HoraCorteDiaOperacional));
    }

    /// <summary>
    /// Resumo diário / leitura do caixa (F11 › 6, 21.6): dados locais deste terminal no período. Com o estimado oculto
    /// (O3), sai só com as quantidades de vendas, formas, sangrias e reforços, sem os valores — em todas as sessões, a
    /// aberta e as fechadas: as vendas por forma de uma sessão, com o fundo e as sangrias, são o esperado e a diferença
    /// que só o gerente vê, no ERP (padrão até a confirmação do dono, O26). <paramref name="imprimir"/> manda à
    /// impressora (Ctrl+P na tela). Sem a permissão, a liberação do supervisor vale para o diálogo e fica na auditoria
    /// <c>liberacao</c> uma vez, na primeira consulta. <paramref name="quem"/>: quem pede, quando não é o operador logado
    /// (a Central do PDV › 2 Caixas, aberta também pelo login; bloco G6): a permissão, o estimado (O3) e o cabeçalho são
    /// dele.
    /// </summary>
    public async Task<ResultadoResumoDiario> ResumoDiarioAsync(
        PeriodoResumo periodo, bool imprimir, LiberacaoConcedida? liberacao = null, Operador? quem = null, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(periodo);
        var operador = quem ?? Operador;
        ExigirPermissao(operador, PermissoesPdv.ResumoDiario, liberacao, automatica: false);
        await CarregarRegrasAsync(ct);
        var resumo = await caixa.ResumoDiarioAsync(periodo, valoresOcultos: !VeEstimado(operador), ct);
        if (liberacao is not null && !ReferenceEquals(liberacao, _liberacaoResumoAuditada))
        {
            await using var db = await fabrica.CreateDbContextAsync(ct);
            db.LogAuditoriaLocal.Add(Auditoria(operador.Id, liberacao.Supervisor.Id, sessao.SessaoCaixa?.Id, "liberacao",
                $"Resumo diário ({periodo.Descricao}) liberado por {liberacao.Supervisor.Nome}", liberacao.Motivo));
            await db.SaveChangesAsync(ct);
            _liberacaoResumoAuditada = liberacao;
        }

        var bytes = LayoutsCaixa.ResumoDiario(Cabecalho(operador.Nome), resumo, impressao.Colunas);
        var avisos = new List<string>();
        var texto = imprimir
            ? await ImprimirAsync("resumo_diario", null, bytes, avisos, ct)
            : impressao.Texto(bytes);
        return new ResultadoResumoDiario(resumo, texto ?? string.Empty, avisos);
    }

    private static string TipoEvento(string tipoMovimento) => tipoMovimento == TipoMovimentoCaixa.Sangria ? "caixa.sangria" : "caixa.reforco";

    /// <summary>T13: o tipo que a nuvem não anunciou nem começa (o gravador recusaria no commit de qualquer modo).</summary>
    private async Task GarantirTipoAceitoAsync(string tipo, CancellationToken ct)
    {
        if (!await caixa.TipoAceitoAsync(tipo, FabricaEventosCaixa.VersaoSchema, ct))
        {
            throw new RegraNegocioException(GravadorOutbox.MensagemTipoNaoAnunciado(tipo, FabricaEventosCaixa.VersaoSchema));
        }
    }

    /// <summary>Nome de um usuário do espelho (ou dos operadores de demonstração); "outro operador" sem a linha.</summary>
    public async Task<string> NomeUsuarioAsync(Guid usuarioId, CancellationToken ct = default)
    {
        if (sessao.Operador is { } logado && logado.Id == usuarioId)
        {
            return logado.Nome;
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        var nome = await db.Usuarios.AsNoTracking().Where(u => u.Id == usuarioId).Select(u => u.Nome).FirstOrDefaultAsync(ct);
#if MODO_DEMONSTRACAO
        nome ??= AutenticadorOperadorSimulado.NomeDe(usuarioId);
#endif
        return nome ?? "outro operador";
    }

    private Operador Operador => sessao.Operador ?? throw new InvalidOperationException("Nenhum operador logado.");

    /// <summary>Sem a permissão e sem a liberação do supervisor (31.3), a operação não começa.</summary>
    private static void ExigirPermissao(Operador operador, string permissao, LiberacaoConcedida? liberacao, bool automatica)
    {
        // A abertura automática do login (8.1, chave desligada) não é um ato do operador: não pede a permissão.
        if (!automatica && !operador.Tem(permissao) && liberacao is null)
        {
            throw new RegraNegocioException(MensagemSemPermissao);
        }
    }

    /// <summary>PDV 8.1: empresa em implantação (<c>geral.ativa</c>) ou loja sem PDV (<c>lojas.usa_pdv</c>) não abrem sessão.</summary>
    private void GarantirAberturaPermitida()
    {
        if (!Regras.EmpresaAtiva)
        {
            throw new RegraNegocioException(MensagemEmpresaEmImplantacao);
        }

        if (!Regras.LojaUsaPdv)
        {
            throw new RegraNegocioException(MensagemLojaSemPdv);
        }
    }

    /// <summary>D22: durante a confirmação da desativação nada que sobe é gravado; avisa antes de o banco recusar.</summary>
    private void GarantirForaDaConfirmacao()
    {
        if (sincronizacao.Situacao.ConfirmandoDesativacao)
        {
            throw new RegraNegocioException(MensagemConfirmandoDesativacao);
        }
    }

    private MovimentoCaixaRegistro NovoMovimento(SessaoCaixaRegistro s, string tipo, decimal valor, Operador operador, DateTimeOffset agora, string? observacao) => new()
    {
        Id = IdGerador.Novo(),
        SessaoCaixaId = s.Id,
        LojaId = s.LojaId,
        CaixaId = s.CaixaId,
        NumeroCaixa = s.NumeroCaixa,
        TerminalId = s.TerminalId,
        Tipo = tipo,
        Valor = valor,
        OperadorId = operador.Id,
        Observacao = observacao,
        OcorridoEm = agora,
    };

    private static RegistroAuditoria Liberacao(Operador operador, LiberacaoConcedida liberacao, string entidade, Guid registroId, string descricao) =>
        new("liberacao", operador.Id, entidade, registroId, $"{descricao} por {liberacao.Supervisor.Nome}", liberacao.Supervisor.Id, "pdv.caixa",
            liberacao.Motivo);

    private LogAuditoriaLocal Auditoria(
        Guid usuarioId, Guid? autorizadoPorId, Guid? sessaoCaixaId, string acao, string descricao, string? motivo, string? depois = null) => new()
        {
            Id = IdGerador.Novo(),
            OcorridoEm = relogio.Agora,
            UsuarioId = usuarioId,
            AutorizadoPorId = autorizadoPorId,
            SessaoCaixaId = sessaoCaixaId,
            Acao = acao,
            Entidade = "sessoes_caixa",
            RegistroId = sessaoCaixaId,
            Localizacao = "pdv.caixa",
            Descricao = descricao,
            Motivo = motivo,
            Depois = depois,
        };

    /// <summary><c>fechamentos_caixa.resumo</c> (SYNC 9.6), com as chaves da fixture; troca, vale e NFC-e ainda não existem.</summary>
    private static string Resumo(ResumoTurno r, long ultimaSequencia) => new JsonObject
    {
        ["qtd_vendas"] = r.QtdVendas,
        ["total_vendas"] = FormatoProtocolo.Dinheiro(r.TotalVendas),
        ["ticket_medio"] = FormatoProtocolo.Dinheiro(r.TicketMedio),
        ["qtd_canceladas"] = r.QtdCanceladas,
        ["total_canceladas"] = FormatoProtocolo.Dinheiro(r.TotalCanceladas),
        ["qtd_itens_cancelados"] = r.QtdItensCancelados,
        ["total_itens_cancelados"] = FormatoProtocolo.Dinheiro(r.TotalItensCancelados),
        ["total_descontos"] = FormatoProtocolo.Dinheiro(r.TotalDescontos),
        ["qtd_liberacoes"] = r.QtdLiberacoes,
        ["qtd_trocas"] = 0,
        ["total_vales_emitidos"] = FormatoProtocolo.Dinheiro(0m),
        ["nfce_emitidas"] = 0,
        ["nfce_contingencia"] = 0,
        ["nfce_pendentes"] = 0,
        ["ultima_sequencia_evento"] = ultimaSequencia,
    }.ToJsonString();

    private CabecalhoCaixa Cabecalho(string operador) =>
        new(sessao.NomeLoja, (short)(sessao.Identidade?.NumeroCaixa ?? 0), operador, DiaOperacional.ObterFuso(sessao.FusoHorario));

    private async Task<string?> ImprimirAsync(string tipo, Guid? referencia, byte[] conteudo, List<string> avisos, CancellationToken ct, int vias = 1)
    {
        if (await impressao.ImprimirAsync(tipo, referencia, conteudo, e => $"Comprovante não impresso ({e}) — ficou na fila para reimpressão.", vias, ct) is { } aviso)
        {
            avisos.Add(aviso);
        }

        return impressao.Texto(conteudo);
    }

    /// <summary>Movimento do caixa: a gaveta ligada só abre com "abre nos movimentos" (dono, I4; decisão 63).</summary>
    private async Task AbrirGavetaAsync(List<string> avisos, CancellationToken ct)
    {
        if (await gaveta.AbrirNoMovimentoAsync(ct) is { } aviso)
        {
            avisos.Add(aviso);
        }
    }
}
