import { cp, mkdtemp, rm, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { planMigrations, runMigrations } from '../src/db/migrate.js';
import { makeTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', 'db', 'migrations');

beforeAll(async () => {
  ctx = await makeTestApp();
});

afterAll(async () => {
  await ctx.close();
});

describe('migrations', () => {
  it('rodar de novo não aplica nada (idempotente)', async () => {
    const result = await runMigrations(inject('adminUrl'), MIGRATIONS_DIR, () => undefined);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      '001_roles_schemas.sql',
      '002_auth_tables.sql',
      '003_app_tables.sql',
      '004_rls.sql',
      '005_backup_role.sql',
      '006_latex.sql',
    ]);
  });

  it('migration já aplicada que foi editada aborta a execução', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
    try {
      await cp(MIGRATIONS_DIR, dir, { recursive: true });
      await appendFile(path.join(dir, '004_rls.sql'), '\n-- alteração indevida\n');
      await expect(runMigrations(inject('adminUrl'), dir, () => undefined)).rejects.toThrow(/mudou depois de aplicada/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('migrate-plan mostra pendentes e alteradas sem aplicar nada', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
    try {
      await cp(MIGRATIONS_DIR, dir, { recursive: true });
      await appendFile(path.join(dir, '004_rls.sql'), '\n-- alteração indevida\n');
      await writeFile(path.join(dir, '007_teste_plano.sql'), 'CREATE TABLE app.nao_deve_existir (id int);\n');
      const plan = await planMigrations(inject('adminUrl'), dir);
      expect(plan.pending).toEqual(['007_teste_plano.sql']);
      expect(plan.changed).toEqual(['004_rls.sql']);
      expect(plan.applied).toHaveLength(5);
      expect(plan.target.host).toBeTruthy();
      expect(plan.target.database).toBeTruthy();
      expect(typeof plan.counts['app.documents']).toBe('number');
      expect(typeof plan.counts['app.document_files']).toBe('number');
      expect(JSON.stringify(plan)).not.toContain(new URL(inject('adminUrl')).password || '\u0000');
      const again = await runMigrations(inject('adminUrl'), MIGRATIONS_DIR, () => undefined);
      expect(again.applied).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('o schema do Better Auth bate com as tabelas criadas (nada a criar ou adicionar)', async () => {
    const { toBeCreated, toBeAdded } = await getMigrations(ctx.auth.options);
    expect(toBeCreated).toEqual([]);
    expect(toBeAdded).toEqual([]);
  });
});
