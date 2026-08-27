import React from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Mermaid from '../Mermaid/Mermaid';
import './Preview.css';

/**
 * Um bloco ```mermaid chega aqui como <pre><code class="language-mermaid">.
 * Trocamos no <pre> e não no <code> porque o SVG do diagrama é conteúdo de
 * bloco, e um <div> dentro de <pre> seria HTML inválido.
 */
function mermaidSource(children: React.ReactNode): string | null {
  const code = React.Children.toArray(children)[0];
  if (!React.isValidElement(code)) return null;

  const { className, children: content } = code.props as {
    className?: string;
    children?: React.ReactNode;
  };

  if (!className?.split(' ').includes('language-mermaid')) return null;

  return String(content ?? '');
}

/**
 * Tabelas, ~riscado~, listas de tarefas e links automáticos são GitHub
 * Flavored Markdown, que o react-markdown não traz por padrão.
 */
const remarkPlugins = [remarkGfm];

const markdownComponents: Components = {
  pre({ children, ...props }) {
    const chart = mermaidSource(children);
    if (chart === null) return <pre {...props}>{children}</pre>;
    return <Mermaid chart={chart} />;
  },
};

interface PreviewProps {
  content: string;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

const Preview: React.FC<PreviewProps> = ({ content, isFullscreen = false, onToggleFullscreen }) => {
  return (
    <div className={`preview-container${isFullscreen ? ' preview-fullscreen' : ''}`}>
      {onToggleFullscreen && (
        <button
          className="preview-fullscreen-btn"
          onClick={onToggleFullscreen}
          aria-label={isFullscreen ? 'Sair da tela cheia (Esc)' : 'Visualizar em tela cheia (Ctrl+Shift+F)'}
          data-tooltip={isFullscreen ? 'Sair da tela cheia (Esc)' : 'Tela cheia (Ctrl+Shift+F)'}
        >
          {isFullscreen ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3v3a2 2 0 0 1-2 2H3"></path>
              <path d="M21 8h-3a2 2 0 0 1-2-2V3"></path>
              <path d="M3 16h3a2 2 0 0 1 2 2v3"></path>
              <path d="M16 21v-3a2 2 0 0 1 2-2h3"></path>
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3"></path>
              <path d="M21 8V5a2 2 0 0 0-2-2h-3"></path>
              <path d="M3 16v3a2 2 0 0 0 2 2h3"></path>
              <path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>
            </svg>
          )}
        </button>
      )}

      <div className="preview-content">
        {content ? (
          <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
            {content}
          </ReactMarkdown>
        ) : (
          <div className="preview-empty">
            <p>O preview aparecerá aqui</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Preview;
