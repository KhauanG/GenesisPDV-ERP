/**
 * Código de ativação (ERP 12.3; SYNC 3.1) e `POST /sync/ativar` (SYNC 3.2–3.4): validações em ordem, três commits
 * (controle → empresa idempotente → controle) com o estado intermediário `provisionando`, compensação quando a etapa
 * da empresa falha e repetição segura com o mesmo `requisicao_ativacao_id`.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { setTimeout as esperar } from 'node:timers/promises';
import { SALTO_SEGURANCA_NUMERACAO, type BloqueioAtivacoes } from '@genesis/shared';
import { and, count, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErroApi } from '../comum/erros.js';
import type { BancoControle, DbControle } from '../database/controle/conexao.js';
import {
  ativacoesPdv,
  auditoriaPlataforma,
  empresas,
  planos,
  tentativasAtivacao,
  terminaisPdv,
  versoesAppPdv,
} from '../database/controle/schema.js';
import { auditoria } from '../database/empresa/auditoria.js';
import {
  alertas,
  caixas,
  comandosTerminal,
  configuracoes,
  lojas,
  numeracoes,
  terminais,
} from '../database/empresa/schema/index.js';
import { registrarAuditoriaPlataforma } from '../plataforma/auditoria-plataforma.js';
import type { Cifra } from '../seguranca/cifra.js';
import { cifrarParaTerminal, lerChavePublica } from '../seguranca/ecies.js';
import { gerarSegredo, sha256Hex } from '../seguranca/tokens.js';
import type { EmpresaResolvida, ResolvedorEmpresas } from '../tenancy/resolvedor.js';
import type { DbEmpresa, Tenancy } from '../tenancy/tenancy.js';
import {
  ALERTA_FORCA_BRUTA,
  alertarEventosNaoResolvidos,
  aplicarEstadoNaEmpresa,
  MOTIVOS_REVOGACAO,
} from '../terminais/revogacao.js';
import { ALFABETO_ATIVACAO, type Ativar, type RespostaAtivacao } from './contratos.js';
import { ErroSync } from './erros.js';
import { FLUXOS } from './fluxos.js';
import { fecharSessoesDoTerminal } from './sessoes-caixa.js';
import { compararVersoes } from './versoes-app.js';

export const AAD_CHAVE_BACKUP = 'terminais_pdv.chave_backup_cifrada';
/** Falhas de ativação antes de "Liberar ativações" não contam; `parametro` é o do código da empresa na consulta. */
const liberadasEm = (parametro: string) =>
  `coalesce((select e.ativacoes_liberadas_em from empresas e where e.codigo = ${parametro}), '-infinity'::timestamptz)`;
/**
 * Janela de repetição da ativação (SYNC 3.4), medida pelo relógio do banco (`ativado_em` é `now()` do controle). A
 * manutenção só compensa um `provisionando` depois dela, com margem (`PROVISIONANDO_ESQUECIDO_MIN`).
 */
export const REPETICAO_MIN = 15;
const MOTIVOS_FORCA_BRUTA = ['codigo_invalido', 'expirado', 'empresa_inativa'] as const;
/** SYNC 3.1: falhas de "código errado" em 1 h que bloqueiam o código da empresa. */
export const LIMITE_FALHAS_CODIGO_EMPRESA = 20;

export const INTERVALOS_PADRAO = { heartbeat_s: 30, pull_s: 30, pull_com_sse_s: 300, push_pendente_s: 15 };

type Motivo = (typeof MOTIVOS_FORCA_BRUTA)[number] | 'limite_plano' | 'ip_bloqueado' | null;

export type NumeracoesAtivacao = RespostaAtivacao['numeracoes'];

export function hashCodigoAtivacao(codigoEmpresa: number, codigo: string): string {
  return sha256Hex(`${codigoEmpresa}:${codigo.replace(/[\s-]/g, '').toUpperCase()}`);
}

export class AtivacaoTerminais {
  constructor(
    private readonly controle: BancoControle,
    private readonly resolvedor: ResolvedorEmpresas,
    private readonly tenancy: Tenancy,
    private readonly auditoria: AuditoriaService,
    private readonly cifra: Cifra,
  ) {}

