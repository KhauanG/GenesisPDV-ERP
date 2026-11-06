export const meta = {
  name: 'genesis-bloco',
  description:
    'Implementa um bloco de um plano de docs/planos/, revisa por lentes, tenta refutar cada achado, corrige e roda todos os checks (sem commitar)',
  whenToUse:
    'Para cada bloco dos planos em docs/planos/ (ex.: F2-B20, G15). Args: {plano, bloco, branch, repo?, enxuto?}',
  phases: [{ title: 'Implementação' }, { title: 'Revisão' }, { title: 'Correção' }, { title: 'Verificação' }],
};

/* global args, agent, parallel, pipeline, log -- funções do runtime do Workflow do Claude Code */

// Args:
//   plano   — caminho do plano no repositório (ex.: "docs/planos/fase2-plano.md")
//   bloco   — id do bloco (ex.: "F2-B20")
//   branch  — branch de trabalho (o agente não troca de branch)
//   repo    — pasta do repositório ou do worktree (padrão: o diretório de trabalho da sessão)
//   enxuto  — true: 1 lente de revisão (mais barato, menos rigoroso)
//   extra   — instruções adicionais para o implementador (opcional)
const A = args || {};
const B = A.bloco;
const PLANO = A.plano || 'docs/planos/fase2-plano.md';
const REPO = A.repo || 'o diretório de trabalho atual (a raiz do repositório)';
if (!B || !A.branch) throw new Error('Informe args.bloco e args.branch');

const BASE = `Repositório: ${REPO}, branch ${A.branch} (NÃO troque de branch). Siga o CLAUDE.md da raiz (regras, mapa e checks) e o
docs/andamento.md (estado atual). Monorepo pnpm: API NestJS em apps/api (Drizzle, Postgres por empresa), ERP React/Mantine em
apps/erp-web, contratos zod em packages/shared, PDV C#/.NET 10 + Avalonia + EF Core SQLite em apps/pdv. Textos, comentários, nomes e
mensagens em português do Brasil, no estilo e na densidade de comentários do código ao redor.
NÃO faça commit nem push, não dispare workflows do GitHub, não use sleep em primeiro plano, não apague nada fora do escopo.
NADA FISCAL (emissão NFC-e/NF-e, SEFAZ, DF-e, certificado). O PDV instalado nas lojas tem de continuar funcionando com a API nova
(compatibilidade retroativa, versoes_schema). Ao adicionar pacote NuGet, atualize e versione os packages.lock.json
(dotnet restore --force-evaluate); não versione lock gerado por "dotnet publish -r".

PLANO: ${PLANO} (leia a seção do bloco e as partes gerais: estado atual, fora do escopo, perguntas ao dono, padrões aplicados).
Especificações: docs/arquitetura/sincronizacao.md (SYNC), docs/arquitetura/modelo-de-dados.md (MD), docs/erp/especificacao-erp.md (ERP),
docs/pdv/especificacao-pdv.md (PDV), docs/roadmap.md (fases e decisões §16).
DECISÕES DO DONO: docs/planos/decisoes-do-dono.md (fonte da verdade). Pergunta sem resposta: implemente a RECOMENDAÇÃO do plano,
configurável pela chave indicada, registre no README como "padrão até a confirmação do dono" e na tabela do roadmap §16.
Confira a numeração real das migrações Drizzle e das decisões nos READMEs (continue a partir da última).`;

const IMPL = await agent(
  `${BASE}

TAREFA: implemente o BLOCO ${B} exatamente como a seção do bloco no plano descreve (objetivo, arquivos, contratos/migrações, testes,
critério de pronto). Não adiante blocos seguintes além do mínimo para o critério de pronto. Migração Drizzle com drizzle-kit
(snapshot + journal); se tocar tabela espelhada no PDV, mantenha o Esquema.g.cs e o EsquemaNuvemTests verdes. Atualize os READMEs
(decisões numeradas), a especificação e o docs/andamento.md (a linha do bloco).${A.extra ? `\n\nINSTRUÇÕES ADICIONAIS: ${A.extra}` : ''}
Se o working tree já tiver alterações não commitadas deste mesmo bloco (execução anterior interrompida), continue a partir delas.

Ao terminar, rode os checks do CLAUDE.md que o bloco afeta e deixe tudo verde. Responda com: o que foi feito (arquivos), as decisões
técnicas (e onde ficaram documentadas), o que ficou fora e por quê, e o resultado de cada check.`,
  { label: `implementar:${B}`, phase: 'Implementação' },
);

