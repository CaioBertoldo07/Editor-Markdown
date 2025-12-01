import { useParams, useNavigate } from 'react-router-dom';
import { useDocuments } from '../context/DocumentsContext';
import { useEffect, useState, useCallback } from 'react';
import { useDebounce } from '../hooks/useDebounce';
import DocumentList from '../components/DocumentList/DocumentList';
import Toolbar from '../components/Toolbar/Toolbar';
import Editor from '../components/Editor/Editor';
import Preview from '../components/Preview/Preview';
import ThemeToggle from '../components/ThemeToggle/ThemeToggle';
import SaveIndicator from '../components/SaveIndicator/SaveIndicator';
import MobileMenu from '../components/MobileMenu/MobileMenu';
import './EditorPage.css';

const EditorPage = () => {
  const { id } = useParams<{ id: string }>();
  const { selectedDocument, selectDocument, updateDocument } = useDocuments();
  const navigate = useNavigate();
  
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [insertFormatCallback, setInsertFormatCallback] = useState<((before: string, after: string, placeholder?: string) => void) | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [localContent, setLocalContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  
  const debouncedContent = useDebounce(localContent, 800);

  const handleSetInsertCallback = useCallback((callback: (before: string, after: string, placeholder?: string) => void) => {
    setInsertFormatCallback(() => callback);
  }, []);

  // Selecionar documento quando o ID mudar
  useEffect(() => {
    if (id) {
      selectDocument(id);
    }
  }, [id, selectDocument]);

  // Redirecionar se não houver documento selecionado
  useEffect(() => {
    if (!selectedDocument && id) {
      navigate('/', { replace: true });
    }
  }, [selectedDocument, id, navigate]);

  // Atualizar campos locais quando o documento mudar
  // CORRIGIDO: Agora observa o selectedDocument completo e seu conteúdo
  useEffect(() => {
    if (selectedDocument) {
      setTitleInput(selectedDocument.title);
      setLocalContent(selectedDocument.content);
      setLastSaved(selectedDocument.updatedAt);
    }
  }, [selectedDocument]); // Removido ?.id para observar todo o objeto

  // Autosave - CORRIGIDO: Adicionar verificação para evitar loop
  useEffect(() => {
    if (
      selectedDocument && 
      debouncedContent !== selectedDocument.content &&
      debouncedContent !== '' // Evitar salvar vazio no primeiro render
    ) {
      setIsSaving(true);
      
      updateDocument(selectedDocument.id, { content: debouncedContent });
      
      setTimeout(() => {
        setIsSaving(false);
        setLastSaved(new Date().toISOString());
      }, 300);
    }
  }, [debouncedContent]);

  const handleContentChange = (content: string) => {
    setLocalContent(content);
  };

  const handleTitleClick = () => {
    setIsEditingTitle(true);
  };

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTitleInput(e.target.value);
  };

  const handleTitleBlur = () => {
    if (selectedDocument) {
      if (titleInput.trim()) {
        updateDocument(selectedDocument.id, { title: titleInput.trim() });
      } else {
        setTitleInput(selectedDocument.title);
      }
    }
    setIsEditingTitle(false);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleTitleBlur();
    } else if (e.key === 'Escape' && selectedDocument) {
      setTitleInput(selectedDocument.title);
      setIsEditingTitle(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('pt-BR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const handleInsertFormat = (before: string, after: string, placeholder?: string) => {
    if (insertFormatCallback) {
      insertFormatCallback(before, after, placeholder);
    }
  };

  const toggleMobileMenu = () => {
    setIsMobileMenuOpen(!isMobileMenuOpen);
  };

  const closeMobileMenu = () => {
    setIsMobileMenuOpen(false);
  };

  if (!selectedDocument) {
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100vh',
        color: 'var(--text-primary)',
        background: 'var(--bg-main)'
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ 
            width: '40px', 
            height: '40px', 
            border: '3px solid var(--border)',
            borderTopColor: 'var(--accent)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            margin: '0 auto 16px'
          }}></div>
          <p>Carregando documento...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-page">
      <DocumentList isOpen={isMobileMenuOpen} onClose={closeMobileMenu} />
      
      <div className="editor-main">
        <div className="editor-header">
          <MobileMenu isOpen={isMobileMenuOpen} onToggle={toggleMobileMenu} />
          
          <div className="header-left">
            {isEditingTitle ? (
              <input
                type="text"
                className="title-input"
                value={titleInput}
                onChange={handleTitleChange}
                onBlur={handleTitleBlur}
                onKeyDown={handleTitleKeyDown}
                autoFocus
              />
            ) : (
              <h1 className="document-title" onClick={handleTitleClick}>
                {selectedDocument.title}
              </h1>
            )}
            <span className="document-info">
              Atualizado {formatDate(selectedDocument.updatedAt)}
            </span>
          </div>

          <div className="header-right">
            <SaveIndicator isSaving={isSaving} lastSaved={lastSaved} />
            <ThemeToggle />
          </div>
        </div>

        <Toolbar onInsert={handleInsertFormat} />

        <div className="editor-workspace">
          <Editor 
            content={localContent}
            onChange={handleContentChange}
            onInsertFormat={handleSetInsertCallback}
          />
          <Preview content={localContent} />
        </div>
      </div>
    </div>
  );
};

export default EditorPage;