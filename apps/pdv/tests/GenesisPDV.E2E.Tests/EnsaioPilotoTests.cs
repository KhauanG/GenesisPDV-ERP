using System.Diagnostics;
using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Tests;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Data;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.E2E.Tests;

/// <summary>
/// Ensaio do piloto com o catálogo REAL (implantação I5), local e fora do CI: o PDV de verdade (Avalonia headless)
/// contra a API de <c>apps/api/test/e2e-pdv/ensaio-piloto.ts</c>, que importou a planilha do Nuvem3 pelo importador de
/// verdade. Ativa pelo assistente e mede a carga inicial (tempo e tamanho do banco local), mede a busca por código e por
/// texto no catálogo real, abre o caixa, vende <c>GENESIS_ENSAIO_VENDAS</c> vendas (padrão 30) com itens sorteados da
/// amostra (semente fixa) em dinheiro, PIX (com a liberação do gerente, O9b), débito e crédito, faz uma sangria e fecha
/// às cegas; espera o outbox esvaziar e confere pelo ERP as vendas, a sessão fechada, nenhum evento com erro, o estoque
/// baixado e a Prontidão da loja sem nenhum item "falta". O relatório (<c>GENESIS_ENSAIO_RELATORIO</c>) só tem tempos e
/// contagens: nenhum nome de produto nem código.
/// <para>
/// <c>Explicit</c>: só roda pedido (<c>ensaio-piloto.sh</c>, <c>--explicit only</c>); o <c>rodar.sh</c> do CI não o vê
/// como pulado (lá o <c>--fail-skips</c> falharia o job).
/// </para>
/// </summary>
public sealed class EnsaioPilotoTests
{
    public const string VariavelEstado = "GENESIS_ENSAIO_ESTADO";

    private static readonly CultureInfo PtBr = CultureInfo.GetCultureInfo("pt-BR");

    [AvaloniaFact(Explicit = true)]
    public async Task Catalogo_real_ativa_carrega_vende_em_todas_as_formas_fecha_e_a_loja_fica_pronta()
    {
        var estado = await EstadoEnsaio.CarregarAsync(TimeSpan.FromMinutes(5));
        var quantasVendas = int.TryParse(Environment.GetEnvironmentVariable("GENESIS_ENSAIO_VENDAS"), out var n) && n > 0 ? n : 30;
        using var erp = await ErpE2E.EntrarAsync(estado.Api, estado.CodigoEmpresa, estado.Erp);
        var vendaveis = estado.Amostra.Where(a => a.Tipo != "combo").ToList();
        var saldosAntes = new Dictionary<Guid, decimal>();
        foreach (var a in vendaveis)
        {
            saldosAntes[a.Id] = await SaldoAsync(erp, estado, a);
        }

        // 1. Ativação pelo assistente e a carga inicial do catálogo inteiro.
        using var pdv = await RoteiroE2E.IniciarAsync();
        var carga = Stopwatch.StartNew();
        var terminal = await RoteiroE2E.AtivarECarregarAsync(pdv, estado.Api, estado.CodigoEmpresa, await erp.GerarCodigoAsync(estado.LojaId, estado.CaixaId));
        carga.Stop();
        int produtosLocais;
        int ativosLocais;
        int codigosLocais;
        List<string> codigos;
        List<string> palavras;
        Dictionary<Guid, List<(Guid Componente, decimal Quantidade)>> composicao;
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            // A descida leva também os inativos (a planilha com "Ativo = Não", o combo sem composição que o importador
            // cria inativo): o total local bate com o total da nuvem, e os ativos com os ativos.
            produtosLocais = await db.Produtos.CountAsync(p => p.ExcluidoEm == null);
            ativosLocais = await db.Produtos.CountAsync(p => p.ExcluidoEm == null && p.Ativo);
            // O combo vendido baixa os componentes: se algum também está na amostra, a baixa esperada dele soma a do combo.
            var combos = estado.Amostra.Where(a => a.Tipo == "combo").Select(a => a.Id).ToList();
            composicao = (await db.ProdutosComponentes
                    .Where(pc => combos.Contains(pc.ProdutoId) && pc.Tipo == "kit" && pc.ExcluidoEm == null)
                    .Select(pc => new { pc.ProdutoId, pc.ComponenteId, pc.Quantidade }).ToListAsync())
                .GroupBy(pc => pc.ProdutoId)
                .ToDictionary(g => g.Key, g => g.Select(pc => (pc.ComponenteId, pc.Quantidade)).ToList());
            codigosLocais = await db.ProdutosCodigosBarras.CountAsync(c => c.ExcluidoEm == null);
            var aleatorio = new Random(4);
            codigos = (await db.ProdutosCodigosBarras.Where(c => c.ExcluidoEm == null && c.UsaVenda).Select(c => c.Codigo).ToListAsync())
                .OrderBy(_ => aleatorio.Next()).Take(300).ToList();
            palavras = (await db.Produtos.Where(p => p.ExcluidoEm == null && p.Ativo).Select(p => p.Nome).ToListAsync())
                .Select(nome => nome.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault(w => w.Length >= 4))
                .OfType<string>().OrderBy(_ => aleatorio.Next()).Take(50).ToList();
        }

