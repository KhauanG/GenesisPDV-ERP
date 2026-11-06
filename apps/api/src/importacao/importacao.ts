/**
 * Importação de produtos e clientes por planilha (ERP 8.6; roadmap Fase 1 "carga do Nuvem3"): upload → prévia (todas
 * as linhas validadas, nada gravado; a planilha fica no armazenamento) → confirmar → tarefa em segundo plano (ERP
 * 3.6) que relê a planilha, refaz a análise com o banco do momento, grava linha a linha (uma transação curta por
 * linha, MD 1.5), gera o acerto "Definir" da coluna `estoque_atual` e o relatório de inconsistências para download.
 */
import {
  colunasImportacao,
  criarPessoaSchema,
  criarProdutoSchema,
  mapearColunas,
  resumirLinhas,
  ROTULOS_AVISO_IMPORTACAO,
  type CriarProdutoEntrada,
  type LinhaPreviaImportacao,
  type OpcoesImportacao,
  type PreviaImportacao,
  type ResultadoImportacao,
  type TipoImportacao,
  LIMITE_ITENS_ACERTO,
  LIMITE_LINHAS_PREVIA,
} from '@genesis/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { AuditoriaService, OrigemAcao } from '../auditoria/auditoria.service.js';
import type { SessaoErp } from '../auth/auth.service.js';
import type { PermissoesEfetivas } from '../autorizacao/permissoes-efetivas.js';
import { ErroApi } from '../comum/erros.js';
import { gerarArquivoPlanilha, nomeArquivoExportacao, type ColunaExportacao } from '../comum/exportacao.js';
import { acertosEstoque, arquivos, marcas } from '../database/empresa/schema/index.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import {
  efetivarAcerto,
  gravarItensRascunho,
  resolverTipoEstoque,
  resumoEfetivacao,
  TIPOS_SEM_ESTOQUE,
} from '../estoques/acertos.js';
import { estoquePermitido } from '../estoques/permitidos.js';
import { chaveArquivo, type ArmazenamentoObjetos } from '../infra/armazenamento.js';
import { atualizarPessoa, detalhe as detalhePessoa, inserirPessoa } from '../pessoas/pessoas.controller.js';
import { detalheProduto } from '../produtos/consultas.js';
import type { CustoCombos } from '../produtos/custo-combo.js';
import { atualizarProduto, entradaDoDetalhe, inserirProduto } from '../produtos/produtos.controller.js';
import { sessaoDaTarefa, type ExecucaoTarefa, type TarefasSegundoPlano } from '../tarefas/tarefas.js';
import type { DbEmpresa, Tenancy } from '../tenancy/tenancy.js';
import { analisarClientes, carregarReferenciasClientes, type LinhaCliente } from './clientes.js';
import { lerPlanilha, type Planilha } from './planilha.js';
import {
  analisarProdutos,
  carregarReferencias,
  chaveNome,
  resolverComposicao,
  type LinhaProduto,
} from './produtos.js';

export const TAREFA_IMPORTACAO: Record<TipoImportacao, string> = {
  produtos: 'importacao_produtos',
  clientes: 'importacao_clientes',
};
const PERMISSAO: Record<TipoImportacao, string> = {
  produtos: 'produtos.importar',
  clientes: 'pessoas.importar',
};
const ENTIDADE: Record<TipoImportacao, string> = { produtos: 'produtos', clientes: 'pessoas' };
const LOCALIZACAO: Record<TipoImportacao, string> = {
  produtos: 'Produtos › Importação',
  clientes: 'Pessoas › Importação',
};
/** Cada efeito da planilha exige a permissão do formulário equivalente (decisão 85). */
const PERMISSAO_CRIAR: Record<TipoImportacao, string> = {
  produtos: 'produtos.criar',
  clientes: 'pessoas.criar',
};
const PERMISSAO_EDITAR: Record<TipoImportacao, string> = {
  produtos: 'produtos.editar',
  clientes: 'pessoas.editar',
};
/**
 * Tarefa interrompida no meio (decisão 150): cada linha é uma transação, então o que já entrou ficou; repetir a
 * mesma planilha é o caminho de recuperação, mas só com a prévia conferida: o já gravado é reconhecido pela
 * identificação de cada tipo (produto: Id → código → código interno → EAN; cliente: Id → CPF/CNPJ → código, e o
 * código da planilha não é gravado no cliente novo). A linha sem chave que já entrou volta como "Criar" e seria
 * cadastrada de novo; o produto que já entrou com "Atualizar estoque" vem "Atualizar" (o saldo só é acertado no fim).
 */
const SE_INTERROMPIDA: Record<TipoImportacao, string> = {
  produtos:
    'O que já foi gravado ficou salvo. Importe a mesma planilha de novo e confira a prévia antes de confirmar: o que já entrou aparece como "Sem alteração" (ou "Atualizar", só no estoque, que é acertado no fim). Linha que já entrou e aparecer como "Criar" (sem código, código interno nem EAN) seria cadastrada de novo: tire-a da planilha.',
  clientes:
    'O que já foi gravado ficou salvo. Importe a mesma planilha de novo e confira a prévia antes de confirmar: o cliente que já entrou é reconhecido pelo Id ou pelo CPF/CNPJ e aparece como "Sem alteração". Linha que já entrou e aparecer como "Criar" (cliente sem CPF/CNPJ) seria cadastrada de novo: tire-a da planilha. Confira também a quem aponta cada "Atualizar": o código da planilha não fica no cliente novo e pode ser o de outro cliente.',
};
const RETENCAO_DIAS = 30;
const MOTIVO_ACERTO = 'Importação de planilha';

