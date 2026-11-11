import { AuditoriaService } from './auditoria/auditoria.service.js';
import { AuthService } from './auth/auth.service.js';
import { PermissoesEfetivas } from './autorizacao/permissoes-efetivas.js';
import type { Configuracao } from './config/configuracao.js';
import { BancoControle } from './database/controle/conexao.js';
import { lerMigracoes, PASTA_MIGRACOES_EMPRESA } from './database/migracoes/journal.js';
import { ServidoresBanco } from './database/servidores.js';
import { AdminAuthService } from './plataforma/admin-auth.service.js';
import { MigradorEmpresas } from './plataforma/migrador-empresas.js';
import { Provisionamento } from './plataforma/provisionamento.js';
import { Cifra } from './seguranca/cifra.js';
import { AssinadorJwt } from './seguranca/jwt.js';
import { RedefinicaoSenha } from './auth/redefinicao-senha.js';
import { ArmazenamentoObjetos } from './infra/armazenamento.js';
import { EnviadorEmail } from './infra/email.js';
import { FILAS, FilaTrabalhos, trabalhoPorEmpresas } from './infra/fila.js';
import { AtivacaoTerminais } from './sync/ativacao.js';
import { CRON_TAREFAS_INTERROMPIDAS, VarreduraTarefasInterrompidas } from './tarefas/interrompidas.js';
import { provedorCatalogoClientes, provedorCatalogoProdutos } from './produtos/exportacao.js';
import { ExportacaoRelatorios } from './tarefas/exportar-relatorio.js';
import { provedorEanDuplicado } from './relatorios/ean-duplicado.js';
import { provedorEstoqueAtual } from './relatorios/estoque-atual.js';
import { provedorMovimentacao } from './relatorios/movimentacao.js';
import { provedorNcmInvalidos } from './relatorios/ncm-invalidos.js';
import { provedorProdutosGeral } from './relatorios/produtos-geral.js';
import { TarefasSegundoPlano } from './tarefas/tarefas.js';
import { FilaDecisao } from './terminais/fila-decisao.js';
import { CRON_MANUTENCAO_TERMINAIS, ManutencaoTerminais } from './terminais/manutencao.js';
import { TerminaisErp } from './terminais/terminais.service.js';
import { HeartbeatSync } from './sync/heartbeat.js';
import { ConsultasSync } from './sync/consultas.js';
import { RecuperarSync } from './sync/recuperar.js';
import { PullSync } from './sync/pull.js';
import { PushSync } from './sync/push.js';
import { AutenticacaoTerminal } from './sync/terminal.js';
import { TokenTerminal } from './sync/token.js';
import { CustoCombos } from './produtos/custo-combo.js';
import { Importacoes } from './importacao/importacao.js';
import { NotasEntrada } from './entradas/notas-entrada.js';
import { CRON_EXPIRACAO_RELEVANCIA, ExpiracaoRelevancia } from './pessoas/expiracao-relevancia.js';
import { VerificacaoRazao } from './estoques/verificacao-razao.js';
import { AlertaTransferencias, CRON_ALERTA_TRANSFERENCIAS } from './transferencias/alertas.js';
import { PoolsEmpresas } from './tenancy/pools-empresas.js';
import { SaudeDetalhada } from './saude/saude-detalhada.js';
import { ResolvedorEmpresas, type ExigenciaSchema } from './tenancy/resolvedor.js';
import { Tenancy } from './tenancy/tenancy.js';

/** O banco da empresa precisa estar ao menos na última migração do journal com que esta versão foi publicada. */
function exigenciaSchemaEmpresa(): ExigenciaSchema {
  const migracoes = lerMigracoes(PASTA_MIGRACOES_EMPRESA);
  return {
    ordemPorTag: new Map(migracoes.map((m) => [m.tag, m.ordem])),
    ordemMinima: Math.max(...migracoes.map((m) => m.ordem)),
  };
}

/**
 * Grafo de serviços da API, montado sem depender do container do Nest: o mesmo objeto é usado pelos controllers
 * (via `AppModule`), pelos CLIs e pelos testes.
 */
