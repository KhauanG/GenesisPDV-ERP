using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Sync.Ativacao;
using GenesisPDV.Sync.Protocolo;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// Ativação real (SYNC 3.2–3.5; PDV 5.3, 5.5) contra a <see cref="ApiFalsa"/>, que responde com as fixtures do contrato:
/// estado local completo numa transação, nada gravado em recusa, a mesma requisição (id e chaves) na repetição, a
/// mensagem de cada código e o token nunca em claro no <c>pdv.db</c> nem no log.
/// </summary>
public class AtivacaoTests
{
    [Fact]
    public async Task Ativacao_grava_o_estado_da_3_5_com_o_token_e_os_segredos_protegidos()
    {
        using var pdv = await AmbienteSync.CriarAsync();
        var ct = TestContext.Current.CancellationToken;
        var resultado = await pdv.AtivarAsync();

        Assert.True(resultado.Ativado, resultado.Mensagem);
        var ativado = resultado.Terminal!;
        Assert.Equal(("ICE BEER COMÉRCIO DE BEBIDAS LTDA", "Loja 1 - Ice Beer Hermes", "00000000000100", 2),
            (ativado.RazaoSocial, ativado.LojaNome, ativado.LojaCnpj, ativado.NumeroCaixa));

        var identidade = (await pdv.Terminal.ObterIdentidadeAsync(ct))!;
        Assert.Equal(pdv.Api.TerminalId, identidade.TerminalId);
        Assert.Equal((100001, 2, "ativo", AmbienteSync.Url.ToString()), (identidade.EmpresaCodigo, identidade.NumeroCaixa, identidade.Status, identidade.UrlApi));
        Assert.Equal(Guid.Parse("01a18752-3782-7bda-ad3c-2d6d1a3d1fa7"), identidade.LojaId);
        Assert.False(identidade.Demonstracao);

        // Token: só protegido no banco; abre com a finalidade do terminal.
        var token = pdv.Api.TokensEmitidos.Single();
        Assert.Equal(token, Encoding.UTF8.GetString(pdv.Protetor.Desproteger(identidade.TokenProtegido, ProtetorSegredos.FinalidadeToken(identidade.TerminalId))));
        var banco = pdv.BytesDoBanco();
        Assert.Equal(-1, banco.AsSpan().IndexOf(Encoding.UTF8.GetBytes(token.Split('.')[1])));
        Assert.DoesNotContain(pdv.Log.Linhas, l => l.Contains(token.Split('.')[1], StringComparison.Ordinal));
        Assert.Contains(pdv.Log.Linhas, l => l.Contains("ativado", StringComparison.Ordinal));

        // Sequências com o salto que a API mandou (13.3) e evento começando do zero.
        var sequencias = new Dictionary<string, long>();
        foreach (var chave in new[] { "evento", "venda", "vale", "nfce:2:2", "nfce:2:1" })
        {
            sequencias[chave] = (long)pdv.Escalar($"select ultimo_valor from sequencias_locais where chave = '{chave}'")!;
        }

        Assert.Equal(new Dictionary<string, long> { ["evento"] = 0, ["venda"] = 1126, ["vale"] = 1008, ["nfce:2:2"] = 0, ["nfce:2:1"] = 4515 }, sequencias);
        Assert.Equal(7L, pdv.Contar("estado_sincronizacao where cursor = 0 and carga_inicial_concluida = 0"));
        Assert.Equal(1L, pdv.Contar("estado_conexao where online = 1 and desvio_relogio_ms is not null and desvio_amostra_boot_id is not null"));

        // Chave de backup decifrada do envelope e re-protegida; privada do terminal = par da pública enviada.
        var backup = await pdv.Terminal.ObterConfiguracaoAsync<string>(ChavesConfiguracaoTerminal.BackupChave, ct);
        Assert.Equal(pdv.Api.ChaveBackup, pdv.Protetor.Desproteger(Convert.FromBase64String(backup!), ProtetorSegredos.FinalidadeBackup(identidade.TerminalId)));
        Assert.Equal(-1, banco.AsSpan().IndexOf(pdv.Api.ChaveBackup));
        var privada = (await pdv.Terminal.ObterConfiguracaoAsync<ChavePrivadaGravada>(ChavesConfiguracaoTerminal.ChavePrivadaTerminal, ct))!;
        Assert.Equal("x25519", privada.Algoritmo);
        var par = ParX25519.DaPrivada(pdv.Protetor.Desproteger(Convert.FromBase64String(privada.Protegida), ProtetorSegredos.FinalidadeChaveTerminal(identidade.TerminalId)));
        var pedido = JsonSerializer.Deserialize<RequisicaoAtivacao>(pdv.Api.Envios.Single().Corpo!, ContratosJson.Opcoes)!;
        Assert.Equal(pedido.ChavePublicaTerminal.Chave, par.PublicaSpkiBase64);
        Assert.NotEqual(pedido.ChavePublicaTerminal.Chave, pedido.ChaveBackupPublica);
        Assert.Equal(1L, pdv.Contar("log_auditoria_local where acao = 'terminal_ativado'"));
    }

