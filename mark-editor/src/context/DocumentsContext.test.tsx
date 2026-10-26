// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Document } from '../types/document';
import { DELETE_MESSAGES } from '../lib/documentDeletion';

const mockApi = vi.hoisted(() => ({
  documents: { list: vi.fn(), remove: vi.fn(), create: vi.fn(), import: vi.fn(), update: vi.fn() },
  folders: { list: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn() },
}));

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: mockApi,
}));
// Mesmo objeto a cada render, como o estado do AuthContext real.
const mockAuth = vi.hoisted(() => ({ user: { id: 'u1', email: 'ficticio@example.invalid' } }));
vi.mock('./AuthContext', () => ({ useAuth: () => mockAuth }));
vi.mock('../utils/migration', () => ({ hasMigrated: () => true, migrateLocalData: vi.fn() }));

const { ApiError } = await import('../lib/api');
const { DocumentsProvider, useDocuments } = await import('./DocumentsContext');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc = (id: string, title: string): Document => ({ id, title, content: '', folderId: null, updatedAt: '2026-10-26T00:00:00.000Z' });
const A = doc('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Fictício A');
const B = doc('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Fictício B');

type Ctx = ReturnType<typeof useDocuments>;
let ctx: Ctx;
const Probe = ({ onValue }: { onValue: (value: Ctx) => void }) => {
  onValue(useDocuments());
  return null;
};

let container: HTMLDivElement;
let root: Root;

const mount = async () => {
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root.render(
      <DocumentsProvider>
        <Probe onValue={(value) => (ctx = value)} />
      </DocumentsProvider>
    );
  });
};

const ids = () => ctx.documents.map((d) => d.id);

/** Promessa controlada pelo teste, para observar o estado "excluindo". */
const deferred = () => {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(async () => {
  vi.clearAllMocks();
  mockApi.folders.list.mockResolvedValue([]);
  mockApi.documents.list.mockResolvedValue([A, B]);
  await mount();
});

afterEach(() => {
  act(() => root.unmount());
});

describe('exclusão no contexto de documentos', () => {
  it('não some antes da confirmação; some depois do 204', async () => {
    const pending = deferred();
    mockApi.documents.remove.mockReturnValue(pending.promise);

    let result!: Promise<unknown>;
    await act(async () => {
      result = ctx.deleteDocument(A.id);
    });
    expect(ids()).toEqual([A.id, B.id]);
    expect(ctx.deletingIds).toEqual([A.id]);

    await act(async () => {
      pending.resolve();
      await result;
    });
    expect(ids()).toEqual([B.id]);
    expect(ctx.deletingIds).toEqual([]);
    expect(ctx.error).toBeNull();
  });

  it('erro real sem exclusão: o item continua na lista e a mensagem aparece', async () => {
    mockApi.documents.remove.mockRejectedValue(new ApiError(403, 'forbidden', 'erro 403'));
    await act(async () => {
      await ctx.deleteDocument(A.id);
    });
    expect(ids()).toEqual([A.id, B.id]);
    expect(ctx.deletingIds).toEqual([]);
    expect(ctx.error).toBe(DELETE_MESSAGES.rejected('erro 403'));
  });

  it('503 e o documento ainda existe no servidor: continua na lista com aviso', async () => {
    mockApi.documents.remove.mockRejectedValue(new ApiError(503, 'http_503', 'erro 503'));
    await act(async () => {
      await ctx.deleteDocument(A.id);
    });
    expect(ids()).toEqual([A.id, B.id]);
    expect(ctx.error).toBe(DELETE_MESSAGES.stillSaved);
    expect(mockApi.documents.remove).toHaveBeenCalledTimes(1);
  });

  it('503 depois de uma exclusão concluída: confere o servidor e remove sem aviso de erro', async () => {
    mockApi.documents.remove.mockRejectedValue(new ApiError(503, 'http_503', 'erro 503'));
    mockApi.documents.list.mockResolvedValue([B]);
    await act(async () => {
      await ctx.deleteDocument(A.id);
    });
    expect(ids()).toEqual([B.id]);
    expect(ctx.error).toBeNull();
    expect(mockApi.documents.remove).toHaveBeenCalledTimes(1);
  });

  it('sem como confirmar: o item continua e o usuário é orientado a recarregar', async () => {
    mockApi.documents.remove.mockRejectedValue(new ApiError(0, 'network', 'Não foi possível conectar ao servidor.'));
    mockApi.documents.list.mockRejectedValue(new ApiError(0, 'network', 'Não foi possível conectar ao servidor.'));
    await act(async () => {
      await ctx.deleteDocument(A.id);
    });
    expect(ids()).toEqual([A.id, B.id]);
    expect(ctx.error).toBe(DELETE_MESSAGES.unconfirmed);
  });

  it('documento inexistente (404): sai da lista sem aviso de erro', async () => {
    mockApi.documents.remove.mockRejectedValue(new ApiError(404, 'document_not_found', 'Documento não encontrado.'));
    await act(async () => {
      await ctx.deleteDocument(A.id);
    });
    expect(ids()).toEqual([B.id]);
    expect(ctx.error).toBeNull();
  });

  it('clique duplo: um único DELETE', async () => {
    const pending = deferred();
    mockApi.documents.remove.mockReturnValue(pending.promise);
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = ctx.deleteDocument(A.id);
      second = ctx.deleteDocument(A.id);
    });
    await act(async () => {
      pending.resolve();
      await Promise.all([first, second]);
    });
    expect(mockApi.documents.remove).toHaveBeenCalledTimes(1);
    expect(await second).toEqual({ status: 'in_progress' });
    expect(ids()).toEqual([B.id]);
  });

  it('o documento aberto é fechado só depois da exclusão confirmada', async () => {
    act(() => ctx.selectDocument(A.id));
    const pending = deferred();
    mockApi.documents.remove.mockReturnValue(pending.promise);
    let result!: Promise<unknown>;
    await act(async () => {
      result = ctx.deleteDocument(A.id);
    });
    expect(ctx.selectedDocument?.id).toBe(A.id);
    await act(async () => {
      pending.resolve();
      await result;
    });
    expect(ctx.selectedDocument).toBeNull();
  });

  it('após recarregar, a lista vem do servidor: o excluído não volta', async () => {
    mockApi.documents.remove.mockResolvedValue(undefined);
    await act(async () => {
      await ctx.deleteDocument(A.id);
    });
    mockApi.documents.list.mockResolvedValue([B]);
    act(() => root.unmount());
    await mount();
    expect(ids()).toEqual([B.id]);
  });
});
