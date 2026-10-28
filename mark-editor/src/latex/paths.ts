/**
 * Regras de caminhos e tipos de arquivo dos projetos LaTeX.
 *
 * ESTE ARQUIVO É IDÊNTICO em latex-compiler/src/paths.ts, api/src/latex/paths.ts
 * e mark-editor/src/latex/paths.ts (um teste da API confere). Mude os três juntos.
 *
 * Caminho válido: relativo, separado por "/", sem "." nem ".." como segmento,
 * sem segmento oculto (começando com "."), sem barra invertida, sem letra de
 * unidade, sem caracteres de controle. Assim nenhum caminho sai do diretório
 * do projeto, nem no navegador, nem na API, nem no compilador.
 */

export const PATH_MAX_LENGTH = 200;
export const PATH_MAX_DEPTH = 8;
const SEGMENT_MAX_LENGTH = 80;

/** Letras e números de qualquer idioma, espaço e alguns sinais comuns em nomes de arquivo. */
const SEGMENT_CHARS = /^[\p{L}\p{N}_\-+.,()@ ]+$/u;

/** Arquivos de texto: editáveis no navegador, gravados como texto (UTF-8). */
export const TEXT_EXTENSIONS = [
  'tex', 'ltx', 'sty', 'cls', 'bib', 'bst', 'bbx', 'cbx', 'lbx', 'dbx', 'def', 'cfg', 'clo', 'fd',
  'ist', 'bbl', 'txt', 'md', 'csv', 'tsv', 'dat', 'tikz', 'pgf', 'lua',
] as const;

/** Arquivos binários aceitos (imagens e fontes usadas pelo documento). */
export const BINARY_EXTENSIONS = ['png', 'jpg', 'jpeg', 'pdf', 'eps', 'ttf', 'otf'] as const;

/**
 * Nomes recusados em qualquer pasta: configurações que o latexmk, o Biber ou o
 * kpathsea leriam do diretório do projeto (o latexmkrc é código Perl).
 */
const FORBIDDEN_NAMES = new Set(['latexmkrc', 'biber.conf', 'texmf.cnf', 'mktex.cnf', 'kpathsea.cnf']);

export type FileKind = 'text' | 'binary';

export class InvalidPathError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export const extensionOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
};

/** Tipo pelo nome; null = extensão não aceita. */
export function fileKindOf(path: string): FileKind | null {
  const ext = extensionOf(path);
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) return 'text';
  if ((BINARY_EXTENSIONS as readonly string[]).includes(ext)) return 'binary';
  return null;
}

/**
 * Normaliza (NFC) e valida um caminho de arquivo do projeto. Devolve o caminho
 * normalizado ou lança InvalidPathError com o motivo (em português, para a UI).
 */
export function normalizeProjectPath(input: string): string {
  if (typeof input !== 'string') throw new InvalidPathError('caminho inválido');
  const path = input.normalize('NFC');
  if (path.length === 0) throw new InvalidPathError('caminho vazio');
  if (path.length > PATH_MAX_LENGTH) throw new InvalidPathError(`caminho com mais de ${PATH_MAX_LENGTH} caracteres`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new InvalidPathError('caminho com caracteres de controle');
  if (path.includes('\\')) throw new InvalidPathError('use "/" para separar pastas');
  if (path.startsWith('/')) throw new InvalidPathError('caminho absoluto não é permitido');
  if (/^[A-Za-z]:/.test(path)) throw new InvalidPathError('caminho absoluto não é permitido');

  const segments = path.split('/');
  if (segments.length > PATH_MAX_DEPTH) throw new InvalidPathError(`mais de ${PATH_MAX_DEPTH} níveis de pasta`);
  for (const segment of segments) {
    if (segment === '') throw new InvalidPathError('caminho com pasta vazia');
    if (segment === '.' || segment === '..') throw new InvalidPathError('caminho não pode usar "." ou ".."');
    if (segment.startsWith('.')) throw new InvalidPathError('arquivos e pastas ocultos não são permitidos');
    if (segment !== segment.trim()) throw new InvalidPathError('nome não pode começar ou terminar com espaço');
    if (segment.length > SEGMENT_MAX_LENGTH) throw new InvalidPathError(`nome com mais de ${SEGMENT_MAX_LENGTH} caracteres`);
    if (!SEGMENT_CHARS.test(segment)) throw new InvalidPathError(`caractere não permitido em "${segment}"`);
  }

  const base = segments[segments.length - 1]!.toLowerCase();
  if (FORBIDDEN_NAMES.has(base)) throw new InvalidPathError(`"${base}" não é aceito por segurança`);
  if (fileKindOf(path) === null) {
    const ext = extensionOf(path);
    throw new InvalidPathError(ext ? `arquivos .${ext} não são aceitos` : 'arquivo sem extensão');
  }
  return path;
}

/** Versão que não lança: null quando inválido. */
export function safeProjectPath(input: string): string | null {
  try {
    return normalizeProjectPath(input);
  } catch {
    return null;
  }
}
