import { useParams, useNavigate } from 'react-router-dom';
import { useDocuments } from '../context/DocumentsContext';
import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { useDebounce } from '../hooks/useDebounce';
import DocumentList from '../components/DocumentList/DocumentList';
import Toolbar from '../components/Toolbar/Toolbar';
import Editor from '../components/Editor/Editor';
import Preview from '../components/Preview/Preview';
import ThemeToggle from '../components/ThemeToggle/ThemeToggle';
import SaveIndicator from '../components/SaveIndicator/SaveIndicator';
import MobileMenu from '../components/MobileMenu/MobileMenu';
import UserMenu from '../components/UserMenu/UserMenu';
import FullScreenLoader from '../components/FullScreenLoader/FullScreenLoader';
import './EditorPage.css';

// Ambiente LaTeX (editor de código + prévia PDF): só é baixado ao abrir um projeto LaTeX.
const LatexWorkspace = lazy(() => import('../components/Latex/LatexWorkspace'));

const EditorPage = () => {
  const { id } = useParams<{ id: string }>();
  const { documents, selectedDocument, selectDocument, updateDocument, folders, isLoading } = useDocuments();
  const navigate = useNavigate();
  
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [insertFormatCallback, setInsertFormatCallback] = useState<((before: string, after: string, placeholder?: string) => void) | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [localContent, setLocalContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  // Estado de salvamento dos arquivos de um projeto LaTeX (vem do workspace).
  const [latexSave, setLatexSave] = useState<{ saving: boolean; lastSaved: string | null }>({ saving: false, lastSaved: null });
  const isLatex = selectedDocument?.kind === 'latex';
  
  const debouncedContent = useDebounce(localContent, 800);

  const togglePreviewFullscreen = useCallback(() => {
    setIsPreviewFullscreen((prev) => !prev);
  }, []);

  // Atalhos da tela cheia: Ctrl+Shift+F alterna, Esc sai
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setIsPreviewFullscreen((prev) => !prev);
      } else if (e.key === 'Escape') {
        setIsPreviewFullscreen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSetInsertCallback = useCallback((callback: (before: string, after: string, placeholder?: string) => void) => {
    setInsertFormatCallback(() => callback);
  }, []);

  // Selecionar documento quando o ID mudar
  useEffect(() => {
    if (id) {
      selectDocument(id);
    }
  }, [id, selectDocument]);

  // Redirecionar só se o documento não existe (ou deixou de existir) na lista.
  // Olhar para selectedDocument aqui falhava ao abrir /doc/:id direto: no
  // render em que a carga termina, a seleção acima ainda não foi aplicada.
  useEffect(() => {
    if (!isLoading && id && !documents.some((doc) => doc.id === id)) {
      navigate('/', { replace: true });
    }
  }, [isLoading, documents, id, navigate]);

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
      selectedDocument.kind !== 'latex' &&
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

  const currentFolder = selectedDocument?.folderId
    ? folders.find((folder) => folder.id === selectedDocument.folderId) ?? null
    : null;

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
    return <FullScreenLoader message="Carregando documento..." />;
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
              {currentFolder && (
                <>
                  <svg className="document-info-folder" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"></path>
                  </svg>
                  {currentFolder.name}
                  <span className="document-info-sep">·</span>
                </>
              )}
              Atualizado {formatDate(selectedDocument.updatedAt)}
            </span>
          </div>

          <div className="header-right">
            <SaveIndicator
              isSaving={isLatex ? latexSave.saving : isSaving}
              lastSaved={isLatex ? latexSave.lastSaved : lastSaved}
            />
            <UserMenu />
            <button
              className="fullscreen-toggle"
              onClick={togglePreviewFullscreen}
              aria-label="Visualizar em tela cheia (Ctrl+Shift+F)"
              title="Visualizar em tela cheia (Ctrl+Shift+F)"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3"></path>
                <path d="M21 8V5a2 2 0 0 0-2-2h-3"></path>
                <path d="M3 16v3a2 2 0 0 0 2 2h3"></path>
                <path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>
              </svg>
            </button>
            <ThemeToggle />
          </div>
        </div>

        {isLatex ? (
          <Suspense fallback={<FullScreenLoader message="Abrindo o projeto LaTeX..." />}>
            <LatexWorkspace
              key={selectedDocument.id}
              doc={selectedDocument}
              isPreviewExpanded={isPreviewFullscreen}
              onTogglePreviewExpanded={togglePreviewFullscreen}
              onSaveState={setLatexSave}
            />
          </Suspense>
        ) : (
          <>
            <Toolbar onInsert={handleInsertFormat} />

            <div className="editor-workspace">
              <Editor
                content={localContent}
                onChange={handleContentChange}
                onInsertFormat={handleSetInsertCallback}
              />
              <Preview
                content={localContent}
                isFullscreen={isPreviewFullscreen}
                onToggleFullscreen={togglePreviewFullscreen}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default EditorPage;