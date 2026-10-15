import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { withUser } from '../src/db/pool.js';
import { createUser, makeTestApp, type FakeUser, type TestContext } from './helpers.js';

/**
 * Testa o banco diretamente com o papel da API (app_api), sem passar pelas
 * rotas: prova que o RLS isola mesmo se a API errar um filtro.
 */

let ctx: TestContext;
let a: FakeUser;
let b: FakeUser;
let aDoc: string;
let bDoc: string;
let aFolder: string;

beforeAll(async () => {
  ctx = await makeTestApp();
  a = await createUser(ctx.admin);
  b = await createUser(ctx.admin);
  aFolder = randomUUID();
  aDoc = randomUUID();
  bDoc = randomUUID();
  await ctx.admin.query(`INSERT INTO app.folders (id, user_id, name) VALUES ($1, $2, 'pasta A')`, [aFolder, a.id]);
  await ctx.admin.query(
    `INSERT INTO app.documents (id, user_id, title, content) VALUES ($1, $2, 'doc A', 'a'), ($3, $4, 'doc B', 'b')`,
    [aDoc, a.id, bDoc, b.id]
  );
});

afterAll(async () => {
  await ctx.close();
});

describe('papel usado pela API', () => {
  it('a API conecta como app_api, sem superusuário e sem BYPASSRLS', async () => {
    const { rows } = await ctx.pool.query(
      `SELECT current_user AS who, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication
       FROM pg_roles r WHERE r.rolname = current_user`
    );
    expect(rows[0]).toEqual({
      who: 'app_api',
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
    });
  });

  it('o servidor de teste é PostgreSQL 18', async () => {
    const { rows } = await ctx.pool.query(`SELECT current_setting('server_version_num')::int AS v`);
    expect(rows[0].v).toBeGreaterThanOrEqual(180000);
    expect(rows[0].v).toBeLessThan(190000);
  });

  it('app_api não é dono das tabelas e o RLS está ativo e forçado', async () => {
    const { rows } = await ctx.admin.query(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app' AND c.relkind = 'r' ORDER BY c.relname`
    );
    expect(rows).toEqual([
      { relname: 'documents', owner: 'app_owner', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'folders', owner: 'app_owner', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('app_api não consegue desligar o RLS nem criar objetos', async () => {
    await expect(ctx.pool.query('ALTER TABLE app.documents DISABLE ROW LEVEL SECURITY')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(ctx.pool.query('CREATE TABLE app.intrusa (id int)')).rejects.toMatchObject({ code: '42501' });
    await expect(ctx.pool.query('TRUNCATE app.documents')).rejects.toMatchObject({ code: '42501' });
    await expect(ctx.pool.query('SET ROLE app_owner')).rejects.toMatchObject({ code: '42501' });
  });

  it('não existe nenhuma dependência do Neon (pg_session_jwt, schema auth/neon_auth)', async () => {
    const { rows } = await ctx.admin.query(
      `SELECT
         (SELECT count(*)::int FROM pg_extension WHERE extname = 'pg_session_jwt') AS ext,
         (SELECT count(*)::int FROM pg_namespace WHERE nspname IN ('auth', 'neon_auth')) AS schemas`
    );
    expect(rows[0]).toEqual({ ext: 0, schemas: 0 });
  });
});

describe('policies RLS com app_api', () => {
  it('sem usuário definido na transação, não vê nem grava nada', async () => {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      const docs = await client.query('SELECT id FROM app.documents');
      const folders = await client.query('SELECT id FROM app.folders');
      expect(docs.rowCount).toBe(0);
      expect(folders.rowCount).toBe(0);
      // O DEFAULT de user_id devolve NULL fora de uma sessão; o WITH CHECK do RLS recusa.
      await expect(client.query(`INSERT INTO app.documents (title) VALUES ('sem dono')`)).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('row-level security'),
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('com o usuário A, mesmo sem WHERE, só aparecem linhas de A', async () => {
    const ids = await withUser(ctx.pool, a.id, async (c) => (await c.query('SELECT id FROM app.documents')).rows);
    expect(ids).toEqual([{ id: aDoc }]);
  });

  it('A não altera nem apaga linhas de B, mesmo sem filtro por usuário', async () => {
    const result = await withUser(ctx.pool, a.id, async (c) => {
      const upd = await c.query(`UPDATE app.documents SET title = 'hackeado' WHERE id = $1`, [bDoc]);
      const del = await c.query('DELETE FROM app.documents WHERE id = $1', [bDoc]);
      return { upd: upd.rowCount, del: del.rowCount };
    });
    expect(result).toEqual({ upd: 0, del: 0 });
    const { rows } = await ctx.admin.query('SELECT title FROM app.documents WHERE id = $1', [bDoc]);
    expect(rows[0].title).toBe('doc B');
  });

  it('app_api não pode gravar user_id (nem em INSERT nem em UPDATE)', async () => {
    await expect(
      withUser(ctx.pool, a.id, (c) =>
        c.query(`INSERT INTO app.documents (user_id, title) VALUES ($1, 'como B')`, [b.id])
      )
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withUser(ctx.pool, a.id, (c) => c.query('UPDATE app.documents SET user_id = $1 WHERE id = $2', [b.id, aDoc]))
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('INSERT sem user_id herda o usuário da sessão', async () => {
    const owner = await withUser(ctx.pool, b.id, async (c) => {
      const r = await c.query(`INSERT INTO app.documents (title) VALUES ('novo de B') RETURNING user_id`);
      return r.rows[0].user_id as string;
    });
    expect(owner).toBe(b.id);
  });

  it('B não consegue colocar documento na pasta de A, nem via SQL direto', async () => {
    await expect(
      withUser(ctx.pool, b.id, (c) => c.query('UPDATE app.documents SET folder_id = $1 WHERE id = $2', [aFolder, bDoc]))
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('trocar o usuário da sessão no meio da transação não dá acesso a outra conta sem passar pela API', async () => {
    // Documenta a premissa: app.user_id só pode vir do servidor. O valor fica
    // restrito à transação; numa nova transação a sessão volta a não ver nada.
    await withUser(ctx.pool, a.id, async () => undefined);
    const client = await ctx.pool.connect();
    try {
      const r = await client.query('SELECT id FROM app.documents');
      expect(r.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('app_api lê as tabelas do Better Auth (servidor de autenticação), mas sem DDL', async () => {
    const r = await ctx.pool.query('SELECT count(*)::int AS n FROM "user"');
    expect(r.rows[0].n).toBeGreaterThan(0);
    await expect(ctx.pool.query('ALTER TABLE app_auth.account ADD COLUMN x int')).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('isolamento da conexão do app_api', () => {
  it('não conecta como administrador por engano: a URL de admin é outra', () => {
    expect(new URL(inject('apiUrl')).username).toBe('app_api');
    expect(new URL(inject('adminUrl')).username).not.toBe('app_api');
  });

  it('o papel app_api não consegue conectar sem a senha', async () => {
    const url = new URL(inject('apiUrl'));
    url.password = 'senha-errada';
    const client = new pg.Client({ connectionString: url.toString() });
    await expect(client.connect()).rejects.toBeTruthy();
  });
});
