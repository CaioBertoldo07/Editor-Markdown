import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { verifyPassword } from 'better-auth/crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { runStagingSeed, SEED_USERS } from '../src/ops/staging-seed.js';

/**
 * Cada execução usa um banco próprio, criado aqui e apagado no final: a trava
 * "só usuários de teste" olha o banco inteiro, então ele não pode ser
 * compartilhado com os outros testes.
 */

const PASSWORD = `senha-de-teste-${randomBytes(8).toString('hex')}`;
const dbName = `seed_test_${randomBytes(4).toString('hex')}`;
let seedUrl: string;
let admin: pg.Client;

const quiet = () => undefined;
const seed = (overrides: Partial<Parameters<typeof runStagingSeed>[0]> = {}) =>
  runStagingSeed({ adminUrl: seedUrl, password: PASSWORD, environmentName: undefined, allowLocal: true, log: quiet, ...overrides });

const counts = async () => {
  const { rows } = await admin.query<{ users: number; folders: number; documents: number }>(
    `SELECT (SELECT count(*) FROM app_auth."user")::int AS users, (SELECT count(*) FROM app.folders)::int AS folders,
            (SELECT count(*) FROM app.documents)::int AS documents`
  );
  return rows[0]!;
};

beforeAll(async () => {
  const root = new pg.Client({ connectionString: inject('adminUrl') });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  await root.end();
  const url = new URL(inject('adminUrl'));
  url.pathname = `/${dbName}`;
  seedUrl = url.toString();
  await runMigrations(seedUrl, path.resolve(import.meta.dirname, '..', 'db', 'migrations'), quiet);
  admin = new pg.Client({ connectionString: seedUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  const root = new pg.Client({ connectionString: inject('adminUrl') });
  await root.connect();
  await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await root.end();
});

describe('staging-seed', () => {
  it('fora do staging e sem permissão local: recusa', async () => {
    await expect(seed({ allowLocal: false })).rejects.toThrow(/só roda no ambiente staging/);
    await expect(seed({ allowLocal: false, environmentName: 'production' })).rejects.toThrow(/só roda no ambiente staging/);
  });

  it('permissão local não vale para um banco remoto', async () => {
    const remote = new URL(seedUrl);
    remote.hostname = 'postgres.railway.internal';
    await expect(seed({ adminUrl: remote.toString() })).rejects.toThrow(/só roda no ambiente staging/);
  });

  it('senha curta: recusa', async () => {
    await expect(seed({ password: 'curta' })).rejects.toThrow(/16 caracteres/);
  });

  it('cria 2 usuários de teste, 2 pastas e 5 documentos; a senha funciona', async () => {
    expect(await seed()).toEqual({ users: 2, folders: 2, documents: 5 });
    expect(await counts()).toEqual({ users: 2, folders: 2, documents: 5 });

    const { rows } = await admin.query<{ email: string; password: string }>(
      `SELECT u.email, a.password FROM app_auth."user" u JOIN app_auth.account a ON a."userId" = u.id ORDER BY u.email`
    );
    expect(rows.map((r) => r.email)).toEqual(SEED_USERS.map((u) => u.email).sort());
    for (const r of rows) {
      expect(await verifyPassword({ hash: r.password, password: PASSWORD })).toBe(true);
      expect(await verifyPassword({ hash: r.password, password: 'senha-errada-qualquer' })).toBe(false);
    }
  });

  it('o documento do Bruno é só dele; a Ana tem os documentos de markdown, mermaid e XSS', async () => {
    const { rows } = await admin.query<{ email: string; title: string }>(
      `SELECT u.email, d.title FROM app.documents d JOIN app_auth."user" u ON u.id = d.user_id ORDER BY d.title`
    );
    expect(rows.filter((r) => r.email.startsWith('bruno')).map((r) => r.title)).toEqual(['Documento privado do Bruno (fictício)']);
    expect(rows.filter((r) => r.email.startsWith('ana')).map((r) => r.title)).toEqual([
      'Boas-vindas (fictício)',
      'Diagramas mermaid (fictício)',
      'Rascunho sem pasta (fictício)',
      'Teste de XSS (fictício)',
    ]);
  });

  it('rodar de novo recria os dados de teste sem duplicar', async () => {
    await seed();
    expect(await counts()).toEqual({ users: 2, folders: 2, documents: 5 });
  });

  it('com qualquer usuário de domínio real no banco: recusa e não grava nada', async () => {
    await admin.query(`INSERT INTO app_auth."user" (name, email) VALUES ('Pessoa', 'pessoa@gmail.com')`);
    const before = await counts();
    await expect(seed()).rejects.toThrow(/não são de teste: nada foi gravado/);
    expect(await counts()).toEqual(before);
    await admin.query(`DELETE FROM app_auth."user" WHERE email = 'pessoa@gmail.com'`);
  });
});
