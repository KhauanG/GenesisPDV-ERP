using System.Diagnostics;
using System.Text;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.Extensions.Logging;
using Serilog.Extensions.Logging;

namespace GenesisPDV.App.Tests;

/// <summary>
/// O leitor do arquivo técnico da aba 5 Logs e ocorrências (Central do PDV, bloco G8; plano 5.5; README › decisão 73):
/// lê com o Serilog escrevendo (o arquivo do dia aberto), junta a exceção de várias linhas ao registro dela, aceita os dois
/// formatos (com e sem o código do terminal), lê o arquivo de 20 MB pelo final sem carregar tudo, pagina pelo cursor (os
/// arquivos <c>_001</c> do mesmo dia inclusive) sem repetir nem pular, não quebra acento entre os blocos e mostra tudo
/// mascarado (procurar um segredo não acha a linha onde ele foi escondido).
/// </summary>
public sealed class LeitorLogArquivoTests : IDisposable
{
    private readonly string _raiz = Path.Combine(Path.GetTempPath(), "genesispdv-leitor-log", Guid.NewGuid().ToString("N"));

    public LeitorLogArquivoTests()
    {
        Caminhos = CaminhosPdv.SobRaiz(_raiz);
        Caminhos.CriarPastas();
    }

    private CaminhosPdv Caminhos { get; }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        try
        {
            Directory.Delete(_raiz, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private string Arquivo(string nome) => Path.Combine(Caminhos.PastaLogs, nome);

    /// <summary>Uma linha no modelo do <see cref="ConfiguracaoLog.Modelo"/> (com ou sem o código do terminal).</summary>
    private static string Linha(DateTimeOffset quando, string nivel, string mensagem, string? terminal = "cx2-9f3a01bc ", string categoria = "GenesisPDV.App.Teste") =>
        $"{quando:yyyy-MM-dd HH:mm:ss.fff zzz} [{nivel}] {terminal}{categoria} {mensagem}";

    [Fact]
    public void Le_o_arquivo_do_dia_com_o_serilog_escrevendo_e_junta_a_excecao_ao_registro()
    {
        var terminal = new EnriquecedorTerminal();
        using var serilog = ConfiguracaoLog.Criar(Caminhos.PastaLogs, terminal, "0.0.0-teste").CreateLogger();
        using var fabrica = new SerilogLoggerFactory(serilog);
        var log = fabrica.CreateLogger("GenesisPDV.App.Servicos.ServicoImpressao");
        // Antes da identidade, o formato de antes (sem o código do terminal); depois, com ele (decisão 67).
        log.LogInformation("Caixa abrindo");
        terminal.Definir(new IdentidadeTerminal { TerminalId = Guid.Parse("019a0b3c-7d2e-7f00-8a1b-2c3d9f3a01bc"), NumeroCaixa = 2 });
        log.LogWarning("Documento {Tipo} não impresso", "cupom");
        try
        {
            throw new InvalidOperationException("A impressora não respondeu (Bearer abc.def.ghi)");
        }
        catch (InvalidOperationException e)
        {
            log.LogError(e, "Falha ao imprimir o cupom da venda 4512");
        }

        log.LogInformation("Depois da falha");

        // O Serilog continua com o arquivo aberto: o leitor abre com FileShare.ReadWrite.
        var leitor = new LeitorLogArquivo(Caminhos);
        var dia = Assert.Single(leitor.Dias());
        Assert.Equal(DateOnly.FromDateTime(DateTime.Now), dia.Dia);
        var pagina = leitor.Ler(dia, new FiltroLogArquivo(), ct: Ct);
        Assert.Null(pagina.Proxima);
        Assert.Equal(["Depois da falha", "Falha ao imprimir o cupom da venda 4512", "Documento cupom não impresso", "Caixa abrindo"],
            pagina.Registros.Select(r => r.Mensagem));
        var erro = pagina.Registros[1];
        Assert.Equal((NiveisOcorrencia.Erro, "ERR", "cx2-9f3a01bc", "GenesisPDV.App.Servicos.ServicoImpressao"), (erro.Nivel, erro.NivelArquivo, erro.Terminal, erro.Categoria));
        // A exceção (o tipo e a pilha) está no registro, mascarada.
        Assert.True(erro.TemDetalhe);
        Assert.Contains("System.InvalidOperationException: A impressora não respondeu", erro.Texto, StringComparison.Ordinal);
        Assert.Contains("   at ", erro.Texto, StringComparison.Ordinal);
        Assert.DoesNotContain("abc.def.ghi", erro.Texto, StringComparison.Ordinal);
        Assert.Null(pagina.Registros[3].Terminal);
        Assert.Equal("aviso", pagina.Registros[2].Nivel);

        // Os filtros: o nível mínimo e o texto (sem acento nem maiúscula), também na exceção.
        Assert.Equal(["Falha ao imprimir o cupom da venda 4512", "Documento cupom não impresso"],
            leitor.Ler(dia, new FiltroLogArquivo(NiveisOcorrencia.Aviso), ct: Ct).Registros.Select(r => r.Mensagem));
        Assert.Equal(["Falha ao imprimir o cupom da venda 4512"], leitor.Ler(dia, new FiltroLogArquivo(Texto: "NAO RESPONDEU"), ct: Ct).Registros.Select(r => r.Mensagem));
        // O segredo mascarado não é achado pela busca (procurar o token não revela a linha onde ele estava).
        Assert.Empty(leitor.Ler(dia, new FiltroLogArquivo(Texto: "abc.def.ghi"), ct: Ct).Registros);
    }

    [Fact]
    public void Arquivo_de_20_mb_e_lido_pelo_final_sem_carregar_tudo()
    {
        var hora = new DateTimeOffset(2026, 11, 4, 8, 0, 0, TimeSpan.FromHours(-3));
        var caminho = Arquivo("genesispdv-20261104.log");
        long linhas = 0;
        using (var escrita = new StreamWriter(caminho, false, new UTF8Encoding(false)))
        {
            escrita.WriteLine(Linha(hora, "ERR", "O erro procurado lá do começo do dia"));
            escrita.WriteLine("System.TimeoutException: tempo esgotado");
            while (escrita.BaseStream.Length < ConfiguracaoLog.TamanhoMaximoArquivo - 4096)
            {
                linhas++;
                escrita.WriteLine(Linha(hora.AddMilliseconds(linhas), "INF", $"Sync: heartbeat {linhas} sem novidade, ação ok"));
            }

            escrita.WriteLine(Linha(hora.AddHours(10), "WRN", "A última do dia"));
        }

        Assert.InRange(new FileInfo(caminho).Length, 19L * 1024 * 1024, ConfiguracaoLog.TamanhoMaximoArquivo);
        var leitor = new LeitorLogArquivo(Caminhos);
        var dia = Assert.Single(leitor.Dias());
        var cronometro = Stopwatch.StartNew();
        var pagina = leitor.Ler(dia, new FiltroLogArquivo(), ct: Ct);
        cronometro.Stop();
        Assert.Equal(LeitorLogArquivo.TamanhoPagina, pagina.Registros.Count);
        Assert.Equal("A última do dia", pagina.Registros[0].Mensagem);
        Assert.NotNull(pagina.Proxima);
        // Só os últimos blocos saíram do disco (50 linhas de ~110 bytes), não os 20 MB.
        Assert.True(pagina.BytesLidos <= 2 * LeitorLogArquivo.TamanhoBloco, $"leu {pagina.BytesLidos} bytes");
        Assert.True(cronometro.ElapsedMilliseconds < 1_000, $"{cronometro.ElapsedMilliseconds} ms");

        // O filtro que só acha o começo: a página para no orçamento (parcial) e o PgDn continua dali até achar.
        var filtro = new FiltroLogArquivo(NiveisOcorrencia.Erro);
        var parcial = leitor.Ler(dia, filtro, ct: Ct);
        Assert.True(parcial.Parcial);
        Assert.Empty(parcial.Registros);
        Assert.InRange(parcial.BytesLidos, LeitorLogArquivo.OrcamentoPorPagina, LeitorLogArquivo.OrcamentoPorPagina + LeitorLogArquivo.TamanhoBloco);
        var achou = parcial;
        var paginas = 1;
        while (achou.Registros.Count == 0 && achou.Proxima is not null)
        {
            achou = leitor.Ler(dia, filtro, achou.Proxima, ct: Ct);
            paginas++;
        }

        Assert.Equal(3, paginas);
        var registro = Assert.Single(achou.Registros);
        Assert.Equal("O erro procurado lá do começo do dia", registro.Mensagem);
        Assert.Contains("System.TimeoutException: tempo esgotado", registro.Texto, StringComparison.Ordinal);
        Assert.Null(achou.Proxima);
    }

    [Fact]
    public void Pagina_pelo_cursor_entre_os_arquivos_do_dia_sem_repetir_nem_pular_e_sem_quebrar_acento_entre_blocos()
    {
        // O dia com o arquivo cheio (o primeiro) e o _001 (o mais novo), como o Serilog faz no limite de tamanho.
        var hora = new DateTimeOffset(2026, 11, 3, 9, 0, 0, TimeSpan.FromHours(-3));
        var esperadas = new List<string>();
        var n = 0;
        foreach (var nome in new[] { "genesispdv-20261103.log", "genesispdv-20261103_001.log" })
        {
            var texto = new StringBuilder();
            for (var i = 0; i < 40; i++, n++)
            {
                var mensagem = $"ação nº {n:000} — impressão ção ã é ü";
                esperadas.Add(mensagem);
                texto.Append(Linha(hora.AddSeconds(n), n % 5 == 0 ? "ERR" : "INF", mensagem, terminal: n % 2 == 0 ? null : "cx2-9f3a01bc ")).Append("\r\n");
                if (n % 5 == 0)
                {
                    texto.Append("System.Exception: falhou ção\r\n   at GenesisPDV.Teste.Metodo() in C:\\Users\\fulano\\src\\x.cs:line 1\r\n");
                }
            }

            File.WriteAllText(Arquivo(nome), texto.ToString(), new UTF8Encoding(false));
        }

        // Um dia mais antigo e um arquivo que não é do Serilog ficam de fora do dia escolhido.
        File.WriteAllText(Arquivo("genesispdv-20261102.log"), Linha(hora.AddDays(-1), "INF", "outro dia") + "\n");
        File.WriteAllText(Arquivo("anotacoes.log"), "nada\n");
        var leitor = new LeitorLogArquivo(Caminhos);
        var dias = leitor.Dias();
        Assert.Equal([new DateOnly(2026, 11, 3), new DateOnly(2026, 11, 2)], dias.Select(d => d.Dia));
        Assert.Equal([1, 0], dias[0].Arquivos.Select(a => a.Parte));
        esperadas.Reverse();

        // Blocos pequenos (17 bytes): as linhas e os acentos atravessam as fronteiras dos blocos.
        foreach (var bloco in new[] { 17, 64, LeitorLogArquivo.TamanhoBloco })
        {
            var vistas = new List<RegistroLog>();
            CursorLog? cursor = null;
            do
            {
                var pagina = leitor.Ler(dias[0], new FiltroLogArquivo(), cursor, tamanho: 7, ct: Ct, bloco: bloco);
                vistas.AddRange(pagina.Registros);
                cursor = pagina.Proxima;
            }
            while (cursor is not null);

            Assert.Equal(esperadas, vistas.Select(r => r.Mensagem));
            var comExcecao = vistas.Where(r => r.TemDetalhe).ToList();
            Assert.Equal(16, comExcecao.Count);
            Assert.All(comExcecao, r =>
            {
                Assert.Equal(NiveisOcorrencia.Erro, r.Nivel);
                Assert.Equal(2, r.LinhasExtras);
                // A pasta do perfil do Windows na pilha vira %USERPROFILE% (MascaradorSuporte).
                Assert.Contains(@"%USERPROFILE%\src\x.cs", r.Texto, StringComparison.Ordinal);
                Assert.DoesNotContain("\r", r.Texto, StringComparison.Ordinal);
            });
        }
    }

    [Fact]
    public void Cursor_continua_no_mesmo_arquivo_quando_o_serilog_abre_o_001_entre_as_paginas()
    {
        // Na 3ª página do dia de hoje o arquivo passa dos 20 MB e o Serilog abre o _001; o F5 relê a lista dos dias, que
        // agora começa pelo _001. O cursor é a parte do arquivo, não a posição na lista: a página segue no arquivo de antes.
        var hora = new DateTimeOffset(2026, 11, 5, 9, 0, 0, TimeSpan.FromHours(-3));
        File.WriteAllText(Arquivo("genesispdv-20261105.log"),
            string.Concat(Enumerable.Range(0, 30).Select(i => Linha(hora.AddSeconds(i), "INF", $"antigo {i:00}") + "\n")), new UTF8Encoding(false));
        var leitor = new LeitorLogArquivo(Caminhos);
        var primeira = leitor.Ler(leitor.Dias()[0], new FiltroLogArquivo(), tamanho: 10, ct: Ct);
        var segunda = leitor.Ler(leitor.Dias()[0], new FiltroLogArquivo(), primeira.Proxima, tamanho: 10, ct: Ct);
        Assert.Equal("antigo 10", segunda.Registros[^1].Mensagem);

        File.WriteAllText(Arquivo("genesispdv-20261105_001.log"),
            string.Concat(Enumerable.Range(0, 30).Select(i => Linha(hora.AddMinutes(10).AddSeconds(i), "INF", $"novo {i:00}") + "\n")), new UTF8Encoding(false));
        var dia = leitor.Dias()[0];
        Assert.Equal([1, 0], dia.Arquivos.Select(a => a.Parte));
        // O F5 da 2ª página (o começo dela) e o PgDn da 2ª: os mesmos registros do arquivo de antes, nada do _001.
        Assert.Equal(segunda.Registros.Select(r => r.Mensagem), leitor.Ler(dia, new FiltroLogArquivo(), primeira.Proxima, tamanho: 10, ct: Ct).Registros.Select(r => r.Mensagem));
        var terceira = leitor.Ler(dia, new FiltroLogArquivo(), segunda.Proxima, tamanho: 10, ct: Ct);
        Assert.Equal([.. Enumerable.Range(0, 10).Select(i => $"antigo {9 - i:00}")], terceira.Registros.Select(r => r.Mensagem));
        Assert.Empty(leitor.Ler(dia, new FiltroLogArquivo(), terceira.Proxima, tamanho: 10, ct: Ct).Registros);

        // A parte do cursor que sumiu (o _001 apagado): continua do fim da seguinte, mais antiga, sem erro.
        Assert.Equal(["antigo 29", "antigo 28", "antigo 27"],
            leitor.Ler(dia with { Arquivos = [dia.Arquivos[1]] }, new FiltroLogArquivo(), new CursorLog(1, 50), tamanho: 3, ct: Ct).Registros.Select(r => r.Mensagem));
    }

    [Fact]
    public void Linha_solta_no_comeco_do_arquivo_e_cpf_pontuado_mascarado()
    {
        var hora = new DateTimeOffset(2026, 11, 5, 9, 0, 0, TimeSpan.FromHours(-3));
        File.WriteAllText(Arquivo("genesispdv-20261105.log"),
            "   at continuação de um registro do arquivo anterior\n"
            + Linha(hora, "INF", "Cliente 123.456.789-09 identificado na nota") + "\n"
            + Linha(hora.AddSeconds(1), "WRN", "Sem fim de linha", terminal: null),
            new UTF8Encoding(false));
        var leitor = new LeitorLogArquivo(Caminhos);
        var pagina = leitor.Ler(Assert.Single(leitor.Dias()), new FiltroLogArquivo(), ct: Ct);
        Assert.Equal(3, pagina.Registros.Count);
        Assert.Equal("Sem fim de linha", pagina.Registros[0].Mensagem);
        Assert.DoesNotContain("123.456.789-09", pagina.Registros[1].Mensagem, StringComparison.Ordinal);
        Assert.DoesNotContain("123.456.789-09", pagina.Registros[1].Texto, StringComparison.Ordinal);
        var solta = pagina.Registros[2];
        Assert.Null(solta.Quando);
        Assert.Equal(NiveisOcorrencia.Info, solta.Nivel);
        Assert.Contains("continuação", solta.Texto, StringComparison.Ordinal);
        Assert.Empty(leitor.Ler(leitor.Dias()[0], new FiltroLogArquivo(Texto: "123.456.789-09"), ct: Ct).Registros);
        Assert.Empty(new LeitorLogArquivo(CaminhosPdv.SobRaiz(Path.Combine(_raiz, "sem-logs-nem-pasta"))).Dias());
    }
}
