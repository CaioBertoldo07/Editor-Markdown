import { cp, mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
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

  it('o schema do Better Auth bate com as tabelas criadas (nada a criar ou adicionar)', async () => {
    const { toBeCreated, toBeAdded } = await getMigrations(ctx.auth.options);
    expect(toBeCreated).toEqual([]);
    expect(toBeAdded).toEqual([]);
  });
});
