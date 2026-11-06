import { describe, expect, it } from 'vitest';
import {
  alterarDestinoNotaEntradaSchema,
  conferirTotaisNfe,
  custoEntradaItemNfeTexto,
  estornarNotaEntradaSchema,
  fatorPelasQuantidadesNfe,
  movimentarNotaEntradaSchema,
  partesLoteRastroNfe,
  itemResolvidoNfe,
  quantidadeEstoqueNfeTexto,
  vincularItensNfeSchema,
  filtroNotasEntradaSchema,
  ignorarNotaEntradaSchema,
  LIMITES_UPLOAD_NFE,
  MENSAGEM_ENVIO_GRANDE_NFE,
  mensagemRecusaImportacaoNfe,
  MOTIVOS_RECUSA_ARQUIVO_NFE,
  TETO_UPLOAD_NFE_TEXTO,
  opcoesImportacaoNfeSchema,
  resumirImportacaoNfe,
  type ResultadoArquivoNfe,
  MOTIVOS_RECUSA_NFE,
  STATUS_NOTA_ENTRADA,
  ROTULOS_STATUS_NOTA_ENTRADA,
  totaisCalculadosNfe,
  type ItemNfeLido,
  type TotaisNfeLidos,
} from './notas-entrada.js';

const ZERO = '0.00';
const totais = (t: Partial<TotaisNfeLidos>): TotaisNfeLidos => ({
  produtos: ZERO,
  frete: ZERO,
  seguro: ZERO,
  desconto: ZERO,
  outras: ZERO,
  ipi: ZERO,
  ipiDevolvido: ZERO,
  ii: ZERO,
  icmsBase: ZERO,
  icms: ZERO,
  icmsDesonerado: ZERO,
  icmsStBase: ZERO,
  icmsSt: ZERO,
  fcpSt: ZERO,
  fcpStRetido: ZERO,
  pis: ZERO,
  cofins: ZERO,
  servicos: ZERO,
  total: ZERO,
  ...t,
});
const item = (i: Partial<ItemNfeLido> & { st?: string; fcp?: string }): ItemNfeLido =>
  ({
    valorProduto: ZERO,
    valorFrete: ZERO,
    valorSeguro: ZERO,
    valorDesconto: ZERO,
    valorOutros: ZERO,
    valorIpi: ZERO,
    compoeTotal: true,
    ...i,
    icms: { stValor: i.st ?? ZERO, fcpStValor: i.fcp ?? ZERO },
  }) as ItemNfeLido;

describe('totais da NF-e (F2-B18)', () => {
  it('vNF pela regra da SEFAZ, com e sem a dedução do ICMS desonerado', () => {
    const t = totais({
      produtos: '1000.00',
      desconto: '10.00',
      icmsSt: '120.50',
      fcpSt: '20.10',
      frete: '30.00',
      seguro: '5.00',
      outras: '2.00',
      ipi: '39.00',
      icmsDesonerado: '7.00',
    });
    expect(totaisCalculadosNfe(t)).toEqual({ comDesonerado: '1199.60', semDesonerado: '1206.60' });
  });

  it('confere a soma dos itens (só os que compõem o total no vProd) e o vNF', () => {
    const itens = [
      item({ valorProduto: '100.00', valorFrete: '5.00', st: '12.00', fcp: '2.00' }),
      item({ valorProduto: '50.00', valorDesconto: '1.00', valorIpi: '3.90' }),
      item({ valorProduto: '9.99', compoeTotal: false }),
    ];
    const t = totais({
      produtos: '150.00',
      frete: '5.00',
      desconto: '1.00',
      ipi: '3.90',
      icmsSt: '12.00',
      fcpSt: '2.00',
      total: '171.90',
    });
    expect(conferirTotaisNfe({ itens, totais: t })).toEqual([]);
    expect(conferirTotaisNfe({ itens, totais: { ...t, frete: '6.00', total: '172.91' } })).toEqual([
      'vFrete: nota 6.00, itens 5.00',
      'vNF: nota 172.91, calculado 172.90',
    ]);
  });

  it('situações e motivos com rótulo e mensagem', () => {
    for (const s of STATUS_NOTA_ENTRADA) expect(ROTULOS_STATUS_NOTA_ENTRADA[s]).toBeTruthy();
    expect(MOTIVOS_RECUSA_NFE.MODELO_NAO_ACEITO).toContain('NFC-e');
  });
});

