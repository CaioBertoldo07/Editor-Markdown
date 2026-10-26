import { ApiError } from './api';

/**
 * Exclusão de documento com confirmação do servidor.
 *
 * - O DELETE é enviado uma única vez. Nunca é repetido automaticamente: ele pode
 *   ter sido concluído mesmo que a resposta não tenha chegado.
 * - Resposta 2xx (inclusive 204 sem corpo): excluído.
 * - 404: o documento já não existe para este usuário; o resultado é o mesmo.
 * - Outros 4xx (sessão expirada, limite de requisições...): o servidor recusou
 *   antes de apagar; o documento continua salvo.
 * - Falha de rede ou 5xx: resultado ambíguo. A listagem do servidor é
 *   consultada para saber se o documento ainda existe antes de afirmar sucesso
 *   ou falha.
 * - Uma segunda exclusão do mesmo documento enquanto a primeira não terminou é
 *   ignorada (clique duplo).
 */

export type DeleteOutcome =
  | { status: 'deleted'; verified: boolean }
  | { status: 'already_deleted' }
  | { status: 'not_deleted'; message: string }
  | { status: 'unknown'; message: string }
  | { status: 'in_progress' };

export interface DeletionApi {
  remove(id: string): Promise<void>;
  list(): Promise<Array<{ id: string }>>;
}

export const DELETE_MESSAGES = {
  stillSaved:
    'Não foi possível excluir o documento: o servidor não confirmou a exclusão e ele continua salvo. Tente novamente.',
  unconfirmed:
    'Não foi possível confirmar a exclusão do documento por uma falha de comunicação. Recarregue a página para ver se ele ainda existe.',
  rejected: (reason: string) => `Não foi possível excluir o documento: ${reason}`,
};

/** Erros em que o servidor pode ter concluído a exclusão antes de a resposta se perder. */
const isAmbiguous = (err: unknown): boolean => !(err instanceof ApiError) || err.status === 0 || err.status >= 500;

export function createDocumentDeleter(api: DeletionApi) {
  const inFlight = new Set<string>();

  return async function deleteDocument(id: string): Promise<DeleteOutcome> {
    if (inFlight.has(id)) return { status: 'in_progress' };
    inFlight.add(id);

    try {
      try {
        await api.remove(id);
        return { status: 'deleted', verified: false };
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return { status: 'already_deleted' };
        if (!isAmbiguous(err)) return { status: 'not_deleted', message: DELETE_MESSAGES.rejected((err as Error).message) };
      }

      // Resultado ambíguo: confere o estado real, sem repetir o DELETE.
      let documents: Array<{ id: string }>;
      try {
        documents = await api.list();
      } catch {
        return { status: 'unknown', message: DELETE_MESSAGES.unconfirmed };
      }
      return documents.some((doc) => doc.id === id)
        ? { status: 'not_deleted', message: DELETE_MESSAGES.stillSaved }
        : { status: 'deleted', verified: true };
    } finally {
      inFlight.delete(id);
    }
  };
}
