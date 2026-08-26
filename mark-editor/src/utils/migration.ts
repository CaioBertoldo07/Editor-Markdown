import { neon } from '../lib/neon';
import { loadDocuments, loadFolders } from './localStorage';

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

/**
 * Sobe para o Neon o que já existia no localStorage.
 *
 * Quem chama só deve invocar isto com a conta ainda vazia no banco (é o que o
 * DocumentsContext faz) — assim, entrar num segundo dispositivo que tenha
 * rascunhos locais antigos não duplica documentos.
 * Retorna quantos documentos foram enviados.
 */
export const migrateLocalDataToNeon = async (): Promise<number> => {
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
    const { data, error } = await neon
      .from('folders')
      .insert({ name: folder.name, created_at: folder.createdAt })
      .select()
      .single();

    if (error) throw new Error(`Falha ao migrar a pasta "${folder.name}": ${error.message}`);
    if (data) folderIdMap.set(folder.id, data.id);
  }

  const rows = localDocuments.map((doc) => ({
    title: doc.title,
    content: doc.content,
    folder_id: doc.folderId ? folderIdMap.get(doc.folderId) ?? null : null,
    updated_at: doc.updatedAt,
  }));

  if (rows.length > 0) {
    const { error } = await neon.from('documents').insert(rows);
    if (error) throw new Error(`Falha ao migrar os documentos: ${error.message}`);
  }

  markMigrated();
  return rows.length;
};
