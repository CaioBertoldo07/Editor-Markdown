import pg from 'pg';
import type { ClientBase } from 'pg';
import { computeChecksums, describeChecksums, sameChecksums } from './checksums.js';

/**
 * Transferência Neon -> PostgreSQL do Railway, executada DENTRO do Railway:
 * sem arquivos em disco e sem expor o Postgres do Railway à internet.
 *
 *   inspect  só lê o Neon (transação READ ONLY) e imprime agregados:
 *            contagens, nulos, formato dos hashes, trigger, e-mails etc.
 *   execute  lê o Neon num snapshot READ ONLY e grava no Railway numa única
 *            transação; só faz COMMIT se contagens e checksums baterem.
 *
 * Nenhum dado pessoal, hash ou conteúdo é impresso — apenas números e checksums.
 */

export const TRANSFER_CONFIRMATION = 'COPIAR-NEON-PARA-STAGING';
const NEON_HOST = /\.neon\.tech$/;
const SOURCE = { auth: 'neon_auth', app: 'public' };
const TARGET = { auth: 'app_auth', app: 'app' };
const HASH_FORMAT = '^[0-9a-f]{32}:[0-9a-f]{128}$';

export type TransferOptions = {
  sourceUrl: string;
  targetUrl: string;
  /** Hosts aceitos como destino; padrão: só a rede privada do Railway. */
  allowTargetHost?: (host: string) => boolean;
  allowSourceHost?: (host: string) => boolean;
  log?: (line: string) => void;
};

const host = (url: string) => new URL(url).hostname;

function guardHosts(o: TransferOptions) {
  const src = host(o.sourceUrl);
  const dst = host(o.targetUrl);
  const allowSource = o.allowSourceHost ?? ((h: string) => NEON_HOST.test(h));
  const allowTarget = o.allowTargetHost ?? ((h: string) => h.endsWith('.railway.internal'));
  if (!allowSource(src)) throw new Error('Origem não é um host do Neon: abortado');
  if (!allowTarget(dst)) throw new Error('Destino não é a rede privada do Railway: abortado');
  if (NEON_HOST.test(dst)) throw new Error('Destino aponta para o Neon: abortado');
}

async function openSource(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, application_name: 'editor-markdown-transfer-readonly' });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  await client.query("SET TIME ZONE 'UTC'");
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  return client;
}

export type Inspection = {
  counts: Record<string, number>;
  problems: string[];
  notes: string[];
};

