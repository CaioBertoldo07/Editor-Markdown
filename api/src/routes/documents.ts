import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type pg from 'pg';
import type { PoolClient } from 'pg';
import type { AuthVariables } from '../auth/session.js';
import { withUser } from '../db/pool.js';
import { HTTPException } from 'hono/http-exception';
import { BadRequestError, NotFoundError, parseBody } from '../http/errors.js';
import { assertUserQuota, validPath } from '../latex/files.js';
import { DOCUMENT_COLUMNS, toDocument, type DocumentRow } from '../http/mappers.js';
import {
  LIMITS,
  createDocumentBody,
  idParam,
  importDocumentsBody,
  updateDocumentBody,
} from '../http/schemas.js';

/** Confere que a pasta existe E pertence ao usuário; senão, 404. */
export async function assertOwnFolder(client: PoolClient, userId: string, folderId: string | null | undefined) {
  if (!folderId) return;
  const { rowCount } = await client.query('SELECT 1 FROM app.folders WHERE id = $1 AND user_id = $2', [
    folderId,
    userId,
  ]);
  if (rowCount !== 1) throw new NotFoundError('folder_not_found');
}

const parseId = (value: string): string => {
  const parsed = idParam.safeParse(value);
  if (!parsed.success) throw new NotFoundError('document_not_found');
  return parsed.data;
};

const limit = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  });

