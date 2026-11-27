/**
 * As regras puras do cancelamento pelo ERP (F3-B11; ERP 15.4.3; SYNC 10.4; D112, D113): a ordem dos bloqueios, a
 * forma de devolução da venda de caixa fechado e os avisos do terminal (offline, eventos pendentes, versão que não lê a
 * projeção). A gravação, o estoque e a corrida com o caixa estão em `test/integracao/cancelamento-erp.test.ts`.
 */
import { VERSAO_PDV_LE_STATUS_VENDA } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import {
  avisosCancelamento,
  bloqueioCancelamento,
  exigeFormaDevolucao,
  type TerminalDaVenda,
  type VendaParaCancelar,
} from './cancelamento-erp.js';

const VENDA = '0190a000-0000-7000-8000-000000000001';
const TERMINAL = '0190a000-0000-7000-8000-0000000000aa';
const AGORA = new Date('2026-11-26T15:00:00Z');

const venda = (extra: Partial<VendaParaCancelar> = {}): VendaParaCancelar => ({
  id: VENDA,
  numeroExibicao: 'L01-C02-000123',
  lojaId: '0190a000-0000-7000-8000-000000000011',
  caixaId: '0190a000-0000-7000-8000-000000000022',
  numeroCaixa: 2,
  terminalId: TERMINAL,
  sessaoCaixaId: '0190a000-0000-7000-8000-000000000033',
  sessaoStatus: 'fechada',
  status: 'finalizada',
  statusFiscal: 'nao_aplicavel',
  cancelamentoOrigem: null,
  total: '25.90',
  ...extra,
});

const terminal = (extra: Partial<TerminalDaVenda> = {}): TerminalDaVenda => ({
  id: TERMINAL,
  numeroCaixa: 2,
  descricao: 'PC do balcão',
  status: 'ativo',
  versaoApp: VERSAO_PDV_LE_STATUS_VENDA,
  ultimoContatoEm: new Date(AGORA.getTime() - 30_000),
  eventosPendentes: 0,
  vendasCancelamentoPendente: [],
  origem: true,
  ...extra,
});

describe('bloqueioCancelamento', () => {
  it('a venda do caixa finalizada, de sessão fechada, sem troca nem pendência: pode cancelar', () => {
    expect(bloqueioCancelamento(venda(), [terminal()], false)).toBeNull();
  });

  it('na ordem: já cancelada, não finalizada, sem terminal, fiscal, na fila, pendente no caixa, sessão aberta, troca', () => {
    // Cada caso tem também verdadeiras as condições de todos os bloqueios seguintes: trocar dois ifs de lugar em
    // `bloqueioCancelamento` muda o código (ou a mensagem, entre os dois do caixa) de pelo menos um caso.
    const pendente = terminal({ vendasCancelamentoPendente: [VENDA] });
    const seguintes = { terminalId: null, statusFiscal: 'autorizada', sessaoStatus: 'aberta' } as const;
    const bloqueio = (v: VendaParaCancelar, naFila: 'erro' | null = 'erro') =>
      bloqueioCancelamento(v, [pendente], true, naFila);
    expect(bloqueio(venda({ ...seguintes, status: 'cancelada', cancelamentoOrigem: 'erp' }))).toMatchObject({
      codigo: 'ja_cancelada',
      mensagem: expect.stringContaining('no ERP'),
    });
    expect(bloqueio(venda({ ...seguintes, status: 'pedido_pendente' }))?.codigo).toBe('nao_finalizada');
    expect(bloqueio(venda(seguintes))?.codigo).toBe('nao_pdv');
    expect(bloqueio(venda({ ...seguintes, terminalId: TERMINAL }))?.codigo).toBe('documento_fiscal');
    const aberta = venda({ sessaoStatus: 'aberta' });
    expect(bloqueio(aberta)).toMatchObject({
      codigo: 'cancelamento_pendente_no_caixa',
      mensagem: expect.stringContaining('parou na sincronização (com erro)'),
    });
    expect(bloqueio(aberta, null)).toMatchObject({
      codigo: 'cancelamento_pendente_no_caixa',
      mensagem: 'O caixa 02 já cancelou esta venda; aguarde a sincronização.',
    });
    expect(bloqueioCancelamento(aberta, [terminal()], true)?.codigo).toBe('sessao_aberta');
    expect(bloqueioCancelamento(venda({ sessaoStatus: 'em_fechamento' }), [], false)?.codigo).toBe(
      'sessao_aberta',
    );
    expect(bloqueioCancelamento(venda(), [terminal()], true)?.codigo).toBe('com_troca');
  });

  it('o cancelamento do caixa parado na fila (erro, retido) ou chegando (recebido) bloqueia com o mesmo código', () => {
    expect(bloqueioCancelamento(venda(), [terminal()], false, 'retido')).toMatchObject({
      codigo: 'cancelamento_pendente_no_caixa',
      mensagem: expect.stringMatching(/parou na sincronização \(retido\).*"Eventos com erro"/),
    });
    expect(bloqueioCancelamento(venda(), [terminal()], false, 'recebido')).toMatchObject({
      codigo: 'cancelamento_pendente_no_caixa',
      mensagem: expect.stringContaining('está chegando; aguarde a sincronização'),
    });
    // Sem terminal online, com eventos pendentes ou com a pendência no heartbeat: é a nuvem que já sabe.
    expect(bloqueioCancelamento(venda(), [], false, 'erro')?.codigo).toBe('cancelamento_pendente_no_caixa');
  });

  it('só a pendência do terminal de origem bloqueia (outro terminal do caixa não cancela a venda dele)', () => {
    const outro = terminal({
      id: '0190a000-0000-7000-8000-0000000000bb',
      origem: false,
      vendasCancelamentoPendente: [VENDA],
    });
    expect(bloqueioCancelamento(venda(), [outro], false)).toBeNull();
  });
});

