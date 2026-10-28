import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { lintGutter, lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { ProjectIndex } from '../../latex/projectIndex';

/** LaTeX: modo "stex" do CodeMirror, com comentário de linha "%" e fechamento de $. */
const latex = StreamLanguage.define(stex);
const latexData = latex.data.of({
  commentTokens: { line: '%' },
  closeBrackets: { brackets: ['(', '[', '{', '$'] },
});

/** Cores ligadas às variáveis do tema do app (claro/escuro mudam juntos). */
const highlight = HighlightStyle.define([
  { tag: [tags.tagName, tags.keyword], color: 'var(--latex-command)' },
  { tag: [tags.atom, tags.special(tags.variableName), tags.variableName], color: 'var(--latex-env)' },
  { tag: tags.comment, color: 'var(--latex-comment)', fontStyle: 'italic' },
  { tag: [tags.number, tags.string], color: 'var(--latex-number)' },
  { tag: [tags.bracket, tags.brace, tags.squareBracket, tags.paren], color: 'var(--latex-bracket)' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--latex-math)' },
  { tag: tags.invalid, color: 'var(--latex-error)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' },
  '.cm-scroller': { fontFamily: "'JetBrains Mono', ui-monospace, monospace", lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '12px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-main)', color: 'var(--text-secondary)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--accent-transparent)', color: 'var(--text-primary)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-transparent) !important' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-transparent)', outline: '1px solid var(--accent)' },
  '.cm-searchMatch': { backgroundColor: 'rgba(250, 204, 21, 0.25)' },
  '.cm-searchMatch-selected': { backgroundColor: 'rgba(250, 204, 21, 0.5)' },
  '.cm-panels': { backgroundColor: 'var(--bg-card)', color: 'var(--text-primary)', borderColor: 'var(--border)' },
  '.cm-panel input, .cm-panel button': { fontFamily: 'inherit', fontSize: '13px' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: '#fff' },
  '.cm-completionDetail': { color: 'var(--text-secondary)', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--latex-error)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--latex-warning)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--latex-error)', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--latex-warning)', textUnderlineOffset: '3px' },
});

// --- Autocompletar ---

const cmd = (label: string, detail: string, template?: string): Completion =>
  template ? snippetCompletion(template, { label, detail, type: 'function' }) : { label, detail, type: 'function' };

