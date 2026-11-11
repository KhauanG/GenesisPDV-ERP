/**
 * Envio de arquivos e imagens (Fase 2, F2-B43; MD 3.1.6; SYNC 6.12; README da API › decisão 189), com o S3 em
 * memória e imagens geradas na hora (nada de foto real: o repositório é público). Critério de pronto: a foto enviada
 * fica guardada com o sha256 e a variante `pdv_256`, e o envio malicioso é recusado.
 *
 * Também: o HTML renomeado para `.png` e o SVG (415), o PNG truncado (415, a imagem é decodificada de verdade), o
 * arquivo grande pelo `Content-Length` e pelo corte do stream no multer (413, 1 MB no logotipo), o terceiro envio
 * simultâneo do mesmo usuário (429), os envios lentos que não seguram a vaga do processo, o envio sem tamanho
 * (pedaços), a bomba de descompressão (422 pelo cabeçalho, sem decodificar), a outra empresa e o cadastro que o
 * usuário não vê (404), a permissão do destino (403 antes de ler o corpo), a chave do armazenamento gerada pelo
 * servidor (sem o nome do cliente), os cabeçalhos do conteúdo (`nosniff`, o tipo detectado, o nome `<id>.<ext>`), os
 * Anexos da loja (logotipo e foto gravados no cadastro, com a categoria e a loja conferidas) e a memória estável com
 * 20 envios seguidos.
 */
import { createHash, randomBytes } from 'node:crypto';
import { request as pedidoHttp } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as esperar } from 'node:timers/promises';
import { detectarTipoArquivo, LADO_VARIANTE_PDV, type ArquivoInfo } from '@genesis/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { imagemTeste, pngBomba } from '../fixtures/imagens.js';
import {
  consultar,
  criarAmbiente,
  criarLoja,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';
import { iniciarS3Falso, type S3Falso } from './s3-falso.js';

process.env.ARQUIVOS_ENVIOS_POR_MINUTO = '1000';

let amb: Ambiente;
let emp: EmpresaTeste;
let outra: EmpresaTeste;
let s3: S3Falso | null = null;
let admin: string;
let adminOutra: string;
let vendedor: string;
let gerenteLoja2: string;
let bucket: string;
const ids: Record<string, string> = {};
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  bucket = `genesis-teste-arquivos-${Date.now()}`;
  amb = await criarAmbiente({
    env: { ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url, ARMAZENAMENTO_BUCKET: bucket },
  });
  await amb.servicos.armazenamento.garantirBucket();
  emp = await amb.criarEmpresa();
  outra = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  adminOutra = await amb.entrar(outra.codigo, 'admin', outra.senha);
  ids.loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1');
  ids.loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2');
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [ids.loja1] });
  vendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  await criarUsuario(emp.nomeBanco, { login: 'gerente2', perfil: 'gerente', lojas: [ids.loja2] });
  gerenteLoja2 = await amb.entrar(emp.codigo, 'gerente2', SENHA_TESTE);
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
  await s3?.fechar();
});

function enviar(token: string, query: string, conteudo: Buffer, nome = 'foto.png', tipo = 'image/png') {
  return amb
    .http()
    .post(`/api/arquivos?${query}`)
    .set(bearer(token))
    .attach('arquivo', conteudo, { filename: nome, contentType: tipo });
}

const objeto = (chave: string) => s3?.objetos.get(`${bucket}/${chave}`);

const CABECALHO_PARTE =
  '--xyz\r\nContent-Disposition: form-data; name="arquivo"; filename="a.png"\r\n' +
  'Content-Type: image/png\r\n\r\n';

/**
 * Um envio que declara `contentLength` e manda só `pedacos`, sem terminar o corpo (o envio lento, ou o que mente no
 * tamanho). `resposta` resolve com o status e o corpo se o servidor responder antes de o corpo terminar, ou com
 * `null` depois de `prazoMs`; `fechar` derruba a conexão.
 */
