namespace GenesisPDV.Core.Atalhos;

/// <summary>
/// Os códigos das ações da tabela <c>atalhos_pdv</c> (PDV 28.1 e 28.2; MD 7.8): os mesmos do seed da nuvem
/// (<c>ATALHOS_PDV_PADRAO</c> em <c>apps/api/src/database/seed/dados/tabelas-md.ts</c>, conferido pelo
/// <c>MapaAtalhosTests</c>). O plano da Fase 3 chama três deles pelo nome da tela (<c>suspender</c>,
/// <c>recuperar_suspensa</c>, <c>cupom_troca</c>): valem os códigos que já descem (<see cref="SuspenderVenda"/>,
/// <see cref="RecuperarVenda"/>, <see cref="CupomTrocaUltima"/>).
/// </summary>
public static class AcoesAtalho
{
    public const string PesquisarProduto = "pesquisar_produto";
    public const string RemoverItem = "remover_item";
    public const string TipoPreco = "tipo_preco";
    public const string PedidosOrcamentos = "pedidos_orcamentos";
    public const string ConcluirVenda = "concluir_venda";
    public const string GestaoVendas = "gestao_vendas";
    public const string NovaVenda = "nova_venda";
    public const string TrocaProdutos = "troca_produtos";
    public const string IncluirComanda = "incluir_comanda";
    public const string FecharComanda = "fechar_comanda";
    public const string GestaoComandas = "gestao_comandas";
    public const string Delivery = "delivery";
    public const string AcompanhamentoPedidos = "acompanhamento_pedidos";
    public const string Balcao = "balcao";
    public const string TabelaPrecos = "tabela_precos";
    public const string ProdutosVencidos = "produtos_vencidos";
    public const string OrdemServico = "ordem_servico";
    public const string Agenda = "agenda";
    public const string Ajuda = "ajuda";
    public const string Quantidade = "quantidade";
    public const string CancelarVenda = "cancelar_venda";
    public const string Cliente = "cliente";
    public const string DescontoAcrescimo = "desconto_acrescimo";
    public const string AlterarPreco = "alterar_preco";
    public const string Vendedor = "vendedor";
    public const string MenuFuncoes = "menu_funcoes";
    public const string ConsultaPreco = "consulta_preco";
    public const string ServicoAvulso = "servico_avulso";
    public const string CardapioInterno = "cardapio_interno";
    public const string SuspenderVenda = "suspender_venda";
    public const string RecuperarVenda = "recuperar_venda";
    public const string CupomTrocaUltima = "cupom_troca_ultima";
    public const string BloquearTerminal = "bloquear_terminal";
    public const string SincronizarAgora = "sincronizar_agora";
    public const string ConfiguracaoTerminal = "configuracao_terminal";
    public const string Gelada = "gelada";
}

/// <summary>Uma ação do catálogo com o padrão da nuvem (MD 7.8) e os textos do caixa.</summary>
/// <param name="Rotulo">O texto curto do botão da barra.</param>
/// <param name="Descricao">O texto da ajuda (F1).</param>
public sealed record AcaoAtalho(string Acao, string Tecla, bool Habilitado, int Ordem, string Rotulo, string Descricao);

/// <summary>Uma linha do espelho <c>atalhos_pdv</c> (MD 3.10.2): <paramref name="LojaId"/> nulo = a da empresa.</summary>
public sealed record LinhaAtalho(Guid? LojaId, string Acao, string Tecla, bool Habilitado, int Ordem);

/// <summary>De onde veio a linha que vale de uma ação: a da loja do terminal, a da empresa ou, sem nenhuma, o padrão.</summary>
public enum OrigemAtalho
{
    Loja,
    Empresa,
    Padrao,
}

