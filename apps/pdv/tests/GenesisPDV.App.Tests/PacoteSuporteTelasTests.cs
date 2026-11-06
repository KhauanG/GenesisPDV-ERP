using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.VisualTree;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.App.ViewModels;
using GenesisPDV.App.ViewModels.Central;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Ativacao;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Central do PDV, bloco G9 (plano 4.6 e 5.4; PC-12; README › decisão 76): o pacote de suporte. O critério de bloqueio é a
/// <b>varredura de segredos</b>: token, chave privada, <c>backup.chave</c>, hash de PIN, CPF e BR Code plantados no banco,
/// na configuração do terminal e no arquivo de log; nenhum aparece nos bytes do zip nem em nenhum arquivo dele
/// descompactado. Também: o zip nunca tem <c>.db</c>, <c>-wal</c>, <c>-shm</c> nem <c>.gz</c>; o manifesto confere os
/// hashes; a auditoria <c>exportar</c> com quem liberou; os três cliques (⚙, P, Gerar) e o botão do Painel; e a geração na
/// tela de erro fatal com o banco inacessível (sem abrir o banco) e na de terminal bloqueado (a ocorrência gravada).
/// </summary>
public class PacoteSuporteTelasTests
{
    private static readonly Guid Maria = Guid.Parse("019a0003-0000-7000-8000-000000000001");
    private static readonly Guid Carlos = Guid.Parse("019a0003-0000-7000-8000-000000000002");

    private const string Token = "TOKEN-PLANTADO-7f3e9a";
    private const string Senha = "SENHAPLANTADA42";
    private const string CorpoChavePrivada = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCHAVEPRIVADAPLANTADA";
    private const string ChaveBackup = "BACKUPCHAVEPLANTADA+q1w2e3r4==";
    private const string SalPin = "SALPLANTADO0123456789";
    private const string HashPin = "$argon2id$v=19$m=65536,t=3,p=1$" + SalPin + "$HASHPLANTADOabcdefghij";
    private const string CpfPontuado = "123.456.789-09";
    private const string CpfDigitos = "12345678909";
    private const string ChavePix = "PIXPLANTADO";

    /// <summary>A conta do Windows que ativou o caixa (<c>ativacao.conta</c>): a tela de "ativado com outra conta" a mostra.</summary>
    private const string ContaQueAtivou = @"LOJA\FULANO.ATIVOU";

    /// <summary>Um BR Code (EMV) completo, com a chave PIX plantada.</summary>
    private const string BrCode = "000201" + "2633" + "0014br.gov.bcb.pix" + "0111" + ChavePix + "52040000" + "5303986" + "5802BR"
                                  + "5909LOJA DEMO" + "6009SAO PAULO" + "6304ABCD";

    private static readonly string[] Segredos =
    [
        Token, Senha, CorpoChavePrivada, ChaveBackup, SalPin, CpfPontuado, CpfDigitos, ChavePix, "br.gov.bcb.pix",
        Convert.ToBase64String(Encoding.UTF8.GetBytes(Token)), "BEGIN PRIVATE KEY", "FULANO.ATIVOU",
    ];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    /// <summary>Os destinos do teste: um "pendrive" e a "pasta dos Documentos", as duas na pasta do teste.</summary>
    private sealed class DestinosTeste(string raiz) : IDestinosPacote
    {
        public DestinoPacote Pendrive { get; } = new("Pendrive E:\\ (TESTE)", Path.Combine(raiz, "pendrive"), true);

        public DestinoPacote Documentos { get; } = new("Documentos › GenesisPDV-suporte", Path.Combine(raiz, "documentos", "GenesisPDV-suporte"), false);

        public bool SemPendrive { get; set; }

        public IReadOnlyList<DestinoPacote> Listar() => SemPendrive ? [Documentos] : [Pendrive, Documentos];
    }

    /// <summary>Os destinos do teste dentro da pasta do próprio PDV (o <see cref="AmbienteUi"/> apaga tudo junto no fim).</summary>
    private static DestinosTeste Destinos(out string raiz)
    {
        raiz = AmbienteUi.NovaRaiz();
        return new DestinosTeste(Path.Combine(raiz, "destinos"));
    }

    private static async Task<AmbienteUi> IniciarAsync(DestinosTeste destinos, string? raiz = null, bool apagar = true, Action<IServiceCollection>? ajustar = null) =>
        await AmbienteUi.IniciarAsync(raiz, apagar, s =>
        {
            AutenticadorComExtras.Registrar(s);
            s.AddSingleton<IDestinosPacote>(destinos);
            ajustar?.Invoke(s);
        });

    /// <summary>Grava (ou troca) uma chave do <c>configuracao_terminal</c>, em JSON como o PDV grava.</summary>
    private static async Task GravarConfiguracaoAsync(AmbienteUi pdv, string chave, string valor)
    {
        await using var db = Banco(pdv);
        await db.ConfiguracaoTerminal.Where(c => c.Chave == chave).ExecuteDeleteAsync(Ct);
        db.ConfiguracaoTerminal.Add(new ConfiguracaoTerminal { Chave = chave, Valor = System.Text.Json.JsonSerializer.Serialize(valor), AtualizadoEm = DateTimeOffset.UtcNow });
        await db.SaveChangesAsync(Ct);
    }

    /// <summary>O arquivo técnico de hoje, como o Serilog grava, com os segredos numa linha e numa exceção de várias linhas.</summary>
    private static void PlantarLog(AmbienteUi pdv) => PlantarLog(pdv.Caminhos.PastaLogs);

    private static void PlantarLog(string pastaLogs)
    {
        var agora = DateTimeOffset.Now;
        Directory.CreateDirectory(pastaLogs);
        File.WriteAllText(Path.Combine(pastaLogs, $"{ConfiguracaoLog.PrefixoArquivo}{agora:yyyyMMdd}.log"),
            $"{agora.AddMinutes(-3):yyyy-MM-dd HH:mm:ss.fff zzz} [INF] cx1-0000abcd GenesisPDV.App.Servicos.ServicoVenda Venda finalizada para o CPF {CpfPontuado}\n"
            + $"{agora.AddMinutes(-2):yyyy-MM-dd HH:mm:ss.fff zzz} [ERR] cx1-0000abcd GenesisPDV.Sync.Cliente.ServicoSincronizacaoHttp Push falhou: Authorization: Bearer {Token}\n"
            + $"System.InvalidOperationException: senha={Senha} pin: 9876 hash {HashPin} qr {BrCode}\n"
            + "-----BEGIN PRIVATE KEY-----\n" + CorpoChavePrivada + "\n" + CorpoChavePrivada + "\n-----END PRIVATE KEY-----\n"
            + "   at GenesisPDV.Sync.Cliente.ClienteSyncHttp.EnviarAsync()\n"
            + $"{agora.AddMinutes(-1):yyyy-MM-dd HH:mm:ss.fff zzz} [INF] cx1-0000abcd GenesisPDV.App.Servicos.ServicoBackup Backup feito com {{\"backup.chave\":\"{ChaveBackup}\",\"token\":\"{Token}\"}}\n",
            new UTF8Encoding(false));
    }

