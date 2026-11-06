using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Push;

namespace GenesisPDV.App.Servicos.Diagnostico;

/// <summary>Os grupos do filtro do Histórico de uso (plano 4.4).</summary>
public enum GrupoAuditoria
{
    Acessos,
    Vendas,
    Caixa,
    Configuracao,
    Sistema,
}

/// <summary>
/// Uma ação do <c>log_auditoria_local</c> em português de balcão: o grupo, o verbo da frase ("MARIA <b>cancelou um
/// item</b>") e o nome curto ("Item cancelado"; também a frase quando não há pessoa, como o relógio que voltou).
/// </summary>
public sealed record DescricaoAcao(string Acao, GrupoAuditoria Grupo, string Verbo, string Titulo);

/// <summary>Onde o registro está em relação à nuvem: a marca "enviado / só local" da lista (plano 4.4).</summary>
public enum SituacaoEnvio
{
    /// <summary>A ação não está no catálogo da nuvem (desconto, item cancelado, Central aberta…): fica só neste caixa.</summary>
    SoLocal,

    /// <summary>No catálogo, ainda sem lote ou com o lote esperando a nuvem.</summary>
    AEnviar,

    /// <summary>O lote <c>auditoria.registros</c> foi confirmado: o registro já está guardado na nuvem.</summary>
    Enviado,

    /// <summary>O lote foi recusado pela nuvem (quem resolve é o ERP; a aba 4 mostra).</summary>
    Recusado,

    /// <summary>O lote foi recusado e o ERP o descartou (decisão final): não entra na nuvem, fica só neste caixa.</summary>
    Descartado,
}

/// <summary>Um campo do antes/depois que pode aparecer na tela (já mascarado).</summary>
public sealed record CampoAuditoria(string Nome, string? Antes, string? Depois);

