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
  file_not_found: 'Arquivo não encontrado no projeto.',
  file_exists: 'Já existe um arquivo com esse nome.',
  storage_quota_exceeded: 'Seu espaço para projetos LaTeX acabou (250 MB). Apague arquivos que não usa.',
  too_many_files: 'O projeto chegou ao limite de 300 arquivos.',
  project_too_large: 'O projeto chegou ao limite de 40 MB.',
  compiler_not_configured: 'A compilação LaTeX não está disponível neste ambiente.',
  compile_in_progress: 'Já há compilações em andamento. Aguarde terminarem.',
  too_many_compiles: 'Muitas compilações em pouco tempo. Aguarde um minuto.',
  job_not_found: 'A compilação expirou. Compile de novo.',
  not_found: 'Serviço indisponível no momento.',
};

let unauthorizedHandler: (() => void) | null = null;

/** Chamado quando a API responde 401 numa rota de dados (sessão expirada). */
export const onUnauthorized = (handler: (() => void) | null) => {
  unauthorizedHandler = handler;
};

/** Corpo binário (upload de arquivo do projeto) em vez de JSON. */
class RawBody {
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
}

async function send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body instanceof RawBody) {
    headers['content-type'] = 'application/octet-stream';
    payload = new Blob([body.bytes as Uint8Array<ArrayBuffer>]);
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  try {
    return await fetch(`/api${path}`, { method, credentials: 'same-origin', headers, body: payload, signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Não foi possível conectar ao servidor.');
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await send(method, path, body, signal);

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

/** Download binário (arquivo do projeto, PDF compilado). */
async function requestBytes(path: string, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await send('GET', path, undefined, signal);
  if (!res.ok) {
    const payload = ((await res.json().catch(() => null)) ?? {}) as { error?: string };
    const code = payload.error ?? `http_${res.status}`;
    if (res.status === 401) unauthorizedHandler?.();
    throw new ApiError(res.status, code, MESSAGES[code] ?? `erro ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export type ProjectFileKind = 'text' | 'binary';

export interface ProjectFileInfo {
  path: string;
  kind: ProjectFileKind;
  size: number;
  updatedAt: string;
  /** Só nos arquivos de texto. */
  content?: string;
}

export type CompileStatus =
  | 'running'
  | 'success'
  | 'warnings'
  | 'error'
  | 'timeout'
  | 'cancelled'
  | 'too_large'
  | 'busy'
  | 'unavailable';

export interface CompileDiagnostic {
  severity: 'error' | 'warning' | 'info';
  file: string | null;
  line: number | null;
  message: string;
  raw: string;
  source: string;
}

export interface CompileJob {
  id: string;
  documentId: string;
  status: CompileStatus;
  createdAt: string;
  finishedAt: string | null;
  hasPdf: boolean;
  engine?: string | null;
  durationMs?: number | null;
  diagnostics?: CompileDiagnostic[];
  log?: string;
  output?: string;
  pdfBytes?: number;
  message?: string | null;
}

export type LatexEngine = 'pdflatex' | 'xelatex' | 'lualatex';

const filePath = (docId: string, suffix: string, path?: string) =>
  `/documents/${encodeURIComponent(docId)}/files${suffix}${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`;

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

/** Formato devolvido pela API (camelCase, datas ISO). */
type ApiDocument = Omit<Document, 'kind' | 'mainFile'> & { createdAt: string; kind?: Document['kind']; mainFile?: string | null };

const toDocument = (doc: ApiDocument): Document => ({
  id: doc.id,
  title: doc.title,
  content: doc.content,
  folderId: doc.folderId,
  updatedAt: doc.updatedAt,
  // API antiga (sem os campos) => Markdown, como todos os documentos anteriores.
  kind: doc.kind ?? 'markdown',
  mainFile: doc.mainFile ?? null,
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
    async create(input: {
      title?: string;
      content?: string;
      folderId?: string | null;
      kind?: Document['kind'];
      mainFile?: string;
    }): Promise<Document> {
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
    async update(
      id: string,
      input: { title?: string; content?: string; folderId?: string | null; mainFile?: string }
    ): Promise<Document> {
      const data = await request<{ document: ApiDocument }>('PATCH', `/documents/${encodeURIComponent(id)}`, input);
      return toDocument(data.document);
    },
    async remove(id: string): Promise<void> {
      await request('DELETE', `/documents/${encodeURIComponent(id)}`);
    },
  },

  /** Arquivos de projetos LaTeX e compilação. */
  latex: {
    async listFiles(docId: string): Promise<{ mainFile: string; updatedAt: string; files: ProjectFileInfo[] }> {
      return request('GET', filePath(docId, ''));
    },
    async readFile(docId: string, path: string): Promise<Uint8Array> {
      return requestBytes(filePath(docId, '/raw', path));
    },
    /** Cria ou substitui um arquivo (texto em UTF-8 ou bytes). */
    async writeFile(
      docId: string,
      path: string,
      content: string | Uint8Array
    ): Promise<{ file: ProjectFileInfo; documentUpdatedAt: string }> {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      return request('PUT', filePath(docId, '/content', path), new RawBody(bytes));
    },
    async move(
      docId: string,
      from: string,
      to: string,
      folder = false
    ): Promise<{ mainFile: string; documentUpdatedAt: string }> {
      return request('POST', filePath(docId, '/move'), { from, to, ...(folder ? { folder: true } : {}) });
    },
    async remove(docId: string, path: string): Promise<{ documentUpdatedAt: string }> {
      return request('DELETE', filePath(docId, '', path));
    },
    async removeFolder(docId: string, folder: string): Promise<{ documentUpdatedAt: string }> {
      return request('DELETE', `/documents/${encodeURIComponent(docId)}/files?folder=${encodeURIComponent(folder)}`);
    },
    async compile(docId: string, engine?: LatexEngine): Promise<CompileJob> {
      const data = await request<{ job: CompileJob }>(
        'POST',
        `/documents/${encodeURIComponent(docId)}/compile`,
        engine ? { engine } : {}
      );
      return data.job;
    },
    /** Long-poll: volta quando o job termina ou depois de ~20 s. */
    async waitJob(jobId: string, signal?: AbortSignal): Promise<CompileJob> {
      const data = await request<{ job: CompileJob }>('GET', `/compile-jobs/${encodeURIComponent(jobId)}?wait=1`, undefined, signal);
      return data.job;
    },
    async cancelJob(jobId: string): Promise<void> {
      await request('DELETE', `/compile-jobs/${encodeURIComponent(jobId)}`);
    },
    async pdf(jobId: string, signal?: AbortSignal): Promise<Uint8Array> {
      return requestBytes(`/compile-jobs/${encodeURIComponent(jobId)}/pdf`, signal);
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
