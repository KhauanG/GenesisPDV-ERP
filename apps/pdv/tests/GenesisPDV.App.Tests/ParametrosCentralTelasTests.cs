using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.Threading;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.App.ViewModels;
using GenesisPDV.App.ViewModels.Central;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Backup;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Central do PDV, bloco G11 (plano 4.5 e 7; PC-2 e PC-13; README › decisão 75), no terminal de demonstração: a aba 7
/// Parâmetros (os do caixa com a validação, o teste da pasta e a auditoria antes/depois; as regras da loja só leitura,
/// com a origem e o "definido no ERP"), a aba 8 Backup (a lista e o "Fazer backup agora" que deixa o Painel verde), o
/// bloqueio da tela por inatividade (desligado por padrão; o PIN do operador ou o supervisor desbloqueia; a venda em
/// andamento fica como estava) e o Ctrl+Alt+T auditado.
/// </summary>
public class ParametrosCentralTelasTests
{
    private static readonly Guid Maria = Guid.Parse("019a0003-0000-7000-8000-000000000001");
    private static readonly Guid Carlos = Guid.Parse("019a0003-0000-7000-8000-000000000002");

    /// <summary>O CARLOS da demonstração (Master), para gravar os parâmetros pelo serviço nos testes do bloqueio.</summary>
    private static readonly Operador CarlosMaster = new(Carlos, 2, "carlos", "CARLOS", 100m, Master: true);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<List<LogAuditoriaLocal>> AuditoriaAsync(AmbienteUi pdv, string acao)
    {
        await using var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
        return await db.LogAuditoriaLocal.AsNoTracking().Where(a => a.Acao == acao).OrderBy(a => a.OcorridoEm).ToListAsync(Ct);
    }

    private static async Task<List<string>> CodigosOcorrenciasAsync(AmbienteUi pdv)
    {
        await using var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
        return [.. (await db.LogLocal.AsNoTracking().Select(l => l.Detalhes).ToListAsync(Ct)).Select(Ocorrencias.CodigoDe).OfType<string>()];
    }

    private static async Task<AbaParametrosViewModel> AbrirParametrosAsync(AmbienteUi pdv, CentralPdvViewModel central)
    {
        pdv.Tecla(Key.D7);
        await pdv.EsperarAsync(() => central.Conteudo is AbaParametrosViewModel { Ocupado: false, Regras.Count: > 0 }, "aba 7 Parâmetros");
        await pdv.EsperarFocoAsync("CampoBloqueioMinutos");
        return (AbaParametrosViewModel)central.Conteudo!;
    }

    [AvaloniaFact]
    public async Task Gerente_troca_a_pasta_secundaria_testada_faz_backup_agora_e_o_painel_fica_verde()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        // O "pendrive" fica fora da pasta do PDV (a de dentro é recusada).
        using var fora = new PastaFora();
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Shell.IrParaLogin();
        var central = await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        var aba = await AbrirParametrosAsync(pdv, central);

        // Os do caixa como estão (o padrão: tema escuro, bloqueio desligado, sem pasta secundária) e as regras da loja só
        // leitura: o valor que vale, a origem (sem nuvem, o padrão) e onde mudar no ERP (spec 6.9).
        Assert.Equal("0", aba.BloqueioMinutos);
        Assert.Equal(0, aba.TemaIndice);
        Assert.Empty(aba.PastaSecundaria);
        Assert.Equal(CatalogoRotulosConfiguracao.Todos.Count, aba.Regras.Count);
        var cego = aba.Regras.Single(r => r.Chave == ChavesConfiguracao.FechamentoCego);
        Assert.Equal("Sim", cego.Valor);
        Assert.Contains("padrão", cego.Origem, StringComparison.Ordinal);
        Assert.Equal("ERP › Cadastros › Configurações › PDV (por loja: Lojas › Parâmetros)", cego.OndeMudar);
        Assert.Contains("demonstração", aba.UltimoPullTexto, StringComparison.Ordinal);
        Assert.Contains("sem cifra", pdv.Texto("TextoAvisoPasta"), StringComparison.Ordinal);
        Assert.All(new[] { "BotaoSalvarParametros", "BotaoTestarPasta", "BotaoAtualizarParametros" },
            b => Assert.True(pdv.Controle<Button>(b).Bounds.Height >= 44, $"{b} grande o bastante para o mouse"));
        pdv.Captura("80-central-parametros");

        // A pasta errada não grava nada: sem o caminho completo, a pasta do próprio PDV e um arquivo no lugar da pasta.
        aba.PastaSecundaria = "pendrive";
        pdv.Tecla(Key.F2);
        await pdv.EsperarAsync(() => aba.Erro is not null, "caminho incompleto recusado");
        Assert.Contains("caminho completo", aba.Erro, StringComparison.Ordinal);
        aba.PastaSecundaria = Path.Combine(pdv.Caminhos.PastaBackup, "copia");
        pdv.Clicar(pdv.Controle<Button>("BotaoTestarPasta"));
        await pdv.EsperarAsync(() => aba.Erro is not null && !aba.Ocupado, "pasta do PDV recusada");
        Assert.Contains("fora do GenesisPDV", aba.Erro, StringComparison.Ordinal);
        var arquivo = Path.Combine(fora.Caminho, "nao-e-pasta");
        await File.WriteAllTextAsync(arquivo, "x", Ct);
        aba.PastaSecundaria = arquivo;
        pdv.Tecla(Key.F2);
        await pdv.EsperarAsync(() => aba.Erro is not null && !aba.Ocupado, "pasta sem gravação recusada");
        Assert.Contains("não deu para gravar", aba.Erro, StringComparison.Ordinal);
        Assert.Empty(await AuditoriaAsync(pdv, "editar"));
        Assert.Null(await pdv.Servicos.GetRequiredService<BackupLocal>().PastaSecundariaAsync(Ct));