    [Fact]
    public async Task Ida_e_volta_acima_de_3_s_nao_grava_amostra_de_desvio_do_relogio()
    {
        using var pdv = await AmbienteSync.CriarAsync();
        pdv.Api.Ativacoes.Enqueue(e =>
        {
            pdv.Relogio.Agora += TimeSpan.FromSeconds(8);
            return pdv.Api.AtivacaoAceita(e);
        });
        Assert.True((await pdv.AtivarAsync()).Ativado);

        // SYNC 12.2: amostra descartada (sem desvio nem o par boot/UTC); online e a maior hora vista ficam.
        Assert.Equal(1L, pdv.Contar(
            "estado_conexao where online = 1 and maior_hora_vista is not null and desvio_relogio_ms is null " +
            "and desvio_amostra_utc_local is null and desvio_amostra_boot_id is null"));
    }

    [Fact]
    public async Task Ida_e_volta_de_ate_3_s_grava_o_desvio_contra_o_meio()
    {
        using var pdv = await AmbienteSync.CriarAsync();
        pdv.Api.Ativacoes.Enqueue(e =>
        {
            pdv.Relogio.Agora += TimeSpan.FromSeconds(2);
            return pdv.Api.AtivacaoAceita(e);
        });
        var antes = pdv.Relogio.Agora;
        Assert.True((await pdv.AtivarAsync()).Ativado);

        var agoraServidor = DateTimeOffset.Parse(JsonNode.Parse(ApiFalsa.Fixture("ativar.resposta.json"))!["agora_servidor"]!.GetValue<string>(), System.Globalization.CultureInfo.InvariantCulture);
        var esperado = (long)Math.Round((agoraServidor - (antes + TimeSpan.FromSeconds(1))).TotalMilliseconds);
        var conexao = await pdv.Terminal.ObterEstadoConexaoAsync(TestContext.Current.CancellationToken);
        Assert.Equal(esperado, conexao.DesvioRelogioMs);
        Assert.Equal(IdBoot.Atual(), conexao.DesvioAmostraBootId);
    }

    [Fact]
    public async Task Auditoria_da_ativacao_vai_no_mesmo_commit_e_nao_fica_se_a_gravacao_falha()
    {
        using var pdv = await AmbienteSync.CriarAsync();
        var ct = TestContext.Current.CancellationToken;
        Assert.True((await pdv.AtivarAsync()).Ativado);
        Assert.Equal(1L, pdv.Contar("log_auditoria_local where acao = 'terminal_ativado'"));

        // Uma segunda gravação (terminal já ativado) é recusada inteira: nem a auditoria dela fica.
        var auditoria = new LogAuditoriaLocal { Id = Guid.NewGuid(), OcorridoEm = pdv.Relogio.Agora, Acao = "terminal_ativado" };
        var dados = new GenesisPDV.Data.Repositorios.DadosAtivacao(
            new IdentidadeTerminal { TerminalId = Guid.NewGuid(), UrlApi = AmbienteSync.Url.ToString() },
            new Dictionary<string, long>(), null, new Dictionary<string, string>(), auditoria);
        await Assert.ThrowsAsync<InvalidOperationException>(() => pdv.Terminal.RegistrarAtivacaoAsync(dados, ct));
        Assert.Equal(1L, pdv.Contar("log_auditoria_local"));
    }

