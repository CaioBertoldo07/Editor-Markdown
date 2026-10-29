import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, login, makeTestApp, request, type FakeUser, type TestContext } from './helpers.js';

type Doc = { id: string; title: string; content: string; folderId: string | null; createdAt: string; updatedAt: string };
type Folder = { id: string; name: string; createdAt: string };

let ctx: TestContext;
let alice: FakeUser;
let bob: FakeUser;
let aliceCookie: string;
let bobCookie: string;

const json = async <T>(res: Response) => (await res.json()) as T;

async function createDoc(cookie: string, body: Record<string, unknown> = {}) {
  const res = await request(ctx, 'POST', '/api/documents', { cookie, body });
  expect(res.status).toBe(201);
  return (await json<{ document: Doc }>(res)).document;
}

async function createFolder(cookie: string, name = 'Pasta') {
  const res = await request(ctx, 'POST', '/api/folders', { cookie, body: { name } });
  expect(res.status).toBe(201);
  return (await json<{ folder: Folder }>(res)).folder;
}

async function listDocs(cookie: string) {
  const res = await request(ctx, 'GET', '/api/documents', { cookie });
  expect(res.status).toBe(200);
  return (await json<{ documents: Doc[] }>(res)).documents;
}

async function dbDoc(id: string) {
  const { rows } = await ctx.admin.query(
    'SELECT id, user_id, folder_id, title, content, updated_at FROM app.documents WHERE id = $1',
    [id]
  );
  return rows[0] as { id: string; user_id: string; folder_id: string | null; title: string; content: string; updated_at: Date } | undefined;
}

beforeAll(async () => {
  ctx = await makeTestApp();
  alice = await createUser(ctx.admin, { email: 'alice@example.test' });
  bob = await createUser(ctx.admin, { email: 'bob@example.test' });
});

beforeEach(async () => {
  aliceCookie = await login(ctx, alice);
  bobCookie = await login(ctx, bob);
});

afterAll(async () => {
  await ctx.close();
});

