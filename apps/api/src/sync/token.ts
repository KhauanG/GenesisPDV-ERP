/**
 * Rotação do token do terminal (SYNC 3.7): `POST /sync/token/renovar`. O PDV gera o segredo novo, grava-o como
 * `token.pendente` e manda só o `sha256_hex` dele; a API troca o `token_hash` e guarda o atual como anterior por 7 dias
 * (a autenticação aceita os dois, `terminal.ts`). Idempotente pelo `requisicao_id` (`token_renovacao_requisicao_id`):
 * a repetição, autenticada pelo anterior ou pelo novo, não muda nada. Também aqui o alerta `token_anterior_reutilizado`
 * (uso do anterior depois que o novo já funcionou, indício de cópia).
 */
import { ALERTA_TOKEN_ANTERIOR_REUTILIZADO } from '@genesis/shared';
import { eq } from 'drizzle-orm';
import type { AuditoriaService } from '../auditoria/auditoria.service.js';
import type { BancoControle } from '../database/controle/conexao.js';
import { terminaisPdv } from '../database/controle/schema.js';
import { alertas } from '../database/empresa/schema/index.js';
import { registrarAuditoriaPlataforma } from '../plataforma/auditoria-plataforma.js';
import { iguaisTempoConstante } from '../seguranca/tokens.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import type { RenovarToken, RespostaRenovarToken } from './contratos.js';
import { ErroSync } from './erros.js';
import type { TerminalAutenticado } from './terminal.js';

/** Janela em que o token anterior continua aceito depois da rotação (SYNC 3.7). */
export const JANELA_TOKEN_ANTERIOR_MS = 7 * 86_400_000;

/**
 * SYNC 3.7: chamada autenticada pelo token anterior depois que o atual já foi usado com sucesso. Aparece em
 * PDVs/Terminais e é resolvido lá (`TerminaisService.resolverAlerta`).
 */
export const ALERTA_TOKEN_ANTERIOR = ALERTA_TOKEN_ANTERIOR_REUTILIZADO;

export class TokenTerminal {
  constructor(
    private readonly controle: BancoControle,
    private readonly tenancy: Tenancy,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Token usado de outra máquina não rouba a rotação: o 409 HARDWARE_ALTERADO sai antes, no controller
   * (`exigirHardware` em `terminal.ts`, a única regra de hardware do sync).
   */
  async renovar(t: TerminalAutenticado, entrada: RenovarToken): Promise<RespostaRenovarToken> {
    const emitidoEm = await this.controle.transacao(async (tx) => {
      const [linha] = await tx
        .select()
        .from(terminaisPdv)
        .where(eq(terminaisPdv.id, t.terminalId))
        .for('update');
      if (!linha) throw ErroSync.token();
      if (linha.tokenRenovacaoRequisicaoId === entrada.requisicao_id) {
        // Repetição (resposta perdida): sem efeito, desde que seja o mesmo segredo.
        if (linha.tokenHash !== entrada.novo_token_hash) {
          throw ErroSync.invalida('Esta renovação já foi aplicada com outro token.');
        }
        return linha.tokenEmitidoEm;
      }
      // Rotação nova só com o token atual (relido sob a trava: outra renovação pode ter acabado de trocá-lo). O
      // anterior autenticado com `requisicao_id` novo é 401, para um token antigo copiado não "roubar" a rotação.
      if (t.porTokenAnterior || !iguaisTempoConstante(t.hashToken, linha.tokenHash)) throw ErroSync.token();
      if (
        entrada.novo_token_hash === linha.tokenHash ||
        entrada.novo_token_hash === linha.tokenHashAnterior
      ) {
        throw ErroSync.invalida('O token novo precisa ser diferente do atual e do anterior.', {
          campos: { novo_token_hash: ['igual a um token já usado'] },
        });
      }
      const agora = new Date();
      await tx
        .update(terminaisPdv)
        .set({
          tokenHashAnterior: linha.tokenHash,
          tokenAnteriorValidoAte: new Date(agora.getTime() + JANELA_TOKEN_ANTERIOR_MS),
          tokenHash: entrada.novo_token_hash,
          tokenEmitidoEm: agora,
          tokenAtualUsadoEm: null,
          tokenRenovacaoRequisicaoId: entrada.requisicao_id,
        })
        .where(eq(terminaisPdv.id, t.terminalId));
      // Sem "token" nos nomes das chaves: o mascaramento da auditoria esconderia os valores (ERP 17.2).
      await registrarAuditoriaPlataforma(tx, {
        empresaId: t.empresa.id,
        acao: 'terminal_token_renovado',
        entidade: 'terminais_pdv',
        registroId: t.terminalId,
        antes: { emitido_em: linha.tokenEmitidoEm.toISOString() },
        depois: {
          emitido_em: agora.toISOString(),
          requisicao_id: entrada.requisicao_id,
          anterior_valido_ate: new Date(agora.getTime() + JANELA_TOKEN_ANTERIOR_MS).toISOString(),
        },
        ip: t.ip,
      });
      return agora;
    });
    return { token_emitido_em: emitidoEm.toISOString() };
  }

  /**
   * Uso do token anterior depois que o novo já funcionou (`token_atual_usado_em` preenchido há mais que
   * `MARGEM_TOKEN_ANTERIOR_MS`, SYNC 3.7): o PDV nunca faz isso (tenta sempre o pendente/atual primeiro e relê os
   * candidatos depois de um 401), então é indício de cópia. Vale também com hardware divergente (o 409 sai depois). Alerta crítico no ERP e auditoria
   * `token_anterior_reutilizado`, uma vez por terminal enquanto o alerta estiver aberto (as chamadas seguintes com o
   * mesmo token não repetem). Roda no contexto da empresa do terminal; a chamada em si continua aceita até o fim da
   * janela de 7 dias (quem decide revogar é o ERP).
   */
  async registrarAnteriorReutilizado(t: TerminalAutenticado): Promise<void> {
    await this.tenancy.cx().transacao(async (tx) => {
      const novo = await tx
        .insert(alertas)
        .values({
          tipo: ALERTA_TOKEN_ANTERIOR,
          severidade: 'critico',
          titulo: `Token antigo do caixa ${String(t.numeroCaixa).padStart(2, '0')} usado depois da renovação`,
          mensagem:
            'Uma chamada usou o token anterior do terminal depois que o token novo já estava em uso: pode haver ' +
            'uma cópia do terminal. Confira a máquina e, se não reconhecer, revogue o terminal em PDVs/Terminais.',
          lojaId: t.lojaId,
          entidade: 'terminais',
          registroId: t.terminalId,
          dados: { ip: t.ip, id_hardware_confere: t.hardwareConfere },
          chaveDeduplicacao: `token_anterior:${t.terminalId}`,
        })
        .onConflictDoNothing()
        .returning({ id: alertas.id });
      if (novo.length === 0) return;
      await this.auditoria.registrar(
        tx,
        { origem: 'pdv', terminalId: t.terminalId, lojaId: t.lojaId, ip: t.ip },
        {
          acao: 'token_anterior_reutilizado',
          entidade: 'terminais',
          registroId: t.terminalId,
          localizacao: 'PDV › Sincronização',
          descricao: 'Token anterior do terminal usado depois que o token novo já estava em uso',
          depois: { ip: t.ip, id_hardware_confere: t.hardwareConfere },
        },
      );
    });
  }
}