/** Para onde vai o "Atualizar estoque" (F2-B11): o estoque escolhido (ou o da loja) e a loja dele (`null` = o CD). */
interface DestinoEstoque {
  estoqueId: string;
  lojaId: string | null;
}

interface Dependencias {
  tenancy: Tenancy;
  tarefas: TarefasSegundoPlano;
  armazenamento: ArmazenamentoObjetos;
  auditoria: AuditoriaService;
  custoCombos: CustoCombos;
  permissoes: PermissoesEfetivas;
}

type LinhaAnalisada = LinhaProduto | LinhaCliente;

export class Importacoes {
  constructor(private readonly d: Dependencias) {
    for (const tipo of ['produtos', 'clientes'] as const) {
      d.tarefas.registrarTipo(TAREFA_IMPORTACAO[tipo], (e) => this.executar(tipo, e), {
        seInterrompida: SE_INTERROMPIDA[tipo],
      });
    }
  }

  /** Planilha-modelo (8.6 "Baixar modelo"): só o cabeçalho do nosso layout e uma linha de exemplo. */
  async modelo(tipo: TipoImportacao): Promise<{ conteudo: Buffer; tipoMime: string; nome: string }> {
    const colunas = colunasImportacao(tipo).filter((c) => c.chave !== 'id' && c.chave !== 'codigo');
    const exemplo: Record<string, string | number> =
      tipo === 'produtos'
        ? {
            codigo_interno: 'CERV-001',
            ean: '7891149103102',
            nome: 'CERV BRAHMA LT 350ML',
            tipo: 'Simples',
            unidade: 'UN',
            ativo: 'Sim',
            marca: 'BRAHMA',
            categoria: 'CERVEJA > LATA',
            preco_custo: 2.1,
            preco_venda: 3.49,
            preco_atacado: 3.19,
            qtd_minima_atacado: 12,
            estoque_minimo: 24,
            estoque_atual: 120,
            ncm: '22030000',
            cest: '0302100',
            cfop_venda_estado: '5405',
            icms_situacao: '500',
            icms_origem: '0',
          }
        : {
            tipo: 'PF',
            nome: 'MARIA DA SILVA',
            cpf_cnpj: '529.982.247-25',
            telefone: '(43) 99999-0000',
            email: 'maria@exemplo.com',
            cep: '86010-000',
            logradouro: 'Rua Exemplo',
            numero: '100',
            bairro: 'Centro',
            cidade: 'Londrina',
            uf: 'PR',
            limite_compras: 500,
            categorias: 'Cliente',
          };
    const r = await gerarArquivoPlanilha<Record<string, string | number>>(
      'xlsx',
      colunas.map((c) => ({ rotulo: c.chave, valor: (l) => l[c.chave] ?? null })),
      [exemplo],
    );
    return { ...r, nome: `modelo_importacao_${tipo}.xlsx` };
  }

  /** Prévia: valida todas as linhas sem gravar e guarda a planilha para a confirmação. */
  async previa(
    sessao: SessaoErp,
    tipo: TipoImportacao,
    arquivo: { nome: string; conteudo: Buffer; tipoMime: string },
    opcoes: OpcoesImportacao,
  ): Promise<PreviaImportacao> {
    this.conferirLoja(sessao, tipo, opcoes);
    this.conferirOpcoes(sessao, tipo, opcoes);
    const cx = this.d.tenancy.cx();
    const destino = await cx.consulta((db) => this.conferirEstoque(db, sessao, tipo, opcoes));
    const planilha = await lerPlanilha(arquivo.nome, arquivo.conteudo);
    const { linhas, mapa } = await cx.consulta((db) =>
      this.analisar(db, tipo, planilha, opcoes, sessao, destino),
    );
    // E/S externa fora de transação (MD 1.5): grava o objeto e depois a linha de `arquivos`.
    const chave = chaveArquivo(
      cx.contexto.codigo,
      'importacao',
      /\.csv$/i.test(arquivo.nome) ? 'csv' : 'xlsx',
    );
    const { sha256, tamanhoBytes } = await this.d.armazenamento.gravar(
      chave,
      arquivo.conteudo,
      arquivo.tipoMime,
    );
    const retencao = new Date(Date.now() + RETENCAO_DIAS * 86_400_000).toISOString().slice(0, 10);
    const [a] = await cx.consulta((db) =>
      db
        .insert(arquivos)
        .values({
          chaveArmazenamento: chave,
          nomeOriginal: arquivo.nome.slice(0, 255),
          tipoMime: arquivo.tipoMime.slice(0, 100),
          tamanhoBytes,
          sha256,
          categoria: 'planilha_importacao',
          entidade: ENTIDADE[tipo],
          lojaId: opcoes.lojaId ?? null,
          retencaoAte: retencao,
          criadoPorId: sessao.usuarioId,
          atualizadoPorId: sessao.usuarioId,
        })
        .returning({ id: arquivos.id }),
    );
    // Erros primeiro (é o que o usuário precisa corrigir), depois o que será gravado (criar/atualizar/inativar) antes
    // do que fica igual, com os avisos na frente; por fim a ordem da planilha.
    const ordenadas = [...linhas].sort(
      (x, y) =>
        Number(y.erros.length > 0) - Number(x.erros.length > 0) ||
        Number(x.acao === 'sem_alteracao') - Number(y.acao === 'sem_alteracao') ||
        Number(y.avisos.length > 0) - Number(x.avisos.length > 0) ||
        x.linha - y.linha,
    );
    return {
      tipo,
      arquivoId: a!.id,
      nomeArquivo: arquivo.nome,
      colunasReconhecidas: Object.keys(mapa.indices),
      colunasIgnoradas: [...mapa.ignoradas, ...mapa.repetidas.map((r) => `${r} (repetida)`)],
      resumo: resumirLinhas(linhas),
      linhas: ordenadas.slice(0, LIMITE_LINHAS_PREVIA).map(paraPrevia),
    };
  }

