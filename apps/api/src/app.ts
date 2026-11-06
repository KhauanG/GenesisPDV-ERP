import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import pino from 'pino';
import { AppModule } from './app.module.js';
import { FiltroErros } from './comum/filtro-erros.js';
import type { Configuracao } from './config/configuracao.js';
import { criarServicos, type Servicos } from './servicos.js';

export interface Aplicacao {
  app: INestApplication;
  servicos: Servicos;
}

export async function criarAplicacao(
  config: Configuracao,
  servicos = criarServicos(config),
): Promise<Aplicacao> {
  const logger = pino({
    level: config.log.nivel,
    ...(config.log.legivel ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  });
  const app = await NestFactory.create<NestExpressApplication>(AppModule.registrar(servicos, logger), {
    bufferLogs: true,
    logger: config.log.nivel === 'silent' ? false : undefined,
  });
  app.useLogger(app.get(Logger));
  // Só os proxies declarados em TRUST_PROXY definem o IP do cliente (limite de taxa, auditoria, historico_logins).
  app.set('trust proxy', config.trustProxy);
  logger.info(
    { ambiente: config.ambiente, trust_proxy: config.trustProxy, cookie_seguro: config.cookieSeguro },
    `API no ambiente "${config.ambiente}"`,
  );
  app.disable('x-powered-by');
  app.use(cookieParser());
  // Lotes do push chegam a 8 MiB (SYNC 19.2), com gzip (o body-parser descomprime).
  app.useBodyParser('json', { limit: '9mb' });
  // O protocolo do PDV fica fora do prefixo (SYNC 1.4: `/sync/*`).
  app.setGlobalPrefix('api', { exclude: ['saude', 'sync/{*caminho}'] });
  app.enableCors({ origin: config.corsOrigens, credentials: true });
  app.useGlobalFilters(new FiltroErros(logger));
  app.enableShutdownHooks();
  // Trabalhadores da fila (tarefas e e-mails) nesta instância; quem só enfileira inicia o pg-boss sob demanda.
  if (config.fila.trabalhador) {
    servicos.fila.iniciar().catch((e: unknown) => logger.error({ err: e }, 'fila de trabalhos não iniciou'));
  }
  const fecharNest = app.close.bind(app);
  app.close = async () => {
    await fecharNest();
    await servicos.fechar();
  };
  return { app, servicos };
}
