import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  alterarTransferenciaSchema,
  cancelarTransferenciaSchema,
  criarTransferenciaSchema,
  type DestinoTransferenciaOpcao,
  enviarTransferenciaSchema,
  excluirTransferenciaSchema,
  filtroTransferenciasSchema,
  limiteDeslocamento,
  nfeExternaTransferenciaSchema,
  type Pagina,
  receberTransferenciaSchema,
  type StatusTransferencia,
  type TransferenciaDetalhe,
  type TransferenciaResumo,
  tratarDivergenciaTransferenciaSchema,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { conflitoVersao, ordemDaQuery } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { inicioDoDiaNaEmpresa } from '../comum/fuso.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import { transferenciasEstoque } from '../database/empresa/schema/index.js';
import { lojaDoEstoque, resumoEfetivacao } from '../estoques/acertos.js';
import { estoquePermitido, estoqueVisivel } from '../estoques/permitidos.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import {
  receberTransferencia,
  resumoRecebimento,
  resumoTratamento,
  tratarDivergenciaTransferencia,
} from './recebimento.js';
import {
  cancelarTransferencia,
  conferirCabecalhoTransferencia,
  detalheTransferencia,
  enviarTransferencia,
  gravarItensTransferencia,
  resumoCancelamento,
  resumoEnvio,
  sqlVersaoTransferencia,
  type TransferenciaATratar,
} from './transferencias.js';

const LOCALIZACAO = 'Estoque › Transferências';

const colunasOrdenacao = {
  codigo: sql`t.codigo`,
  data: sql`t.data`,
  enviada_em: sql`t.enviada_em`,
  recebida_em: sql`t.recebida_em`,
  origem: sql`lower(eo.nome)`,
  destino: sql`lower(ed.nome)`,
  status: sql`t.status`,
};

interface LinhaTransferencia extends TransferenciaATratar {
  versao: number;
  atualizadoPorId: string | null;
  atualizadoEm: Date;
}

/**
 * A transferência é visível para quem vê a origem **ou** o destino (ERP 13.7; decisão 149): o CD que despacha e a loja
 * que vai receber (F2-B24). Fora dos dois, 404, como inexistente.
 */
function filtroVisivel(sessao: SessaoErp): SQL | undefined {
  const origem = estoqueVisivel(sessao, sql`t.estoque_origem_id`);
  const destino = estoqueVisivel(sessao, sql`t.estoque_destino_id`);
  return origem && destino ? sql`(${origem} or ${destino})` : undefined;
}

/**
 * Transferência entre estoques (ERP 13.7; MD 3.7.6; Fase 2, F2-B23 e F2-B24; README da API › decisões 171 e 172):
 * listagem, detalhe, o rascunho (criar, alterar, excluir), **enviar** (1ª etapa: `TRANSF_SAIDA` na origem; no modo de
 * uma etapa, já recebe tudo), **receber** (2ª etapa: `TRANSF_ENTRADA` no destino), **tratar a divergência** (retorno à
 * origem ou perda) e **cancelar** (do rascunho, sem efeito; do trânsito, `TRANSF_RETORNO` integral), e a anotação da
 * NF-e emitida por fora (D6). Vê quem tem a origem ou o destino entre os estoques visíveis; gravar, enviar, cancelar e
 * anotar a NF-e exigem a **origem** permitida para movimentar (403), e o destino não precisa estar permitido (o
 * seletor lê `GET /transferencias/destinos`, sem o filtro dos permitidos); receber exige o **destino** permitido, e
 * tratar a diferença, a origem ou o destino. As etapas que movimentam rodam com `travaVersao`: o movimento e o saldo
 * descem ao PDV pelo fluxo `estoque`.
 */
