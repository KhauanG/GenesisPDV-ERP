using GenesisPDV.App.ViewModels;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data;
using GenesisPDV.Data.Backup;
using GenesisPDV.Data.Outbox;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Fiscal;
using GenesisPDV.Hardware.Balanca;
using GenesisPDV.Hardware.Gaveta;
using GenesisPDV.Hardware.Impressora;
using GenesisPDV.Hardware.Leitor;
using GenesisPDV.Sync.Acesso;
using GenesisPDV.Sync.Ativacao;
using GenesisPDV.Sync.Ciclo;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Pull;
using GenesisPDV.Sync.Push;
using GenesisPDV.Sync.Relogio;
using GenesisPDV.Sync.Token;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// Composição dos serviços do PDV. O catálogo vem dos espelhos locais (<see cref="CatalogoLocal"/>; em modo demonstração
/// com a carga de <c>CatalogoDemonstracao</c>); a impressora e a gaveta seguem a configuração local do terminal
/// (<see cref="ServicoHardware"/>; a balança ainda é simulada). A ativação real
/// (<see cref="ServicoAtivacao"/>), o cliente HTTP do protocolo, a guarda do token (<see cref="CofreToken"/>, protegido
/// pela DPAPI no Windows ou pela chave local no Linux), a carga inicial (<see cref="CargaInicial"/>), o login pelo PIN
/// contra o espelho (<see cref="AutenticadorEspelho"/>) e o ciclo online (<see cref="ServicoSincronizacaoHttp"/>:
/// handshake, pull, push, heartbeat e comandos) já são os de verdade. Os intervalos do ciclo vêm de
/// <see cref="OpcoesSincronizacao"/> (os testes trocam pelo <c>ajustar</c>).
/// </summary>
public static class Inicializacao
{
    public const string ClienteHttpSync = "sync";

