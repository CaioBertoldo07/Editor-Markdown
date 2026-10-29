import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callCompiler, CompileJobs, DEFAULT_JOB_OPTIONS } from '../src/latex/compileJobs.js';
import { createUser, login, makeTestApp, nextIp, ORIGIN, request, type TestContext } from './helpers.js';

const TOKEN = 'token-do-compilador-de-teste-0123456789';

describe('cliente do compilador (servidor falso)', () => {
  let server: Server;
  let url: string;
  let mode: 'ok' | 'busy' | 'invalid' | 'slow' | 'crash' = 'ok';
  let lastAuth = '';
  let lastManifest: { mainFile: string; files: Array<{ path: string; field: string }> } | null = null;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      lastAuth = req.headers.authorization ?? '';
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type']! } }).formData();
      lastManifest = JSON.parse(String(form.get('manifest')));
      if (mode === 'busy') return res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"compiler_busy"}');
      if (mode === 'invalid') return res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_project","issue":"arquivo repetido"}');
      if (mode === 'crash') return res.writeHead(500).end();
      if (mode === 'slow') return void setTimeout(() => res.end(), 5_000);
      const out = new FormData();
      out.set('result', JSON.stringify({ status: 'success', engine: 'pdflatex', durationMs: 10, diagnostics: [], log: 'ok', output: '', pdfBytes: 9 }));
      out.set('pdf', new Blob([Buffer.from('%PDF-1.7\n')], { type: 'application/pdf' }));
      const response = new Response(out);
      res.writeHead(200, { 'content-type': response.headers.get('content-type')! });
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const files = [
    { path: 'main.tex', content: '\\documentclass{article}', data: null },
    { path: 'img/a.png', content: null, data: Buffer.from([0x89, 0x50]) },
  ];
  const call = (timeoutMs = 2_000, signal = new AbortController().signal) =>
    callCompiler({ url, token: TOKEN, timeoutMs }, { mainFile: 'main.tex', files }, signal);

  it('envia token, manifesto e arquivos; lê resultado e PDF', async () => {
    mode = 'ok';
    const r = await call();
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
    expect(lastManifest).toEqual({ mainFile: 'main.tex', files: [{ path: 'main.tex', field: 'f0' }, { path: 'img/a.png', field: 'f1' }] });
    expect(r.status).toBe('success');
    expect(r.pdf!.toString()).toBe('%PDF-1.7\n');
  });

  it('traduz ocupado, projeto inválido, erro e tempo esgotado', async () => {
    mode = 'busy';
    expect((await call()).status).toBe('busy');
    mode = 'invalid';
    const invalid = await call();
    expect(invalid.status).toBe('error');
    expect(invalid.result.message).toContain('arquivo repetido');
    mode = 'crash';
    expect((await call()).status).toBe('unavailable');
    mode = 'slow';
    expect((await call(500)).status).toBe('timeout');
  });

  it('cancelamento e serviço fora do ar', async () => {
    mode = 'slow';
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    expect((await call(5_000, controller.signal)).status).toBe('cancelled');
    const down = await callCompiler({ url: 'http://127.0.0.1:1', token: TOKEN, timeoutMs: 2_000 }, { mainFile: 'main.tex', files }, new AbortController().signal);
    expect(down.status).toBe('unavailable');
  });
});

/**
 * Fluxo completo com o compilador REAL (contêiner latex-compiler):
 *   docker run -d -p 18080:8080 -e COMPILER_TOKEN=... latex-compiler
 *   COMPILER_TEST_URL=http://127.0.0.1:18080 COMPILER_TEST_TOKEN=... npm test
 */
const realUrl = process.env.COMPILER_TEST_URL;
const realToken = process.env.COMPILER_TEST_TOKEN ?? '';

function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 200)]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
}

describe.skipIf(!realUrl)('API + compilador real', () => {
  let ctx: TestContext;
  let cookie: string;

  beforeAll(async () => {
    ctx = await makeTestApp({
      compileJobs: new CompileJobs((req, signal) => callCompiler({ url: realUrl!, token: realToken, timeoutMs: 120_000 }, req, signal), DEFAULT_JOB_OPTIONS),
    });
    const user = await createUser(ctx.admin);
    cookie = await login(ctx, user);
  });
  afterAll(() => ctx.close());

  const put = (docId: string, path: string, body: Uint8Array | string) =>
    ctx.app.request(`${ORIGIN}/api/documents/${docId}/files/content?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { origin: ORIGIN, cookie, 'x-forwarded-for': nextIp() },
      body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
    });

  async function compile(docId: string) {
    const start = await request(ctx, 'POST', `/api/documents/${docId}/compile`, { cookie });
    expect(start.status).toBe(202);
    const { job } = (await start.json()) as { job: { id: string } };
    for (;;) {
      const res = await request(ctx, 'GET', `/api/compile-jobs/${job.id}?wait=1`, { cookie });
      const body = (await res.json()) as { job: { id: string; status: string; hasPdf: boolean; diagnostics: Array<{ file: string; line: number; message: string; severity: string }> } };
      if (body.job.status !== 'running') return body.job;
    }
  }

  it('projeto com capítulos, imagem e bibliografia vira PDF real', async () => {
    const main = String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage[brazil]{babel}
\usepackage{graphicx,amsmath}
\begin{document}
\section{Introdução}\label{sec:intro}
\input{capitulos/intro}
\begin{figure}[h]\centering\includegraphics[width=2cm]{imagens/arquitetura.png}\caption{Arquitetura}\label{fig:a}\end{figure}
Ver Figura~\ref{fig:a} e \cite{knuth}.
\bibliographystyle{plain}
\bibliography{referencias}
\end{document}
`;
    const res = await request(ctx, 'POST', '/api/documents', { cookie, body: { kind: 'latex', title: 'Real', content: main } });
    const doc = ((await res.json()) as { document: { id: string } }).document;
    expect((await put(doc.id, 'capitulos/intro.tex', 'Texto do capítulo com $E = mc^2$.\n')).status).toBe(201);
    expect((await put(doc.id, 'imagens/arquitetura.png', png(30, 20))).status).toBe(201);
    expect((await put(doc.id, 'referencias.bib', '@book{knuth, author={Donald Knuth}, title={The TeXbook}, year={1984}, publisher={AW}}\n')).status).toBe(201);

    const job = await compile(doc.id);
    expect(job.status, JSON.stringify(job.diagnostics)).toBe('success');
    const pdf = await request(ctx, 'GET', `/api/compile-jobs/${job.id}/pdf`, { cookie });
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(5_000);
  });

  it('erro real aponta o arquivo e a linha', async () => {
    const res = await request(ctx, 'POST', '/api/documents', {
      cookie,
      body: { kind: 'latex', content: '\\documentclass{article}\n\\begin{document}\nok\n\\input{cap}\n\\end{document}\n' },
    });
    const doc = ((await res.json()) as { document: { id: string } }).document;
    await put(doc.id, 'cap.tex', 'linha 1\n\\naoexiste\n');
    const job = await compile(doc.id);
    expect(job.status).toBe('error');
    expect(job.hasPdf).toBe(false);
    expect(job.diagnostics[0]).toMatchObject({ severity: 'error', file: 'cap.tex', line: 2 });
    expect(job.diagnostics[0]!.message).toContain('não reconhecido');
  });
});
