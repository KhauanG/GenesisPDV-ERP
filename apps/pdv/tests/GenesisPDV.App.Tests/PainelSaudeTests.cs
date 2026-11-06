using System.Data.Common;
using System.Diagnostics;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Outbox;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Hardware.Gaveta;
using GenesisPDV.Hardware.Impressora;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Push;
using GenesisPDV.Sync.Relogio;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Painel de saúde da Central do PDV (bloco G4; plano 4.1; README › decisão 69), sem a tela: cada verificação em verde,
/// amarelo e vermelho com o estado simulado (a situação do sync, o outbox, o disco, o relógio, a fila de impressão, a
/// gaveta, o backup, o banco, a versão e o log local), o tempo total limitado com uma verificação travada, a ordem do
/// Painel, e que nenhuma rodada roda o <c>integrity_check</c> nem chama a nuvem (tudo offline). A tela, o ícone da barra e
/// o bloqueio da abertura pelo disco estão em <c>PainelSaudeTelasTests</c>.
/// </summary>
public sealed class PainelSaudeTests : IDisposable
{
    private const long MB = 1024L * 1024;

    private readonly string _raiz = Path.Combine(Path.GetTempPath(), "genesispdv-saude", Guid.NewGuid().ToString("N"));
    private readonly Relogio _relogio = new();
    private readonly SincronizacaoSimulada _sync = new();
    private readonly ComandosCapturados _comandos = new();
    private long? _livre = 50_000 * MB;
    private ServiceProvider? _servicos;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private ServiceProvider Servicos => _servicos ?? throw new InvalidOperationException("Chame IniciarAsync antes.");

    private FabricaPdvDb Fabrica => Servicos.GetRequiredService<FabricaPdvDb>();