        var arquivoBanco = new FileInfo(pdv.Caminhos.ArquivoBanco);
        var tamanhoBanco = arquivoBanco.Length + (File.Exists(arquivoBanco.FullName + "-wal") ? new FileInfo(arquivoBanco.FullName + "-wal").Length : 0);

        // 2. Busca no catálogo real: código (o leitor de código de barras) e texto (F2), como o caixa faz.
        var catalogo = pdv.Servicos.GetRequiredService<ICatalogoProdutos>();
        var buscaCodigo = new List<double>();
        foreach (var c in codigos)
        {
            var t = Stopwatch.StartNew();
            Assert.NotEmpty(await catalogo.ResolverAsync(c));
            buscaCodigo.Add(t.Elapsed.TotalMilliseconds);
        }

        var buscaTexto = new List<double>();
        foreach (var p in palavras)
        {
            var t = Stopwatch.StartNew();
            Assert.NotEmpty(await catalogo.PesquisarAsync(p));
            buscaTexto.Add(t.Elapsed.TotalMilliseconds);
        }

        // 3. Caixa aberto com R$ 100,00 e as vendas sorteadas (semente fixa), alternando as formas do piloto (O9a).
        var venda = await pdv.LogarAsync(estado.Operador.Login, estado.Operador.Pin, "100");
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>().SessaoCaixaId!.Value;
        var sorteio = new Random(20261104);
        var vendidos = new Dictionary<Guid, decimal>();
        var tempos = new List<double>();
        var porForma = new Dictionary<string, int>(StringComparer.Ordinal);
        var itens = 0;
        var formas = new[] { "dinheiro", "pix", "cartao_debito", "cartao_credito" };
        var sangria = false;
        for (var i = 0; i < quantasVendas; i++)
        {
            var t = Stopwatch.StartNew();
            var quantos = sorteio.Next(1, 5);
            for (var k = 0; k < quantos; k++)
            {
                var a = estado.Amostra[sorteio.Next(estado.Amostra.Count)];
                var quantidade = a.Tipo switch
                {
                    "fracionado" => 0.5m,
                    "combo" => 1m,
                    _ => sorteio.Next(1, 4),
                };
                var entrada = quantidade == 1m ? a.Codigo : $"{quantidade.ToString("0.###", PtBr)}*{a.Codigo}";
                await RoteiroE2E.IncluirAsync(pdv, venda, entrada);
                itens++;
                if (a.Tipo != "combo")
                {
                    vendidos[a.Id] = vendidos.GetValueOrDefault(a.Id) + quantidade;
                }
                else
                {
                    foreach (var (componente, porCombo) in composicao.GetValueOrDefault(a.Id) ?? [])
                    {
                        if (saldosAntes.ContainsKey(componente))
                        {
                            vendidos[componente] = vendidos.GetValueOrDefault(componente) + (quantidade * porCombo);
                        }
                    }
                }
            }

            var forma = formas[i % formas.Length];
            await PagarAsync(pdv, venda, estado, forma);
            porForma[forma] = porForma.GetValueOrDefault(forma) + 1;
            tempos.Add(t.Elapsed.TotalMilliseconds);
            if (!sangria && i >= quantasVendas / 2)
            {
                await RoteiroE2E.SangriaAsync(pdv, venda, "50", "GERENTE");
                sangria = true;
            }
        }

