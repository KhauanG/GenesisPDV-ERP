import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { Permissao } from './autorizacao/decorators.js';
import { LojasController } from './lojas/lojas.controller.js';

describe('decorators (legacy) sem metadados de tipo', () => {
  it('@Permissao grava a metadata e recusa chave fora do catálogo', () => {
    const r = new Reflector();
    expect(r.get('genesis:permissoes', LojasController.prototype.listar)).toEqual(['lojas.ver']);
    expect(() => Permissao('nao.existe')).toThrow(/fora do catálogo/);
  });
});