function envioIncompleto(
  token: string,
  query: string,
  contentLength: number,
  pedacos: readonly (string | Buffer)[],
  prazoMs = 3000,
) {
  const { port } = amb.app!.getHttpServer().address() as AddressInfo;
  const req = pedidoHttp({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: `/api/arquivos?${query}`,
    headers: {
      ...bearer(token),
      'Content-Type': 'multipart/form-data; boundary=xyz',
      'Content-Length': String(contentLength),
    },
  });
  req.on('error', () => undefined);
  const resposta = new Promise<{ status: number; corpo: { codigo?: string; mensagem?: string } } | null>(
    (ok) => {
      const prazo = setTimeout(() => ok(null), prazoMs);
      req.on('response', (res) => {
        let texto = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (texto += d));
        res.on('end', () => {
          clearTimeout(prazo);
          ok({ status: res.statusCode ?? 0, corpo: texto ? JSON.parse(texto) : {} });
        });
      });
    },
  );
  for (const p of pedacos) req.write(p);
  return { resposta, fechar: () => req.destroy() };
}

/** Soma dos bytes guardados no S3 em memória (o que o teste desconta da memória do processo). */
const bytesNoS3 = () => [...(s3?.objetos.values() ?? [])].reduce((t, o) => t + o.corpo.length, 0);

const linhaArquivo = async (id: string) =>
  (
    await consultar<{
      chave_armazenamento: string;
      nome_original: string;
      tipo_mime: string;
      sha256: string;
      tamanho_bytes: string;
      categoria: string;
      entidade: string;
      loja_id: string | null;
      registro_id: string | null;
      variantes: Record<string, { chave: string; sha256: string; largura: number; altura: number }>;
    }>(emp.nomeBanco, 'select * from arquivos where id = $1', [id])
  )[0]!;

