using Microsoft.EntityFrameworkCore;
using Microsoft.Data.Sqlite;

namespace GenesisPDV.Data.Tests;

public class InicializacaoTests
{
    private static readonly string[] TabelasEsperadas =
    [
        "identidade_terminal", "configuracao_terminal", "estado_sincronizacao", "estado_conexao", "eventos_saida",
        "sequencias_locais", "estado_operacao", "fila_impressao", "log_local", "log_auditoria_local",
        "vendas", "itens_venda", "pagamentos_venda", "parcelas_venda",
    ];

    [Fact]
    public async Task Cria_pdv_db_com_as_tabelas_do_modelo_e_linhas_unicas()
    {
        using var banco = new BancoTemporario();
        var resultado = await banco.InicializarAsync();
        Assert.True(resultado.BancoNovo);
        Assert.Equal(MigracoesDoModelo(banco), resultado.MigracoesAplicadas);
        Assert.Null(resultado.ArquivoBackup);
        Assert.True(File.Exists(banco.Caminhos.ArquivoBanco));
        foreach (var tabela in TabelasEsperadas)
        {
            Assert.Equal(1L, banco.Escalar($"select count(*) from sqlite_master where type='table' and name='{tabela}'"));
        }

        Assert.Equal(1L, banco.Escalar("select count(*) from estado_conexao"));
        Assert.Equal(1L, banco.Escalar("select count(*) from estado_operacao"));
    }