/// <summary>
/// O atalho que está valendo de uma ação. <see cref="Tecla"/> é sempre uma tecla aceita (a da linha ou, recusada, a
/// padrão); <see cref="TeclaRecusada"/> guarda a que veio da nuvem e não valeu.
/// </summary>
public sealed record AtalhoEfetivo(
    AcaoAtalho Catalogo, string Tecla, bool Habilitado, int Ordem, OrigemAtalho Origem, string? TeclaRecusada = null)
{
    public string Acao => Catalogo.Acao;

    public string Rotulo => Catalogo.Rotulo;
}

/// <summary>Uma tecla da nuvem que o caixa não aplicou (vale a padrão), para o registro local da ocorrência.</summary>
/// <param name="Motivo">"tecla inválida ou reservada" ou "tecla repetida com &lt;ação&gt;".</param>
public sealed record AlertaAtalho(string Acao, string TeclaRecebida, string TeclaAplicada, string Motivo)
{
    public string Texto => $"{Acao}: \"{TeclaRecebida}\" ({Motivo}); vale {TeclaAplicada}";
}

/// <summary>
/// O mapa de atalhos do caixa (F3-B13; PDV 28.1–28.3; MD 3.10.2): a tabela <c>atalhos_pdv</c> que desce no fluxo
/// <c>configuracao</c>, com a linha da loja do terminal sobre a da empresa e, sem nenhuma, o padrão do catálogo
/// (<see cref="Catalogo"/>, o mesmo seed da nuvem). Puro: quem lê o espelho é o repositório do Data.
/// <list type="bullet">
/// <item>A tecla é a mesma que o ERP grava (<see cref="NormalizarTecla"/>, a regra do <c>normalizarTeclaAtalho</c> do
/// shared, conferida pelos vetores <c>atalhos.teclas.vetores.json</c>): as teclas fixas da 28.3 (Enter, Esc, Tab, setas,
/// Del, dígitos, <c>+</c>/<c>-</c>) nem têm formato de atalho, e <c>Alt+F4</c>, <c>Ctrl+Alt+Del</c> e o
/// <c>Ctrl+Alt+T</c> do tema são recusados. Tecla recusada que chegar da nuvem cai na padrão da ação, com um
/// <see cref="AlertaAtalho"/>.</item>
/// <item>Duas ações habilitadas com a mesma tecla (só acontece com a linha da loja sobre a da empresa, ou gravada fora do
/// ERP: o ERP e o <c>uq_atalhos_pdv_tecla</c> recusam na mesma linha de loja): cada uma delas que não está na tecla
/// padrão volta à padrão, com o alerta, até não sobrar repetição. Como as padrões não se repetem entre si, sempre
/// termina, e nenhuma ação habilitada fica sem tecla.</item>
/// <item>Ação desabilitada não entra na barra; a tecla dela só bipa (quando nenhuma habilitada a usa). As
/// <see cref="Essenciais"/> (o CONCLUIR e o menu de Funções) não se desligam: a linha desligada vale ligada, com o
/// alerta.</item>
/// <item>Ação que o caixa não conhece (de um ERP mais novo) é ignorada; a que falta na tabela vale o padrão.</item>
/// </list>
/// </summary>
public sealed class MapaAtalhos
{
    /// <summary>As ações do catálogo, na ordem padrão (MD 7.8; o seed <c>ATALHOS_PDV_PADRAO</c> da nuvem).</summary>
    public static IReadOnlyList<AcaoAtalho> Catalogo { get; } =
    [
        new(AcoesAtalho.PesquisarProduto, "F2", true, 1, "Pesquisar", "Pesquisar produto (na pesquisa, F4 = estoque nas outras lojas, online)"),
        new(AcoesAtalho.RemoverItem, "F4", true, 2, "Remover item", "Remover (cancelar) o item selecionado"),
        new(AcoesAtalho.TipoPreco, "F8", true, 3, "Tipo de preço", "Tipo de preço (varejo, atacado, parcelado)"),
        new(AcoesAtalho.PedidosOrcamentos, "F9", false, 4, "Pedidos/Orç.", "Pedidos e orçamentos"),
        new(AcoesAtalho.ConcluirVenda, "F10", true, 5, "CONCLUIR", "Concluir a venda: ↑↓ ou Alt+1..9 escolhem a forma (cartão: maquininha; PIX: QR e supervisor)"),
        new(AcoesAtalho.GestaoVendas, "F12", true, 6, "Gestão de vendas", "Gestão de vendas: Enter detalhes, Ctrl+R reimprimir, Ctrl+Del cancelar a venda paga, F3 caixas anteriores"),
        new(AcoesAtalho.NovaVenda, "Ctrl+N", true, 7, "Nova venda", "Nova venda (com itens: C cancela a atual, Esc volta)"),
        new(AcoesAtalho.TrocaProdutos, "Ctrl+T", true, 8, "Troca", "Troca de produtos"),
        new(AcoesAtalho.IncluirComanda, "Ctrl+I", false, 9, "Incluir comanda", "Incluir na comanda"),
        new(AcoesAtalho.FecharComanda, "Ctrl+F", false, 10, "Fechar comanda", "Fechar comanda"),
        new(AcoesAtalho.GestaoComandas, "Ctrl+G", false, 11, "Comandas", "Gestão de comandas"),
        new(AcoesAtalho.Delivery, "Ctrl+D", false, 12, "Delivery", "Delivery"),
        new(AcoesAtalho.AcompanhamentoPedidos, "Ctrl+A", false, 13, "Pedidos", "Acompanhamento de pedidos"),
        new(AcoesAtalho.Balcao, "Ctrl+B", false, 14, "Balcão", "Balcão"),
        new(AcoesAtalho.TabelaPrecos, "Ctrl+P", true, 15, "Tabela de preços", "Tabela de preços"),
        new(AcoesAtalho.ProdutosVencidos, "Alt+V", true, 16, "Vencidos", "Produtos vencidos"),
        new(AcoesAtalho.OrdemServico, "Ctrl+O", false, 17, "Ordem de serviço", "Ordem de serviço"),
        new(AcoesAtalho.Agenda, "Alt+A", false, 18, "Agenda", "Agenda"),
        new(AcoesAtalho.Ajuda, "F1", true, 19, "Ajuda", "Ajuda: esta lista de atalhos"),
        new(AcoesAtalho.Quantidade, "F3", true, 20, "Quantidade", "Quantidade do item selecionado ou da próxima leitura (ou 3*código no campo)"),
        new(AcoesAtalho.CancelarVenda, "Shift+F4", true, 21, "Cancelar venda", "Cancelar a venda inteira em andamento"),
        new(AcoesAtalho.Cliente, "F5", true, 22, "Cliente / CPF", "CPF na nota / cliente"),
        new(AcoesAtalho.DescontoAcrescimo, "F6", true, 23, "Desconto", "Desconto (no item ou no total)"),
        new(AcoesAtalho.AlterarPreco, "Ctrl+F6", true, 24, "Alterar preço", "Alterar o preço do item"),
        new(AcoesAtalho.Vendedor, "F7", true, 25, "Vendedor", "Vendedor / atendente"),
        new(AcoesAtalho.MenuFuncoes, "F11", true, 26, "Funções", "Funções do caixa (as opções logo abaixo)"),
        new(AcoesAtalho.ConsultaPreco, "Ctrl+L", true, 27, "Consulta preço", "Consulta de preço"),
        new(AcoesAtalho.ServicoAvulso, "Ctrl+S", false, 28, "Serviço avulso", "Serviço avulso"),
        new(AcoesAtalho.CardapioInterno, "Ctrl+M", false, 29, "Cardápio", "Cardápio interno (mostrar/ocultar)"),
        new(AcoesAtalho.SuspenderVenda, "Ctrl+Espaço", true, 30, "Suspender", "Suspender a venda"),
        new(AcoesAtalho.RecuperarVenda, "Ctrl+Shift+Espaço", true, 31, "Recuperar", "Recuperar uma venda suspensa"),
        new(AcoesAtalho.CupomTrocaUltima, "Ctrl+Shift+T", true, 32, "Cupom de troca", "Cupom de troca da última venda"),
        new(AcoesAtalho.BloquearTerminal, "Ctrl+Alt+B", true, 33, "Bloquear", "Bloquear a tela (desbloqueia com o PIN; também Funções › 7)"),
        new(AcoesAtalho.SincronizarAgora, "Ctrl+Alt+S", true, 34, "Sincronizar", "Sincronizar agora"),
        new(AcoesAtalho.ConfiguracaoTerminal, "Ctrl+Alt+C", true, 35, "Central", "Central do PDV (o mesmo do ⚙ e do Funções › 8; no login, sempre Ctrl+Alt+C)"),
        new(AcoesAtalho.Gelada, "Alt+G", true, 36, "Gelada", "Gelada: o acréscimo do produto gelado no item selecionado"),
    ];