describe('envio de imagem (critério de pronto)', () => {
  it('a foto do produto fica guardada com o sha256 e a variante pdv_256 em WebP de 256 px', async () => {
    const foto = await imagemTeste(800, 600, 'jpeg');
    const r = await enviar(admin, 'destino=produto_foto', foto, 'garrafa.jpg', 'image/jpeg');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const a = r.body as ArquivoInfo;
    expect(a).toMatchObject({
      categoria: 'foto_produto',
      entidade: 'produtos',
      lojaId: null,
      nomeOriginal: 'garrafa.jpg',
      tipoMime: 'image/jpeg',
      tamanhoBytes: foto.length,
      sha256: sha(foto),
    });
    expect(a.variantes.pdv_256).toMatchObject({
      tipoMime: 'image/webp',
      largura: LADO_VARIANTE_PDV,
      altura: 192,
    });
    const l = await linhaArquivo(a.id);
    expect(l.sha256).toBe(sha(foto));
    // A chave é do servidor: `emp/<codigo>/foto_produto/<aaaa>/<mm>/<uuid>.jpg`, a variante ao lado.
    expect(l.chave_armazenamento).toMatch(
      new RegExp(`^emp/${emp.codigo}/foto_produto/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.jpg$`),
    );
    expect(l.variantes.pdv_256!.chave).toBe(l.chave_armazenamento.replace(/\.jpg$/, '.pdv_256.webp'));
    if (s3) {
      expect(objeto(l.chave_armazenamento)).toMatchObject({ tipo: 'image/jpeg', sha256: sha(foto) });
      const v = objeto(l.variantes.pdv_256!.chave)!;
      expect(v.tipo).toBe('image/webp');
      expect(v.sha256).toBe(l.variantes.pdv_256!.sha256);
      expect(sha(v.corpo)).toBe(l.variantes.pdv_256!.sha256);
      expect(detectarTipoArquivo(v.corpo)).toBe('webp');
      const m = await sharp(v.corpo).metadata();
      expect([m.width, m.height]).toEqual([256, 192]);
    }
    // O conteúdo da variante, pela API: o tipo gravado, nosniff e o nome gerado.
    const c = await amb
      .http()
      .get(`/api/arquivos/${a.id}/conteudo?variante=pdv_256`)
      .set(bearer(admin))
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on('data', (p: Buffer) => partes.push(p));
        res.on('end', () => cb(null, Buffer.concat(partes)));
      });
    expect(c.status).toBe(200);
    expect(c.headers['content-type']).toBe('image/webp');
    expect(c.headers['x-content-type-options']).toBe('nosniff');
    expect(c.headers['content-security-policy']).toContain("default-src 'none'");
    expect(c.headers['content-disposition']).toBe(`inline; filename="${a.id}.pdv_256.webp"`);
    expect(c.headers.etag).toBe(`"${a.variantes.pdv_256!.sha256}"`);
    expect(sha(c.body as Buffer)).toBe(a.variantes.pdv_256!.sha256);
    const original = await amb.http().get(`/api/arquivos/${a.id}/conteudo`).set(bearer(admin));
    expect(original.headers['content-type']).toBe('image/jpeg');
    expect(original.headers['content-disposition']).toBe(`inline; filename="${a.id}.jpg"`);
    const meta = await amb.http().get(`/api/arquivos/${a.id}`).set(bearer(admin));
    expect(meta.status).toBe(200);
    expect(meta.body).toEqual(a);
    expect(JSON.stringify(meta.body)).not.toContain('emp/');
  });

  it('PNG e WebP passam; a imagem pequena não é ampliada; o tipo gravado é o do conteúdo, não o do cliente', async () => {
    const png = await imagemTeste(300, 900, 'png');
    // O navegador mandou "image/jpeg" e a extensão .jpg: vale o conteúdo (PNG).
    const r = await enviar(admin, 'destino=categoria_imagem', png, 'categoria.jpg', 'image/jpeg');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.tipoMime).toBe('image/png');
    expect(r.body.variantes.pdv_256).toMatchObject({ largura: 85, altura: 256 });
    expect((await linhaArquivo(r.body.id)).chave_armazenamento).toMatch(/\.png$/);
    const webp = await imagemTeste(100, 80, 'webp');
    const w = await enviar(admin, 'destino=marca_logotipo', webp, 'logo.webp', 'image/webp');
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(w.body).toMatchObject({ tipoMime: 'image/webp', categoria: 'logotipo', entidade: 'marcas' });
    expect(w.body.variantes.pdv_256).toMatchObject({ largura: 100, altura: 80 });
  });
});

