import { timingSafeEqual, createHash } from 'node:crypto';
import { getIp } from '@better-auth/core/utils/ip';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

/**
 * Recursos SÓ PARA STAGING. Em produção as duas variáveis ficam vazias e nada
 * disto é montado.
 */

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Exige `x-staging-key` em todas as rotas, exceto GET /api/health (usado pelo
 * healthcheck do Railway). Sem a chave: 404, como se a API não existisse.
 */
export function stagingGate(accessKey: string) {
  const expected = digest(accessKey);
  return createMiddleware<{ Variables: { viaProxy?: boolean } }>(async (c, next) => {
    if (c.req.method === 'GET' && c.req.path === '/api/health') return next();
    // Chamadas do proxy da Vercel (Preview -> staging) já provaram o segredo do proxy.
    if (c.get('viaProxy')) return next();
    const provided = c.req.header('x-staging-key');
    if (!provided || !timingSafeEqual(digest(provided), expected)) {
      return c.json({ error: 'not_found' }, 404);
    }
    return next();
  });
}

/** Mascara um IP: 203.0.113.45 -> 203.0.x.x; 2001:db8:1::5 -> 2001:db8:x */
export function maskIp(value: string): string {
  const ip = value.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.split('.').slice(0, 2).join('.') + '.x.x';
  if (ip.includes(':')) return ip.split(':').filter(Boolean).slice(0, 2).join(':') + ':x';
  return ip ? '(não-IP)' : '(vazio)';
}

const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'x-envoy-external-address',
  'forwarded',
  'cf-connecting-ip',
  'true-client-ip',
  'x-vercel-forwarded-for',
  'x-vercel-proxied-for',
];

/**
 * Mostra como a requisição chega à API: nomes dos cabeçalhos, quantos saltos
 * cada cabeçalho de encaminhamento tem (IPs mascarados) e qual IP o Better Auth
 * usaria para o rate limit com a configuração atual. Nunca mostra valores de
 * cookies, autorização ou corpo.
 */
export function requestDiagnostics(options: { ipAddressHeaders: string[]; trustedProxies: string[] }) {
  return (c: Context) => {
    const headers = c.req.raw.headers;
    const forwarding: Record<string, { hops: number; masked: string[] }> = {};
    for (const name of FORWARDING_HEADERS) {
      const value = headers.get(name);
      if (value === null) continue;
      const parts = name === 'forwarded' ? value.split(',') : value.split(',').map((p) => p.trim());
      forwarding[name] = {
        hops: parts.filter(Boolean).length,
        masked: name === 'forwarded' ? parts.map(() => '(oculto)') : parts.filter(Boolean).map(maskIp),
      };
    }
    const resolved = getIp(c.req.raw, {
      advanced: {
        ipAddress: {
          ipAddressHeaders: options.ipAddressHeaders,
          ...(options.trustedProxies.length > 0 ? { trustedProxies: options.trustedProxies } : {}),
        },
      },
    } as Parameters<typeof getIp>[1]);
    return c.json({
      headerNames: [...headers.keys()].sort(),
      forwarding,
      rateLimitIp: resolved ? maskIp(resolved) : null,
      rateLimitIpSource: options.ipAddressHeaders,
      trustedProxiesConfigured: options.trustedProxies.length,
    });
  };
}
