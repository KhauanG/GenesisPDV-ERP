/**
 * API para o e2e PDV ↔ API da Fase 1B (`apps/pdv/tests/GenesisPDV.E2E.Tests`): banco de controle próprio, faixa de
 * códigos de empresa 600000–699999 (separada da 700000 do e2e do ERP e da 800000+ da integração), uma empresa com
 * loja, quatro caixas (o quarto é o da recuperação do backup de 2 h, C17), um operador com PIN definido pela rota do
 * ERP e um produto com EAN, e a API escutando em `E2E_PORTA_API` (padrão 3399). Fase 1C (C13): a loja é a "Treino"
 * do piloto (O10 do dono: `lojas.treino`, não fiscal), com o gerente que libera o cancelamento da venda paga (O6), e o
 * catálogo do caixa da Ice Beer no ERP — lata com o DUN do fardo de 12, cerveja retornável com o casco e o combo de
 * whisky com a troca do energético —, com saldo por um acerto de Entrada. O estado (URL, empresa, credenciais do ERP,
 * PIN, ids) vai para `E2E_ESTADO` só depois que tudo está pronto: o teste do PDV espera o arquivo aparecer, com o
 * formato conferido contra o exemplo versionado `estado.exemplo.json` (o mesmo que o `EstadoE2ETests` do PDV lê). O
 * bloco de 1.000 códigos fica sob uma trava consultiva até o fim do processo; ao receber SIGINT/SIGTERM, ou se o
 * preparo falhar no meio, apaga os bancos e as roles que criou. Restos de um processo morto à força (`kill -9`) saem
 * com `pnpm --filter api test:limpar`.
 *
 * Uso: `pnpm --filter api e2e:pdv:servidor` (ou `tsx test/e2e-pdv/servidor.ts`), com `DATABASE_URL` do servidor local.
 */
import { randomInt } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { calcularDvGtin, completarCnpj, criarEmpresaSchema } from '@genesis/shared';
import { criarAplicacao } from '../../src/app.js';
import { carregarConfiguracao } from '../../src/config/configuracao.js';
import { garantirBanco, migrarControle, seedControle } from '../../src/database/migracoes/controle.js';
import { criarServicos } from '../../src/servicos.js';
import { consultar, criarLoja, urlDoBanco } from '../integracao/ambiente.js';
import { RecursosE2ePdv } from './recursos.js';

const SENHA_ERP = 'SenhaE2ePdv123';
const OPERADOR = { login: 'caixa1', nome: 'MARIA CAIXA', pin: '258036' } as const;
const PRODUTO = { nome: 'CERV BRAHMA LT 350ML', ean: '7891149103102', preco: '4.99' } as const;
const GERENTE = { login: 'gerente1', nome: 'CARLOS GERENTE', pin: '369147' } as const;
/** GTIN com o dígito verificador calculado (EAN-13 de 12 dígitos, DUN-14 de 13). */
const gtin = (base: string) => `${base}${calcularDvGtin(base)}`;

const estadoArquivo = process.env.E2E_ESTADO ?? 'e2e-pdv-estado.json';
const porta = Number(process.env.E2E_PORTA_API ?? 3399);
const recursos = new RecursosE2ePdv();
const bancoControle = recursos.bancoControle;
rmSync(estadoArquivo, { force: true });

/** Apaga o que foi criado (idempotente): bancos, roles e o arquivo de estado (`recursos.ts`). */
async function limpar(): Promise<void> {
  await recursos.limpar();
  rmSync(estadoArquivo, { force: true });
}

type Formato = 'array' | 'null' | 'object' | 'string' | 'number' | 'boolean' | 'outro';
const formato = (v: unknown): Formato =>
  Array.isArray(v)
    ? 'array'
    : v === null
      ? 'null'
      : ['object', 'string', 'number', 'boolean'].includes(typeof v)
        ? (typeof v as Formato)
        : 'outro';

/**
 * O estado gravado tem as mesmas chaves e tipos do exemplo versionado (recursivo; listas pelo 1º item do exemplo). O
 * `EstadoE2ETests` do PDV desserializa o mesmo exemplo: uma chave renomeada aqui falha neste ponto, com o caminho dela,
 * e não como um 0 ou um nulo no meio do roteiro do PDV.
 */