/// <summary>
/// As frases do Histórico de uso (Central do PDV, bloco G10; plano 4.4; README › decisão 74): cada ação que o caixa grava
/// hoje tem a sua (o <c>DescritorAuditoriaTests</c> varre o código e falha se surgir ação sem frase), e também as do
/// catálogo da nuvem (<see cref="CatalogosNuvem.AcoesAuditoria"/>), para a versão seguinte não aparecer crua. A ação
/// desconhecida (de outra versão) vira "registrou …" no grupo Sistema. O texto é fixo: o que é do registro (a descrição, o
/// motivo, o antes e o depois) passa pelo <see cref="MascaradorSuporte"/> na tela, e a descrição que repete o que não pode
/// aparecer (o login digitado, o pagador do PIX) antes pela <see cref="DescricaoExibivel"/>.
/// </summary>
public static partial class DescritorAuditoria
{
    private static readonly DescricaoAcao[] Lista =
    [
        // Acessos
        new("login", GrupoAuditoria.Acessos, "entrou no caixa", "Login"),
        new("logout", GrupoAuditoria.Acessos, "saiu do caixa", "Logout"),
        new("login_negado", GrupoAuditoria.Acessos, "teve o login negado", "Login negado"),
        new("liberacao", GrupoAuditoria.Acessos, "pediu uma liberação", "Liberação do supervisor"),
        new(AcessoCentral.AcaoCentralAcessada, GrupoAuditoria.Acessos, "abriu a Central do PDV", "Central do PDV aberta"),
        new("hash_fora_dos_limites", GrupoAuditoria.Acessos, "teve o PIN recusado (gravado fora dos limites)", "PIN fora dos limites"),
        new(BloqueioTela.AcaoBloqueio, GrupoAuditoria.Acessos, "bloqueou a tela", "Tela bloqueada"),
        new(BloqueioTela.AcaoDesbloqueio, GrupoAuditoria.Acessos, "desbloqueou a tela", "Tela desbloqueada"),
        new("senha_alterada", GrupoAuditoria.Acessos, "trocou a senha", "Senha trocada"),
        new("senha_redefinida", GrupoAuditoria.Acessos, "redefiniu uma senha", "Senha redefinida"),
        new("permissoes_alteradas", GrupoAuditoria.Acessos, "mudou permissões", "Permissões alteradas"),
        new("acesso_suporte", GrupoAuditoria.Acessos, "deu acesso ao suporte", "Acesso do suporte"),
        new("token_anterior_reutilizado", GrupoAuditoria.Acessos, "usou um acesso antigo do terminal", "Acesso antigo do terminal usado"),
        new("segredo_entregue", GrupoAuditoria.Acessos, "recebeu um segredo da nuvem", "Segredo entregue"),

        // Vendas
        new("cancelar", GrupoAuditoria.Vendas, "cancelou uma venda em andamento", "Venda em andamento cancelada"),
        // A paga e a em andamento gravam a mesma ação: a frase sai da venda (Descrever(registro)); esta, só sem saber qual.
        new("venda_cancelada", GrupoAuditoria.Vendas, "cancelou uma venda", "Venda cancelada"),
        new("item_cancelado", GrupoAuditoria.Vendas, "cancelou um item", "Item cancelado"),
        new("desconto_item", GrupoAuditoria.Vendas, "deu desconto num item", "Desconto no item"),
        new("desconto_total", GrupoAuditoria.Vendas, "deu desconto no total da venda", "Desconto no total"),
        new("desconto_item_removido", GrupoAuditoria.Vendas, "tirou o desconto de um item", "Desconto do item tirado"),
        new("cascos_trazidos", GrupoAuditoria.Vendas, "registrou os cascos trazidos", "Cascos trazidos"),
        new("cascos_descontados", GrupoAuditoria.Vendas, "descontou cascos na venda", "Cascos descontados"),
        new("pix_confirmado_manual", GrupoAuditoria.Vendas, "confirmou um PIX à mão", "PIX confirmado à mão"),
        new("venda_recuperada", GrupoAuditoria.Vendas, "recuperou uma venda interrompida", "Venda recuperada"),
        new("idade_confirmada", GrupoAuditoria.Vendas, "confirmou a idade do cliente", "Idade confirmada"),
        new("idade_recusada", GrupoAuditoria.Vendas, "recusou a venda pela idade", "Idade recusada"),
        new("horario_restrito_liberado", GrupoAuditoria.Vendas, "liberou um produto fora do horário", "Horário restrito liberado"),
        new("estornar", GrupoAuditoria.Vendas, "estornou um lançamento", "Estorno"),
        new("download_xml", GrupoAuditoria.Vendas, "baixou um XML", "XML baixado"),

        // Caixa
        new("gaveta_aberta", GrupoAuditoria.Caixa, "abriu a gaveta sem venda", "Gaveta aberta sem venda"),
        new("reimpressao", GrupoAuditoria.Caixa, "reimprimiu um comprovante", "Reimpressão"),
        new(ServicoCaixa.AcaoSangriaRecusada, GrupoAuditoria.Caixa, "teve uma sangria recusada", "Sangria recusada"),
        new("caixa_operar_de_outro", GrupoAuditoria.Caixa, "operou o caixa aberto por outra pessoa", "Caixa de outro operador"),
        new("movimentar", GrupoAuditoria.Caixa, "fez um movimento", "Movimento"),
        new("conferir", GrupoAuditoria.Caixa, "conferiu", "Conferência"),

        // Configuração
        new("editar", GrupoAuditoria.Configuracao, "alterou a configuração", "Configuração alterada"),
        new("hardware_alterado", GrupoAuditoria.Configuracao, "trocou o computador do caixa", "Computador do caixa trocado"),
        new("pix_recebedor_alterado", GrupoAuditoria.Configuracao, "trocou o recebedor do PIX", "Recebedor do PIX trocado"),
        new("criar", GrupoAuditoria.Configuracao, "criou um registro", "Registro criado"),
        new("excluir", GrupoAuditoria.Configuracao, "excluiu um registro", "Registro excluído"),

        // Sistema
        new("terminal_ativado", GrupoAuditoria.Sistema, "ativou o terminal", "Terminal ativado"),
        new("terminal_ativado_demonstracao", GrupoAuditoria.Sistema, "ativou o terminal em demonstração", "Terminal ativado em demonstração"),
        new("terminal_revogado", GrupoAuditoria.Sistema, "revogou o terminal", "Terminal revogado"),
        new("restaurar", GrupoAuditoria.Sistema, "restaurou um backup", "Backup restaurado"),
        new(GenesisPDV.Data.Outbox.GravadorOutbox.AcaoRelogioRegrediu, GrupoAuditoria.Sistema, "viu o relógio do Windows voltar", "Relógio do Windows voltou"),
        new("evento_descartado", GrupoAuditoria.Sistema, "descartou um registro recusado", "Registro descartado no ERP"),
        new("evento_reprocessado", GrupoAuditoria.Sistema, "reprocessou um registro recusado", "Registro reprocessado no ERP"),
        new("lacuna_substituida", GrupoAuditoria.Sistema, "declarou uma lacuna de sequência", "Lacuna declarada"),
        new("recalcular_saldos", GrupoAuditoria.Sistema, "recalculou os saldos", "Saldos recalculados"),
        new("importar", GrupoAuditoria.Sistema, "importou dados", "Importação"),
        new("exportar", GrupoAuditoria.Sistema, "exportou dados", "Exportação"),
        new("efetivar", GrupoAuditoria.Sistema, "efetivou um documento", "Documento efetivado"),
        new("converter", GrupoAuditoria.Sistema, "converteu um documento", "Documento convertido"),
    ];

