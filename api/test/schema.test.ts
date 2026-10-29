import { cp, mkdtemp, rm, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import pg from 'pg';
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
      '007_document_files_path_check.sql',
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

  // O teste de restauração do backup compara o texto das constraints antes e
  // depois do pg_dump/pg_restore; um CHECK cujo texto muda ao ser lido de novo
  // (ex.: BETWEEN seguido de AND) faz todo backup falhar.
  it('todo CHECK tem texto estável (sobrevive ao dump/restore do backup)', async () => {
    const client = new pg.Client({ connectionString: inject('adminUrl') });
    await client.connect();
    const unstable: string[] = [];
    try {
      const { rows } = await client.query<{ tbl: string; name: string; def: string }>(`
        SELECT format('%I.%I', n.nspname, cl.relname) AS tbl, co.conname AS name, pg_get_constraintdef(co.oid) AS def
        FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE co.contype = 'c' AND n.nspname NOT IN ('pg_catalog', 'information_schema')`);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        await client.query('BEGIN');
        try {
          await client.query(`CREATE TEMP TABLE check_probe (LIKE ${row.tbl})`);
          await client.query(`ALTER TABLE check_probe ADD CONSTRAINT check_probe_c ${row.def}`);
          const again = await client.query<{ def: string }>(
            "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'check_probe_c'"
          );
          if (again.rows[0]?.def !== row.def) unstable.push(`${row.tbl} ${row.name}`);
        } finally {
          await client.query('ROLLBACK');
        }
      }
    } finally {
      await client.end();
    }
    expect(unstable).toEqual([]);
  });

  it('migrate-plan mostra pendentes e alteradas sem aplicar nada', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
    try {
      await cp(MIGRATIONS_DIR, dir, { recursive: true });
      await appendFile(path.join(dir, '004_rls.sql'), '\n-- alteração indevida\n');
      await writeFile(path.join(dir, '999_teste_plano.sql'), 'CREATE TABLE app.nao_deve_existir (id int);\n');
      const plan = await planMigrations(inject('adminUrl'), dir);
      expect(plan.pending).toEqual(['999_teste_plano.sql']);
      expect(plan.changed).toEqual(['004_rls.sql']);
      expect(plan.applied).toHaveLength(6);
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
