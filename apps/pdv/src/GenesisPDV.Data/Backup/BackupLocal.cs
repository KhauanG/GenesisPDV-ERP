using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Convencoes;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Backup;

/// <summary>Por que o backup foi feito (sufixo do nome do arquivo; PDV 32.5).</summary>
public static class MotivosBackup
{
    /// <summary>A cada 2 h com o caixa aberto (<see cref="OpcoesBackup.Intervalo"/>).</summary>
    public const string Periodico = "periodico";

    /// <summary>Logo depois do fechamento de caixa (ou da troca de turno).</summary>
    public const string Fechamento = "fechamento";

    /// <summary>Ao fechar o aplicativo normalmente: o "backup de saída" que o <c>encerramento.json</c> confere (22.1).</summary>
    public const string Saida = "saida";

    /// <summary>
    /// O banco em uso, guardado antes de ser substituído pela restauração (nada se perde se o arquivo for o errado). Fica
    /// fora da retenção automática: pode ser a única cópia dos eventos que ele não chegou a enviar.
    /// </summary>
    public const string AntesRestauracao = "antes-restauracao";

    /// <summary>Antes de aplicar migrações pendentes (<see cref="InicializadorBanco"/>, sem compactar: o schema é o antigo).</summary>
    public const string AntesMigracao = "antes-migracao";

    /// <summary>
    /// "Fazer backup agora" da aba 8 Backup da Central do PDV (bloco G11): o mesmo backup do periódico, nas duas pastas e
    /// com a mesma retenção.
    /// </summary>
    public const string Manual = "manual";

    /// <summary>
    /// O motivo em português de balcão, o mesmo na aba 8 Backup e na tela do "Restaurar backup" (o de outra versão aparece
    /// como foi gravado).
    /// </summary>
    public static string Rotulo(string motivo) => motivo switch
    {
        Periodico => "a cada 2 h",
        Fechamento => "fechamento do caixa",
        Saida => "saída do aplicativo",
        AntesRestauracao => "antes de uma restauração",
        AntesMigracao => "antes de atualizar o banco",
        Manual => "feito agora (manual)",
        _ => motivo,
    };
}

/// <summary>Configuração do backup local (os testes encurtam o intervalo).</summary>
public sealed record OpcoesBackup
{
    /// <summary>PDV 32.5: a cada 2 h com o caixa aberto.</summary>
    public TimeSpan Intervalo { get; init; } = TimeSpan.FromHours(2);

    /// <summary>Retenção: todos os dos últimos dias…</summary>
    public int DiasCompletos { get; init; } = 7;

    /// <summary>…e o mais novo de cada semana até este tanto de semanas.</summary>
    public int SemanasUmPorSemana { get; init; } = 4;
}

/// <summary>Um arquivo de backup na pasta (o nome traz a hora e o motivo: <c>pdv-AAAAMMDD-HHMMSS-fff-motivo.db[.gz]</c>).</summary>
/// <param name="NaSecundaria">A cópia está na pasta secundária (<see cref="BackupLocal.ListarAsync"/>; a aba 8 mostra onde).</param>
public sealed record ArquivoBackup(string Caminho, DateTimeOffset FeitoEm, string Motivo, long Tamanho, bool NaSecundaria = false)
{
    public string Nome => Path.GetFileName(Caminho);

    public bool Compactado => Caminho.EndsWith(".gz", StringComparison.OrdinalIgnoreCase);
}

/// <summary>Backup feito: o arquivo, o sha256 dele (o que o <c>encerramento.json</c> grava) e a cópia na pasta secundária.</summary>
public sealed record ResultadoBackup(string Arquivo, string Sha256, DateTimeOffset FeitoEm, string Motivo, string? CopiaSecundaria);

