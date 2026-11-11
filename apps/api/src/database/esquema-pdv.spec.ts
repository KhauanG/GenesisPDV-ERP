import { describe, expect, it } from 'vitest';
import * as schema from './empresa/schema/index.js';
import { gerarCsharp, TABELAS_MOVIMENTO_PDV, tabelasPdv, tipoClr } from './esquema-pdv.js';

describe('gerador do Esquema.g.cs do PDV (MD 4.1)', () => {
  it('mapeia os tipos do PostgreSQL para o C# do PDV, com a escala do numeric', () => {
    expect(tipoClr('numeric(15, 2)')).toEqual({ tipo: 'decimal', escala: 2 });
    expect(tipoClr('numeric(7,4)')).toEqual({ tipo: 'decimal', escala: 4 });
    expect(tipoClr('uuid').tipo).toBe('Guid');
    expect(tipoClr('timestamp with time zone').tipo).toBe('DateTimeOffset');
    expect(tipoClr('varchar(40)').tipo).toBe('string');
    expect(tipoClr('boolean').tipo).toBe('bool');
    expect(tipoClr('text[]').tipo).toBe('string[]');
    expect(tipoClr('smallint[]').tipo).toBe('short[]');
    expect(tipoClr('time').tipo).toBe('TimeOnly');
    expect(() => tipoClr('numeric(15,2)[]')).toThrow(/Array/);
    expect(() => tipoClr('numeric')).toThrow(/escala/);
    expect(() => tipoClr('point')).toThrow(/sem mapeamento/);
  });

  it('lista os campos calculados do pull (F2-B45) no fim, projetados e anuláveis, e as tabelas de complementos', () => {
    const tabelas = tabelasPdv(schema);
    for (const [tabela, campo] of [
      ['produtos', 'foto'],
      ['categorias', 'imagem'],
      ['marcas', 'logotipo'],
    ] as const) {
      const colunas = tabelas.find((t) => t.nome === tabela)!.colunas;
      expect(colunas.slice(-2)).toEqual([
        {
          nome: `${campo}_url`,
          tipoNuvem: 'text',
          tipoClr: 'string',
          nulo: true,
          escala: null,
          descida: 'projetada',
          gerada: false,
        },
        {
          nome: `${campo}_sha256`,
          tipoNuvem: 'varchar(64)',
          tipoClr: 'string',
          nulo: true,
          escala: null,
          descida: 'projetada',
          gerada: false,
        },
      ]);
    }
    for (const nome of ['produtos_grupos_complementos', 'produtos_complementos'])
      expect(tabelas.find((t) => t.nome === nome)).toMatchObject({ papel: 'espelho', fluxo: 'catalogo' });
  });

  it('descreve as tabelas dos fluxos com nulidade, escala e CHECKs, em ordem estável', () => {
    const tabelas = tabelasPdv(schema);
    const usuarios = tabelas.find((t) => t.nome === 'usuarios')!;
    expect(usuarios.papel).toBe('espelho');
    expect(usuarios.colunas.find((c) => c.nome === 'limite_desconto_pct')).toMatchObject({
      tipoClr: 'decimal',
      escala: 4,
      nulo: false,
    });
    expect(usuarios.colunas.find((c) => c.nome === 'email')?.nulo).toBe(true);
    expect(usuarios.checks.map((k) => k.nome)).toContain('ck_usuarios_limites');
    expect(tabelas.map((t) => t.nome)).toEqual(
      [...tabelas.map((t) => t.nome)].sort((a, b) => a.localeCompare(b)),
    );
    expect(gerarCsharp(tabelas)).toBe(gerarCsharp(tabelasPdv(schema)));
    expect(gerarCsharp(tabelas)).toContain(
      'new("limite_desconto_pct", "numeric(7, 4)", typeof(decimal), Nulo: false, Escala: 4),',
    );
  });

  it('tabelas de movimento da 1C (C3): todas no schema, sem fluxo, com a chave `id` e as colunas da nuvem', () => {
    const tabelas = tabelasPdv(schema);
    const movimento = tabelas.filter((t) => t.papel === 'movimento');
    expect(movimento.map((t) => t.nome).sort()).toEqual([...TABELAS_MOVIMENTO_PDV].sort());
    for (const t of movimento) {
      expect(t.fluxo, t.nome).toBeNull();
      expect(t.chave, t.nome).toEqual(['id']);
      expect(
        t.colunas.every((c) => c.descida === 'desce'),
        t.nome,
      ).toBe(true);
    }
    const vendas = movimento.find((t) => t.nome === 'vendas')!;
    expect(vendas.colunas.find((c) => c.nome === 'relogio_confiavel')).toMatchObject({
      tipoClr: 'bool',
      nulo: false,
    });
    expect(vendas.colunas.find((c) => c.nome === 'numero')).toMatchObject({ tipoClr: 'long', nulo: false });
    const vasilhame = movimento.find((t) => t.nome === 'movimentos_vasilhame')!;
    expect(vasilhame.checks.find((k) => k.nome === 'ck_movimentos_vasilhame_destino')?.expressao).toContain(
      "'entrada'",
    );
    const fechamento = movimento.find((t) => t.nome === 'fechamentos_caixa')!;
    expect(fechamento.colunas.find((c) => c.nome === 'diferenca')).toMatchObject({
      tipoClr: 'decimal',
      escala: 2,
      gerada: true,
    });
    // Só as colunas `generated` ficam marcadas (o handler do C6 não as inclui no INSERT).
    const geradas = tabelas.flatMap((t) =>
      t.colunas.filter((c) => c.gerada).map((c) => `${t.nome}.${c.nome}`),
    );
    expect(geradas.sort()).toEqual(['fechamentos_caixa.diferenca', 'fechamentos_caixa_formas.diferenca']);
    expect(gerarCsharp(tabelas)).toContain(
      'new("diferenca", "numeric(15, 2)", typeof(decimal), Nulo: false, Escala: 2, Gerada: true),',
    );
  });

  it('marca como cada coluna de espelho desce no pull: omitida, projetada (inclui bytea) ou desce', () => {
    const tabelas = tabelasPdv(schema);
    const coluna = (tabela: string, nome: string) =>
      tabelas.find((t) => t.nome === tabela)!.colunas.find((c) => c.nome === nome)!;
    expect(coluna('usuarios', 'senha_hash').descida).toBe('omitida');
    expect(coluna('usuarios', 'senha_pdv_hash').descida).toBe('projetada');
    expect(coluna('produtos', 'preco_custo').descida).toBe('omitida');
    expect(coluna('produtos', 'peso_g').descida).toBe('omitida');
    expect(coluna('produtos', 'preco_venda').descida).toBe('desce');
    expect(coluna('lojas', 'nfce_csc_cifrado').descida).toBe('projetada');
    expect(coluna('configuracoes', 'valor_cifrado').descida).toBe('projetada');
    for (const t of tabelas.filter((x) => x.papel === 'movimento'))
      expect(t.colunas.every((c) => c.descida === 'desce')).toBe(true);
    const cs = gerarCsharp(tabelas);
    expect(cs).toContain(
      'new("senha_hash", "varchar(255)", typeof(string), Nulo: true, Escala: null, Descida: DescidaColuna.Omitida),',
    );
    expect(cs).toContain('Descida: DescidaColuna.Projetada),');
  });
});