describe('upload e ações da NF-e (F2-B19)', () => {
  it('mensagem de qualquer motivo de recusa (do XML ou do arquivo/acesso)', () => {
    expect(mensagemRecusaImportacaoNfe('MODELO_NAO_ACEITO')).toBe(MOTIVOS_RECUSA_NFE.MODELO_NAO_ACEITO);
    expect(mensagemRecusaImportacaoNfe('ESTOQUE_NAO_PERMITIDO')).toBe(
      MOTIVOS_RECUSA_ARQUIVO_NFE.ESTOQUE_NAO_PERMITIDO,
    );
    // Os dois catálogos não repetem motivo (o resultado diria duas coisas).
    for (const m of Object.keys(MOTIVOS_RECUSA_ARQUIVO_NFE)) expect(m in MOTIVOS_RECUSA_NFE).toBe(false);
  });

  it('o texto do teto do envio sai do LIMITES_UPLOAD_NFE (a tela e a API dizem o mesmo)', () => {
    expect(TETO_UPLOAD_NFE_TEXTO).toBe(`${LIMITES_UPLOAD_NFE.bytes / 1024 / 1024} MB`);
    expect(MENSAGEM_ENVIO_GRANDE_NFE).toBe('O envio passa de 20 MB: divida os arquivos.');
  });

  it('resumo por situação', () => {
    const r = (situacao: ResultadoArquivoNfe['situacao']) => ({ situacao }) as ResultadoArquivoNfe;
    expect(resumirImportacaoNfe([r('importada'), r('duplicada'), r('importada'), r('recusada')])).toEqual({
      importadas: 2,
      duplicadas: 1,
      recusadas: 1,
    });
  });

  it('opções do upload: vazio = o estoque da loja e o tipo padrão', () => {
    expect(opcoesImportacaoNfeSchema.parse({ estoqueId: '', tipoEstoqueId: undefined })).toEqual({
      estoqueId: null,
      tipoEstoqueId: null,
    });
    expect(opcoesImportacaoNfeSchema.safeParse({ estoqueId: 'x' }).success).toBe(false);
  });

  it('filtro: número/chave sem espaços e em maiúsculas, período pela emissão por padrão', () => {
    const f = filtroNotasEntradaSchema.parse({ numeroChave: ' 3526 1099 ab ' });
    expect(f.numeroChave).toBe('35261099AB');
    expect(f.periodo).toBe('emissao');
    expect(filtroNotasEntradaSchema.safeParse({ dataInicial: '2026-02-30' }).success).toBe(false);
    expect(filtroNotasEntradaSchema.safeParse({ numeroChave: '1'.repeat(45) }).success).toBe(false);
  });

  it('"Ignorar" exige o motivo; o destino exige a loja e a versão', () => {
    expect(ignorarNotaEntradaSchema.safeParse({ motivo: '  ' }).success).toBe(false);
    expect(ignorarNotaEntradaSchema.parse({ motivo: ' brinde ' }).motivo).toBe('brinde');
    expect(alterarDestinoNotaEntradaSchema.safeParse({ lojaId: crypto.randomUUID() }).success).toBe(false);
    expect(
      alterarDestinoNotaEntradaSchema.parse({ versao: 3, lojaId: crypto.randomUUID(), estoqueId: '' })
        .estoqueId,
    ).toBeNull();
  });
});

