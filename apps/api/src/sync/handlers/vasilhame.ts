/**
 * Handler do `vasilhame.movimentado` (SYNC 9.26, 10.1; MD 3.12.6; bloco C7 da 1C): a devolução **avulsa** de cascos
 * vazios, sem compra (PDV 10.12, `F11` › `V`). Na Fase 1 só existe o destino `entrada` (T2; dono, O14): grava
 * `movimentos_vasilhame` e dá entrada dos vazios como `VASILHAME_DEVOLVIDO` no tipo `vasilhame_vazio` do estoque do
 * contexto (ou do da loja, com `ESTOQUE_CONTEXTO_INVALIDO`, como a venda), com `documento_tipo = 'vasilhame'` e o
 * próprio movimento como documento e item (`documento_id = documento_item_id = movimentos_vasilhame.id`: o documento
 * tem uma linha só, e o índice de idempotência fica coberto sem id derivado). A entrada não traz custo novo: entra ao
 * custo médio da linha (ou ao de referência do casco), como os vazios trazidos na venda. Casco que não controla estoque
 * grava o movimento sem estoque. Entrada anterior a um "Definir" ganha a compensação (15.3). Produto que não é casco
 * (`tipo` diferente de `vasilhame`, MD 3.12.6) → `PAYLOAD_INVALIDO`.
 *
 * `baixa_comodato` e `vale` são da Fase 3 (comodato e crédito do casco em vale): `PAYLOAD_INVALIDO` (erro
 * permanente), como os `emprestados` da venda. Reenvio igual → `ja_existia`; outro conteúdo para o mesmo id →
 * `AGREGADO_DIVERGENTE`.
 */
import {
  decTexto,
  payloadVasilhameMovimentadoSchema,
  type PayloadVasilhameMovimentado,
} from '@genesis/shared';
import { eq } from 'drizzle-orm';
import { compensarDefinir } from '../../estoques/compensacao.js';
import { lancarDocumento, lerCadastrosEstoque, type CadastrosEstoque } from '../../estoques/movimentos.js';
import { movimentosVasilhame } from '../../database/empresa/schema/index.js';
import { ErroRegraEvento } from '../erros.js';
import {
  agregadoDivergente,
  colunasDivergentes,
  conferirEscopoLinha,
  registrarAuditoriaPdv,
  type CatalogoHandlers,
  type ContextoHandler,
  type DependenciaEvento,
} from './comum.js';
import {
  ALERTA_ESTOQUE_CONTEXTO_INVALIDO,
  alertarEstoqueContexto,
  conferirCascos,
  conferirSessaoDoDocumento,
  escolherEstoque,
  estoqueDoContexto,
  resolverAliases,
  resolverPessoa,
  type EstoqueEscolhido,
} from './vendas.js';

/** Destinos que a Fase 1 aplica (T2); os demais são da Fase 3. */
const DESTINOS_ACEITOS: readonly string[] = ['entrada'];

/** Colunas que só o cancelamento da devolução muda (sem evento na 1C): fora do reenvio. */
const COLUNAS_CANCELAMENTO_VASILHAME = ['cancelado', 'canceladoEm', 'canceladoPorId', 'motivoCancelamento'];

const minusculo = (v: string) => v.toLowerCase();

interface DevolucaoPreparada {
  cadastros: CadastrosEstoque;
  estoque: EstoqueEscolhido;
  pessoaId: string | null;
}

/**
 * Só lendo, antes da trava 7300001 (T21): escopo, destino, sessão, pessoa (aliases), o casco (existe e é do tipo
 * `vasilhame`) e o estoque.
 */
async function prepararDevolucao(
  ctx: ContextoHandler,
  p: PayloadVasilhameMovimentado,
): Promise<DevolucaoPreparada> {
  const { tx, terminal } = ctx;
  const m = p.movimentos_vasilhame;
  conferirEscopoLinha(m, terminal, 'movimentos_vasilhame');
  if (!DESTINOS_ACEITOS.includes(m.destino) || p.vales.length || p.movimentos_vale.length) {
    throw new ErroRegraEvento(
      'PAYLOAD_INVALIDO',
      `Devolução de cascos com destino ${m.destino} ainda não é aceita (comodato e vale: Fase 3).`,
      { destino: m.destino },
    );
  }
  await conferirSessaoDoDocumento(ctx, m.sessao_caixa_id, 'da devolução de cascos');
  const pessoas = await resolverAliases(tx, m.pessoa_id ? [m.pessoa_id] : []);
  const contexto = estoqueDoContexto(ctx);
  const casco = minusculo(m.produto_vasilhame_id);
  const cadastros = await lerCadastrosEstoque(tx, {
    produtoIds: [casco],
    estoqueIds: contexto ? [contexto] : [],
  });
  if (!cadastros.produtos.has(casco)) {
    throw new ErroRegraEvento('REFERENCIA_INEXISTENTE', 'Casco da devolução inexistente na empresa.', {
      produtos: [casco],
    });
  }
  conferirCascos([casco], cadastros, 'da devolução');
  return {
    cadastros,
    estoque: await escolherEstoque(ctx, cadastros),
    pessoaId: resolverPessoa({ pessoas }, m.pessoa_id),
  };
}

