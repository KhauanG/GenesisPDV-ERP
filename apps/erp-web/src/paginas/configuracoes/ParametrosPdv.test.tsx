/**
 * Parâmetros-PDV (Fase 3, F3-B12): onde cada chave aparece (aba Vendas, Lojas › Parâmetros), o aviso da versão do PDV,
 * a trava dura, o valor gravado fora da faixa e o "Nº da próxima venda" do ERP.
 */
import {
  CONFIGURACOES,
  temVersaoPdv,
  type ChaveComTerminaisDesatualizados,
  type ValorConfiguracao,
} from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { PARAMETROS_LOJA } from '../lojas/Lojas';
import { CamposConfiguracoes, textoVersaoChave } from './CamposConfiguracoes';
import { ProximaVendaErp } from './Configuracoes';
import { ABA_GERAL, ABA_PARAMETROS, ABA_PDV, ABA_VENDAS, type RotuloConfiguracao } from './rotulos';

afterEach(() => vi.unstubAllGlobals());

const LOJA = '01928f3a-0000-7000-8000-0000000000f1';
const LOJAS = [{ id: LOJA, codigo: 1, nome: 'Loja 1 - Centro', ativa: true, treino: false }];
const PERMISSOES = ['configuracoes.ver', 'configuracoes.editar'];
const valor = (chave: string, v: Partial<ValorConfiguracao>): ValorConfiguracao => ({
  chave,
  valor: null,
  padrao: null,
  loja: true,
  pdv: true,
  segredo: false,
  lojasSobrepondo: 0,
  ...v,
});
const ANTIGO = {
  id: '01928f3a-0000-7000-8000-00000000aa01',
  lojaNome: 'Loja 1 - Centro',
  numeroCaixa: 1,
  descricao: null,
  versaoApp: '0.13.0',
};
const comodato = (terminais = [ANTIGO], outrasLojas = 0): ChaveComTerminaisDesatualizados => ({
  chave: 'pdv.vasilhame_comodato',
  versaoMinima: '0.15.0',
  trava: true,
  terminais,
  outrasLojas,
});

describe('onde cada chave aparece (ERP 9.10, 10.3.9)', () => {
  it('toda chave Loja = S do catálogo aparece em Lojas › Parâmetros, uma vez só', () => {
    const chaves = PARAMETROS_LOJA.map((i) => i.chave);
    expect(new Set(chaves).size).toBe(chaves.length);
    const faltando = CONFIGURACOES.filter((c) => c.loja && !c.segredo && !chaves.includes(c.chave)).map(
      (c) => c.chave,
    );
    expect(faltando).toEqual([]);
  });

  it('a aba Vendas tem todas as vendas.* do catálogo, com as de NF-e desabilitadas pela Fase 6', () => {
    const doCatalogo = CONFIGURACOES.filter((c) => c.chave.startsWith('vendas.')).map((c) => c.chave);
    expect(ABA_VENDAS.map((i) => i.chave).sort()).toEqual(doCatalogo.sort());
    const nfe = ABA_VENDAS.filter((i) => i.fase === 'Fase 6').map((i) => i.chave);
    expect(nfe).toEqual([
      'vendas.usa_remessa',
      'vendas.bloqueia_pf_fora_estado',
      'vendas.valida_volumes_nfe',
    ]);
  });

  it('nenhuma chave com versão do PDV é marcada "sem efeito ainda" nem desabilitada pela fase', () => {
    const abas: RotuloConfiguracao[] = [...ABA_GERAL, ...ABA_PARAMETROS, ...ABA_PDV, ...ABA_VENDAS];
    for (const i of abas) {
      if (!temVersaoPdv(i.chave)) continue;
      expect(i.semEfeito, i.chave).toBeUndefined();
      expect(i.fase, i.chave).toBeUndefined();
    }
    // O comodato deixou de ser "módulo futuro": pronto e desligado (D84), com a trava.
    expect(ABA_PDV.find((i) => i.chave === 'pdv.vasilhame_comodato')!.fut).toBeUndefined();
  });

  it('a ajuda da D15: o limite de valor pede o supervisor; o "em aberto" é o máximo de suspensas', () => {
    const ajuda = (c: string) => ABA_PARAMETROS.find((i) => i.chave === c)!.ajuda!;
    expect(ajuda('pdv.limite_valor_venda')).toContain('supervisor');
    expect(ajuda('pdv.limite_venda_em_aberto')).toContain('0 = não deixa suspender');
  });
});

describe('textoVersaoChave (F3-B12)', () => {
  it('a versão e os caixas desatualizados; a trava sempre diz que só liga com todos na versão', () => {
    expect(textoVersaoChave({ ...comodato([], 0), trava: false })).toBeNull();
    expect(textoVersaoChave(comodato([], 0))).toBe(
      'Só liga com todos os caixas ativos no PDV 0.15.0 ou mais novo.',
    );
    expect(textoVersaoChave({ ...comodato([ANTIGO], 2), trava: false })).toBe(
      'Tem efeito a partir do PDV 0.15.0; 3 caixa(s) desatualizado(s): Loja 1 - Centro – caixa 01: versão 0.13.0; ' +
        '2 de outras lojas, fora do seu acesso',
    );
    // Só com "Configurações: Ver": os caixas das lojas permitidas vêm só na contagem.
    expect(textoVersaoChave({ ...comodato([], 1), trava: false, semDetalhes: 2 })).toBe(
      'Tem efeito a partir do PDV 0.15.0; 3 caixa(s) desatualizado(s): 2 das suas lojas (os detalhes pedem ' +
        '"PDVs/Terminais: Ver"); 1 de outras lojas, fora do seu acesso',
    );
  });
});

