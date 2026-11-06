/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jcs } from '../jcs.js';
import {
  ACOES_LIBERACAO_VENDA,
  CONTRATOS_EVENTOS,
  formaVendaCancelada,
  MOTIVO_CANCELAMENTO_VENDA_MAX,
  MOTIVO_CANCELAMENTO_VENDA_MIN,
  MOVIMENTOS_CAIXA_CANCELAVEIS,
  payloadAlertaCadastroSchema,
  payloadCaixaAbertoSchema,
  payloadCaixaFechadoSchema,
  payloadCaixaMovimentoCanceladoSchema,
  payloadCaixaReforcoSchema,
  payloadCaixaSangriaSchema,
  payloadVasilhameMovimentadoSchema,
  payloadVendaCanceladaEmAndamentoSchema,
  payloadVendaCanceladaFinalizadaSchema,
  payloadVendaCanceladaSchema,
  payloadVendaFinalizadaSchema,
  type TipoEventoContratado,
} from './eventos.js';
import { chavesDescartadas, lerFixtureSync, pastaFixturesSync as pasta } from './fixtures.teste.js';

/**
 * Suíte de contrato dos payloads (SYNC 9, 17.5): cada `*.payload.json` passa pelo zod aqui e, no PDV, pelo
 * `ContratosEventosTests` (as de venda são exatamente o que a `FabricaEventos` gera). A fixture traz **todas** as
 * chaves do contrato em cada linha: é o que pega a chave com nome errado, já que o schema aceita chave desconhecida.
 * `eventos.conferencias.json` guarda o que os dois lados conferem igual (bordas do motivo, ações de liberação e o
 * `payload_sha256` de cada fixture).
 */
const ler = (nome: string) => lerFixtureSync<Record<string, unknown>>(nome);

/** O payload da auditoria é da Fase 0 e passa só pela suíte do protocolo (`contratos.spec.ts`). */
const DA_FASE_0 = 'auditoria.registros.payload.json';

/** Fixture → tipo do evento e schema da forma (o `venda.cancelada` tem duas). */
const FIXTURES: Record<string, { tipo: TipoEventoContratado; schema: z.ZodType }> = {
  'caixa.aberto.payload.json': { tipo: 'caixa.aberto', schema: payloadCaixaAbertoSchema },
  'caixa.reforco.payload.json': { tipo: 'caixa.reforco', schema: payloadCaixaReforcoSchema },
  'caixa.sangria.payload.json': { tipo: 'caixa.sangria', schema: payloadCaixaSangriaSchema },
  'caixa.movimento_cancelado.payload.json': {
    tipo: 'caixa.movimento_cancelado',
    schema: payloadCaixaMovimentoCanceladoSchema,
  },
  'caixa.fechado.payload.json': { tipo: 'caixa.fechado', schema: payloadCaixaFechadoSchema },
  'caixa.fechado.troca_turno.payload.json': { tipo: 'caixa.fechado', schema: payloadCaixaFechadoSchema },
  'venda.finalizada.payload.json': { tipo: 'venda.finalizada', schema: payloadVendaFinalizadaSchema },
  // C11a: maquininha, PIX estático com a cobrança, CPF/cliente e a ficha técnica do produzido (gerada pelo PDV).
  'venda.finalizada.formas.payload.json': { tipo: 'venda.finalizada', schema: payloadVendaFinalizadaSchema },
  // C11c: cascos descontados na venda (desconto_total de origem cliente e devolvidos além dos devidos).
  'venda.finalizada.cascos.payload.json': { tipo: 'venda.finalizada', schema: payloadVendaFinalizadaSchema },
  'venda.cancelada.em_andamento.payload.json': {
    tipo: 'venda.cancelada',
    schema: payloadVendaCanceladaEmAndamentoSchema,
  },
  'venda.cancelada.finalizada.payload.json': {
    tipo: 'venda.cancelada',
    schema: payloadVendaCanceladaFinalizadaSchema,
  },
  'vasilhame.movimentado.payload.json': {
    tipo: 'vasilhame.movimentado',
    schema: payloadVasilhameMovimentadoSchema,
  },
  'alerta.cadastro.payload.json': { tipo: 'alerta.cadastro', schema: payloadAlertaCadastroSchema },
};
const DE_EVENTO = Object.entries(FIXTURES);

