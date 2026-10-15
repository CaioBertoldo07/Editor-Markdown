import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth/auth.js';
import type { LoginThrottleOptions } from '../src/auth/login-throttle.js';
import type { Config } from '../src/config.js';
import { createPool } from '../src/db/pool.js';

export const ORIGIN = 'https://editor.test';

export function testConfig(databaseUrl: string): Config {
  return {
    nodeEnv: 'test',
    port: 0,
    host: '127.0.0.1',
    databaseUrl,
    dbPoolMax: 5,
    authSecret: 'test-secret-only-for-automated-tests-0123456789',
    baseUrl: ORIGIN,
    trustedOrigins: [ORIGIN],
    ipAddressHeaders: ['x-forwarded-for'],
    trustedProxies: [],
    secureCookies: true,
    stagingAccessKey: null,
    requestDiagnostics: false,
  };
}

export type TestContext = Awaited<ReturnType<typeof makeTestApp>>;

export async function makeTestApp(options: { loginThrottle?: LoginThrottleOptions } = {}) {
  const config = testConfig(inject('apiUrl'));
  const pool = createPool(config.databaseUrl, config.dbPoolMax);
  const auth = createAuth(config, pool);
  const app = createApp({ pool, auth, loginThrottle: options.loginThrottle });
  const admin = new pg.Pool({ connectionString: inject('adminUrl'), max: 3 });
  return {
    app,
    auth,
    pool,
    admin,
    close: async () => {
      await pool.end();
      await admin.end();
    },
  };
}

/**
 * Hash no formato gravado pelo Neon Auth (Better Auth): scrypt N=16384, r=16,
 * p=1, 64 bytes; "salt:chave" em hex, 161 caracteres. Implementado aqui de
 * forma independente com node:crypto para provar a compatibilidade.
 */
export function neonStyleHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password.normalize('NFKC'), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  });
  return `${salt}:${key.toString('hex')}`;
}

export type FakeUser = { id: string; accountId: string; email: string; password: string };

/** Insere um usuário FICTÍCIO como a importação do Neon fará: IDs e hash prontos. */
export async function createUser(
  admin: pg.Pool,
  overrides: Partial<FakeUser> & { name?: string; createdAt?: string } = {}
): Promise<FakeUser> {
  const user: FakeUser = {
    id: overrides.id ?? randomUUID(),
    accountId: overrides.accountId ?? randomUUID(),
    email: overrides.email ?? `user-${randomUUID().slice(0, 8)}@example.test`,
    password: overrides.password ?? `senha-${randomUUID()}`,
  };
  const createdAt = overrides.createdAt ?? new Date().toISOString();
  await admin.query(
    `INSERT INTO app_auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, false, $4, $4)`,
    [user.id, overrides.name ?? 'Pessoa Fictícia', user.email, createdAt]
  );
  await admin.query(
    `INSERT INTO app_auth.account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
     VALUES ($1, $2, 'credential', $3, $4, $5, $5)`,
    [user.accountId, user.id, user.id, neonStyleHash(user.password), createdAt]
  );
  return user;
}

let ipSeq = 0;
const ipBase = Math.floor(Math.random() * 200);
/** IP fictício único por chamada, para o rate limit por IP não vazar entre testes. */
export const nextIp = () => {
  ipSeq += 1;
  return `10.${ipBase}.${Math.floor(ipSeq / 256) % 256}.${ipSeq % 256}`;
};

type RequestOptions = { cookie?: string; body?: unknown; ip?: string; headers?: Record<string, string> };

export function request(ctx: TestContext, method: string, path: string, options: RequestOptions = {}) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    'x-forwarded-for': options.ip ?? nextIp(),
    ...options.headers,
  };
  if (options.cookie) headers.cookie = options.cookie;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  return ctx.app.request(`${ORIGIN}${path}`, { method, headers, body });
}

export function signIn(ctx: TestContext, email: string, password: string, ip?: string) {
  return request(ctx, 'POST', '/api/auth/sign-in/email', { body: { email, password }, ip });
}

/** Converte os Set-Cookie da resposta num cabeçalho Cookie. */
export function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

export async function login(ctx: TestContext, user: FakeUser): Promise<string> {
  const res = await signIn(ctx, user.email, user.password);
  if (res.status !== 200) throw new Error(`login falhou: ${res.status} ${await res.text()}`);
  return cookieHeader(res);
}