function conferirFormato(valor: unknown, exemplo: unknown, caminho = 'estado'): void {
  if (formato(valor) !== formato(exemplo)) {
    throw new Error(`${caminho}: ${formato(valor)} no estado, ${formato(exemplo)} no estado.exemplo.json`);
  }
  if (Array.isArray(valor) && Array.isArray(exemplo)) {
    valor.forEach((v, i) => conferirFormato(v, exemplo[0], `${caminho}[${i}]`));
    return;
  }
  if (formato(valor) !== 'object') return;
  const v = valor as Record<string, unknown>;
  const e = exemplo as Record<string, unknown>;
  const chaves = [...new Set([...Object.keys(v), ...Object.keys(e)])].sort();
  for (const chave of chaves) {
    if (!(chave in v)) throw new Error(`${caminho}.${chave}: falta no estado (está no estado.exemplo.json)`);
    if (!(chave in e)) throw new Error(`${caminho}.${chave}: falta no estado.exemplo.json`);
    conferirFormato(v[chave], e[chave], `${caminho}.${chave}`);
  }
}

async function preparar(): Promise<void> {
  const inicio = await recursos.reservarBloco();

  const url = urlDoBanco(bancoControle);
  recursos.marcarControle();
  await garantirBanco(url);
  await migrarControle(url);
  const config = carregarConfiguracao({
    AMBIENTE: 'teste',
    DATABASE_URL: url,
    PORTA: String(porta),
    LOG_NIVEL: process.env.E2E_LOG_NIVEL ?? 'warn',
    LOG_LEGIVEL: 'false',
    // A revogação e a desativação confirmada acontecem nas rotas; a manutenção de 5 min não entra no roteiro.
    FILA_TRABALHADOR: 'false',
    TENANCY_CACHE_MS: '0',
    CEP_CONSULTA_URL: 'desligada',
    LOGIN_LIMITE_POR_MINUTO: '1000',
    LOGIN_LIMITE_POR_CONTA_MINUTO: '1000',
  });
  const servicos = criarServicos(config, { executadoPor: 'e2e-pdv' });
  await seedControle(servicos.controle, servicos.servidores);
  await servicos.controle.pool.query(`alter sequence seq_codigo_empresa restart with ${inicio + 1}`);

  const empresa = await servicos.provisionamento.criar(
    criarEmpresaSchema.parse({
      razaoSocial: 'Ice Beer E2E Comércio de Bebidas Ltda',
      cnpj: completarCnpj(`${randomInt(10 ** 11, 10 ** 12 - 1)}`.slice(0, 12)),
      planoCodigo: 'padrao',
    }),
  );

  const { app } = await criarAplicacao(config, servicos);
  recursos.app = app;
  await app.listen(porta, '127.0.0.1');
  const base = `http://127.0.0.1:${porta}`;

  async function chamar<T>(metodo: string, rota: string, corpo?: unknown, token?: string): Promise<T> {
    const r = await fetch(`${base}${rota}`, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await r.text();
    if (!r.ok) throw new Error(`${metodo} ${rota}: ${r.status} ${texto}`);
    return (texto ? JSON.parse(texto) : undefined) as T;
  }

  // Admin com a senha provisória trocada (o e2e do PDV entra com ela para gerar códigos, mudar preço e revogar).
  const primeiro = await chamar<{ tokenAcesso: string; trocarSenha: boolean }>('POST', '/api/auth/login', {
    codigoEmpresa: empresa.codigo,
    login: 'admin',
    senha: empresa.senhaProvisoria!,
  });
  const admin = (
    await chamar<{ tokenAcesso: string }>(
      'POST',
      '/api/auth/trocar-senha',
      { senhaAtual: empresa.senhaProvisoria!, novaSenha: SENHA_ERP },
      primeiro.tokenAcesso,
    )
  ).tokenAcesso;

  const lojaId = await criarLoja(empresa.nomeBanco, 1, 'Loja 1 - Centro');
  const caixas = await consultar<{ id: string }>(
    empresa.nomeBanco,
    `insert into caixas (loja_id, numero, descricao)
     values ($1, 1, 'Caixa 01'), ($1, 2, 'Caixa 02'), ($1, 3, 'Caixa 03'), ($1, 4, 'Caixa 04') returning id`,
    [lojaId],
  );
  // O10 do dono (D39): o piloto roda na loja "Treino" dentro da empresa real, não fiscal. O e2e confere pelo ERP que as
  // vendas dela ficam fora das consultas por padrão e aparecem com o filtro.
  await consultar(
    empresa.nomeBanco,
    "update lojas set treino = true, tipo_emissao = 'nao_fiscal' where id = $1",
    [lojaId],
  );
  // Perfil de supervisor: o e2e cancela a venda em andamento direto pelo serviço, sem a tela da liberação, e o serviço
  // confere `pdv.venda.cancelar_venda_aberta` (O6 do dono; fora do perfil do operador).
  const [operador] = await consultar<{ id: string }>(
    empresa.nomeBanco,
    `insert into usuarios (nome, login, perfil_id)
     values ($1, $2, (select id from perfis where chave_sistema = 'supervisor_caixa')) returning id`,
    [OPERADOR.nome, OPERADOR.login],
  );
  await consultar(empresa.nomeBanco, 'insert into usuarios_lojas (usuario_id, loja_id) values ($1, $2)', [
    operador!.id,
    lojaId,
  ]);
  // O PIN pela rota do ERP (argon2id da SYNC 4.2): é ele que desce no fluxo `acesso` e o PDV verifica offline.
  await chamar('PUT', `/api/usuarios/${operador!.id}/pin`, { pin: OPERADOR.pin }, admin);

  // O gerente (perfil padrão `gerente`, com `pdv.venda.cancelar_venda_finalizada`) libera o cancelamento da venda paga.
  const [gerente] = await consultar<{ id: string }>(
    empresa.nomeBanco,
    `insert into usuarios (nome, login, perfil_id)
     values ($1, $2, (select id from perfis where chave_sistema = 'gerente')) returning id`,
    [GERENTE.nome, GERENTE.login],
  );
  await consultar(empresa.nomeBanco, 'insert into usuarios_lojas (usuario_id, loja_id) values ($1, $2)', [
    gerente!.id,
    lojaId,
  ]);
  await chamar('PUT', `/api/usuarios/${gerente!.id}/pin`, { pin: GERENTE.pin }, admin);

  const unidades = await chamar<Array<{ id: string; sigla: string }>>(
    'GET',
    '/api/referencias/unidades',
    undefined,
    admin,
  );
  const un = unidades.find((u) => u.sigla === 'UN')!.id;
  const fd = unidades.find((u) => u.sigla === 'FD')!.id;
  const criarProduto = async (corpo: Record<string, unknown>) =>
    (
      await chamar<{ id: string }>(
        'POST',
        '/api/produtos',
        { unidadeId: un, ncm: '2203.00.00', precoCusto: '1', ...corpo },
        admin,
      )
    ).id;
  const produto = {
    id: await criarProduto({
      nome: PRODUTO.nome,
      precoVenda: PRODUTO.preco,
      codigosBarras: [{ codigo: PRODUTO.ean, principal: true }],
    }),
  };

  // Catálogo do caixa da Ice Beer (Fase 1C, C13): lata com o fardo de 12 pelo DUN, retornável com o casco e o combo.
  const lata = { ean: gtin('789199101300'), dun: gtin('1789199101300') };
  const lataId = await criarProduto({
    nome: 'CERV SKOL LT 350ML',
    precoVenda: '3.49',
    precoCusto: '2',
    codigosBarras: [
      { codigo: lata.ean, principal: true },
      { codigo: lata.dun, unidadeId: fd, fator: '12' },
    ],
  });
  const cascoId = await criarProduto({ nome: 'CASCO 600ML', tipo: 'vasilhame', precoVenda: '2.50' });
  const retornavel = { ean: gtin('789114910400') };
  const retornavelId = await criarProduto({
    nome: 'CERV ORIGINAL 600ML RET',
    precoVenda: '9.90',
    precoCusto: '4',
    vasilhameProdutoId: cascoId,
    vasilhameQuantidade: 1,
    codigosBarras: [{ codigo: retornavel.ean, principal: true }],
  });
  const whisky = await criarProduto({ nome: 'WHISKY 1L', precoVenda: '99.90', precoCusto: '60' });
  const redBull = await criarProduto({
    nome: 'ENERGETICO RED BULL 2L',
    precoVenda: '24.90',
    precoCusto: '10',
  });
  const monster = await criarProduto({
    nome: 'ENERGETICO MONSTER 2L',
    precoVenda: '24.90',
    precoCusto: '12',
  });
  const gelo = await criarProduto({ nome: 'GELO DE COCO', precoVenda: '4.50', precoCusto: '1' });
  const combo = { ean: gtin('789000013130') };
  const comboId = await criarProduto({
    nome: 'COMBO DE WHISKY 1L',
    tipo: 'kit',
    precoVenda: '129.90',
    codigosBarras: [{ codigo: combo.ean, principal: true }],
    componentes: [
      { tipo: 'kit', componenteId: whisky, quantidade: '1' },
      {
        tipo: 'kit',
        componenteId: redBull,
        quantidade: '1',
        rotuloPosicao: 'Energético 2L',
        permiteSubstituicao: true,
        alternativas: [{ produtoId: monster, acrescimo: '2,00' }],
      },
      { tipo: 'kit', componenteId: gelo, quantidade: '2' },
    ],
  });

  // Saldo inicial por um acerto de Entrada efetivado (o caixa vende sem o aviso de estoque, O15).
  const [{ estoque_id: estoqueId }] = (await consultar<{ estoque_id: string }>(
    empresa.nomeBanco,
    'select estoque_id from lojas where id = $1',
    [lojaId],
  )) as [{ estoque_id: string }];
  const acerto = await chamar<{ id: string; versao: number }>(
    'POST',
    '/api/acertos',
    {
      estoqueId,
      tipoAjuste: 'entrada',
      dataContagem: new Date(Date.now() - 3_600_000).toISOString(),
      motivo: 'Saldo inicial do e2e',
      itens: [lataId, retornavelId, cascoId, whisky, redBull, monster, gelo].map((produtoId) => ({
        produtoId,
        quantidade: '5000',
        custoUnitario: '2',
      })),
    },
    admin,
  );
  const lido = await chamar<{ versao: number }>('GET', `/api/acertos/${acerto.id}`, undefined, admin);
  await chamar('POST', `/api/acertos/${acerto.id}/efetivar`, { versao: lido.versao }, admin);

  const estado = {
    api: `${base}/`,
    codigoEmpresa: empresa.codigo,
    erp: { login: 'admin', senha: SENHA_ERP },
    operador: { login: OPERADOR.login, pin: OPERADOR.pin, nome: OPERADOR.nome },
    gerente: { login: GERENTE.login, pin: GERENTE.pin, nome: GERENTE.nome },
    lojaId,
    estoqueId,
    caixas: caixas.map((c) => c.id),
    produto: { id: produto.id, ean: PRODUTO.ean, preco: PRODUTO.preco },
    catalogo: {
      lata: { id: lataId, ean: lata.ean, dun: lata.dun },
      retornavel: { id: retornavelId, ean: retornavel.ean },
      casco: { id: cascoId },
      combo: { id: comboId, ean: combo.ean },
      componentesCombo: [whisky, redBull, gelo],
    },
    bancoControle,
    nomeBanco: empresa.nomeBanco,
  };
  conferirFormato(
    estado,
    JSON.parse(readFileSync(new URL('./estado.exemplo.json', import.meta.url), 'utf8')) as unknown,
  );
  writeFileSync(estadoArquivo, JSON.stringify(estado, null, 2));
  console.log(`e2e PDV: API em ${base}, empresa ${empresa.codigo}; estado em ${estadoArquivo}`);
}

let encerrando = false;
async function encerrar(codigo: number): Promise<void> {
  if (encerrando) return;
  encerrando = true;
  try {
    await limpar();
  } catch (e) {
    console.error('e2e PDV: falha ao apagar os bancos (use pnpm --filter api test:limpar):', e);
    codigo = codigo || 1;
  }
  process.exit(codigo);
}
process.on('SIGINT', () => void encerrar(0));
process.on('SIGTERM', () => void encerrar(0));

try {
  await preparar();
} catch (e) {
  // Preparo que falha no meio (provisionamento, login, produto, porta ocupada): nada fica para trás no Postgres.
  console.error('e2e PDV: o preparo falhou; apagando o que foi criado.', e);
  await encerrar(1);
}