const CONFERENCIAS = lerFixtureSync<{
  motivo_cancelamento_venda: { minimo: number; maximo: number; aceitos: string[]; recusados: string[] };
  acoes_liberacao_venda: string[];
  movimentos_caixa_cancelaveis: string[];
  payload_sha256: Record<string, string>;
}>('eventos.conferencias.json');

/** Tira `optional`/`nullable`/`default` até o schema de dentro. */
function desembrulhar(s: z.ZodType): z.ZodType {
  let atual = s;
  while (
    atual instanceof z.ZodOptional ||
    atual instanceof z.ZodNullable ||
    atual instanceof z.ZodDefault ||
    atual instanceof z.ZodPrefault
  ) {
    atual = atual.unwrap() as z.ZodType;
  }
  return atual;
}

/** Chaves do contrato ausentes na fixture, em qualquer nível (objeto do zod contra o objeto do JSON). */
function chavesAusentes(schema: z.ZodType, valor: unknown, caminho = ''): string[] {
  const s = desembrulhar(schema);
  if (s instanceof z.ZodArray && Array.isArray(valor)) {
    return valor.flatMap((v, i) => chavesAusentes(s.element as z.ZodType, v, `${caminho}[${i}]`));
  }
  if (!(s instanceof z.ZodObject) || !valor || typeof valor !== 'object') return [];
  return Object.entries(s.shape as Record<string, z.ZodType>).flatMap(([chave, sub]) => {
    const p = caminho ? `${caminho}.${chave}` : chave;
    return chave in valor ? chavesAusentes(sub, (valor as Record<string, unknown>)[chave], p) : [p];
  });
}

