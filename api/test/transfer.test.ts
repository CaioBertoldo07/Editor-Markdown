import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth/auth.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { computeChecksums, sameChecksums } from '../src/ops/checksums.js';
import { TRANSFER_CONFIRMATION, runExecute, runInspect } from '../src/ops/transfer.js';
import { ORIGIN, cookieHeader, neonStyleHash, testConfig } from './helpers.js';

/** Transferência direta (job do Railway), ensaiada só com dados FICTÍCIOS. */

const suffix = randomUUID().slice(0, 8);
const NEON_DB = `fake_neon_tr_${suffix}_test`;
const TARGET_DB = `target_tr_${suffix}_test`;
const API_DIR = path.resolve(import.meta.dirname, '..');
const local = () => true;

const urlFor = (db: string, base = inject('adminUrl')) => {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
};

const people = [
  { id: randomUUID(), name: 'Pessoa A', email: 'a@example.test', password: 'senha-da-pessoa-a' },
  { id: randomUUID(), name: 'Pessoa B', email: 'b@example.test', password: 'senha-da-pessoa-b' },
];
const folderA = randomUUID();
const docs = [randomUUID(), randomUUID(), randomUUID()];

let admin: pg.Client;
let neon: pg.Client;
const logs: string[] = [];
const log = (l: string) => logs.push(l);

beforeAll(async () => {
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${NEON_DB}`);
  await admin.query(`CREATE DATABASE ${TARGET_DB}`);

  neon = new pg.Client({ connectionString: urlFor(NEON_DB) });
  await neon.connect();
  await neon.query(await readFile(path.join(import.meta.dirname, 'fixtures', 'fake-neon.sql'), 'utf8'));
  await neon.query(`CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$`);
  await neon.query(`CREATE TRIGGER documents_set_updated_at BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()`);
  for (const p of people) {
    await neon.query(
      `INSERT INTO neon_auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, false, '2026-08-26T17:21:00.5Z', NULL)`,
      [p.id, p.name, p.email]
    );
    await neon.query(
      `INSERT INTO neon_auth.account ("accountId", "providerId", "userId", password, "createdAt") VALUES ($1, 'credential', $2, $3, '2026-08-26T17:21:00Z')`,
      [p.id, p.id, neonStyleHash(p.password)]
    );
    await neon.query(`INSERT INTO neon_auth.session ("expiresAt", token, "userId") VALUES (now() - interval '9 days', $1, $2)`, [randomUUID(), p.id]);
  }
  await neon.query(`INSERT INTO neon_auth.jwks ("publicKey", "privateKey") VALUES ('pub', 'PRIVATE-FAKE')`);
  await neon.query(`INSERT INTO public.folders (id, user_id, name, created_at) VALUES ($1, $2, 'Pasta, "A"', '2026-08-27T10:00:00.123456Z')`, [folderA, people[0]!.id]);
  await neon.query(
    `INSERT INTO public.documents (id, user_id, folder_id, title, content, created_at, updated_at) VALUES
     ($1, $4, $5, 'Na pasta', 'linha 1\nlinha 2 🚀', '2026-08-27T10:05:00.000001Z', '2026-09-01T12:00:00.999999Z'),
     ($2, $4, NULL, 'Solta', '', '2026-08-28T09:00:00Z', '2026-08-30T08:30:00Z'),
     ($3, $6, NULL, 'Da B', 'texto "B"', '2026-08-29T09:00:00Z', '2026-08-29T09:00:00Z')`,
    [docs[0], docs[1], docs[2], people[0]!.id, folderA, people[1]!.id]
  );
  await runMigrations(urlFor(TARGET_DB), path.join(API_DIR, 'db', 'migrations'), () => undefined);
});

afterAll(async () => {
  await neon?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${NEON_DB} WITH (FORCE)`);
  await admin.query(`DROP DATABASE IF EXISTS ${TARGET_DB} WITH (FORCE)`);
  await admin.end();
});

const opts = () => ({
  sourceUrl: urlFor(NEON_DB),
  targetUrl: urlFor(TARGET_DB),
  allowSourceHost: local,
  allowTargetHost: local,
  log,
});

