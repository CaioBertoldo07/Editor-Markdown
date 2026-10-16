import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import type { Document, Folder } from '../types/document';
import { api } from '../lib/api';
import { useAuth } from './AuthContext';
import { hasMigrated, migrateLocalData } from '../utils/migration';
import { parseImportFiles } from '../utils/import';
import type { ImportSummary } from '../utils/import';

interface DocumentsContextType {
  documents: Document[];
  folders: Folder[];
  selectedDocument: Document | null;
  /** true enquanto a carga inicial do banco não terminou */
  isLoading: boolean;
  /** Última falha de sincronização, para avisar o usuário */
  error: string | null;
  dismissError: () => void;
  createDocument: (folderId?: string | null) => Promise<Document | null>;
  /** Cria documentos a partir de arquivos .md enviados pelo usuário */
  importDocuments: (files: File[], folderId?: string | null) => Promise<ImportSummary>;
  updateDocument: (id: string, updates: Partial<Document>) => void;
  deleteDocument: (id: string) => void;
  selectDocument: (id: string) => void;
  moveDocument: (id: string, folderId: string | null) => void;
  createFolder: (name?: string) => Promise<Folder | null>;
  renameFolder: (id: string, name: string) => void;
  deleteFolder: (id: string) => void;
}

const DocumentsContext = createContext<DocumentsContextType | undefined>(undefined);

interface DocumentsProviderProps {
  children: ReactNode;
}

