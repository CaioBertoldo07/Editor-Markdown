import { api } from '../lib/api';
import { loadDocuments, loadFolders } from './localStorage';

/**
 * Mesma chave usada na época do Neon: quem já migrou o localStorage antes não
 * migra de novo (os documentos já estão no banco e vieram junto na cópia).
 */
const MIGRATED_KEY = 'markdown-editor-migrated-to-neon';

export const hasMigrated = (): boolean => {
  try {
    return localStorage.getItem(MIGRATED_KEY) === 'true';
  } catch {
    return false;
  }
};

const markMigrated = (): void => {
  try {
    localStorage.setItem(MIGRATED_KEY, 'true');
  } catch {
    // Sem localStorage disponível: a migração roda de novo no próximo load,
    // mas só age quando a conta está vazia, então não duplica nada.
  }
};

const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /[zZ]|[+-]\d\d:\d\d$/.test(value);

/** Evita duas migrações simultâneas (ex.: efeito executado duas vezes). */
let inFlight: Promise<number> | null = null;

/**
 * Sobe para o servidor o que já existia no localStorage.
 *
 * Quem chama só deve invocar isto com a conta ainda vazia no banco (é o que o
 * DocumentsContext faz) — assim, entrar num segundo dispositivo que tenha
 * rascunhos locais antigos não duplica documentos.
 * Retorna quantos documentos foram enviados.
 */
export const migrateLocalData = (): Promise<number> => {
  if (!inFlight) {
    inFlight = runMigration().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
};

const runMigration = async (): Promise<number> => {
  if (hasMigrated()) return 0;

  const localFolders = loadFolders();
  const localDocuments = loadDocuments();

  if (localFolders.length === 0 && localDocuments.length === 0) {
    markMigrated();
    return 0;
  }

  // Mapeia os ids antigos (uuid gerado no browser) para os ids novos do banco
  const folderIdMap = new Map<string, string>();

  for (const folder of localFolders) {
    try {
      const created = await api.folders.create({
        name: folder.name?.trim() || 'Nova Pasta',
        ...(isIsoDate(folder.createdAt) ? { createdAt: folder.createdAt } : {}),
      });
      folderIdMap.set(folder.id, created.id);
    } catch (err) {
      throw new Error(`Falha ao migrar a pasta "${folder.name}": ${(err as Error).message}`);
    }
  }

  // Agrupa por pasta de destino (a importação recebe uma pasta por lote).
  const byFolder = new Map<string | null, Array<{ title: string; content: string; updatedAt?: string }>>();
  for (const doc of localDocuments) {
    const folderId = doc.folderId ? folderIdMap.get(doc.folderId) ?? null : null;
    const list = byFolder.get(folderId) ?? [];
    list.push({
      title: (doc.title ?? 'Novo Documento').slice(0, 500),
      content: doc.content ?? '',
      ...(isIsoDate(doc.updatedAt) ? { updatedAt: doc.updatedAt } : {}),
    });
    byFolder.set(folderId, list);
  }

  let total = 0;
  try {
    for (const [folderId, docs] of byFolder) {
      total += (await api.documents.import(docs, folderId)).length;
    }
  } catch (err) {
    throw new Error(`Falha ao migrar os documentos: ${(err as Error).message}`);
  }

  markMigrated();
  return total;
};
