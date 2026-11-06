/**
 * Importação de clientes (ERP 8.6, layout de 8.5): identificação `id` → CPF/CNPJ → `codigo`; gravação pela mesma regra
 * do cadastro de pessoas. CPF/CNPJ inválido e cidade não encontrada não impedem a linha (relatório); o endereço só
 * entra completo (CEP, logradouro, número, bairro, UF e cidade do IBGE).
 */
import {
  CATEGORIAS_PESSOA,
  criarPessoaSchema,
  lerCodigoPlanilha,
  lerNumeroPlanilha,
  normalizarCnpj,
  ROTULOS_CATEGORIA_PESSOA,
  somenteDigitos,
  validarCnpj,
  validarCpf,
  type CategoriaPessoa,
  type CriarPessoaEntrada,
  type LinhaPreviaImportacao,
  type OcorrenciaImportacao,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import type { Celula, LinhaPlanilha } from './planilha.js';
import { chaveNome } from './produtos.js';

export interface LinhaCliente extends LinhaPreviaImportacao {
  dados: Partial<CriarPessoaEntrada>;
}

export interface ReferenciasClientes {
  municipios: Map<string, number>;
  porId: Map<string, { id: string; nome: string }>;
  porDocumento: Map<string, { id: string; nome: string }>;
  porCodigo: Map<number, { id: string; nome: string }>;
}

const texto = (v: Celula | undefined): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const t = String(v).trim();
  return t || null;
};

const CATEGORIA_POR_NOME = new Map<string, CategoriaPessoa>([
  ...CATEGORIAS_PESSOA.map((c) => [c, c] as [string, CategoriaPessoa]),
  ...Object.entries(ROTULOS_CATEGORIA_PESSOA).map(
    ([c, r]) => [chaveNome(r), c as CategoriaPessoa] as [string, CategoriaPessoa],
  ),
]);

export async function carregarReferenciasClientes(
  db: DbEmpresa,
  linhas: readonly LinhaPlanilha[],
  indices: Record<string, number>,
): Promise<ReferenciasClientes> {
  const coluna = (chave: string) =>
    indices[chave] === undefined
      ? []
      : linhas.map((l) => lerCodigoPlanilha(l.valores[indices[chave]!])).filter((v): v is string => !!v);
  const arr = (v: string[]) => `{${[...new Set(v)].map((x) => `"${x.replace(/["\\]/g, '')}"`).join(',')}}`;
  const ids = coluna('id').filter((v) => /^[0-9a-f-]{36}$/i.test(v));
  const docs = coluna('cpf_cnpj').map(normalizarCnpj).filter(Boolean);
  const codigos = coluna('codigo')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const [mun, pid, pdoc, pcod] = await Promise.all([
    db.execute<{ codigo_ibge: number; nome: string; uf: string }>(
      sql`select codigo_ibge, nome, uf from municipios`,
    ),
    db.execute<{ id: string; nome: string }>(sql`
      select id, nome from pessoas where excluido_em is null and id = any(${arr(ids)}::uuid[])`),
    db.execute<{ id: string; nome: string; cpf_cnpj: string }>(sql`
      select id, nome, cpf_cnpj from pessoas where excluido_em is null and cpf_cnpj = any(${arr(docs)}::text[])`),
    db.execute<{ id: string; nome: string; codigo: number }>(sql`
      select id, nome, codigo from pessoas where excluido_em is null and codigo = any(${`{${codigos.join(',')}}`}::int[])`),
  ]);
  return {
    municipios: new Map(mun.rows.map((m) => [`${m.uf}|${chaveNome(m.nome)}`, m.codigo_ibge])),
    porId: new Map(pid.rows.map((p) => [p.id, p])),
    porDocumento: new Map(pdoc.rows.map((p) => [p.cpf_cnpj, p])),
    porCodigo: new Map(pcod.rows.map((p) => [p.codigo, p])),
  };
}

const shape = criarPessoaSchema.shape;

