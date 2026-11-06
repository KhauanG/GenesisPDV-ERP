namespace GenesisPDV.Core.Caixa;

/// <summary>
/// Permissões do PDV usadas pelo caixa (PDV 31.2; <c>packages/shared/src/permissoes.ts</c>, conferidas pelo teste do
/// PDV). Avaliadas localmente, offline, no conjunto efetivo do operador carregado no login (MD 3.3.4).
/// </summary>
public static class PermissoesPdv
{
    public const string Entrar = "pdv.acesso.entrar";

    /// <summary>Papel de liberador (31.3): digita login e PIN para liberar a ação de outro operador. Sem liberação.</summary>
    public const string Supervisor = "pdv.supervisor";

    public const string AbrirCaixa = "pdv.caixa.abrir";
    public const string FecharCaixa = "pdv.caixa.fechar";

    /// <summary>Ver o calculado no fechamento (sem liberação). Com a O3 do dono, nem ela mostra o esperado no PDV.</summary>
    public const string VerCalculadoFechamento = "pdv.caixa.ver_calculado_fechamento";

    public const string OperarDeOutro = "pdv.caixa.operar_de_outro";

    // Movimentos do caixa e limite de gaveta (PDV 20; Fase 1C, C10b). O5 do dono: o operador faz sangria e reforço
    // sozinho (estão no perfil), cancelar pede o supervisor e o limite de gaveta é liberado por ele.
    public const string Sangria = "pdv.caixa.sangria";
    public const string Reforco = "pdv.caixa.reforco";
    public const string CancelarMovimento = "pdv.caixa.cancelar_movimento";
    public const string IgnorarLimiteSangria = "pdv.caixa.ignorar_limite_sangria";
    public const string ResumoDiario = "pdv.relatorio.resumo_diario";
    public const string DescontoItem = "pdv.venda.desconto_item";

    /// <summary>
    /// Cancelar item da venda em andamento (F4 Remover item e o "Remover" da janela do item; PDV 13.1). No perfil do
    /// operador; sem ela (ou com <c>pdv.cancelar_item_exige_supervisor</c> ligada), o supervisor libera (31.3).
    /// </summary>
    public const string CancelarItem = "pdv.venda.cancelar_item";
    public const string DescontoTotal = "pdv.venda.desconto_total";

    // Venda real (Fase 1C, bloco C11a; PDV 16.2, 16.7, 29.1).

    /// <summary>Confirmar PIX manualmente (16.7). Fora do perfil do operador: com ela e a chave do supervisor desligada, lança sozinho.</summary>
    public const string ConfirmarPixManual = "pdv.pagamento.confirmar_pix_manual";

    /// <summary>Usar forma com senha de liberação ou "exige supervisor" (16.2; C8b): o supervisor que libera precisa dela.</summary>
    public const string FormaComSenha = "pdv.pagamento.forma_com_senha";

    /// <summary>Vender sem estoque com o bloqueio ligado (29.1).</summary>
    public const string VenderSemEstoque = "pdv.venda.vender_sem_estoque";

    // Gestão de vendas e cancelamentos (Fase 1C, bloco C11b; PDV 13.2, 13.3, 22.1, 22.2; O6 do dono, roadmap D23).

    /// <summary>Cancelar a venda em andamento (13.2): fora do perfil do operador, pede o supervisor (O6).</summary>
    public const string CancelarVendaAberta = "pdv.venda.cancelar_venda_aberta";

    /// <summary>
    /// Cancelar a venda paga da sessão de caixa aberta (13.3): no seed, o gerente (O6) e o encarregado (resposta do dono de
    /// 05/11/2026, decisão 78); o operador e o supervisor pedem a liberação de um deles. A de caixa fechado não tem
    /// permissão nenhuma (D23).
    /// </summary>
    public const string CancelarVendaFinalizada = "pdv.venda.cancelar_venda_finalizada";

    /// <summary>F12 Gestão de vendas (22.1), no perfil do operador.</summary>
    public const string ConsultarVendas = "pdv.venda.consultar";

    /// <summary>Reimprimir o cupom (22.2), no perfil do operador.</summary>
    public const string Reimprimir = "pdv.documento.reimprimir";

