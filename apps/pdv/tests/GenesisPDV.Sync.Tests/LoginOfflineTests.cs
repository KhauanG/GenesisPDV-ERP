using System.Text.Json.Nodes;
using GenesisPDV.Sync.Acesso;
using Microsoft.Extensions.Logging.Abstractions;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// Login offline pelo PIN (PDV 7.2, 7.5; SYNC 4): vetores argon2id gerados pela API com o node-argon2
/// (<c>argon2.vetores.json</c>, os mesmos que o Vitest da API confere) verificados pelo libsodium, regras 1–7 sobre o
/// espelho que desceu e o bloqueio de 5 erros persistido.
/// </summary>
public sealed class LoginOfflineTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public static TheoryData<string, string, string, bool, string?> Vetores()
    {
        var dados = new TheoryData<string, string, string, bool, string?>();
        foreach (var c in JsonNode.Parse(Fixtures.Sync("argon2.vetores.json"))!["casos"]!.AsArray())
        {
            dados.Add(c!["descricao"]!.GetValue<string>(), c["senha"]!.GetValue<string>(), c["hash"]!.GetValue<string>(), c["valido"]!.GetValue<bool>(), c["motivo"]?.GetValue<string>());
        }

        return dados;
    }

    /// <summary>Primeiro vetor válido: o PIN de 6 dígitos com os parâmetros da SYNC 4.2.</summary>
    private static (string Pin, string Hash) PinDaApi()
    {
        var c = JsonNode.Parse(Fixtures.Sync("argon2.vetores.json"))!["casos"]!.AsArray().First(x => x!["valido"]!.GetValue<bool>())!;
        return (c["senha"]!.GetValue<string>(), c["hash"]!.GetValue<string>());
    }

    [Theory]
    [MemberData(nameof(Vetores))]
    public async Task Vetor_da_api_confere_no_libsodium(string descricao, string senha, string hash, bool valido, string? motivo)
    {
        var esperado = valido ? ResultadoVerificacao.Confere : motivo == "fora_dos_limites" ? ResultadoVerificacao.ForaDosLimites : ResultadoVerificacao.NaoConfere;
        Assert.True(esperado == await VerificadorArgon2.VerificarAsync(hash, senha, Ct), descricao);
    }

    [Fact]
    public void Hash_malformado_ou_nulo_fica_fora_dos_limites()
    {
        Assert.Null(VerificadorArgon2.Canonico(null));
        Assert.Null(VerificadorArgon2.Canonico("pin-hash"));
        Assert.Null(VerificadorArgon2.Canonico("$argon2id$v=19$m=65536,t=3$YQcyvmqqnwU3ZOr6LnuZtQ$8mx/XGK+AyS4/bbp79sLoD9BGsF3Um4bCstFMl8Jeu0"));
        Assert.Null(VerificadorArgon2.Canonico("$argon2id$v=19$m=65536,t=3,p=1,p=1$YQcyvmqqnwU3ZOr6LnuZtQ$8mx/XGK+AyS4/bbp79sLoD9BGsF3Um4bCstFMl8Jeu0"));
        Assert.Null(VerificadorArgon2.Canonico("$argon2id$v=19$m=524288,t=3,p=1$YQcyvmqqnwU3ZOr6LnuZtQ$8mx/XGK+AyS4/bbp79sLoD9BGsF3Um4bCstFMl8Jeu0"));
        Assert.Equal(
            "$argon2id$v=19$m=19456,t=3,p=1$YQcyvmqqnwU3ZOr6LnuZtQ$8mx/XGK+AyS4/bbp79sLoD9BGsF3Um4bCstFMl8Jeu0",
            VerificadorArgon2.Canonico("$argon2id$v=19$m=19456,p=1,t=3$YQcyvmqqnwU3ZOr6LnuZtQ$8mx/XGK+AyS4/bbp79sLoD9BGsF3Um4bCstFMl8Jeu0"));
    }

    /// <summary>Terminal ativado com a carga de <c>configuracao</c> e <c>acesso</c> feita a partir da nuvem falsa.</summary>
    private static async Task<AmbienteSync> TerminalComUsuariosAsync(Action<ApiFalsa> publicar)
    {
        var amb = await AmbienteSync.CriarAsync();
        Assert.True((await amb.AtivarAsync()).Ativado);
        amb.Api.PublicarLojaECaixa();
        publicar(amb.Api);
        await amb.Carga.ExecutarAsync(ct: Ct);
        return amb;
    }

    [Fact]
    public async Task Pin_do_erp_entra_offline_com_login_ou_codigo_e_master_entra_sem_a_loja()
    {
        var (pin, hash) = PinDaApi();
        using var amb = await TerminalComUsuariosAsync(api =>
        {
            api.PublicarUsuario("maria", 7, hash);
            api.PublicarUsuario("gerente", 9, hash, master: true, comLoja: false);
        });
        var agora = amb.Relogio.Agora;
        var porLogin = await amb.Autenticador.AutenticarAsync("MARIA", pin, ApiFalsa.LojaId, agora, Ct);
        Assert.NotNull(porLogin.Usuario);
        Assert.Equal("maria", porLogin.Usuario!.Login);
        Assert.Equal(10m, porLogin.Usuario.LimiteDescontoPct);
        Assert.NotNull((await amb.Autenticador.AutenticarAsync("7", pin, ApiFalsa.LojaId, agora, Ct)).Usuario);
        var master = await amb.Autenticador.AutenticarAsync("gerente", pin, ApiFalsa.LojaId, agora, Ct);
        Assert.True(master.Usuario?.Master);
        var errado = await amb.Autenticador.AutenticarAsync("maria", "000000", ApiFalsa.LojaId, agora, Ct);
        Assert.Equal((AutenticadorOffline.MensagemInvalido, "senha_invalida"), (errado.Erro, errado.Motivo));
        var inexistente = await amb.Autenticador.AutenticarAsync("ninguem", pin, ApiFalsa.LojaId, agora, Ct);
        Assert.Equal(AutenticadorOffline.MensagemInvalido, inexistente.Erro);
        // O banco local nunca tem a senha do ERP (PDV 7.5).
        Assert.Equal(0L, amb.Escalar("select count(*) from pragma_table_info('usuarios') where name = 'senha_hash'"));
    }

    [Fact]
    public async Task Regras_3_a_6_inativo_sem_loja_sem_permissao_e_totem()
    {
        var (pin, hash) = PinDaApi();
        Guid negado = Guid.Empty;
        using var amb = await TerminalComUsuariosAsync(api =>
        {
            api.PublicarUsuario("inativo", 11, hash, ativo: false);
            // A API manda o PIN nulo para quem não tem a loja (SYNC 4.1): não entra, com a mensagem genérica.
            api.PublicarUsuario("outra_loja", 12, hashPin: null, comLoja: false);
            // Vínculo com a loja excluído depois que o hash desceu: a regra 4 recusa mesmo com o PIN certo.
            api.PublicarUsuario("sem_loja", 13, hash, comLoja: false);
            api.PublicarUsuario("sem_permissao", 14, hash, comPermissao: false);
            api.PublicarUsuario("totem", 15, hash, totem: true);
            negado = api.PublicarUsuario("negado", 16, hash);
            api.Publicar("acesso", "usuarios_permissoes", new JsonObject
            {
                ["id"] = Guid.CreateVersion7().ToString("D"),
                ["usuario_id"] = negado.ToString("D"),
                ["permissao"] = "pdv.acesso.entrar",
                ["efeito"] = "negar",
                ["excluido_em"] = null,
            });
        });
        var agora = amb.Relogio.Agora;
        async Task<(string? Erro, string? Motivo)> Login(string usuario)
        {
            var r = await amb.Autenticador.AutenticarAsync(usuario, pin, ApiFalsa.LojaId, agora, Ct);
            Assert.Null(r.Usuario);
            return (r.Erro, r.Motivo);
        }

        Assert.Equal((AutenticadorOffline.MensagemInativo, "usuario_inativo"), await Login("inativo"));
        Assert.Equal((AutenticadorOffline.MensagemInvalido, "senha_invalida"), await Login("outra_loja"));
        Assert.Equal((AutenticadorOffline.MensagemSemLoja, "loja_nao_permitida"), await Login("sem_loja"));
        Assert.Equal((AutenticadorOffline.MensagemSemAcesso, "sem_acesso_pdv"), await Login("sem_permissao"));
        Assert.Equal((AutenticadorOffline.MensagemTotem, "totem"), await Login("totem"));
        // Negar do usuário vence o conceder do perfil (MD 3.3.4).
        Assert.Equal((AutenticadorOffline.MensagemSemAcesso, "sem_acesso_pdv"), await Login("negado"));
    }

    [Fact]
    public async Task Login_carrega_as_permissoes_pdv_efetivas_com_o_negar_do_usuario()
    {
        // Fase 1C, C10a (MD 3.3.4): o operador entra com o conjunto efetivo, avaliado offline pelas telas do caixa.
        var (pin, hash) = PinDaApi();
        Guid maria = Guid.Empty;
        using var amb = await TerminalComUsuariosAsync(api =>
        {
            maria = api.PublicarUsuario("maria", 7, hash);
            api.Publicar("acesso", "usuarios_permissoes", new JsonObject
            {
                ["id"] = Guid.CreateVersion7().ToString("D"),
                ["usuario_id"] = maria.ToString("D"),
                ["permissao"] = "pdv.caixa.fechar",
                ["efeito"] = "negar",
                ["excluido_em"] = null,
            });
            api.Publicar("acesso", "usuarios_permissoes", new JsonObject
            {
                ["id"] = Guid.CreateVersion7().ToString("D"),
                ["usuario_id"] = maria.ToString("D"),
                ["permissao"] = "pdv.caixa.operar_de_outro",
                ["efeito"] = "conceder",
                ["excluido_em"] = null,
            });
            api.PublicarUsuario("gerente", 9, hash, master: true);
        });
        var u = (await amb.Autenticador.AutenticarAsync("maria", pin, ApiFalsa.LojaId, amb.Relogio.Agora, Ct)).Usuario!;
        Assert.True(u.Tem("pdv.caixa.abrir"));
        Assert.False(u.Tem("pdv.caixa.fechar"));
        Assert.True(u.Tem("pdv.caixa.operar_de_outro"));
        Assert.False(u.Tem("pdv.supervisor"));
        var gerente = (await amb.Autenticador.AutenticarAsync("gerente", pin, ApiFalsa.LojaId, amb.Relogio.Agora, Ct)).Usuario!;
        Assert.True(gerente.Tem("pdv.caixa.ver_calculado_fechamento"));
    }

    [Fact]
    public async Task Liberacao_do_supervisor_so_pelo_pin_com_a_permissao_da_acao_e_nunca_o_proprio_operador()
    {
        // PDV 31.3 (Fase 1C, C10a): pdv.supervisor e a permissão da ação; PIN errado conta no mesmo bloqueio do login.
        var (pin, hash) = PinDaApi();
        Guid operador = Guid.Empty;
        using var amb = await TerminalComUsuariosAsync(api =>
        {
            operador = api.PublicarUsuario("maria", 7, hash);
            api.PublicarUsuario("fiscal", 8, hash, permissoes: [.. Core.Caixa.PermissoesPdv.PerfilOperador, "pdv.supervisor", "pdv.caixa.operar_de_outro"]);
            api.PublicarUsuario("sem_papel", 10, hash, permissoes: [.. Core.Caixa.PermissoesPdv.PerfilOperador, "pdv.caixa.operar_de_outro"]);
            api.PublicarUsuario("inativo", 11, hash, ativo: false, permissoes: ["pdv.acesso.entrar", "pdv.supervisor", "pdv.caixa.operar_de_outro"]);
        });
        var agora = amb.Relogio.Agora;
        Task<ResultadoLiberacao> Liberar(string quem, string pinDigitado, string permissao = "pdv.caixa.operar_de_outro", Guid? de = null) =>
            amb.Autenticador.LiberarAsync(quem, pinDigitado, ApiFalsa.LojaId, permissao, de ?? operador, agora, Ct);

        Assert.Equal("fiscal", (await Liberar("fiscal", pin)).Supervisor?.Login);
        Assert.Equal(AutenticadorOffline.MensagemLiberadorSemPermissao, (await Liberar("fiscal", pin, "pdv.venda.cancelar_venda_finalizada")).Erro);
        Assert.Equal(AutenticadorOffline.MensagemLiberadorSemPermissao, (await Liberar("sem_papel", pin)).Erro);
        Assert.Equal(AutenticadorOffline.MensagemLiberadorProprio, (await Liberar("maria", pin, "pdv.acesso.entrar")).Erro);
        Assert.Equal(AutenticadorOffline.MensagemLiberacaoNegada, (await Liberar("fiscal", "000000")).Erro);
        Assert.StartsWith(AutenticadorOffline.MensagemLiberacaoNegada + ": " + AutenticadorOffline.MensagemInativo, (await Liberar("inativo", pin)).Erro);
        Assert.Equal(AutenticadorOffline.MensagemLiberacaoNegada, (await Liberar("ninguem", pin)).Erro);

        // O diálogo não serve de força bruta: o PIN errado do "fiscal" acima mais quatro chegam aos 5 do login, e o
        // supervisor fica bloqueado neste terminal — na liberação (com o PIN certo) e no próprio login.
        Assert.Equal(AutenticadorOffline.MensagemLiberacaoNegada, (await Liberar("fiscal", "000000")).Erro);
        Assert.Equal(AutenticadorOffline.MensagemLiberacaoNegada, (await Liberar("fiscal", "000000")).Erro);
        Assert.Equal(AutenticadorOffline.MensagemLiberacaoNegada, (await Liberar("fiscal", "000000")).Erro);
        Assert.Equal(AutenticadorOffline.MensagemLiberacaoNegada + ": " + AutenticadorOffline.MensagemBloqueado, (await Liberar("fiscal", "000000")).Erro);
        Assert.Equal(AutenticadorOffline.MensagemLiberacaoNegada + ": " + AutenticadorOffline.MensagemBloqueado, (await Liberar("fiscal", pin)).Erro);
        Assert.Equal(AutenticadorOffline.MensagemBloqueado, (await amb.Autenticador.AutenticarAsync("fiscal", pin, ApiFalsa.LojaId, agora, Ct)).Erro);
        Assert.Equal(5L, amb.Escalar("select tentativas from bloqueios_senha_local where tipo = 'usuario'"));
    }

    [Fact]
    public async Task Cinco_pins_errados_bloqueiam_5_minutos_neste_terminal_e_o_bloqueio_sobrevive_ao_reinicio()
    {
        var (pin, hash) = PinDaApi();
        using var amb = await TerminalComUsuariosAsync(api => api.PublicarUsuario("maria", 7, hash));
        var inicio = amb.Relogio.Agora;
        for (var i = 1; i <= 4; i++)
        {
            Assert.Equal(AutenticadorOffline.MensagemInvalido, (await amb.Autenticador.AutenticarAsync("maria", "111111", ApiFalsa.LojaId, inicio.AddSeconds(i), Ct)).Erro);
        }

        var quinto = await amb.Autenticador.AutenticarAsync("maria", "111111", ApiFalsa.LojaId, inicio.AddSeconds(5), Ct);
        Assert.Equal((AutenticadorOffline.MensagemBloqueado, "bloqueado"), (quinto.Erro, quinto.Motivo));

        // App reiniciado (outro autenticador, mesmo banco): continua bloqueado, mesmo com o PIN certo.
        var reiniciado = new AutenticadorOffline(amb.Fabrica, amb.Terminal, NullLogger<AutenticadorOffline>.Instance);
        Assert.Equal(AutenticadorOffline.MensagemBloqueado, (await reiniciado.AutenticarAsync("maria", pin, ApiFalsa.LojaId, inicio.AddMinutes(4), Ct)).Erro);
        Assert.Equal(1L, amb.Escalar("select count(*) from bloqueios_senha_local where tipo = 'usuario'"));

        // Passados os 5 min: o PIN certo entra e zera a contagem.
        Assert.NotNull((await reiniciado.AutenticarAsync("maria", pin, ApiFalsa.LojaId, inicio.AddMinutes(6), Ct)).Usuario);
        Assert.Equal(0L, amb.Contar("bloqueios_senha_local"));
    }

    [Fact]
    public async Task Erros_espalhados_alem_da_janela_de_5_minutos_nao_bloqueiam()
    {
        var (_, hash) = PinDaApi();
        using var amb = await TerminalComUsuariosAsync(api => api.PublicarUsuario("maria", 7, hash));
        var inicio = amb.Relogio.Agora;
        for (var i = 0; i < 6; i++)
        {
            var r = await amb.Autenticador.AutenticarAsync("maria", "111111", ApiFalsa.LojaId, inicio.AddMinutes(i * 2), Ct);
            Assert.Equal(AutenticadorOffline.MensagemInvalido, r.Erro);
        }
    }

    [Fact]
    public async Task Hash_fora_dos_limites_nao_loga_e_vai_para_a_auditoria()
    {
        var fora = JsonNode.Parse(Fixtures.Sync("argon2.vetores.json"))!["casos"]!.AsArray()
            .First(c => c!["motivo"]?.GetValue<string>() == "fora_dos_limites")!;
        var senha = fora["senha"]!.GetValue<string>();
        using var amb = await TerminalComUsuariosAsync(api => api.PublicarUsuario("maria", 7, fora["hash"]!.GetValue<string>()));
        var r = await amb.Autenticador.AutenticarAsync("maria", senha, ApiFalsa.LojaId, amb.Relogio.Agora, Ct);
        Assert.Equal((AutenticadorOffline.MensagemInvalido, "hash_fora_dos_limites"), (r.Erro, r.Motivo));
        Assert.Equal(1L, amb.Escalar("select count(*) from log_auditoria_local where acao = 'hash_fora_dos_limites'"));
        Assert.Equal(1L, amb.Escalar("select count(*) from log_local where nivel = 'aviso'"));
        Assert.Equal(0L, amb.Contar("bloqueios_senha_local"));
    }
}