        // 4. Fechamento cego contando a gaveta estimada; o outbox esvazia.
        var gaveta = await pdv.Servicos.GetRequiredService<RepositorioCaixa>().DinheiroGavetaAsync(sessao) ?? 0m;
        await RoteiroE2E.FecharCaixaAsync(pdv, gaveta.ToString("0.00", PtBr));
        var sync = pdv.Servicos.GetRequiredService<IServicoSincronizacao>();
        var esvaziar = Stopwatch.StartNew();
        await RoteiroE2E.EsperarAsync(() => Task.FromResult(sync.Situacao is { Online: true, Pendentes: 0 }), "outbox vazio", TimeSpan.FromMinutes(5));
        esvaziar.Stop();
        decimal totalLocal;
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            totalLocal = (await db.Vendas.Where(v => v.SessaoCaixaId == sessao && v.Status == "finalizada").Select(v => v.Total).ToListAsync()).Sum();
        }

        // 5. O ERP confere pelas próprias consultas (a loja de ensaio é de treino, O10: filtro "somente").
        var vendasErp = await erp.ObterAsync($"api/vendas?sessaoCaixaId={sessao:D}&treino=somente&tamanho=20");
        var nuvem = (Quantidade: vendasErp["totais"]!["quantidade"]!.GetValue<int>(), Total: RoteiroE2E.Decimal(vendasErp["totais"]!["totalLiquido"]));
        var sessaoErp = await erp.ObterAsync($"api/sessoes-caixa/{sessao:D}");
        var comErro = (await erp.ObterAsync($"api/terminais/{terminal:D}/eventos-erro"))["total"]!.GetValue<int>();
        var estoqueErrado = new List<string>();
        foreach (var (id, quantidade) in vendidos)
        {
            var a = estado.Amostra.First(x => x.Id == id);
            var depois = await SaldoAsync(erp, estado, a);
            if (saldosAntes[id] - depois != quantidade)
            {
                estoqueErrado.Add($"{a.Tipo}: esperado -{quantidade}, veio {depois - saldosAntes[id]}");
            }
        }

        var prontidao = await erp.ObterAsync($"api/implantacao/prontidao?lojaId={estado.LojaId:D}");
        var itensProntidao = prontidao["itens"]!.AsArray().Select(x => (Codigo: x!["codigo"]!.GetValue<string>(), Situacao: x["situacao"]!.GetValue<string>())).ToList();

        var relatorio = new
        {
            teste = "Ensaio do piloto com o catálogo real (implantação I5)",
            quando = DateTimeOffset.UtcNow,
            importacao = estado.Importacao,
            catalogoNuvem = estado.Catalogo,
            amostra = estado.Amostra.GroupBy(a => a.Tipo).ToDictionary(g => g.Key, g => g.Count()),
            cargaInicial = new
            {
                segundosAtivacaoECarga = Math.Round(carga.Elapsed.TotalSeconds, 1),
                tamanhoBancoMb = Math.Round(tamanhoBanco / 1048576d, 2),
                produtosLocais,
                ativosLocais,
                codigosLocais,
            },
            busca = new { porCodigo = Estatistica(buscaCodigo), porTexto = Estatistica(buscaTexto) },
            vendas = new
            {
                quantidade = quantasVendas,
                itens,
                porForma,
                porVendaMs = Estatistica(tempos),
                observacao = "Do primeiro item bipado à venda finalizada, pelo teclado simulado (inclui o pagamento e, no PIX, a liberação do gerente).",
            },
            fechamento = new { segundosAteEsvaziarOutbox = Math.Round(esvaziar.Elapsed.TotalSeconds, 1) },
            erp = new
            {
                vendas = nuvem.Quantidade,
                totalConfere = nuvem.Total == totalLocal,
                sessao = sessaoErp["situacao"]!.GetValue<string>(),
                eventosComErro = comErro,
                produtosConferidosNoEstoque = vendidos.Count,
                estoqueDivergente = estoqueErrado.Count,
            },
            prontidao = new
            {
                pronta = prontidao["pronta"]!.GetValue<bool>(),
                resumo = prontidao["resumo"],
                avisos = itensProntidao.Where(x => x.Situacao == "aviso").Select(x => x.Codigo).ToList(),
                faltas = itensProntidao.Where(x => x.Situacao == "falta").Select(x => x.Codigo).ToList(),
            },
        };
        if (Environment.GetEnvironmentVariable("GENESIS_ENSAIO_RELATORIO") is { Length: > 0 } caminho)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(caminho))!);
            await File.WriteAllTextAsync(caminho, JsonSerializer.Serialize(relatorio, new JsonSerializerOptions { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
        }

        Assert.Equal((estado.Catalogo.Produtos, estado.Catalogo.Ativos), (produtosLocais, ativosLocais));
        Assert.Equal((quantasVendas, totalLocal), nuvem);
        Assert.Equal("fechada", relatorio.erp.sessao);
        Assert.Equal(0, comErro);
        Assert.Empty(estoqueErrado);
        Assert.Empty(relatorio.prontidao.faltas);
        Assert.True(relatorio.prontidao.pronta);
    }

    /// <summary>F10 e a forma: dinheiro exato, PIX com o pagador e o horário e a liberação do gerente, ou o cartão com a bandeira.</summary>
    private static async Task PagarAsync(AmbienteUi pdv, VendaViewModel venda, EstadoEnsaio estado, string tipo)
    {
        if (tipo == "dinheiro")
        {
            await RoteiroE2E.PagarEmDinheiroAsync(pdv, venda);
            return;
        }

        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        var indice = pagamento.Formas.ToList().FindIndex(f => f.Forma.TipoForma == tipo && !f.Forma.PermiteParcelar);
        Assert.True(indice >= 0, $"forma {tipo} na loja");
        pagamento.EscolherFormaCommand.Execute((indice + 1).ToString(CultureInfo.InvariantCulture));
        pagamento.ValorRecebido = pagamento.FaltaTexto;
        pdv.Tecla(Key.Enter);
        if (tipo == "pix")
        {
            await pdv.EsperarFocoAsync("CampoPagadorPix");
            var pix = Assert.IsType<DialogoPixViewModel>(venda.Dialogo);
            Assert.NotNull(pix.Qr);
            pix.PagadorNome = "CLIENTE ENSAIO";
            var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
            pix.Horario = TimeZoneInfo.ConvertTime(servico.Agora, servico.Fuso).ToString("HH:mm", CultureInfo.InvariantCulture);
            pdv.Tecla(Key.Enter);
            await pdv.EsperarFocoAsync("CampoSupervisor");
            var liberacao = Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
            liberacao.Pedido.Usuario = estado.Gerente.Login;
            liberacao.Pedido.Pin = estado.Gerente.Pin;
            liberacao.Pedido.Motivo = "PIX conferido no extrato da loja";
            pdv.Tecla(Key.Enter);
        }
        else
        {
            await pdv.EsperarFocoAsync("CampoBandeira");
            var pos = Assert.IsType<DialogoPosViewModel>(venda.Dialogo);
            pos.Bandeira = "1";
            pdv.Tecla(Key.Enter);
        }

        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, $"venda finalizada em {tipo} ({pagamento.Erro})", 30_000);
    }

    /// <summary>Saldo do produto no estoque da loja (soma dos tipos), pela consulta de saldos do ERP (9.3).</summary>
    private static async Task<decimal> SaldoAsync(ErpE2E erp, EstadoEnsaio estado, ItemAmostra a)
    {
        var pagina = await erp.ObterAsync(
            $"api/saldos-estoque?estoqueId={estado.EstoqueId:D}&nome={Uri.EscapeDataString(a.Codigo)}&situacao=todos&tamanho=50");
        return pagina["itens"]!.AsArray()
            .Where(i => i!["produtoId"]!.GetValue<string>() == a.Id.ToString("D"))
            .Sum(i => decimal.Parse(i!["quantidade"]!.GetValue<string>(), CultureInfo.InvariantCulture));
    }

    private static object Estatistica(List<double> ms)
    {
        if (ms.Count == 0)
        {
            return new { amostras = 0 };
        }

        var ordenado = ms.Order().ToList();
        double Percentil(double p) => ordenado[Math.Min(ordenado.Count - 1, (int)Math.Ceiling(p * ordenado.Count) - 1)];
        return new
        {
            amostras = ms.Count,
            p50Ms = Math.Round(Percentil(0.50), 1),
            p95Ms = Math.Round(Percentil(0.95), 1),
            maxMs = Math.Round(ordenado[^1], 1),
        };
    }
}