    /// <summary>"tecla inválida ou reservada": formato fora da 28.3, tecla fixa do caixa ou do sistema.</summary>
    public const string MotivoInvalida = "tecla inválida ou reservada";

    private static readonly HashSet<string> TeclasProibidas = new(StringComparer.OrdinalIgnoreCase)
    {
        "Alt+F4", "Ctrl+Alt+Del", "Ctrl+Alt+Delete", "Ctrl+Alt+T",
    };

    private static readonly string[] Modificadores = ["Ctrl", "Alt", "Shift"];

    /// <summary>
    /// As ações que não se desligam (F3-B13; PDV 28.3; padrão até a confirmação do dono): sem o CONCLUIR nenhuma venda
    /// termina, e sem o menu de Funções o caixa fica sem sangria, reforço, troca de turno e fechamento (só abrem por
    /// ele). A linha da nuvem desligada vale ligada, com o <see cref="AlertaAtalho"/>; o ERP e a API já recusam
    /// desligá-las (o <c>ACOES_ATALHO_ESSENCIAIS</c> do shared, conferido pelos vetores <c>atalhos.teclas.vetores.json</c>),
    /// então a linha desligada só chega da sobreposição por loja ou de uma gravação fora do ERP.
    /// </summary>
    public static IReadOnlySet<string> Essenciais { get; } =
        new HashSet<string>(StringComparer.Ordinal) { AcoesAtalho.ConcluirVenda, AcoesAtalho.MenuFuncoes };