  /** Confirma: cria a tarefa (na transação) e agenda depois do commit. */
  async confirmar(
    sessao: SessaoErp,
    tipo: TipoImportacao,
    entrada: OpcoesImportacao & { arquivoId: string },
  ): Promise<{ tarefaId: string }> {
    const { arquivoId, ...opcoes } = entrada;
    this.conferirLoja(sessao, tipo, opcoes);
    this.conferirOpcoes(sessao, tipo, opcoes);
    const cx = this.d.tenancy.cx();
    const tarefaId = await cx.transacao(async (tx) => {
      await this.conferirEstoque(tx, sessao, tipo, opcoes);
      // Só a planilha enviada pelo próprio usuário na prévia do mesmo tipo (o relatório final é `planilha_exportacao`).
      const [a] = await tx
        .select({ id: arquivos.id })
        .from(arquivos)
        .where(
          and(
            eq(arquivos.id, arquivoId),
            isNull(arquivos.excluidoEm),
            eq(arquivos.categoria, 'planilha_importacao'),
            eq(arquivos.entidade, ENTIDADE[tipo]),
            eq(arquivos.criadoPorId, sessao.usuarioId),
          ),
        );
      if (!a) throw ErroApi.naoEncontrado('Planilha não encontrada: envie o arquivo de novo.');
      return this.d.tarefas.criar(tx, {
        tipo: TAREFA_IMPORTACAO[tipo],
        parametros: { arquivoId, opcoes },
        usuarioId: sessao.usuarioId,
        lojaId: opcoes.lojaId ?? null,
      });
    });
    await this.d.tarefas.agendar(cx.contexto.empresaId, tarefaId);
    return { tarefaId };
  }

  /**
   * Opções que exigem permissão própria (decisão 85): "Atualizar estoque" gera um acerto efetivado →
   * `estoque_acertos.criar` (403). "Criar marcas e categorias" sem `marcas.criar`/`categorias.editar` é ignorada na
   * análise (aviso de marca/categoria inexistente, como com a opção desligada).
   */
  private conferirOpcoes(sessao: SessaoErp, tipo: TipoImportacao, opcoes: OpcoesImportacao): void {
    if (tipo === 'produtos' && opcoes.atualizarEstoque && !sessao.permissoes.has('estoque_acertos.criar')) {
      throw new ErroApi('SEM_PERMISSAO', '"Atualizar estoque" exige "Acertos de estoque: Criar".', {
        campos: { atualizarEstoque: ['Exige a permissão "Acertos de estoque: Criar"'] },
      });
    }
  }

  /**
   * Produtos pedem a loja (preço da loja e estoque mínimo), salvo quando o "Atualizar estoque" vai para um estoque
   * escolhido (F2-B11): a carga do CD, estoque sem loja, não exige uma loja que o usuário nem precisa ter.
   */
  private conferirLoja(sessao: SessaoErp, tipo: TipoImportacao, opcoes: OpcoesImportacao): void {
    if (tipo !== 'produtos') return;
    if (!opcoes.lojaId) {
      if (opcoes.atualizarEstoque && opcoes.estoqueId) return;
      throw new ErroApi('VALIDACAO', 'Escolha a loja.', { campos: { lojaId: ['Escolha a loja'] } });
    }
    if (sessao.lojas !== null && !sessao.lojas.includes(opcoes.lojaId))
      throw ErroApi.semPermissao('A loja está fora das suas lojas permitidas.');
  }

  /**
   * Estoque do "Atualizar estoque" (F2-B11): o escolhido (qualquer estoque, inclusive o sem loja, o CD) ou, vazio, o
   * da loja. Tem de existir, estar ativo e entre os estoques permitidos para movimentar (decisão 149: a loja
   * permitida não basta). Fora deles → 403, antes de ler a planilha. Sem "Atualizar estoque" → `null`.
   */
  private async conferirEstoque(
    db: DbEmpresa,
    sessao: SessaoErp,
    tipo: TipoImportacao,
    opcoes: OpcoesImportacao,
  ): Promise<DestinoEstoque | null> {
    if (tipo !== 'produtos' || !opcoes.atualizarEstoque) return null;
    const campo = opcoes.estoqueId ? 'estoqueId' : 'atualizarEstoque';
    const { rows } = await db.execute<{ id: string; ativo: boolean; loja_id: string | null }>(
      opcoes.estoqueId
        ? sql`select e.id, e.ativo,
                     (select l.id from lojas l where l.estoque_id = e.id and l.excluido_em is null
                       order by l.codigo limit 1) as loja_id
                from estoques e where e.id = ${opcoes.estoqueId} and e.excluido_em is null`
        : sql`select e.id, e.ativo, l.id as loja_id
                from lojas l join estoques e on e.id = l.estoque_id and e.excluido_em is null
               where l.id = ${opcoes.lojaId ?? null}::uuid and l.excluido_em is null`,
    );
    const e = rows[0];
    if (!e)
      throw new ErroApi('VALIDACAO', 'Estoque não encontrado.', {
        campos: { [campo]: ['Estoque não encontrado'] },
      });
    if (!estoquePermitido(sessao, e.id, 'movimentar'))
      throw new ErroApi(
        'SEM_PERMISSAO',
        opcoes.estoqueId
          ? 'O estoque está fora dos seus estoques permitidos.'
          : 'O estoque da loja está fora dos seus estoques permitidos.',
        {
          campos: {
            [campo]: [
              opcoes.estoqueId
                ? 'Fora dos seus estoques permitidos'
                : 'O estoque da loja está fora dos seus estoques permitidos',
            ],
          },
        },
      );
    if (!e.ativo)
      throw new ErroApi('VALIDACAO', 'Estoque inativo.', { campos: { [campo]: ['Estoque inativo'] } });
    return { estoqueId: e.id, lojaId: e.loja_id };
  }