export interface Servicos {
  config: Configuracao;
  controle: BancoControle;
  cifra: Cifra;
  servidores: ServidoresBanco;
  pools: PoolsEmpresas;
  tenancy: Tenancy;
  resolvedor: ResolvedorEmpresas;
  migrador: MigradorEmpresas;
  provisionamento: Provisionamento;
  auditoria: AuditoriaService;
  permissoes: PermissoesEfetivas;
  auth: AuthService;
  adminAuth: AdminAuthService;
  terminalAuth: AutenticacaoTerminal;
  ativacao: AtivacaoTerminais;
  terminais: TerminaisErp;
  /** Fila de decisão do ERP (ERP 12.5; SYNC 11.4): reprocessar, novo número, descartar e o lote por código. */
  filaDecisao: FilaDecisao;
  manutencaoTerminais: ManutencaoTerminais;
  /** Expiração diária da relevância das pessoas no PDV (MD 3.5.4; C14). */
  expiracaoRelevancia: ExpiracaoRelevancia;
  verificacaoRazao: VerificacaoRazao;
  alertaTransferencias: AlertaTransferencias;
  pull: PullSync;
  push: PushSync;
  heartbeat: HeartbeatSync;
  /** `GET /sync/recuperar` (SYNC 22.2; C17): a re-hidratação do banco local restaurado. */
  recuperar: RecuperarSync;
  /** Consultas online do caixa no `/sync/*` (F2-B35): o saldo das outras lojas no F4 da pesquisa. */
  consultas: ConsultasSync;
  token: TokenTerminal;
  fila: FilaTrabalhos;
  armazenamento: ArmazenamentoObjetos;
  email: EnviadorEmail;
  redefinicao: RedefinicaoSenha;
  tarefas: TarefasSegundoPlano;
  tarefasInterrompidas: VarreduraTarefasInterrompidas;
  custoCombos: CustoCombos;
  importacoes: Importacoes;
  /** NF-e de fornecedor por XML (ERP 13.4; F2-B19): upload, fornecedor pelo emitente e a tarefa do lote grande. */
  notasEntrada: NotasEntrada;
  /**
   * Exportação de relatório (F2-B29, decisão 177): na hora até 50 mil linhas, em tarefa por streaming acima; cada
   * relatório registra o seu provedor.
   */
  exportacoes: ExportacaoRelatorios;
  /** `GET /api/saude/detalhada` (Implantação do piloto, I1b). */
  saudeDetalhada: SaudeDetalhada;
  fechar(): Promise<void>;
}

