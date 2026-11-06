using System.Text.Json.Nodes;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.Extensions.Logging.Abstractions;

namespace GenesisPDV.App.Tests;

/// <summary>
/// O <see cref="ServicoLogsCentral"/> da aba 5 Logs e ocorrências (Central do PDV, bloco G8; README › decisão 73), sem a
/// tela: os segredos do texto técnico, que fica dentro do JSON do <c>detalhes</c>, mascarados no detalhe e na busca (a
/// quebra de linha escapada e a aspa escapada não os deixam escapar); a busca sem diferença de acento nem de maiúscula e
/// pelo título da dica, como no arquivo técnico; a página que a conferência depois da máscara esvaziaria, completada do
/// banco (e o termo escondido que não deixa o PgDn aceso); e os períodos pelo dia da loja com a máquina em outro fuso.
/// </summary>
public sealed class ServicoLogsCentralTests : IDisposable
{
    /// <summary>"Agora": 05/11/2026 02:30 UTC — ainda 04/11 em São Paulo (23:30), já 05/11 em Tóquio (11:30).</summary>
    private static readonly DateTimeOffset Agora = new(2026, 11, 5, 11, 30, 0, TimeSpan.FromHours(9));

    private readonly string _raiz = Path.Combine(Path.GetTempPath(), "genesispdv-logs-central", Guid.NewGuid().ToString("N"));
    private readonly FabricaPdvDb _fabrica;
    private readonly Relogio _relogio = new() { Agora = Agora };
    private readonly ServicoLogsCentral _servico;