  private async analisar(
    db: DbEmpresa,
    tipo: TipoImportacao,
    planilha: Planilha,
    opcoes: OpcoesImportacao,
    sessao: SessaoErp,
    destino: DestinoEstoque | null,
  ) {
    const mapa = mapearColunas(planilha.cabecalho, tipo);
    const identifica = [
      'id',
      'nome',
      ...(tipo === 'produtos' ? ['codigo', 'codigo_interno', 'ean'] : ['cpf_cnpj', 'codigo']),
    ];
    if (!identifica.some((c) => c in mapa.indices)) {
      throw new ErroApi(
        'VALIDACAO',
        `Nenhuma coluna reconhecida para identificar o registro (${identifica.join(', ')}). Confira o cabeçalho (linha 1) ou baixe o modelo.`,
      );
    }
    if (opcoes.lojaId) {
      const { rows } = await db.execute(
        sql`select 1 from lojas where id = ${opcoes.lojaId} and excluido_em is null and ativa`,
      );
      if (!rows.length)
        throw new ErroApi('VALIDACAO', 'Loja inexistente ou inativa.', {
          campos: { lojaId: ['Loja inválida'] },
        });
    }
    const linhas: LinhaAnalisada[] =
      tipo === 'produtos'
        ? analisarProdutos(
            planilha.linhas,
            mapa.indices,
            await carregarReferencias(
              db,
              planilha.linhas,
              mapa.indices,
              opcoes.lojaId ?? null,
              destino && opcoes.dataContagem
                ? { estoqueId: destino.estoqueId, dataContagem: opcoes.dataContagem }
                : null,
            ),
            opcoes,
            {
              criarMarcas: sessao.permissoes.has('marcas.criar'),
              criarCategorias: sessao.permissoes.has('categorias.editar'),
              verCusto: sessao.permissoes.has('produtos.ver_custo'),
              estoqueNegativo:
                sessao.master ||
                (!!destino &&
                  (await lerConfiguracao<boolean>(db, 'estoque.permite_negativo_erp', destino.lojaId))),
            },
          )
        : analisarClientes(
            planilha.linhas,
            mapa.indices,
            await carregarReferenciasClientes(db, planilha.linhas, mapa.indices),
          );
    // A planilha não faz o que o usuário não faria no formulário (decisão 85).
    for (const l of linhas) {
      if (l.acao === 'criar' && !sessao.permissoes.has(PERMISSAO_CRIAR[tipo])) {
        l.erros.push(
          tipo === 'produtos'
            ? 'Sem permissão para criar produtos ("Produtos: Criar")'
            : 'Sem permissão para criar pessoas ("Pessoas: Criar")',
        );
        l.acao = 'ignorar';
      } else if (
        (l.acao === 'atualizar' || l.acao === 'inativar') &&
        !sessao.permissoes.has(PERMISSAO_EDITAR[tipo])
      ) {
        l.erros.push(
          tipo === 'produtos'
            ? 'Sem permissão para alterar produtos ("Produtos: Editar")'
            : 'Sem permissão para alterar pessoas ("Pessoas: Editar")',
        );
        l.acao = 'ignorar';
      }
    }
    return { linhas, mapa };
  }

