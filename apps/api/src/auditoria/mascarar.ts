/** Campos sensíveis nunca vão em claro para `antes`/`depois` (ERP 17.2). */
const SENSIVEL = /(senha|hash|cifrad|token|segredo|secret|csc|certificado_arquivo|apikey)/i;

export function mascararSensiveis(valor: unknown): unknown {
  if (valor === null || valor === undefined) return valor;
  if (Array.isArray(valor)) return valor.map(mascararSensiveis);
  if (valor instanceof Date) return valor.toISOString();
  if (Buffer.isBuffer(valor)) return '***';
  if (typeof valor === 'object') {
    const r: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      r[k] = SENSIVEL.test(k) && v !== null && v !== undefined ? '***' : mascararSensiveis(v);
    }
    return r;
  }
  return valor;
}

/** Colunas que nunca saem da API para o navegador, nem mascaradas (MD 1.10). */
const SEGREDO_COLUNA = /(cifrad|senha|token|segredo|secret|hash)/i;

/**
 * Remove do objeto toda chave com cara de segredo. Usado nas respostas que devolvem a linha inteira: uma coluna de
 * segredo acrescentada depois (certificado, TEF, integrações) não vaza por padrão.
 */
export function semSegredos<T extends Record<string, unknown>>(linha: T): Partial<T> {
  return Object.fromEntries(Object.entries(linha).filter(([k]) => !SEGREDO_COLUNA.test(k))) as Partial<T>;
}

const SALARIO = /^sal[aá]rio$/i;
/** Custo, custo médio, markup e totais de custo (`produtos.ver_custo`, MD 3.6.3). */
const CUSTO = /(custo|markup)/i;
/**
 * Os valores em R$ do ST retido da linha da loja (D68; `CAMPOS_ST_RETIDO_CUSTO` do shared), em camelCase e em
 * snake_case: revelam o preço de compra, então seguem o custo. Os percentuais (pST, pFCPSTRet) ficam.
 */
const CUSTO_ST_RETIDO = /^(st|fcp_?st)_?(bc_?retido|icms_?substituto|icms_?retido|retido)_?unitario$/i;
/** Listas por loja (produtos_lojas, faixas, lojas do usuário) filtradas pelas lojas permitidas. */
const LISTA_POR_LOJA = /^(lojas|precosQuantidade|precos_quantidade|faixas)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VisaoAuditoria {
  /** `usuarios.ver_dados_rh`. */
  verRh: boolean;
  /** `produtos.ver_custo`. */
  verCusto: boolean;
  /** Lojas permitidas (`null` = todas). */
  lojas: readonly string[] | null;
}

/**
 * Redige `antes`/`depois` na leitura (ERP 17.3): quem tem `auditoria.ver` não vê pela auditoria o que a permissão mais
 * fina esconde no cadastro — salário sem `usuarios.ver_dados_rh`, custo/markup (e os valores do ST retido, D68) sem
 * `produtos.ver_custo` e linhas de lojas fora das permitidas (preço da loja, faixas, lojas de um usuário). Recursivo.
 */
export function redigirParaVisao(valor: unknown, visao: VisaoAuditoria): unknown {
  if (valor === null || valor === undefined || typeof valor !== 'object') return valor;
  const visivel = (lojaId: unknown) =>
    visao.lojas === null || lojaId === null || lojaId === undefined || visao.lojas.includes(String(lojaId));
  if (Array.isArray(valor)) return valor.map((v) => redigirParaVisao(v, visao));
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
    if (!visao.verRh && SALARIO.test(k)) continue;
    if (!visao.verCusto && (CUSTO.test(k) || CUSTO_ST_RETIDO.test(k))) continue;
    if (visao.lojas !== null && LISTA_POR_LOJA.test(k) && Array.isArray(v)) {
      r[k] = v
        .filter((item) => {
          if (typeof item === 'string') return !UUID.test(item) || visivel(item);
          if (item && typeof item === 'object') {
            const o = item as Record<string, unknown>;
            return visivel(o.lojaId ?? o.loja_id);
          }
          return true;
        })
        .map((item) => redigirParaVisao(item, visao));
      continue;
    }
    r[k] = redigirParaVisao(v, visao);
  }
  return r;
}
