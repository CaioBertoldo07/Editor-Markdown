import { z } from 'zod';

/** Limites de entrada. O maior documento atual tem ~65 KB. */
export const LIMITS = {
  titleMax: 500,
  contentMax: 1_000_000,
  folderNameMax: 200,
  importMaxDocuments: 100,
  /** Corpo de requisições comuns (1 documento). */
  bodyMaxBytes: 1_500_000,
  /** Corpo de importação (vários documentos). */
  importBodyMaxBytes: 5_000_000,
} as const;

export const idParam = z.uuid();

const title = z.string().max(LIMITS.titleMax);
const content = z.string().max(LIMITS.contentMax);
const folderId = z.uuid().nullable();
const timestamp = z.iso.datetime({ offset: true });
const folderName = z.string().trim().min(1).max(LIMITS.folderNameMax);

// `.strict()` recusa qualquer campo extra — inclusive user_id/userId.
export const createDocumentBody = z
  .object({ title: title.optional(), content: content.optional(), folderId: folderId.optional() })
  .strict();

export const importDocumentsBody = z
  .object({
    folderId: folderId.optional(),
    documents: z
      .array(z.object({ title, content, updatedAt: timestamp.optional() }).strict())
      .min(1)
      .max(LIMITS.importMaxDocuments),
  })
  .strict();

export const updateDocumentBody = z
  .object({ title: title.optional(), content: content.optional(), folderId: folderId.optional() })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nada para atualizar' });

export const createFolderBody = z
  .object({ name: folderName.optional(), createdAt: timestamp.optional() })
  .strict();

export const renameFolderBody = z.object({ name: folderName }).strict();