    /// <summary>Os segredos no banco e na configuração do terminal, onde eles existem de verdade (e alguns onde não deviam).</summary>
    private static async Task PlantarNoBancoAsync(AmbienteUi pdv)
    {
        await using var db = Banco(pdv);
        var agora = DateTimeOffset.UtcNow;
        // O token protegido da identidade (os bytes "decifrados", para a varredura achar se eles saírem).
        await db.IdentidadeTerminal.ExecuteUpdateAsync(i => i.SetProperty(x => x.TokenProtegido, Encoding.UTF8.GetBytes(Token)), Ct);
        // As chaves internas do terminal e uma exibível com o perfil do Windows no caminho.
        await db.ConfiguracaoTerminal.Where(c => c.Chave == ChavesConfiguracaoTerminal.ContaAtivacao).ExecuteDeleteAsync(Ct);
        foreach (var (chave, valor) in new[]
                 {
                     (ChavesConfiguracaoTerminal.ContaAtivacao, ContaQueAtivou),
                     (ChavesConfiguracaoTerminal.BackupChave, ChaveBackup),
                     (ChavesConfiguracaoTerminal.ChavePrivadaTerminal, "-----BEGIN PRIVATE KEY-----\n" + CorpoChavePrivada + "\n-----END PRIVATE KEY-----"),
                     (ChavesConfiguracaoTerminal.TokenPendente, Token),
                     (Data.Backup.BackupLocal.ChavePastaSecundaria, "/home/fulano/pendrive"),
                 })
        {
            db.ConfiguracaoTerminal.Add(new ConfiguracaoTerminal { Chave = chave, Valor = System.Text.Json.JsonSerializer.Serialize(valor), AtualizadoEm = agora });
        }

        // O hash do PIN de um usuário do espelho.
        db.Usuarios.Add(new UsuarioRegistro
        {
            Id = IdGerador.Novo(),
            Codigo = 77,
            Nome = "PLANTADO",
            Login = "plantado",
            SenhaPdvHash = HashPin,
            Ativo = true,
            CriadoEm = agora,
            AtualizadoEm = agora,
        });

        // Um registro do outbox com o payload e o contexto cheios de segredo, recusado com o erro mascarável.
        db.EventosSaida.Add(new EventoSaida
        {
            Id = IdGerador.Novo(),
            SequenciaTerminal = 9_000,
            Tipo = "venda.finalizada",
            AgregadoTipo = "venda",
            AgregadoId = IdGerador.Novo(),
            OcorridoEm = agora,
            CriadoEm = agora,
            Status = StatusEventoSaida.Rejeitado,
            Tentativas = 3,
            Payload = new JsonObject { ["cpf_cnpj_nota"] = CpfDigitos, ["br_code"] = BrCode, ["token"] = Token }.ToJsonString(),
            PayloadSha256 = new string('a', 64),
            Contexto = new JsonObject { ["senha"] = Senha }.ToJsonString(),
            UltimoErro = $"PAYLOAD_INVALIDO: cliente {CpfPontuado} token={Token}",
            Resultado = new JsonObject { ["erro"] = $"cpf {CpfPontuado}" }.ToJsonString(),
        });

        // A fila de impressão: o cupom com o QR do PIX e o CPF nos bytes; o erro com a senha.
        db.FilaImpressao.Add(new FilaImpressao
        {
            Id = IdGerador.Novo(),
            TipoDocumento = "cupom",
            Conteudo = Encoding.UTF8.GetBytes($"CPF {CpfPontuado} {BrCode}"),
            Status = "falhou",
            Tentativas = 2,
            UltimoErro = $"Impressora recusou: senha={Senha}",
            CriadoEm = agora,
        });

        // Um comando do ERP com o resultado que traz um token e um CPF.
        db.ComandosRecebidos.Add(new ComandoRecebido
        {
            ComandoId = IdGerador.Novo(),
            Tipo = "enviar_logs",
            RecebidoEm = agora,
            Status = "falhou",
            Resultado = new JsonObject { ["token"] = Token, ["cpf_cnpj"] = CpfDigitos, ["erro"] = "não suportado nesta versão" }.ToJsonString(),
        });

        // E um que falhou com a mensagem da exceção em várias linhas e com aspas, como o ProcessadorComandos grava
        // ({"erro": e.Message} pelo ToJsonString padrão: a quebra vira \n e a aspa vira \u0022).
        db.ComandosRecebidos.Add(new ComandoRecebido
        {
            ComandoId = IdGerador.Novo(),
            Tipo = "mensagem",
            RecebidoEm = agora,
            Status = "falhou",
            Resultado = new JsonObject { ["erro"] = $"falhou ao ler\nsenha={Senha} e\nBearer {Token} e \"token\":\"{Token}\"" }.ToJsonString(),
        });

        // Uma ocorrência com o CPF na mensagem e os segredos nos dados e no texto técnico (com quebra de linha e aspas).
        db.LogLocal.Add(Ocorrencias.Nova(agora, NiveisOcorrencia.Erro, CodigoOcorrencia.ErroInesperado, $"Falha com o cliente {CpfPontuado}",
            new JsonObject { ["token"] = Token, ["cpf_cnpj"] = CpfDigitos, ["br_code"] = BrCode },
            texto: $"System.Exception: \"senha={Senha}\"\n   Bearer {Token}\n {HashPin}\n {BrCode}"));

        // A auditoria com o CPF no motivo (o resumo leva só a contagem por ação e dia).
        db.LogAuditoriaLocal.Add(new LogAuditoriaLocal
        {
            Id = IdGerador.Novo(),
            OcorridoEm = agora,
            Acao = "gaveta_aberta",
            UsuarioId = Maria,
            Motivo = $"troco para {CpfPontuado}",
            Descricao = $"Gaveta aberta {Token}",
            Depois = new JsonObject { ["senha"] = Senha }.ToJsonString(),
        });
        await db.SaveChangesAsync(Ct);
    }

    /// <summary>Todos os arquivos do zip, descompactados.</summary>
    private static Dictionary<string, byte[]> Abrir(string zip)
    {
        using var arquivo = ZipFile.OpenRead(zip);
        return arquivo.Entries.ToDictionary(e => e.FullName, e =>
        {
            using var s = e.Open();
            using var m = new MemoryStream();
            s.CopyTo(m);
            return m.ToArray();
        });
    }

    /// <summary>A varredura: nenhum segredo nos bytes do zip nem em nenhum arquivo dele (texto UTF-8, também sem as aspas do CSV).</summary>
    private static void SemSegredos(string zip, Dictionary<string, byte[]> arquivos)
    {
        var bruto = Encoding.Latin1.GetString(File.ReadAllBytes(zip));
        foreach (var segredo in Segredos)
        {
            Assert.DoesNotContain(segredo, bruto, StringComparison.Ordinal);
        }

        foreach (var (nome, bytes) in arquivos)
        {
            var texto = Encoding.UTF8.GetString(bytes);
            var semAspas = texto.Replace("\"\"", "\"", StringComparison.Ordinal).Replace("\\\"", "\"", StringComparison.Ordinal);
            foreach (var segredo in Segredos)
            {
                Assert.False(texto.Contains(segredo, StringComparison.Ordinal) || semAspas.Contains(segredo, StringComparison.Ordinal),
                    $"{segredo} apareceu em {nome}");
            }

            Assert.DoesNotContain("SQLite format 3", texto, StringComparison.Ordinal);
        }
    }

