import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth/auth.js';
import { loadConfig } from '../src/config.js';
import { maskIp } from '../src/http/staging.js';
import { runStagingCheck } from '../src/ops/staging-check.js';
import { ORIGIN, makeTestApp, testConfig, type TestContext } from './helpers.js';

const KEY = randomBytes(24).toString('hex');

describe('chave de acesso do staging', () => {
  let ctx: TestContext;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    ctx = await makeTestApp();
    app = createApp({
      pool: ctx.pool,
      auth: ctx.auth,
      staging: { accessKey: KEY, diagnostics: true, ipAddressHeaders: ['x-forwarded-for'], trustedProxies: [] },
    });
  });
  afterAll(async () => ctx.close());

  const req = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    app.request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, ...headers } });

  it('health continua aberto (healthcheck do Railway)', async () => {
    expect((await req('/api/health')).status).toBe(200);
  });

  it('sem chave ou com chave errada: 404 em tudo, inclusive login', async () => {
    expect((await req('/api/documents')).status).toBe(404);
    expect((await req('/api/auth/get-session')).status).toBe(404);
    expect((await req('/api/auth/sign-in/email', { 'content-type': 'application/json' }, 'POST')).status).toBe(404);
    expect((await req('/api/documents', { 'x-staging-key': 'x'.repeat(48) })).status).toBe(404);
    expect((await req('/api/_diag/request')).status).toBe(404);
  });

  it('com a chave certa a API responde normalmente', async () => {
    expect((await req('/api/documents', { 'x-staging-key': KEY })).status).toBe(401);
  });

  it('diagnóstico mostra saltos e IPs mascarados, nunca cookies ou valores sensíveis', async () => {
    const res = await req('/api/_diag/request', {
      'x-staging-key': KEY,
      'x-forwarded-for': '203.0.113.45, 198.51.100.7',
      'x-real-ip': '203.0.113.45',
      cookie: 'segredo=1',
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('203.0.113.45');
    expect(text).not.toContain('segredo');
    expect(text).not.toContain(KEY);
    const body = JSON.parse(text);
    expect(body.forwarding['x-forwarded-for']).toEqual({ hops: 2, masked: ['203.0.x.x', '198.51.x.x'] });
    expect(body.headerNames).toContain('cookie');
  });

  it('mascara IPv4 e IPv6', () => {
    expect(maskIp('203.0.113.45')).toBe('203.0.x.x');
    expect(maskIp('2001:db8:1::5')).toBe('2001:db8:x');
  });

  it('a configuração recusa chave curta e liga só quando definida', () => {
    const base = { DATABASE_URL: 'postgres://x', BETTER_AUTH_SECRET: 's'.repeat(40), BETTER_AUTH_URL: 'https://a.test' };
    expect(() => loadConfig({ ...base, STAGING_ACCESS_KEY: 'curta' })).toThrow(/STAGING_ACCESS_KEY/);
    expect(loadConfig(base).stagingAccessKey).toBeNull();
    expect(loadConfig(base).requestDiagnostics).toBe(false);
    expect(loadConfig({ ...base, STAGING_ACCESS_KEY: KEY, ENABLE_REQUEST_DIAGNOSTICS: 'true' })).toMatchObject({
      stagingAccessKey: KEY,
      requestDiagnostics: true,
    });
  });
});

describe('job staging-check (contra um servidor HTTP real)', () => {
  let server: ServerType;
  let base = '';
  let close: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await makeTestApp();
    const config = testConfig(inject('apiUrl'));
    const app = createApp({
      pool: ctx.pool,
      auth: createAuth(config, ctx.pool),
      staging: { accessKey: KEY, diagnostics: true, ipAddressHeaders: ['x-forwarded-for'], trustedProxies: [] },
    });
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = async () => {
      await new Promise((r) => server.close(r));
      await ctx.close();
    };
  });
  afterAll(async () => close());

  it('todas as verificações passam e nada fictício sobra no banco', { timeout: 120_000 }, async () => {
    const lines: string[] = [];
    const ok = await runStagingCheck(
      { adminUrl: inject('adminUrl'), privateUrl: base, publicUrl: base, origin: ORIGIN, accessKey: KEY },
      (l) => lines.push(l)
    );
    const failures = lines.filter((l) => l.startsWith('FAIL'));
    expect(failures).toEqual([]);
    expect(ok).toBe(true);
    // Nada sensível nos logs
    const all = lines.join('\n');
    expect(all).not.toContain(KEY);
    expect(all).not.toMatch(/session_token=/);
    expect(all).not.toMatch(/[0-9a-f]{32}:[0-9a-f]{128}/);
    expect(all).toMatch(/RESULTADO: (\d+)\/\1 verificações aprovadas/);
  });
});