    [Fact]
    public void Id_do_boot_e_estavel_no_processo_e_a_reserva_arredonda_ao_minuto()
    {
        Assert.Equal(IdBoot.Atual(), IdBoot.Atual());
        Assert.False(string.IsNullOrWhiteSpace(IdBoot.Atual()));
        var agora = new DateTimeOffset(2026, 10, 31, 12, 0, 40, TimeSpan.Zero);
        Assert.Equal("boot:202610311201", IdBoot.PorInstante(agora, 10_000));
        Assert.Equal("boot:202610311200", IdBoot.PorInstante(agora, 11_000));
        // Correção de alguns segundos do relógio longe da metade do minuto não muda o id.
        Assert.Equal(IdBoot.PorInstante(agora, 40_000), IdBoot.PorInstante(agora.AddSeconds(5), 40_000));
        Assert.Equal("boot:202610311201", IdBoot.PorInstante(agora.ToOffset(TimeSpan.FromHours(-3)), 10_000));
    }

    [Fact]
    public async Task Requisicao_tem_o_formato_da_fixture_sem_autenticacao_e_com_o_id_da_ativacao()
    {
        using var pdv = await AmbienteSync.CriarAsync();
        await pdv.AtivarAsync("k7qm2xrd");
        var envio = pdv.Api.Envios.Single();
        Assert.Equal("/sync/ativar", envio.Rota);
        Assert.Null(envio.Token);
        var corpo = JsonNode.Parse(envio.Corpo!)!;
        Assert.Equal(Chaves(JsonNode.Parse(ApiFalsa.Fixture("ativar.requisicao.json"))), Chaves(corpo));
        Assert.Equal(corpo["requisicao_ativacao_id"]!.GetValue<string>(), envio.RequisicaoId);
        Assert.Equal("K7QM-2XRD", corpo["codigo_ativacao"]!.GetValue<string>());
        Assert.Equal(100001, corpo["codigo_empresa"]!.GetValue<int>());
        Assert.Equal(pdv.Maquina.IdHardware, corpo["maquina"]!["id_hardware"]!.GetValue<string>());
        Assert.Equal("x25519", corpo["chave_publica_terminal"]!["algoritmo"]!.GetValue<string>());
        Assert.True(corpo["maquina"]!["versao_schema_local"]!.GetValue<int>() > 0);
    }

    public static TheoryData<HttpStatusCode, string, string> Recusas { get; } = new()
    {
        { HttpStatusCode.UnprocessableEntity, "CODIGO_EXPIRADO", MensagensAtivacao.CodigoExpirado },
        { HttpStatusCode.UnprocessableEntity, "CODIGO_USADO", MensagensAtivacao.CodigoUsado },
        { HttpStatusCode.UnprocessableEntity, "LIMITE_PLANO", MensagensAtivacao.LimitePlano },
        { HttpStatusCode.UnprocessableEntity, "CAIXA_OCUPADO", MensagensAtivacao.CaixaOcupado },
        { HttpStatusCode.Forbidden, "PDV_DESABILITADO", MensagensAtivacao.PdvDesabilitado },
        { HttpStatusCode.Forbidden, "LOJA_INATIVA", MensagensAtivacao.LojaInativa },
        { HttpStatusCode.TooManyRequests, "ATIVACAO_BLOQUEADA", MensagensAtivacao.AtivacaoBloqueada },
        { HttpStatusCode.ServiceUnavailable, "MANUTENCAO", MensagensAtivacao.Manutencao },
    };