    /// <summary>"ação essencial: não se desliga": a linha de uma das <see cref="Essenciais"/> chegou desligada.</summary>
    public const string MotivoEssencial = "ação essencial: não se desliga";

    private readonly Dictionary<string, AtalhoEfetivo> _porAcao;
    private readonly Dictionary<string, AtalhoEfetivo> _porTecla;

    private MapaAtalhos(IReadOnlyList<AtalhoEfetivo> atalhos, IReadOnlyList<AlertaAtalho> alertas)
    {
        Atalhos = atalhos;
        Alertas = alertas;
        _porAcao = atalhos.ToDictionary(a => a.Acao, StringComparer.Ordinal);
        // As habilitadas primeiro: a tecla de uma desabilitada só bipa quando nenhuma habilitada a usa.
        _porTecla = new Dictionary<string, AtalhoEfetivo>(StringComparer.OrdinalIgnoreCase);
        foreach (var a in atalhos.Where(a => a.Habilitado).Concat(atalhos.Where(a => !a.Habilitado)))
        {
            _porTecla.TryAdd(a.Tecla, a);
        }

        Assinatura = string.Join(';', atalhos.Select(a => $"{a.Acao}={a.Tecla}|{(a.Habilitado ? 1 : 0)}|{a.Ordem}"));
    }

