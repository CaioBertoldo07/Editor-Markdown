import type { Document, Folder } from '../types/document';

/**
 * Cliente da API própria (Railway). O navegador só fala com o mesmo domínio do
 * app: `/api/*` é repassado à API pelo middleware da Vercel (em produção) ou
 * pelo proxy do Vite (em desenvolvimento). A sessão é um cookie HttpOnly do
 * Better Auth — nenhum token passa pelo JavaScript.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MESSAGES: Record<string, string> = {
  unauthorized: 'Sua sessão expirou. Entre novamente.',
  INVALID_EMAIL_OR_PASSWORD: 'E-mail ou senha incorretos.',
  INVALID_EMAIL: 'E-mail inválido.',
  EMAIL_NOT_VERIFIED: 'E-mail ainda não verificado.',
  too_many_attempts: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
  payload_too_large: 'O conteúdo é grande demais para ser salvo.',
  document_not_found: 'Documento não encontrado.',
  folder_not_found: 'Pasta não encontrada.',
  not_found: 'Serviço indisponível no momento.',
};

let unauthorizedHandler: (() => void) | null = null;

/** Chamado quando a API responde 401 numa rota de dados (sessão expirada). */
export const onUnauthorized = (handler: (() => void) | null) => {
  unauthorizedHandler = handler;
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Não foi possível conectar ao servidor.');
  }

  if (res.status === 204) return undefined as T;

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const payload = (data ?? {}) as { error?: string; code?: string; message?: string };
    const code = payload.code ?? payload.error ?? `http_${res.status}`;
    if (res.status === 401 && !path.startsWith('/auth/')) unauthorizedHandler?.();
    const message =
      (res.status === 429 && MESSAGES.too_many_attempts) ||
      MESSAGES[code] ||
      payload.message ||
      `erro ${res.status}`;
    throw new ApiError(res.status, code, message);
  }
  return data as T;
}

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

/** Formato devolvido pela API (camelCase, datas ISO). */
type ApiDocument = Document & { createdAt: string };

const toDocument = (doc: ApiDocument): Document => ({
  id: doc.id,
  title: doc.title,
  content: doc.content,
  folderId: doc.folderId,
  updatedAt: doc.updatedAt,
});

/** Lotes de importação: limite da API (100) e do proxy da Vercel (~4 MB por corpo). */
const IMPORT_MAX_DOCS = 100;
const IMPORT_MAX_BYTES = 3_000_000;

const chunkForImport = <T extends { title: string; content: string }>(items: T[]): T[][] => {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const itemSize = new Blob([item.title, item.content]).size + 200;
    if (current.length > 0 && (current.length >= IMPORT_MAX_DOCS || size + itemSize > IMPORT_MAX_BYTES)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

export const api = {
  auth: {
    async getSession(): Promise<SessionUser | null> {
      const data = await request<{ user?: SessionUser } | null>('GET', '/auth/get-session');
      return data?.user ?? null;
    },
    async signIn(email: string, password: string): Promise<void> {
      await request('POST', '/auth/sign-in/email', { email, password });
    },
    async signOut(): Promise<void> {
      await request('POST', '/auth/sign-out', {});
    },
  },

  documents: {
    async list(): Promise<Document[]> {
      const data = await request<{ documents: ApiDocument[] }>('GET', '/documents');
      return data.documents.map(toDocument);
    },
    async create(input: { title?: string; content?: string; folderId?: string | null }): Promise<Document> {
      const data = await request<{ document: ApiDocument }>('POST', '/documents', input);
      return toDocument(data.document);
    },
    /** Importa em lotes; cada lote é tudo-ou-nada no servidor. */
    async import(
      documents: Array<{ title: string; content: string; updatedAt?: string }>,
      folderId: string | null = null
    ): Promise<Document[]> {
      const created: Document[] = [];
      for (const chunk of chunkForImport(documents)) {
        const data = await request<{ documents: ApiDocument[] }>('POST', '/documents/import', {
          folderId,
          documents: chunk,
        });
        created.push(...data.documents.map(toDocument));
      }
      return created;
    },
    async update(id: string, input: { title?: string; content?: string; folderId?: string | null }): Promise<Document> {
      const data = await request<{ document: ApiDocument }>('PATCH', `/documents/${encodeURIComponent(id)}`, input);
      return toDocument(data.document);
    },
    async remove(id: string): Promise<void> {
      await request('DELETE', `/documents/${encodeURIComponent(id)}`);
    },
  },

  folders: {
    async list(): Promise<Folder[]> {
      const data = await request<{ folders: Folder[] }>('GET', '/folders');
      return data.folders;
    },
    async create(input: { name?: string; createdAt?: string }): Promise<Folder> {
      const data = await request<{ folder: Folder }>('POST', '/folders', input);
      return data.folder;
    },
    async rename(id: string, name: string): Promise<Folder> {
      const data = await request<{ folder: Folder }>('PATCH', `/folders/${encodeURIComponent(id)}`, { name });
      return data.folder;
    },
    async remove(id: string): Promise<void> {
      await request('DELETE', `/folders/${encodeURIComponent(id)}`);
    },
  },
};
