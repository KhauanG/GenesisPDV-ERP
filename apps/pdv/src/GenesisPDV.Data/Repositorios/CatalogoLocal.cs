using System.Globalization;
using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.Data.Repositorios;

/// <summary>
/// Catálogo da venda lido dos espelhos locais do fluxo <c>catalogo</c> (MD 4.2): resolução do código (PDV 10.2),
/// pesquisa (10.3), fontes de preço da regra 11.3 (loja, promocional, atacado, faixas, mix, embalagens) e a composição
/// do combo com as alternativas vendáveis na loja (10.9.1). Linhas com <c>excluido_em</c> são ignoradas. Para a guarda
/// das variações (F2-B34), o código de uma variação leva a <c>variacao_id</c> no resultado e o pai "Com variações" com
/// variação ativa sai marcado (<see cref="ProdutoVenda.TemVariacoesAtivas"/>); quem recusa é a venda (<c>ServicoVenda</c>).
/// </summary>
public sealed class CatalogoLocal(IDbContextFactory<PdvDbContext> fabrica, ILogger<CatalogoLocal>? log = null) : ICatalogoProdutos
{
    public async Task<IReadOnlyList<ProdutoResolvido>> ResolverAsync(string codigo, CancellationToken ct = default)
    {
        var c = (codigo ?? string.Empty).Trim();
        if (c.Length == 0)
        {
            return [];
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        var loja = await LojaAsync(db, ct);
        var barras = await db.ProdutosCodigosBarras.AsNoTracking()
            .Where(b => b.Codigo == c && b.UsaVenda && b.ExcluidoEm == null)
            .OrderBy(b => b.ProdutoId)
            .ToListAsync(ct);
        if (barras.Count > 0)
        {
            var produtos = await MontarAsync(db, barras.Select(b => b.ProdutoId).Distinct().ToList(), loja, ct);
            var siglas = await SiglasAsync(db, barras.Where(b => b.UnidadeId is not null).Select(b => b.UnidadeId!.Value), ct);
            return barras
                .Where(b => produtos.ContainsKey(b.ProdutoId))
                .Select(b => new ProdutoResolvido(
                    produtos[b.ProdutoId],
                    b.Id,
                    b.Fator,
                    b.Preco,
                    b.UnidadeId is { } u ? siglas.GetValueOrDefault(u) : null,
                    b.VariacaoId))
                .ToList();
        }

        var numero = int.TryParse(c, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : (int?)null;
        var minusculo = c.ToLowerInvariant();
        var ids = await db.Produtos.AsNoTracking()
            .Where(p => p.ExcluidoEm == null
                        && ((p.CodigoInterno != null && p.CodigoInterno.ToLower() == minusculo) || (numero != null && p.Codigo == numero)))
            .OrderBy(p => p.Codigo)
            .Select(p => p.Id)
            .ToListAsync(ct);
        var porId = await MontarAsync(db, ids, loja, ct);
        return ids.Where(porId.ContainsKey).Select(id => new ProdutoResolvido(porId[id])).ToList();
    }

    /// <summary>
    /// Pesquisa F2 por nome (PDV 10.3): pelo índice FTS5 <c>produtos_busca</c> (<see cref="IndiceBuscaProdutos"/>; F2-B36)
    /// quando ele está pronto; sem ele (banco antes da abertura que o preenche, reconstrução pendente, FTS5 ausente ou
    /// corrompida), a busca em memória da Fase 1, com as mesmas regras. A FTS5 que falha na consulta marca a reconstrução
    /// e a pesquisa segue em memória: o caixa nunca fica sem pesquisa.
    /// </summary>
    public async Task<IReadOnlyList<ProdutoPesquisado>> PesquisarAsync(string texto, int limite = 50, CancellationToken ct = default)
    {
        var palavras = IndiceBuscaProdutos.Palavras(texto);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var loja = await LojaAsync(db, ct);
        var ids = await PesquisarNoIndiceAsync(db, palavras, limite, ct) ?? await PesquisarEmMemoriaAsync(db, palavras, limite, ct);
        var porId = await MontarAsync(db, ids, loja, ct);
        var detalhes = await DetalhesAsync(db, ids, ct);
        return ids.Where(porId.ContainsKey).Select(id => porId[id]).Where(p => p.Ativo)
            .Select(p => ComDetalhes(new ProdutoPesquisado(new ProdutoResolvido(p)), detalhes))
            .ToList();
    }

    /// <summary>Os ids pelo índice; nulo = índice indisponível (a busca em memória responde).</summary>
    private async Task<List<Guid>?> PesquisarNoIndiceAsync(PdvDbContext db, string[] palavras, int limite, CancellationToken ct)
    {
        var conexao = (SqliteConnection)db.Database.GetDbConnection();
        await db.Database.OpenConnectionAsync(ct);
        try
        {
            if (!await IndiceBuscaProdutos.ProntoAsync(conexao, null, ct))
            {
                return null;
            }

            return await IndiceBuscaProdutos.PesquisarAsync(conexao, palavras, limite, ct);
        }
        catch (SqliteException e)
        {
            log?.LogWarning(e, "Pesquisa F2: índice FTS5 indisponível ({Erro}); reconstrução marcada, a pesquisa segue em memória", e.Message);
            try
            {
                // Hora da máquina: a marca é só local (quem a lê é a abertura, que reconstrói).
                await IndiceBuscaProdutos.MarcarReconstrucaoAsync(conexao, null, DateTimeOffset.UtcNow, ct);
            }
            catch (SqliteException marca)
            {
                log?.LogWarning(marca, "Pesquisa F2: não foi possível marcar a reconstrução do índice");
            }

            return null;
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }

    /// <summary>
    /// A busca da Fase 1A, sem o índice: filtro em memória sobre a projeção (todas as palavras como trechos do mesmo texto
    /// que o índice guarda), por nome.
    /// </summary>
    private static async Task<List<Guid>> PesquisarEmMemoriaAsync(PdvDbContext db, string[] palavras, int limite, CancellationToken ct)
    {
        var candidatos = await db.Produtos.AsNoTracking()
            .Where(p => p.ExcluidoEm == null && p.Ativo)
            .Select(p => new { p.Id, p.Nome, p.CodigoInterno, p.Codigo, p.MarcaId, p.CategoriaPrincipalId })
            .ToListAsync(ct);
        var marcas = await db.Set<MarcaRegistro>().AsNoTracking().Where(m => m.ExcluidoEm == null).ToDictionaryAsync(m => m.Id, m => m.Descricao, ct);
        var categorias = await db.Set<CategoriaRegistro>().AsNoTracking().Where(c => c.ExcluidoEm == null).ToDictionaryAsync(c => c.Id, c => c.Nome, ct);
        return candidatos
            .Where(p =>
            {
                var texto = IndiceBuscaProdutos.Texto(
                    p.Nome,
                    p.CodigoInterno,
                    p.Codigo,
                    p.MarcaId is { } m ? marcas.GetValueOrDefault(m) : null,
                    p.CategoriaPrincipalId is { } c ? categorias.GetValueOrDefault(c) : null);
                return palavras.All(w => texto.Contains(w, StringComparison.Ordinal));
            })
            .OrderBy(p => p.Nome, StringComparer.Ordinal)
            .ThenBy(p => p.Id.ToString("D"), StringComparer.Ordinal)
            .Take(limite)
            .Select(p => p.Id)
            .ToList();
    }

    /// <summary>Marca e localização dos produtos, para as colunas da pesquisa (F2-B36).</summary>
    private static async Task<Dictionary<Guid, (string? Marca, string? Localizacao)>> DetalhesAsync(PdvDbContext db, IReadOnlyCollection<Guid> ids, CancellationToken ct)
    {
        if (ids.Count == 0)
        {
            return [];
        }

        var lista = ids.Distinct().ToList();
        var produtos = await db.Produtos.AsNoTracking()
            .Where(p => lista.Contains(p.Id))
            .Select(p => new { p.Id, p.MarcaId, p.Localizacao })
            .ToListAsync(ct);
        var idsMarcas = produtos.Where(p => p.MarcaId != null).Select(p => p.MarcaId!.Value).Distinct().ToList();
        var marcas = idsMarcas.Count == 0
            ? []
            : await db.Set<MarcaRegistro>().AsNoTracking()
                .Where(m => idsMarcas.Contains(m.Id) && m.ExcluidoEm == null)
                .ToDictionaryAsync(m => m.Id, m => m.Descricao, ct);
        return produtos.ToDictionary(
            p => p.Id,
            p => (p.MarcaId is { } m ? marcas.GetValueOrDefault(m) : null, string.IsNullOrWhiteSpace(p.Localizacao) ? null : p.Localizacao.Trim()));
    }

    private static ProdutoPesquisado ComDetalhes(ProdutoPesquisado linha, Dictionary<Guid, (string? Marca, string? Localizacao)> detalhes) =>
        detalhes.TryGetValue(linha.Produto.Id, out var d) ? linha with { Marca = d.Marca, Localizacao = d.Localizacao } : linha;

    public async Task<IReadOnlyList<ProdutoPesquisado>> PesquisarCodigoAsync(string digitos, int limite = 50, CancellationToken ct = default)
    {
        var d = (digitos ?? string.Empty).Trim();
        if (d.Length == 0 || !d.All(char.IsAsciiDigit))
        {
            return [];
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        var loja = await LojaAsync(db, ct);

        // Só dígitos (sem curinga do LIKE): o filtro "contém" vai ao SQLite; a ordem exato > começa > contém, em memória.
        var produtos = await db.Produtos.AsNoTracking()
            .Where(p => p.ExcluidoEm == null && p.Ativo
                        && ((p.CodigoInterno != null && p.CodigoInterno.Contains(d)) || p.Codigo.ToString().Contains(d)))
            .Select(p => new { p.Id, p.Nome, p.CodigoInterno, p.Codigo })
            .ToListAsync(ct);
        var barras = await db.ProdutosCodigosBarras.AsNoTracking()
            .Where(b => b.ExcluidoEm == null && b.UsaVenda && b.Codigo.Contains(d))
            .Join(db.Produtos.Where(p => p.ExcluidoEm == null && p.Ativo), b => b.ProdutoId, p => p.Id, (b, p) => new { p.Nome, Barra = b })
            .ToListAsync(ct);

        // Uma linha por produto e embalagem: o código de uma embalagem (fator ≠ 1 ou preço próprio, como no bipe) dá a linha
        // dela, que entra como a embalagem; os códigos da unidade, a da unidade. O código de uma variação (F2-B34) também
        // dá a linha dele, para a inclusão saber que é a variação (e a guarda recusar, como no bipe).
        static int Posicao(string codigo, string d) => codigo == d ? 0 : codigo.StartsWith(d, StringComparison.Ordinal) ? 1 : 2;
        static bool LinhaPropria(ProdutoCodigoBarrasRegistro b) => b.Fator != 1m || b.Preco is not null || b.VariacaoId is not null;
        var achados = produtos
            .SelectMany(p => new[] { p.CodigoInterno, p.Codigo.ToString(CultureInfo.InvariantCulture) }
                .Where(c => c is not null && c.Contains(d, StringComparison.Ordinal))
                .Select(c => (Id: p.Id, p.Nome, Barra: (ProdutoCodigoBarrasRegistro?)null, Posicao: Posicao(c!, d))))
            .Concat(barras.Select(b => (Id: b.Barra.ProdutoId, b.Nome, Barra: LinhaPropria(b.Barra) ? b.Barra : null, Posicao: Posicao(b.Barra.Codigo, d))))
            .GroupBy(a => (a.Id, Embalagem: a.Barra?.Id))
            .Select(g => (g.Key.Id, g.First().Nome, g.First().Barra, Posicao: g.Min(a => a.Posicao)))
            .OrderBy(a => a.Posicao)
            .ThenBy(a => a.Nome, StringComparer.Ordinal)
            .ThenBy(a => a.Barra?.Fator ?? 1m)
            .Take(limite)
            .ToList();
        var idsAchados = achados.Select(a => a.Id).Distinct().ToList();
        var porId = await MontarAsync(db, idsAchados, loja, ct);
        var siglas = await SiglasAsync(db, achados.Where(a => a.Barra?.UnidadeId is not null).Select(a => a.Barra!.UnidadeId!.Value), ct);
        var detalhes = await DetalhesAsync(db, idsAchados, ct);
        return achados
            .Where(a => porId.TryGetValue(a.Id, out var p) && p.Ativo)
            .Select(a => a.Barra is { } b
                ? new ProdutoPesquisado(
                    new ProdutoResolvido(porId[a.Id], b.Id, b.Fator, b.Preco, b.UnidadeId is { } u ? siglas.GetValueOrDefault(u) : null, b.VariacaoId),
                    b.Codigo)
                : new ProdutoPesquisado(new ProdutoResolvido(porId[a.Id])))
            .Select(l => ComDetalhes(l, detalhes))
            .ToList();
    }

    /// <summary>
    /// Formas de pagamento que o caixa oferece (Fase 1C, C8b; PDV 16): não excluídas, ativas, de uso no PDV e com vínculo
    /// vivo em <c>formas_pagamento_lojas</c> ("todas" ou a loja do terminal: só esses vínculos descem), na ordem dos botões.
    /// A tela de pagamento (C11a) e o fechamento por forma (C10a) leem daqui.
    /// </summary>
    public async Task<IReadOnlyList<FormaPagamentoRegistro>> FormasPagamentoAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.FormasPagamento.AsNoTracking()
            .Where(f => f.ExcluidoEm == null && f.Ativa && f.UsaPdv
                        && db.FormasPagamentoLojas.Any(l => l.FormaPagamentoId == f.Id && l.ExcluidoEm == null))
            .OrderBy(f => f.Ordem)
            .ThenBy(f => f.Descricao)
            .ToListAsync(ct);
    }

    /// <summary>
    /// Uma forma do tipo Dinheiro do espelho, mesmo inativa, excluída ou sem vínculo com a loja (as vivas primeiro): o
    /// fechamento (21.2) sempre conta a gaveta, e a forma desativada no meio do turno não pode prender a sessão. A nuvem
    /// tem a linha (só desce o que já valeu na loja), então a FK de <c>fechamentos_caixa_formas</c> fecha.
    /// </summary>
    public async Task<FormaPagamentoRegistro?> FormaDinheiroDoEspelhoAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.FormasPagamento.AsNoTracking()
            .Where(f => f.TipoForma == "dinheiro")
            .OrderBy(f => f.ExcluidoEm != null)
            .ThenBy(f => !f.Ativa)
            .ThenBy(f => f.Ordem)
            .ThenBy(f => f.Descricao)
            .FirstOrDefaultAsync(ct);
    }

    /// <summary>
    /// Cascos vazios para a devolução avulsa (F11 › V, PDV 10.12; Fase 1C, C10b): produtos do tipo <c>vasilhame</c>
    /// ativos e não excluídos, por nome (O14 do dono: casco genérico por tamanho, serve para todas as marcas).
    /// </summary>
    public async Task<IReadOnlyList<ProdutoRegistro>> VasilhamesAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.Produtos.AsNoTracking()
            .Where(p => p.ExcluidoEm == null && p.Ativo && p.Tipo == "vasilhame")
            .OrderBy(p => p.Nome)
            .ToListAsync(ct);
    }

    public async Task<ProdutoVenda?> ObterAsync(Guid produtoId, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var porId = await MontarAsync(db, [produtoId], await LojaAsync(db, ct), ct);
        return porId.GetValueOrDefault(produtoId);
    }

    /// <summary>Vários produtos de uma vez (venda recuperada após queda).</summary>
    public async Task<IReadOnlyList<ProdutoVenda>> ObterVariosAsync(IEnumerable<Guid> produtoIds, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var porId = await MontarAsync(db, produtoIds.Distinct().ToList(), await LojaAsync(db, ct), ct);
        return porId.Values.ToList();
    }

    public async Task<ComboResolvido?> ObterComboAsync(Guid kitId, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var loja = await LojaAsync(db, ct);
        var posicoes = await db.ProdutosComponentes.AsNoTracking()
            .Where(c => c.ProdutoId == kitId && c.Tipo == "kit" && c.ExcluidoEm == null)
            .OrderBy(c => c.Ordem)
            .ToListAsync(ct);
        var idsPosicoes = posicoes.Select(p => p.Id).ToList();
        var alternativas = await db.ProdutosComponentesAlternativas.AsNoTracking()
            .Where(a => idsPosicoes.Contains(a.ComponenteId) && a.Ativo && a.ExcluidoEm == null)
            .OrderBy(a => a.Ordem)
            .ToListAsync(ct);
        var ids = posicoes.Select(p => p.ComponenteId).Concat(alternativas.Select(a => a.ProdutoId)).Append(kitId).Distinct().ToList();
        var produtos = await MontarAsync(db, ids, loja, ct);
        if (!produtos.TryGetValue(kitId, out var kit))
        {
            return null;
        }

        var lista = new List<PosicaoCombo>();
        foreach (var posicao in posicoes.OrderBy(p => p.Ordem).ThenBy(p => p.Id))
        {
            if (!produtos.TryGetValue(posicao.ComponenteId, out var padrao))
            {
                // Componente padrão ausente do espelho: a posição não tem como ser vendida.
                padrao = new ProdutoVenda(posicao.ComponenteId, null, null, "(componente não sincronizado)", "UN", 0m, Ativo: false);
            }

            var opcoes = new List<OpcaoCombo> { Opcao(null, padrao, 0m) };
            if (posicao.PermiteSubstituicao)
            {
                foreach (var alternativa in alternativas.Where(a => a.ComponenteId == posicao.Id))
                {
                    // Alternativa inativa na loja não aparece (10.9.1).
                    if (produtos.TryGetValue(alternativa.ProdutoId, out var produto) && produto.Ativo && produto.Vendavel && !produto.EhKit)
                    {
                        opcoes.Add(Opcao(alternativa.Id, produto, alternativa.Acrescimo));
                    }
                }
            }

            lista.Add(new PosicaoCombo(posicao.Id, posicao.RotuloPosicao ?? padrao.Descricao, posicao.Quantidade, posicao.Ordem, opcoes));
        }

        return new ComboResolvido(kit, lista);
    }

    /// <summary>
    /// Opção da posição: disponível com as mesmas regras de <c>Venda.AdicionarCombo</c> (ativa, vendável, preço ≥ 0;
    /// retornável e produzido não entram em combo na Fase 1, decisão 23), para a tela nunca oferecer o que a venda recusa.
    /// </summary>
    private static OpcaoCombo Opcao(Guid? alternativaId, ProdutoVenda produto, decimal acrescimo)
    {
        var proibido = Venda.MotivoComponenteProibido(produto);
        var disponivel = produto.Ativo && produto.Vendavel && produto.PrecoBase >= 0m && proibido is null;
        var motivo = disponivel ? null : proibido is null ? "indisponível" : produto.VasilhameProdutoId is not null ? "retornável" : "produzido";
        return new OpcaoCombo(alternativaId, produto, acrescimo, disponivel, motivo);
    }

    /// <summary>Monta os produtos com as fontes de preço da loja do terminal (MD 6.2 já filtra as linhas de outras lojas).</summary>
    private static async Task<Dictionary<Guid, ProdutoVenda>> MontarAsync(PdvDbContext db, IReadOnlyList<Guid> ids, Guid? loja, CancellationToken ct)
    {
        if (ids.Count == 0)
        {
            return [];
        }

        var produtos = await db.Produtos.AsNoTracking().Where(p => ids.Contains(p.Id) && p.ExcluidoEm == null).ToListAsync(ct);
        var porLoja = await db.ProdutosLojas.AsNoTracking()
            .Where(l => ids.Contains(l.ProdutoId) && l.LojaId == loja && l.ExcluidoEm == null)
            .ToListAsync(ct);
        var faixas = await db.ProdutosPrecosQuantidade.AsNoTracking()
            .Where(f => ids.Contains(f.ProdutoId) && f.VariacaoId == null && (f.LojaId == null || f.LojaId == loja) && f.ExcluidoEm == null)
            .ToListAsync(ct);
        var embalagens = await db.ProdutosCodigosBarras.AsNoTracking()
            .Where(b => ids.Contains(b.ProdutoId) && b.UsaVenda && b.ExcluidoEm == null)
            .ToListAsync(ct);
        var idsGrupos = produtos.Where(p => p.GrupoPrecoQuantidadeId != null).Select(p => p.GrupoPrecoQuantidadeId!.Value).Distinct().ToList();
        var grupos = await db.GruposPrecoQuantidade.AsNoTracking()
            .Where(g => idsGrupos.Contains(g.Id) && g.ExcluidoEm == null)
            .ToListAsync(ct);
        var faixasGrupo = await db.GruposPrecoQuantidadeFaixas.AsNoTracking()
            .Where(f => idsGrupos.Contains(f.GrupoId) && (f.LojaId == null || f.LojaId == loja) && f.ExcluidoEm == null)
            .ToListAsync(ct);
        var siglas = await SiglasAsync(
            db, produtos.Select(p => p.UnidadeId).Concat(embalagens.Where(b => b.UnidadeId != null).Select(b => b.UnidadeId!.Value)), ct);
        // F2-B34: os pais "Com variações" com variação ativa (o legado sem grade, ou só com inativas, vende como simples).
        var idsComVariacoes = produtos.Where(p => p.Tipo == TipoProduto.ComVariacoes).Select(p => p.Id).ToList();
        var comVariacaoAtiva = idsComVariacoes.Count == 0
            ? []
            : (await db.Set<ProdutoVariacaoRegistro>().AsNoTracking()
                .Where(v => idsComVariacoes.Contains(v.ProdutoId) && v.Ativo && v.ExcluidoEm == null)
                .Select(v => v.ProdutoId)
                .Distinct()
                .ToListAsync(ct)).ToHashSet();
        // Ficha técnica do produzido (D17 do dono; PDV 10.9.2): a venda baixa os insumos, com a perda.
        var idsProduzidos = produtos.Where(p => p.Tipo == TipoProduto.Produzido).Select(p => p.Id).ToList();
        var fichas = idsProduzidos.Count == 0
            ? []
            : await db.ProdutosComponentes.AsNoTracking()
                .Where(c => idsProduzidos.Contains(c.ProdutoId) && c.Tipo == "ficha_tecnica" && c.ExcluidoEm == null)
                .OrderBy(c => c.Ordem)
                .ToListAsync(ct);

        var gruposPorId = grupos.ToDictionary(
            g => g.Id,
            g => new GrupoPrecoQuantidade(
                g.Id,
                g.Nome,
                g.ModoPreco == "grupo" ? ModoPrecoGrupo.Grupo : ModoPrecoGrupo.Produto,
                g.Ativo,
                faixasGrupo.Where(f => f.GrupoId == g.Id).Select(f => new FaixaPreco(f.QuantidadeInicial, f.QuantidadeFinal, f.Preco, f.LojaId)).ToList()));

        var resultado = new Dictionary<Guid, ProdutoVenda>();
        foreach (var p in produtos)
        {
            var pl = porLoja.FirstOrDefault(l => l.ProdutoId == p.Id);
            var codigos = embalagens.Where(b => b.ProdutoId == p.Id).ToList();
            var tabela = new TabelaPreco(
                PrecoVendaLoja: pl?.PrecoVenda,
                PrecoPromocional: p.PrecoPromocional,
                PromocaoInicio: p.PromocaoInicio,
                PromocaoFim: p.PromocaoFim,
                PrecoAtacado: p.PrecoAtacado,
                QtdMinimaAtacado: p.QtdMinimaAtacado,
                Faixas: faixas.Where(f => f.ProdutoId == p.Id).Select(f => new FaixaPreco(f.QuantidadeInicial, f.QuantidadeFinal, f.Preco, f.LojaId)).ToList(),
                Grupo: p.GrupoPrecoQuantidadeId is { } g ? gruposPorId.GetValueOrDefault(g) : null,
                Embalagens: codigos
                    .Where(b => b.Fator != 1m || b.Preco != null)
                    .Select(b => new EmbalagemPreco(b.Id, b.Fator, b.Preco, b.UnidadeId is { } u ? siglas.GetValueOrDefault(u) : null))
                    .ToList());
            resultado[p.Id] = new ProdutoVenda(
                p.Id,
                p.Codigo,
                p.CodigoInterno,
                p.Nome,
                siglas.GetValueOrDefault(p.UnidadeId) ?? "UN",
                p.PrecoVenda,
                Ativo: p.Ativo && (pl?.AtivoNaLoja ?? true),
                Vendavel: p.Tipo != TipoProduto.MateriaPrima && !p.Insumo)
            {
                Tipo = p.Tipo,
                PermiteFracao = p.PermiteFracao,
                Precos = tabela,
                VasilhameProdutoId = p.VasilhameProdutoId,
                VasilhameQuantidade = p.VasilhameQuantidade,
                CodigoPrincipal = codigos.Where(b => b.Fator == 1m).OrderByDescending(b => b.Principal).Select(b => b.Codigo).FirstOrDefault()
                                  ?? p.CodigoInterno,
                ControlaEstoque = p.ControlaEstoque,
                IdadeMinima = p.IdadeMinima,
                TemVariacoesAtivas = comVariacaoAtiva.Contains(p.Id),
                FichaTecnica = p.Tipo == TipoProduto.Produzido
                    ? fichas.Where(c => c.ProdutoId == p.Id)
                        .Select(c => new ComponenteFicha(c.ComponenteId, c.ComponenteVariacaoId, c.Quantidade, c.PerdaPct)).ToList()
                    : null,
            };
        }

        return resultado;
    }

    private static async Task<Dictionary<Guid, string>> SiglasAsync(PdvDbContext db, IEnumerable<Guid> ids, CancellationToken ct)
    {
        var lista = ids.Distinct().ToList();
        return lista.Count == 0
            ? []
            : await db.UnidadesMedida.AsNoTracking().Where(u => lista.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.Sigla, ct);
    }

    private static async Task<Guid?> LojaAsync(PdvDbContext db, CancellationToken ct) =>
        await db.IdentidadeTerminal.AsNoTracking().Select(i => (Guid?)i.LojaId).FirstOrDefaultAsync(ct);
}

/// <summary>
/// Grava linhas de espelho já tipadas (upsert por <c>id</c>, MD 4.2): carga de demonstração e testes. O pull real passa
/// pelo <c>AplicadorPull</c> (SQL em lote gerado do Esquema.g.cs), com a mesma regra de versão e o mesmo recálculo do
/// índice da pesquisa (<see cref="IndiceBuscaProdutos"/>).
/// </summary>
public sealed class RepositorioEspelhos(IDbContextFactory<PdvDbContext> fabrica)
{
    /// <summary>
    /// Upsert por id numa transação própria; só substitui quando a versão recebida é maior (ou a linha não existe). Como no
    /// <c>AplicadorPull</c>, a linha substituída deixa de ser <c>criado_localmente</c> (MD 4.2: a versão da nuvem chegou),
    /// e o texto do índice da pesquisa dos produtos, marcas e categorias gravados é recalculado no mesmo commit.
    /// </summary>
    public async Task<int> GravarAsync(IEnumerable<LinhaEspelho> linhas, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(linhas);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var gravadas = 0;
        var lista = linhas.ToList();
        foreach (var linha in lista)
        {
            var existente = (LinhaEspelho?)await db.FindAsync(linha.GetType(), [linha.Id], ct);
            if (existente is null)
            {
                db.Add(linha);
                gravadas++;
            }
            else if (linha.Versao > existente.Versao)
            {
                db.Entry(existente).CurrentValues.SetValues(linha);
                existente.CriadoLocalmente = false;
                gravadas++;
            }
        }

        await db.SaveChangesAsync(ct);
        static List<string> Ids<T>(List<LinhaEspelho> linhas) => linhas.Where(l => l is T).Select(l => l.Id.ToString("D")).ToList();
        await IndiceBuscaProdutos.AtualizarAsync(
            (SqliteConnection)db.Database.GetDbConnection(),
            (SqliteTransaction)tx.GetDbTransaction(),
            Ids<ProdutoRegistro>(lista),
            Ids<MarcaRegistro>(lista),
            Ids<CategoriaRegistro>(lista),
            DateTimeOffset.UtcNow,
            ct);
        await tx.CommitAsync(ct);
        return gravadas;
    }

    public async Task<bool> CatalogoVazioAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return !await db.Produtos.AnyAsync(ct);
    }
}
