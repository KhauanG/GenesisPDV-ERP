import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import type { Logger as LoggerPino } from 'pino';
import { uuidv7 } from 'uuidv7';
import { AuditoriaController } from './auditoria/auditoria.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AutenticacaoGuard, PermissaoGuard } from './autorizacao/guards.js';
import { limitesDeTaxa } from './autorizacao/limite-taxa.guard.js';
import { SERVICOS } from './comum/tokens-nest.js';
import { EmpresaController } from './empresa/empresa.controller.js';
import { NotasEntradaController } from './entradas/notas-entrada.controller.js';
import { RecebimentosController } from './entradas/recebimentos.controller.js';
import { CategoriasController } from './catalogo/categorias.controller.js';
import { MarcasController } from './catalogo/marcas.controller.js';
import { ConfiguracoesController } from './configuracoes/configuracoes.controller.js';
import { AcertosController } from './estoques/acertos.controller.js';
import { EstoquesController } from './estoques/estoques.controller.js';
import { SaldosEstoqueController } from './estoques/saldos.controller.js';
import { TiposEstoqueController } from './estoques/tipos-estoque.controller.js';
import { DashboardController } from './dashboard/dashboard.controller.js';
import { ImplantacaoController } from './implantacao/implantacao.controller.js';
import { ImportacoesController } from './importacao/importacao.controller.js';
import { FormasPagamentoController } from './formas-pagamento/formas-pagamento.controller.js';
import { CaixasController } from './lojas/caixas.controller.js';
import { LojasController } from './lojas/lojas.controller.js';
import { PessoasController } from './pessoas/pessoas.controller.js';
import { GruposPrecoController } from './produtos/grupos-preco.controller.js';
import { ProdutosController } from './produtos/produtos.controller.js';
import { RestricoesHorarioController } from './produtos/restricoes-horario.controller.js';
import { ReferenciasController } from './referencias/referencias.controller.js';
import { PerfisController } from './perfis/perfis.controller.js';
import { PlataformaAuthController } from './plataforma/plataforma-auth.controller.js';
import { PlataformaEmpresasController } from './plataforma/plataforma-empresas.controller.js';
import { SaudeController } from './saude/saude.controller.js';
import { SyncController } from './sync/sync.controller.js';
import { TarefasController } from './tarefas/tarefas.controller.js';
import { EventosRecebidosController } from './terminais/eventos-recebidos.controller.js';
import { TerminaisController } from './terminais/terminais.controller.js';
import { TransferenciasController } from './transferencias/transferencias.controller.js';
import type { Servicos } from './servicos.js';
import { ContextoEmpresaInterceptor } from './tenancy/contexto.interceptor.js';
import { UsuariosController } from './usuarios/usuarios.controller.js';
import { MovimentosCaixaController } from './vendas/movimentos-caixa.controller.js';
import { SessoesCaixaController } from './vendas/sessoes-caixa.controller.js';
import { VendasController } from './vendas/vendas.controller.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Module({})
export class AppModule {
  static registrar(servicos: Servicos, logger: LoggerPino): DynamicModule {
    const { config } = servicos;
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            logger,
            // Correlação com a auditoria (MD 3.1.7 `requisicao_id`): aceita o X-Requisicao-Id do cliente se for UUID.
            genReqId: (req, res) => {
              const recebido = req.headers['x-requisicao-id'];
              const id = typeof recebido === 'string' && UUID.test(recebido) ? recebido : uuidv7();
              res.setHeader('X-Requisicao-Id', id);
              return id;
            },
            customProps: (req) => ({ requisicao_id: req.id }),
            redact: {
              paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
              censor: '***',
            },
            serializers: {
              req: (req: { id: string; method: string; url: string }) => ({
                method: req.method,
                url: req.url,
              }),
            },
          },
        }),
        ThrottlerModule.forRoot(
          limitesDeTaxa(config.login.limitePorMinuto, config.login.limitePorContaMinuto),
        ),
      ],
      controllers: [
        SaudeController,
        AuthController,
        EmpresaController,
        LojasController,
        CaixasController,
        EstoquesController,
        AcertosController,
        RecebimentosController,
        NotasEntradaController,
        TransferenciasController,
        SaldosEstoqueController,
        TiposEstoqueController,
        UsuariosController,
        PerfisController,
        AuditoriaController,
        FormasPagamentoController,
        ConfiguracoesController,
        PessoasController,
        MarcasController,
        CategoriasController,
        ProdutosController,
        GruposPrecoController,
        RestricoesHorarioController,
        ReferenciasController,
        PlataformaAuthController,
        PlataformaEmpresasController,
        TerminaisController,
        EventosRecebidosController,
        TarefasController,
        ImportacoesController,
        DashboardController,
        ImplantacaoController,
        VendasController,
        MovimentosCaixaController,
        SessoesCaixaController,
        SyncController,
      ],
      providers: [
        { provide: SERVICOS, useValue: servicos },
        { provide: APP_GUARD, useClass: AutenticacaoGuard },
        { provide: APP_GUARD, useClass: PermissaoGuard },
        { provide: APP_INTERCEPTOR, useClass: ContextoEmpresaInterceptor },
      ],
    };
  }
}
