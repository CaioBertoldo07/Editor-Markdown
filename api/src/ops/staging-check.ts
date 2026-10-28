import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import pg from 'pg';

/**
 * Verificação do staging, executada dentro do Railway (serviço de operações).
 *
 * - Confere o banco com a conexão de administrador (estrutura, papéis, RLS, FK).
 * - Cria DOIS usuários fictícios (e-mail @example.invalid, senhas aleatórias que
 *   só existem na memória deste processo) e testa a API pela rede privada e
 *   pelo domínio público.
 * - Apaga tudo o que criou no final, mesmo em caso de falha.
 *
 * Nunca imprime senhas, hashes, cookies, tokens ou a chave de staging.
 */

export type StagingCheckEnv = {
  adminUrl: string;
  privateUrl: string;
  publicUrl: string | null;
  origin: string;
  accessKey: string | null;
};

type Result = { name: string; ok: boolean; detail?: string };
const FAKE_DOMAIN = '@example.invalid';
const FAKE_PREFIX = 'staging-check-';

export function neonStyleHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password.normalize('NFKC'), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 });
  return `${salt}:${key.toString('hex')}`;
}

const cookieHeader = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .filter((pair) => !pair.endsWith('='))
    .join('; ');

export async function runStagingCheck(env: StagingCheckEnv, log: (l: string) => void = console.log): Promise<boolean> {
  const results: Result[] = [];
  const record = (name: string, ok: boolean, detail?: string) => {
    results.push({ name, ok, detail });
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const attempt = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      record(name, true, detail || undefined);
    } catch (err) {
      record(name, false, (err as Error).message);
    }
  };
  const expect = (cond: boolean, message: string) => {
    if (!cond) throw new Error(message);
  };

  const admin = new pg.Client({ connectionString: env.adminUrl, application_name: 'editor-markdown-staging-check' });
  await admin.connect();
  const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await admin.query<T>(sql, params)).rows;

  let ipSeq = 0;
  const call = async (
    base: string,
    method: string,
    path: string,
    o: { cookie?: string; body?: unknown; key?: boolean; ip?: string; headers?: Record<string, string> } = {}
  ) => {
    const headers: Record<string, string> = { origin: env.origin, ...o.headers };
    if (o.key !== false && env.accessKey) headers['x-staging-key'] = env.accessKey;
    if (o.cookie) headers.cookie = o.cookie;
    // Rede privada não tem proxy: o job simula o IP do cliente nos dois
    // cabeçalhos aceitos pela configuração (x-forwarded-for ou x-real-ip).
    if (o.ip) {
      headers['x-forwarded-for'] = o.ip;
      headers['x-real-ip'] = o.ip;
    }
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(`${base}${path}`, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      redirect: 'manual',
    });
  };
  const freshIp = () => `10.${Math.floor(Math.random() * 200)}.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  const signIn = (base: string, email: string, password: string, ip?: string) =>
    call(base, 'POST', '/api/auth/sign-in/email', { body: { email, password }, ip });

  const before = await q<{ users: string; docs: string }>(
    `SELECT (SELECT count(*) FROM app_auth."user")::text AS users, (SELECT count(*) FROM app.documents)::text AS docs`
  );
  log(`Estado inicial: ${before[0]!.users} usuário(s), ${before[0]!.docs} documento(s)`);

  const fake = [0, 1].map((i) => ({
    id: randomUUID(),
    email: `${FAKE_PREFIX}${i}-${randomUUID().slice(0, 8)}${FAKE_DOMAIN}`,
    password: randomBytes(18).toString('base64url'),
  }));

  try {
    // ---------- Banco ----------
    await attempt('PostgreSQL 18', async () => {
      const [r] = await q<{ v: number; ver: string }>(`SELECT current_setting('server_version_num')::int AS v, current_setting('server_version') AS ver`);
      expect(r!.v >= 180000 && r!.v < 190000, `versão ${r!.ver}`);
      return r!.ver;
    });
    await attempt('6 migrations aplicadas', async () => {
      const rows = await q<{ version: string }>('SELECT version FROM public.schema_migrations ORDER BY version');
      const names = rows.map((r) => r.version);
      expect(
        JSON.stringify(names) ===
          JSON.stringify(['001_roles_schemas.sql', '002_auth_tables.sql', '003_app_tables.sql', '004_rls.sql', '005_backup_role.sql', '006_latex.sql']),
        names.join(',')
      );
    });
    await attempt('schemas e tabelas', async () => {
      const rows = await q<{ t: string }>(
        `SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
         WHERE table_schema IN ('app', 'app_auth') AND table_type = 'BASE TABLE' ORDER BY 1`
      );
      const list = rows.map((r) => r.t).join(',');
      expect(list === 'app.document_files,app.documents,app.folders,app_auth.account,app_auth.rateLimit,app_auth.session,app_auth.user,app_auth.verification', list);
    });
    await attempt('app_api sem privilégios administrativos', async () => {
      const [r] = await q<Record<string, boolean>>(
        `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin,
                pg_has_role('app_api', 'app_owner', 'MEMBER') AS member_owner
         FROM pg_roles WHERE rolname = 'app_api'`
      );
      expect(!!r, 'papel inexistente');
      expect(!r!.rolsuper && !r!.rolbypassrls && !r!.rolcreaterole && !r!.rolcreatedb && !r!.rolreplication, 'atributos administrativos');
      expect(!!r!.rolcanlogin, 'sem LOGIN');
      expect(!r!.member_owner, 'é membro de app_owner');
      const owned = await q(`SELECT 1 FROM pg_class c WHERE pg_get_userbyid(c.relowner) = 'app_api'`);
      expect(owned.length === 0, 'é dono de objetos');
    });
    await attempt('app_backup só leitura', async () => {
      const [r] = await q<Record<string, boolean>>(
        `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
                pg_has_role('app_backup', 'pg_read_all_data', 'MEMBER') AS reads_all,
                pg_has_role('app_backup', 'app_owner', 'MEMBER') AS member_owner
         FROM pg_roles WHERE rolname = 'app_backup'`
      );
      expect(!!r, 'papel inexistente');
      expect(!r!.rolsuper && !r!.rolcreaterole && !r!.rolcreatedb && !r!.rolreplication, 'atributos administrativos');
      expect(!!r!.rolbypassrls && !!r!.reads_all, 'sem leitura completa');
      expect(!r!.member_owner, 'é membro de app_owner');
      const writable = await q(
        `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'r' AND n.nspname IN ('app', 'app_auth', 'public')
           AND (has_table_privilege('app_backup', c.oid, 'INSERT') OR has_table_privilege('app_backup', c.oid, 'UPDATE')
             OR has_table_privilege('app_backup', c.oid, 'DELETE') OR has_table_privilege('app_backup', c.oid, 'TRUNCATE'))`
      );
      expect(writable.length === 0, 'pode gravar em tabelas');
      const owned = await q(`SELECT 1 FROM pg_class c WHERE pg_get_userbyid(c.relowner) = 'app_backup'`);
      expect(owned.length === 0, 'é dono de objetos');
    });
    await attempt('RLS habilitado e forçado + policies', async () => {
      const rows = await q<{ relname: string; rls: boolean; force: boolean; policies: string }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'app' AND p.tablename = c.relname)::text AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'app' AND c.relkind = 'r' ORDER BY 1`
      );
      expect(rows.length === 3 && rows.every((r) => r.rls && r.force && r.policies === '1'), JSON.stringify(rows));
    });
    await attempt('FK composta bloqueia pasta de outro usuário', async () => {
      await admin.query('BEGIN');
      try {
        const a = randomUUID();
        const b = randomUUID();
        const folder = randomUUID();
        await admin.query(
          `INSERT INTO app_auth."user" (id, name, email) VALUES ($1, 'fk-a', $3), ($2, 'fk-b', $4)`,
          [a, b, `${FAKE_PREFIX}fk-a${FAKE_DOMAIN}`, `${FAKE_PREFIX}fk-b${FAKE_DOMAIN}`]
        );
        await admin.query(`INSERT INTO app.folders (id, user_id, name) VALUES ($1, $2, 'x')`, [folder, a]);
        let code = '';
        try {
          await admin.query('SAVEPOINT s');
          await admin.query(`INSERT INTO app.documents (user_id, folder_id, title) VALUES ($1, $2, 'x')`, [b, folder]);
        } catch (err) {
          code = (err as { code?: string }).code ?? '';
        }
        expect(code === '23503', `código ${code || 'nenhum erro'}`);
      } finally {
        await admin.query('ROLLBACK');
      }
    });
    await attempt('sem pg_session_jwt nem schemas do Neon', async () => {
      const [r] = await q<{ n: string }>(
        `SELECT ((SELECT count(*) FROM pg_extension WHERE extname = 'pg_session_jwt')
               + (SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth', 'neon_auth')))::text AS n`
      );
      expect(r!.n === '0', r!.n);
    });

    // ---------- Usuários fictícios ----------
    for (const u of fake) {
      await admin.query(`INSERT INTO app_auth."user" (id, name, email) VALUES ($1, 'Staging Check', $2)`, [u.id, u.email]);
      await admin.query(
        `INSERT INTO app_auth.account ("accountId", "providerId", "userId", password) VALUES ($1, 'credential', $2, $3)`,
        [u.id, u.id, neonStyleHash(u.password)]
      );
    }
    const [A, B] = fake as [typeof fake[0], typeof fake[0]];

    // ---------- API pela rede privada ----------
    const P = env.privateUrl;
    await attempt('privada: health 200', async () => {
      const r = await call(P, 'GET', '/api/health', { key: false });
      expect(r.status === 200, String(r.status));
    });
    await attempt('privada: sem login = 401', async () => {
      const r = await call(P, 'GET', '/api/documents');
      expect(r.status === 401, String(r.status));
    });
    await attempt('privada: cadastro público bloqueado', async () => {
      const email = `${FAKE_PREFIX}signup-${randomUUID().slice(0, 8)}${FAKE_DOMAIN}`;
      const r = await call(P, 'POST', '/api/auth/sign-up/email', {
        body: { name: 'x', email, password: randomBytes(12).toString('hex') },
        ip: freshIp(),
      });
      const created = await q(`SELECT 1 FROM app_auth."user" WHERE email = $1`, [email]);
      expect(r.status >= 400 && r.status < 500 && created.length === 0, `status ${r.status}, criado=${created.length}`);
      return `status ${r.status}`;
    });
    await attempt('privada: senha incorreta = 401', async () => {
      const r = await signIn(P, A.email, 'senha-errada-' + randomBytes(4).toString('hex'), freshIp());
      expect(r.status === 401, String(r.status));
      expect(!cookieHeader(r).includes('session_token'), 'cookie de sessão emitido');
    });

    let cookieA = '';
    let cookieB = '';
    await attempt('privada: login com hash no formato do Neon = 200 e mesmo ID', async () => {
      const ra = await signIn(P, A.email, A.password, freshIp());
      const rb = await signIn(P, B.email, B.password, freshIp());
      expect(ra.status === 200 && rb.status === 200, `${ra.status}/${rb.status}`);
      const body = (await ra.json()) as { user?: { id?: string } };
      expect(body.user?.id === A.id, 'ID diferente');
      cookieA = cookieHeader(ra);
      cookieB = cookieHeader(rb);
    });

    await attempt('privada: isolamento entre usuários', async () => {
      const folder = (await (await call(P, 'POST', '/api/folders', { cookie: cookieA, body: { name: 'pasta A' } })).json()) as { folder: { id: string } };
      const docRes = await call(P, 'POST', '/api/documents', { cookie: cookieA, body: { title: 'doc A', content: 'conteúdo A', folderId: folder.folder.id } });
      expect(docRes.status === 201, `criar ${docRes.status}`);
      const doc = ((await docRes.json()) as { document: { id: string; updatedAt: string } }).document;
      const bDoc = ((await (await call(P, 'POST', '/api/documents', { cookie: cookieB, body: { title: 'doc B' } })).json()) as { document: { id: string } }).document;

      const listB = (await (await call(P, 'GET', '/api/documents', { cookie: cookieB })).json()) as { documents: Array<{ id: string }> };
      expect(!listB.documents.some((d) => d.id === doc.id), 'B vê documento de A');
      const foldersB = (await (await call(P, 'GET', '/api/folders', { cookie: cookieB })).json()) as { folders: Array<{ id: string }> };
      expect(!foldersB.folders.some((f) => f.id === folder.folder.id), 'B vê pasta de A');

      const statuses = [
        (await call(P, 'PATCH', `/api/documents/${doc.id}`, { cookie: cookieB, body: { title: 'invadido' } })).status,
        (await call(P, 'DELETE', `/api/documents/${doc.id}`, { cookie: cookieB })).status,
        (await call(P, 'PATCH', `/api/folders/${folder.folder.id}`, { cookie: cookieB, body: { name: 'invadida' } })).status,
        (await call(P, 'DELETE', `/api/folders/${folder.folder.id}`, { cookie: cookieB })).status,
        (await call(P, 'PATCH', `/api/documents/${bDoc.id}`, { cookie: cookieB, body: { folderId: folder.folder.id } })).status,
        (await call(P, 'POST', '/api/documents', { cookie: cookieB, body: { title: 'x', folderId: folder.folder.id } })).status,
      ];
      expect(statuses.every((s) => s === 404), `esperado 404 em tudo: ${statuses.join(',')}`);
      const forged = await call(P, 'POST', '/api/documents', { cookie: cookieB, body: { title: 'forjado', user_id: A.id } });
      expect(forged.status === 400, `user_id forjado: ${forged.status}`);

      const [row] = await q<{ title: string; user_id: string; folder_id: string; updated_at: Date }>(
        'SELECT title, user_id, folder_id, updated_at FROM app.documents WHERE id = $1',
        [doc.id]
      );
      expect(row?.title === 'doc A' && row.user_id === A.id && row.folder_id === folder.folder.id, 'documento de A alterado');
      expect(row!.updated_at.toISOString() === doc.updatedAt, 'updated_at de A alterado');
      return '6 tentativas = 404, user_id forjado = 400, dados de A intactos';
    });

    await attempt('privada: sessão expirada = 401', async () => {
      await admin.query(`UPDATE app_auth.session SET "expiresAt" = now() - interval '1 minute' WHERE "userId" = $1`, [A.id]);
      const r = await call(P, 'GET', '/api/documents', { cookie: cookieA });
      expect(r.status === 401, String(r.status));
    });
    await attempt('privada: logout invalida a sessão', async () => {
      const out = await call(P, 'POST', '/api/auth/sign-out', { cookie: cookieB, body: {} });
      const after = await call(P, 'GET', '/api/documents', { cookie: cookieB });
      expect(out.status === 200 && after.status === 401, `${out.status}/${after.status}`);
    });
    await attempt('privada: limite por e-mail (troca de IP não escapa)', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) statuses.push((await signIn(P, B.email, `errada-${i}-xyz`, freshIp())).status);
      expect(statuses.slice(0, 10).every((s) => s === 401) && statuses[10] === 429, statuses.join(','));
    });

    // ---------- API pelo domínio público ----------
    if (env.publicUrl) {
      const U = env.publicUrl;
      await attempt('pública: health 200 (sem chave)', async () => {
        const r = await call(U, 'GET', '/api/health', { key: false });
        expect(r.status === 200, String(r.status));
      });
      await attempt('pública: sem chave de staging = 404', async () => {
        const statuses = [
          (await call(U, 'GET', '/api/documents', { key: false })).status,
          (await call(U, 'POST', '/api/auth/sign-in/email', { key: false, body: { email: A.email, password: A.password } })).status,
        ];
        expect(statuses.every((s) => s === 404), statuses.join(','));
      });
      await attempt('pública: com chave e sem login = 401', async () => {
        const r = await call(U, 'GET', '/api/documents');
        expect(r.status === 401, String(r.status));
      });
      await attempt('pública: cookie __Secure-, HttpOnly, Secure, SameSite=Lax', async () => {
        let r = await signIn(U, A.email, A.password);
        if (r.status === 429) {
          // Balde do IP de saída ainda cheio de uma execução anterior: espera a janela.
          const wait = Math.min(Number(r.headers.get('retry-after') ?? '60') || 60, 65);
          log(`  (429 por execução anterior; aguardando ${wait}s)`);
          await new Promise((done) => setTimeout(done, wait * 1000));
          r = await signIn(U, A.email, A.password);
        }
        expect(r.status === 200, `login ${r.status}`);
        const c = r.headers.getSetCookie().find((x) => x.includes('session_token='));
        expect(!!c, 'sem cookie');
        expect(/^__Secure-/.test(c!) && /;\s*HttpOnly/i.test(c!) && /;\s*Secure/i.test(c!) && /;\s*SameSite=Lax/i.test(c!), 'atributos ausentes');
        const docs = await call(U, 'GET', '/api/documents', { cookie: cookieHeader(r) });
        expect(docs.status === 200, `documentos ${docs.status}`);
      });
      await attempt('pública: rate limit por IP (no máximo 5 tentativas por minuto)', async () => {
        // O login do teste anterior já conta no mesmo balde (mesmo IP de saída).
        const statuses: number[] = [];
        for (let i = 0; i < 6; i += 1) {
          statuses.push((await signIn(U, `${FAKE_PREFIX}nao-existe-${i}${FAKE_DOMAIN}`, 'senha-errada-123')).status);
        }
        const first429 = statuses.indexOf(429);
        expect(first429 >= 0 && first429 <= 5, statuses.join(','));
        expect(statuses.slice(0, first429).every((s) => s === 401), statuses.join(','));
        expect(statuses.slice(first429).every((s) => s === 429), statuses.join(','));
        return statuses.join(',');
      });
      await attempt('pública: cabeçalhos de IP vistos pela API', async () => {
        const r = await call(U, 'GET', '/api/_diag/request');
        if (r.status === 404) return 'diagnóstico desligado (ENABLE_REQUEST_DIAGNOSTICS)';
        const d = (await r.json()) as { forwarding: Record<string, { hops: number }>; rateLimitIp: string | null };
        const hops = Object.entries(d.forwarding).map(([k, v]) => `${k}:${v.hops}`).join(' ');
        expect(d.rateLimitIp !== null, `nenhum IP resolvido (${hops})`);
        return `${hops}; IP do rate limit resolvido`;
      });
      await attempt('pública: cabeçalhos de IP forjados pelo cliente não definem o IP do rate limit', async () => {
        const r = await call(U, 'GET', '/api/_diag/request', {
          headers: { 'x-forwarded-for': '198.51.100.77', 'x-real-ip': '198.51.100.88' },
        });
        if (r.status === 404) return 'diagnóstico desligado';
        const d = (await r.json()) as { forwarding: Record<string, { hops: number; masked: string[] }>; rateLimitIp: string | null };
        const view = Object.entries(d.forwarding)
          .map(([k, v]) => `${k}:${v.hops}[${v.masked.map((m) => (m.startsWith('198.51.') ? 'FORJADO' : 'outro')).join('|')}]`)
          .join(' ');
        expect(d.rateLimitIp !== '198.51.x.x', `IP forjado aceito pelo rate limit (${view})`);
        return `${view}; rate limit usa ${d.rateLimitIp === null ? 'balde compartilhado (cadeia sem proxy confiável)' : 'IP não forjado'}`;
      });
    } else {
      record('pública: não testada', false, 'STAGING_PUBLIC_URL ausente');
    }

    // ---------- Conexões ----------
    await attempt('API conecta como app_api pela rede privada', async () => {
      const rows = await q<{ usename: string; addr: string | null; ssl: boolean | null }>(
        `SELECT a.usename, host(a.client_addr) AS addr, s.ssl
         FROM pg_stat_activity a LEFT JOIN pg_stat_ssl s ON s.pid = a.pid
         WHERE a.datname = current_database() AND a.usename = 'app_api'`
      );
      expect(rows.length > 0, 'nenhuma conexão do app_api');
      // Faixas privadas, CGNAT, ULA IPv6 (rede privada do Railway) e loopback.
      const isPrivate = (ip: string | null) =>
        !!ip &&
        (/^(10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip) ||
          /^f[cd]/i.test(ip) ||
          ip === '::1');
      expect(rows.every((r) => isPrivate(r.addr)), 'conexão vinda de endereço público');
      const others = await q<{ usename: string }>(
        `SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = current_database() AND usename IS NOT NULL AND usename NOT IN ('app_api', current_user)`
      );
      expect(others.length === 0, `outros usuários conectados: ${others.map((o) => o.usename).join(',')}`);
      return `${rows.length} conexão(ões) app_api, todas de endereço privado`;
    });
  } finally {
    // ---------- Limpeza ----------
    await admin.query(`DELETE FROM app_auth."user" WHERE email LIKE $1`, [`${FAKE_PREFIX}%${FAKE_DOMAIN}`]);
    await admin.query(`DELETE FROM app_auth."rateLimit"`);
    const after = await q<{ users: string; docs: string; leftovers: string }>(
      `SELECT (SELECT count(*) FROM app_auth."user")::text AS users, (SELECT count(*) FROM app.documents)::text AS docs,
              (SELECT count(*) FROM app_auth."user" WHERE email LIKE '${FAKE_PREFIX}%')::text AS leftovers`
    );
    const ok = after[0]!.users === before[0]!.users && after[0]!.docs === before[0]!.docs && after[0]!.leftovers === '0';
    record('limpeza: dados fictícios removidos, estado inicial restaurado', ok, `${after[0]!.users} usuário(s), ${after[0]!.docs} documento(s)`);
    await admin.end();
  }

  const failed = results.filter((r) => !r.ok).length;
  log(`RESULTADO: ${results.length - failed}/${results.length} verificações aprovadas`);
  return failed === 0;
}
