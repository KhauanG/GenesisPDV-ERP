/**
 * Importação de clientes (ERP 8.6, layout de 8.5): identificação `id` → CPF/CNPJ → `codigo`; gravação pela mesma regra
 * do cadastro de pessoas. CPF/CNPJ inválido e cidade não encontrada não impedem a linha (relatório); o endereço só
 * entra completo (CEP, logradouro, número, bairro, UF e cidade do IBGE). Cliente existente: a linha é comparada com o
 * cadastro e só o que muda é gravado; nada mudou → `sem_alteracao` (decisão 103, estendida aos clientes no F2-B40 para
 * a ida e volta do "Exportar Clientes").
 */
import {
  CATEGORIAS_PESSOA,
  criarPessoaSchema,
  dec,
  formatarCpfCnpj,
  lerCodigoPlanilha,
  lerNumeroPlanilha,
  normalizarCnpj,
  ROTULOS_CATEGORIA_PESSOA,
  somenteDigitos,
  validarCnpj,
  validarCpf,
  type CategoriaPessoa,
  type AlteracaoImportacao,
  type CriarPessoaEntrada,
  type LinhaPreviaImportacao,
  type OcorrenciaImportacao,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import type { Celula, LinhaPlanilha } from './planilha.js';
import { chaveNome, formatarDinheiro } from './produtos.js';

export interface LinhaCliente extends LinhaPreviaImportacao {
  dados: Partial<CriarPessoaEntrada>;
}

/**
 * Cliente existente como o "Exportar Clientes" o leva (base da comparação): o telefone e o e-mail são os da
 * exportação (o principal, senão o primeiro) e o endereço é o principal no Brasil.
 */
export interface EstadoCliente {
  tipo: 'PF' | 'PJ';
  nome: string;
  apelido: string | null;
  cpfCnpj: string | null;
  rgIe: string | null;
  /** `aaaa-mm-dd`. */
  nascimento: string | null;
  limiteCompras: string | null;
  categorias: CategoriaPessoa[];
  /** DDD + número. */
  telefone: string | null;
  email: string | null;
  endereco: {
    cep: string | null;
    logradouro: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    uf: string | null;
    municipioIbge: number | null;
    cidade: string | null;
  } | null;
}

export interface ReferenciasClientes {
  municipios: Map<string, number>;
  porId: Map<string, { id: string; nome: string }>;
  porDocumento: Map<string, { id: string; nome: string }>;
  porCodigo: Map<number, { id: string; nome: string }>;
  /** Estado atual dos clientes achados (por id), para o "Sem alteração" e o "O que muda". */
  atuais: Map<string, EstadoCliente>;
}

/** O que a sessão pode alterar pela planilha além do cadastro (decisão 85). */
export interface PermissoesAnaliseClientes {
  /** `pessoas.editar_credito`: sem ela o limite de compras da planilha não é gravado nem comparado. */
  editarCredito: boolean;
  /**
   * `pessoas.ver`: sem ela a linha não é comparada com o cadastro. O "de" de "O que muda" traria o CPF/CNPJ, o RG, o
   * nascimento, o telefone, o e-mail e o endereço de quem já está gravado (revisão de segurança do PR-9, D63), e o
   * "Sem alteração" serviria de oráculo para adivinhar esses dados. A linha fica "Atualizar" com tudo o que veio na
   * planilha, como antes do F2-B40.
   */
  verPessoas: boolean;
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
  const achados = [...new Set([...pid.rows, ...pdoc.rows, ...pcod.rows].map((p) => p.id))];
  return {
    municipios: new Map(mun.rows.map((m) => [`${m.uf}|${chaveNome(m.nome)}`, m.codigo_ibge])),
    porId: new Map(pid.rows.map((p) => [p.id, p])),
    porDocumento: new Map(pdoc.rows.map((p) => [p.cpf_cnpj, p])),
    porCodigo: new Map(pcod.rows.map((p) => [p.codigo, p])),
    atuais: await carregarEstadosClientes(db, achados),
  };
}

/** Estado dos clientes pelo id, com as mesmas escolhas da exportação (`sqlCatalogoClientes`). */
async function carregarEstadosClientes(
  db: DbEmpresa,
  ids: readonly string[],
): Promise<Map<string, EstadoCliente>> {
  if (!ids.length) return new Map();
  const { rows } = await db.execute<{
    id: string;
    tipo: string;
    nome: string;
    apelido: string | null;
    cpf_cnpj: string | null;
    rg_ie: string | null;
    nascimento: string | null;
    limite_compras: string | null;
    categorias: CategoriaPessoa[] | null;
    telefone: string | null;
    email: string | null;
    cep: string | null;
    logradouro: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    uf: string | null;
    municipio_ibge: number | null;
    cidade: string | null;
  }>(sql`
    select p.id, trim(p.tipo) as tipo, p.nome, p.apelido, p.cpf_cnpj, p.rg_ie,
           to_char(p.nascimento, 'YYYY-MM-DD') as nascimento, p.limite_compras::text,
           (select array_agg(c.categoria order by c.categoria) from pessoas_categorias c
             where c.pessoa_id = p.id and c.excluido_em is null) as categorias,
           (select t.ddd || t.numero from pessoas_telefones t
             where t.pessoa_id = p.id and t.excluido_em is null order by t.principal desc, t.id limit 1) as telefone,
           (select e.email from pessoas_emails e
             where e.pessoa_id = p.id and e.excluido_em is null order by e.principal desc, e.id limit 1) as email,
           en.cep, en.logradouro, en.numero, en.complemento, en.bairro, en.uf, en.municipio_ibge, mu.nome as cidade
      from pessoas p
      left join lateral (
        select en.cep, en.logradouro, en.numero, en.complemento, en.bairro, en.uf, en.municipio_ibge
          from pessoas_enderecos en
         where en.pessoa_id = p.id and en.excluido_em is null and en.tipo = 'principal' and not en.exterior
         order by en.id limit 1) en on true
      left join municipios mu on mu.codigo_ibge = en.municipio_ibge
     where p.excluido_em is null and p.id = any(${`{${ids.join(',')}}`}::uuid[])`);
  return new Map(
    rows.map((r) => [
      r.id,
      {
        tipo: r.tipo === 'PJ' ? 'PJ' : 'PF',
        nome: r.nome,
        apelido: r.apelido,
        cpfCnpj: r.cpf_cnpj,
        rgIe: r.rg_ie,
        nascimento: r.nascimento,
        limiteCompras: r.limite_compras,
        categorias: r.categorias ?? [],
        telefone: r.telefone,
        email: r.email,
        endereco:
          r.cep || r.logradouro || r.municipio_ibge
            ? {
                cep: r.cep,
                logradouro: r.logradouro,
                numero: r.numero,
                complemento: r.complemento,
                bairro: r.bairro,
                uf: r.uf,
                municipioIbge: r.municipio_ibge,
                cidade: r.cidade,
              }
            : null,
      },
    ]),
  );
}

const shape = criarPessoaSchema.shape;

export function analisarClientes(
  linhas: readonly LinhaPlanilha[],
  indices: Record<string, number>,
  ref: ReferenciasClientes,
  pode: PermissoesAnaliseClientes = { editarCredito: true, verPessoas: true },
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
    const linha: LinhaCliente = {
      linha: l.numero,
      acao: erros.length ? 'ignorar' : existente ? 'atualizar' : 'criar',
      descricao: (nome ?? existente?.nome ?? docBruto ?? '').slice(0, 120),
      registroId: existente?.id ?? null,
      erros,
      avisos,
      dados,
    };
    // Cliente existente: só o que muda é gravado; nada mudou → `sem_alteracao` (decisão 103).
    if (linha.acao === 'atualizar' && pode.verPessoas) {
      const atual = ref.atuais.get(existente!.id);
      if (atual) {
        linha.alteracoes = compararClienteComAtual(dados, atual, cidade, pode);
        if (!linha.alteracoes.length) linha.acao = 'sem_alteracao';
      }
    }
    return linha;
  });
}

