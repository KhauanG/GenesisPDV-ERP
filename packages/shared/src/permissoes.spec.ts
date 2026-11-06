import { describe, expect, it } from 'vitest';
import { PERFIS_PADRAO } from './perfis-padrao.js';
import {
  CHAVES_PERMISSOES,
  PERMISSOES,
  REGEX_CHAVE_PERMISSAO,
  calcularPermissoesEfetivas,
  temAcessoErp,
} from './permissoes.js';

describe('catálogo de permissões', () => {
  it('tem chaves únicas e no formato do CHECK do banco', () => {
    expect(CHAVES_PERMISSOES.size).toBe(PERMISSOES.length);
    for (const p of PERMISSOES) {
      expect(p.chave).toMatch(REGEX_CHAVE_PERMISSAO);
      expect(p.chave.length).toBeLessThanOrEqual(80);
      expect(p.modulo === 'pdv').toBe(p.chave.startsWith('pdv.'));
    }
  });

  it('PDV usa pdv.<area>.<acao>, exceto pdv.supervisor', () => {
    for (const p of PERMISSOES.filter((x) => x.modulo === 'pdv')) {
      const partes = p.chave.split('.');
      if (p.chave !== 'pdv.supervisor') expect(partes).toHaveLength(3);
    }
  });

  it('perfis padrão só usam chaves do catálogo', () => {
    expect(PERFIS_PADRAO.map((p) => p.chaveSistema)).toEqual([
      'administrador',
      'gerente',
      'financeiro',
      'estoquista',
      'vendedor',
      'operador_caixa',
      'supervisor_caixa',
      'encarregado',
    ]);
    for (const perfil of PERFIS_PADRAO) {
      for (const c of perfil.permissoes)
        expect(CHAVES_PERMISSOES.has(c), `${perfil.chaveSistema}: ${c}`).toBe(true);
    }
  });

  it('pdv.config.fiscal e estoques.todos ficam só para o Master', () => {
    expect(CHAVES_PERMISSOES.has('estoques.todos')).toBe(true);
    for (const perfil of PERFIS_PADRAO) {
      expect(perfil.permissoes).not.toContain('pdv.config.fiscal');
      // Decisão 149 do README da API: os perfis seguem os estoques permitidos de cada usuário.
      expect(perfil.permissoes, perfil.chaveSistema).not.toContain('estoques.todos');
    }
  });

  it('o Estoquista cadastra fornecedor e faz o cadastro completo de pessoas, mas não edita, exclui nem importa pessoas nem muda preço (dono, 05/11/2026)', () => {
    const estoquista = PERFIS_PADRAO.find((p) => p.chaveSistema === 'estoquista')!;
    expect(estoquista.permissoes).toContain('pessoas.criar_fornecedor');
    expect(estoquista.permissoes).toContain('pessoas.criar');
    expect(estoquista.permissoes).toContain('pessoas.ver');
    for (const fora of [
      'pessoas.editar',
      'pessoas.excluir',
      'pessoas.importar',
      'pessoas.editar_credito',
      'pessoas.anonimizar',
      'produtos.alterar_preco',
    ])
      expect(estoquista.permissoes, fora).not.toContain(fora);
  });

  it('operador de caixa não entra no ERP', () => {
    const operador = PERFIS_PADRAO.find((p) => p.chaveSistema === 'operador_caixa')!;
    expect(temAcessoErp(operador.permissoes)).toBe(false);
    const gerente = PERFIS_PADRAO.find((p) => p.chaveSistema === 'gerente')!;
    expect(temAcessoErp(gerente.permissoes)).toBe(true);
  });
});