describe('fluxo do dono', () => {
  it('cria, lista, edita, move e exclui documentos', async () => {
    const folder = await createFolder(aliceCookie, 'Trabalho');
    const doc = await createDoc(aliceCookie);
    expect(doc).toMatchObject({ title: 'Novo Documento', content: '', folderId: null });

    const edited = await request(ctx, 'PATCH', `/api/documents/${doc.id}`, {
      cookie: aliceCookie,
      body: { title: 'Notas', content: '# Olá' },
    });
    expect(edited.status).toBe(200);
    const editedDoc = (await json<{ document: Doc }>(edited)).document;
    expect(editedDoc).toMatchObject({ title: 'Notas', content: '# Olá' });
    expect(new Date(editedDoc.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(doc.updatedAt).getTime());

    const moved = await request(ctx, 'PATCH', `/api/documents/${doc.id}`, {
      cookie: aliceCookie,
      body: { folderId: folder.id },
    });
    expect(moved.status).toBe(200);
    expect((await json<{ document: Doc }>(moved)).document.folderId).toBe(folder.id);

    const outOfFolder = await request(ctx, 'PATCH', `/api/documents/${doc.id}`, {
      cookie: aliceCookie,
      body: { folderId: null },
    });
    expect((await json<{ document: Doc }>(outOfFolder)).document.folderId).toBeNull();

    expect((await listDocs(aliceCookie)).map((d) => d.id)).toContain(doc.id);

    const del = await request(ctx, 'DELETE', `/api/documents/${doc.id}`, { cookie: aliceCookie });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe('');
    expect(await dbDoc(doc.id)).toBeUndefined();
    // Recarregar a página = nova listagem: o documento não volta.
    expect((await listDocs(aliceCookie)).map((d) => d.id)).not.toContain(doc.id);
    expect((await request(ctx, 'DELETE', `/api/documents/${doc.id}`, { cookie: aliceCookie })).status).toBe(404);
  });

  it('cria documento direto numa pasta própria', async () => {
    const folder = await createFolder(aliceCookie);
    const doc = await createDoc(aliceCookie, { title: 'Na pasta', folderId: folder.id });
    expect(doc.folderId).toBe(folder.id);
  });

  it('importa vários documentos de uma vez, preservando updatedAt enviado', async () => {
    const folder = await createFolder(aliceCookie, 'Importados');
    const res = await request(ctx, 'POST', '/api/documents/import', {
      cookie: aliceCookie,
      body: {
        folderId: folder.id,
        documents: [
          { title: 'um.md', content: 'conteúdo 1', updatedAt: '2025-01-02T03:04:05.000Z' },
          { title: 'dois.md', content: 'conteúdo 2' },
        ],
      },
    });
    expect(res.status).toBe(201);
    const docs = (await json<{ documents: Doc[] }>(res)).documents;
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.folderId === folder.id)).toBe(true);
    expect(docs[0]!.updatedAt).toBe('2025-01-02T03:04:05.000Z');
  });

  it('cria, renomeia e exclui pastas; excluir a pasta mantém os documentos fora dela', async () => {
    const folder = await createFolder(aliceCookie, 'Temporária');
    const doc = await createDoc(aliceCookie, { folderId: folder.id });

    const renamed = await request(ctx, 'PATCH', `/api/folders/${folder.id}`, {
      cookie: aliceCookie,
      body: { name: '  Renomeada  ' },
    });
    expect(renamed.status).toBe(200);
    expect((await json<{ folder: Folder }>(renamed)).folder.name).toBe('Renomeada');

    const del = await request(ctx, 'DELETE', `/api/folders/${folder.id}`, { cookie: aliceCookie });
    expect(del.status).toBe(204);

    const after = await dbDoc(doc.id);
    expect(after).toBeDefined();
    expect(after!.folder_id).toBeNull();
    expect(after!.user_id).toBe(alice.id);
  });

  it('pasta: aceita createdAt (migração do localStorage) e lista em ordem de criação', async () => {
    const res = await request(ctx, 'POST', '/api/folders', {
      cookie: aliceCookie,
      body: { name: 'Antiga', createdAt: '2020-05-06T07:08:09.000Z' },
    });
    expect(res.status).toBe(201);
    const list = await request(ctx, 'GET', '/api/folders', { cookie: aliceCookie });
    const folders = (await json<{ folders: Folder[] }>(list)).folders;
    expect(folders[0]).toMatchObject({ name: 'Antiga', createdAt: '2020-05-06T07:08:09.000Z' });
  });
});

