import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withUser } from '../src/db/pool.js';
import { CompileJobs, type callCompiler, type CompileRequest } from '../src/latex/compileJobs.js';
import { createUser, login, makeTestApp, nextIp, ORIGIN, request, type FakeUser, type TestContext } from './helpers.js';

type Doc = { id: string; title: string; content: string; folderId: string | null; kind: string; mainFile: string | null; updatedAt: string };
type ProjectFile = { path: string; kind: 'text' | 'binary'; size: number; content?: string };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const FAKE_PDF = Buffer.from('%PDF-1.5\n% pdf de teste\n%%EOF\n');

let ctx: TestContext;
let alice: FakeUser;
let bob: FakeUser;
let aliceCookie: string;
let bobCookie: string;

/** Compilador falso: devolve o resultado programado e registra o que recebeu. */
const compilerCalls: CompileRequest[] = [];
let nextOutcome: Awaited<ReturnType<typeof callCompiler>> | 'hang' = 'hang';
const fakeRun = (req: CompileRequest, signal: AbortSignal) => {
  compilerCalls.push(req);
  const outcome = nextOutcome;
  if (outcome === 'hang') {
    return new Promise<Awaited<ReturnType<typeof callCompiler>>>((resolve) => {
      signal.addEventListener('abort', () =>
        resolve({ status: 'cancelled', result: { engine: null, durationMs: null, diagnostics: [], log: '', output: '', pdfBytes: 0, message: null }, pdf: null })
      );
    });
  }
  return new Promise<Awaited<ReturnType<typeof callCompiler>>>((resolve) => setTimeout(() => resolve(outcome), 50));
};
const success = (): Awaited<ReturnType<typeof callCompiler>> => ({
  status: 'success',
  result: { engine: 'pdflatex', durationMs: 900, diagnostics: [], log: 'Output written on main.pdf (1 page)', output: '', pdfBytes: FAKE_PDF.length, message: null },
  pdf: FAKE_PDF,
});

const json = async <T>(res: Response) => (await res.json()) as T;

async function createProject(cookie: string, body: Record<string, unknown> = {}) {
  const res = await request(ctx, 'POST', '/api/documents', {
    cookie,
    body: { kind: 'latex', title: 'Projeto', content: '\\documentclass{article}\n\\begin{document}Oi\\end{document}\n', ...body },
  });
  expect(res.status).toBe(201);
  return (await json<{ document: Doc }>(res)).document;
}

const put = (cookie: string, docId: string, filePath: string, body: Uint8Array | string) =>
  ctx.app.request(`${ORIGIN}/api/documents/${docId}/files/content?path=${encodeURIComponent(filePath)}`, {
    method: 'PUT',
    headers: { origin: ORIGIN, cookie, 'x-forwarded-for': nextIp(), 'content-type': 'application/octet-stream' },
    body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
  });

async function listFiles(cookie: string, docId: string) {
  const res = await request(ctx, 'GET', `/api/documents/${docId}/files`, { cookie });
  expect(res.status).toBe(200);
  return json<{ mainFile: string; files: ProjectFile[] }>(res);
}

beforeAll(async () => {
  ctx = await makeTestApp({ compileJobs: new CompileJobs(fakeRun, { maxActivePerUser: 2, ratePerMinute: 6, retentionMs: 60_000, maxStoredPdfBytes: 10_000_000 }) });
  alice = await createUser(ctx.admin, { email: 'alice.latex@example.test' });
  bob = await createUser(ctx.admin, { email: 'bob.latex@example.test' });
});

beforeEach(async () => {
  aliceCookie = await login(ctx, alice);
  bobCookie = await login(ctx, bob);
  compilerCalls.length = 0;
  nextOutcome = 'hang';
});

afterAll(async () => {
  await ctx.close();
});

