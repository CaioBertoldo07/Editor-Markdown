import { createMiddleware } from 'hono/factory';

/**
 * Limite de tentativas de login POR E-MAIL, complementar ao rate limit por IP
 * do Better Auth: quem troca de IP a cada tentativa continua barrado na conta.
 * Em memória (uma instância da API); um login bem-sucedido zera o contador.
 */
export type LoginThrottleOptions = { max: number; windowMs: number; now?: () => number };

export const DEFAULT_LOGIN_THROTTLE: LoginThrottleOptions = { max: 10, windowMs: 15 * 60 * 1000 };

export function createLoginThrottle(options: LoginThrottleOptions = DEFAULT_LOGIN_THROTTLE) {
  const now = options.now ?? Date.now;
  const attempts = new Map<string, { count: number; startedAt: number }>();

  const prune = () => {
    const t = now();
    for (const [key, entry] of attempts) {
      if (t - entry.startedAt >= options.windowMs) attempts.delete(key);
    }
  };

  return createMiddleware(async (c, next) => {
    let email: string | null = null;
    try {
      const body: unknown = await c.req.raw.clone().json();
      if (body && typeof body === 'object' && typeof (body as { email?: unknown }).email === 'string') {
        email = (body as { email: string }).email.trim().toLowerCase();
      }
    } catch {
      // corpo inválido: o Better Auth responde 400
    }

    if (!email) return next();

    if (attempts.size > 10_000) prune();
    const t = now();
    let entry = attempts.get(email);
    if (!entry || t - entry.startedAt >= options.windowMs) {
      entry = { count: 0, startedAt: t };
      attempts.set(email, entry);
    }

    if (entry.count >= options.max) {
      const retryAfter = Math.ceil((entry.startedAt + options.windowMs - t) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'too_many_attempts' }, 429);
    }

    entry.count += 1;
    await next();

    if (c.res.status === 200) attempts.delete(email);
  });
}