async function aplicarDevolucao(
  ctx: ContextoHandler,
  p: PayloadVasilhameMovimentado,
  prep: DevolucaoPreparada,
) {
  const { tx, terminal } = ctx;
  const m = p.movimentos_vasilhame;
  const id = minusculo(m.id);
  const valores = {
    id,
    sessaoCaixaId: minusculo(m.sessao_caixa_id),
    lojaId: minusculo(m.loja_id),
    caixaId: minusculo(m.caixa_id),
    terminalId: terminal.terminalId,
    operadorId: minusculo(m.operador_id),
    pessoaId: prep.pessoaId,
    produtoVasilhameId: minusculo(m.produto_vasilhame_id),
    quantidade: decTexto(m.quantidade, 3),
    destino: m.destino,
    valeId: null,
    ocorridoEm: new Date(m.ocorrido_em),
  };
  const [gravado] = await tx.select().from(movimentosVasilhame).where(eq(movimentosVasilhame.id, id));
  if (gravado) {
    const divergentes = colunasDivergentes(gravado, valores, COLUNAS_CANCELAMENTO_VASILHAME);
    if (divergentes.length) throw agregadoDivergente('movimentos_vasilhame', id, divergentes);
    return { movimento_vasilhame_id: id, ja_existia: true };
  }
  await tx.insert(movimentosVasilhame).values(valores);
  const casco = prep.cadastros.produtos.get(valores.produtoVasilhameId)!;
  const tipoVazio = prep.cadastros.tipoEstoqueVasilhameVazioId;
  let movimentos = 0;
  let compensacoes = 0;
  if (casco.controlaEstoque) {
    if (!tipoVazio) throw new Error('Empresa sem o tipo de estoque vasilhame_vazio');
    const doc = await lancarDocumento(tx, [
      {
        estoqueId: prep.estoque.estoqueId,
        produtoId: valores.produtoVasilhameId,
        variacaoId: null,
        tipoEstoqueId: tipoVazio,
        tipoMovimento: 'VASILHAME_DEVOLVIDO',
        quantidade: valores.quantidade,
        // Entrada dos vazios ao custo médio da linha (ou ao de referência do casco): não traz custo novo.
        custoUnitario: null,
        custoReferencia: casco.precoCusto,
        precoVenda: null,
        dataMovimento: valores.ocorridoEm,
        lojaId: terminal.lojaId,
        usuarioId: valores.operadorId,
        documentoTipo: 'vasilhame',
        documentoId: id,
        documentoItemId: id,
        unidadeDocumento: casco.sigla,
        pessoaId: prep.pessoaId,
        terminalId: terminal.terminalId,
        eventoId: ctx.evento.evento_id,
      },
    ]);
    movimentos = doc.movimentos.length;
    compensacoes = (await compensarDefinir(tx, doc.movimentos, 'devolução de cascos')).length;
  }
  const alertaEstoque = await alertarEstoqueContexto(ctx, prep.estoque, {
    entidade: 'movimentos_vasilhame',
    registroId: id,
    documento: 'recebeu cascos',
  });
  const caixa = String(terminal.numeroCaixa).padStart(2, '0');
  const quantidade = Number(valores.quantidade).toLocaleString('pt-BR');
  await registrarAuditoriaPdv(ctx, {
    entidade: 'movimentos_vasilhame',
    registroId: id,
    acao: 'movimentar',
    localizacao: 'PDV › Vasilhames',
    descricao: `Devolução avulsa de ${quantidade} ${casco.sigla} de ${casco.nome} no caixa ${caixa}`,
    usuarioId: valores.operadorId,
    ocorridoEm: valores.ocorridoEm,
    depois: {
      destino: m.destino,
      produto_vasilhame_id: valores.produtoVasilhameId,
      quantidade: valores.quantidade,
      pessoa_id: prep.pessoaId,
      estoque_id: prep.estoque.estoqueId,
      movimentos_estoque: movimentos,
    },
  });
  return {
    movimento_vasilhame_id: id,
    movimentos,
    ...(compensacoes ? { compensacoes } : {}),
    ...(alertaEstoque ? { alertas: [ALERTA_ESTOQUE_CONTEXTO_INVALIDO] } : {}),
  };
}

export const HANDLERS_VASILHAME: CatalogoHandlers = {
  'vasilhame.movimentado': {
    1: {
      schema: payloadVasilhameMovimentadoSchema,
      // SYNC 9.26, 8.5: a sessão e a pessoa local, se for o caso.
      async dependencias(_ctx, p: PayloadVasilhameMovimentado): Promise<DependenciaEvento[]> {
        const m = p.movimentos_vasilhame;
        return [
          { agregado_tipo: 'sessao_caixa', agregado_id: m.sessao_caixa_id },
          ...(m.pessoa_id ? [{ agregado_tipo: 'pessoa', agregado_id: m.pessoa_id }] : []),
        ];
      },
      preparar: prepararDevolucao,
      aplicar: aplicarDevolucao,
    },
  },
};