        // O pendrive: F6 testa (grava e apaga o arquivo de teste), F2 grava com a auditoria antes/depois só do que mudou.
        var pendrive = Path.Combine(fora.Caminho, "pendrive");
        aba.PastaSecundaria = pendrive;
        pdv.Tecla(Key.F6);
        await pdv.EsperarAsync(() => aba.Mensagem is not null && !aba.Ocupado, "pasta testada");
        Assert.Contains("funciona", aba.Mensagem, StringComparison.Ordinal);
        Assert.Empty(Directory.GetFiles(pendrive));
        aba.BloqueioMinutos = "15";
        pdv.Clicar(pdv.Controle<Button>("BotaoSalvarParametros"));
        await pdv.EsperarAsync(() => aba.Mensagem?.StartsWith(AbaParametrosViewModel.MensagemSalvo, StringComparison.Ordinal) == true, "gravado");
        var editar = Assert.Single(await AuditoriaAsync(pdv, "editar"));
        Assert.Equal("configuracao_terminal", editar.Entidade);
        Assert.Equal(Carlos, editar.UsuarioId);
        Assert.Equal(ServicoParametrosLocais.LocalizacaoCentral, editar.Localizacao);
        Assert.Equal(new JsonObject { [ServicoParametrosLocais.ChaveBloqueioInatividade] = 0, [BackupLocal.ChavePastaSecundaria] = null }.ToJsonString(), editar.Antes);
        // A pasta vai pelo mascarador (no Windows o %TEMP% do perfil vira %USERPROFILE%); a configuração guarda o caminho inteiro.
        Assert.Equal(new JsonObject { [ServicoParametrosLocais.ChaveBloqueioInatividade] = 15, [BackupLocal.ChavePastaSecundaria] = MascaradorSuporte.Mascarar(pendrive) }.ToJsonString(), editar.Depois);
        Assert.Equal(pendrive, (await pdv.Servicos.GetRequiredService<ServicoParametrosLocais>().LerAsync(Ct)).PastaSecundaria);
        Assert.Contains(CodigoOcorrencia.ParametroAlterado.Codigo, await CodigosOcorrenciasAsync(pdv));
        Assert.Equal(TimeSpan.FromMinutes(15), pdv.Servicos.GetRequiredService<ServicoParametrosLocais>().BloqueioInatividade);
        // Gravar de novo o mesmo não grava nada.
        pdv.Tecla(Key.F2);
        await pdv.EsperarAsync(() => aba.Erro == ServicoParametrosLocais.MensagemNadaMudou, "nada mudou");
        Assert.Single(await AuditoriaAsync(pdv, "editar"));
        // Só os minutos mudam: a mensagem fala só deles, sem prometer o teste da pasta (que não rodou).
        aba.BloqueioMinutos = "20";
        pdv.Tecla(Key.F2);
        await pdv.EsperarAsync(() => aba.Mensagem?.StartsWith(AbaParametrosViewModel.MensagemSalvo, StringComparison.Ordinal) == true, "só os minutos");
        Assert.Contains("20 min sem uso", aba.Mensagem, StringComparison.Ordinal);
        Assert.DoesNotContain("testada", aba.Mensagem, StringComparison.Ordinal);
        Assert.Equal("""{"tela.bloqueio_inatividade_min":20}""", (await AuditoriaAsync(pdv, "editar"))[^1].Depois);