@Controller('transferencias')
export class TransferenciasController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('transferencias.ver')
  @Get()
  async listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<Pagina<TransferenciaResumo>> {
    const q = validar(filtroTransferenciasSchema, query);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const condicoes: SQL[] = [sql`t.excluido_em is null`];
    const visivel = filtroVisivel(sessao);
    if (visivel) condicoes.push(visivel);
    if (q.codigo) condicoes.push(sql`t.codigo = ${q.codigo}`);
    if (q.estoqueOrigemId) condicoes.push(sql`t.estoque_origem_id = ${q.estoqueOrigemId}`);
    if (q.estoqueDestinoId) condicoes.push(sql`t.estoque_destino_id = ${q.estoqueDestinoId}`);
    if (q.status) condicoes.push(sql`t.status = ${q.status}`);
    // "Data de criação" é a data do documento; "Data da transferência", o dia do envio no fuso da empresa.
    if (q.periodo === 'criacao') {
      if (q.dataInicial) condicoes.push(sql`t.data >= ${q.dataInicial}::date`);
      if (q.dataFinal) condicoes.push(sql`t.data <= ${q.dataFinal}::date`);
    } else {
      if (q.dataInicial)
        condicoes.push(sql`t.enviada_em >= ${inicioDoDiaNaEmpresa(sql`${q.dataInicial}::date`)}`);
      if (q.dataFinal)
        condicoes.push(sql`t.enviada_em < ${inicioDoDiaNaEmpresa(sql`(${q.dataFinal}::date + 1)`)}`);
    }
    const onde = sql.join(condicoes, sql` and `);
    const ordem = ordemDaQuery(q, colunasOrdenacao, 'codigo:desc', sql`t.codigo`);
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        select t.id, t.codigo, t.estoque_origem_id, eo.nome as origem_nome, t.estoque_destino_id,
               ed.nome as destino_nome, t.data::text as data, t.enviada_em, t.recebida_em, t.qtd_itens, t.status,
               ${sqlVersaoTransferencia} as versao
          from transferencias_estoque t
          join estoques eo on eo.id = t.estoque_origem_id
          join estoques ed on ed.id = t.estoque_destino_id
         where ${onde}
         order by ${sql.join(ordem, sql`, `)}
         limit ${limite} offset ${deslocamento}`);
      const { rows: total } = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from transferencias_estoque t where ${onde}`);
      const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
      return {
        itens: rows.map((r) => ({
          id: r.id as string,
          codigo: r.codigo as number,
          estoqueOrigemId: r.estoque_origem_id as string,
          estoqueOrigemNome: r.origem_nome as string,
          estoqueDestinoId: r.estoque_destino_id as string,
          estoqueDestinoNome: r.destino_nome as string,
          data: r.data as string,
          enviadaEm: iso(r.enviada_em),
          recebidaEm: iso(r.recebida_em),
          qtdItens: r.qtd_itens as number,
          status: r.status as StatusTransferencia,
          versao: Number(r.versao),
        })),
        total: total[0]?.n ?? 0,
        pagina: q.pagina,
        tamanho: q.tamanho,
      };
    });
  }

  /**
   * Opções do seletor "Destino" do rascunho (ERP 13.7): todo estoque vivo e **ativo** da empresa, **sem** o filtro dos
   * estoques permitidos (o destino não precisa ser permitido para quem envia, e o `GET /estoques` só mostra os
   * visíveis), com a loja do estoque (a de menor código; nula no CD). Só a identificação, sem saldo nem custo; a
   * própria origem não sai da lista (a tela a esconde, e a API recusa origem = destino no schema).
   */
  @Permissao('transferencias.criar')
  @Get('destinos')
  async destinos(): Promise<DestinoTransferenciaOpcao[]> {
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<{
        id: string;
        codigo: number;
        nome: string;
        tipo: DestinoTransferenciaOpcao['tipo'];
        loja_id: string | null;
        loja_nome: string | null;
      }>(sql`
        select e.id, e.codigo, e.nome, e.tipo, l.id as loja_id, l.nome as loja_nome
          from estoques e
          left join lateral (select l.id, l.nome from lojas l
                              where l.estoque_id = e.id and l.excluido_em is null order by l.codigo limit 1) l on true
         where e.excluido_em is null and e.ativo
         order by lower(e.nome), e.codigo`);
      return rows.map((r) => ({
        id: r.id,
        codigo: r.codigo,
        nome: r.nome,
        tipo: r.tipo,
        lojaId: r.loja_id,
        lojaNome: r.loja_nome,
      }));
    });
  }

  @Permissao('transferencias.ver')
  @Get(':id')
  async obter(@Param('id') idBruto: string, @Sessao() sessao: SessaoErp): Promise<TransferenciaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const d = await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao));
    if (!d) throw ErroApi.naoEncontrado('Transferência não encontrada.');
    return d;
  }

  /** Cria o rascunho (origem permitida, destino qualquer estoque ativo da empresa). */
  @Permissao('transferencias.criar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<TransferenciaDetalhe> {
    const dados = validar(criarTransferenciaSchema, corpo);
    const id = await this.s.tenancy.cx().transacao(async (tx) => {
      const cab = await conferirCabecalhoTransferencia(tx, dados, sessao);
      const id = uuidv7();
      await tx.insert(transferenciasEstoque).values({
        id,
        estoqueOrigemId: cab.estoqueOrigemId,
        estoqueDestinoId: cab.estoqueDestinoId,
        tipoEstoqueId: cab.tipoEstoqueId,
        data: cab.data,
        motivo: dados.motivo,
        observacoes: dados.observacoes,
        nfeExternaChave: dados.nfeExternaChave,
        nfeExternaNumero: dados.nfeExternaNumero,
        criadoPorId: sessao.usuarioId,
        atualizadoPorId: sessao.usuarioId,
      });
      await gravarItensTransferencia(tx, { id, estoqueOrigemId: cab.estoqueOrigemId }, dados.itens);
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'criar',
        entidade: 'transferencias_estoque',
        registroId: id,
        localizacao: LOCALIZACAO,
        lojaId: cab.lojaOrigemId,
        depois: { ...dados, ...cab },
      });
      return id;
    });
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /** Altera o rascunho inteiro (cabeçalho e itens) conferindo a versão do documento (409 se outro mexeu). */
  @Permissao('transferencias.criar')
  @Put(':id')
  async alterar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<TransferenciaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, ...dados } = validar(alterarTransferenciaSchema, corpo);
    await this.s.tenancy.cx().transacao(async (tx) => {
      const antes = await this.travar(tx, id, sessao, versao);
      exigirOrigemPermitida(sessao, antes);
      exigirRascunho(antes);
      const cab = await conferirCabecalhoTransferencia(tx, dados, sessao);
      await tx.execute(sql`
        update transferencias_estoque
           set estoque_origem_id = ${cab.estoqueOrigemId}, estoque_destino_id = ${cab.estoqueDestinoId},
               tipo_estoque_id = ${cab.tipoEstoqueId}, data = ${cab.data}::date, motivo = ${dados.motivo},
               observacoes = ${dados.observacoes}, nfe_externa_chave = ${dados.nfeExternaChave},
               nfe_externa_numero = ${dados.nfeExternaNumero}, atualizado_por_id = ${sessao.usuarioId}
         where id = ${id}`);
      await gravarItensTransferencia(tx, { id, estoqueOrigemId: cab.estoqueOrigemId }, dados.itens);
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'editar',
        entidade: 'transferencias_estoque',
        registroId: id,
        localizacao: LOCALIZACAO,
        lojaId: cab.lojaOrigemId,
        antes,
        depois: { ...dados, ...cab },
      });
    });
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /**
   * Só o rascunho é excluído (logicamente, com os itens); depois do envio, só se cancela (o trigger também recusa).
   * `?versao=` confere a versão do documento, quando informada.
   */
  @Permissao('transferencias.criar')
  @Delete(':id')
  @HttpCode(204)
  async excluir(
    @Param('id') idBruto: string,
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<void> {
    const id = validar(z.uuid(), idBruto);
    const { versao } = validar(excluirTransferenciaSchema, query ?? {});
    await this.s.tenancy.cx().transacao(async (tx) => {
      const antes = await this.travar(tx, id, sessao, versao);
      exigirOrigemPermitida(sessao, antes);
      exigirRascunho(antes);
      await tx.execute(sql`
        update itens_transferencia set excluido_em = now() where transferencia_id = ${id} and excluido_em is null`);
      await tx.execute(sql`
        update transferencias_estoque set excluido_em = now(), atualizado_por_id = ${sessao.usuarioId}
         where id = ${id}`);
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'excluir',
        entidade: 'transferencias_estoque',
        registroId: id,
        localizacao: LOCALIZACAO,
        lojaId: await lojaDoEstoque(tx, antes.estoqueOrigemId),
        antes,
      });
    });
  }

  /**
   * Enviar (ERP 13.7, 1ª etapa): `TRANSF_SAIDA` ao custo médio da origem, com o saldo conferido (SYNC 15.1: o ERP não
   * deixa negativo, salvo Master ou `estoque.permite_negativo_erp` da loja da origem). **Idempotente**: a transferência
   * já enviada (em trânsito ou recebida) devolve o detalhe sem lançar nada nem conferir a versão (o clique repetido, a
   * resposta perdida e duas chamadas juntas — a trava do cabeçalho serializa, e a segunda relê a situação — não dobram
   * a saída); a cancelada é 422. **Modo de uma etapa** (`estoque.transferencia_recebimento_automatico`, chave da
   * empresa: o catálogo não a aceita por loja, então ligada vale para toda transferência; ERP 13.7 "Uma etapa"; lida
   * com a loja da origem, como as demais, para valer por loja se o catálogo um dia aceitar): na mesma transação, o envio
   * já recebe tudo como enviado (`TRANSF_ENTRADA` no destino), com quem enviou como quem recebeu — a chave é a
   * autorização, e quem envia não precisa do destino permitido nem de `transferencias.receber`.
   */
  @Permissao('transferencias.enviar')
  @Post(':id/enviar')
  @HttpCode(200)
  async enviar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<TransferenciaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao } = validar(enviarTransferenciaSchema, corpo ?? {});
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await this.travar(tx, id, sessao);
        exigirOrigemPermitida(sessao, antes);
        if (antes.status === 'cancelada')
          throw new ErroApi('REGRA_NEGOCIO', 'Transferência cancelada não pode ser enviada.');
        if (antes.status !== 'rascunho') return;
        if (versao !== undefined && antes.versao !== versao) await conflitoVersao(tx, antes);
        const lojaId = await lojaDoEstoque(tx, antes.estoqueOrigemId);
        const permiteNegativo =
          sessao.master || (await lerConfiguracao<boolean>(tx, 'estoque.permite_negativo_erp', lojaId));
        const r = await enviarTransferencia(tx, antes, { usuarioId: sessao.usuarioId, permiteNegativo });
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'movimentar',
          entidade: 'transferencias_estoque',
          registroId: id,
          localizacao: LOCALIZACAO,
          lojaId,
          descricao: `Transferência Nº ${antes.codigo} enviada: ${resumoEnvio(r)}`,
        });
        if (await lerConfiguracao<boolean>(tx, 'estoque.transferencia_recebimento_automatico', lojaId)) {
          const rec = await receberTransferencia(
            tx,
            { ...antes, status: 'em_transito' },
            { usuarioId: sessao.usuarioId },
            { receberTudo: true, itens: [] },
          );
          await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
            acao: 'movimentar',
            entidade: 'transferencias_estoque',
            registroId: id,
            localizacao: LOCALIZACAO,
            lojaId: await lojaDoEstoque(tx, antes.estoqueDestinoId),
            descricao: `Transferência Nº ${antes.codigo} recebida no envio (recebimento automático): ${resumoRecebimento(rec)}`,
          });
        }
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /**
   * Receber (ERP 13.7, 2ª etapa): a quantidade conferida de cada item, ou "Receber tudo como enviado" (`receberTudo`);
   * `TRANSF_ENTRADA` no destino com o custo da saída, e a situação passa a `recebida` ou, com item a menor,
   * `recebida_divergencia`. Exige `transferencias.receber` e o **destino** entre os estoques permitidos para movimentar
   * (403; quem só tem a origem não recebe pela loja). **Idempotente** como o envio: a já recebida (com ou sem
   * divergência) devolve o detalhe sem lançar nem conferir a versão (o clique repetido, a resposta perdida); o rascunho
   * e a cancelada são 422.
   */
  @Permissao('transferencias.receber')
  @Post(':id/receber')
  @HttpCode(200)
  async receber(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<TransferenciaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, receberTudo, itens } = validar(receberTransferenciaSchema, corpo ?? {});
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await this.travar(tx, id, sessao);
        exigirDestinoPermitido(sessao, antes);
        if (antes.status === 'rascunho')
          throw new ErroApi('REGRA_NEGOCIO', 'A transferência ainda não foi enviada: não há o que receber.');
        if (antes.status === 'cancelada')
          throw new ErroApi('REGRA_NEGOCIO', 'Transferência cancelada não pode ser recebida.');
        if (antes.status !== 'em_transito') return;
        if (versao !== undefined && antes.versao !== versao) await conflitoVersao(tx, antes);
        const r = await receberTransferencia(
          tx,
          antes,
          { usuarioId: sessao.usuarioId },
          { receberTudo, itens },
        );
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'movimentar',
          entidade: 'transferencias_estoque',
          registroId: id,
          localizacao: LOCALIZACAO,
          lojaId: await lojaDoEstoque(tx, antes.estoqueDestinoId),
          descricao: `Transferência Nº ${antes.codigo} recebida${r.status === 'recebida_divergencia' ? ' com divergência' : ''}: ${resumoRecebimento(r)}`,
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /**
   * Tratar a diferença recebida a menor (ERP 13.7 "Divergência"), por item, uma vez cada: "Retornar à origem"
   * (`TRANSF_RETORNO` da diferença) ou "Baixar como perda" (F2-Q10 = D51, padrão até a confirmação do dono: o retorno
   * mais o acerto de Saída na origem com a origem `perda_transferencia`). Sem diferença pendente, a transferência passa
   * a `recebida`. Exige `transferencias.receber` e a origem **ou** o destino permitidos para movimentar (padrão até a
   * confirmação do dono, D61: quem recebeu e quem enviou decidem; os movimentos são todos na origem). Só na
   * `recebida_divergencia` (422 nas outras), com a versão conferida quando informada.
   */
  @Permissao('transferencias.receber')
  @Post(':id/tratar-divergencia')
  @HttpCode(200)
  async tratarDivergencia(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<TransferenciaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, itens } = validar(tratarDivergenciaTransferenciaSchema, corpo ?? {});
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await this.travar(tx, id, sessao, versao);
        if (
          !estoquePermitido(sessao, antes.estoqueOrigemId, 'movimentar') &&
          !estoquePermitido(sessao, antes.estoqueDestinoId, 'movimentar')
        )
          throw new ErroApi(
            'SEM_PERMISSAO',
            'A origem e o destino da transferência estão fora dos seus estoques permitidos: só quem tem um deles trata a diferença.',
          );
        if (antes.status !== 'recebida_divergencia')
          throw new ErroApi(
            'REGRA_NEGOCIO',
            antes.status === 'recebida'
              ? 'A transferência não tem diferença a tratar.'
              : 'Só a transferência recebida com divergência tem diferença a tratar.',
          );
        const r = await tratarDivergenciaTransferencia(tx, antes, { usuarioId: sessao.usuarioId }, itens);
        const origem = origemDaRequisicao(req);
        const lojaOrigem = await lojaDoEstoque(tx, antes.estoqueOrigemId);
        if (r.acerto) {
          // O acerto da perda é um documento próprio (aparece na tela de acertos): criado e efetivado, como o "Ajustar".
          await this.s.auditoria.registrar(tx, origem, {
            acao: 'criar',
            entidade: 'acertos_estoque',
            registroId: r.acerto.id,
            localizacao: LOCALIZACAO,
            lojaId: lojaOrigem,
            descricao: `Perda da transferência Nº ${antes.codigo} (acerto Nº ${r.acerto.codigo})`,
          });
          await this.s.auditoria.registrar(tx, origem, {
            acao: 'efetivar',
            entidade: 'acertos_estoque',
            registroId: r.acerto.id,
            localizacao: LOCALIZACAO,
            lojaId: lojaOrigem,
            descricao: `Acerto efetivado: ${resumoEfetivacao(r.acerto)}`,
          });
        }
        await this.s.auditoria.registrar(tx, origem, {
          acao: 'movimentar',
          entidade: 'transferencias_estoque',
          registroId: id,
          localizacao: LOCALIZACAO,
          lojaId: lojaOrigem,
          descricao: `Diferença da transferência Nº ${antes.codigo} tratada: ${resumoTratamento(r)}`,
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /**
   * Cancelar com motivo (ERP 13.7): do rascunho, sem efeito no estoque; do trânsito, `TRANSF_RETORNO` integral de cada
   * saída, ao custo dela (T20). A recebida (ou com divergência) não se cancela: faz-se uma transferência inversa. A
   * já cancelada é 422 (como o estorno repetido do recebimento).
   */
  @Permissao('transferencias.cancelar')
  @Post(':id/cancelar')
  @HttpCode(200)
  async cancelar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<TransferenciaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, motivo } = validar(cancelarTransferenciaSchema, corpo ?? {});
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await this.travar(tx, id, sessao, versao);
        exigirOrigemPermitida(sessao, antes);
        if (antes.status === 'cancelada')
          throw new ErroApi('REGRA_NEGOCIO', 'A transferência já foi cancelada.');
        if (antes.status !== 'rascunho' && antes.status !== 'em_transito')
          throw new ErroApi(
            'REGRA_NEGOCIO',
            'Transferência recebida não se cancela: faça uma transferência no sentido inverso.',
          );
        const r = await cancelarTransferencia(tx, antes, { usuarioId: sessao.usuarioId, motivo });
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'cancelar',
          entidade: 'transferencias_estoque',
          registroId: id,
          localizacao: LOCALIZACAO,
          lojaId: await lojaDoEstoque(tx, antes.estoqueOrigemId),
          descricao: `Transferência Nº ${antes.codigo} cancelada (${resumoCancelamento(r, antes.status === 'rascunho')}): ${motivo}`,
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /**
   * Anota a NF-e de transferência emitida por fora (D6: Nuvem3/contador, entre CNPJs diferentes), em qualquer situação
   * menos a cancelada (no rascunho ela também vai junto do `PUT`): a nota costuma sair na expedição, depois do envio.
   * Só anota: nada se emite nem se consulta (sem SEFAZ). Quem envia é quem anota (`transferencias.enviar` e a origem).
   */
  @Permissao('transferencias.enviar')
  @Put(':id/nfe-externa')
  async anotarNfeExterna(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<TransferenciaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, nfeExternaChave, nfeExternaNumero } = validar(nfeExternaTransferenciaSchema, corpo ?? {});
    await this.s.tenancy.cx().transacao(async (tx) => {
      const antes = await this.travar(tx, id, sessao, versao);
      exigirOrigemPermitida(sessao, antes);
      if (antes.status === 'cancelada')
        throw new ErroApi('REGRA_NEGOCIO', 'Transferência cancelada não muda mais.');
      const { rows } = await tx.execute<{
        nfe_externa_chave: string | null;
        nfe_externa_numero: string | null;
      }>(sql`
        select nfe_externa_chave, nfe_externa_numero from transferencias_estoque where id = ${id}`);
      await tx.execute(sql`
        update transferencias_estoque
           set nfe_externa_chave = ${nfeExternaChave}, nfe_externa_numero = ${nfeExternaNumero},
               atualizado_por_id = ${sessao.usuarioId}
         where id = ${id}`);
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'editar',
        entidade: 'transferencias_estoque',
        registroId: id,
        localizacao: LOCALIZACAO,
        lojaId: await lojaDoEstoque(tx, antes.estoqueOrigemId),
        descricao: `NF-e de fora da transferência Nº ${antes.codigo} anotada`,
        antes: {
          nfeExternaChave: rows[0]?.nfe_externa_chave ?? null,
          nfeExternaNumero: rows[0]?.nfe_externa_numero ?? null,
        },
        depois: { nfeExternaChave, nfeExternaNumero },
      });
    });
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  private detalhe(db: DbEmpresa, id: string, sessao: SessaoErp): Promise<TransferenciaDetalhe | null> {
    return detalheTransferencia(db, id, sessao, filtroVisivel(sessao));
  }

  /**
   * Lê com `for update` (a origem ou o destino visível: fora dos dois, 404) e confere a versão agregada do documento,
   * quando informada. A versão sai de uma **segunda instrução**, depois da trava (READ COMMITTED: a subconsulta dos
   * itens na mesma instrução ficaria no instantâneo de antes da espera; o mesmo cuidado do recebimento e do acerto).
   */
  private async travar(
    tx: DbEmpresa,
    id: string,
    sessao: SessaoErp,
    versao?: number,
  ): Promise<LinhaTransferencia> {
    const visivel = filtroVisivel(sessao);
    const { rows } = await tx.execute<Record<string, unknown>>(sql`
      select t.id, t.codigo, t.status, t.estoque_origem_id, t.estoque_destino_id, t.tipo_estoque_id,
             t.atualizado_por_id, t.atualizado_em
        from transferencias_estoque t
       where t.id = ${id} and t.excluido_em is null ${visivel ? sql`and ${visivel}` : sql``}
         for update of t`);
    const r = rows[0];
    if (!r) throw ErroApi.naoEncontrado('Transferência não encontrada.');
    const { rows: v } = await tx.execute<{ versao: string }>(sql`
      select ${sqlVersaoTransferencia}::text as versao from transferencias_estoque t where t.id = ${id}`);
    const linha: LinhaTransferencia = {
      id: r.id as string,
      codigo: r.codigo as number,
      versao: Number(v[0]!.versao),
      status: r.status as StatusTransferencia,
      estoqueOrigemId: r.estoque_origem_id as string,
      estoqueDestinoId: r.estoque_destino_id as string,
      tipoEstoqueId: r.tipo_estoque_id as string,
      atualizadoPorId: (r.atualizado_por_id as string | null) ?? null,
      atualizadoEm: new Date(r.atualizado_em as string),
    };
    if (versao !== undefined && linha.versao !== versao) await conflitoVersao(tx, linha);
    return linha;
  }
}