    public static ServiceProvider CriarServicos(CaminhosPdv caminhos, ILoggerFactory? logs = null, Action<IServiceCollection>? ajustar = null)
    {
        ArgumentNullException.ThrowIfNull(caminhos);
        caminhos.CriarPastas();
        var servicos = new ServiceCollection();
        servicos.AddLogging(b =>
        {
            if (logs is not null)
            {
                b.Services.AddSingleton(logs);
            }
        });
        servicos.AddSingleton(caminhos);
        servicos.AddSingleton<IRelogio, RelogioSistema>();
        servicos.AddSingleton(new FabricaPdvDb(caminhos.ArquivoBanco));
        servicos.AddSingleton<IDbContextFactory<PdvDbContext>>(sp => sp.GetRequiredService<FabricaPdvDb>());
        // Backup local e restauração (PDV 32.5; SYNC 22.1; Fase 1C, C17): os testes trocam as OpcoesBackup pelo `ajustar`.
        servicos.AddSingleton(new OpcoesBackup());
        servicos.AddSingleton(sp => new BackupLocal(
            sp.GetRequiredService<FabricaPdvDb>(), caminhos, sp.GetRequiredService<IRelogio>(), sp.GetRequiredService<OpcoesBackup>()));
        servicos.AddSingleton(sp => new RestauracaoBackup(
            sp.GetRequiredService<FabricaPdvDb>(), caminhos, sp.GetRequiredService<BackupLocal>(), sp.GetRequiredService<IRelogio>()));
        servicos.AddSingleton<ServicoBackup>();
        // Venda, caixa e lote de auditoria entram no outbox pelo mesmo gravador (Fase 1C, C9): hora corrigida, contexto e
        // a conferência do versoes_schema (T13).
        servicos.AddSingleton(sp => new GravadorOutbox(sp.GetRequiredService<RelogioSync>(), VersaoApp.Atual));
        servicos.AddSingleton<RepositorioVendas>();
        servicos.AddSingleton<RepositorioCaixa>();
        servicos.AddSingleton<IRepositorioVendas>(sp => sp.GetRequiredService<RepositorioVendas>());
        servicos.AddSingleton<RepositorioTerminal>();
        servicos.AddSingleton<RepositorioImpressao>();
        servicos.AddSingleton<CatalogoLocal>();
        servicos.AddSingleton<ConsultasVendaLocal>();
        servicos.AddSingleton<ConsultasHistoricoLocal>();
        servicos.AddSingleton<ConsultasSincronizacaoLocal>();
        servicos.AddSingleton<ICatalogoProdutos>(sp => sp.GetRequiredService<CatalogoLocal>());
        servicos.AddSingleton<RepositorioEspelhos>();
        servicos.AddSingleton<RepositorioConfiguracoes>();
        servicos.AddSingleton<AutenticadorOffline>();
#if MODO_DEMONSTRACAO
        servicos.AddSingleton<AutenticadorOperadorSimulado>();
        servicos.AddSingleton<IAutenticadorOperador>(sp => new AutenticadorEspelho(
            sp.GetRequiredService<AutenticadorOffline>(), sp.GetRequiredService<SessaoTerminal>(), sp.GetRequiredService<AutenticadorOperadorSimulado>()));
#else
        servicos.AddSingleton<IAutenticadorOperador>(sp => new AutenticadorEspelho(
            sp.GetRequiredService<AutenticadorOffline>(), sp.GetRequiredService<SessaoTerminal>()));
#endif
        // Impressora e gaveta (PDV 6.2, 6.3; implantação I4, decisão 63): a configuração local escolhe a simulada, a real
        // (spooler, rede, serial, dispositivo) ou nenhuma; os testes trocam a fábrica de transporte pelo `ajustar`.
        servicos.AddSingleton<ServicoHardware>();
        servicos.AddSingleton(sp => new ImpressoraArquivoSimulada(caminhos.PastaImpressao));
        servicos.AddSingleton<FabricaTransporteImpressora>(Transportes.Criar);
        servicos.AddSingleton<ImpressoraDoTerminal>();
        servicos.AddSingleton<IImpressora>(sp => sp.GetRequiredService<ImpressoraDoTerminal>());
        servicos.AddSingleton<ServicoImpressao>();
        servicos.AddSingleton<GavetaSimulada>();
        servicos.AddSingleton<ServicoGaveta>();
        servicos.AddSingleton<IBalanca, BalancaSimulada>();
        servicos.AddSingleton<LeitorComoTeclado>();
        // As colunas do cupom seguem o papel configurado (48 no 80 mm, 32 no 58 mm).
        servicos.AddSingleton<IEmissorDocumento>(sp => new EmissorNaoFiscal(() => sp.GetRequiredService<IImpressora>().Colunas));
        servicos.AddSingleton(_ => MaquinaLocal.Detectar(caminhos.PastaDados, VersaoApp.Atual));
        servicos.AddSingleton(_ => ProtetorSegredos.ParaEsteSistema(caminhos));
        servicos.AddSingleton<CofreToken>();
        servicos.AddSingleton<IFonteToken>(sp => sp.GetRequiredService<CofreToken>());
        // Tempos da SYNC 2.1: conexão 5 s no handler; o de cada chamada (heartbeat e handshake 10 s, pull 30 s, push 60 s)
        // é do ClienteSyncHttp (TemposLimiteSync), então o HttpClient fica sem Timeout próprio.
        servicos.AddHttpClient(ClienteHttpSync, c => c.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { ConnectTimeout = TimeSpan.FromSeconds(5) });
        servicos.AddSingleton<RelogioSync>();
        servicos.AddSingleton<RelogioCorrigido>();
        servicos.AddSingleton<IClienteSync>(sp =>
        {
            var sessao = sp.GetRequiredService<SessaoTerminal>();
            return new ClienteSyncHttp(
                sp.GetRequiredService<IHttpClientFactory>().CreateClient(ClienteHttpSync),
                sp.GetRequiredService<MaquinaLocal>().ParaCliente(),
                sp.GetRequiredService<IRelogio>(),
                sp.GetRequiredService<IFonteToken>(),
                () => sessao.Identidade is { Demonstracao: false } i ? new Uri(i.UrlApi) : null,
                sp.GetRequiredService<RelogioSync>());
        });
        servicos.AddSingleton<ServicoAtivacao>();
        servicos.AddSingleton<RotacaoToken>();
        servicos.AddSingleton<AplicadorPull>();
        servicos.AddSingleton<CargaInicial>();
        servicos.AddSingleton(new OpcoesSincronizacao());
        servicos.AddSingleton(sp => new OutboxSync(
            sp.GetRequiredService<FabricaPdvDb>(), sp.GetRequiredService<RelogioSync>(), VersaoApp.Atual, sp.GetRequiredService<ILogger<OutboxSync>>()));
        servicos.AddSingleton(sp => new EnvioPush(
            sp.GetRequiredService<IClienteSync>(), sp.GetRequiredService<FabricaPdvDb>(), sp.GetRequiredService<IRelogio>(), VersaoApp.Atual,
            sp.GetRequiredService<ILogger<EnvioPush>>()));
        servicos.AddSingleton<ProcessadorComandos>();
        servicos.AddSingleton(sp => new ServicoSincronizacaoHttp(
            sp.GetRequiredService<IClienteSync>(),
            sp.GetRequiredService<FabricaPdvDb>(),
            sp.GetRequiredService<RepositorioTerminal>(),
            sp.GetRequiredService<AplicadorPull>(),
            sp.GetRequiredService<OutboxSync>(),
            sp.GetRequiredService<EnvioPush>(),
            sp.GetRequiredService<ProcessadorComandos>(),
            sp.GetRequiredService<RotacaoToken>(),
            sp.GetRequiredService<RelogioSync>(),
            sp.GetRequiredService<MaquinaLocal>(),
            sp.GetRequiredService<OpcoesSincronizacao>(),
            sp.GetRequiredService<ILogger<ServicoSincronizacaoHttp>>(),
            () => sp.GetRequiredService<SessaoTerminal>().Operador?.Id));
        servicos.AddSingleton<IServicoSincronizacao>(sp => sp.GetRequiredService<ServicoSincronizacaoHttp>());
        // F4 "Outras lojas" da pesquisa (F2-B35): a consulta online de 3 s, que nunca trava a venda.
        servicos.AddSingleton<IConsultaOutrasLojas>(sp => new ConsultaOutrasLojasHttp(
            sp.GetRequiredService<IClienteSync>(), sp.GetRequiredService<IServicoSincronizacao>(),
            sp.GetRequiredService<ILogger<ConsultaOutrasLojasHttp>>()));
        // Imagens do catálogo (F2-B45; SYNC 6.12): o cache local com o sha256 conferido, sob demanda; a exibição da foto
        // (`pdv.exibe_foto_produto`, padrão desligado) e o descarte LRU entram depois.
        servicos.AddSingleton(sp => new CacheImagens(
            sp.GetRequiredService<IClienteSync>(), caminhos.PastaCacheImagens, sp.GetRequiredService<IRelogio>(),
            sp.GetRequiredService<ILogger<CacheImagens>>()));
        servicos.AddSingleton<SessaoTerminal>();
        // Central do PDV (bloco G2): quem está nela, a liberação de 5 min e a auditoria do acesso.
        servicos.AddSingleton<Diagnostico.AcessoCentral>();
        // Painel de saúde (bloco G4): as 12 verificações locais, na ordem do Painel (plano 4.1), o disco (os testes trocam a
        // medida do livre pelo `ajustar`), o integrity_check da abertura guardado em memória e a rodada do ícone da barra.
        servicos.AddSingleton(new Diagnostico.OpcoesSaude());
        servicos.AddSingleton(_ => new Diagnostico.MedidorDisco(caminhos));
        servicos.AddSingleton<Diagnostico.EstadoBanco>();
        servicos.AddSingleton<Diagnostico.IVerificacaoSaude, Diagnostico.Verificacoes.VerificacaoSincronizacao>();
        servicos.AddSingleton<Diagnostico.IVerificacaoSaude, Diagnostico.Verificacoes.VerificacaoRejeitados>();
        servicos.AddSingleton<Diagnostico.IVerificacaoSaude, Diagnostico.Verificacoes.VerificacaoLacuna>();
        servicos.AddSingleton<Diagnostico.IVerificacaoSaude, Diagnostico.Verificacoes.VerificacaoRelogio>();
        servicos.AddSingleton<Diagnostico.IVerificacaoSaude, Diagnostico.Verificacoes.VerificacaoImpressora>();
        servicos.AddSingleton<Diagnostico.IVerificacaoSaude, Diagnostico.Verificacoes.VerificacaoGaveta>();
        servicos.AddSingleton<Diagnostico.IVerificacaoSaude, Diagnostico.Verificacoes.VerificacaoDisco>();
        servicos.AddSingleton<Diagnostico.IVerificacaoSaude, Diagnostico.Verificacoes.VerificacaoBackup>();
        servicos.AddSingleton<Diagnostico.IVerificacaoSaude, Diagnostico.Verificacoes.VerificacaoBanco>();
        servicos.AddSingleton<Diagnostico.IVerificacaoSaude, Diagnostico.Verificacoes.VerificacaoCaixa>();
        servicos.AddSingleton<Diagnostico.IVerificacaoSaude, Diagnostico.Verificacoes.VerificacaoVersao>();
        servicos.AddSingleton<Diagnostico.IVerificacaoSaude, Diagnostico.Verificacoes.VerificacaoErros>();
        servicos.AddSingleton<Diagnostico.VerificadorSaude>();
        servicos.AddSingleton<Diagnostico.MonitorSaude>();
        // Os fatos da venda (iniciada_em, finalizada_em…) usam a hora corrigida, a mesma do envelope (SYNC 12.3).
        servicos.AddSingleton(sp => ActivatorUtilities.CreateInstance<ServicoVenda>(sp, (IRelogio)sp.GetRequiredService<RelogioCorrigido>()));
        // Os fatos do caixa (aberta_em, ocorrido_em…) também (Fase 1C, C10a).
        servicos.AddSingleton(sp => ActivatorUtilities.CreateInstance<ServicoCaixa>(sp, (IRelogio)sp.GetRequiredService<RelogioCorrigido>()));
        // Aba Vendas da Central (bloco G5): o caixa aberto e os fechados dos últimos 30 dias, pelo dia operacional.
        servicos.AddSingleton<ServicoHistoricoVendas>();
        // Aba Caixas (bloco G6): os mesmos caixas, como foram impressos (o retrato do fechamento e os bytes da fila).
        servicos.AddSingleton<ServicoHistoricoCaixas>();
        // Aba Sincronização (bloco G7): as vendas e os registros do caixa ainda não confirmados pela nuvem, sem payload.
        servicos.AddSingleton<ServicoSincronizacaoCentral>();
        // Aba Logs e ocorrências (bloco G8): o log_local com as dicas e o arquivo do Serilog lido pelo final, mascarados.
        servicos.AddSingleton<ConsultasLogLocal>();
        servicos.AddSingleton<Diagnostico.LeitorLogArquivo>();
        servicos.AddSingleton<ServicoLogsCentral>();
        // Aba Histórico de uso (bloco G10): o log_auditoria_local em frases, mascarado, e o resumo por operador.
        servicos.AddSingleton<ConsultasAuditoriaLocal>();
        servicos.AddSingleton<ServicoHistoricoUso>();
        // Pacote de suporte (bloco G9): o zip por lista de permitidos, mascarado, salvo no pendrive (os testes trocam os destinos).
        servicos.AddSingleton<ConsultasPacoteSuporte>();
        servicos.AddSingleton<Diagnostico.IDestinosPacote, Diagnostico.DestinosPacoteSistema>();
        servicos.AddSingleton<Diagnostico.ServicoPacoteSuporte>();
        servicos.AddSingleton<ServicoTema>();
        // Parâmetros do caixa e bloqueio da tela por inatividade (Central do PDV, bloco G11; desligado por padrão, PC-13).
        servicos.AddSingleton<ServicoParametrosLocais>();
        servicos.AddSingleton<MonitorInatividade>();
        servicos.AddSingleton<ShellViewModel>();
        ajustar?.Invoke(servicos);
        return servicos.BuildServiceProvider();
    }
}