describe('vinculação dos itens (F2-B20)', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const PRODUTO = '0190a000-0000-7000-8000-0000000000a2';

  it('fator pelas quantidades do XML: qTrib / qCom a 3 casas, nulo sem qTrib ou com zero', () => {
    expect(fatorPelasQuantidadesNfe('10.0000', '120.0000')).toBe('12.000');
    expect(fatorPelasQuantidadesNfe('3.5000', '42.3750')).toBe('12.107');
    expect(fatorPelasQuantidadesNfe('24.0000', '24.0000')).toBe('1.000');
    expect(fatorPelasQuantidadesNfe('10.0000', null)).toBeNull();
    expect(fatorPelasQuantidadesNfe('0.0000', '12.0000')).toBeNull();
    expect(fatorPelasQuantidadesNfe('100000.0000', '0.0001')).toBeNull();
  });

  it('quantidade no estoque = qCom × fator, a 3 casas', () => {
    expect(quantidadeEstoqueNfeTexto('10.0000', '12')).toBe('120.000');
    expect(quantidadeEstoqueNfeTexto('3.5000', '12.107')).toBe('42.375');
  });

  it('custo de entrada: as parcelas que as chaves ligam, por unidade do produto, nunca negativo', () => {
    const item = {
      valorProduto: '399.00',
      valorFrete: '15.00',
      valorSeguro: '1.00',
      valorOutros: '2.00',
      valorDesconto: '5.00',
      valorIpi: '10.00',
      valorIcmsSt: '57.60',
      valorFcpSt: '3.40',
    };
    const todas = { incluiSt: true, incluiIpi: true, incluiFrete: true };
    // (399 + 15 + 1 + 2 − 5 + 10 + 57,60 + 3,40) / 120 = 483 / 120.
    expect(custoEntradaItemNfeTexto(item, '120', todas)).toBe('4.0250');
    // Sem ST, sem IPI e sem frete e despesas: (399 − 5) / 120 (a chave do frete tira também o seguro e as outras).
    expect(
      custoEntradaItemNfeTexto(item, '120', { incluiSt: false, incluiIpi: false, incluiFrete: false }),
    ).toBe('3.2833');
    // Só a chave do frete e despesas desligada: (399 − 5 + 10 + 57,60 + 3,40) / 120.
    expect(custoEntradaItemNfeTexto(item, '120', { ...todas, incluiFrete: false })).toBe('3.8750');
    // O exemplo da revisão: vProd 100, vSeg 5 e vOutro 10 em 10 unidades dá 10,0000 com a chave desligada.
    const despesas = {
      ...item,
      valorProduto: '100.00',
      valorFrete: '0.00',
      valorSeguro: '5.00',
      valorOutros: '10.00',
    };
    const semNada = {
      ...despesas,
      valorDesconto: '0.00',
      valorIpi: '0.00',
      valorIcmsSt: '0.00',
      valorFcpSt: '0.00',
    };
    expect(custoEntradaItemNfeTexto(semNada, '10', { ...todas, incluiFrete: false })).toBe('10.0000');
    expect(custoEntradaItemNfeTexto(semNada, '10', todas)).toBe('11.5000');
    expect(custoEntradaItemNfeTexto({ ...item, valorDesconto: '9999.00' }, '120', todas)).toBe('0.0000');
    expect(custoEntradaItemNfeTexto(item, '0', todas)).toBe('0.0000');
  });

  it('o item resolvido (a contagem do detalhe): ignorado, ou vinculado com o fator confirmado', () => {
    const vinculado = { ignorado: false, produtoId: PRODUTO, fatorConfirmado: true };
    expect(itemResolvidoNfe(vinculado)).toBe(true);
    expect(itemResolvidoNfe({ ignorado: true, produtoId: null, fatorConfirmado: false })).toBe(true);
    expect(itemResolvidoNfe({ ...vinculado, fatorConfirmado: false })).toBe(false);
    expect(itemResolvidoNfe({ ignorado: false, produtoId: null, fatorConfirmado: false })).toBe(false);
  });

  it('o contrato do PUT: motivo do ignorado, produto para confirmar, preço a atualizar, lote e item repetido', () => {
    const r = vincularItensNfeSchema.safeParse({
      versao: 1,
      itens: [
        { id: ID, ignorado: true },
        { id: ID, fatorConfirmado: true },
      ],
    });
    expect(r.success).toBe(false);
    const caminhos = r.error!.issues.map((i) => i.path.join('.'));
    expect(caminhos).toEqual(['itens.0.motivoIgnorado', 'itens.1.id', 'itens.1.fator', 'itens.1.produtoId']);
    const ok = vincularItensNfeSchema.parse({
      versao: 1,
      itens: [{ id: ID, produtoId: PRODUTO, fator: '12,5', fatorConfirmado: true }],
    });
    expect(ok.itens[0]).toMatchObject({
      fator: '12.500',
      codigoBarrasId: null,
      atualizarPreco: 'nao',
      lote: null,
    });
    // O fator apagado não vira 1 confirmado (10 CX entrariam como 10 UN): só o item por confirmar fica com 1.
    for (const fator of ['', '  ', null, undefined]) {
      const vazio = vincularItensNfeSchema.safeParse({
        versao: 1,
        itens: [{ id: ID, produtoId: PRODUTO, fator, fatorConfirmado: true }],
      });
      expect(vazio.success).toBe(false);
      expect(vazio.error!.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
        ['itens.0.fator', 'Informe o fator'],
      ]);
    }
    const porConfirmar = vincularItensNfeSchema.parse({
      versao: 1,
      itens: [
        { id: ID, produtoId: PRODUTO, fator: '' },
        { id: PRODUTO, ignorado: true, motivoIgnorado: 'Brinde', fatorConfirmado: true },
      ],
    });
    expect(porConfirmar.itens.map((i) => [i.fator, i.fatorConfirmado])).toEqual([
      ['1.000', false],
      ['1.000', true],
    ]);
    const erros = vincularItensNfeSchema.safeParse({
      versao: 1,
      itens: [
        {
          id: ID,
          produtoId: PRODUTO,
          fator: '0',
          atualizarPreco: 'geral',
          validade: '2026-12-01',
          fabricacao: '2026-12-31',
        },
      ],
    });
    expect(erros.error!.issues.map((i) => i.path.join('.'))).toEqual([
      'itens.0.fator',
      'itens.0.precoVenda',
      'itens.0.lote',
      'itens.0.fabricacao',
    ]);
  });
});

