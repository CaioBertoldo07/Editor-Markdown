import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations, setApiRolePassword } from '../src/db/migrate.js';

/**
 * Banco de teste ISOLADO:
 * - padrão: PostgreSQL 18 embutido (pacote embedded-postgres), num diretório
 *   temporário apagado ao final;
 * - ou TEST_DATABASE_URL (conexão de admin) para um banco descartável cujo nome
 *   contenha "test". Nunca aponte para Neon, staging ou produção.
 */

declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
    apiUrl: string;
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject()));
    });
  });

export default async function setup(project: TestProject) {
  let adminUrl = process.env.TEST_DATABASE_URL;
  let teardown: () => Promise<void> = async () => undefined;

  if (adminUrl) {
    const dbName = new URL(adminUrl).pathname.slice(1);
    if (!/test/i.test(dbName)) {
      throw new Error(`TEST_DATABASE_URL precisa apontar para um banco de teste (nome atual: "${dbName}")`);
    }
  } else {
    const databaseDir = await mkdtemp(path.join(tmpdir(), 'editor-markdown-pg-'));
    const port = await freePort();
    const password = randomBytes(18).toString('hex');
    const server = new EmbeddedPostgres({
      databaseDir,
      port,
      user: 'postgres',
      password,
      persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      // initdb não roda como root; o pacote cria um usuário do SO para isso.
      createPostgresUser: process.getuid?.() === 0,
      onLog: () => undefined,
    });
    await server.initialise();
    await server.start();
    await server.createDatabase('editor_markdown_test');
    adminUrl = `postgres://postgres:${password}@127.0.0.1:${port}/editor_markdown_test`;
    teardown = async () => {
      await server.stop();
      await rm(databaseDir, { recursive: true, force: true });
    };
  }

  const migrationsDir = path.resolve(import.meta.dirname, '..', 'db', 'migrations');
  await runMigrations(adminUrl, migrationsDir, () => undefined);

  const apiPassword = randomBytes(24).toString('hex');
  await setApiRolePassword(adminUrl, apiPassword);

  // Começa limpo (relevante com TEST_DATABASE_URL reutilizado).
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query('TRUNCATE app_auth."user", app_auth."rateLimit", app_auth.verification CASCADE');
  await admin.end();

  const apiUrl = new URL(adminUrl);
  apiUrl.username = 'app_api';
  apiUrl.password = apiPassword;

  project.provide('adminUrl', adminUrl);
  project.provide('apiUrl', apiUrl.toString());

  return teardown;
}
