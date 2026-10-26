import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

/**
 * Executor de migrations SQL versionadas.
 *
 * - Roda com a conexão de ADMINISTRADOR (MIGRATION_DATABASE_URL), nunca com app_api.
 * - Cada arquivo roda numa transação própria; falhou, nada daquele arquivo fica.
 * - Arquivos já aplicados têm o checksum conferido: editar uma migration antiga
 *   aborta a execução (crie uma nova em vez de alterar a anterior).
 */

export type MigrationResult = { applied: string[]; skipped: string[] };

const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;

export const defaultMigrationsDir = (): string => path.resolve(process.cwd(), 'db', 'migrations');

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export async function runMigrations(
  connectionString: string,
  migrationsDir = defaultMigrationsDir(),
  log: (message: string) => void = console.log
): Promise<MigrationResult> {
  const files = (await readdir(migrationsDir)).filter((f) => MIGRATION_FILE.test(f)).sort();
  if (files.length === 0) throw new Error(`Nenhuma migration em ${migrationsDir}`);

  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };

  try {
    // Impede duas execuções simultâneas.
    await client.query("SELECT pg_advisory_lock(hashtext('editor-markdown-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version    text        PRIMARY KEY,
        checksum   text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM public.schema_migrations'
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      const checksum = sha256(sql);
      const previous = applied.get(file);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(`A migration ${file} mudou depois de aplicada (checksum diferente). Abortado.`);
        }
        result.skipped.push(file);
        continue;
      }

      log(`Aplicando ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('RESET ROLE');
        await client.query('INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Falha em ${file}: ${(err as Error).message}`);
      }
      result.applied.push(file);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('editor-markdown-migrations'))").catch(() => undefined);
    await client.end();
  }

  return result;
}

/** Libera o LOGIN do app_api com a senha informada (nunca vai para o git). */
export async function setApiRolePassword(connectionString: string, password: string): Promise<void> {
  if (password.length < 24) throw new Error('A senha do app_api precisa de pelo menos 24 caracteres');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const literal = client.escapeLiteral(password);
    await client.query(`ALTER ROLE app_api WITH LOGIN PASSWORD ${literal} CONNECTION LIMIT 30`);
  } finally {
    await client.end();
  }
}

/** Libera o LOGIN do app_backup (só leitura, usado pelo pg_dump) com a senha informada. */
export async function setBackupRolePassword(connectionString: string, password: string): Promise<void> {
  if (password.length < 24) throw new Error('A senha do app_backup precisa de pelo menos 24 caracteres');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const literal = client.escapeLiteral(password);
    await client.query(`ALTER ROLE app_backup WITH LOGIN PASSWORD ${literal} CONNECTION LIMIT 3`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('Defina MIGRATION_DATABASE_URL (conexão de administrador)');

  const result = await runMigrations(url);
  console.log(`Migrations aplicadas: ${result.applied.length}; já existentes: ${result.skipped.length}`);

  if (process.argv.includes('--set-api-password')) {
    const password = process.env.APP_API_DB_PASSWORD;
    if (!password) throw new Error('Defina APP_API_DB_PASSWORD para usar --set-api-password');
    await setApiRolePassword(url, password);
    console.log('LOGIN e senha do app_api atualizados.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
