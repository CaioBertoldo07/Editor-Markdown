export type DocumentRow = {
  id: string;
  title: string;
  content: string;
  folder_id: string | null;
  kind: 'markdown' | 'latex';
  main_file: string | null;
  created_at: Date;
  updated_at: Date;
};

export type FolderRow = { id: string; name: string; created_at: Date };

export const DOCUMENT_COLUMNS = 'id, title, content, folder_id, kind, main_file, created_at, updated_at';
export const FOLDER_COLUMNS = 'id, name, created_at';

export const toDocument = (row: DocumentRow) => ({
  id: row.id,
  title: row.title,
  content: row.content,
  folderId: row.folder_id,
  kind: row.kind,
  mainFile: row.main_file,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export const toFolder = (row: FolderRow) => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at.toISOString(),
});
