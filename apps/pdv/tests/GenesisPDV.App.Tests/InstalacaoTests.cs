using System.Reflection;
using System.Reflection.Emit;
using System.Text.Json;
using System.Xml.Linq;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.App.Views;
using GenesisPDV.Data;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Sync.Ativacao;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Tests;
using GenesisPDV.Sync.Token;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Implantação I3 (README do PDV › decisão 62): o que o build grava no executável (URL padrão da API, versão única,
/// demonstração só nos builds de desenvolvimento, e a tela do executável publicado sem ela), a trava de um PDV por
/// computador que o instalador procura, o aviso de versão abaixo da mínima, o caixa aberto por outra conta do sistema,
/// a versão antiga por cima da nova e a falha na abertura. O instalador em si (Inno Setup) é provado no CI Windows.
/// </summary>
public class InstalacaoTests
{
    [Fact]
    public void Url_padrao_vem_do_AssemblyMetadata_do_build_e_a_variavel_sobrepoe()
    {
        // O build de teste não passa GenesisUrlApiPadrao: vale a do produto, gravada pelo csproj.
        Assert.Equal(ConfiguracaoBuild.UrlApiProduto, ConfiguracaoBuild.Ler(typeof(ConfiguracaoBuild).Assembly, ConfiguracaoBuild.ChaveUrlApiPadrao));
        Assert.Equal(ConfiguracaoBuild.UrlApiProduto, ConfiguracaoBuild.UrlApiPadrao);

        // O build do piloto (-p:GenesisUrlApiPadrao=...) vira um AssemblyMetadata com a URL dele.
        Assert.Equal("https://api.grupoicebeer.com.br", ConfiguracaoBuild.Ler(AssemblyCom("https://api.grupoicebeer.com.br "), ConfiguracaoBuild.ChaveUrlApiPadrao));
        Assert.Null(ConfiguracaoBuild.Ler(AssemblyCom(string.Empty), ConfiguracaoBuild.ChaveUrlApiPadrao));
        Assert.Null(ConfiguracaoBuild.Ler(typeof(InstalacaoTests).Assembly, ConfiguracaoBuild.ChaveUrlApiPadrao));

        // GENESISPDV_API continua sobrepondo; vazia, vale a do build.
        Assert.Equal("http://localhost:3000", ConfiguracaoBuild.UrlApiInicial(" http://localhost:3000 "));
        Assert.Equal(ConfiguracaoBuild.UrlApiPadrao, ConfiguracaoBuild.UrlApiInicial(null));
        Assert.Equal(ConfiguracaoBuild.UrlApiPadrao, ConfiguracaoBuild.UrlApiInicial("  "));
    }

    [Fact]
    public void Versao_do_app_e_a_do_Directory_Build_props_e_o_info_build_grava_o_que_o_ci_confere()
    {
        var props = XDocument.Load(Path.Combine(PastaPdv(), "Directory.Build.props"));
        var versao = props.Descendants("Version").Single().Value;
        Assert.Equal(versao, VersaoApp.Atual);

        var arquivo = Path.Combine(Path.GetTempPath(), $"genesispdv-info-{Guid.NewGuid():N}.json");
        try
        {
            ConfiguracaoBuild.GravarInfo(arquivo);
            using var json = JsonDocument.Parse(File.ReadAllText(arquivo));
            Assert.Equal(versao, json.RootElement.GetProperty("versao").GetString());
            Assert.Equal(ConfiguracaoBuild.UrlApiProduto, json.RootElement.GetProperty("url_api_padrao").GetString());
            // dotnet build/test é de desenvolvimento: a demonstração existe aqui e nunca no dotnet publish (o CI confere).
            Assert.True(json.RootElement.GetProperty("modo_demonstracao").GetBoolean());
        }
        finally
        {
            File.Delete(arquivo);
        }
    }

    [Fact]
    public void Comparacao_de_versoes_e_a_mesma_da_api()
    {
        // Os casos de apps/api/src/sync/versoes-app.spec.ts.
        string[] lista = ["1.10.0", "1.2.0", "1.4.2", "1.4.2-beta.1", "0.9.9", "1.4.10"];
        Assert.Equal(["0.9.9", "1.2.0", "1.4.2-beta.1", "1.4.2", "1.4.10", "1.10.0"], lista.Order(Comparer<string>.Create(VersaoApp.Comparar)));
        Assert.Equal(0, VersaoApp.Comparar("1.4.2", "1.4.2"));
        Assert.Equal(0, VersaoApp.Comparar("1.4.2", "1.4.2+abc"));

        Assert.True(VersaoApp.AbaixoDe("1.0.0", "0.9.0"));
        Assert.False(VersaoApp.AbaixoDe("0.9.0", "0.9.0"));
        Assert.False(VersaoApp.AbaixoDe("0.9.0-beta.1", "0.9.0"));
        Assert.False(VersaoApp.AbaixoDe(null, "0.9.0"));
        Assert.False(VersaoApp.AbaixoDe(" ", "0.9.0"));
    }

    [Fact]
    public async Task Um_pdv_por_computador_o_segundo_nao_abre_e_o_reinicio_espera_o_anterior_sair()
    {
        // O mutex é da thread que o pegou (a principal do app) e reentrante nela: cada "PDV" é uma thread própria, nunca
        // uma do pool (que poderia ser a mesma do primeiro).
        var nome = $@"Global\GenesisPDV.Teste.{Guid.NewGuid():N}";
        using var soltar = new ManualResetEventSlim();
        var adquirido = new TaskCompletionSource<(bool PodeAbrir, string? Falha)>(TaskCreationOptions.RunContinuationsAsynchronously);
        var primeiro = new Thread(() =>
        {
            using var instancia = InstanciaUnica.Adquirir(nome, TimeSpan.Zero);
            adquirido.SetResult((instancia.PodeAbrir, instancia.FalhaTrava));
            soltar.Wait();
        })
        { IsBackground = true };
        primeiro.Start();
        Assert.Equal((true, (string?)null), await adquirido.Task.WaitAsync(TimeSpan.FromSeconds(30), Ct));

        Assert.False(await EmThreadPropria(() => InstanciaUnica.Adquirir(nome, TimeSpan.Zero)).WaitAsync(TimeSpan.FromSeconds(30), Ct));

        // O processo do reinício espera: o anterior solta a trava (sai) e ele abre.
        var reinicio = EmThreadPropria(() => InstanciaUnica.Adquirir(nome, TimeSpan.FromSeconds(30)));
        await Task.Delay(200, Ct);
        Assert.False(reinicio.IsCompleted);
        soltar.Set();
        Assert.True(await reinicio.WaitAsync(TimeSpan.FromSeconds(30), Ct));
        primeiro.Join();
    }

    /// <summary>Tenta a trava numa thread nova e solta nela mesma; devolve se pôde abrir.</summary>
    private static Task<bool> EmThreadPropria(Func<InstanciaUnica> adquirir)
    {
        var resultado = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        new Thread(() =>
        {
            try
            {
                using var instancia = adquirir();
                resultado.SetResult(instancia.PodeAbrir);
            }
            catch (Exception e)
            {
                resultado.SetException(e);
            }
        })
        { IsBackground = true }.Start();
        return resultado.Task;
    }

    [AvaloniaFact]
    public async Task Build_de_desenvolvimento_tem_o_F8_e_o_login_avisa_a_versao_abaixo_da_minima_com_o_instalador()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var ativacao = Assert.IsType<AtivacaoViewModel>(pdv.Shell.PaginaAtual);
        Assert.True(ativacao.MostraDemonstracao);
        Assert.True(pdv.Controle<Avalonia.Controls.Button>("BotaoDemonstracao").IsVisible);
        Assert.Contains("F8 modo demonstração", ativacao.Rodape, StringComparison.Ordinal);
        Assert.Equal(ConfiguracaoBuild.UrlApiInicial(Environment.GetEnvironmentVariable(AtivacaoViewModel.VariavelUrlApi)), ativacao.UrlServidor);

        // A nuvem publicou uma mínima acima desta versão (handshake/heartbeat gravam em estado_conexao).
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            if (await db.EstadoConexao.AnyAsync(Ct))
            {
                await db.EstadoConexao.ExecuteUpdateAsync(s => s.SetProperty(c => c.VersaoMinimaApp, "99.0.0"), Ct);
            }
            else
            {
                db.EstadoConexao.Add(new EstadoConexao { VersaoMinimaApp = "99.0.0" });
                await db.SaveChangesAsync(Ct);
            }
        }

        await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is AtivacaoView, "foco no assistente");
        pdv.Tecla(Key.F8);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel { AvisoVersao: not null }, "aviso de versão no login");
        var aviso = pdv.Texto("TextoAvisoVersao");
        Assert.Contains($"A nuvem pede o GenesisPDV 99.0.0 (este é o {VersaoApp.Atual})", aviso, StringComparison.Ordinal);
        Assert.Contains("pelo instalador (GenesisPDV-Setup-99.0.0.exe), por cima deste", aviso, StringComparison.Ordinal);
        Assert.True(pdv.Controle<Avalonia.Controls.TextBlock>("TextoAvisoVersao").IsVisible);
        pdv.Captura("62-login-versao-minima");

        // Só avisa: o login continua.
        var venda = await pdv.LogarAsync();
        Assert.NotNull(venda);
    }

    [AvaloniaFact]
    public async Task Assistente_do_executavel_publicado_nao_tem_F8_nem_botao_nem_dica_de_demonstracao()
    {
        // O ramo do dotnet publish (ModoDemonstracao=false), que o --info-build do CI só confere pela constante: a tela.
        using var pdv = await AmbienteUi.IniciarAsync();
        var ativacao = new AtivacaoViewModel(pdv.Shell, permiteDemonstracao: false);
        pdv.Shell.PaginaAtual = ativacao;
        await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is AtivacaoView, "foco no assistente");
        foreach (var passo in new[] { AtivacaoViewModel.PassoBoasVindas, AtivacaoViewModel.PassoConexao, AtivacaoViewModel.PassoCodigo })
        {
            ativacao.Passo = passo;
            Avalonia.Threading.Dispatcher.UIThread.RunJobs();
            Assert.False(ativacao.MostraDemonstracao);
            Assert.False(pdv.Controle<Avalonia.Controls.Button>("BotaoDemonstracao").IsVisible);
            Assert.DoesNotContain("F8", ativacao.Rodape, StringComparison.Ordinal);
            pdv.Tecla(Key.F8);
            Avalonia.Threading.Dispatcher.UIThread.RunJobs();
            Assert.Same(ativacao, pdv.Shell.PaginaAtual);
        }

        Assert.Null(await pdv.Servicos.GetRequiredService<Data.Repositorios.RepositorioTerminal>().ObterIdentidadeAsync(Ct));
    }

    [AvaloniaFact]
    public async Task Caixa_aberto_por_outra_conta_do_sistema_explica_qual_conta_usar_em_vez_de_travar()
    {
        // I3: o banco é da máquina e o PDV abre para quem entrar (Run em HKLM), mas o token está na DPAPI da conta que
        // ativou. Antes, a CryptographicException escapava do IniciarAsync e a janela ficava vazia.
        var api = new ApiFalsa();
        api.PublicarLojaECaixa();
        var raiz = AmbienteUi.NovaRaiz();
        using (var primeiro = await AmbienteUi.IniciarAsync(raiz, apagar: false, ajustar: ComApiFalsa(api)))
        {
            Assert.True((await primeiro.Servicos.GetRequiredService<ServicoAtivacao>()
                .AtivarAsync(new Uri("https://api.exemplo/"), "100001", "K7QM-2XRD", Ct)).Ativado);
        }

        var estados = api.Contar("/sync/estado");
        using var outraConta = await AmbienteUi.IniciarAsync(raiz, ajustar: s =>
        {
            ComApiFalsa(api)(s);
            s.AddSingleton<IProtetorSegredos>(new ProtetorDeOutraConta());
        });
        await outraConta.EsperarAsync(() => outraConta.Shell.PaginaAtual is TerminalBloqueadoViewModel, "tela de outra conta");
        Assert.Equal(TerminalBloqueadoViewModel.TituloContaDiferente, outraConta.Texto("TituloBloqueio"));
        var texto = outraConta.Texto("TextoBloqueio");
        Assert.Contains($"\"{ContaSistema.Atual()}\"", texto, StringComparison.Ordinal);
        Assert.Contains("Alt+F4", texto, StringComparison.Ordinal);
        Assert.False(((TerminalBloqueadoViewModel)outraConta.Shell.PaginaAtual!).PodeTentarDeNovo);
        Assert.False(outraConta.Servicos.GetRequiredService<ServicoSincronizacaoHttp>().Rodando);
        Assert.Equal(estados, api.Contar("/sync/estado"));
        outraConta.Captura("62-caixa-de-outra-conta");
    }

    [AvaloniaFact]
    public async Task Versao_antiga_instalada_por_cima_da_nova_nao_abre_o_banco_migrado()
    {
        var raiz = AmbienteUi.NovaRaiz();
        using (var primeiro = await AmbienteUi.IniciarAsync(raiz, apagar: false))
        {
            await using var db = primeiro.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
            await db.Database.ExecuteSqlRawAsync(
                "insert into __ef_migracoes (MigrationId, ProductVersion) values ('29991231235959_VersaoFutura', '10.0.0')", Ct);
        }

        using var antigo = await AmbienteUi.IniciarAsync(raiz);
        var erro = Assert.IsType<ErroFatalViewModel>(antigo.Shell.PaginaAtual);
        Assert.Equal("Este caixa já usa uma versão mais nova do GenesisPDV", erro.Titulo);
        Assert.Contains("Nada foi alterado", erro.Mensagem, StringComparison.Ordinal);
        Assert.Null(await antigo.Servicos.GetRequiredService<ServicoBackup>().EncerrarAsync());
    }

    [AvaloniaFact]
    public async Task Falha_inesperada_na_abertura_vira_tela_de_erro_e_nunca_a_janela_vazia()
    {
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<ServicoTema>(_ => throw new InvalidOperationException("tema quebrado")));
        var erro = Assert.IsType<ErroFatalViewModel>(pdv.Shell.PaginaAtual);
        Assert.Equal("O caixa não conseguiu abrir", erro.Titulo);
        Assert.Contains("tema quebrado", erro.Mensagem, StringComparison.Ordinal);
        Assert.Contains(pdv.Caminhos.PastaLogs, erro.Mensagem, StringComparison.Ordinal);
        Assert.False(pdv.Shell.Iniciando);
    }

    /// <summary>A DPAPI de outra conta do Windows: protege, mas nada do que outra conta protegeu abre.</summary>
    private sealed class ProtetorDeOutraConta : IProtetorSegredos
    {
        public string Esquema => "outra-conta";

        public byte[] Proteger(ReadOnlySpan<byte> dados, string finalidade) => dados.ToArray();

        public byte[] Desproteger(ReadOnlySpan<byte> protegido, string finalidade) =>
            throw new System.Security.Cryptography.CryptographicException("Chave inválida para uso no estado especificado.");
    }

    private static Action<IServiceCollection> ComApiFalsa(ApiFalsa api) => servicos =>
        servicos.AddSingleton<IClienteSync>(sp => new ClienteSyncHttp(
            new HttpClient(api),
            sp.GetRequiredService<MaquinaLocal>().ParaCliente(),
            sp.GetRequiredService<IRelogio>(),
            sp.GetRequiredService<IFonteToken>(),
            () => new Uri("https://api.exemplo/")));

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static Assembly AssemblyCom(string url)
    {
        var construtor = typeof(AssemblyMetadataAttribute).GetConstructor([typeof(string), typeof(string)])!;
        return AssemblyBuilder.DefineDynamicAssembly(new AssemblyName($"Teste{Guid.NewGuid():N}"), AssemblyBuilderAccess.Run,
            [new CustomAttributeBuilder(construtor, [ConfiguracaoBuild.ChaveUrlApiPadrao, url])]);
    }

    /// <summary><c>apps/pdv</c>, subindo a partir da saída do teste até achar o <c>GenesisPDV.slnx</c>.</summary>
    private static string PastaPdv()
    {
        for (var pasta = new DirectoryInfo(AppContext.BaseDirectory); pasta is not null; pasta = pasta.Parent)
        {
            if (File.Exists(Path.Combine(pasta.FullName, "GenesisPDV.slnx")))
            {
                return pasta.FullName;
            }
        }

        throw new InvalidOperationException("apps/pdv não encontrado acima da saída do teste.");
    }
}