    /// <summary>O mapa só com os padrões do catálogo (nenhuma linha no espelho, terminal de demonstração).</summary>
    public static MapaAtalhos Padrao { get; } = Montar([], Guid.Empty);

    /// <summary>Todas as ações do catálogo, por <c>ordem</c> (e pela ordem do catálogo no empate).</summary>
    public IReadOnlyList<AtalhoEfetivo> Atalhos { get; }

    /// <summary>
    /// As linhas da nuvem que não valeram como vieram: a tecla que caiu na padrão da ação e a ação essencial desligada
    /// que ficou ligada.
    /// </summary>
    public IReadOnlyList<AlertaAtalho> Alertas { get; }

    /// <summary>Texto que muda quando qualquer tecla, habilitado ou ordem muda: a tela só remonta a barra com ele novo.</summary>
    public string Assinatura { get; }

    public AtalhoEfetivo Da(string acao) => _porAcao[acao];

    /// <summary>A ação da tecla (canônica, <see cref="NormalizarTecla"/>): a habilitada que a usa ou, sem ela, a desabilitada.</summary>
    public AtalhoEfetivo? DaTecla(string tecla) => _porTecla.GetValueOrDefault(tecla);

    /// <summary>As teclas que o caixa liga na tela de venda: uma por tecla, a ação habilitada ou, sem ela, a desabilitada.</summary>
    public IEnumerable<AtalhoEfetivo> Teclas => _porTecla.Values;

    /// <summary>
    /// A barra da tela de venda (28.3): as ações habilitadas por <c>ordem</c> que <paramref name="naBarra"/> aceita (as
    /// que este caixa já tem), até <paramref name="maximo"/>.
    /// </summary>
    public IReadOnlyList<AtalhoEfetivo> Barra(Func<AtalhoEfetivo, bool> naBarra, int maximo)
    {
        ArgumentNullException.ThrowIfNull(naBarra);
        return [.. Atalhos.Where(a => a.Habilitado && naBarra(a)).Take(maximo)];
    }

    /// <summary>
    /// Monta o mapa com as <paramref name="linhas"/> do espelho (as de outra loja são ignoradas): por ação, a linha da loja,
    /// a da empresa ou o padrão; a tecla recusada e a repetida voltam à padrão da ação, e a essencial desligada fica
    /// ligada, com o alerta.
    /// </summary>
    public static MapaAtalhos Montar(IEnumerable<LinhaAtalho> linhas, Guid lojaId)
    {
        ArgumentNullException.ThrowIfNull(linhas);
        var lista = linhas.Where(l => l.LojaId is null || l.LojaId == lojaId).ToList();
        var alertas = new List<AlertaAtalho>();
        var efetivos = new List<AtalhoEfetivo>(Catalogo.Count);
        foreach (var acao in Catalogo)
        {
            var daLoja = lojaId != Guid.Empty ? lista.FirstOrDefault(l => l.LojaId == lojaId && l.Acao == acao.Acao) : null;
            var linha = daLoja ?? lista.FirstOrDefault(l => l.LojaId is null && l.Acao == acao.Acao);
            if (linha is null)
            {
                efetivos.Add(new AtalhoEfetivo(acao, acao.Tecla, acao.Habilitado, acao.Ordem, OrigemAtalho.Padrao));
                continue;
            }

            var origem = daLoja is not null ? OrigemAtalho.Loja : OrigemAtalho.Empresa;
            var tecla = NormalizarTecla(linha.Tecla);
            if (tecla is null)
            {
                alertas.Add(new AlertaAtalho(acao.Acao, linha.Tecla, acao.Tecla, MotivoInvalida));
            }

            var habilitado = linha.Habilitado;
            if (!habilitado && Essenciais.Contains(acao.Acao))
            {
                // Desligada, o caixa ficaria preso: sem concluir a venda ou sem fechar o caixa até o próximo pull.
                alertas.Add(new AlertaAtalho(acao.Acao, linha.Tecla, tecla ?? acao.Tecla, MotivoEssencial));
                habilitado = true;
            }

            efetivos.Add(new AtalhoEfetivo(acao, tecla ?? acao.Tecla, habilitado, linha.Ordem, origem, tecla is null ? linha.Tecla : null));
        }

        // Repetição entre as habilitadas: quem está fora da padrão volta a ela. Cada volta tira ao menos uma ação da
        // repetição para sempre (a padrão nunca muda), então termina em no máximo uma volta por ação.
        for (var volta = 0; volta <= Catalogo.Count; volta++)
        {
            var repetidas = efetivos.Where(a => a.Habilitado)
                .GroupBy(a => a.Tecla, StringComparer.OrdinalIgnoreCase)
                .Where(g => g.Count() > 1)
                .ToList();
            if (repetidas.Count == 0)
            {
                break;
            }

            foreach (var grupo in repetidas)
            {
                foreach (var a in grupo.Where(a => !string.Equals(a.Tecla, a.Catalogo.Tecla, StringComparison.Ordinal)).ToList())
                {
                    var outra = grupo.First(o => o.Acao != a.Acao);
                    alertas.Add(new AlertaAtalho(a.Acao, a.TeclaRecusada ?? a.Tecla, a.Catalogo.Tecla, $"tecla repetida com {outra.Acao}"));
                    efetivos[efetivos.IndexOf(a)] = a with { Tecla = a.Catalogo.Tecla, TeclaRecusada = a.TeclaRecusada ?? a.Tecla };
                }
            }
        }

        var ordenados = efetivos
            .Select((a, i) => (a, i))
            .OrderBy(x => x.a.Ordem)
            .ThenBy(x => x.i)
            .Select(x => x.a)
            .ToList();
        return new MapaAtalhos(ordenados, alertas);
    }