export function criarServicos(config: Configuracao, opcoes: { executadoPor?: string } = {}): Servicos {
  const controle = new BancoControle(config.bancoControleUrl);
  const cifra = new Cifra(config.cifra.versaoAtual, config.cifra.chaves);
  const servidores = new ServidoresBanco(controle, cifra, config.empresas.servidorUrl);
  const pools = new PoolsEmpresas(servidores, {
    maximo: config.pools.cacheMaximo,
    ociosoMs: config.pools.ociosoMs,
    conexoesPorEmpresa: config.pools.conexoesPorEmpresa,
  });
  const tenancy = new Tenancy(pools, { esperaTravaVersaoMs: config.esperaTravaVersaoMs });
  const resolvedor = new ResolvedorEmpresas(controle, config.tenancyCacheMs, exigenciaSchemaEmpresa());
  const migrador = new MigradorEmpresas(
    controle,
    servidores,
    {
      lote: config.migracao.lote,
      lockTimeout: config.migracao.lockTimeout,
      executadoPor: opcoes.executadoPor,
    },
    () => resolvedor.invalidar(),
  );
  const provisionamento = new Provisionamento(
    controle,
    servidores,
    migrador,
    pools,
    { icuLocale: config.empresas.icuLocale },
    () => resolvedor.invalidar(),
  );
  const auditoria = new AuditoriaService();
  const permissoes = new PermissoesEfetivas();
  const auth = new AuthService(
    config,
    tenancy,
    resolvedor,
    auditoria,
    permissoes,
    new AssinadorJwt(config.jwt.segredo, 'erp', config.jwt.acessoMinutos),
  );
  const adminAuth = new AdminAuthService(
    config,
    controle,
    cifra,
    new AssinadorJwt(config.jwt.segredoPlataforma, 'plataforma', config.jwt.acessoMinutos),
  );
  const fila = new FilaTrabalhos(config.bancoControleUrl, { trabalhador: config.fila.trabalhador });
  const armazenamento = new ArmazenamentoObjetos(config.armazenamento);
  const email = new EnviadorEmail(config.email);
  const redefinicao = new RedefinicaoSenha(config, tenancy, resolvedor, auditoria, fila, email);
  const tarefas = new TarefasSegundoPlano(tenancy, resolvedor, fila, armazenamento);
  fila.registrar(FILAS.mensagem, async (d) => {
    await redefinicao.enviarRedefinicao(String(d.empresaId), String(d.mensagemId));
  });
  fila.registrar(FILAS.tarefa, (d, job) =>
    tarefas.executar(String(d.empresaId), String(d.tarefaId), job.retryCount ?? 0),
  );
  const custoCombos = new CustoCombos();
  const importacoes = new Importacoes({
    tenancy,
    tarefas,
    armazenamento,
    auditoria,
    custoCombos,
    permissoes,
  });
  const notasEntrada = new NotasEntrada({ tenancy, tarefas, armazenamento, auditoria, permissoes });
  const exportacoes = new ExportacaoRelatorios({ tenancy, tarefas, armazenamento, auditoria, permissoes });
  // Os relatórios exportáveis pela rota comum (F2-B29): o Estoque Atual (F2-B31, decisão 178) e a Movimentação de
  // Estoque, nas duas visões (F2-B33, decisão 180), o EAN duplicado (F2-B38, decisão 184), o Produtos geral e os NCMs
  // inválidos (F2-B41, decisão 187).
  exportacoes.registrar(provedorEstoqueAtual());
  exportacoes.registrar(provedorMovimentacao());
  exportacoes.registrar(provedorEanDuplicado());
  exportacoes.registrar(provedorProdutosGeral());
  exportacoes.registrar(provedorNcmInvalidos());
  // A exportação do catálogo de ida e volta (F2-B40, decisão 186): produtos e clientes, com o acesso do cadastro.
  exportacoes.registrar(provedorCatalogoProdutos());
  exportacoes.registrar(provedorCatalogoClientes());
  const terminalAuth = new AutenticacaoTerminal(controle, resolvedor);
  const ativacao = new AtivacaoTerminais(controle, resolvedor, tenancy, auditoria, cifra);
  const manutencaoTerminais = new ManutencaoTerminais(controle, resolvedor, tenancy, auditoria, ativacao);
  fila.registrar(
    FILAS.manutencaoTerminais,
    trabalhoPorEmpresas(FILAS.manutencaoTerminais, () => manutencaoTerminais.executar()),
  );
  fila.agendar(FILAS.manutencaoTerminais, CRON_MANUTENCAO_TERMINAIS);
  const filaDecisao = new FilaDecisao(tenancy, auditoria, tarefas);
  const expiracaoRelevancia = new ExpiracaoRelevancia(controle, resolvedor, tenancy);
  fila.registrar(
    FILAS.expiracaoRelevancia,
    trabalhoPorEmpresas(FILAS.expiracaoRelevancia, () => expiracaoRelevancia.executar()),
  );
  fila.agendar(FILAS.expiracaoRelevancia, CRON_EXPIRACAO_RELEVANCIA);
  // Decisão 150: a tarefa `executando` de um processo que morreu vira `falhou` (interrompida) no início da instância
  // com trabalhador e a cada 2 min, pelo "último sinal" que o executor renova.
  const tarefasInterrompidas = new VarreduraTarefasInterrompidas(controle, resolvedor, tenancy, tarefas);
  fila.registrar(
    FILAS.tarefasInterrompidas,
    trabalhoPorEmpresas(FILAS.tarefasInterrompidas, () => tarefasInterrompidas.executar()),
  );
  fila.agendar(FILAS.tarefasInterrompidas, CRON_TAREFAS_INTERROMPIDAS);
  fila.executarAoIniciar(FILAS.tarefasInterrompidas);
  // F2-B26 (decisão 174): a transferência parada em trânsito ou com divergência a tratar além do prazo abre o alerta.
  const alertaTransferencias = new AlertaTransferencias(controle, resolvedor, tenancy);
  fila.registrar(
    FILAS.alertaTransferencias,
    trabalhoPorEmpresas(FILAS.alertaTransferencias, () => alertaTransferencias.executar()),
  );
  fila.agendar(FILAS.alertaTransferencias, CRON_ALERTA_TRANSFERENCIAS);
  // F2-B3 (decisão 147): só verifica o razão e abre o alerta; desligada sem `VERIFICACAO_RAZAO_CRON`, o que também
  // remove o agendamento gravado no pg-boss quando ela esteve ligada (senão o cron seguia criando jobs sem consumidor).
  const verificacaoRazao = new VerificacaoRazao(controle, resolvedor, tenancy);
  if (config.fila.verificacaoRazaoCron) {
    fila.registrar(
      FILAS.verificacaoRazao,
      trabalhoPorEmpresas(FILAS.verificacaoRazao, () => verificacaoRazao.executar()),
    );
    fila.agendar(FILAS.verificacaoRazao, config.fila.verificacaoRazaoCron);
  } else {
    fila.desagendar(FILAS.verificacaoRazao);
  }
  return {
    config,
    controle,
    cifra,
    servidores,
    pools,
    tenancy,
    resolvedor,
    migrador,
    provisionamento,
    auditoria,
    permissoes,
    auth,
    adminAuth,
    terminalAuth,
    ativacao,
    terminais: new TerminaisErp(controle, tenancy, auditoria, ativacao),
    filaDecisao,
    manutencaoTerminais,
    expiracaoRelevancia,
    verificacaoRazao,
    alertaTransferencias,
    pull: new PullSync(tenancy),
    push: new PushSync(tenancy, {
      permissoes,
      // SYNC 8.6: depois da lacuna recuperada, os eventos com erro posteriores a ela voltam em ordem (tarefa).
      reprocessamentoAposLacuna: {
        criar: (tx, d) => filaDecisao.criarReprocessamentoAposLacuna(tx, d),
        agendar: (empresaId, tarefaId) => filaDecisao.agendarTarefa(empresaId, tarefaId),
      },
    }),
    heartbeat: new HeartbeatSync(controle, tenancy, auditoria),
    recuperar: new RecuperarSync(tenancy),
    consultas: new ConsultasSync(tenancy),
    token: new TokenTerminal(controle, tenancy, auditoria),
    fila,
    armazenamento,
    email,
    redefinicao,
    tarefas,
    tarefasInterrompidas,
    custoCombos,
    importacoes,
    notasEntrada,
    exportacoes,
    saudeDetalhada: new SaudeDetalhada(config, controle, resolvedor, tenancy, armazenamento),
    async fechar() {
      await fila.parar();
      email.fechar();
      armazenamento.destruir();
      await pools.fecharTodos();
      await controle.fechar();
    },
  };
}