const TODAS = [
  {
    key: 'spec',
    foco: 'aderência ao plano e às especificações: falta algo prometido? contrato diverge entre TS e C#? estados, códigos de erro e mensagens corretos? as decisões do dono foram respeitadas?',
  },
  {
    key: 'seguranca-dados',
    foco: 'segurança e integridade: autorização por loja/estoque/permissão, escalada de privilégio, segredo em log ou banco, transações, idempotência, condições de corrida, travas e deadlock, migrações e triggers de versão, dinheiro/decimal e arredondamento, compatibilidade com o PDV já instalado',
  },
  {
    key: 'testes-qualidade',
    foco: 'testes: cobrem o critério de pronto? falhariam sem a mudança? frágeis (relógio, ordem)? código morto, duplicação, estilo destoante, documentação desatualizada',
  },
];
const LENTES = A.enxuto ? [{ key: 'geral', foco: TODAS.map((l) => l.foco).join(' | ') }] : TODAS;
const ACHADOS = {
  type: 'object',
  properties: {
    achados: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severidade: { type: 'string', enum: ['alta', 'media', 'baixa'] },
          arquivo: { type: 'string' },
          linha: { type: 'number' },
          problema: { type: 'string' },
          cenario: { type: 'string' },
          correcao: { type: 'string' },
        },
        required: ['severidade', 'arquivo', 'problema', 'cenario', 'correcao'],
      },
    },
  },
  required: ['achados'],
};
const VEREDITO = {
  type: 'object',
  properties: { real: { type: 'boolean' }, motivo: { type: 'string' } },
  required: ['real', 'motivo'],
};

const confirmados = (
  await pipeline(
    LENTES,
    (l) =>
      agent(
        `${BASE}\n\nRevise as mudanças não commitadas do BLOCO ${B} (git diff HEAD + arquivos novos do git status) com a lente: ${l.foco}.
Resumo do implementador:\n${IMPL}\n\nReporte só problemas reais e concretos (com cenário de falha), não preferências. Não altere arquivos.`,
        { label: `revisar:${B}:${l.key}`, phase: 'Revisão', schema: ACHADOS },
      ),
    (r) =>
      parallel(
        (r?.achados || []).map(
          (a) => () =>
            agent(
              `${BASE}\n\nTente REFUTAR este achado de revisão do bloco ${B}, lendo o código real
(não altere arquivos). Se não reproduzir o cenário ou ele for irrelevante ou fora do escopo do bloco, real=false.\n${JSON.stringify(a)}`,
              { label: `verificar:${B}:${a.arquivo.split('/').pop()}`, phase: 'Revisão', schema: VEREDITO },
            ).then((v) => (v && v.real ? { ...a, motivo: v.motivo } : null)),
        ),
      ),
  )
)
  .flat()
  .filter(Boolean);
log(`${B}: ${confirmados.length} achados confirmados`);

let CORR = 'nenhum achado confirmado';
if (confirmados.length) {
  CORR = await agent(
    `${BASE}\n\nCorrija TODOS os achados confirmados abaixo do bloco ${B}, cada um com teste quando fizer sentido, e deixe os
checks afetados verdes. Responda com o que fez em cada achado.\n${JSON.stringify(confirmados, null, 1)}`,
    { label: `corrigir:${B}`, phase: 'Correção' },
  );
}

const VERIF = await agent(
  `${BASE}\n\nVERIFICAÇÃO FINAL do bloco ${B}. Não implemente funcionalidade nova; só conserte o que quebrar nos checks.
Rode TODOS os checks do CLAUDE.md, em primeiro plano e esperando o resultado (TS completos e, se o bloco tocou no PDV, restore, format com o
SDK do global.json, build e test). Confira que o git status não tem temporário, .env, .db, bin/obj, dist, .pfx nem dado real.
Se o bloco tem critério de pronto demonstrável, demonstre de verdade (ex.: subir a API local e exercitar o fluxo por HTTP) e diga como.
Responda começando por "Veredito: pronto" ou "Veredito: não pronto", depois a tabela de checks e a lista final de arquivos alterados.`,
  { label: `verificar-final:${B}`, phase: 'Verificação' },
);

return {
  bloco: B,
  impl: IMPL,
  confirmados: confirmados.length,
  achados: confirmados.map((a) => `${a.severidade} ${a.arquivo}: ${a.problema}`),
  correcao: CORR,
  verif: VERIF,
};
