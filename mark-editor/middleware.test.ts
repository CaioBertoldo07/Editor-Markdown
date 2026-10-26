import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import middleware from './middleware';

const ORIGIN = 'https://api.example.test';
const SECRET = 'segredo-de-teste-do-proxy-com-mais-de-32-caracteres';
const ID = '11111111-1111-4111-8111-111111111111';

const upstream = (impl: (url: URL, init: RequestInit) => Promise<Response>) => {
  const fn = vi.fn((input: URL | string, init?: RequestInit) => impl(new URL(String(input)), init ?? {}));
  vi.stubGlobal('fetch', fn);
  return fn;
};

const browserRequest = (method: string, path: string) =>
  new Request(`https://app.example.test${path}`, {
    method,
    headers: { accept: 'application/json', cookie: 'sessao=abc', 'x-real-ip': '203.0.113.7', 'x-proxy-secret': 'forjado' },
  });

beforeEach(() => {
  vi.stubEnv('API_ORIGIN', ORIGIN);
  vi.stubEnv('API_PROXY_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('middleware da Vercel', () => {
  it('DELETE com 204 sem corpo chega ao navegador como 204 sem corpo', async () => {
    const fetchFn = upstream(async () => new Response(null, { status: 204, headers: { 'x-railway-request-id': 'req-1', 'cache-control': 'no-store' } }));
    const res = await middleware(browserRequest('DELETE', `/api/documents/${ID}`));

    expect(res.status).toBe(204);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('');
    expect(res.headers.get('x-railway-request-id')).toBe('req-1');
    expect(res.headers.get('cache-control')).toBe('no-store');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe(`${ORIGIN}/api/documents/${ID}`);
    expect(init!.method).toBe('DELETE');
    const sent = new Headers(init!.headers);
    expect(sent.get('x-proxy-secret')).toBe(SECRET);
    expect(sent.get('x-client-ip')).toBe('203.0.113.7');
    expect(sent.get('cookie')).toBe('sessao=abc');
  });

  it('erro da API (404 com JSON) passa com o mesmo status e corpo', async () => {
    upstream(async () => Response.json({ error: 'document_not_found' }, { status: 404 }));
    const res = await middleware(browserRequest('DELETE', `/api/documents/${ID}`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'document_not_found' });
  });

  it('vários Set-Cookie da API chegam separados', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1; Path=/; HttpOnly');
    headers.append('set-cookie', 'b=2; Path=/; HttpOnly');
    upstream(async () => new Response(null, { status: 204, headers }));
    const res = await middleware(browserRequest('POST', '/api/auth/sign-out'));
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/; HttpOnly', 'b=2; Path=/; HttpOnly']);
  });

  it('API inalcançável: 502 api_unreachable', async () => {
    upstream(async () => {
      throw new TypeError('fetch failed');
    });
    const res = await middleware(browserRequest('DELETE', `/api/documents/${ID}`));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'api_unreachable' });
  });

  it('variáveis ausentes: 503 api_not_configured, sem chamar a API', async () => {
    vi.stubEnv('API_ORIGIN', '');
    const fetchFn = upstream(async () => new Response(null, { status: 204 }));
    const res = await middleware(browserRequest('DELETE', `/api/documents/${ID}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'api_not_configured' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