    [Fact]
    public async Task Pragmas_wal_synchronous_full_e_foreign_keys()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        await using var db = banco.Fabrica.CreateDbContext();
        var conexao = db.Database.GetDbConnection();
        await db.Database.OpenConnectionAsync(TestContext.Current.CancellationToken);
        Assert.Equal("wal", Pragma(conexao, "journal_mode"));
        Assert.Equal("2", Pragma(conexao, "synchronous"));
        Assert.Equal("1", Pragma(conexao, "foreign_keys"));
    }

    [Fact]
    public async Task Backup_antes_de_aplicar_migracao_em_banco_existente()
    {
        using var banco = new BancoTemporario();
        using (var conexao = new SqliteConnection($"Data Source={banco.Caminhos.ArquivoBanco};Pooling=False"))
        {
            conexao.Open();
            using var cmd = conexao.CreateCommand();
            cmd.CommandText = "create table dado_antigo (x integer); insert into dado_antigo values (42);";
            cmd.ExecuteNonQuery();
        }

        var resultado = await banco.InicializarAsync();
        Assert.False(resultado.BancoNovo);
        Assert.NotNull(resultado.ArquivoBackup);
        Assert.StartsWith(banco.Caminhos.PastaBackup, resultado.ArquivoBackup);
        using var copia = new SqliteConnection($"Data Source={resultado.ArquivoBackup};Mode=ReadOnly;Pooling=False");
        copia.Open();
        using var consulta = copia.CreateCommand();
        consulta.CommandText = "select x from dado_antigo";
        Assert.Equal(42L, consulta.ExecuteScalar());
        consulta.CommandText = "select count(*) from sqlite_master where name='vendas'";
        Assert.Equal(0L, consulta.ExecuteScalar());
    }

    [Fact]
    public async Task Banco_migrado_por_versao_mais_nova_nao_abre_e_fica_como_estava()
    {
        // I3: o GenesisPDV-Setup antigo instalado por cima do novo. O MigrateAsync ignoraria a migração desconhecida e o
        // app antigo gravaria num esquema que não conhece; agora a abertura recusa sem tocar no banco nem no marcador.
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        const string Futura = "29991231235959_VersaoFutura";
        using (var conexao = banco.AbrirConexao())
        {
            using var cmd = conexao.CreateCommand();
            cmd.CommandText = $"insert into __ef_migracoes (MigrationId, ProductVersion) values ('{Futura}', '10.0.0'); " +
                              "create table tabela_futura (x integer not null);";
            cmd.ExecuteNonQuery();
        }

        var marcador = Path.Combine(banco.Caminhos.PastaDados, "encerramento.json");
        await File.WriteAllTextAsync(marcador, "{}", TestContext.Current.CancellationToken);
        var aplicadas = banco.Escalar("select count(*) from __ef_migracoes");
        var erro = await Assert.ThrowsAsync<BancoDeVersaoMaisNovaException>(() =>
            InicializadorBanco.InicializarAsync(banco.Fabrica, banco.Caminhos.PastaBackup, banco.Relogio.Agora,
                TestContext.Current.CancellationToken, pastaMarcadorEncerramento: banco.Caminhos.PastaDados));
        Assert.Equal([Futura], erro.MigracoesDesconhecidas);
        Assert.Equal(aplicadas, banco.Escalar("select count(*) from __ef_migracoes"));
        Assert.True(File.Exists(marcador));
        Assert.Empty(Directory.GetFiles(banco.Caminhos.PastaBackup));
    }

    [Fact]
    public async Task Linux_na_pasta_do_grupo_o_banco_e_o_backup_saem_com_escrita_do_grupo()
    {
        // .deb (I3): /var/lib/genesispdv é 2770 root:genesispdv e outra conta do grupo abre o mesmo banco. O SQLite cria
        // com 0644 qualquer que seja a umask; sem o g+rw a segunda conta cai em "attempt to write a readonly database".
        if (OperatingSystem.IsWindows())
        {
            Assert.Skip("Permissões Unix: no Windows a ACL herdada de %ProgramData%\\GenesisPDV dá MODIFICAR a Usuários.");
            return;
        }

        const UnixFileMode Grupo = UnixFileMode.GroupRead | UnixFileMode.GroupWrite;
        using var compartilhada = new BancoTemporario();
        const UnixFileMode Pasta2770 = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead
                                       | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute | UnixFileMode.SetGroup;
        File.SetUnixFileMode(compartilhada.Caminhos.PastaDados, Pasta2770);
        File.SetUnixFileMode(compartilhada.Caminhos.PastaBackup, Pasta2770);
        await compartilhada.InicializarAsync();
        Assert.Equal(Grupo, File.GetUnixFileMode(compartilhada.Caminhos.ArquivoBanco) & Grupo);
        foreach (var lateral in new[] { "-wal", "-shm" }.Select(s => compartilhada.Caminhos.ArquivoBanco + s).Where(File.Exists))
        {
            Assert.Equal(Grupo, File.GetUnixFileMode(lateral) & Grupo);
        }

        var backup = InicializadorBanco.FazerBackup(compartilhada.Fabrica, compartilhada.Caminhos.PastaBackup, compartilhada.Relogio.Agora, "teste");
        Assert.Equal(Grupo, File.GetUnixFileMode(backup) & Grupo);
        Assert.Equal(UnixFileMode.None, File.GetUnixFileMode(compartilhada.Caminhos.ArquivoBanco) & (UnixFileMode.OtherWrite | UnixFileMode.OtherExecute));

        // Na pasta do usuário (sem escrita do grupo) nada muda.
        using var pessoal = new BancoTemporario();
        File.SetUnixFileMode(pessoal.Caminhos.PastaDados, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        await pessoal.InicializarAsync();
        Assert.Equal(UnixFileMode.None, File.GetUnixFileMode(pessoal.Caminhos.ArquivoBanco) & UnixFileMode.GroupWrite);
    }

    [Fact]
    public async Task Sem_migracao_pendente_nao_faz_backup()
    {
        using var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var segunda = await banco.InicializarAsync();
        Assert.False(segunda.BancoNovo);
        Assert.Empty(segunda.MigracoesAplicadas);
        Assert.Null(segunda.ArquivoBackup);
        Assert.Empty(Directory.GetFiles(banco.Caminhos.PastaBackup));
    }

    [Fact]
    public async Task Banco_corrompido_bloqueia_a_inicializacao()
    {
        using var banco = new BancoTemporario();
        await File.WriteAllBytesAsync(banco.Caminhos.ArquivoBanco, Enumerable.Repeat((byte)0x5A, 8192).ToArray(), TestContext.Current.CancellationToken);
        await Assert.ThrowsAsync<BancoCorrompidoException>(banco.InicializarAsync);
    }

    [Fact]
    public void Nomes_em_snake_case()
    {
        Assert.Equal("payload_sha256", PdvDbContext.ParaSnakeCase("PayloadSha256"));
        Assert.Equal("cpf_cnpj_nota", PdvDbContext.ParaSnakeCase("CpfCnpjNota"));
        Assert.Equal("v_ibs", PdvDbContext.ParaSnakeCase("VIbs"));
        Assert.Equal("id", PdvDbContext.ParaSnakeCase("Id"));
    }

    private static string? Pragma(System.Data.Common.DbConnection conexao, string nome)
    {
        using var cmd = conexao.CreateCommand();
        cmd.CommandText = $"PRAGMA {nome};";
        return cmd.ExecuteScalar()?.ToString();
    }

    private static List<string> MigracoesDoModelo(BancoTemporario banco)
    {
        using var db = banco.Fabrica.CreateDbContext();
        return [.. db.Database.GetMigrations()];
    }
}
