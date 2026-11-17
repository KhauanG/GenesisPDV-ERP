/**
 * Prazo de leitura dos envios em multipart (README da API › decisão 202): o arquivo tem `ENVIO_ARQUIVO_PRAZO_LEITURA_S`
 * (padrão 60 s, o `readTimeout` do proxy de produção) para chegar inteiro, contados de quando a rota começa a ler o
 * corpo (depois do login e da permissão). Passou dele com o corpo ainda chegando, a requisição termina com 408
 * `TEMPO_ESGOTADO` e `Connection: close`: a leitura para (o multer limpa o que juntou quando a conexão fecha) e os
 * contadores do envio (o do usuário, o da empresa) voltam na hora, sem esperar o `requestTimeout` de 300 s do Node.
 * Com o corpo já lido, o prazo não corta nada: o processamento (a vaga do processo, a gravação) tem o tempo dele.
 *
 * Vai **antes** de todos os interceptors da rota (o primeiro de `@UseInterceptors`), para cobrir o envio inteiro.
 */
import type { IncomingMessage } from 'node:http';
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Servicos } from '../servicos.js';
import { ErroApi } from './erros.js';
import { SERVICOS } from './tokens-nest.js';

/** Sempre com `Connection: close`: o resto do envio lento não é recebido. */
export const envioForaDoPrazo = () =>
  new ErroApi('TEMPO_ESGOTADO', 'O envio do arquivo demorou além do prazo. Tente de novo.', {
    cabecalhos: { Connection: 'close' },
  });

@Injectable()
export class PrazoLeituraEnvio implements NestInterceptor {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<IncomingMessage>();
    const prazoMs = this.s.config.envioArquivo.prazoLeituraMs;
    return new Observable((assinante) => {
      const prazo = setTimeout(() => {
        if (req.complete) return;
        // Para de receber; a resposta de erro fecha a conexão e o multer descarta o que juntou.
        req.pause();
        assinante.error(envioForaDoPrazo());
      }, prazoMs);
      prazo.unref();
      const inscricao = next.handle().subscribe(assinante);
      return () => {
        clearTimeout(prazo);
        inscricao.unsubscribe();
      };
    });
  }
}
