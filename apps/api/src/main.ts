import { carregarArquivosEnv, carregarConfiguracao } from './config/configuracao.js';
import { criarAplicacao } from './app.js';
import {
  criarLoggerProcesso,
  memoriaDoProcesso,
  registrarDiagnosticoProcesso,
  vigiarHeap,
} from './comum/processo.js';

carregarArquivosEnv();
const config = carregarConfiguracao();
// Antes de criar a aplicação: uma falha na subida (banco fora do ar...) também fica no log (decisão 166).
const logProcesso = criarLoggerProcesso(config.log.nivel);
registrarDiagnosticoProcesso(logProcesso);
vigiarHeap(logProcesso);
const { app } = await criarAplicacao(config);
await app.listen(config.porta);
// Uma linha por subida: o reinício sem implantação aparece no log (e em `processo.no_ar_segundos` da saúde detalhada).
logProcesso.info(
  {
    versao: config.versao,
    porta: config.porta,
    pid: process.pid,
    node: process.version,
    memoria: memoriaDoProcesso(),
  },
  'API no ar',
);