describe('isolamento entre usuários', () => {
  it('a listagem de um usuário nunca inclui documentos ou pastas de outro', async () => {
    const aliceDoc = await createDoc(aliceCookie, { title: 'segredo da alice' });
    const aliceFolder = await createFolder(aliceCookie, 'pasta da alice');

    const bobDocs = await listDocs(bobCookie);
    expect(bobDocs.find((d) => d.id === aliceDoc.id)).toBeUndefined();
    expect(bobDocs.some((d) => d.title === 'segredo da alice')).toBe(false);

    const bobFolders = (await json<{ folders: Folder[] }>(await request(ctx, 'GET', '/api/folders', { cookie: bobCookie })))
      .folders;
    expect(bobFolders.find((f) => f.id === aliceFolder.id)).toBeUndefined();
  });

  it('editar ou excluir documento de outro usuário: 404 e nada muda', async () => {
    const doc = await createDoc(aliceCookie, { title: 'original', content: 'intacto' });

    const edit = await request(ctx, 'PATCH', `/api/documents/${doc.id}`, {
      cookie: bobCookie,
      body: { title: 'invadido', content: 'apagado' },
    });
    expect(edit.status).toBe(404);

    const del = await request(ctx, 'DELETE', `/api/documents/${doc.id}`, { cookie: bobCookie });
    expect(del.status).toBe(404);

    const row = await dbDoc(doc.id);
    expect(row).toMatchObject({ title: 'original', content: 'intacto', user_id: alice.id });
    expect(row!.updated_at.toISOString()).toBe(doc.updatedAt);
  });

  it('renomear ou excluir pasta de outro usuário: 404 e nada muda', async () => {
    const folder = await createFolder(aliceCookie, 'da alice');
    expect(
      (await request(ctx, 'PATCH', `/api/folders/${folder.id}`, { cookie: bobCookie, body: { name: 'do bob' } })).status
    ).toBe(404);
    expect((await request(ctx, 'DELETE', `/api/folders/${folder.id}`, { cookie: bobCookie })).status).toBe(404);
    const { rows } = await ctx.admin.query('SELECT name, user_id FROM app.folders WHERE id = $1', [folder.id]);
    expect(rows[0]).toEqual({ name: 'da alice', user_id: alice.id });
  });

  it('mover documento próprio para pasta de outro usuário: 404 e o documento não muda', async () => {
    const aliceFolder = await createFolder(aliceCookie, 'alvo');
    const bobDoc = await createDoc(bobCookie, { title: 'do bob' });

    const res = await request(ctx, 'PATCH', `/api/documents/${bobDoc.id}`, {
      cookie: bobCookie,
      body: { folderId: aliceFolder.id },
    });
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe('folder_not_found');
    expect((await dbDoc(bobDoc.id))!.folder_id).toBeNull();
  });

  it('criar ou importar documento na pasta de outro usuário: 404 e nada é criado', async () => {
    const aliceFolder = await createFolder(aliceCookie, 'alvo 2');
    const before = (await listDocs(bobCookie)).length;

    const create = await request(ctx, 'POST', '/api/documents', {
      cookie: bobCookie,
      body: { title: 'intruso', folderId: aliceFolder.id },
    });
    expect(create.status).toBe(404);

    const imp = await request(ctx, 'POST', '/api/documents/import', {
      cookie: bobCookie,
      body: { folderId: aliceFolder.id, documents: [{ title: 'x', content: 'y' }] },
    });
    expect(imp.status).toBe(404);

    expect((await listDocs(bobCookie)).length).toBe(before);
    const { rowCount } = await ctx.admin.query('SELECT 1 FROM app.documents WHERE folder_id = $1', [aliceFolder.id]);
    expect(rowCount).toBe(0);
  });

  it('user_id/userId enviado pelo navegador é recusado (400) e nada é criado para outra pessoa', async () => {
    for (const body of [
      { title: 'forjado', user_id: alice.id },
      { title: 'forjado', userId: alice.id },
    ]) {
      const res = await request(ctx, 'POST', '/api/documents', { cookie: bobCookie, body });
      expect(res.status).toBe(400);
    }
    const patch = await request(ctx, 'PATCH', `/api/documents/${randomUUID()}`, {
      cookie: bobCookie,
      body: { user_id: bob.id },
    });
    expect(patch.status).toBe(400);
    const { rowCount } = await ctx.admin.query(`SELECT 1 FROM app.documents WHERE title = 'forjado'`);
    expect(rowCount).toBe(0);
  });
});

describe('validação e limites', () => {
  it('id inválido na URL: 404', async () => {
    expect((await request(ctx, 'PATCH', '/api/documents/nao-e-uuid', { cookie: aliceCookie, body: { title: 'x' } })).status).toBe(404);
    expect((await request(ctx, 'DELETE', '/api/folders/123', { cookie: aliceCookie })).status).toBe(404);
  });

  it('JSON inválido ou campos com tipo errado: 400', async () => {
    expect((await request(ctx, 'POST', '/api/documents', { cookie: aliceCookie, body: '{nao json' })).status).toBe(400);
    expect((await request(ctx, 'POST', '/api/documents', { cookie: aliceCookie, body: { title: 42 } })).status).toBe(400);
    expect((await request(ctx, 'POST', '/api/folders', { cookie: aliceCookie, body: { name: '   ' } })).status).toBe(400);
    const doc = await createDoc(aliceCookie);
    expect((await request(ctx, 'PATCH', `/api/documents/${doc.id}`, { cookie: aliceCookie, body: {} })).status).toBe(400);
  });

  it('conteúdo acima de 1.000.000 caracteres: recusado', async () => {
    const res = await request(ctx, 'POST', '/api/documents', {
      cookie: aliceCookie,
      body: { content: 'a'.repeat(1_000_001) },
    });
    expect([400, 413]).toContain(res.status);
  });

  it('importação com mais de 100 documentos: 400', async () => {
    const documents = Array.from({ length: 101 }, (_, i) => ({ title: `d${i}`, content: '' }));
    const res = await request(ctx, 'POST', '/api/documents/import', { cookie: aliceCookie, body: { documents } });
    expect(res.status).toBe(400);
  });

  it('corpo maior que o limite de bytes: 413', async () => {
    const res = await request(ctx, 'POST', '/api/documents/import', {
      cookie: aliceCookie,
      body: { documents: Array.from({ length: 6 }, () => ({ title: 't', content: 'x'.repeat(999_000) })) },
    });
    expect(res.status).toBe(413);
  });
});

