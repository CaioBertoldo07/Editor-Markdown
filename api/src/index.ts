import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createAuth } from './auth/auth.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { CompileJobs, DEFAULT_JOB_OPTIONS, callCompiler } from './latex/compileJobs.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbPoolMax);
const auth = createAuth(config, pool);
const compileJobs = config.compiler
  ? new CompileJobs((request, signal) => callCompiler(config.compiler!, request, signal), {
      ...DEFAULT_JOB_OPTIONS,
      ratePerMinute: config.compiler.ratePerMinute,
      maxActivePerUser: config.compiler.maxActivePerUser,
    })
  : null;
const app = createApp({
  pool,
  auth,
  compileJobs,
  proxy: config.proxySecret
    ? { secret: config.proxySecret, required: config.proxyRequired, ipAddressHeaders: config.ipAddressHeaders }
    : null,
  staging: {
    accessKey: config.stagingAccessKey,
    diagnostics: config.requestDiagnostics,
    ipAddressHeaders: config.ipAddressHeaders,
    trustedProxies: config.trustedProxies,
  },
});

console.log(config.compiler ? '[api] compilação LaTeX ligada' : '[api] compilação LaTeX desligada (sem COMPILER_URL)');
if (config.proxySecret) console.log(`[api] proxy confiável ligado${config.proxyRequired ? ' (obrigatório)' : ''}`);
if (config.stagingAccessKey) console.log('[api] modo staging: x-staging-key obrigatório (exceto /api/health)');
if (config.requestDiagnostics) console.log('[api] diagnóstico de cabeçalhos ligado em /api/_diag/request');

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[api] ouvindo na porta ${info.port} (${config.nodeEnv})`);
});

const shutdown = (signal: string) => {
  console.log(`[api] ${signal} recebido, encerrando...`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