const COMMANDS: Completion[] = [
  cmd('\\documentclass', 'classe do documento', '\\documentclass{${article}}'),
  cmd('\\usepackage', 'carregar pacote', '\\usepackage{${pacote}}'),
  cmd('\\section', 'seção', '\\section{${título}}'),
  cmd('\\subsection', 'subseção', '\\subsection{${título}}'),
  cmd('\\subsubsection', 'subsubseção', '\\subsubsection{${título}}'),
  cmd('\\chapter', 'capítulo', '\\chapter{${título}}'),
  cmd('\\paragraph', 'parágrafo', '\\paragraph{${título}}'),
  cmd('\\textbf', 'negrito', '\\textbf{${texto}}'),
  cmd('\\textit', 'itálico', '\\textit{${texto}}'),
  cmd('\\emph', 'ênfase', '\\emph{${texto}}'),
  cmd('\\underline', 'sublinhado', '\\underline{${texto}}'),
  cmd('\\texttt', 'monoespaçado', '\\texttt{${texto}}'),
  cmd('\\label', 'rótulo', '\\label{${rotulo}}'),
  cmd('\\ref', 'referência', '\\ref{${rotulo}}'),
  cmd('\\eqref', 'referência a equação', '\\eqref{${rotulo}}'),
  cmd('\\pageref', 'página do rótulo', '\\pageref{${rotulo}}'),
  cmd('\\cite', 'citação', '\\cite{${chave}}'),
  cmd('\\citep', 'citação (natbib)', '\\citep{${chave}}'),
  cmd('\\citet', 'citação textual (natbib)', '\\citet{${chave}}'),
  cmd('\\textcite', 'citação textual (biblatex)', '\\textcite{${chave}}'),
  cmd('\\parencite', 'citação entre parênteses (biblatex)', '\\parencite{${chave}}'),
  cmd('\\footnote', 'nota de rodapé', '\\footnote{${texto}}'),
  cmd('\\includegraphics', 'imagem', '\\includegraphics[width=${0.8}\\linewidth]{${arquivo}}'),
  cmd('\\input', 'incluir arquivo', '\\input{${arquivo}}'),
  cmd('\\include', 'incluir capítulo', '\\include{${arquivo}}'),
  cmd('\\caption', 'legenda', '\\caption{${legenda}}'),
  cmd('\\item', 'item de lista'),
  cmd('\\frac', 'fração', '\\frac{${a}}{${b}}'),
  cmd('\\sqrt', 'raiz', '\\sqrt{${x}}'),
  cmd('\\sum', 'somatório', '\\sum_{${i=1}}^{${n}}'),
  cmd('\\int', 'integral', '\\int_{${a}}^{${b}}'),
  cmd('\\lim', 'limite', '\\lim_{${x \\to 0}}'),
  cmd('\\mathbb', 'conjunto (ℝ, ℕ...)', '\\mathbb{${R}}'),
  cmd('\\mathrm', 'texto reto em fórmula', '\\mathrm{${texto}}'),
  cmd('\\text', 'texto em fórmula', '\\text{${texto}}'),
  cmd('\\left(', 'parênteses ajustáveis', '\\left( ${} \\right)'),
  cmd('\\maketitle', 'título'),
  cmd('\\tableofcontents', 'sumário'),
  cmd('\\newpage', 'nova página'),
  cmd('\\centering', 'centralizar'),
  cmd('\\hline', 'linha de tabela'),
  cmd('\\toprule', 'booktabs'),
  cmd('\\midrule', 'booktabs'),
  cmd('\\bottomrule', 'booktabs'),
  cmd('\\bibliography', 'arquivo .bib (BibTeX)', '\\bibliography{${referencias}}'),
  cmd('\\bibliographystyle', 'estilo (BibTeX)', '\\bibliographystyle{${plain}}'),
  cmd('\\addbibresource', 'arquivo .bib (biblatex)', '\\addbibresource{${referencias.bib}}'),
  cmd('\\printbibliography', 'bibliografia (biblatex)'),
  cmd('\\newcommand', 'novo comando', '\\newcommand{\\${nome}}{${definição}}'),
  ...['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'theta', 'lambda', 'mu', 'pi', 'sigma', 'phi', 'omega', 'infty', 'partial', 'nabla', 'cdot', 'times', 'leq', 'geq', 'neq', 'approx', 'rightarrow', 'Rightarrow', 'in', 'forall', 'exists'].map(
    (name) => ({ label: `\\${name}`, detail: 'símbolo', type: 'constant' }) as Completion
  ),
];

const ENVIRONMENTS: Record<string, string> = {
  itemize: '\\begin{itemize}\n\t\\item ${}\n\\end{itemize}',
  enumerate: '\\begin{enumerate}\n\t\\item ${}\n\\end{enumerate}',
  description: '\\begin{description}\n\t\\item[${termo}] ${}\n\\end{description}',
  figure: '\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{${arquivo}}\n\t\\caption{${legenda}}\n\t\\label{fig:${rotulo}}\n\\end{figure}',
  table: '\\begin{table}[htbp]\n\t\\centering\n\t\\caption{${legenda}}\n\t\\label{tab:${rotulo}}\n\t\\begin{tabular}{${lcr}}\n\t\t${} \\\\\n\t\\end{tabular}\n\\end{table}',
  tabular: '\\begin{tabular}{${lcr}}\n\t${} \\\\\n\\end{tabular}',
  equation: '\\begin{equation}\n\t${}\n\t\\label{eq:${rotulo}}\n\\end{equation}',
  'equation*': '\\begin{equation*}\n\t${}\n\\end{equation*}',
  align: '\\begin{align}\n\t${} &= ${} \\\\\n\\end{align}',
  'align*': '\\begin{align*}\n\t${} &= ${}\n\\end{align*}',
  center: '\\begin{center}\n\t${}\n\\end{center}',
  abstract: '\\begin{abstract}\n\t${}\n\\end{abstract}',
  document: '\\begin{document}\n${}\n\\end{document}',
  minipage: '\\begin{minipage}{${0.45}\\linewidth}\n\t${}\n\\end{minipage}',
  verbatim: '\\begin{verbatim}\n${}\n\\end{verbatim}',
  quote: '\\begin{quote}\n\t${}\n\\end{quote}',
  frame: '\\begin{frame}{${título}}\n\t${}\n\\end{frame}',
};

