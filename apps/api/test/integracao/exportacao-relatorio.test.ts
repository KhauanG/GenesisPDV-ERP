/**
 * Exportação de relatório em tarefa, em streaming (Fase 2, F2-B29; ERP 3.5, 3.6; MD 3.1.6, 3.1.8; README da API ›
 * decisão 177), com a fila pg-boss, o S3 em memória e uma massa pequena do razão (`gerarMassa` do F2-B28) lida pelo
 * provedor de exemplo (`provedor-movimentos.ts`). Os limites ficam pequenos (na hora até 1.000 linhas, lotes de 500,
 * abas de 2.500 e partes de 64 KiB no S3 em memória) para o streaming aparecer com poucas linhas: a primeira parte do
 * multipart sobe antes de a última linha ser escrita (o arquivo não fica inteiro na memória). A carga de 1 milhão de
 * linhas com o pico de heap é `pnpm --filter api carga:exportacao` (fora do CI). Também: o link que não passa da
 * retenção, o acesso do momento na execução, a vaga do semáforo e a parte do envio pendurada (limite de inatividade
 * do armazenamento, curto aqui).
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as esperar } from 'node:timers/promises';
import { TAREFA_EXPORTAR_RELATORIO } from '@genesis/shared';
import ExcelJS from 'exceljs';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { semaforoExportacao } from '../../src/comum/exportacao.js';
import { gerarMassa, type Cadastro } from '../carga/massa-razao.js';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';
import { CHAVE_MOVIMENTOS_TESTE, provedorMovimentosTeste } from './provedor-movimentos.js';
import { iniciarS3Falso, type S3Falso } from './s3-falso.js';

let amb: Ambiente;
let emp: EmpresaTeste;
let s3: S3Falso | null = null;
let c: pg.Client;
let cad: Cadastro;
let admin: string;
let total: number;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const ROTA = `/api/relatorios/${CHAVE_MOVIMENTOS_TESTE}/exportar`;
const LINHAS_POR_ABA = 2500;
/** Inatividade máxima de um pedido ao armazenamento no teste (o padrão é 2 min): a parte pendurada falha logo. */
const INATIVIDADE_MS = 3000;
/** A tarefa `.xlsx` do primeiro teste (o do link que não passa da retenção usa o arquivo dela). */
let tarefaXlsx: string;

/** Quantas partes do multipart já tinham chegado ao S3 quando a última linha foi escrita (só no S3 em memória). */
let partesAntesDaUltima: number | null = null;
let escritas = 0;
let esperadas = 0;