  /** Executor da tarefa: permissão conferida de novo com o usuário do momento. */
  private async executar(tipo: TipoImportacao, e: ExecucaoTarefa) {
    const cx = this.d.tenancy.cx();
    const parametros = e.tarefa.parametros as { arquivoId: string; opcoes: OpcoesImportacao };
    const sessao = await cx.consulta((db) =>
      sessaoDaTarefa(db, this.d.tenancy, this.d.permissoes, e.tarefa.usuarioId!, e.tarefa.id),
    );
    if (!sessao.permissoes.has(PERMISSAO[tipo]))
      throw new Error('O usuário não tem mais a permissão de importar.');
    // Loja, opções e estoque conferidos de novo com o acesso do momento (perdeu a loja, "Acertos: Criar" ou o estoque
    // da loja → falha).
    // Tarefa confirmada antes do F2-B11 (sem a hora da contagem): vale a hora da confirmação, que era o `new Date()`
    // de antes, sem lançar no passado o que o usuário não informou.
    if (parametros.opcoes.atualizarEstoque && !parametros.opcoes.dataContagem)
      parametros.opcoes.dataContagem = new Date(e.tarefa.criadoEm).toISOString();
    let destino: DestinoEstoque | null;
    try {
      this.conferirLoja(sessao, tipo, parametros.opcoes);
      this.conferirOpcoes(sessao, tipo, parametros.opcoes);
      destino = await cx.consulta((db) => this.conferirEstoque(db, sessao, tipo, parametros.opcoes));
    } catch (erro) {
      throw new Error((erro as Error).message, { cause: erro });
    }
    const [arq] = await cx.consulta((db) =>
      db
        .select({ chave: arquivos.chaveArmazenamento, nome: arquivos.nomeOriginal })
        .from(arquivos)
        .where(eq(arquivos.id, parametros.arquivoId)),
    );
    if (!arq) throw new Error('Planilha não encontrada.');
    await e.progresso(1, 'Lendo a planilha');
    const planilha = await lerPlanilha(arq.nome, await this.d.armazenamento.ler(arq.chave));
    const { linhas } = await cx.consulta((db) =>
      this.analisar(db, tipo, planilha, parametros.opcoes, sessao, destino),
    );
    const origem: OrigemAcao = {
      origem: 'importacao',
      usuarioId: sessao.usuarioId,
      usuarioNome: sessao.usuarioNome,
    };
    if (tipo === 'produtos') await this.criarMarcasCategorias(sessao, origem, linhas as LinhaProduto[]);

    const gravadas: Array<{ linha: LinhaAnalisada; id: string }> = [];
    const total = linhas.length || 1;
    let feitas = 0;
    // Combos por último: os componentes cadastrados na mesma planilha já existem quando o combo é gravado.
    const ordem =
      tipo === 'produtos'
        ? [
            ...linhas.filter((l) => !(l as LinhaProduto).composicao),
            ...linhas.filter((l) => (l as LinhaProduto).composicao),
          ]
        : linhas;
    for (const l of ordem) {
      feitas++;
      if (feitas % 25 === 0)
        await e.progresso(5 + (feitas / total) * 85, `Linha ${feitas} de ${linhas.length}`);
      // Linha igual ao cadastro: nada é gravado (nem auditoria nem versão nova para o sync).
      if (l.acao === 'ignorar' || l.acao === 'sem_alteracao') continue;
      try {
        const id = await cx.transacao(
          (tx) =>
            tipo === 'produtos'
              ? this.gravarProduto(tx, sessao, origem, l as LinhaProduto, parametros.opcoes)
              : this.gravarCliente(tx, sessao, origem, l as LinhaCliente),
          { travaVersao: true, esperaSemLimite: true },
        );
        gravadas.push({ linha: l, id });
      } catch (erro) {
        l.erros.push(mensagemErro(erro));
        l.acao = 'ignorar';
      }
    }

    let acertos: Array<{ id: string; codigo: number }> = [];
    if (tipo === 'produtos' && destino && parametros.opcoes.dataContagem) {
      await e.progresso(92, 'Atualizando o estoque');
      // A contagem inteira vai ao "Definir": as linhas gravadas e as iguais ao cadastro (`sem_alteracao`), que
      // também foram contadas (o produto contado com o saldo certo entra com diferença zero).
      const contadas = [
        ...(gravadas as Array<{ linha: LinhaProduto; id: string }>),
        ...(linhas as LinhaProduto[])
          .filter((l) => l.acao === 'sem_alteracao' && l.registroId)
          .map((l) => ({ linha: l, id: l.registroId! })),
      ].sort((x, y) => x.linha.linha - y.linha.linha);
      acertos = await this.acertoEstoque(
        sessao,
        origem,
        destino,
        new Date(parametros.opcoes.dataContagem),
        contadas,
      );
    }

    await e.progresso(96, 'Gerando o relatório');
    const resumo = resumirLinhas(linhas);
    const resultado: ResultadoImportacao = {
      tipo,
      criados: gravadas.filter((g) => g.linha.acao === 'criar').length,
      atualizados: gravadas.filter((g) => g.linha.acao === 'atualizar').length,
      inativados: gravadas.filter((g) => g.linha.acao === 'inativar').length,
      semAlteracao: linhas.filter((l) => l.acao === 'sem_alteracao').length,
      comErro: linhas.filter((l) => l.erros.length).length,
      comAviso: resumo.comAviso,
      porAviso: resumo.porAviso,
      acertoId: acertos[0]?.id ?? null,
      acertoCodigo: acertos[0]?.codigo ?? null,
      acertos,
    };
    const arquivoId = await this.relatorio(sessao, tipo, linhas);
    return { resultado: resultado as unknown as Record<string, unknown>, arquivoId };
  }

