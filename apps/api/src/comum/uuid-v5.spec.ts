import { describe, expect, it } from 'vitest';
import { uuidv5 } from './uuid-v5.js';

const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('uuidv5 (RFC 9562 §5.5)', () => {
  it('bate com os vetores conhecidos e é determinístico', () => {
    // Python: uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')
    expect(uuidv5('python.org', DNS)).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
    expect(uuidv5('www.example.com', DNS)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    expect(uuidv5('a', DNS)).toBe(uuidv5('a', DNS));
    expect(uuidv5('a', DNS)).not.toBe(uuidv5('b', DNS));
  });

  it('recusa namespace que não é UUID', () => {
    expect(() => uuidv5('x', 'nao-e-uuid')).toThrow(/Namespace/);
  });
});
