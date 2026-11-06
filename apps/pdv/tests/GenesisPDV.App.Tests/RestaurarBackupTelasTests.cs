using System.Text.Json;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.App.ViewModels.Central;
using GenesisPDV.Data;
using GenesisPDV.Data.Backup;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Backup local e "Restaurar backup" na tela (PDV 32.5; SYNC 22.1; Fase 1C, C17; O12 do dono), no terminal de
/// demonstração: o backup a cada intervalo com o caixa aberto e o de saída com o <c>encerramento.json</c>; Ctrl+Alt+C no
/// login (a Central do PDV › 3 Impressora e gaveta) com a liberação de <c>pdv.config.terminal</c> (MARIA não tem;
/// CARLOS, Master, tem) e a confirmação dupla; o app
/// reaberto no "modo restaurado" salta a numeração na primeira venda; e o banco corrompido abre a restauração sozinho.
/// </summary>
public class RestaurarBackupTelasTests
{
    /// <summary>Ctrl+Alt+C no login: a Central com o PIN de CARLOS (Master), a aba 3 Impressora e gaveta e o F9 (I4; G3).</summary>
    private static async Task AbrirRestauracaoAsync(AmbienteUi pdv)
    {
        await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        await pdv.AbrirAbaHardwareAsync();
        pdv.Tecla(Key.F9);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is RestaurarBackupViewModel, "restaurar backup");
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static string? ValorConfiguracao(AmbienteUi pdv, string chave)
    {
        using var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
        return db.ConfiguracaoTerminal.AsNoTracking().Where(c => c.Chave == chave).Select(c => c.Valor).FirstOrDefault();
    }

    [AvaloniaFact]
    public async Task Backup_a_cada_intervalo_com_o_caixa_aberto_e_o_de_saida_com_o_marcador()
    {
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton(new OpcoesBackup { Intervalo = TimeSpan.FromSeconds(2) }));
        await pdv.AtivarDemonstracaoELogarAsync();
        // Caixa aberto: o laço vê o ultimo_backup_em vazio (ou velho) e faz o periódico.
        await pdv.EsperarAsync(() => BackupLocal.Listar(pdv.Caminhos.PastaBackup).Any(a => a.Motivo == MotivosBackup.Periodico),
            "backup periódico", 15_000);

