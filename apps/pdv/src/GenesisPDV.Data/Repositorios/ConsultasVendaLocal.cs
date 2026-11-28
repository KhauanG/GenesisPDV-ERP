using System.Globalization;
using System.Text;
using System.Text.Json;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Repositorios;

/// <summary>Cabeçalho do comprovante (PDV 19.2) e recebedor do PIX estático (16.7), dos espelhos <c>lojas</c> e <c>empresa</c>.</summary>
/// <param name="Endereco">"Rua X, 123 - Centro - Curitiba/PR", montado da loja.</param>
public sealed record DadosLojaVenda(
    string NomeLoja,
    string RazaoSocial,
    string? Cnpj,
    string? InscricaoEstadual,
    string? Endereco,
    string? Telefone,
    string? FraseRodape,
    string? ChavePix,
    string? PixNomeRecebedor,
    string? PixCidadeRecebedor);

/// <summary>Cliente do espelho <c>pessoas</c> para o F5 (PDV 14.2): só os relevantes para a loja descem (D19).</summary>
public sealed record ClienteLocal(Guid Id, int Codigo, string Nome, string? Apelido, string? CpfCnpj, bool Ativa);

/// <summary>O que o tempo máximo offline (30.6) lê do banco local.</summary>
/// <param name="UltimoPullSucesso">O mais antigo entre os fluxos <c>acesso</c> e <c>configuracao</c>; nulo sem pull.</param>
public sealed record SituacaoOffline(DateTimeOffset? MaiorHoraVista, DateTimeOffset? UltimoPullSucesso, long SegundosOfflineAcumulados);

/// <summary>Uma venda da lista do F12 Gestão de vendas (PDV 22.1) e da aba Vendas da Central (bloco G5).</summary>
/// <param name="Hora">Quando terminou: a finalização ou, na venda em andamento cancelada, o cancelamento.</param>
/// <param name="Formas">As formas dos pagamentos aprovados ou estornados, como o cupom as mostra.</param>
/// <param name="Finalizada">Foi paga (finalizada, mesmo que cancelada depois): só ela se reimprime ou se cancela (13.3).</param>
/// <param name="NumeroNuvem">
/// O número que a nuvem deu à venda no "Aplicar com novo número" da fila de decisão (T27; <c>resultado</c> do
/// <c>venda.finalizada</c>); nulo quando vale o do caixa.
/// </param>
/// <param name="CaixaFechadoEm">Quando o caixa (sessão) da venda fechou; nulo com o caixa aberto.</param>
/// <param name="CanceladaDepois">
/// Cancelada depois do fechamento do caixa dela (<c>cancelada_em &gt; fechada_em</c>, plano 4.3). Nenhum caminho do PDV
/// faz isso (D23 mantida); o selo só aparece se o dado chegar assim.
/// </param>
public sealed record VendaDaSessao(
    Guid Id,
    long Numero,
    string NumeroExibicao,
    string Status,
    DateTimeOffset Hora,
    decimal Total,
    string Formas,
    string? CpfCnpjNota,
    Guid OperadorId,
    string? MotivoCancelamento,
    bool Finalizada,
    string? NumeroNuvem = null,
    Guid? SessaoCaixaId = null,
    DateTimeOffset? CaixaFechadoEm = null,
    bool CanceladaDepois = false);

/// <summary>
/// Consultas da venda real nos espelhos e no outbox (Fase 1C, C11a): cabeçalho do comprovante, cliente do F5, saldo
/// estimado (SYNC 15.2; PDV 29.1) e a situação do tempo offline (30.6). Só leitura.
/// </summary>
public sealed class ConsultasVendaLocal(IDbContextFactory<PdvDbContext> fabrica)
{
    public const int LimiteBuscaClientes = 30;