describe('exigeFormaDevolucao (D113)', () => {
  it('venda de caixa fechado com valor pede a forma; sem valor, não', () => {
    expect(exigeFormaDevolucao(venda())).toBe(true);
    expect(exigeFormaDevolucao(venda({ total: '0.00' }))).toBe(false);
    expect(exigeFormaDevolucao(venda({ sessaoStatus: null }))).toBe(false);
  });
});

describe('avisosCancelamento (SYNC 10.4)', () => {
  it('terminal online, em dia e na versão que lê a projeção: nenhum aviso', () => {
    expect(avisosCancelamento([terminal()], AGORA)).toEqual([]);
  });

  it('offline (2 min ou mais sem contato, ou nunca) pede confirmação, com os eventos pendentes na mensagem', () => {
    const offline = terminal({
      ultimoContatoEm: new Date(AGORA.getTime() - 2 * 60_000),
      eventosPendentes: 4,
    });
    expect(avisosCancelamento([offline], AGORA)).toEqual([
      {
        codigo: 'terminal_offline',
        mensagem: expect.stringContaining(
          'O caixa 02 (PC do balcão) está offline com 4 evento(s) pendente(s)',
        ),
        exigeConfirmacao: true,
      },
    ]);
    expect(avisosCancelamento([terminal({ ultimoContatoEm: null })], AGORA)[0]?.codigo).toBe(
      'terminal_offline',
    );
  });

  it('online com eventos pendentes pede confirmação', () => {
    expect(avisosCancelamento([terminal({ eventosPendentes: 2 })], AGORA)).toMatchObject([
      { codigo: 'eventos_pendentes', exigeConfirmacao: true },
    ]);
  });

  it('o terminal que não é o de origem não pede confirmação, mas entra no aviso de versão', () => {
    const substituto = terminal({
      id: '0190a000-0000-7000-8000-0000000000cc',
      origem: false,
      versaoApp: '0.13.0',
      ultimoContatoEm: null,
      eventosPendentes: 9,
    });
    expect(avisosCancelamento([substituto], AGORA)).toEqual([
      {
        codigo: 'versao_sem_status',
        mensagem: expect.stringContaining('O caixa 02 (PC do balcão) está no PDV 0.13.0'),
        exigeConfirmacao: false,
      },
    ]);
  });

  it('abaixo da versão ou sem versão conhecida só avisa', () => {
    const avisos = avisosCancelamento([terminal({ versaoApp: null, descricao: null })], AGORA);
    expect(avisos).toEqual([
      {
        codigo: 'versao_sem_status',
        mensagem: expect.stringContaining('O caixa 02 está no PDV de versão desconhecida'),
        exigeConfirmacao: false,
      },
    ]);
    expect(avisosCancelamento([terminal({ versaoApp: '0.14.1' })], AGORA)).toEqual([]);
  });
});
