import { createHash, timingSafeEqual } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { compileProject, InvalidProjectError, type CompileOutcome, type ProjectFile } from './compile.js';
import type { Config } from './config.js';
import { ENGINES, type Engine } from './engine.js';
import type { SelfTest } from './sandbox.js';
import { BusyError, SlotPool } from './slots.js';

/**
 * HTTP do compilador. Só a API chama (rede privada do Railway, sem domínio
 * público) e sempre com `Authorization: Bearer <COMPILER_TOKEN>`.
 *
 * POST /compile  multipart/form-data
 *   manifest  JSON { mainFile, engine?, files: [{ path, field }] }
 *   <field>   conteúdo de cada arquivo
 * Resposta: multipart/form-data com `result` (JSON) e, se compilou, `pdf`.
 */

type Deps = {
  config: Config;
  pool: SlotPool;
  sandbox: () => SelfTest | null;
  /** Injetável nos testes. */
  compile?: typeof compileProject;
};

const digest = (value: string) => createHash('sha256').update(value).digest();

type Manifest = { mainFile: string; engine?: Engine; files: Array<{ path: string; field: string }> };

function parseManifest(raw: unknown, maxFiles: number): Manifest {
  if (typeof raw !== 'string') throw new InvalidProjectError('manifest ausente');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new InvalidProjectError('manifest inválido');
  }
  const m = data as Partial<Manifest>;
  if (!m || typeof m.mainFile !== 'string' || !Array.isArray(m.files)) throw new InvalidProjectError('manifest inválido');
  if (m.engine !== undefined && !(ENGINES as readonly string[]).includes(m.engine)) throw new InvalidProjectError('motor inválido');
  if (m.files.length > maxFiles) throw new InvalidProjectError(`mais de ${maxFiles} arquivos`);
  for (const f of m.files) {
    if (!f || typeof f.path !== 'string' || typeof f.field !== 'string' || !/^f\d{1,5}$/.test(f.field)) {
      throw new InvalidProjectError('manifest inválido');
    }
  }
  return m as Manifest;
}

export function createApp({ config, pool, sandbox, compile = compileProject }: Deps) {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const expected = digest(config.token);

  app.get('/health', (c) => {
    const test = sandbox();
    const ok = !!test?.ok;
    return c.json(
      {
        status: ok ? 'ok' : test ? 'sandbox_unavailable' : 'starting',
        sandbox: test ? test.checks.map(({ name, ok }) => ({ name, ok })) : null,
        queue: pool.stats,
      },
      ok ? 200 : 503
    );
  });

  app.use('/compile', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !timingSafeEqual(digest(token), expected)) return c.json({ error: 'unauthorized' }, 401);
    return next();
  });

  app.post(
    '/compile',
    bodyLimit({ maxSize: config.limits.requestBytes, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
    async (c) => {
      const test = sandbox();
      if (!test?.ok) return c.json({ error: 'sandbox_unavailable' }, 503);

      // Cancelamento: a API aborta a requisição (usuário cancelou, nova versão
      // do documento, tempo esgotado) => a conexão fecha => matamos o TeX.
      const controller = new AbortController();
      const outgoing = c.env?.outgoing;
      const onClose = () => {
        if (outgoing && !outgoing.writableFinished) controller.abort();
      };
      outgoing?.on('close', onClose);
      c.req.raw.signal?.addEventListener('abort', () => controller.abort(), { once: true });

      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        return c.json({ error: 'invalid_body' }, 400);
      }

      let manifest: Manifest;
      const files: ProjectFile[] = [];
      try {
        manifest = parseManifest(form.get('manifest'), config.limits.maxFiles);
        for (const entry of manifest.files) {
          const value = form.get(entry.field);
          if (!(value instanceof Blob)) throw new InvalidProjectError(`conteúdo ausente: ${entry.path}`);
          files.push({ path: entry.path, data: new Uint8Array(await value.arrayBuffer()) });
        }
      } catch (err) {
        if (err instanceof InvalidProjectError) return c.json({ error: 'invalid_project', issue: err.issue }, 400);
        throw err;
      }

      let slot: number;
      try {
        slot = await pool.acquire(controller.signal);
      } catch (err) {
        if (err instanceof BusyError) return c.json({ error: 'compiler_busy', reason: err.reason }, 503);
        return c.json({ error: 'cancelled' }, 499 as never);
      }

      let outcome: CompileOutcome;
      try {
        outcome = await compile(config, slot, { mainFile: manifest.mainFile, files, engine: manifest.engine }, controller.signal);
      } catch (err) {
        if (err instanceof InvalidProjectError) return c.json({ error: 'invalid_project', issue: err.issue }, 400);
        throw err;
      } finally {
        pool.release(slot);
        outgoing?.off('close', onClose);
      }

      const { pdf, ...result } = outcome;
      const body = new FormData();
      body.set('result', JSON.stringify({ ...result, pdfBytes: pdf?.length ?? 0 }));
      if (pdf) body.set('pdf', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'output.pdf');
      return new Response(body, { status: 200, headers: { 'cache-control': 'no-store' } });
    }
  );

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error('[compiler] erro inesperado:', err.name, err.message);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}