    public ServicoLogsCentralTests()
    {
        var caminhos = CaminhosPdv.SobRaiz(_raiz);
        caminhos.CriarPastas();
        _fabrica = new FabricaPdvDb(caminhos.ArquivoBanco);
        var acesso = new AcessoCentral(new SemAutenticador(), new RepositorioTerminal(_fabrica, _relogio), _relogio, NullLogger<AcessoCentral>.Instance);
        acesso.AbrirPelaVenda(new Operador(
            Guid.CreateVersion7(), 3, "ana", "ANA", 0m,
            Permissoes: new HashSet<string>([.. PermissoesPdv.PerfilOperador, PermissoesPdv.VerDiagnostico], StringComparer.Ordinal)));
        _servico = new ServicoLogsCentral(new ConsultasLogLocal(_fabrica), new LeitorLogArquivo(caminhos), acesso, new SessaoTerminal(), _relogio);
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try
        {
            Directory.Delete(_raiz, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private async Task GravarAsync(params LogLocal[] linhas)
    {
        await InicializadorBanco.InicializarAsync(_fabrica, Path.Combine(_raiz, "backup"), _relogio.Agora, Ct);
        await using var db = _fabrica.CreateDbContext();
        db.LogLocal.AddRange(linhas);
        await db.SaveChangesAsync(Ct);
    }

    private async Task<List<string>> MensagensAsync(string texto, PeriodoOcorrencias periodo = PeriodoOcorrencias.Tudo)
    {
        var (desde, ate) = _servico.Intervalo(periodo);
        return [.. (await _servico.OcorrenciasAsync(new FiltroOcorrencias(Desde: desde, Ate: ate, Texto: texto), ct: Ct)).Ocorrencias.Select(o => o.Mensagem)];
    }

    [Fact]
    public async Task Segredos_do_texto_tecnico_no_json_ficam_mascarados_no_detalhe_e_na_busca()
    {
        // A exceção como o ShellViewModel grava (o ToString(), com quebras de linha de verdade), com segredos plantados:
        // depois de uma quebra (vira "\n" no JSON), entre aspas (vira \"…\"), logo no começo do texto e num dado.
        var bruto = "token: \"tok123secret\" recusado\n"
                    + "System.InvalidOperationException: falhou\nsenha=abc123\nBearer tok.en.xyz\ntoken: segredo99\n"
                    + "falhou com token: \"tok999\" e senha=\"s3gr3do\" e pin: 'x9x9'\n   at GenesisPDV.App.ShellViewModel.Tratar()";
        var linha = Ocorrencias.Nova(Agora.AddMinutes(-1), NiveisOcorrencia.Erro, CodigoOcorrencia.ErroInesperado, "Erro inesperado na tela",
            new JsonObject { ["access_token"] = "tok-dos-dados", ["cpf"] = 12345678909, ["venda_id"] = "019a-venda", ["pix_ativo"] = true }, bruto);
        await GravarAsync(linha);
        var segredos = new[] { "tok123secret", "abc123", "tok.en.xyz", "segredo99", "tok999", "s3gr3do", "x9x9", "tok-dos-dados", "12345678909" };

        var lista = Assert.Single((await _servico.OcorrenciasAsync(new FiltroOcorrencias(), ct: Ct)).Ocorrencias);
        var detalhe = (await _servico.OcorrenciaAsync(lista.Id, Ct))!;
        foreach (var o in new[] { lista, detalhe })
        {
            Assert.All(segredos, s => Assert.DoesNotContain(s, o.Detalhes, StringComparison.Ordinal));
            // O JSON continua inteiro (o detalhe da tela o abre): o texto técnico mascarado, os dados que não são segredo.
            var json = JsonNode.Parse(o.Detalhes!)!.AsObject();
            Assert.Equal(CodigoOcorrencia.ErroInesperado.Codigo, json["codigo"]!.GetValue<string>());
            Assert.Equal(("***", "***", "019a-venda", true),
                (json["access_token"]!.GetValue<string>(), json["cpf"]!.GetValue<string>(), json["venda_id"]!.GetValue<string>(), json["pix_ativo"]!.GetValue<bool>()));
            var texto = json["texto"]!.GetValue<string>();
            Assert.Contains("System.InvalidOperationException: falhou\nsenha=***\nBearer ***\ntoken: ***", texto, StringComparison.Ordinal);
            Assert.Contains("token: \"***\" e senha=\"***\" e pin: '***'", texto, StringComparison.Ordinal);
            Assert.StartsWith("token: \"***\" recusado", texto, StringComparison.Ordinal);
        }

        // Idempotente: mascarar o que já saiu mascarado não muda nada.
        Assert.Equal(detalhe.Detalhes, MascaradorSuporte.MascararDetalhes(detalhe.Detalhes));
        // A busca não "acha" o segredo onde ele foi escondido (nem pelo JSON escapado); acha o resto.
        foreach (var s in segredos)
        {
            Assert.Empty(await MensagensAsync(s));
        }

        Assert.Single(await MensagensAsync("ShellViewModel.Tratar"));
        Assert.Single(await MensagensAsync("falhou com token"));
        // A linha de antes do G8 (o texto solto, sem JSON) continua pela máscara do texto inteiro.
        Assert.Equal("senha=*** e Bearer ***", MascaradorSuporte.MascararDetalhes("senha=abc123 e Bearer tok.en.xyz"));
        Assert.Equal("{quebrado senha=***", MascaradorSuporte.MascararDetalhes("{quebrado senha=abc123"));
    }

    [Fact]
    public async Task Busca_sem_acento_nem_maiuscula_e_pelo_titulo_da_dica()
    {
        await GravarAsync(
            Ocorrencias.Nova(Agora.AddMinutes(-3), NiveisOcorrencia.Aviso, CodigoOcorrencia.BackupFalhou, "Backup (periodico) não foi feito: disco cheio"),
            Ocorrencias.Nova(Agora.AddMinutes(-2), NiveisOcorrencia.Aviso, CodigoOcorrencia.ImpressaoFalhou, "Cupom da venda não saiu na impressora: sem papel"),
            Ocorrencias.Nova(Agora.AddMinutes(-1), NiveisOcorrencia.Aviso, CodigoOcorrencia.GavetaFalhou, "A gaveta não abriu", texto: "Impressão da gaveta: ÇÃO"),
            // A linha de antes do G8, sem código: a dica (e o título) vêm da origem.
            new LogLocal { OcorridoEm = Agora.AddMinutes(-4), Nivel = NiveisOcorrencia.Aviso, Origem = OrigensOcorrencia.Impressora, Mensagem = "cupom antigo" });

        // Como no arquivo técnico: "nao" acha "não", "IMPRESSÃO" acha "impressão" (o LIKE do SQLite não faria nenhum dos dois);
        // as três mensagens com "não" e a linha antiga pelo título da dica ("Documento não impresso").
        Assert.Equal(4, (await MensagensAsync("nao")).Count);
        Assert.Equal(4, (await MensagensAsync("NÃO")).Count);
        Assert.Equal(["Cupom da venda não saiu na impressora: sem papel"], await MensagensAsync("IMPRESSORA: SEM"));
        Assert.Equal(["A gaveta não abriu"], await MensagensAsync("impressao da GAVETA"));
        Assert.Equal(["A gaveta não abriu"], await MensagensAsync("cao"));
        Assert.Equal(["Backup (periodico) não foi feito: disco cheio"], await MensagensAsync("periódico"));
        // O título da dica (a coluna "Resumo"), que a mensagem não tem: o do código e o da origem das linhas antigas.
        Assert.Equal(["Cupom da venda não saiu na impressora: sem papel", "cupom antigo"], await MensagensAsync("documento nao impresso"));
        Assert.Equal(["Backup (periodico) não foi feito: disco cheio"], await MensagensAsync("backup não feito"));
        Assert.Empty(await MensagensAsync("nada parecido"));
    }

    [Fact]
    public async Task Pagina_que_a_mascara_esvaziaria_e_completada_do_banco_sem_pular_nem_repetir()
    {
        // As 70 mais novas têm o termo só onde a máscara esconde (o token); as 55 mais antigas, à vista.
        await GravarAsync([
            .. Enumerable.Range(0, 55).Select(i => Ocorrencias.Nova(
                Agora.AddHours(-2).AddMinutes(-i), NiveisOcorrencia.Aviso, CodigoOcorrencia.ComandoFalhou, $"visível {i:00} no arquivo XYZSECRETO.log")),
            .. Enumerable.Range(0, 70).Select(i => Ocorrencias.Nova(
                Agora.AddMinutes(-i), NiveisOcorrencia.Aviso, CodigoOcorrencia.ComandoFalhou, $"escondida {i:00} token: XYZSECRETO")),
        ]);

        // A primeira página já vem cheia com as visíveis (antes vinha vazia, com o PgDn aceso); a segunda, o resto.
        var filtro = new FiltroOcorrencias(Texto: "xyzsecreto");
        var primeira = await _servico.OcorrenciasAsync(filtro, ct: Ct);
        Assert.Equal(ConsultasLogLocal.TamanhoPagina, primeira.Ocorrencias.Count);
        Assert.False(primeira.Parcial);
        Assert.Equal("visível 00 no arquivo XYZSECRETO.log", primeira.Ocorrencias[0].Mensagem);
        var segunda = await _servico.OcorrenciasAsync(filtro, primeira.Proxima, ct: Ct);
        Assert.Equal(5, segunda.Ocorrencias.Count);
        Assert.Null(segunda.Proxima);
        Assert.Equal(55, primeira.Ocorrencias.Concat(segunda.Ocorrencias).Select(o => o.Id).Distinct().Count());

        // O termo que só existe escondido: a mesma resposta do termo que não existe (sem PgDn aceso que denuncie).
        var escondido = await _servico.OcorrenciasAsync(new FiltroOcorrencias(Texto: "escondida 0"), ct: Ct);
        Assert.Equal(10, escondido.Ocorrencias.Count);
        var soEscondido = await _servico.OcorrenciasAsync(new FiltroOcorrencias(Texto: "token: XYZSECRETO"), ct: Ct);
        Assert.Equal((0, (CursorOcorrencias?)null, false), (soEscondido.Ocorrencias.Count, soEscondido.Proxima, soEscondido.Parcial));

        // Com o limite de leitura alcançado sem achar nada: a página parcial continua do ponto lido, sem pular nenhuma.
        var vistas = new List<long>();
        CursorOcorrencias? cursor = null;
        var parciais = 0;
        do
        {
            var pagina = await _servico.OcorrenciasAsync(filtro, cursor, Ct, limite: 50);
            parciais += pagina.Parcial ? 1 : 0;
            vistas.AddRange(pagina.Ocorrencias.Select(o => o.Id));
            cursor = pagina.Proxima;
        }
        while (cursor is not null);

        Assert.True(parciais >= 1);
        Assert.Equal(55, vistas.Count);
        Assert.Equal(55, vistas.Distinct().Count());
    }

    [Fact]
    public async Task Volume_de_um_ano_de_log_local_responde_rapido_e_a_busca_para_no_limite_de_leitura()
    {
        // Sem retenção do log_local (PC-11: só medir): 20 mil linhas, todas com o termo só onde a máscara esconde.
        await GravarAsync([.. Enumerable.Range(0, 20_000).Select(i => Ocorrencias.Nova(
            Agora.AddMinutes(-i * 26), i % 9 == 0 ? NiveisOcorrencia.Erro : NiveisOcorrencia.Aviso, CodigoOcorrencia.GavetaFalhou,
            $"A gaveta não abriu ({i}) token: VOLUMESECRETO", texto: "System.Exception: timeout\n   at GenesisPDV.Hardware.Gaveta.Abrir()"))]);

        // "Tudo" com um texto que não existe: o SQL percorre a tabela, sem trazer linha nenhuma para a memória.
        var relogio = System.Diagnostics.Stopwatch.StartNew();
        var nada = await _servico.OcorrenciasAsync(new FiltroOcorrencias(Texto: "zzqqxx"), ct: Ct);
        Assert.Equal((0, (CursorOcorrencias?)null), (nada.Ocorrencias.Count, nada.Proxima));
        // Todas pré-selecionadas, nenhuma à vista: a página para nas 2.000 lidas (parcial, o PgDn continua dali).
        var escondido = await _servico.OcorrenciasAsync(new FiltroOcorrencias(Texto: "volumesecreto"), ct: Ct);
        Assert.Equal((0, true), (escondido.Ocorrencias.Count, escondido.Parcial));
        Assert.NotNull(escondido.Proxima);
        // A primeira página sem texto e a de "só erros" dos 30 dias.
        Assert.Equal(ConsultasLogLocal.TamanhoPagina, (await _servico.OcorrenciasAsync(new FiltroOcorrencias(), ct: Ct)).Ocorrencias.Count);
        var (desde, _) = _servico.Intervalo(PeriodoOcorrencias.Ultimos30Dias);
        Assert.NotEmpty((await _servico.OcorrenciasAsync(new FiltroOcorrencias(NiveisOcorrencia.Erro, desde), ct: Ct)).Ocorrencias);
        relogio.Stop();
        // Folgado (outro fluxo pode rodar testes ao mesmo tempo nesta máquina); no caixa, bem menos de 1 s cada.
        Assert.True(relogio.Elapsed < TimeSpan.FromSeconds(10), $"As quatro consultas levaram {relogio.Elapsed}.");
    }

    [Fact]
    public void Periodos_pelo_dia_da_loja_com_a_maquina_em_outro_fuso()
    {
        // O relógio diz 11:30 em Tóquio (+09:00); na loja (São Paulo, -03:00) ainda é 04/11, 23:30.
        var saoPaulo = TimeSpan.FromHours(-3);
        Assert.Equal((new DateTimeOffset(2026, 11, 4, 0, 0, 0, saoPaulo), (DateTimeOffset?)null), _servico.Intervalo(PeriodoOcorrencias.Hoje));
        Assert.Equal(
            (new DateTimeOffset(2026, 11, 3, 0, 0, 0, saoPaulo), new DateTimeOffset(2026, 11, 4, 0, 0, 0, saoPaulo)),
            _servico.Intervalo(PeriodoOcorrencias.Ontem));
        Assert.Equal(new DateTimeOffset(2026, 10, 29, 0, 0, 0, saoPaulo), _servico.Intervalo(PeriodoOcorrencias.Ultimos7Dias).Desde);
        Assert.Equal(new DateTimeOffset(2026, 10, 6, 0, 0, 0, saoPaulo), _servico.Intervalo(PeriodoOcorrencias.Ultimos30Dias).Desde);
        Assert.Equal((Agora.AddHours(-24), (DateTimeOffset?)null), _servico.Intervalo(PeriodoOcorrencias.Ultimas24Horas));
        Assert.Equal(((DateTimeOffset?)null, (DateTimeOffset?)null), _servico.Intervalo(PeriodoOcorrencias.Tudo));
    }

    [Fact]
    public async Task Sem_o_diagnostico_o_servico_recusa()
    {
        var acesso = new AcessoCentral(new SemAutenticador(), new RepositorioTerminal(_fabrica, _relogio), _relogio, NullLogger<AcessoCentral>.Instance);
        acesso.AbrirPelaVenda(new Operador(
            Guid.CreateVersion7(), 1, "maria", "MARIA", 0m, Permissoes: new HashSet<string>(PermissoesPdv.PerfilOperador, StringComparer.Ordinal)));
        var servico = new ServicoLogsCentral(
            new ConsultasLogLocal(_fabrica), new LeitorLogArquivo(CaminhosPdv.SobRaiz(_raiz)), acesso, new SessaoTerminal(), _relogio);
        await Assert.ThrowsAsync<RegraNegocioException>(() => servico.OcorrenciasAsync(new FiltroOcorrencias(Texto: "x"), ct: Ct));
        Assert.Throws<RegraNegocioException>(servico.DiasDoArquivo);
    }

    private sealed class Relogio : IRelogio
    {
        public DateTimeOffset Agora { get; set; }
    }

    /// <summary>Nenhum PIN é conferido nestes testes (a Central entra pela venda).</summary>
    private sealed class SemAutenticador : IAutenticadorOperador
    {
        public Task<ResultadoLogin> AutenticarAsync(string usuario, string senha, DateTimeOffset agora, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task<ResultadoLiberacaoSupervisor> LiberarAsync(
            string usuario, string pin, string permissao, Guid operadorId, DateTimeOffset agora, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task<ResultadoLogin> AutenticarParaCentralAsync(string usuario, string pin, DateTimeOffset agora, CancellationToken ct = default) =>
            throw new NotSupportedException();
    }
}
