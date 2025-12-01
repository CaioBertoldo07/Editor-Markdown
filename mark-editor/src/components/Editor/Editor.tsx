import { useRef, useEffect } from 'react';
import './Editor.css';

interface EditorProps {
  content: string;
  onChange: (content: string) => void;
  onInsertFormat?: (callback: (before: string, after: string, placeholder?: string) => void) => void;
}

const Editor: React.FC<EditorProps> = ({ content, onChange, onInsertFormat }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (onInsertFormat) {
      onInsertFormat(handleInsertFormat);
    }
  }, [onInsertFormat]);

  const handleInsertFormat = (before: string, after: string, placeholder: string = '') => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = content.substring(start, end);
    const textToInsert = selectedText || placeholder;

    const newContent =
      content.substring(0, start) +
      before +
      textToInsert +
      after +
      content.substring(end);

    onChange(newContent);

    // Restaurar foco e posição do cursor
    setTimeout(() => {
      textarea.focus();
      const newCursorPos = start + before.length + textToInsert.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Tab para inserir 2 espaços
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;

      const newContent =
        content.substring(0, start) +
        '  ' +
        content.substring(end);

      onChange(newContent);

      setTimeout(() => {
        textarea.setSelectionRange(start + 2, start + 2);
      }, 0);
    }

    // Atalhos de teclado
    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'b':
          e.preventDefault();
          handleInsertFormat('**', '**', 'texto em negrito');
          break;
        case 'i':
          e.preventDefault();
          handleInsertFormat('*', '*', 'texto em itálico');
          break;
        case 'k':
          if (e.shiftKey) {
            e.preventDefault();
            handleInsertFormat('```\n', '\n```', 'código aqui');
          } else {
            e.preventDefault();
            handleInsertFormat('`', '`', 'código');
          }
          break;
        case 'h':
          e.preventDefault();
          handleInsertFormat('# ', '', 'Título');
          break;
        case 'l':
          e.preventDefault();
          handleInsertFormat('- ', '', 'item da lista');
          break;
        case 'u':
          e.preventDefault();
          handleInsertFormat('[', '](url)', 'texto do link');
          break;
        case 'q':
          e.preventDefault();
          handleInsertFormat('> ', '', 'citação');
          break;
      }
    }
  };

  return (
    <div className="editor-container">
      <textarea
        ref={textareaRef}
        className="editor-textarea"
        value={content}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Comece a escrever em Markdown..."
        spellCheck={false}
      />
    </div>
  );
};

export default Editor;