const dataBr = (iso: string | null | undefined) => (iso ? iso.split('-').reverse().join('/') : null);
const telefoneBr = (v: string | null) =>
  v ? `(${v.slice(0, 2)}) ${v.length > 6 ? `${v.slice(2, -4)}-${v.slice(-4)}` : v.slice(2)}` : null;
const rotulosCategorias = (c: readonly CategoriaPessoa[]) =>
  [...c]
    .sort()
    .map((x) => ROTULOS_CATEGORIA_PESSOA[x])
    .join(', ');
const enderecoBr = (e: EstadoCliente['endereco']) =>
  e
    ? [
        [e.logradouro, e.numero].filter(Boolean).join(', '),
        e.complemento,
        e.bairro,
        [e.cidade, e.uf].filter(Boolean).join('/'),
        e.cep?.length === 8 ? `${e.cep.slice(0, 5)}-${e.cep.slice(5)}` : e.cep,
      ]
        .filter(Boolean)
        .join(' - ')
    : null;

/**
 * Compara a linha com o cliente gravado e **tira de `dados`** o que não muda: a gravação só envia o que mudou, e a
 * prévia mostra cada diferença "de → para" (inclusive a de uma planilha exportada antes de uma alteração no ERP, que
 * voltaria o valor antigo: quem confere a prévia vê). Telefone e e-mail se comparam com os que a
 * exportação leva (o principal, senão o primeiro); o endereço, com o principal, pelas colunas da planilha (a referência
 * e os demais campos do cadastro não entram). Sem `pessoas.editar_credito` o limite de compras não entra (não seria
 * gravado).
 */
