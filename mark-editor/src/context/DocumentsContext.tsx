import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Document, DocumentKind, Folder } from '../types/document';
import { api } from '../lib/api';
import { NEW_PROJECT_TEMPLATE } from '../latex/templates';
import {
  ProjectImportError,
  projectTitle,
  readProjectFiles,
  readProjectZip,
  splitLatexUploads,
  type ProjectImport,
} from '../latex/projectImport';
import { createDocumentDeleter } from '../lib/documentDeletion';
import type { DeleteOutcome } from '../lib/documentDeletion';
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
  createDocument: (folderId?: string | null, kind?: DocumentKind) => Promise<Document | null>;
  /** Cria documentos a partir de arquivos enviados: .md viram Markdown; .tex/.zip viram projetos LaTeX */
  importDocuments: (files: File[], folderId?: string | null) => Promise<ImportSummary>;
  /** Atualiza só o estado local depois de uma escrita nos arquivos de um projeto LaTeX */
  applyServerUpdate: (id: string, updates: Partial<Pick<Document, 'updatedAt' | 'mainFile'>>) => void;
  updateDocument: (id: string, updates: Partial<Document>) => void;
  /** Exclui no servidor e só então tira o documento da lista */
  deleteDocument: (id: string) => Promise<DeleteOutcome>;
  /** Documentos com exclusão em andamento (ainda na lista, aguardando o servidor) */
  deletingIds: string[];
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
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const deleterRef = useRef(createDocumentDeleter(api.documents));

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

  const createDocument = async (
    folderId: string | null = null,
    kind: DocumentKind = 'markdown'
  ): Promise<Document | null> => {
    try {
      const newDoc = await api.documents.create(
        kind === 'latex'
          ? { kind: 'latex', title: 'Novo Projeto LaTeX', content: NEW_PROJECT_TEMPLATE, folderId }
          : { title: 'Novo Documento', content: '', folderId }
      );
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
  /**
   * Cria um projeto LaTeX com os arquivos lidos do ZIP (ou soltos). O projeto
   * nasce com o arquivo principal; os outros sobem um por requisição (limite
   * do proxy). Se algum falhar, o projeto incompleto é apagado.
   */
  const importLatexProject = async (
    title: string,
    project: ProjectImport,
    folderId: string | null
  ): Promise<Document> => {
    const mainFile =
      project.mainFile ?? project.files.find((f) => f.path.toLowerCase().endsWith('.tex'))!.path;
    const main = project.files.find((f) => f.path === mainFile)!;
    const doc = await api.documents.create({
      kind: 'latex',
      title,
      folderId,
      mainFile,
      content: new TextDecoder().decode(main.bytes),
    });
    try {
      let updatedAt = doc.updatedAt;
      for (const file of project.files) {
        if (file.path === mainFile) continue;
        updatedAt = (await api.latex.writeFile(doc.id, file.path, file.bytes)).documentUpdatedAt;
      }
      return { ...doc, updatedAt };
    } catch (err) {
      await api.documents.remove(doc.id).catch(() => undefined);
      throw err;
    }
  };

  const importDocuments = async (
    files: File[],
    folderId: string | null = null
  ): Promise<ImportSummary> => {
    const { zips, latex, others } = splitLatexUploads(files);
    const latexDocs: Document[] = [];
    const latexSkipped: ImportSummary['skipped'] = [];

    const sources: Array<{ name: string; read: () => Promise<ProjectImport> }> = [
      ...zips.map((zip) => ({ name: zip.name, read: () => readProjectZip(zip) })),
      ...(latex.length > 0
        ? [{ name: latex.find((f) => /\.(tex|ltx)$/i.test(f.name))?.name ?? latex[0].name, read: () => readProjectFiles(latex) }]
        : []),
    ];
    for (const source of sources) {
      try {
        const project = await source.read();
        latexSkipped.push(...project.skipped.map((s) => ({ name: `${source.name}: ${s.name}`, reason: s.reason })));
        latexDocs.push(await importLatexProject(projectTitle(source.name), project, folderId));
      } catch (err) {
        const reason =
          err instanceof ProjectImportError ? err.message : `falha ao salvar no servidor (${(err as Error).message})`;
        latexSkipped.push({ name: source.name, reason });
      }
    }
    if (latexDocs.length > 0) setDocuments((prev) => [...latexDocs, ...prev]);

    const { parsed, skipped: markdownSkipped } = await parseImportFiles(others);
    const skipped = [...latexSkipped, ...markdownSkipped];

    if (parsed.length === 0) {
      if (latexDocs.length === 1) setSelectedDocument(latexDocs[0]);
      return { imported: latexDocs.length, skipped, firstDocumentId: latexDocs[0]?.id ?? null };
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
        imported: latexDocs.length,
        skipped: [
          ...skipped,
          ...parsed.map((doc) => ({ name: doc.title, reason: 'falha ao salvar no servidor' })),
        ],
        firstDocumentId: latexDocs[0]?.id ?? null,
      };
    }

    setDocuments((prev) => [...newDocs, ...prev]);

    // Veio um arquivo só: já deixa ele selecionado, como acontece ao criar um
    // documento novo, para quem chamar poder abrir a rota dele em seguida.
    const all = [...latexDocs, ...newDocs];
    if (all.length === 1) setSelectedDocument(all[0]);

    return { imported: all.length, skipped, firstDocumentId: all[0]?.id ?? null };
  };

  const applyServerUpdate = useCallback(
    (id: string, updates: Partial<Pick<Document, 'updatedAt' | 'mainFile'>>) => {
      setDocuments((prev) => prev.map((doc) => (doc.id === id ? { ...doc, ...updates } : doc)));
      setSelectedDocument((prev) => (prev?.id === id ? { ...prev, ...updates } : prev));
    },
    []
  );

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

  /**
   * Exclusão confirmada: o documento fica na lista (marcado em deletingIds)
   * até o servidor confirmar. Em caso de erro ele simplesmente continua lá.
   */
  const deleteDocument = async (id: string): Promise<DeleteOutcome> => {
    setDeletingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    let outcome: DeleteOutcome;
    try {
      outcome = await deleterRef.current(id);
    } finally {
      setDeletingIds((prev) => prev.filter((pending) => pending !== id));
    }

    if (outcome.status === 'deleted' || outcome.status === 'already_deleted') {
      setDocuments((prev) => prev.filter((doc) => doc.id !== id));
      setSelectedDocument((prev) => (prev?.id === id ? null : prev));
    } else if (outcome.status === 'not_deleted' || outcome.status === 'unknown') {
      console.error('Erro ao excluir o documento:', outcome.message);
      setError(outcome.message);
    }
    return outcome;
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
        applyServerUpdate,
        updateDocument,
        deleteDocument,
        deletingIds,
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