    private static readonly DescricaoAcao VendaPagaCancelada =
        new("venda_cancelada", GrupoAuditoria.Vendas, "cancelou uma venda paga", "Venda paga cancelada");

    private static readonly DescricaoAcao VendaEmAndamentoCancelada =
        new("venda_cancelada", GrupoAuditoria.Vendas, "cancelou uma venda em andamento", "Venda em andamento cancelada");

    private static readonly DescricaoAcao LiberacaoPropria =
        new("liberacao", GrupoAuditoria.Acessos, "liberou com a própria permissão de supervisor", "Liberação com a própria permissão");

    /// <summary>
    /// O "Fazer backup agora" da aba 8 (o <c>criar</c> de <c>backup_local</c>, bloco G11). Fica no grupo da ação
    /// (Configuração): o filtro por grupo é pela ação, e a linha não pode aparecer num grupo e sumir do filtro dele.
    /// </summary>
    private static readonly DescricaoAcao BackupManual =
        new("criar", GrupoAuditoria.Configuracao, "fez um backup agora", "Backup feito agora");

    /// <summary>O pacote de suporte da aba P (o <c>exportar</c> de <c>pacote_suporte</c>, bloco G9), no grupo da ação (Sistema).</summary>
    private static readonly DescricaoAcao PacoteSuporte =
        new("exportar", GrupoAuditoria.Sistema, "gerou o pacote de suporte", "Pacote de suporte gerado");

    /// <summary>As frases que dependem do registro, não só da ação (a busca pela frase também as olha).</summary>
    private static readonly DescricaoAcao[] Variantes = [VendaPagaCancelada, VendaEmAndamentoCancelada, LiberacaoPropria, BackupManual, PacoteSuporte];

    private static readonly Dictionary<string, DescricaoAcao> PorAcao = Lista.ToDictionary(d => d.Acao, StringComparer.Ordinal);

