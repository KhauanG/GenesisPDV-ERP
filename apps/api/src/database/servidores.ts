import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import pg from 'pg';
import type { Cifra } from '../seguranca/cifra.js';
import { gerarSegredo } from '../seguranca/tokens.js';
import type { BancoControle } from './controle/conexao.js';
import { empresas, servidoresBanco } from './controle/schema.js';
import { garantirRoleAplicacao } from './roles-empresa.js';

export interface DadosConexao {
  host: string;
  porta: number;
  usuario: string;
  senha: string;
}

const AAD_SENHA = 'servidores_banco.senha_cifrada';
export const AAD_SENHA_EMPRESA = 'empresas.senha_banco_cifrada';

export class SemRoleAplicacaoErro extends Error {
  constructor(codigo: number) {
    super(`Empresa ${codigo} sem role de aplicação no banco: rode db:migrate:empresas`);
    this.name = 'SemRoleAplicacaoErro';
  }
}
const NOME_PADRAO = 'padrao';

/**
 * Servidores PostgreSQL das empresas (MD 2.2): credenciais cifradas no controle, decifradas só em memória. A role do
 * servidor é a dona dos bancos (provisionamento e migrações); as requisições usam a role de runtime da empresa.
 */
export class ServidoresBanco {
  private readonly cache = new Map<string, DadosConexao>();
  private readonly cacheEmpresas = new Map<string, DadosConexao>();

  constructor(
    private readonly controle: BancoControle,
    private readonly cifra: Cifra,
    private readonly urlPadrao: string,
  ) {}

  async obter(id: string): Promise<DadosConexao> {
    const emCache = this.cache.get(id);
    if (emCache) return emCache;
    const [s] = await this.controle.db.select().from(servidoresBanco).where(eq(servidoresBanco.id, id));
    if (!s) throw new Error(`Servidor de banco ${id} não encontrado`);
    const dados = {
      host: s.host,
      porta: s.porta,
      usuario: s.usuario,
      senha: this.cifra.decifrarTexto(s.senhaCifrada, AAD_SENHA),
    };
    this.cache.set(id, dados);
    return dados;
  }

  /** Credenciais de runtime da empresa (role própria, MD 1.4) no servidor dela. */
  async credenciaisEmpresa(empresaId: string): Promise<DadosConexao> {
    const emCache = this.cacheEmpresas.get(empresaId);
    if (emCache) return emCache;
    const [e] = await this.controle.db
      .select({
        codigo: empresas.codigo,
        servidorId: empresas.servidorBancoId,
        usuario: empresas.usuarioBanco,
        senha: empresas.senhaBancoCifrada,
      })
      .from(empresas)
      .where(eq(empresas.id, empresaId));
    if (!e) throw new Error(`Empresa ${empresaId} não encontrada`);
    if (!e.usuario || !e.senha) throw new SemRoleAplicacaoErro(e.codigo);
    const servidor = await this.obter(e.servidorId);
    const dados = {
      host: servidor.host,
      porta: servidor.porta,
      usuario: e.usuario,
      senha: this.cifra.decifrarTexto(e.senha, AAD_SENHA_EMPRESA),
    };
    this.cacheEmpresas.set(empresaId, dados);
    return dados;
  }

  /**
   * Garante a role de runtime da empresa e os privilégios dela (depois de cada migração). A senha nasce aqui uma
   * vez, cifrada no controle; as execuções seguintes só reaplicam os privilégios.
   */
  async garantirRoleAplicacao(
    cliente: pg.ClientBase,
    empresa: { id: string; nomeBanco: string },
  ): Promise<void> {
    const [e] = await this.controle.db
      .select({ senha: empresas.senhaBancoCifrada })
      .from(empresas)
      .where(eq(empresas.id, empresa.id));
    const senha = e?.senha ? this.cifra.decifrarTexto(e.senha, AAD_SENHA_EMPRESA) : gerarSegredo(24);
    const role = await garantirRoleAplicacao(cliente, empresa.nomeBanco, senha);
    if (!e?.senha) {
      await this.controle.db
        .update(empresas)
        .set({ usuarioBanco: role, senhaBancoCifrada: this.cifra.cifrar(senha, AAD_SENHA_EMPRESA) })
        .where(eq(empresas.id, empresa.id));
    }
    this.cacheEmpresas.delete(empresa.id);
  }

  /** Registra o servidor padrão a partir de EMPRESAS_SERVIDOR_URL/DATABASE_URL, se ainda não existir. */
  async garantirPadrao(): Promise<string> {
    const [existente] = await this.controle.db
      .select({ id: servidoresBanco.id })
      .from(servidoresBanco)
      .where(and(eq(servidoresBanco.nome, NOME_PADRAO), isNull(servidoresBanco.excluidoEm)));
    if (existente) return existente.id;
    const url = new URL(this.urlPadrao);
    const [novo] = await this.controle.db
      .insert(servidoresBanco)
      .values({
        nome: NOME_PADRAO,
        host: url.hostname,
        porta: Number(url.port || 5432),
        usuario: decodeURIComponent(url.username),
        senhaCifrada: this.cifra.cifrar(decodeURIComponent(url.password), AAD_SENHA),
        observacoes: 'Criado automaticamente a partir da configuração da API',
      })
      .onConflictDoNothing()
      .returning({ id: servidoresBanco.id });
    if (novo) return novo.id;
    return this.garantirPadrao();
  }

  /** Servidor ativo que aceita novas empresas, com menos empresas (permite espalhar a carga). */
  async escolherParaNovaEmpresa(): Promise<string> {
    const candidatos = await this.controle.db
      .select({
        id: servidoresBanco.id,
        capacidade: servidoresBanco.capacidadeEmpresas,
        total: sql<number>`(select count(*)::int from empresas e where e.servidor_banco_id = servidores_banco.id)`,
      })
      .from(servidoresBanco)
      .where(
        and(
          eq(servidoresBanco.ativo, true),
          eq(servidoresBanco.aceitaNovasEmpresas, true),
          isNull(servidoresBanco.excluidoEm),
        ),
      )
      .orderBy(asc(servidoresBanco.criadoEm));
    const livre = candidatos
      .filter((c) => c.capacidade === null || c.total < c.capacidade)
      .sort((a, b) => a.total - b.total)[0];
    return livre?.id ?? this.garantirPadrao();
  }

  async conectar(servidorId: string, database: string, applicationName: string): Promise<pg.Client> {
    const d = await this.obter(servidorId);
    const cliente = new pg.Client({
      host: d.host,
      port: d.porta,
      user: d.usuario,
      password: d.senha,
      database,
      application_name: applicationName,
    });
    await cliente.connect();
    return cliente;
  }
}
