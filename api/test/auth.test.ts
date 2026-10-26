import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cookieHeader,
  createUser,
  login,
  makeTestApp,
  neonStyleHash,
  request,
  signIn,
  type FakeUser,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let ana: FakeUser;

const PRESERVED_USER_ID = randomUUID();
const PRESERVED_ACCOUNT_ID = randomUUID();

beforeAll(async () => {
  ctx = await makeTestApp();
  // Usuário fictício "importado": IDs fixos e hash no formato do Neon Auth.
  ana = await createUser(ctx.admin, {
    id: PRESERVED_USER_ID,
    accountId: PRESERVED_ACCOUNT_ID,
    email: 'ana.ficticia@example.test',
    password: 'senha-correta-da-ana-123',
  });
});

afterAll(async () => {
  await ctx.close();
});

describe('hash de senha compatível com o Neon Auth', () => {
  it('o Better Auth gera o mesmo formato (salt:chave em hex, 161 caracteres)', async () => {
    const hash = await hashPassword('qualquer-senha');
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(hash).toHaveLength(161);
  });

  it('o Better Auth valida um hash gerado de forma independente no formato do Neon', async () => {
    const hash = neonStyleHash('outra-senha-qualquer');
    expect(await verifyPassword({ hash, password: 'outra-senha-qualquer' })).toBe(true);
    expect(await verifyPassword({ hash, password: 'senha-errada' })).toBe(false);
  });
});

describe('login por e-mail e senha', () => {
  it('senha correta: 200, mesmo ID de usuário e cookie HttpOnly + Secure + SameSite=Lax', async () => {
    const res = await signIn(ctx, ana.email, ana.password);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { user: { id: string; email: string } };
    expect(body.user.id).toBe(PRESERVED_USER_ID);
    expect(body.user.email).toBe(ana.email);

    const sessionCookie = res.headers.getSetCookie().find((c) => c.includes('session_token='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/^__Secure-/);
    expect(sessionCookie).toMatch(/;\s*HttpOnly/i);
    expect(sessionCookie).toMatch(/;\s*Secure/i);
    expect(sessionCookie).toMatch(/;\s*SameSite=Lax/i);
    expect(sessionCookie).toMatch(/;\s*Path=\//i);

    // Conta e hash preservados (o login não regrava nada).
    const { rows } = await ctx.admin.query(
      `SELECT id, "userId", "providerId" FROM app_auth.account WHERE "userId" = $1`,
      [PRESERVED_USER_ID]
    );
    expect(rows).toEqual([{ id: PRESERVED_ACCOUNT_ID, userId: PRESERVED_USER_ID, providerId: 'credential' }]);
  });

  it('e-mail com maiúsculas e espaços ainda encontra a conta', async () => {
    const res = await signIn(ctx, 'Ana.Ficticia@Example.TEST', ana.password);
    expect(res.status).toBe(200);
  });

  it('senha incorreta: 401 e nenhum cookie de sessão', async () => {
    const res = await signIn(ctx, ana.email, 'senha-errada-123');
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().some((c) => c.includes('session_token=') && !c.includes('session_token=;'))).toBe(
      false
    );
  });

  it('e-mail inexistente: 401 (sem revelar se a conta existe)', async () => {
    const res = await signIn(ctx, 'ninguem@example.test', 'qualquer-senha-123');
    expect(res.status).toBe(401);
  });

  it('get-session devolve o usuário logado', async () => {
    const cookie = await login(ctx, ana);
    const res = await request(ctx, 'GET', '/api/auth/get-session', { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    expect(body.user.id).toBe(PRESERVED_USER_ID);
  });
});

describe('cadastro público', () => {
  it('está bloqueado e não cria usuário', async () => {
    const email = `novo-${randomUUID().slice(0, 8)}@example.test`;
    const res = await request(ctx, 'POST', '/api/auth/sign-up/email', {
      body: { name: 'Novo', email, password: 'senha-nova-123456' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(cookieHeader(res)).not.toContain('session_token');

    const { rowCount } = await ctx.admin.query(`SELECT 1 FROM app_auth."user" WHERE email = $1`, [email]);
    expect(rowCount).toBe(0);
  });
});

describe('sessão', () => {
  it('sessão expirada: 401', async () => {
    const user = await createUser(ctx.admin);
    const cookie = await login(ctx, user);
    expect((await request(ctx, 'GET', '/api/documents', { cookie })).status).toBe(200);

    await ctx.admin.query(
      `UPDATE app_auth.session SET "expiresAt" = now() - interval '1 minute' WHERE "userId" = $1`,
      [user.id]
    );
    expect((await request(ctx, 'GET', '/api/documents', { cookie })).status).toBe(401);
    expect((await request(ctx, 'GET', '/api/folders', { cookie })).status).toBe(401);
  });

  it('depois do logout o cookie não vale mais', async () => {
    const user = await createUser(ctx.admin);
    const cookie = await login(ctx, user);
    const out = await request(ctx, 'POST', '/api/auth/sign-out', { cookie, body: {} });
    expect(out.status).toBe(200);
    expect((await request(ctx, 'GET', '/api/documents', { cookie })).status).toBe(401);
  });

  it('cookie forjado: 401', async () => {
    const cookie = `__Secure-better-auth.session_token=${randomUUID()}.assinatura-falsa`;
    expect((await request(ctx, 'GET', '/api/documents', { cookie })).status).toBe(401);
  });

  it('sem autenticação, todas as rotas de dados respondem 401', async () => {
    const id = randomUUID();
    const calls: Array<[string, string, unknown?]> = [
      ['GET', '/api/documents'],
      ['POST', '/api/documents', {}],
      ['POST', '/api/documents/import', { documents: [{ title: 'a', content: 'b' }] }],
      ['PATCH', `/api/documents/${id}`, { title: 'x' }],
      ['DELETE', `/api/documents/${id}`],
      ['GET', '/api/folders'],
      ['POST', '/api/folders', { name: 'x' }],
      ['PATCH', `/api/folders/${id}`, { name: 'x' }],
      ['DELETE', `/api/folders/${id}`],
    ];
    for (const [method, path, body] of calls) {
      const res = await request(ctx, method, path, { body });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('saúde', () => {
  it('GET /api/health responde ok sem autenticação', async () => {
    const res = await request(ctx, 'GET', '/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