    /// <summary>
    /// F12 Gestão de vendas (PDV 22.1; Fase 1C, C11b): as vendas encerradas da sessão de caixa (finalizadas e canceladas),
    /// da mais nova à mais antiga, com o filtro opcional pelo número ou pelo CPF/CNPJ da nota. O número casa inteiro: o
    /// <c>numero_exibicao</c> completo ("L01-C02-000013") ou só os dígitos do número, com ou sem os zeros ("13",
    /// "000013"; nunca os da loja e do caixa do prefixo), o do caixa ou o novo que a nuvem deu (T27). Desde o bloco G5 da
    /// Central é o caso particular "uma sessão" da <see cref="ConsultasHistoricoLocal"/> (os filtros no SQL).
    /// </summary>
    public Task<IReadOnlyList<VendaDaSessao>> VendasDaSessaoAsync(Guid sessaoCaixaId, string? filtro = null, CancellationToken ct = default) =>
        new ConsultasHistoricoLocal(fabrica).VendasDaSessaoAsync(sessaoCaixaId, filtro, ct);

    /// <summary>
    /// O <c>venda.finalizada</c> da venda foi descartado na fila de decisão do ERP (<c>resultado.descartado</c>, que o
    /// heartbeat grava): a nuvem não tem a venda, e o caixa não a cancela (SYNC 9.9; PDV 13.3).
    /// </summary>
    public async Task<bool> FinalizadaDescartadaAsync(Guid vendaId, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await FinalizadaDescartadaAsync(db, vendaId, ct);
    }

    /// <summary>A mesma conferência num contexto já aberto (a reconferência dentro da transação do cancelamento).</summary>
    public static async Task<bool> FinalizadaDescartadaAsync(PdvDbContext db, Guid vendaId, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        var resultados = await db.EventosSaida.AsNoTracking()
            .Where(e => e.Tipo == "venda.finalizada" && e.AgregadoId == vendaId && e.Resultado != null)
            .Select(e => e.Resultado)
            .ToListAsync(ct);
        return resultados.Any(Descartado);
    }

    /// <summary>
    /// O comprovante impresso na finalização (a primeira linha de <c>fila_impressao</c> do cupom da venda): a reimpressão
    /// (22.2) sai com o mesmo conteúdo. Nulo se o comprovante não chegou a ser gerado.
    /// </summary>
    public async Task<byte[]?> ComprovanteOriginalAsync(Guid vendaId, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.FilaImpressao.AsNoTracking()
            .Where(f => f.ReferenciaId == vendaId && f.TipoDocumento == "cupom")
            .OrderBy(f => f.CriadoEm)
            .Select(f => f.Conteudo)
            .FirstOrDefaultAsync(ct);
    }