    /// <summary>
    /// Os valores do <c>documento</c> que podem aparecer: o nome é sensível para o <see cref="MascaradorSuporte"/> (o CPF do
    /// cliente) e o valor sozinho perde esse contexto; os tipos de impresso que o caixa grava aparecem, o resto vira
    /// <c>***</c>.
    /// </summary>
    private static readonly HashSet<string> DocumentosConhecidos = new(["cupom", ServicoHistoricoCaixas.DocumentoFechamento], StringComparer.Ordinal);

    /// <summary>
    /// As ações cuja descrição a tela troca (<see cref="DescricaoExibivel"/>): na busca com texto elas sempre entram na
    /// pré-seleção do SQL (o texto exibido pode não estar, igual, no gravado), e a conferência é no texto exibido.
    /// </summary>
    public static IReadOnlyList<string> AcoesComDescricaoTrocada { get; } = ["login_negado", "pix_confirmado_manual"];

    /// <summary>As ações com frase (o teste confere que toda ação gravada hoje está aqui).</summary>
    public static IReadOnlyCollection<string> Conhecidas => PorAcao.Keys;

    public static IReadOnlyList<GrupoAuditoria> Grupos { get; } = Enum.GetValues<GrupoAuditoria>();

    /// <summary>
    /// Os campos do antes/depois que podem aparecer (plano 4.4 e 5.4): as chaves exibíveis do terminal
    /// (<see cref="ChavesExibiveis"/>: impressora, gaveta, tela, pasta do backup) e os campos de valor e de referência que o
    /// caixa grava. Fora da lista não aparece, mesmo mascarado: o <c>login_informado</c> (pode ser um PIN digitado no
    /// campo errado), o nome do pagador do PIX, o <c>dinheiro_estimado</c> da sangria recusada (o esperado da gaveta, O3) e
    /// todo campo de outra versão.
    /// </summary>
    public static IReadOnlySet<string> CamposExibiveis { get; } = new HashSet<string>(
        [
            .. ChavesExibiveis.Todas,
            "valor", "valor_tentado", "desconto_item", "desconto_total", "desconto_cascos", "forma_pagamento", "forma", "numero",
            "total", "sai_da_gaveta", "cascos_devolvidos", "documento", "origem", "aba", "abas", "validade_min", "livre_mb",
            "arquivo", "backup_de_saida", "sequencia_backup", "tipo", "sequencia", "recuo_ms", "como", "minutos", "copia_secundaria",
            "tamanho_bytes", "motivo_backup", "sha256", "destino",
        ],
        StringComparer.Ordinal);

    /// <summary>A ação em frase; a desconhecida (de outra versão), "registrou …" no grupo Sistema.</summary>
    public static DescricaoAcao Descrever(string acao) =>
        PorAcao.TryGetValue(acao, out var d) ? d : new DescricaoAcao(acao, GrupoAuditoria.Sistema, $"registrou \"{acao}\"", $"Registro \"{acao}\"");

    /// <summary>
    /// A frase do registro: o <c>venda_cancelada</c> pela venda (a paga, com o dinheiro que saiu da gaveta, ou a em
    /// andamento, o Shift+F4: as duas gravam a mesma ação), e a liberação que a pessoa deu a si mesma (o supervisor que
    /// libera o próprio caixa) como tal, não como "pediu", e o <c>criar</c> de <c>backup_local</c> como "fez um backup
    /// agora" (aba 8, bloco G11) e o <c>exportar</c> de <c>pacote_suporte</c> como "gerou o pacote de suporte" (aba P, bloco G9).
    /// </summary>
    public static DescricaoAcao Descrever(RegistroAuditoriaLocal registro)
    {
        ArgumentNullException.ThrowIfNull(registro);
        return registro.Acao switch
        {
            ConsultasAuditoriaLocal.AcaoVendaCancelada when registro.VendaPaga is { } paga => paga ? VendaPagaCancelada : VendaEmAndamentoCancelada,
            "liberacao" when registro.UsuarioId is { } u && registro.AutorizadoPorId == u => LiberacaoPropria,
            "criar" when registro.Entidade == ServicoBackup.EntidadeBackup => BackupManual,
            "exportar" when registro.Entidade == ServicoPacoteSuporte.EntidadePacote => PacoteSuporte,
            _ => Descrever(registro.Acao),
        };
    }