describe('envio malicioso recusado', () => {
  it('HTML renomeado para .png volta 415, e nada é gravado', async () => {
    const antes = s3?.objetos.size ?? 0;
    const contar = async () =>
      (await consultar<{ n: number }>(emp.nomeBanco, 'select count(*)::int as n from arquivos'))[0]!.n;
    const linhasAntes = await contar();
    const html = Buffer.from('<!doctype html><html><script>alert(document.cookie)</script></html>');
    const r = await enviar(admin, 'destino=produto_foto', html, 'foto.png', 'image/png');
    expect(r.status, JSON.stringify(r.body)).toBe(415);
    expect(r.body.codigo).toBe('TIPO_NAO_SUPORTADO');
    expect(r.body.mensagem).toContain('pelo conteúdo');
    if (s3) expect(s3.objetos.size).toBe(antes);
    expect(await contar()).toBe(linhasAntes);
  });

  it('SVG (mesmo com script), GIF, PDF na foto e o PNG truncado são recusados (415)', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    expect((await enviar(admin, 'destino=produto_foto', svg, 'a.svg', 'image/svg+xml')).status).toBe(415);
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
    expect((await enviar(admin, 'destino=produto_foto', gif, 'a.gif', 'image/gif')).status).toBe(415);
    const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    expect((await enviar(admin, 'destino=produto_foto', pdf, 'a.pdf', 'application/pdf')).status).toBe(415);
    // Começa como PNG, mas não é imagem: o sharp decodifica e recusa.
    const png = await imagemTeste(200, 200, 'png');
    const truncado = Buffer.concat([png.subarray(0, 40), Buffer.from('<html><script>x</script></html>')]);
    const t = await enviar(admin, 'destino=produto_foto', truncado);
    expect(t.status, JSON.stringify(t.body)).toBe(415);
    expect(t.body.mensagem).toContain('corrompido');
  });

  it('2,1 MB volta 413 pelo Content-Length, antes de ler o corpo; 1,1 MB no logotipo também', async () => {
    // Só o cabeçalho da parte vai: o 413 chega sem o corpo, então é o `Content-Length` (nem o multer nem o serviço
    // chegariam a ver bytes do arquivo).
    for (const [query, declarado, texto] of [
      ['destino=produto_foto', 2.1 * 1024 * 1024, '2 MB'],
      ['destino=marca_logotipo', 1.1 * 1024 * 1024, '1 MB'],
    ] as const) {
      const e = envioIncompleto(admin, query, Math.round(declarado), [CABECALHO_PARTE]);
      const r = await e.resposta;
      e.fechar();
      expect(r, query).not.toBeNull();
      expect(r!.status).toBe(413);
      expect(r!.corpo.codigo).toBe('ARQUIVO_GRANDE');
      expect(r!.corpo.mensagem).toContain(texto);
    }
    // O corpo inteiro (o caminho do navegador) também.
    const grande = Buffer.concat([await imagemTeste(10, 10, 'png'), Buffer.alloc(2.1 * 1024 * 1024)]);
    const r = await enviar(admin, 'destino=produto_foto', grande);
    expect(r.status, JSON.stringify(r.body)).toBe(413);
    expect(r.body.codigo).toBe('ARQUIVO_GRANDE');
  });

  it('o arquivo 1 byte acima do limite, dentro da folga do Content-Length, é cortado no stream (413)', async () => {
    // O `Content-Length` cabe na folga, então é o `fileSize` do multer que recusa: o envio nem chega ao serviço (a
    // conferência de tamanho de `Arquivos.enviar` daria o mesmo 413, mas só com o arquivo inteiro na memória).
    const png = await imagemTeste(10, 10, 'png');
    const justo = Buffer.concat([png, Buffer.alloc(1024 * 1024 + 1 - png.length)]);
    const servico = vi.spyOn(amb.servicos.arquivos, 'enviar');
    try {
      const r = await enviar(admin, 'destino=marca_logotipo', justo);
      expect(r.status, JSON.stringify(r.body)).toBe(413);
      expect(r.body.codigo).toBe('ARQUIVO_GRANDE');
      expect(servico).not.toHaveBeenCalled();
      // O controle: no limite exato o mesmo caminho chega ao serviço.
      const noLimite = Buffer.concat([png, Buffer.alloc(1024 * 1024 - png.length)]);
      expect((await enviar(admin, 'destino=marca_logotipo', noLimite)).status).not.toBe(413);
      expect(servico).toHaveBeenCalledTimes(1);
    } finally {
      servico.mockRestore();
    }
  });

  it('o terceiro envio simultâneo do mesmo usuário volta 429 na hora; terminados, as vagas voltam', async () => {
    const { port } = amb.app!.getHttpServer().address() as AddressInfo;
    const png = await imagemTeste(30, 30, 'png');
    // Dois envios que mandam só o começo do corpo e ficam abertos (o envio lento), um de cada vez e com folga para o
    // servidor contar cada um antes do próximo (senão o terceiro pode chegar antes e o 429 cair num dos abertos).
    const respostas: number[] = [];
    const abertos = [];
    for (let i = 0; i < 2; i++) {
      const req = pedidoHttp({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/arquivos?destino=produto_foto',
        headers: {
          ...bearer(admin),
          'Content-Type': 'multipart/form-data; boundary=xyz',
          'Content-Length': String(500_000),
        },
      });
      req.on('error', () => undefined);
      req.on('response', (r) => respostas.push(r.statusCode ?? 0));
      req.write(CABECALHO_PARTE);
      req.write(png);
      abertos.push(req);
      await esperar(400);
    }
    let status = 0;
    for (let i = 0; i < 20 && status !== 429 && !respostas.length; i++) {
      status = (await enviar(admin, 'destino=produto_foto', png)).status;
      if (status !== 429) await esperar(200);
    }
    expect(respostas).toEqual([]);
    expect(status).toBe(429);
    for (const r of abertos) r.destroy();
    let depois = 0;
    for (let i = 0; i < 50 && depois !== 201; i++) {
      depois = (await enviar(admin, 'destino=produto_foto', png)).status;
      if (depois !== 201) await esperar(100);
    }
    expect(depois).toBe(201);
  });

  it('envios lentos de dois usuários não seguram as vagas do processo: o de outra empresa passa na hora', async () => {
    // As 4 vagas de `ARQUIVOS_ENVIOS_SIMULTANEOS` com 2 envios lentos de cada usuário (cada um no limite dele): a
    // vaga só é pega com o corpo lido, então o envio da outra empresa não fica na fila atrás deles.
    await criarUsuario(emp.nomeBanco, { login: 'admin2', master: true });
    const admin2 = await amb.entrar(emp.codigo, 'admin2', SENHA_TESTE);
    const png = await imagemTeste(30, 30, 'png');
    const lentos = [];
    for (const token of [admin, admin, admin2, admin2]) {
      lentos.push(envioIncompleto(token, 'destino=produto_foto', 500_000, [CABECALHO_PARTE, png], 60_000));
      await esperar(200);
    }
    try {
      const inicio = Date.now();
      const r = await enviar(adminOutra, 'destino=produto_foto', png).timeout(10_000);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(Date.now() - inicio).toBeLessThan(5_000);
    } finally {
      for (const e of lentos) e.fechar();
    }
  });

  it('o envio sem Content-Length (em pedaços) é recusado antes de ler', async () => {
    const { port } = amb.app!.getHttpServer().address() as AddressInfo;
    const status = await new Promise<number>((ok, falha) => {
      const req = pedidoHttp(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/arquivos?destino=produto_foto',
          headers: {
            ...bearer(admin),
            'Content-Type': 'multipart/form-data; boundary=xyz',
            'Transfer-Encoding': 'chunked',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => ok(res.statusCode ?? 0));
        },
      );
      req.on('error', falha);
      req.write('--xyz\r\nContent-Disposition: form-data; name="arquivo"; filename="a.png"\r\n\r\n');
      req.end('abc\r\n--xyz--\r\n');
    });
    expect(status).toBe(422);
  });

  it('a bomba de descompressão (50.000 × 50.000 em poucos KB) é recusada pelo cabeçalho (422)', async () => {
    const bomba = pngBomba();
    expect(bomba.length).toBeLessThan(2 * 1024 * 1024);
    const antes = process.memoryUsage().rss;
    const r = await enviar(admin, 'destino=produto_foto', bomba);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.mensagem).toContain('50000 × 50000');
    expect(r.body.mensagem).toContain('36 megapixels');
    // 2,5 bilhões de pixels decodificados seriam 2,5 GB: nada disso foi alocado.
    expect(process.memoryUsage().rss - antes).toBeLessThan(200 * 1024 * 1024);
  });

  it('a permissão do destino é conferida antes de ler o corpo (403); destino e loja inválidos (422/404)', async () => {
    const png = await imagemTeste(50, 50, 'png');
    const r = await enviar(vendedor, 'destino=produto_foto', png);
    expect(r.status).toBe(403);
    expect((await enviar(vendedor, 'destino=loja_foto&lojaId=' + ids.loja1, png)).status).toBe(403);
    expect((await enviar(admin, 'destino=qualquer', png)).status).toBe(422);
    expect((await enviar(admin, 'destino=loja_foto', png)).status).toBe(422);
    expect((await enviar(admin, `destino=produto_foto&lojaId=${ids.loja1}`, png)).status).toBe(422);
    // A loja que o gerente não vê, e a que não existe: 404.
    expect((await enviar(gerenteLoja2, `destino=loja_foto&lojaId=${ids.loja1}`, png)).status).toBe(404);
    expect(
      (await enviar(admin, 'destino=loja_foto&lojaId=01a18792-00de-7acc-9165-e21098543881', png)).status,
    ).toBe(404);
    // Campo de texto extra no multipart, ou dois arquivos: 422.
    const extra = await amb
      .http()
      .post('/api/arquivos?destino=produto_foto')
      .set(bearer(admin))
      .field('categoria', 'xml_nfce')
      .attach('arquivo', png, 'a.png');
    expect(extra.status).toBe(422);
  });

  it('o nome do cliente não entra no caminho (path traversal), só no nome_original sem as pastas', async () => {
    const png = await imagemTeste(40, 40, 'png');
    for (const nome of ['../../../etc/passwd.png', '..\\..\\windows\\passwd.png']) {
      const r = await enviar(admin, 'destino=produto_foto', png, nome);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const l = await linhaArquivo(r.body.id);
      expect(l.nome_original).toBe('passwd.png');
      expect(l.chave_armazenamento).not.toContain('passwd');
      expect(l.chave_armazenamento).not.toContain('..');
    }
  });
});

