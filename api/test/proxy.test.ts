import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIGN_IN_MAX_PER_IP } from '../src/auth/auth.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ORIGIN, createUser, makeTestApp, type TestContext } from './helpers.js';

const SECRET = randomBytes(24).toString('hex');
const STAGING_KEY = randomBytes(24).toString('hex');

describe('proxy confiável da Vercel', () => {
  let ctx: TestContext;
  let required: ReturnType<typeof createApp>;
  let optional: ReturnType<typeof createApp>;

  beforeAll(async () => {
    ctx = await makeTestApp();
    const staging = { accessKey: STAGING_KEY, diagnostics: true, ipAddressHeaders: ['x-forwarded-for'], trustedProxies: [] };
    required = createApp({
      pool: ctx.pool,
      auth: ctx.auth,
      proxy: { secret: SECRET, required: true, ipAddressHeaders: ['x-forwarded-for'] },
    });
    optional = createApp({
      pool: ctx.pool,
      auth: ctx.auth,
      proxy: { secret: SECRET, required: false, ipAddressHeaders: ['x-forwarded-for'] },
      staging,
    });
  });
  afterAll(async () => ctx.close());

  const call = (app: ReturnType<typeof createApp>, method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    app.request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });

  it('obrigatório: sem o segredo, só /api/health responde', async () => {
    expect((await call(required, 'GET', '/api/health', {})).status).toBe(200);
    expect((await call(required, 'GET', '/api/auth/get-session', {})).status).toBe(404);
    expect((await call(required, 'GET', '/api/documents', { 'x-proxy-secret': 'x'.repeat(48) })).status).toBe(404);
    expect((await call(required, 'GET', '/api/documents', { 'x-proxy-secret': SECRET })).status).toBe(401);
  });

  it('com o segredo, o rate limit usa x-client-ip e ignora X-Forwarded-For forjado', async () => {
    const victimIp = '203.0.113.200';
    const statuses: number[] = [];
    for (let i = 0; i < SIGN_IN_MAX_PER_IP + 1; i += 1) {
      // O atacante troca o X-Forwarded-For a cada tentativa; o proxy manda o IP real.
      const res = await call(
        required,
        'POST',
        '/api/auth/sign-in/email',
        { 'x-proxy-secret': SECRET, 'x-client-ip': victimIp, 'x-forwarded-for': `198.51.100.${i}` },
        { email: `ninguem-${i}@example.test`, password: 'senha-errada-123' }
      );
      statuses.push(res.status);
    }
    expect(statuses.at(-1)).toBe(429);

    // Outro cliente real (outro x-client-ip) continua entrando.
    const user = await createUser(ctx.admin);
    const ok = await call(
      required,
      'POST',
      '/api/auth/sign-in/email',
      { 'x-proxy-secret': SECRET, 'x-client-ip': '203.0.113.201' },
      { email: user.email, password: user.password }
    );
    expect(ok.status).toBe(200);
  });

  it('x-client-ip só vale com o segredo; sem ele, x-client-ip é ignorado', async () => {
    const res = await call(optional, 'GET', '/api/_diag/request', {
      'x-staging-key': STAGING_KEY,
      'x-client-ip': '198.51.100.9',
      'x-forwarded-for': '10.1.2.3',
    });
    expect(((await res.json()) as { rateLimitIp: string }).rateLimitIp).toBe('10.1.x.x');
  });

  it('staging: chamada do proxy dispensa x-staging-key e o diagnóstico mostra o IP do cliente', async () => {
    expect((await call(optional, 'GET', '/api/documents', {})).status).toBe(404);
    const res = await call(optional, 'GET', '/api/_diag/request', {
      'x-proxy-secret': SECRET,
      'x-client-ip': '203.0.113.45',
      'x-forwarded-for': '198.51.100.1',
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).rateLimitIp).toBe('203.0.x.x');
  });

  it('x-client-ip inválido não vira IP do rate limit', async () => {
    const res = await call(optional, 'GET', '/api/_diag/request', { 'x-proxy-secret': SECRET, 'x-client-ip': 'lixo' });
    // Sem IP válido, o Better Auth cai no fallback local de teste (loopback), nunca no valor enviado.
    const ip = ((await res.json()) as { rateLimitIp: string | null }).rateLimitIp;
    expect(ip === null || ip === '127.0.x.x').toBe(true);
  });

  it('configuração: segredo curto recusado; obrigatório exige segredo', () => {
    const base = { DATABASE_URL: 'postgres://x', BETTER_AUTH_SECRET: 's'.repeat(40), BETTER_AUTH_URL: 'https://a.test' };
    expect(() => loadConfig({ ...base, PROXY_SECRET: 'curto' })).toThrow(/PROXY_SECRET/);
    expect(() => loadConfig({ ...base, PROXY_REQUIRED: 'true' })).toThrow(/PROXY_SECRET/);
    expect(loadConfig({ ...base, PROXY_SECRET: SECRET, PROXY_REQUIRED: 'true' })).toMatchObject({
      proxySecret: SECRET,
      proxyRequired: true,
    });
    expect(loadConfig(base).proxySecret).toBeNull();
  });
});
