/**
 * Leitura de projetos LaTeX enviados pelo usuário: um .zip (estrutura de pastas
 * preservada) ou arquivos soltos (.tex, .bib, .sty, imagens...).
 *
 * Tudo aqui é entrada NÃO confiável. A API e o compilador validam de novo cada
 * caminho e cada arquivo; este módulo existe para recusar cedo, explicar o
 * motivo ao usuário e não travar o navegador com um ZIP malicioso:
 *   - caminhos são validados pelas mesmas regras da API (sem "..", sem
 *     absolutos, sem ocultos, sem latexmkrc...);
 *   - links simbólicos dentro do ZIP são ignorados;
 *   - limites de quantidade, de tamanho por arquivo e de tamanho total, com a
 *     descompressão interrompida assim que passa do limite (ZIP bomb).
 */
import { fileKindOf, normalizeProjectPath, InvalidPathError, PATH_MAX_LENGTH } from './paths';

export const LIMITS = {
  zipMaxBytes: 50 * 1024 * 1024,
  maxEntries: 1000,
  maxFiles: 300,
  textMaxBytes: 1_000_000,
  binaryMaxBytes: 4 * 1024 * 1024,
  totalMaxBytes: 40 * 1024 * 1024,
  /** Razão descompactado/compactado acima disso, em arquivo grande, é tratada como bomba. */
  maxRatio: 200,
} as const;

export interface ImportedFile {
  path: string;
  bytes: Uint8Array;
}

export interface SkippedEntry {
  name: string;
  reason: string;
}

export interface ProjectImport {
  files: ImportedFile[];
  skipped: SkippedEntry[];
  /** Arquivo principal sugerido (null se nenhum .tex tem \documentclass). */
  mainFile: string | null;
  /** Todos os .tex com \documentclass, para o usuário escolher se houver mais de um. */
  mainCandidates: string[];
}

export class ProjectImportError extends Error {}

/** Extensões de arquivos gerados pela compilação: vêm em ZIPs, mas não fazem parte do projeto. */
const GENERATED = new Set([
  'aux', 'log', 'out', 'toc', 'lof', 'lot', 'fls', 'fdb_latexmk', 'synctex', 'gz', 'blg', 'bcf', 'run', 'xml',
  'nav', 'snm', 'vrb', 'idx', 'ilg', 'ind', 'xdv', 'dvi',
]);

const formatMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

const decoder = new TextDecoder('utf-8');

/** \documentclass fora de comentário. */
const hasDocumentClass = (text: string) => /^[^%\n]*\\documentclass\b/m.test(text);

function pickMain(files: ImportedFile[]): { mainFile: string | null; mainCandidates: string[] } {
  const candidates = files
    .filter((f) => f.path.toLowerCase().endsWith('.tex') && hasDocumentClass(decoder.decode(f.bytes)))
    .map((f) => f.path)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const preferred =
    candidates.find((p) => p.toLowerCase() === 'main.tex') ??
    candidates.find((p) => !p.includes('/')) ??
    candidates[0] ??
    null;
  return { mainFile: preferred, mainCandidates: candidates };
}

/** Confere o caminho e o tamanho de um arquivo; devolve o motivo da recusa ou null. */
function rejectReason(path: string, size: number): string | null {
  const kind = fileKindOf(path);
  if (!kind) {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return GENERATED.has(ext) ? 'arquivo gerado pela compilação (não é necessário)' : `arquivos .${ext} não são aceitos`;
  }
  const max = kind === 'text' ? LIMITS.textMaxBytes : LIMITS.binaryMaxBytes;
  if (size > max) return `maior que ${formatMB(max)}`;
  return null;
}

/** Texto precisa ser UTF-8 sem bytes nulos (a API recusa o contrário). */
function textProblem(path: string, bytes: Uint8Array): string | null {
  if (fileKindOf(path) !== 'text') return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\u0000')) return 'não parece um arquivo de texto';
  } catch {
    return 'não está em UTF-8 (converta a codificação do arquivo)';
  }
  return null;
}

/** Remove a pasta raiz única (ex.: "meu-projeto/main.tex" -> "main.tex"). */
function stripCommonRoot(paths: string[]): (p: string) => string {
  const roots = new Set(paths.map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '')));
  if (roots.size !== 1) return (p) => p;
  const [root] = [...roots];
  if (!root) return (p) => p;
  return (p) => p.slice(root.length + 1);
}