describe('quem vê o arquivo', () => {
  it('o arquivo de outra empresa é 404 (metadados e conteúdo), e a outra empresa não vê o daqui', async () => {
    const png = await imagemTeste(60, 60, 'png');
    const daOutra = await enviar(adminOutra, 'destino=produto_foto', png);
    expect(daOutra.status).toBe(201);
    expect((await amb.http().get(`/api/arquivos/${daOutra.body.id}`).set(bearer(admin))).status).toBe(404);
    expect(
      (await amb.http().get(`/api/arquivos/${daOutra.body.id}/conteudo`).set(bearer(admin))).status,
    ).toBe(404);
    const daqui = await enviar(admin, 'destino=produto_foto', png);
    expect((await amb.http().get(`/api/arquivos/${daqui.body.id}`).set(bearer(adminOutra))).status).toBe(404);
    expect((await amb.http().get(`/api/arquivos/${daqui.body.id}`).set(bearer(admin))).status).toBe(200);
  });

  it('só quem vê o cadastro dono vê o arquivo; o da loja só com a loja; as outras categorias são 404', async () => {
    const png = await imagemTeste(60, 60, 'png');
    const produto = await enviar(admin, 'destino=produto_foto', png);
    const categoria = await enviar(admin, 'destino=categoria_imagem', png);
    const loja1 = await enviar(admin, `destino=loja_foto&lojaId=${ids.loja1}`, png);
    expect([produto.status, categoria.status, loja1.status]).toEqual([201, 201, 201]);
    // O vendedor vê produtos, mas não categorias nem lojas.
    expect((await amb.http().get(`/api/arquivos/${produto.body.id}`).set(bearer(vendedor))).status).toBe(200);
    expect((await amb.http().get(`/api/arquivos/${categoria.body.id}`).set(bearer(vendedor))).status).toBe(
      404,
    );
    expect((await amb.http().get(`/api/arquivos/${loja1.body.id}`).set(bearer(vendedor))).status).toBe(404);
    // O gerente da Loja 2 não vê o arquivo da Loja 1.
    expect((await amb.http().get(`/api/arquivos/${loja1.body.id}`).set(bearer(gerenteLoja2))).status).toBe(
      404,
    );
    // Uma planilha da importação (outra categoria): não sai por aqui.
    const [planilha] = await consultar<{ id: string }>(
      emp.nomeBanco,
      `insert into arquivos (chave_armazenamento, nome_original, tipo_mime, tamanho_bytes, sha256, categoria)
       values ('emp/1/importacao/x.xlsx', 'x.xlsx', 'text/html', 1, repeat('0', 64), 'planilha_importacao')
       returning id`,
    );
    expect((await amb.http().get(`/api/arquivos/${planilha!.id}/conteudo`).set(bearer(admin))).status).toBe(
      404,
    );
    expect((await amb.http().get('/api/arquivos/nao-e-uuid').set(bearer(admin))).status).toBe(404);
    expect(
      (await amb.http().get(`/api/arquivos/${produto.body.id}/conteudo?variante=outra`).set(bearer(admin)))
        .status,
    ).toBe(422);
  });
});

