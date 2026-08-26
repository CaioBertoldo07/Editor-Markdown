import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import type { Document, Folder } from '../types/document';
import { neon } from '../lib/neon';
import { useAuth } from './AuthContext';
import { hasMigrated, migrateLocalDataToNeon } from '../utils/migration';

/** Formato das linhas como vêm do Postgres (snake_case) */
interface DocumentRow {
  id: string;
  title: string;
  content: string;
  folder_id: string | null;
  updated_at: string;
}

interface FolderRow {
  id: string;
  name: string;
  created_at: string;
}

const toDocument = (row: DocumentRow): Document => ({
  id: row.id,
  title: row.title,
  content: row.content,
  folderId: row.folder_id,
  updatedAt: row.updated_at,
});

const toFolder = (row: FolderRow): Folder => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
});

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
    const [foldersResult, documentsResult] = await Promise.all([
      neon.from('folders').select('*').order('created_at', { ascending: true }),
      neon.from('documents').select('*').order('updated_at', { ascending: false }),
    ]);

    if (foldersResult.error) throw new Error(foldersResult.error.message);
    if (documentsResult.error) throw new Error(documentsResult.error.message);

    return {
      folders: (foldersResult.data ?? []).map(toFolder),
      documents: (documentsResult.data ?? []).map(toDocument),
    };
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
        const migrated = await migrateLocalDataToNeon();
        if (migrated > 0) result = await fetchAll();
      }

      if (cancelled) return;

      setFolders(result.folders);
      setDocuments(result.documents);
    })()
      .catch((err: Error) => {
        if (cancelled) return;
        console.error('Erro ao carregar do Neon:', err);
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
  const sync = (promise: PromiseLike<{ error: { message: string } | null }>, acao: string) => {
    Promise.resolve(promise).then(
      ({ error: syncError }) => {
        if (syncError) {
          console.error(`Erro ao ${acao}:`, syncError);
          setError(`Não foi possível ${acao}: ${syncError.message}`);
        }
      },
      (err: Error) => {
        console.error(`Erro ao ${acao}:`, err);
        setError(`Não foi possível ${acao}: ${err.message}`);
      }
    );
  };

  const createDocument = async (folderId: string | null = null): Promise<Document | null> => {
    const { data, error: insertError } = await neon
      .from('documents')
      .insert({ title: 'Novo Documento', content: '', folder_id: folderId })
      .select()
      .single();

    if (insertError || !data) {
      console.error('Erro ao criar documento:', insertError);
      setError(`Não foi possível criar o documento: ${insertError?.message ?? 'erro desconhecido'}`);
      return null;
    }

    const newDoc = toDocument(data);
    setDocuments((prev) => [newDoc, ...prev]);
    setSelectedDocument(newDoc);
    return newDoc;
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

    const payload: Record<string, unknown> = {};
    if (updates.title !== undefined) payload.title = updates.title;
    if (updates.content !== undefined) payload.content = updates.content;
    if (updates.folderId !== undefined) payload.folder_id = updates.folderId;

    if (Object.keys(payload).length === 0) return;

    sync(neon.from('documents').update(payload).eq('id', id), 'salvar o documento');
  };

  const deleteDocument = (id: string): void => {
    setDocuments((prev) => {
      const filtered = prev.filter((doc) => doc.id !== id);

      if (selectedDocument?.id === id) {
        setSelectedDocument(filtered[0] || null);
      }

      return filtered;
    });

    sync(neon.from('documents').delete().eq('id', id), 'excluir o documento');
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

    sync(neon.from('documents').update({ folder_id: folderId }).eq('id', id), 'mover o documento');
  };

  const createFolder = async (name = 'Nova Pasta'): Promise<Folder | null> => {
    const { data, error: insertError } = await neon
      .from('folders')
      .insert({ name })
      .select()
      .single();

    if (insertError || !data) {
      console.error('Erro ao criar pasta:', insertError);
      setError(`Não foi possível criar a pasta: ${insertError?.message ?? 'erro desconhecido'}`);
      return null;
    }

    const newFolder = toFolder(data);
    setFolders((prev) => [...prev, newFolder]);
    return newFolder;
  };

  const renameFolder = (id: string, name: string): void => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setFolders((prev) =>
      prev.map((folder) => (folder.id === id ? { ...folder, name: trimmed } : folder))
    );

    sync(neon.from('folders').update({ name: trimmed }).eq('id', id), 'renomear a pasta');
  };

  /**
   * Remove a pasta. Os documentos dela não são excluídos: a FK está declarada
   * com ON DELETE SET NULL, então eles voltam para fora de qualquer pasta.
   */
  const deleteFolder = (id: string): void => {
    setDocuments((prev) =>
      prev.map((doc) => (doc.folderId === id ? { ...doc, folderId: null } : doc))
    );

    if (selectedDocument?.folderId === id) {
      setSelectedDocument((prev) => (prev ? { ...prev, folderId: null } : null));
    }

    setFolders((prev) => prev.filter((folder) => folder.id !== id));

    sync(neon.from('folders').delete().eq('id', id), 'excluir a pasta');
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
