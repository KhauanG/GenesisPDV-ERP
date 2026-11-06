using GenesisPDV.App.Servicos.Diagnostico;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Central do PDV, bloco G2 (plano 5.4; README › decisão 67): o mascarador único do visor, do pacote de suporte e da
/// auditoria. Tabela do que mascara e, tão importante quanto, do que <b>não</b> pode mascarar.
/// </summary>
public sealed class MascaradorSuporteTests
{
    private const string BrCode =
        "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913ICE BEER LTDA6008BRASILIA62070503***6304ABCD";

    public static TheoryData<string, string> Mascarados => new()
    {
        { "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def", "Authorization: Bearer ***" },
        // O cabeçalho leva só o esquema e a credencial: o resto da linha é o que o suporte precisa ler.
        { "Authorization: Basic dXNlcjpwYXNz, status 401 em /sync/push depois de 3 tentativas", "Authorization: ***, status 401 em /sync/push depois de 3 tentativas" },
        { "enviando com Bearer tok_123456 para a nuvem", "enviando com Bearer *** para a nuvem" },
        { "GET /sync/estado?token=abc123&loja=7", "GET /sync/estado?token=***&loja=7" },
        { "access_token=xyz senha=1234 pin=4321 secret=s3 chave=K7QM", "access_token=*** senha=*** pin=*** secret=*** chave=***" },
        { "backup.chave=AAAA pin_hash=BBBB", "backup.chave=*** pin_hash=***" },
        { """{"token":"abc","chave_pix":"loja@ex.com","senha_pdv_hash":"x"}""", """{"token":"***","chave_pix":"***","senha_pdv_hash":"***"}""" },
        { """{"pin": 123456, "PIN_novo": "9"}""", """{"pin": "***", "PIN_novo": "***"}""" },
        { """{"cpf_cnpj_nota":"12345678909","cpf":"123"}""", """{"cpf_cnpj_nota":"***","cpf":"***"}""" },
        // Objeto e lista com nome sensível: o valor inteiro (o que vai dentro também é segredo).
        { """{"terminal.chave_privada":{"algoritmo":"x25519","privada":"q83v"},"ok":1}""", """{"terminal.chave_privada":"***","ok":1}""" },
        { """{"token": ["a","b"], "chave_terminal": {"k":{"v":"}"}}}""", """{"token": "***", "chave_terminal": "***"}""" },
        // camelCase e PascalCase.
        { """{"accessToken":"segredo","senhaPdvHash":"x","CpfCnpjNota":"12345678909"}""", """{"accessToken":"***","senhaPdvHash":"***","CpfCnpjNota":"***"}""" },
        { "tokenTerminal=abc AccessToken=def", "tokenTerminal=*** AccessToken=***" },
        // JSON escapado dentro de outro (a coluna depois exportada) e JSON numa célula de CSV.
        { """{\"token\":\"abc123\",\"pin\":4321}""", """{\"token\":\"***\",\"pin\":\"***\"}""" },
        { """{"depois":"{\"senha\":\"x\",\"ok\":true}"}""", """{"depois":"{\"senha\":\"***\",\"ok\":true}"}""" },
        { "1;\"{\"\"token\"\":\"\"abc\"\",\"\"pin\"\":12}\"", "1;\"{\"\"token\"\":\"\"***\"\",\"\"pin\"\":\"\"***\"\"}\"" },
        // nome=valor e nome: valor com o valor entre aspas, e o separador dois-pontos fora do JSON.
        { """senha="abc 123" token='xyz' pin=""", """senha="***" token='***' pin=""" },
        { "Token: abc123 e senha:abc no retorno", "Token: *** e senha:*** no retorno" },
        // Dado pessoal: documento do pagador, e-mail e telefone.
        { """{"pagador_documento":"12345678909","email":"a@b.com","telefone":"41999990000"}""", """{"pagador_documento":"***","email":"***","telefone":"***"}""" },
        { """{"token":"com \"aspas\" dentro"}""", """{"token":"***"}""" },
        { "CPF 123.456.789-09 na nota", "CPF ***.***.***-** na nota" },
        { "CNPJ 12.345.678/0001-95 da loja", "CNPJ **.***.***/****-** da loja" },
        { $"PIX gerado: {BrCode} para a venda 4512", "PIX gerado: [BR Code] para a venda 4512" },
        { $"""{"{"}"br_code":"{BrCode}"{"}"}""", """{"br_code":"***"}""" },
        { "hash $argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA no espelho", "hash [hash] no espelho" },
        { "-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBg\n-----END PRIVATE KEY----- fim", "[chave privada] fim" },
        { @"dados em C:\Users\joao.silva\AppData\Local\GenesisPDV", @"dados em %USERPROFILE%\AppData\Local\GenesisPDV" },
        { @"pasta C:\Users\Caixa 1\Documents\backup", @"pasta %USERPROFILE%\Documents\backup" },
        { """{"pasta":"C:\\Users\\maria\\Desktop"}""", """{"pasta":"%USERPROFILE%\\Desktop"}""" },
        { "dados em /home/caixa/.local/share/genesispdv", "dados em %USERPROFILE%/.local/share/genesispdv" },
        { "abrindo file:///home/caixa/x.log", "abrindo file://%USERPROFILE%/x.log" },
        // O BR Code acaba no CRC (campo 63): o que vem depois, mesmo com outro "6304…", fica.
        { $"PIX {BrCode} venda 4512 hash 9f86d0816304beef00aa", "PIX [BR Code] venda 4512 hash 9f86d0816304beef00aa" },
        // Cortado (sem o CRC): até o fim da linha, como antes.
        { "PIX 00020126580014br.gov.bcb.pix0136123e\nvenda 4512", "PIX [BR Code]\nvenda 4512" },
    };

