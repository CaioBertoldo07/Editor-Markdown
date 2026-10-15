import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export class NotFoundError extends Error {
  constructor(public readonly code = 'not_found') {
    super(code);
  }
}

/** Lê o JSON e valida; qualquer falha vira 400 sem detalhes internos. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'invalid_json' });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`));
  }
  return parsed.data;
}

export class BadRequestError extends Error {
  constructor(public readonly issues: string[]) {
    super('validation_error');
  }
}

const FOREIGN_KEY_VIOLATION = '23503';

export function handleError(err: Error, c: Context) {
  if (err instanceof BadRequestError) {
    return c.json({ error: 'validation_error', issues: err.issues }, 400);
  }
  if (err instanceof NotFoundError) {
    return c.json({ error: err.code }, 404);
  }
  if (err instanceof HTTPException) {
    const status = err.status;
    const message = status === 413 ? 'payload_too_large' : err.message || 'http_error';
    return c.json({ error: message }, status);
  }
  // Pasta de outro usuário/inexistente que escapou da checagem prévia (corrida):
  // a FK composta barra no banco, e respondemos como recurso inexistente.
  if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
    return c.json({ error: 'folder_not_found' }, 404);
  }
  console.error('[api] erro inesperado:', (err as { code?: string }).code ?? err.name);
  return c.json({ error: 'internal_error' }, 500);
}
