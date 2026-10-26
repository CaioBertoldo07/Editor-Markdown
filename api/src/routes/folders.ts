import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type pg from 'pg';
import type { AuthVariables } from '../auth/session.js';
import { withUser } from '../db/pool.js';
import { NotFoundError, parseBody } from '../http/errors.js';
import { FOLDER_COLUMNS, toFolder, type FolderRow } from '../http/mappers.js';
import { createFolderBody, idParam, renameFolderBody } from '../http/schemas.js';

const parseId = (value: string): string => {
  const parsed = idParam.safeParse(value);
  if (!parsed.success) throw new NotFoundError('folder_not_found');
  return parsed.data;
};

const smallBody = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) });

export function foldersRoutes(pool: pg.Pool) {
  const router = new Hono<{ Variables: AuthVariables }>();

  router.get('/', async (c) => {
    const userId = c.get('userId');
    const rows = await withUser(pool, userId, async (client) => {
      const result = await client.query<FolderRow>(
        `SELECT ${FOLDER_COLUMNS} FROM app.folders WHERE user_id = $1 ORDER BY created_at ASC, id`,
        [userId]
      );
      return result.rows;
    });
    return c.json({ folders: rows.map(toFolder) });
  });

  router.post('/', smallBody, async (c) => {
    const userId = c.get('userId');
    const body = await parseBody(c, createFolderBody);
    const row = await withUser(pool, userId, async (client) => {
      const result = await client.query<FolderRow>(
        `INSERT INTO app.folders (name, created_at)
         VALUES ($1, COALESCE($2::timestamptz, now()))
         RETURNING ${FOLDER_COLUMNS}`,
        [body.name ?? 'Nova Pasta', body.createdAt ?? null]
      );
      return result.rows[0]!;
    });
    return c.json({ folder: toFolder(row) }, 201);
  });

  router.patch('/:id', smallBody, async (c) => {
    const userId = c.get('userId');
    const id = parseId(c.req.param('id'));
    const body = await parseBody(c, renameFolderBody);
    const row = await withUser(pool, userId, async (client) => {
      const result = await client.query<FolderRow>(
        `UPDATE app.folders SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING ${FOLDER_COLUMNS}`,
        [body.name, id, userId]
      );
      if (result.rowCount !== 1) throw new NotFoundError('folder_not_found');
      return result.rows[0]!;
    });
    return c.json({ folder: toFolder(row) });
  });

  /** Os documentos da pasta não são apagados: a FK zera o folder_id deles. */
  router.delete('/:id', async (c) => {
    const userId = c.get('userId');
    const id = parseId(c.req.param('id'));
    await withUser(pool, userId, async (client) => {
      const result = await client.query('DELETE FROM app.folders WHERE id = $1 AND user_id = $2', [id, userId]);
      if (result.rowCount !== 1) throw new NotFoundError('folder_not_found');
    });
    return c.body(null, 204);
  });

  return router;
}
