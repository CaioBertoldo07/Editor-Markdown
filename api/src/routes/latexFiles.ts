import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type pg from 'pg';
import type { PoolClient } from 'pg';
import type { AuthVariables } from '../auth/session.js';
import { withUser } from '../db/pool.js';
import { BadRequestError, NotFoundError } from '../http/errors.js';
import { idParam, LIMITS, moveFileBody } from '../http/schemas.js';
import {
  assertProjectQuota,
  decodeUpload,
  lockLatexDocument,
  safeContentType,
  touchDocument,
  validPath,
} from '../latex/files.js';
import { fileKindOf } from '../latex/paths.js';

/**
 * Arquivos de um projeto LaTeX: /api/documents/:id/files
 *
 *   GET    /                  lista (com o conteúdo dos arquivos de texto)
 *   GET    /raw?path=         um arquivo, como bytes
 *   PUT    /content?path=     cria ou substitui (corpo = bytes do arquivo)
 *   POST   /move              { from, to, folder? } renomeia/move arquivo ou pasta
 *   DELETE /?path= | ?folder= remove arquivo ou pasta
 *
 * Projeto de outro usuário ou inexistente => 404, como nos documentos.
 */

type FileRow = { path: string; content: string | null; size_bytes: number; updated_at: Date; is_text: boolean };

const parseId = (value: string | undefined): string => {
  const parsed = idParam.safeParse(value);
  if (!parsed.success) throw new NotFoundError('document_not_found');
  return parsed.data;
};

const requirePath = (value: string | undefined): string => {
  if (!value) throw new BadRequestError(['path: obrigatório']);
  return validPath(value);
};

/** Pasta: mesmas regras de um caminho, mas sem extensão obrigatória. */
const validFolder = (value: string | undefined): string => {
  if (!value) throw new BadRequestError(['folder: obrigatório']);
  const folder = value.replace(/\/+$/, '');
  // Valida como se fosse um arquivo dentro da pasta.
  validPath(`${folder}/x.tex`);
  return folder.normalize('NFC');
};

const toFile = (row: FileRow) => ({
  path: row.path,
  kind: row.is_text ? ('text' as const) : ('binary' as const),
  size: row.size_bytes,
  updatedAt: row.updated_at.toISOString(),
  ...(row.is_text ? { content: row.content ?? '' } : {}),
});

/**
 * Um caminho não pode coincidir com uma pasta existente (nem o contrário):
 * "fig.png" e "fig.png/a.tex" não cabem juntos no disco do compilador.
 * Também recusa o mesmo nome com outra caixa ("Main.tex" x "main.tex").
 */
async function assertNoConflict(client: PoolClient, documentId: string, path: string, ignore: string[] = []) {
  const segments = path.split('/');
  const parents = segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join('/').toLowerCase());
  const { rows } = await client.query<{ path: string }>(
    `SELECT path FROM app.document_files
      WHERE document_id = $1
        AND NOT (lower(path) = ANY($4::text[]))
        AND (
          (lower(path) = lower($2) AND path <> $2)
          OR lower(path) = ANY($3::text[])
          OR left(lower(path), length($2) + 1) = lower($2) || '/'
        )
      LIMIT 1`,
    [documentId, path, parents, ignore.map((p) => p.toLowerCase())]
  );
  if (rows.length > 0) throw new BadRequestError([`path: conflita com "${rows[0]!.path}"`]);
}