  /** ERP 12.3: gera o código (exibido uma vez) para um caixa de uma loja ponto de venda com PDV. */
  async gerarCodigo(
    empresa: EmpresaResolvida,
    entrada: {
      lojaId: string;
      caixaId: string;
      descricao?: string | null;
      validadeHoras: 1 | 24 | 72;
      substituiTerminalId?: string | null;
    },
    usuario: { id: string; nome: string },
  ): Promise<{ codigo: string; codigoExibicao: string; expiraEm: string; ativacaoId: string }> {
    const caixa = await this.tenancy.executarNaEmpresa(this.resolvedor.contexto(empresa), () =>
      this.tenancy.cx().consulta(async (db) => {
        const [c] = await db
          .select({ id: caixas.id, numero: caixas.numero, lojaId: caixas.lojaId, loja: lojas })
          .from(caixas)
          .innerJoin(lojas, eq(lojas.id, caixas.lojaId))
          .where(and(eq(caixas.id, entrada.caixaId), isNull(caixas.excluidoEm), isNull(lojas.excluidoEm)));
        return c;
      }),
    );
    if (!caixa || caixa.lojaId !== entrada.lojaId)
      throw ErroApi.naoEncontrado('Caixa não encontrado nesta loja.');
    if (caixa.numero < 1) throw new ErroApi('REGRA_NEGOCIO', 'O caixa 0 (sistema) não aceita terminal.');
    if (caixa.loja.tipo !== 'ponto_venda' || !caixa.loja.ativa || !caixa.loja.usaPdv) {
      throw new ErroApi('REGRA_NEGOCIO', 'A loja precisa ser ponto de venda ativa e com "Usa PDV".');
    }
    const codigo = Array.from(
      { length: 8 },
      () => ALFABETO_ATIVACAO[randomInt(ALFABETO_ATIVACAO.length)],
    ).join('');
    const expira = new Date(Date.now() + entrada.validadeHoras * 3_600_000);
    const id = await this.controle.transacao(async (tx) => {
      await this.garantirLimitePlano(tx, empresa.id, 1);
      const [ocupante] = await tx
        .select({ id: terminaisPdv.id })
        .from(terminaisPdv)
        .where(
          and(
            eq(terminaisPdv.empresaId, empresa.id),
            eq(terminaisPdv.caixaId, entrada.caixaId),
            inArray(terminaisPdv.status, ['provisionando', 'ativo']),
          ),
        );
      if (ocupante && ocupante.id !== entrada.substituiTerminalId) {
        throw new ErroApi(
          'REGRA_NEGOCIO',
          'Caixa já ocupado por um terminal ativo: use "Substituir terminal".',
        );
      }
      const [a] = await tx
        .insert(ativacoesPdv)
        .values({
          empresaId: empresa.id,
          lojaId: entrada.lojaId,
          caixaId: entrada.caixaId,
          numeroCaixa: caixa.numero,
          descricao: entrada.descricao ?? null,
          codigoHash: hashCodigoAtivacao(empresa.codigo, codigo),
          codigoFinal: codigo.slice(-2),
          validadeHoras: entrada.validadeHoras,
          expiraEm: expira,
          substituiTerminalId: ocupante ? ocupante.id : null,
          criadoPorUsuarioId: usuario.id,
          criadoPorNome: usuario.nome.slice(0, 100),
        })
        .returning({ id: ativacoesPdv.id });
      return a!.id;
    });
    return {
      codigo,
      codigoExibicao: `${codigo.slice(0, 4)}-${codigo.slice(4)}`,
      expiraEm: expira.toISOString(),
      ativacaoId: id,
    };
  }

