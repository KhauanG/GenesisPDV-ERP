using System.IO.Compression;
using System.Text.Json;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Backup;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Backup local e restauração (PDV 32.5; SYNC 22.1; Fase 1C, C17): o arquivo compactado e consistente com o
/// <c>ultimo_backup_em</c> dele, a pasta secundária, a retenção de 7 dias + 1 por semana, o <c>encerramento.json</c> que a
/// inicialização apaga, a restauração (validação, banco em uso guardado, token atual mantido, auditoria, restauração
/// pendente) e o salto offline de +1000 do "modo restaurado".
/// </summary>
public class BackupLocalTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed class RelogioFixo(DateTimeOffset agora) : IRelogio
    {
        public DateTimeOffset Agora { get; set; } = agora;
    }

    private static readonly Guid Terminal = Guid.Parse("01a18751-a521-7238-b924-56de3eb13b90");

    private static async Task<(BancoTemporario Banco, RelogioFixo Relogio, BackupLocal Backup)> AtivadoAsync()
    {
        var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var relogio = new RelogioFixo(new DateTimeOffset(2026, 11, 4, 12, 0, 0, TimeSpan.Zero));
        await new RepositorioTerminal(banco.Fabrica, relogio).RegistrarAtivacaoAsync(
            new DadosAtivacao(
                new IdentidadeTerminal
                {
                    TerminalId = Terminal,
                    EmpresaCodigo = 100001,
                    LojaId = Guid.CreateVersion7(),
                    CaixaId = Guid.CreateVersion7(),
                    NumeroCaixa = 2,
                    UrlApi = "https://api.exemplo",
                    TokenProtegido = [1, 2, 3],
                    AtivadoEm = relogio.Agora,
                    NomeMaquina = "CAIXA02",
                },
                new Dictionary<string, long> { [SequenciaLocal.Venda] = 100, [SequenciaLocal.Vale] = 8 },
                null,
                new Dictionary<string, string>()),
            Ct);
        return (banco, relogio, new BackupLocal(banco.Fabrica, banco.Caminhos, relogio));
    }

    private static async Task DefinirSequenciaAsync(BancoTemporario banco, string chave, long valor)
    {
        await using var db = banco.Fabrica.CreateDbContext();
        await db.SequenciasLocais.Where(s => s.Chave == chave).ExecuteUpdateAsync(s => s.SetProperty(x => x.UltimoValor, valor), Ct);
    }

    private static long Sequencia(BancoTemporario banco, string chave) =>
        (long)banco.Escalar($"select ultimo_valor from sequencias_locais where chave = '{chave}'")!;

    /// <summary>Abre o backup compactado num temporário e devolve um valor dele.</summary>
    private static object? EscalarNoBackup(string arquivo, string sql)
    {
        var temporario = Path.Combine(Path.GetTempPath(), $"backup-{Guid.NewGuid():N}.db");
        try
        {
            using (var entrada = File.OpenRead(arquivo))
            using (var gzip = new GZipStream(entrada, CompressionMode.Decompress))
            using (var saida = File.Create(temporario))
            {
                gzip.CopyTo(saida);
            }

            using var c = new SqliteConnection($"Data Source={temporario};Mode=ReadOnly;Pooling=False");
            c.Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = sql;
            return cmd.ExecuteScalar();
        }
        finally
        {
            File.Delete(temporario);
        }
    }

    [Fact]
    public async Task Backup_compactado_consistente_com_o_proprio_ultimo_backup_em_e_a_copia_secundaria()
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        var secundaria = Path.Combine(banco.Raiz, "pendrive");
        await new RepositorioTerminal(banco.Fabrica, relogio).GravarConfiguracaoAsync(BackupLocal.ChavePastaSecundaria, secundaria, ct: Ct);

        var r = await backup.FazerAsync(MotivosBackup.Periodico, Ct);
        Assert.Equal(Path.Combine(banco.Caminhos.PastaBackup, "pdv-20261104-120000-000-periodico.db.gz"), r.Arquivo);
        Assert.Equal(BackupLocal.Sha256(r.Arquivo), r.Sha256);
        Assert.Equal("ok", EscalarNoBackup(r.Arquivo, "PRAGMA integrity_check;"));
        Assert.Equal("delete", EscalarNoBackup(r.Arquivo, "PRAGMA journal_mode;"));
        // O ultimo_backup_em do arquivo é o dele (22.1, prova de que nada se perdeu), e o banco em uso também ganha.
        Assert.Equal("2026-11-04T12:00:00.000Z", EscalarNoBackup(r.Arquivo, "select ultimo_backup_em from identidade_terminal"));
        Assert.Equal("2026-11-04T12:00:00.000Z", banco.Escalar("select ultimo_backup_em from identidade_terminal"));
        // Na secundária, a subpasta do terminal (a pasta de rede pode ser de vários caixas).
        Assert.Equal(Path.Combine(secundaria, Terminal.ToString("D"), Path.GetFileName(r.Arquivo)), r.CopiaSecundaria);
        Assert.Equal(r.Sha256, BackupLocal.Sha256(r.CopiaSecundaria!));
        // Nenhum temporário fica para trás; a lista junta as duas pastas sem repetir e vem do mais novo para o mais antigo.
        Assert.Equal([Path.GetFileName(r.Arquivo)], Directory.GetFiles(banco.Caminhos.PastaBackup).Select(Path.GetFileName));
        relogio.Agora = relogio.Agora.AddHours(2);
        var segundo = await backup.FazerAsync(MotivosBackup.Fechamento, Ct);
        var lista = await backup.ListarAsync(Ct);
        Assert.Equal([segundo.Arquivo, r.Arquivo], lista.Where(a => a.Caminho.StartsWith(banco.Caminhos.PastaBackup, StringComparison.Ordinal)).Select(a => a.Caminho));
        Assert.Equal([MotivosBackup.Fechamento, MotivosBackup.Periodico], lista.Select(a => a.Motivo).Distinct());
    }

    /// <summary>
    /// Central do PDV, bloco G11 (aba 8 Backup): o "Fazer backup agora" tem o motivo <c>manual</c>, vai para as duas pastas,
    /// e a lista diz onde está cada cópia (a do PDV e a da secundária).
    /// </summary>
    [Fact]
    public async Task Backup_manual_vai_as_duas_pastas_e_a_lista_diz_onde_esta_cada_copia()
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        var secundaria = Path.Combine(banco.Raiz, "pendrive");
        await new RepositorioTerminal(banco.Fabrica, relogio).GravarConfiguracaoAsync(BackupLocal.ChavePastaSecundaria, secundaria, ct: Ct);
        var r = await backup.FazerAsync(MotivosBackup.Manual, Ct);
        Assert.EndsWith("-manual.db.gz", r.Arquivo, StringComparison.Ordinal);
        Assert.NotNull(r.CopiaSecundaria);

        var lista = await backup.ListarAsync(Ct);
        Assert.Equal(2, lista.Count);
        Assert.All(lista, a => Assert.Equal(MotivosBackup.Manual, a.Motivo));
        Assert.Equal(r.Arquivo, Assert.Single(lista, a => !a.NaSecundaria).Caminho);
        Assert.Equal(r.CopiaSecundaria, Assert.Single(lista, a => a.NaSecundaria).Caminho);
    }

    /// <summary>
    /// Plano G11: o backup manual respeita a retenção, nas duas pastas, como o periódico: os de mais de 7 dias ficam um por
    /// semana (o mais novo), os manuais antigos também saem.
    /// </summary>
    [Fact]
    public async Task Backup_manual_aplica_a_retencao_nas_duas_pastas()
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        var secundaria = Path.Combine(banco.Raiz, "pendrive");
        await new RepositorioTerminal(banco.Fabrica, relogio).GravarConfiguracaoAsync(BackupLocal.ChavePastaSecundaria, secundaria, ct: Ct);
        var daSecundaria = Path.Combine(secundaria, Terminal.ToString("D"));
        Directory.CreateDirectory(daSecundaria);
        // Na mesma semana, com mais de 7 dias: fica só o mais novo (8 dias); o de 40 dias sai (passa das 4 semanas).
        var antigos = new[] { (8.0, MotivosBackup.Manual), (9.0, MotivosBackup.Manual), (10.0, MotivosBackup.Periodico), (40.0, MotivosBackup.Manual) };
        foreach (var pasta in new[] { banco.Caminhos.PastaBackup, daSecundaria })
        {
            foreach (var (dias, motivo) in antigos)
            {
                await File.WriteAllTextAsync(Path.Combine(pasta, BackupLocal.NomeArquivo(relogio.Agora.AddDays(-dias), motivo) + ".gz"), "x", Ct);
            }
        }

        var r = await backup.FazerAsync(MotivosBackup.Manual, Ct);
        Assert.NotNull(r.CopiaSecundaria);
        foreach (var pasta in new[] { banco.Caminhos.PastaBackup, daSecundaria })
        {
            var ficaram = BackupLocal.Listar(pasta).Select(a => (Math.Round((relogio.Agora - a.FeitoEm).TotalDays, 1), a.Motivo)).ToList();
            Assert.Equal([(0.0, MotivosBackup.Manual), (8.0, MotivosBackup.Manual)], ficaram);
        }
    }

    [Fact]
    public async Task Pasta_secundaria_fora_do_ar_nao_impede_o_backup()
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        // Um arquivo no lugar da pasta: a cópia falha (pendrive fora), o principal fica e o log registra.
        var bloqueio = Path.Combine(banco.Raiz, "nao-e-pasta");
        await File.WriteAllTextAsync(bloqueio, "x", Ct);
        await new RepositorioTerminal(banco.Fabrica, relogio).GravarConfiguracaoAsync(BackupLocal.ChavePastaSecundaria, bloqueio, ct: Ct);
        var r = await backup.FazerAsync(MotivosBackup.Periodico, Ct);
        Assert.True(File.Exists(r.Arquivo));
        Assert.Null(r.CopiaSecundaria);
        Assert.Equal(1L, banco.Escalar("select count(*) from log_local where origem = 'backup' and nivel = 'aviso'"));
    }

    [Fact]
    public void Retencao_mantem_7_dias_e_o_mais_novo_de_cada_semana_ate_4_semanas()
    {
        using var banco = new BancoTemporario();
        var agora = new DateTimeOffset(2026, 11, 30, 12, 0, 0, TimeSpan.Zero);
        var backup = new BackupLocal(banco.Fabrica, banco.Caminhos, new RelogioFixo(agora));
        var dias = new[] { 0.5, 3, 6.9, 7.5, 9, 13, 15, 20, 22, 27, 29, 40 };
        foreach (var d in dias)
        {
            File.WriteAllText(Path.Combine(banco.Caminhos.PastaBackup, BackupLocal.NomeArquivo(agora.AddDays(-d), MotivosBackup.Periodico) + ".gz"), "x");
        }

        File.WriteAllText(Path.Combine(banco.Caminhos.PastaBackup, "anotacoes.txt"), "não é backup");
        var apagados = backup.AplicarRetencao(banco.Caminhos.PastaBackup, agora);
        var ficaram = BackupLocal.Listar(banco.Caminhos.PastaBackup).Select(a => Math.Round((agora - a.FeitoEm).TotalDays, 1)).ToList();
        // Até 7 dias, todos; depois, um por semana (o mais novo dela): 7,5 (semana 1), 15 (semana 2), 22 (semana 3).
        Assert.Equal([0.5, 3, 6.9, 7.5, 15, 22], ficaram);
        Assert.Equal(6, apagados.Count);
        Assert.True(File.Exists(Path.Combine(banco.Caminhos.PastaBackup, "anotacoes.txt")));
    }

    [Fact]
    public async Task Pasta_secundaria_comum_a_dois_caixas_nao_mistura_lista_nem_retencao()
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        var rede = Path.Combine(banco.Raiz, "servidor", "backup-pdv");
        await new RepositorioTerminal(banco.Fabrica, relogio).GravarConfiguracaoAsync(BackupLocal.ChavePastaSecundaria, rede, ct: Ct);
        // O caixa 01 grava na mesma pasta de rede, na subpasta dele: dois semanais com mais de 7 dias, na mesma semana.
        var outro = Path.Combine(rede, Guid.CreateVersion7().ToString("D"));
        Directory.CreateDirectory(outro);
        var doOutro = new[] { 8, 9 }.Select(d => Path.Combine(outro, BackupLocal.NomeArquivo(relogio.Agora.AddDays(-d), MotivosBackup.Periodico) + ".gz")).ToList();
        foreach (var a in doOutro)
        {
            await File.WriteAllTextAsync(a, "x", Ct);
        }

        // Também um arquivo solto na raiz (de uma versão que não usava a subpasta): nem a lista nem a retenção o veem.
        var solto = Path.Combine(rede, BackupLocal.NomeArquivo(relogio.Agora.AddDays(-9), MotivosBackup.Periodico) + ".gz");
        await File.WriteAllTextAsync(solto, "x", Ct);

        var r = await backup.FazerAsync(MotivosBackup.Periodico, Ct);
        Assert.Equal(Path.Combine(rede, Terminal.ToString("D")), Path.GetDirectoryName(r.CopiaSecundaria));
        Assert.All(doOutro.Append(solto), a => Assert.True(File.Exists(a), a));
        var lista = await backup.ListarAsync(Ct);
        Assert.Equal(2, lista.Count);
        Assert.All(lista, a => Assert.Equal(Path.GetFileName(r.Arquivo), a.Nome));
    }

    [Fact]
    public async Task Retencao_nunca_apaga_o_banco_guardado_antes_de_uma_restauracao()
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        var guardado = Path.Combine(banco.Caminhos.PastaBackup, BackupLocal.NomeArquivo(relogio.Agora.AddDays(-9), MotivosBackup.AntesRestauracao) + ".gz");
        var semanal = Path.Combine(banco.Caminhos.PastaBackup, BackupLocal.NomeArquivo(relogio.Agora.AddDays(-8), MotivosBackup.Periodico) + ".gz");
        var velho = Path.Combine(banco.Caminhos.PastaBackup, BackupLocal.NomeArquivo(relogio.Agora.AddDays(-60), MotivosBackup.AntesRestauracao) + ".gz");
        foreach (var a in new[] { guardado, semanal, velho })
        {
            await File.WriteAllTextAsync(a, "x", Ct);
        }

        // O periódico de 8 dias é o mais novo da semana 1: o antes-restauracao de 9 dias, na mesma semana, também fica, e o
        // de 60 dias (fora das 4 semanas) também.
        await backup.FazerAsync(MotivosBackup.Periodico, Ct);
        Assert.True(File.Exists(guardado));
        Assert.True(File.Exists(semanal));
        Assert.True(File.Exists(velho));
    }

    [Fact]
    public async Task Marcador_de_encerramento_e_apagado_na_inicializacao_so_com_o_banco_integro()
    {
        var (banco, _, backup) = await AtivadoAsync();
        using var _b = banco;
        var saida = await backup.FazerAsync(MotivosBackup.Saida, Ct);
        MarcadorEncerramento.Gravar(banco.Caminhos.PastaDados, saida);
        Assert.True(MarcadorEncerramento.Confere(banco.Caminhos.PastaDados, saida.Arquivo));
        Assert.Equal(Path.GetFileName(saida.Arquivo), MarcadorEncerramento.Ler(banco.Caminhos.PastaDados)!.Arquivo);

        SqliteConnection.ClearAllPools();
        await File.WriteAllBytesAsync(banco.Caminhos.ArquivoBanco, [.. Enumerable.Repeat((byte)0x42, 8192)], Ct);
        await Assert.ThrowsAsync<BancoCorrompidoException>(() => InicializadorBanco.InicializarAsync(
            banco.Fabrica, banco.Caminhos.PastaBackup, DateTimeOffset.UtcNow, Ct, banco.Caminhos.PastaDados));
        Assert.NotNull(MarcadorEncerramento.Ler(banco.Caminhos.PastaDados));

        SqliteConnection.ClearAllPools();
        foreach (var arquivo in new[] { "", "-wal", "-shm" })
        {
            File.Delete(banco.Caminhos.ArquivoBanco + arquivo);
        }

        await InicializadorBanco.InicializarAsync(banco.Fabrica, banco.Caminhos.PastaBackup, DateTimeOffset.UtcNow, Ct, banco.Caminhos.PastaDados);
        Assert.Null(MarcadorEncerramento.Ler(banco.Caminhos.PastaDados));
    }

    [Fact]
    public async Task Restaurar_valida_guarda_o_banco_em_uso_mantem_o_token_e_deixa_a_restauracao_pendente()
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        await DefinirSequenciaAsync(banco, SequenciaLocal.Evento, 1020);
        var antigo = await backup.FazerAsync(MotivosBackup.Periodico, Ct);

        // Depois do backup: mais eventos e o token rotacionado.
        relogio.Agora = relogio.Agora.AddHours(2);
        await DefinirSequenciaAsync(banco, SequenciaLocal.Evento, 1046);
        await DefinirSequenciaAsync(banco, SequenciaLocal.Venda, 126);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.IdentidadeTerminal.ExecuteUpdateAsync(s => s.SetProperty(i => i.TokenProtegido, new byte[] { 9, 9, 9 }), Ct);
        }

        var restauracao = new RestauracaoBackup(banco.Fabrica, banco.Caminhos, backup, relogio);
        var r = await restauracao.RestaurarAsync(antigo.Arquivo, null, null, Ct);
        Assert.False(r.Pendente.BackupDeSaida);
        Assert.Equal((1020L, relogio.Agora), (r.Pendente.SequenciaBackup, r.Pendente.RestauradoEm));
        Assert.Equal(DateTimeOffset.Parse("2026-11-04T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture), r.Pendente.UltimoBackupEm);
        Assert.Contains("-antes-restauracao.db.gz", r.BancoAnterior, StringComparison.Ordinal);

        Assert.Equal(1020L, Sequencia(banco, SequenciaLocal.Evento));
        Assert.Equal(100L, Sequencia(banco, SequenciaLocal.Venda));
        Assert.Equal("2026-11-04T14:00:00.000Z", banco.Escalar("select restaurado_em from identidade_terminal"));
        Assert.Equal("2026-11-04T12:00:00.000Z", banco.Escalar("select ultimo_backup_em from identidade_terminal"));
        Assert.Equal(new byte[] { 9, 9, 9 }, (byte[])banco.Escalar("select token_protegido from identidade_terminal")!);
        var pendente = JsonSerializer.Deserialize<RestauracaoPendente>(
            (string)banco.Escalar($"select valor from configuracao_terminal where chave = '{ChavesConfiguracaoTerminal.RestauracaoPendente}'")!)!;
        Assert.Equal(r.Pendente, pendente);
        Assert.Equal(1L, banco.Escalar("select count(*) from log_auditoria_local where acao = 'restaurar' and entidade = 'identidade_terminal'"));
        // O banco que estava em uso ficou guardado (com a sequência 1046).
        Assert.Equal(1046L, EscalarNoBackup(r.BancoAnterior!, "select ultimo_valor from sequencias_locais where chave = 'evento'"));
        Assert.Equal("ok", banco.Escalar("PRAGMA integrity_check;"));
    }

    [Fact]
    public async Task Restaurar_recusa_arquivo_invalido_e_backup_de_outro_terminal_sem_tocar_no_banco()
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        var restauracao = new RestauracaoBackup(banco.Fabrica, banco.Caminhos, backup, relogio);
        var lixo = Path.Combine(banco.Caminhos.PastaBackup, BackupLocal.NomeArquivo(relogio.Agora, MotivosBackup.Periodico));
        await File.WriteAllBytesAsync(lixo, [.. Enumerable.Repeat((byte)0x42, 8192)], Ct);
        var e = await Assert.ThrowsAsync<RegraNegocioException>(() => restauracao.RestaurarAsync(lixo, null, null, Ct));
        Assert.Equal(RestauracaoBackup.MensagemInvalido, e.Message);

        var meu = await backup.FazerAsync(MotivosBackup.Periodico, Ct);
        using (var outro = new BancoTemporario())
        {
            await outro.InicializarAsync();
            var relogioOutro = new RelogioFixo(relogio.Agora);
            await new RepositorioTerminal(outro.Fabrica, relogioOutro).RegistrarAtivacaoAsync(
                new IdentidadeTerminal { TerminalId = Guid.CreateVersion7(), UrlApi = "https://api.exemplo", TokenProtegido = [7], AtivadoEm = relogio.Agora }, Ct);
            var doOutro = await new BackupLocal(outro.Fabrica, outro.Caminhos, relogioOutro).FazerAsync(MotivosBackup.Periodico, Ct);
            File.Copy(doOutro.Arquivo, Path.Combine(banco.Caminhos.PastaBackup, "pdv-20260101-000000-000-periodico.db.gz"));
        }

        e = await Assert.ThrowsAsync<RegraNegocioException>(() =>
            restauracao.RestaurarAsync(Path.Combine(banco.Caminhos.PastaBackup, "pdv-20260101-000000-000-periodico.db.gz"), null, null, Ct));
        Assert.Equal(RestauracaoBackup.MensagemOutroTerminal, e.Message);
        Assert.Equal(DBNull.Value, banco.Escalar("select restaurado_em from identidade_terminal"));
        // Nenhuma restauração recusada guardou o banco em uso nem deixou temporário.
        Assert.Equal(
            new[] { meu.Arquivo, Path.Combine(banco.Caminhos.PastaBackup, "pdv-20260101-000000-000-periodico.db.gz"), lixo }.Order(StringComparer.Ordinal),
            Directory.GetFiles(banco.Caminhos.PastaBackup).Order(StringComparer.Ordinal));
        Assert.Empty(Directory.GetFiles(banco.Caminhos.PastaDados, ".restaurando-*"));
    }

    [Fact]
    public async Task Conferir_recusa_antes_de_parar_o_caixa_e_conta_os_eventos_nao_enviados_do_banco_em_uso()
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        var arquivo = await backup.FazerAsync(MotivosBackup.Periodico, Ct);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            foreach (var (seq, status) in new[] { (1L, StatusEventoSaida.Confirmado), (2L, StatusEventoSaida.Pendente), (3L, StatusEventoSaida.ErroTemporario) })
            {
                db.EventosSaida.Add(new EventoSaida
                {
                    Id = Guid.CreateVersion7(),
                    SequenciaTerminal = seq,
                    Tipo = "caixa.sangria",
                    VersaoSchema = 1,
                    AgregadoTipo = "sessao_caixa",
                    AgregadoId = Guid.CreateVersion7(),
                    OcorridoEm = relogio.Agora,
                    CriadoEm = relogio.Agora,
                    Payload = "{}",
                    PayloadSha256 = new string('0', 64),
                    Status = status,
                });
            }

            await db.SaveChangesAsync(Ct);
        }

        var restauracao = new RestauracaoBackup(banco.Fabrica, banco.Caminhos, backup, relogio);
        var c = await restauracao.ConferirAsync(arquivo.Arquivo, Ct);
        Assert.Equal((Terminal, 2), (c.TerminalId, c.EventosPendentesEmUso));
        Assert.Equal(DBNull.Value, banco.Escalar("select restaurado_em from identidade_terminal"));
        Assert.Empty(Directory.GetFiles(banco.Caminhos.PastaDados, ".restaurando-*"));
        var e = await Assert.ThrowsAsync<RegraNegocioException>(() => restauracao.ConferirAsync(arquivo.Arquivo + ".nao-existe", Ct));
        Assert.Contains("não existe", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Banco_em_uso_corrompido_com_a_identidade_legivel_mantem_o_token_atual_e_confere_o_terminal()
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        var arquivo = await backup.FazerAsync(MotivosBackup.Periodico, Ct);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.IdentidadeTerminal.ExecuteUpdateAsync(s => s.SetProperty(i => i.TokenProtegido, new byte[] { 9, 9, 9 }), Ct);
        }

        // Corrupção fora de identidade_terminal: o token rotacionado depois do backup não volta ao antigo.
        CorromperForaDaIdentidade(banco);
        var r = await new RestauracaoBackup(banco.Fabrica, banco.Caminhos, backup, relogio).RestaurarAsync(arquivo.Arquivo, null, null, Ct);
        Assert.Contains(".corrompido-", r.BancoAnterior, StringComparison.Ordinal);
        Assert.Equal(new byte[] { 9, 9, 9 }, (byte[])banco.Escalar("select token_protegido from identidade_terminal")!);
    }

    /// <summary>
    /// A página de <c>estado_conexao</c> (gravada a cada heartbeat) estragada no banco em uso: a <c>maior_hora_vista</c>
    /// não sai, mas o token pendente da rotação em curso (SYNC 3.7), lido antes e à parte, continua no arquivo restaurado.
    /// </summary>
    [Fact]
    public async Task Banco_em_uso_com_a_pagina_de_estado_conexao_corrompida_mantem_o_token_pendente()
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        var arquivo = await backup.FazerAsync(MotivosBackup.Periodico, Ct);
        Assert.Equal(0L, EscalarNoBackup(arquivo.Arquivo, $"select count(*) from configuracao_terminal where chave = '{ChavesConfiguracaoTerminal.TokenPendente}'"));

        // Depois do backup: a rotação pedida e o token novo guardado como pendente.
        var pendenteEmUso = new Dictionary<string, string> { ["token"] = "dGVzdGU=", ["requisicao_id"] = Guid.CreateVersion7().ToString("D") };
        var terminal = new RepositorioTerminal(banco.Fabrica, relogio);
        await terminal.GravarConfiguracaoAsync(ChavesConfiguracaoTerminal.TokenPendente, pendenteEmUso, ct: Ct);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.IdentidadeTerminal.ExecuteUpdateAsync(s => s.SetProperty(i => i.TokenProtegido, new byte[] { 9, 9, 9 }), Ct);
        }

        var esperado = (string)banco.Escalar($"select valor from configuracao_terminal where chave = '{ChavesConfiguracaoTerminal.TokenPendente}'")!;
        CorromperPaginaDaTabela(banco, "estado_conexao");
        var r = await new RestauracaoBackup(banco.Fabrica, banco.Caminhos, backup, relogio).RestaurarAsync(arquivo.Arquivo, null, null, Ct);
        Assert.Contains(".corrompido-", r.BancoAnterior, StringComparison.Ordinal);
        Assert.Equal(new byte[] { 9, 9, 9 }, (byte[])banco.Escalar("select token_protegido from identidade_terminal")!);
        Assert.Equal(esperado, banco.Escalar($"select valor from configuracao_terminal where chave = '{ChavesConfiguracaoTerminal.TokenPendente}'"));
    }

    /// <summary>
    /// Estraga só a página raiz de <paramref name="tabela"/> (o byte do tipo da página): o <c>SELECT</c> nela lança
    /// SQLITE_CORRUPT, e as outras tabelas continuam saindo na leitura direta.
    /// </summary>
    private static void CorromperPaginaDaTabela(BancoTemporario banco, string tabela)
    {
        SqliteConnection.ClearAllPools();
        long raiz, tamanho;
        using (var c = new SqliteConnection($"Data Source={banco.Caminhos.ArquivoBanco};Pooling=False"))
        {
            c.Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;";
            cmd.ExecuteNonQuery();
            cmd.CommandText = $"SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = '{tabela}';";
            raiz = (long)cmd.ExecuteScalar()!;
            cmd.CommandText = "PRAGMA page_size;";
            tamanho = (long)cmd.ExecuteScalar()!;
        }

        SqliteConnection.ClearAllPools();
        using (var f = new FileStream(banco.Caminhos.ArquivoBanco, FileMode.Open, FileAccess.Write))
        {
            f.Position = ((raiz - 1) * tamanho) + (raiz == 1 ? 100 : 0);
            f.WriteByte(0xFF);
        }

        Assert.Throws<SqliteException>(() => banco.Escalar($"select count(*) from {tabela}"));
        SqliteConnection.ClearAllPools();
    }

    /// <summary>
    /// Um índice com o conteúdo trocado reprova o <c>integrity_check</c>, mas as linhas de <c>identidade_terminal</c> e de
    /// <c>estado_conexao</c> ainda saem (o caminho da restauração automática depois do banco corrompido).
    /// </summary>
    private static void CorromperForaDaIdentidade(BancoTemporario banco)
    {
        SqliteConnection.ClearAllPools();
        using (var c = new SqliteConnection($"Data Source={banco.Caminhos.ArquivoBanco};Pooling=False"))
        {
            c.Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText =
                "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; CREATE TABLE t_corromper (a TEXT); CREATE INDEX ix_corromper ON t_corromper (a);" +
                "INSERT INTO t_corromper VALUES ('a'), ('b'), ('c'); PRAGMA writable_schema=ON;" +
                "UPDATE sqlite_master SET sql = 'CREATE INDEX ix_corromper ON t_corromper (a DESC)' WHERE name = 'ix_corromper';";
            cmd.ExecuteNonQuery();
        }

        SqliteConnection.ClearAllPools();
        Assert.NotEqual("ok", banco.Escalar("PRAGMA integrity_check;")?.ToString());
    }

    /// <summary>
    /// SYNC 3.8 e 22.1: o status do terminal só avança (<c>ativo → desativando → revogado</c>), e a restauração fica com o
    /// mais restritivo entre o do arquivo e o do banco em uso — também na automática, com o banco em uso corrompido. O
    /// backup tirado antes da ordem do ERP não devolve o caixa a <c>ativo</c>: offline, ele continua sem reservar número
    /// de venda e sem abrir o caixa. A maior hora já vista (relógio de alta-água, PDV 30.5) também não volta.
    /// </summary>
    [Theory]
    [InlineData(StatusIdentidade.Desativando, false)]
    [InlineData(StatusIdentidade.Revogado, false)]
    [InlineData(StatusIdentidade.Desativando, true)]
    [InlineData(StatusIdentidade.Revogado, true)]
    public async Task Restaurar_backup_de_antes_da_ordem_do_erp_mantem_o_status_e_o_caixa_nao_vende_nem_abre(string status, bool emUsoCorrompido)
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        var antigo = await backup.FazerAsync(MotivosBackup.Periodico, Ct);
        Assert.Equal(StatusIdentidade.Ativo, EscalarNoBackup(antigo.Arquivo, "select status from identidade_terminal"));

        // Depois do backup: a ordem do ERP gravada e o relógio de alta-água adiantado.
        relogio.Agora = relogio.Agora.AddHours(2);
        Assert.True(await new RepositorioTerminal(banco.Fabrica, relogio).AvancarStatusAsync(status, Ct));
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.EstadoConexao.ExecuteUpdateAsync(s => s.SetProperty(c => c.MaiorHoraVista, relogio.Agora), Ct);
        }

        if (emUsoCorrompido)
        {
            CorromperForaDaIdentidade(banco);
        }

        await new RestauracaoBackup(banco.Fabrica, banco.Caminhos, backup, relogio).RestaurarAsync(antigo.Arquivo, null, null, Ct);
        Assert.Equal(status, banco.Escalar("select status from identidade_terminal"));
        Assert.Equal("2026-11-04T14:00:00.000Z", banco.Escalar("select maior_hora_vista from estado_conexao"));

        var venda = await Assert.ThrowsAsync<RegraNegocioException>(() => new RepositorioVendas(banco.Fabrica, relogio).ReservarNumeroVendaAsync(Ct));
        Assert.Equal(RepositorioVendas.MensagemTerminalDesativando, venda.Message);
        var sessao = new SessaoCaixaRegistro
        {
            Id = IdGerador.Novo(),
            LojaId = Guid.CreateVersion7(),
            CaixaId = Guid.CreateVersion7(),
            NumeroCaixa = 2,
            TerminalId = Terminal,
            OperadorId = Guid.CreateVersion7(),
            DiaOperacional = DateOnly.FromDateTime(relogio.Agora.UtcDateTime),
            AbertaEm = relogio.Agora,
        };
        var abrir = await Assert.ThrowsAsync<RegraNegocioException>(() => new RepositorioCaixa(banco.Fabrica, relogio).AbrirAsync(
            sessao, null, new EventoParaOutbox(Guid.CreateVersion7(), "caixa.aberto", 1, "sessao_caixa", sessao.Id, relogio.Agora, "{}", new string('0', 64)), Ct));
        Assert.Equal(RepositorioCaixa.MensagemTerminalDesativando, abrir.Message);
        Assert.Equal(0L, banco.Escalar("select count(*) from sessoes_caixa"));
    }

    /// <summary>Restauração com o terminal ativo nos dois bancos: o status fica <c>ativo</c> e a maior hora do arquivo, se for maior, fica.</summary>
    [Fact]
    public async Task Restaurar_com_o_terminal_ativo_fica_ativo_e_a_maior_hora_vista_mais_nova_vale()
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.EstadoConexao.ExecuteUpdateAsync(s => s.SetProperty(c => c.MaiorHoraVista, relogio.Agora.AddHours(5)), Ct);
        }

        var arquivo = await backup.FazerAsync(MotivosBackup.Periodico, Ct);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.EstadoConexao.ExecuteUpdateAsync(s => s.SetProperty(c => c.MaiorHoraVista, relogio.Agora.AddHours(1)), Ct);
        }

        await new RestauracaoBackup(banco.Fabrica, banco.Caminhos, backup, relogio).RestaurarAsync(arquivo.Arquivo, null, null, Ct);
        Assert.Equal(StatusIdentidade.Ativo, banco.Escalar("select status from identidade_terminal"));
        Assert.Equal("2026-11-04T17:00:00.000Z", banco.Escalar("select maior_hora_vista from estado_conexao"));
        Assert.Equal(1101L, await new RepositorioVendas(banco.Fabrica, relogio).ReservarNumeroVendaAsync(Ct));
    }

    [Fact]
    public async Task Backup_de_saida_com_o_marcador_conferido_marca_a_restauracao()
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        var saida = await backup.FazerAsync(MotivosBackup.Saida, Ct);
        MarcadorEncerramento.Gravar(banco.Caminhos.PastaDados, saida);
        var r = await new RestauracaoBackup(banco.Fabrica, banco.Caminhos, backup, relogio).RestaurarAsync(saida.Arquivo, null, null, Ct);
        Assert.True(r.Pendente.BackupDeSaida);
    }

    [Fact]
    public async Task Modo_restaurado_salta_venda_e_vale_1000_uma_vez_na_primeira_reserva()
    {
        var (banco, relogio, backup) = await AtivadoAsync();
        using var _ = banco;
        var arquivo = await backup.FazerAsync(MotivosBackup.Periodico, Ct);
        await new RestauracaoBackup(banco.Fabrica, banco.Caminhos, backup, relogio).RestaurarAsync(arquivo.Arquivo, null, null, Ct);
        var vendas = new RepositorioVendas(banco.Fabrica, relogio);
        Assert.Equal(1101L, await vendas.ReservarNumeroVendaAsync(Ct));
        Assert.Equal(1102L, await vendas.ReservarNumeroVendaAsync(Ct));
        Assert.Equal(1008L, Sequencia(banco, SequenciaLocal.Vale));
        var pendente = JsonSerializer.Deserialize<RestauracaoPendente>(
            (string)banco.Escalar($"select valor from configuracao_terminal where chave = '{ChavesConfiguracaoTerminal.RestauracaoPendente}'")!)!;
        Assert.Equal(relogio.Agora, pendente.SaltoAplicadoEm);
        Assert.Equal(1L, banco.Escalar("select count(*) from log_local where origem = 'backup' and mensagem like 'Modo restaurado%'"));
    }
}
