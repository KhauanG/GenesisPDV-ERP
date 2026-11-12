/**
 * Atualização da tabela NCM pela plataforma (Fase 2, F2-B46; README da API › decisão 193), em duas empresas (e uma
 * terceira criada depois), com o download de um servidor HTTP falso local:
 *
 * - simular: o relatório sai e nada é gravado; o formato quebrado e o arquivo que encerraria boa parte da tabela não
 *   aplicam nada em nenhuma empresa;
 * - aplicar: a inclusão, a alteração e o encerramento (fim de vigência na véspera da data da tabela, sem excluir), o
 *   `ressincronizar_fluxo referencia` aos terminais, o registro por empresa e o resumo, e o produto da empresa que
 *   usa o NCM encerrado no relatório "NCMs inválidos" (o critério de pronto); a outra empresa não tem produto afetado;
 * - rodar de novo não muda nada; a migração (carga das referências) não desfaz a tabela aplicada, e a empresa nova
 *   recebe o `ncms.csv`; a tabela mais antiga e a empresa em migração ficam de fora; a falha numa empresa desfaz só
 *   ela, inteira.
 *
 * A tabela servida é **montada no teste** a partir do `ncms.csv` versionado (já público), com as mudanças inventadas
 * (o NCM 7701.00.00, do capítulo 77 que a Nomenclatura não usa): a tabela real do Siscomex não entra no repositório.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RespostaNcmInvalidos } from '@genesis/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lerNcms, type LinhaNcm } from '../../src/database/referencias/carregar.js';
import {
  AtualizacaoNcm,
  baixarTabelaNcm,
  ErroTabelaNcm,
  interpretarTabelaNcm,
  type OpcoesAtualizacaoNcm,
} from '../../src/plataforma/ncm-atualizacao.js';
import { posMigracaoSemAdmin } from '../../src/plataforma/provisionamento.js';
import {
  consultar,
  criarAmbiente,
  criarLoja,
  urlDoBanco,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

const ENCERRADO = '01012100';
const ALTERADO = '01013000';
const INCLUIDO = '77010000';
const DE_B = '22030000';

let amb: Ambiente;
let a: EmpresaTeste;
let b: EmpresaTeste;
let tokenA: string;
let terminalA: string;
let produtoA: string;
let servidor: Server;
let base: string;
let corpo: Buffer = Buffer.alloc(0);

const br = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** A tabela do Siscomex montada do `ncms.csv` com `ajuste` (o formato do download, 8 dígitos com os pontos). */
function tabela(ajuste: (l: LinhaNcm[]) => LinhaNcm[] = (l) => l, data = '12/11/2026'): Buffer {
  return Buffer.from(
    JSON.stringify({
      Data_Ultima_Atualizacao_NCM: `Vigente em ${data}`,
      Ato: 'Resolução Inventada nº 1/2026',
      Nomenclaturas: ajuste(lerNcms()).map((n) => ({
        Codigo: `${n.codigo.slice(0, 4)}.${n.codigo.slice(4, 6)}.${n.codigo.slice(6)}`,
        Descricao: n.descricao,
        Data_Inicio: br(n.inicio ?? '2022-04-01'),
        Data_Fim: n.fim ? br(n.fim) : '31/12/9999',
      })),
    }),
  );
}

const comMudancas = (l: LinhaNcm[]) => [
  ...l
    .filter((n) => n.codigo !== ENCERRADO)
    .map((n) => (n.codigo === ALTERADO ? { ...n, descricao: 'Asininos (descrição alterada no teste)' } : n)),
  { codigo: INCLUIDO, descricao: 'Engenhocas inventadas de teste', inicio: '2026-11-01', fim: null },
];

/** O caminho do `ncm-atualizar`: baixa do servidor falso, lê e aplica. */
async function rodar(opcoes: OpcoesAtualizacaoNcm = {}) {
  const t = interpretarTabelaNcm(await baixarTabelaNcm(`${base}/ncm.json`));
  return new AtualizacaoNcm(amb.servicos.controle, amb.servicos.servidores, 'vitest').executar(t, {
    origem: base,
    ...opcoes,
  });
}

