export interface Document {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  /** id da pasta que contém o documento; null = fora de qualquer pasta */
  folderId: string | null;
}

export interface Folder {
  id: string;
  name: string;
  createdAt: string;
}