describe('Anexos da loja (ERP 10.3.4)', () => {
  const lojaAtual = async (token: string, id: string) => {
    const r = await amb.http().get(`/api/lojas/${id}`).set(bearer(token));
    expect(r.status).toBe(200);
    return r.body as Record<string, unknown>;
  };

  it('o logotipo e a foto enviados ficam no cadastro da loja, ligados a ela', async () => {
    const logo = await enviar(
      admin,
      `destino=loja_logotipo&lojaId=${ids.loja1}`,
      await imagemTeste(300, 100),
    );
    const foto = await enviar(
      admin,
      `destino=loja_foto&lojaId=${ids.loja1}`,
      await imagemTeste(640, 480, 'jpeg'),
    );
    expect([logo.status, foto.status]).toEqual([201, 201]);
    expect(logo.body).toMatchObject({ categoria: 'logotipo', entidade: 'lojas', lojaId: ids.loja1 });
    const atual = await lojaAtual(admin, ids.loja1!);
    const r = await amb
      .http()
      .put(`/api/lojas/${ids.loja1}`)
      .set(bearer(admin))
      .send({ ...atual, logotipoArquivoId: logo.body.id, fotoArquivoId: foto.body.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ logotipoArquivoId: logo.body.id, fotoArquivoId: foto.body.id });
    expect((await linhaArquivo(logo.body.id)).registro_id).toBe(ids.loja1);
    // O corpo sem os anexos (o ERP de antes do F2-B43) não apaga nada; `null` tira.
    const { logotipoArquivoId: _l, fotoArquivoId: _f, ...semAnexos } = await lojaAtual(admin, ids.loja1!);
    const r2 = await amb.http().put(`/api/lojas/${ids.loja1}`).set(bearer(admin)).send(semAnexos);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.logotipoArquivoId).toBe(logo.body.id);
    const r3 = await amb
      .http()
      .put(`/api/lojas/${ids.loja1}`)
      .set(bearer(admin))
      .send({ ...(await lojaAtual(admin, ids.loja1!)), fotoArquivoId: null });
    expect(r3.status).toBe(200);
    expect(r3.body).toMatchObject({ logotipoArquivoId: logo.body.id, fotoArquivoId: null });
  });

  it('recusa o arquivo de outra categoria, de outra loja ou inexistente (422)', async () => {
    const png = await imagemTeste(50, 50);
    const produto = await enviar(admin, 'destino=produto_foto', png);
    const daLoja2 = await enviar(admin, `destino=loja_logotipo&lojaId=${ids.loja2}`, png);
    const foto = await enviar(admin, `destino=loja_foto&lojaId=${ids.loja1}`, png);
    for (const [campo, valor] of [
      ['logotipoArquivoId', produto.body.id],
      ['logotipoArquivoId', daLoja2.body.id],
      ['logotipoArquivoId', foto.body.id],
      ['fotoArquivoId', '01a18792-00de-7acc-9165-e21098543881'],
    ] as const) {
      const r = await amb
        .http()
        .put(`/api/lojas/${ids.loja1}`)
        .set(bearer(admin))
        .send({ ...(await lojaAtual(admin, ids.loja1!)), [campo]: valor });
      expect(r.status, `${campo} ${JSON.stringify(r.body)}`).toBe(422);
      expect(r.body.campos?.[campo]).toBeDefined();
    }
  });
});

