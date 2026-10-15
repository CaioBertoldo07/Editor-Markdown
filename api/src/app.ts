import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type pg from 'pg';
import type { Auth } from './auth/auth.js';
import { createLoginThrottle, type LoginThrottleOptions } from './auth/login-throttle.js';
import { requireSession, type AuthVariables } from './auth/session.js';
import { handleError } from './http/errors.js';
import { documentsRoutes } from './routes/documents.js';
import { foldersRoutes } from './routes/folders.js';

export type AppDeps = {
  pool: pg.Pool;
  auth: Auth;
  loginThrottle?: LoginThrottleOptions;
};

export function createApp({ pool, auth, loginThrottle }: AppDeps) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use('*', secureHeaders());
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.get('/api/health', async (c) => {
    try {
      await pool.query('SELECT 1');
      return c.json({ status: 'ok' });
    } catch {
      return c.json({ status: 'unavailable' }, 503);
    }
  });

  // Better Auth: login, logout e sessão. Cadastro está desligado na config.
  app.post('/api/auth/sign-in/email', createLoginThrottle(loginThrottle));
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  // Tudo abaixo exige sessão válida.
  const session = requireSession(auth);
  app.use('/api/documents', session);
  app.use('/api/documents/*', session);
  app.use('/api/folders', session);
  app.use('/api/folders/*', session);
  app.route('/api/documents', documentsRoutes(pool));
  app.route('/api/folders', foldersRoutes(pool));

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError(handleError);

  return app;
}