export function compararClienteComAtual(
  dados: Partial<CriarPessoaEntrada>,
  atual: EstadoCliente,
  cidadePlanilha: string | null,
  pode: PermissoesAnaliseClientes,
): AlteracaoImportacao[] {
  const alteracoes: AlteracaoImportacao[] = [];
  const mudou = (campo: string, rotulo: string, de: string | null, para: string | null) =>
    alteracoes.push({ campo, rotulo, de, para });
  const d = dados as Record<string, unknown>;
  const simples: Array<
    [keyof EstadoCliente & keyof CriarPessoaEntrada, string, string, (v: string | null) => string | null]
  > = [
    ['nome', 'nome', 'Nome', (v) => v],
    ['tipo', 'tipo', 'Tipo', (v) => v],
    ['apelido', 'apelido', 'Apelido', (v) => v],
    ['cpfCnpj', 'cpf_cnpj', 'CPF/CNPJ', (v) => (v ? formatarCpfCnpj(v) : null)],
    ['rgIe', 'rg_ie', 'RG/IE', (v) => v],
    ['nascimento', 'nascimento', 'Nascimento', dataBr],
  ];
  for (const [chave, campo, rotulo, formatar] of simples) {
    if (!(chave in d)) continue;
    const novo = (d[chave] as string | null | undefined) ?? null;
    const velho = (atual[chave] as string | null) ?? null;
    // O cadastro guarda o RG/IE em maiúsculas (`criarPessoaSchema`).
    const igual = chave === 'rgIe' ? (novo?.toUpperCase() ?? null) === velho : novo === velho;
    if (igual) delete d[chave];
    else mudou(campo, rotulo, formatar(velho), formatar(novo));
  }
  if ('limiteCompras' in d) {
    const novo = (d.limiteCompras as string | null | undefined) ?? null;
    const velho = atual.limiteCompras;
    const igual = novo === null || velho === null ? novo === velho : dec(novo).eq(dec(velho));
    if (!pode.editarCredito || igual) delete d.limiteCompras;
    else mudou('limite_compras', 'Limite de compras', formatarDinheiro(velho), formatarDinheiro(novo));
  }
  if (dados.categorias) {
    const novo = [...new Set(dados.categorias)].sort();
    const velho = [...atual.categorias].sort();
    if (novo.join(',') === velho.join(',')) delete d.categorias;
    else mudou('categorias', 'Categorias', rotulosCategorias(velho), rotulosCategorias(novo));
  }
  const tel = dados.telefones?.[0];
  if (tel) {
    const novo = `${tel.ddd ?? ''}${tel.numero}`;
    if (novo === atual.telefone) delete d.telefones;
    else mudou('telefone', 'Telefone', telefoneBr(atual.telefone), telefoneBr(novo));
  }
  const email = dados.emails?.[0];
  if (email) {
    if (email.email.toLowerCase() === atual.email?.toLowerCase()) delete d.emails;
    else mudou('email', 'E-mail', atual.email, email.email);
  }
  const end = dados.enderecos?.[0];
  if (end) {
    const a = atual.endereco;
    // `dados` já vem normalizado pelo schema (a saída do `safeParse` da análise).
    const valor = (v: unknown) => (v as string | null | undefined) ?? null;
    const novo = {
      cep: valor(end.cep),
      logradouro: valor(end.logradouro),
      numero: valor(end.numero),
      complemento: valor(end.complemento),
      bairro: valor(end.bairro),
      uf: valor(end.uf),
      municipioIbge: (end.municipioIbge as number | null | undefined) ?? null,
    };
    const igual =
      !!a && (Object.keys(novo) as Array<keyof typeof novo>).every((k) => (a[k] ?? null) === novo[k]);
    if (igual) delete d.enderecos;
    else mudou('endereco', 'Endereço', enderecoBr(a), enderecoBr({ ...novo, cidade: cidadePlanilha }));
  }
  return alteracoes;
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