    /// <summary>
    /// Série/número NFC-e e salto de numeração; na Fase 1C (C15, SYNC 8.6) também declarar a lacuna de eventos e liberar
    /// o reenvio dos eventos dela. Sem liberação (o operador não a "empresta"): ou o próprio operador a tem, ou um
    /// supervisor que a tem digita o PIN. No perfil padrão é só do Master; a nuvem confere de novo no push.
    /// </summary>
    public const string ConfigFiscal = "pdv.config.fiscal";

    /// <summary>
    /// Configuração local e diagnóstico do terminal (Ctrl+Alt+C); na Fase 1C (C17, PDV 32.5) a ação "Restaurar backup",
    /// com a liberação de quem a tem e a confirmação dupla.
    /// </summary>
    public const string ConfigTerminal = "pdv.config.terminal";

    /// <summary>
    /// Abrir a gaveta sem venda (F11 › 9; PDV 19.4; implantação I4): fora do perfil do operador, o supervisor libera. Só
    /// com a gaveta ligada na configuração do terminal (desligada por padrão, dono).
    /// </summary>
    public const string AbrirGavetaAvulsa = "pdv.gaveta.abrir_avulsa";

    // Central do PDV, a engrenagem (bloco G1; decisão 66). Ainda sem tela: entram aqui para o espelho com o shared e
    // para os blocos seguintes. Todas admitem liberação. Não existe a de cancelar venda de caixa fechado (D23 mantida).

    /// <summary>Ver as vendas dos caixas fechados deste terminal (últimos 30 dias); sem ela, só as do caixa aberto.</summary>
    public const string ConsultarHistoricoVendas = "pdv.venda.consultar_historico";

    /// <summary>
    /// Ver os fechamentos de caixa deste terminal (últimos 30 dias), como foram impressos (PC-9). Reimprimir continua com
    /// <see cref="Reimprimir"/>.
    /// </summary>
    public const string ConsultarFechamentos = "pdv.caixa.consultar_fechamentos";

    /// <summary>Sincronização detalhada, logs, ocorrências e lista de backups do terminal.</summary>
    public const string VerDiagnostico = "pdv.diagnostico.ver";

    /// <summary>Gerar o pacote para o suporte (pendrive).</summary>
    public const string PacoteSuporte = "pdv.diagnostico.pacote_suporte";

    /// <summary>Histórico de uso (auditoria local, quem fez o quê): no seed, só Gerente e Administrador (e o Master).</summary>
    public const string VerAuditoriaLocal = "pdv.auditoria.ver_local";

    /// <summary>
    /// Parâmetros do caixa (bloqueio de tela, pasta secundária do backup) e "Fazer backup agora": no seed, só Gerente e
    /// Administrador (e o Master).
    /// </summary>
    public const string ParametrosLocais = "pdv.config.parametros_locais";

    /// <summary>As que não admitem liberação por supervisor (<c>semLiberacao</c> no catálogo).</summary>
    public static readonly IReadOnlySet<string> SemLiberacao =
        new HashSet<string>(StringComparer.Ordinal) { Supervisor, VerCalculadoFechamento, ConfigFiscal };

    /// <summary>
    /// Coluna "Operador" da matriz (perfil padrão <c>operador_caixa</c>, <c>PDV_OPERADOR</c> do shared): os operadores de
    /// demonstração e os testes partem dela.
    /// </summary>
    public static readonly IReadOnlySet<string> PerfilOperador = new HashSet<string>(StringComparer.Ordinal)
    {
        "pdv.acesso.entrar", "pdv.caixa.abrir", "pdv.caixa.fechar", "pdv.caixa.sangria", "pdv.caixa.reforco",
        "pdv.venda.vender", "pdv.venda.cancelar_item", "pdv.venda.desconto_item", "pdv.venda.desconto_total",
        "pdv.venda.acrescimo", "pdv.venda.consultar", "pdv.crediario.receber", "pdv.documento.reimprimir",
        "pdv.cliente.cadastro_rapido", "pdv.orcamento.importar", "pdv.orcamento.criar", "pdv.comanda.operar",
        "pdv.pedido.operar", "pdv.fiscal.retransmitir", "pdv.relatorio.resumo_diario",
    };
}
