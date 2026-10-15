import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIGN_IN_MAX_PER_IP } from '../src/auth/auth.js';
import { createUser, makeTestApp, nextIp, signIn, type FakeUser, type TestContext } from './helpers.js';

let ctx: TestContext;
let target: FakeUser;

beforeAll(async () => {
  ctx = await makeTestApp({ loginThrottle: { max: 4, windowMs: 60_000 } });
  target = await createUser(ctx.admin, { email: 'alvo@example.test' });
});

afterAll(async () => {
  await ctx.close();
});

describe('rate limit de autenticação', () => {
  it(`por IP: após ${SIGN_IN_MAX_PER_IP} tentativas em 60 s, o mesmo IP recebe 429`, async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < SIGN_IN_MAX_PER_IP + 1; i += 1) {
      // e-mails diferentes para isolar do limite por conta
      const res = await signIn(ctx, `inexistente-${i}@example.test`, 'senha-errada-123', ip);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, SIGN_IN_MAX_PER_IP).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);

    // Bloqueado inclusive com a senha certa, enquanto durar a janela.
    const blocked = await signIn(ctx, target.email, target.password, ip);
    expect(blocked.status).toBe(429);

    // Outro IP continua podendo entrar.
    const other = await signIn(ctx, target.email, target.password, nextIp());
    expect(other.status).toBe(200);
  });

  it('o contador por IP fica no banco (sobrevive a reinício da API)', async () => {
    const { rows } = await ctx.admin.query(`SELECT count(*)::int AS n FROM app_auth."rateLimit"`);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('por conta: trocar de IP a cada tentativa não escapa do limite do e-mail', async () => {
    const victim = await createUser(ctx.admin, { email: 'vitima@example.test' });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await signIn(ctx, victim.email, `chute-${i}-errado`, nextIp())).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 429]);

    // Nem a senha correta passa enquanto a conta está travada.
    const res = await signIn(ctx, victim.email, victim.password, nextIp());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('login bem-sucedido zera o contador da conta', async () => {
    const user = await createUser(ctx.admin);
    for (let i = 0; i < 3; i += 1) await signIn(ctx, user.email, 'errada-123456', nextIp());
    expect((await signIn(ctx, user.email, user.password, nextIp())).status).toBe(200);
    for (let i = 0; i < 3; i += 1) {
      expect((await signIn(ctx, user.email, 'errada-123456', nextIp())).status).toBe(401);
    }
  });

  it('X-Forwarded-For com vários IPs (sem proxies confiáveis configurados) cai num balde compartilhado', async () => {
    // Sem TRUSTED_PROXIES, uma cadeia forjada não gera um IP "novo" a cada
    // tentativa: o Better Auth usa um único balde para todos esses casos.
    const statuses: number[] = [];
    for (let i = 0; i < SIGN_IN_MAX_PER_IP + 1; i += 1) {
      const res = await signIn(ctx, `cadeia-${i}@example.test`, 'senha-errada-123', `1.2.3.${i}, 10.0.0.1`);
      statuses.push(res.status);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});