  /** "Criar marcas e categorias inexistentes" (8.6): uma transação antes das linhas. */
  private async criarMarcasCategorias(
    sessao: SessaoErp,
    origem: OrigemAcao,
    linhas: LinhaProduto[],
  ): Promise<void> {
    const marcasNovas = new Map<string, string>();
    const categoriasNovas = new Map<string, string[]>();
    for (const l of linhas) {
      if (l.acao === 'ignorar') continue;
      if (l.marcaNova) marcasNovas.set(chaveNome(l.marcaNova), l.marcaNova);
      // Só as que faltam: as existentes vêm com o id (a subcategoria achada pelo nome não é recriada na raiz).
      for (const c of l.categoriaNova ?? [])
        if (!c.id) categoriasNovas.set(c.caminho.map(chaveNome).join('>'), c.caminho);
    }
    if (!marcasNovas.size && !categoriasNovas.size) return;
    const ids = await this.d.tenancy.cx().transacao(
      async (tx) => {
        const marcaIds = new Map<string, string>();
        for (const [chave, nome] of marcasNovas) {
          const { rows } = await tx.execute<{ id: string }>(sql`
            select id from marcas where lower(fn_unaccent(descricao)) = lower(fn_unaccent(${nome})) and excluido_em is null`);
          if (rows[0]) {
            marcaIds.set(chave, rows[0].id);
            continue;
          }
          const [m] = await tx
            .insert(marcas)
            .values({ descricao: nome, criadoPorId: sessao.usuarioId, atualizadoPorId: sessao.usuarioId })
            .returning();
          marcaIds.set(chave, m!.id);
          await this.d.auditoria.registrar(tx, origem, {
            acao: 'criar',
            entidade: 'marcas',
            registroId: m!.id,
            localizacao: LOCALIZACAO.produtos,
            depois: m,
          });
        }
        const categoriaIds = new Map<string, string>();
        for (const [chave, partes] of categoriasNovas) {
          type No = { id: string; caminho: string; caminhoNomes: string; nivel: number };
          let pai: No | null = null;
          for (const nome of partes) {
            const paiId: string | null = (pai as No | null)?.id ?? null;
            const {
              rows,
            }: { rows: Array<{ id: string; caminho: string; caminho_nomes: string; nivel: number }> } =
              await tx.execute<{ id: string; caminho: string; caminho_nomes: string; nivel: number }>(sql`
              select id, caminho, caminho_nomes, nivel from categorias
               where excluido_em is null and categoria_pai_id is not distinct from ${paiId}::uuid
                 and lower(fn_unaccent(nome)) = lower(fn_unaccent(${nome}))`);
            if (rows[0]) {
              pai = {
                id: rows[0].id,
                caminho: rows[0].caminho,
                caminhoNomes: rows[0].caminho_nomes,
                nivel: rows[0].nivel,
              };
              continue;
            }
            const id = uuidv7();
            const nova: No = {
              id,
              caminho: pai ? `${pai.caminho}/${id}` : id,
              caminhoNomes: pai ? `${pai.caminhoNomes} > ${nome}` : nome,
              nivel: pai ? pai.nivel + 1 : 1,
            };
            await tx.execute(sql`
              insert into categorias (id, nome, categoria_pai_id, caminho, caminho_nomes, nivel, criado_por_id, atualizado_por_id)
              values (${id}, ${nome}, ${paiId}, ${nova.caminho}, ${nova.caminhoNomes}, ${nova.nivel},
                      ${sessao.usuarioId}, ${sessao.usuarioId})`);
            await this.d.auditoria.registrar(tx, origem, {
              acao: 'criar',
              entidade: 'categorias',
              registroId: id,
              localizacao: LOCALIZACAO.produtos,
              depois: { nome, ...nova },
            });
            pai = nova;
          }
          if (pai) categoriaIds.set(chave, pai.id);
        }
        return { marcaIds, categoriaIds };
      },
      { travaVersao: true, esperaSemLimite: true },
    );
    for (const l of linhas) {
      if (l.marcaNova) l.dados.marcaId = ids.marcaIds.get(chaveNome(l.marcaNova)) ?? null;
      if (l.categoriaNova) {
        const idsLinha = l.categoriaNova
          .map((c) => c.id ?? ids.categoriaIds.get(c.caminho.map(chaveNome).join('>')))
          .filter((id): id is string => !!id);
        if (idsLinha.length) {
          l.dados.categorias = [...new Set(idsLinha)];
          l.dados.categoriaPrincipalId = idsLinha[0]!;
        }
      }
    }
  }

