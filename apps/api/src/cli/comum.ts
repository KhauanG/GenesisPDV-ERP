import { parseArgs, type ParseArgsConfig } from 'node:util';
import { ErroApi } from '../comum/erros.js';
import { carregarArquivosEnv, carregarConfiguracao, type Configuracao } from '../config/configuracao.js';
import { criarServicos, type Servicos } from '../servicos.js';

export function argumentos<T extends NonNullable<ParseArgsConfig['options']>>(opcoes: T) {
  return parseArgs({ options: opcoes, allowPositionals: false, strict: true }).values;
}

/**
 * O `--empresas 100001,100002`: a lista dos códigos, ou `undefined` sem o argumento (todas as empresas). Um item que
 * não é inteiro positivo (`emp100001`, `1O`, `100001;`, a vírgula sobrando) recusa o argumento inteiro: o filtro
 * inválido nunca vira "todas as empresas" sem aviso.
 */
export function codigosEmpresas(valor: string | undefined): number[] | undefined {
  if (valor === undefined) return undefined;
  const itens = valor.split(',').map((c) => c.trim());
  const invalidos = itens.filter((c) => !/^[1-9]\d{0,14}$/.test(c));
  if (invalidos.length)
    throw new Error(
      `--empresas recusado: ${invalidos.map((c) => (c ? `"${c}"` : '(vazio)')).join(', ')} não é código de ` +
        'empresa (use os números separados por vírgula, ex.: --empresas 100001,100002); nada foi feito',
    );
  return [...new Set(itens.map(Number))];
}

export function configuracaoCli(): Configuracao {
  carregarArquivosEnv();
  return carregarConfiguracao();
}

/** Executa um comando com o grafo de serviços e fecha as conexões no fim; erro → código de saída 1. */
export async function executarCli(fn: (s: Servicos) => Promise<number | void>): Promise<void> {
  let servicos: Servicos | undefined;
  try {
    servicos = criarServicos(configuracaoCli(), {
      executadoPor: `cli:${process.env.USER ?? 'desconhecido'}`,
    });
    const codigo = await fn(servicos);
    process.exitCode = typeof codigo === 'number' ? codigo : 0;
  } catch (e) {
    console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof ErroApi && e.extras.campos) {
      for (const [campo, msgs] of Object.entries(e.extras.campos))
        console.error(`  ${campo}: ${msgs.join('; ')}`);
    }
    process.exitCode = 1;
  } finally {
    await servicos?.fechar();
  }
}