    /// <summary>Nenhum banco nem backup no zip, todo nome na lista de permitidos e o manifesto conferindo cada arquivo.</summary>
    private static JsonObject ConferirManifesto(Dictionary<string, byte[]> arquivos)
    {
        Assert.All(arquivos.Keys, nome =>
        {
            Assert.True(ServicoPacoteSuporte.Permitido(nome), $"{nome} fora da lista de permitidos");
            Assert.False(nome.EndsWith(".db", StringComparison.OrdinalIgnoreCase) || nome.EndsWith("-wal", StringComparison.OrdinalIgnoreCase)
                         || nome.EndsWith("-shm", StringComparison.OrdinalIgnoreCase) || nome.EndsWith(".gz", StringComparison.OrdinalIgnoreCase), nome);
        });
        var manifesto = (JsonObject)JsonNode.Parse(arquivos[ServicoPacoteSuporte.Manifesto])!;
        var listados = manifesto["arquivos"]!.AsArray().Select(a => a!.AsObject()).ToList();
        Assert.Equal(arquivos.Keys.Where(n => n != ServicoPacoteSuporte.Manifesto).Order(StringComparer.Ordinal),
            listados.Select(a => (string)a["nome"]!).Order(StringComparer.Ordinal));
        foreach (var a in listados)
        {
            var bytes = arquivos[(string)a["nome"]!];
            Assert.Equal((long)a["bytes"]!, bytes.LongLength);
            Assert.Equal((string)a["sha256"]!, Convert.ToHexStringLower(SHA256.HashData(bytes)));
        }

        return manifesto;
    }