    public void Dispose()
    {
        _servicos?.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try
        {
            Directory.Delete(_raiz, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    /// <summary>
    /// O PDV composto como no caixa, com o sync, o relógio e o disco simulados; o banco migrado e um terminal ativado de
    /// verdade (a verificação do sync não olha a demonstração). Todo comando SQL passa pelo <see cref="ComandosCapturados"/>.
    /// </summary>
    private async Task IniciarAsync(Action<IServiceCollection>? ajustar = null)
    {
        var caminhos = CaminhosPdv.SobRaiz(_raiz);
        _servicos = Inicializacao.CriarServicos(caminhos, ajustar: s =>
        {
            s.AddSingleton<IRelogio>(_relogio);
            s.AddSingleton<IServicoSincronizacao>(_sync);
            s.AddSingleton(new MedidorDisco(caminhos, _ => _livre));
            s.AddSingleton<IDbContextFactory<PdvDbContext>>(sp => new FabricaCapturada(sp.GetRequiredService<FabricaPdvDb>(), _comandos));
            ajustar?.Invoke(s);
        });
        var inicio = await InicializadorBanco.InicializarAsync(Fabrica, caminhos.PastaBackup, _relogio.Agora, Ct);
        Servicos.GetRequiredService<EstadoBanco>().Registrar(inicio.BancoNovo, _relogio.Agora);
        var identidade = new IdentidadeTerminal
        {
            TerminalId = Guid.CreateVersion7(),
            EmpresaCodigo = 7,
            LojaId = Guid.CreateVersion7(),
            CaixaId = Guid.CreateVersion7(),
            NumeroCaixa = 2,
            UrlApi = "https://api.exemplo/",
            AtivadoEm = _relogio.Agora,
        };
        await using (var db = Fabrica.CreateDbContext())
        {
            db.IdentidadeTerminal.Add(identidade);
            await db.SaveChangesAsync(Ct);
        }

        Servicos.GetRequiredService<SessaoTerminal>().Identidade = identidade;
    }

    private Task<ItemSaude> VerificarAsync(string codigo, bool completa = true) =>
        Servicos.GetServices<IVerificacaoSaude>().Single(v => v.Codigo == codigo).VerificarAsync(completa, Ct);

    private async Task GravarAsync(Action<PdvDbContext> alterar)
    {
        await using var db = Fabrica.CreateDbContext();
        alterar(db);
        await db.SaveChangesAsync(Ct);
    }

    private EventoSaida Evento(long sequencia, string status, TimeSpan idade, string? erro = null) => new()
    {
        Id = Guid.CreateVersion7(),
        SequenciaTerminal = sequencia,
        Tipo = "venda.finalizada",
        AgregadoTipo = "venda",
        AgregadoId = Guid.CreateVersion7(),
        OcorridoEm = _relogio.Agora - idade,
        CriadoEm = _relogio.Agora - idade,
        Payload = "{}",
        PayloadSha256 = new string('a', 64),
        Status = status,
        UltimoErro = erro,
    };

    [Fact]
    public async Task Doze_verificacoes_na_ordem_do_plano_todas_locais()
    {
        await IniciarAsync();
        Assert.Equal(
            ["sincronizacao", "rejeitados", "lacuna", "relogio", "impressora", "gaveta", "disco", "backup", "banco", "caixa", "versao", "erros"],
            Servicos.GetServices<IVerificacaoSaude>().Select(v => v.Codigo));

        // Uma rodada completa e a barata do ícone: nenhum comando é o integrity_check (ele lê o arquivo inteiro e fica
        // guardado da abertura) e nada vai à nuvem (sem sincronizar, acordar ou handshake: o Painel funciona offline).
        _comandos.Limpar();
        var verificador = Servicos.GetRequiredService<VerificadorSaude>();
        var completa = await verificador.VerificarAsync(completa: true, Ct);
        var barata = await verificador.VerificarAsync(completa: false, Ct);
        Assert.Equal(12, completa.Itens.Count);
        Assert.Equal(12, barata.Itens.Count);
        Assert.Same(barata, verificador.Ultimo);
        Assert.NotEmpty(_comandos.Textos);
        Assert.DoesNotContain(_comandos.Textos, t => t.Contains("integrity_check", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(0, _sync.ChamadasNuvem);
        // O banco conferido na abertura aparece verde sem rodar de novo.
        Assert.Equal(NivelSaude.Ok, completa.Itens.Single(i => i.Codigo == "banco").Nivel);
    }

    [Fact]
    public async Task Sincronizacao_verde_amarela_e_vermelha()
    {
        await IniciarAsync();

        _sync.Situacao = new SituacaoSincronizacao(true, 0, null) { SemNuvem = true };
        Assert.Equal(NivelSaude.Ok, (await VerificarAsync("sincronizacao")).Nivel);

        _sync.Situacao = new SituacaoSincronizacao(true, 0, null);
        var online = await VerificarAsync("sincronizacao");
        Assert.Equal((NivelSaude.Ok, "Online: tudo enviado ao ERP."), (online.Nivel, online.Frase));

        // Registro parado há 2 h (mais que 1 h): amarelo, com o Sincronizar agora.
        await GravarAsync(db => db.EventosSaida.Add(Evento(1, StatusEventoSaida.Pendente, TimeSpan.FromHours(2))));
        var parado = await VerificarAsync("sincronizacao");
        Assert.Equal(NivelSaude.Aviso, parado.Nivel);
        Assert.StartsWith("1 registro esperando envio desde", parado.Frase, StringComparison.Ordinal);
        Assert.True(parado.Acao!.Sincronizar);

        // O "pronto quando" do G4: sem internet há 30 min e a fila parada (o registro de 2 h atrás): vermelho, com o que
        // fazer e o código do terminal para o suporte (o ⚠ da venda acende).
        _sync.Situacao = new SituacaoSincronizacao(false, 1, _relogio.Agora.AddMinutes(-30));
        var parada = await VerificarAsync("sincronizacao");
        Assert.Equal(NivelSaude.Problema, parada.Nivel);
        Assert.Contains("Sem internet há 30 min: 1 registro esperando envio ao ERP desde", parada.Frase, StringComparison.Ordinal);
        Assert.Contains("cabo de rede ou o Wi-Fi", parada.OQueFazer, StringComparison.Ordinal);
        Assert.Contains("código do terminal", parada.OQueFazer, StringComparison.Ordinal);
        Assert.True(parada.Acao!.Sincronizar);

        // Sem internet com a fila em dia (o registro parado subiu; um de 10 min espera): amarelo, a venda segue (O18: sem
        // limite de dias, nunca vermelho por isso).
        await GravarAsync(db =>
        {
            db.EventosSaida.Single().Status = StatusEventoSaida.Confirmado;
            db.EventosSaida.Add(Evento(2, StatusEventoSaida.Pendente, TimeSpan.FromMinutes(10)));
        });
        var offline = await VerificarAsync("sincronizacao");
        Assert.Equal(NivelSaude.Aviso, offline.Nivel);
        Assert.Contains("Sem internet há 30 min", offline.Frase, StringComparison.Ordinal);
        Assert.Contains("(1 registro na fila)", offline.Frase, StringComparison.Ordinal);
        Assert.Contains("cabo de rede ou o Wi-Fi", offline.OQueFazer, StringComparison.Ordinal);

        // Com pdv.dias_max_offline = 3 e 2 dias e meio sem sincronizar: vermelho (a um dia de parar de vender).
        await GravarAsync(db =>
        {
            db.Configuracoes.Add(new ConfiguracaoRegistro
            {
                Id = Guid.CreateVersion7(),
                Chave = ChavesConfiguracao.DiasMaxOffline,
                Valor = "3",
                CriadoEm = _relogio.Agora,
                AtualizadoEm = _relogio.Agora,
                Versao = 1,
            });
            db.EstadoConexao.Single().SegundosOfflineAcumulados = (long)TimeSpan.FromDays(2.5).TotalSeconds;
        });
        var perto = await VerificarAsync("sincronizacao");
        Assert.Equal(NivelSaude.Problema, perto.Nivel);
        Assert.Contains("com 3 dias sem internet o caixa para de vender", perto.Frase, StringComparison.Ordinal);

        // O terminal recusado pela nuvem: vermelho, "chame o suporte".
        _sync.Situacao = new SituacaoSincronizacao(true, 0, null) { Terminal = EstadoTerminalSync.Bloqueado };
        var bloqueado = await VerificarAsync("sincronizacao");
        Assert.Equal(NivelSaude.Problema, bloqueado.Nivel);
        Assert.Contains("suporte", bloqueado.OQueFazer, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Recusados_e_lacuna_dizem_que_a_decisao_e_do_erp_ou_do_supervisor()
    {
        await IniciarAsync();
        Assert.Equal(NivelSaude.Ok, (await VerificarAsync("rejeitados")).Nivel);

        await GravarAsync(db => db.EventosSaida.Add(Evento(9, StatusEventoSaida.Rejeitado, TimeSpan.FromMinutes(5), "PAYLOAD_INVALIDO token=segredo123")));
        var recusado = await VerificarAsync("rejeitados");
        Assert.Equal(NivelSaude.Problema, recusado.Nivel);
        Assert.Contains("nº 9, venda.finalizada", recusado.Frase, StringComparison.Ordinal);
        Assert.DoesNotContain("segredo123", recusado.Frase, StringComparison.Ordinal);
        Assert.Contains("Eventos com erro", recusado.OQueFazer, StringComparison.Ordinal);
        Assert.Equal(AbasCentral.Sincronizacao.Codigo, recusado.Acao!.Aba);

        Assert.Equal(NivelSaude.Ok, (await VerificarAsync("lacuna")).Nivel);
        _sync.Situacao = _sync.Situacao with { Lacuna = new LacunaEventos(1048, 1049, Recuperavel: false) };
        var lacuna = await VerificarAsync("lacuna");
        Assert.Equal(NivelSaude.Problema, lacuna.Nivel);
        Assert.Contains("1048–1049", lacuna.Frase, StringComparison.Ordinal);
        Assert.Contains("F11 › S › F4", lacuna.OQueFazer, StringComparison.Ordinal);
        _sync.Situacao = _sync.Situacao with { Lacuna = new LacunaEventos(1048, 1049, Recuperavel: true) };
        Assert.Equal(NivelSaude.Aviso, (await VerificarAsync("lacuna")).Nivel);
    }

    [Fact]
    public async Task Relogio_pelo_desvio_da_nuvem_e_pela_regressao()
    {
        await IniciarAsync();
        var sessao = Servicos.GetRequiredService<SessaoTerminal>();
        var opcoes = new OpcoesSaude();

        async Task<ItemSaude> ComDesvioAsync(TimeSpan desvio)
        {
            var relogio = new RelogioSync(Fabrica, _relogio);
            relogio.Registrar(_relogio.Agora, TimeSpan.Zero, _relogio.Agora + desvio);
            return await new Servicos.Diagnostico.Verificacoes.VerificacaoRelogio(relogio, Fabrica, sessao, opcoes).VerificarAsync(true, Ct);
        }

        Assert.Equal(NivelSaude.Ok, (await VerificarAsync("relogio")).Nivel);
        Assert.Equal(NivelSaude.Ok, (await ComDesvioAsync(TimeSpan.FromSeconds(20))).Nivel);
        var atrasado = await ComDesvioAsync(TimeSpan.FromMinutes(3));
        Assert.Equal((NivelSaude.Aviso, "O relógio do computador está 3 min atrasado em relação à nuvem."), (atrasado.Nivel, atrasado.Frase));
        Assert.Equal(NivelSaude.Problema, (await ComDesvioAsync(TimeSpan.FromMinutes(-10))).Nivel);

        // A hora do Windows voltou para trás (a auditoria local do C16): vermelho por 24 h.
        await GravarAsync(db => db.LogAuditoriaLocal.Add(new LogAuditoriaLocal
        {
            Id = Guid.CreateVersion7(),
            OcorridoEm = _relogio.Agora.AddHours(-1),
            Acao = GravadorOutbox.AcaoRelogioRegrediu,
        }));
        var regrediu = await VerificarAsync("relogio");
        Assert.Equal(NivelSaude.Problema, regrediu.Nivel);
        Assert.Contains("voltou para trás", regrediu.Frase, StringComparison.Ordinal);
        _relogio.Agora = _relogio.Agora.AddHours(30);
        Assert.Equal(NivelSaude.Ok, (await VerificarAsync("relogio")).Nivel);
    }

    [Fact]
    public async Task Impressora_e_gaveta_pela_fila_e_pelo_ultimo_pulso()
    {
        await IniciarAsync();
        var hardware = Servicos.GetRequiredService<ServicoHardware>();
        await hardware.GravarAsync(hardware.Atual with { Impressora = new ConfiguracaoImpressora { Conexao = TipoConexao.Nenhuma } }, null, null, Ct);
        var sem = await VerificarAsync("impressora");
        Assert.Equal(NivelSaude.Aviso, sem.Nivel);
        Assert.Equal(AbasCentral.ImpressoraGaveta.Codigo, sem.Acao!.Aba);
        Assert.Equal(NivelSaude.Ok, (await VerificarAsync("gaveta")).Nivel);

        await hardware.GravarAsync(hardware.Atual with
        {
            Impressora = new ConfiguracaoImpressora { Conexao = TipoConexao.Simulada },
            Gaveta = new ConfiguracaoGaveta(Ligada: true, AbreNosMovimentos: true),
        }, null, null, Ct);
        Assert.Equal(NivelSaude.Ok, (await VerificarAsync("impressora")).Nivel);
        var fila = Servicos.GetRequiredService<RepositorioImpressao>();
        var cupom = await fila.EnfileirarAsync("cupom", null, [0x41], ct: Ct);
        Assert.Equal(NivelSaude.Aviso, (await VerificarAsync("impressora")).Nivel);
        await fila.MarcarResultadoAsync(cupom, impresso: false, "sem papel", Ct);
        var falhou = await VerificarAsync("impressora");
        Assert.Equal((NivelSaude.Problema, "1 comprovante não saiu na impressora (sem papel)."), (falhou.Nivel, falhou.Frase));
        Assert.Contains("F7 Imprimir pendentes", falhou.OQueFazer, StringComparison.Ordinal);

        // A gaveta que não abriu (registrada no log local, como depois de reabrir o caixa): vermelho até um pulso dar certo.
        Assert.Equal((NivelSaude.Ok, "Ligada."), ((await VerificarAsync("gaveta")).Nivel, (await VerificarAsync("gaveta")).Frase));
        await Servicos.GetRequiredService<RepositorioTerminal>().RegistrarOcorrenciaAsync(
            NiveisOcorrencia.Aviso, CodigoOcorrencia.GavetaFalhou, "A gaveta não abriu", "timeout", ct: Ct);
        var gaveta = await VerificarAsync("gaveta");
        Assert.Equal(NivelSaude.Problema, gaveta.Nivel);
        Assert.Contains("F6", gaveta.OQueFazer, StringComparison.Ordinal);
        _relogio.Agora = _relogio.Agora.AddSeconds(1);
        var servicoGaveta = Servicos.GetRequiredService<ServicoGaveta>();
        Assert.Null(await servicoGaveta.AbrirNoMovimentoAsync(Ct));
        Assert.Equal((NivelSaude.Ok, "Ligada; a última abertura funcionou."), ((await VerificarAsync("gaveta")).Nivel, (await VerificarAsync("gaveta")).Frase));

        // O app reaberto (a memória do pulso bom some): o "voltou a abrir" gravado no log local deixa a gaveta verde — sem
        // ele, a falha de antes ficaria vermelha por até 24 h. Uma linha por recuperação, não por pulso.
        Assert.Null(await servicoGaveta.AbrirNoMovimentoAsync(Ct));
        Assert.Equal(1, await ContarLogGavetaAsync(ServicoGaveta.NivelVoltou));
        var terminal = Servicos.GetRequiredService<RepositorioTerminal>();
        var sessao = Servicos.GetRequiredService<SessaoTerminal>();
        Task<ItemSaude> ReabertoAsync() => new Servicos.Diagnostico.Verificacoes.VerificacaoGaveta(
            ActivatorUtilities.CreateInstance<ServicoGaveta>(Servicos), terminal, sessao, _relogio, new OpcoesSaude()).VerificarAsync(true, Ct);
        Assert.Equal(NivelSaude.Ok, (await ReabertoAsync()).Nivel);

        // A falha de agora, com o app reaberto antes de outro pulso: continua vermelha (o último registro é a falha).
        _relogio.Agora = _relogio.Agora.AddMinutes(1);
        await terminal.RegistrarOcorrenciaAsync(NiveisOcorrencia.Aviso, CodigoOcorrencia.GavetaFalhou, "A gaveta não abriu", "timeout", ct: Ct);
        Assert.Equal(NivelSaude.Problema, (await ReabertoAsync()).Nivel);
    }

    private async Task<int> ContarLogGavetaAsync(string nivel)
    {
        await using var db = Fabrica.CreateDbContext();
        return await db.LogLocal.CountAsync(l => l.Origem == ServicoGaveta.OrigemLog && l.Nivel == nivel, Ct);
    }

    [Fact]
    public async Task Disco_nos_limites_de_1_GB_e_200_MB()
    {
        await IniciarAsync();
        var folga = await VerificarAsync("disco");
        Assert.Equal(NivelSaude.Ok, folga.Nivel);
        Assert.Contains("Banco ", folga.Frase, StringComparison.Ordinal);
        Assert.DoesNotContain("Banco ", (await VerificarAsync("disco", completa: false)).Frase, StringComparison.Ordinal);

        _livre = 1024 * MB - 1;
        Assert.Equal(NivelSaude.Aviso, (await VerificarAsync("disco")).Nivel);
        _livre = 200 * MB;
        Assert.Equal(NivelSaude.Aviso, (await VerificarAsync("disco")).Nivel);
        _livre = 200 * MB - 1;
        var cheio = await VerificarAsync("disco");
        Assert.Equal(NivelSaude.Problema, cheio.Nivel);
        Assert.Contains("Abrir caixa novo fica bloqueado (a venda em curso continua)", cheio.Frase, StringComparison.Ordinal);
        Assert.Contains("liberar a abertura do caixa por 1 h", cheio.OQueFazer, StringComparison.Ordinal);
        _livre = null;
        Assert.Equal(NivelSaude.Aviso, (await VerificarAsync("disco")).Nivel);
    }

    [Fact]
    public async Task Backup_banco_versao_e_erros_recentes()
    {
        await IniciarAsync();
        // Sem caixa aberto, o backup velho é o normal (o periódico só sai com o caixa aberto).
        Assert.Equal(NivelSaude.Ok, (await VerificarAsync("backup")).Nivel);
        await GravarAsync(db => db.IdentidadeTerminal.Single().UltimoBackupEm = _relogio.Agora.AddHours(-30));
        Assert.Equal(NivelSaude.Ok, (await VerificarAsync("backup")).Nivel);

        // A última tentativa falhou (a pasta de backup virou um arquivo): vermelho com o motivo.
        var caminhos = Servicos.GetRequiredService<CaminhosPdv>();
        Directory.Delete(caminhos.PastaBackup, recursive: true);
        await File.WriteAllTextAsync(caminhos.PastaBackup, "não é pasta", Ct);
        Assert.Null(await Servicos.GetRequiredService<ServicoBackup>().TentarAsync(Data.Backup.MotivosBackup.Periodico, Ct));
        var falhou = await VerificarAsync("backup");
        Assert.Equal(NivelSaude.Problema, falhou.Nivel);
        Assert.StartsWith("O último backup falhou em", falhou.Frase, StringComparison.Ordinal);
        Assert.Equal(AbasCentral.Backup.Codigo, falhou.Acao!.Aba);
        // A falha também ficou no log local (a aba 5 da Central, bloco G8): aviso, com o código e a exceção no texto técnico.
        await using (var db = Fabrica.CreateDbContext())
        {
            var ocorrencia = await db.LogLocal.AsNoTracking().SingleAsync(l => l.Origem == OrigensOcorrencia.Backup, Ct);
            Assert.Equal((NiveisOcorrencia.Aviso, CodigoOcorrencia.BackupFalhou.Codigo), (ocorrencia.Nivel, Ocorrencias.CodigoDe(ocorrencia.Detalhes)));
            Assert.StartsWith("Backup (periodico) não foi feito:", ocorrencia.Mensagem, StringComparison.Ordinal);
            Assert.Contains("\"texto\":", ocorrencia.Detalhes, StringComparison.Ordinal);
        }

        var estado = Servicos.GetRequiredService<EstadoBanco>();
        estado.RegistrarFalha("Banco local com falha de integridade: row 3 missing");
        Assert.Equal(NivelSaude.Problema, (await VerificarAsync("banco")).Nivel);
        estado.Registrar(bancoNovo: false, _relogio.Agora);
        Assert.Contains("íntegro", (await VerificarAsync("banco")).Frase, StringComparison.Ordinal);

        Assert.Equal(NivelSaude.Ok, (await VerificarAsync("versao")).Nivel);
        await GravarAsync(db => db.EstadoConexao.Single().VersaoMinimaApp = "99.0.0");
        var versao = await VerificarAsync("versao");
        Assert.Equal(NivelSaude.Problema, versao.Nivel);
        Assert.Contains("GenesisPDV-Setup-99.0.0.exe", versao.OQueFazer, StringComparison.Ordinal);

        // Erro de 30 h atrás não conta; o de agora, amarelo, com a mensagem mascarada (G2).
        await GravarAsync(db => db.LogLocal.Add(new LogLocal { OcorridoEm = _relogio.Agora.AddHours(-30), Nivel = "erro", Mensagem = "antigo" }));
        Assert.Equal(NivelSaude.Ok, (await VerificarAsync("erros")).Nivel);
        await Servicos.GetRequiredService<RepositorioTerminal>().RegistrarOcorrenciaAsync(
            NiveisOcorrencia.Erro, CodigoOcorrencia.ErroInesperado, "Falhou com Bearer abc.def.ghi", ct: Ct);
        var erros = await VerificarAsync("erros");
        Assert.Equal(NivelSaude.Aviso, erros.Nivel);
        Assert.StartsWith("1 erro nas últimas 24 h; o último em ", erros.Frase, StringComparison.Ordinal);
        // O Painel abre sem PIN (PC-7): o texto do erro (qualquer exceção, talvez com dado de cliente) fica na aba 5.
        Assert.DoesNotContain("Falhou com", erros.Frase, StringComparison.Ordinal);
        Assert.DoesNotContain("abc.def.ghi", erros.Frase, StringComparison.Ordinal);
        Assert.Equal(AbasCentral.Logs.Codigo, erros.Acao!.Aba);
    }

    [Fact]
    public async Task Backup_que_falha_com_a_restauracao_em_curso_nao_grava_no_banco()
    {
        await IniciarAsync();
        var caminhos = Servicos.GetRequiredService<CaminhosPdv>();
        Directory.Delete(caminhos.PastaBackup, recursive: true);
        await File.WriteAllTextAsync(caminhos.PastaBackup, "não é pasta", Ct);
        // O backup do fechamento já em curso quando a restauração começa (o SuspenderParaRestauracao não o espera): ele
        // falha — aqui, logo depois da suspensão, que o log do erro dispara — e nada vai para o log local durante a troca.
        ServicoBackup? servico = null;
        var log = new LogQueSuspende(() => servico!.SuspenderParaRestauracao());
        servico = new ServicoBackup(Servicos.GetRequiredService<Data.Backup.BackupLocal>(), Fabrica, caminhos, _relogio, log);
        Assert.Null(await servico.TentarAsync(Data.Backup.MotivosBackup.Fechamento, Ct));
        Assert.True(log.Suspendeu);
        Assert.NotNull(servico.UltimaFalha);
        await using var db = Fabrica.CreateDbContext();
        Assert.Equal(0, await db.LogLocal.CountAsync(Ct));
    }

    [Fact]
    public async Task Verificacao_travada_ou_com_erro_nao_segura_o_painel()
    {
        var opcoes = new OpcoesSaude { LimitePorVerificacao = TimeSpan.FromMilliseconds(300) };
        var verificador = new VerificadorSaude(
            [
                new Fixa("verde", NivelSaude.Ok),
                new Travada(),
                new Fixa("vermelha", NivelSaude.Problema),
                new ComErro(),
                new Fixa("amarela", NivelSaude.Aviso),
            ],
            opcoes, _relogio, NullLogger<VerificadorSaude>.Instance);

        var tempo = Stopwatch.StartNew();
        var resultado = await verificador.VerificarAsync(ct: Ct);
        tempo.Stop();

        // Em paralelo: o total fica perto do limite de uma, nunca na soma (e a travada não segura as outras).
        Assert.True(tempo.Elapsed < TimeSpan.FromSeconds(2), $"o Painel esperou {tempo.Elapsed}");
        Assert.Equal(["vermelha", "travada", "erro", "amarela", "verde"], resultado.Itens.Select(i => i.Codigo));
        var travada = resultado.Itens.Single(i => i.Codigo == "travada");
        Assert.Equal(NivelSaude.Aviso, travada.Nivel);
        Assert.Contains("não respondeu", travada.Frase, StringComparison.Ordinal);
        var erro = resultado.Itens.Single(i => i.Codigo == "erro");
        Assert.Equal(NivelSaude.Aviso, erro.Nivel);
        Assert.DoesNotContain("segredo-do-erro", erro.Frase, StringComparison.Ordinal);
        Assert.Equal((1, 3, NivelSaude.Problema), (resultado.Problemas, resultado.Avisos, resultado.Pior));
    }

    [Fact]
    public async Task Verificacao_presa_nao_e_disparada_de_novo_a_cada_rodada()
    {
        // Presa de forma síncrona (DriveInfo de um disco de rede travado): o limite devolve o aviso, mas a thread fica.
        using var solta = new ManualResetEventSlim();
        var presa = new Presa(solta);
        var verificador = new VerificadorSaude([presa], new OpcoesSaude { LimitePorVerificacao = TimeSpan.FromMilliseconds(100) }, _relogio,
            NullLogger<VerificadorSaude>.Instance);
        for (var i = 0; i < 3; i++)
        {
            Assert.Equal(NivelSaude.Aviso, (await verificador.VerificarAsync(completa: false, Ct)).Itens.Single().Nivel);
        }

        // Três rodadas, uma thread só presa: as seguintes esperaram a mesma.
        Assert.Equal(1, presa.Chamadas);

        // Solta, ela termina e a rodada seguinte roda uma nova.
        solta.Set();
        await EsperarAsync(async () => (await verificador.VerificarAsync(completa: false, Ct)).Itens.Single().Nivel == NivelSaude.Ok);
        var antes = presa.Chamadas;
        await verificador.VerificarAsync(completa: false, Ct);
        Assert.Equal(antes + 1, presa.Chamadas);
    }

    [Fact]
    public async Task Suspensao_para_a_restauracao_espera_a_rodada_em_curso_e_nao_comeca_outra()
    {
        var lenta = new Lenta();
        var verificador = new VerificadorSaude([lenta], new OpcoesSaude { LimitePorVerificacao = TimeSpan.FromMilliseconds(100) }, _relogio,
            NullLogger<VerificadorSaude>.Instance);
        var anterior = await verificador.VerificarAsync(ct: Ct);
        Assert.Equal(NivelSaude.Aviso, anterior.Itens.Single().Nivel);

        // A rodada já devolveu o aviso, mas a verificação segue com o banco aberto: a suspensão espera por ela.
        var suspensao = verificador.SuspenderAsync(TimeSpan.FromSeconds(10));
        await Task.Delay(300, Ct);
        Assert.False(suspensao.IsCompleted);
        lenta.Soltar();
        await suspensao.WaitAsync(TimeSpan.FromSeconds(5), Ct);
        Assert.True(verificador.Suspenso);

        // Suspenso, nada mais começa (a restauração troca o pdv.db): a rodada devolve a última, sem chamar a verificação.
        Assert.Same(anterior, await verificador.VerificarAsync(ct: Ct));
        Assert.Equal(1, lenta.Chamadas);
    }

    private static async Task EsperarAsync(Func<Task<bool>> condicao)
    {
        var limite = Stopwatch.StartNew();
        while (!await condicao())
        {
            Assert.True(limite.Elapsed < TimeSpan.FromSeconds(10), "a condição não chegou");
            await Task.Delay(50, Ct);
        }
    }

    /// <summary>Bloqueia a thread até ser solta (ignora o cancelamento) e conta as chamadas.</summary>
    private sealed class Presa(ManualResetEventSlim solta) : IVerificacaoSaude
    {
        private int _chamadas;

        public int Chamadas => Volatile.Read(ref _chamadas);

        public string Codigo => "presa";

        public string Nome => "Presa";

        public Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct)
        {
            Interlocked.Increment(ref _chamadas);
            solta.Wait(CancellationToken.None);
            return Task.FromResult(new ItemSaude(Codigo, Nome, NivelSaude.Ok, "solta"));
        }
    }

    /// <summary>Termina só quando o teste solta (ignora o cancelamento, como uma consulta presa no SQLite).</summary>
    private sealed class Lenta : IVerificacaoSaude
    {
        private readonly TaskCompletionSource _solta = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _chamadas;

        public int Chamadas => Volatile.Read(ref _chamadas);

        public string Codigo => "lenta";

        public string Nome => "Lenta";

        public void Soltar() => _solta.TrySetResult();

        public async Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct)
        {
            Interlocked.Increment(ref _chamadas);
            await _solta.Task;
            return new ItemSaude(Codigo, Nome, NivelSaude.Ok, "terminou");
        }
    }

    private sealed class Fixa(string codigo, NivelSaude nivel) : IVerificacaoSaude
    {
        public string Codigo => codigo;

        public string Nome => codigo;

        public Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct) => Task.FromResult(new ItemSaude(codigo, codigo, nivel, codigo));
    }

    /// <summary>Não termina nunca e ignora o cancelamento (um disco de rede travado).</summary>
    private sealed class Travada : IVerificacaoSaude
    {
        public string Codigo => "travada";

        public string Nome => "Travada";

        public Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct) => new TaskCompletionSource<ItemSaude>().Task;
    }

    private sealed class ComErro : IVerificacaoSaude
    {
        public string Codigo => "erro";

        public string Nome => "Com erro";

        public Task<ItemSaude> VerificarAsync(bool completa, CancellationToken ct) =>
            throw new InvalidOperationException("caiu com senha=segredo-do-erro");
    }

    private sealed class Relogio : IRelogio
    {
        public DateTimeOffset Agora { get; set; } = new RelogioSistema().Agora;
    }

    /// <summary>O log do <see cref="ServicoBackup"/> que suspende para a restauração no primeiro erro (a corrida do fechamento).</summary>
    private sealed class LogQueSuspende(Action suspender) : Microsoft.Extensions.Logging.ILogger<ServicoBackup>
    {
        public bool Suspendeu { get; private set; }

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(Microsoft.Extensions.Logging.LogLevel logLevel) => true;

        public void Log<TState>(
            Microsoft.Extensions.Logging.LogLevel logLevel, Microsoft.Extensions.Logging.EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (logLevel == Microsoft.Extensions.Logging.LogLevel.Error && !Suspendeu)
            {
                Suspendeu = true;
                suspender();
            }
        }
    }

    /// <summary>A situação do ciclo online à mão; conta toda chamada que iria à nuvem.</summary>
    private sealed class SincronizacaoSimulada : IServicoSincronizacao
    {
        public SituacaoSincronizacao Situacao { get; set; } = new(true, 0, null);

        public int ChamadasNuvem { get; private set; }

        public event EventHandler<SituacaoSincronizacao>? SituacaoAlterada
        {
            add { }
            remove { }
        }

        public event EventHandler<string>? MensagemRecebida
        {
            add { }
            remove { }
        }

        public Task<ResultadoHandshake> HandshakeAsync(CancellationToken ct = default)
        {
            ChamadasNuvem++;
            return Task.FromResult(new ResultadoHandshake(DesfechoHandshake.SemConexao));
        }

        public void Iniciar() => ChamadasNuvem++;

        public Task AcordarAsync(CancellationToken ct = default)
        {
            ChamadasNuvem++;
            return Task.CompletedTask;
        }

        public void SincronizarAgora() => ChamadasNuvem++;

        public Task DeclararLacunaAsync(Guid autorizadoPorId, string? observacao, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null) => throw new NotSupportedException();

        public Task AutorizarRecuperacaoLacunaAsync(Guid autorizadoPorId, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null) => throw new NotSupportedException();
    }

    /// <summary>Os textos SQL de todo comando dos contextos criados pela fábrica da composição.</summary>
    private sealed class ComandosCapturados : DbCommandInterceptor
    {
        private readonly List<string> _textos = [];

        public IReadOnlyList<string> Textos
        {
            get
            {
                lock (_textos)
                {
                    return [.. _textos];
                }
            }
        }

        public void Limpar()
        {
            lock (_textos)
            {
                _textos.Clear();
            }
        }

        public override DbCommand CommandInitialized(CommandEndEventData eventData, DbCommand result)
        {
            lock (_textos)
            {
                _textos.Add(result.CommandText);
            }

            return result;
        }
    }

    private sealed class FabricaCapturada(FabricaPdvDb fabrica, ComandosCapturados comandos) : IDbContextFactory<PdvDbContext>
    {
        public PdvDbContext CreateDbContext() => new(new DbContextOptionsBuilder<PdvDbContext>()
            .UseSqlite(fabrica.StringConexao, o => o.MigrationsHistoryTable("__ef_migracoes"))
            .AddInterceptors(PragmasSqlite.Instancia, comandos)
            .Options);
    }
}
