import type { Document, Folder } from '../types/document';

/**
 * Caracteres proibidos em nome de arquivo no Windows (< > : " / \ | ? *) mais
 * os de controle. O título do documento é texto livre, então precisa passar por
 * aqui antes de virar nome de arquivo.
 */
// eslint-disable-next-line no-control-regex
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;

/** Nomes reservados do Windows: CON, PRN, AUX, NUL, COM1-9, LPT1-9. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MAX_NAME_LENGTH = 100;

export function toFileName(title: string, extension = '.md'): string {
  let name = title
    .replace(INVALID_FILENAME_CHARS, '-')
    // O Windows recusa nome terminado em ponto ou espaço.
    .replace(/[. ]+$/, '')
    .trim();

  if (RESERVED_NAMES.test(name)) name = `_${name}`;
  if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH).trim();
  if (!name) name = 'sem-titulo';

  return name + extension;
}

/**
 * Dois documentos podem ter o mesmo título — dentro de um zip isso faria um
 * sobrescrever o outro em silêncio. Numera os repetidos: "nota.md",
 * "nota (2).md", "nota (3).md".
 */
function uniqueName(desired: string, taken: Set<string>): string {
  if (!taken.has(desired.toLowerCase())) {
    taken.add(desired.toLowerCase());
    return desired;
  }

  const dot = desired.lastIndexOf('.');
  const base = dot === -1 ? desired : desired.slice(0, dot);
  const ext = dot === -1 ? '' : desired.slice(dot);

  let n = 2;
  let candidate = `${base} (${n})${ext}`;
  while (taken.has(candidate.toLowerCase())) {
    n += 1;
    candidate = `${base} (${n})${ext}`;
  }

  taken.add(candidate.toLowerCase());
  return candidate;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Sem revoke o blob fica na memória até a aba fechar. O timeout dá tempo
  // do navegador começar o download antes da URL deixar de existir.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Baixa um documento como arquivo .md. */
export function downloadDocument(doc: Document): void {
  const blob = new Blob([doc.content], { type: 'text/markdown;charset=utf-8' });
  saveBlob(blob, toFileName(doc.title));
}

/**
 * Baixa os documentos de uma pasta como um único .zip.
 * O JSZip só é carregado aqui, na primeira vez que alguém baixa uma pasta.
 */
export async function downloadFolderAsZip(folder: Folder, docs: Document[]): Promise<void> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const taken = new Set<string>();

  for (const doc of docs) {
    zip.file(uniqueName(toFileName(doc.title), taken), doc.content);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  saveBlob(blob, toFileName(folder.name, '.zip'));
}
