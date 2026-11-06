using System.Text.RegularExpressions;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Push;

namespace GenesisPDV.App.Tests;

/// <summary>
/// As frases do Histórico de uso (Central do PDV, bloco G10; plano 4.4; README › decisão 74): toda ação que o código grava
/// hoje no <c>log_auditoria_local</c> tem frase (o teste varre o código: ação nova sem frase quebra aqui), e também todas
/// as do catálogo da nuvem; a desconhecida vira "registrou …"; a marca de envio; e o antes/depois que só mostra os campos
/// exibíveis, mascarados (nunca o <c>login_informado</c>, o pagador do PIX nem o dinheiro estimado da sangria, O3).
/// </summary>
public partial class DescritorAuditoriaTests
{
    [Fact]
    public void Toda_acao_gravada_hoje_tem_frase()
    {
        var raiz = Path.Combine(ChavesTerminalTests.PastaPdv(), "src");
        var gravadas = Directory.EnumerateFiles(raiz, "*.cs", SearchOption.AllDirectories)
            .Where(a => !a.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                        && !a.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                        && !a.Contains($"{Path.DirectorySeparatorChar}Migracoes{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Select(File.ReadAllText)
            .SelectMany(texto => Gravacoes().SelectMany(r => r.Matches(texto)).Select(m => m.Groups["a"].Value))
            .ToHashSet(StringComparer.Ordinal);

        // A varredura acha os jeitos de gravar que existem (o registro da venda e do caixa, o RegistrarAuditoriaAsync, a
        // entidade montada à mão, a constante, o helper do caixa e o SQL da restauração): se um deles deixar de ser achado,
        // o teste fica cego e quebra aqui.
        string[] conhecidasNoCodigo =
        [
            "login", "login_negado", "logout", "liberacao", AcessoCentral.AcaoCentralAcessada, "hash_fora_dos_limites", "cancelar",
            "venda_cancelada", "item_cancelado", "desconto_item", "desconto_total", "desconto_item_removido", "cascos_trazidos",
            "cascos_descontados", "pix_confirmado_manual", "venda_recuperada", "gaveta_aberta", "reimpressao", "sangria_recusada",
            "caixa_operar_de_outro", "editar", "terminal_ativado", "terminal_ativado_demonstracao", "restaurar", "relogio_regrediu",
        ];
        Assert.All(conhecidasNoCodigo, a => Assert.Contains(a, gravadas));
        // Nada de texto que não é ação (a varredura não pega a entidade nem a localização).
        Assert.DoesNotContain("sessoes_caixa", gravadas);
        Assert.DoesNotContain("pdv", gravadas);

        var semFrase = gravadas.Where(a => !DescritorAuditoria.Conhecidas.Contains(a)).Order(StringComparer.Ordinal).ToList();
        Assert.Empty(semFrase);
        // A versão seguinte pode trazer qualquer ação do catálogo da nuvem: todas já têm frase.
        Assert.All(CatalogosNuvem.AcoesAuditoria, a => Assert.Contains(a, DescritorAuditoria.Conhecidas));
        // Cada frase tem verbo e nome curto, e todo grupo tem ação.
        Assert.All(DescritorAuditoria.Conhecidas.Select(DescritorAuditoria.Descrever), d =>
        {
            Assert.False(string.IsNullOrWhiteSpace(d.Verbo));
            Assert.False(string.IsNullOrWhiteSpace(d.Titulo));
            Assert.DoesNotContain('_', d.Verbo);
            Assert.DoesNotContain('_', d.Titulo);
        });
        Assert.All(DescritorAuditoria.Grupos, g => Assert.NotEmpty(DescritorAuditoria.AcoesDoGrupo(g)));
        Assert.Equal(DescritorAuditoria.Conhecidas.Count, DescritorAuditoria.Grupos.Sum(g => DescritorAuditoria.AcoesDoGrupo(g).Count));
    }

    [Fact]
    public void Frase_com_quem_fez_e_quem_liberou_e_a_acao_de_outra_versao()
    {
        Assert.Equal("MARIA cancelou um item · liberado por CARLOS", DescritorAuditoria.Frase("item_cancelado", "MARIA", "CARLOS"));
        Assert.Equal("MARIA abriu a gaveta sem venda", DescritorAuditoria.Frase("gaveta_aberta", "MARIA", null));
        // Sem pessoa (o caixa sozinho): o nome curto.
        Assert.Equal("Relógio do Windows voltou", DescritorAuditoria.Frase("relogio_regrediu", null, null));
        var nova = DescritorAuditoria.Descrever("acao_de_outra_versao");
        Assert.Equal((GrupoAuditoria.Sistema, "MARIA registrou \"acao_de_outra_versao\""),
            (nova.Grupo, DescritorAuditoria.Frase("acao_de_outra_versao", "MARIA", null)));
        Assert.Contains("gaveta_aberta", DescritorAuditoria.AcoesComTexto("GAVETA"));
        Assert.Contains("desconto_item", DescritorAuditoria.AcoesComTexto("desconto"));
        Assert.Empty(DescritorAuditoria.AcoesComTexto("xyz123"));
        // A frase que depende do registro também é procurada ("paga", "andamento", "própria").
        Assert.Equal(["venda_cancelada"], DescritorAuditoria.AcoesComTexto("venda paga"));
        Assert.Equal(["cancelar", "venda_cancelada"], DescritorAuditoria.AcoesComTexto("em andamento").Order(StringComparer.Ordinal));
        Assert.Equal(["liberacao"], DescritorAuditoria.AcoesComTexto("propria permissao"));
        Assert.Equal(["Acessos", "Vendas", "Caixa", "Configuração", "Sistema"], DescritorAuditoria.Grupos.Select(DescritorAuditoria.RotuloGrupo));
    }

    [Fact]
    public void Frase_do_cancelamento_pela_venda_e_da_liberacao_dada_a_si_mesmo()
    {
        var maria = Guid.CreateVersion7();
        var carlos = Guid.CreateVersion7();
        RegistroAuditoriaLocal Registro(string acao, Guid? autorizado = null, bool? vendaPaga = null) => new(
            Guid.CreateVersion7(), DateTimeOffset.UtcNow, maria, autorizado, null, acao, "venda", Guid.CreateVersion7(), null, null, null, null, null,
            null, null, VendaPaga: vendaPaga);

        // O Shift+F4 da venda em andamento e o F12 da venda paga gravam a mesma ação: a frase sai da venda.
        Assert.Equal("MARIA cancelou uma venda paga", DescritorAuditoria.Frase(DescritorAuditoria.Descrever(Registro("venda_cancelada", vendaPaga: true)), "MARIA", null));
        Assert.Equal("MARIA cancelou uma venda em andamento · liberado por CARLOS",
            DescritorAuditoria.Frase(DescritorAuditoria.Descrever(Registro("venda_cancelada", carlos, vendaPaga: false)), "MARIA", "CARLOS"));
        Assert.Equal("MARIA cancelou uma venda", DescritorAuditoria.Frase(DescritorAuditoria.Descrever(Registro("venda_cancelada")), "MARIA", null));
        Assert.Equal("Venda em andamento cancelada", DescritorAuditoria.Descrever(Registro("cancelar")).Titulo);
        Assert.All(new[] { true, false }, paga => Assert.Equal(GrupoAuditoria.Vendas, DescritorAuditoria.Descrever(Registro("venda_cancelada", vendaPaga: paga)).Grupo));

        // A liberação: pedida a outro, ou dada a si mesmo (o supervisor que libera o próprio caixa com o disco cheio).
        Assert.Equal("pediu uma liberação", DescritorAuditoria.Descrever(Registro("liberacao", carlos)).Verbo);
        Assert.Equal("liberou com a própria permissão de supervisor", DescritorAuditoria.Descrever(Registro("liberacao", maria)).Verbo);
    }

    [Fact]
    public void Descricao_exibivel_sem_o_login_digitado_nem_o_pagador_do_pix()
    {
        // Como o LoginViewModel e a Central gravam: o PIN digitado no campo do usuário não aparece (nem pela máscara, que
        // não esconde 4 a 6 dígitos soltos).
        Assert.Equal("Login negado", DescritorAuditoria.DescricaoExibivel("login_negado", "Login negado para '9876'"));
        Assert.Equal("Login negado na Central do PDV", DescritorAuditoria.DescricaoExibivel("login_negado", "Login negado para '98'76' na Central do PDV"));
        Assert.Contains("9876", MascaradorSuporte.Mascarar("Login negado para '9876'"), StringComparison.Ordinal);

        // O PIX à mão (o AuditoriaPagamento do caixa): o valor e a hora sim, o nome do cliente não.
        Assert.Equal("PIX de R$ 25,00 confirmado manualmente às 14:32",
            DescritorAuditoria.DescricaoExibivel("pix_confirmado_manual", "PIX de R$ 25,00 confirmado manualmente: JOANA DA SILVA às 14:32"));
        Assert.Equal("PIX de R$ 25,00 confirmado manualmente às 14:32",
            DescritorAuditoria.DescricaoExibivel("pix_confirmado_manual", "PIX de R$ 25,00 confirmado manualmente:  às 14:32"));
        Assert.Equal("PIX confirmado manualmente", DescritorAuditoria.DescricaoExibivel("pix_confirmado_manual", "PIX de outra versão: JOANA"));

        // As outras, como foram gravadas; sem descrição, nada.
        Assert.Equal("Login de MARIA", DescritorAuditoria.DescricaoExibivel("login", "Login de MARIA"));
        Assert.Null(DescritorAuditoria.DescricaoExibivel("login_negado", null));
        Assert.Equal(["login_negado", "pix_confirmado_manual"], DescritorAuditoria.AcoesComDescricaoTrocada);
    }

    [Fact]
    public void Backup_manual_tem_a_frase_dele_e_o_criar_de_outra_entidade_continua_generico()
    {
        static RegistroAuditoriaLocal Registro(string acao, string? entidade) => new(
            Guid.CreateVersion7(), DateTimeOffset.UtcNow, Guid.CreateVersion7(), null, null, acao, entidade, null, null, null, null, null, null, null, null);

        var backup = DescritorAuditoria.Descrever(Registro("criar", ServicoBackup.EntidadeBackup));
        Assert.Equal(("fez um backup agora", "Backup feito agora", GrupoAuditoria.Configuracao), (backup.Verbo, backup.Titulo, backup.Grupo));
        // O grupo é o da ação: o filtro por grupo (pela ação) acha a linha onde ela aparece.
        Assert.Contains("criar", DescritorAuditoria.AcoesDoGrupo(backup.Grupo));
        Assert.Equal("criou um registro", DescritorAuditoria.Descrever(Registro("criar", "produtos")).Verbo);
        Assert.Contains("criar", DescritorAuditoria.AcoesComTexto("backup agora"));
    }

    [Fact]
    public void Marca_de_envio_pelo_catalogo_e_pelo_lote()
    {
        var lote = Guid.CreateVersion7();
        Assert.Equal(SituacaoEnvio.SoLocal, DescritorAuditoria.Envio("desconto_item", null, null));
        Assert.Equal(SituacaoEnvio.SoLocal, DescritorAuditoria.Envio(AcessoCentral.AcaoCentralAcessada, null, null));
        Assert.Equal(SituacaoEnvio.AEnviar, DescritorAuditoria.Envio("login", null, null));
        Assert.Equal(SituacaoEnvio.AEnviar, DescritorAuditoria.Envio("login", lote, StatusEventoSaida.Pendente));
        Assert.Equal(SituacaoEnvio.AEnviar, DescritorAuditoria.Envio("login", lote, null));
        Assert.Equal(SituacaoEnvio.Enviado, DescritorAuditoria.Envio("login", lote, StatusEventoSaida.Confirmado));
        Assert.Equal(SituacaoEnvio.Recusado, DescritorAuditoria.Envio("gaveta_aberta", lote, StatusEventoSaida.Rejeitado));
        Assert.Equal(SituacaoEnvio.Recusado, DescritorAuditoria.Envio("gaveta_aberta", lote, StatusEventoSaida.Rejeitado, """{"codigo":"PAYLOAD_INVALIDO"}"""));
        // O ERP descartou o lote: continua `rejeitado`, e só o `resultado` diz (não manda resolver na aba 4).
        Assert.Equal(SituacaoEnvio.Descartado, DescritorAuditoria.Envio("gaveta_aberta", lote, StatusEventoSaida.Rejeitado, """{"descartado":true}"""));
        Assert.Equal(["só local", "a enviar", "✓ enviado", "recusado", "descartado no ERP"], Enum.GetValues<SituacaoEnvio>().Select(DescritorAuditoria.RotuloEnvio));
    }

    [Fact]
    public void Antes_e_depois_so_com_os_campos_exibiveis_e_mascarados()
    {
        // A edição da impressora: só o que mudou, das chaves exibíveis; a chave interna (o token) nunca.
        var (campos, ocultos) = DescritorAuditoria.Campos(
            """{"impressora.modelo":"epson_tm_t20","impressora.ip":"192.168.0.50","tela.tema":"claro","sync.token":"abc"}""",
            """{"impressora.modelo":"epson_tm_t20","impressora.ip":"192.168.0.51","tela.tema":"escuro","sync.token":"def"}""");
        Assert.Equal(
            [new CampoAuditoria("impressora.ip", "192.168.0.50", "192.168.0.51"), new CampoAuditoria("tela.tema", "claro", "escuro")],
            campos);
        Assert.Equal(1, ocultos);

        // O login negado: o login digitado pode ser um PIN no campo errado; não aparece.
        (campos, ocultos) = DescritorAuditoria.Campos(null, """{"login_informado":"1234"}""");
        Assert.Empty(campos);
        Assert.Equal(1, ocultos);

        // A sangria recusada: o valor tentado aparece; o dinheiro estimado da gaveta (O3) não.
        (campos, ocultos) = DescritorAuditoria.Campos(null, """{"valor_tentado":"500.00","dinheiro_estimado":"123.45"}""");
        Assert.Equal([new CampoAuditoria("valor_tentado", null, "500.00")], campos);
        Assert.Equal(1, ocultos);

        // O PIX à mão: o valor sim, o pagador e o txid não; a lista vira texto; o mascarador passa em cada valor.
        (campos, ocultos) = DescritorAuditoria.Campos(null,
            """{"valor":"25.00","pagador_nome":"JOAO DA SILVA","txid":"abc","abas":["4 Sincronização","5 Logs"],"documento":"cupom"}""");
        Assert.Equal(
            [new CampoAuditoria("valor", null, "25.00"), new CampoAuditoria("abas", null, "4 Sincronização, 5 Logs"), new CampoAuditoria("documento", null, "cupom")],
            campos);
        Assert.Equal(2, ocultos);

        // O `documento`: o mascarador esconde pelo nome (o CPF), que o valor sozinho perde; só os impressos conhecidos aparecem.
        Assert.Equal("fechamento_caixa", DescritorAuditoria.Campos(null, """{"documento":"fechamento_caixa"}""").Campos.Single().Depois);
        Assert.Equal(MascaradorSuporte.Mascara, DescritorAuditoria.Campos(null, """{"documento":"12345678909"}""").Campos.Single().Depois);
        Assert.Equal(MascaradorSuporte.Mascara, DescritorAuditoria.Campos(null, """{"documento":"cupom 123.456.789-09"}""").Campos.Single().Depois);
        Assert.Equal("12345678909", MascaradorSuporte.Mascarar("12345678909"));

        // JSON quebrado ou que não é objeto: nada.
        Assert.Empty(DescritorAuditoria.Campos("{quebrado", "[1,2]").Campos);
        Assert.Equal(0, DescritorAuditoria.Campos(null, null).Ocultos);
        Assert.DoesNotContain("login_informado", DescritorAuditoria.CamposExibiveis);
        Assert.DoesNotContain("dinheiro_estimado", DescritorAuditoria.CamposExibiveis);
        Assert.Empty(DescritorAuditoria.CamposExibiveis.Intersect(ChavesConfiguracaoTerminal.Internas));
    }

    private static IEnumerable<Regex> Gravacoes() =>
    [
        RegistroAuditoria(), RegistrarAuditoria(), AcaoAtribuida(), ConstanteAcao(), AuditoriaDoCaixa(), NovoRegistroDeOperador(), SqlRestauracao(),
    ];

    [GeneratedRegex(@"\bRegistroAuditoria\(\s*""(?<a>[a-z_]+)""")]
    private static partial Regex RegistroAuditoria();

    [GeneratedRegex(@"\bRegistrarAuditoriaAsync\(\s*""(?<a>[a-z_]+)""")]
    private static partial Regex RegistrarAuditoria();

    [GeneratedRegex(@"\bAcao\s*=\s*""(?<a>[a-z_]+)""")]
    private static partial Regex AcaoAtribuida();

    [GeneratedRegex(@"\bconst\s+string\s+Acao\w*\s*=\s*""(?<a>[a-z_]+)""")]
    private static partial Regex ConstanteAcao();

    /// <summary>O <c>Auditoria(...)</c> do <c>ServicoCaixa</c>: a ação é o primeiro texto da chamada.</summary>
    [GeneratedRegex(@"\.Add\(Auditoria\([^;""]*""(?<a>[a-z_]+)""")]
    private static partial Regex AuditoriaDoCaixa();

    /// <summary>O <c>new("liberacao", operador.Id, …)</c> que devolve um <c>RegistroAuditoria</c>.</summary>
    [GeneratedRegex(@"\bnew\(\s*""(?<a>[a-z_]+)"",\s*[Oo]perador\.Id\b")]
    private static partial Regex NovoRegistroDeOperador();

    [GeneratedRegex(@"INSERT INTO log_auditoria_local[^;]*?VALUES\s*\([^']*'(?<a>[a-z_]+)'")]
    private static partial Regex SqlRestauracao();
}
