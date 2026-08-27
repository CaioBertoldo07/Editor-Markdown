import { useRef, useEffect, useMemo, memo } from 'react';
import { computeFenceFlags, tokenizeLine } from '../../utils/markdownHighlight';
import './Editor.css';

interface MirrorLineProps {
  number: number;
  text: string;
  insideFence: boolean;
}

/**
 * Uma linha do espelho: o número na calha e o texto já colorido.
 *
 * As props são todas primitivas de propósito — passar o array de tokens pronto
 * quebraria o memo, porque seria um array novo a cada render. Tokenizar uma
 * linha é barato; reconciliar milhares delas a cada tecla não é.
 */
const MirrorLine = memo(({ number, text, insideFence }: MirrorLineProps) => {
  const tokens = tokenizeLine(text, insideFence);

  return (
    <div className="editor-line">
      <span className="editor-line-number">{number}</span>
      {/* Linha vazia não gera caixa de linha; o espaço zero-width gera. */}
      {tokens.length === 0
        ? '​'
        : tokens.map((token, i) => (
            <span key={i} className={token.kind ? `md-${token.kind}` : undefined}>
              {token.text}
            </span>
          ))}
    </div>
  );
});

interface EditorProps {
  content: string;
  onChange: (content: string) => void;
  onInsertFormat?: (callback: (before: string, after: string, placeholder?: string) => void) => void;
}

const Editor: React.FC<EditorProps> = ({ content, onChange, onInsertFormat }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const linesRef = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => content.split('\n'), [content]);

  // Único estado que atravessa linhas: se a linha está dentro de ``` ou ~~~.
  const fenceFlags = useMemo(() => computeFenceFlags(lines), [lines]);

  // Largura da calha: cresce junto com a quantidade de dígitos, com um mínimo
  // de 2 para não ficar apertada em documentos curtos.
  const digits = Math.max(2, String(lines.length).length);

  /** A numeração vive numa camada separada, então precisa rolar junto. */
  const syncScroll = () => {
    if (linesRef.current && textareaRef.current) {
      linesRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // Trocar de documento reposiciona o textarea sem disparar onScroll.
  useEffect(syncScroll, [content]);

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
    <div
      className="editor-container"
      style={{ '--editor-digits': digits } as React.CSSProperties}
    >
      <div className="editor-gutter-bg" />

      {/*
        Espelho do texto, sobreposto ao textarea e invisível (color: transparent).
        Ele existe só para o navegador calcular onde cada linha começa: como usa
        a mesma fonte e a mesma largura, uma linha longa quebra no mesmo ponto
        que no textarea, e o número fica alinhado ao topo dela — sem nenhuma
        medição manual.
      */}
      <div className="editor-lines" ref={linesRef} aria-hidden="true">
        {lines.map((line, index) => (
          <MirrorLine
            key={index}
            number={index + 1}
            text={line}
            insideFence={fenceFlags[index]}
          />
        ))}
      </div>

      <textarea
        ref={textareaRef}
        className="editor-textarea"
        value={content}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onScroll={syncScroll}
        placeholder="Comece a escrever em Markdown..."
        spellCheck={false}
      />
    </div>
  );
};

export default Editor;