    [Theory]
    [MemberData(nameof(Recusas))]
    public async Task Cada_recusa_mostra_a_sua_mensagem_e_nada_e_gravado(HttpStatusCode status, string codigo, string mensagem)
    {
        using var pdv = await AmbienteSync.CriarAsync();
        pdv.Api.Ativacoes.Enqueue(_ => ApiFalsa.Erro(status, codigo));
        var resultado = await pdv.AtivarAsync();
        Assert.False(resultado.Ativado);
        Assert.Equal(codigo, resultado.Codigo);
        Assert.Equal(mensagem, resultado.Mensagem);
        AssertNadaGravado(pdv);
    }

    [Theory]
    [InlineData("código de ativação errado", "CODIGO_INVALIDO", MensagensAtivacao.CodigoInvalido)]
    [InlineData("IP bloqueado por força bruta (com Retry-After)", "IP_BLOQUEADO", MensagensAtivacao.IpBloqueado)]
    public async Task Recusas_das_fixtures_de_erro(string descricao, string codigo, string mensagem)
    {
        using var pdv = await AmbienteSync.CriarAsync();
        pdv.Api.Ativacoes.Enqueue(_ => ApiFalsa.ErroDaFixture(descricao));
        var resultado = await pdv.AtivarAsync();
        Assert.Equal((codigo, mensagem), (resultado.Codigo, resultado.Mensagem));
        AssertNadaGravado(pdv);
    }

    [Fact]
    public async Task Versao_abaixo_da_minima_426_mostra_a_versao_exigida()
    {
        using var pdv = await AmbienteSync.CriarAsync();
        pdv.Api.Ativacoes.Enqueue(_ => ApiFalsa.Erro(HttpStatusCode.UpgradeRequired, "PROTOCOLO_NAO_SUPORTADO", "Atualize.",
            new JsonObject { ["versao_minima"] = "1.6.0" }));
        var resultado = await pdv.AtivarAsync();
        Assert.Equal("PROTOCOLO_NAO_SUPORTADO", resultado.Codigo);
        Assert.Contains("mínima: 1.6.0", resultado.Mensagem, StringComparison.Ordinal);
        // PDV-1 (I3): diz qual instalador usar; ainda não há ativação, então não promete que ela "continua" (só banco e
        // backups) e manda ativar depois.
        Assert.Equal(
            "Esta versão do GenesisPDV está desatualizada (mínima: 1.6.0). Instale o GenesisPDV 1.6.0 ou mais novo pelo instalador " +
            "(GenesisPDV-Setup-1.6.0.exe), por cima deste: o banco e os backups continuam. Depois, abra o GenesisPDV e faça a ativação.",
            resultado.Mensagem);
        Assert.DoesNotContain("ativação continua", resultado.Mensagem, StringComparison.Ordinal);
        Assert.EndsWith("o banco, os backups e a ativação continuam.", MensagensAtivacao.ComoAtualizar("1.6.0"), StringComparison.Ordinal);
        AssertNadaGravado(pdv);
    }