export function documentsRoutes(pool: pg.Pool) {
  const router = new Hono<{ Variables: AuthVariables }>();

  router.get('/', async (c) => {
    const userId = c.get('userId');
    const rows = await withUser(pool, userId, async (client) => {
      const result = await client.query<DocumentRow>(
        `SELECT ${DOCUMENT_COLUMNS} FROM app.documents WHERE user_id = $1 ORDER BY updated_at DESC, id`,
        [userId]
      );
      return result.rows;
    });
    return c.json({ documents: rows.map(toDocument) });
  });

  router.post('/', limit(LIMITS.bodyMaxBytes), async (c) => {
    const userId = c.get('userId');
    const body = await parseBody(c, createDocumentBody);

    if (body.kind === 'latex') {
      const mainFile = validPath(body.mainFile ?? 'main.tex');
      if (!mainFile.toLowerCase().endsWith('.tex')) throw new BadRequestError(['mainFile: precisa ser um arquivo .tex']);
      const source = body.content ?? '';
      const size = Buffer.byteLength(source, 'utf8');
      if (size > LIMITS.latexTextFileMaxBytes) throw new HTTPException(413, { message: 'payload_too_large' });
      const row = await withUser(pool, userId, async (client) => {
        await assertOwnFolder(client, userId, body.folderId);
        await assertUserQuota(client, userId, size);
        // Projeto LaTeX: o conteúdo fica nos arquivos; `content` do documento fica vazio.
        const result = await client.query<DocumentRow>(
          `INSERT INTO app.documents (title, content, folder_id, kind, main_file)
           VALUES (COALESCE($1, 'Novo Projeto LaTeX'), '', $2, 'latex', $3)
           RETURNING ${DOCUMENT_COLUMNS}`,
          [body.title ?? null, body.folderId ?? null, mainFile]
        );
        const doc = result.rows[0]!;
        await client.query(
          'INSERT INTO app.document_files (document_id, path, content, size_bytes) VALUES ($1, $2, $3, $4)',
          [doc.id, mainFile, source, size]
        );
        return doc;
      });
      return c.json({ document: toDocument(row) }, 201);
    }

    const row = await withUser(pool, userId, async (client) => {
      await assertOwnFolder(client, userId, body.folderId);
      const result = await client.query<DocumentRow>(
        `INSERT INTO app.documents (title, content, folder_id)
         VALUES (COALESCE($1, 'Novo Documento'), COALESCE($2, ''), $3)
         RETURNING ${DOCUMENT_COLUMNS}`,
        [body.title ?? null, body.content ?? null, body.folderId ?? null]
      );
      return result.rows[0]!;
    });
    return c.json({ document: toDocument(row) }, 201);
  });

  /** Vários documentos de uma vez (upload de .md e migração do localStorage). Tudo ou nada. */
  router.post('/import', limit(LIMITS.importBodyMaxBytes), async (c) => {
    const userId = c.get('userId');
    const body = await parseBody(c, importDocumentsBody);
    const rows = await withUser(pool, userId, async (client) => {
      await assertOwnFolder(client, userId, body.folderId);
      const created: DocumentRow[] = [];
      for (const doc of body.documents) {
        const result = await client.query<DocumentRow>(
          `INSERT INTO app.documents (title, content, folder_id, updated_at)
           VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
           RETURNING ${DOCUMENT_COLUMNS}`,
          [doc.title, doc.content, body.folderId ?? null, doc.updatedAt ?? null]
        );
        created.push(result.rows[0]!);
      }
      return created;
    });
    return c.json({ documents: rows.map(toDocument) }, 201);
  });

  router.patch('/:id', limit(LIMITS.bodyMaxBytes), async (c) => {
    const userId = c.get('userId');
    const id = parseId(c.req.param('id'));
    const body = await parseBody(c, updateDocumentBody);

    const row = await withUser(pool, userId, async (client) => {
      if (body.folderId !== undefined) await assertOwnFolder(client, userId, body.folderId);

      // Conteúdo e arquivo principal dependem do tipo, que nunca muda.
      if (body.content !== undefined || body.mainFile !== undefined) {
        const current = await client.query<{ kind: string }>(
          'SELECT kind FROM app.documents WHERE id = $1 AND user_id = $2',
          [id, userId]
        );
        const kind = current.rows[0]?.kind;
        if (!kind) throw new NotFoundError('document_not_found');
        if (kind === 'latex' && body.content !== undefined) {
          throw new BadRequestError(['content: o conteúdo de um projeto LaTeX fica nos arquivos do projeto']);
        }
        if (body.mainFile !== undefined) {
          if (kind !== 'latex') throw new BadRequestError(['mainFile: só existe em documentos LaTeX']);
          const mainFile = validPath(body.mainFile);
          if (!mainFile.toLowerCase().endsWith('.tex')) throw new BadRequestError(['mainFile: precisa ser um arquivo .tex']);
          const exists = await client.query('SELECT 1 FROM app.document_files WHERE document_id = $1 AND path = $2', [
            id,
            mainFile,
          ]);
          if (exists.rowCount !== 1) throw new BadRequestError(['mainFile: o arquivo não existe no projeto']);
          body.mainFile = mainFile;
        }
      }

      // Nomes de coluna fixos (nunca vindos do cliente); valores sempre parametrizados.
      const sets: string[] = [];
      const values: unknown[] = [];
      const set = (column: 'title' | 'content' | 'folder_id' | 'main_file', value: unknown) => {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      };
      if (body.title !== undefined) set('title', body.title);
      if (body.content !== undefined) set('content', body.content);
      if (body.folderId !== undefined) set('folder_id', body.folderId);
      if (body.mainFile !== undefined) set('main_file', body.mainFile);
      values.push(id, userId);

      const result = await client.query<DocumentRow>(
        `UPDATE app.documents SET ${sets.join(', ')}
         WHERE id = $${values.length - 1} AND user_id = $${values.length}
         RETURNING ${DOCUMENT_COLUMNS}`,
        values
      );
      if (result.rowCount !== 1) throw new NotFoundError('document_not_found');
      return result.rows[0]!;
    });
    return c.json({ document: toDocument(row) });
  });

  router.delete('/:id', async (c) => {
    const userId = c.get('userId');
    const id = parseId(c.req.param('id'));
    await withUser(pool, userId, async (client) => {
      const result = await client.query('DELETE FROM app.documents WHERE id = $1 AND user_id = $2', [id, userId]);
      if (result.rowCount !== 1) throw new NotFoundError('document_not_found');
    });
    return c.body(null, 204);
  });

  return router;
}