/// <summary>
/// Backup local do PDV (PDV 32.5; SYNC 22.1; Fase 1C, bloco C17; O12 do dono). Cópia consistente pela API de backup
/// online do SQLite (o banco segue em uso), com o <c>identidade_terminal.ultimo_backup_em</c> do arquivo gravado na
/// própria cópia (é o que a prova de "nada se perdeu" compara depois de restaurar), convertida para um arquivo só
/// (<c>journal_mode=DELETE</c>), compactada (gzip) e gravada com nome temporário e renomeada no fim: um backup pela
/// metade nunca aparece na lista. Depois o banco em uso também ganha o <c>ultimo_backup_em</c> e, se configurada, uma
/// cópia vai para a pasta secundária (<c>backup.pasta_secundaria</c>, pendrive ou rede; falha só no log), numa subpasta
/// com o <c>terminal_id</c> (<see cref="PastaSecundariaAsync"/>): a pasta de rede comum a vários caixas não mistura os
/// arquivos nem a retenção de um apaga os do outro. Retenção: os últimos 7 dias completos e o mais novo de cada semana
/// até 4 semanas, nas duas pastas, menos o <see cref="MotivosBackup.AntesRestauracao"/>. Sem cifra até a 1D (decisão
/// do dono O12; a chave de backup em custódia, SYNC 22.3, chega com o SQLCipher).
/// </summary>
public sealed class BackupLocal(FabricaPdvDb fabrica, CaminhosPdv caminhos, IRelogio relogio, OpcoesBackup? opcoes = null)
{
    /// <summary>Chave local de <c>configuracao_terminal</c> com a pasta secundária (texto JSON); ausente = só a pasta <c>backup/</c>.</summary>
    public const string ChavePastaSecundaria = "backup.pasta_secundaria";

    private const string Prefixo = "pdv-";
    private const string FormatoHora = "yyyyMMdd-HHmmss-fff";
    private static readonly SemaphoreSlim Trava = new(1, 1);

    public OpcoesBackup Opcoes { get; } = opcoes ?? new OpcoesBackup();

    /// <summary>Há um backup em curso neste processo agora (o próximo espera ele terminar; a aba 8 avisa).</summary>
    public static bool EmCurso => Trava.CurrentCount == 0;

    /// <summary>Faz um backup agora (um por vez no processo); devolve o arquivo e o sha256.</summary>
    public async Task<ResultadoBackup> FazerAsync(string motivo, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(motivo);
        await Trava.WaitAsync(ct);
        try
        {
            var agora = relogio.Agora;
            Directory.CreateDirectory(caminhos.PastaBackup);
            var nome = NomeArquivo(agora, motivo) + ".gz";
            var destino = Path.Combine(caminhos.PastaBackup, nome);
            var temporario = Path.Combine(caminhos.PastaBackup, $".{Guid.NewGuid():N}.db");
            try
            {
                CopiarOnline(fabrica.StringConexao, temporario);
                PrepararCopia(temporario, agora);
                await CompactarAsync(temporario, destino + ".parcial", ct);
                File.Move(destino + ".parcial", destino, overwrite: true);
            }
            finally
            {
                ApagarSeExiste(temporario);
                ApagarSeExiste(destino + ".parcial");
            }

            await using (var db = fabrica.CreateDbContext())
            {
                await db.IdentidadeTerminal.ExecuteUpdateAsync(s => s.SetProperty(i => i.UltimoBackupEm, agora), ct);
            }

            var sha = Sha256(destino);
            var copia = await CopiarParaSecundariaAsync(destino, ct);
            AplicarRetencao(caminhos.PastaBackup, agora);
            if (copia is not null)
            {
                AplicarRetencao(Path.GetDirectoryName(copia)!, agora);
            }

            return new ResultadoBackup(destino, sha, agora, motivo, copia);
        }
        finally
        {
            Trava.Release();
        }
    }

    /// <summary>Backups da pasta <c>backup/</c> e da secundária (a subpasta deste terminal), do mais novo para o mais antigo.</summary>
    public async Task<IReadOnlyList<ArquivoBackup>> ListarAsync(CancellationToken ct = default)
    {
        var arquivos = Listar(caminhos.PastaBackup).AsEnumerable();
        if (await PastaSecundariaAsync(ct) is { } secundaria)
        {
            arquivos = arquivos.Concat(Listar(secundaria).Select(a => a with { NaSecundaria = true }));
        }

        return [.. arquivos.DistinctBy(a => Path.GetFullPath(a.Caminho)).OrderByDescending(a => a.FeitoEm)];
    }

    /// <summary>Backups de uma pasta (nomes no formato do PDV; o resto é ignorado), do mais novo para o mais antigo.</summary>
    public static IReadOnlyList<ArquivoBackup> Listar(string pasta)
    {
        if (!Directory.Exists(pasta))
        {
            return [];
        }

        var arquivos = new List<ArquivoBackup>();
        foreach (var caminho in Directory.EnumerateFiles(pasta, Prefixo + "*"))
        {
            if (Interpretar(caminho) is { } a)
            {
                arquivos.Add(a);
            }
        }

        return [.. arquivos.OrderByDescending(a => a.FeitoEm)];
    }

