/**
 * Leitura da tabela NCM do Siscomex, a diferença com a empresa e o download (F2-B46, decisão 193). Os arquivos são
 * **inventados** e montados aqui (capítulo 77, que a Nomenclatura reserva e não usa): o repositório é público e a
 * tabela real não entra nele.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  baixarTabelaNcm,
  diferencaNcm,
  ErroTabelaNcm,
  interpretarTabelaNcm,
  LIMITE_BYTES_TABELA_NCM,
  vespera,
} from './ncm-atualizacao.js';

interface Item {
  Codigo: string;
  Descricao: string;
  Data_Inicio?: string;
  Data_Fim?: string;
}

const item = (Codigo: string, Descricao: string, extra: Partial<Item> = {}): Item => ({
  Codigo,
  Descricao,
  Data_Inicio: '01/04/2022',
  Data_Fim: '31/12/9999',
  ...extra,
});

/** Tabela inventada no formato do download (`Data_Ultima_Atualizacao_NCM`, `Ato`, `Nomenclaturas`). */
function tabelaInventada(itens: unknown[] = ITENS, cabecalho: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      Data_Ultima_Atualizacao_NCM: 'Vigente em 12/11/2026',
      Ato: 'Resolução Inventada nº 1/2026',
      Nomenclaturas: itens,
      ...cabecalho,
    }),
  );
}

const ITENS: Item[] = [
  item('77', 'Capítulo inventado de teste.'),
  item('77.01', 'Engenhocas inventadas; de teste.'),
  item('7701.1', '- De peso não superior a 10\u00a0kg:'),
  item('7701.11.00', '-- Com <i>manivela</i> &amp; mola'),
  item('7701.19.00', '-- Outras'),
  item('7701.90', '- Outras'),
  item('7701.90.10', 'Engenhocas de bolso'),
  item('7701.90.90', 'Outras'),
  item('77.02', 'Geringonças inventadas.'),
  item('7702.10.00', '- Geringonças a vapor'),
  item('7702.20.00', '- Geringonças antigas', { Data_Inicio: '01/01/2020', Data_Fim: '31/12/2025' }),
  item('7702.90.00', '- Outras'),
];

const ler = (b: Buffer) => interpretarTabelaNcm(b, { minimoNcms: 1 });

describe('interpretarTabelaNcm (F2-B46)', () => {
  it('monta a descrição como o ncms.csv, com as datas em ISO', () => {
    const t = ler(tabelaInventada());
    expect(t).toMatchObject({ vigenteEm: '2026-11-12', ato: 'Resolução Inventada nº 1/2026' });
    expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
    const pos = 'Engenhocas inventadas, de teste.';
    expect(t.ncms).toEqual([
      {
        codigo: '77011100',
        descricao: `${pos} - De peso não superior a 10\u00a0kg - Com manivela & mola`,
        inicio: '2022-04-01',
        fim: null,
      },
      {
        codigo: '77011900',
        descricao: `${pos} - De peso não superior a 10\u00a0kg - Outras`,
        inicio: '2022-04-01',
        fim: null,
      },
      {
        codigo: '77019010',
        descricao: `${pos} - Outras - Engenhocas de bolso`,
        inicio: '2022-04-01',
        fim: null,
      },
      // O item que só repete a subposição ("- Outras" / "Outras") entra uma vez.
      { codigo: '77019090', descricao: `${pos} - Outras`, inicio: '2022-04-01', fim: null },
      { codigo: '77021000', descricao: 'Geringonças a vapor', inicio: '2022-04-01', fim: null },
      { codigo: '77022000', descricao: 'Geringonças antigas', inicio: '2020-01-01', fim: '2025-12-31' },
      { codigo: '77029000', descricao: 'Geringonças inventadas. - Outras', inicio: '2022-04-01', fim: null },
    ]);
  });

  it('aceita o BOM e os campos a mais; o Ato é opcional', () => {
    const corpo = tabelaInventada(
      ITENS.map((i) => ({ ...i, Tipo_Ato_Ini: 'Res Inventada' })),
      { Ato: undefined },
    );
    const t = ler(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), corpo]));
    expect(t.ato).toBeNull();
    expect(t.ncms).toHaveLength(7);
  });

  it.each([
    ['UTF-8 inválido', Buffer.from([0x7b, 0xff, 0x7d]), /UTF-8/],
    ['não é JSON', Buffer.from('<html>fora do ar</html>'), /não é um JSON/],
    ['raiz em lista', Buffer.from('[]'), /objeto da tabela/],
    ['sem a lista', tabelaInventada(undefined, { Nomenclaturas: undefined }), /Nomenclaturas/],
    ['lista grande demais', tabelaInventada(new Array(100_001).fill(0)), /mais de 100000 itens/],
    ['sem a data', tabelaInventada(undefined, { Data_Ultima_Atualizacao_NCM: 'Vigente' }), /data da tabela/],
    ['Ato que não é texto', tabelaInventada(undefined, { Ato: 7 }), /Ato/],
    ['item que não é objeto', tabelaInventada([...ITENS, 'x']), /não é um objeto/],
    ['campo renomeado', tabelaInventada([{ Cod: '7703.00.00', Descricao: 'X' }]), /Codigo/],
    ['código fora do formato', tabelaInventada([item('7703.0000', 'X')]), /Codigo fora do formato/],
    ['código repetido', tabelaInventada([...ITENS, item('7701.19.00', 'X')]), /repetido/],
    [
      'descrição que não é texto',
      tabelaInventada([{ ...item('7703.00.00', 'X'), Descricao: 1 }]),
      /Descricao/,
    ],
    ['descrição vazia', tabelaInventada([item('7703.00.00', '-- <b></b>')]), /vazia/],
    ['data em ISO', tabelaInventada([item('7703.00.00', 'X', { Data_Inicio: '2022-04-01' })]), /Data_Inicio/],
    [
      'data inexistente',
      tabelaInventada([item('7703.00.00', 'X', { Data_Fim: '31/02/2027' })]),
      /inexistente/,
    ],
    [
      'fim antes do início',
      tabelaInventada([item('7703.00.00', 'X', { Data_Inicio: '01/01/2026', Data_Fim: '31/12/2025' })]),
      /antes da Data_Inicio/,
    ],
  ])('formato alterado (%s): recusa com ErroTabelaNcm', (_, corpo, mensagem) => {
    expect(() => ler(corpo)).toThrow(ErroTabelaNcm);
    expect(() => ler(corpo)).toThrow(mensagem);
  });

  it('recusa a tabela com NCMs de menos (o mínimo padrão) e o arquivo acima do limite', () => {
    expect(() => interpretarTabelaNcm(tabelaInventada())).toThrow(/só 7 NCMs de 8 dígitos/);
    expect(() => interpretarTabelaNcm(new Uint8Array(LIMITE_BYTES_TABELA_NCM + 1))).toThrow(/mais de 32 MB/);
  });
});