describe('<CamposConfiguracoes>: versão do PDV, trava, faixa e fase (F3-B12)', () => {
  const ITENS = ABA_PDV.filter((i) =>
    [
      'pdv.vasilhame_comodato',
      'pdv.orcamento_pdv',
      'pdv.devolucao_emite_nfe_entrada',
      'pdv.troco_maximo',
    ].includes(i.chave),
  ).concat(ABA_PARAMETROS.filter((i) => i.chave === 'pdv.fonte_total'));

  function simular(putResposta: () => { status?: number; corpo: unknown }) {
    return simularApi(...rotasSessao({ permissoes: PERMISSOES }), ({ url, metodo }) => {
      if (url.pathname === '/api/configuracoes/terminais-desatualizados')
        return {
          corpo: {
            chaves: (url.searchParams.get('chave') ?? '')
              .split(',')
              .map((c) =>
                c === 'pdv.vasilhame_comodato'
                  ? comodato()
                  : { ...comodato([ANTIGO]), chave: c, versaoMinima: '0.16.0', trava: false },
              ),
          },
        };
      if (url.pathname !== '/api/configuracoes') return undefined;
      if (metodo === 'PUT') return putResposta();
      return {
        corpo: [
          valor('pdv.vasilhame_comodato', { valor: false, padrao: false }),
          valor('pdv.orcamento_pdv', { valor: false, padrao: false }),
          valor('pdv.devolucao_emite_nfe_entrada', { valor: false, padrao: false }),
          valor('pdv.troco_maximo', { valor: '500.00', padrao: '500.00' }),
          valor('pdv.fonte_total', { valor: 36, padrao: 36, foraDaFaixa: { empresa: 120 } }),
        ],
      };
    });
  }

  it('mostra a versão e os caixas antigos, só a chave com versão é consultada, e marca fase e "sem efeito"', async () => {
    const { chamadas } = simular(() => ({ corpo: [] }));
    renderizarComSessao(<CamposConfiguracoes itens={ITENS} />);
    const linhaComodato = await screen.findByText(/Só liga com todos os caixas ativos no PDV 0\.15\.0/);
    expect(linhaComodato).toHaveTextContent('Loja 1 - Centro – caixa 01: versão 0.13.0');
    expect(await screen.findByText(/Tem efeito a partir do PDV 0\.16\.0/)).toBeInTheDocument();
    const consulta = chamadas.find((c) => c.url.pathname === '/api/configuracoes/terminais-desatualizados')!;
    expect(consulta.url.searchParams.get('chave')!.split(',').sort()).toEqual([
      'pdv.orcamento_pdv',
      'pdv.vasilhame_comodato',
    ]);
    expect(screen.getByRole('switch', { name: 'Devolução emite NF-e de entrada' })).toBeDisabled();
    expect(screen.getByText('Fase 6')).toBeInTheDocument();
    expect(screen.getAllByText('sem efeito ainda')).toHaveLength(2);
    // O valor gravado fora da faixa nova (ERP 9.3.1): o aviso, e o campo mostra o que vale.
    expect(screen.getByText(/O valor gravado 120 está fora da faixa 20–72/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Tamanho da fonte – total' })).toHaveValue('36');
  });

  it('a trava recusa ligar: o modal lista os caixas que impedem', async () => {
    const u = userEvent.setup();
    simular(() => ({
      status: 422,
      corpo: {
        codigo: 'REGRA_NEGOCIO',
        mensagem: 'Há caixas com o PDV antigo',
        campos: { 'pdv.vasilhame_comodato': ['Só liga com todos os caixas no PDV 0.15.0'] },
        detalhes: { codigo: 'TERMINAIS_DESATUALIZADOS', chaves: [comodato([ANTIGO], 1)] },
      },
    }));
    renderizarComSessao(<CamposConfiguracoes itens={ITENS} />);
    await u.click(await screen.findByRole('switch', { name: 'Empréstimo de cascos (comodato)' }));
    await u.click(screen.getByRole('button', { name: 'Gravar' }));
    const modal = await screen.findByRole('dialog', { name: 'Caixas com o PDV antigo' });
    expect(within(modal).getByText('Loja 1 - Centro – caixa 01: versão 0.13.0')).toBeInTheDocument();
    expect(within(modal).getByText('1 caixa(s) de outras lojas, fora do seu acesso')).toBeInTheDocument();
    expect(within(modal).getByText(/Empréstimo de cascos \(comodato\): PDV 0\.15\.0/)).toBeInTheDocument();
    expect(screen.getByText('Só liga com todos os caixas no PDV 0.15.0')).toBeInTheDocument();
  });

  it('o gravado fora da faixa conta como alteração: gravar o exibido apaga a linha inválida', async () => {
    const u = userEvent.setup();
    const { chamadas } = simular(() => ({ corpo: [] }));
    renderizarComSessao(<CamposConfiguracoes itens={ITENS} />);
    await screen.findByText(/O valor gravado 120 está fora da faixa 20–72/);
    // Sem mexer em nada: o 36 exibido é o padrão, e é ele que vai (a API apaga a linha igual ao padrão).
    expect(screen.getByText('1 alteração(ões) não gravada(s)')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Gravar' }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true));
    expect(chamadas.find((c) => c.metodo === 'PUT')!.corpo).toEqual({
      lojaId: null,
      valores: { 'pdv.fonte_total': 36 },
    });
  });

  it('na loja, o gravado fora da faixa aparece em "Herdar" e gravar manda o null', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(...rotasSessao({ permissoes: PERMISSOES }), ({ url, metodo }) => {
      if (url.pathname === '/api/configuracoes/terminais-desatualizados') return { corpo: { chaves: [] } };
      if (url.pathname !== '/api/configuracoes') return undefined;
      if (metodo === 'PUT') return { corpo: [] };
      return {
        corpo: [valor('pdv.fonte_total', { valor: 36, padrao: 36, foraDaFaixa: { loja: 8 } })],
      };
    });
    renderizarComSessao(
      <CamposConfiguracoes itens={ITENS.filter((i) => i.chave === 'pdv.fonte_total')} lojaId={LOJA} />,
    );
    await screen.findByText(/O valor gravado 8 está fora da faixa 20–72 e não vale: vale o da empresa/);
    expect(screen.getByText('1 alteração(ões) não gravada(s)')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Gravar' }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true));
    expect(chamadas.find((c) => c.metodo === 'PUT')!.corpo).toEqual({
      lojaId: LOJA,
      valores: { 'pdv.fonte_total': null },
    });
  });

  it('na loja, a consulta de versão vai com a loja', async () => {
    const { chamadas } = simular(() => ({ corpo: [] }));
    renderizarComSessao(<CamposConfiguracoes itens={ITENS} lojaId={LOJA} />);
    await screen.findByText(/Só liga com todos os caixas ativos/);
    const consulta = chamadas.find((c) => c.url.pathname === '/api/configuracoes/terminais-desatualizados')!;
    expect(consulta.url.searchParams.get('lojaId')).toBe(LOJA);
  });
});

describe('<ProximaVendaErp> (ERP 9.10; F3-B12)', () => {
  const URL_LOJA = `/api/lojas/${LOJA}/numeracao-venda-erp`;

  it('sem "Numeração própria" só mostra a sequência; com ela grava e mostra a recusa da API no campo', async () => {
    const u = userEvent.setup();
    let propria = false;
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS, todasLojas: true }),
      ({ url, metodo, corpo }) => {
        if (url.pathname !== URL_LOJA) return undefined;
        if (metodo === 'GET')
          return { corpo: { lojaId: LOJA, ultimoNumero: 41, proximoNumero: 42, numeracaoPropria: propria } };
        const n = (corpo as { proximoNumero: number }).proximoNumero;
        return n <= 41
          ? {
              status: 422,
              corpo: {
                codigo: 'VALIDACAO',
                mensagem: 'Verifique os campos destacados.',
                campos: { proximoNumero: ['Tem de ser maior que o último número usado (41).'] },
              },
            }
          : { corpo: { lojaId: LOJA, ultimoNumero: n - 1, proximoNumero: n, numeracaoPropria: true } };
      },
    );
    const { unmount } = renderizarComSessao(<ProximaVendaErp />);
    await u.click(await screen.findByRole('combobox', { name: 'Loja' }));
    await u.click(await screen.findByRole('option', { name: '1 - Loja 1 - Centro', hidden: true }));
    expect(await screen.findByText(/Próxima venda: nº 42, na sequência/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Nº da próxima venda' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Gravar número' })).not.toBeInTheDocument();
    unmount();

    propria = true;
    renderizarComSessao(<ProximaVendaErp />);
    await u.click(await screen.findByRole('combobox', { name: 'Loja' }));
    await u.click(await screen.findByRole('option', { name: '1 - Loja 1 - Centro', hidden: true }));
    const campo = await screen.findByRole('textbox', { name: 'Nº da próxima venda' });
    await waitFor(() => expect(campo).toBeEnabled());
    await u.type(campo, '30');
    await u.click(screen.getByRole('button', { name: 'Gravar número' }));
    expect(await screen.findByText('Tem de ser maior que o último número usado (41).')).toBeInTheDocument();
    await u.clear(campo);
    await u.type(campo, '1000');
    await u.click(screen.getByRole('button', { name: 'Gravar número' }));
    await waitFor(() =>
      expect(chamadas.filter((c) => c.metodo === 'PUT').map((c) => c.corpo)).toEqual([
        { proximoNumero: 30 },
        { proximoNumero: 1000 },
      ]),
    );
    expect(await screen.findByText(/Último número usado: 999/)).toBeInTheDocument();
  });
});
