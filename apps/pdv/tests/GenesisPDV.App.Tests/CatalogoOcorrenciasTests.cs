using System.Reflection;
using System.Text.RegularExpressions;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Data.Repositorios;

namespace GenesisPDV.App.Tests;

/// <summary>
/// As ocorrências do <c>log_local</c> (Central do PDV, bloco G8; plano 5.5; README › decisão 73): todo
/// <see cref="CodigoOcorrencia"/> tem a dica no <see cref="CatalogoOcorrencias"/> (código novo sem dica quebra aqui), toda
/// origem do filtro tem código, e nenhum ponto de gravação do código cria a linha à mão (todos passam pelo
/// <see cref="Ocorrencias.Nova"/>, que põe o código e a origem padronizada).
/// </summary>
public partial class CatalogoOcorrenciasTests
{
    [Fact]
    public void Todo_codigo_gravado_tem_dica_no_catalogo()
    {
        // Os códigos pela reflexão (não pela lista Todos, que alguém pode esquecer de atualizar).
        var porReflexao = typeof(CodigoOcorrencia).GetProperties(BindingFlags.Public | BindingFlags.Static)
            .Where(p => p.PropertyType == typeof(CodigoOcorrencia))
            .Select(p => (CodigoOcorrencia)p.GetValue(null)!)
            .ToList();
        Assert.Equal(porReflexao.Select(c => c.Codigo).Order(StringComparer.Ordinal), CodigoOcorrencia.Todos.Select(c => c.Codigo).Order(StringComparer.Ordinal));
        Assert.Equal(porReflexao.Count, porReflexao.Select(c => c.Codigo).Distinct().Count());
        Assert.Equal(porReflexao.Select(c => c.Codigo).Order(StringComparer.Ordinal), CatalogoOcorrencias.Codigos.Order(StringComparer.Ordinal));
        Assert.All(porReflexao, c =>
        {
            var dica = CatalogoOcorrencias.Dica(c.Codigo, c.Origem);
            Assert.False(string.IsNullOrWhiteSpace(dica.Titulo));
            Assert.True(dica.OQueFazer.Length >= 20, $"{c.Codigo}: dica curta demais");
            Assert.Contains(c.Origem, OrigensOcorrencia.Todas);
        });

        // Toda origem do filtro tem algum código (nenhuma opção morta) e uma dica para as linhas de antes do G8.
        Assert.All(OrigensOcorrencia.Todas, o =>
        {
            Assert.Contains(porReflexao, c => c.Origem == o);
            Assert.NotEqual(o, CatalogoOcorrencias.RotuloOrigem(o));
        });

        // A linha de antes do G8: sem código, pela origem (o "app" é o sistema).
        Assert.Equal(CatalogoOcorrencias.Dica(CodigoOcorrencia.ErroInesperado.Codigo, null), CatalogoOcorrencias.Dica(null, OrigensOcorrencia.Legado));
        Assert.Equal("Sistema", CatalogoOcorrencias.RotuloOrigem(OrigensOcorrencia.Legado));
        Assert.Equal("Ocorrência", CatalogoOcorrencias.Dica("CODIGO_DE_OUTRA_VERSAO", "origem_nova").Titulo);
        Assert.Equal("ERRO", CatalogoOcorrencias.RotuloNivel(NiveisOcorrencia.Erro));
    }

    [Fact]
    public void Nenhum_ponto_de_gravacao_cria_a_linha_do_log_local_a_mao()
    {
        var raiz = Path.Combine(ChavesTerminalTests.PastaPdv(), "src");
        var achados = Directory.EnumerateFiles(raiz, "*.cs", SearchOption.AllDirectories)
            .Where(a => !a.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                        && !a.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                        && !a.Contains($"{Path.DirectorySeparatorChar}Migracoes{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                        && Path.GetFileName(a) != "OcorrenciasLocais.cs")
            .SelectMany(a => File.ReadLines(a).Select((linha, i) => (Arquivo: Path.GetRelativePath(raiz, a), Linha: i + 1, Texto: linha)))
            .Where(l => CriacaoAMao().IsMatch(l.Texto))
            .Select(l => $"{l.Arquivo}:{l.Linha}: {l.Texto.Trim()}")
            .ToList();
        Assert.Empty(achados);
    }

    [Fact]
    public void Todo_documento_impresso_tem_nome_legivel_na_ocorrencia()
    {
        // Os tipos da fila escritos no código (as chamadas do ImprimirAsync), o "cupom" do emissor não fiscal e a 2ª via.
        var raiz = Path.Combine(ChavesTerminalTests.PastaPdv(), "src");
        var tipos = Directory.EnumerateFiles(raiz, "*.cs", SearchOption.AllDirectories)
            .Where(a => !a.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                        && !a.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .SelectMany(File.ReadLines)
            .Where(l => l.Contains("ImprimirAsync(", StringComparison.Ordinal))
            .SelectMany(l => TipoDocumento().Matches(l).Select(m => m.Groups["tipo"].Value))
            .Append("cupom")
            .Append(ServicoHistoricoCaixas.DocumentoReimpressao)
            .Distinct(StringComparer.Ordinal)
            .ToList();
        Assert.Contains("cobranca_pix", tipos);
        Assert.Contains("sangria", tipos);
        // "O que aconteceu" da aba 5 em português de balcão: nada de "Cobranca pix" nem de "Fechamento caixa".
        Assert.All(tipos, t =>
        {
            var nome = ServicoImpressao.NomeDocumento(t);
            Assert.NotEqual("Documento", nome);
            Assert.DoesNotContain('_', nome);
        });
        Assert.Equal("QR do PIX", ServicoImpressao.NomeDocumento("cobranca_pix"));
        Assert.Equal("Relatório de fechamento do caixa", ServicoImpressao.NomeDocumento("fechamento_caixa"));
        Assert.Equal("Documento", ServicoImpressao.NomeDocumento("tipo_de_outra_versao"));
    }

    /// <summary>O texto só de minúsculas e <c>_</c> numa chamada do <c>ImprimirAsync</c>: o tipo da fila.</summary>
    [GeneratedRegex(@"""(?<tipo>[a-z]+(?:_[a-z]+)*)""")]
    private static partial Regex TipoDocumento();

    /// <summary><c>new LogLocal</c>, o <c>new()</c> que devolve um <c>LogLocal</c> e o <c>RegistrarLogAsync</c> antigo.</summary>
    [GeneratedRegex(@"new\s+LogLocal\b|LogLocal\s+\w+\s*\([^)]*\)\s*=>\s*new\s*\(|\bRegistrarLogAsync\s*\(|\bOrigem\s*=\s*""")]
    private static partial Regex CriacaoAMao();
}
