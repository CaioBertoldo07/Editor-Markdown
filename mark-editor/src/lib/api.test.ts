import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

const ID = '11111111-1111-4111-8111-111111111111';

const mockFetch = (impl: () => Promise<Response>) => {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.documents.remove', () => {
  it('204 sem corpo: resolve sem erro e sem tentar ler JSON', async () => {
    const fetchFn = mockFetch(async () => new Response(null, { status: 204 }));
    await expect(api.documents.remove(ID)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/documents/${ID}`);
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('200 com corpo vazio também é sucesso', async () => {
    mockFetch(async () => new Response('', { status: 200 }));
    await expect(api.documents.remove(ID)).resolves.toBeUndefined();
  });

  it('404: ApiError com código e mensagem de documento não encontrado', async () => {
    mockFetch(async () => Response.json({ error: 'document_not_found' }, { status: 404 }));
    await expect(api.documents.remove(ID)).rejects.toMatchObject({
      status: 404,
      code: 'document_not_found',
      message: 'Documento não encontrado.',
    });
  });

  it('503 vindo do proxy (API não configurada): ApiError 503, sem repetir a requisição', async () => {
    const fetchFn = mockFetch(async () => Response.json({ error: 'api_not_configured' }, { status: 503 }));
    const err = await api.documents.remove(ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, code: 'api_not_configured' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('503 sem corpo JSON: ApiError com mensagem genérica', async () => {
    mockFetch(async () => new Response('Service Unavailable', { status: 503 }));
    await expect(api.documents.remove(ID)).rejects.toMatchObject({ status: 503, code: 'http_503', message: 'erro 503' });
  });

  it('falha de rede: ApiError status 0', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(api.documents.remove(ID)).rejects.toMatchObject({
      status: 0,
      code: 'network',
      message: 'Não foi possível conectar ao servidor.',
    });
  });
});
