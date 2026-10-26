import { createMiddleware } from 'hono/factory';
import type { Auth } from './auth.js';

export type AuthVariables = { userId: string };

/**
 * Exige sessão válida (cookie do Better Auth conferido no banco, não expirado).
 * A identidade usada pela API sai SÓ daqui — nunca do corpo ou da URL.
 */
export function requireSession(auth: Auth) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const result = await auth.api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
    const session = result.response;

    if (!session?.user?.id) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    c.set('userId', session.user.id);
    await next();

    // Renovação do cookie (updateAge) quando o Better Auth estende a sessão.
    for (const cookie of result.headers.getSetCookie()) {
      c.res.headers.append('Set-Cookie', cookie);
    }
  });
}
