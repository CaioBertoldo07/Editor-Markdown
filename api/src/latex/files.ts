import { HTTPException } from 'hono/http-exception';
import type { PoolClient } from 'pg';
import { BadRequestError, NotFoundError } from '../http/errors.js';
import { LIMITS } from '../http/schemas.js';
import { fileKindOf, InvalidPathError, normalizeProjectPath, type FileKind } from './paths.js';

/** Caminho do projeto validado com as mesmas regras do compilador (400 se inválido). */
export function validPath(input: string): string {
  try {
    return normalizeProjectPath(input);
  } catch (err) {
    if (err instanceof InvalidPathError) throw new BadRequestError([`path: ${err.reason}`]);
    throw err;
  }
}

export type LatexDocument = { id: string; main_file: string };

/**
 * Trava o documento LaTeX do usuário (FOR UPDATE) até o fim da transação: as
 * escritas no mesmo projeto ficam em fila, e a conta da cota não sofre corrida.
 * Documento de outro usuário ou inexistente => 404; Markdown => 400.
 */
export async function lockLatexDocument(client: PoolClient, userId: string, documentId: string): Promise<LatexDocument> {
  const { rows } = await client.query<{ id: string; kind: string; main_file: string | null }>(
    'SELECT id, kind, main_file FROM app.documents WHERE id = $1 AND user_id = $2 FOR UPDATE',
    [documentId, userId]
  );
  const doc = rows[0];
  if (!doc) throw new NotFoundError('document_not_found');
  if (doc.kind !== 'latex' || !doc.main_file) throw new BadRequestError(['document: não é um projeto LaTeX']);
  return { id: doc.id, main_file: doc.main_file };
}

/** Atualiza o updated_at do documento (o trigger cuida da data). */
export async function touchDocument(client: PoolClient, documentId: string): Promise<string> {
  const { rows } = await client.query<{ updated_at: Date }>(
    'UPDATE app.documents SET main_file = main_file WHERE id = $1 RETURNING updated_at',
    [documentId]
  );
  return rows[0]!.updated_at.toISOString();
}

export async function assertUserQuota(client: PoolClient, userId: string, extraBytes: number) {
  const { rows } = await client.query<{ total: string }>(
    'SELECT coalesce(sum(size_bytes), 0)::text AS total FROM app.document_files WHERE user_id = $1',
    [userId]
  );
  if (Number(rows[0]!.total) + extraBytes > LIMITS.latexUserMaxBytes) {
    throw new HTTPException(413, { message: 'storage_quota_exceeded' });
  }
}

/** Confere os limites do projeto, considerando que `replacingPath` (se existir) sai. */
export async function assertProjectQuota(
  client: PoolClient,
  userId: string,
  documentId: string,
  newBytes: number,
  replacingPath: string | null
) {
  const { rows } = await client.query<{ files: number; total: string; existing: number; replaced: string }>(
    `SELECT count(*)::int AS files,
            coalesce(sum(size_bytes), 0)::text AS total,
            (count(*) FILTER (WHERE lower(path) = lower($2)))::int AS existing,
            coalesce(sum(size_bytes) FILTER (WHERE lower(path) = lower($2)), 0)::text AS replaced
       FROM app.document_files WHERE document_id = $1`,
    [documentId, replacingPath ?? '']
  );
  const stats = rows[0]!;
  const replaced = Number(stats.replaced);
  if (stats.files - stats.existing + 1 > LIMITS.latexProjectMaxFiles) {
    throw new HTTPException(413, { message: 'too_many_files' });
  }
  if (Number(stats.total) - replaced + newBytes > LIMITS.latexProjectMaxBytes) {
    throw new HTTPException(413, { message: 'project_too_large' });
  }
  await assertUserQuota(client, userId, newBytes - replaced);
}

const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Decide como guardar o arquivo pelo nome e confere o conteúdo: texto precisa
 * ser UTF-8 válido sem bytes nulos; binários precisam ter a assinatura do formato.
 */
export function decodeUpload(path: string, bytes: Uint8Array): { kind: FileKind; content: string | null; data: Buffer | null } {
  const kind = fileKindOf(path);
  if (!kind) throw new BadRequestError(['path: tipo de arquivo não aceito']);
  if (kind === 'text') {
    if (bytes.length > LIMITS.latexTextFileMaxBytes) throw new HTTPException(413, { message: 'payload_too_large' });
    let text: string;
    try {
      text = fatalUtf8.decode(bytes);
    } catch {
      throw new BadRequestError(['content: arquivo de texto precisa estar em UTF-8']);
    }
    if (text.includes('\u0000')) throw new BadRequestError(['content: arquivo de texto com bytes nulos']);
    return { kind, content: text.replace(/^﻿/, ''), data: null };
  }
  if (bytes.length > LIMITS.latexBinaryFileMaxBytes) throw new HTTPException(413, { message: 'payload_too_large' });
  if (!matchesSignature(path, bytes)) throw new BadRequestError(['content: o conteúdo não corresponde à extensão do arquivo']);
  return { kind, content: null, data: Buffer.from(bytes) };
}

const startsWith = (bytes: Uint8Array, signature: number[]) => signature.every((b, i) => bytes[i] === b);

function matchesSignature(path: string, bytes: Uint8Array): boolean {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpg':
    case 'jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'pdf':
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    case 'eps':
      return startsWith(bytes, [0x25, 0x21, 0x50, 0x53]) || startsWith(bytes, [0xc5, 0xd0, 0xd3, 0xc6]); // %!PS ou binário DOS EPS
    case 'ttf':
      return startsWith(bytes, [0x00, 0x01, 0x00, 0x00]) || startsWith(bytes, [0x74, 0x72, 0x75, 0x65]);
    case 'otf':
      return startsWith(bytes, [0x4f, 0x54, 0x54, 0x4f]); // OTTO
    default:
      return false;
  }
}

/** Content-Type seguro para servir o arquivo: só imagens raster como imagem; o resto, binário opaco. */
export function safeContentType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (fileKindOf(path) === 'text') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

export type StoredFile = { path: string; content: string | null; data: Buffer | null };

/** Todos os arquivos do projeto (para compilar ou exportar). */
export async function loadProjectFiles(client: PoolClient, documentId: string): Promise<StoredFile[]> {
  const { rows } = await client.query<StoredFile>(
    'SELECT path, content, data FROM app.document_files WHERE document_id = $1 ORDER BY path',
    [documentId]
  );
  return rows;
}