    /// <summary>Nome sem extensão: <c>pdv-AAAAMMDD-HHMMSS-fff-motivo.db</c> (o mesmo do backup antes da migração).</summary>
    public static string NomeArquivo(DateTimeOffset feitoEm, string motivo) =>
        $"{Prefixo}{feitoEm.UtcDateTime.ToString(FormatoHora, CultureInfo.InvariantCulture)}-{motivo}.db";

    /// <summary>SHA-256 do arquivo em hexadecimal minúsculo.</summary>
    public static string Sha256(string arquivo)
    {
        using var leitura = File.OpenRead(arquivo);
        return Convert.ToHexStringLower(SHA256.HashData(leitura));
    }

    /// <summary>
    /// Retenção da PDV 32.5 numa pasta: fica tudo de até <see cref="OpcoesBackup.DiasCompletos"/> dias e, até
    /// <see cref="OpcoesBackup.SemanasUmPorSemana"/> semanas, o mais novo de cada semana (contada para trás a partir de
    /// agora); o resto é apagado. Só arquivos com o nome do PDV, e nunca o <see cref="MotivosBackup.AntesRestauracao"/>.
    /// </summary>
    public IReadOnlyList<string> AplicarRetencao(string pasta, DateTimeOffset agora)
    {
        var apagados = new List<string>();
        var completos = agora - TimeSpan.FromDays(Opcoes.DiasCompletos);
        var limite = agora - TimeSpan.FromDays(7 * Opcoes.SemanasUmPorSemana);
        var semanasGuardadas = new HashSet<int>();
        foreach (var a in Listar(pasta))
        {
            if (a.FeitoEm >= completos || a.Motivo == MotivosBackup.AntesRestauracao)
            {
                continue;
            }

            var semana = (int)((agora - a.FeitoEm).TotalDays / 7);
            if (a.FeitoEm >= limite && semanasGuardadas.Add(semana))
            {
                continue;
            }

            try
            {
                File.Delete(a.Caminho);
                apagados.Add(a.Caminho);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // Arquivo preso (antivírus, pendrive saindo): fica para a próxima retenção.
            }
        }

        return apagados;
    }

    /// <summary>
    /// Pasta deste terminal na secundária configurada, se houver: <c>&lt;backup.pasta_secundaria&gt;/&lt;terminal_id&gt;</c>
    /// (os caixas que apontam para a mesma pasta de rede ficam cada um na sua). Sem terminal ativado, nenhuma. Com o banco
    /// ilegível (a restauração automática depois do <c>integrity_check</c> falho) não há como ler a configuração: só a
    /// pasta <c>backup/</c>.
    /// </summary>
    public async Task<string?> PastaSecundariaAsync(CancellationToken ct = default)
    {
        try
        {
            await using var db = fabrica.CreateDbContext();
            var valor = await db.ConfiguracaoTerminal.AsNoTracking()
                .Where(c => c.Chave == ChavePastaSecundaria).Select(c => c.Valor).FirstOrDefaultAsync(ct);
            if (valor is null || JsonSerializer.Deserialize<string?>(valor) is not { Length: > 0 } pasta)
            {
                return null;
            }

            var terminal = await db.IdentidadeTerminal.AsNoTracking().Select(i => (Guid?)i.TerminalId).FirstOrDefaultAsync(ct);
            return terminal is { } id ? Path.Combine(pasta, id.ToString("D")) : null;
        }
        catch (SqliteException)
        {
            return null;
        }
    }

    /// <summary>Copia o banco em uso para <paramref name="destino"/> pela API de backup online do SQLite.</summary>
    internal static void CopiarOnline(string stringConexaoOrigem, string destino)
    {
        using var origem = new SqliteConnection(stringConexaoOrigem);
        origem.Open();
        using var copia = new SqliteConnection(Conexao(destino));
        copia.Open();
        origem.BackupDatabase(copia);
        PermissoesGrupo.LiberarParaOGrupo(destino);
    }

    /// <summary>Conexão sem pool para um arquivo avulso (backup, restauração): fecha de verdade no <c>Dispose</c>.</summary>
    internal static string Conexao(string arquivo, SqliteOpenMode modo = SqliteOpenMode.ReadWriteCreate) =>
        new SqliteConnectionStringBuilder { DataSource = arquivo, Mode = modo, Pooling = false }.ToString();

