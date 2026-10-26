import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { createDocumentDeleter, DELETE_MESSAGES, type DeletionApi } from './documentDeletion';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function fakeApi(overrides: Partial<DeletionApi> = {}) {
  return {
    remove: vi.fn<DeletionApi['remove']>().mockResolvedValue(undefined),
    list: vi.fn<DeletionApi['list']>().mockResolvedValue([]),
    ...overrides,
  };
}

describe('exclusão de documento', () => {
  it('exclusão bem-sucedida (204 sem corpo): excluído, sem consulta extra', async () => {
    const api = fakeApi();
    const outcome = await createDocumentDeleter(api)(ID);
    expect(outcome).toEqual({ status: 'deleted', verified: false });
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(api.list).not.toHaveBeenCalled();
  });

  it('documento inexistente (404): tratado como já excluído', async () => {
    const api = fakeApi({ remove: vi.fn().mockRejectedValue(new ApiError(404, 'document_not_found', 'Documento não encontrado.')) });
    expect(await createDocumentDeleter(api)(ID)).toEqual({ status: 'already_deleted' });
    expect(api.list).not.toHaveBeenCalled();
  });

  it('erro real sem exclusão (5xx e o documento continua no servidor): não excluído', async () => {
    const api = fakeApi({
      remove: vi.fn().mockRejectedValue(new ApiError(503, 'http_503', 'erro 503')),
      list: vi.fn().mockResolvedValue([{ id: ID }, { id: OTHER }]),
    });
    expect(await createDocumentDeleter(api)(ID)).toEqual({ status: 'not_deleted', message: DELETE_MESSAGES.stillSaved });
    expect(api.remove).toHaveBeenCalledTimes(1);
  });

  it('erro de comunicação depois de uma exclusão concluída: confirma pela listagem, sem repetir o DELETE', async () => {
    const api = fakeApi({
      remove: vi.fn().mockRejectedValue(new ApiError(0, 'network', 'Não foi possível conectar ao servidor.')),
      list: vi.fn().mockResolvedValue([{ id: OTHER }]),
    });
    expect(await createDocumentDeleter(api)(ID)).toEqual({ status: 'deleted', verified: true });
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('5xx depois de uma exclusão concluída (como o 503 relatado): confirma pela listagem', async () => {
    const api = fakeApi({
      remove: vi.fn().mockRejectedValue(new ApiError(503, 'http_503', 'erro 503')),
      list: vi.fn().mockResolvedValue([]),
    });
    expect(await createDocumentDeleter(api)(ID)).toEqual({ status: 'deleted', verified: true });
    expect(api.remove).toHaveBeenCalledTimes(1);
  });

  it('erro não-ApiError (exceção inesperada) também é tratado como ambíguo', async () => {
    const api = fakeApi({ remove: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), list: vi.fn().mockResolvedValue([]) });
    expect(await createDocumentDeleter(api)(ID)).toEqual({ status: 'deleted', verified: true });
  });

  it('resultado ambíguo e a conferência também falha: estado desconhecido, nunca "excluído"', async () => {
    const api = fakeApi({
      remove: vi.fn().mockRejectedValue(new ApiError(0, 'network', 'Não foi possível conectar ao servidor.')),
      list: vi.fn().mockRejectedValue(new ApiError(0, 'network', 'Não foi possível conectar ao servidor.')),
    });
    expect(await createDocumentDeleter(api)(ID)).toEqual({ status: 'unknown', message: DELETE_MESSAGES.unconfirmed });
    expect(api.remove).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 'unauthorized', 'Sua sessão expirou. Entre novamente.'],
    [403, 'forbidden', 'erro 403'],
    [429, 'too_many_attempts', 'Muitas tentativas. Aguarde alguns minutos e tente de novo.'],
  ])('%i: o servidor recusou antes de apagar; não excluído, sem consulta extra', async (status, code, message) => {
    const api = fakeApi({ remove: vi.fn().mockRejectedValue(new ApiError(status, code, message)) });
    expect(await createDocumentDeleter(api)(ID)).toEqual({ status: 'not_deleted', message: DELETE_MESSAGES.rejected(message) });
    expect(api.list).not.toHaveBeenCalled();
  });

  it('clique duplo: a segunda exclusão do mesmo documento é ignorada enquanto a primeira não termina', async () => {
    let finish!: () => void;
    const remove = vi.fn<DeletionApi['remove']>(() => new Promise<void>((resolve) => (finish = resolve)));
    const api = fakeApi({ remove });
    const deleteDocument = createDocumentDeleter(api);

    const first = deleteDocument(ID);
    expect(await deleteDocument(ID)).toEqual({ status: 'in_progress' });
    finish();
    expect(await first).toEqual({ status: 'deleted', verified: false });
    expect(api.remove).toHaveBeenCalledTimes(1);

    // Terminada a primeira, uma nova tentativa volta a ser permitida.
    remove.mockResolvedValueOnce(undefined);
    await deleteDocument(ID);
    expect(api.remove).toHaveBeenCalledTimes(2);
  });

  it('documentos diferentes podem ser excluídos ao mesmo tempo', async () => {
    const api = fakeApi();
    const deleteDocument = createDocumentDeleter(api);
    const results = await Promise.all([deleteDocument(ID), deleteDocument(OTHER)]);
    expect(results.map((r) => r.status)).toEqual(['deleted', 'deleted']);
    expect(api.remove).toHaveBeenCalledTimes(2);
  });
});

describe('mensagens para o usuário', () => {
  it('são claras e não afirmam exclusão quando ela não foi confirmada', () => {
    expect(DELETE_MESSAGES.stillSaved).toMatch(/continua salvo/);
    expect(DELETE_MESSAGES.unconfirmed).toMatch(/Recarregue a página/);
    expect(DELETE_MESSAGES.unconfirmed).not.toMatch(/excluído com sucesso/);
    expect(DELETE_MESSAGES.rejected('Sua sessão expirou. Entre novamente.')).toBe(
      'Não foi possível excluir o documento: Sua sessão expirou. Entre novamente.'
    );
  });
});
