import type { Document, Folder } from '../types/document';

export type SortMode = 'name' | 'recent';

/**
 * `numeric: true` é o que faz "2 - Mapa" vir antes de "10 - Riscos"; uma
 * comparação de texto comum colocaria "10" antes de "2". `sensitivity: base`
 * ignora acento e caixa, então "Índice" e "indice" ficam lado a lado em vez de
 * separados no fim da lista.
 */
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

export function compareByName(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Mais recente primeiro; empate cai para o nome, para a ordem não oscilar. */
function compareByRecent(a: Document, b: Document): number {
  const diff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  return diff !== 0 ? diff : collator.compare(a.title, b.title);
}

export function sortDocuments(documents: Document[], mode: SortMode): Document[] {
  // Cópia antes de ordenar: sort() altera o array no lugar, e este vem do
  // estado do contexto.
  const copy = [...documents];
  return mode === 'recent'
    ? copy.sort(compareByRecent)
    : copy.sort((a, b) => collator.compare(a.title, b.title));
}

/** Pastas seguem sempre por nome — elas não têm "modificado em". */
export function sortFolders(folders: Folder[]): Folder[] {
  return [...folders].sort((a, b) => collator.compare(a.name, b.name));
}