    /// <summary>
    /// A descrição gravada como a tela pode mostrar (ainda sem a máscara): o login negado sem o que foi digitado no campo do
    /// usuário (pode ser um PIN no campo errado: "Login negado", "Login negado na Central do PDV") e o PIX à mão sem o nome
    /// do pagador (dado do cliente: "PIX de R$ 25,00 confirmado manualmente às 14:32"). As outras, como foram gravadas.
    /// </summary>
    public static string? DescricaoExibivel(string acao, string? descricao)
    {
        if (descricao is null)
        {
            return null;
        }

        return acao switch
        {
            "login_negado" => descricao.EndsWith(" na Central do PDV", StringComparison.Ordinal) ? "Login negado na Central do PDV" : "Login negado",
            "pix_confirmado_manual" => PixManual().Match(descricao) is { Success: true } m
                ? $"{m.Groups["antes"].Value} {m.Groups["hora"].Value}"
                : "PIX confirmado manualmente",
            _ => descricao,
        };
    }

    public static string RotuloGrupo(GrupoAuditoria grupo) => grupo switch
    {
        GrupoAuditoria.Acessos => "Acessos",
        GrupoAuditoria.Vendas => "Vendas",
        GrupoAuditoria.Caixa => "Caixa",
        GrupoAuditoria.Configuracao => "Configuração",
        _ => "Sistema",
    };

    /// <summary>As ações do grupo (o filtro vai ao SQL). A ação desconhecida (de outra versão) só aparece em "Todos os grupos".</summary>
    public static IReadOnlyList<string> AcoesDoGrupo(GrupoAuditoria grupo) => [.. Lista.Where(d => d.Grupo == grupo).Select(d => d.Acao)];

    /// <summary>
    /// As ações cujo verbo ou nome curto (também os que dependem do registro) tem o texto: a busca acha "gaveta" também
    /// pela frase. Os nomes de quem fez e de quem liberou não entram (a pessoa é o filtro F7).
    /// </summary>
    public static IReadOnlyList<string> AcoesComTexto(string texto) =>
        [
            .. Lista.Concat(Variantes)
                .Where(d => BuscaSemAcento.Contem(d.Verbo, texto) || BuscaSemAcento.Contem(d.Titulo, texto))
                .Select(d => d.Acao)
                .Distinct(StringComparer.Ordinal),
        ];

    /// <summary>
    /// "MARIA cancelou um item · liberado por CARLOS": a pessoa e o verbo; sem pessoa (o caixa sozinho), o nome curto. O
    /// liberador só quando é outra pessoa (quem entra pela Central com a permissão fica também como quem autorizou).
    /// </summary>
    public static string Frase(string acao, string? quem, string? liberadoPor) => Frase(Descrever(acao), quem, liberadoPor);

    public static string Frase(DescricaoAcao descricao, string? quem, string? liberadoPor)
    {
        ArgumentNullException.ThrowIfNull(descricao);
        var frase = quem is null ? descricao.Titulo : $"{quem} {descricao.Verbo}";
        return liberadoPor is null ? frase : $"{frase} · liberado por {liberadoPor}";
    }

