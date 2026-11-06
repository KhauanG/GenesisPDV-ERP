import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criarAmbiente, type Ambiente } from './ambiente.js';

let amb: Ambiente;

beforeAll(async () => {
  amb = await criarAmbiente();
});

afterAll(async () => {
  await amb?.fechar();
});

describe('infraestrutura HTTP', () => {
  it('GET /saude (fora do prefixo /api) informa o banco de controle', async () => {
    const r = await amb.http().get('/saude');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', banco_controle: 'ok', ambiente: 'teste' });
  });

  it('ecoa X-Requisicao-Id válido e gera um UUID v7 quando ausente', async () => {
    const id = '01a18aa7-b34c-7ecf-be3c-23bd5d29385f';
    expect((await amb.http().get('/saude').set('X-Requisicao-Id', id)).headers['x-requisicao-id']).toBe(id);
    expect(
      (await amb.http().get('/saude').set('X-Requisicao-Id', 'nao-uuid')).headers['x-requisicao-id'],
    ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it('rota inexistente e JSON malformado usam o envelope padrão', async () => {
    const nf = await amb.http().get('/api/nao-existe');
    expect(nf.status).toBe(404);
    expect(nf.body).toMatchObject({ codigo: 'NAO_ENCONTRADO', mensagem: 'Rota não encontrada.' });
    const malformado = await amb
      .http()
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"a":');
    expect(malformado.status).toBe(422);
    expect(malformado.body.codigo).toBe('VALIDACAO');
  });

  it('/sync fica fora do prefixo /api e usa o envelope próprio (SYNC 2.4)', async () => {
    const r = await amb.http().get('/sync/pull');
    expect(r.status).toBe(400);
    expect(r.body.erro).toMatchObject({ codigo: 'REQUISICAO_INVALIDA' });
    expect(r.headers['x-agora-servidor']).toMatch(/Z$/);
    expect((await amb.http().get('/api/sync/pull')).status).toBe(404);
    const nf = await amb.http().get('/sync/nao-existe');
    expect(nf.status).toBe(404);
    expect(nf.body.erro.codigo).toBe('NAO_ENCONTRADO');
  });
});
