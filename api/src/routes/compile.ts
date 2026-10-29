import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type pg from 'pg';
import type { AuthVariables } from '../auth/session.js';
import { withUser } from '../db/pool.js';
import { NotFoundError, parseBody } from '../http/errors.js';
import { compileBody, idParam } from '../http/schemas.js';
import { TooManyCompilesError, type CompileJobs } from '../latex/compileJobs.js';
import { loadProjectFiles, lockLatexDocument } from '../latex/files.js';

/**
 * Compilação LaTeX (assíncrona):
 *
 *   POST   /api/documents/:id/compile        { engine? }  -> 202 { job }
 *   GET    /api/compile-jobs/:jobId?wait=1                 -> { job } (long-poll até 20 s)
 *   GET    /api/compile-jobs/:jobId/pdf                    -> application/pdf
 *   DELETE /api/compile-jobs/:jobId                        -> cancela
 *
 * O compilador nunca vê o banco nem a sessão: a API lê os arquivos do
 * projeto (com RLS, como o usuário) e envia só eles.
 */

const LONG_POLL_MS = 20_000;

const parseId = (value: string | undefined, code: string): string => {
  const parsed = idParam.safeParse(value);
  if (!parsed.success) throw new NotFoundError(code);
  return parsed.data;
};

export function compileStartRoute(pool: pg.Pool, jobs: CompileJobs | null) {
  const router = new Hono<{ Variables: AuthVariables }>();
  router.post('/', bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }), async (c) => {
    const userId = c.get('userId');
    const id = parseId(c.req.param('id'), 'document_not_found');
    const hasBody = (c.req.header('content-length') ?? '0') !== '0' || c.req.header('content-type')?.includes('json');
    const body = hasBody ? await parseBody(c, compileBody) : {};

    // Confere dono e tipo ANTES de olhar a configuração: documento de outra
    // pessoa responde 404 mesmo com o compilador desligado.
    const project = await withUser(pool, userId, async (client) => {
      const doc = await lockLatexDocument(client, userId, id);
      return { mainFile: doc.main_file, files: await loadProjectFiles(client, id) };
    });
    if (!jobs) return c.json({ error: 'compiler_not_configured' }, 503);

    try {
      const job = jobs.start(userId, id, { ...project, engine: body.engine });
      return c.json({ job: jobs.view(job) }, 202);
    } catch (err) {
      if (err instanceof TooManyCompilesError) {
        return c.json({ error: err.reason === 'rate' ? 'too_many_compiles' : 'compile_in_progress' }, 429);
      }
      throw err;
    }
  });
  return router;
}

export function compileJobsRoutes(jobs: CompileJobs | null) {
  const router = new Hono<{ Variables: AuthVariables }>();

  const find = (userId: string, rawId: string | undefined) => {
    const jobId = parseId(rawId, 'job_not_found');
    const job = jobs?.get(userId, jobId);
    if (!job) throw new NotFoundError('job_not_found');
    return job;
  };

  router.get('/:jobId', async (c) => {
    const job = find(c.get('userId'), c.req.param('jobId'));
    if (c.req.query('wait') === '1') await jobs!.wait(job, LONG_POLL_MS, c.req.raw.signal);
    return c.json({ job: jobs!.view(job) });
  });

  router.get('/:jobId/pdf', (c) => {
    const job = find(c.get('userId'), c.req.param('jobId'));
    if (!job.pdf) throw new NotFoundError('pdf_not_found');
    return c.body(new Uint8Array(job.pdf), 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="documento.pdf"',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
  });

  router.delete('/:jobId', (c) => {
    const job = find(c.get('userId'), c.req.param('jobId'));
    jobs!.cancel(job);
    return c.json({ job: jobs!.view(job) });
  });

  return router;
}