    [Theory]
    [MemberData(nameof(Mascarados))]
    public void Mascara_o_segredo_pelo_contexto(string texto, string esperado)
    {
        Assert.Equal(esperado, MascaradorSuporte.Mascarar(texto));
        // Idempotente: o pacote mascara o que o visor já mascarou sem estragar nada.
        Assert.Equal(esperado, MascaradorSuporte.Mascarar(esperado));
    }

    public static TheoryData<string> Intactos => new()
    {
        // payload_sha256 (64 hex), GTIN-14, número da venda, uuid do terminal e dinheiro.
        """{"payload_sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}""",
        "GTIN 17891234567895 e EAN 7891234567895",
        "Venda nº 4512 (nuvem 100045) de R$ 1.234,56",
        "terminal 019a0b3c-7d2e-7f00-8a1b-2c3d4e5f6a7b caixa 2",
        // CPF/CNPJ sem pontuação não se distingue de um código: fica (o campo JSON cpf_cnpj_* é que mascara).
        "codigo 12345678909 e 12345678000195",
        // A gaveta, a impressora e palavras parecidas com as sensíveis.
        """{"gaveta.pino":5,"impressora.ip":"192.168.0.20","pinos":2,"tokens_total":3}""",
        "gaveta.pino=5 impressora.porta=COM3",
        "Token aceito de novo pela nuvem: push e pull voltam",
        "Pasta D:\\Backup\\GenesisPDV e /var/lib/genesispdv",
        """{"chave":null}""",
        // As regras da loja (booleanas) e as datas com nome parecido: o suporte lê; o campo "chave" é o nome da configuração.
        """{"pdv.permite_pin_curto":true,"pdv.pergunta_cpf_na_finalizacao":false,"pdv.login_aceita_senha_erp":true}""",
        """{"crediario_exige_senha_cliente":false,"sangria_exige_senha_quem_retira":true}""",
        "pdv.permite_pin_curto=true geral.qualquer_senha=false",
        """{"token_expira_em":"2026-11-04T10:00:00Z","segredo_definido_em":"2026-11-01","senhaAlteradaEm":"x"}""",
        """{"chave":"impressora.modelo","valor":"tm-t20"}""",
        "Gravando a chave: tela.tema",
        """{"tipo_pinpad":"pinpad_usb","tipoPinpad":"x","spinCount":3}""",
        // /home no meio de um endereço não é a pasta do usuário.
        "GET https://api.exemplo/home/maria/x",
    };

    [Theory]
    [MemberData(nameof(Intactos))]
    public void Nao_mascara_o_que_o_suporte_precisa_ler(string texto) =>
        Assert.Equal(texto, MascaradorSuporte.Mascarar(texto));

    [Fact]
    public void No_windows_o_perfil_e_a_conta_exatos_somem_mesmo_com_espaco_no_nome()
    {
        const string perfil = @"C:\Users\João Silva";
        const string conta = @"LOJA01\João Silva";
        var texto = @"Pasta C:\Users\João Silva sem acesso; conta LOJA01\João Silva; " + """{"pasta":"C:\\Users\\João Silva\\Desktop","conta":"LOJA01\\João Silva"}""";
        var mascarado = MascaradorSuporte.Mascarar(texto, perfil, conta)!;
        Assert.Equal(
            @"Pasta %USERPROFILE% sem acesso; conta %USERDOMAIN%\%USERNAME%; " + """{"pasta":"%USERPROFILE%\\Desktop","conta":"%USERDOMAIN%\\%USERNAME%"}""",
            mascarado);
        Assert.DoesNotContain("Silva", mascarado, StringComparison.Ordinal);
        Assert.Equal(mascarado, MascaradorSuporte.Mascarar(mascarado, perfil, conta));
    }

    [Fact]
    public void Nulo_e_vazio_continuam()
    {
        Assert.Null(MascaradorSuporte.Mascarar(null));
        Assert.Equal(string.Empty, MascaradorSuporte.Mascarar(string.Empty));
    }

    [Fact]
    public void Segredos_plantados_numa_linha_de_log_nao_sobram()
    {
        // Uma linha do log com tudo o que nunca pode sair do caixa (o pacote do G9 repete esta varredura nos bytes do zip).
        string[] segredos = ["eyJhbGciOiJIUzI1NiJ9.zz", "1234", "123.456.789-09", "br.gov.bcb.pix", "$argon2id$", "q83vEjRWeJA", "joao.silva"];
        var linha = "2026-11-04 10:00:00.000 -03:00 [ERR] Sync falhou Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.zz | " +
                    """{"pin":"1234","cpf_cnpj_nota":"123.456.789-09","privada":"q83vEjRWeJA"} """ + BrCode +
                    @" $argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA em C:\Users\joao.silva\AppData";
        var mascarada = MascaradorSuporte.Mascarar(linha)!;
        Assert.All(segredos, s => Assert.DoesNotContain(s, mascarada, StringComparison.OrdinalIgnoreCase));
        Assert.StartsWith("2026-11-04 10:00:00.000 -03:00 [ERR] Sync falhou", mascarada, StringComparison.Ordinal);
    }
}