    /// <summary>Dados da loja do terminal; sem a linha da loja (demonstração, carga não feita), nulo.</summary>
    public async Task<DadosLojaVenda?> DadosLojaAsync(Guid lojaId, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var loja = await db.Lojas.AsNoTracking().FirstOrDefaultAsync(l => l.Id == lojaId && l.ExcluidoEm == null, ct);
        if (loja is null)
        {
            return null;
        }

        var empresa = await db.Set<EmpresaRegistro>().AsNoTracking().Where(e => e.ExcluidoEm == null).FirstOrDefaultAsync(ct);
        var municipio = await db.Set<MunicipioRegistro>().AsNoTracking().Where(m => m.CodigoIbge == loja.MunicipioIbge).Select(m => m.Nome)
            .FirstOrDefaultAsync(ct);
        var partes = new List<string>();
        if (!string.IsNullOrWhiteSpace(loja.Logradouro))
        {
            partes.Add(string.IsNullOrWhiteSpace(loja.Numero) ? loja.Logradouro.Trim() : $"{loja.Logradouro.Trim()}, {loja.Numero.Trim()}");
        }

        if (!string.IsNullOrWhiteSpace(loja.Bairro))
        {
            partes.Add(loja.Bairro.Trim());
        }

        if (municipio is not null)
        {
            partes.Add(string.IsNullOrWhiteSpace(loja.Uf) ? municipio : $"{municipio}/{loja.Uf}");
        }

        return new DadosLojaVenda(
            NomeLoja: string.IsNullOrWhiteSpace(loja.NomeFantasia) ? loja.Nome : loja.NomeFantasia,
            RazaoSocial: string.IsNullOrWhiteSpace(loja.RazaoSocial) ? empresa?.RazaoSocial ?? loja.Nome : loja.RazaoSocial,
            Cnpj: Cnpj(string.IsNullOrWhiteSpace(loja.Cnpj) ? empresa?.Cnpj : loja.Cnpj),
            InscricaoEstadual: string.IsNullOrWhiteSpace(loja.Ie) ? empresa?.Ie : loja.Ie,
            Endereco: partes.Count == 0 ? null : string.Join(" - ", partes),
            Telefone: string.IsNullOrWhiteSpace(loja.Telefone) ? empresa?.Telefone : loja.Telefone,
            FraseRodape: string.IsNullOrWhiteSpace(loja.FraseRodapeCupom) ? null : loja.FraseRodapeCupom.Trim(),
            ChavePix: string.IsNullOrWhiteSpace(loja.ChavePix) ? null : loja.ChavePix.Trim(),
            PixNomeRecebedor: loja.PixNomeRecebedor ?? loja.RazaoSocial,
            PixCidadeRecebedor: loja.PixCidadeRecebedor ?? municipio);
    }

    /// <summary>A pessoa do espelho com o documento (sem máscara), para vincular o CPF da nota ao cadastro (14.1).</summary>
    public async Task<ClienteLocal?> ClientePorDocumentoAsync(string documento, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var pessoa = await db.Pessoas.AsNoTracking()
            .Where(p => p.ExcluidoEm == null && p.CpfCnpj == documento)
            .OrderByDescending(p => p.Ativa)
            .FirstOrDefaultAsync(ct);
        return pessoa is null ? null : Cliente(pessoa);
    }

    public async Task<ClienteLocal?> ClienteAsync(Guid id, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var pessoa = await db.Pessoas.AsNoTracking().FirstOrDefaultAsync(p => p.Id == id && p.ExcluidoEm == null, ct);
        return pessoa is null ? null : Cliente(pessoa);
    }

    /// <summary>
    /// Busca local do F5 › Buscar cliente (14.2): nome ou apelido (todas as palavras, sem acento), CPF/CNPJ (com ou sem
    /// máscara) ou o código. Ativas primeiro; as inativas aparecem marcadas e não são escolhidas (a tela recusa).
    /// </summary>
    public async Task<IReadOnlyList<ClienteLocal>> BuscarClientesAsync(string? texto, CancellationToken ct = default)
    {
        var filtro = (texto ?? string.Empty).Trim();
        if (filtro.Length < 2)
        {
            return [];
        }

        var digitos = string.Concat(filtro.Where(char.IsAsciiLetterOrDigit)).ToUpperInvariant();
        var codigo = int.TryParse(filtro, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : (int?)null;
        var palavras = SemAcento(filtro).Split(' ', StringSplitOptions.RemoveEmptyEntries);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var candidatos = await db.Pessoas.AsNoTracking().Where(p => p.ExcluidoEm == null).ToListAsync(ct);
        return candidatos
            .Where(p => (codigo is not null && p.Codigo == codigo)
                        || (digitos.Length >= 3 && p.CpfCnpj is { } doc && doc.Contains(digitos, StringComparison.Ordinal))
                        || palavras.All(w => SemAcento($"{p.Nome} {p.Apelido}").Contains(w, StringComparison.Ordinal)))
            .OrderByDescending(p => p.Ativa)
            .ThenBy(p => p.Nome, StringComparer.Ordinal)
            .Take(LimiteBuscaClientes)
            .Select(Cliente)
            .ToList();
    }

    public async Task<SituacaoOffline> SituacaoOfflineAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var conexao = await db.EstadoConexao.AsNoTracking().FirstOrDefaultAsync(ct);
        var pulls = await db.EstadoSincronizacao.AsNoTracking()
            .Where(e => e.Fluxo == "acesso" || e.Fluxo == "configuracao")
            .Select(e => e.UltimoPullSucessoEm)
            .ToListAsync(ct);
        // Fluxo sem pull ainda (terminal novo na carga) não conta: o "mais antigo" é só dos que já puxaram.
        var ultimo = pulls.Where(p => p is not null).Select(p => p!.Value).DefaultIfEmpty().Min();
        return new SituacaoOffline(conexao?.MaiorHoraVista, ultimo == default ? null : ultimo, conexao?.SegundosOfflineAcumulados ?? 0);
    }

