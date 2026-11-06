/**
 * Prontidão da loja para o piloto (implantação I5; `GET /api/implantacao/prontidao`): o que falta para a loja vender,
 * só de leitura, avaliado do jeito que o caixa avalia (mesmas configurações efetivas, mesmas lojas permitidas, mesmas
 * permissões efetivas) para o "ok" daqui não mentir no balcão. Cada regra devolve um item com a situação:
 *
 * - `falta`: o caixa não abre, não vende ou não conclui um fluxo do piloto (ex.: sem forma Dinheiro, ninguém para
 *   liberar o cancelamento da venda paga, PDV abaixo da versão mínima);
 * - `aviso`: vende, mas convém olhar antes do dia D (ex.: produto sem preço, NCM ausente, PDV offline agora);
 * - `ok`.
 *
 * Não leva dado pessoal: só contagens, estados e os números dos caixas (nada de nome, login ou documento). Os links
 * apontam para a tela do ERP que resolve; `null` quando a solução está fora do ERP (a VPS, o Hermes).
 */
import {
  ALERTA_LACUNA_DECLARADA,
  ALERTA_RELOGIO_DESVIO,
  ALERTA_RELOGIO_SUSPEITO,
  calcularPermissoesEfetivas,
  CONFIGURACOES_POR_CHAVE,
  PERMISSOES,
  tipoChavePix,
  validarGtin,
  type GrupoProntidao,
  type ItemProntidao,
  type Prontidao,
  type SituacaoProntidao,
} from '@genesis/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { garantirLoja } from '../autorizacao/lojas.js';
import { ErroApi } from '../comum/erros.js';
import { hojeNaEmpresa } from '../comum/fuso.js';
import { lerConfiguracoes } from '../configuracoes/valores.js';
import type { BancoControle } from '../database/controle/conexao.js';
import { FILAS } from '../infra/fila.js';
import { backupsEmpresas, empresas } from '../database/controle/schema.js';
import { ncmVigente } from '../produtos/ncm.js';
import type { TerminaisErp } from '../terminais/terminais.service.js';
import type { DbEmpresa, Tenancy } from '../tenancy/tenancy.js';
import { diaOperacionalAtual } from '../vendas/consultas.js';

/** Filas recorrentes da plataforma (sem empresa no `data`): contam na Prontidão de todas as empresas. */
const FILAS_DA_PLATAFORMA = [
  FILAS.manutencaoTerminais,
  FILAS.expiracaoRelevancia,
  FILAS.tarefasInterrompidas,
];

/** Backup lógico mais velho que isto (o diário roda uma vez por dia, com folga) vira aviso. */
export const HORAS_BACKUP_RECENTE = 26;
/** Tarefa na fila (da empresa ou do pg-boss) que devia ter começado há mais que isto está atrasada. */
export const MINUTOS_TAREFA_ATRASADA = 5;

const CHAVES = [
  'geral.ativa',
  'geral.dia_operacional_hora_corte',
  'pdv.horas_alerta_sessao',
  'pdv.valor_limite_sangria',
  'pdv.desconto_cascos_max_sem_supervisor',
  'pdv.pix_manual_exige_supervisor',
] as const;

/**
 * Liberações que o piloto usa (PDV 31.3): quem libera digita login e PIN no caixa e passa pelas regras do login
 * (`AutenticadorOffline.AutenticarAsync`: não é totem e, fora o Master, tem `pdv.acesso.entrar`) e pelas do liberador
 * (`LiberarAsync`: `pdv.supervisor`, a permissão e não ser o próprio operador). Três modos, como o caixa pede:
 *
 * - `operador` (o padrão): o operador que tem a permissão faz sozinho; quem não tem pede o liberador. Basta um.
 * - `sempre`: o caixa sempre pede a liberação, mesmo do operador que tem a permissão (PIX manual com a chave ligada,
 *   forma "exige supervisor", desconto pelos cascos acima do teto). Quem libera tem de ser outra pessoa: o único
 *   liberador que também é o único operador não serve.
 * - `pix_sem_chave`: o PIX manual com `pdv.pix_manual_exige_supervisor` desligado: só pede o liberador para o operador
 *   sem `pdv.pagamento.confirmar_pix_manual` (`ServicoVenda.PermissoesParaLancar`); com todos os operadores tendo a
 *   permissão, ninguém precisa liberar.
 */
interface RegraLiberacao {
  codigo: string;
  titulo: string;
  permissao: string;
  situacaoSemNinguem: SituacaoProntidao;
  explicacao: string;
  modo?: 'operador' | 'sempre' | 'pix_sem_chave';
}