const ncm = (e: EmpresaTeste, codigo: string) =>
  consultar<{ descricao: string; inicio: string | null; fim: string | null; excluido: boolean }>(
    e.nomeBanco,
    `select descricao, vigencia_inicio::text as inicio, vigencia_fim::text as fim, excluido_em is not null as excluido
       from ncms where codigo = $1`,
    [codigo],
  );

const comandos = (e: EmpresaTeste) =>
  consultar<{ terminal_id: string; parametros: unknown; status: string }>(
    e.nomeBanco,
    "select terminal_id, parametros, status from comandos_terminal where tipo = 'ressincronizar_fluxo'",
  );

const registros = (acao: string) =>
  consultar<{ empresa_id: string | null; depois: Record<string, unknown> }>(
    amb.bancoControle,
    'select empresa_id, depois from auditoria_plataforma where acao = $1 order by criado_em',
    [acao],
  );

async function criarProduto(token: string, banco: string, nome: string, ncmProduto: string) {
  const [u] = await consultar<{ id: string }>(banco, "select id from unidades_medida where sigla = 'UN'");
  const r = await amb
    .http()
    .post('/api/produtos')
    .set({ Authorization: `Bearer ${token}` })
    .send({ nome, unidadeId: u!.id, precoVenda: '10', ncm: ncmProduto });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

beforeAll(async () => {
  amb = await criarAmbiente();
  a = await amb.criarEmpresa({ canario: true });
  b = await amb.criarEmpresa();
  tokenA = await amb.entrar(a.codigo, 'admin', a.senha);
  const tokenB = await amb.entrar(b.codigo, 'admin', b.senha);
  produtoA = await criarProduto(tokenA, a.nomeBanco, 'CAVALO DE TESTE', ENCERRADO);
  await criarProduto(tokenB, b.nomeBanco, 'CERVEJA DE TESTE', DE_B);
  const loja = await criarLoja(a.nomeBanco, 1, 'Loja NCM');
  const [caixa] = await consultar<{ id: string }>(
    a.nomeBanco,
    "insert into caixas (loja_id, numero, descricao) values ($1, 1, 'Caixa 01') returning id",
    [loja],
  );
  const [t] = await consultar<{ id: string }>(
    a.nomeBanco,
    "insert into terminais (loja_id, caixa_id, status, ativado_em) values ($1, $2, 'ativo', now()) returning id",
    [loja, caixa!.id],
  );
  terminalA = t!.id;
  servidor = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(corpo);
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterAll(async () => {
  servidor?.closeAllConnections();
  await new Promise((ok) => (servidor ? servidor.close(ok) : ok(undefined)));
  await amb?.fechar();
});

describe('ncm-atualizar (F2-B46)', () => {
  it('a tabela igual à versionada não muda nada (a descrição sai como no ncms.csv)', async () => {
    corpo = tabela();
    const r = await rodar({ simular: true });
    expect(r.empresas.map((e) => [e.status, e.incluidos, e.alterados, e.encerrados])).toEqual([
      ['ok', 0, 0, 0],
      ['ok', 0, 0, 0],
    ]);
  });

  it('simular: o relatório completo, sem gravar nada', async () => {
    corpo = tabela(comMudancas);
    const r = await rodar({ simular: true });
    expect(r.simulacao).toBe(true);
    expect(r.empresas).toEqual([
      expect.objectContaining({
        codigo: a.codigo,
        status: 'ok',
        incluidos: 1,
        alterados: 1,
        encerrados: 1,
        terminais: 1,
        produtosInvalidados: 1,
        produtos: [expect.objectContaining({ nome: 'CAVALO DE TESTE', ncm: ENCERRADO })],
      }),
      expect.objectContaining({
        codigo: b.codigo,
        status: 'ok',
        encerrados: 1,
        terminais: 0,
        produtosInvalidados: 0,
      }),
    ]);
    expect(await ncm(a, INCLUIDO)).toEqual([]);
    expect(await ncm(a, ENCERRADO)).toEqual([expect.objectContaining({ fim: null, excluido: false })]);
    expect(await comandos(a)).toEqual([]);
    expect(await registros('ncm_atualizada')).toEqual([]);
    expect(await registros('ncm_atualizacao_executada')).toEqual([]);
  });

  it('formato quebrado ou encerramento em massa: nada aplicado em nenhuma empresa', async () => {
    corpo = Buffer.from(corpo.toString('utf8').replace('"Descricao"', '"Descrição"'));
    await expect(rodar()).rejects.toThrow(ErroTabelaNcm);
    corpo = tabela((l) => l.filter((_, i) => i % 2 === 0));
    await expect(rodar()).rejects.toThrow(new RegExp(`encerraria \\d+ dos ${lerNcms().length} NCMs`));
    for (const e of [a, b]) {
      expect(await ncm(e, ENCERRADO)).toEqual([expect.objectContaining({ fim: null })]);
      expect(await ncm(e, INCLUIDO)).toEqual([]);
    }
    expect(await registros('ncm_atualizada')).toEqual([]);
  });

  it('aplica em cada empresa: o NCM encerrado aparece no relatório NCMs inválidos de quem o usa', async () => {
    corpo = tabela(comMudancas);
    const r = await rodar();
    expect(r.falhas).toBe(0);
    for (const e of [a, b]) {
      expect(await ncm(e, INCLUIDO)).toEqual([
        { descricao: 'Engenhocas inventadas de teste', inicio: '2026-11-01', fim: null, excluido: false },
      ]);
      // Sem excluir: o fim de vigência na véspera da data da tabela.
      expect(await ncm(e, ENCERRADO)).toEqual([
        expect.objectContaining({ fim: '2026-11-11', excluido: false }),
      ]);
      expect((await ncm(e, ALTERADO))[0]!.descricao).toBe('Asininos (descrição alterada no teste)');
    }
    expect(await comandos(a)).toEqual([
      { terminal_id: terminalA, parametros: { fluxo: 'referencia' }, status: 'pendente' },
    ]);
    expect(await comandos(b)).toEqual([]);

    const rel = await amb
      .http()
      .get('/api/relatorios/ncm-invalidos')
      .set({ Authorization: `Bearer ${tokenA}` });
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    expect((rel.body as RespostaNcmInvalidos).itens).toEqual([
      expect.objectContaining({
        produtoId: produtoA,
        ncm: ENCERRADO,
        motivo: 'fora_vigencia',
        detalhe: 'Vigência até 11/11/2026',
      }),
    ]);

    const porEmpresa = await registros('ncm_atualizada');
    expect(porEmpresa.map((x) => x.empresa_id)).toEqual([a.empresaId, b.empresaId]);
    expect(porEmpresa[0]!.depois).toMatchObject({
      vigente_em: '2026-11-12',
      incluidos: 1,
      encerrados: 1,
      encerrar_em: '2026-11-11',
      terminais: 1,
      produtos_invalidados: 1,
      codigos: { incluidos: [INCLUIDO], alterados: [ALTERADO], encerrados: [ENCERRADO] },
      produtos: [expect.objectContaining({ ncm: ENCERRADO })],
    });
    const [resumo] = await registros('ncm_atualizacao_executada');
    expect(resumo!.depois).toMatchObject({ falhas: 0, vigente_em: '2026-11-12', origem: base });
  });

  it('rodar de novo não muda nada nem manda outro comando', async () => {
    const r = await rodar();
    expect(r.empresas.map((e) => [e.incluidos, e.alterados, e.encerrados, e.terminais])).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    expect(await comandos(a)).toHaveLength(1);
  });

  it('a migração não recarrega o ncms.csv por cima; a empresa nova recebe o arquivo e depois a tabela', async () => {
    const m = await amb.servicos.migrador.migrarTodas({
      posMigracao: posMigracaoSemAdmin(amb.servicos.controle),
    });
    expect(m.falhas).toBe(0);
    for (const e of [a, b]) {
      expect(await ncm(e, INCLUIDO)).toEqual([expect.objectContaining({ excluido: false })]);
      expect(await ncm(e, ENCERRADO)).toEqual([expect.objectContaining({ fim: '2026-11-11' })]);
    }
    const c = await amb.criarEmpresa();
    expect(await ncm(c, INCLUIDO)).toEqual([]);
    // A lista vazia é nenhuma empresa, nunca "todas" (o CLI recusa o `--empresas` inválido antes de chegar aqui).
    expect((await rodar({ codigos: [] })).empresas).toEqual([]);
    expect(await ncm(c, INCLUIDO)).toEqual([]);
    const r = await rodar({ codigos: [c.codigo] });
    expect(r.empresas).toEqual([expect.objectContaining({ codigo: c.codigo, status: 'ok', incluidos: 1 })]);
    expect(await ncm(c, ENCERRADO)).toEqual([expect.objectContaining({ fim: '2026-11-11' })]);
  });

  it('a tabela mais antiga que a aplicada e a empresa em migração ficam de fora', async () => {
    corpo = tabela(comMudancas, '05/11/2026');
    const antiga = await rodar({ codigos: [a.codigo] });
    expect(antiga.empresas).toEqual([
      expect.objectContaining({ status: 'ignorada', erro: expect.stringContaining('mais antiga') }),
    ]);
    corpo = tabela(comMudancas, '13/11/2026');
    const trava = new pg.Client({ connectionString: urlDoBanco(amb.bancoControle) });
    await trava.connect();
    try {
      await trava.query("select pg_advisory_lock(hashtext('genesis:migracao_empresa'), hashtext($1))", [
        a.empresaId,
      ]);
      const r = await rodar({ codigos: [a.codigo, b.codigo] });
      expect(r.empresas.map((e) => e.status)).toEqual(['ignorada', 'ok']);
    } finally {
      await trava.end();
    }
  });

  it('a falha numa empresa desfaz só ela, inteira; as outras seguem', async () => {
    // A gravação em `ncms` falha só na B (gatilho do teste).
    await consultar(
      b.nomeBanco,
      `create function fn_teste_falha() returns trigger language plpgsql as $$
       begin if new.codigo = '77020000' then raise exception 'falha forçada do teste'; end if; return new; end $$;
       create trigger tg_teste_falha before insert or update on ncms for each row execute function fn_teste_falha();`,
    );
    corpo = tabela(
      (l) => [
        ...comMudancas(l).filter((n) => n.codigo !== '01019000'),
        { codigo: '77020000', descricao: 'Geringonças inventadas de teste', inicio: '2026-11-01', fim: null },
      ],
      '14/11/2026',
    );
    const r = await rodar();
    expect(r.falhas).toBe(1);
    expect(r.empresas.map((e) => [e.codigo, e.status])).toEqual([
      [a.codigo, 'ok'],
      [b.codigo, 'falhou'],
      [expect.any(Number), 'ok'],
    ]);
    expect(r.empresas[1]!.erro).toMatch(/falha forçada/);
    expect(await ncm(a, '77020000')).toHaveLength(1);
    expect(await ncm(a, '01019000')).toEqual([expect.objectContaining({ fim: '2026-11-13' })]);
    // Na B, nem o encerramento do outro NCM ficou, nem o registro.
    expect(await ncm(b, '77020000')).toEqual([]);
    expect(await ncm(b, '01019000')).toEqual([expect.objectContaining({ fim: null })]);
    const daB = (await registros('ncm_atualizada')).filter((x) => x.empresa_id === b.empresaId);
    // A de 12/11 duas vezes (a segunda execução também registra), a de 13/11 e nenhuma de 14/11.
    expect(daB.map((x) => x.depois.vigente_em)).toEqual(['2026-11-12', '2026-11-12', '2026-11-13']);
  });
});