    /// <summary>
    /// A marca de envio: fora do catálogo da nuvem, só local; no catálogo, pelo lote em que subiu (confirmado, recusado,
    /// descartado pelo ERP — o <c>rejeitado</c> com o <c>resultado</c> do descarte — ou ainda esperando; sem lote, a enviar).
    /// </summary>
    public static SituacaoEnvio Envio(string acao, Guid? eventoId, string? statusEvento, string? resultadoEvento = null)
    {
        if (!CatalogosNuvem.AcoesAuditoria.Contains(acao, StringComparer.Ordinal))
        {
            return SituacaoEnvio.SoLocal;
        }

        return eventoId is null ? SituacaoEnvio.AEnviar : statusEvento switch
        {
            StatusEventoSaida.Confirmado => SituacaoEnvio.Enviado,
            StatusEventoSaida.Rejeitado => ConsultasVendaLocal.Descartado(resultadoEvento) ? SituacaoEnvio.Descartado : SituacaoEnvio.Recusado,
            _ => SituacaoEnvio.AEnviar,
        };
    }

    public static string RotuloEnvio(SituacaoEnvio envio) => envio switch
    {
        SituacaoEnvio.SoLocal => "só local",
        SituacaoEnvio.Enviado => "✓ enviado",
        SituacaoEnvio.Recusado => "recusado",
        SituacaoEnvio.Descartado => "descartado no ERP",
        _ => "a enviar",
    };

    /// <summary>
    /// O antes e o depois, campo a campo (os objetos JSON do registro): só os de <see cref="CamposExibiveis"/>, cada valor
    /// pelo <see cref="MascaradorSuporte"/> (o <c>documento</c>, só os tipos de impresso conhecidos:
    /// <see cref="DocumentosConhecidos"/>); na edição (antes e depois), só os que mudaram. Devolve também quantos campos
    /// ficaram de fora (a tela diz "+2 campos não mostrados"). O JSON quebrado ou que não é objeto não aparece.
    /// </summary>
    public static (IReadOnlyList<CampoAuditoria> Campos, int Ocultos) Campos(string? antes, string? depois)
    {
        var a = Objeto(antes);
        var d = Objeto(depois);
        var nomes = (a?.Select(p => p.Key) ?? []).Concat(d?.Select(p => p.Key) ?? []).Distinct(StringComparer.Ordinal).ToList();
        var campos = new List<CampoAuditoria>();
        var ocultos = 0;
        foreach (var nome in nomes)
        {
            var va = Texto(a, nome);
            var vd = Texto(d, nome);
            if (a is not null && d is not null && va == vd)
            {
                continue;
            }

            if (!CamposExibiveis.Contains(nome))
            {
                ocultos++;
                continue;
            }

            campos.Add(new CampoAuditoria(nome, Exibir(nome, va), Exibir(nome, vd)));
        }

        return (campos, ocultos);
    }

    private static string? Exibir(string nome, string? valor) =>
        nome == "documento" && valor is not (null or "—") && !DocumentosConhecidos.Contains(valor)
            ? MascaradorSuporte.Mascara
            : MascaradorSuporte.Mascarar(valor);

    /// <summary>"PIX de R$ 25,00 confirmado manualmente: FULANO às 14:32" (o <c>AuditoriaPagamento</c> do caixa).</summary>
    [GeneratedRegex(@"^(?<antes>PIX de .+? confirmado manualmente): .*(?<hora>às \d{2}:\d{2})$", RegexOptions.Singleline | RegexOptions.CultureInvariant)]
    private static partial Regex PixManual();

    private static JsonObject? Objeto(string? json)
    {
        if (string.IsNullOrWhiteSpace(json) || !json.TrimStart().StartsWith('{'))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(json) as JsonObject;
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or ArgumentException)
        {
            return null;
        }
    }

    private static string? Texto(JsonObject? objeto, string nome)
    {
        if (objeto is null || !objeto.TryGetPropertyValue(nome, out var valor))
        {
            return null;
        }

        return valor switch
        {
            null => "—",
            JsonValue v when v.TryGetValue<string>(out var s) => s,
            JsonArray lista => string.Join(", ", lista.Select(i => i is JsonValue iv && iv.TryGetValue<string>(out var s) ? s : i?.ToJsonString() ?? "—")),
            _ => valor.ToJsonString(),
        };
    }
}
