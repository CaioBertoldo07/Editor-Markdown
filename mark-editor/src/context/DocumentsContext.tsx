import React, { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { Document } from '../types/document';
import { loadDocuments, saveDocuments } from '../utils/localStorage';
import { v4 as uuidv4 } from 'uuid';

interface DocumentsContextType {
  documents: Document[];
  selectedDocument: Document | null;
  createDocument: () => Document;
  updateDocument: (id: string, updates: Partial<Document>) => void;
  deleteDocument: (id: string) => void;
  selectDocument: (id: string) => void;
}

const DocumentsContext = createContext<DocumentsContextType | undefined>(undefined);

interface DocumentsProviderProps {
  children: ReactNode;
}

export const DocumentsProvider: React.FC<DocumentsProviderProps> = ({ children }) => {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);

  // Carregar documentos do localStorage ao inicializar
  useEffect(() => {
    const loaded = loadDocuments();
    setDocuments(loaded);
    
    // Se não houver documentos, criar um inicial
    if (loaded.length === 0) {
      const initialDoc = createInitialDocument();
      setDocuments([initialDoc]);
      setSelectedDocument(initialDoc);
      saveDocuments([initialDoc]);
    }
  }, []);

  // Salvar no localStorage sempre que documents mudar
  useEffect(() => {
    if (documents.length > 0) {
      saveDocuments(documents);
    }
  }, [documents]);

  const createInitialDocument = (): Document => ({
    id: uuidv4(),
    title: 'Bem-vindo ao Editor Markdown',
    content: '# Bem-vindo! 👋\n\nComece a escrever seu documento aqui...',
    updatedAt: new Date().toISOString(),
  });

  const createDocument = (): Document => {
    const newDoc: Document = {
      id: uuidv4(),
      title: 'Novo Documento',
      content: '',
      updatedAt: new Date().toISOString(),
    };

    setDocuments((prev) => [newDoc, ...prev]);
    setSelectedDocument(newDoc);
    return newDoc;
  };

  const updateDocument = (id: string, updates: Partial<Document>): void => {
    setDocuments((prev) =>
      prev.map((doc) =>
        doc.id === id
          ? { ...doc, ...updates, updatedAt: new Date().toISOString() }
          : doc
      )
    );

    // Atualizar documento selecionado se for o mesmo
    if (selectedDocument?.id === id) {
      setSelectedDocument((prev) =>
        prev ? { ...prev, ...updates, updatedAt: new Date().toISOString() } : null
      );
    }
  };

  const deleteDocument = (id: string): void => {
    setDocuments((prev) => {
      const filtered = prev.filter((doc) => doc.id !== id);
      
      // Se deletar o documento selecionado, selecionar o primeiro disponível
      if (selectedDocument?.id === id) {
        setSelectedDocument(filtered[0] || null);
      }
      
      return filtered;
    });
  };

  const selectDocument = (id: string): void => {
    const doc = documents.find((d) => d.id === id);
    if (doc) {
      setSelectedDocument(doc);
    }
  };

  return (
    <DocumentsContext.Provider
      value={{
        documents,
        selectedDocument,
        createDocument,
        updateDocument,
        deleteDocument,
        selectDocument,
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