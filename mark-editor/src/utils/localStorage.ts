import type { Document, Folder } from '../types/document';
import type { SortMode } from './sorting';

/**
 * Leitura dos dados que ficaram no navegador antes da sincronização com o Neon.
 * Hoje só serve para a migração inicial (ver utils/migration.ts) — a fonte da
 * verdade é o banco. O estado das pastas recolhidas continua sendo local, já
 * que é preferência de cada dispositivo.
 */

const STORAGE_KEY = 'markdown-editor-documents';
const FOLDERS_KEY = 'markdown-editor-folders';
const COLLAPSED_KEY = 'markdown-editor-collapsed-folders';
const SORT_KEY = 'markdown-editor-sort-mode';

export const loadDocuments = (): Document[] => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed: Document[] = stored ? JSON.parse(stored) : [];

    // Migração: documentos criados antes das pastas não têm folderId
    return parsed.map((doc) => ({
      ...doc,
      folderId: doc.folderId ?? null,
    }));
  } catch (error) {
    console.error('Erro ao carregar documentos:', error);
    return [];
  }
};

export const loadFolders = (): Folder[] => {
  try {
    const stored = localStorage.getItem(FOLDERS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('Erro ao carregar pastas:', error);
    return [];
  }
};

/** Ids das pastas que o usuário deixou recolhidas na sidebar */
export const loadCollapsedFolders = (): string[] => {
  try {
    const stored = localStorage.getItem(COLLAPSED_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

export const saveCollapsedFolders = (ids: string[]): void => {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(ids));
  } catch (error) {
    console.error('Erro ao salvar estado das pastas:', error);
  }
};

/** Como o usuário prefere ver a lista. Preferência local, como as recolhidas. */
export const loadSortMode = (): SortMode => {
  try {
    return localStorage.getItem(SORT_KEY) === 'recent' ? 'recent' : 'name';
  } catch {
    return 'name';
  }
};

export const saveSortMode = (mode: SortMode): void => {
  try {
    localStorage.setItem(SORT_KEY, mode);
  } catch (error) {
    console.error('Erro ao salvar a ordenação:', error);
  }
};