export function analisarClientes(
  linhas: readonly LinhaPlanilha[],
  indices: Record<string, number>,
  ref: ReferenciasClientes,
): LinhaCliente[] {
  const tem = (chave: string) => indices[chave] !== undefined;
  const documentos = new Map<string, number>();
  return linhas.map((l): LinhaCliente => {
    const cel = (chave: string): Celula | undefined => (tem(chave) ? l.valores[indices[chave]!] : undefined);
    const erros: string[] = [];
    const avisos: OcorrenciaImportacao[] = [];
    const dados: Partial<CriarPessoaEntrada> = {};

    const id = lerCodigoPlanilha(cel('id'));
    const docBruto = lerCodigoPlanilha(cel('cpf_cnpj'));
    const doc = docBruto ? normalizarCnpj(docBruto) : '';
    const codigo = lerNumeroPlanilha(cel('codigo'));
    let existente: { id: string; nome: string } | null = null;
    if (id) {
      existente = ref.porId.get(id) ?? null;
      if (!existente) erros.push(`Id ${id} não encontrado (apague a coluna Id para cadastrar como novo)`);
    }
    if (!existente && !erros.length && doc) existente = ref.porDocumento.get(doc) ?? null;
    if (!existente && !erros.length && codigo !== null && Number.isInteger(codigo))
      existente = ref.porCodigo.get(codigo) ?? null;

    const nome = texto(cel('nome'));
    if (nome) dados.nome = nome.slice(0, 150);
    else if (!existente) erros.push('Informe o nome');

    // Tipo: coluna ou pelo tamanho do documento.
    const tipoTexto = texto(cel('tipo'))?.toUpperCase() ?? null;
    let tipo: 'PF' | 'PJ' | null = null;
    if (tipoTexto) {
      if (/^(PF|F|FISICA|PESSOA FISICA)/.test(chaveNome(tipoTexto).toUpperCase())) tipo = 'PF';
      else if (/^(PJ|J|JURIDICA|PESSOA JURIDICA)/.test(chaveNome(tipoTexto).toUpperCase())) tipo = 'PJ';
      else erros.push(`Tipo "${tipoTexto}" desconhecido (use PF ou PJ)`);
    }
    if (!tipo && doc) tipo = doc.length > 11 ? 'PJ' : 'PF';
    if (tipo) dados.tipo = tipo;

    if (doc) {
      const valido = (tipo ?? 'PF') === 'PJ' ? validarCnpj(doc) : validarCpf(doc);
      if (!valido) {
        avisos.push({
          codigo: 'documento_invalido',
          campo: 'cpf_cnpj',
          mensagem: `${tipo === 'PJ' ? 'CNPJ' : 'CPF'} ${docBruto} inválido: cadastrado sem documento`,
        });
      } else {
        const anterior = documentos.get(doc);
        if (anterior !== undefined) erros.push(`CPF/CNPJ repetido na planilha (linha ${anterior})`);
        else documentos.set(doc, l.numero);
        dados.cpfCnpj = doc;
      }
    }

    const apelido = texto(cel('apelido'));
    if (apelido) dados.apelido = apelido.slice(0, 150);
    const rgIe = texto(cel('rg_ie'));
    if (rgIe) dados.rgIe = rgIe.slice(0, 20);
    const nasc = cel('nascimento');
    if (nasc !== undefined && nasc !== null && nasc !== '') {
      const iso = dataPlanilha(nasc);
      if (!iso) erros.push(`Nascimento "${String(nasc)}" inválido (use dd/mm/aaaa)`);
      else dados.nascimento = iso;
    }
    if (tem('limite_compras')) {
      const n = lerNumeroPlanilha(cel('limite_compras'));
      if (n !== null && Number.isNaN(n)) erros.push('Limite de compras inválido');
      else if (n !== null) dados.limiteCompras = String(n);
    }
    const categorias = texto(cel('categorias'));
    if (categorias) {
      const lista = categorias
        .split(/[,;/]/)
        .map((c) => CATEGORIA_POR_NOME.get(chaveNome(c)))
        .filter((c): c is CategoriaPessoa => !!c);
      dados.categorias = lista.length ? [...new Set(lista)] : ['cliente'];
    } else if (!existente) dados.categorias = ['cliente'];

    const telefone = lerCodigoPlanilha(cel('telefone'));
    if (telefone) {
      const r = shape.telefones.safeParse([{ numero: somenteDigitos(telefone), principal: true }]);
      if (r.success) dados.telefones = r.data;
      else
        avisos.push({
          codigo: 'outro',
          campo: 'telefone',
          mensagem: `Telefone ${telefone} inválido: não importado`,
        });
    }
    const email = texto(cel('email'));
    if (email) {
      const r = shape.emails.safeParse([{ email, principal: true }]);
      if (r.success) dados.emails = r.data;
      else
        avisos.push({ codigo: 'outro', campo: 'email', mensagem: `E-mail ${email} inválido: não importado` });
    }

    // Endereço principal completo; cidade pelo nome + UF (IBGE).
    const uf = texto(cel('uf'))?.toUpperCase() ?? null;
    const cidade = texto(cel('cidade'));
    const algumEndereco = ['cep', 'logradouro', 'numero', 'bairro', 'cidade', 'uf'].some((c) =>
      texto(cel(c)),
    );
    if (algumEndereco) {
      const municipio = uf && cidade ? ref.municipios.get(`${uf}|${chaveNome(cidade)}`) : undefined;
      if (cidade && !municipio)
        avisos.push({
          codigo: 'cidade_inexistente',
          campo: 'cidade',
          mensagem: `Cidade "${cidade}${uf ? `/${uf}` : ''}" não encontrada: endereço não importado`,
        });
      else {
        const r = shape.enderecos.safeParse([
          {
            tipo: 'principal',
            cep: lerCodigoPlanilha(cel('cep'))?.replace(/\D/g, '').padStart(8, '0') ?? null,
            logradouro: texto(cel('logradouro')),
            numero: lerCodigoPlanilha(cel('numero')) ?? 'S/N',
            complemento: texto(cel('complemento')),
            bairro: texto(cel('bairro')),
            uf,
            municipioIbge: municipio ?? null,
          },
        ]);
        if (r.success) dados.enderecos = r.data;
        else
          avisos.push({
            codigo: 'outro',
            campo: 'endereco',
            mensagem: `Endereço incompleto (${r.error.issues.map((i) => i.message).join(', ')}): não importado`,
          });
      }
    }

    if (!existente && !erros.length) {
      const r = criarPessoaSchema.safeParse(dados);
      if (!r.success)
        erros.push(
          ...r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)),
        );
    }
    return {
      linha: l.numero,
      acao: erros.length ? 'ignorar' : existente ? 'atualizar' : 'criar',
      descricao: (nome ?? existente?.nome ?? docBruto ?? '').slice(0, 120),
      registroId: existente?.id ?? null,
      erros,
      avisos,
      dados,
    };
  });
}

/** Data da planilha: célula de data do xlsx, `dd/mm/aaaa` ou `aaaa-mm-dd`. */
export function dataPlanilha(v: Celula): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const t = String(v).trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return validaData(+m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return validaData(+m[1]!, +m[2]!, +m[3]!);
  return null;
}

function validaData(a: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(a, m - 1, d));
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}