/// <summary>Estado gravado pelo <c>ensaio-piloto.ts</c> em <c>GENESIS_ENSAIO_ESTADO</c> (fica na pasta temporária do script).</summary>
public sealed record EstadoEnsaio(
    [property: JsonPropertyName("api")] string Api,
    [property: JsonPropertyName("codigoEmpresa")] int CodigoEmpresa,
    [property: JsonPropertyName("erp")] CredencialErp Erp,
    [property: JsonPropertyName("operador")] OperadorE2E Operador,
    [property: JsonPropertyName("gerente")] OperadorE2E Gerente,
    [property: JsonPropertyName("lojaId")] Guid LojaId,
    [property: JsonPropertyName("estoqueId")] Guid EstoqueId,
    [property: JsonPropertyName("caixaId")] Guid CaixaId,
    [property: JsonPropertyName("importacao")] JsonObject Importacao,
    [property: JsonPropertyName("catalogo")] CatalogoEnsaio Catalogo,
    [property: JsonPropertyName("amostra")] IReadOnlyList<ItemAmostra> Amostra)
{
    public static async Task<EstadoEnsaio> CarregarAsync(TimeSpan limite)
    {
        var arquivo = Environment.GetEnvironmentVariable(EnsaioPilotoTests.VariavelEstado)
                      ?? throw new InvalidOperationException($"Defina {EnsaioPilotoTests.VariavelEstado} (use apps/api/test/e2e-pdv/ensaio-piloto.sh).");
        var fim = DateTime.UtcNow + limite;
        while (!File.Exists(arquivo))
        {
            if (DateTime.UtcNow > fim)
            {
                throw new TimeoutException($"O servidor do ensaio não gravou {arquivo} em {limite.TotalSeconds:0} s.");
            }

            await Task.Delay(250);
        }

        var estado = JsonSerializer.Deserialize<EstadoEnsaio>(await File.ReadAllTextAsync(arquivo))!;
        Assert.NotEmpty(estado.Amostra);
        return estado;
    }
}

public sealed record CatalogoEnsaio(
    [property: JsonPropertyName("produtos")] int Produtos,
    [property: JsonPropertyName("ativos")] int Ativos,
    [property: JsonPropertyName("com_preco")] int ComPreco,
    [property: JsonPropertyName("codigos")] int Codigos);

/// <summary>Produto vendável da amostra: o código de venda que só ele tem e o tipo (unidade, fardo, fracionado, combo).</summary>
public sealed record ItemAmostra(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("codigo")] string Codigo,
    [property: JsonPropertyName("tipo")] string Tipo,
    [property: JsonPropertyName("preco")] string Preco);