    [Fact]
    public async Task Repeticao_leva_o_mesmo_id_e_as_mesmas_chaves_e_codigo_novo_comeca_outra_tentativa()
    {
        using var pdv = await AmbienteSync.CriarAsync();
        pdv.Api.Ativacoes.Enqueue(_ => throw new HttpRequestException("rede caiu"));
        pdv.Api.Ativacoes.Enqueue(_ => ApiFalsa.Erro(HttpStatusCode.ServiceUnavailable, "MANUTENCAO"));
        pdv.Api.Ativacoes.Enqueue(_ => ApiFalsa.Erro(HttpStatusCode.UnprocessableEntity, "CODIGO_INVALIDO"));

        var semRede = await pdv.AtivarAsync();
        Assert.Equal(MensagensAtivacao.SemConexao, semRede.Mensagem);
        var id = pdv.Ativacao.RequisicaoEmAndamento;
        Assert.NotNull(id);
        Assert.Equal(MensagensAtivacao.Manutencao, (await pdv.AtivarAsync()).Mensagem);
        AssertNadaGravado(pdv);

        // Outro código: outra tentativa (id e chaves novos).
        Assert.Equal(MensagensAtivacao.CodigoInvalido, (await pdv.AtivarAsync("ABCD-EFGH")).Mensagem);
        Assert.NotEqual(id, pdv.Ativacao.RequisicaoEmAndamento);
        var outro = pdv.Ativacao.RequisicaoEmAndamento;
        Assert.True((await pdv.AtivarAsync("ABCD-EFGH")).Ativado);
        Assert.Null(pdv.Ativacao.RequisicaoEmAndamento);

        var pedidos = pdv.Api.Envios.Where(e => e.Rota == "/sync/ativar")
            .Select(e => (e.RequisicaoId, Corpo: JsonSerializer.Deserialize<RequisicaoAtivacao>(e.Corpo!, ContratosJson.Opcoes)!))
            .ToList();
        Assert.Equal(4, pedidos.Count);
        Assert.All(pedidos, p => Assert.Equal(p.Corpo.RequisicaoAtivacaoId.ToString("D"), p.RequisicaoId));
        Assert.Equal(id, pedidos[0].Corpo.RequisicaoAtivacaoId);
        // Mesmo corpo inteiro: id, códigos, máquina e as duas chaves públicas.
        Assert.Equal(pedidos[0].Corpo, pedidos[1].Corpo);
        Assert.Equal(outro, pedidos[2].Corpo.RequisicaoAtivacaoId);
        Assert.Equal(outro, pedidos[3].Corpo.RequisicaoAtivacaoId);
        Assert.NotEqual(pedidos[0].Corpo.ChavePublicaTerminal, pedidos[2].Corpo.ChavePublicaTerminal);
        Assert.Equal(pedidos[2].Corpo.ChavePublicaTerminal, pedidos[3].Corpo.ChavePublicaTerminal);
    }

    [Fact]
    public async Task Chave_de_backup_que_nao_abre_ou_token_de_outro_terminal_nao_gravam_nada_e_a_repeticao_ativa()
    {
        using var pdv = await AmbienteSync.CriarAsync();
        var estranha = ParX25519.Gerar();
        pdv.Api.Ativacoes.Enqueue(e => pdv.Api.AtivacaoAceita(e, r =>
            r["chave_backup_cifrada"] = Convert.ToBase64String(EciesApi.Cifrar(estranha.PublicaSpki, pdv.Api.ChaveBackup))));
        pdv.Api.Ativacoes.Enqueue(e => pdv.Api.AtivacaoAceita(e, r => r["token"] = $"{Guid.NewGuid():D}.{new string('A', 43)}"));

        Assert.Equal(MensagensAtivacao.RespostaInvalida, (await pdv.AtivarAsync()).Mensagem);
        Assert.Equal(MensagensAtivacao.RespostaInvalida, (await pdv.AtivarAsync()).Mensagem);
        AssertNadaGravado(pdv);
        Assert.True((await pdv.AtivarAsync()).Ativado);
        Assert.Single(pdv.Api.Envios.Select(e => e.RequisicaoId).Distinct());
    }