const descricao = (chave: string) => PERMISSOES.find((p) => p.chave === chave)?.descricao ?? chave;
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;
const caixa = (n: number) => String(n).padStart(2, '0');
/** Dinheiro das configurações (`'800.00'`) como o dono lê: `R$ 800,00`. */
const reais = (v: unknown) =>
  `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Adicionar = (
  grupo: GrupoProntidao,
  codigo: string,
  titulo: string,
  situacao: SituacaoProntidao,
  mensagem: string,
  linkErp: string | null,
) => void;

interface UsuarioLoja {
  id: string;
  master: boolean;
  perfilId: string | null;
  temPin: boolean;
}

export class ProntidaoLojas {
  constructor(
    private readonly controle: BancoControle,
    private readonly tenancy: Tenancy,
    private readonly terminais: TerminaisErp,
  ) {}

  async avaliar(sessao: SessaoErp, lojaId: string): Promise<Prontidao> {
    garantirLoja(sessao, lojaId);
    const itens: ItemProntidao[] = [];
    const add: Adicionar = (grupo, codigo, titulo, situacao, mensagem, linkErp) => {
      itens.push({ codigo: `${grupo}.${codigo}`, grupo, titulo, situacao, mensagem, linkErp });
    };

    const dados = await this.tenancy.cx().consulta((db) => this.ler(db, lojaId));
    if (!dados) throw ErroApi.naoEncontrado('Loja não encontrada.');
    const { loja, cfg } = dados;
    const linkLoja = `/cadastros/lojas/${loja.id}`;

    // ---------------------------------------------------------------- Empresa
    const [emp] = await this.controle.db
      .select({ status: empresas.status })
      .from(empresas)
      .where(eq(empresas.id, sessao.empresa.empresaId));
    const geralAtiva = cfg.get('geral.ativa') !== false;
    if (emp?.status !== 'ativa')
      add(
        'empresa',
        'ativa',
        'Empresa ativa',
        'falta',
        `A empresa está "${emp?.status ?? 'desconhecida'}" na plataforma: fale com o suporte.`,
        null,
      );
    else if (!geralAtiva)
      add(
        'empresa',
        'ativa',
        'Empresa ativa',
        'falta',
        'A empresa está em implantação (Configurações › Geral › "Ativa" em Não, o modo implantação): o caixa não abre sessão.',
        '/cadastros/configuracoes/geral',
      );
    else add('empresa', 'ativa', 'Empresa ativa', 'ok', 'Empresa ativa e liberada para o caixa.', null);

    // ---------------------------------------------------------------- Loja e caixas
    if (!loja.ativa || loja.tipo !== 'ponto_venda' || !loja.usaPdv)
      add(
        'loja',
        'usa_pdv',
        'Loja ativa com PDV',
        'falta',
        !loja.ativa
          ? 'A loja está inativa.'
          : loja.tipo !== 'ponto_venda'
            ? 'A loja é um depósito/CD: não tem caixa.'
            : 'A loja está com "Usa PDV nesta loja" desligado: o caixa não abre sessão.',
        linkLoja,
      );
    else
      add(
        'loja',
        'usa_pdv',
        'Loja ativa com PDV',
        'ok',
        loja.treino ? 'Loja ativa, com PDV (loja de treino, não fiscal).' : 'Loja ativa, com PDV.',
        linkLoja,
      );

    const corte = String(cfg.get('geral.dia_operacional_hora_corte') ?? '05:00');
    const horasSessao = Number(cfg.get('pdv.horas_alerta_sessao') ?? 24);
    const dia = `Dia operacional vira às ${corte} (fuso ${loja.fusoHorario}); hoje é ${formatarDia(dados.hoje)}.`;
    if (dados.sessoesAntigas > 0)
      add(
        'loja',
        'dia_operacional',
        'Dia operacional e sessões de caixa',
        'aviso',
        `${dia} ${plural(dados.sessoesAntigas, 'sessão de caixa aberta', 'sessões de caixa abertas')} há mais de ${horasSessao} h: feche no PDV antes de começar.`,
        '/financeiro/fechamentos-caixa',
      );
    else
      add(
        'loja',
        'dia_operacional',
        'Dia operacional e sessões de caixa',
        'ok',
        dia,
        '/cadastros/configuracoes/geral',
      );

    if (dados.caixas.length === 0)
      add(
        'loja',
        'caixas',
        'Caixas cadastrados',
        'falta',
        'Nenhum caixa ativo (além do caixa 0 do sistema): cadastre o caixa 01 na aba Caixas da loja.',
        `${linkLoja}/caixas`,
      );
    else
      add(
        'loja',
        'caixas',
        'Caixas cadastrados',
        'ok',
        `${plural(dados.caixas.length, 'caixa ativo', 'caixas ativos')}: ${dados.caixas.map(caixa).join(', ')}.`,
        `${linkLoja}/caixas`,
      );

    // ---------------------------------------------------------------- Usuários e liberações
    const efetivas = dados.usuarios.map((u) => ({
      ...u,
      permissoes: calcularPermissoesEfetivas({
        master: u.master,
        doPerfil: dados.doPerfil.get(u.perfilId ?? '') ?? [],
        concedidas: dados.ajustes.get(u.id)?.conceder ?? [],
        negadas: dados.ajustes.get(u.id)?.negar ?? [],
      }),
    }));
    // Quem passa no login do caixa (`AutenticadorOffline.AutenticarAsync`): PIN, não é totem (a consulta já tira) e,
    // fora o Master (que tem todas), `pdv.acesso.entrar`. Vale também para quem libera: a liberação passa pelo login.
    const comPin = efetivas.filter((u) => u.temPin && u.permissoes.has('pdv.acesso.entrar'));
    const operadores = comPin.filter((u) =>
      ['pdv.caixa.abrir', 'pdv.venda.vender'].every((p) => u.permissoes.has(p)),
    );
    // O Master tem tudo e quase nunca opera o caixa: fica fora da dica de quem ainda está sem PIN.
    const semPin = efetivas.filter(
      (u) =>
        !u.master &&
        !u.temPin &&
        u.permissoes.has('pdv.acesso.entrar') &&
        u.permissoes.has('pdv.venda.vender'),
    ).length;
    if (operadores.length === 0)
      add(
        'usuarios',
        'operador',
        'Operador de caixa com PIN',
        'falta',
        `Nenhum usuário ativo com acesso à loja, PIN do PDV e permissão para entrar, abrir o caixa e vender.${
          semPin
            ? ` ${plural(semPin, 'usuário com o perfil ainda não tem', 'usuários com o perfil ainda não têm')} PIN.`
            : ''
        }`,
        '/cadastros/usuarios',
      );
    else
      add(
        'usuarios',
        'operador',
        'Operador de caixa com PIN',
        'ok',
        `${plural(operadores.length, 'usuário pode', 'usuários podem')} abrir o caixa e vender nesta loja.${
          semPin ? ` ${plural(semPin, 'outro ainda está', 'outros ainda estão')} sem PIN.` : ''
        }`,
        '/cadastros/usuarios',
      );

    const liberadores = comPin.filter((u) => u.permissoes.has('pdv.supervisor'));
    const regras: RegraLiberacao[] = [
      {
        codigo: 'cancelar_venda_paga',
        titulo: 'Quem libera o cancelamento da venda paga',
        permissao: 'pdv.venda.cancelar_venda_finalizada',
        situacaoSemNinguem: 'falta',
        explicacao:
          'O6: o gerente ou o encarregado cancela a venda paga do caixa aberto, pelo PIN dele no caixa (caixa fechado: só pelo ERP, na Fase 3).',
      },
      {
        codigo: 'cancelar_venda_aberta',
        titulo: 'Quem libera o cancelamento da venda em andamento',
        permissao: 'pdv.venda.cancelar_venda_aberta',
        situacaoSemNinguem: 'falta',
        explicacao: 'O operador pede a liberação do supervisor para cancelar a venda em andamento.',
      },
      {
        codigo: 'cancelar_sangria',
        titulo: 'Quem libera o cancelamento da sangria/reforço',
        permissao: 'pdv.caixa.cancelar_movimento',
        situacaoSemNinguem: 'aviso',
        explicacao: 'O5: cancelar uma sangria pede o supervisor.',
      },
    ];
    const limiteSangria = cfg.get('pdv.valor_limite_sangria');
    if (limiteSangria !== null && limiteSangria !== undefined)
      regras.push({
        codigo: 'limite_sangria',
        titulo: 'Quem libera vender acima do limite de gaveta',
        permissao: 'pdv.caixa.ignorar_limite_sangria',
        situacaoSemNinguem: 'falta',
        explicacao: `Com o limite de gaveta em ${reais(limiteSangria)}, o caixa trava até a sangria ou a liberação.`,
      });
    const tetoCascos = Number(cfg.get('pdv.desconto_cascos_max_sem_supervisor') ?? 0);
    if (tetoCascos > 0)
      regras.push({
        codigo: 'desconto_cascos',
        titulo: 'Quem libera o desconto pelos cascos acima do teto',
        permissao: 'pdv.venda.desconto_total',
        situacaoSemNinguem: 'aviso',
        explicacao: `D38: desconto pelos cascos acima de ${reais(tetoCascos)} por venda pede o supervisor.`,
        modo: 'sempre',
      });
    const formasPix = dados.formas.filter((f) => f.tipoForma === 'pix');
    if (formasPix.length > 0) {
      const chaveLigada = cfg.get('pdv.pix_manual_exige_supervisor') !== false;
      if (chaveLigada)
        regras.push({
          codigo: 'pix_manual',
          titulo: 'Quem confirma o PIX manual',
          permissao: 'pdv.pagamento.confirmar_pix_manual',
          situacaoSemNinguem: 'falta',
          explicacao:
            'O9b: o PIX confirmado à mão pede o supervisor; sem ninguém, a venda em PIX não conclui.',
          modo: 'sempre',
        });
      else if (operadores.some((u) => !u.permissoes.has('pdv.pagamento.confirmar_pix_manual')))
        regras.push({
          codigo: 'pix_manual',
          titulo: 'Quem confirma o PIX manual',
          permissao: 'pdv.pagamento.confirmar_pix_manual',
          situacaoSemNinguem: 'falta',
          explicacao:
            'O9b: "PIX manual exige supervisor" está desligado, mas o operador sem "Confirmar PIX manual" (o perfil padrão Operador de caixa) continua pedindo o supervisor; dê a permissão aos operadores para confirmarem sozinhos.',
          modo: 'pix_sem_chave',
        });
      else
        add(
          'usuarios',
          'liberacao.pix_manual',
          'Quem confirma o PIX manual',
          'ok',
          'O9b: "PIX manual exige supervisor" está desligado e todos os operadores com PIN confirmam o PIX sozinhos.',
          '/cadastros/perfis',
        );
    }
    if (dados.formas.some((f) => f.exigeSupervisor || f.temSenha))
      regras.push({
        codigo: 'forma_com_supervisor',
        titulo: 'Quem libera as formas que exigem supervisor',
        permissao: 'pdv.pagamento.forma_com_senha',
        situacaoSemNinguem: 'falta',
        explicacao: 'Há forma de pagamento com "Exige supervisor" (ou senha de liberação) ativa na loja.',
        modo: 'sempre',
      });
    for (const r of regras) {
      const quem = liberadores.filter((u) => u.permissoes.has(r.permissao));
      const n = quem.length;
      // `sempre`: o operador cujo único liberador é ele mesmo fica sem quem libere. Com todos assim (o gerente é o único
      // com PIN, ou o único liberador é o único operador), é como não ter ninguém; com só alguns, `ok` com a ressalva.
      const semOutro =
        r.modo === 'sempre' && n > 0 ? operadores.filter((o) => !quem.some((l) => l.id !== o.id)).length : 0;
      const ninguem = n === 0 || (semOutro > 0 && semOutro === operadores.length);
      const proprio = `o caixa não aceita o PIN do próprio operador na liberação`;
      add(
        'usuarios',
        `liberacao.${r.codigo}`,
        r.titulo,
        ninguem ? r.situacaoSemNinguem : 'ok',
        n === 0
          ? `Ninguém com PIN, acesso à loja, "pdv.supervisor" e "${descricao(r.permissao)}". ${r.explicacao}`
          : ninguem
            ? `Só 1 pessoa pode liberar "${descricao(r.permissao)}" e ela também é quem opera o caixa: ${proprio}. Dê a permissão (com "pdv.supervisor") a outra pessoa com PIN. ${r.explicacao}`
            : `${plural(n, 'pessoa pode', 'pessoas podem')} liberar "${descricao(r.permissao)}"${
                semOutro ? ` (quando ela mesma estiver no caixa, ninguém libera: ${proprio})` : ''
              }. ${r.explicacao}`,
        '/cadastros/perfis',
      );
    }

    // Configuração do terminal: no login (Ctrl+Alt+C) e no "Restaurar backup" o caixa SEMPRE pede alguém com
    // `pdv.supervisor` e a permissão (`LiberarAsync` com operador vazio); só o F11 › 8, com o caixa aberto, aceita o
    // próprio operador. O roteiro do piloto configura a impressora e restaura o backup pelo login.
    const configTerminal = liberadores.filter((u) => u.permissoes.has('pdv.config.terminal')).length;
    const configSoPropria = comPin.filter((u) => u.permissoes.has('pdv.config.terminal')).length;
    add(
      'usuarios',
      'liberacao.config_terminal',
      'Quem configura o terminal (impressora, restaurar backup)',
      configTerminal > 0 ? 'ok' : 'falta',
      configTerminal > 0
        ? `${plural(configTerminal, 'pessoa pode', 'pessoas podem')} liberar "${descricao('pdv.config.terminal')}" no login (Ctrl+Alt+C): impressora, gaveta e "Restaurar backup". No F11 › 8, com o caixa aberto, basta o próprio operador ter a permissão.`
        : `Ninguém com PIN, acesso à loja, "pdv.supervisor" e "${descricao('pdv.config.terminal')}": no login (Ctrl+Alt+C) e no "Restaurar backup" o caixa pede essa pessoa${
            configSoPropria
              ? `; ${plural(configSoPropria, 'pessoa tem', 'pessoas têm')} a permissão sem "pdv.supervisor" e só ${configSoPropria === 1 ? 'consegue' : 'conseguem'} pelo F11 › 8 com o caixa aberto`
              : ''
          }.`,
      '/cadastros/perfis',
    );
    // Lacuna (`pdv.config.fiscal`): o próprio operador com a permissão declara; sem ela, um liberador com ela.
    const lacuna = comPin.filter((u) => u.permissoes.has('pdv.config.fiscal')).length;
    const explicacaoLacuna =
      'C15: só quem tem a permissão declara a lacuna (no perfil padrão, só o Master); raro, mas sem ninguém o caixa fica parado até o suporte.';
    add(
      'usuarios',
      'liberacao.lacuna',
      'Quem declara lacuna de eventos',
      lacuna > 0 ? 'ok' : 'aviso',
      lacuna > 0
        ? `${plural(lacuna, 'pessoa tem', 'pessoas têm')} "${descricao('pdv.config.fiscal')}" com PIN. ${explicacaoLacuna}`
        : `Ninguém com PIN e acesso à loja tem "${descricao('pdv.config.fiscal')}". ${explicacaoLacuna}`,
      '/cadastros/perfis',
    );

    // ---------------------------------------------------------------- Formas de pagamento
    const dinheiro = dados.formas.filter((f) => f.tipoForma === 'dinheiro');
    add(
      'formas',
      'dinheiro',
      'Dinheiro',
      dinheiro.length ? 'ok' : 'falta',
      dinheiro.length
        ? `${plural(dinheiro.length, 'forma', 'formas')} de dinheiro ativa na loja (troco só no dinheiro, O23).`
        : 'Nenhuma forma Dinheiro ativa nesta loja: o fundo de caixa, a sangria e o troco dependem dela.',
      '/cadastros/formas-pagamento',
    );
    const pixQr = formasPix.filter((f) => f.geraQrcodePix);
    const tipoChave = tipoChavePix(loja.chavePix);
    if (formasPix.length === 0)
      add(
        'formas',
        'pix',
        'PIX',
        'aviso',
        'Nenhuma forma PIX ativa nesta loja (o piloto usa PIX com QR estático e confirmação manual, O9a).',
        '/cadastros/formas-pagamento',
      );
    else if (pixQr.length && (!tipoChave || !loja.pixNomeRecebedor))
      add(
        'formas',
        'pix',
        'PIX',
        'falta',
        !loja.chavePix
          ? 'A forma PIX gera QR, mas a loja não tem chave PIX: informe a chave e o nome do recebedor no cadastro da loja.'
          : !tipoChave
            ? 'A chave PIX da loja não tem formato válido (CPF, CNPJ, e-mail, +55 com DDD ou aleatória).'
            : 'Falta o nome do recebedor do PIX no cadastro da loja.',
        linkLoja,
      );
    else
      add(
        'formas',
        'pix',
        'PIX',
        'ok',
        pixQr.length
          ? `QR estático com a chave ${tipoChave === 'aleatoria' ? 'aleatória' : `de ${tipoChave}`} da loja; confirme com um PIX de teste lido pelo app do banco.`
          : 'PIX por confirmação manual, sem QR (a forma não gera QR Code).',
        pixQr.length ? linkLoja : '/cadastros/formas-pagamento',
      );
    const credito = dados.formas.some((f) => f.tipoForma === 'cartao_credito');
    const debito = dados.formas.some((f) => f.tipoForma === 'cartao_debito');
    add(
      'formas',
      'cartao',
      'Cartão na maquininha',
      credito && debito ? 'ok' : 'aviso',
      credito && debito
        ? 'Débito e crédito ativos: o caixa pede a bandeira (lista fixa do PDV); NSU e autorização são opcionais (O9c).'
        : `Falta ${!credito && !debito ? 'débito e crédito' : !credito ? 'crédito' : 'débito'} ativo nesta loja (o piloto usa a maquininha POS, O9a).`,
      '/cadastros/formas-pagamento',
    );

    // ---------------------------------------------------------------- Catálogo
    const c = dados.catalogo;
    add(
      'catalogo',
      'produtos',
      'Produtos à venda',
      c.comPreco > 0 ? 'ok' : 'falta',
      c.comPreco > 0
        ? `${plural(c.comPreco, 'produto ativo', 'produtos ativos')} com preço nesta loja.`
        : 'Nenhum produto ativo com preço nesta loja: importe a planilha do Nuvem3 (Produtos › Importação).',
      c.comPreco > 0 ? '/produtos' : '/produtos/importacao',
    );
    add(
      'catalogo',
      'sem_preco',
      'Produtos sem preço',
      c.semPreco ? 'aviso' : 'ok',
      c.semPreco
        ? `${plural(c.semPreco, 'produto ativo está', 'produtos ativos estão')} com preço zero (e sem "solicita preço no PDV"): o caixa não vende.`
        : 'Todos os produtos ativos têm preço.',
      '/produtos',
    );
    add(
      'catalogo',
      'sem_codigo',
      'Produtos sem código de barras',
      c.semCodigo ? 'aviso' : 'ok',
      c.semCodigo
        ? `${plural(c.semCodigo, 'produto ativo', 'produtos ativos')} sem EAN nem código interno: no caixa, só pela busca (F2) ou pelo código do produto.`
        : 'Todos os produtos ativos têm código de barras.',
      '/produtos',
    );
    add(
      'catalogo',
      'ean_invalido',
      'EAN inválido',
      dados.eanInvalidos ? 'aviso' : 'ok',
      dados.eanInvalidos
        ? `${plural(dados.eanInvalidos, 'código numérico', 'códigos numéricos')} com dígito verificador inválido (gravados como código interno): bipam se o rótulo for igual; confira os produtos.`
        : 'Nenhum EAN com dígito verificador inválido.',
      '/produtos',
    );
    add(
      'catalogo',
      'ean_duplicado',
      'EAN em mais de um produto',
      dados.eanDuplicados ? 'aviso' : 'ok',
      dados.eanDuplicados
        ? `${plural(dados.eanDuplicados, 'código de barras está', 'códigos de barras estão')} em mais de um produto ativo: no caixa entra o primeiro encontrado (pode sair o produto errado).`
        : 'Nenhum código de barras repetido entre produtos ativos.',
      '/produtos',
    );
    add(
      'catalogo',
      'combos',
      'Combos com componentes ativos',
      c.combosQuebrados ? 'aviso' : 'ok',
      c.combosQuebrados
        ? `${plural(c.combosQuebrados, 'combo ativo tem', 'combos ativos têm')} componente inativo, excluído ou desligado na loja (ou nenhum componente): o caixa recusa o combo.`
        : c.combos
          ? `${plural(c.combos, 'combo ativo', 'combos ativos')} com todos os componentes ativos.`
          : 'Nenhum combo cadastrado.',
      '/produtos',
    );
    add(
      'catalogo',
      'ncm',
      'NCM (fiscal fica para depois)',
      c.semNcm ? 'aviso' : 'ok',
      c.semNcm
        ? `${plural(c.semNcm, 'produto ativo', 'produtos ativos')} sem NCM vigente: não impede a venda não fiscal, mas precisa ser corrigido antes da NFC-e (Fase 3F).`
        : 'Todos os produtos ativos têm NCM vigente.',
      '/produtos',
    );
    add(
      'catalogo',
      'estoque_negativo',
      'Estoque negativo',
      c.estoqueNegativo ? 'aviso' : 'ok',
      c.estoqueNegativo
        ? `${plural(c.estoqueNegativo, 'produto está', 'produtos estão')} com saldo negativo no estoque da loja: o caixa vende com aviso (O15); acerte o estoque.`
        : 'Nenhum saldo negativo no estoque da loja.',
      '/estoque/saldos',
    );

    // ---------------------------------------------------------------- Terminais
    // O estado dos caixas é o da tela PDVs/Terminais: sem `terminais.ver`, um item só, sem os dados (como o Dashboard).
    if (!sessao.permissoes.has('terminais.ver'))
      add(
        'terminais',
        'sem_permissao',
        'PDVs / Terminais',
        'aviso',
        'Sem a permissão "PDVs/Terminais: Ver": quem a tem confere aqui os PDVs ativados, o contato, a versão, o relógio, a fila de decisão e a lacuna.',
        null,
      );
    else await this.avaliarTerminais(sessao, lojaId, add);

    await this.avaliarOperacao(sessao, dados.tarefasAtrasadas, add);

    const resumo: Record<SituacaoProntidao, number> = { ok: 0, aviso: 0, falta: 0 };
    for (const i of itens) resumo[i.situacao]++;
    return {
      lojaId: loja.id,
      lojaCodigo: loja.codigo,
      lojaNome: loja.nome,
      geradoEm: new Date().toISOString(),
      pronta: resumo.falta === 0,
      resumo,
      itens,
    };
  }

  private async avaliarTerminais(sessao: SessaoErp, lojaId: string, add: Adicionar): Promise<void> {
    const listagem = await this.terminais.listar(sessao, {
      lojaId,
      situacao: 'ativos',
      conexao: 'todos',
      versaoApp: undefined,
    });
    const ativos = listagem.itens.filter((t) => t.status === 'ativo');
    const ids = new Set(ativos.map((t) => t.id));
    const doTerminal = (tipo: string) =>
      new Set(
        listagem.alertas
          .filter((a) => a.tipo === tipo && a.terminalId && ids.has(a.terminalId))
          .map((a) => a.terminalId),
      );
    const linkTerminal = (id: string) => `/cadastros/pdvs/${id}`;
    const nomes = (lista: Array<{ numeroCaixa: number }>) =>
      lista.map((t) => `caixa ${caixa(t.numeroCaixa)}`).join(', ');
    if (ativos.length === 0)
      add(
        'terminais',
        'ativo',
        'PDV ativado',
        'falta',
        'Nenhum PDV ativo nesta loja: gere o código em PDVs/Terminais › Gerar código e ative pelo assistente do PDV.',
        '/cadastros/pdvs',
      );
    else {
      add(
        'terminais',
        'ativo',
        'PDV ativado',
        'ok',
        `${plural(ativos.length, 'PDV ativo', 'PDVs ativos')}: ${nomes(ativos)}.`,
        '/cadastros/pdvs',
      );
      const semContato = ativos.filter((t) => t.conexao !== 'online');
      add(
        'terminais',
        'contato',
        'Último contato recente',
        semContato.length ? 'aviso' : 'ok',
        semContato.length
          ? `Sem contato nos últimos 2 min: ${nomes(semContato)}. O caixa vende offline; abra o PDV com internet para conferir.`
          : 'Todos os PDVs falaram com a nuvem nos últimos 2 min.',
        semContato.length === 1 ? linkTerminal(semContato[0]!.id) : '/cadastros/pdvs',
      );
      const abaixo = ativos.filter((t) => t.abaixoDaMinima);
      add(
        'terminais',
        'versao',
        'Versão do PDV',
        abaixo.length ? 'falta' : 'ok',
        abaixo.length
          ? `Abaixo da versão mínima: ${abaixo
              .map((t) => `caixa ${caixa(t.numeroCaixa)} (${t.versaoApp ?? '?'} < ${t.versaoMinima ?? '?'})`)
              .join(', ')}. Instale a versão nova pelo instalador; sem isso o caixa não sincroniza.`
          : `Versão: ${[...new Set(ativos.map((t) => t.versaoApp ?? 'desconhecida'))].join(', ')}.`,
        abaixo.length === 1 ? linkTerminal(abaixo[0]!.id) : '/cadastros/pdvs',
      );
      const desvio = doTerminal(ALERTA_RELOGIO_DESVIO);
      const suspeito = doTerminal(ALERTA_RELOGIO_SUSPEITO);
      const relogio = ativos.filter(
        (t) => t.relogioConfiavel === false || desvio.has(t.id) || suspeito.has(t.id),
      );
      add(
        'terminais',
        'relogio',
        'Relógio do computador',
        relogio.length ? 'aviso' : 'ok',
        relogio.length
          ? `Relógio errado ou que voltou: ${nomes(relogio)}. Acerte a data e a hora do Windows (automático, fuso de Brasília).`
          : 'Relógio dos PDVs conferido pela nuvem (C16).',
        relogio.length === 1 ? linkTerminal(relogio[0]!.id) : '/cadastros/pdvs',
      );
      const comErro = ativos.filter((t) => t.eventosComErro > 0);
      add(
        'terminais',
        'fila_decisao',
        'Fila de decisão (eventos com erro)',
        comErro.length ? 'aviso' : 'ok',
        comErro.length
          ? `${comErro.map((t) => `caixa ${caixa(t.numeroCaixa)}: ${t.eventosComErro}`).join(', ')} evento(s) com erro ou retido(s): decida em PDVs/Terminais › detalhe › Eventos com erro.`
          : 'Nenhum evento com erro ou retido.',
        comErro.length === 1 ? `${linkTerminal(comErro[0]!.id)}?aba=eventos` : '/cadastros/pdvs',
      );
      const lacunas = doTerminal(ALERTA_LACUNA_DECLARADA);
      const comLacuna = ativos.filter((t) => lacunas.has(t.id));
      add(
        'terminais',
        'lacuna',
        'Lacuna de eventos',
        comLacuna.length ? 'aviso' : 'ok',
        comLacuna.length
          ? `Lacuna declarada e aberta: ${nomes(comLacuna)}. Confira com o caixa o que se perdeu (C15) antes do piloto.`
          : 'Nenhuma lacuna de eventos aberta.',
        comLacuna.length === 1 ? linkTerminal(comLacuna[0]!.id) : '/cadastros/pdvs',
      );
    }
  }

  private async avaliarOperacao(sessao: SessaoErp, tarefasAtrasadas: number, add: Adicionar): Promise<void> {
    const [backup] = await this.controle.db
      .select({ status: backupsEmpresas.status, concluidoEm: backupsEmpresas.concluidoEm })
      .from(backupsEmpresas)
      .where(and(eq(backupsEmpresas.empresaId, sessao.empresa.empresaId), isNull(backupsEmpresas.excluidoEm)))
      .orderBy(desc(backupsEmpresas.iniciadoEm))
      .limit(1);
    if (!backup)
      add(
        'operacao',
        'backup',
        'Backup lógico da nuvem',
        'aviso',
        'Não verificável aqui: o backup diário (genesis-backup) registra o resultado no bucket. Confira o "ultimo_backup" pelo Hermes (/api/saude/detalhada) ou com "genesis-backup estado" na VPS.',
        null,
      );
    else {
      const horas = backup.concluidoEm ? (Date.now() - backup.concluidoEm.getTime()) / 3_600_000 : null;
      const recente = backup.status === 'concluido' && horas !== null && horas <= HORAS_BACKUP_RECENTE;
      add(
        'operacao',
        'backup',
        'Backup lógico da nuvem',
        recente ? 'ok' : 'aviso',
        recente
          ? `Último backup concluído há ${Math.max(0, Math.round(horas))} h.`
          : backup.status === 'concluido'
            ? `Último backup concluído há mais de ${HORAS_BACKUP_RECENTE} h: confira o genesis-backup na VPS.`
            : `O último backup está "${backup.status}": confira o genesis-backup na VPS.`,
        null,
      );
    }
    const pgBoss = await this.tarefasPgBoss(sessao.empresa.empresaId);
    const atrasadas = tarefasAtrasadas + (pgBoss ?? 0);
    add(
      'operacao',
      'tarefas',
      'Tarefas em segundo plano',
      atrasadas || pgBoss === null ? 'aviso' : 'ok',
      atrasadas
        ? `${plural(atrasadas, 'tarefa está', 'tarefas estão')} na fila há mais de ${MINUTOS_TAREFA_ATRASADA} min sem começar (importação, manutenção dos terminais): confira o trabalhador da API na VPS.`
        : pgBoss === null
          ? 'Não deu para ler a fila do pg-boss agora: confira a API pelo Hermes.'
          : 'Nenhuma tarefa atrasada.',
      null,
    );
  }

  /** Tudo o que vem do banco da empresa, numa conexão. `null` = loja inexistente (ou excluída). */
  private async ler(db: DbEmpresa, lojaId: string) {
    const lojas = await db.execute<{
      id: string;
      codigo: number;
      nome: string;
      tipo: string;
      ativa: boolean;
      usa_pdv: boolean;
      treino: boolean;
      fuso_horario: string;
      chave_pix: string | null;
      pix_nome_recebedor: string | null;
      hoje: string;
    }>(sql`
      select l.id, l.codigo, l.nome, l.tipo, l.ativa, l.usa_pdv, l.treino, l.fuso_horario, l.chave_pix,
             l.pix_nome_recebedor, (${diaOperacionalAtual})::text as hoje
        from lojas l where l.id = ${lojaId} and l.excluido_em is null`);
    const l = lojas.rows[0];
    if (!l) return null;
    const cfg = await lerConfiguracoes(db, CHAVES, lojaId);
    const horasSessao = Number(
      cfg.get('pdv.horas_alerta_sessao') ??
        CONFIGURACOES_POR_CHAVE.get('pdv.horas_alerta_sessao')?.padrao ??
        24,
    );

    const caixas = await db.execute<{ numero: number }>(sql`
      select numero from caixas
       where loja_id = ${lojaId} and excluido_em is null and ativo and not sistema order by numero`);
    const sessoes = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from sessoes_caixa
       where loja_id = ${lojaId} and status <> 'fechada' and excluido_em is null
         and aberta_em < now() - make_interval(hours => ${horasSessao})`);

    // Usuários com acesso à loja (Master = todas; os demais pelas lojas permitidas), ativos e não demitidos no fuso da
    // empresa: os mesmos que recebem o PIN e `ativo = true` no fluxo `acesso` (sync/fluxos.ts). O totem do menu digital
    // fica de fora: o caixa o recusa no login (`MotivoRecusa.Totem`), mesmo com PIN.
    const usuarios = await db.execute<{
      id: string;
      master: boolean;
      perfil_id: string | null;
      tem_pin: boolean;
    }>(sql`
      select u.id, u.master, u.perfil_id, u.senha_pdv_hash is not null as tem_pin
        from usuarios u
       where u.excluido_em is null and u.ativo and not u.totem
         and (u.demissao is null or u.demissao > ${hojeNaEmpresa})
         and (u.master or exists (select 1 from usuarios_lojas ul
                                   where ul.usuario_id = u.id and ul.loja_id = ${lojaId} and ul.excluido_em is null))`);
    const perfisPerm = await db.execute<{ perfil_id: string; permissao: string }>(sql`
      select pp.perfil_id, pp.permissao from perfis_permissoes pp
        join perfis p on p.id = pp.perfil_id and p.excluido_em is null
       where pp.excluido_em is null and pp.permissao like 'pdv.%'`);
    const ajustesPerm = await db.execute<{ usuario_id: string; permissao: string; efeito: string }>(sql`
      select usuario_id, permissao, efeito from usuarios_permissoes
       where excluido_em is null and permissao like 'pdv.%'`);
    const doPerfil = new Map<string, string[]>();
    for (const r of perfisPerm.rows)
      doPerfil.set(r.perfil_id, [...(doPerfil.get(r.perfil_id) ?? []), r.permissao]);
    const ajustes = new Map<string, { conceder: string[]; negar: string[] }>();
    for (const r of ajustesPerm.rows) {
      const a = ajustes.get(r.usuario_id) ?? { conceder: [], negar: [] };
      (r.efeito === 'negar' ? a.negar : a.conceder).push(r.permissao);
      ajustes.set(r.usuario_id, a);
    }

    // Formas que o caixa oferece na loja (`CatalogoLocal`): ativas, "usa PDV" e com vínculo vivo de "todas" ou da loja.
    const formas = await db.execute<{
      tipo_forma: string;
      gera_qrcode_pix: boolean;
      exige_supervisor: boolean;
      tem_senha: boolean;
    }>(sql`
      select f.tipo_forma, f.gera_qrcode_pix, f.exige_supervisor, f.senha_liberacao_hash is not null as tem_senha
        from formas_pagamento f
       where f.excluido_em is null and f.ativa and f.usa_pdv
         and exists (select 1 from formas_pagamento_lojas fl
                      where fl.forma_pagamento_id = f.id and fl.excluido_em is null
                        and (fl.loja_id is null or fl.loja_id = ${lojaId}))`);

    // Catálogo do caixa da loja: ativos, ativos na loja, fora a matéria-prima (o mesmo corte do Dashboard).
    const vendaveis = sql`
      select p.id, p.tipo, p.ncm, coalesce(pl.preco_venda, p.preco_venda) as preco, p.solicita_preco_pdv
        from produtos p
        left join produtos_lojas pl on pl.produto_id = p.id and pl.loja_id = ${lojaId} and pl.excluido_em is null
       where p.excluido_em is null and p.ativo and coalesce(pl.ativo_na_loja, true) and p.tipo <> 'materia_prima'`;
    const catalogo = await db.execute<{
      com_preco: number;
      sem_preco: number;
      sem_codigo: number;
      sem_ncm: number;
      combos: number;
      combos_quebrados: number;
      estoque_negativo: number;
    }>(sql`
      with v as (${vendaveis})
      select count(*) filter (where v.preco > 0 or v.solicita_preco_pdv)::int as com_preco,
             count(*) filter (where v.preco <= 0 and not v.solicita_preco_pdv)::int as sem_preco,
             count(*) filter (where not exists (select 1 from produtos_codigos_barras c
                                                 where c.produto_id = v.id and c.excluido_em is null and c.usa_venda)
                                and v.tipo <> 'vasilhame')::int as sem_codigo,
             count(*) filter (where v.tipo not in ('kit', 'servico')
                                and (v.ncm is null or not ${ncmVigente(sql`v.ncm`)}))::int as sem_ncm,
             count(*) filter (where v.tipo = 'kit')::int as combos,
             count(*) filter (where v.tipo = 'kit' and (
               not exists (select 1 from produtos_componentes pc
                            where pc.produto_id = v.id and pc.tipo = 'kit' and pc.excluido_em is null)
               or exists (select 1 from produtos_componentes pc
                            join produtos c on c.id = pc.componente_id
                            left join produtos_lojas cl on cl.produto_id = c.id and cl.loja_id = ${lojaId}
                                                       and cl.excluido_em is null
                           where pc.produto_id = v.id and pc.tipo = 'kit' and pc.excluido_em is null
                             and (c.excluido_em is not null or not c.ativo or not coalesce(cl.ativo_na_loja, true)))
             ))::int as combos_quebrados,
             (select count(distinct s.produto_id)::int from saldos_estoque s
                join lojas l on l.id = ${lojaId} and l.estoque_id = s.estoque_id
                join tipos_estoque te on te.id = s.tipo_estoque_id and te.vendavel
                join produtos p on p.id = s.produto_id and p.excluido_em is null and p.ativo
               where s.quantidade < 0) as estoque_negativo
        from v`);
    // Códigos de barras dos vendáveis: o dígito verificador e a repetição entre produtos saem daqui (`validarGtin`).
    const codigos = await db.execute<{ codigo: string; produtos: number }>(sql`
      with v as (${vendaveis})
      select c.codigo, count(distinct c.produto_id)::int as produtos
        from produtos_codigos_barras c join v on v.id = c.produto_id
       where c.excluido_em is null and c.usa_venda
       group by c.codigo`);
    let eanInvalidos = 0;
    let eanDuplicados = 0;
    for (const r of codigos.rows) {
      if (/^(\d{8}|\d{12,14})$/.test(r.codigo) && !validarGtin(r.codigo)) eanInvalidos++;
      if (r.produtos > 1) eanDuplicados++;
    }

    const tarefas = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from tarefas
       where status = 'na_fila' and criado_em < now() - make_interval(mins => ${MINUTOS_TAREFA_ATRASADA})`);

    const k = catalogo.rows[0]!;
    const usuariosLoja: UsuarioLoja[] = usuarios.rows.map((u) => ({
      id: u.id,
      master: u.master,
      perfilId: u.perfil_id,
      temPin: u.tem_pin,
    }));
    return {
      loja: {
        id: l.id,
        codigo: l.codigo,
        nome: l.nome,
        tipo: l.tipo,
        ativa: l.ativa,
        usaPdv: l.usa_pdv,
        treino: l.treino,
        fusoHorario: l.fuso_horario,
        chavePix: l.chave_pix,
        pixNomeRecebedor: l.pix_nome_recebedor,
      },
      hoje: l.hoje,
      cfg,
      caixas: caixas.rows.map((c) => c.numero),
      sessoesAntigas: sessoes.rows[0]?.n ?? 0,
      usuarios: usuariosLoja,
      doPerfil,
      ajustes,
      formas: formas.rows.map((f) => ({
        tipoForma: f.tipo_forma,
        geraQrcodePix: f.gera_qrcode_pix,
        exigeSupervisor: f.exige_supervisor,
        temSenha: f.tem_senha,
      })),
      catalogo: {
        comPreco: k.com_preco,
        semPreco: k.sem_preco,
        semCodigo: k.sem_codigo,
        semNcm: k.sem_ncm,
        combos: k.combos,
        combosQuebrados: k.combos_quebrados,
        estoqueNegativo: k.estoque_negativo,
      },
      eanInvalidos,
      eanDuplicados,
      tarefasAtrasadas: tarefas.rows[0]?.n ?? 0,
    };
  }

  /**
   * Trabalhos do pg-boss (banco de controle, schema `pgboss`, um só para a plataforma) que já deviam ter começado,
   * com o critério do `/api/saude/detalhada` da VPS, mas só os desta empresa (`data.empresaId`, que os produtores
   * gravam) e os recorrentes da plataforma (sem empresa, mas parados indicam o trabalhador fora do ar para todas). A
   * fila `genesis-tarefa` fica de fora: a linha `tarefas` da empresa já conta a mesma tarefa. A fila inteira continua
   * só no `/api/saude/detalhada`. `null` = não deu para ler (a tabela some até o primeiro `iniciar`: aí é 0).
   */
  private async tarefasPgBoss(empresaId: string): Promise<number | null> {
    try {
      const { rows } = await this.controle.pool.query<{ existe: boolean }>(
        "select to_regclass('pgboss.job') is not null as existe",
      );
      if (!rows[0]?.existe) return 0;
      const r = await this.controle.pool.query<{ n: number }>(
        `select count(*)::int as n from pgboss.job
          where state in ('created', 'retry') and start_after < now() - make_interval(mins => $1)
            and name <> $2 and (data->>'empresaId' = $3 or name = any($4::text[]))`,
        [MINUTOS_TAREFA_ATRASADA, FILAS.tarefa, empresaId, FILAS_DA_PLATAFORMA],
      );
      return r.rows[0]?.n ?? 0;
    } catch {
      return null;
    }
  }
}

function formatarDia(iso: string): string {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}