/**
 * A origem **gravada** entre os estoques permitidos para movimentar: quem só tem o destino vê a transferência (vai
 * recebê-la, F2-B24), mas não altera, exclui, envia nem cancela o documento do remetente.
 */
function exigirOrigemPermitida(sessao: SessaoErp, t: { estoqueOrigemId: string }): void {
  if (!estoquePermitido(sessao, t.estoqueOrigemId, 'movimentar'))
    throw new ErroApi(
      'SEM_PERMISSAO',
      'A transferência sai de um estoque fora dos seus estoques permitidos: só quem tem a origem altera, envia ou cancela.',
    );
}

/** O **destino** entre os estoques permitidos para movimentar: quem recebe é a loja (ou o CD) que confere a carga. */
function exigirDestinoPermitido(sessao: SessaoErp, t: { estoqueDestinoId: string }): void {
  if (!estoquePermitido(sessao, t.estoqueDestinoId, 'movimentar'))
    throw new ErroApi(
      'SEM_PERMISSAO',
      'A transferência vai para um estoque fora dos seus estoques permitidos: só quem tem o destino recebe.',
    );
}

function exigirRascunho(t: { status: string }): void {
  if (t.status !== 'rascunho')
    throw new ErroApi(
      'REGRA_NEGOCIO',
      'Transferência enviada, recebida ou cancelada não pode ser alterada nem excluída (em trânsito, use Cancelar).',
    );
}