        // A aba 8: F5 faz o backup agora, nas duas pastas; a lista diz onde; a auditoria `criar` do backup_local.
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "7", "menu");
        pdv.Tecla(Key.D8);
        await pdv.EsperarAsync(() => central.Conteudo is AbaBackupViewModel { Ocupado: false, PastaTexto: not null }, "aba 8 Backup");
        var backup = (AbaBackupViewModel)central.Conteudo!;
        await pdv.EsperarFocoAsync(Views.Central.AbaBackupView.NomeTela);
        Assert.Contains("pendrive", backup.PastaTexto, StringComparison.Ordinal);
        Assert.True(backup.MostraRestaurar);
        pdv.Tecla(Key.F5);
        await pdv.EsperarAsync(() => backup.Mensagem is not null && !backup.Ocupado, "backup feito");
        Assert.Contains("Backup feito agora", backup.Mensagem, StringComparison.Ordinal);
        Assert.Contains("cópia na pasta secundária", backup.Mensagem, StringComparison.Ordinal);
        var linha = Assert.Single(backup.Backups, b => b.Nome.EndsWith("-manual.db.gz", StringComparison.Ordinal));
        Assert.Equal("feito agora (manual)", linha.Motivo);
        Assert.Equal("pasta do PDV e secundária", linha.Onde);
        Assert.Single(Directory.GetFiles(Directory.GetDirectories(pendrive).Single(), "*-manual.db.gz"));
        var criar = Assert.Single(await AuditoriaAsync(pdv, "criar"));
        Assert.Equal(ServicoBackup.EntidadeBackup, criar.Entidade);
        Assert.Equal(Carlos, criar.UsuarioId);
        Assert.Equal(AbaBackupViewModel.Localizacao, criar.Localizacao);
        Assert.Contains(CodigoOcorrencia.BackupManual.Codigo, await CodigosOcorrenciasAsync(pdv));
        Assert.Contains("Último backup que deu certo", backup.UltimoSucessoTexto, StringComparison.Ordinal);
        pdv.Captura("81-central-backup");

        // O Painel de saúde fica verde no backup.
        var verificacao = pdv.Servicos.GetServices<IVerificacaoSaude>().Single(v => v.Codigo == "backup");
        Assert.Equal(NivelSaude.Ok, (await verificacao.VerificarAsync(true, Ct)).Nivel);
    }

    [AvaloniaFact]
    public async Task Operadora_ve_pela_liberacao_e_gravar_ou_fazer_backup_pede_o_supervisor_na_hora()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.D8);
        var central = await pdv.EsperarCentralAsync();

        // A MARIA não vê os parâmetros (pdv.diagnostico.ver): o cadeado pede o supervisor, que empresta só o ver.
        Assert.True(central.Abas.Single(a => a.Codigo == "7").Bloqueada);
        pdv.Clicar(pdv.BotaoDaAba("7"));
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "2";
        central.PinLiberacao = "4321";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => central.Conteudo is AbaParametrosViewModel { Ocupado: false, Regras.Count: > 0 }, "aba 7 pela liberação");
        var aba = (AbaParametrosViewModel)central.Conteudo!;
        Assert.Contains("supervisor libera na hora", aba.PermissaoTexto, StringComparison.Ordinal);

        // Gravar pede o supervisor na hora (31.3: usuário, PIN e motivo), sobre a aba; Esc fecha sem gravar.
        aba.BloqueioMinutos = "10";
        pdv.Tecla(Key.F2);
        await pdv.EsperarAsync(() => aba.Liberacao is not null, "pedido do supervisor");
        await pdv.EsperarFocoAsync("CampoSupervisor");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => aba.Liberacao is null, "pedido fechado");
        Assert.Empty(await AuditoriaAsync(pdv, "editar"));
        pdv.Clicar(pdv.Controle<Button>("BotaoSalvarParametros"));
        await pdv.EsperarAsync(() => aba.Liberacao is not null, "pedido de novo");
        aba.Liberacao!.Usuario = "2";
        aba.Liberacao.Pin = "4321";
        aba.Liberacao.Motivo = "Ligar o bloqueio do caixa";
        await aba.Liberacao.ConfirmarCommand.ExecuteAsync(null);
        await pdv.EsperarAsync(() => aba.Mensagem?.Contains("Liberado por CARLOS", StringComparison.Ordinal) == true, "gravado com o CARLOS");
        var editar = Assert.Single(await AuditoriaAsync(pdv, "editar"));
        Assert.Equal(Maria, editar.UsuarioId);
        Assert.Equal(Carlos, editar.AutorizadoPorId);
        Assert.Equal("Ligar o bloqueio do caixa", editar.Motivo);

        // A aba 8: sem o F9 pela venda; F5 pede o supervisor e, liberado, faz o backup agora (sem venda em andamento).
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "7", "menu");
        pdv.Tecla(Key.D8);
        await pdv.EsperarAsync(() => central.Conteudo is AbaBackupViewModel { Ocupado: false, PastaTexto: not null }, "aba 8 pela liberação");
        var backup = (AbaBackupViewModel)central.Conteudo!;
        Assert.False(backup.MostraRestaurar);
        pdv.Clicar(pdv.Controle<Button>("BotaoFazerBackupAgora"));
        await pdv.EsperarAsync(() => backup.Liberacao is not null, "pedido do supervisor no backup");
        backup.Liberacao!.Usuario = "2";
        backup.Liberacao.Pin = "4321";
        backup.Liberacao.Motivo = "Antes de trocar o pendrive";
        await backup.Liberacao.ConfirmarCommand.ExecuteAsync(null);
        await pdv.EsperarAsync(() => backup.Mensagem?.Contains("Backup feito agora", StringComparison.Ordinal) == true, "backup liberado");
        var criar = Assert.Single(await AuditoriaAsync(pdv, "criar"));
        Assert.Equal(Maria, criar.UsuarioId);
        Assert.Equal(Carlos, criar.AutorizadoPorId);
    }

    [AvaloniaFact]
    public async Task Backup_agora_recusa_com_a_venda_em_andamento()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "1 item");
        var servico = pdv.Servicos.GetRequiredService<ServicoBackup>();
        var e = await Assert.ThrowsAsync<RegraNegocioException>(() => servico.FazerAgoraAsync(Carlos, null, null, AbaBackupViewModel.Localizacao, Ct));
        Assert.Equal(ServicoBackup.MensagemVendaEmAndamento, e.Message);
        Assert.DoesNotContain(BackupLocal.Listar(pdv.Caminhos.PastaBackup), a => a.Motivo == MotivosBackup.Manual);
        Assert.Empty(await AuditoriaAsync(pdv, "criar"));

        // Pela tela, sem a permissão: a recusa vem antes do PIN do supervisor (ele não libera o que vai ser recusado). A
        // Central da venda não abre com a venda em andamento; a do login abre, com a venda gravada no caixa aberto.
        pdv.Shell.IrParaLogin();
        var central = await pdv.EntrarNaCentralPeloLoginAsync("1", "1234");
        pdv.Clicar(pdv.BotaoDaAba("8"));
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "2";
        central.PinLiberacao = "4321";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => central.Conteudo is AbaBackupViewModel { Ocupado: false, PastaTexto: not null }, "aba 8 pela liberação");
        var aba = (AbaBackupViewModel)central.Conteudo!;
        pdv.Clicar(pdv.Controle<Button>("BotaoFazerBackupAgora"));
        await pdv.EsperarAsync(() => aba.Erro is not null && !aba.Ocupado, "recusado antes do PIN");
        Assert.Equal(ServicoBackup.MensagemVendaEmAndamento, aba.Erro);
        Assert.Null(aba.Liberacao);
        Assert.Empty(await AuditoriaAsync(pdv, "criar"));
    }

    [AvaloniaFact]
    public async Task Bloqueio_por_inatividade_desligado_por_padrao_bloqueia_e_o_pin_da_operadora_desbloqueia_com_a_venda_como_estava()
    {
        var tempo = new Tempo();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<TimeProvider>(tempo));
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "1 item");

        // Desligado por padrão (PC-13): uma hora sem uso não bloqueia.
        Assert.Null(pdv.Servicos.GetRequiredService<ServicoParametrosLocais>().BloqueioInatividade);
        tempo.Avancar(TimeSpan.FromHours(1));
        await Task.Delay(1_300, Ct);
        await AmbienteUi.Pausa();
        Assert.Same(venda, pdv.Shell.PaginaAtual);

        // Ligado em 10 min: a tecla zera a contagem; 10 min sem nada bloqueia, com a venda guardada.
        await pdv.Servicos.GetRequiredService<ServicoParametrosLocais>().GravarAsync(new ParametrosCaixa(BloqueioInatividadeMin: 10), CarlosMaster, null, Ct);
        pdv.Tecla(Key.Down);
        tempo.Avancar(TimeSpan.FromMinutes(9));
        await Task.Delay(1_300, Ct);
        await AmbienteUi.Pausa();
        Assert.Same(venda, pdv.Shell.PaginaAtual);
        tempo.Avancar(TimeSpan.FromMinutes(1));
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is TelaBloqueadaViewModel, "tela bloqueada");
        var tela = (TelaBloqueadaViewModel)pdv.Shell.PaginaAtual!;
        await pdv.EsperarFocoAsync("CampoPinDesbloqueio");
        Assert.Equal(BloqueioTela.ComoInatividade, tela.Como);
        Assert.Contains("10 min sem uso", tela.Descricao, StringComparison.Ordinal);
        Assert.NotNull(tela.VendaTexto);
        Assert.Contains("MARIA", pdv.Texto("TextoOperadorBloqueio"), StringComparison.Ordinal);
        var bloqueio = Assert.Single(await AuditoriaAsync(pdv, BloqueioTela.AcaoBloqueio));
        Assert.Equal(Maria, bloqueio.UsuarioId);
        Assert.Equal("""{"como":"inatividade","minutos":10}""", bloqueio.Depois);
        // A entidade própria: no ERP, `bloqueio` de `usuarios` é a conta bloqueada por tentativas.
        Assert.Equal(BloqueioTela.Entidade, bloqueio.Entidade);
        pdv.Captura("82-tela-bloqueada");

        // As teclas da venda não chegam atrás do bloqueio (o F10 não conclui, o F11 não abre nada).
        pdv.Tecla(Key.F10);
        pdv.Tecla(Key.F11);
        await AmbienteUi.Pausa();
        Assert.Same(tela, pdv.Shell.PaginaAtual);
        Assert.Null(venda.Dialogo);

        // O PIN errado não desbloqueia (conta no bloqueio por tentativas do login); o certo volta à mesma venda.
        pdv.Digitar("9999");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => tela.Erro is not null, "PIN recusado");
        Assert.Equal(TelaBloqueadaViewModel.MensagemPinErrado, tela.Erro);
        Assert.Same(tela, pdv.Shell.PaginaAtual);
        // O PIN errado deixa rastro, como no login e na Central: o login_negado sobe e vira historico_logins no ERP.
        var negado = Assert.Single(await AuditoriaAsync(pdv, "login_negado"));
        Assert.Equal((BloqueioTela.Entidade, BloqueioTela.Localizacao), (negado.Entidade, negado.Localizacao));
        Assert.Equal("""{"login_informado":"maria"}""", negado.Depois);
        Assert.Contains("login_negado", Sync.Push.CatalogosNuvem.AcoesAuditoria);
        pdv.Digitar("1234");
        pdv.Clicar(pdv.Controle<Button>("BotaoDesbloquear"));
        await pdv.EsperarAsync(() => ReferenceEquals(pdv.Shell.PaginaAtual, venda), "de volta à venda");
        await pdv.EsperarFocoAsync("CampoCodigo");
        Assert.Single(venda.Itens);
        var desbloqueio = Assert.Single(await AuditoriaAsync(pdv, BloqueioTela.AcaoDesbloqueio));
        Assert.Equal(Maria, desbloqueio.UsuarioId);
        Assert.Null(desbloqueio.AutorizadoPorId);
        // O desbloqueio é só local (fora do catálogo da nuvem, como o central_acessada); o bloqueio sobe.
        Assert.DoesNotContain(BloqueioTela.AcaoDesbloqueio, Sync.Push.CatalogosNuvem.AcoesAuditoria);
        Assert.Contains(BloqueioTela.AcaoBloqueio, Sync.Push.CatalogosNuvem.AcoesAuditoria);

        // O desbloqueio conta como uso: 5 min depois a venda continua.
        tempo.Avancar(TimeSpan.FromMinutes(5));
        await Task.Delay(1_300, Ct);
        await AmbienteUi.Pausa();
        Assert.Same(venda, pdv.Shell.PaginaAtual);
    }

    [AvaloniaFact]
    public async Task Central_aberta_pela_venda_bloqueia_por_inatividade_e_o_desbloqueio_volta_a_venda()
    {
        var tempo = new Tempo();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<TimeProvider>(tempo));
        await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.Servicos.GetRequiredService<ServicoParametrosLocais>().GravarAsync(new ParametrosCaixa(BloqueioInatividadeMin: 10), CarlosMaster, null, Ct);
        pdv.Clicar(pdv.BotaoDaBarra(VendaViewModel.TeclaCentral));
        await pdv.EsperarCentralAsync();

        // A Central da venda é do operador logado: bloqueia como a venda, e a troca de página encerra a Central.
        tempo.Avancar(TimeSpan.FromMinutes(10));
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is TelaBloqueadaViewModel, "a Central bloqueada");
        Assert.False(pdv.Servicos.GetRequiredService<AcessoCentral>().Aberta);
        await pdv.EsperarFocoAsync("CampoPinDesbloqueio");
        pdv.Digitar("1234");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "a venda depois da Central bloqueada");
        await pdv.EsperarFocoAsync("CampoCodigo");

        // A Central aberta pelo login não tem operador no caixa: não bloqueia (a liberação dela acaba sozinha em 5 min).
        pdv.Shell.IrParaLogin();
        await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        pdv.Servicos.GetRequiredService<SessaoTerminal>().Operador = null;
        tempo.Avancar(TimeSpan.FromMinutes(30));
        await Task.Delay(1_300, Ct);
        await AmbienteUi.Pausa();
        Assert.IsType<CentralPdvViewModel>(pdv.Shell.PaginaAtual);
    }

    [AvaloniaFact]
    public async Task Ctrl_alt_b_bloqueia_na_hora_e_o_supervisor_desbloqueia()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();

        // F11 › 7 e Ctrl+Alt+B bloqueiam mesmo com o bloqueio por inatividade desligado.
        pdv.Tecla(Key.B, RawInputModifiers.Control | RawInputModifiers.Alt);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is TelaBloqueadaViewModel, "tela bloqueada");
        var tela = (TelaBloqueadaViewModel)pdv.Shell.PaginaAtual!;
        Assert.Equal(BloqueioTela.ComoManual, tela.Como);
        Assert.Null(tela.VendaTexto);
        Assert.Equal("""{"como":"manual","minutos":null}""", Assert.Single(await AuditoriaAsync(pdv, BloqueioTela.AcaoBloqueio)).Depois);

        // F2: o supervisor. A própria MARIA não desbloqueia por ali; o CARLOS sim (no autorizado_por_id). Esc volta ao PIN.
        pdv.Tecla(Key.F2);
        await pdv.EsperarFocoAsync("CampoSupervisorDesbloqueio");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("CampoPinDesbloqueio");
        Assert.False(tela.PeloSupervisor);
        pdv.Clicar(pdv.Controle<Button>("BotaoSupervisorDesbloqueia"));
        await pdv.EsperarFocoAsync("CampoSupervisorDesbloqueio");
        tela.UsuarioSupervisor = "1";
        tela.PinSupervisor = "1234";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => tela.Erro is not null, "a própria operadora recusada");
        Assert.Same(tela, pdv.Shell.PaginaAtual);
        // A recusa do supervisor também fica (o usuário digitado no login_informado).
        Assert.Equal("""{"login_informado":"1"}""", Assert.Single(await AuditoriaAsync(pdv, "login_negado")).Depois);
        tela.UsuarioSupervisor = "2";
        tela.PinSupervisor = "4321";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => ReferenceEquals(pdv.Shell.PaginaAtual, venda), "de volta à venda");
        // A sessão da MARIA reaberta com o PIN do CARLOS é uma liberação (no catálogo; sobe), não o desbloqueio só local.
        Assert.Empty(await AuditoriaAsync(pdv, BloqueioTela.AcaoDesbloqueio));
        var liberacao = Assert.Single(await AuditoriaAsync(pdv, "liberacao"));
        Assert.Equal((Maria, Carlos, BloqueioTela.Entidade), (liberacao.UsuarioId, liberacao.AutorizadoPorId, liberacao.Entidade));
        Assert.Equal("""{"como":"supervisor"}""", liberacao.Depois);
        Assert.Contains("liberacao", Sync.Push.CatalogosNuvem.AcoesAuditoria);

        // Pelo F11 › 7 (o botão também).
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Clicar(pdv.Controle<Button>("OpcaoFuncao7"));
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is TelaBloqueadaViewModel, "bloqueada pelo F11 › 7");
    }

    [AvaloniaFact]
    public async Task Ctrl_alt_t_troca_o_tema_sem_permissao_com_a_auditoria()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Tecla(Key.T, RawInputModifiers.Control | RawInputModifiers.Alt);
        await pdv.EsperarAsync(() => pdv.Servicos.GetRequiredService<ServicoTema>().Atual == ServicoTema.Claro, "tema claro");
        var editar = Assert.Single(await AuditoriaAsync(pdv, "editar"));
        Assert.Equal(Maria, editar.UsuarioId);
        Assert.Equal(ServicoParametrosLocais.LocalizacaoTema, editar.Localizacao);
        Assert.Equal("""{"tela.tema":"escuro"}""", editar.Antes);
        Assert.Equal("""{"tela.tema":"claro"}""", editar.Depois);
        Assert.Equal(ServicoTema.Claro, (await pdv.Servicos.GetRequiredService<ServicoParametrosLocais>().LerAsync(Ct)).Tema);
    }

    [AvaloniaFact]
    public async Task Parametros_validam_a_faixa_e_a_pasta_do_proprio_pdv()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        var servico = pdv.Servicos.GetRequiredService<ServicoParametrosLocais>();
        var maria = pdv.Servicos.GetRequiredService<SessaoTerminal>().Operador!;
        await Assert.ThrowsAsync<RegraNegocioException>(() => servico.GravarAsync(new ParametrosCaixa(BloqueioInatividadeMin: 121), CarlosMaster, null, Ct));
        await Assert.ThrowsAsync<RegraNegocioException>(() => servico.GravarAsync(new ParametrosCaixa(BloqueioInatividadeMin: -1), CarlosMaster, null, Ct));
        var semPermissao = await Assert.ThrowsAsync<RegraNegocioException>(() => servico.GravarAsync(new ParametrosCaixa(BloqueioInatividadeMin: 5), maria, null, Ct));
        Assert.Equal(ServicoParametrosLocais.MensagemSemPermissao, semPermissao.Message);
        Assert.Null(servico.ValidarPasta(null));
        Assert.Null(servico.ValidarPasta(Path.Combine(pdv.Raiz, "..", "pendrive")));
        Assert.NotNull(servico.ValidarPasta("backup"));
        Assert.NotNull(servico.ValidarPasta(pdv.Caminhos.PastaDados));
        Assert.NotNull(servico.ValidarPasta(Path.Combine(pdv.Caminhos.PastaLogs, "x")));
        Assert.NotNull(servico.ValidarPasta(pdv.Raiz));
        Assert.Empty(await AuditoriaAsync(pdv, "editar"));
        Assert.Equal(ParametrosCaixa.Padrao, await servico.LerAsync(Ct));
    }

    /// <summary>
    /// O "Fazer backup agora" com outro backup em curso (o periódico, preso no meio): a aba diz que espera, a tela continua
    /// respondendo e o backup manual roda fora da thread da tela (a cópia online e o sha256 são síncronos: na thread da
    /// tela, o Windows mostraria "Não respondendo").
    /// </summary>
    [AvaloniaFact]
    public async Task Backup_agora_roda_fora_da_thread_da_tela_e_espera_o_backup_em_curso()
    {
        var relogio = new RelogioDoBackup();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton(sp => new BackupLocal(
            sp.GetRequiredService<FabricaPdvDb>(), sp.GetRequiredService<CaminhosPdv>(), relogio, sp.GetRequiredService<OpcoesBackup>())));
        await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Shell.IrParaLogin();
        var central = await pdv.EntrarNaCentralPeloLoginAsync("2", "4321");
        pdv.Tecla(Key.D8);
        await pdv.EsperarAsync(() => central.Conteudo is AbaBackupViewModel { Ocupado: false, PastaTexto: not null }, "aba 8 Backup");
        var aba = (AbaBackupViewModel)central.Conteudo!;
        await pdv.EsperarFocoAsync(Views.Central.AbaBackupView.NomeTela);

        relogio.Prender();
        var periodico = Task.Run(() => pdv.Servicos.GetRequiredService<ServicoBackup>().TentarAsync(MotivosBackup.Periodico, Ct), Ct);
        await pdv.EsperarAsync(() => relogio.Presos == 1, "o periódico em curso");
        relogio.ZerarChamadas();
        pdv.Tecla(Key.F5);
        await pdv.EsperarAsync(() => aba.Andamento?.Contains("Esperando o backup", StringComparison.Ordinal) == true, "esperando o backup em curso");
        Assert.True(pdv.Controle<TextBlock>("TextoAndamentoBackup").IsVisible);
        await Task.Delay(300, Ct);
        await AmbienteUi.Pausa();
        Assert.True(aba.Ocupado);
        Assert.Null(aba.Mensagem);

        relogio.Soltar();
        Assert.NotNull(await periodico);
        await pdv.EsperarAsync(() => aba.Mensagem is not null && !aba.Ocupado, "o backup agora, depois do periódico", 30_000);
        Assert.Contains("Backup feito agora", aba.Mensagem, StringComparison.Ordinal);
        Assert.Null(aba.Andamento);
        // O backup manual leu o relógio (o começo dele, já com a trava) fora da thread da tela.
        Assert.NotEmpty(relogio.Chamadas);
        Assert.DoesNotContain(true, relogio.Chamadas);
        var motivos = BackupLocal.Listar(pdv.Caminhos.PastaBackup).Select(a => a.Motivo).ToList();
        Assert.Contains(MotivosBackup.Manual, motivos);
        Assert.Contains(MotivosBackup.Periodico, motivos);
    }

    /// <summary>
    /// O backup feito e o registro recusado: pelo banco (o SQLite ocupado, simulado por um gatilho) ou pela D22. O backup
    /// está na pasta e no <c>ultimo_backup_em</c>: a tela avisa, não diz "não deu certo". Na D22 a tela também bloqueia e
    /// desbloqueia (as auditorias recusadas não prendem o caixa).
    /// </summary>
    [AvaloniaFact]
    public async Task Backup_agora_com_o_registro_recusado_avisa_e_na_d22_a_tela_bloqueia_e_desbloqueia()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        var servico = pdv.Servicos.GetRequiredService<ServicoBackup>();
        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            await db.Database.ExecuteSqlRawAsync(
                "CREATE TRIGGER teste_recusa_backup BEFORE INSERT ON log_auditoria_local WHEN NEW.entidade = 'backup_local' "
                + "BEGIN SELECT RAISE(ABORT, 'database is locked (teste)'); END;", Ct);
        }

        var r = await servico.FazerAgoraAsync(Carlos, null, null, AbaBackupViewModel.Localizacao, Ct);
        Assert.True(File.Exists(r.Backup.Arquivo));
        Assert.StartsWith("O backup foi feito, mas não ficou registrado no histórico", r.Aviso, StringComparison.Ordinal);
        Assert.NotNull((await pdv.Servicos.GetRequiredService<RepositorioTerminal>().ObterIdentidadeAsync(Ct))!.UltimoBackupEm);
        Assert.Empty(await AuditoriaAsync(pdv, "criar"));

        await using (var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext())
        {
            await db.Database.ExecuteSqlRawAsync("DROP TRIGGER teste_recusa_backup;", Ct);
            // D22 só no banco: os gatilhos recusam toda auditoria até a resposta da desativação.
            Assert.Equal(1, await db.EstadoConexao.ExecuteUpdateAsync(e => e.SetProperty(x => x.ConfirmandoDesativacaoEm, DateTimeOffset.UtcNow), Ct));
        }

        r = await servico.FazerAgoraAsync(Carlos, null, null, AbaBackupViewModel.Localizacao, Ct);
        Assert.True(File.Exists(r.Backup.Arquivo));
        Assert.StartsWith("O backup foi feito, mas não ficou registrado no histórico", r.Aviso, StringComparison.Ordinal);

        pdv.Tecla(Key.B, RawInputModifiers.Control | RawInputModifiers.Alt);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is TelaBloqueadaViewModel, "bloqueada na D22");
        await pdv.EsperarFocoAsync("CampoPinDesbloqueio");
        pdv.Digitar("1234");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => ReferenceEquals(pdv.Shell.PaginaAtual, venda), "desbloqueada na D22");
        Assert.Empty(await AuditoriaAsync(pdv, BloqueioTela.AcaoBloqueio));
        Assert.Empty(await AuditoriaAsync(pdv, BloqueioTela.AcaoDesbloqueio));
        Assert.Empty(await AuditoriaAsync(pdv, "criar"));
    }

    /// <summary>
    /// O Ctrl+Alt+T muda só o tema, a partir do banco: com a memória no padrão (a leitura da abertura que falhou; aqui, os
    /// valores gravados depois dela) e uma pasta de antes do G11 fora das regras de hoje, o bloqueio e a pasta ficam.
    /// </summary>
    [AvaloniaFact]
    public async Task Ctrl_alt_t_parte_do_banco_e_nao_mexe_no_bloqueio_nem_na_pasta()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        await pdv.AtivarDemonstracaoELogarAsync();
        var terminal = pdv.Servicos.GetRequiredService<RepositorioTerminal>();
        await terminal.GravarConfiguracaoAsync(ServicoParametrosLocais.ChaveBloqueioInatividade, 15, ct: Ct);
        await terminal.GravarConfiguracaoAsync(BackupLocal.ChavePastaSecundaria, "pendrive-antigo", ct: Ct);
        var servico = pdv.Servicos.GetRequiredService<ServicoParametrosLocais>();
        Assert.Equal(ParametrosCaixa.Padrao, servico.Atual);

        pdv.Tecla(Key.T, RawInputModifiers.Control | RawInputModifiers.Alt);
        await pdv.EsperarAsync(() => pdv.Servicos.GetRequiredService<ServicoTema>().Atual == ServicoTema.Claro, "tema claro");
        var lidos = await servico.LerAsync(Ct);
        Assert.Equal(new ParametrosCaixa(ServicoTema.Claro, 15, "pendrive-antigo"), lidos);
        Assert.Equal(lidos, servico.Atual);
        var editar = Assert.Single(await AuditoriaAsync(pdv, "editar"));
        Assert.Equal("""{"tela.tema":"escuro"}""", editar.Antes);
        Assert.Equal("""{"tela.tema":"claro"}""", editar.Depois);
    }

    /// <summary>
    /// A MARIA pela liberação Ctrl+L: a faixa, o "nada mudou" e a regra da pasta vêm antes do PIN do supervisor; o F6 (que
    /// grava na pasta) pede a própria permissão; o teste de escrita vem com a liberação; e, quando a liberação da Central
    /// acaba, a aba não fica com a pasta nem com os minutos.
    /// </summary>
    [AvaloniaFact]
    public async Task Pela_liberacao_a_conferencia_vem_antes_do_pin_o_f6_nao_grava_e_a_aba_esvazia_quando_acaba()
    {
        var tempo = new Tempo();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<TimeProvider>(tempo));
        using var fora = new PastaFora();
        await pdv.AtivarDemonstracaoELogarAsync();
        var pendrive = Path.Combine(fora.Caminho, "pendrive");
        await pdv.Servicos.GetRequiredService<ServicoParametrosLocais>().GravarAsync(new ParametrosCaixa(PastaSecundaria: pendrive), CarlosMaster, null, Ct);
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.D8);
        var central = await pdv.EsperarCentralAsync();
        pdv.Clicar(pdv.BotaoDaAba("7"));
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "2";
        central.PinLiberacao = "4321";
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => central.Conteudo is AbaParametrosViewModel { Ocupado: false, Regras.Count: > 0 }, "aba 7 pela liberação");
        var aba = (AbaParametrosViewModel)central.Conteudo!;
        Assert.Equal(pendrive, aba.PastaSecundaria);

        aba.BloqueioMinutos = "999";
        pdv.Tecla(Key.F2);
        await pdv.EsperarAsync(() => aba.Erro is not null && !aba.Ocupado, "a faixa antes do PIN");
        Assert.Contains("de 0 a 120", aba.Erro, StringComparison.Ordinal);
        Assert.Null(aba.Liberacao);
        aba.BloqueioMinutos = "0";
        pdv.Tecla(Key.F2);
        await pdv.EsperarAsync(() => aba.Erro == ServicoParametrosLocais.MensagemNadaMudou && !aba.Ocupado, "nada mudou antes do PIN");
        Assert.Null(aba.Liberacao);
        aba.PastaSecundaria = "pendrive";
        pdv.Clicar(pdv.Controle<Button>("BotaoSalvarParametros"));
        await pdv.EsperarAsync(() => aba.Erro?.Contains("caminho completo", StringComparison.Ordinal) == true && !aba.Ocupado, "a pasta antes do PIN");
        Assert.Null(aba.Liberacao);

        // O F6 grava um arquivo na pasta: o ver emprestado pelo Ctrl+L não basta (e a pasta nova nem é criada).
        var nova = Path.Combine(fora.Caminho, "outra");
        aba.PastaSecundaria = nova;
        pdv.Tecla(Key.F6);
        await pdv.EsperarAsync(() => aba.Erro == AbaParametrosViewModel.MensagemTestarSemPermissao && !aba.Ocupado, "o F6 sem a permissão");
        Assert.False(Directory.Exists(nova));

        // O pedido certo chama o supervisor (sem tocar no disco); liberado, a pasta é testada e gravada.
        pdv.Tecla(Key.F2);
        await pdv.EsperarAsync(() => aba.Liberacao is not null, "o pedido do supervisor");
        Assert.False(Directory.Exists(nova));
        aba.Liberacao!.Usuario = "2";
        aba.Liberacao.Pin = "4321";
        aba.Liberacao.Motivo = "Trocar o pendrive do backup";
        await aba.Liberacao.ConfirmarCommand.ExecuteAsync(null);
        await pdv.EsperarAsync(() => aba.Mensagem?.Contains("Liberado por CARLOS", StringComparison.Ordinal) == true, "gravado com o CARLOS");
        Assert.Contains("testada agora", aba.Mensagem, StringComparison.Ordinal);
        Assert.True(Directory.Exists(nova));
        Assert.Equal(2, (await AuditoriaAsync(pdv, "editar")).Count);

        // A liberação da Central acaba sem uso: a aba não fica com o que mostrava (a pasta traz o perfil do Windows).
        tempo.Avancar(AcessoCentral.ValidadeLiberacao + TimeSpan.FromSeconds(1));
        central.Atualizar();
        Assert.Empty(aba.PastaSecundaria);
        Assert.Empty(aba.BloqueioMinutos);
        Assert.Null(aba.PermissaoTexto);
        Assert.Empty(aba.Regras);
    }

    /// <summary>O leitor de código bipando no campo do PIN: recusado sem conferir, não bloqueia a operadora por tentativas.</summary>
    [AvaloniaFact]
    public async Task Leitor_de_codigo_na_tela_bloqueada_nao_conta_como_tentativa_de_pin()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        pdv.Tecla(Key.B, RawInputModifiers.Control | RawInputModifiers.Alt);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is TelaBloqueadaViewModel, "tela bloqueada");
        var tela = (TelaBloqueadaViewModel)pdv.Shell.PaginaAtual!;
        await pdv.EsperarFocoAsync("CampoPinDesbloqueio");

        // Mais bipes que as 5 tentativas do login (PDV 7.2, regra 7).
        for (var i = 1; i <= 6; i++)
        {
            tela.Erro = null;
            pdv.Digitar("7891234567895");
            pdv.Tecla(Key.Enter);
            await pdv.EsperarAsync(() => tela.Erro == TelaBloqueadaViewModel.MensagemNaoEPin, $"bipe {i} recusado sem conferir");
            Assert.Empty(tela.Pin);
        }

        Assert.Empty(await AuditoriaAsync(pdv, "login_negado"));
        pdv.Digitar("1234");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => ReferenceEquals(pdv.Shell.PaginaAtual, venda), "o PIN certo desbloqueia");
        Assert.True(TelaBloqueadaViewModel.PareceUmPin("1234"));
        Assert.True(TelaBloqueadaViewModel.PareceUmPin("12345678"));
        Assert.False(TelaBloqueadaViewModel.PareceUmPin("123"));
        Assert.False(TelaBloqueadaViewModel.PareceUmPin("789123456"));
        Assert.False(TelaBloqueadaViewModel.PareceUmPin("12a4"));
    }

    /// <summary>
    /// No pagamento (o cliente com o QR do PIX no app do banco, a maquininha) a inatividade não bloqueia; o Ctrl+Alt+B
    /// sim, e o desbloqueio volta ao mesmo pagamento, com o foco no campo dele.
    /// </summary>
    [AvaloniaFact]
    public async Task Inatividade_nao_bloqueia_no_pagamento_e_o_bloqueio_manual_volta_ao_pagamento()
    {
        var tempo = new Tempo();
        using var pdv = await AmbienteUi.IniciarAsync(ajustar: s => s.AddSingleton<TimeProvider>(tempo));
        var venda = await pdv.AtivarDemonstracaoELogarAsync();
        await pdv.Servicos.GetRequiredService<ServicoParametrosLocais>().GravarAsync(new ParametrosCaixa(BloqueioInatividadeMin: 10), CarlosMaster, null, Ct);
        await pdv.EntrarCodigoAsync("0044");
        await pdv.EsperarAsync(() => venda.Itens.Count == 1, "1 item");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        var pagamento = Assert.IsType<DialogoPagamentoViewModel>(venda.Dialogo);

        tempo.Avancar(TimeSpan.FromMinutes(30));
        await Task.Delay(1_300, Ct);
        await AmbienteUi.Pausa();
        Assert.Same(venda, pdv.Shell.PaginaAtual);
        Assert.Same(pagamento, venda.Dialogo);
        Assert.Empty(await AuditoriaAsync(pdv, BloqueioTela.AcaoBloqueio));

        pdv.Tecla(Key.B, RawInputModifiers.Control | RawInputModifiers.Alt);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is TelaBloqueadaViewModel, "bloqueada no pagamento");
        await pdv.EsperarFocoAsync("CampoPinDesbloqueio");
        pdv.Digitar("1234");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => ReferenceEquals(pdv.Shell.PaginaAtual, venda), "de volta à venda");
        Assert.Same(pagamento, venda.Dialogo);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
    }

    /// <summary>A pasta passa pelo mascarador na auditoria (que sobe) e na ocorrência; só a configuração guarda o caminho inteiro.</summary>
    [AvaloniaFact]
    public async Task A_pasta_vai_mascarada_para_a_auditoria_e_a_ocorrencia()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        using var fora = new PastaFora();
        await pdv.AtivarDemonstracaoELogarAsync();
        // Um trecho que o mascarador esconde em qualquer sistema (no Windows, o perfil C:\Users\fulano também).
        var pasta = Path.Combine(fora.Caminho, "backup-123.456.789-09");
        var servico = pdv.Servicos.GetRequiredService<ServicoParametrosLocais>();
        await servico.GravarAsync(new ParametrosCaixa(PastaSecundaria: pasta), CarlosMaster, null, Ct);
        var editar = Assert.Single(await AuditoriaAsync(pdv, "editar"));
        Assert.DoesNotContain("123.456.789-09", editar.Descricao + editar.Antes + editar.Depois, StringComparison.Ordinal);
        Assert.Contains(MascaradorSuporte.Mascarar(pasta)!, editar.Descricao, StringComparison.Ordinal);
        await using var db = pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();
        Assert.All(await db.LogLocal.AsNoTracking().Select(l => l.Detalhes).ToListAsync(Ct),
            d => Assert.DoesNotContain("123.456.789-09", d ?? string.Empty, StringComparison.Ordinal));
        Assert.Equal(pasta, (await servico.LerAsync(Ct)).PastaSecundaria);
    }

    [Fact]
    public void Restaurar_backup_mostra_o_manual_como_a_aba_8()
    {
        var arquivo = new ArquivoBackup("pdv-20261104-120000-000-manual.db.gz", DateTimeOffset.UtcNow, MotivosBackup.Manual, 2048);
        Assert.Equal("feito agora (manual)", new ViewModels.LinhaBackup(arquivo).Motivo);
        Assert.Equal("fechamento do caixa", MotivosBackup.Rotulo(MotivosBackup.Fechamento));
        Assert.Equal("de-outra-versao", MotivosBackup.Rotulo("de-outra-versao"));
    }

    /// <summary>
    /// O relógio só do <see cref="BackupLocal"/>: anota se cada leitura veio da thread da tela e, fechado, prende quem lê
    /// fora dela (o backup em curso, parado no meio, com a trava). A thread da tela nunca fica presa aqui.
    /// </summary>
    private sealed class RelogioDoBackup : IRelogio
    {
        private readonly ConcurrentQueue<bool> _chamadas = new();
        private readonly ManualResetEventSlim _portao = new(true);
        private int _presos;

        public int Presos => Volatile.Read(ref _presos);

        public IReadOnlyCollection<bool> Chamadas => [.. _chamadas];

        public DateTimeOffset Agora
        {
            get
            {
                var naTela = Dispatcher.UIThread.CheckAccess();
                _chamadas.Enqueue(naTela);
                if (!naTela && !_portao.IsSet)
                {
                    Interlocked.Increment(ref _presos);
                    _portao.Wait(TimeSpan.FromSeconds(30));
                    Interlocked.Decrement(ref _presos);
                }

                var agora = DateTimeOffset.UtcNow;
                return agora.AddTicks(-(agora.Ticks % TimeSpan.TicksPerMillisecond));
            }
        }

        public void Prender() => _portao.Reset();

        public void Soltar() => _portao.Set();

        public void ZerarChamadas() => _chamadas.Clear();
    }

    /// <summary>Uma pasta temporária fora da pasta do PDV (o pendrive dos testes), apagada no fim.</summary>
    private sealed class PastaFora : IDisposable
    {
        public string Caminho { get; } = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "genesispdv-pendrive", Guid.NewGuid().ToString("N"))).FullName;

        public void Dispose()
        {
            try
            {
                Directory.Delete(Caminho, recursive: true);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // Preso por alguns ms no Windows: fica no %TEMP%.
            }
        }
    }

    /// <summary>O relógio monotônico, avançado à mão (a hora do sistema fica a de verdade).</summary>
    private sealed class Tempo : TimeProvider
    {
        private long _ticks = 1;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => Interlocked.Read(ref _ticks);

        public void Avancar(TimeSpan quanto) => Interlocked.Add(ref _ticks, quanto.Ticks);
    }
}
