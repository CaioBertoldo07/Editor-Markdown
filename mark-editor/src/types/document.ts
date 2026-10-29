export type DocumentKind = 'markdown' | 'latex';

export interface Document {
  id: string;
  title: string;
  /** Conteúdo Markdown. Em projetos LaTeX fica vazio: o texto está nos arquivos do projeto. */
  content: string;
  updatedAt: string;
  /** id da pasta que contém o documento; null = fora de qualquer pasta */
  folderId: string | null;
  /** Tipo definido na criação; nunca muda (Markdown não vira LaTeX). */
  kind: DocumentKind;
  /** Arquivo principal do projeto LaTeX (ex.: main.tex); null em Markdown. */
  mainFile: string | null;
}

export interface Folder {
  id: string;
  name: string;
  createdAt: string;
}
