import './SaveIndicator.css';

interface SaveIndicatorProps {
  isSaving: boolean;
  lastSaved: string | null;
}

const SaveIndicator: React.FC<SaveIndicatorProps> = ({ isSaving, lastSaved }) => {
  const formatLastSaved = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 5) {
      return 'Salvo agora';
    } else if (diffInSeconds < 60) {
      return `Salvo há ${diffInSeconds}s`;
    } else {
      const minutes = Math.floor(diffInSeconds / 60);
      return `Salvo há ${minutes}min`;
    }
  };

  return (
    <div className="save-indicator">
      {isSaving ? (
        <>
          <div className="save-spinner"></div>
          <span>Salvando...</span>
        </>
      ) : lastSaved ? (
        <>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>{formatLastSaved(lastSaved)}</span>
        </>
      ) : null}
    </div>
  );
};

export default SaveIndicator;