describe('tipos de documento', () => {
  it('documentos Markdown continuam iguais (kind markdown, sem mainFile)', async () => {
    const res = await request(ctx, 'POST', '/api/documents', { cookie: aliceCookie, body: { title: 'nota', content: '# Oi' } });
    const doc = (await json<{ document: Doc }>(res)).document;
    expect(doc).toMatchObject({ kind: 'markdown', mainFile: null, content: '# Oi' });
    const files = await request(ctx, 'GET', `/api/documents/${doc.id}/files`, { cookie: aliceCookie });
    expect(files.status).toBe(400);
  });

  it('cria projeto LaTeX com main.tex', async () => {
    const doc = await createProject(aliceCookie, { title: 'Artigo' });
    expect(doc).toMatchObject({ kind: 'latex', mainFile: 'main.tex', content: '', title: 'Artigo' });
    const { files, mainFile } = await listFiles(aliceCookie, doc.id);
    expect(mainFile).toBe('main.tex');
    expect(files).toEqual([expect.objectContaining({ path: 'main.tex', kind: 'text', content: expect.stringContaining('\\documentclass') })]);
  });

  it('o tipo nunca muda: PATCH com kind é recusado e Markdown não ganha mainFile', async () => {
    const md = (await json<{ document: Doc }>(await request(ctx, 'POST', '/api/documents', { cookie: aliceCookie, body: {} }))).document;
    expect((await request(ctx, 'PATCH', `/api/documents/${md.id}`, { cookie: aliceCookie, body: { kind: 'latex' } })).status).toBe(400);
    expect((await request(ctx, 'PATCH', `/api/documents/${md.id}`, { cookie: aliceCookie, body: { mainFile: 'main.tex' } })).status).toBe(400);
    const { rows } = await ctx.admin.query('SELECT kind FROM app.documents WHERE id = $1', [md.id]);
    expect(rows[0].kind).toBe('markdown');
  });

  it('o banco também impede o app_api de trocar o tipo', async () => {
    const doc = await createProject(aliceCookie);
    await expect(
      withUser(ctx.pool, alice.id, (client) => client.query("UPDATE app.documents SET kind = 'markdown' WHERE id = $1", [doc.id]))
    ).rejects.toThrow(/permission denied/);
  });

  it('conteúdo de projeto LaTeX não vai em documents.content', async () => {
    const doc = await createProject(aliceCookie);
    const res = await request(ctx, 'PATCH', `/api/documents/${doc.id}`, { cookie: aliceCookie, body: { content: 'x' } });
    expect(res.status).toBe(400);
  });

  it('arquivo principal precisa existir e ser .tex', async () => {
    const doc = await createProject(aliceCookie);
    expect((await request(ctx, 'PATCH', `/api/documents/${doc.id}`, { cookie: aliceCookie, body: { mainFile: 'outro.tex' } })).status).toBe(400);
    await put(aliceCookie, doc.id, 'outro.tex', '\\documentclass{article}');
    await put(aliceCookie, doc.id, 'refs.bib', '@misc{a,title={x}}');
    expect((await request(ctx, 'PATCH', `/api/documents/${doc.id}`, { cookie: aliceCookie, body: { mainFile: 'refs.bib' } })).status).toBe(400);
    const ok = await request(ctx, 'PATCH', `/api/documents/${doc.id}`, { cookie: aliceCookie, body: { mainFile: 'outro.tex' } });
    expect(ok.status).toBe(200);
    expect((await json<{ document: Doc }>(ok)).document.mainFile).toBe('outro.tex');
  });

  it('título, pasta e exclusão de projetos usam as rotas de documentos (arquivos vão junto)', async () => {
    const folder = (await json<{ folder: { id: string } }>(await request(ctx, 'POST', '/api/folders', { cookie: aliceCookie, body: { name: 'Teses' } }))).folder;
    const doc = await createProject(aliceCookie);
    await put(aliceCookie, doc.id, 'cap/a.tex', 'a');
    const moved = await request(ctx, 'PATCH', `/api/documents/${doc.id}`, { cookie: aliceCookie, body: { title: 'Tese', folderId: folder.id } });
    expect((await json<{ document: Doc }>(moved)).document).toMatchObject({ title: 'Tese', folderId: folder.id, kind: 'latex' });
    expect((await request(ctx, 'DELETE', `/api/documents/${doc.id}`, { cookie: aliceCookie })).status).toBe(204);
    const { rows } = await ctx.admin.query('SELECT count(*)::int AS n FROM app.document_files WHERE document_id = $1', [doc.id]);
    expect(rows[0].n).toBe(0);
  });
});