export const DocumentsProvider: React.FC<DocumentsProviderProps> = ({ children }) => {
  const { user } = useAuth();

  const [documents, setDocuments] = useState<Document[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const dismissError = useCallback(() => setError(null), []);

  const fetchAll = useCallback(async () => {
    const [folders, documents] = await Promise.all([api.folders.list(), api.documents.list()]);
    return { folders, documents };
  }, []);

  // Carregar do banco sempre que o usuário logado mudar
  useEffect(() => {
    if (!user) {
      setDocuments([]);
      setFolders([]);
      setSelectedDocument(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    (async () => {
      let result = await fetchAll();

      // Primeira entrada com a conta vazia: sobe o que existia no localStorage
      if (!cancelled && result.documents.length === 0 && result.folders.length === 0 && !hasMigrated()) {
        const migrated = await migrateLocalData();
        if (migrated > 0) result = await fetchAll();
      }

      if (cancelled) return;

      setFolders(result.folders);
      setDocuments(result.documents);
    })()
      .catch((err: Error) => {
        if (cancelled) return;
        console.error('Erro ao carregar documentos:', err.message);
        setError(`Não foi possível carregar seus documentos: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user, fetchAll]);

  /** Roda a escrita no banco em segundo plano e avisa se falhar */
  const sync = (promise: Promise<unknown>, acao: string) => {
    promise.catch((err: Error) => {
      console.error(`Erro ao ${acao}:`, err.message);
      setError(`Não foi possível ${acao}: ${err.message}`);
    });
  };

  const createDocument = async (folderId: string | null = null): Promise<Document | null> => {
    try {
      const newDoc = await api.documents.create({ title: 'Novo Documento', content: '', folderId });
      setDocuments((prev) => [newDoc, ...prev]);
      setSelectedDocument(newDoc);
      return newDoc;
    } catch (err) {
      console.error('Erro ao criar documento:', (err as Error).message);
      setError(`Não foi possível criar o documento: ${(err as Error).message}`);
      return null;
    }
  };

  /**
   * Importa arquivos markdown como novos documentos.
   *
   * Os arquivos que não servem (formato, tamanho, leitura) não impedem os
   * outros: eles voltam na lista de `skipped` para a UI explicar o que ficou de
   * fora. Já uma falha no banco derruba a importação inteira, porque a gravação
   * é um insert único.
   */
  const importDocuments = async (
    files: File[],
    folderId: string | null = null
  ): Promise<ImportSummary> => {
    const { parsed, skipped } = await parseImportFiles(files);

    if (parsed.length === 0) {
      return { imported: 0, skipped, firstDocumentId: null };
    }

    let newDocs: Document[];
    try {
      newDocs = await api.documents.import(
        parsed.map((doc) => ({ title: doc.title, content: doc.content })),
        folderId
      );
    } catch (err) {
      console.error('Erro ao importar documentos:', (err as Error).message);
      setError(`Não foi possível importar os documentos: ${(err as Error).message}`);
      return {
        imported: 0,
        skipped: [
          ...skipped,
          ...parsed.map((doc) => ({ name: doc.title, reason: 'falha ao salvar no servidor' })),
        ],
        firstDocumentId: null,
      };
    }

    setDocuments((prev) => [...newDocs, ...prev]);

    // Veio um arquivo só: já deixa ele selecionado, como acontece ao criar um
    // documento novo, para quem chamar poder abrir a rota dele em seguida.
    if (newDocs.length === 1) setSelectedDocument(newDocs[0]);

    return { imported: newDocs.length, skipped, firstDocumentId: newDocs[0]?.id ?? null };
  };

  const updateDocument = (id: string, updates: Partial<Document>): void => {
    const updatedAt = new Date().toISOString();

    // Atualização otimista: a UI responde na hora, o banco confirma depois
    setDocuments((prev) =>
      prev.map((doc) => (doc.id === id ? { ...doc, ...updates, updatedAt } : doc))
    );

    if (selectedDocument?.id === id) {
      setSelectedDocument((prev) => (prev ? { ...prev, ...updates, updatedAt } : null));
    }

    const payload: { title?: string; content?: string; folderId?: string | null } = {};
    if (updates.title !== undefined) payload.title = updates.title;
    if (updates.content !== undefined) payload.content = updates.content;
    if (updates.folderId !== undefined) payload.folderId = updates.folderId;

    if (Object.keys(payload).length === 0) return;

    sync(api.documents.update(id, payload), 'salvar o documento');
  };

  const deleteDocument = (id: string): void => {
    setDocuments((prev) => {
      const filtered = prev.filter((doc) => doc.id !== id);

      if (selectedDocument?.id === id) {
        setSelectedDocument(filtered[0] || null);
      }

      return filtered;
    });

    sync(api.documents.remove(id), 'excluir o documento');
  };

  const selectDocument = (id: string): void => {
    const doc = documents.find((d) => d.id === id);
    if (doc) {
      setSelectedDocument(doc);
    }
  };

  /** Move um documento para uma pasta (ou para fora de todas, com null) */
  const moveDocument = (id: string, folderId: string | null): void => {
    setDocuments((prev) =>
      prev.map((doc) => (doc.id === id ? { ...doc, folderId } : doc))
    );

    if (selectedDocument?.id === id) {
      setSelectedDocument((prev) => (prev ? { ...prev, folderId } : null));
    }

    sync(api.documents.update(id, { folderId }), 'mover o documento');
  };

  const createFolder = async (name = 'Nova Pasta'): Promise<Folder | null> => {
    try {
      const newFolder = await api.folders.create({ name });
      setFolders((prev) => [...prev, newFolder]);
      return newFolder;
    } catch (err) {
      console.error('Erro ao criar pasta:', (err as Error).message);
      setError(`Não foi possível criar a pasta: ${(err as Error).message}`);
      return null;
    }
  };

  const renameFolder = (id: string, name: string): void => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setFolders((prev) =>
      prev.map((folder) => (folder.id === id ? { ...folder, name: trimmed } : folder))
    );

    sync(api.folders.rename(id, trimmed), 'renomear a pasta');
  };

  /**
   * Remove a pasta. Os documentos dela não são excluídos: no banco a FK zera o
   * folder_id deles, então eles voltam para fora de qualquer pasta.
   */
  const deleteFolder = (id: string): void => {
    setDocuments((prev) =>
      prev.map((doc) => (doc.folderId === id ? { ...doc, folderId: null } : doc))
    );

    if (selectedDocument?.folderId === id) {
      setSelectedDocument((prev) => (prev ? { ...prev, folderId: null } : null));
    }

    setFolders((prev) => prev.filter((folder) => folder.id !== id));

    sync(api.folders.remove(id), 'excluir a pasta');
  };

  return (
    <DocumentsContext.Provider
      value={{
        documents,
        folders,
        selectedDocument,
        isLoading,
        error,
        dismissError,
        createDocument,
        importDocuments,
        updateDocument,
        deleteDocument,
        selectDocument,
        moveDocument,
        createFolder,
        renameFolder,
        deleteFolder,
      }}
    >
      {children}
    </DocumentsContext.Provider>
  );
};

export const useDocuments = (): DocumentsContextType => {
  const context = useContext(DocumentsContext);
  if (!context) {
    throw new Error('useDocuments deve ser usado dentro de DocumentsProvider');
  }
  return context;
};
