/**
 * Leitura dos arquivos que o usuário envia pelo botão "Importar" ou arrastando
 * para a lista. Nada aqui toca no banco: o resultado é entregue ao
 * DocumentsContext, que decide como gravar.
 */

/** Extensões aceitas. Fora daqui o arquivo é recusado com um motivo. */
const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd', '.mdx', '.txt'];

/** Valor do `accept` do <input type="file">, para o seletor do sistema já filtrar. */
export const IMPORT_ACCEPT = [...MARKDOWN_EXTENSIONS, 'text/markdown', 'text/plain'].join(',');

/**
 * 2 MB. Markdown escrito à mão não chega perto disso — o limite existe para
 * barrar um arquivo enorme arrastado por engano antes de ele virar uma linha
 * no banco.
 */
const MAX_FILE_SIZE = 2 * 1024 * 1024;

const MAX_FILES = 50;

export interface ParsedImport {
  title: string;
  content: string;
}

export interface SkippedImport {
  name: string;
  reason: string;
}

export interface ParseResult {
  parsed: ParsedImport[];
  skipped: SkippedImport[];
}

const hasMarkdownExtension = (name: string): boolean => {
  const lower = name.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

/** "notas/plano de aula.md" -> "plano de aula" */
const titleFromFileName = (name: string): string => {
  const withoutPath = name.split(/[\\/]/).pop() ?? name;
  const dot = withoutPath.lastIndexOf('.');
  // dot === 0 é um arquivo que só tem extensão (".md"): não sobra nome, e o
  // título sai do primeiro cabeçalho.
  const stem = dot === -1 ? withoutPath : withoutPath.slice(0, dot);
  return stem.trim();
};

/** Primeiro cabeçalho do arquivo, usado só quando o nome não serve como título. */
const firstHeading = (content: string): string => {
  const match = content.match(/^ {0,3}#{1,6} +(.+?) *#* *$/m);
  return match ? match[1].trim() : '';
};

const titleFor = (fileName: string, content: string): string =>
  titleFromFileName(fileName) || firstHeading(content) || 'Documento importado';

const formatSize = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Normaliza o texto lido do arquivo: tira o BOM que o Bloco de Notas escreve no
 * começo e converte CRLF em LF, para o conteúdo ficar igual ao que o editor
 * grava.
 */
const normalize = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

/**
 * Um arquivo binário renomeado para .txt vira texto cheio de caracteres de
 * substituição e bytes nulos. O nulo é o sinal mais confiável e não aparece em
 * markdown de verdade.
 */
const looksBinary = (text: string): boolean => text.includes('\u0000');

/** Lê os arquivos aceitos e separa os recusados, cada um com o motivo. */
export async function parseImportFiles(files: File[]): Promise<ParseResult> {
  const parsed: ParsedImport[] = [];
  const skipped: SkippedImport[] = [];

  const accepted = files.slice(0, MAX_FILES);
  for (const extra of files.slice(MAX_FILES)) {
    skipped.push({ name: extra.name, reason: `acima do limite de ${MAX_FILES} arquivos por vez` });
  }

  for (const file of accepted) {
    if (!hasMarkdownExtension(file.name)) {
      skipped.push({ name: file.name, reason: 'não é um arquivo markdown' });
      continue;
    }

    if (file.size > MAX_FILE_SIZE) {
      skipped.push({
        name: file.name,
        reason: `maior que ${formatSize(MAX_FILE_SIZE)}`,
      });
      continue;
    }

    let text: string;
    try {
      text = normalize(await file.text());
    } catch (err) {
      console.error(`Erro ao ler "${file.name}":`, err);
      skipped.push({ name: file.name, reason: 'não foi possível ler o arquivo' });
      continue;
    }

    if (looksBinary(text)) {
      skipped.push({ name: file.name, reason: 'não parece um arquivo de texto' });
      continue;
    }

    parsed.push({ title: titleFor(file.name, text), content: text });
  }

  return { parsed, skipped };
}

/**
 * Extrai os arquivos de um drop.
 *
 * Precisa rodar de forma síncrona dentro do handler: depois que o evento
 * termina, o `dataTransfer` é esvaziado pelo navegador. Percorre `items` em vez
 * de `files` porque só ali dá para saber que o usuário arrastou uma pasta —
 * pela lista de arquivos, uma pasta chega parecendo um arquivo sem extensão.
 */
export function filesFromDrop(dataTransfer: DataTransfer): {
  files: File[];
  directories: string[];
} {
  const files: File[] = [];
  const directories: string[] = [];

  if (dataTransfer.items && dataTransfer.items.length > 0) {
    for (const item of Array.from(dataTransfer.items)) {
      if (item.kind !== 'file') continue;

      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        directories.push(entry.name);
        continue;
      }

      const file = item.getAsFile();
      if (file) files.push(file);
    }

    return { files, directories };
  }

  return { files: Array.from(dataTransfer.files), directories };
}

/** true quando o que está sendo arrastado vem de fora do navegador. */
export const isFileDrag = (dataTransfer: DataTransfer | null): boolean =>
  !!dataTransfer && Array.from(dataTransfer.types).includes('Files');

/** O que a UI mostra depois que a importação termina. */
export interface ImportSummary {
  imported: number;
  skipped: SkippedImport[];
  /** id do primeiro documento criado, para abrir quando veio um só */
  firstDocumentId: string | null;
}