beforeAll(async () => {
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      FILA_TRABALHADOR: 'true',
      ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-exp-${Date.now()}`,
      ARMAZENAMENTO_INATIVIDADE_MS: String(INATIVIDADE_MS),
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  await amb.servicos.fila.iniciar();
  Object.assign(amb.servicos.exportacoes.opcoes, {
    limiteNaHora: 1000,
    linhasPorLote: 500,
    linhasPorAba: LINHAS_POR_ABA,
    // O S3 de verdade (MinIO) exige 5 MiB por parte: com ele vale o padrão (um envio só, para este tamanho).
    ...(s3 ? { tamanhoParte: 64 * 1024 } : {}),
  });
  amb.servicos.exportacoes.registrar(
    provedorMovimentosTeste({
      linha: () => {
        escritas++;
        if (s3 && escritas === esperadas) {
          partesAntesDaUltima = s3.pedidos.filter(
            (p) => p.metodo === 'PUT' && p.consulta.has('partNumber'),
          ).length;
        }
      },
    }),
  );
  emp = await amb.criarEmpresa();
  c = await conectar(emp.nomeBanco);
  ({ cadastro: cad } = await gerarMassa(emp.nomeBanco, c, { movimentos: 6000, produtos: 100, semente: 29 }));
  const [n] = await consultar<{ n: string }>(
    emp.nomeBanco,
    'select count(*)::text as n from movimentos_estoque',
  );
  total = Number(n!.n);
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
}, 180_000);

afterAll(async () => {
  await c?.end();
  await amb?.fechar();
  await s3?.fechar();
});

async function aguardarTarefa(token: string, id: string) {
  const fim = Date.now() + 60_000;
  for (;;) {
    const r = await amb.http().get(`/api/tarefas/${id}`).set(bearer(token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    if (r.body.status === 'concluida' || r.body.status === 'falhou') return r.body;
    if (Date.now() > fim) throw new Error(`tarefa não terminou: ${JSON.stringify(r.body)}`);
    await esperar(200);
  }
}

async function baixar(url: string): Promise<Buffer> {
  const r = await fetch(url);
  expect(r.status).toBe(200);
  return Buffer.from(await r.arrayBuffer());
}

const partesMultipart = () =>
  s3 ? s3.pedidos.filter((p) => p.metodo === 'PUT' && p.consulta.has('partNumber')).length : 0;

/** As abas do `.xlsx`: o cabeçalho e as linhas de dados de cada uma. */
async function lerXlsx(conteudo: Buffer) {
  const livro = new ExcelJS.Workbook();
  await livro.xlsx.load(conteudo as unknown as ArrayBuffer);
  return livro.worksheets.map((aba) => {
    const linhas: unknown[][] = [];
    aba.eachRow((r) => linhas.push((r.values as unknown[]).slice(1)));
    return { nome: aba.name, cabecalho: linhas[0] as string[], dados: linhas.slice(1) };
  });
}

describe('exportação em tarefa (acima de LIMITE_EXPORTACAO)', () => {
  it('xlsx: 202 com a tarefa, cursor + streaming + multipart, abas, link de 7 dias, arquivos e auditoria', async () => {
    expect(total).toBeGreaterThan(5000);
    escritas = 0;
    esperadas = total;
    partesAntesDaUltima = null;
    // A retenção é "hoje + 7" em UTC, calculada pelo executor: vale o dia de antes ou o de depois (meia-noite UTC no meio).
    const retencaoAntes = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const r = await amb.http().get(ROTA).query({ formato: 'xlsx' }).set(bearer(admin));
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    tarefaXlsx = r.body.tarefaId;
    expect(r.body).toEqual({ tarefaId: expect.any(String), linhas: total });
    const t = await aguardarTarefa(admin, r.body.tarefaId);
    expect(t.status, JSON.stringify(t)).toBe('concluida');
    expect(t.tipo).toBe(TAREFA_EXPORTAR_RELATORIO);
    const abas = Math.ceil(total / LINHAS_POR_ABA);
    expect(t.resultado).toMatchObject({
      relatorio: CHAVE_MOVIMENTOS_TESTE,
      formato: 'xlsx',
      linhas: total,
      abas,
      nomeArquivo: expect.stringMatching(/^Relatorio_Movimentos_Teste_\d{2}_\d{2}_\d{4}_\d{2}_\d{2}\.xlsx$/),
    });
    expect(t.download).toContain('X-Amz-Expires=604800');
    if (s3) {
      // Streaming: a primeira parte subiu antes de a última linha ser escrita, e nada ficou aberto no bucket.
      expect(partesAntesDaUltima).toBeGreaterThanOrEqual(1);
      expect(partesMultipart()).toBeGreaterThan(1);
      expect(s3.multipart.size).toBe(0);
    }
    const conteudo = await baixar(t.download);
    const planilha = await lerXlsx(conteudo);
    expect(planilha.map((a) => a.nome)).toEqual(
      Array.from({ length: abas }, (_, i) => (i === 0 ? 'Relatório' : `Relatório (${i + 1})`)),
    );
    for (const aba of planilha) {
      expect(aba.cabecalho).toEqual([
        'Data',
        'Estoque',
        'Código',
        'Produto',
        'Movimento',
        'Quantidade',
        'Saldo',
        'Custo unitário',
        'Custo total',
      ]);
    }
    expect(planilha.reduce((s, a) => s + a.dados.length, 0)).toBe(total);
    expect(planilha.slice(0, -1).every((a) => a.dados.length === LINHAS_POR_ABA)).toBe(true);
    // A ordem do cursor (estoque, data, id) e os tipos das células: data, número e texto.
    const [primeiro] = await consultar<{ data: Date; quantidade: string }>(
      emp.nomeBanco,
      `select data_movimento as data, quantidade::text from movimentos_estoque
        order by estoque_id, data_movimento, id limit 1`,
    );
    const linha = planilha[0]!.dados[0]!;
    expect(linha[0]).toBeInstanceOf(Date);
    expect(typeof linha[5]).toBe('number');
    expect(linha[5]).toBe(Number(primeiro!.quantidade));

    const [arq] = await consultar<{
      categoria: string;
      entidade: string;
      registro_id: string;
      tamanho_bytes: string;
      sha256: string;
      retencao_ate: string;
      nome_original: string;
    }>(
      emp.nomeBanco,
      `select a.categoria, a.entidade, a.registro_id, a.tamanho_bytes::text, a.sha256, a.retencao_ate::text,
              a.nome_original
         from arquivos a join tarefas t on t.arquivo_id = a.id where t.id = $1`,
      [r.body.tarefaId],
    );
    expect(arq).toMatchObject({
      categoria: 'planilha_exportacao',
      entidade: 'tarefas',
      registro_id: r.body.tarefaId,
      tamanho_bytes: String(conteudo.length),
      sha256: createHash('sha256').update(conteudo).digest('hex'),
      nome_original: t.resultado.nomeArquivo,
    });
    const retencaoDepois = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    expect([retencaoAntes, retencaoDepois]).toContain(arq!.retencao_ate);

    const auditoria = await consultar<{
      origem: string;
      usuario_nome: string;
      localizacao: string;
      depois: Record<string, unknown>;
    }>(
      emp.nomeBanco,
      `select origem, usuario_nome, localizacao, depois from auditoria
        where acao = 'exportar' and entidade = 'movimentos_estoque' and depois->>'tarefaId' = $1`,
      [r.body.tarefaId],
    );
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]).toMatchObject({
      origem: 'erp',
      localizacao: 'Relatórios › Movimentos (teste)',
      depois: { relatorio: CHAVE_MOVIMENTOS_TESTE, formato: 'xlsx', linhas: total, filtros: {} },
    });
  });

  it('csv: BOM, `;`, vírgula decimal, uma linha por movimento e o mesmo streaming', async () => {
    const antes = partesMultipart();
    const r = await amb.http().get(ROTA).query({ formato: 'csv' }).set(bearer(admin));
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const t = await aguardarTarefa(admin, r.body.tarefaId);
    expect(t.status, JSON.stringify(t)).toBe('concluida');
    expect(t.resultado).toMatchObject({ formato: 'csv', linhas: total, abas: 1 });
    expect(t.resultado.nomeArquivo).toMatch(/\.csv$/);
    if (s3) expect(partesMultipart() - antes).toBeGreaterThan(1);
    const texto = (await baixar(t.download)).toString('utf8');
    expect(
      texto.startsWith(
        '﻿Data;Estoque;Código;Produto;Movimento;Quantidade;Saldo;Custo unitário;Custo total\r\n',
      ),
    ).toBe(true);
    const linhas = texto.slice(1).split('\r\n').filter(Boolean);
    expect(linhas).toHaveLength(total + 1);
    // `dd/mm/aaaa hh:mm` e o custo com vírgula.
    expect(linhas[1]).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2};/);
    expect(linhas.slice(1).some((l) => /;-?\d+,\d+$/.test(l))).toBe(true);
  });

  it('o filtro do provedor vale na tarefa (um estoque)', async () => {
    const loja = cad.estoques.find((e) => e.nome === 'Loja 1')!;
    const [n] = await consultar<{ n: string }>(
      emp.nomeBanco,
      'select count(*)::text as n from movimentos_estoque where estoque_id = $1',
      [loja.id],
    );
    expect(Number(n!.n)).toBeGreaterThan(1000);
    const [{ nome }] = (await consultar<{ nome: string }>(
      emp.nomeBanco,
      'select nome from estoques where id = $1',
      [loja.id],
    )) as [{ nome: string }];
    const r = await amb.http().get(ROTA).query({ formato: 'csv', estoqueId: loja.id }).set(bearer(admin));
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.linhas).toBe(Number(n!.n));
    const t = await aguardarTarefa(admin, r.body.tarefaId);
    expect(t.resultado.linhas).toBe(Number(n!.n));
    const texto = (await baixar(t.download)).toString('utf8');
    expect(
      texto
        .split('\r\n')
        .filter(Boolean)
        .slice(1)
        .every((l) => l.split(';')[1] === nome),
    ).toBe(true);
  });
});

describe('o link do GET /tarefas não passa da retenção do arquivo (ERP 3.6)', () => {
  const retencao = async (data: string) =>
    consultar(
      emp.nomeBanco,
      'update arquivos set retencao_ate = $1 where id = (select arquivo_id from tarefas where id = $2)',
      [data, tarefaXlsx],
    );
  const tarefa = async () => {
    const r = await amb.http().get(`/api/tarefas/${tarefaXlsx}`).set(bearer(admin));
    expect(r.status).toBe(200);
    return r.body as { download: string | null; downloadExpirado: boolean };
  };
  const dia = (deslocamento: number) =>
    new Date(Date.now() + deslocamento * 86_400_000).toISOString().slice(0, 10);

  it('retenção vencida → sem link (expirado); no último dia, o link vale só até o fim dele', async () => {
    const antes = await tarefa();
    expect(antes.downloadExpirado).toBe(false);
    try {
      await retencao(dia(-1));
      expect(await tarefa()).toMatchObject({ download: null, downloadExpirado: true });
      // E a lista também: o mesmo item, sem link.
      const lista = await amb.http().get('/api/tarefas').set(bearer(admin));
      expect(lista.body.itens.find((i: { id: string }) => i.id === tarefaXlsx)).toMatchObject({
        download: null,
        downloadExpirado: true,
      });
      await retencao(dia(0));
      const ultimoDia = await tarefa();
      expect(ultimoDia.downloadExpirado).toBe(false);
      const validade = Number(new URL(ultimoDia.download!).searchParams.get('X-Amz-Expires'));
      expect(validade).toBeGreaterThan(0);
      expect(validade).toBeLessThanOrEqual(86_400);
    } finally {
      await retencao(dia(7));
    }
  });
});

describe('até LIMITE_EXPORTACAO baixa na hora', () => {
  it('200 com o arquivo (write-excel-file) e a auditoria `exportar`', async () => {
    const menor = await consultar<{ estoque_id: string; n: string }>(
      emp.nomeBanco,
      'select estoque_id, count(*)::text as n from movimentos_estoque group by 1 order by 2::int limit 1',
    );
    // O limite do teste (1.000) passa a ser exatamente o tamanho do menor estoque: no limite ainda baixa na hora.
    const opcoes = amb.servicos.exportacoes.opcoes;
    const limite = opcoes.limiteNaHora;
    opcoes.limiteNaHora = Number(menor[0]!.n);
    let r;
    try {
      r = await amb
        .http()
        .get(ROTA)
        .query({ formato: 'xlsx', estoqueId: menor[0]!.estoque_id })
        .set(bearer(admin))
        .buffer(true)
        .parse((res, cb) => {
          const partes: Buffer[] = [];
          res.on('data', (p: Buffer) => partes.push(p));
          res.on('end', () => cb(null, Buffer.concat(partes)));
        });
    } finally {
      opcoes.limiteNaHora = limite;
    }
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(
      /Relatorio_Movimentos_Teste_\d{2}_\d{2}_\d{4}_\d{2}_\d{2}\.xlsx/,
    );
    const [aba] = await lerXlsx(r.body as Buffer);
    expect(aba!.dados).toHaveLength(Number(menor[0]!.n));
    const auditoria = await consultar<{ depois: Record<string, unknown> }>(
      emp.nomeBanco,
      `select depois from auditoria where acao = 'exportar' and entidade = 'movimentos_estoque'
          and depois->'filtros'->>'estoqueId' = $1 and not depois ? 'tarefaId'`,
      [menor[0]!.estoque_id],
    );
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]!.depois).toMatchObject({ formato: 'xlsx', linhas: Number(menor[0]!.n) });
  });

  it('relatório desconhecido → 404; filtro inválido → 422', async () => {
    expect((await amb.http().get('/api/relatorios/nao-existe/exportar').set(bearer(admin))).status).toBe(404);
    const r = await amb.http().get(ROTA).query({ estoqueId: 'x' }).set(bearer(admin));
    expect(r.status).toBe(422);
  });
});

describe('permissões (relatorios.exportar, a do relatório e produtos.ver_custo)', () => {
  it('sem relatorios.exportar → 403; sem a permissão do relatório → 403', async () => {
    await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista' });
    const estoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
    expect((await amb.http().get(ROTA).set(bearer(estoquista))).status).toBe(403);
    // O Financeiro tem relatorios.exportar, mas não relatorios.movimentacao_estoque.
    await criarUsuario(emp.nomeBanco, { login: 'financeiro', perfil: 'financeiro' });
    const financeiro = await amb.entrar(emp.codigo, 'financeiro', SENHA_TESTE);
    const r = await amb.http().get(ROTA).set(bearer(financeiro));
    expect(r.status).toBe(403);
    expect(r.body.detalhes?.permissoes ?? r.body.erro?.detalhes?.permissoes).toEqual([
      'relatorios.movimentacao_estoque',
    ]);
  });

  it('sem produtos.ver_custo o custo sai do arquivo; os estoques permitidos limitam as linhas', async () => {
    const loja = cad.estoques.find((e) => e.nome === 'Loja 2')!;
    const id = await criarUsuario(emp.nomeBanco, {
      login: 'estoquista2',
      perfil: 'estoquista',
      estoques: [loja.id],
    });
    await consultar(
      emp.nomeBanco,
      "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'relatorios.exportar', 'conceder')",
      [id],
    );
    const token = await amb.entrar(emp.codigo, 'estoquista2', SENHA_TESTE);
    const [n] = await consultar<{ n: string }>(
      emp.nomeBanco,
      'select count(*)::text as n from movimentos_estoque where estoque_id = $1',
      [loja.id],
    );
    const [{ nome }] = (await consultar<{ nome: string }>(
      emp.nomeBanco,
      'select nome from estoques where id = $1',
      [loja.id],
    )) as [{ nome: string }];
    const r = await amb.http().get(ROTA).query({ formato: 'xlsx' }).set(bearer(token));
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.linhas).toBe(Number(n!.n));
    const t = await aguardarTarefa(token, r.body.tarefaId);
    expect(t.status, JSON.stringify(t)).toBe('concluida');
    const planilha = await lerXlsx(await baixar(t.download));
    expect(planilha[0]!.cabecalho).toEqual([
      'Data',
      'Estoque',
      'Código',
      'Produto',
      'Movimento',
      'Quantidade',
      'Saldo',
    ]);
    expect(planilha.flatMap((a) => a.dados).every((l) => l.length <= 7 && l[1] === nome)).toBe(true);
    expect(planilha.reduce((s, a) => s + a.dados.length, 0)).toBe(Number(n!.n));
  });
});

describe('na execução vale o acesso do momento, não o do pedido', () => {
  /** A tarefa como o pedido a criaria, de quem tinha o acesso; o executor roda direto, como a fila depois da mudança. */
  async function tarefaDe(usuarioId: string, formato: 'csv' | 'xlsx', linhas: number) {
    const [t] = await consultar<{ id: string }>(
      emp.nomeBanco,
      `insert into tarefas (tipo, parametros, usuario_id) values ($1, $2, $3) returning id`,
      [
        TAREFA_EXPORTAR_RELATORIO,
        JSON.stringify({ relatorio: CHAVE_MOVIMENTOS_TESTE, formato, filtros: {}, linhas, origem: {} }),
        usuarioId,
      ],
    );
    await amb.servicos.tarefas.executar(emp.empresaId, t!.id);
    return t!.id;
  }

  it('sem relatorios.exportar desde o pedido: falha sem gravar arquivo nem auditoria', async () => {
    const loja = cad.estoques.find((e) => e.nome === 'Loja 1')!;
    const id = await criarUsuario(emp.nomeBanco, {
      login: 'revogado',
      perfil: 'estoquista',
      estoques: [loja.id],
    });
    // Tinha a permissão no pedido; perdeu antes da execução.
    const [antes] = await consultar<{ arquivos: string; auditoria: string }>(
      emp.nomeBanco,
      `select (select count(*) from arquivos)::text as arquivos,
              (select count(*) from auditoria where acao = 'exportar')::text as auditoria`,
    );
    const tarefaId = await tarefaDe(id, 'csv', 2000);
    const [fim] = await consultar<{ status: string; erro: string; arquivo_id: string | null }>(
      emp.nomeBanco,
      'select status, erro, arquivo_id from tarefas where id = $1',
      [tarefaId],
    );
    expect(fim).toEqual({
      status: 'falhou',
      erro: 'Você não tem permissão para exportar este relatório.',
      arquivo_id: null,
    });
    const [depois] = await consultar<{ arquivos: string; auditoria: string }>(
      emp.nomeBanco,
      `select (select count(*) from arquivos)::text as arquivos,
              (select count(*) from auditoria where acao = 'exportar')::text as auditoria`,
    );
    expect(depois).toEqual(antes);
  });

  it('o estoque trocado entre o pedido e a execução: só as linhas do estoque de agora', async () => {
    const [loja1, loja2] = ['Loja 1', 'Loja 2'].map((n) => cad.estoques.find((e) => e.nome === n)!);
    const id = await criarUsuario(emp.nomeBanco, {
      login: 'trocado',
      perfil: 'estoquista',
      estoques: [loja1!.id],
    });
    await consultar(
      emp.nomeBanco,
      "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'relatorios.exportar', 'conceder')",
      [id],
    );
    await consultar(emp.nomeBanco, 'update usuarios_estoques set estoque_id = $2 where usuario_id = $1', [
      id,
      loja2!.id,
    ]);
    const [n] = await consultar<{ n: string }>(
      emp.nomeBanco,
      'select count(*)::text as n from movimentos_estoque where estoque_id = $1',
      [loja2!.id],
    );
    const [{ nome }] = (await consultar<{ nome: string }>(
      emp.nomeBanco,
      'select nome from estoques where id = $1',
      [loja2!.id],
    )) as [{ nome: string }];
    const tarefaId = await tarefaDe(id, 'csv', 2000);
    const token = await amb.entrar(emp.codigo, 'trocado', SENHA_TESTE);
    const t = await aguardarTarefa(token, tarefaId);
    expect(t.status, JSON.stringify(t)).toBe('concluida');
    expect(t.resultado.linhas).toBe(Number(n!.n));
    const texto = (await baixar(t.download)).toString('utf8');
    const dados = texto.slice(1).split('\r\n').filter(Boolean).slice(1);
    expect(dados).toHaveLength(Number(n!.n));
    expect(dados.every((l) => l.split(';')[1] === nome)).toBe(true);
    // Sem produtos.ver_custo (o perfil Estoquista): as colunas de custo também são as de agora.
    expect(texto.slice(1).split('\r\n')[0]).not.toContain('Custo');
  });
});

describe('semáforo da exportação (EXPORTACAO_CONCORRENCIA)', () => {
  it('com as vagas ocupadas, a tarefa fica em "Aguardando a vez" e segue quando uma vaga abre', async () => {
    expect(semaforoExportacao.limite).toBeGreaterThanOrEqual(2);
    const vagas = await Promise.all(
      Array.from({ length: semaforoExportacao.limite }, () => semaforoExportacao.adquirir()),
    );
    let tarefaId: string;
    try {
      const r = await amb.http().get(ROTA).query({ formato: 'csv' }).set(bearer(admin));
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      tarefaId = r.body.tarefaId;
      const fim = Date.now() + 30_000;
      for (;;) {
        const t = (await amb.http().get(`/api/tarefas/${tarefaId}`).set(bearer(admin))).body;
        if (t.status === 'executando' && t.mensagem === 'Aguardando a vez') break;
        expect(t.status, JSON.stringify(t)).not.toMatch(/concluida|falhou/);
        if (Date.now() > fim)
          throw new Error(`a tarefa não chegou a "Aguardando a vez": ${JSON.stringify(t)}`);
        await esperar(100);
      }
      await esperar(500);
      const parada = (await amb.http().get(`/api/tarefas/${tarefaId}`).set(bearer(admin))).body;
      expect(parada).toMatchObject({ status: 'executando', mensagem: 'Aguardando a vez', progressoPct: 0 });
    } finally {
      for (const liberar of vagas) liberar();
    }
    const t = await aguardarTarefa(admin, tarefaId);
    expect(t.status, JSON.stringify(t)).toBe('concluida');
  });
});

describe('teto e falhas', () => {
  it('no máximo 2 exportações em andamento por usuário (422 na terceira)', async () => {
    const [{ id: usuarioId }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from usuarios where login = 'admin'",
    )) as [{ id: string }];
    await consultar(
      emp.nomeBanco,
      `insert into tarefas (tipo, status, usuario_id) values ($1, 'na_fila', $2), ($1, 'executando', $2)`,
      [TAREFA_EXPORTAR_RELATORIO, usuarioId],
    );
    try {
      const r = await amb.http().get(ROTA).set(bearer(admin));
      expect(r.status).toBe(422);
      expect(JSON.stringify(r.body)).toContain('em andamento');
      // Abaixo do limite (no limite, na hora) não conta: baixa direto.
      const menor = await consultar<{ estoque_id: string }>(
        emp.nomeBanco,
        'select estoque_id from movimentos_estoque group by 1 order by count(*) limit 1',
      );
      amb.servicos.exportacoes.opcoes.limiteNaHora = 100_000;
      const naHora = await amb.http().get(ROTA).query({ estoqueId: menor[0]!.estoque_id }).set(bearer(admin));
      expect(naHora.status).toBe(200);
    } finally {
      amb.servicos.exportacoes.opcoes.limiteNaHora = 1000;
      await consultar(
        emp.nomeBanco,
        `delete from tarefas where tipo = $1 and status in ('na_fila', 'executando')`,
        [TAREFA_EXPORTAR_RELATORIO],
      );
    }
  });

  it('acima de LIMITE_EXPORTACAO_TAREFA pede para refinar os filtros (422)', async () => {
    const opcoes = amb.servicos.exportacoes.opcoes;
    opcoes.limiteTarefa = 1000;
    try {
      const r = await amb.http().get(ROTA).set(bearer(admin));
      expect(r.status).toBe(422);
      expect(JSON.stringify(r.body)).toContain('Refine os filtros');
    } finally {
      delete opcoes.limiteTarefa;
    }
  });

  it.skipIf(!!process.env.ARMAZENAMENTO_TESTE_URL).each(['csv', 'xlsx'] as const)(
    '%s: o envio que falha no meio aborta o multipart, a tarefa falha e nada é gravado',
    async (formato) => {
      const [antes] = await consultar<{ arquivos: string; auditoria: string }>(
        emp.nomeBanco,
        `select (select count(*) from arquivos)::text as arquivos,
                (select count(*) from auditoria where acao = 'exportar')::text as auditoria`,
      );
      s3!.falharNaParte = 2;
      const abortos = s3!.pedidos.filter((p) => p.metodo === 'DELETE' && p.consulta.has('uploadId')).length;
      try {
        const r = await amb.http().get(ROTA).query({ formato }).set(bearer(admin));
        expect(r.status).toBe(202);
        const t = await aguardarTarefa(admin, r.body.tarefaId);
        expect(t.status).toBe('falhou');
        expect(t.erro).toMatch(/^O arquivo não pôde ser gravado no armazenamento: /);
        expect(t.download).toBeNull();
      } finally {
        s3!.falharNaParte = null;
      }
      expect(s3!.multipart.size).toBe(0);
      expect(s3!.pedidos.filter((p) => p.metodo === 'DELETE' && p.consulta.has('uploadId')).length).toBe(
        abortos + 1,
      );
      const [depois] = await consultar<{ arquivos: string; auditoria: string }>(
        emp.nomeBanco,
        `select (select count(*) from arquivos)::text as arquivos,
                (select count(*) from auditoria where acao = 'exportar')::text as auditoria`,
      );
      expect(depois).toEqual(antes);
    },
  );

  it.skipIf(!!process.env.ARMAZENAMENTO_TESTE_URL)(
    'a parte do envio pendurada (sem resposta) falha pelo limite de inatividade e solta a transação do cursor',
    async () => {
      s3!.pendurarNaParte = 2;
      try {
        const r = await amb.http().get(ROTA).query({ formato: 'csv' }).set(bearer(admin));
        expect(r.status).toBe(202);
        const t = await aguardarTarefa(admin, r.body.tarefaId);
        expect(t.status).toBe('falhou');
        expect(t.erro).toMatch(/^O arquivo não pôde ser gravado no armazenamento: .*timed out/);
      } finally {
        s3!.pendurarNaParte = null;
      }
      expect(s3!.multipart.size).toBe(0);
      // Nada ficou "idle in transaction" com o instantâneo do cursor aberto.
      const sessoes = await consultar<{ n: string }>(
        emp.nomeBanco,
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and state like 'idle in transaction%'`,
      );
      expect(sessoes[0]!.n).toBe('0');
    },
    60_000,
  );

  it('gravarFluxo: arquivo menor que uma parte vai num PUT só', async () => {
    const antes = partesMultipart();
    const chave = `emp/${emp.codigo}/relatorios/teste/pequeno.csv`;
    const r = await amb.servicos.armazenamento.gravarFluxo(
      chave,
      Readable.from([Buffer.from('a;b\r\n'), Buffer.from('1;2\r\n')]),
      'text/csv; charset=utf-8',
    );
    expect(r).toEqual({
      sha256: createHash('sha256').update('a;b\r\n1;2\r\n').digest('hex'),
      tamanhoBytes: 10,
      partes: 1,
    });
    expect(partesMultipart()).toBe(antes);
    expect((await amb.servicos.armazenamento.ler(chave)).toString()).toBe('a;b\r\n1;2\r\n');
  });
});
