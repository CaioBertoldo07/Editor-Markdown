import type { Document } from '../types/document';

const STORAGE_KEY = 'markdown-editor-documents';

export const loadDocuments = (): Document[] => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('Erro ao carregar documentos:', error);
    return [];
  }
};

export const saveDocuments = (documents: Document[]): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(documents));
  } catch (error) {
    console.error('Erro ao salvar documentos:', error);
  }
};