type ZipEntry = {
  name: string;
  /** Nome como está no ZIP, antes da limpeza do JSZip (que tira "../" do início). */
  unsafeOriginalName?: string;
  dir: boolean;
  unixPermissions: number | string | null;
  _data?: { uncompressedSize?: number; compressedSize?: number };
  internalStream(type: 'uint8array'): {
    on(event: 'data', cb: (chunk: Uint8Array) => void): unknown;
    on(event: 'end', cb: () => void): unknown;
    on(event: 'error', cb: (err: Error) => void): unknown;
    pause(): unknown;
    resume(): unknown;
  };
};

/** Descompacta parando assim que passa de `max` bytes (o tamanho declarado no ZIP pode mentir). */
function readLimited(entry: ZipEntry, max: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    const stream = entry.internalStream('uint8array');
    stream.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > max) {
        done = true;
        stream.pause();
        reject(new ProjectImportError('too_large'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
    stream.on('end', () => {
      if (done) return;
      done = true;
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      resolve(out);
    });
    stream.resume();
  });
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export async function readProjectZip(zipFile: Blob): Promise<ProjectImport> {
  if (zipFile.size > LIMITS.zipMaxBytes) throw new ProjectImportError(`O ZIP passa de ${formatMB(LIMITS.zipMaxBytes)}.`);
  const { default: JSZip } = await import('jszip');
  let zip;
  try {
    zip = await JSZip.loadAsync(await zipFile.arrayBuffer(), { checkCRC32: true });
  } catch {
    throw new ProjectImportError('Não foi possível abrir o ZIP (arquivo corrompido ou não é um ZIP).');
  }

  const entries = Object.values(zip.files) as unknown as ZipEntry[];
  if (entries.length > LIMITS.maxEntries) {
    throw new ProjectImportError(`O ZIP tem mais de ${LIMITS.maxEntries} itens.`);
  }

  const skipped: SkippedEntry[] = [];
  const candidates: ZipEntry[] = [];
  // Sempre o nome ORIGINAL: um "../x.tex" limpo pelo JSZip para "x.tex" tem de
  // ser recusado, não importado com outro nome.
  const nameOf = (entry: ZipEntry) => (entry.unsafeOriginalName ?? entry.name).replace(/\\/g, '/');

  for (const entry of entries) {
    if (entry.dir) continue;
    const name = nameOf(entry);
    // Lixo de sistemas operacionais, sem aviso.
    if (name.startsWith('__MACOSX/') || /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(name)) continue;
    const perms = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0;
    if ((perms & S_IFMT) === S_IFLNK) {
      skipped.push({ name, reason: 'links simbólicos não são importados' });
      continue;
    }
    candidates.push(entry);
  }

  const strip = stripCommonRoot(candidates.map(nameOf));
  const files: ImportedFile[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const entry of candidates) {
    const original = nameOf(entry);
    if (GENERATED.has(original.slice(original.lastIndexOf('.') + 1).toLowerCase())) {
      skipped.push({ name: original, reason: 'arquivo gerado pela compilação (não é necessário)' });
      continue;
    }
    let path: string;
    try {
      path = normalizeProjectPath(strip(original));
    } catch (err) {
      const reason = err instanceof InvalidPathError ? err.reason : 'caminho inválido';
      // Arquivos ocultos e auxiliares são comuns em ZIPs: o motivo fica, sem alarme.
      skipped.push({ name: original.slice(0, PATH_MAX_LENGTH), reason });
      continue;
    }
    if (seen.has(path.toLowerCase())) {
      skipped.push({ name: original, reason: 'nome repetido (só muda maiúsculas/minúsculas)' });
      continue;
    }

    const declared = entry._data?.uncompressedSize ?? 0;
    const compressed = entry._data?.compressedSize ?? 0;
    const reason = rejectReason(path, declared);
    if (reason) {
      skipped.push({ name: original, reason });
      continue;
    }
    if (compressed > 0 && declared > 1024 * 1024 && declared / compressed > LIMITS.maxRatio) {
      throw new ProjectImportError('O ZIP parece malicioso (compressão anormal). Importação cancelada.');
    }
    if (files.length >= LIMITS.maxFiles) {
      throw new ProjectImportError(`O projeto passa de ${LIMITS.maxFiles} arquivos.`);
    }

    const max = fileKindOf(path) === 'text' ? LIMITS.textMaxBytes : LIMITS.binaryMaxBytes;
    let bytes: Uint8Array;
    try {
      bytes = await readLimited(entry, max);
    } catch (err) {
      if (err instanceof ProjectImportError) {
        // Tamanho real maior que o declarado: o cabeçalho mentiu.
        throw new ProjectImportError('O ZIP parece malicioso (tamanho real diferente do declarado). Importação cancelada.');
      }
      skipped.push({ name: original, reason: 'não foi possível descompactar' });
      continue;
    }
    total += bytes.length;
    if (total > LIMITS.totalMaxBytes) {
      throw new ProjectImportError(`O conteúdo descompactado passa de ${formatMB(LIMITS.totalMaxBytes)}.`);
    }
    const problem = textProblem(path, bytes);
    if (problem) {
      skipped.push({ name: original, reason: problem });
      continue;
    }
    seen.add(path.toLowerCase());
    files.push({ path, bytes });
  }

  if (!files.some((f) => f.path.toLowerCase().endsWith('.tex'))) {
    throw new ProjectImportError('O ZIP não tem nenhum arquivo .tex.');
  }
  return { files, skipped, ...pickMain(files) };
}

/** Arquivos soltos escolhidos juntos viram um projeto só (sem pastas). */
export async function readProjectFiles(list: File[]): Promise<ProjectImport> {
  const files: ImportedFile[] = [];
  const skipped: SkippedEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const file of list) {
    let path: string;
    try {
      path = normalizeProjectPath(file.name);
    } catch (err) {
      skipped.push({ name: file.name, reason: err instanceof InvalidPathError ? err.reason : 'nome inválido' });
      continue;
    }
    const reason = rejectReason(path, file.size);
    if (reason) {
      skipped.push({ name: file.name, reason });
      continue;
    }
    if (seen.has(path.toLowerCase())) {
      skipped.push({ name: file.name, reason: 'nome repetido' });
      continue;
    }
    if (files.length >= LIMITS.maxFiles) {
      skipped.push({ name: file.name, reason: `acima de ${LIMITS.maxFiles} arquivos` });
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    total += bytes.length;
    if (total > LIMITS.totalMaxBytes) throw new ProjectImportError(`Os arquivos passam de ${formatMB(LIMITS.totalMaxBytes)}.`);
    const problem = textProblem(path, bytes);
    if (problem) {
      skipped.push({ name: file.name, reason: problem });
      continue;
    }
    seen.add(path.toLowerCase());
    files.push({ path, bytes });
  }
  if (!files.some((f) => f.path.toLowerCase().endsWith('.tex'))) {
    throw new ProjectImportError('Nenhum arquivo .tex entre os escolhidos.');
  }
  return { files, skipped, ...pickMain(files) };
}

const LATEX_SOURCE = /\.(tex|ltx|bib|sty|cls|bst|bbx|cbx|lbx|dbx|def|cfg|clo|fd|ist|bbl|tikz|pgf|lua)$/i;
const LATEX_ASSET = /\.(png|jpe?g|pdf|eps|ttf|otf|csv|tsv|dat)$/i;

/**
 * Separa o que veio do seletor/arraste: .zip e arquivos LaTeX vão para
 * projetos; o resto segue o fluxo Markdown de antes. Imagens e dados só vão
 * para o projeto quando acompanham um .tex.
 */
export function splitLatexUploads(files: File[]): { zips: File[]; latex: File[]; others: File[] } {
  const zips = files.filter((f) => /\.zip$/i.test(f.name));
  const rest = files.filter((f) => !/\.zip$/i.test(f.name));
  const hasTex = rest.some((f) => /\.(tex|ltx)$/i.test(f.name));
  const latex = rest.filter((f) => LATEX_SOURCE.test(f.name) || (hasTex && LATEX_ASSET.test(f.name)));
  const others = rest.filter((f) => !latex.includes(f));
  return { zips, latex, others };
}

/** Título do projeto a partir do arquivo ("Minha Tese.zip" -> "Minha Tese"). */
export const projectTitle = (name: string) => name.replace(/\.(zip|tex|ltx)$/i, '').trim() || 'Projeto LaTeX';