/** Diagnóstico somente leitura da origem. Bloqueia a transferência se houver problemas. */
export async function inspectSource(source: ClientBase): Promise<Inspection> {
  const q = async (sql: string) => Number((await source.query<{ n: string }>(sql)).rows[0]!.n);
  const counts = {
    users: await q('SELECT count(*) AS n FROM neon_auth."user"'),
    accounts: await q('SELECT count(*) AS n FROM neon_auth.account'),
    credentialAccounts: await q(`SELECT count(*) AS n FROM neon_auth.account WHERE "providerId" = 'credential'`),
    hashesInExpectedFormat: await q(
      `SELECT count(*) AS n FROM neon_auth.account WHERE "providerId" = 'credential' AND password ~ '${HASH_FORMAT}'`
    ),
    folders: await q('SELECT count(*) AS n FROM public.folders'),
    documents: await q('SELECT count(*) AS n FROM public.documents'),
    sessionsNotMigrated: await q('SELECT count(*) AS n FROM neon_auth.session'),
  };

  const problems: string[] = [];
  const notes: string[] = [];
  const check = async (label: string, sql: string) => {
    const n = await q(sql);
    if (n > 0) problems.push(`${label}: ${n}`);
  };

  await check('usuários com name/email nulo', `SELECT count(*) AS n FROM neon_auth."user" WHERE name IS NULL OR email IS NULL`);
  await check(
    'e-mails com maiúsculas/espaços (o login do Better Auth procura em minúsculas)',
    `SELECT count(*) AS n FROM neon_auth."user" WHERE email <> lower(btrim(email))`
  );
  await check('e-mails duplicados (sem diferenciar maiúsculas)', `SELECT count(*) AS n FROM (SELECT lower(email) FROM neon_auth."user" GROUP BY 1 HAVING count(*) > 1) d`);
  await check('contas sem usuário', `SELECT count(*) AS n FROM neon_auth.account a WHERE NOT EXISTS (SELECT 1 FROM neon_auth."user" u WHERE u.id = a."userId")`);
  await check('contas credential sem hash no formato scrypt do Better Auth', `SELECT count(*) AS n FROM neon_auth.account WHERE "providerId" = 'credential' AND (password IS NULL OR password !~ '${HASH_FORMAT}')`);
  await check('contas com accountId/providerId nulo', `SELECT count(*) AS n FROM neon_auth.account WHERE "accountId" IS NULL OR "providerId" IS NULL`);
  await check('datas de criação nulas (user/account)', `SELECT (SELECT count(*) FROM neon_auth."user" WHERE "createdAt" IS NULL) + (SELECT count(*) FROM neon_auth.account WHERE "createdAt" IS NULL) AS n`);
  await check('pastas com campos nulos', `SELECT count(*) AS n FROM public.folders WHERE user_id IS NULL OR name IS NULL OR created_at IS NULL`);
  await check('documentos com campos nulos', `SELECT count(*) AS n FROM public.documents WHERE user_id IS NULL OR title IS NULL OR content IS NULL OR created_at IS NULL OR updated_at IS NULL`);
  await check('user_id que não é uuid', `SELECT count(*) AS n FROM (SELECT user_id FROM public.folders UNION ALL SELECT user_id FROM public.documents) x WHERE user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`);
  await check('pastas/documentos de usuário inexistente', `SELECT count(*) AS n FROM (SELECT user_id FROM public.folders UNION ALL SELECT user_id FROM public.documents) x WHERE NOT EXISTS (SELECT 1 FROM neon_auth."user" u WHERE u.id::text = x.user_id)`);
  await check('documento em pasta de outro dono', `SELECT count(*) AS n FROM public.documents d JOIN public.folders f ON f.id = d.folder_id WHERE f.user_id <> d.user_id`);
  await check('documento apontando para pasta inexistente', `SELECT count(*) AS n FROM public.documents d WHERE d.folder_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.folders f WHERE f.id = d.folder_id)`);

  const oauth = await q(`SELECT count(*) AS n FROM neon_auth.account WHERE "accessToken" IS NOT NULL OR "refreshToken" IS NOT NULL OR "idToken" IS NOT NULL`);
  if (oauth > 0) notes.push(`${oauth} conta(s) com tokens OAuth (serão copiados como estão)`);

  // Trigger de updated_at: o corpo da função é código, não dado pessoal.
  const trig = await source.query<{ def: string; fn: string }>(`
    SELECT pg_get_triggerdef(t.oid) AS def, pg_get_functiondef(t.tgfoid) AS fn
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.documents'::regclass AND NOT t.tgisinternal`);
  for (const t of trig.rows) {
    const body = t.fn.replace(/\s+/g, ' ');
    notes.push(`trigger: ${t.def.replace(/\s+/g, ' ')}`);
    notes.push(`função: ${body.slice(body.indexOf('AS $'), body.indexOf('AS $') + 220)}`);
  }

  const nullable = await source.query<{ col: string }>(`
    SELECT table_name || '.' || column_name AS col FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('documents', 'folders') AND is_nullable = 'YES'
    ORDER BY 1`);
  notes.push(`colunas que aceitam nulo no Neon: ${nullable.rows.map((r) => r.col).join(', ') || 'nenhuma'}`);

  if (counts.credentialAccounts !== counts.hashesInExpectedFormat) {
    problems.push('nem todos os hashes estão no formato esperado');
  }
  return { counts, problems, notes };
}

export async function runInspect(o: TransferOptions): Promise<Inspection> {
  guardHosts(o);
  const log = o.log ?? console.log;
  const source = await openSource(o.sourceUrl);
  try {
    const result = await inspectSource(source);
    const checks = await computeChecksums(source, SOURCE);
    log(`[inspect] contagens: ${JSON.stringify(result.counts)}`);
    log(`[inspect] checksums origem: ${describeChecksums(checks)}`);
    for (const n of result.notes) log(`[inspect] ${n}`);
    if (result.problems.length === 0) log('[inspect] nenhum problema que bloqueie a transferência');
    for (const p of result.problems) log(`[inspect] PROBLEMA: ${p}`);

    // Prova de que nada foi escrito no Neon: a transação é READ ONLY e nunca
    // recebeu um ID de transação (só é atribuído quando há escrita).
    const proof = await source.query<{ ro: string; no_xid: boolean }>(
      `SELECT current_setting('transaction_read_only') AS ro, pg_current_xact_id_if_assigned() IS NULL AS no_xid`
    );
    const p = proof.rows[0]!;
    log(`[inspect] origem: transaction_read_only=${p.ro}, nenhuma escrita na transação=${p.no_xid ? 'sim' : 'NÃO'}`);
    if (p.ro !== 'on' || !p.no_xid) result.problems.push('a sessão da origem não ficou somente leitura');

    // Estado do destino, lido também em transação somente leitura.
    const target = new pg.Client({ connectionString: o.targetUrl, application_name: 'editor-markdown-inspect-target' });
    await target.connect();
    try {
      await target.query('BEGIN TRANSACTION READ ONLY');
      const t = await target.query<Record<string, string>>(`
        SELECT (SELECT count(*) FROM app_auth."user")::text AS users,
               (SELECT count(*) FROM app_auth.account)::text AS accounts,
               (SELECT count(*) FROM app_auth.session)::text AS sessions,
               (SELECT count(*) FROM app.folders)::text AS folders,
               (SELECT count(*) FROM app.documents)::text AS documents`);
      await target.query('ROLLBACK');
      log(`[inspect] destino staging (somente leitura): ${JSON.stringify(t.rows[0])}`);
    } finally {
      await target.end();
    }
    return result;
  } finally {
    await source.query('ROLLBACK').catch(() => undefined);
    await source.end();
  }
}

