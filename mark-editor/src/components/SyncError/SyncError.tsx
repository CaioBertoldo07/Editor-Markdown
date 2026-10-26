import { useDocuments } from '../../context/DocumentsContext';
import './SyncError.css';

/**
 * Avisa quando uma escrita no banco falha. Sem isso, uma alteração poderia
 * parecer salva na tela e nunca ter chegado ao servidor.
 */
const SyncError = () => {
  const { error, dismissError } = useDocuments();

  if (!error) return null;

  return (
    <div className="sync-error" role="alert">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>

      <span>{error}</span>

      <button onClick={dismissError} aria-label="Fechar aviso">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
  );
};

export default SyncError;
