import { PERFIS_PADRAO, type RegimeFiscal } from '@genesis/shared';
import type pg from 'pg';
import {
  ATRIBUTOS_VARIACAO_PADRAO,
  CFOPS_GRUPOS_PADRAO,
  CONTA_CAIXA_INTERNO,
  FORMAS_PAGAMENTO_PADRAO,
  TEMPLATES_PADRAO,
  TIPOS_ESTOQUE_PADRAO,
  UNIDADES_MEDIDA_PADRAO,
} from './dados/cadastros.js';
import { ATALHOS_PDV_PADRAO, PLANO_CONTAS_PADRAO } from './dados/tabelas-md.js';

export interface DadosSeedEmpresa {
  codigo: number;
  razaoSocial: string;
  nomeFantasia: string | null;
  cnpj: string;
  email: string | null;
  regime: RegimeFiscal;
}

export interface AdminSeed {
  nome: string;
  login: string;
  email: string | null;
  senhaHash: string;
}

export type ResultadoAdmin = 'criado' | 'senha_provisoria_redefinida' | 'mantido';

async function idPorChave(cliente: pg.ClientBase, tabela: string, chave: string): Promise<string> {
  const { rows } = await cliente.query<{ id: string }>(`select id from ${tabela} where chave_sistema = $1`, [
    chave,
  ]);
  if (!rows[0]) throw new Error(`Seed: ${tabela}.${chave} não encontrado`);
  return rows[0].id;
}

/**
 * Nome do perfil de sistema que ainda não existe na empresa (ex.: o "Encarregado", decisão 66 do README do PDV). Se ela
 * já tem um perfil próprio com o mesmo nome (`uq_perfis_nome`: `lower(nome)`, sem os excluídos), o de sistema entra
 * como "Nome (padrão)", depois "Nome (padrão 2)" e assim por diante — nunca fica sem nome, e o "padrão" o separa do
 * perfil da empresa no seletor do usuário. O dela fica intocado. Os nomes de `PERFIS_PADRAO` cabem com folga nos 40.
 */
async function nomePerfilLivre(
  cliente: pg.ClientBase,
  perfil: { nome: string; chaveSistema: string },
): Promise<string> {
  const { rows } = await cliente.query<{ nome: string }>(
    `select lower(nome) as nome from perfis where excluido_em is null and lower(nome) like lower($1::varchar) || '%'`,
    [perfil.nome],
  );
  const ocupados = new Set(rows.map((r) => r.nome));
  for (let n = 1; ; n++) {
    const nome =
      n === 1 ? perfil.nome : n === 2 ? `${perfil.nome} (padrão)` : `${perfil.nome} (padrão ${n - 1})`;
    if (!ocupados.has(nome.toLowerCase())) return nome;
  }
}

/**
 * Seed idempotente de uma empresa (MD 7.3–7.12). Pode ser reaplicado a qualquer momento (ex.: migração que
 * acrescenta um item padrão): insere só o que falta e nunca ressuscita o que a empresa excluiu ou renomeou.
 * Deve rodar dentro de uma transação aberta por quem chama. Referências nacionais vêm antes (`carregarReferencias`).
 */