  async ativar(entrada: Ativar, meta: { ip: string; requisicaoId: string }): Promise<RespostaAtivacao> {
    const { ip } = meta;
    await this.verificarBloqueios(ip, entrada.codigo_empresa);
    const falhar = async (erro: ErroSync, motivo: Motivo): Promise<never> => {
      await this.controle.db.insert(tentativasAtivacao).values({
        ip,
        codigoEmpresa: entrada.codigo_empresa,
        sucesso: false,
        motivoFalha: motivo,
      });
      if (motivo && (MOTIVOS_FORCA_BRUTA as readonly string[]).includes(motivo)) {
        await this.alertarForcaBruta(entrada.codigo_empresa).catch(() => undefined);
      }
      // Força bruta global (SYNC 3.1): acima de 500 falhas em 10 min, toda falha responde com atraso fixo.
      const [g] = await this.controle.db
        .select({ n: count() })
        .from(tentativasAtivacao)
        .where(
          and(
            eq(tentativasAtivacao.sucesso, false),
            gt(tentativasAtivacao.criadoEm, sql`now() - interval '10 minutes'`),
          ),
        );
      if ((g?.n ?? 0) > 500) await esperar(3000);
      throw erro;
    };
    const invalido = new ErroSync('CODIGO_INVALIDO', 'Código de ativação inválido.');

    const empresa = await this.resolvedor.porCodigo(entrada.codigo_empresa);
    if (!empresa || empresa.excluida || empresa.status !== 'ativa')
      return falhar(invalido, 'empresa_inativa');
    if (empresa.emManutencao) throw ErroSync.manutencao();
    const hash = hashCodigoAtivacao(entrada.codigo_empresa, entrada.codigo_ativacao);
    const chavePublica = Buffer.from(entrada.chave_publica_terminal.chave, 'base64');
    const chaveBackupPublica = Buffer.from(entrada.chave_backup_publica, 'base64');
    try {
      lerChavePublica(chavePublica, entrada.chave_publica_terminal.algoritmo);
      lerChavePublica(chaveBackupPublica, 'x25519');
    } catch {
      throw ErroSync.invalida('Chave pública do terminal inválida.');
    }

    const [ativacao] = await this.controle.db
      .select()
      .from(ativacoesPdv)
      .where(and(eq(ativacoesPdv.codigoHash, hash), eq(ativacoesPdv.empresaId, empresa.id)))
      .orderBy(sql`${ativacoesPdv.criadoEm} desc`)
      .limit(1);
    if (!ativacao) return falhar(invalido, 'codigo_invalido');
    if (ativacao.status === 'usado') return this.repetir(ativacao, entrada, empresa, meta, falhar);
    if (ativacao.status !== 'pendente') return falhar(invalido, 'codigo_invalido');
    if (ativacao.expiraEm <= new Date()) {
      return falhar(
        new ErroSync('CODIGO_EXPIRADO', 'Código de ativação expirado. Gere outro no ERP.'),
        'expirado',
      );
    }

    // 5: loja e PDV habilitados (leitura no banco da empresa, antes do primeiro commit).
    const contexto = this.resolvedor.contexto(empresa);
    const loja = await this.tenancy.executarNaEmpresa(contexto, () =>
      this.tenancy.cx().consulta(async (db) => {
        const [l] = await db.select().from(lojas).where(eq(lojas.id, ativacao.lojaId));
        const desligado = await db
          .select({ id: configuracoes.id })
          .from(configuracoes)
          .where(
            and(
              eq(configuracoes.chave, 'pdv.usa_pdv'),
              isNull(configuracoes.excluidoEm),
              sql`${configuracoes.valor} = 'false'::jsonb`,
              sql`(${configuracoes.escopo} = 'empresa' or ${configuracoes.lojaId} = ${ativacao.lojaId})`,
            ),
          );
        return l ? { ...l, pdvDesligado: desligado.length > 0 } : null;
      }),
    );
    if (!loja || loja.excluidoEm || !loja.ativa || loja.tipo !== 'ponto_venda') {
      return falhar(new ErroSync('LOJA_INATIVA', 'Loja inativa ou sem PDV.'), null);
    }
    if (!loja.usaPdv || loja.pdvDesligado) {
      return falhar(new ErroSync('PDV_DESABILITADO', 'O PDV está desabilitado para esta loja.'), null);
    }
    // 8: versão mínima do app para a plataforma e o canal da empresa.
    await this.garantirVersaoMinima(empresa.id, entrada.maquina.plataforma, entrada.maquina.versao_app);

    const segredo = gerarSegredo();
    const terminalId = uuidv7();
    const chaveBackup = randomBytes(32);
    // 1º commit: terminal `provisionando` ocupa o caixa e o código vira `usado`.
    await this.controle
      .transacao(async (tx) => {
        const [a] = await tx
          .select()
          .from(ativacoesPdv)
          .where(eq(ativacoesPdv.id, ativacao.id))
          .for('update');
        if (!a || a.status !== 'pendente') throw invalido;
        // Uma ativação por caixa de cada vez: dois códigos do mesmo caixa (vazio, ou ambos substituindo o mesmo terminal)
        // leriam os mesmos `ocupantes` em READ COMMITTED e o segundo morreria no `uq_terminais_pdv_caixa_ativo` (500).
        // Com a trava, o segundo lê o `provisionando` do primeiro e recebe `CAIXA_OCUPADO`.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`ativacao:caixa:${empresa.id}:${a.caixaId}`}, 0))`,
        );
        // 6: limite do plano, contando este código (que vira terminal).
        await this.garantirLimitePlano(tx, empresa.id, 0).catch(() => {
          throw new ErroSync('LIMITE_PLANO', 'Limite de terminais do plano atingido.');
        });
        // 7: caixa livre (ou substituição do terminal que o ocupa).
        const ocupantes = await tx
          .select({ id: terminaisPdv.id })
          .from(terminaisPdv)
          .where(
            and(
              eq(terminaisPdv.empresaId, empresa.id),
              eq(terminaisPdv.caixaId, a.caixaId),
              inArray(terminaisPdv.status, ['provisionando', 'ativo']),
            ),
          );
        if (ocupantes.some((o) => o.id !== a.substituiTerminalId)) {
          throw new ErroSync('CAIXA_OCUPADO', 'O caixa já tem um terminal ativo.');
        }
        // Substituição: o antigo sai de `ativo` antes do insert (`uq_terminais_pdv_caixa_ativo`) e só aponta para o
        // novo depois dele (`fk_terminais_pdv_substituido_por_terminal_id` não é adiável).
        const substituido = a.substituiTerminalId && ocupantes.length ? a.substituiTerminalId : null;
        if (substituido) {
          await tx
            .update(terminaisPdv)
            .set({ status: 'desativando', carenciaAte: sql`now() + interval '7 days'` })
            .where(eq(terminaisPdv.id, substituido));
        }
        await tx.insert(terminaisPdv).values({
          id: terminalId,
          empresaId: empresa.id,
          lojaId: a.lojaId,
          caixaId: a.caixaId,
          numeroCaixa: a.numeroCaixa,
          descricao: a.descricao,
          tokenHash: sha256Hex(segredo),
          chaveBackupCifrada: this.cifra.cifrar(chaveBackup, AAD_CHAVE_BACKUP),
          chavePublicaTerminal: chavePublica,
          chavePublicaAlgoritmo: entrada.chave_publica_terminal.algoritmo,
          status: 'provisionando',
          ativadoPorUsuarioId: a.criadoPorUsuarioId,
          ativacaoId: a.id,
          nomeMaquina: entrada.maquina.nome_maquina,
          sistemaOperacional: entrada.maquina.sistema_operacional,
          idHardware: entrada.maquina.id_hardware,
          versaoApp: entrada.maquina.versao_app,
          ultimoIp: ip,
        });
        if (substituido) {
          await tx
            .update(terminaisPdv)
            .set({ substituidoPorTerminalId: terminalId })
            .where(eq(terminaisPdv.id, substituido));
        }
        await tx
          .update(ativacoesPdv)
          .set({ status: 'usado', usadoEm: new Date(), usadoIp: ip, terminalId })
          .where(eq(ativacoesPdv.id, a.id));
        await tx.insert(tentativasAtivacao).values({ ip, codigoEmpresa: empresa.codigo, sucesso: true });
        await registrarAuditoriaPlataforma(tx, {
          empresaId: empresa.id,
          acao: 'terminal_ativacao_iniciada',
          entidade: 'terminais_pdv',
          registroId: terminalId,
          depois: {
            requisicao_ativacao_id: entrada.requisicao_ativacao_id,
            id_hardware: entrada.maquina.id_hardware,
            caixa_id: a.caixaId,
          },
          ip,
        });
      })
      .catch(async (e) => {
        if (e instanceof ErroSync && e.codigo === 'LIMITE_PLANO') return falhar(e, 'limite_plano');
        if (e instanceof ErroSync && e.codigo === 'CODIGO_INVALIDO') return falhar(e, 'codigo_invalido');
        if (e instanceof ErroSync) return falhar(e, null);
        throw e;
      });

