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

  it('Encarregado = Supervisor (PC-8) + cancelar a venda paga (dono, 05/11/2026) + devolver dinheiro (D91), sem configuração, histórico de uso nem ERP', () => {
    const encarregado = perfil('encarregado');
    const supervisor = perfil('supervisor_caixa');
    // Decisão 78 do README do PDV: o cancelamento da venda paga (do caixa aberto: a de caixa fechado não tem permissão
    // nenhuma, D23); D91 (F3-B3): a devolução em dinheiro na troca e o resgate do vale. O Supervisor continua sem as duas.
    expect([...encarregado].filter((c) => !supervisor.has(c))).toEqual([
      'pdv.venda.cancelar_venda_finalizada',
      'pdv.troca.devolver_dinheiro',
    ]);
    expect(supervisor.has('pdv.venda.cancelar_venda_finalizada')).toBe(false);
    expect(supervisor.has('pdv.troca.devolver_dinheiro')).toBe(false);
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
    expect(encarregado.descricao).toContain('devolver dinheiro na troca');
    expect(encarregado.descricao.length).toBeLessThanOrEqual(255);
    // A do G1 e a de antes da D91 (F3-B3): o pós-migração troca a que a empresa não reescreveu.
    expect(encarregado.descricoesAnteriores).toHaveLength(2);
    expect(encarregado.descricoesAnteriores).not.toContain(encarregado.descricao);
    expect(encarregado.descricoesAnteriores![0]).toContain('as mesmas permissões do Supervisor de caixa');
    expect(encarregado.descricoesAnteriores![1]).not.toContain('devolver dinheiro');
  });
});