    [AvaloniaFact]
    public async Task Pacote_completo_pelo_login_nao_leva_nenhum_segredo_plantado_e_o_manifesto_confere()
    {
        var destinos = Destinos(out var raiz);
        using var pdv = await IniciarAsync(destinos, raiz);
        await pdv.AtivarDemonstracaoELogarAsync();
        await PlantarNoBancoAsync(pdv);
        PlantarLog(pdv);
        pdv.Shell.IrParaLogin();

        // Três passos: a engrenagem (aqui pelo login, com o PIN do dono), o P e o Enter que gera no pendrive.
        var central = await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        Assert.False(central.Abas.Single(a => a.Codigo == "P").Bloqueada);
        pdv.Tecla(Key.P);
        await pdv.EsperarAsync(() => central.Conteudo is AbaPacoteViewModel { Ocupado: false, Destinos.Count: 2 }, "aba P Pacote de suporte");
        var aba = (AbaPacoteViewModel)central.Conteudo!;
        await pdv.EsperarFocoAsync("TelaPacote");
        Assert.Equal(destinos.Pendrive, aba.DestinoSelecionado);
        pdv.Tecla(Key.Down);
        Assert.Equal(destinos.Documentos, aba.DestinoSelecionado);
        pdv.Tecla(Key.Up);
        Assert.Equal(destinos.Pendrive, aba.DestinoSelecionado);
        Assert.Contains("Nunca entra", pdv.Texto("TextoPacoteNuncaEntra"), StringComparison.Ordinal);
        Assert.All(new[] { "BotaoGerarPacote", "BotaoProcurarPendrive", "BotaoVoltarPacote" },
            b => Assert.True(pdv.Controle<Button>(b).Bounds.Height >= 44, $"{b} grande o bastante para o mouse"));
        pdv.Captura("90-central-pacote");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.Ultimo is not null && !aba.Ocupado, $"pacote gerado ({aba.Erro})", timeoutMs: 30_000);
        var r = aba.Ultimo!;
        Assert.Null(aba.Erro);
        Assert.StartsWith(destinos.Pendrive.Pasta, r.Arquivo, StringComparison.Ordinal);
        Assert.Matches(@"^suporte-loja1-cx\d{2}-\d{8}-\d{4}\.zip$", r.Nome);
        Assert.Contains("Pacote salvo em Pendrive E:", aba.Mensagem, StringComparison.Ordinal);
        Assert.Contains("entregue só ao suporte", aba.Mensagem, StringComparison.Ordinal);
        Assert.Empty(Directory.GetFiles(destinos.Pendrive.Pasta, "*.parcial"));
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(r.Arquivo, Ct))), r.Sha256);

        // A varredura (o critério de bloqueio do bloco) e a lista de permitidos.
        var arquivos = Abrir(r.Arquivo);
        SemSegredos(r.Arquivo, arquivos);
        var manifesto = ConferirManifesto(arquivos);
        foreach (var esperado in new[]
                 {
                     ServicoPacoteSuporte.Manifesto, ServicoPacoteSuporte.Saude, ServicoPacoteSuporte.StatusSync, ServicoPacoteSuporte.Outbox,
                     ServicoPacoteSuporte.Comandos, ServicoPacoteSuporte.OcorrenciasCsv, ServicoPacoteSuporte.ConfiguracaoTerminalJson,
                     ServicoPacoteSuporte.ConfiguracoesEfetivas, ServicoPacoteSuporte.BackupsCsv, ServicoPacoteSuporte.FilaImpressaoCsv,
                     ServicoPacoteSuporte.Disco, ServicoPacoteSuporte.AuditoriaResumo,
                 })
        {
            Assert.True(arquivos.ContainsKey(esperado), $"{esperado} no pacote");
        }

        Assert.DoesNotContain(ServicoPacoteSuporte.DiagnosticoTxt, arquivos.Keys);
        Assert.Single(arquivos.Keys, n => n.StartsWith(ServicoPacoteSuporte.PastaLogs, StringComparison.Ordinal));
        Assert.Equal("completo", (string)manifesto["modo"]!);
        Assert.Equal("CARLOS", (string)manifesto["gerado_por"]!);
        Assert.Null(manifesto["liberado_por"]);
        Assert.Empty(manifesto["avisos"]!.AsArray());
        Assert.Equal(pdv.Servicos.GetRequiredService<SessaoTerminal>().Identidade!.CodigoCurto, (string)manifesto["terminal"]!["codigo"]!);

        // O que entrou está lá, mascarado (o suporte entende o problema): o recusado, a ocorrência, o log com a exceção.
        string Texto(string nome) => Encoding.UTF8.GetString(arquivos[nome]);
        Assert.Contains("PAYLOAD_INVALIDO: cliente ***.***.***-**", Texto(ServicoPacoteSuporte.Outbox), StringComparison.Ordinal);
        Assert.Contains("Falha com o cliente ***.***.***-**", Texto(ServicoPacoteSuporte.OcorrenciasCsv), StringComparison.Ordinal);
        Assert.Contains("enviar_logs", Texto(ServicoPacoteSuporte.Comandos), StringComparison.Ordinal);
        Assert.Contains("senha=***", Texto(ServicoPacoteSuporte.Comandos), StringComparison.Ordinal);
        Assert.Contains(";gaveta_aberta;", Texto(ServicoPacoteSuporte.AuditoriaResumo), StringComparison.Ordinal);
        Assert.Contains("falhou", Texto(ServicoPacoteSuporte.FilaImpressaoCsv), StringComparison.Ordinal);
        Assert.Contains(MascaradorSuporte.PerfilUsuario, Texto(ServicoPacoteSuporte.ConfiguracaoTerminalJson), StringComparison.Ordinal);
        Assert.DoesNotContain(ChavesConfiguracaoTerminal.BackupChave, Texto(ServicoPacoteSuporte.ConfiguracaoTerminalJson), StringComparison.Ordinal);
        var log = Texto(arquivos.Keys.Single(n => n.StartsWith(ServicoPacoteSuporte.PastaLogs, StringComparison.Ordinal)));
        Assert.Contains("Push falhou: Authorization: ", log, StringComparison.Ordinal);
        Assert.Contains(MascaradorSuporte.Mascara, log, StringComparison.Ordinal);
        Assert.Contains(MascaradorSuporte.MascaraChavePrivada, log, StringComparison.Ordinal);
        Assert.Contains("ClienteSyncHttp.EnviarAsync()", log, StringComparison.Ordinal);
        Assert.NotEmpty(JsonNode.Parse(arquivos[ServicoPacoteSuporte.Saude])!["itens"]!.AsArray());

        // A auditoria exportar (sobe no lote) e a ocorrência PACOTE_GERADO, com o hash do zip; nada de caminho.
        await using (var db = Banco(pdv))
        {
            var exportar = await db.LogAuditoriaLocal.AsNoTracking().SingleAsync(a => a.Acao == "exportar", Ct);
            Assert.Equal(ServicoPacoteSuporte.EntidadePacote, exportar.Entidade);
            Assert.Equal(Carlos, exportar.UsuarioId);
            Assert.Null(exportar.AutorizadoPorId);
            Assert.Equal(ServicoPacoteSuporte.LocalizacaoCentral, exportar.Localizacao);
            var depois = JsonNode.Parse(exportar.Depois!)!;
            Assert.Equal(r.Sha256, (string)depois["sha256"]!);
            Assert.Equal("pendrive", (string)depois["destino"]!);
            Assert.DoesNotContain(destinos.Pendrive.Pasta, exportar.Depois, StringComparison.Ordinal);
            var ocorrencias = await db.LogLocal.AsNoTracking().Select(l => l.Detalhes).ToListAsync(Ct);
            Assert.Single(ocorrencias, d => Ocorrencias.CodigoDe(d) == CodigoOcorrencia.PacoteGerado.Codigo);
        }

        // O segundo pacote no mesmo minuto não apaga o primeiro; sem pendrive (F5), vai para os Documentos.
        destinos.SemPendrive = true;
        pdv.Clicar(pdv.Controle<Button>("BotaoProcurarPendrive"));
        await pdv.EsperarAsync(() => aba.Destinos.Count == 1 && !aba.Ocupado, "só os Documentos");
        Assert.Equal(destinos.Documentos, aba.DestinoSelecionado);
        Assert.Contains("Nenhum pendrive", aba.DestinosTexto, StringComparison.Ordinal);
        pdv.Clicar(pdv.Controle<Button>("BotaoGerarPacote"));
        await pdv.EsperarAsync(() => aba.Ultimo != r && !aba.Ocupado, $"segundo pacote ({aba.Erro})", timeoutMs: 30_000);
        Assert.StartsWith(destinos.Documentos.Pasta, aba.Ultimo!.Arquivo, StringComparison.Ordinal);
        Assert.True(File.Exists(r.Arquivo));
        SemSegredos(aba.Ultimo.Arquivo, Abrir(aba.Ultimo.Arquivo));

        // Esc volta ao menu.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "P", "foco no menu");
    }

    [AvaloniaFact]
    public async Task Operadora_pelo_botao_do_painel_pede_o_supervisor_e_o_pacote_leva_quem_liberou()
    {
        var destinos = Destinos(out var raiz);
        using var pdv = await IniciarAsync(destinos, raiz);
        await pdv.AtivarDemonstracaoELogarAsync();

        // A MARIA (operadora) abre a Central na venda; o botão do rodapé do Painel leva à aba P, que tem o cadeado.
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        var central = await pdv.EsperarCentralAsync();
        Assert.True(central.Abas.Single(a => a.Codigo == "P").Bloqueada);
        await pdv.EsperarAsync(() => central.Conteudo is AbaPainelViewModel, "Painel");
        Assert.True(pdv.Controle<Button>("BotaoPacotePainel").Bounds.Height >= 44);
        pdv.Clicar(pdv.Controle<Button>("BotaoPacotePainel"));
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "2";
        central.PinLiberacao = "4321";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => central.Conteudo is AbaPacoteViewModel { Ocupado: false, Destinos.Count: > 0 }, "aba P liberada");
        var aba = (AbaPacoteViewModel)central.Conteudo!;
        pdv.Clicar(pdv.Controle<Button>("BotaoGerarPacote"));
        await pdv.EsperarAsync(() => aba.Ultimo is not null && !aba.Ocupado, $"pacote gerado ({aba.Erro})", timeoutMs: 30_000);

        var manifesto = ConferirManifesto(Abrir(aba.Ultimo!.Arquivo));
        Assert.Equal("MARIA", (string)manifesto["gerado_por"]!);
        Assert.Equal("CARLOS", (string)manifesto["liberado_por"]!);
        await using (var db = Banco(pdv))
        {
            var exportar = await db.LogAuditoriaLocal.AsNoTracking().SingleAsync(a => a.Acao == "exportar", Ct);
            Assert.Equal(Maria, exportar.UsuarioId);
            Assert.Equal(Carlos, exportar.AutorizadoPorId);
        }

        // Na D22 o pacote sai, mas a auditoria é recusada: a tela diz que não ficou no histórico (não "não deu certo").
        await using (var db = Banco(pdv))
        {
            Assert.Equal(1, await db.EstadoConexao.ExecuteUpdateAsync(e => e.SetProperty(x => x.ConfirmandoDesativacaoEm, DateTimeOffset.UtcNow), Ct));
        }

        var primeiro = aba.Ultimo;
        pdv.Tecla(Key.F2);
        await pdv.EsperarAsync(() => aba.Ultimo != primeiro && !aba.Ocupado, $"pacote na D22 ({aba.Erro})", timeoutMs: 30_000);
        Assert.True(File.Exists(aba.Ultimo!.Arquivo));
        Assert.StartsWith("O pacote foi gerado, mas não ficou registrado no histórico", aba.Ultimo.AvisoRegistro, StringComparison.Ordinal);
        Assert.Contains("não ficou registrado no histórico", aba.Mensagem, StringComparison.Ordinal);
        await using (var db = Banco(pdv))
        {
            Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(a => a.Acao == "exportar", Ct));
        }
    }

    [AvaloniaFact]
    public async Task Servico_recusa_sem_a_permissao_e_os_nomes_fora_da_lista()
    {
        var destinos = Destinos(out var raiz);
        using var pdv = await IniciarAsync(destinos, raiz);
        await pdv.AtivarDemonstracaoELogarAsync();
        var servico = pdv.Servicos.GetRequiredService<ServicoPacoteSuporte>();
        var acesso = pdv.Servicos.GetRequiredService<AcessoCentral>();

        // Sem a Central aberta, e com a MARIA (sem a permissão): recusa, nada no pendrive.
        await Assert.ThrowsAsync<RegraNegocioException>(() => servico.GerarAsync(destinos.Pendrive, Ct));
        acesso.AbrirPelaVenda(pdv.Servicos.GetRequiredService<SessaoTerminal>().Operador!);
        var e = await Assert.ThrowsAsync<RegraNegocioException>(() => servico.GerarAsync(destinos.Pendrive, Ct));
        Assert.Equal(ServicoPacoteSuporte.MensagemSemPermissao, e.Message);
        Assert.False(Directory.Exists(destinos.Pendrive.Pasta));
        acesso.Encerrar();

        foreach (var proibido in new[]
                 {
                     "pdv.db", "pdv.db-wal", "pdv.db-shm", "backup/pdv-20261105-101010-000-periodico.db.gz", "encerramento.json", "chave_terminal",
                     "logs/../pdv.db", "logs/pdv.db", "logs\\genesispdv-20261105.log", "/etc/genesispdv/chave_terminal", "outbox.csv.gz",
                 })
        {
            Assert.False(ServicoPacoteSuporte.Permitido(proibido), proibido);
            Assert.Throws<InvalidOperationException>(() => ServicoPacoteSuporte.ExigirPermitido(proibido));
        }

        Assert.True(ServicoPacoteSuporte.Permitido("logs/genesispdv-20261105.log"));
        Assert.True(ServicoPacoteSuporte.Permitido("logs/genesispdv-20261105_001.log"));
        Assert.True(ServicoPacoteSuporte.Permitido(ServicoPacoteSuporte.Outbox));
    }

    [AvaloniaFact]
    public async Task Erro_fatal_com_o_banco_inacessivel_gera_o_pacote_sem_abrir_o_banco()
    {
        var raiz = AmbienteUi.NovaRaiz();
        var destinos = new DestinosTeste(Path.Combine(raiz, "destinos"));
        try
        {
            using (var pdv = await IniciarAsync(destinos, raiz, apagar: false))
            {
                await pdv.AtivarDemonstracaoELogarAsync();
            }

            // O banco corrompido e nenhum backup: a tela de erro fatal ("Banco local com problema").
            var caminhos = CaminhosPdv.SobRaiz(raiz);
            SqliteConnection.ClearAllPools();
            foreach (var sufixo in new[] { "-wal", "-shm" })
            {
                File.Delete(caminhos.ArquivoBanco + sufixo);
            }

            foreach (var backup in Directory.GetFiles(caminhos.PastaBackup))
            {
                File.Delete(backup);
            }

            await File.WriteAllBytesAsync(caminhos.ArquivoBanco, [.. Enumerable.Repeat((byte)0x42, 8192)], Ct);
            PlantarLog(caminhos.PastaLogs);
            using var reaberto = await IniciarAsync(destinos, raiz, apagar: false);
            var erro = Assert.IsType<ErroFatalViewModel>(reaberto.Shell.PaginaAtual);
            Assert.Equal("Banco local com problema", erro.Titulo);
            var banco = Directory.GetFiles(caminhos.PastaDados, "pdv.db*").ToDictionary(a => a, LerCompartilhado);

            // F2 (ou o botão): o pacote sem login e sem banco, no pendrive.
            Assert.Contains("F2", reaberto.Controle<Button>("BotaoPacoteErroFatal").Content as string, StringComparison.Ordinal);
            reaberto.Tecla(Key.F2);
            await reaberto.EsperarAsync(() => erro.Pacote.Ultimo is not null && !erro.Pacote.Ocupado, $"pacote sem banco ({erro.Pacote.Erro})", timeoutMs: 30_000);
            var r = erro.Pacote.Ultimo!;
            Assert.StartsWith(destinos.Pendrive.Pasta, r.Arquivo, StringComparison.Ordinal);
            Assert.Matches(@"^suporte-caixa-\d{8}-\d{4}\.zip$", r.Nome);
            Assert.Contains("entregue só ao suporte", reaberto.Texto("TextoPacoteErroFatal"), StringComparison.Ordinal);

            var arquivos = Abrir(r.Arquivo);
            SemSegredos(r.Arquivo, arquivos);
            var manifesto = ConferirManifesto(arquivos);
            Assert.Equal(
                new[] { ServicoPacoteSuporte.DiagnosticoTxt, ServicoPacoteSuporte.Manifesto },
                arquivos.Keys.Where(n => !n.StartsWith(ServicoPacoteSuporte.PastaLogs, StringComparison.Ordinal)).Order(StringComparer.Ordinal));
            Assert.Single(arquivos.Keys, n => n.StartsWith(ServicoPacoteSuporte.PastaLogs, StringComparison.Ordinal));
            Assert.Equal("sem_banco", (string)manifesto["modo"]!);
            Assert.False(manifesto.ContainsKey("gerado_por"));
            var diagnostico = Encoding.UTF8.GetString(arquivos[ServicoPacoteSuporte.DiagnosticoTxt]);
            Assert.Contains("Banco local com problema", diagnostico, StringComparison.Ordinal);
            Assert.Contains("entregue só ao suporte", diagnostico, StringComparison.Ordinal);

            // O banco não foi aberto nem mexido (nada criado ao lado, nenhum byte diferente).
            Assert.Equal(banco.Keys.Order(StringComparer.Ordinal), Directory.GetFiles(caminhos.PastaDados, "pdv.db*").Order(StringComparer.Ordinal));
            foreach (var (arquivo, bytes) in banco)
            {
                Assert.Equal(bytes, LerCompartilhado(arquivo));
            }
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(raiz, recursive: true);
        }
    }

    [AvaloniaFact]
    public async Task Terminal_bloqueado_gera_o_pacote_sem_login_e_grava_a_ocorrencia()
    {
        var destinos = Destinos(out var raiz);
        destinos.SemPendrive = true;
        using var pdv = await IniciarAsync(destinos, raiz);
        await pdv.AtivarDemonstracaoELogarAsync();
        await PlantarNoBancoAsync(pdv);
        PlantarLog(pdv);
        // A mensagem com a conta que ativou o caixa (a da tela de "ativado com outra conta"): no pacote, ela fica escondida.
        var tela = new TerminalBloqueadoViewModel(pdv.Shell, TerminalBloqueadoViewModel.TituloDesativado,
            $"O ERP desativou este caixa (token={Token}). {MensagensAtivacao.ContaDiferente(ContaQueAtivou, @"LOJA\caixa2")}", podeTentarDeNovo: false);
        pdv.Shell.PaginaAtual = tela;
        await pdv.EsperarAsync(() => pdv.Janela.GetVisualDescendants().OfType<Button>().Any(b => b.Name == "BotaoPacoteBloqueado"), "tela do terminal bloqueado");
        Assert.Contains("F2", tela.Rodape, StringComparison.Ordinal);
        pdv.Clicar(pdv.Controle<Button>("BotaoPacoteBloqueado"));
        await pdv.EsperarAsync(() => tela.Pacote.Ultimo is not null && !tela.Pacote.Ocupado, $"pacote ({tela.Pacote.Erro})", timeoutMs: 30_000);
        var r = tela.Pacote.Ultimo!;
        Assert.StartsWith(destinos.Documentos.Pasta, r.Arquivo, StringComparison.Ordinal);
        var arquivos = Abrir(r.Arquivo);
        SemSegredos(r.Arquivo, arquivos);
        Assert.Equal("sem_banco", (string)ConferirManifesto(arquivos)["modo"]!);
        var diagnostico = Encoding.UTF8.GetString(arquivos[ServicoPacoteSuporte.DiagnosticoTxt]);
        Assert.Contains(TerminalBloqueadoViewModel.TituloDesativado, diagnostico, StringComparison.Ordinal);
        Assert.Contains("Eventos não confirmados", diagnostico, StringComparison.Ordinal);
        Assert.Contains($"pela conta \"{MascaradorSuporte.ContaAtivacao}\"", diagnostico, StringComparison.Ordinal);
        Assert.True(pdv.Controle<Button>("BotaoPacoteBloqueado").Bounds.Height >= 44, "botão grande o bastante para o mouse");

        // Aqui o banco abriu: a ocorrência fica (sem auditoria: não há ninguém logado).
        await using var db = Banco(pdv);
        var detalhes = await db.LogLocal.AsNoTracking().Select(l => l.Detalhes).ToListAsync(Ct);
        var gerado = Assert.Single(detalhes, d => Ocorrencias.CodigoDe(d) == CodigoOcorrencia.PacoteGerado.Codigo);
        Assert.True((bool)JsonNode.Parse(gerado!)!["sem_banco"]!);
        var mensagem = await db.LogLocal.AsNoTracking().Where(l => l.Detalhes == gerado).Select(l => l.Mensagem).SingleAsync(Ct);
        Assert.Contains("sem login, na tela de terminal bloqueado", mensagem, StringComparison.Ordinal);
        Assert.False(await db.LogAuditoriaLocal.AnyAsync(a => a.Acao == "exportar", Ct));
    }

    [AvaloniaFact]
    public async Task Registro_gigante_cortado_no_meio_da_chave_privada_nao_vaza_o_resto_dela()
    {
        var pasta = AmbienteUi.NovaRaiz();
        Directory.CreateDirectory(pasta);
        try
        {
            var arquivo = Path.Combine(pasta, "genesispdv-20261105.log");
            var texto = new StringBuilder();
            texto.Append("2026-11-05 10:00:00.000 -03:00 [ERR] cx1-0000abcd Categoria.Teste Laço com um texto enorme\n");
            var enchimento = new string('x', 1023) + "\n";
            while (texto.Length + enchimento.Length < ServicoPacoteSuporte.MaximoRegistro - 100)
            {
                texto.Append(enchimento);
            }

            texto.Append("-----BEGIN PRIVATE KEY-----\n");
            for (var i = 0; i < 5; i++)
            {
                texto.Append(CorpoChavePrivada).Append(new string('Q', 200)).Append('\n');
            }

            texto.Append("-----END PRIVATE KEY-----\n");
            texto.Append($"2026-11-05 10:00:01.000 -03:00 [INF] cx1-0000abcd Categoria.Teste Depois da chave, token={Token}\n");
            await File.WriteAllTextAsync(arquivo, texto.ToString(), new UTF8Encoding(false), Ct);

            using var saida = new MemoryStream();
            var copia = ServicoPacoteSuporte.CopiarMascarado(arquivo, saida, ct: Ct);
            var mascarado = Encoding.UTF8.GetString(saida.ToArray());
            Assert.True(copia.Lidos > ServicoPacoteSuporte.MaximoRegistro);
            Assert.False(copia.ChaveSemFim);
            Assert.DoesNotContain(CorpoChavePrivada, mascarado, StringComparison.Ordinal);
            Assert.DoesNotContain(Token, mascarado, StringComparison.Ordinal);
            Assert.Contains(MascaradorSuporte.MascaraChavePrivada, mascarado, StringComparison.Ordinal);
            Assert.Contains("Depois da chave, token=***", mascarado, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(pasta, recursive: true);
        }
    }
    [AvaloniaFact]
    public async Task Chave_privada_cortada_sem_o_fim_nao_leva_junto_o_resto_do_log()
    {
        var pasta = AmbienteUi.NovaRaiz();
        Directory.CreateDirectory(pasta);
        try
        {
            // O registro gigante cortado dentro de uma chave que nunca recebe o END (o log truncado no meio dela).
            var arquivo = Path.Combine(pasta, "genesispdv-20261105.log");
            var texto = new StringBuilder();
            texto.Append("2026-11-05 10:00:00.000 -03:00 [ERR] cx1-0000abcd Categoria.Teste Laço com um texto enorme\n");
            var enchimento = new string('x', 1023) + "\n";
            while (texto.Length + enchimento.Length < ServicoPacoteSuporte.MaximoRegistro - 100)
            {
                texto.Append(enchimento);
            }

            texto.Append("-----BEGIN PRIVATE KEY-----\n");
            for (var i = 0; i < 5; i++)
            {
                texto.Append(CorpoChavePrivada).Append(new string('Q', 200)).Append('\n');
            }

            texto.Append($"2026-11-05 10:00:01.000 -03:00 [INF] cx1-0000abcd Categoria.Teste Depois da chave, token={Token}\n");
            texto.Append("2026-11-05 10:00:02.000 -03:00 [INF] cx1-0000abcd Categoria.Teste O registro seguinte também fica\n");
            await File.WriteAllTextAsync(arquivo, texto.ToString(), new UTF8Encoding(false), Ct);

            using var saida = new MemoryStream();
            var copia = ServicoPacoteSuporte.CopiarMascarado(arquivo, saida, ct: Ct);
            var mascarado = Encoding.UTF8.GetString(saida.ToArray());
            Assert.True(copia.ChaveSemFim);
            Assert.DoesNotContain(CorpoChavePrivada, mascarado, StringComparison.Ordinal);
            Assert.DoesNotContain(Token, mascarado, StringComparison.Ordinal);
            Assert.Contains(ServicoPacoteSuporte.MarcadorChaveSemFim, mascarado, StringComparison.Ordinal);
            Assert.Contains("Depois da chave, token=***", mascarado, StringComparison.Ordinal);
            Assert.Contains("O registro seguinte também fica", mascarado, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(pasta, recursive: true);
        }
    }

    [Theory]
    [InlineData("-1+1", "'-1+1")]
    [InlineData("-2+3+cmd|' /C calc'!A0", "'-2+3+cmd|' /C calc'!A0")]
    [InlineData("-1", "-1")]
    [InlineData("-12.5", "-12.5")]
    [InlineData("-", "'-")]
    [InlineData("-abc", "'-abc")]
    [InlineData("=SOMA(A1)", "'=SOMA(A1)")]
    [InlineData("+55", "'+55")]
    [InlineData("@cmd", "'@cmd")]
    [InlineData("texto; com ponto e vírgula", "\"texto; com ponto e vírgula\"")]
    [InlineData("-1;2", "\"'-1;2\"")]
    [InlineData("1234", "1234")]
    public void Campo_do_csv_so_deixa_o_menos_sem_apostrofo_no_numero(string valor, string esperado) =>
        Assert.Equal(esperado, ServicoPacoteSuporte.CampoCsv(valor));

    [Fact]
    public void Valor_da_configuracao_esconde_o_campo_de_nome_sensivel_inteiro()
    {
        var valor = ServicoPacoteSuporte.ValorMascarado("{\"senha\":\"abc123\",\"pin\":1234,\"pasta\":\"/home/fulano/backup\",\"ligado\":true}")!.AsObject();
        Assert.Equal(MascaradorSuporte.Mascara, (string)valor["senha"]!);
        Assert.Equal(MascaradorSuporte.Mascara, (string)valor["pin"]!);
        Assert.Equal($"{MascaradorSuporte.PerfilUsuario}/backup", (string)valor["pasta"]!);
        Assert.True((bool)valor["ligado"]!);
        Assert.Equal("\"5\"", ServicoPacoteSuporte.ValorMascarado("\"5\"")!.ToJsonString());
        Assert.Equal("texto solto", (string)ServicoPacoteSuporte.ValorMascarado("texto solto")!);
    }

    [Fact]
    public void Conta_que_ativou_o_caixa_some_do_texto()
    {
        // Windows: DOMÍNIO\usuário em qualquer lugar, também escapado no JSON (e sem diferenciar maiúsculas).
        Assert.Equal($"ativado por {MascaradorSuporte.ContaAtivacao} ontem",
            MascaradorSuporte.OcultarConta(@"ativado por loja\fulano.ativou ontem", ContaQueAtivou));
        Assert.Equal($"{{\"erro\":\"conta {MascaradorSuporte.ContaAtivacao}\"}}",
            MascaradorSuporte.OcultarConta(@"{""erro"":""conta LOJA\\FULANO.ATIVOU""}", ContaQueAtivou));
        // Linux: o nome curto só entre aspas (não come "fulano.txt" nem outra palavra).
        Assert.Equal($"pela conta \"{MascaradorSuporte.ContaAtivacao}\" e o arquivo fulano.txt",
            MascaradorSuporte.OcultarConta("pela conta \"fulano\" e o arquivo fulano.txt", "fulano"));
        Assert.Equal("sem conta", MascaradorSuporte.OcultarConta("sem conta", null));
    }

    [Theory]
    [InlineData("/media/caixa/KINGSTON", DriveType.Fixed, "exfat", true, true)]
    [InlineData("/media/caixa/PENDRIVE", DriveType.Removable, "vfat", true, true)]
    [InlineData("/run/media/caixa/USB", DriveType.Unknown, "ntfs3", true, true)]
    [InlineData("/media/caixa/USB", DriveType.Network, "fuseblk", true, true)]
    [InlineData("/mnt/usb", DriveType.Fixed, "ntfs", true, true)]
    [InlineData("/boot/efi", DriveType.Removable, "vfat", true, false)]
    [InlineData("/", DriveType.Fixed, "ext4", true, false)]
    [InlineData("/media/caixa/DADOS", DriveType.Fixed, "ext4", true, false)]
    [InlineData("/media/", DriveType.Fixed, "vfat", true, false)]
    [InlineData("/media/caixa/CD", DriveType.CDRom, "iso9660", true, false)]
    [InlineData("E:\\", DriveType.Removable, null, false, true)]
    [InlineData("D:\\", DriveType.Fixed, null, false, false)]
    public void Pendrive_no_linux_pelo_lugar_da_montagem_e_o_sistema_de_arquivos(string raiz, DriveType tipo, string? formato, bool linux, bool esperado) =>
        Assert.Equal(esperado, DestinosPacoteSistema.EhPendrive(raiz, tipo, formato, linux));

    [AvaloniaFact]
    public async Task Erro_fatal_por_um_servico_que_nao_abre_ainda_gera_o_pacote_pelo_botao()
    {
        // O Painel de saúde quebra ao ser montado (como se uma das verificações lançasse no construtor): o caixa não abre.
        var destinos = Destinos(out var raiz);
        using var pdv = await IniciarAsync(destinos, raiz,
            ajustar: s => s.AddSingleton<VerificadorSaude>(_ => throw new InvalidOperationException("verificação quebrada ao montar")));
        var erro = Assert.IsType<ErroFatalViewModel>(pdv.Shell.PaginaAtual);
        Assert.Equal("O caixa não conseguiu abrir", erro.Titulo);
        PlantarLog(pdv);
        await pdv.EsperarAsync(() => pdv.Janela.GetVisualDescendants().OfType<Button>().Any(b => b.Name == "BotaoPacoteErroFatal"), "tela de erro fatal");
        var botao = pdv.Controle<Button>("BotaoPacoteErroFatal");
        Assert.True(botao.Bounds.Height >= 44, "botão grande o bastante para o mouse");

        // Pelo botão (o mouse): o pacote não depende do serviço que quebrou.
        pdv.Clicar(botao);
        await pdv.EsperarAsync(() => erro.Pacote.Ultimo is not null || erro.Pacote.Erro is not null, "pacote sem banco", timeoutMs: 30_000);
        await pdv.EsperarAsync(() => !erro.Pacote.Ocupado, "fim do pacote");
        Assert.Null(erro.Pacote.Erro);
        var arquivos = Abrir(erro.Pacote.Ultimo!.Arquivo);
        SemSegredos(erro.Pacote.Ultimo.Arquivo, arquivos);
        Assert.Equal("sem_banco", (string)ConferirManifesto(arquivos)["modo"]!);
        Assert.Contains("verificação quebrada ao montar", Encoding.UTF8.GetString(arquivos[ServicoPacoteSuporte.DiagnosticoTxt]), StringComparison.Ordinal);
    }

    [AvaloniaFact]
    public async Task Voltar_a_aba_P_durante_a_geracao_nao_solta_o_gerando_nem_gera_dois_e_guarda_o_ultimo_pacote()
    {
        var destinos = Destinos(out var raiz);
        using var pdv = await IniciarAsync(destinos, raiz);
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Shell.IrParaLogin();
        var central = await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        pdv.Tecla(Key.P);
        await pdv.EsperarAsync(() => central.Conteudo is AbaPacoteViewModel { Ocupado: false, Destinos.Count: 2 }, "aba P");
        var aba = (AbaPacoteViewModel)central.Conteudo!;
        await pdv.EsperarFocoAsync("TelaPacote");
        var servico = pdv.Servicos.GetRequiredService<ServicoPacoteSuporte>();

        // Um pacote grande na frente (a fila segurada): o Enter fica esperando, com o "gerando…" na tela.
        await servico.Trava.WaitAsync(Ct);
        var soltou = false;
        try
        {
            pdv.Tecla(Key.Enter);
            await pdv.EsperarAsync(() => aba.Ocupado && aba.Andamento is not null, "gerando");

            // Esc (volta ao menu sem cancelar), a aba 0 e de volta à P pela tecla P do Painel: nada se solta.
            pdv.Tecla(Key.Escape);
            await pdv.EsperarAsync(() => pdv.AbaFocada() == "P", "foco no menu");
            pdv.Tecla(Key.D0);
            await pdv.EsperarAsync(() => central.Conteudo is AbaPainelViewModel, "Painel");
            pdv.Tecla(Key.D0);
            await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is ListBoxItem, "foco na lista do Painel");
            pdv.Tecla(Key.P);
            await pdv.EsperarAsync(() => ReferenceEquals(central.Conteudo, aba), "de volta à aba P pela tecla P do Painel");
            await AmbienteUi.Pausa();
            Assert.True(aba.Ocupado);
            Assert.NotNull(aba.Andamento);
            Assert.Equal(2, aba.Destinos.Count);

            // O Enter e o botão de novo não enfileiram outro pacote.
            pdv.Clicar(pdv.Controle<Button>("BotaoGerarPacote"));
            await AmbienteUi.Pausa();
            servico.Trava.Release();
            soltou = true;
            await pdv.EsperarAsync(() => aba.Ultimo is not null && !aba.Ocupado, $"pacote gerado ({aba.Erro})", timeoutMs: 30_000);
        }
        finally
        {
            if (!soltou)
            {
                servico.Trava.Release();
            }
        }

        await pdv.EsperarAsync(() => !servico.Gerando, "nenhum outro na fila");
        Assert.Single(Directory.GetFiles(destinos.Pendrive.Pasta, "*.zip"));
        var frase = aba.Mensagem;
        Assert.Contains($"Pacote salvo em Pendrive E:\\ (TESTE): {aba.Ultimo!.Nome}", frase, StringComparison.Ordinal);

        // Depois de pronto, a volta à aba procura o pendrive de novo e não apaga a frase com o nome do arquivo.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "P", "foco no menu");
        pdv.Tecla(Key.D0);
        await pdv.EsperarAsync(() => central.Conteudo is AbaPainelViewModel, "Painel");
        pdv.Clicar(pdv.Controle<Button>("BotaoPacotePainel"));
        await pdv.EsperarAsync(() => ReferenceEquals(central.Conteudo, aba) && !aba.Ocupado, "de volta à aba P pelo botão do Painel");
        await AmbienteUi.Pausa();
        Assert.Equal(frase, aba.Mensagem);
    }

    [AvaloniaFact]
    public async Task Servico_confere_de_novo_quem_pede_depois_de_esperar_o_pacote_da_frente()
    {
        var destinos = Destinos(out var raiz);
        using var pdv = await IniciarAsync(destinos, raiz);
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Shell.IrParaLogin();
        await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        var servico = pdv.Servicos.GetRequiredService<ServicoPacoteSuporte>();

        // O pedido entra com a Central aberta e espera o pacote da frente; nesse meio-tempo a Central fecha.
        await servico.Trava.WaitAsync(Ct);
        var pedido = servico.GerarAsync(destinos.Pendrive, Ct);
        await AmbienteUi.Pausa();
        Assert.False(pedido.IsCompleted);
        pdv.Servicos.GetRequiredService<AcessoCentral>().Encerrar();
        servico.Trava.Release();
        var e = await Assert.ThrowsAsync<RegraNegocioException>(() => pedido);
        Assert.Equal(AcessoCentral.MensagemFechada, e.Message);
        Assert.False(Directory.Exists(destinos.Pendrive.Pasta) && Directory.EnumerateFiles(destinos.Pendrive.Pasta).Any());
        await using var db = Banco(pdv);
        Assert.False(await db.LogAuditoriaLocal.AnyAsync(a => a.Acao == "exportar", Ct));
    }

    [AvaloniaFact]
    public async Task Restauracao_do_backup_suspende_o_pacote_que_fica_so_com_os_logs_e_nao_grava_no_banco()
    {
        var destinos = Destinos(out var raiz);
        using var pdv = await IniciarAsync(destinos, raiz);
        await pdv.AtivarDemonstracaoELogarAsync();
        PlantarLog(pdv);
        pdv.Shell.IrParaLogin();
        await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        var servico = pdv.Servicos.GetRequiredService<ServicoPacoteSuporte>();

        await servico.SuspenderParaRestauracaoAsync();
        Assert.True(servico.Suspenso);
        var r = await servico.GerarAsync(destinos.Pendrive, Ct);
        Assert.Contains(ServicoPacoteSuporte.MotivoRestauracao, r.AvisoRegistro, StringComparison.Ordinal);
        var arquivos = Abrir(r.Arquivo);
        var manifesto = ConferirManifesto(arquivos);
        Assert.Equal(
            [ServicoPacoteSuporte.Manifesto],
            arquivos.Keys.Where(n => !n.StartsWith(ServicoPacoteSuporte.PastaLogs, StringComparison.Ordinal)).ToArray());
        Assert.Single(arquivos.Keys, n => n.StartsWith(ServicoPacoteSuporte.PastaLogs, StringComparison.Ordinal));
        Assert.Contains(manifesto["avisos"]!.AsArray(), a => ((string)a!).Contains(ServicoPacoteSuporte.MotivoRestauracao, StringComparison.Ordinal));
        await using var db = Banco(pdv);
        Assert.False(await db.LogAuditoriaLocal.AnyAsync(a => a.Acao == "exportar", Ct));
        var detalhes = await db.LogLocal.AsNoTracking().Select(l => l.Detalhes).ToListAsync(Ct);
        Assert.DoesNotContain(detalhes, d => Ocorrencias.CodigoDe(d) == CodigoOcorrencia.PacoteGerado.Codigo);
    }

    [AvaloniaFact]
    public async Task Outbox_e_auditoria_alem_do_limite_dizem_no_manifesto_o_que_ficou_de_fora()
    {
        var destinos = Destinos(out var raiz);
        using var pdv = await IniciarAsync(destinos, raiz);
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Shell.IrParaLogin();
        await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");

        // Semanas sem internet: mais pendentes que o limite por situação, e mais registros de auditoria que o contado.
        var pendentes = ConsultasPacoteSuporte.LimiteNaoConfirmados + 1;
        await using (var db = Banco(pdv))
        {
            var agora = DateTimeOffset.UtcNow;
            db.EventosSaida.Add(new EventoSaida
            {
                Id = IdGerador.Novo(),
                SequenciaTerminal = 1_000_000,
                Tipo = "venda.finalizada",
                AgregadoTipo = "venda",
                AgregadoId = IdGerador.Novo(),
                OcorridoEm = agora,
                CriadoEm = agora,
                Status = StatusEventoSaida.Pendente,
                PayloadSha256 = new string('a', 64),
            });
            db.LogAuditoriaLocal.Add(new LogAuditoriaLocal { Id = IdGerador.Novo(), OcorridoEm = agora, Acao = "gaveta_aberta", UsuarioId = Carlos });
            await db.SaveChangesAsync(Ct);
            await DuplicarAsync(db, "eventos_saida", pendentes - 1, "sequencia_terminal = 1000000",
                new Dictionary<string, string> { ["sequencia_terminal"] = "sequencia_terminal + n" });
            await DuplicarAsync(db, "log_auditoria_local", ConsultasPacoteSuporte.LimiteAuditoria, "acao = 'gaveta_aberta'", []);
            // Mais os que a abertura do caixa já deixou.
            pendentes = await db.EventosSaida.CountAsync(e => e.Status == StatusEventoSaida.Pendente, Ct);
        }

        var r = await pdv.Servicos.GetRequiredService<ServicoPacoteSuporte>().GerarAsync(destinos.Pendrive, Ct);
        var arquivos = Abrir(r.Arquivo);
        var avisos = ConferirManifesto(arquivos)["avisos"]!.AsArray().Select(a => (string)a!).ToList();
        Assert.Contains(avisos, a => a.StartsWith($"{ServicoPacoteSuporte.Outbox}: só os {ConsultasPacoteSuporte.LimiteNaoConfirmados} mais antigos de {pendentes} na situação pendente", StringComparison.Ordinal));
        Assert.Contains(avisos, a => a.StartsWith($"{ServicoPacoteSuporte.AuditoriaResumo}: contados só os", StringComparison.Ordinal));
        var linhas = Encoding.UTF8.GetString(arquivos[ServicoPacoteSuporte.Outbox]).Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(ConsultasPacoteSuporte.LimiteNaoConfirmados + 1, linhas.Length);
    }

    /// <summary>
    /// Copia <paramref name="vezes"/> vezes a linha de <paramref name="tabela"/> que atende <paramref name="onde"/>, com um
    /// id novo em cada (e as colunas trocadas por <paramref name="trocar"/>; <c>n</c> é o número da cópia): o volume
    /// sintético num INSERT só, sem passar por milhares de entidades.
    /// </summary>
    private static async Task DuplicarAsync(PdvDbContext db, string tabela, int vezes, string onde, Dictionary<string, string> trocar)
    {
        var colunas = await db.Database.SqlQuery<string>($"select name as Value from pragma_table_info({tabela})").ToListAsync(Ct);
        var selecao = colunas.Select(c => c == "id"
            ? "upper(printf('%08x-0000-7000-8000-%012x', abs(random()) % 4294967295, n))"
            : trocar.GetValueOrDefault(c, c));
        // O nome da tabela e das colunas vêm do próprio teste e do esquema, não de quem digita.
        var sql = $"with recursive seq(n) as (select 1 union all select n + 1 from seq where n < {vezes}) " +
                  $"insert into {tabela} ({string.Join(", ", colunas)}) select {string.Join(", ", selecao)} from seq, (select * from {tabela} where {onde} limit 1)";
        await db.Database.ExecuteSqlRawAsync(sql, Ct);
    }

    /// <summary>
    /// Lê o arquivo sem exigir acesso exclusivo: no Windows o pool de conexões do SQLite pode manter aberto o
    /// <c>pdv.db</c> que a abertura conferiu, e o <see cref="File.ReadAllBytes(string)"/> (que só compartilha leitura)
    /// falharia com "being used by another process". O que o teste confere é que o pacote não alterou os bytes.
    /// </summary>
    private static byte[] LerCompartilhado(string caminho)
    {
        using var arquivo = new FileStream(caminho, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var memoria = new MemoryStream();
        arquivo.CopyTo(memoria);
        return memoria.ToArray();
    }
}
