import './Toolbar.css';

interface ToolbarProps {
  onInsert: (before: string, after: string, placeholder?: string) => void;
}

const Toolbar: React.FC<ToolbarProps> = ({ onInsert }) => {
  const tools = [
    {
      id: 'bold',
      label: 'Negrito',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path>
          <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path>
        </svg>
      ),
      before: '**',
      after: '**',
      shortcut: 'Ctrl+B'
    },
    {
      id: 'italic',
      label: 'Itálico',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="19" y1="4" x2="10" y2="4"></line>
          <line x1="14" y1="20" x2="5" y2="20"></line>
          <line x1="15" y1="4" x2="9" y2="20"></line>
        </svg>
      ),
      before: '*',
      after: '*',
      shortcut: 'Ctrl+I'
    },
    {
      id: 'heading',
      label: 'Título',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 12h8m0 0h8m-8 0V4m0 8v8"></path>
        </svg>
      ),
      before: '# ',
      after: '',
      shortcut: 'Ctrl+H'
    },
    {
      id: 'list',
      label: 'Lista',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="8" y1="6" x2="21" y2="6"></line>
          <line x1="8" y1="12" x2="21" y2="12"></line>
          <line x1="8" y1="18" x2="21" y2="18"></line>
          <line x1="3" y1="6" x2="3.01" y2="6"></line>
          <line x1="3" y1="12" x2="3.01" y2="12"></line>
          <line x1="3" y1="18" x2="3.01" y2="18"></line>
        </svg>
      ),
      before: '- ',
      after: '',
      shortcut: 'Ctrl+L'
    },
    {
      id: 'code',
      label: 'Código Inline',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="16 18 22 12 16 6"></polyline>
          <polyline points="8 6 2 12 8 18"></polyline>
        </svg>
      ),
      before: '`',
      after: '`',
      shortcut: 'Ctrl+K'
    },
    {
      id: 'codeblock',
      label: 'Bloco de Código',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="3" width="20" height="18" rx="2"></rect>
          <line x1="8" y1="10" x2="16" y2="10"></line>
          <line x1="8" y1="14" x2="14" y2="14"></line>
        </svg>
      ),
      before: '```\n',
      after: '\n```',
      shortcut: 'Ctrl+Shift+K'
    },
    {
      id: 'link',
      label: 'Link',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
        </svg>
      ),
      before: '[',
      after: '](url)',
      shortcut: 'Ctrl+U'
    },
    {
      id: 'quote',
      label: 'Citação',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"></path>
          <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"></path>
        </svg>
      ),
      before: '> ',
      after: '',
      shortcut: 'Ctrl+Q'
    }
  ];

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        {tools.map((tool) => (
          <button
            key={tool.id}
            className="toolbar-btn"
            onClick={() => onInsert(tool.before, tool.after)}
            title={`${tool.label} (${tool.shortcut})`}
          >
            {tool.icon}
          </button>
        ))}
      </div>
    </div>
  );
};

export default Toolbar;