describe('transferência Neon -> Railway (fictícia)', () => {
  it('recusa destinos fora da rede privada do Railway e origens fora do Neon', async () => {
    await expect(runInspect({ sourceUrl: urlFor(NEON_DB), targetUrl: urlFor(TARGET_DB), log })).rejects.toThrow(/Neon/);
    await expect(
      runInspect({ sourceUrl: 'postgres://u:p@ep-x.aws.neon.tech/db', targetUrl: 'postgres://u:p@ep-y.aws.neon.tech/db', log })
    ).rejects.toThrow(/rede privada do Railway/);
  });

  it('inspect só lê, não aponta problemas e mostra o trigger, sem dados pessoais', async () => {
    logs.length = 0;
    const r = await runInspect(opts());
    expect(r.problems).toEqual([]);
    expect(r.counts).toMatchObject({ users: 2, accounts: 2, hashesInExpectedFormat: 2, folders: 1, documents: 3, sessionsNotMigrated: 2 });
    const out = logs.join('\n');
    expect(out).toContain('documents_set_updated_at');
    for (const p of people) {
      expect(out).not.toContain(p.email);
      expect(out).not.toContain(p.name);
    }
    expect(out).not.toMatch(/[0-9a-f]{32}:[0-9a-f]{128}/);
    expect(out).not.toContain('Na pasta');
  });

  it('a sessão da origem é somente leitura', async () => {
    // Mesmo com um bug no código, o Neon recusaria escrita nesta sessão.
    const c = new pg.Client({ connectionString: urlFor(NEON_DB) });
    await c.connect();
    await c.query('SET default_transaction_read_only = on');
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await expect(c.query(`UPDATE public.documents SET title = 'x'`)).rejects.toMatchObject({ code: '25006' });
    await c.query('ROLLBACK');
    await c.end();
  });

  it('execute exige a confirmação explícita', async () => {
    await expect(runExecute({ ...opts(), confirmation: 'sim' })).rejects.toThrow(/Confirmação ausente/);
    const t = new pg.Client({ connectionString: urlFor(TARGET_DB) });
    await t.connect();
    expect((await t.query('SELECT count(*)::int AS n FROM app_auth."user"')).rows[0].n).toBe(0);
    await t.end();
  });

  it('execute copia tudo numa transação, com checksums idênticos e sem sessões/JWKS', async () => {
    logs.length = 0;
    await runExecute({ ...opts(), confirmation: TRANSFER_CONFIRMATION });
    expect(logs.join('\n')).toContain('COMMIT: contagens e checksums idênticos');

    const t = new pg.Client({ connectionString: urlFor(TARGET_DB) });
    await t.connect();
    try {
      const src = await computeChecksums(neon, { auth: 'neon_auth', app: 'public' });
      const dst = await computeChecksums(t, { auth: 'app_auth', app: 'app' });
      expect(sameChecksums(src, dst)).toBe(true);
      const { rows } = await t.query(
        `SELECT (SELECT count(*)::int FROM app_auth.session) AS sessions,
                (SELECT count(*)::int FROM pg_namespace WHERE nspname IN ('neon_auth','auth')) AS schemas,
                (SELECT "updatedAt" = "createdAt" FROM app_auth."user" LIMIT 1) AS updated_from_created`
      );
      expect(rows[0]).toEqual({ sessions: 0, schemas: 0, updated_from_created: true });
    } finally {
      await t.end();
    }
  });

  it('usuário transferido entra com a senha antiga e só vê os próprios documentos', async () => {
    const api = new URL(inject('apiUrl'));
    api.pathname = `/${TARGET_DB}`;
    const config = testConfig(api.toString());
    const pool = createPool(config.databaseUrl, 2);
    const app = createApp({ pool, auth: createAuth(config, pool) });
    try {
      const login = await app.request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '10.251.0.1' },
        body: JSON.stringify({ email: people[1]!.email, password: people[1]!.password }),
      });
      expect(login.status).toBe(200);
      const list = await app.request(`${ORIGIN}/api/documents`, { headers: { origin: ORIGIN, cookie: cookieHeader(login) } });
      const ids = ((await list.json()) as { documents: Array<{ id: string }> }).documents.map((d) => d.id);
      expect(ids).toEqual([docs[2]]);
    } finally {
      await pool.end();
    }
  });

  it('segunda execução é recusada (destino não vazio) e nada muda', async () => {
    await expect(runExecute({ ...opts(), confirmation: TRANSFER_CONFIRMATION })).rejects.toThrow(/não está vazio/);
  });

  it('inspect bloqueia origem com problemas (e-mail com maiúscula, título nulo)', async () => {
    await neon.query(`UPDATE neon_auth."user" SET email = 'A@Example.test' WHERE id = $1`, [people[0]!.id]);
    await neon.query(`UPDATE public.documents SET title = NULL WHERE id = $1`, [docs[1]]);
    logs.length = 0;
    const r = await runInspect(opts());
    expect(r.problems.join('\n')).toMatch(/maiúsculas/);
    expect(r.problems.join('\n')).toMatch(/documentos com campos nulos/);
  });
});
