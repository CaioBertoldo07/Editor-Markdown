import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { sweepJobsDir } from './compile.js';
import { loadConfig } from './config.js';
import { sandboxSelfTest, type SelfTest } from './sandbox.js';
import { SlotPool } from './slots.js';

const config = loadConfig();
// O token fica só na config em memória; os processos do TeX recebem um ambiente limpo.
delete process.env.COMPILER_TOKEN;

const pool = new SlotPool(config.concurrency, config.queueLength, config.queueWaitMs);
let selfTest: SelfTest | null = null;

const app = createApp({ config, pool, sandbox: () => selfTest });

await sweepJobsDir(config.jobsDir);
sandboxSelfTest(config)
  .then((result) => {
    selfTest = result;
    for (const check of result.checks) {
      console.log(`[compiler] sandbox: ${check.ok ? 'ok ' : 'FALHOU'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
    }
    console.log(result.ok ? '[compiler] sandbox ativo; compilações liberadas' : '[compiler] SANDBOX INDISPONÍVEL: compilações recusadas (503)');
  })
  .catch((err: Error) => {
    selfTest = { ok: false, checks: [{ name: 'autoteste', ok: false, detail: err.message }] };
    console.error('[compiler] autoteste do sandbox falhou:', err.message);
  });

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[compiler] ouvindo na porta ${info.port} (${config.concurrency} slots, fila ${config.queueLength})`);
});

const shutdown = (signal: string) => {
  console.log(`[compiler] ${signal} recebido, encerrando...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