const ENV_COMPLETIONS: Completion[] = Object.entries(ENVIRONMENTS).map(([name, template]) =>
  snippetCompletion(template, { label: `\\begin{${name}}`, detail: 'ambiente', type: 'class' })
);

function latexCompletions(getIndex: () => ProjectIndex) {
  return (context: CompletionContext): CompletionResult | null => {
    // Dentro de \ref{...}, \cite{...}, \includegraphics{...} etc.
    const arg = context.matchBefore(/\\([A-Za-z]+\*?)(\[[^\]]*\])?\{[^}]*$/);
    if (arg) {
      const command = arg.text.match(/^\\([A-Za-z]+)/)![1]!;
      const braceAt = arg.from + arg.text.lastIndexOf('{') + 1;
      // Vários itens separados por vírgula (\cite{a,b}).
      const afterComma = arg.text.lastIndexOf(',');
      const from = afterComma > arg.text.lastIndexOf('{') ? arg.from + afterComma + 1 : braceAt;
      const index = getIndex();
      let options: Completion[] = [];
      if (/^(ref|eqref|pageref|autoref|cref|Cref|nameref)$/.test(command)) {
        options = index.labels.map((label) => ({ label, type: 'variable', detail: 'rótulo' }));
      } else if (/cite/i.test(command)) {
        options = index.citations.map((label) => ({ label, type: 'variable', detail: 'referência' }));
      } else if (command === 'includegraphics') {
        options = index.files.filter((f) => /\.(png|jpe?g|pdf|eps)$/i.test(f)).map((label) => ({ label, type: 'text', detail: 'imagem' }));
      } else if (command === 'input' || command === 'include' || command === 'subfile') {
        options = index.files
          .filter((f) => f.toLowerCase().endsWith('.tex'))
          .map((f) => ({ label: command === 'include' ? f.replace(/\.tex$/i, '') : f, type: 'text', detail: 'arquivo' }));
      } else if (command === 'begin') {
        options = Object.keys(ENVIRONMENTS).map((label) => ({ label, type: 'class', detail: 'ambiente' }));
      } else if (command === 'addbibresource' || command === 'bibliography') {
        options = index.files
          .filter((f) => f.toLowerCase().endsWith('.bib'))
          .map((f) => ({ label: command === 'bibliography' ? f.replace(/\.bib$/i, '') : f, type: 'text', detail: 'bibliografia' }));
      }
      return options.length ? { from, options, validFor: /^[^,}]*$/ } : null;
    }

    const word = context.matchBefore(/\\[A-Za-z]*\*?/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    return { from: word.from, options: [...ENV_COMPLETIONS, ...COMMANDS], validFor: /^\\[A-Za-z]*$/ };
  };
}

// --- Atalhos de formatação ---

const wrapSelection = (before: string, after: string) => (view: EditorView) => {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      const start = range.from + before.length;
      return {
        changes: { from: range.from, to: range.to, insert: `${before}${text}${after}` },
        range: EditorSelection.range(start, start + text.length),
      };
    })
  );
  return true;
};

export interface EditorCallbacks {
  onChange: (text: string) => void;
  onCompile: () => void;
  onSave: () => void;
  getIndex: () => ProjectIndex;
}

/** Todas as extensões do editor LaTeX. */
export function latexExtensions(callbacks: () => EditorCallbacks): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    latex,
    latexData,
    syntaxHighlighting(highlight),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ override: [latexCompletions(() => callbacks().getIndex())], icons: false }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    lintGutter(),
    EditorView.lineWrapping,
    theme,
    keymap.of([
      { key: 'Mod-Enter', run: () => (callbacks().onCompile(), true), preventDefault: true },
      { key: 'Mod-s', run: () => (callbacks().onSave(), true), preventDefault: true },
      { key: 'Mod-b', run: wrapSelection('\\textbf{', '}') },
      { key: 'Mod-i', run: wrapSelection('\\textit{', '}') },
      { key: 'Mod-/', run: toggleComment },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) callbacks().onChange(update.state.doc.toString());
    }),
  ];
}