    /// <summary>
    /// A tecla canônica (PDV 28.3), a mesma regra do <c>normalizarTeclaAtalho</c> do shared: <c>F1</c>–<c>F12</c> com ou
    /// sem modificadores; letra, dígito ou <c>Espaço</c> só com Ctrl/Alt (Shift sozinho digitaria o caractere); ordem
    /// Ctrl+Alt+Shift. Nula quando inválida ou proibida.
    /// </summary>
    public static string? NormalizarTecla(string? tecla)
    {
        if (tecla is null)
        {
            return null;
        }

        var partes = tecla.Split('+').Select(p => p.Trim()).Where(p => p.Length > 0).ToList();
        if (partes.Count == 0)
        {
            return null;
        }

        var baseTecla = partes[^1];
        partes.RemoveAt(partes.Count - 1);
        var mods = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in partes)
        {
            var m = Modificadores.FirstOrDefault(x => string.Equals(x, p, StringComparison.OrdinalIgnoreCase));
            if (m is null || !mods.Add(m))
            {
                return null;
            }
        }

        string chave;
        var funcao = false;
        if (baseTecla.Length is 2 or 3 && (baseTecla[0] is 'f' or 'F') && int.TryParse(baseTecla.AsSpan(1), System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture, out var n) && n is >= 1 and <= 12 && baseTecla[1] != '0')
        {
            chave = $"F{n}";
            funcao = true;
        }
        else if (baseTecla.Length == 1 && char.IsAsciiLetterOrDigit(baseTecla[0]))
        {
            chave = char.ToUpperInvariant(baseTecla[0]).ToString();
        }
        else if (baseTecla.ToLowerInvariant() is "espaço" or "espaco" or "space")
        {
            chave = "Espaço";
        }
        else
        {
            return null;
        }

        if (!funcao && !mods.Contains("Ctrl") && !mods.Contains("Alt"))
        {
            return null;
        }

        var texto = string.Join('+', Modificadores.Where(mods.Contains).Append(chave));
        return TeclasProibidas.Contains(texto) ? null : texto;
    }
}