describe('diferencaNcm', () => {
  const linha = (descricao: string, fim: string | null = null, excluido = false) => ({
    descricao,
    inicio: '2022-04-01',
    fim,
    excluido,
  });

  it('separa incluídos, alterados e encerrados, e os que deixam de ser vigentes', () => {
    const tabela = ler(tabelaInventada());
    const atuais = new Map([
      ['77011100', linha(tabela.ncms[0]!.descricao)], // igual
      ['77011900', linha('Descrição antiga')], // alterado
      ['77019010', linha(tabela.ncms[2]!.descricao, null, true)], // excluído que volta
      ['77019090', linha(tabela.ncms[3]!.descricao, '2024-01-01')], // encerrado antes que volta
      ['77022000', linha('Geringonças antigas')], // ganha o fim de vigência do arquivo
      ['77030000', linha('Sumiu do arquivo')], // encerrado
      ['77040000', linha('Já encerrado', '2025-06-30')], // saiu e já tinha terminado: fica
      ['77050000', linha('Excluído', null, true)], // saiu e estava excluído: fica
    ]);
    const d = diferencaNcm(atuais, tabela, '2026-11-12');
    expect(d).toEqual({
      incluidos: ['77019010', '77019090', '77021000', '77029000'],
      alterados: ['77011900', '77022000'],
      encerrados: ['77030000'],
      invalidados: ['77022000', '77030000'],
    });
    expect(vespera(tabela.vigenteEm)).toBe('2026-11-11');
    expect(vespera('2027-01-01')).toBe('2026-12-31');
  });
});

describe('baixarTabelaNcm (servidor HTTP falso)', () => {
  let servidor: Server;
  let base: string;

  beforeAll(async () => {
    servidor = createServer((req, res) => {
      const rota = req.url ?? '/';
      if (rota === '/ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(tabelaInventada());
      } else if (rota === '/erro') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{}');
      } else if (rota === '/html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html></html>');
      } else if (rota === '/grande-declarado') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(64 * 1024 * 1024),
        });
        res.end();
      } else if (rota === '/grande') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(Buffer.alloc(4096, 0x20));
        res.end(Buffer.alloc(4096, 0x20));
      } else if (rota === '/redireciona') {
        res.writeHead(307, { location: '/ok' });
        res.end();
      } else if (rota === '/lento') {
        // Não responde: o tempo limite corta.
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    servidor.closeAllConnections();
    await new Promise((ok) => servidor.close(ok));
  });

  it('baixa e lê a tabela', async () => {
    const t = ler(Buffer.from(await baixarTabelaNcm(`${base}/ok`)));
    expect(t.ncms).toHaveLength(7);
  });

  it.each([
    ['/erro', /respondeu 500/],
    ['/html', /não mandou JSON \(text\/html\)/],
    ['/grande-declarado', /mais de/],
    ['/redireciona', /não foi possível baixar/],
  ])('%s: recusa', async (rota, mensagem) => {
    await expect(baixarTabelaNcm(`${base}${rota}`)).rejects.toThrow(mensagem);
  });

  it('corta o download acima do limite e o que passa do tempo', async () => {
    await expect(baixarTabelaNcm(`${base}/grande`, { limiteBytes: 6000 })).rejects.toThrow(ErroTabelaNcm);
    await expect(baixarTabelaNcm(`${base}/lento`, { tempoLimiteMs: 200 })).rejects.toThrow(/tempo esgotado/);
  });

  it('recusa endereço que não é http(s)', async () => {
    await expect(baixarTabelaNcm('file:///etc/passwd')).rejects.toThrow(/http\(s\)/);
    await expect(baixarTabelaNcm('não é endereço')).rejects.toThrow(/inválido/);
  });
});
