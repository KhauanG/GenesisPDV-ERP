import { describe, expect, it } from 'vitest';
import {
  criarFormaPagamentoSchema,
  criarLojaSchema,
  criarPessoaSchema,
  decimal,
  gravarAtalhosSchema,
  listaEmailsOpcional,
  montarArvoreCategorias,
  normalizarTeclaAtalho,
  validarPin,
  type CategoriaNo,
} from './index.js';

describe('validarPin (SYNC 4.3)', () => {
  it('recusa sequências, repetições, tamanho e o código do usuário', () => {
    expect(validarPin('480297')).toBeNull();
    expect(validarPin('12345678')).toContain('sequências');
    expect(validarPin('987654')).toContain('sequências');
    expect(validarPin('890123')).toContain('sequências');
    expect(validarPin('000000')).toContain('repetidos');
    expect(validarPin('1234')).toContain('6 a 8');
    expect(validarPin('4802', { permitirCurto: true })).toBeNull();
    expect(validarPin('123456789')).toContain('6 a 8');
    expect(validarPin('48a297')).toContain('números');
    expect(validarPin('004812', { codigoUsuario: 4812 })).toContain('código');
  });
});

describe('normalizarTeclaAtalho (PDV 28.3)', () => {
  it('canoniza e recusa combinações proibidas', () => {
    expect(normalizarTeclaAtalho('f2')).toBe('F2');
    expect(normalizarTeclaAtalho('shift+ctrl+t')).toBe('Ctrl+Shift+T');
    expect(normalizarTeclaAtalho('Ctrl+espaco')).toBe('Ctrl+Espaço');
    expect(normalizarTeclaAtalho('Shift+F4')).toBe('Shift+F4');
    expect(normalizarTeclaAtalho('A')).toBeNull();
    expect(normalizarTeclaAtalho('Shift+A')).toBeNull();
    expect(normalizarTeclaAtalho('Alt+F4')).toBeNull();
    expect(normalizarTeclaAtalho('Ctrl+Ctrl+A')).toBeNull();
    expect(normalizarTeclaAtalho('Enter')).toBeNull();
  });

  it('gravarAtalhosSchema acusa a tecla repetida entre habilitados', () => {
    const r = gravarAtalhosSchema.safeParse({
      itens: [
        { acao: 'a_um', tecla: 'F2', habilitado: true, ordem: 1 },
        { acao: 'b_dois', tecla: 'f2', habilitado: true, ordem: 2 },
        { acao: 'c_tres', tecla: 'F2', habilitado: false, ordem: 3 },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join('.'))).toEqual(['itens.1.tecla']);
  });
});

describe('campos', () => {
  it('decimal aceita vírgula e milhar pt-BR, recusa vazio e fora da faixa', () => {
    const d = decimal({ min: 0, max: 100, casas: 2 });
    expect(d.parse('12,5')).toBe('12.50');
    expect(decimal({ casas: 2 }).parse('1.234,56')).toBe('1234.56');
    expect(d.safeParse('').success).toBe(false);
    expect(d.safeParse('101').success).toBe(false);
  });

  it('lista de e-mails do contador', () => {
    expect(listaEmailsOpcional.parse('A@b.com; c@d.com')).toBe('a@b.com, c@d.com');
    expect(listaEmailsOpcional.safeParse('a@b.com, x').success).toBe(false);
    expect(listaEmailsOpcional.parse('')).toBeNull();
  });
});

describe('schemas de cadastro', () => {
  it('pessoa: documento por tipo, endereço principal único, telefone num campo só', () => {
    const ok = criarPessoaSchema.parse({
      nome: 'Ana',
      cpfCnpj: '529.982.247-25',
      telefones: [{ numero: '(41) 3333-4444' }],
      enderecos: [{ tipo: 'principal', exterior: true, paisCodigo: '1058' }],
    });
    expect(ok.telefones[0]).toMatchObject({ ddd: '41', numero: '33334444' });
    const pj = criarPessoaSchema.safeParse({
      tipo: 'PJ',
      nome: 'Forn',
      categorias: ['fornecedor'],
      sexo: 'M',
    });
    expect(pj.error!.issues.map((i) => i.path.join('.')).sort()).toEqual(['cpfCnpj', 'sexo']);
  });

  it('forma de pagamento: regras do MD 3.10.1 por campo', () => {
    const r = criarFormaPagamentoSchema.safeParse({
      descricao: 'Avaria',
      tipoForma: 'consumo_interno',
      meioPagamentoFiscal: '01',
      permiteTroco: true,
      lancaQuitada: false,
    });
    expect(r.error!.issues.map((i) => i.path[0]).sort()).toEqual([
      'lancaQuitada',
      'meioPagamentoFiscal',
      'permiteTroco',
      'planoContasId',
    ]);
  });

  it('forma de pagamento (C8b, O23): troco só sem integração e fora de cartão/PIX; lojas sem repetição', () => {
    const base = { descricao: 'Forma', meioPagamentoFiscal: '01', permiteTroco: true };
    for (const errado of [
      { tipoForma: 'pix' },
      { tipoForma: 'cartao_debito' },
      { integracao: 'pos_externo' },
    ]) {
      const r = criarFormaPagamentoSchema.safeParse({ ...base, ...errado });
      expect(r.error!.issues.map((i) => i.path[0])).toEqual(['permiteTroco']);
    }
    const loja = '01928f3a-0000-7000-8000-0000000000a9';
    const ok = criarFormaPagamentoSchema.parse({ ...base, tipoForma: 'outros', lojaIds: [loja, loja] });
    expect(ok).toMatchObject({ permiteTroco: true, lojaIds: [loja], exigeSupervisor: false });
    expect(criarFormaPagamentoSchema.parse({ descricao: 'X', meioPagamentoFiscal: '01' }).lojaIds).toEqual(
      [],
    );
  });

  it('loja: depósito não usa PDV; NFC-e exige IE; loja de treino só não fiscal (O10)', () => {
    const base = {
      nome: 'CD',
      razaoSocial: 'CD Ltda',
      nomeFantasia: 'CD',
      cnpj: '11.222.333/0001-81',
      cep: '80010000',
      logradouro: 'Rua',
      numero: '1',
      bairro: 'Centro',
      uf: 'pr',
      municipioIbge: 4106902,
    };
    const r = criarLojaSchema.safeParse({ ...base, tipo: 'deposito', tipoEmissao: 'nfce' });
    expect(r.error!.issues.map((i) => i.path[0]).sort()).toEqual(['ie', 'usaPdv']);
    expect(criarLojaSchema.parse({ ...base, usaPdv: true }).uf).toBe('PR');
    // Uma loja que emite documento fiscal marcada como treino sumiria dos totais do ERP (C12); e a de treino não
    // passa a emitir.
    const fiscal = criarLojaSchema.safeParse({ ...base, ie: '123', tipoEmissao: 'nfce', treino: true });
    expect(fiscal.error!.issues.map((i) => i.path[0])).toEqual(['treino']);
    expect(criarLojaSchema.safeParse({ ...base, tipoEmissao: 'sat', treino: true }).success).toBe(false);
    expect(criarLojaSchema.parse({ ...base, treino: true })).toMatchObject({
      treino: true,
      tipoEmissao: 'nao_fiscal',
    });
  });
});

describe('montarArvoreCategorias', () => {
  it('aninha pela categoria pai e ordena por ordem e nome', () => {
    const no = (id: string, nome: string, pai: string | null, ordem = 0): CategoriaNo => ({
      id,
      nome,
      categoriaPaiId: pai,
      caminhoNomes: nome,
      nivel: pai ? 2 : 1,
      ordem,
      ativa: true,
      exibePdv: true,
      exibeMenuDigital: false,
      exibeTotem: false,
      exibeSite: false,
      cor: null,
      produtos: 0,
      versao: 1,
    });
    const a = montarArvoreCategorias([
      no('2', 'Vinhos', null),
      no('1', 'Cervejas', null),
      no('3', 'Lata', '1', 1),
      no('4', 'Long neck', '1'),
    ]);
    expect(a.map((x) => x.nome)).toEqual(['Cervejas', 'Vinhos']);
    expect(a[0]!.filhas.map((x) => x.nome)).toEqual(['Long neck', 'Lata']);
  });
});