type Row = Record<string, unknown>;

async function insertAll(target: ClientBase, table: string, columns: string[], rows: Row[]) {
  const cols = columns.map((c) => `"${c}"`).join(', ');
  const params = columns.map((_, i) => `$${i + 1}`).join(', ');
  for (const row of rows) {
    await target.query(`INSERT INTO ${table} (${cols}) VALUES (${params})`, columns.map((c) => row[c]));
  }
}

export async function runExecute(o: TransferOptions & { confirmation: string }): Promise<void> {
  if (o.confirmation !== TRANSFER_CONFIRMATION) {
    throw new Error(`Confirmação ausente: defina TRANSFER_CONFIRM=${TRANSFER_CONFIRMATION}`);
  }
  guardHosts(o);
  const log = o.log ?? console.log;
  const source = await openSource(o.sourceUrl);
  const target = new pg.Client({ connectionString: o.targetUrl, application_name: 'editor-markdown-transfer' });
  await target.connect();

  try {
    const inspection = await inspectSource(source);
    if (inspection.problems.length > 0) {
      throw new Error(`Origem com problemas, nada foi copiado: ${inspection.problems.join('; ')}`);
    }
    const sourceChecks = await computeChecksums(source, SOURCE);

    // Datas viajam como TEXTO (precisão de microssegundos): o Date do JavaScript
    // só guarda milissegundos e alteraria os timestamps originais.
    const users = (
      await source.query(`SELECT id, name, email, "emailVerified", image, "createdAt"::text AS "createdAt",
        COALESCE("updatedAt", "createdAt")::text AS "updatedAt"
        FROM neon_auth."user" ORDER BY id`)
    ).rows;
    const accounts = (
      await source.query(`SELECT id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken",
        "accessTokenExpiresAt"::text AS "accessTokenExpiresAt", "refreshTokenExpiresAt"::text AS "refreshTokenExpiresAt",
        scope, password, "createdAt"::text AS "createdAt", COALESCE("updatedAt", "createdAt")::text AS "updatedAt"
        FROM neon_auth.account ORDER BY id`)
    ).rows;
    const folders = (
      await source.query(`SELECT id, user_id::uuid AS user_id, name, created_at::text AS created_at FROM public.folders ORDER BY id`)
    ).rows;
    const documents = (
      await source.query(`SELECT id, user_id::uuid AS user_id, folder_id, title, content,
        created_at::text AS created_at, updated_at::text AS updated_at FROM public.documents ORDER BY id`)
    ).rows;

    await target.query("SET TIME ZONE 'UTC'");
    await target.query('BEGIN');
    const occupied = await target.query<{ n: string }>(`
      SELECT ((SELECT count(*) FROM app_auth."user") + (SELECT count(*) FROM app_auth.account)
            + (SELECT count(*) FROM app.folders) + (SELECT count(*) FROM app.documents))::text AS n`);
    if (Number(occupied.rows[0]!.n) !== 0) throw new Error('Destino não está vazio: nada foi copiado');

    await insertAll(target, 'app_auth."user"', ['id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt'], users);
    await insertAll(
      target,
      'app_auth.account',
      ['id', 'accountId', 'providerId', 'userId', 'accessToken', 'refreshToken', 'idToken', 'accessTokenExpiresAt', 'refreshTokenExpiresAt', 'scope', 'password', 'createdAt', 'updatedAt'],
      accounts
    );
    await insertAll(target, 'app.folders', ['id', 'user_id', 'name', 'created_at'], folders);
    await insertAll(target, 'app.documents', ['id', 'user_id', 'folder_id', 'title', 'content', 'created_at', 'updated_at'], documents);

    const targetChecks = await computeChecksums(target, TARGET);
    log(`[execute] origem:  ${describeChecksums(sourceChecks)}`);
    log(`[execute] destino: ${describeChecksums(targetChecks)}`);
    if (!sameChecksums(sourceChecks, targetChecks)) {
      throw new Error('Checksums divergentes: ROLLBACK, nada foi gravado');
    }
    await target.query('COMMIT');
    log('[execute] COMMIT: contagens e checksums idênticos');
  } catch (err) {
    await target.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await source.query('ROLLBACK').catch(() => undefined);
    await source.end();
    await target.end();
  }
}