    /// <summary><c>ultimo_backup_em</c> do próprio arquivo e um arquivo só (sem WAL), antes de compactar.</summary>
    private static void PrepararCopia(string arquivo, DateTimeOffset agora)
    {
        using var conexao = new SqliteConnection(Conexao(arquivo, SqliteOpenMode.ReadWrite));
        conexao.Open();
        using (var cmd = conexao.CreateCommand())
        {
            cmd.CommandText = "UPDATE identidade_terminal SET ultimo_backup_em = $agora;";
            cmd.Parameters.AddWithValue("$agora", DataHoraUtcTexto.Formatar(agora));
            cmd.ExecuteNonQuery();
        }

        using (var cmd = conexao.CreateCommand())
        {
            cmd.CommandText = "PRAGMA journal_mode=DELETE;";
            cmd.ExecuteNonQuery();
        }
    }

    private static async Task CompactarAsync(string origem, string destino, CancellationToken ct)
    {
        await using var entrada = File.OpenRead(origem);
        await using (var saida = File.Create(destino))
        {
            await using var gzip = new GZipStream(saida, CompressionLevel.Optimal);
            await entrada.CopyToAsync(gzip, ct);
        }
    }

    /// <summary>Descompacta (ou copia, se o backup não for <c>.gz</c>) para <paramref name="destino"/>.</summary>
    internal static async Task ExtrairAsync(string arquivo, string destino, CancellationToken ct)
    {
        await using var entrada = File.OpenRead(arquivo);
        await using var saida = File.Create(destino);
        if (arquivo.EndsWith(".gz", StringComparison.OrdinalIgnoreCase))
        {
            await using var gzip = new GZipStream(entrada, CompressionMode.Decompress);
            await gzip.CopyToAsync(saida, ct);
        }
        else
        {
            await entrada.CopyToAsync(saida, ct);
        }
    }

    private async Task<string?> CopiarParaSecundariaAsync(string arquivo, CancellationToken ct)
    {
        string? pasta = null;
        try
        {
            pasta = await PastaSecundariaAsync(ct);
            if (pasta is null)
            {
                return null;
            }

            Directory.CreateDirectory(pasta);
            var destino = Path.Combine(pasta, Path.GetFileName(arquivo));
            File.Copy(arquivo, destino + ".parcial", overwrite: true);
            File.Move(destino + ".parcial", destino, overwrite: true);
            return destino;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or ArgumentException or NotSupportedException)
        {
            // Pendrive fora, rede sem acesso: o backup principal está feito; a cópia sai no próximo.
            await RegistrarCopiaFalhouAsync(NiveisOcorrencia.Aviso, $"Backup: a cópia para a pasta secundária {pasta} falhou ({e.Message}).", ct);
            return null;
        }
    }

    private async Task RegistrarCopiaFalhouAsync(string nivel, string mensagem, CancellationToken ct)
    {
        await using var db = fabrica.CreateDbContext();
        db.LogLocal.Add(Ocorrencias.Nova(relogio.Agora, nivel, CodigoOcorrencia.BackupCopiaFalhou, mensagem));
        await db.SaveChangesAsync(ct);
    }

    private static ArquivoBackup? Interpretar(string caminho)
    {
        var nome = Path.GetFileName(caminho);
        var semGz = nome.EndsWith(".gz", StringComparison.OrdinalIgnoreCase) ? nome[..^3] : nome;
        if (!semGz.EndsWith(".db", StringComparison.OrdinalIgnoreCase) || semGz.Length < Prefixo.Length + FormatoHora.Length + 5)
        {
            return null;
        }

        var hora = semGz.Substring(Prefixo.Length, FormatoHora.Length);
        if (!DateTime.TryParseExact(hora, FormatoHora, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var feito))
        {
            return null;
        }

        var motivo = semGz[(Prefixo.Length + FormatoHora.Length + 1)..^3];
        return new ArquivoBackup(caminho, new DateTimeOffset(feito, TimeSpan.Zero), motivo, new FileInfo(caminho).Length);
    }

    internal static void ApagarSeExiste(string arquivo)
    {
        try
        {
            if (File.Exists(arquivo))
            {
                File.Delete(arquivo);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Temporário preso: some na próxima retenção (não tem o nome do PDV) ou no próximo backup.
        }
    }
}
