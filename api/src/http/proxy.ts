import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { createMiddleware } from 'hono/factory';

/**
 * Confiança no proxy da Vercel (frontend -> /api/* -> Railway).
 *
 * O middleware da Vercel (mark-editor/middleware.ts) repassa as chamadas com:
 *   x-proxy-secret  segredo compartilhado (só existe nas variáveis de servidor
 *                   da Vercel e da API; nunca vai para o bundle)
 *   x-client-ip     IP do navegador, tirado do cabeçalho que a própria Vercel
 *                   define (o cliente não consegue forjá-lo)
 *
 * Com o segredo correto, o IP do rate limit passa a ser `x-client-ip`: todos os
 * cabeçalhos de IP lidos pelo Better Auth são sobrescritos com ele. Sem o
 * segredo, nada muda (acesso direto ao Railway, já validado em staging) — e,
 * com `required`, a requisição nem é atendida (404), exceto GET /api/health.
 */
export type ProxyOptions = {
  secret: string;
  required: boolean;
  /** Os mesmos cabeçalhos configurados em advanced.ipAddress do Better Auth. */
  ipAddressHeaders: string[];
};

export type ProxyVariables = { viaProxy: boolean };

const digest = (value: string) => createHash('sha256').update(value).digest();

export function proxyTrust(options: ProxyOptions) {
  const expected = digest(options.secret);
  return createMiddleware<{ Variables: ProxyVariables }>(async (c, next) => {
    const provided = c.req.header('x-proxy-secret');
    const viaProxy = !!provided && timingSafeEqual(digest(provided), expected);
    c.set('viaProxy', viaProxy);

    if (!viaProxy) {
      if (options.required && !(c.req.method === 'GET' && c.req.path === '/api/health')) {
        return c.json({ error: 'not_found' }, 404);
      }
      return next();
    }

    const headers = new Headers(c.req.raw.headers);
    headers.delete('x-proxy-secret');
    const clientIp = (c.req.header('x-client-ip') ?? '').trim();
    for (const name of options.ipAddressHeaders) {
      if (isIP(clientIp)) headers.set(name, clientIp);
      else headers.delete(name);
    }
    c.req.raw = new Request(c.req.raw, { headers });
    return next();
  });
}