describe('arquivos do projeto', () => {
  let doc: Doc;
  beforeEach(async () => {
    doc = await createProject(aliceCookie);
  });

  it('cria, substitui e lê arquivos de texto e imagens', async () => {
    expect((await put(aliceCookie, doc.id, 'capitulos/introdução.tex', 'Intro')).status).toBe(201);
    expect((await put(aliceCookie, doc.id, 'capitulos/introdução.tex', 'Intro v2')).status).toBe(200);
    expect((await put(aliceCookie, doc.id, 'imagens/fig.png', PNG)).status).toBe(201);
    const { files } = await listFiles(aliceCookie, doc.id);
    expect(files.map((f) => f.path)).toEqual(['capitulos/introdução.tex', 'imagens/fig.png', 'main.tex']);
    expect(files[0]).toMatchObject({ kind: 'text', content: 'Intro v2' });
    expect(files[1]).toMatchObject({ kind: 'binary', size: PNG.length });
    expect(files[1]).not.toHaveProperty('content');

    const raw = await request(ctx, 'GET', `/api/documents/${doc.id}/files/raw?path=imagens/fig.png`, { cookie: aliceCookie });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('image/png');
    expect(raw.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(raw.headers.get('content-security-policy')).toContain('sandbox');
    expect(raw.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(PNG);
  });

  it('atualiza a data do projeto a cada escrita', async () => {
    const before = doc.updatedAt;
    await new Promise((r) => setTimeout(r, 20));
    const res = await put(aliceCookie, doc.id, 'a.tex', 'x');
    const body = await json<{ documentUpdatedAt: string }>(res);
    expect(new Date(body.documentUpdatedAt).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it.each([
    ['../fora.tex'],
    ['/etc/passwd.tex'],
    ['a\\b.tex'],
    ['.latexmkrc'],
    ['latexmkrc'],
    ['sub/biber.conf'],
    ['virus.exe'],
    ['pagina.html'],
    ['img.svg'],
    ['C:/x.tex'],
  ])('recusa o caminho %j', async (bad) => {
    const res = await put(aliceCookie, doc.id, bad, 'x');
    expect(res.status).toBe(400);
  });

  it('recusa binário cujo conteúdo não bate com a extensão', async () => {
    expect((await put(aliceCookie, doc.id, 'fig.png', '<script>alert(1)</script>')).status).toBe(400);
    expect((await put(aliceCookie, doc.id, 'doc.pdf', PNG)).status).toBe(400);
  });

  it('recusa texto que não é UTF-8 ou tem bytes nulos', async () => {
    expect((await put(aliceCookie, doc.id, 'a.tex', new Uint8Array([0xff, 0xfe, 0x00, 0x41]))).status).toBe(400);
    expect((await put(aliceCookie, doc.id, 'a.tex', 'a\u0000b')).status).toBe(400);
  });

  it('limites de tamanho por arquivo', async () => {
    expect((await put(aliceCookie, doc.id, 'grande.tex', 'x'.repeat(1_000_001))).status).toBe(413);
    const bigPng = new Uint8Array(4 * 1024 * 1024 + 1);
    bigPng.set(PNG);
    expect((await put(aliceCookie, doc.id, 'grande.png', bigPng)).status).toBe(413);
  });

  it('cota total do usuário', async () => {
    // Simula 249,9 MB já usados, gravados direto no banco.
    const filler = await createProject(aliceCookie, { title: 'enchimento' });
    await ctx.admin.query("UPDATE app.document_files SET size_bytes = 8388608 WHERE document_id = $1", [filler.id]);
    for (let i = 0; i < 30; i++) {
      await ctx.admin.query(
        "INSERT INTO app.document_files (user_id, document_id, path, content, size_bytes) VALUES ($1, $2, $3, '', 8388608)",
        [alice.id, filler.id, `f${i}.tex`]
      );
    }
    const res = await put(aliceCookie, doc.id, 'mais.png', (() => { const b = new Uint8Array(3 * 1024 * 1024); b.set(PNG); return b; })());
    expect(res.status).toBe(413);
    expect((await json<{ error: string }>(res)).error).toBe('storage_quota_exceeded');
    await request(ctx, 'DELETE', `/api/documents/${filler.id}`, { cookie: aliceCookie });
  });

  it('recusa nomes que conflitam (outra caixa, arquivo x pasta)', async () => {
    await put(aliceCookie, doc.id, 'fig.png', PNG);
    expect((await put(aliceCookie, doc.id, 'FIG.png', PNG)).status).toBe(400);
    expect((await put(aliceCookie, doc.id, 'fig.png/a.tex', 'x')).status).toBe(400);
    await put(aliceCookie, doc.id, 'cap/a.tex', 'x');
    expect((await put(aliceCookie, doc.id, 'cap', 'x')).status).toBe(400);
  });

  it('renomeia arquivo, acompanha o principal e move pastas', async () => {
    await put(aliceCookie, doc.id, 'capitulos/a.tex', 'A');
    await put(aliceCookie, doc.id, 'capitulos/b.tex', 'B');
    let res = await request(ctx, 'POST', `/api/documents/${doc.id}/files/move`, { cookie: aliceCookie, body: { from: 'main.tex', to: 'tese.tex' } });
    expect(res.status).toBe(200);
    expect((await json<{ mainFile: string }>(res)).mainFile).toBe('tese.tex');
    res = await request(ctx, 'POST', `/api/documents/${doc.id}/files/move`, { cookie: aliceCookie, body: { from: 'capitulos', to: 'partes/caps', folder: true } });
    expect(res.status).toBe(200);
    const { files, mainFile } = await listFiles(aliceCookie, doc.id);
    expect(mainFile).toBe('tese.tex');
    expect(files.map((f) => f.path)).toEqual(['partes/caps/a.tex', 'partes/caps/b.tex', 'tese.tex']);
    expect(
      (await request(ctx, 'POST', `/api/documents/${doc.id}/files/move`, { cookie: aliceCookie, body: { from: 'tese.tex', to: 'tese.bib' } })).status
    ).toBe(400);
    expect(
      (await request(ctx, 'POST', `/api/documents/${doc.id}/files/move`, { cookie: aliceCookie, body: { from: 'tese.tex', to: '../x.tex' } })).status
    ).toBe(400);
  });

  it('exclui arquivos e pastas, mas nunca o principal', async () => {
    await put(aliceCookie, doc.id, 'img/a.png', PNG);
    await put(aliceCookie, doc.id, 'img/b.png', PNG);
    await put(aliceCookie, doc.id, 'refs.bib', '@misc{a}');
    expect((await request(ctx, 'DELETE', `/api/documents/${doc.id}/files?path=main.tex`, { cookie: aliceCookie })).status).toBe(400);
    expect((await request(ctx, 'DELETE', `/api/documents/${doc.id}/files?path=refs.bib`, { cookie: aliceCookie })).status).toBe(200);
    const res = await request(ctx, 'DELETE', `/api/documents/${doc.id}/files?folder=img`, { cookie: aliceCookie });
    expect((await json<{ deleted: number }>(res)).deleted).toBe(2);
    expect((await listFiles(aliceCookie, doc.id)).files.map((f) => f.path)).toEqual(['main.tex']);
  });

  it('o banco recusa caminhos perigosos mesmo sem passar pela API', async () => {
    for (const bad of ['../x.tex', '/abs.tex', 'a//b.tex', '.hidden.tex', 'a\\b.tex', 'a/../b.tex']) {
      await expect(
        ctx.admin.query("INSERT INTO app.document_files (user_id, document_id, path, content, size_bytes) VALUES ($1, $2, $3, '', 0)", [
          alice.id,
          doc.id,
          bad,
        ])
      ).rejects.toThrow(/document_files_path_check/);
    }
  });
});

describe('isolamento entre usuários', () => {
  it('outro usuário não lista, lê, grava, move, exclui nem compila arquivos alheios (404)', async () => {
    const doc = await createProject(aliceCookie);
    await put(aliceCookie, doc.id, 'segredo.tex', 'segredo da alice');
    const attempts = [
      request(ctx, 'GET', `/api/documents/${doc.id}/files`, { cookie: bobCookie }),
      request(ctx, 'GET', `/api/documents/${doc.id}/files/raw?path=segredo.tex`, { cookie: bobCookie }),
      put(bobCookie, doc.id, 'invasao.tex', 'x'),
      request(ctx, 'POST', `/api/documents/${doc.id}/files/move`, { cookie: bobCookie, body: { from: 'segredo.tex', to: 'b.tex' } }),
      request(ctx, 'DELETE', `/api/documents/${doc.id}/files?path=segredo.tex`, { cookie: bobCookie }),
      request(ctx, 'POST', `/api/documents/${doc.id}/compile`, { cookie: bobCookie }),
      request(ctx, 'PATCH', `/api/documents/${doc.id}`, { cookie: bobCookie, body: { mainFile: 'segredo.tex' } }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('segredo da alice');
    }
    const { files } = await listFiles(aliceCookie, doc.id);
    expect(files.map((f) => f.path)).toEqual(['main.tex', 'segredo.tex']);
    expect(compilerCalls).toHaveLength(0);
  });

  it('sem sessão: 401', async () => {
    const doc = await createProject(aliceCookie);
    expect((await request(ctx, 'GET', `/api/documents/${doc.id}/files`)).status).toBe(401);
    expect((await request(ctx, 'POST', `/api/documents/${doc.id}/compile`)).status).toBe(401);
    expect((await request(ctx, 'GET', `/api/compile-jobs/${randomUUID()}`)).status).toBe(401);
  });

  it('RLS: o app_api não enxerga arquivos de outro usuário nem sem filtro na query', async () => {
    const doc = await createProject(aliceCookie);
    const rows = await withUser(ctx.pool, bob.id, async (client) => (await client.query('SELECT path FROM app.document_files')).rows);
    expect(rows.find((r) => r.path === 'main.tex' && doc)).toBeUndefined();
    const own = await withUser(ctx.pool, alice.id, async (client) =>
      (await client.query('SELECT path FROM app.document_files WHERE document_id = $1', [doc.id])).rows
    );
    expect(own).toHaveLength(1);
    // Inserir em nome de outro usuário também é barrado (user_id vem da sessão).
    await expect(
      withUser(ctx.pool, bob.id, (client) =>
        client.query("INSERT INTO app.document_files (document_id, path, content, size_bytes) VALUES ($1, 'x.tex', 'x', 1)", [doc.id])
      )
    ).rejects.toThrow();
  });
});

describe('compilação', () => {
  it('cria o job, acompanha com long-poll e baixa o PDF', async () => {
    nextOutcome = success();
    const doc = await createProject(aliceCookie);
    await put(aliceCookie, doc.id, 'imagens/fig.png', PNG);
    const start = await request(ctx, 'POST', `/api/documents/${doc.id}/compile`, { cookie: aliceCookie });
    expect(start.status).toBe(202);
    const { job } = await json<{ job: { id: string; status: string } }>(start);
    expect(job.status).toBe('running');

    // O compilador recebeu só os arquivos do projeto, como texto/bytes.
    expect(compilerCalls[0]!.mainFile).toBe('main.tex');
    expect(compilerCalls[0]!.files.map((f) => f.path)).toEqual(['imagens/fig.png', 'main.tex']);

    const polled = await request(ctx, 'GET', `/api/compile-jobs/${job.id}?wait=1`, { cookie: aliceCookie });
    const done = (await json<{ job: { status: string; hasPdf: boolean; pdfBytes: number } }>(polled)).job;
    expect(done).toMatchObject({ status: 'success', hasPdf: true, pdfBytes: FAKE_PDF.length });

    const pdf = await request(ctx, 'GET', `/api/compile-jobs/${job.id}/pdf`, { cookie: aliceCookie });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('o job e o PDF de um usuário são invisíveis para outro', async () => {
    nextOutcome = success();
    const doc = await createProject(aliceCookie);
    const { job } = await json<{ job: { id: string } }>(await request(ctx, 'POST', `/api/documents/${doc.id}/compile`, { cookie: aliceCookie }));
    await request(ctx, 'GET', `/api/compile-jobs/${job.id}?wait=1`, { cookie: aliceCookie });
    expect((await request(ctx, 'GET', `/api/compile-jobs/${job.id}`, { cookie: bobCookie })).status).toBe(404);
    expect((await request(ctx, 'GET', `/api/compile-jobs/${job.id}/pdf`, { cookie: bobCookie })).status).toBe(404);
    expect((await request(ctx, 'DELETE', `/api/compile-jobs/${job.id}`, { cookie: bobCookie })).status).toBe(404);
    expect((await request(ctx, 'GET', `/api/compile-jobs/nao-e-uuid`, { cookie: aliceCookie })).status).toBe(404);
  });

  it('cancelamento e substituição por uma compilação mais nova do mesmo documento', async () => {
    nextOutcome = 'hang';
    const doc = await createProject(aliceCookie);
    const first = (await json<{ job: { id: string } }>(await request(ctx, 'POST', `/api/documents/${doc.id}/compile`, { cookie: aliceCookie }))).job;
    const second = (await json<{ job: { id: string } }>(await request(ctx, 'POST', `/api/documents/${doc.id}/compile`, { cookie: aliceCookie }))).job;
    const old = await json<{ job: { status: string } }>(await request(ctx, 'GET', `/api/compile-jobs/${first.id}`, { cookie: aliceCookie }));
    expect(old.job.status).toBe('cancelled');
    const cancel = await request(ctx, 'DELETE', `/api/compile-jobs/${second.id}`, { cookie: aliceCookie });
    expect((await json<{ job: { status: string } }>(cancel)).job.status).toBe('cancelled');
  });

  it('erros do compilador chegam com os diagnósticos e sem PDF', async () => {
    nextOutcome = {
      status: 'error',
      result: {
        engine: 'pdflatex',
        durationMs: 300,
        diagnostics: [{ severity: 'error', file: 'main.tex', line: 4, message: 'Comando LaTeX não reconhecido (\\x) na linha 4.', raw: 'Undefined control sequence.', source: 'latex' }],
        log: '! Undefined control sequence.',
        output: '',
        pdfBytes: 0,
        message: null,
      },
      pdf: null,
    };
    const doc = await createProject(aliceCookie);
    const { job } = await json<{ job: { id: string } }>(await request(ctx, 'POST', `/api/documents/${doc.id}/compile`, { cookie: aliceCookie }));
    const done = (await json<{ job: { status: string; hasPdf: boolean; diagnostics: Array<{ line: number }> } }>(
      await request(ctx, 'GET', `/api/compile-jobs/${job.id}?wait=1`, { cookie: aliceCookie })
    )).job;
    expect(done).toMatchObject({ status: 'error', hasPdf: false });
    expect(done.diagnostics[0]!.line).toBe(4);
    expect((await request(ctx, 'GET', `/api/compile-jobs/${job.id}/pdf`, { cookie: aliceCookie })).status).toBe(404);
  });

  it('documento Markdown não compila', async () => {
    const md = (await json<{ document: Doc }>(await request(ctx, 'POST', '/api/documents', { cookie: aliceCookie, body: {} }))).document;
    expect((await request(ctx, 'POST', `/api/documents/${md.id}/compile`, { cookie: aliceCookie })).status).toBe(400);
  });

  it('limita compilações simultâneas e por minuto', async () => {
    nextOutcome = 'hang';
    const carol = await createUser(ctx.admin);
    const cookie = await login(ctx, carol);
    const docs = await Promise.all([1, 2, 3].map(() => createProject(cookie)));
    expect((await request(ctx, 'POST', `/api/documents/${docs[0]!.id}/compile`, { cookie })).status).toBe(202);
    expect((await request(ctx, 'POST', `/api/documents/${docs[1]!.id}/compile`, { cookie })).status).toBe(202);
    const third = await request(ctx, 'POST', `/api/documents/${docs[2]!.id}/compile`, { cookie });
    expect(third.status).toBe(429);
    expect((await json<{ error: string }>(third)).error).toBe('compile_in_progress');
    // Recompilar o mesmo documento substitui (não conta como simultânea)...
    for (let i = 0; i < 4; i++) await request(ctx, 'POST', `/api/documents/${docs[0]!.id}/compile`, { cookie });
    // ...mas conta no limite por minuto (6 nos testes).
    const limited = await request(ctx, 'POST', `/api/documents/${docs[0]!.id}/compile`, { cookie });
    expect(limited.status).toBe(429);
    expect((await json<{ error: string }>(limited)).error).toBe('too_many_compiles');
  });

  it('sem compilador configurado: 503 (depois de conferir o dono)', async () => {
    const plain = await makeTestApp();
    try {
      const doc = await createProject(aliceCookie);
      const res = await plain.app.request(`${ORIGIN}/api/documents/${doc.id}/compile`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: aliceCookie, 'x-forwarded-for': nextIp() },
      });
      expect(res.status).toBe(503);
      const other = await plain.app.request(`${ORIGIN}/api/documents/${doc.id}/compile`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: bobCookie, 'x-forwarded-for': nextIp() },
      });
      expect(other.status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

describe('regras de caminho compartilhadas', () => {
  it('paths.ts é idêntico na API, no compilador e no frontend', async () => {
    const root = path.resolve(import.meta.dirname, '..', '..');
    const [api, compiler, frontend] = await Promise.all(
      ['api/src/latex/paths.ts', 'latex-compiler/src/paths.ts', 'mark-editor/src/latex/paths.ts'].map((p) =>
        readFile(path.join(root, p), 'utf8').then((s) => s.replace(/\r\n/g, '\n'))
      )
    );
    expect(compiler).toBe(api);
    expect(frontend).toBe(api);
  });
});
