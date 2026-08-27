import { useState, useEffect } from 'react';
import { useDocuments } from '../../context/DocumentsContext';
import { useNavigate } from 'react-router-dom';
import type { Document, Folder } from '../../types/document';
import { loadCollapsedFolders, saveCollapsedFolders } from '../../utils/localStorage';
import { downloadDocument, downloadFolderAsZip } from '../../utils/download';
import AppIcon from '../AppIcon/AppIcon';
import ConfirmModal from '../ConfirmModal/ConfirmModal';
import './DocumentList.css';

interface DocumentListProps {
  isOpen?: boolean;
  onClose?: () => void;
}

type DeleteTarget =
  | { kind: 'document'; id: string; name: string }
  | { kind: 'folder'; id: string; name: string }
  | null;

/** string = id da pasta, null = área "Sem pasta", undefined = nenhum alvo */
type DropTarget = string | null | undefined;

const DocumentList: React.FC<DocumentListProps> = ({ isOpen = true, onClose }) => {
  const {
    documents,
    folders,
    selectedDocument,
    createDocument,
    deleteDocument,
    isLoading,
    selectDocument,
    moveDocument,
    createFolder,
    renameFolder,
    deleteFolder,
  } = useDocuments();
  const navigate = useNavigate();

  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>(() => loadCollapsedFolders());
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderNameInput, setFolderNameInput] = useState('');
  const [draggedDocId, setDraggedDocId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(undefined);
  // Pasta cujo zip está sendo gerado; o JSZip é baixado sob demanda, então a
  // primeira vez tem uma espera perceptível.
  const [zippingFolderId, setZippingFolderId] = useState<string | null>(null);

  useEffect(() => {
    saveCollapsedFolders(collapsedFolders);
  }, [collapsedFolders]);

  const rootDocuments = documents.filter((doc) => !doc.folderId);
  const documentsInFolder = (folderId: string) =>
    documents.filter((doc) => doc.folderId === folderId);

  const isCollapsed = (folderId: string) => collapsedFolders.includes(folderId);

  const toggleFolder = (folderId: string) => {
    setCollapsedFolders((prev) =>
      prev.includes(folderId) ? prev.filter((id) => id !== folderId) : [...prev, folderId]
    );
  };

  const expandFolder = (folderId: string) => {
    setCollapsedFolders((prev) => prev.filter((id) => id !== folderId));
  };

  // --- Documentos ---

  const handleCreateDocument = async (folderId: string | null = null) => {
    const newDoc = await createDocument(folderId);
    if (!newDoc) return;

    if (folderId) expandFolder(folderId);
    navigate(`/doc/${newDoc.id}`);
    if (onClose) onClose();
  };

  const handleSelectDocument = (id: string) => {
    selectDocument(id);
    navigate(`/doc/${id}`);
    if (onClose) onClose();
  };

  // --- Pastas ---

  const handleCreateFolder = async () => {
    const newFolder = await createFolder();
    if (!newFolder) return;

    setRenamingFolderId(newFolder.id);
    setFolderNameInput(newFolder.name);
  };

  const startRenaming = (e: React.MouseEvent, folderId: string, currentName: string) => {
    e.stopPropagation();
    setRenamingFolderId(folderId);
    setFolderNameInput(currentName);
  };

  const commitRename = () => {
    if (renamingFolderId) {
      renameFolder(renamingFolderId, folderNameInput);
    }
    setRenamingFolderId(null);
    setFolderNameInput('');
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      commitRename();
    } else if (e.key === 'Escape') {
      setRenamingFolderId(null);
      setFolderNameInput('');
    }
  };

  // --- Exclusão ---

  const handleConfirmDelete = () => {
    if (deleteTarget?.kind === 'document') {
      const wasSelected = selectedDocument?.id === deleteTarget.id;
      deleteDocument(deleteTarget.id);
      if (wasSelected) navigate('/');
    } else if (deleteTarget?.kind === 'folder') {
      deleteFolder(deleteTarget.id);
    }

    setDeleteTarget(null);
  };

  // --- Drag & drop ---

  const handleDragStart = (e: React.DragEvent, docId: string) => {
    setDraggedDocId(docId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', docId);
  };

  const handleDragEnd = () => {
    setDraggedDocId(null);
    setDropTarget(undefined);
  };

  const handleDragOver = (e: React.DragEvent, target: string | null) => {
    if (!draggedDocId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(target);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Ignorar quando o ponteiro apenas entra em um filho da mesma área
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropTarget(undefined);
  };

  const handleDrop = (e: React.DragEvent, target: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const docId = e.dataTransfer.getData('text/plain') || draggedDocId;
    if (docId) moveDocument(docId, target);
    handleDragEnd();
  };

  // --- Download ---

  const handleDownloadFolder = async (e: React.MouseEvent, folder: Folder) => {
    e.stopPropagation();

    const docs = documentsInFolder(folder.id);
    if (docs.length === 0) return;

    setZippingFolderId(folder.id);
    try {
      await downloadFolderAsZip(folder, docs);
    } catch (err) {
      console.error('Erro ao gerar o zip da pasta:', err);
    } finally {
      setZippingFolderId(null);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInMs = now.getTime() - date.getTime();
    const diffInHours = diffInMs / (1000 * 60 * 60);

    if (diffInHours < 1) {
      return 'Agora mesmo';
    } else if (diffInHours < 24) {
      return `Há ${Math.floor(diffInHours)}h`;
    } else if (diffInHours < 48) {
      return 'Ontem';
    } else {
      return date.toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: 'short',
      });
    }
  };

  const renderDocument = (doc: Document) => (
    <div
      key={doc.id}
      className={`document-item ${selectedDocument?.id === doc.id ? 'selected' : ''} ${
        draggedDocId === doc.id ? 'dragging' : ''
      }`}
      onClick={() => handleSelectDocument(doc.id)}
      draggable
      onDragStart={(e) => handleDragStart(e, doc.id)}
      onDragEnd={handleDragEnd}
    >
      <div className="document-content">
        <h3 className="document-title">{doc.title}</h3>
        <div className="document-meta">
          <span className="document-date">{formatDate(doc.updatedAt)}</span>
          <span className="document-preview">
            {doc.content.substring(0, 50) || 'Documento vazio'}
          </span>
        </div>
      </div>

      <div className="document-actions">
        <button
          className="btn-download"
          onClick={(e) => {
            e.stopPropagation();
            downloadDocument(doc);
          }}
          title="Baixar como .md"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
        </button>

        <button
          className="btn-delete"
          onClick={(e) => {
            e.stopPropagation();
            setDeleteTarget({ kind: 'document', id: doc.id, name: doc.title });
          }}
          title="Excluir documento"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {isOpen && onClose && <div className="mobile-overlay" onClick={onClose} />}

      <div className={`document-list ${isOpen ? 'mobile-open' : ''}`}>
        <div className="document-list-header">
          <div className="document-list-brand">
            <AppIcon className="document-list-logo" size={28} />
            <h2>Documentos</h2>
          </div>
          <div className="header-actions">
            <button
              className="btn-create btn-create-folder"
              onClick={handleCreateFolder}
              title="Criar nova pasta"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v3"></path>
                <line x1="18" y1="14" x2="18" y2="20"></line>
                <line x1="15" y1="17" x2="21" y2="17"></line>
              </svg>
            </button>
            <button
              className="btn-create"
              onClick={() => handleCreateDocument(null)}
              title="Criar novo documento"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
            </button>
          </div>
        </div>

        <div className="documents-container">
          {isLoading ? (
            <div className="empty-state">
              <p>Carregando seus documentos...</p>
            </div>
          ) : documents.length === 0 && folders.length === 0 ? (
            <div className="empty-state">
              <p>Nenhum documento criado</p>
              <small>Clique no botão + para começar</small>
            </div>
          ) : (
            <>
              {folders.map((folder) => {
                const folderDocs = documentsInFolder(folder.id);
                const collapsed = isCollapsed(folder.id);

                return (
                  <div
                    key={folder.id}
                    className={`folder ${dropTarget === folder.id ? 'drop-target' : ''}`}
                    onDragOver={(e) => handleDragOver(e, folder.id)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, folder.id)}
                  >
                    <div className="folder-header" onClick={() => toggleFolder(folder.id)}>
                      <svg
                        className={`folder-chevron ${collapsed ? 'collapsed' : ''}`}
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="6 9 12 15 18 9"></polyline>
                      </svg>

                      <svg className="folder-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"></path>
                      </svg>

                      {renamingFolderId === folder.id ? (
                        <input
                          className="folder-name-input"
                          value={folderNameInput}
                          onChange={(e) => setFolderNameInput(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={handleRenameKeyDown}
                          onClick={(e) => e.stopPropagation()}
                          onFocus={(e) => e.target.select()}
                          autoFocus
                        />
                      ) : (
                        <span className="folder-name" title={folder.name}>
                          {folder.name}
                        </span>
                      )}

                      <span className="folder-count">{folderDocs.length}</span>

                      <div className="folder-actions">
                        <button
                          className="folder-action"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCreateDocument(folder.id);
                          }}
                          title="Novo documento nesta pasta"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                          </svg>
                        </button>
                        <button
                          className="folder-action"
                          onClick={(e) => handleDownloadFolder(e, folder)}
                          disabled={folderDocs.length === 0 || zippingFolderId === folder.id}
                          title={
                            folderDocs.length === 0
                              ? 'Pasta vazia'
                              : zippingFolderId === folder.id
                                ? 'Gerando o zip...'
                                : `Baixar ${folderDocs.length} documento(s) em .zip`
                          }
                        >
                          {zippingFolderId === folder.id ? (
                            <svg className="folder-action-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                              <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                            </svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                              <polyline points="7 10 12 15 17 10"></polyline>
                              <line x1="12" y1="15" x2="12" y2="3"></line>
                            </svg>
                          )}
                        </button>
                        <button
                          className="folder-action"
                          onClick={(e) => startRenaming(e, folder.id, folder.name)}
                          title="Renomear pasta"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 20h9"></path>
                            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"></path>
                          </svg>
                        </button>
                        <button
                          className="folder-action folder-action-danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget({ kind: 'folder', id: folder.id, name: folder.name });
                          }}
                          title="Excluir pasta"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                          </svg>
                        </button>
                      </div>
                    </div>

                    {!collapsed && (
                      <div className="folder-documents">
                        {folderDocs.length === 0 ? (
                          <div className="folder-empty">Arraste documentos para cá</div>
                        ) : (
                          folderDocs.map(renderDocument)
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              <div
                className={`root-documents ${dropTarget === null ? 'drop-target' : ''}`}
                onDragOver={(e) => handleDragOver(e, null)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, null)}
              >
                {folders.length > 0 && rootDocuments.length > 0 && (
                  <div className="section-label">Sem pasta</div>
                )}
                {rootDocuments.map(renderDocument)}
                {folders.length > 0 && rootDocuments.length === 0 && draggedDocId && (
                  <div className="folder-empty">Solte aqui para tirar da pasta</div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title={deleteTarget?.kind === 'folder' ? 'Excluir Pasta' : 'Excluir Documento'}
        message={
          deleteTarget?.kind === 'folder'
            ? `Tem certeza que deseja excluir a pasta "${deleteTarget.name}"? Os documentos dentro dela não serão excluídos — eles voltam para "Sem pasta".`
            : `Tem certeza que deseja excluir "${deleteTarget?.name}"? Esta ação não pode ser desfeita.`
        }
        confirmText="Excluir"
        cancelText="Cancelar"
        type={deleteTarget?.kind === 'folder' ? 'warning' : 'danger'}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
};

export default DocumentList;
