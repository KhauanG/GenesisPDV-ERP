import { mapearColunas } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import { analisarClientes, type EstadoCliente, type ReferenciasClientes } from './clientes.js';
import type { LinhaPlanilha } from './planilha.js';

const MARIA = '0190a000-0000-7000-8000-0000000000b1';
const SAO_PAULO = 3550308;

/** A MARIA como o "Exportar Clientes" a leva. */
const ATUAL: EstadoCliente = {
  tipo: 'PF',
  nome: 'MARIA TESTE DA SILVA',
  apelido: null,
  cpfCnpj: '52998224725',
  rgIe: 'MG123',
  nascimento: '1990-05-01',
  limiteCompras: '500.00',
  categorias: ['fornecedor', 'cliente'],
  telefone: '43999990000',
  email: 'maria@exemplo.com',
  endereco: {
    cep: '01001000',
    logradouro: 'Rua Exemplo',
    numero: '100',
    complemento: null,
    bairro: 'Centro',
    uf: 'SP',
    municipioIbge: SAO_PAULO,
    cidade: 'São Paulo',
  },
};

const REF: ReferenciasClientes = {
  municipios: new Map([['SP|sao paulo', SAO_PAULO]]),
  porId: new Map([[MARIA, { id: MARIA, nome: ATUAL.nome }]]),
  porDocumento: new Map(),
  porCodigo: new Map(),
  atuais: new Map([[MARIA, ATUAL]]),
};

/** A linha exportada da MARIA, com as células trocadas por `mudar`. */
function analisar(mudar: Record<string, string | number> = {}, editarCredito = true, verPessoas = true) {
  const linha: Record<string, string | number> = {
    'Id (UUID)': MARIA,
    'Tipo (PF/PJ)': 'PF',
    Nome: 'MARIA TESTE DA SILVA',
    'CPF/CNPJ': '529.982.247-25',
    'RG/IE': 'mg123',
    Nascimento: '01/05/1990',
    Telefone: '(43) 99999-0000',
    'E-mail': 'MARIA@exemplo.com',
    CEP: '01001-000',
    Logradouro: 'Rua Exemplo',
    Número: '100',
    Bairro: 'Centro',
    Cidade: 'São Paulo',
    UF: 'SP',
    'Limite de compras': 500,
    Categorias: 'Cliente, Fornecedor',
    ...mudar,
  };
  const cabecalho = Object.keys(linha);
  const mapa = mapearColunas(cabecalho, 'clientes');
  const linhas: LinhaPlanilha[] = [{ numero: 2, valores: cabecalho.map((c) => linha[c]!) }];
  return analisarClientes(linhas, mapa.indices, REF, { editarCredito, verPessoas })[0]!;
}

describe('analisarClientes: "Sem alteração" e "O que muda" (decisão 103, F2-B40)', () => {
  it('a linha exportada sem edição fica "Sem alteração" (decimal, maiúsculas e ordem das categorias)', () => {
    const l = analisar();
    expect(l.erros).toEqual([]);
    expect(l.alteracoes).toEqual([]);
    expect(l.acao).toBe('sem_alteracao');
  });

  it('só a célula mudada entra em `dados` e em "O que muda"', () => {
    const l = analisar({ 'Limite de compras': 750, Número: '200' });
    expect(l.acao).toBe('atualizar');
    expect(l.alteracoes!.map((a) => [a.campo, a.de, a.para])).toEqual([
      ['limite_compras', '500,00', '750,00'],
      [
        'endereco',
        'Rua Exemplo, 100 - Centro - São Paulo/SP - 01001-000',
        'Rua Exemplo, 200 - Centro - São Paulo/SP - 01001-000',
      ],
    ]);
    expect(Object.keys(l.dados).sort()).toEqual(['enderecos', 'limiteCompras']);
  });

  it('sem "Pessoas: Alterar limite de compras" o limite não é comparado nem gravado', () => {
    const l = analisar({ 'Limite de compras': 750 }, false);
    expect(l.acao).toBe('sem_alteracao');
    expect(l.dados.limiteCompras).toBeUndefined();
  });

  it('sem "Pessoas: Ver" a linha não é comparada: nenhum valor do cadastro sai na prévia (D63)', () => {
    const igual = analisar({}, true, false);
    expect(igual.acao).toBe('atualizar');
    expect(igual.alteracoes).toBeUndefined();
    const mudada = analisar({ Número: '200' }, true, false);
    expect(mudada.alteracoes).toBeUndefined();
    expect(JSON.stringify(mudada)).not.toContain('Rua Exemplo, 100');
    expect(mudada.dados.cpfCnpj).toBe('52998224725');
  });
});