const problemas = (schema: z.ZodType, v: unknown) =>
  (schema.safeParse(v).error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`);

/**
 * Cópia profunda com a alteração aplicada (as fixtures não mudam entre os testes). O `any` é só para o teste mexer em
 * qualquer nível do JSON sem um tipo por fixture; o resultado volta como `unknown` para o schema.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function com(nome: string, mudar: (p: Record<string, any>) => void): Record<string, unknown> {
  const p = structuredClone(ler(nome));
  mudar(p);
  return p;
}

describe('payloads dos eventos (fixtures *.payload.json)', () => {
  it('toda fixture de payload da pasta tem schema aqui', () => {
    const arquivos = readdirSync(pasta).filter((f) => f.endsWith('.payload.json') && f !== DA_FASE_0);
    expect(arquivos.sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  it('o payload_sha256 de cada fixture é o mesmo que o PDV calcula (JCS, SYNC 7.3)', () => {
    // O ContratosEventosTests confere os mesmos hashes com o Jcs do C#: uma diferença de serialização entre as duas
    // linguagens (número, escape, ordem de chave) quebra um dos lados.
    const arquivos = readdirSync(pasta).filter((f) => f.endsWith('.payload.json'));
    const calculados = Object.fromEntries(
      arquivos.map((f) => [
        f,
        createHash('sha256')
          .update(jcs(ler(f)), 'utf8')
          .digest('hex'),
      ]),
    );
    expect(calculados).toEqual(CONFERENCIAS.payload_sha256);
  });

  it.each(Object.entries(FIXTURES))('%s passa pelo schema sem descartar chave', (nome, { schema }) => {
    const fixture = ler(nome);
    expect(problemas(schema, fixture)).toEqual([]);
    expect(chavesDescartadas(fixture, schema.parse(fixture))).toEqual([]);
  });

  it.each(DE_EVENTO)('%s traz todas as chaves do contrato em cada linha', (nome, { schema }) => {
    expect(chavesAusentes(schema, ler(nome))).toEqual([]);
  });

  it.each(DE_EVENTO)('%s passa pelo catálogo do tipo e dá o agregado do envelope', (nome, { tipo }) => {
    const contrato = CONTRATOS_EVENTOS[tipo as TipoEventoContratado];
    const p = contrato.versoes[1].parse(ler(nome));
    const id = (contrato.agregadoId as (p: unknown) => string)(p);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('venda.cancelada: a forma vem da chave e cada forma é validada só pelo seu schema', () => {
    const b = ler('venda.cancelada.em_andamento.payload.json');
    const a = ler('venda.cancelada.finalizada.payload.json');
    expect([formaVendaCancelada(b), formaVendaCancelada(a)]).toEqual(['em_andamento', 'finalizada']);
    expect(payloadVendaCanceladaSchema.parse(b)).toHaveProperty('itens_venda');
    expect(payloadVendaCanceladaSchema.parse(a)).toHaveProperty('sessao_caixa_cancelamento_id');
    // A B com erro aponta o erro dela, sem o "falta sessao_caixa_cancelamento_id" da A.
    const bRuim = com('venda.cancelada.em_andamento.payload.json', (p) => {
      p.vendas.motivo_cancelamento = 'curto';
    });
    expect(problemas(payloadVendaCanceladaSchema, bRuim)).toEqual([
      'vendas.motivo_cancelamento: motivo de 15 a 255 caracteres',
    ]);
  });

  it('motivo do cancelamento da venda: de 15 a 255 caracteres sem as pontas, nas duas formas e igual ao PDV (O6)', () => {
    const regra = CONFERENCIAS.motivo_cancelamento_venda;
    expect([regra.minimo, regra.maximo]).toEqual([
      MOTIVO_CANCELAMENTO_VENDA_MIN,
      MOTIVO_CANCELAMENTO_VENDA_MAX,
    ]);
    const casos = [
      ...regra.aceitos.map((motivo) => [motivo, true] as const),
      ...regra.recusados.map((motivo) => [motivo, false] as const),
    ];
    for (const nome of [
      'venda.cancelada.em_andamento.payload.json',
      'venda.cancelada.finalizada.payload.json',
    ]) {
      for (const [motivo, ok] of casos) {
        const r = payloadVendaCanceladaSchema.safeParse(
          com(nome, (v) => {
            v.vendas.motivo_cancelamento = motivo;
          }),
        );
        expect({ nome, motivo, ok: r.success }).toEqual({ nome, motivo, ok });
        // As duas formas gravam o motivo aparado (o PDV também manda aparado, `Venda.Cancelar`).
        if (r.success) expect(r.data.vendas.motivo_cancelamento).toBe(motivo.trim());
      }
    }
  });

  it('ações de liberação: as que o PDV gera (AcaoLiberacao) são as da conferência', () => {
    expect([...ACOES_LIBERACAO_VENDA]).toEqual(CONFERENCIAS.acoes_liberacao_venda);
  });

  it('movimentos canceláveis pelo caixa: os que o PDV deixa cancelar (TipoMovimentoCaixa.Cancelaveis) são os da conferência', () => {
    expect([...MOVIMENTOS_CAIXA_CANCELAVEIS]).toEqual(CONFERENCIAS.movimentos_caixa_cancelaveis);
  });

  it('venda: decimais na escala da coluna, linhas da própria venda e liberação de item da venda', () => {
    const nome = 'venda.finalizada.payload.json';
    const s = payloadVendaFinalizadaSchema;
    expect(
      problemas(
        s,
        com(nome, (p) => (p.vendas.total = '181.3')),
      ),
    ).toEqual(['vendas.total: decimal com 2 casas, sem sinal']);
    expect(
      problemas(
        s,
        com(nome, (p) => (p.itens_venda[0].quantidade = '0.000')),
      ),
    ).toEqual(['itens_venda.0.quantidade: deve ser maior que zero']);
    expect(
      problemas(
        s,
        com(nome, (p) => (p.itens_venda[1].venda_id = p.itens_venda[1].id)),
      ),
    ).toEqual(['itens_venda.1.venda_id: outra venda']);
    expect(
      problemas(
        s,
        com(nome, (p) => (p.liberacoes[0].item_venda_id = p.vendas.id)),
      ),
    ).toEqual(['liberacoes.0.item_venda_id: item fora da venda']);
    expect(
      problemas(
        s,
        com(nome, (p) => (p.itens_venda[2].kit_componente_id = null)),
      ),
    ).toEqual(['itens_venda.2.kit_grupo_id: colunas do combo incompletas']);
    expect(
      problemas(
        s,
        com(nome, (p) => (p.vasilhames[0].emprestados = 2)),
      ),
    ).toEqual(['vasilhames.0.pessoa_id: comodato exige o cliente']);
  });

  it('venda: chave nova e ação de liberação nova não recusam a venda (PDV mais novo não trava o outbox)', () => {
    const p = com('venda.finalizada.payload.json', (v) => {
      v.vendas.coluna_futura = 1;
      v.liberacoes[0].acao = 'preco_manual';
    });
    expect(payloadVendaFinalizadaSchema.safeParse(p).success).toBe(true);
    // Fechamento das contas não rejeita (P6): é o handler que grava e alerta VENDA_INCONSISTENTE.
    const somaErrada = com('venda.finalizada.payload.json', (v) => (v.vendas.total = '999.99'));
    expect(payloadVendaFinalizadaSchema.safeParse(somaErrada).success).toBe(true);
  });

  it('venda.cancelada A: estorno_venda por forma, só com estorno efetivado e sempre com a forma (O22)', () => {
    const nome = 'venda.cancelada.finalizada.payload.json';
    const s = payloadVendaCanceladaFinalizadaSchema;
    // A fixture tem o pagamento em dinheiro devolvido e os dois caminhos da O22: o estorno na maquininha (linha na
    // forma do cartão, que não sai da gaveta e cancela a conta a receber) e o PIX devolvido em dinheiro (somado na
    // linha da forma Dinheiro: sai da gaveta, mas a transação PIX e a conta a receber dela ficam).
    expect(ler(nome).pagamentos_venda).toEqual([
      expect.objectContaining({ estorno: 'dinheiro_devolvido' }),
      expect.objectContaining({ estorno: 'pos_cancelado_na_maquininha' }),
      expect.objectContaining({ estorno: 'devolvido_em_dinheiro' }),
    ]);
    // Só a devolução em dinheiro de um cartão já basta para exigir o estorno_venda (na forma Dinheiro).
    const soCartaoEmDinheiro = com(nome, (p) => {
      p.pagamentos_venda = [{ ...p.pagamentos_venda[1], estorno: 'devolvido_em_dinheiro' }];
      p.movimentos_caixa = [p.movimentos_caixa[0]];
    });
    expect(problemas(s, soCartaoEmDinheiro)).toEqual([]);
    expect(
      problemas(
        s,
        com(nome, (p) => {
          p.pagamentos_venda = [{ ...p.pagamentos_venda[1], estorno: 'devolvido_em_dinheiro' }];
          p.movimentos_caixa = [];
        }),
      ),
    ).toEqual(['movimentos_caixa: estorno_venda só (e sempre) com estorno efetivado']);
    const pendentes = com(nome, (p) => {
      p.pagamentos_venda[0].estorno = 'dinheiro_nao_devolvido';
      p.pagamentos_venda[1].estorno = 'tef_estorno_pendente';
      p.pagamentos_venda[2].estorno = 'pix_devolucao_pendente';
    });
    expect(problemas(s, pendentes)).toEqual([
      'movimentos_caixa: estorno_venda só (e sempre) com estorno efetivado',
    ]);
    const semMovimento = com(nome, (p) => (p.movimentos_caixa = []));
    expect(problemas(s, semMovimento)).toEqual([
      'movimentos_caixa: estorno_venda só (e sempre) com estorno efetivado',
    ]);
    const semForma = com(nome, (p) => (p.movimentos_caixa[0].forma_pagamento_id = null));
    expect(problemas(s, semForma)).toEqual(['movimentos_caixa.0.forma_pagamento_id: estorno sem a forma']);
    expect(
      problemas(
        s,
        com(nome, (p) => (p.pagamentos_venda[0].estorno = 'devolveu_no_balcao')),
      ),
    ).toHaveLength(1);
  });

  it('caixa: CHECKs da 0012 viram PAYLOAD_INVALIDO antes do banco', () => {
    const semQuemRetira = com('caixa.sangria.payload.json', (p) => {
      p.movimentos_caixa.quem_retira_usuario_id = null;
      p.movimentos_caixa.quem_retira_nome = null;
    });
    expect(problemas(payloadCaixaSangriaSchema, semQuemRetira)).toEqual([
      'movimentos_caixa.quem_retira_nome: quem retira',
    ]);
    // O reforço não exige quem entregou.
    const reforco = com('caixa.reforco.payload.json', (p) => {
      p.movimentos_caixa.quem_retira_usuario_id = null;
      p.movimentos_caixa.quem_retira_nome = null;
    });
    expect(payloadCaixaReforcoSchema.safeParse(reforco).success).toBe(true);
    const trocaQueZera = com(
      'caixa.fechado.troca_turno.payload.json',
      (p) => (p.fechamentos_caixa.zera_caixa = true),
    );
    expect(problemas(payloadCaixaFechadoSchema, trocaQueZera)).toEqual([
      'fechamentos_caixa.zera_caixa: zera só no fechamento',
    ]);
    const formaRepetida = com('caixa.fechado.payload.json', (p) => {
      p.fechamentos_caixa_formas[1].forma_pagamento_id = p.fechamentos_caixa_formas[0].forma_pagamento_id;
    });
    expect(problemas(payloadCaixaFechadoSchema, formaRepetida)).toEqual([
      'fechamentos_caixa_formas.1.forma_pagamento_id: forma repetida',
    ]);
    const aberturaDiferente = com(
      'caixa.aberto.payload.json',
      (p) => (p.movimentos_caixa[0].valor = '100.00'),
    );
    expect(problemas(payloadCaixaAbertoSchema, aberturaDiferente)).toEqual([
      'movimentos_caixa.0.valor: o movimento de abertura é o fundo de troco',
    ]);
    // Fundo zero: sessão sem movimento (ck_movimentos_caixa_valor exige valor > 0).
    const fundoZero = com('caixa.aberto.payload.json', (p) => {
      p.sessoes_caixa.fundo_troco = '0.00';
      p.movimentos_caixa = [];
    });
    expect(payloadCaixaAbertoSchema.safeParse(fundoZero).success).toBe(true);
    // Diferença do recebimento na troca de turno pode ser negativa; o fundo contado, não.
    const diferenca = com(
      'caixa.aberto.payload.json',
      (p) => (p.sessoes_caixa.diferenca_recebimento = '-5.00'),
    );
    expect(payloadCaixaAbertoSchema.safeParse(diferenca).success).toBe(true);
    const fundoNegativo = com('caixa.aberto.payload.json', (p) => (p.sessoes_caixa.fundo_troco = '-1.00'));
    expect(payloadCaixaAbertoSchema.safeParse(fundoNegativo).success).toBe(false);
  });

  it('vasilhame e alerta: destino e tipo fechados na v1', () => {
    const vale = com('vasilhame.movimentado.payload.json', (p) => (p.movimentos_vasilhame.destino = 'vale'));
    expect(problemas(payloadVasilhameMovimentadoSchema, vale)).toEqual([
      'movimentos_vasilhame.vale_id: vale só no destino vale',
    ]);
    const comodato = com(
      'vasilhame.movimentado.payload.json',
      (p) => (p.movimentos_vasilhame.destino = 'baixa_comodato'),
    );
    expect(problemas(payloadVasilhameMovimentadoSchema, comodato)).toEqual([
      'movimentos_vasilhame.pessoa_id: comodato exige o cliente',
    ]);
    const tipo = com('alerta.cadastro.payload.json', (p) => (p.tipo_alerta = 'preco_zerado'));
    expect(payloadAlertaCadastroSchema.safeParse(tipo).success).toBe(false);
  });
});