export function latexFilesRoutes(pool: pg.Pool) {
  const router = new Hono<{ Variables: AuthVariables }>();

  router.get('/', async (c) => {
    const userId = c.get('userId');
    const id = parseId(c.req.param('id'));
    const result = await withUser(pool, userId, async (client) => {
      const { rows: docs } = await client.query<{ kind: string; main_file: string | null; updated_at: Date }>(
        'SELECT kind, main_file, updated_at FROM app.documents WHERE id = $1 AND user_id = $2',
        [id, userId]
      );
      const doc = docs[0];
      if (!doc) throw new NotFoundError('document_not_found');
      if (doc.kind !== 'latex') throw new BadRequestError(['document: não é um projeto LaTeX']);
      const { rows } = await client.query<FileRow>(
        `SELECT path, content, size_bytes, updated_at, content IS NOT NULL AS is_text
           FROM app.document_files WHERE document_id = $1 ORDER BY path`,
        [id]
      );
      return { mainFile: doc.main_file, updatedAt: doc.updated_at.toISOString(), files: rows.map(toFile) };
    });
    return c.json(result);
  });

  router.get('/raw', async (c) => {
    const userId = c.get('userId');
    const id = parseId(c.req.param('id'));
    const path = requirePath(c.req.query('path'));
    const file = await withUser(pool, userId, async (client) => {
      const { rows } = await client.query<{ content: string | null; data: Buffer | null }>(
        `SELECT f.content, f.data FROM app.document_files f
           JOIN app.documents d ON d.id = f.document_id
          WHERE f.document_id = $1 AND f.path = $2 AND d.user_id = $3`,
        [id, path, userId]
      );
      return rows[0];
    });
    if (!file) throw new NotFoundError('file_not_found');
    const body = file.data ?? Buffer.from(file.content ?? '', 'utf8');
    const name = encodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
    return c.body(new Uint8Array(body), 200, {
      'Content-Type': safeContentType(path),
      // Nunca é exibido como página do app: sem scripts, sem estilos, sem sniffing.
      'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
  });

  router.put(
    '/content',
    bodyLimit({ maxSize: LIMITS.latexBinaryFileMaxBytes + 64 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
    async (c) => {
      const userId = c.get('userId');
      const id = parseId(c.req.param('id'));
      const path = requirePath(c.req.query('path'));
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const upload = decodeUpload(path, bytes);

      const result = await withUser(pool, userId, async (client) => {
        await lockLatexDocument(client, userId, id);
        await assertNoConflict(client, id, path);
        await assertProjectQuota(client, userId, id, bytes.length, path);
        const { rows } = await client.query<FileRow & { created: boolean }>(
          `INSERT INTO app.document_files (document_id, path, content, data, size_bytes)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (document_id, lower(path)) DO UPDATE
             SET content = EXCLUDED.content, data = EXCLUDED.data, size_bytes = EXCLUDED.size_bytes
           RETURNING path, content, size_bytes, updated_at, content IS NOT NULL AS is_text, (xmax = 0) AS created`,
          [id, path, upload.content, upload.data, bytes.length]
        );
        const updatedAt = await touchDocument(client, id);
        return { row: rows[0]!, updatedAt };
      });
      const row = result.row;
      const file = { path: row.path, kind: row.is_text ? 'text' : 'binary', size: row.size_bytes, updatedAt: row.updated_at.toISOString() };
      return c.json({ file, documentUpdatedAt: result.updatedAt }, row.created ? 201 : 200);
    }
  );

  router.post('/move', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }), async (c) => {
    const userId = c.get('userId');
    const id = parseId(c.req.param('id'));
    const raw = (await c.req.json().catch(() => null)) as { folder?: unknown } | null;
    const isFolder = raw?.folder === true;
    if (raw && 'folder' in raw) delete raw.folder;
    const body = moveFileBody.safeParse(raw);
    if (!body.success) throw new BadRequestError(body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`));

    const result = await withUser(pool, userId, async (client) => {
      const doc = await lockLatexDocument(client, userId, id);
      let mainFile = doc.main_file;

      if (!isFolder) {
        const from = requirePath(body.data.from);
        const to = requirePath(body.data.to);
        if (fileKindOf(from) !== fileKindOf(to)) throw new BadRequestError(['to: não é possível trocar arquivo de texto por binário']);
        if (from === mainFile && !to.toLowerCase().endsWith('.tex')) throw new BadRequestError(['to: o arquivo principal precisa ser .tex']);
        await assertNoConflict(client, id, to, [from]);
        const exists = await client.query('SELECT 1 FROM app.document_files WHERE document_id = $1 AND lower(path) = lower($2) AND path <> $3', [id, to, from]);
        if (exists.rowCount) throw new BadRequestError(['to: já existe um arquivo com esse nome']);
        const moved = await client.query('UPDATE app.document_files SET path = $3 WHERE document_id = $1 AND path = $2', [id, from, to]);
        if (moved.rowCount !== 1) throw new NotFoundError('file_not_found');
        if (from === mainFile) mainFile = to;
      } else {
        const from = validFolder(body.data.from);
        const to = validFolder(body.data.to);
        if (to === from || to.startsWith(`${from}/`)) throw new BadRequestError(['to: não é possível mover a pasta para dentro dela mesma']);
        const { rows } = await client.query<{ path: string }>(
          "SELECT path FROM app.document_files WHERE document_id = $1 AND left(path, length($2) + 1) = $2 || '/'",
          [id, from]
        );
        if (rows.length === 0) throw new NotFoundError('file_not_found');
        const moving = rows.map((r) => r.path);
        for (const path of moving) {
          const target = validPath(`${to}${path.slice(from.length)}`);
          await assertNoConflict(client, id, target, moving);
          await client.query('UPDATE app.document_files SET path = $3 WHERE document_id = $1 AND path = $2', [id, path, target]);
          if (path === mainFile) mainFile = target;
        }
      }

      if (mainFile !== doc.main_file) {
        await client.query('UPDATE app.documents SET main_file = $2 WHERE id = $1', [id, mainFile]);
      }
      const updatedAt = await touchDocument(client, id);
      return { mainFile, updatedAt };
    });
    return c.json({ mainFile: result.mainFile, documentUpdatedAt: result.updatedAt });
  });

  router.delete('/', async (c) => {
    const userId = c.get('userId');
    const id = parseId(c.req.param('id'));
    const folderParam = c.req.query('folder');
    const result = await withUser(pool, userId, async (client) => {
      const doc = await lockLatexDocument(client, userId, id);
      let deleted: number;
      if (folderParam !== undefined) {
        const folder = validFolder(folderParam);
        if (doc.main_file.startsWith(`${folder}/`)) throw new BadRequestError(['folder: contém o arquivo principal do projeto']);
        const r = await client.query("DELETE FROM app.document_files WHERE document_id = $1 AND left(path, length($2) + 1) = $2 || '/'", [
          id,
          folder,
        ]);
        deleted = r.rowCount ?? 0;
      } else {
        const path = requirePath(c.req.query('path'));
        if (path === doc.main_file) throw new BadRequestError(['path: o arquivo principal não pode ser excluído']);
        const r = await client.query('DELETE FROM app.document_files WHERE document_id = $1 AND path = $2', [id, path]);
        deleted = r.rowCount ?? 0;
      }
      if (deleted === 0) throw new NotFoundError('file_not_found');
      return { deleted, updatedAt: await touchDocument(client, id) };
    });
    return c.json({ deleted: result.deleted, documentUpdatedAt: result.updatedAt });
  });

  return router;
}
