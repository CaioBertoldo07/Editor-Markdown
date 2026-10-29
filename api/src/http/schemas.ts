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
  /**
   * Projetos LaTeX. Um arquivo por requisição: o proxy da Vercel aceita
   * corpos de até ~4,5 MB, então binários ficam em 4 MB.
   */
  latexTextFileMaxBytes: 1_000_000,
  latexBinaryFileMaxBytes: 4 * 1024 * 1024,
  latexProjectMaxFiles: 300,
  latexProjectMaxBytes: 40 * 1024 * 1024,
  /** Soma de todos os projetos LaTeX de um usuário. */
  latexUserMaxBytes: 250 * 1024 * 1024,
} as const;

export const idParam = z.uuid();

const title = z.string().max(LIMITS.titleMax);
const content = z.string().max(LIMITS.contentMax);
const folderId = z.uuid().nullable();
const timestamp = z.iso.datetime({ offset: true });
const folderName = z.string().trim().min(1).max(LIMITS.folderNameMax);

const kind = z.enum(['markdown', 'latex']);
/** Validação fina (normalizeProjectPath) na rota; aqui só o formato básico. */
const projectPath = z.string().min(1).max(200);

// `.strict()` recusa qualquer campo extra — inclusive user_id/userId.
// Num projeto LaTeX, `content` vira o arquivo principal (`mainFile`, padrão main.tex).
export const createDocumentBody = z
  .object({
    title: title.optional(),
    content: content.optional(),
    folderId: folderId.optional(),
    kind: kind.optional(),
    mainFile: projectPath.optional(),
  })
  .strict()
  .refine((body) => body.kind === 'latex' || body.mainFile === undefined, {
    message: 'mainFile só existe em documentos LaTeX',
  });

export const moveFileBody = z.object({ from: projectPath, to: projectPath }).strict();

export const compileBody = z
  .object({ engine: z.enum(['pdflatex', 'xelatex', 'lualatex']).optional() })
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

// Sem `kind`: o tipo do documento não muda depois de criado.
export const updateDocumentBody = z
  .object({
    title: title.optional(),
    content: content.optional(),
    folderId: folderId.optional(),
    mainFile: projectPath.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nada para atualizar' });

export const createFolderBody = z
  .object({ name: folderName.optional(), createdAt: timestamp.optional() })
  .strict();

export const renameFolderBody = z.object({ name: folderName }).strict();