        var saida = await pdv.Servicos.GetRequiredService<ServicoBackup>().EncerrarAsync();
        Assert.NotNull(saida);
        Assert.Equal(MotivosBackup.Saida, saida.Motivo);
        Assert.True(MarcadorEncerramento.Confere(pdv.Caminhos.PastaDados, saida.Arquivo));
    }

    [AvaloniaFact]
    public async Task Ctrl_Alt_C_restaura_com_liberacao_e_confirmacao_dupla_e_o_app_reaberto_salta_a_numeracao()
    {
        var raiz = AmbienteUi.NovaRaiz();
        string arquivo;
        using (var pdv = await AmbienteUi.IniciarAsync(raiz, apagar: false))
        {
            await pdv.AtivarDemonstracaoELogarAsync();
            arquivo = (await pdv.Servicos.GetRequiredService<ServicoBackup>().TentarAsync(MotivosBackup.Periodico, Ct))!.Arquivo;
            pdv.Shell.IrParaLogin();
            await pdv.EsperarFocoAsync("CampoUsuario");
            var reinicios = 0;
            pdv.Shell.AoReiniciar = () => reinicios++;

            // Ctrl+Alt+C: a Central pelo login com o PIN da MARIA (operadora, sem pdv.config.terminal). A aba 3 pede a
            // liberação (sem ela, nem o botão do F9 aparece nem a tecla faz nada); a própria MARIA não libera, o CARLOS
            // (Master) sim. O F9 leva ao "Restaurar backup", que pede o PIN de novo na hora (plano 3.3).
            await pdv.EntrarNaCentralPeloLoginAsync("1", "1234");
            var central = (CentralPdvViewModel)pdv.Shell.PaginaAtual!;
            pdv.Tecla(Key.D3);
            await pdv.EsperarFocoAsync("CampoUsuarioConfig");
            var configuracao = Assert.IsType<AbaHardwareViewModel>(central.Conteudo);
            Assert.False(configuracao.MostraRestaurar);
            Assert.False(pdv.Controle<Button>("BotaoRestaurarBackup").IsVisible);
            pdv.Tecla(Key.F9);
            await AmbienteUi.Pausa();
            Assert.Same(central, pdv.Shell.PaginaAtual);
            configuracao.Usuario = "1";
            configuracao.Pin = "1234";
            pdv.Tecla(Key.Enter);
            await pdv.EsperarAsync(() => configuracao.Erro is not null, "liberação recusada");
            Assert.Equal(AbaHardwareViewModel.EtapaLiberar, configuracao.Etapa);
            configuracao.Usuario = "2";
            configuracao.Pin = "4321";
            pdv.Tecla(Key.Enter);
            await pdv.EsperarAsync(() => configuracao.Editando, "configuração liberada");
            Assert.True(configuracao.MostraRestaurar);
            pdv.Tecla(Key.F9);
            await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is RestaurarBackupViewModel, "restaurar backup");
            var tela = (RestaurarBackupViewModel)pdv.Shell.PaginaAtual!;
            Assert.False(tela.Automatica);
            Assert.Equal(arquivo, tela.Escolhido!.Arquivo.Caminho);
            pdv.Captura("40-restaurar-backup");

            // Conferido o arquivo, a liberação na hora: nem o PIN da entrada na Central nem o que o CARLOS deu na aba 3
            // valem para a ação destrutiva. A MARIA não é supervisora; o CARLOS digita de novo.
            pdv.Tecla(Key.Enter);
            await pdv.EsperarFocoAsync("CampoUsuarioRestauracao");
            Assert.Equal(RestaurarBackupViewModel.EtapaLiberar, tela.Etapa);
            tela.Usuario = "1";
            tela.Pin = "1234";
            pdv.Tecla(Key.Enter);
            await pdv.EsperarAsync(() => tela.Erro is not null, "MARIA não libera a restauração");
            Assert.Equal(RestaurarBackupViewModel.EtapaLiberar, tela.Etapa);
            Assert.Empty(tela.Pin);
            tela.Usuario = "2";
            tela.Pin = "4321";
            pdv.Tecla(Key.Enter);
            await pdv.EsperarFocoAsync("CampoConfirmacaoRestauracao");

            // Confirmação dupla: só a palavra exata.
            tela.Confirmacao = "restaurar";
            pdv.Tecla(Key.Enter);
            await pdv.EsperarAsync(() => tela.Erro is not null, "confirmação recusada");
            Assert.Equal(RestaurarBackupViewModel.EtapaConfirmar, tela.Etapa);
            tela.Confirmacao = tela.PalavraExigida;
            pdv.Tecla(Key.Enter);
            await pdv.EsperarAsync(() => tela.Concluida, $"restauração concluída ({tela.Erro})", 15_000);
            Assert.Contains("restaurado", tela.Resultado, StringComparison.Ordinal);
            pdv.Captura("41-backup-restaurado");
            pdv.Tecla(Key.Enter);
            Assert.Equal(1, reinicios);

            // A restauração ficou pendente para o handshake; o backup de saída não sai (o arquivo é o restaurado).
            var pendente = JsonSerializer.Deserialize<RestauracaoPendente>(ValorConfiguracao(pdv, ChavesConfiguracaoTerminal.RestauracaoPendente)!)!;
            Assert.Equal(Path.GetFileName(arquivo), pendente.Arquivo);
            Assert.Null(await pdv.Servicos.GetRequiredService<ServicoBackup>().EncerrarAsync());
            // O pacote de suporte também parou de ler e gravar no banco (Central do PDV, bloco G9).
            Assert.True(pdv.Servicos.GetRequiredService<GenesisPDV.App.Servicos.Diagnostico.ServicoPacoteSuporte>().Suspenso);
            Assert.Contains(BackupLocal.Listar(pdv.Caminhos.PastaBackup), a => a.Motivo == MotivosBackup.AntesRestauracao);
            await using var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
            var restaurar = await db.LogAuditoriaLocal.SingleAsync(l => l.Acao == "restaurar", Ct);
            Assert.Equal(Guid.Parse("019a0003-0000-7000-8000-000000000002"), restaurar.AutorizadoPorId);
        }

        try
        {
            // Reaberto: o terminal de demonstração não tem nuvem, então é o modo restaurado — a primeira venda salta 1.000.
            using var reaberto = await AmbienteUi.IniciarAsync(raiz, apagar: false);
            var antes = await reaberto.Servicos.GetRequiredService<RepositorioTerminal>().ObterIdentidadeAsync(Ct);
            Assert.NotNull(antes!.RestauradoEm);
            var numero = await reaberto.Servicos.GetRequiredService<RepositorioVendas>().ReservarNumeroVendaAsync(Ct);
            Assert.True(numero > SaltoNumeracao.Margem, $"número {numero}");
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(raiz, recursive: true);
        }
    }

    [AvaloniaFact]
    public async Task Banco_corrompido_abre_a_restauracao_automatica_sem_liberacao()
    {
        var raiz = AmbienteUi.NovaRaiz();
        try
        {
            using (var pdv = await AmbienteUi.IniciarAsync(raiz, apagar: false))
            {
                await pdv.AtivarDemonstracaoELogarAsync();
                await pdv.Servicos.GetRequiredService<ServicoBackup>().TentarAsync(MotivosBackup.Periodico, Ct);
            }

            var caminhos = CaminhosPdv.SobRaiz(raiz);
            SqliteConnection.ClearAllPools();
            foreach (var sufixo in new[] { "-wal", "-shm" })
            {
                File.Delete(caminhos.ArquivoBanco + sufixo);
            }

            await File.WriteAllBytesAsync(caminhos.ArquivoBanco, [.. Enumerable.Repeat((byte)0x42, 8192)], Ct);

            using var reaberto = await AmbienteUi.IniciarAsync(raiz, apagar: false);
            var tela = Assert.IsType<RestaurarBackupViewModel>(reaberto.Shell.PaginaAtual);
            Assert.True(tela.Automatica);
            Assert.Single(tela.Backups);
            reaberto.Shell.AoReiniciar = () => { };
            reaberto.Tecla(Key.Enter);
            await reaberto.EsperarFocoAsync("CampoConfirmacaoRestauracao");
            tela.Confirmacao = RestaurarBackupViewModel.PalavraConfirmacao;
            reaberto.Tecla(Key.Enter);
            await reaberto.EsperarAsync(() => tela.Concluida, $"restauração concluída ({tela.Erro})", 15_000);
            Assert.Single(Directory.GetFiles(caminhos.PastaDados, "pdv.db.corrompido-*"));
            using var c = new SqliteConnection($"Data Source={caminhos.ArquivoBanco};Mode=ReadOnly;Pooling=False");
            c.Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = "PRAGMA integrity_check;";
            Assert.Equal("ok", cmd.ExecuteScalar());
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(raiz, recursive: true);
        }
    }
    [AvaloniaFact]
    public async Task Backup_periodico_so_com_o_caixa_aberto_e_depois_de_vencer_o_intervalo()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var backup = pdv.Servicos.GetRequiredService<ServicoBackup>();
        Assert.True(backup.BancoConferido);
        // Sem terminal ativado e, depois, ativado com o caixa fechado: nenhum periódico.
        Assert.False(await backup.DevidoAsync(Ct));
        await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is not null, "foco no assistente");
        pdv.Tecla(Key.F8);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel);
        Assert.False(await backup.DevidoAsync(Ct));

        // Caixa aberto e nenhum backup ainda: devido; logo depois de um, não; com o último há 2 h, devido de novo.
        await pdv.LogarAsync();
        Assert.True(await backup.DevidoAsync(Ct));
        Assert.NotNull(await backup.TentarAsync(MotivosBackup.Fechamento, Ct));
        Assert.False(await backup.DevidoAsync(Ct));
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            var quase = pdv.Servicos.GetRequiredService<GenesisPDV.Core.Comum.IRelogio>().Agora - new OpcoesBackup().Intervalo + TimeSpan.FromMinutes(1);
            await db.IdentidadeTerminal.ExecuteUpdateAsync(s => s.SetProperty(i => i.UltimoBackupEm, quase), Ct);
            Assert.False(await backup.DevidoAsync(Ct));
            await db.IdentidadeTerminal.ExecuteUpdateAsync(s => s.SetProperty(i => i.UltimoBackupEm, quase - TimeSpan.FromMinutes(2)), Ct);
        }

        Assert.True(await backup.DevidoAsync(Ct));
    }

    [AvaloniaFact]
    public async Task Backup_de_outro_terminal_e_recusado_antes_de_parar_o_sync_e_o_backup()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        var backup = pdv.Servicos.GetRequiredService<ServicoBackup>();
        // Um backup de outro caixa na pasta (a pasta secundária de rede, copiado à mão).
        var outroRaiz = AmbienteUi.NovaRaiz();
        try
        {
            using (var outro = await AmbienteUi.IniciarAsync(outroRaiz, apagar: false))
            {
                await outro.AtivarDemonstracaoELogarAsync();
                await using var db = outro.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
                await db.IdentidadeTerminal.ExecuteUpdateAsync(s => s.SetProperty(i => i.TerminalId, Guid.CreateVersion7()), Ct);
                var doOutro = (await outro.Servicos.GetRequiredService<ServicoBackup>().TentarAsync(MotivosBackup.Periodico, Ct))!.Arquivo;
                File.Copy(doOutro, Path.Combine(pdv.Caminhos.PastaBackup, Path.GetFileName(doOutro)));
            }
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(outroRaiz, recursive: true);
        }

        pdv.Shell.IrParaLogin();
        await pdv.EsperarFocoAsync("CampoUsuario");
        await AbrirRestauracaoAsync(pdv);
        var tela = (RestaurarBackupViewModel)pdv.Shell.PaginaAtual!;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => tela.Erro is not null, "backup de outro terminal recusado");
        Assert.Equal(GenesisPDV.Data.Backup.RestauracaoBackup.MensagemOutroTerminal, tela.Erro);
        Assert.Equal(RestaurarBackupViewModel.EtapaEscolher, tela.Etapa);

        // Nada parou: o backup continua saindo e o Esc volta ao login com o ciclo intacto.
        Assert.NotNull(await backup.TentarAsync(MotivosBackup.Periodico, Ct));
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, "login");
        Assert.NotNull(await backup.EncerrarAsync());
    }

    [AvaloniaFact]
    public async Task Restauracao_que_falha_depois_de_parar_o_caixa_termina_no_reinicio()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        var arquivo = (await pdv.Servicos.GetRequiredService<ServicoBackup>().TentarAsync(MotivosBackup.Periodico, Ct))!.Arquivo;
        var reinicios = 0;
        pdv.Shell.AoReiniciar = () => reinicios++;
        var tela = new RestaurarBackupViewModel(pdv.Shell, automatica: true);
        await tela.CarregarAsync();
        pdv.Shell.PaginaAtual = tela;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoConfirmacaoRestauracao");
        // O arquivo some entre a conferência e a restauração (pendrive retirado): o sync e o backup já pararam.
        File.Delete(arquivo);
        tela.Confirmacao = tela.PalavraExigida;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => tela.Concluida, "restauração recusada", 15_000);
        Assert.NotNull(tela.Erro);
        Assert.Contains("não foi feita", tela.Resultado, StringComparison.Ordinal);
        // O Painel de saúde (G4) também parou antes da troca: nenhuma verificação lê o banco até o app reabrir.
        Assert.True(pdv.Servicos.GetRequiredService<Servicos.Diagnostico.VerificadorSaude>().Suspenso);
        pdv.Tecla(Key.Escape);
        Assert.Same(tela, pdv.Shell.PaginaAtual);
        pdv.Tecla(Key.Enter);
        Assert.Equal(1, reinicios);
    }

    [AvaloniaFact]
    public async Task Eventos_nao_enviados_no_banco_em_uso_exigem_a_confirmacao_com_a_quantidade()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        var arquivo = (await pdv.Servicos.GetRequiredService<ServicoBackup>().TentarAsync(MotivosBackup.Periodico, Ct))!.Arquivo;
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            var maior = await db.EventosSaida.MaxAsync(e => (long?)e.SequenciaTerminal, Ct) ?? 0;
            var agora = DateTimeOffset.UtcNow;
            for (var i = 1; i <= 3; i++)
            {
                db.EventosSaida.Add(new EventoSaida
                {
                    Id = Guid.CreateVersion7(),
                    SequenciaTerminal = maior + i,
                    Tipo = "caixa.sangria",
                    VersaoSchema = 1,
                    AgregadoTipo = "sessao_caixa",
                    AgregadoId = Guid.CreateVersion7(),
                    OcorridoEm = agora,
                    CriadoEm = agora,
                    Payload = "{}",
                    PayloadSha256 = new string('0', 64),
                    Status = StatusEventoSaida.Pendente,
                });
            }

            await db.SaveChangesAsync(Ct);
        }

        int pendentes;
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            string[] aEnviar = [StatusEventoSaida.Pendente, StatusEventoSaida.Enviando, StatusEventoSaida.ErroTemporario];
            pendentes = await db.EventosSaida.CountAsync(e => aEnviar.Contains(e.Status), Ct);
        }

        pdv.Shell.AoReiniciar = () => { };
        var tela = new RestaurarBackupViewModel(pdv.Shell, automatica: true);
        await tela.CarregarAsync();
        tela.Selecionado = tela.Backups.Select(b => b.Arquivo.Caminho).ToList().IndexOf(arquivo);
        pdv.Shell.PaginaAtual = tela;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoConfirmacaoRestauracao");
        Assert.True(pendentes >= 3, $"pendentes {pendentes}");
        Assert.Equal($"{RestaurarBackupViewModel.PalavraConfirmacao} {pendentes}", tela.PalavraExigida);
        Assert.Contains("ainda não enviado", tela.TextoConfirmacao, StringComparison.Ordinal);
        tela.Confirmacao = RestaurarBackupViewModel.PalavraConfirmacao;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => tela.Erro is not null, "confirmação sem a quantidade recusada");
        Assert.Equal(RestaurarBackupViewModel.EtapaConfirmar, tela.Etapa);
    }

    /// <summary>O sync real, com o <c>Iniciar</c> contado (a abertura com a reidratação interrompida liga o ciclo).</summary>
    private sealed class SincronizacaoContada(IServicoSincronizacao real) : IServicoSincronizacao
    {
        public int Inicios { get; private set; }

        public SituacaoSincronizacao Situacao => real.Situacao;

        public event EventHandler<SituacaoSincronizacao>? SituacaoAlterada
        {
            add => real.SituacaoAlterada += value;
            remove => real.SituacaoAlterada -= value;
        }

        public event EventHandler<string>? MensagemRecebida
        {
            add => real.MensagemRecebida += value;
            remove => real.MensagemRecebida -= value;
        }

        public Task<ResultadoHandshake> HandshakeAsync(CancellationToken ct = default) => real.HandshakeAsync(ct);

        public void Iniciar()
        {
            Inicios++;
            real.Iniciar();
        }

        public Task AcordarAsync(CancellationToken ct = default) => real.AcordarAsync(ct);

        public void SincronizarAgora() => real.SincronizarAgora();

        public Task DeclararLacunaAsync(Guid autorizadoPorId, string? observacao, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null) =>
            real.DeclararLacunaAsync(autorizadoPorId, observacao, ct, origem);

        public Task AutorizarRecuperacaoLacunaAsync(Guid autorizadoPorId, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null) =>
            real.AutorizarRecuperacaoLacunaAsync(autorizadoPorId, ct, origem);
    }

    [AvaloniaFact]
    public async Task Reidratacao_interrompida_na_abertura_liga_o_ciclo_e_vai_sozinha_ao_login_quando_termina()
    {
        SincronizacaoContada? sync = null;
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<IServicoSincronizacao>(sp =>
            sync = new SincronizacaoContada(sp.GetRequiredService<ServicoSincronizacaoHttp>())));
        await pdv.AtivarDemonstracaoELogarAsync();
        var inicios = sync!.Inicios;

        // O desfecho do handshake com a reidratação interrompida (o ServicoSincronizacaoHttp, contra a nuvem real).
        Assert.True(await pdv.Shell.AplicarHandshakeAsync(new ResultadoHandshake(DesfechoHandshake.Regressao, "Recuperando.")));
        var tela = Assert.IsType<TerminalBloqueadoViewModel>(pdv.Shell.PaginaAtual);
        Assert.Equal(TerminalBloqueadoViewModel.TituloRecuperando, tela.Titulo);
        Assert.Equal(inicios + 1, sync.Inicios);

        // Ainda em regressão (ou sincronizando): fica; terminada (Ativo), o login vem sem tecla.
        pdv.Shell.AoMudarSituacao(sync.Situacao with { Terminal = EstadoTerminalSync.Regressao });
        pdv.Shell.AoMudarSituacao(sync.Situacao with { Terminal = EstadoTerminalSync.Ativo, Sincronizando = true });
        Assert.Same(tela, pdv.Shell.PaginaAtual);
        pdv.Shell.AoMudarSituacao(sync.Situacao with { Terminal = EstadoTerminalSync.Ativo });
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel, $"login depois da recuperação ({pdv.Shell.PaginaAtual?.GetType().Name}, {pdv.Shell.ErroGlobal})");
    }

    [AvaloniaFact]
    public async Task Banco_corrompido_nao_vira_backup_de_saida_nem_troca_o_marcador()
    {
        var raiz = AmbienteUi.NovaRaiz();
        try
        {
            ResultadoBackup saida;
            using (var pdv = await AmbienteUi.IniciarAsync(raiz, apagar: false))
            {
                await pdv.AtivarDemonstracaoELogarAsync();
                saida = (await pdv.Servicos.GetRequiredService<ServicoBackup>().EncerrarAsync())!;
            }

            var caminhos = CaminhosPdv.SobRaiz(raiz);
            SqliteConnection.ClearAllPools();
            foreach (var sufixo in new[] { "-wal", "-shm" })
            {
                File.Delete(caminhos.ArquivoBanco + sufixo);
            }

            await File.WriteAllBytesAsync(caminhos.ArquivoBanco, [.. Enumerable.Repeat((byte)0x42, 8192)], Ct);
            using var reaberto = await AmbienteUi.IniciarAsync(raiz, apagar: false);
            Assert.IsType<RestaurarBackupViewModel>(reaberto.Shell.PaginaAtual);
            // O operador fecha o app para chamar o suporte: nada de backup do banco corrompido, o marcador fica o de B1.
            var backup = reaberto.Servicos.GetRequiredService<ServicoBackup>();
            Assert.False(backup.BancoConferido);
            Assert.Null(await backup.EncerrarAsync());
            Assert.True(MarcadorEncerramento.Confere(caminhos.PastaDados, saida.Arquivo));
            Assert.DoesNotContain(BackupLocal.Listar(caminhos.PastaBackup), a => a.FeitoEm > saida.FeitoEm);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(raiz, recursive: true);
        }
    }
}