describe('Central do PDV e perfil Encarregado (decisão 66 do README do PDV)', () => {
  const perfil = (chave: string) => new Set(PERFIS_PADRAO.find((p) => p.chaveSistema === chave)!.permissoes);
  const CONSULTA = [
    'pdv.venda.consultar_historico',
    'pdv.caixa.consultar_fechamentos',
    'pdv.diagnostico.ver',
    'pdv.diagnostico.pacote_suporte',
  ];
  const SO_GERENTE = ['pdv.auditoria.ver_local', 'pdv.config.parametros_locais'];

  it('as 6 permissões novas existem no grupo da Central, todas com liberação', () => {
    const central = PERMISSOES.filter((p) => p.grupo === 'PDV – Central do PDV');
    expect(central.map((p) => p.chave)).toEqual([...CONSULTA, ...SO_GERENTE]);
    for (const p of central) expect(p.permiteLiberacao, p.chave).toBe(true);
  });

  it('o fechamento é visto como foi impresso; reimprimir continua com pdv.documento.reimprimir', () => {
    // Plano 3.1: o rótulo no ERP não pode sugerir que esta permissão libera a reimpressão.
    const rotulo = PERMISSOES.find((p) => p.chave === 'pdv.caixa.consultar_fechamentos')!.descricao;
    expect(rotulo.toLowerCase()).not.toContain('reimprim');
    expect(rotulo).toContain('como foram impressos');
  });

  it('D23 mantida: não existe permissão de cancelar venda de caixa já fechado', () => {
    expect(CHAVES_PERMISSOES.has('pdv.venda.cancelar_venda_sessao_fechada')).toBe(false);
    expect([...CHAVES_PERMISSOES].filter((c) => c.includes('posterior'))).toEqual([]);
  });

  it('Operador nenhuma; Supervisor as 4 de consulta; Gerente e Administrador as 6', () => {
    const operador = perfil('operador_caixa');
    for (const c of [...CONSULTA, ...SO_GERENTE]) expect(operador.has(c), c).toBe(false);
    const supervisor = perfil('supervisor_caixa');
    for (const c of CONSULTA) expect(supervisor.has(c), c).toBe(true);
    for (const c of SO_GERENTE) expect(supervisor.has(c), c).toBe(false);
    for (const chave of ['gerente', 'administrador'])
      for (const c of [...CONSULTA, ...SO_GERENTE]) expect(perfil(chave).has(c), `${chave}: ${c}`).toBe(true);
  });

  it('Encarregado = Supervisor (PC-8) + cancelar a venda paga (dono, 05/11/2026), sem configuração, histórico de uso nem ERP', () => {
    const encarregado = perfil('encarregado');
    const supervisor = perfil('supervisor_caixa');
    // Decisão 78 do README do PDV: a única diferença para o Supervisor é o cancelamento da venda paga (do caixa aberto:
    // a de caixa fechado não tem permissão nenhuma, D23); o Supervisor continua sem ele.
    expect([...encarregado].filter((c) => !supervisor.has(c))).toEqual([
      'pdv.venda.cancelar_venda_finalizada',
    ]);
    expect(supervisor.has('pdv.venda.cancelar_venda_finalizada')).toBe(false);
    for (const c of supervisor) expect(encarregado.has(c), c).toBe(true);
    // O que o dono pediu para o encarregado liberar no lugar dele.
    for (const c of [
      'pdv.supervisor',
      'pdv.venda.cancelar_item',
      'pdv.venda.cancelar_venda_aberta',
      'pdv.venda.desconto_item',
      'pdv.venda.desconto_total',
      'pdv.caixa.sangria',
      'pdv.caixa.reforco',
      'pdv.caixa.cancelar_movimento',
      'pdv.caixa.ignorar_limite_sangria',
      'pdv.caixa.fechar',
      'pdv.caixa.operar_de_outro',
      'pdv.pagamento.confirmar_pix_manual',
      'pdv.venda.cancelar_venda_finalizada',
      ...CONSULTA,
    ])
      expect(encarregado.has(c), c).toBe(true);
    for (const c of [
      'pdv.config.terminal',
      'pdv.config.fiscal',
      'pdv.offline.estender',
      'pdv.troca.devolver_dinheiro',
      'pdv.pagamento.exceder_limite_credito',
      ...SO_GERENTE,
    ])
      expect(encarregado.has(c), c).toBe(false);
    expect(temAcessoErp(encarregado)).toBe(false);
  });

  it('a descrição do Encarregado diz o cancelamento da venda paga; a do G1 fica nas anteriores (o pós-migração a troca)', () => {
    const encarregado = PERFIS_PADRAO.find((p) => p.chaveSistema === 'encarregado')!;
    expect(encarregado.descricao).toMatch(/^Perfil do sistema/);
    expect(encarregado.descricao).toContain('cancelar a venda paga do caixa aberto');
    expect(encarregado.descricao.length).toBeLessThanOrEqual(255);
    expect(encarregado.descricoesAnteriores).toHaveLength(1);
    expect(encarregado.descricoesAnteriores).not.toContain(encarregado.descricao);
    expect(encarregado.descricoesAnteriores![0]).toContain('as mesmas permissões do Supervisor de caixa');
  });
});

describe('calcularPermissoesEfetivas', () => {
  it('negar vence conceder', () => {
    const r = calcularPermissoesEfetivas({
      master: false,
      doPerfil: ['produtos.ver', 'produtos.editar'],
      concedidas: ['pessoas.ver', 'produtos.excluir'],
      negadas: ['produtos.editar', 'pessoas.ver'],
    });
    expect([...r].sort()).toEqual(['produtos.excluir', 'produtos.ver']);
  });
  it('master tem todas', () => {
    expect(calcularPermissoesEfetivas({ master: true, doPerfil: [] }).size).toBe(PERMISSOES.length);
  });
  it('ignora chaves fora do catálogo', () => {
    expect(calcularPermissoesEfetivas({ master: false, doPerfil: ['inexistente.ver'] }).size).toBe(0);
  });
});