describe('Fase 3 (F3-B3): promoções, comodato e a matriz dos perfis que liberam', () => {
  const perfil = (chave: string) => new Set(PERFIS_PADRAO.find((p) => p.chaveSistema === chave)!.permissoes);
  const PROMOCOES = ['promocoes.ver', 'promocoes.criar', 'promocoes.editar', 'promocoes.excluir'];

  it('as permissões novas existem, no grupo do ERP 11.4, todas com liberação', () => {
    for (const c of PROMOCOES) {
      const p = PERMISSOES.find((x) => x.chave === c)!;
      expect(p, c).toBeDefined();
      expect(p.grupo, c).toBe('Produtos');
    }
    const comodato = PERMISSOES.find((x) => x.chave === 'pdv.vasilhame.comodato')!;
    expect(comodato.modulo).toBe('pdv');
    expect(comodato.permiteLiberacao).toBe(true);
  });

  it('promoções: quem edita produtos no seed (Administrador, Gerente, Estoquista) vê, cria e edita; excluir só Gerente e Administrador', () => {
    for (const chave of ['administrador', 'gerente'])
      for (const c of PROMOCOES) expect(perfil(chave).has(c), `${chave}: ${c}`).toBe(true);
    const estoquista = perfil('estoquista');
    for (const c of PROMOCOES.slice(0, 3)) expect(estoquista.has(c), c).toBe(true);
    expect(estoquista.has('promocoes.excluir')).toBe(false);
    // A regra é a da migração 0031 (README da API › decisão 222): o perfil sem `produtos.editar` não ganha nada.
    for (const p of PERFIS_PADRAO) {
      const tem = new Set(p.permissoes);
      if (!tem.has('produtos.editar'))
        for (const c of PROMOCOES) expect(tem.has(c), `${p.chaveSistema}: ${c}`).toBe(false);
    }
  });

  /**
   * A migração 0031 protege só estes perfis de sistema: o que a empresa tirou de produtos fica com a linha de promoções
   * já excluída, que o seed respeita (README da API › decisão 222). A lista está fixa no SQL da 0031, que já rodou nas
   * empresas e não se edita mais: é o seed de hoje que tem de bater com ela. Um bloco que der promoções a outro perfil
   * de sistema no seed decide, com uma migração nova, o que fazer nas empresas que tiraram dele a permissão de
   * produtos correspondente, e só então acrescenta o perfil aqui.
   */
  it('os perfis de sistema que recebem promoções no seed são os que a migração 0031 protege', () => {
    const PROTEGIDOS_0031 = {
      'promocoes.ver': ['administrador', 'estoquista', 'gerente'],
      'promocoes.criar': ['administrador', 'estoquista', 'gerente'],
      'promocoes.editar': ['administrador', 'estoquista', 'gerente'],
      'promocoes.excluir': ['administrador', 'gerente'],
    };
    for (const [permissao, perfis] of Object.entries(PROTEGIDOS_0031))
      expect(
        PERFIS_PADRAO.filter((p) => p.permissoes.includes(permissao))
          .map((p) => p.chaveSistema)
          .sort(),
        permissao,
      ).toEqual(perfis);
  });

  /**
   * PDV 31.2 nas permissões que a Fase 3 usa: ✔ = no perfil; L = pede a liberação. O Encarregado tem a coluna do
   * Supervisor mais o cancelamento da venda paga (decisão 78 do PDV) e a devolução em dinheiro (D91); Gerente e
   * Administrador têm todas.
   */
  const MATRIZ_FASE3: Record<string, { operador: boolean; supervisor: boolean; encarregado: boolean }> = {
    'pdv.vasilhame.comodato': { operador: true, supervisor: true, encarregado: true },
    'pdv.venda.acrescimo': { operador: true, supervisor: true, encarregado: true },
    'pdv.venda.alterar_preco': { operador: false, supervisor: true, encarregado: true },
    'pdv.venda.tipo_preco_atacado': { operador: false, supervisor: true, encarregado: true },
    'pdv.venda.peso_manual': { operador: false, supervisor: true, encarregado: true },
    'pdv.venda.vender_vencido': { operador: false, supervisor: false, encarregado: false },
    'pdv.venda.exceder_limite_valor': { operador: false, supervisor: true, encarregado: true },
    'pdv.pagamento.consumo_interno': { operador: false, supervisor: true, encarregado: true },
    'pdv.troca.realizar': { operador: false, supervisor: true, encarregado: true },
    'pdv.troca.fora_prazo': { operador: false, supervisor: false, encarregado: false },
    'pdv.troca.devolver_dinheiro': { operador: false, supervisor: false, encarregado: true },
    'pdv.vale.emitir': { operador: false, supervisor: true, encarregado: true },
    'pdv.cliente.cadastro_rapido': { operador: true, supervisor: true, encarregado: true },
    'pdv.orcamento.importar': { operador: true, supervisor: true, encarregado: true },
    'pdv.orcamento.criar': { operador: true, supervisor: true, encarregado: true },
  };

  it.each(Object.entries(MATRIZ_FASE3))('%s segue a PDV 31.2 nos perfis de caixa', (chave, esperado) => {
    expect(CHAVES_PERMISSOES.has(chave)).toBe(true);
    expect(perfil('operador_caixa').has(chave), 'operador').toBe(esperado.operador);
    expect(perfil('supervisor_caixa').has(chave), 'supervisor').toBe(esperado.supervisor);
    expect(perfil('encarregado').has(chave), 'encarregado').toBe(esperado.encarregado);
    for (const c of ['gerente', 'administrador']) expect(perfil(c).has(chave), c).toBe(true);
  });

  it('quem libera no caixa (Supervisor, Encarregado, Administrador) tem pdv.supervisor; o Operador não', () => {
    for (const c of ['supervisor_caixa', 'encarregado', 'administrador', 'gerente'])
      expect(perfil(c).has('pdv.supervisor'), c).toBe(true);
    expect(perfil('operador_caixa').has('pdv.supervisor')).toBe(false);
  });

  it('nenhum perfil do ERP sem caixa ganhou permissão do PDV', () => {
    for (const c of ['financeiro', 'estoquista', 'vendedor'])
      expect(
        [...perfil(c)].filter((x) => x.startsWith('pdv.')),
        c,
      ).toEqual([]);
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
