import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth/auth.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { ORIGIN, cookieHeader, neonStyleHash, testConfig } from './helpers.js';

/**
 * Ensaio completo, só com dados FICTÍCIOS, do procedimento de corte:
 * banco com formato do Neon -> export-from-neon.sql -> migrations num banco
 * vazio -> import-to-railway.sql -> verify.sql dos dois lados -> login na API.
 */

const run = promisify(execFile);
const hasPsql = (() => {
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const API_DIR = path.resolve(import.meta.dirname, '..');
const IMPORT_DIR = path.join(API_DIR, 'db', 'import');
const suffix = randomUUID().slice(0, 8);
const FAKE_NEON_DB = `fake_neon_${suffix}_test`;
const TARGET_DB = `target_${suffix}_test`;

const urlFor = (base: string, db: string) => {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
};

const psql = (url: string, file: string, cwd: string, vars: Record<string, string> = {}) =>
  run(
    'psql',
    [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`]), '-f', file],
    { cwd }
  );

const fake = {
  users: [
    { id: randomUUID(), name: 'Pessoa Um', email: 'um@example.test', password: 'senha-da-pessoa-um' },
    { id: randomUUID(), name: 'Pessoa Dois, "aspas"', email: 'dois@example.test', password: 'senha-da-pessoa-dois' },
    { id: randomUUID(), name: 'Teste', email: 'teste-ficticio@example.com', password: 'senha-de-teste-123' },
  ],
  folders: [randomUUID(), randomUUID()],
  docs: Array.from({ length: 5 }, () => randomUUID()),
};

describe.skipIf(!hasPsql)('ensaio de migração com dados fictícios (psql)', () => {
  let admin: pg.Client;
  let workDir: string;
  let neonUrl: string;
  let targetUrl: string;

  beforeAll(async () => {
    const adminUrl = inject('adminUrl');
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${FAKE_NEON_DB}`);
    await admin.query(`CREATE DATABASE ${TARGET_DB}`);
    neonUrl = urlFor(adminUrl, FAKE_NEON_DB);
    targetUrl = urlFor(adminUrl, TARGET_DB);
    workDir = await mkdtemp(path.join(tmpdir(), 'editor-markdown-import-'));

    // "Neon" fictício
    const neon = new pg.Client({ connectionString: neonUrl });
    await neon.connect();
    await neon.query(await readFile(path.join(import.meta.dirname, 'fixtures', 'fake-neon.sql'), 'utf8'));
    for (const u of fake.users) {
      await neon.query(
        `INSERT INTO neon_auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned)
         VALUES ($1, $2, $3, false, '2026-08-26T17:21:00.123456Z', '2026-08-26T17:21:00.123456Z', 'user', false)`,
        [u.id, u.name, u.email]
      );
      await neon.query(
        `INSERT INTO neon_auth.account ("accountId", "providerId", "userId", password, "createdAt", "updatedAt")
         VALUES ($1, 'credential', $2, $3, '2026-08-26T17:21:00Z', NULL)`,
        [u.id, u.id, neonStyleHash(u.password)]
      );
      await neon.query(
        `INSERT INTO neon_auth.session ("expiresAt", token, "userId") VALUES (now() - interval '1 day', $1, $2)`,
        [`token-${randomUUID()}`, u.id]
      );
    }
    await neon.query(`INSERT INTO neon_auth.jwks ("publicKey", "privateKey") VALUES ('pub-fake', 'PRIVATE-FAKE')`);
    const [u1, u2] = fake.users;
    await neon.query(
      `INSERT INTO public.folders (id, user_id, name, created_at) VALUES
       ($1, $3, 'Faculdade', '2026-08-27T10:00:00.5Z'), ($2, $4, 'Pasta, com "aspas"', '2026-08-28T11:00:00Z')`,
      [fake.folders[0], fake.folders[1], u1!.id, u2!.id]
    );
    const big = '# Grande\n' + 'linha com acentuação e emoji 🚀, vírgula "aspas"\n'.repeat(1300);
    const docs: Array<[string, string, string | null, string, string]> = [
      [fake.docs[0]!, u1!.id, fake.folders[0]!, 'Resumo', 'texto\ncom\nquebras'],
      [fake.docs[1]!, u1!.id, null, 'Solto', ''],
      [fake.docs[2]!, u1!.id, null, 'Grande', big],
      [fake.docs[3]!, u2!.id, fake.folders[1]!, 'Do dois', '```mermaid\ngraph TD; A-->B\n```'],
      [fake.docs[4]!, u2!.id, null, 'Título, "difícil"', 'conteúdo\r\ncom CRLF'],
    ];
    for (const [i, [id, userId, folderId, title, content]] of docs.entries()) {
      await neon.query(
        `INSERT INTO public.documents (id, user_id, folder_id, title, content, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, userId, folderId, title, content, `2026-08-2${i}T08:00:00.654321Z`, `2026-09-0${i + 1}T09:30:00.000001Z`]
      );
    }
    await neon.end();

    // "Railway" vazio com as migrations
    await runMigrations(targetUrl, path.join(API_DIR, 'db', 'migrations'), () => undefined);
  });

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${FAKE_NEON_DB} WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS ${TARGET_DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('exporta, importa e os checksums dos dois lados são idênticos', async () => {
    await psql(neonUrl, path.join(IMPORT_DIR, 'export-from-neon.sql'), workDir);
    expect((await readdir(workDir)).sort()).toEqual(['account.csv', 'documents.csv', 'folders.csv', 'user.csv']);

    await psql(targetUrl, path.join(IMPORT_DIR, 'import-to-railway.sql'), workDir);

    const source = await psql(neonUrl, path.join(IMPORT_DIR, 'verify.sql'), workDir, {
      auth_schema: 'neon_auth',
      app_schema: 'public',
    });
    const target = await psql(targetUrl, path.join(IMPORT_DIR, 'verify.sql'), workDir, {
      auth_schema: 'app_auth',
      app_schema: 'app',
    });
    expect(source.stdout.trim().split('\n')).toHaveLength(4);
    expect(source.stdout).toMatch(/^users 3 [0-9a-f]{32}$/m);
    expect(source.stdout).toMatch(/^documents 5 [0-9a-f]{32}$/m);
    expect(target.stdout).toBe(source.stdout);
  });

  it('não leva sessões, chaves JWKS nem schemas do Neon', async () => {
    const c = new pg.Client({ connectionString: targetUrl });
    await c.connect();
    try {
      const { rows } = await c.query(
        `SELECT (SELECT count(*)::int FROM app_auth.session) AS sessions,
                (SELECT count(*)::int FROM pg_namespace WHERE nspname IN ('neon_auth', 'auth')) AS schemas`
      );
      expect(rows[0]).toEqual({ sessions: 0, schemas: 0 });
    } finally {
      await c.end();
    }
  });

  it('usuários importados entram com a senha antiga e veem só os próprios documentos', async () => {
    const apiUrl = new URL(inject('apiUrl'));
    apiUrl.pathname = `/${TARGET_DB}`;
    const config = testConfig(apiUrl.toString());
    const pool = createPool(config.databaseUrl, 2);
    const app = createApp({ pool, auth: createAuth(config, pool) });
    try {
      const [u1, u2] = fake.users;
      const res = await app.request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '10.250.0.1' },
        body: JSON.stringify({ email: u1!.email, password: u1!.password }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { user: { id: string } }).user.id).toBe(u1!.id);

      const list = await app.request(`${ORIGIN}/api/documents`, {
        headers: { cookie: cookieHeader(res), origin: ORIGIN },
      });
      const docs = ((await list.json()) as { documents: Array<{ id: string; folderId: string | null }> }).documents;
      expect(docs.map((d) => d.id).sort()).toEqual([fake.docs[0], fake.docs[1], fake.docs[2]].sort());
      expect(docs.find((d) => d.id === fake.docs[0])!.folderId).toBe(fake.folders[0]);

      const wrong = await app.request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '10.250.0.2' },
        body: JSON.stringify({ email: u2!.email, password: u1!.password }),
      });
      expect(wrong.status).toBe(401);
    } finally {
      await pool.end();
    }
  });

  it('uma segunda importação no mesmo banco é recusada e não altera nada', async () => {
    await expect(psql(targetUrl, path.join(IMPORT_DIR, 'import-to-railway.sql'), workDir)).rejects.toMatchObject({
      stderr: expect.stringContaining('não está vazio'),
    });
    const c = new pg.Client({ connectionString: targetUrl });
    await c.connect();
    try {
      const { rows } = await c.query('SELECT count(*)::int AS n FROM app.documents');
      expect(rows[0].n).toBe(5);
    } finally {
      await c.end();
    }
  });
});
