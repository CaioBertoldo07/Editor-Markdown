import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type pg from 'pg';
import type { Auth } from './auth/auth.js';
import { createLoginThrottle, type LoginThrottleOptions } from './auth/login-throttle.js';
import { requireSession, type AuthVariables } from './auth/session.js';
import { handleError } from './http/errors.js';
import { proxyTrust, type ProxyOptions, type ProxyVariables } from './http/proxy.js';
import { requestDiagnostics, stagingGate } from './http/staging.js';
import type { CompileJobs } from './latex/compileJobs.js';
import { compileJobsRoutes, compileStartRoute } from './routes/compile.js';
import { documentsRoutes } from './routes/documents.js';
import { foldersRoutes } from './routes/folders.js';
import { latexFilesRoutes } from './routes/latexFiles.js';

export type AppDeps = {
  pool: pg.Pool;
  auth: Auth;
  loginThrottle?: LoginThrottleOptions;
  /** Proxy confiável da Vercel (segredo compartilhado + IP real do cliente). */
  proxy?: ProxyOptions | null;
  /** Compilações LaTeX; null/ausente = compilador não configurado (503). */
  compileJobs?: CompileJobs | null;
  /** Só staging: chave de acesso e diagnóstico de cabeçalhos. */
  staging?: {
    accessKey: string | null;
    diagnostics: boolean;
    ipAddressHeaders: string[];
    trustedProxies: string[];
  };
};

export function createApp({ pool, auth, loginThrottle, staging, proxy, compileJobs = null }: AppDeps) {
  const app = new Hono<{ Variables: AuthVariables & ProxyVariables }>();

  app.use('*', secureHeaders());
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  // Antes de tudo: decide se a chamada veio do proxy da Vercel e fixa o IP do cliente.
  if (proxy) app.use('*', proxyTrust(proxy));
  if (staging?.accessKey) app.use('*', stagingGate(staging.accessKey));

  app.get('/api/health', async (c) => {
    try {
      await pool.query('SELECT 1');
      return c.json({ status: 'ok' });
    } catch {
      return c.json({ status: 'unavailable' }, 503);
    }
  });

  if (staging?.diagnostics) {
    app.get('/api/_diag/request', requestDiagnostics(staging));
  }

  // Better Auth: login, logout e sessão. Cadastro está desligado na config.
  app.post('/api/auth/sign-in/email', createLoginThrottle(loginThrottle));
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  // Tudo abaixo exige sessão válida.
  const session = requireSession(auth);
  app.use('/api/documents', session);
  app.use('/api/documents/*', session);
  app.use('/api/folders', session);
  app.use('/api/folders/*', session);
  app.use('/api/compile-jobs/*', session);
  // Projetos LaTeX: arquivos e compilação de um documento.
  app.route('/api/documents/:id/files', latexFilesRoutes(pool));
  app.route('/api/documents/:id/compile', compileStartRoute(pool, compileJobs));
  app.route('/api/compile-jobs', compileJobsRoutes(compileJobs));
  app.route('/api/documents', documentsRoutes(pool));
  app.route('/api/folders', foldersRoutes(pool));

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError(handleError);

  return app;
}