export async function aplicarSeedEmpresa(
  cliente: pg.ClientBase,
  dados: DadosSeedEmpresa,
  admin?: AdminSeed,
): Promise<{ admin?: ResultadoAdmin }> {
  await cliente.query(
    `insert into empresa (codigo, razao_social, nome_fantasia, cnpj, email)
     select $1, $2, $3, $4, $5 where not exists (select 1 from empresa)`,
    [dados.codigo, dados.razaoSocial, dados.nomeFantasia, dados.cnpj, dados.email],
  );

  await cliente.query(
    `insert into configuracoes (escopo, chave, valor)
     select 'empresa', 'fiscal.regime', to_jsonb($1::text)
     where not exists (select 1 from configuracoes where escopo = 'empresa' and loja_id is null and chave = 'fiscal.regime')`,
    [dados.regime],
  );

  for (const t of TIPOS_ESTOQUE_PADRAO) {
    await cliente.query(
      `insert into tipos_estoque (nome, vendavel, padrao, chave_sistema)
       select $1::varchar, $2::boolean, $3::boolean and not exists (select 1 from tipos_estoque where padrao and excluido_em is null), $4::varchar
       where not exists (select 1 from tipos_estoque where chave_sistema = $4::varchar)
         and not exists (select 1 from tipos_estoque where lower(nome) = lower($1::varchar) and excluido_em is null)`,
      [t.nome, t.vendavel, t.padrao, t.chaveSistema],
    );
  }

  for (const u of UNIDADES_MEDIDA_PADRAO) {
    await cliente.query(
      `insert into unidades_medida (sigla, descricao, permite_fracao, sistema)
       select $1::varchar, $2::varchar, $3::boolean, true
       where not exists (select 1 from unidades_medida where upper(sigla) = upper($1::varchar) and excluido_em is null)`,
      [u.sigla, u.descricao, u.permiteFracao],
    );
  }

  for (const g of CFOPS_GRUPOS_PADRAO) {
    for (const [i, cfop] of g.cfops.entries()) {
      await cliente.query(
        `insert into cfops_grupos (grupo, cfop, padrao, ordem)
         select $1::varchar, $2::varchar, $3::boolean and not exists (select 1 from cfops_grupos where grupo = $1::varchar and padrao and excluido_em is null), $4::integer
         where not exists (select 1 from cfops_grupos where grupo = $1::varchar and cfop = $2::varchar)`,
        [g.grupo, cfop, g.comPadrao && i === 0, i + 1],
      );
    }
  }

  // Plano de contas: pai = código sem o último segmento (1.01.001 → 1.01).
  for (const [i, p] of PLANO_CONTAS_PADRAO.entries()) {
    const codigoPai = p.codigo.includes('.') ? p.codigo.slice(0, p.codigo.lastIndexOf('.')) : null;
    await cliente.query(
      `insert into planos_contas (codigo, nome, tipo, natureza, pai_id, ordem, chave_sistema)
       select $1::varchar, $2::varchar, $3::varchar, $4::varchar,
         (select id from planos_contas where codigo = $5::varchar and excluido_em is null), $6::integer, $7::varchar
       where not exists (select 1 from planos_contas where codigo = $1::varchar)
         and ($7::varchar is null or not exists (select 1 from planos_contas where chave_sistema = $7))`,
      [p.codigo, p.nome, p.tipo, p.natureza, codigoPai, i + 1, p.chaveSistema],
    );
  }

  await cliente.query(
    `insert into contas_correntes (tipo, descricao, chave_sistema)
     select $1::varchar, $2::varchar, $3::varchar where not exists (select 1 from contas_correntes where chave_sistema = $3::varchar)`,
    [CONTA_CAIXA_INTERNO.tipo, CONTA_CAIXA_INTERNO.descricao, CONTA_CAIXA_INTERNO.chaveSistema],
  );

  const caixaInterno = await idPorChave(cliente, 'contas_correntes', CONTA_CAIXA_INTERNO.chaveSistema);
  for (const f of FORMAS_PAGAMENTO_PADRAO) {
    const planoId = await idPorChave(cliente, 'planos_contas', f.planoContas ?? 'vendas_pdv');
    const flag = (k: keyof typeof f.flags) => f.flags[k] === true;
    // A forma nova nasce valendo em todas as lojas (vínculo de loja nula, MD 3.10.1; C8b). A que a empresa já tem, ou
    // excluiu, fica como está (a descrição é única na empresa desde a 0014).
    await cliente.query(
      `with nova as (
         insert into formas_pagamento (
           ordem, descricao, tipo_forma, meio_pagamento_fiscal, descricao_fiscal, integracao, dias_recebimento,
           parcelas_maximo, conta_corrente_id, plano_contas_id, lanca_quitada, permite_troco, abrir_gaveta,
           sempre_zerado_pdv, ativa, usa_pdv, gera_qrcode_pix, exige_dados_pos, permite_parcelar, restringe_idade_minima,
           exige_pessoa, a_prazo, credito_funcionario, vale_compra, e_boleto)
         select $1, $2::varchar, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
           $22, $23, $24, $25
         where not exists (select 1 from formas_pagamento where lower(descricao) = lower($2::varchar))
         returning id)
       insert into formas_pagamento_lojas (forma_pagamento_id, loja_id) select id, null from nova`,
      [
        f.ordem,
        f.descricao,
        f.tipoForma,
        f.meioPagamentoFiscal,
        f.descricaoFiscal ?? null,
        f.integracao,
        f.diasRecebimento ?? 0,
        f.parcelasMaximo ?? 1,
        caixaInterno,
        planoId,
        flag('lancaQuitada'),
        flag('permiteTroco'),
        flag('abrirGaveta'),
        flag('sempreZeradoPdv'),
        flag('ativa'),
        flag('usaPdv'),
        flag('geraQrcodePix'),
        flag('exigeDadosPos'),
        flag('permiteParcelar'),
        flag('restringeIdadeMinima'),
        flag('exigePessoa'),
        flag('aPrazo'),
        flag('creditoFuncionario'),
        flag('valeCompra'),
        flag('eBoleto'),
      ],
    );
  }

  for (const a of ATALHOS_PDV_PADRAO) {
    // Tecla já usada por outro atalho habilitado: o novo entra desabilitado (uq_atalhos_pdv_tecla).
    await cliente.query(
      `insert into atalhos_pdv (acao, tecla, habilitado, ordem)
       select $1::varchar, $2::varchar, $3::boolean and not exists (
           select 1 from atalhos_pdv where loja_id is null and lower(tecla) = lower($2::varchar) and habilitado and excluido_em is null),
         $4::integer
       where not exists (select 1 from atalhos_pdv where loja_id is null and acao = $1::varchar)`,
      [a.acao, a.tecla, a.habilitado, a.ordem],
    );
  }

  // MD 7.12: marca genérica (uma só, `uq_marcas_sem_marca`) e atributos de variação padrão.
  await cliente.query(
    `insert into marcas (descricao, sem_marca)
     select 'SEM MARCA', true
     where not exists (select 1 from marcas where sem_marca)
       and not exists (select 1 from marcas where lower(fn_unaccent(descricao)) = 'sem marca' and excluido_em is null)`,
  );
  for (const [i, nome] of ATRIBUTOS_VARIACAO_PADRAO.entries()) {
    await cliente.query(
      `insert into atributos_variacao (nome, ordem)
       select $1::varchar, $2::integer
       where not exists (select 1 from atributos_variacao where lower(nome) = lower($1::varchar))`,
      [nome, i + 1],
    );
  }

  for (const t of TEMPLATES_PADRAO) {
    await cliente.query(
      `insert into templates_documentos (tipo, nome, formato, assunto, conteudo, padrao)
       select $1::varchar, $2, $3, $4, $5, true
       where not exists (select 1 from templates_documentos where tipo = $1::varchar and loja_id is null and padrao)`,
      [t.tipo, t.nome, t.formato, 'assunto' in t ? t.assunto : null, t.conteudo],
    );
  }

  for (const perfil of PERFIS_PADRAO) {
    await cliente.query(
      `insert into perfis (nome, descricao, chave_sistema)
       select $1::varchar, $2, $3::varchar
       where not exists (select 1 from perfis where chave_sistema = $3::varchar)`,
      [await nomePerfilLivre(cliente, perfil), perfil.descricao, perfil.chaveSistema],
    );
    const perfilId = await idPorChave(cliente, 'perfis', perfil.chaveSistema);
    if (perfil.descricoesAnteriores?.length) {
      // A descrição do seed que mudou (ex.: o Encarregado que passou a cancelar a venda paga, decisão 78 do README do
      // PDV): só a que a empresa não reescreveu.
      await cliente.query(
        'update perfis set descricao = $2 where id = $1 and descricao = any($3::varchar[])',
        [perfilId, perfil.descricao, perfil.descricoesAnteriores],
      );
    }
    // Só acrescenta o que falta; permissão que a empresa removeu do perfil (linha excluída) não volta.
    const { rowCount } = await cliente.query(
      `insert into perfis_permissoes (perfil_id, permissao)
       select $1, p from unnest($2::varchar[]) p
       where not exists (select 1 from perfis_permissoes pp where pp.perfil_id = $1 and pp.permissao = p)
         and exists (select 1 from permissoes x where x.chave = p and x.excluido_em is null)`,
      [perfilId, perfil.permissoes],
    );
    if (rowCount) {
      await cliente.query(
        'update usuarios set permissoes_versao = permissoes_versao + 1 where perfil_id = $1',
        [perfilId],
      );
    }
  }

  if (!admin) return {};
  const perfilAdmin = await idPorChave(cliente, 'perfis', 'administrador');
  const { rows } = await cliente.query<{ id: string; senha_provisoria: boolean }>(
    'select id, senha_provisoria from usuarios where lower(login) = lower($1) and excluido_em is null',
    [admin.login],
  );
  const existente = rows[0];
  if (!existente) {
    await cliente.query(
      `insert into usuarios (nome, login, email, senha_hash, senha_provisoria, master, perfil_id, ativo)
       values ($1, $2, $3, $4, true, true, $5, true)`,
      [admin.nome, admin.login, admin.email, admin.senhaHash, perfilAdmin],
    );
    return { admin: 'criado' };
  }
  if (existente.senha_provisoria) {
    // "Tentar novamente" do provisionamento: a senha anterior nunca foi exibida, então gera outra.
    await cliente.query(
      'update usuarios set senha_hash = $2, tentativas_falhas = 0, bloqueado_ate = null where id = $1',
      [existente.id, admin.senhaHash],
    );
    return { admin: 'senha_provisoria_redefinida' };
  }
  return { admin: 'mantido' };
}