    [Fact]
    public async Task Formato_invalido_nao_chama_a_api_e_url_com_caminho_mantem_o_caminho()
    {
        using var pdv = await AmbienteSync.CriarAsync();
        var ct = TestContext.Current.CancellationToken;
        Assert.NotNull((await pdv.Ativacao.AtivarAsync(AmbienteSync.Url, "12345", "K7QM-2XRD", ct)).Mensagem);
        Assert.Contains("0", (await pdv.Ativacao.AtivarAsync(AmbienteSync.Url, "100001", "K7QM-0XRD", ct)).Mensagem, StringComparison.Ordinal);
        Assert.Empty(pdv.Api.Envios);

        Assert.True((await pdv.Ativacao.AtivarAsync(new Uri("https://api.exemplo/genesis?x=1"), "100001", "K7QM2XRD", ct)).Ativado);
        Assert.Equal("/genesis/sync/ativar", pdv.Api.Envios.Single().Rota);
        Assert.Equal("https://api.exemplo/genesis/", (await pdv.Terminal.ObterIdentidadeAsync(ct))!.UrlApi);
    }

    [Fact]
    public async Task Teste_de_conexao_usa_a_saude_do_servidor()
    {
        using var pdv = await AmbienteSync.CriarAsync();
        var ct = TestContext.Current.CancellationToken;
        pdv.Api.Saudes.Enqueue(() => throw new HttpRequestException("sem rede"));
        pdv.Api.Saudes.Enqueue(() => new HttpResponseMessage(HttpStatusCode.BadGateway));
        Assert.False(await pdv.Ativacao.TestarConexaoAsync(AmbienteSync.Url, ct));
        Assert.False(await pdv.Ativacao.TestarConexaoAsync(AmbienteSync.Url, ct));
        Assert.True(await pdv.Ativacao.TestarConexaoAsync(AmbienteSync.Url, ct));
        Assert.All(pdv.Api.Envios, e => Assert.Equal("/saude", e.Rota));
    }

    [Fact]
    public async Task Identidade_de_demonstracao_e_marcada_e_nao_tem_token()
    {
        using var pdv = await AmbienteSync.CriarAsync();
        var ct = TestContext.Current.CancellationToken;
        await pdv.Terminal.RegistrarAtivacaoAsync(new IdentidadeTerminal
        {
            TerminalId = Guid.NewGuid(),
            LojaId = Guid.NewGuid(),
            CaixaId = Guid.NewGuid(),
            NumeroCaixa = 2,
            UrlApi = IdentidadeTerminal.UrlDemonstracao,
            AtivadoEm = pdv.Relogio.Agora,
            NomeMaquina = "x",
        }, ct);
        Assert.True((await pdv.Terminal.ObterIdentidadeAsync(ct))!.Demonstracao);
        Assert.Empty(await pdv.Cofre.CandidatosAsync(ct));
        Assert.False(await pdv.Rotacao.RenovarAsync(ct));
        Assert.Empty(pdv.Api.Envios);
        Assert.Equal(0L, pdv.Contar("estado_conexao where online = 1 or desvio_relogio_ms is not null"));
    }

    private static void AssertNadaGravado(AmbienteSync pdv)
    {
        Assert.Equal(0L, pdv.Contar("identidade_terminal"));
        Assert.Equal(0L, pdv.Contar("configuracao_terminal"));
        Assert.Equal(0L, pdv.Contar("sequencias_locais"));
        // estado_conexao nasce com a linha única da migração: continua offline e sem amostra de relógio.
        Assert.Equal(0L, pdv.Contar("estado_conexao where online = 1 or desvio_relogio_ms is not null"));
        Assert.Equal(0L, pdv.Contar("estado_sincronizacao"));
        Assert.False(File.Exists(pdv.Caminhos.ArquivoChaveTerminal), "a chave local só nasce com a ativação aceita");
    }

    /// <summary>Caminhos de todas as chaves (o formato, sem os valores).</summary>
    private static SortedSet<string> Chaves(JsonNode? no, string prefixo = "")
    {
        var chaves = new SortedSet<string>(StringComparer.Ordinal);
        if (no is JsonObject objeto)
        {
            foreach (var (chave, valor) in objeto)
            {
                chaves.Add(prefixo + chave);
                chaves.UnionWith(Chaves(valor, prefixo + chave + "."));
            }
        }

        return chaves;
    }
}
