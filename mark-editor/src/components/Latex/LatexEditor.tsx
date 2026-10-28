import { useEffect, useRef } from 'react';
import { setDiagnostics, type Diagnostic as LintDiagnostic } from '@codemirror/lint';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { CompileDiagnostic } from '../../lib/api';
import { latexExtensions, type EditorCallbacks } from './latexLanguage';

/**
 * Editor de código LaTeX (CodeMirror 6). Carregado sob demanda: quem só usa
 * Markdown não baixa este pedaço.
 *
 * Um EditorView só; cada arquivo guarda o próprio EditorState, então desfazer
 * e refazer continuam funcionando ao voltar para um arquivo.
 */

export interface GotoRequest {
  path: string;
  line: number;
  /** Muda a cada clique, para repetir o mesmo destino. */
  nonce: number;
}

interface LatexEditorProps extends EditorCallbacks {
  path: string;
  initialText: string;
  diagnostics: CompileDiagnostic[];
  gotoRequest: GotoRequest | null;
}

const toLint = (state: EditorState, diagnostics: CompileDiagnostic[]): LintDiagnostic[] =>
  diagnostics
    .filter((d) => d.line !== null && d.severity !== 'info')
    .map((d) => {
      const line = state.doc.line(Math.min(Math.max(1, d.line!), state.doc.lines));
      return {
        from: line.from,
        to: Math.max(line.from, line.to),
        severity: d.severity === 'error' ? 'error' : 'warning',
        message: d.message,
        source: d.source,
      };
    });

const LatexEditor: React.FC<LatexEditorProps> = ({ path, initialText, diagnostics, gotoRequest, ...callbacks }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const currentPath = useRef(path);
  // As extensões leem sempre os callbacks mais novos (sem recriar o editor).
  const callbacksRef = useRef<EditorCallbacks>(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  });

  const extensions = useRef(latexExtensions(() => callbacksRef.current));

  // Cria o editor uma vez.
  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({ doc: initialText, extensions: extensions.current }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Só na montagem: trocas de arquivo são tratadas abaixo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Troca de arquivo: guarda o estado do atual e restaura (ou cria) o do novo.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || currentPath.current === path) return;
    states.current.set(currentPath.current, view.state);
    currentPath.current = path;
    const saved = states.current.get(path);
    view.setState(saved && saved.doc.toString() === initialText ? saved : EditorState.create({ doc: initialText, extensions: extensions.current }));
    view.focus();
    // initialText só importa no momento da troca.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Texto alterado por fora do editor (ex.: troca do motor no comentário
  // mágico): aplica como uma edição, que entra no desfazer.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || currentPath.current !== path) return;
    const doc = view.state.doc;
    if (doc.length === initialText.length && doc.toString() === initialText) return;
    view.dispatch({ changes: { from: 0, to: doc.length, insert: initialText } });
  }, [initialText, path]);

  // Erros e avisos da última compilação, sublinhados no arquivo aberto.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch(setDiagnostics(view.state, toLint(view.state, diagnostics)));
  }, [diagnostics, path]);

  // Clique num erro: vai para a linha.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !gotoRequest || gotoRequest.path !== path) return;
    const line = view.state.doc.line(Math.min(Math.max(1, gotoRequest.line), view.state.doc.lines));
    view.dispatch({ selection: EditorSelection.cursor(line.from), effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    view.focus();
  }, [gotoRequest, path]);

  return <div className="latex-editor" ref={hostRef} data-testid="latex-editor" />;
};

export default LatexEditor;
