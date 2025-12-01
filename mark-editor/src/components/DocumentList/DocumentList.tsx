import { useState } from 'react';
import { useDocuments } from '../../context/DocumentsContext';
import { useNavigate } from 'react-router-dom';
import ConfirmModal from '../ConfirmModal/ConfirmModal';
import './DocumentList.css';

interface DocumentListProps {
  isOpen?: boolean;
  onClose?: () => void;
}

const DocumentList: React.FC<DocumentListProps> = ({ isOpen = true, onClose }) => {
  const { documents, selectedDocument, createDocument, deleteDocument, selectDocument } = useDocuments();
  const navigate = useNavigate();
  const [deleteModal, setDeleteModal] = useState<{ isOpen: boolean; documentId: string | null; documentTitle: string | null }>({
    isOpen: false,
    documentId: null,
    documentTitle: null
  });

  const handleCreateDocument = () => {
    const newDoc = createDocument();
    navigate(`/doc/${newDoc.id}`);
    if (onClose) onClose();
  };

  const handleSelectDocument = (id: string) => {
    selectDocument(id);
    navigate(`/doc/${id}`);
    if (onClose) onClose();
  };

  const handleDeleteClick = (e: React.MouseEvent, id: string, title: string) => {
    e.stopPropagation();
    setDeleteModal({
      isOpen: true,
      documentId: id,
      documentTitle: title
    });
  };

  const handleConfirmDelete = () => {
    if (deleteModal.documentId) {
      deleteDocument(deleteModal.documentId);
      
      if (selectedDocument?.id === deleteModal.documentId) {
        navigate('/');
      }
    }
    
    setDeleteModal({ isOpen: false, documentId: null, documentTitle: null });
  };

  const handleCancelDelete = () => {
    setDeleteModal({ isOpen: false, documentId: null, documentTitle: null });
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
        month: 'short' 
      });
    }
  };

  return (
    <>
      {isOpen && onClose && <div className="mobile-overlay" onClick={onClose} />}
      
      <div className={`document-list ${isOpen ? 'mobile-open' : ''}`}>
        <div className="document-list-header">
          <h2>Documentos</h2>
          <button 
            className="btn-create" 
            onClick={handleCreateDocument}
            title="Criar novo documento"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
        </div>

        <div className="documents-container">
          {documents.length === 0 ? (
            <div className="empty-state">
              <p>Nenhum documento criado</p>
              <small>Clique no botão + para começar</small>
            </div>
          ) : (
            documents.map((doc) => (
              <div
                key={doc.id}
                className={`document-item ${selectedDocument?.id === doc.id ? 'selected' : ''}`}
                onClick={() => handleSelectDocument(doc.id)}
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
                
                <button
                  className="btn-delete"
                  onClick={(e) => handleDeleteClick(e, doc.id, doc.title)}
                  title="Excluir documento"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={deleteModal.isOpen}
        title="Excluir Documento"
        message={`Tem certeza que deseja excluir "${deleteModal.documentTitle}"? Esta ação não pode ser desfeita.`}
        confirmText="Excluir"
        cancelText="Cancelar"
        type="danger"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </>
  );
};

export default DocumentList;