  private async gravarProduto(
    tx: DbEmpresa,
    sessao: SessaoErp,
    origem: OrigemAcao,
    l: LinhaProduto,
    opcoes: OpcoesImportacao,
  ): Promise<string> {
    const deps = { auditoria: this.d.auditoria, custoCombos: this.d.custoCombos };
    // Histórico do custo recalculado pelo banco (combo) com a origem da importação (migração 0006).
    await tx.execute(sql`set local genesis.origem_preco = 'importacao'`);
    const componentes = l.composicao ? await resolverComposicao(tx, l.composicao) : null;
    const loja =
      opcoes.lojaId && (l.estoqueMinimo !== null || l.precoLoja !== null)
        ? {
            lojaId: opcoes.lojaId,
            ...(l.estoqueMinimo !== null ? { estoqueMinimo: l.estoqueMinimo } : {}),
            ...(l.precoLoja !== null ? { precoVenda: l.precoLoja } : {}),
          }
        : null;
    if (l.acao === 'criar') {
      const dados = criarProdutoSchema.parse({
        ...l.dados,
        lojas: loja ? [loja] : [],
        ...(componentes ? { componentes } : {}),
      });
      return inserirProduto(deps, tx, sessao, origem, dados, {
        importacao: true,
        ...(l.codigo !== null ? { codigo: l.codigo } : {}),
      });
    }
    const id = l.registroId!;
    // Só o estoque (acerto) mudou: o cadastro não é regravado (sem auditoria nem versão nova à toa).
    if (!Object.keys(l.dados).length && !loja && !componentes) return id;
    const atual = await detalheProduto(tx, id, true);
    if (!atual) throw ErroApi.naoEncontrado('Produto excluído depois da prévia.');
    const base = entradaDoDetalhe(atual);
    const codigos = [...(base.codigosBarras ?? [])];
    const novo = l.dados.codigosBarras?.[0];
    if (novo && !codigos.some((c) => c.codigo === novo.codigo))
      codigos.push({ ...novo, principal: !codigos.some((c) => c.principal) });
    const lojas = [...(base.lojas ?? [])];
    if (loja) {
      const i = lojas.findIndex((x) => x.lojaId === loja.lojaId);
      if (i >= 0) lojas[i] = { ...lojas[i]!, ...loja };
      else lojas.push(loja);
    }
    // Composição da planilha só preenche combo ainda sem posições (as do ERP, com alternativas, não são trocadas).
    const semPosicoes = !(base.componentes ?? []).some((c) => c.tipo === 'kit');
    const entrada: CriarProdutoEntrada = {
      ...base,
      ...l.dados,
      codigosBarras: codigos,
      lojas,
      ...(componentes && semPosicoes ? { componentes } : {}),
    };
    const r = criarProdutoSchema.safeParse(entrada);
    if (!r.success)
      throw new ErroApi(
        'VALIDACAO',
        r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    await atualizarProduto(deps, tx, sessao, origem, id, null, r.data, { importacao: true });
    return id;
  }

  private async gravarCliente(
    tx: DbEmpresa,
    sessao: SessaoErp,
    origem: OrigemAcao,
    l: LinhaCliente,
  ): Promise<string> {
    const deps = { auditoria: this.d.auditoria };
    if (l.acao === 'criar') {
      const { senha: _s, removerSenha: _r, ...dados } = criarPessoaSchema.parse(l.dados);
      if (dados.limiteCompras !== null && !sessao.permissoes.has('pessoas.editar_credito'))
        dados.limiteCompras = null;
      return inserirPessoa(deps, tx, sessao, origem, dados, null, 'importacao');
    }
    const id = l.registroId!;
    const atual = await detalhePessoa(tx, id);
    if (!atual) throw ErroApi.naoEncontrado('Pessoa excluída depois da prévia.');
    // Filhas: as da planilha substituem só quando vieram (endereço principal, telefone e e-mail principais).
    const enderecos = l.dados.enderecos
      ? [...atual.enderecos.filter((e) => e.tipo !== 'principal'), ...l.dados.enderecos]
      : atual.enderecos;
    const telefones = l.dados.telefones
      ? [...atual.telefones.map((t) => ({ ...t, principal: false })), ...l.dados.telefones].filter(
          (t, i, todos) => todos.findIndex((x) => `${x.ddd}${x.numero}` === `${t.ddd}${t.numero}`) === i,
        )
      : atual.telefones;
    const emails = l.dados.emails
      ? [...atual.emails.map((m) => ({ ...m, principal: false })), ...l.dados.emails].filter(
          (m, i, todos) => todos.findIndex((x) => x.email === m.email) === i,
        )
      : atual.emails;
    const r = criarPessoaSchema.safeParse({ ...atual, ...l.dados, enderecos, telefones, emails });
    if (!r.success)
      throw new ErroApi(
        'VALIDACAO',
        r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    const { senha: _s, removerSenha: _r, ...dados } = r.data;
    if (!sessao.permissoes.has('pessoas.editar_credito')) dados.limiteCompras = atual.limiteCompras;
    await atualizarPessoa(deps, tx, sessao, origem, id, null, dados);
    return id;
  }

  /**
   * Coluna `estoque_atual` define o saldo (8.6): um acerto "Definir" efetivado com a origem `importacao`
   * (AJUSTE_IMPORTACAO), no estoque escolhido (o da loja ou o CD) e **na hora da contagem informada** (F2-B11): lança
   * nela com `retroativoPermitido`, e as vendas e movimentos posteriores são descontados (ERP 13.1.5), como no
   * "Definir" da tela. Entram todos os produtos contados (os iguais ao saldo com diferença zero: a contagem também os
   * viu, e a venda offline anterior a ela que chegar depois é compensada; F2-B4), desde que algum mude. Acima de
   * `LIMITE_ITENS_ACERTO` produtos, um acerto por parte, com a mesma hora, **cada um na sua transação**: a 7300001
   * (`travaVersao`) e as linhas de saldo são soltas entre as partes, e o push dos PDVs e as gravações do ERP não
   * esperam a planilha inteira (12 mil produtos do Nuvem3 em horário de venda). Cada parte é um acerto completo, com
   * auditoria e estorno próprios; a parte que falha não desfaz as já efetivadas, e a mensagem da tarefa diz quais são.
   */
  private async acertoEstoque(
    sessao: SessaoErp,
    origem: OrigemAcao,
    destino: DestinoEstoque,
    dataContagem: Date,
    contadas: Array<{ linha: LinhaProduto; id: string }>,
  ): Promise<Array<{ id: string; codigo: number }>> {
    const comEstoque = contadas.filter((g) => g.linha.estoqueContado !== null);
    // Nada mudou no saldo: a planilha confirma o que o sistema já tem (sem acerto, como antes).
    if (!comEstoque.some((g) => g.linha.estoqueAtual !== null)) return [];
    const cx = this.d.tenancy.cx();
    const { estoqueId, lojaId } = destino;
    // Produto com variações (o legado da D43) também fica fora: o saldo é por variação, e o item sem ela é recusado
    // ("Escolha a variação"); a análise já o tira da prévia (`analisarProdutos`).
    const { validos, tipoEstoqueId, permiteNegativo } = await cx.consulta(async (db) => {
      const { rows } = await db.execute<{ id: string }>(sql`
        select id from produtos where controla_estoque and tipo not in (${sql.join(
          [...TIPOS_SEM_ESTOQUE, 'com_variacoes'].map((t) => sql`${t}`),
          sql`, `,
        )}) and excluido_em is null
           and id = any(${`{${comEstoque.map((g) => g.id).join(',')}}`}::uuid[])`);
      return {
        validos: new Set(rows.map((r) => r.id)),
        tipoEstoqueId: await resolverTipoEstoque(db, null),
        permiteNegativo:
          sessao.master || (await lerConfiguracao<boolean>(db, 'estoque.permite_negativo_erp', lojaId)),
      };
    });
    const itens = comEstoque
      .filter((g) => validos.has(g.id))
      .filter((g, i, todos) => todos.findIndex((x) => x.id === g.id) === i)
      .map((g) => ({
        id: null,
        produtoId: g.id,
        variacaoId: null,
        quantidade: g.linha.estoqueContado!,
        custoUnitario: null,
      }));
    if (!itens.length) return [];
    const partes: Array<typeof itens> = [];
    for (let i = 0; i < itens.length; i += LIMITE_ITENS_ACERTO)
      partes.push(itens.slice(i, i + LIMITE_ITENS_ACERTO));
    const gerados: Array<{ id: string; codigo: number }> = [];
    for (const [n, parte] of partes.entries()) {
      try {
        gerados.push(
          await cx.transacao(
            async (tx) => {
              const id = uuidv7();
              const [a] = await tx
                .insert(acertosEstoque)
                .values({
                  id,
                  estoqueId,
                  tipoEstoqueId,
                  tipoAjuste: 'definir',
                  dataContagem,
                  motivo: MOTIVO_ACERTO,
                  responsavelId: sessao.usuarioId,
                  origem: 'importacao',
                  observacoes:
                    n > 0
                      ? `Continuação do acerto Nº ${gerados[0]!.codigo} (importação de planilha acima de ${LIMITE_ITENS_ACERTO.toLocaleString('pt-BR')} produtos, parte ${n + 1} de ${partes.length}).`
                      : null,
                  criadoPorId: sessao.usuarioId,
                  atualizadoPorId: sessao.usuarioId,
                })
                .returning({ codigo: acertosEstoque.codigo });
              await gravarItensRascunho(tx, { id, estoqueId, tipoEstoqueId, tipoAjuste: 'definir' }, parte);
              const r = await efetivarAcerto(
                tx,
                { id, estoqueId, tipoEstoqueId, tipoAjuste: 'definir', origem: 'importacao', dataContagem },
                { usuarioId: sessao.usuarioId, permiteNegativo },
              );
              await this.d.auditoria.registrar(tx, origem, {
                acao: 'efetivar',
                entidade: 'acertos_estoque',
                registroId: id,
                localizacao: LOCALIZACAO.produtos,
                lojaId,
                descricao: `Acerto da importação: ${resumoEfetivacao(r)}`,
              });
              return { id, codigo: a!.codigo };
            },
            { travaVersao: true, esperaSemLimite: true },
          ),
        );
      } catch (erro) {
        if (!gerados.length) throw erro;
        // As partes anteriores já estão efetivadas: a tarefa falha dizendo quais, para conferir ou estornar.
        throw new Error(
          `Estoque definido só em parte: acerto(s) Nº ${gerados.map((g) => g.codigo).join(', ')} efetivado(s); a parte ${n + 1} de ${partes.length} falhou (${mensagemErro(erro)}). Confira em Estoques › Acertos.`,
          { cause: erro },
        );
      }
    }
    return gerados;
  }

  /** Relatório final (8.6 "planilha de erros"): linhas com erro ou aviso, gravado para o download da tarefa. */
  private async relatorio(
    sessao: SessaoErp,
    tipo: TipoImportacao,
    linhas: LinhaAnalisada[],
  ): Promise<string | null> {
    const comProblema = linhas.filter((l) => l.erros.length || l.avisos.length);
    if (!comProblema.length) return null;
    const colunas: ColunaExportacao<LinhaAnalisada>[] = [
      { rotulo: 'Linha', valor: (l) => l.linha },
      { rotulo: tipo === 'produtos' ? 'Produto' : 'Cliente', valor: (l) => l.descricao },
      {
        rotulo: 'Situação',
        valor: (l) => (l.erros.length ? 'Não importada' : SITUACAO_RELATORIO[l.acao]),
      },
      {
        rotulo: 'O que mudou',
        valor: (l) =>
          (l.alteracoes ?? []).map((a) => `${a.rotulo}: ${a.de ?? '—'} → ${a.para ?? '—'}`).join(' | ') ||
          null,
      },
      { rotulo: 'Erros', valor: (l) => l.erros.join(' | ') || null },
      {
        rotulo: 'Inconsistências',
        valor: (l) =>
          [...new Set(l.avisos.map((a) => ROTULOS_AVISO_IMPORTACAO[a.codigo]))].join(', ') || null,
      },
      { rotulo: 'Detalhes', valor: (l) => l.avisos.map((a) => a.mensagem).join(' | ') || null },
    ];
    const { conteudo, tipoMime } = await gerarArquivoPlanilha('xlsx', colunas, comProblema);
    const cx = this.d.tenancy.cx();
    const chave = chaveArquivo(cx.contexto.codigo, 'importacao', 'xlsx');
    const { sha256, tamanhoBytes } = await this.d.armazenamento.gravar(chave, conteudo, tipoMime);
    const [a] = await cx.consulta((db) =>
      db
        .insert(arquivos)
        .values({
          chaveArmazenamento: chave,
          nomeOriginal: nomeArquivoExportacao(`Relatorio_importacao_${tipo}`, 'xlsx'),
          tipoMime,
          tamanhoBytes,
          sha256,
          // Saída gerada pelo sistema, não planilha enviada: não pode ser "confirmada" como importação.
          categoria: 'planilha_exportacao',
          entidade: ENTIDADE[tipo],
          retencaoAte: new Date(Date.now() + RETENCAO_DIAS * 86_400_000).toISOString().slice(0, 10),
          criadoPorId: sessao.usuarioId,
          atualizadoPorId: sessao.usuarioId,
        })
        .returning({ id: arquivos.id }),
    );
    return a!.id;
  }
}

function paraPrevia(l: LinhaAnalisada): LinhaPreviaImportacao {
  return {
    linha: l.linha,
    acao: l.acao,
    descricao: l.descricao,
    registroId: l.registroId,
    erros: l.erros,
    avisos: l.avisos,
    ...(l.alteracoes ? { alteracoes: l.alteracoes } : {}),
  };
}

const SITUACAO_RELATORIO: Record<LinhaPreviaImportacao['acao'], string> = {
  criar: 'Criada',
  atualizar: 'Atualizada',
  sem_alteracao: 'Sem alteração',
  inativar: 'Inativada',
  ignorar: 'Ignorada',
};

/** Mensagem do erro de uma linha (ErroApi com os campos ou erro do banco). */
function mensagemErro(e: unknown): string {
  if (e instanceof ErroApi) {
    const campos = Object.entries(e.extras.campos ?? {}).map(
      ([c, m]) => `${c}: ${(m as string[]).join(', ')}`,
    );
    return [e.message, ...campos].join(' — ');
  }
  return (e as Error).message ?? String(e);
}