describe('movimentar e estornar a NF-e (F2-B21)', () => {
  const rastro = [
    {
      lote: 'L2610A',
      quantidade: '72.000',
      fabricacao: '2026-10-10',
      validade: '2026-11-25',
      codigoAgregacao: null,
    },
    {
      lote: 'L2612B',
      quantidade: '48.000',
      fabricacao: '2026-10-12',
      validade: '2026-11-27',
      codigoAgregacao: null,
    },
  ];
  const item = { lote: 'L2610A', validade: '2026-11-25', fabricacao: '2026-10-10', rastro };

  it('divide o item pelos lotes do rastro na proporção do qLote, com o resíduo na maior parte', () => {
    // 20 FD × 6 = 120: 72 e 48 (o qLote em unidades); a mesma proporção com o qLote em fardos (12 e 8).
    expect(partesLoteRastroNfe(item, '120')).toEqual([
      { lote: 'L2610A', quantidade: '72.000', validade: '2026-11-25', fabricacao: '2026-10-10' },
      { lote: 'L2612B', quantidade: '48.000', validade: '2026-11-27', fabricacao: '2026-10-12' },
    ]);
    const emFardos = rastro.map((r, i) => ({ ...r, quantidade: i === 0 ? '12.000' : '8.000' }));
    expect(partesLoteRastroNfe({ ...item, rastro: emFardos }, '120')!.map((p) => p.quantidade)).toEqual([
      '72.000',
      '48.000',
    ]);
    // Três lotes iguais em 10: 3,334 (o resíduo na primeira, a maior no empate) + 3,333 + 3,333 fecham 10.
    const tres = ['A', 'B', 'C'].map((lote) => ({ ...rastro[0]!, lote, quantidade: '1.000' }));
    const p = partesLoteRastroNfe({ ...item, lote: 'A', rastro: tres }, '10')!;
    expect(p.map((x) => x.quantidade)).toEqual(['3.334', '3.333', '3.333']);
    // A primeira parte leva as datas da vinculação (corrigidas pelo usuário); as outras, as do rastro.
    expect(
      partesLoteRastroNfe({ ...item, validade: '2026-11-30', fabricacao: null }, '120')![0],
    ).toMatchObject({
      validade: '2026-11-30',
      fabricacao: null,
    });
  });

  it('não divide: lote trocado, um lote só (ou repetido), sem lote, qLote zero', () => {
    expect(partesLoteRastroNfe({ ...item, lote: 'OUTRO' }, '120')).toBeNull();
    expect(partesLoteRastroNfe({ ...item, lote: null }, '120')).toBeNull();
    expect(partesLoteRastroNfe({ ...item, rastro: [rastro[0]!] }, '120')).toBeNull();
    expect(partesLoteRastroNfe({ ...item, rastro: [rastro[0]!, rastro[0]!] }, '120')).toBeNull();
    expect(
      partesLoteRastroNfe({ ...item, rastro: [rastro[0]!, { ...rastro[1]!, quantidade: '0.000' }] }, '120'),
    ).toBeNull();
    expect(partesLoteRastroNfe(item, '0')).toBeNull();
  });

  it('o mesmo lote repetido soma numa parte; a fabricação depois da validade fica nula', () => {
    const r = [
      rastro[0]!,
      { ...rastro[1]!, fabricacao: '2026-12-01' },
      { ...rastro[0]!, quantidade: '24.000' },
    ];
    expect(partesLoteRastroNfe({ ...item, rastro: r }, '144')).toEqual([
      { lote: 'L2610A', quantidade: '96.000', validade: '2026-11-25', fabricacao: '2026-10-10' },
      { lote: 'L2612B', quantidade: '48.000', validade: '2026-11-27', fabricacao: null },
    ]);
  });

  it('contratos: a resposta do preço de custo e o estorno com motivo e a lista confirmada', () => {
    expect(movimentarNotaEntradaSchema.parse({})).toEqual({ atualizarPrecoCusto: null });
    expect(movimentarNotaEntradaSchema.parse({ versao: 3, atualizarPrecoCusto: true })).toEqual({
      versao: 3,
      atualizarPrecoCusto: true,
    });
    expect(estornarNotaEntradaSchema.safeParse({ motivo: ' ' }).success).toBe(false);
    expect(estornarNotaEntradaSchema.parse({ motivo: 'Devolvida' })).toEqual({
      motivo: 'Devolvida',
      confirmarNegativo: [],
    });
    expect(
      estornarNotaEntradaSchema.safeParse({ motivo: 'Devolvida', confirmarNegativo: true }).success,
    ).toBe(false);
  });
});
