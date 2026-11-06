using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using GenesisPDV.Hardware.Gaveta;
using GenesisPDV.Hardware.Impressora;
using Microsoft.Extensions.DependencyInjection;
using GenesisPDV.App.Views;
using GenesisPDV.Sync.Ativacao;
using GenesisPDV.Sync.Pull;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Tests;
using GenesisPDV.Sync.Token;

namespace GenesisPDV.App.Tests;

public class TelasTests
{
    [AvaloniaFact]
    public async Task App_inicia_cria_o_banco_e_mostra_o_assistente_de_ativacao()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var vm = Assert.IsType<AtivacaoViewModel>(pdv.Shell.PaginaAtual);
        Assert.True(File.Exists(pdv.Caminhos.ArquivoBanco));
        Assert.Equal("Ativar este caixa", pdv.Texto("TituloAtivacao"));
        Assert.Equal("Passo 1 de 6 · Boas-vindas", pdv.Texto("TextoPasso"));
        Assert.Contains(vm.Requisitos, r => r.Nome == "Memória");
        await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is AtivacaoView, "foco no assistente");
        pdv.Captura("01-ativacao");
    }

    [AvaloniaFact]
    public async Task Assistente_valida_o_endereco_e_o_formato_dos_codigos_pelo_teclado()
    {
        var api = new ApiFalsa();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: ComApiFalsa(api));
        var vm = Assert.IsType<AtivacaoViewModel>(pdv.Shell.PaginaAtual);
        await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is AtivacaoView, "foco no assistente");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoUrl");
        Assert.Equal(AtivacaoViewModel.PassoConexao, vm.Passo);
        pdv.Digitar("http://api.exemplo");
        pdv.Tecla(Key.Enter);
        Assert.Contains("HTTPS", vm.ErroUrl, StringComparison.Ordinal);
        Assert.Empty(api.Envios);
        vm.UrlServidor = "https://api.exemplo";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoCodigoEmpresa");
        Assert.Equal("Passo 3 de 6 · Código", pdv.Texto("TextoPasso"));
        Assert.Equal("/saude", api.Envios.Single().Rota);

        pdv.Digitar("12345");
        pdv.Tecla(Key.Tab);
        pdv.Digitar("abc0-1234");
        pdv.Tecla(Key.Enter);
        await AmbienteUi.Pausa();
        Assert.NotNull(vm.ErroCodigoEmpresa);
        Assert.Contains("0", vm.ErroCodigoAtivacao, StringComparison.Ordinal);
        Assert.Single(api.Envios);
        pdv.Captura("02-ativacao-erros");

        // Esc limpa; com os campos vazios, Esc volta ao passo da conexão.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("CampoCodigoEmpresa");
        Assert.Equal(string.Empty, vm.CodigoEmpresa);
        pdv.Digitar("100001");
        pdv.Tecla(Key.Tab);
        pdv.Digitar("k7m2q9xz");
        await AmbienteUi.Pausa();
        Assert.Equal("K7M2-Q9XZ", vm.CodigoAtivacao);
        Assert.Equal("K7M2-Q9XZ", pdv.Controle<TextBox>("CampoCodigoAtivacao").Text);
        pdv.Tecla(Key.Escape);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("CampoUrl");
        Assert.Equal(AtivacaoViewModel.PassoConexao, vm.Passo);
    }

    [AvaloniaFact]
    public async Task Assistente_ativa_contra_a_api_mostra_cada_recusa_e_confirma_loja_e_caixa()
    {
        var api = new ApiFalsa();
        api.Saudes.Enqueue(() => throw new HttpRequestException("sem rede"));
        api.Ativacoes.Enqueue(_ => ApiFalsa.Erro(System.Net.HttpStatusCode.UnprocessableEntity, "CODIGO_EXPIRADO"));
        api.Ativacoes.Enqueue(_ => ApiFalsa.Erro(System.Net.HttpStatusCode.UnprocessableEntity, "CAIXA_OCUPADO"));
        // A "nuvem" que a carga inicial baixa: loja (nome do cabeçalho), caixa e um operador com o PIN gerado pela API.
        var (pin, hash) = PinDaApi();
        api.PublicarLojaECaixa("Loja 1 - Hermes (espelho)");
        api.PublicarUsuario("maria", 1, hash);
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: ComApiFalsa(api));
        var vm = Assert.IsType<AtivacaoViewModel>(pdv.Shell.PaginaAtual);
        var terminal = pdv.Servicos.GetRequiredService<RepositorioTerminal>();
        vm.UrlServidor = "https://api.exemplo";
        await pdv.EsperarAsync(() => pdv.Janela.FocusManager?.GetFocusedElement() is AtivacaoView, "foco no assistente");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoUrl");

        // Sem internet: mensagem da PDV 5.3 e Enter tenta de novo.
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => !vm.Ocupado && vm.Mensagem is not null);
        Assert.StartsWith(AtivacaoViewModel.MensagemSemInternet, pdv.Texto("TextoMensagem"), StringComparison.Ordinal);
        Assert.Equal(AtivacaoViewModel.PassoConexao, vm.Passo);
        pdv.Captura("02b-ativacao-sem-internet");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoCodigoEmpresa");

        pdv.Digitar("100001");
        pdv.Tecla(Key.Tab);
        pdv.Digitar("K7QM2XRD");
        await AmbienteUi.Pausa();
        foreach (var esperada in new[] { MensagensAtivacao.CodigoExpirado, MensagensAtivacao.CaixaOcupado })
        {
            pdv.Tecla(Key.Enter);
            await pdv.EsperarAsync(() => !vm.Ocupado && vm.Mensagem == esperada, esperada);
            Assert.Equal(esperada, pdv.Texto("TextoMensagem"));
            Assert.Null(await terminal.ObterIdentidadeAsync(TestContext.Current.CancellationToken));
        }

        pdv.Captura("02c-ativacao-recusada");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => vm.Passo == AtivacaoViewModel.PassoConfirmacao, "confirmação");
        Assert.Equal("ICE BEER COMÉRCIO DE BEBIDAS LTDA (código 100001)", pdv.Texto("TextoEmpresa"));
        Assert.Equal("1 - Loja 1 - Ice Beer Hermes", pdv.Texto("TextoLoja"));
        Assert.Equal("00.000.000/0001-00", pdv.Texto("TextoCnpj"));
        Assert.Equal("Caixa 02", pdv.Texto("TextoCaixa"));
        pdv.Captura("02d-ativacao-confirmacao");

        // As três tentativas foram a mesma requisição (id e chaves); o token só existe protegido no banco.
        var ativacoes = api.Envios.Where(e => e.Rota == "/sync/ativar").ToList();
        Assert.Equal(3, ativacoes.Count);
        Assert.Single(ativacoes.Select(e => e.Corpo).Distinct());
        var identidade = (await terminal.ObterIdentidadeAsync(TestContext.Current.CancellationToken))!;
        Assert.False(identidade.Demonstracao);
        Assert.Equal("https://api.exemplo/", identidade.UrlApi);
        var segredo = System.Text.Encoding.UTF8.GetBytes(api.TokensEmitidos.Single().Split('.')[1]);
        Assert.All(new[] { pdv.Caminhos.ArquivoBanco, pdv.Caminhos.ArquivoBanco + "-wal" }.Where(File.Exists),
            arquivo => Assert.Equal(-1, LerCompartilhado(arquivo).AsSpan().IndexOf(segredo)));

        // Passo 5: carga inicial dos 7 fluxos; com os bloqueantes concluídos, Enter vai para o login.
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is CargaInicialViewModel { Concluida: true }, "carga concluída");
        var carga = (CargaInicialViewModel)pdv.Shell.PaginaAtual!;
        Assert.True(carga.LoginLiberado);
        Assert.All(carga.Fluxos, f => Assert.True(f.Concluido, f.Fluxo));
        await AmbienteUi.Pausa();
        pdv.Captura("02e-carga-inicial");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel);
        Assert.Contains("Loja 1 - Hermes (espelho)", ((LoginViewModel)pdv.Shell.PaginaAtual!).Cabecalho, StringComparison.Ordinal);

        // Login offline com o PIN que desceu (argon2id do node-argon2 verificado pelo libsodium).
        var venda = await pdv.LogarAsync("maria", pin);
        Assert.Equal("MARIA", pdv.Servicos.GetRequiredService<SessaoTerminal>().Operador!.Nome);
        Assert.NotNull(venda);
    }

    /// <summary>PIN de 6 dígitos e o hash gerado pela API (packages/shared/testes/sync/argon2.vetores.json).</summary>
    private static (string Pin, string Hash) PinDaApi()
    {
        var caso = System.Text.Json.Nodes.JsonNode.Parse(ApiFalsa.Fixture("argon2.vetores.json"))!["casos"]!.AsArray()
            .First(c => c!["valido"]!.GetValue<bool>())!;
        return (caso["senha"]!.GetValue<string>(), caso["hash"]!.GetValue<string>());
    }

    [AvaloniaFact]
    public async Task Terminal_real_reaberto_com_carga_interrompida_retoma_antes_do_login_e_pin_errado_e_recusado()
    {
        var api = new ApiFalsa();
        var (pin, hash) = PinDaApi();
        api.PublicarLojaECaixa();
        api.PublicarUsuario("maria", 1, hash);
        var raiz = AmbienteUi.NovaRaiz();
        api.AoPuxar = e => e.Consulta.Contains("fluxo=acesso", StringComparison.Ordinal) ? throw new HttpRequestException("rede caiu") : null;
        using (var primeiro = await AmbienteUi.IniciarAsync(raiz, apagar: false, ajustar: ComApiFalsa(api)))
        {
            Assert.True((await primeiro.Servicos.GetRequiredService<ServicoAtivacao>()
                .AtivarAsync(new Uri("https://api.exemplo/"), "100001", "K7QM-2XRD", TestContext.Current.CancellationToken)).Ativado);
            await primeiro.Shell.IrParaCargaInicialAsync();
            var carga = Assert.IsType<CargaInicialViewModel>(primeiro.Shell.PaginaAtual);
            Assert.False(carga.LoginLiberado);
            Assert.NotNull(carga.Erro);
            // O progresso chega pela fila da tela (Progress<T>).
            await primeiro.EsperarAsync(() => carga.Fluxos[0].Concluido, "configuração concluída");
        }

        // Reaberto com a rede de volta: a abertura vai para a carga (retoma do acesso), não para o login.
        api.AoPuxar = null;
        using var pdv = await AmbienteUi.IniciarAsync(raiz, ajustar: ComApiFalsa(api));
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is CargaInicialViewModel { LoginLiberado: true }, "carga retomada");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel);
        await pdv.EsperarFocoAsync("CampoUsuario");
        pdv.Digitar("maria");
        pdv.Tecla(Key.Tab);
        pdv.Digitar("000000");
        pdv.Tecla(Key.Enter);
        var login = (LoginViewModel)pdv.Shell.PaginaAtual!;
        await pdv.EsperarAsync(() => login.Erro is not null, "PIN recusado");
        Assert.Equal("Usuário ou senha inválidos", pdv.Texto("TextoErroLogin"));
        login.Senha = pin;
        await login.EntrarCommand.ExecuteAsync(null);
        // Sem sessão de caixa, o login leva à abertura (PDV 8.1; C10a).
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is AberturaCaixaViewModel, "abertura do caixa");
    }

    [AvaloniaFact]
    public async Task Terminal_real_vende_com_a_forma_da_loja_e_cancela_com_evento_desde_a_fase_1c()
    {
        // Fim da D18 (C11a): o terminal ativado finaliza a venda (forma Dinheiro do espelho, cupom com os dados da loja) e
        // o cancelamento em andamento gera o `venda.cancelada` forma B.
        var api = new ApiFalsa();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: ComApiFalsa(api));
        var resultado = await pdv.Servicos.GetRequiredService<ServicoAtivacao>()
            .AtivarAsync(new Uri("https://api.exemplo/"), "100001", "K7QM-2XRD", TestContext.Current.CancellationToken);
        Assert.True(resultado.Ativado, resultado.Mensagem);
        // Usuário e loja descem pela carga inicial; o catálogo de demonstração dá os produtos e a forma Dinheiro.
        var (pin, hash) = PinDaApi();
        api.PublicarLojaECaixa();
        api.PublicarUsuario("maria", 1, hash, permissoes: PerfilQueCancela);
        await pdv.Servicos.GetRequiredService<CargaInicial>().ExecutarAsync(ct: TestContext.Current.CancellationToken);
        await CatalogoDemonstracao.GarantirAsync(pdv.Servicos.GetRequiredService<RepositorioEspelhos>(), DateTimeOffset.UtcNow);
        pdv.Servicos.GetRequiredService<SessaoTerminal>().Identidade =
            await pdv.Servicos.GetRequiredService<RepositorioTerminal>().ObterIdentidadeAsync(TestContext.Current.CancellationToken);
        pdv.Shell.IrParaLogin();
        var venda = await pdv.LogarAsync("maria", pin);

        await pdv.EntrarCodigoAsync("0044");
        Assert.Single(venda.Itens);
        // Sem saldo no espelho (O15 do dono): vende com o aviso âmbar, sem bloquear.
        Assert.StartsWith("Estoque insuficiente: GELO ESCAMA 5KG", pdv.Texto("TextoAlertaEstoque"));
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        Assert.Equal("Dinheiro", Assert.Single(pagamento.Formas).Forma.Descricao);
        pdv.Digitar("20");
        Assert.Equal("7,10", pagamento.TrocoTexto);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
        Assert.Equal("TROCO R$ 7,10", pdv.Texto("TextoTroco"));
        // Cabeçalho do comprovante a partir do espelho `lojas` (PDV 19.2), não mais o de demonstração.
        Assert.Contains("ICE BEER COMÉRCIO DE BEBIDAS LTDA", venda.UltimoCupom);
        Assert.Contains("CNPJ 00.000.000/0001-00", venda.UltimoCupom);
        pdv.Captura("10-venda-terminal-real");

        await pdv.EntrarCodigoAsync("0077");
        await pdv.Servicos.GetRequiredService<ServicoVenda>().CancelarVendaAsync("Cliente desistiu da compra no caixa");
        Assert.False(pdv.Servicos.GetRequiredService<ServicoVenda>().VendaAberta);

        await using var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
        var tipos = await db.EventosSaida.OrderBy(e => e.SequenciaTerminal).Select(e => e.Tipo).ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal(["caixa.aberto", "venda.finalizada", "venda.cancelada"], tipos.Where(t => t != "auditoria.registros"));
        var sessao = await db.SessoesCaixa.SingleAsync(TestContext.Current.CancellationToken);
        Assert.All(await db.Vendas.ToListAsync(TestContext.Current.CancellationToken), v => Assert.Equal(sessao.Id, v.SessaoCaixaId));
        var finalizada = await db.EventosSaida.SingleAsync(e => e.Tipo == "venda.finalizada", TestContext.Current.CancellationToken);
        Assert.Contains(sessao.Id.ToString("D"), finalizada.Dependencias);
    }

    [AvaloniaFact]
    public async Task Terminal_real_com_o_bloqueio_de_estoque_ligado_pede_o_supervisor_sem_gastar_o_numero()
    {
        // PDV 29.1 com `pdv.bloqueia_venda_sem_estoque` (fora do padrão do dono, O15) e online: saldo estimado negativo
        // recusa o item e abre a liberação `pdv.venda.vender_sem_estoque`; a venda nem começa.
        var (pdv, _) = await TerminalRealLogadoAsync(comCatalogo: true, comSupervisor: true);
        using var ambiente = pdv;
        var venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        await ConfigurarAsync(pdv, ChavesConfiguracao.BloqueiaVendaSemEstoque, "true");
        var sync = pdv.Servicos.GetRequiredService<IServicoSincronizacao>();
        await pdv.EsperarAsync(() => sync.Situacao.Online, "online", 20_000);
        long? Numero()
        {
            using var banco = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
            return banco.SequenciasLocais.Where(s => s.Chave == SequenciaLocal.Venda).Select(s => (long?)s.UltimoValor).FirstOrDefault();
        }

        var numeroAntes = Numero();

        await pdv.EntrarCodigoAsync("0044");

        await pdv.EsperarAsync(() => venda.Dialogo is DialogoLiberacaoViewModel, "liberação do supervisor");
        Assert.StartsWith("Estoque insuficiente: GELO ESCAMA 5KG (disponível: 0)", pdv.Texto("TextoMensagem"));
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        Assert.False(servico.VendaAberta);
        Assert.Equal(numeroAntes, Numero());

        // O supervisor do perfil padrão (não Master) libera; o item registrado de novo abre a venda com a faixa âmbar.
        await LiberarComJoaoAsync(pdv, venda, "Gelo chegou e não foi lançado");
        Assert.Equal("Venda sem estoque liberada por JOAO: registre o item de novo.", pdv.Texto("TextoMensagem"));
        Assert.False(servico.VendaAberta);
        await pdv.EsperarFocoAsync("CampoCodigo");
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => servico.VendaAberta, "venda aberta com a liberação");
        Assert.Equal("GELO ESCAMA 5KG: vendido sem estoque com a liberação do supervisor.", pdv.Texto("TextoAlertaEstoque"));
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            var auditoria = await db.LogAuditoriaLocal.SingleAsync(l => l.Acao == "liberacao" && l.Entidade == "produtos", TestContext.Current.CancellationToken);
            Assert.Equal((JoaoId, "Gelo chegou e não foi lançado"), (auditoria.AutorizadoPorId, auditoria.Motivo));
        }

        // A liberação é desta venda: terminada, o próximo gelo pede o supervisor de novo.
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoLiberacaoViewModel, "liberação de novo");
        Assert.False(servico.VendaAberta);

        // Liberada no primeiro item e não usada: outro login (logout, troca de operador) não a herda.
        await LiberarComJoaoAsync(pdv, venda, "Gelo chegou e não foi lançado");
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>();
        sessao.Operador = sessao.Operador! with { };
        await pdv.EsperarFocoAsync("CampoCodigo");
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoLiberacaoViewModel, "liberação no outro login");
        Assert.False(servico.VendaAberta);
    }

    /// <summary>Id do supervisor "joao" publicado por <see cref="TerminalRealLogadoAsync"/> (<c>comSupervisor</c>).</summary>
    internal static Guid JoaoId { get; private set; }

    /// <summary>
    /// Supervisor do perfil padrão (<c>PDV_SUPERVISOR</c> do shared, só as chaves que o caixa da 1C confere), sem Master: a
    /// permissão que a liberação exige é conferida de verdade.
    /// </summary>
    private static readonly IReadOnlySet<string> PerfilSupervisor = new HashSet<string>(Core.Caixa.PermissoesPdv.PerfilOperador, StringComparer.Ordinal)
    {
        Core.Caixa.PermissoesPdv.Supervisor, Core.Caixa.PermissoesPdv.ConfirmarPixManual, Core.Caixa.PermissoesPdv.FormaComSenha,
        Core.Caixa.PermissoesPdv.VenderSemEstoque, "pdv.venda.cancelar_venda_aberta",
    };

    /// <summary>
    /// Perfil do operador com <c>pdv.venda.cancelar_venda_aberta</c>: os testes que cancelam a venda em andamento direto
    /// pelo serviço, sem a liberação do supervisor (o serviço confere a permissão, O6).
    /// </summary>
    private static readonly IReadOnlySet<string> PerfilQueCancela =
        new HashSet<string>(Core.Caixa.PermissoesPdv.PerfilOperador, StringComparer.Ordinal) { Core.Caixa.PermissoesPdv.CancelarVendaAberta };

    internal static async Task LiberarComJoaoAsync(AmbienteUi pdv, VendaViewModel venda, string motivo)
    {
        await pdv.EsperarFocoAsync("CampoSupervisor");
        var dialogo = Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
        dialogo.Pedido.Usuario = "joao";
        dialogo.Pedido.Pin = PinDaApi().Pin;
        dialogo.Pedido.Motivo = motivo;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is not DialogoLiberacaoViewModel, "liberação concedida");
    }

    /// <summary>Chave de configuração da loja no espelho (como o pull a gravaria).</summary>
    private static Task ConfigurarAsync(AmbienteUi pdv, string chave, string valor)
    {
        var agora = DateTimeOffset.UtcNow;
        return pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [
                new ConfiguracaoRegistro
                {
                    Id = Guid.CreateVersion7(), Escopo = "loja", LojaId = ApiFalsa.LojaId, Chave = chave, Valor = valor,
                    CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
            ],
            TestContext.Current.CancellationToken);
    }

    private static readonly Guid DebitoReal = Guid.Parse("019a0004-0000-7000-8000-000000000202");
    private static readonly Guid PixReal = Guid.Parse("019a0004-0000-7000-8000-000000000203");

    /// <summary>Débito na maquininha e PIX com confirmação manual (sem QR) valendo em todas as lojas, como o pull os gravaria.</summary>
    private static Task FormasReaisAsync(AmbienteUi pdv)
    {
        var agora = DateTimeOffset.UtcNow;
        return pdv.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync(
            [
                new FormaPagamentoRegistro
                {
                    Id = DebitoReal, Descricao = "Cartão de débito", Ordem = 2, TipoForma = "cartao_debito", MeioPagamentoFiscal = "04",
                    Integracao = "pos_externo", CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
                new FormaPagamentoRegistro
                {
                    Id = PixReal, Descricao = "PIX", Ordem = 3, TipoForma = "pix", MeioPagamentoFiscal = "20", LancaQuitada = true,
                    CriadoEm = agora, AtualizadoEm = agora, Versao = 1,
                },
                new FormaPagamentoLojaRegistro { Id = Guid.CreateVersion7(), FormaPagamentoId = DebitoReal, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
                new FormaPagamentoLojaRegistro { Id = Guid.CreateVersion7(), FormaPagamentoId = PixReal, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
            ],
            TestContext.Current.CancellationToken);
    }

    /// <summary>F10, escolhe o PIX e confirma o pagador e o horário (um minuto atrás); a liberação, se houver, fica para o teste.</summary>
    private static async Task PagarComPixAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        Assert.Equal(["Dinheiro", "Cartão de débito", "PIX"], pagamento.Formas.Select(f => f.Forma.Descricao));
        pagamento.EscolherFormaCommand.Execute("3");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarFocoAsync("CampoPagadorPix");
        var pix = Assert.IsType<DialogoPixViewModel>(venda.Dialogo);
        pix.PagadorNome = "JOSE DA SILVA";
        // A hora corrigida do caixa (SYNC 12.3: a da API falsa), base do horário que o operador lê no banco.
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        pix.Horario = TimeZoneInfo.ConvertTime(servico.Agora.AddMinutes(-1), servico.Fuso).ToString("HH:mm");
        pdv.Tecla(Key.Enter);
        await AmbienteUi.Pausa();
        Assert.Null(pix.Erro);
    }

    [AvaloniaFact]
    public async Task Terminal_real_libera_o_pix_com_o_supervisor_do_perfil_padrao_e_confere_as_duas_permissoes()
    {
        // PIX manual com `pdv.pix_manual_exige_supervisor` no padrão (O9b): o "joao" (PDV_SUPERVISOR, não Master) libera.
        var (pdv, _) = await TerminalRealLogadoAsync(comCatalogo: true, comSupervisor: true);
        using var ambiente = pdv;
        var venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        await FormasReaisAsync(pdv);
        await pdv.EntrarCodigoAsync("0044");
        await PagarComPixAsync(pdv, venda);
        await LiberarComJoaoAsync(pdv, venda, "PIX conferido no extrato");
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            var evento = await db.EventosSaida.SingleAsync(e => e.Tipo == "venda.finalizada", TestContext.Current.CancellationToken);
            var payload = System.Text.Json.Nodes.JsonNode.Parse(evento.Payload)!;
            var joao = JoaoId.ToString("D");
            Assert.Equal(joao, payload["pagamentos_venda"]![0]!["autorizado_por_id"]!.GetValue<string>());
            var liberacao = Assert.Single(payload["liberacoes"]!.AsArray())!;
            Assert.Equal(("pix_manual", joao), (liberacao["acao"]!.GetValue<string>(), liberacao["autorizado_por_id"]!.GetValue<string>()));
        }

        // As duas regras se somam (PDV 16.2): a forma PIX com "exige supervisor" pede as duas permissões a quem libera, e
        // o lançamento recusa o supervisor que só tem a da forma.
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        var pixComSupervisor = (await servico.FormasPagamentoAsync(TestContext.Current.CancellationToken)).Single(f => f.Id == PixReal) with { ExigeSupervisor = true };
        Assert.Equal([Core.Caixa.PermissoesPdv.FormaComSenha, Core.Caixa.PermissoesPdv.ConfirmarPixManual], servico.PermissoesParaLancar(pixComSupervisor));
        Assert.Equal(Core.Caixa.PermissoesPdv.FormaComSenha, servico.PermissaoParaLancar(pixComSupervisor));
        await pdv.EntrarCodigoAsync("0044");
        await servico.IniciarPagamentoAsync(TestContext.Current.CancellationToken);
        var soDaForma = new Operador(Guid.CreateVersion7(), 3, "ana", "ANA", 0m,
            Permissoes: new HashSet<string>(StringComparer.Ordinal) { Core.Caixa.PermissoesPdv.FormaComSenha });
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() => servico.LancarPagamentoAsync(
            pixComSupervisor, 12.90m, pix: new ConfirmacaoPix("JOSE", DateTimeOffset.UtcNow, string.Empty, "L01C02000002"),
            liberacao: new LiberacaoConcedida(soDaForma, "PIX conferido", DateTimeOffset.UtcNow), ct: TestContext.Current.CancellationToken));
        Assert.Contains(Core.Caixa.PermissoesPdv.ConfirmarPixManual, recusa.Message);
        Assert.Empty(servico.Atual!.PagamentosAtivos);
    }

    [AvaloniaFact]
    public async Task Terminal_real_com_a_chave_do_supervisor_desligada_o_operador_com_a_permissao_confirma_o_pix_sozinho()
    {
        var (pdv, _) = await TerminalRealLogadoAsync(
            comCatalogo: true, permissoesOperador: Core.Caixa.PermissoesPdv.PerfilOperador.Append(Core.Caixa.PermissoesPdv.ConfirmarPixManual));
        using var ambiente = pdv;
        var venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        await FormasReaisAsync(pdv);
        await ConfigurarAsync(pdv, ChavesConfiguracao.PixManualExigeSupervisor, "false");
        await pdv.EntrarCodigoAsync("0044");

        await PagarComPixAsync(pdv, venda);

        // Sem o diálogo de liberação: o PIX entra direto e quita a venda.
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada sem liberação");
        await using var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
        var evento = await db.EventosSaida.SingleAsync(e => e.Tipo == "venda.finalizada", TestContext.Current.CancellationToken);
        var payload = System.Text.Json.Nodes.JsonNode.Parse(evento.Payload)!;
        Assert.Null(payload["pagamentos_venda"]![0]!["autorizado_por_id"]);
        Assert.Empty(payload["liberacoes"]!.AsArray());
        Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "pix_confirmado_manual", TestContext.Current.CancellationToken));
    }

    [AvaloniaFact]
    public async Task Terminal_real_sem_o_venda_finalizada_anunciado_recusa_o_item_sem_gastar_o_numero()
    {
        // T13: a API sem o handler do `venda.finalizada` (anterior ao C6b): a venda nem começa.
        var (pdv, api) = await TerminalRealLogadoAsync(comCatalogo: true);
        using var ambiente = pdv;
        api.VersoesSchema.Remove("venda.finalizada");
        await pdv.Servicos.GetRequiredService<IServicoSincronizacao>().HandshakeAsync(TestContext.Current.CancellationToken);
        await using var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
        var numeroAntes = await db.SequenciasLocais.Where(s => s.Chave == SequenciaLocal.Venda).Select(s => (long?)s.UltimoValor)
            .FirstOrDefaultAsync(TestContext.Current.CancellationToken);

        await pdv.EntrarCodigoAsync("0044");

        Assert.Equal(Data.Outbox.GravadorOutbox.MensagemTipoNaoAnunciado("venda.finalizada", 1), pdv.Texto("TextoMensagem"));
        Assert.False(pdv.Servicos.GetRequiredService<ServicoVenda>().VendaAberta);
        Assert.Equal(numeroAntes, await db.SequenciasLocais.Where(s => s.Chave == SequenciaLocal.Venda).Select(s => (long?)s.UltimoValor)
            .FirstOrDefaultAsync(TestContext.Current.CancellationToken));
        Assert.Equal(0, await db.Vendas.CountAsync(TestContext.Current.CancellationToken));
    }

    [AvaloniaFact]
    public async Task Terminal_real_sem_o_venda_cancelada_anunciado_cancela_sem_evento_com_a_auditoria()
    {
        // T13 com a API entre o C6b e o C7: o caixa não fica preso na venda — cancela como na 1B, com a auditoria `cancelar`.
        var (pdv, api) = await TerminalRealLogadoAsync(comCatalogo: true, permissoesOperador: PerfilQueCancela);
        using var ambiente = pdv;
        await pdv.EntrarCodigoAsync("0044");
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        Assert.True(servico.VendaAberta);
        api.VersoesSchema.Remove("venda.cancelada");
        await pdv.Servicos.GetRequiredService<IServicoSincronizacao>().HandshakeAsync(TestContext.Current.CancellationToken);

        await servico.CancelarVendaAsync("Cliente desistiu da compra no caixa", TestContext.Current.CancellationToken);

        Assert.False(servico.VendaAberta);
        await using var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
        Assert.Equal(StatusVenda.Cancelada, (await db.Vendas.SingleAsync(TestContext.Current.CancellationToken)).Status);
        Assert.Equal(0, await db.EventosSaida.CountAsync(e => e.Tipo.StartsWith("venda."), TestContext.Current.CancellationToken));
        var auditoria = await db.LogAuditoriaLocal.SingleAsync(l => l.Acao == "cancelar", TestContext.Current.CancellationToken);
        Assert.Equal("vendas", auditoria.Entidade);
        Assert.Contains("Cliente desistiu da compra no caixa", auditoria.Descricao);
    }

    [AvaloniaFact]
    public async Task Terminal_real_sem_o_venda_cancelada_anunciado_nao_cancela_a_venda_paga()
    {
        // T13 na gestão de vendas (C11b): o estorno tira dinheiro da gaveta e não fica sem o evento (forma A); diferente
        // da venda em andamento, a paga não cancela como na 1B.
        var (pdv, api) = await TerminalRealLogadoAsync(comCatalogo: true);
        using var ambiente = pdv;
        var venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
        api.VersoesSchema.Remove("venda.cancelada");
        await pdv.Servicos.GetRequiredService<IServicoSincronizacao>().HandshakeAsync(TestContext.Current.CancellationToken);
        await using var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
        var paga = (await db.Vendas.SingleAsync(TestContext.Current.CancellationToken)).Id;

        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() =>
            pdv.Servicos.GetRequiredService<ServicoVenda>().PrepararCancelamentoAsync(paga, TestContext.Current.CancellationToken));

        Assert.Equal(Data.Outbox.GravadorOutbox.MensagemTipoNaoAnunciado("venda.cancelada", 1), recusa.Message);
        Assert.Equal(StatusVenda.Finalizada, (await db.Vendas.AsNoTracking().SingleAsync(TestContext.Current.CancellationToken)).Status);
        Assert.Equal(0, await db.EventosSaida.CountAsync(e => e.Tipo == "venda.cancelada", TestContext.Current.CancellationToken));
    }

    [AvaloniaFact]
    public async Task Venda_da_1b_sem_sessao_entra_na_sessao_aberta_ou_so_cancela_sem_evento()
    {
        // Terminal real da 1B (D18): a venda montada sem caixa volta na recuperação com `sessao_caixa_id` nulo.
        var (pdv, _) = await TerminalRealLogadoAsync(comCatalogo: true, permissoesOperador: PerfilQueCancela);
        using var ambiente = pdv;
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        var sessao = pdv.Servicos.GetRequiredService<SessaoTerminal>();
        var ct = TestContext.Current.CancellationToken;
        async Task VendaSemSessaoAsync()
        {
            await pdv.EntrarCodigoAsync("0044");
            await using var banco = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
            await banco.Vendas.Where(v => v.Id == servico.Atual!.Id).ExecuteUpdateAsync(v => v.SetProperty(x => x.SessaoCaixaId, (Guid?)null), ct);
        }

        // Com o caixa aberto: a recuperação a inclui na sessão e o `venda.finalizada` sobe com ela.
        await VendaSemSessaoAsync();
        Assert.True(await servico.RecuperarAsync(ct));
        var aberta = sessao.SessaoCaixaId!.Value;
        Assert.Equal(aberta, servico.Atual!.SessaoCaixaId);
        await servico.IniciarPagamentoAsync(ct);
        Assert.NotNull(await servico.LancarDinheiroAsync(20m, ct));
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            Assert.Equal(aberta, (await db.Vendas.SingleAsync(ct)).SessaoCaixaId);
            var finalizada = await db.EventosSaida.SingleAsync(e => e.Tipo == "venda.finalizada", ct);
            Assert.Contains(aberta.ToString("D"), finalizada.Dependencias);
        }

        // Sem sessão para entrar: não vai ao pagamento nem finaliza, e o cancelamento sai sem `venda.cancelada`.
        await VendaSemSessaoAsync();
        var registro = sessao.SessaoCaixa;
        sessao.DefinirSessaoCaixa(null);
        Assert.True(await servico.RecuperarAsync(ct));
        Assert.Null(servico.Atual!.SessaoCaixaId);
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() => servico.IniciarPagamentoAsync(ct));
        Assert.Equal(ServicoVenda.MensagemVendaSemSessao, recusa.Message);
        await servico.CancelarVendaAsync("Venda montada antes da atualização", ct);
        Assert.False(servico.VendaAberta);
        sessao.DefinirSessaoCaixa(registro);
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            Assert.Equal(["venda.finalizada"], await db.EventosSaida.Where(e => e.Tipo.StartsWith("venda.")).Select(e => e.Tipo).ToListAsync(ct));
            Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "cancelar", ct));
        }
    }

    /// <summary>Terminal real ativado contra a API falsa, com a carga feita e o operador logado (o ciclo online já roda).</summary>
    /// <param name="permissoesOperador">Perfil da "maria" (padrão: o do operador de caixa).</param>
    /// <param name="comSupervisor">Publica também o "joao" (código 2, mesmo PIN), supervisor do perfil padrão, não Master.</param>
    internal static async Task<(AmbienteUi Pdv, ApiFalsa Api)> TerminalRealLogadoAsync(
        bool apagar = true, bool comCatalogo = false, IEnumerable<string>? permissoesOperador = null, bool comSupervisor = false)
    {
        var api = new ApiFalsa { IntervaloS = 1 };
        var pdv = await AmbienteUi.IniciarAsync(apagar: apagar, ajustar: ComApiFalsa(api));
        Assert.True((await pdv.Servicos.GetRequiredService<ServicoAtivacao>()
            .AtivarAsync(new Uri("https://api.exemplo/"), "100001", "K7QM-2XRD", TestContext.Current.CancellationToken)).Ativado);
        var (pin, hash) = PinDaApi();
        api.PublicarLojaECaixa();
        api.PublicarUsuario("maria", 1, hash, permissoes: permissoesOperador);
        if (comSupervisor)
        {
            JoaoId = api.PublicarUsuario("joao", 2, hash, permissoes: PerfilSupervisor);
        }

        await pdv.Servicos.GetRequiredService<CargaInicial>().ExecutarAsync(ct: TestContext.Current.CancellationToken);
        if (comCatalogo)
        {
            // Só para ter o que montar: o catálogo da carga da API falsa é vazio.
            await CatalogoDemonstracao.GarantirAsync(pdv.Servicos.GetRequiredService<RepositorioEspelhos>(), DateTimeOffset.UtcNow);
        }

        pdv.Servicos.GetRequiredService<SessaoTerminal>().Identidade =
            await pdv.Servicos.GetRequiredService<RepositorioTerminal>().ObterIdentidadeAsync(TestContext.Current.CancellationToken);
        pdv.Shell.IrParaLogin();
        await pdv.LogarAsync("maria", pin);
        return (pdv, api);
    }

    /// <summary>Telas por onde o shell passou, na ordem (a troca pode durar menos que um polling).</summary>
    private static System.Collections.Concurrent.ConcurrentQueue<Type> Telas(AmbienteUi pdv)
    {
        var telas = new System.Collections.Concurrent.ConcurrentQueue<Type>();
        pdv.Shell.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(ShellViewModel.PaginaAtual) && pdv.Shell.PaginaAtual is { } pagina)
            {
                telas.Enqueue(pagina.GetType());
            }
        };
        return telas;
    }

    [AvaloniaFact]
    public async Task Ciclo_online_mostra_o_indicador_a_mensagem_do_erp_e_a_desativacao_ate_desativado()
    {
        var (pdv, api) = await TerminalRealLogadoAsync();
        using var _ = pdv;
        await pdv.EsperarAsync(() => pdv.Texto("TextoConexao") == "● Online", "indicador online", 20_000);
        pdv.Captura("11-venda-online");

        api.Comandar("mensagem", new System.Text.Json.Nodes.JsonObject { ["texto"] = "Inventário amanhã às 7h" });
        await pdv.EsperarAsync(() => pdv.Shell.MensagemNuvem is not null, "mensagem do ERP", 20_000);
        Assert.Equal("Mensagem do ERP: Inventário amanhã às 7h", pdv.Texto("TextoMensagemNuvem"));
        await pdv.EsperarAsync(() => api.Comandos.Count == 0, "ack da mensagem", 20_000);

        // Revogar aceitando pendências: com o caixa livre, vai para a desativação. O push do lote de auditoria (o login)
        // falha de propósito, então a tela fica mostrando a pendência; liberado o envio, a nuvem confirma.
        var tentativas = 0;
        api.AoEnviar = _ =>
        {
            tentativas++;
            return ApiFalsa.Erro(System.Net.HttpStatusCode.ServiceUnavailable, "MANUTENCAO", "Manutenção.");
        };
        api.StatusTerminal = "desativando";
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is DesativacaoViewModel, "tela de desativação", 20_000);
        await pdv.EsperarAsync(() => tentativas > 0 && pdv.Texto("TituloDesativacao") == "Terminal em desativação — enviando pendências (1)",
            "pendência na tela", 20_000);
        Assert.False(api.DesativacaoConfirmada);
        pdv.Captura("12-desativacao");
        api.AoEnviar = null;
        await pdv.EsperarAsync(
            () => pdv.Shell.PaginaAtual is TerminalBloqueadoViewModel { Titulo: TerminalBloqueadoViewModel.TituloDesativado }, "terminal desativado", 30_000);
        Assert.True(api.DesativacaoConfirmada);
        Assert.Equal(TerminalBloqueadoViewModel.TituloDesativado, pdv.Texto("TituloBloqueio"));
        Assert.Contains(api.EventosRecebidos.Values, e => e["tipo"]!.GetValue<string>() == "auditoria.registros");
        pdv.Captura("13-terminal-desativado");
    }

    [AvaloniaFact]
    public async Task Desativacao_com_venda_aberta_espera_ela_fechar_para_trocar_a_tela_e_confirmar()
    {
        var (pdv, api) = await TerminalRealLogadoAsync(comCatalogo: true, permissoesOperador: PerfilQueCancela);
        using var _ = pdv;
        var venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "1 item");
        var telas = Telas(pdv);

        // Com venda aberta, a barra avisa e a tela fica na venda; a nuvem não recebe a confirmação (o cancelamento ainda
        // gera o `venda.cancelada`).
        api.StatusTerminal = "desativando";
        await pdv.EsperarAsync(() => pdv.Texto("TextoConexao")!.StartsWith("▲ Em desativação", StringComparison.Ordinal), "aviso na barra", 20_000);
        // O `caixa.aberto` da abertura (C10a) e a auditoria do login.
        await pdv.EsperarAsync(() => api.EventosRecebidos.Count == 2, "abertura e auditoria do login enviadas", 20_000);
        var heartbeats = api.Contar("/sync/heartbeat");
        await pdv.EsperarAsync(() => api.Contar("/sync/heartbeat") >= heartbeats + 2, "heartbeats com a venda aberta", 20_000);
        Assert.IsType<VendaViewModel>(pdv.Shell.PaginaAtual);
        Assert.False(api.DesativacaoConfirmada);
        Assert.Empty(telas);

        // A venda fecha: a tela vai para a desativação, o `venda.cancelada` (forma B, C11a) sobe e só então a nuvem confirma.
        await pdv.Servicos.GetRequiredService<ServicoVenda>().CancelarVendaAsync("desativação do caixa");
        await pdv.EsperarAsync(
            () => pdv.Shell.PaginaAtual is TerminalBloqueadoViewModel { Titulo: TerminalBloqueadoViewModel.TituloDesativado }, "terminal desativado", 30_000);
        Assert.Equal([typeof(DesativacaoViewModel), typeof(TerminalBloqueadoViewModel)], telas);
        Assert.Contains(api.EventosRecebidos.Values, e => e["tipo"]?.GetValue<string>() == "venda.cancelada");
    }

    [AvaloniaFact]
    public async Task Hardware_aprovado_durante_a_desativacao_sai_do_bloqueio_para_a_desativacao()
    {
        var (pdv, api) = await TerminalRealLogadoAsync(apagar: false);
        var raiz = pdv.Raiz;
        pdv.Dispose();
        api.HardwareConfere = false;
        using var reaberto = await AmbienteUi.IniciarAsync(raiz, ajustar: ComApiFalsa(api));
        await reaberto.EsperarAsync(() => reaberto.Shell.PaginaAtual is TerminalBloqueadoViewModel { Titulo: TerminalBloqueadoViewModel.TituloHardware }, "bloqueio de hardware");
        var telas = Telas(reaberto);

        // O gerente pede a desativação e aprova o hardware para as pendências subirem.
        api.StatusTerminal = "desativando";
        api.HardwareConfere = true;
        await reaberto.EsperarAsync(
            () => reaberto.Shell.PaginaAtual is TerminalBloqueadoViewModel { Titulo: TerminalBloqueadoViewModel.TituloDesativado }, "terminal desativado", 30_000);
        Assert.True(api.DesativacaoConfirmada);
        Assert.Equal([typeof(DesativacaoViewModel), typeof(TerminalBloqueadoViewModel)], telas);
    }

    [AvaloniaFact]
    public async Task Revogacao_imediata_troca_a_tela_e_na_reabertura_so_mostra_o_diagnostico()
    {
        string raiz;
        var (pdv, api) = await TerminalRealLogadoAsync(apagar: false);
        using (pdv)
        {
            api.Revogado = true;
            await pdv.EsperarAsync(
                () => pdv.Shell.PaginaAtual is TerminalBloqueadoViewModel { Titulo: TerminalBloqueadoViewModel.TituloDesativado }, "desativado", 30_000);
            Assert.Equal(StatusIdentidade.Revogado,
                (await pdv.Servicos.GetRequiredService<RepositorioTerminal>().ObterIdentidadeAsync(TestContext.Current.CancellationToken))!.Status);
            raiz = pdv.Raiz;
        }

        // Reaberto (sem depender da rede): direto para a tela de desativado; o banco local continua lá.
        using var reaberto = await AmbienteUi.IniciarAsync(raiz, ajustar: ComApiFalsa(api));
        await reaberto.EsperarAsync(() => reaberto.Shell.PaginaAtual is TerminalBloqueadoViewModel, "desativado na abertura");
        Assert.Equal(TerminalBloqueadoViewModel.TituloDesativado, reaberto.Texto("TituloBloqueio"));
    }

    [AvaloniaFact]
    public async Task Handshake_com_hardware_divergente_bloqueia_antes_do_login()
    {
        var (pdv, api) = await TerminalRealLogadoAsync(apagar: false);
        var raiz = pdv.Raiz;
        pdv.Dispose();
        api.HardwareConfere = false;
        using var reaberto = await AmbienteUi.IniciarAsync(raiz, ajustar: ComApiFalsa(api));
        await reaberto.EsperarAsync(() => reaberto.Shell.PaginaAtual is TerminalBloqueadoViewModel, "bloqueio de hardware");
        Assert.Equal("Hardware alterado — aguardando aprovação no ERP", reaberto.Texto("TituloBloqueio"));
        reaberto.Captura("14-hardware-alterado");

        // Aprovado no ERP: Enter refaz o handshake e libera o login.
        api.HardwareConfere = true;
        reaberto.Tecla(Key.Enter);
        await reaberto.EsperarAsync(() => reaberto.Shell.PaginaAtual is LoginViewModel, "login depois da aprovação");
    }

    [AvaloniaFact]
    public async Task Empresa_suspensa_termina_a_venda_atual_bloqueia_a_proxima_e_na_abertura_mostra_o_motivo()
    {
        var (pdv, api) = await TerminalRealLogadoAsync(apagar: false, comCatalogo: true, permissoesOperador: PerfilQueCancela);
        var raiz = pdv.Raiz;
        using (pdv)
        {
            var venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
            await pdv.EntrarCodigoAsync("0044");
            await pdv.EsperarAsync(() => venda.Itens.Count == 1, "venda aberta");

            // A Genesis suspende a empresa no meio da venda: a barra mostra o motivo, não "sem conexão".
            api.EmpresaBloqueada = "EMPRESA_SUSPENSA";
            await pdv.EsperarAsync(() => pdv.Texto("TextoConexao") == "■ Empresa suspensa — novas vendas bloqueadas", "aviso de empresa suspensa", 20_000);

            // A venda atual continua (a D18 já impede a finalização no terminal real; aqui ela é cancelada); a próxima não abre.
            var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
            await pdv.EntrarCodigoAsync("0044");
            Assert.Equal(2m, servico.Atual!.Itens.Sum(i => i.Quantidade));
            await servico.CancelarVendaAsync("teste de cancelamento");
            await venda.RecarregarDoBancoAsync();
            await pdv.EntrarCodigoAsync("0044");
            Assert.Empty(venda.Itens);
            Assert.Equal(ServicoVenda.MensagemTerminalBloqueado, pdv.Texto("TextoMensagem"));
        }

        // Reaberto ainda suspenso: tela de bloqueio com o motivo; o ciclo liga (o push continua) e Enter tenta de novo.
        using var reaberto = await AmbienteUi.IniciarAsync(raiz, ajustar: ComApiFalsa(api));
        await reaberto.EsperarAsync(() => reaberto.Shell.PaginaAtual is TerminalBloqueadoViewModel, "bloqueio da empresa suspensa");
        Assert.Equal("Empresa suspensa — novas vendas bloqueadas", reaberto.Texto("TituloBloqueio"));
        Assert.Equal(MensagensBloqueioNuvem.EmpresaSuspensa, reaberto.Texto("TextoBloqueio"));
        Assert.True(reaberto.Servicos.GetRequiredService<ServicoSincronizacaoHttp>().Rodando);
        reaberto.Captura("15-empresa-suspensa");

        api.EmpresaBloqueada = null;
        reaberto.Tecla(Key.Enter);
        await reaberto.EsperarAsync(() => reaberto.Shell.PaginaAtual is LoginViewModel, "login depois da reativação");
    }

    [AvaloniaFact]
    public async Task Revogacao_durante_a_carga_inicial_vai_para_desativado_e_token_recusado_para_o_bloqueio()
    {
        var api = new ApiFalsa();
        api.PublicarLojaECaixa();
        var raiz = AmbienteUi.NovaRaiz();
        using (var pdv = await AmbienteUi.IniciarAsync(raiz, apagar: false, ajustar: ComApiFalsa(api)))
        {
            Assert.True((await pdv.Servicos.GetRequiredService<ServicoAtivacao>()
                .AtivarAsync(new Uri("https://api.exemplo/"), "100001", "K7QM-2XRD", TestContext.Current.CancellationToken)).Ativado);
            // O gerente revoga no ERP antes do fim dos fluxos que liberam o login: nada de "Enter tenta de novo".
            api.AoPuxar = e => e.Consulta.Contains("fluxo=catalogo", StringComparison.Ordinal)
                ? ApiFalsa.Erro(System.Net.HttpStatusCode.Unauthorized, "TERMINAL_REVOGADO", "Este terminal foi desativado no ERP.")
                : null;
            await pdv.Shell.IrParaCargaInicialAsync();
            await pdv.EsperarAsync(
                () => pdv.Shell.PaginaAtual is TerminalBloqueadoViewModel { Titulo: TerminalBloqueadoViewModel.TituloDesativado }, "desativado na carga");
            Assert.Equal(StatusIdentidade.Revogado,
                (await pdv.Servicos.GetRequiredService<RepositorioTerminal>().ObterIdentidadeAsync(TestContext.Current.CancellationToken))!.Status);
        }

        // Reaberto sem rede: o revogado foi gravado, então a abertura vai direto para a tela de desativado.
        api.ForaDoAr = true;
        using (var reaberto = await AmbienteUi.IniciarAsync(raiz, ajustar: ComApiFalsa(api)))
        {
            await reaberto.EsperarAsync(() => reaberto.Shell.PaginaAtual is TerminalBloqueadoViewModel, "desativado na abertura");
            Assert.Equal(TerminalBloqueadoViewModel.TituloDesativado, reaberto.Texto("TituloBloqueio"));
        }

        // Token recusado na carga: o bloqueio "chame o suporte" do handshake; aceito de novo, Enter volta para a carga.
        var outra = new ApiFalsa();
        outra.PublicarLojaECaixa();
        using var segundo = await AmbienteUi.IniciarAsync(ajustar: ComApiFalsa(outra));
        Assert.True((await segundo.Servicos.GetRequiredService<ServicoAtivacao>()
            .AtivarAsync(new Uri("https://api.exemplo/"), "100001", "K7QM-2XRD", TestContext.Current.CancellationToken)).Ativado);
        var hashes = outra.HashesValidos.ToList();
        outra.HashesValidos.Clear();
        await segundo.Shell.IrParaCargaInicialAsync();
        await segundo.EsperarAsync(() => segundo.Shell.PaginaAtual is TerminalBloqueadoViewModel, "bloqueio do token");
        Assert.Equal(TerminalBloqueadoViewModel.TituloSuporte, segundo.Texto("TituloBloqueio"));
        Assert.Equal(MensagensBloqueioNuvem.TokenRecusado, segundo.Texto("TextoBloqueio"));
        outra.HashesValidos.UnionWith(hashes);
        segundo.Tecla(Key.Enter);
        await segundo.EsperarAsync(() => segundo.Shell.PaginaAtual is CargaInicialViewModel { Concluida: true }, "carga depois do token aceito");
    }

    private static Action<IServiceCollection> ComApiFalsa(ApiFalsa api) => servicos =>
        servicos.AddSingleton<IClienteSync>(sp => new ClienteSyncHttp(
            new HttpClient(api),
            sp.GetRequiredService<MaquinaLocal>().ParaCliente(),
            sp.GetRequiredService<IRelogio>(),
            sp.GetRequiredService<IFonteToken>(),
            () => new Uri("https://api.exemplo/")));

    private static byte[] LerCompartilhado(string arquivo)
    {
        using var fluxo = new FileStream(arquivo, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var memoria = new MemoryStream();
        fluxo.CopyTo(memoria);
        return memoria.ToArray();
    }

    private static async Task<long> ContarEventosAsync(AmbienteUi pdv)
    {
        await using var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
        return await db.EventosSaida.LongCountAsync(TestContext.Current.CancellationToken);
    }

    [AvaloniaFact]
    public async Task Modo_demonstracao_leva_ao_login_e_senha_errada_e_recusada()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        pdv.Tecla(Key.F8);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is LoginViewModel);
        await pdv.EsperarFocoAsync("CampoUsuario");
        pdv.Captura("03-login");
        pdv.Digitar("1");
        pdv.Tecla(Key.Tab);
        pdv.Digitar("0000");
        pdv.Tecla(Key.Enter);
        await AmbienteUi.Pausa();
        Assert.Equal("Usuário ou senha inválidos", pdv.Texto("TextoErroLogin"));
        Assert.IsType<LoginViewModel>(pdv.Shell.PaginaAtual);
        Assert.NotNull(await pdv.Servicos.GetRequiredService<RepositorioTerminal>().ObterIdentidadeAsync(TestContext.Current.CancellationToken));
    }

    [AvaloniaFact]
    public async Task Tela_de_venda_inclui_item_pelo_teclado_com_multiplicador()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        Assert.True(venda.CaixaLivre);
        pdv.Captura("04-caixa-livre");

        await pdv.EntrarCodigoAsync("7891149103102");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "1 item");
        Assert.Equal("3,49", pdv.Texto("TextoTotal"));
        Assert.StartsWith("VENDA L01-C02-000001", pdv.Texto("TextoCabecalhoVenda"));
        Assert.Equal(1, pdv.Controle<ListBox>("ListaItens").ItemCount);

        await pdv.EntrarCodigoAsync("3*0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 2, "2 itens");
        Assert.Equal("3,000 UN", venda.Itens[1].Quantidade);
        Assert.Equal("42,19", pdv.Texto("TextoTotal"));

        // Multiplicador fixado antes da leitura (3* Enter e depois o código).
        await pdv.EntrarCodigoAsync("2*");
        Assert.Equal("Qtd: 2", pdv.Texto("TextoMultiplicador"));
        await pdv.EntrarCodigoAsync("7896045506873");
        await pdv.EsperarAsync(() => venda.Itens.Count == 3, "3 itens");
        Assert.Equal("47,19", pdv.Texto("TextoTotal"));
        Assert.Equal("Qtd: 1", pdv.Texto("TextoMultiplicador"));
        Assert.Equal("CampoCodigo", pdv.NomeFocado());

        await pdv.EntrarCodigoAsync("7890000000000");
        Assert.Equal("Produto não encontrado: 7890000000000", pdv.Texto("TextoMensagem"));
        Assert.Equal(string.Empty, venda.CodigoEntrada);
        Assert.Equal(3, venda.Itens.Count);
    }

    [AvaloniaFact]
    public async Task Remover_item_com_F4_risca_a_linha_e_tira_do_total()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("7891149103102");
        await pdv.EntrarCodigoAsync("0050");
        await pdv.EsperarAsync(() => venda.Itens.Count == 2);
        pdv.Tecla(Key.Up);
        Assert.Equal(1, venda.ItemSelecionado?.Sequencia);
        pdv.Tecla(Key.F4);
        await pdv.EsperarFocoAsync("CampoSequencia");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.Itens[0].Cancelado, "item cancelado");
        Assert.Equal("19,99", pdv.Texto("TextoTotal"));
        Assert.Contains("CANCELADO", venda.Itens[0].Detalhe);
        await pdv.EsperarFocoAsync("CampoCodigo");
    }

    [AvaloniaFact]
    public async Task Pagamento_em_dinheiro_calcula_troco_imprime_cupom_e_grava_outbox()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("12*7891149103102");
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 2);
        // 12 latas ativam o atacado 12+ da Brahma (3,19): 38,28 + 12,90.
        Assert.Equal("51,18", pdv.Texto("TextoTotal"));
        Assert.Equal("ATAC 12+", venda.Itens[0].Etiqueta);
        Assert.Equal("Economia atacado: R$ 3,60", pdv.Texto("TextoEconomia"));

        await pdv.LigarGavetaAsync();
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        Assert.Equal("51,18", pagamento.ValorRecebido);
        pdv.Digitar("60");
        Assert.Equal("8,82", pagamento.TrocoTexto);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");

        Assert.Equal("TROCO R$ 8,82", pdv.Texto("TextoTroco"));
        Assert.Contains("NÃO É DOCUMENTO FISCAL", venda.UltimoCupom);
        Assert.Contains("TOTAL R$     51,18", venda.UltimoCupom);
        Assert.Contains("ATACADO 12+ (varejo 3,49)", venda.UltimoCupom);
        Assert.Contains("Economia no atacado: R$ 3,60", venda.UltimoCupom);
        // O `caixa.aberto` da abertura e a venda (C10a).
        await pdv.EsperarAsync(() => venda.PendentesTexto == "⇅ 2", "pendentes no outbox");
        var impressora = pdv.Servicos.GetRequiredService<ImpressoraArquivoSimulada>();
        Assert.True(File.Exists(impressora.UltimoArquivo));
        // Só a venda em dinheiro (forma "Abrir gaveta"), com a gaveta ligada antes do F10; a abertura do caixa não abre
        // (dono, I4: só as formas "Abrir gaveta" e o F11 › 9; nos movimentos, só com a chave ligada).
        Assert.Equal(1, pdv.Servicos.GetRequiredService<GavetaSimulada>().Aberturas);

        // A próxima leitura inicia a próxima venda e apaga o troco da tela.
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1);
        Assert.Null(venda.TrocoTexto);
        Assert.StartsWith("VENDA L01-C02-000002", pdv.Texto("TextoCabecalhoVenda"));
    }

    [AvaloniaFact]
    public async Task Venda_de_mil_reais_ou_mais_fecha_so_com_Enter_no_valor_preenchido()
    {
        // O valor vem preenchido com separador de milhar ("1.290,00"); antes ele era recusado ("Informe o valor...") e a
        // venda a partir de R$ 1.000 não fechava sem redigitar o valor (achado no ensaio com a planilha real).
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("100*0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1);

        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);
        Assert.Contains('.', pagamento.ValorRecebido);
        Assert.Equal(pagamento.TotalTexto, pagamento.ValorRecebido);
        Assert.Null(pagamento.Erro);
        Assert.Equal("0,00", pagamento.TrocoTexto);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
        Assert.Contains(pagamento.TotalTexto, venda.UltimoCupom);
    }

    [AvaloniaFact]
    public async Task Venda_em_andamento_volta_depois_de_reiniciar_o_aplicativo()
    {
        var raiz = AmbienteUi.NovaRaiz();
        using (var primeiro = await AmbienteUi.IniciarAsync(raiz, apagar: false))
        {
            var venda = await primeiro.AtivarDemonstracaoELogarAsync();
            await primeiro.EntrarCodigoAsync("7891149103102");
            await primeiro.EntrarCodigoAsync("0,795*0050");
            await primeiro.EsperarAsync(() => venda.Itens.Count == 2);
        }

        using var segundo = await AmbienteUi.IniciarAsync(raiz);
        Assert.IsType<LoginViewModel>(segundo.Shell.PaginaAtual);
        var recuperada = await segundo.AtivarDemonstracaoELogarAsync();
        Assert.True(recuperada.VendaRecuperada);
        Assert.Equal(2, recuperada.Itens.Count);
        Assert.Equal("19,38", segundo.Texto("TextoTotal"));
        Assert.True(segundo.Controle<TextBlock>("TextoVendaRecuperada").IsEffectivelyVisible);
    }

    [AvaloniaFact]
    public async Task Pull_de_preco_durante_a_queda_nao_muda_os_itens_da_venda_recuperada()
    {
        var raiz = AmbienteUi.NovaRaiz();
        using (var primeiro = await AmbienteUi.IniciarAsync(raiz, apagar: false))
        {
            var venda = await primeiro.AtivarDemonstracaoELogarAsync();
            Assert.True(primeiro.Servicos.GetRequiredService<SessaoTerminal>().UsaPrecoVolume);
            await primeiro.EntrarCodigoAsync("5*7891149103102");
            await primeiro.EsperarAsync(() => venda.Itens.Count == 1);
            Assert.Equal("17,45", primeiro.Texto("TextoTotal"));
        }

        using var segundo = await AmbienteUi.IniciarAsync(raiz);
        var ct = TestContext.Current.CancellationToken;
        var fabrica = segundo.Servicos.GetRequiredService<IDbContextFactory<PdvDbContext>>();
        await using (var db = await fabrica.CreateDbContextAsync(ct))
        {
            // "Pull" com o preço novo da Brahma (3,49 → 3,99) enquanto o PDV estava fora.
            var brahma = await db.Produtos.AsNoTracking().SingleAsync(p => p.Codigo == 123, ct);
            brahma.PrecoVenda = 3.99m;
            brahma.Versao++;
            Assert.Equal(1, await segundo.Servicos.GetRequiredService<RepositorioEspelhos>().GravarAsync([brahma], ct));
        }

        var recuperada = await segundo.AtivarDemonstracaoELogarAsync();
        Assert.True(recuperada.VendaRecuperada);
        await segundo.EntrarCodigoAsync("7891991010856");
        await segundo.EsperarAsync(() => recuperada.Itens.Count == 2);
        var itens = segundo.Servicos.GetRequiredService<ServicoVenda>().Atual!.ItensAtivos.ToList();
        Assert.Equal(17.45m, itens[0].ValorBruto);
        Assert.Equal(3.49m, itens[0].PrecoUnitario);
    }

    [AvaloniaFact]
    public async Task Erro_inesperado_avisa_e_recarrega_a_venda_do_banco()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1);
        await pdv.Shell.TratarErroInesperadoAsync(new InvalidOperationException("falha simulada"));
        await AmbienteUi.Pausa();
        Assert.Equal("Ocorreu um erro. A venda foi preservada.", pdv.Texto("TextoErroGlobal"));
        Assert.Single(venda.Itens);
        Assert.Equal("12,90", pdv.Texto("TextoTotal"));
    }

    [AvaloniaFact]
    public async Task Desconto_acima_do_limite_do_operador_pede_supervisor_e_dentro_e_aplicado()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("10*0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1);
        pdv.Tecla(Key.F6);
        await AmbienteUi.Pausa();
        pdv.Tecla(Key.D2);
        await pdv.EsperarFocoAsync("CampoDesconto");
        pdv.Digitar("15%");
        pdv.Tecla(Key.Enter);
        // Acima dos 10% da MARIA: a liberação do supervisor (PDV 31.3; C10a); Esc desiste sem aplicar.
        await pdv.EsperarFocoAsync("CampoSupervisor");
        Assert.IsType<DialogoLiberacaoViewModel>(venda.Dialogo);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null);
        Assert.Equal("129,00", pdv.Texto("TextoTotal"));
        pdv.Tecla(Key.F6);
        await AmbienteUi.Pausa();
        pdv.Tecla(Key.D2);
        await pdv.EsperarFocoAsync("CampoDesconto");
        pdv.Digitar("10%");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null);
        Assert.Equal("116,10", pdv.Texto("TextoTotal"));
        Assert.Equal("-12,90", venda.DescontosTexto);
    }

    [AvaloniaFact]
    public async Task Diminuir_quantidade_com_desconto_acima_do_limite_e_recusado_e_auditoria_vai_no_mesmo_commit()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("5*0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1);
        var servico = pdv.Servicos.GetRequiredService<ServicoVenda>();
        var fabrica = pdv.Servicos.GetRequiredService<FabricaPdvDb>();
        var ct = TestContext.Current.CancellationToken;

        Assert.True((await servico.DescontoItemAsync(1, Desconto.EmPercentual(10m), ct: ct)).Aplicado);
        await using (var db = fabrica.CreateDbContext())
        {
            Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(a => a.Acao == "desconto_item", ct));
            Assert.Equal(6.45m, (await db.ItensVenda.SingleAsync(ct)).DescontoItem);
        }

        // MARIA tem 10%: os R$ 6,45 em 1 unidade de 12,90 seriam 50%.
        await Assert.ThrowsAsync<RegraNegocioException>(() => servico.AlterarQuantidadeAsync(1, 1m, ct));
        Assert.Equal(5m, servico.Atual!.ObterItem(1).Quantidade);
        await using (var db = fabrica.CreateDbContext())
        {
            Assert.Equal(5m, (await db.ItensVenda.SingleAsync(ct)).Quantidade);
        }

        await venda.RemoverDescontoItemAsync(1);
        await servico.AlterarQuantidadeAsync(1, 1m, ct);
        Assert.Equal(12.90m, servico.Atual!.Total);
    }

    [AvaloniaFact]
    public async Task Capturas_de_tela_do_fluxo_completo()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("12*7891149103102");
        await pdv.EntrarCodigoAsync("7896045506873");
        await pdv.EntrarCodigoAsync("2*7896045506873");
        await pdv.EntrarCodigoAsync("0,795*0050");
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 5);
        pdv.Tecla(Key.Up);
        pdv.Tecla(Key.Up);
        pdv.Tecla(Key.Up);
        pdv.Tecla(Key.F4);
        await pdv.EsperarFocoAsync("CampoSequencia");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null);
        await AmbienteUi.Pausa();
        pdv.Captura("05-venda-itens");

        pdv.Tecla(Key.F2);
        await pdv.EsperarFocoAsync("CampoPesquisa");
        pdv.Digitar("cerv");
        await AmbienteUi.Pausa();
        pdv.Captura("06-pesquisa");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("CampoCodigo");

        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("100");
        await AmbienteUi.Pausa();
        pdv.Captura("07-pagamento");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.CaixaLivre && venda.Dialogo is null);
        await AmbienteUi.Pausa();
        pdv.Captura("08-troco-cupom");

        pdv.Tecla(Key.T, RawInputModifiers.Control | RawInputModifiers.Alt);
        await pdv.EntrarCodigoAsync("3*7891149103102");
        await pdv.EntrarCodigoAsync("0077");
        await pdv.EsperarAsync(() => venda.Itens.Count == 2);
        await AmbienteUi.Pausa();
        pdv.Captura("09-venda-tema-claro");
        Assert.Equal("claro", await pdv.Servicos.GetRequiredService<RepositorioTerminal>().ObterConfiguracaoAsync<string>("tela.tema", TestContext.Current.CancellationToken));
        pdv.Tecla(Key.T, RawInputModifiers.Control | RawInputModifiers.Alt);
    }
}