    /// <summary>
    /// Saldo estimado (SYNC 15.2; PDV 29.1) dos produtos, sem a venda em andamento: o saldo baixado do espelho
    /// <c>saldos_estoque</c> (estoque da loja, tipos vendáveis, também no espelho <c>tipos_estoque</c>) menos o que as vendas finalizadas deste caixa ainda não
    /// refletidas baixam. Refletido = evento confirmado e (cursor do fluxo <c>estoque</c> ≥ <c>versao_nuvem_fim</c>, ou a
    /// linha do saldo com versão acima da <c>versao_nuvem</c>). O rejeitado continua contando (a venda aconteceu); o
    /// descartado no ERP (<c>resultado.descartado</c>) deixa de contar. A baixa vem do payload: o item ou, no produzido,
    /// os insumos de <c>componentes_estoque</c>; os componentes do combo já são itens. Desde o F3-B15, na v2, também os
    /// complementos do item não cancelado: os insumos da <c>componentes_estoque</c> da linha ou o vinculado com saldo
    /// próprio (o mesmo <c>Venda.BaixasEstimadas</c> da venda em andamento). A venda finalizada cancelada no caixa
    /// (<c>venda.cancelada</c> forma A, C11b) devolve a baixa até o estorno se refletir.
    /// </summary>
    public async Task<IReadOnlyDictionary<Guid, decimal>> SaldosEstimadosAsync(IReadOnlyCollection<Guid> produtos, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(produtos);
        var resultado = produtos.Distinct().ToDictionary(p => p, _ => 0m);
        if (resultado.Count == 0)
        {
            return resultado;
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        var lojaId = await db.IdentidadeTerminal.AsNoTracking().Select(i => (Guid?)i.LojaId).FirstOrDefaultAsync(ct);
        var estoqueId = await db.Lojas.AsNoTracking().Where(l => l.Id == lojaId && l.ExcluidoEm == null).Select(l => (Guid?)l.EstoqueId)
            .FirstOrDefaultAsync(ct);
        var ids = resultado.Keys.ToList();
        // A linha de um tipo que deixou de ser vendável sai do filtro do pull mas fica no espelho (sem a sombra da SYNC
        // 6.11) com a última quantidade baixada: o tipo não vendável no espelho `tipos_estoque` não conta. O tipo que
        // ainda não desceu conta (a linha só desce se o tipo era vendável na nuvem).
        var naoVendaveis = db.Set<TipoEstoqueRegistro>().Where(t => !t.Vendavel && t.ExcluidoEm == null).Select(t => t.Id);
        var linhas = await db.Set<SaldoEstoqueRegistro>().AsNoTracking()
            .Where(s => s.EstoqueId == estoqueId && ids.Contains(s.ProdutoId) && s.VariacaoId == null && s.ExcluidoEm == null
                        && !naoVendaveis.Contains(s.TipoEstoqueId))
            .ToListAsync(ct);
        var versaoLinha = new Dictionary<Guid, long>();
        foreach (var l in linhas)
        {
            resultado[l.ProdutoId] += l.Quantidade;
            versaoLinha[l.ProdutoId] = Math.Max(versaoLinha.GetValueOrDefault(l.ProdutoId), l.Versao);
        }

        var cursor = await db.EstadoSincronizacao.AsNoTracking().Where(e => e.Fluxo == "estoque").Select(e => (long?)e.Cursor).FirstOrDefaultAsync(ct) ?? 0;
        var eventos = await db.EventosSaida.AsNoTracking()
            .Where(e => e.Tipo == "venda.finalizada"
                        && (e.Status != StatusEventoSaida.Confirmado || e.VersaoNuvemFim == null || e.VersaoNuvemFim > cursor))
            .Select(e => new { e.Status, e.VersaoNuvem, e.VersaoSchema, e.Payload, e.Resultado })
            .ToListAsync(ct);

        // C11b: a venda finalizada cancelada no caixa (forma A) devolve o estoque na nuvem; até o estorno se refletir, o
        // que ela baixou volta ao estimado. O payload da forma A não traz os itens: vêm do `venda.finalizada` dela.
        var cancelamentos = await db.EventosSaida.AsNoTracking()
            .Where(e => e.Tipo == "venda.cancelada"
                        && (e.Status != StatusEventoSaida.Confirmado || e.VersaoNuvemFim == null || e.VersaoNuvemFim > cursor))
            .Select(e => new { e.AgregadoId, e.Status, e.VersaoNuvem, e.Resultado })
            .ToListAsync(ct);
        var vendasCanceladas = cancelamentos.Where(c => !Descartado(c.Resultado)).Select(c => c.AgregadoId).Distinct().ToList();
        var finalizadas = await db.EventosSaida.AsNoTracking()
            .Where(e => e.Tipo == "venda.finalizada" && vendasCanceladas.Contains(e.AgregadoId))
            .Select(e => new { e.AgregadoId, e.VersaoSchema, e.Payload, e.Resultado })
            .ToListAsync(ct);

        var lidos = eventos.Where(e => !Descartado(e.Resultado)).Select(e => (Evento: e, Baixas: Ler(e.Payload, e.VersaoSchema))).ToList();
        var lidasCanceladas = finalizadas.GroupBy(f => f.AgregadoId).Select(g => g.First())
            .Where(f => !Descartado(f.Resultado))
            .ToDictionary(f => f.AgregadoId, f => Ler(f.Payload, f.VersaoSchema));
        var vinculados = await VinculadosComSaldoAsync(
            db, lidos.SelectMany(l => l.Baixas.Vinculados).Concat(lidasCanceladas.Values.SelectMany(l => l.Vinculados)).Select(v => v.Complemento), ct);

        foreach (var (e, lido) in lidos)
        {
            foreach (var (produtoId, quantidade) in Baixas(lido, vinculados))
            {
                if (!resultado.ContainsKey(produtoId))
                {
                    continue;
                }

                var refletido = e.Status == StatusEventoSaida.Confirmado && e.VersaoNuvem is { } v && versaoLinha.GetValueOrDefault(produtoId) > v;
                if (!refletido)
                {
                    resultado[produtoId] -= quantidade;
                }
            }
        }

        foreach (var c in cancelamentos.Where(c => !Descartado(c.Resultado)))
        {
            // Forma B (venda em andamento) não tem `venda.finalizada`: não baixou nada.
            if (!lidasCanceladas.TryGetValue(c.AgregadoId, out var lido))
            {
                continue;
            }

            foreach (var (produtoId, quantidade) in Baixas(lido, vinculados))
            {
                var refletido = c.Status == StatusEventoSaida.Confirmado && c.VersaoNuvem is { } v && versaoLinha.GetValueOrDefault(produtoId) > v;
                if (resultado.ContainsKey(produtoId) && !refletido)
                {
                    resultado[produtoId] += quantidade;
                }
            }
        }

        return resultado;
    }

    /// <summary>
    /// O que um <c>venda.finalizada</c> baixa, lido do payload: <see cref="Fixas"/> são o item não cancelado ou os insumos
    /// da ficha dele (unidade base) e, na v2, os insumos da <c>componentes_estoque</c> da linha do complemento;
    /// <see cref="Vinculados"/> são as linhas de complemento da v2 sem a lista, cujo vinculado a nuvem baixa pelo cadastro
    /// (<see cref="VinculadosComSaldoAsync"/>), com as vezes = quantidade do item × a do complemento.
    /// </summary>
    private sealed record BaixasDoPayload(List<(Guid Produto, decimal Quantidade)> Fixas, List<(Guid Complemento, decimal Vezes)> Vinculados);

    /// <summary>
    /// Lê as baixas do payload. Os complementos (F3-B15) contam só na v2 e só os do item não cancelado, a mesma regra do
    /// <c>baixaDoComplemento</c> da nuvem: na v1 ela grava os complementos sem baixa nenhuma.
    /// </summary>
    private static BaixasDoPayload Ler(string payload, int versaoSchema)
    {
        var fixas = new List<(Guid, decimal)>();
        var vinculados = new List<(Guid, decimal)>();
        using var doc = JsonDocument.Parse(payload);
        if (!doc.RootElement.TryGetProperty("itens_venda", out var itens) || itens.ValueKind != JsonValueKind.Array)
        {
            return new BaixasDoPayload(fixas, vinculados);
        }

        var ativos = new Dictionary<Guid, decimal>();
        foreach (var i in itens.EnumerateArray())
        {
            if (i.TryGetProperty("cancelado", out var c) && c.ValueKind == JsonValueKind.True)
            {
                continue;
            }

            if (i.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String)
            {
                ativos[Guid.Parse(id.GetString()!)] = Decimal(i.GetProperty("quantidade"));
            }

            if (Componentes(i) is { } comps)
            {
                fixas.AddRange(comps);
                continue;
            }

            fixas.Add((Guid.Parse(i.GetProperty("produto_id").GetString()!), Decimal(i.GetProperty("quantidade"))));
        }

        if (versaoSchema < 2
            || !doc.RootElement.TryGetProperty("itens_venda_complementos", out var linhas) || linhas.ValueKind != JsonValueKind.Array)
        {
            return new BaixasDoPayload(fixas, vinculados);
        }

        foreach (var l in linhas.EnumerateArray())
        {
            if (!l.TryGetProperty("item_venda_id", out var item) || item.ValueKind != JsonValueKind.String
                || !ativos.TryGetValue(Guid.Parse(item.GetString()!), out var quantidadeItem))
            {
                continue;
            }

            if (Componentes(l) is { } comps)
            {
                fixas.AddRange(comps);
                continue;
            }

            if (l.TryGetProperty("complemento_id", out var opcao) && opcao.ValueKind == JsonValueKind.String)
            {
                var quantidade = l.TryGetProperty("quantidade", out var q) && q.ValueKind != JsonValueKind.Null ? Decimal(q) : 1m;
                vinculados.Add((Guid.Parse(opcao.GetString()!), quantidadeItem * quantidade));
            }
        }

        return new BaixasDoPayload(fixas, vinculados);
    }

    /// <summary>A <c>componentes_estoque</c> não vazia da linha (item ou complemento); nula sem ela.</summary>
    private static List<(Guid, decimal)>? Componentes(JsonElement linha) =>
        linha.TryGetProperty("componentes_estoque", out var comps) && comps.ValueKind == JsonValueKind.Array && comps.GetArrayLength() > 0
            ? comps.EnumerateArray().Select(x => (Guid.Parse(x.GetProperty("produto_id").GetString()!), Decimal(x.GetProperty("quantidade")))).ToList()
            : null;

    /// <summary>As baixas do payload, com o vinculado de cada complemento resolvido pelo espelho (3 casas, a conta da nuvem).</summary>
    private static IEnumerable<(Guid Produto, decimal Quantidade)> Baixas(BaixasDoPayload lido, IReadOnlyDictionary<Guid, (Guid Produto, decimal QuantidadeBaixa)> vinculados)
    {
        foreach (var x in lido.Fixas)
        {
            yield return x;
        }

        foreach (var (complemento, vezes) in lido.Vinculados)
        {
            if (vinculados.TryGetValue(complemento, out var v) && Arredondamento.Arred3(vezes * v.QuantidadeBaixa) is > 0m and var quantidade)
            {
                yield return (v.Produto, quantidade);
            }
        }
    }

    /// <summary>
    /// As opções (espelho <c>produtos_complementos</c>, pelo id, como a nuvem lê o cadastro dela) com <c>baixa_estoque</c>
    /// cujo vinculado tem saldo próprio: <c>controla_estoque</c> e não é kit, produzido nem serviço (o produzido baixa
    /// pela <c>componentes_estoque</c> da linha; os outros a nuvem só custeia).
    /// </summary>
    private static async Task<Dictionary<Guid, (Guid Produto, decimal QuantidadeBaixa)>> VinculadosComSaldoAsync(
        PdvDbContext db, IEnumerable<Guid> complementos, CancellationToken ct)
    {
        var ids = complementos.Distinct().ToList();
        if (ids.Count == 0)
        {
            return [];
        }

        var semBaixaPropria = new[] { TipoProduto.Kit, TipoProduto.Produzido, TipoProduto.Servico };
        var linhas = await db.Set<ProdutoComplementoRegistro>().AsNoTracking()
            .Where(o => ids.Contains(o.Id) && o.BaixaEstoque && o.ProdutoId != null)
            .Join(db.Produtos.AsNoTracking().Where(p => p.ControlaEstoque && !semBaixaPropria.Contains(p.Tipo)),
                o => o.ProdutoId, p => (Guid?)p.Id, (o, p) => new { o.Id, Produto = p.Id, o.QuantidadeBaixa })
            .ToListAsync(ct);
        return linhas.ToDictionary(l => l.Id, l => (l.Produto, l.QuantidadeBaixa));
    }

    private static decimal Decimal(JsonElement e) =>
        e.ValueKind == JsonValueKind.String ? decimal.Parse(e.GetString()!, CultureInfo.InvariantCulture) : e.GetDecimal();

    /// <summary>
    /// <c>resultado.descartado = true</c>: o evento foi descartado na fila de decisão do ERP (decisão final na nuvem). Também
    /// tira o evento da consulta horária do <c>GET /sync/eventos-status</c> (nada mais muda para ele).
    /// </summary>
    public static bool Descartado(string? resultado)
    {
        if (string.IsNullOrWhiteSpace(resultado))
        {
            return false;
        }

        try
        {
            using var doc = JsonDocument.Parse(resultado);
            return doc.RootElement.ValueKind == JsonValueKind.Object
                   && doc.RootElement.TryGetProperty("descartado", out var d) && d.ValueKind == JsonValueKind.True;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static ClienteLocal Cliente(PessoaRegistro p) => new(p.Id, p.Codigo, p.Nome, p.Apelido, p.CpfCnpj, p.Ativa);

    /// <summary>CNPJ com a máscara do cupom (14 posições); outro formato sai como veio.</summary>
    private static string? Cnpj(string? cnpj) =>
        cnpj is { Length: 14 } c ? $"{c[..2]}.{c[2..5]}.{c[5..8]}/{c[8..12]}-{c[12..]}" : cnpj;

    private static string SemAcento(string texto)
    {
        var normalizado = texto.ToUpperInvariant().Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(normalizado.Length);
        foreach (var c in normalizado)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark)
            {
                sb.Append(c);
            }
        }

        return sb.ToString();
    }
}