describe('preservação de dados importados do Neon (fictícios)', () => {
  it('IDs, relacionamentos e timestamps importados aparecem idênticos na API', async () => {
    const owner = await createUser(ctx.admin, { createdAt: '2026-08-26T17:21:00.000Z' });
    const folderId = randomUUID();
    const inFolder = randomUUID();
    const loose = randomUUID();

    // Simula a carga do script de importação (como admin, valores explícitos).
    await ctx.admin.query(
      `INSERT INTO app.folders (id, user_id, name, created_at) VALUES ($1, $2, 'Faculdade', '2026-08-27T10:00:00Z')`,
      [folderId, owner.id]
    );
    await ctx.admin.query(
      `INSERT INTO app.documents (id, user_id, folder_id, title, content, created_at, updated_at) VALUES
       ($1, $3, $4, 'Resumo', 'texto 1', '2026-08-27T10:05:00Z', '2026-09-01T12:00:00Z'),
       ($2, $3, NULL, 'Solto', 'texto 2', '2026-08-28T09:00:00Z', '2026-08-30T08:30:00Z')`,
      [inFolder, loose, owner.id, folderId]
    );

    const cookie = await login(ctx, owner);
    const docs = await listDocs(cookie);
    expect(docs).toEqual([
      {
        id: inFolder,
        title: 'Resumo',
        content: 'texto 1',
        folderId,
        // Documentos que já existiam viram Markdown pelo DEFAULT da migration 006.
        kind: 'markdown',
        mainFile: null,
        createdAt: '2026-08-27T10:05:00.000Z',
        updatedAt: '2026-09-01T12:00:00.000Z',
      },
      {
        id: loose,
        title: 'Solto',
        content: 'texto 2',
        folderId: null,
        kind: 'markdown',
        mainFile: null,
        createdAt: '2026-08-28T09:00:00.000Z',
        updatedAt: '2026-08-30T08:30:00.000Z',
      },
    ]);
    const folders = (await json<{ folders: Folder[] }>(await request(ctx, 'GET', '/api/folders', { cookie }))).folders;
    expect(folders).toEqual([{ id: folderId, name: 'Faculdade', createdAt: '2026-08-27T10:00:00.000Z' }]);
  });

  it('a FK composta impede, no banco, documento de um usuário em pasta de outro', async () => {
    const a = await createUser(ctx.admin);
    const b = await createUser(ctx.admin);
    const folderId = randomUUID();
    await ctx.admin.query(`INSERT INTO app.folders (id, user_id, name) VALUES ($1, $2, 'de A')`, [folderId, a.id]);
    await expect(
      ctx.admin.query(`INSERT INTO app.documents (user_id, folder_id, title) VALUES ($1, $2, 'de B')`, [b.id, folderId])
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('apagar um usuário apaga só os dados dele', async () => {
    const temp = await createUser(ctx.admin);
    const cookie = await login(ctx, temp);
    const doc = await createDoc(cookie, { title: 'temporário' });
    const aliceDoc = await createDoc(aliceCookie, { title: 'fica' });
    await ctx.admin.query(`DELETE FROM app_auth."user" WHERE id = $1`, [temp.id]);
    expect(await dbDoc(doc.id)).toBeUndefined();
    expect(await dbDoc(aliceDoc.id)).toBeDefined();
  });
});
