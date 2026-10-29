/** O que existe no projeto, para completar \ref, \cite e caminhos no editor. */
export interface ProjectIndex {
  labels: string[];
  citations: string[];
  files: string[];
}

/** Extrai rótulos dos .tex e chaves dos .bib. */
export function buildIndex(files: Array<{ path: string; text?: string }>): ProjectIndex {
  const labels = new Set<string>();
  const citations = new Set<string>();
  for (const file of files) {
    if (!file.text) continue;
    if (file.path.toLowerCase().endsWith('.bib')) {
      for (const m of file.text.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)) citations.add(m[1]!);
    } else if (/\.(tex|ltx)$/i.test(file.path)) {
      for (const m of file.text.matchAll(/\\label\{([^}]+)\}/g)) labels.add(m[1]!);
    }
  }
  return { labels: [...labels].sort(), citations: [...citations].sort(), files: files.map((f) => f.path) };
}