    return this.concluir(empresa, terminalId, segredo, chaveBackup, chaveBackupPublica, entrada, meta);
  }

  /** Repetição da mesma ativação (resposta perdida, SYNC 3.4): mesmo `requisicao_ativacao_id` e `id_hardware`. */
  private async repetir(
    ativacao: typeof ativacoesPdv.$inferSelect,
    entrada: Ativar,
    empresa: EmpresaResolvida,
    meta: { ip: string; requisicaoId: string },
    falhar: (erro: ErroSync, motivo: Motivo) => Promise<never>,
  ): Promise<RespostaAtivacao> {
    const invalido = new ErroSync('CODIGO_INVALIDO', 'Código de ativação inválido.');
    if (!ativacao.terminalId) return falhar(invalido, 'codigo_invalido');
    const [linha] = await this.controle.db
      .select({
        t: terminaisPdv,
        vencida: sql<boolean>`${terminaisPdv.ativadoEm} < now() - make_interval(mins => ${REPETICAO_MIN})`,
      })
      .from(terminaisPdv)
      .where(eq(terminaisPdv.id, ativacao.terminalId));
    const t = linha?.t;
    const [inicio] = await this.controle.db
      .select({ depois: auditoriaPlataforma.depois })
      .from(auditoriaPlataforma)
      .where(
        and(
          eq(auditoriaPlataforma.registroId, ativacao.terminalId),
          eq(auditoriaPlataforma.acao, 'terminal_ativacao_iniciada'),
        ),
      );
    const depois = (inicio?.depois ?? {}) as { requisicao_ativacao_id?: string; id_hardware?: string };
    const mesma =
      !!t &&
      depois.requisicao_ativacao_id === entrada.requisicao_ativacao_id &&
      depois.id_hardware === entrada.maquina.id_hardware &&
      t.idHardware === entrada.maquina.id_hardware;
    if (!mesma || !t || (t.status !== 'provisionando' && t.status !== 'ativo'))
      return falhar(invalido, 'codigo_invalido');
    if (linha.vencida) {
      return falhar(
        new ErroSync('CODIGO_USADO', 'Este código já foi usado para ativar este terminal.'),
        'codigo_invalido',
      );
    }
    // Segredo novo: o anterior pode ter se perdido com a resposta.
    const segredo = gerarSegredo();
    const chaveBackup = this.cifra.decifrar(t.chaveBackupCifrada!, AAD_CHAVE_BACKUP);
    await this.controle.db
      .update(terminaisPdv)
      .set({ tokenHash: sha256Hex(segredo), tokenEmitidoEm: new Date(), tokenAtualUsadoEm: null })
      .where(eq(terminaisPdv.id, t.id));
    return this.concluir(
      empresa,
      t.id,
      segredo,
      chaveBackup,
      Buffer.from(entrada.chave_backup_publica, 'base64'),
      entrada,
      meta,
    );
  }

  /** Etapa da empresa (idempotente) + 3º commit; falha controlada compensa e responde 503. */
  private async concluir(
    empresa: EmpresaResolvida,
    terminalId: string,
    segredo: string,
    chaveBackup: Buffer,
    chaveBackupPublica: Buffer,
    entrada: Ativar,
    meta: { ip: string; requisicaoId: string },
  ): Promise<RespostaAtivacao> {
    const [t] = await this.controle.db.select().from(terminaisPdv).where(eq(terminaisPdv.id, terminalId));
    if (!t) throw ErroSync.manutencao();
    let etapa: {
      loja: typeof lojas.$inferSelect;
      caixa: typeof caixas.$inferSelect;
      numeracoes: NumeracoesAtivacao;
    };
    try {
      etapa = await this.etapaEmpresa(empresa, t, entrada, meta);
    } catch (e) {
      // Se a própria compensação falhar (ex.: o banco da empresa fora do ar), a manutenção a refaz depois.
      await this.compensar(terminalId).catch(() => false);
      if (e instanceof ErroSync) throw e;
      throw ErroSync.manutencao();
    }
    const promovidos = await this.controle.db
      .update(terminaisPdv)
      .set({ status: 'ativo' })
      .where(and(eq(terminaisPdv.id, terminalId), eq(terminaisPdv.status, 'provisionando')))
      .returning({ id: terminaisPdv.id });
    if (!promovidos.length) {
      // Já `ativo` (repetição de uma ativação concluída, ou a manutenção concluiu antes): segue normal. Qualquer outro
      // estado (compensado pela manutenção enquanto a etapa rodava, revogado no ERP) não pode receber o token: o PDV
      // gravaria uma identidade que leva 401 na primeira chamada. A etapa da empresa que acabou de commitar fica para a
      // reconciliação, que leva o novo ao `revogado` do controle (e libera o caixa); se o código voltou a `pendente`, a
      // nova tentativa ativa.
      const [atual] = await this.controle.db
        .select({ status: terminaisPdv.status })
        .from(terminaisPdv)
        .where(eq(terminaisPdv.id, terminalId));
      if (atual?.status !== 'ativo') throw ErroSync.manutencao();
    }
    return {
      terminal_id: terminalId,
      token: `${terminalId}.${segredo}`,
      token_emitido_em: new Date().toISOString(),
      renovar_token_apos_dias: 30,
      empresa: { codigo: empresa.codigo, razao_social: empresa.razaoSocial },
      loja: {
        id: etapa.loja.id,
        codigo: etapa.loja.codigo,
        nome: etapa.loja.nome,
        cnpj: etapa.loja.cnpj,
        fuso_horario: etapa.loja.fusoHorario,
        estoque_id: etapa.loja.estoqueId,
        tipo_emissao: etapa.loja.tipoEmissao as RespostaAtivacao['loja']['tipo_emissao'],
      },
      caixa: { id: etapa.caixa.id, numero: etapa.caixa.numero, nfce_serie: etapa.caixa.nfceSerie },
      numeracoes: etapa.numeracoes,
      sequencia_terminal: { ultima_recebida: 0 },
      fluxos: [...FLUXOS],
      chave_backup_cifrada: cifrarParaTerminal(chaveBackupPublica, 'x25519', chaveBackup).toString('base64'),
      intervalos: INTERVALOS_PADRAO,
      versao_protocolo: 1,
      agora_servidor: new Date().toISOString(),
    };
  }

  /**
   * Compensação da ativação que não concluiu (SYNC 3.4): o `provisionando` vira `revogado` (`falha_ativacao`), a
   * substituição é desfeita e o código volta a `pendente` se ainda não venceu. Usada na falha da etapa da empresa e
   * pela manutenção periódica (provisionando esquecido). Devolve `false` se o terminal já não estava
   * `provisionando` (ativação concluída: nada a desfazer).
   */
  async compensar(terminalId: string): Promise<boolean> {
    return this.controle.transacao(async (tx) => {
      const revogados = await tx
        .update(terminaisPdv)
        .set({ status: 'revogado', motivoRevogacao: MOTIVOS_REVOGACAO.falhaAtivacao, revogadoEm: new Date() })
        .where(and(eq(terminaisPdv.id, terminalId), eq(terminaisPdv.status, 'provisionando')))
        .returning({
          id: terminaisPdv.id,
          ativacaoId: terminaisPdv.ativacaoId,
          empresaId: terminaisPdv.empresaId,
        });
      // Já `ativo` (repetição de uma ativação concluída): não há o que desfazer.
      if (!revogados.length) return false;
      // Substituição desfeita: o antigo volta a `ativo` (no banco da empresa ele nunca saiu, a etapa fez rollback);
      // senão o próximo heartbeat lhe entrega `revogar` e o caixa fica sem terminal. Só se ainda apontar para este
      // novo: uma revogação feita no ERP nesse meio-tempo prevalece.
      const restaurados = await tx
        .update(terminaisPdv)
        .set({ status: 'ativo', carenciaAte: null, substituidoPorTerminalId: null })
        .where(
          and(eq(terminaisPdv.substituidoPorTerminalId, terminalId), eq(terminaisPdv.status, 'desativando')),
        )
        .returning({ id: terminaisPdv.id });
      // O `revogar` que porventura chegou a ser gravado para o antigo nessa janela (o heartbeat e o ERP já não o
      // gravam durante a substituição; este é o caso de quem ganhou a corrida) não pode descer depois. Dentro da
      // transação do controle: se o banco da empresa falhar, nada da compensação vale e a manutenção a refaz.
      if (restaurados.length)
        await this.cancelarRevogar(
          revogados[0]!.empresaId,
          restaurados.map((r) => r.id),
        );
      await tx
        .update(ativacoesPdv)
        .set({ status: 'pendente', usadoEm: null, usadoIp: null, terminalId: null })
        .where(and(eq(ativacoesPdv.id, revogados[0]!.ativacaoId), gt(ativacoesPdv.expiraEm, sql`now()`)));
      return true;
    });
  }

  /** `revogar` pendente/entregue dos terminais devolvidos a `ativo` pela compensação vira `cancelado`. */
  private async cancelarRevogar(empresaId: string, terminalIds: string[]): Promise<void> {
    const empresa = await this.resolvedor.porId(empresaId);
    if (!empresa || empresa.excluida) return;
    await this.tenancy.executarNaEmpresa(this.resolvedor.contexto(empresa), () =>
      this.tenancy.cx().transacao(async (db) => {
        await db
          .update(comandosTerminal)
          .set({ status: 'cancelado' })
          .where(
            and(
              inArray(comandosTerminal.terminalId, terminalIds),
              eq(comandosTerminal.tipo, 'revogar'),
              inArray(comandosTerminal.status, ['pendente', 'entregue']),
              isNull(comandosTerminal.excluidoEm),
            ),
          );
      }),
    );
  }

  /**
   * Etapa no banco da empresa (SYNC 3.4): `terminais` (on conflict do nothing), troca de `caixas.terminal_id`
   * só se ainda não for o novo, numerações (SYNC 13.3) calculadas uma vez e gravadas em `auditoria`
   * `terminal_ativado` — a repetição reusa a decisão gravada.
   *
   * Antes do insert, os terminais anteriores do caixa que o controle já tirou de `ativo` (o substituído foi para
   * `desativando` no 1º commit; um revogado cuja etapa da empresa não rodou) saem de `ativo` também aqui: senão o
   * `uq_terminais_caixa_ativo` recusa o novo e a substituição nunca conclui. O revogado passa pela mesma
   * `aplicarEstadoNaEmpresa` da revogação (a transação já tem `travaVersao`). A sessão de caixa aberta do terminal que
   * sai fecha à força na mesma transação (MD 3.12.1).
   */
  private async etapaEmpresa(
    empresa: EmpresaResolvida,
    t: typeof terminaisPdv.$inferSelect,
    entrada: Ativar,
    meta: { ip: string; requisicaoId: string },
  ) {
    const contexto = this.resolvedor.contexto(empresa);
    const anteriores = await this.controle.db
      .select()
      .from(terminaisPdv)
      .where(
        and(
          eq(terminaisPdv.empresaId, empresa.id),
          eq(terminaisPdv.caixaId, t.caixaId),
          ne(terminaisPdv.id, t.id),
          inArray(terminaisPdv.status, ['desativando', 'revogado']),
        ),
      );
    return this.tenancy.executarNaEmpresa(contexto, () =>
      this.tenancy.cx().transacao(
        async (tx) => {
          const [loja] = await tx.select().from(lojas).where(eq(lojas.id, t.lojaId));
          const [caixa] = await tx.select().from(caixas).where(eq(caixas.id, t.caixaId)).for('update');
          if (!loja || !caixa) throw new ErroSync('CAIXA_OCUPADO', 'Caixa não encontrado.');
          for (const a of anteriores) {
            if (a.status === 'revogado') {
              // A revogação cuja etapa da empresa não rodou (ex.: falhou depois do controle) é completada aqui por
              // inteiro: caixa, auditoria, anulação do modo perdido e alerta da D20, como faria a manutenção.
              await aplicarEstadoNaEmpresa(
                tx,
                this.auditoria,
                a,
                { origem: 'sistema', terminalId: a.id },
                { localizacao: 'PDV › Ativação' },
              );
              continue;
            }
            const saiu = await tx
              .update(terminais)
              .set({ status: 'desativando' })
              .where(and(eq(terminais.id, a.id), eq(terminais.status, 'ativo')))
              .returning({ id: terminais.id });
            // D20: a numeração passa ao novo na hora; eventos do antigo em erro/retido viram alerta no ERP. Vale
            // também para o `desativando` que ainda ocupava o caixa (aceitar pendências e código novo sem
            // substituição): ele sai do caixa agora.
            if (saiu.length || caixa.terminalId === a.id) {
              await alertarEventosNaoResolvidos(tx, a, 'Terminal substituído por um novo no mesmo caixa');
              // MD 3.12.1: o turno aberto do substituído fecha agora; o fechamento dele, se chegar, é gravado.
              await fecharSessoesDoTerminal(tx, a.id, 'substituicao_terminal');
            }
          }
          await tx
            .insert(terminais)
            .values({
              id: t.id,
              lojaId: t.lojaId,
              caixaId: t.caixaId,
              descricao: t.descricao,
              status: 'ativo',
              nomeMaquina: t.nomeMaquina,
              sistemaOperacional: t.sistemaOperacional,
              idHardware: t.idHardware,
              versaoApp: t.versaoApp,
              ativadoEm: t.ativadoEm,
              ativadoPorId: t.ativadoPorUsuarioId,
              versaoSchemaLocal: entrada.maquina.versao_schema_local,
            })
            .onConflictDoNothing({ target: terminais.id });
          const [ja] = await tx
            .select({ depois: auditoria.depois })
            .from(auditoria)
            .where(and(eq(auditoria.acao, 'terminal_ativado'), eq(auditoria.registroId, t.id)))
            .limit(1);
          if (ja) {
            const caixaAtual = (await tx.select().from(caixas).where(eq(caixas.id, t.caixaId)))[0]!;
            return {
              loja,
              caixa: caixaAtual,
              numeracoes: (ja.depois as { numeracoes: NumeracoesAtivacao }).numeracoes,
            };
          }
          const anteriorId = caixa.terminalId ?? caixa.terminalAnteriorId;
          const decisao = await this.decidirNumeracao(tx, caixa, anteriorId, t.id);
          if (caixa.terminalId !== t.id) {
            await tx
              .update(caixas)
              .set({ terminalAnteriorId: caixa.terminalId ?? caixa.terminalAnteriorId, terminalId: t.id })
              .where(eq(caixas.id, caixa.id));
          }
          await this.auditoria.registrar(
            tx,
            {
              origem: 'sistema',
              terminalId: t.id,
              lojaId: t.lojaId,
              ip: meta.ip,
              requisicaoId: meta.requisicaoId,
            },
            {
              acao: 'terminal_ativado',
              entidade: 'terminais',
              registroId: t.id,
              localizacao: 'PDV › Ativação',
              descricao: `Terminal ativado no caixa ${caixa.numero}${decisao.salto ? ' (salto de segurança na numeração)' : ''}`,
              depois: {
                requisicao_ativacao_id: entrada.requisicao_ativacao_id,
                terminal_anterior_id: anteriorId,
                numeracoes: decisao.numeracoes,
                salto: decisao.salto,
                motivo: decisao.motivo,
              },
            },
          );
          const [caixaFinal] = await tx.select().from(caixas).where(eq(caixas.id, t.caixaId));
          return { loja, caixa: caixaFinal!, numeracoes: decisao.numeracoes };
        },
        // Rota do PDV: espera a 7300001 sem limite, como o push (o `lock_timeout` é só do ERP, C13).
        { travaVersao: true, esperaSemLimite: true },
      ),
    );
  }

  /**
   * SYNC 13.3: sem terminal anterior, a base é `numeracoes`; anterior com desativação confirmada continua a série;
   * sem confirmação, salto de +1000 em venda e vale. A série NFC-e nova (escolhida no ERP ao gerar o código) entra
   * com a fase fiscal (3F): por ora as séries NFC-e voltam como estão.
   */
  private async decidirNumeracao(
    tx: DbEmpresa,
    caixa: typeof caixas.$inferSelect,
    anteriorId: string | null,
    novoId: string,
  ): Promise<{ numeracoes: NumeracoesAtivacao; salto: boolean; motivo: string }> {
    const linhas = await tx
      .select()
      .from(numeracoes)
      .where(and(eq(numeracoes.caixaId, caixa.id), isNull(numeracoes.excluidoEm)));
    const ultimo = (tipo: string) => linhas.find((l) => l.tipo === tipo)?.ultimoNumero ?? 0;
    let venda = ultimo('venda');
    let vale = ultimo('vale');
    let salto = false;
    let motivo = 'caixa sem terminal anterior';
    if (anteriorId && anteriorId !== novoId) {
      const [ant] = await tx.select().from(terminais).where(eq(terminais.id, anteriorId));
      venda = Math.max(venda, ant?.desativacaoVendaUltimoNumero ?? 0, ant?.vendaUltimoNumero ?? 0);
      vale = Math.max(vale, ant?.desativacaoValeUltimoNumero ?? 0, ant?.valeUltimoNumero ?? 0);
      if (ant?.desativacaoConfirmadaEm) {
        motivo = 'terminal anterior confirmou a desativação';
      } else {
        venda += SALTO_SEGURANCA_NUMERACAO;
        vale += SALTO_SEGURANCA_NUMERACAO;
        salto = true;
        motivo = 'terminal anterior sem confirmação de desativação';
      }
    }
    for (const [tipo, valor] of [
      ['venda', venda],
      ['vale', vale],
    ] as const) {
      const existente = linhas.find((l) => l.tipo === tipo);
      if (existente) {
        if (existente.ultimoNumero !== valor) {
          await tx
            .update(numeracoes)
            .set({ ultimoNumero: valor, ultimoAtualizadoPorTerminalId: novoId })
            .where(eq(numeracoes.id, existente.id));
        }
      } else {
        await tx.insert(numeracoes).values({
          tipo,
          lojaId: caixa.lojaId,
          caixaId: caixa.id,
          ultimoNumero: valor,
          dono: 'terminal',
          ultimoAtualizadoPorTerminalId: novoId,
        });
      }
    }
    return {
      numeracoes: {
        venda: { ultimo_numero: venda },
        nfce: linhas
          .filter((l) => l.tipo === 'nfce' && l.serie !== null && l.ambiente !== null)
          .map((l) => ({ serie: l.serie!, ambiente: l.ambiente!, ultimo_numero: l.ultimoNumero })),
        vale: { ultimo_numero: vale },
      },
      salto,
      motivo,
    };
  }

  /**
   * SYNC 3.1: 5 falhas por IP em 10 min bloqueiam o IP por 30 min; 20 falhas em 1 h para o mesmo código de empresa
   * (exista ou não) bloqueiam aquele código por 1 h. Só contam as falhas de "código errado".
   */
  private async verificarBloqueios(ip: string, codigoEmpresa: number): Promise<void> {
    const { rows } = await this.controle.pool.query<{ ip: boolean; codigo: boolean }>(
      `select
         exists (select 1 from tentativas_ativacao t
                 where t.ip = $1 and not t.sucesso and t.motivo_falha = any($3) and t.criado_em > now() - interval '30 minutes'
                   and (select count(*) from tentativas_ativacao u
                        where u.ip = t.ip and not u.sucesso and u.motivo_falha = any($3)
                          and u.criado_em between t.criado_em - interval '10 minutes' and t.criado_em) >= 5) as ip,
         (select count(*) from tentativas_ativacao t
          where t.codigo_empresa = $2 and not t.sucesso and t.motivo_falha = any($3)
            and t.criado_em > now() - interval '1 hour'
            and t.criado_em > ${liberadasEm('$2')}) >= $4 as codigo`,
      [ip, codigoEmpresa, [...MOTIVOS_FORCA_BRUTA], LIMITE_FALHAS_CODIGO_EMPRESA],
    );
    if (rows[0]?.ip) {
      await this.controle.db
        .insert(tentativasAtivacao)
        .values({ ip, codigoEmpresa, sucesso: false, motivoFalha: 'ip_bloqueado' });
      throw new ErroSync(
        'IP_BLOQUEADO',
        'Muitas tentativas. Aguarde 30 minutos.',
        {},
        { 'Retry-After': '1800' },
      );
    }
    if (rows[0]?.codigo) {
      throw new ErroSync(
        'ATIVACAO_BLOQUEADA',
        'Ativações temporariamente bloqueadas. Peça ao gerente para liberar no ERP.',
        {},
        { 'Retry-After': '3600' },
      );
    }
  }

  /**
   * Estado do bloqueio do código da empresa para a tela (ERP 12.2): falhas que contam (última hora, depois da última
   * liberação) e quando o bloqueio cai sozinho (a 20ª falha mais recente sai da janela de 1 h).
   */
  async estadoBloqueio(codigoEmpresa: number): Promise<BloqueioAtivacoes> {
    const { rows } = await this.controle.pool.query<{ falhas: number; ate: Date | null }>(
      `with f as (
         select t.criado_em from tentativas_ativacao t
          where t.codigo_empresa = $1 and not t.sucesso and t.motivo_falha = any($2)
            and t.criado_em > now() - interval '1 hour' and t.criado_em > ${liberadasEm('$1')})
       select (select count(*)::int from f) as falhas,
              (select criado_em + interval '1 hour' from f order by criado_em desc offset ($3::int - 1) limit 1) as ate`,
      [codigoEmpresa, [...MOTIVOS_FORCA_BRUTA], LIMITE_FALHAS_CODIGO_EMPRESA],
    );
    const falhas = rows[0]?.falhas ?? 0;
    const bloqueado = falhas >= LIMITE_FALHAS_CODIGO_EMPRESA;
    return {
      bloqueado,
      falhas,
      limite: LIMITE_FALHAS_CODIGO_EMPRESA,
      ate: bloqueado && rows[0]?.ate ? rows[0].ate.toISOString() : null,
    };
  }

  /**
   * "Liberar ativações" (ERP 12.2; SYNC 3.1): as falhas anteriores deixam de contar para o bloqueio do código da
   * empresa (o bloqueio por IP continua). O alerta e a auditoria ficam com quem chama, no banco da empresa.
   */
  async liberarAtivacoes(empresaId: string): Promise<void> {
    await this.controle.db
      .update(empresas)
      .set({ ativacoesLiberadasEm: sql`now()` })
      .where(eq(empresas.id, empresaId));
  }

  /**
   * Alerta crítico `ATIVACAO_FORCA_BRUTA` no ERP da empresa (quando o código existe) ao atingir o bloqueio. Com o
   * alerta ainda aberto, só atualiza as falhas e o "até"; a manutenção o fecha quando o bloqueio cai sozinho.
   */
  private async alertarForcaBruta(codigoEmpresa: number): Promise<void> {
    const estado = await this.estadoBloqueio(codigoEmpresa);
    if (!estado.bloqueado) return;
    const empresa = await this.resolvedor.porCodigo(codigoEmpresa);
    if (!empresa || empresa.excluida || empresa.status !== 'ativa' || empresa.emManutencao) return;
    await this.tenancy.executarNaEmpresa(this.resolvedor.contexto(empresa), () =>
      this.tenancy.cx().transacao(async (tx) => {
        await tx
          .insert(alertas)
          .values({
            tipo: ALERTA_FORCA_BRUTA,
            severidade: 'critico',
            titulo: 'Ativações de PDV temporariamente bloqueadas',
            mensagem:
              `${estado.falhas} tentativas de ativação com código errado na última hora para o código da empresa. ` +
              'Se foi um engano, use "Liberar ativações" em PDVs/Terminais.',
            entidade: 'ativacoes_pdv',
            dados: { falhas: estado.falhas, ate: estado.ate },
            chaveDeduplicacao: `ativacao_forca_bruta:${codigoEmpresa}`,
          })
          .onConflictDoUpdate({
            target: alertas.chaveDeduplicacao,
            targetWhere: sql`resolvido_em is null and excluido_em is null`,
            set: { mensagem: sql`excluded.mensagem`, dados: sql`excluded.dados` },
          });
      }),
    );
  }

  /**
   * Manutenção: empresas (id → código) com falhas de "código errado" nos últimos `dias`, as únicas que podem ter o
   * alerta `ATIVACAO_FORCA_BRUTA` aberto.
   */
  async empresasComFalhasDeAtivacao(dias: number): Promise<Map<string, number>> {
    const { rows } = await this.controle.pool.query<{ id: string; codigo: number }>(
      `select distinct e.id, e.codigo from tentativas_ativacao t join empresas e on e.codigo = t.codigo_empresa
        where not t.sucesso and t.motivo_falha = any($1) and t.criado_em > now() - make_interval(days => $2)`,
      [[...MOTIVOS_FORCA_BRUTA], dias],
    );
    return new Map(rows.map((r) => [r.id, r.codigo]));
  }

  /** Manutenção: códigos `pendente` vencidos passam a `expirado` (ERP 12.1). */
  async expirarCodigos(): Promise<number> {
    const r = await this.controle.db
      .update(ativacoesPdv)
      .set({ status: 'expirado' })
      .where(and(eq(ativacoesPdv.status, 'pendente'), sql`${ativacoesPdv.expiraEm} <= now()`))
      .returning({ id: ativacoesPdv.id });
    return r.length;
  }

  /** Terminais provisionando/ativos/desativando + códigos pendentes ≤ limite (+ `acrescimo` do que vai nascer). */
  private async garantirLimitePlano(tx: DbControle, empresaId: string, acrescimo: number): Promise<void> {
    const [e] = await tx
      .select({ limite: sql<number>`coalesce(${empresas.limiteTerminais}, ${planos.limiteTerminais})` })
      .from(empresas)
      .innerJoin(planos, eq(planos.id, empresas.planoId))
      .where(eq(empresas.id, empresaId));
    const [term] = await tx
      .select({ n: count() })
      .from(terminaisPdv)
      .where(
        and(
          eq(terminaisPdv.empresaId, empresaId),
          inArray(terminaisPdv.status, ['provisionando', 'ativo', 'desativando']),
        ),
      );
    const [pend] = await tx
      .select({ n: count() })
      .from(ativacoesPdv)
      .where(
        and(
          eq(ativacoesPdv.empresaId, empresaId),
          eq(ativacoesPdv.status, 'pendente'),
          gt(ativacoesPdv.expiraEm, sql`now()`),
        ),
      );
    if ((term?.n ?? 0) + (pend?.n ?? 0) + acrescimo > Number(e?.limite ?? 0)) {
      throw new ErroApi('LIMITE_PLANO', 'Limite de terminais do plano atingido.');
    }
  }

  private async garantirVersaoMinima(
    empresaId: string,
    plataforma: string,
    versaoApp: string,
  ): Promise<void> {
    const [e] = await this.controle.db
      .select({ canal: empresas.canalPdv })
      .from(empresas)
      .where(eq(empresas.id, empresaId));
    const minimas = await this.controle.db
      .select({ versao: versoesAppPdv.versaoApp })
      .from(versoesAppPdv)
      .where(
        and(
          eq(versoesAppPdv.plataforma, plataforma),
          eq(versoesAppPdv.canal, e?.canal ?? 'estavel'),
          eq(versoesAppPdv.versaoMinima, true),
          isNull(versoesAppPdv.excluidoEm),
          sql`${versoesAppPdv.publicadaEm} is not null`,
        ),
      );
    const minima = minimas
      .map((m) => m.versao)
      .sort(compararVersoes)
      .at(-1);
    if (minima && compararVersoes(versaoApp, minima) < 0) {
      throw new ErroSync(
        'PROTOCOLO_NAO_SUPORTADO',
        `Versão ${versaoApp} abaixo da mínima ${minima}. Atualize o PDV.`,
        {
          versao_minima: minima,
        },
      );
    }
  }
}