/** O GC duas vezes, com uma volta do laço entre elas: os `Buffer` liberados saem do `external` só no segundo. */
async function coletar(gc: () => void) {
  gc();
  await esperar(50);
  gc();
}

describe('memória', () => {
  it('20 envios seguidos não fazem a memória crescer sem parar', async () => {
    // O `--expose-gc` vem do `vitest.integracao.config.ts`: sem ele a medição incluiria o lixo não coletado e não
    // provaria nada, então o teste exige o GC em vez de seguir sem ele.
    const gc = globalThis.gc;
    expect(gc, 'rode pelo vitest.integracao.config.ts (execArgv --expose-gc)').toBeTypeOf('function');
    // Ruído (não comprime): ~1,1 MB por envio, para que guardar o buffer de cada envio estoure o limite abaixo.
    const foto = await sharp(randomBytes(1600 * 1200 * 3), {
      raw: { width: 1600, height: 1200, channels: 3 },
    })
      .jpeg({ quality: 75 })
      .toBuffer();
    expect(foto.length).toBeGreaterThan(900 * 1024);
    for (let i = 0; i < 3; i++) expect((await enviar(admin, 'destino=produto_foto', foto)).status).toBe(201);
    await coletar(gc!);
    const antes = process.memoryUsage();
    const s3Antes = bytesNoS3();
    for (let i = 0; i < 20; i++) expect((await enviar(admin, 'destino=produto_foto', foto)).status).toBe(201);
    await coletar(gc!);
    const depois = process.memoryUsage();
    // O S3 em memória (o do teste, no mesmo processo) guarda os 20 originais e as variantes, fora do heap do V8 (os
    // `Buffer` contam em `external`/`arrayBuffers`): só ali se desconta o que ele guardou, pelo tamanho exato.
    const guardados = bytesNoS3() - s3Antes;
    const MB = 1024 * 1024;
    // Um vazamento de um envio por vez (o buffer de ~1,1 MB × 20 = 22 MB) passa de qualquer um destes limites.
    expect(depois.heapUsed - antes.heapUsed).toBeLessThan(10 * MB);
    expect(depois.arrayBuffers - antes.arrayBuffers - guardados).toBeLessThan(10 * MB);
    expect(depois.external - antes.external - guardados).toBeLessThan(10 * MB);
    expect(depois.rss - antes.rss - guardados).toBeLessThan(40 * MB);
    // O cache de operações do libvips (memória nativa, só no rss) fica desligado: `sharp.cache(false)`.
    const cache = sharp.cache();
    expect(cache.memory).toMatchObject({ current: 0, max: 0 });
    expect(cache.items.current).toBe(0);
  }, 90_000);

  it('envios ao mesmo tempo decodificam uma imagem por vez (o semáforo de imagens.ts)', async () => {
    const foto = await imagemTeste(1600, 1200, 'jpeg');
    await criarUsuario(emp.nomeBanco, { login: 'admin3', master: true });
    const admin3 = await amb.entrar(emp.codigo, 'admin3', SENHA_TESTE);
    // `sharp.counters().process`: as tarefas do libvips rodando agora (a amostra a cada 1 ms pega a sobreposição).
    let pico = 0;
    const amostra = setInterval(() => (pico = Math.max(pico, sharp.counters().process)), 1);
    try {
      const rs = await Promise.all(
        [admin, admin, admin3, admin3].map((t) => enviar(t, 'destino=produto_foto', foto)),
      );
      for (const r of rs) expect(r.status, JSON.stringify(r.body)).toBe(201);
    } finally {
      clearInterval(amostra);
    }
    expect(pico).toBeGreaterThanOrEqual(1);
    expect(pico).toBe(1);
  }, 60_000);
});
