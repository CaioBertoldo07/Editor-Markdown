import { useMemo, useRef, useState } from 'react';
import type { ProjectFile } from '../../latex/useLatexProject';
import { BINARY_EXTENSIONS, TEXT_EXTENSIONS } from '../../latex/paths';

/**
 * Árvore de arquivos do projeto LaTeX. As pastas não existem sozinhas: são
 * os prefixos dos caminhos ("capitulos/intro.tex" cria a pasta "capitulos").
 */

interface FileTreeProps {
  files: ProjectFile[];
  mainFile: string;
  activePath: string | null;
  dirty: Set<string>;
  busy: boolean;
  onOpen: (path: string) => void;
  onCreate: (path: string) => Promise<void>;
  onUpload: (files: File[], folder: string) => void;
  onRename: (from: string, to: string, folder: boolean) => Promise<void>;
  onDelete: (path: string, folder: boolean) => void;
  onSetMain: (path: string) => void;
  onDownload: (path: string) => void;
}

type Node = { name: string; path: string; folder: boolean; children: Node[]; file?: ProjectFile };

function buildTree(files: ProjectFile[]): Node[] {
  const root: Node = { name: '', path: '', folder: true, children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      const isFile = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part && c.folder !== isFile);
      if (!child) {
        child = { name: part, path, folder: !isFile, children: [], ...(isFile ? { file } : {}) };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => (a.folder === b.folder ? a.name.localeCompare(b.name) : a.folder ? -1 : 1));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

const UPLOAD_ACCEPT = [...TEXT_EXTENSIONS, ...BINARY_EXTENSIONS].map((e) => `.${e}`).join(',');

const FileIcon: React.FC<{ path: string; folder?: boolean; open?: boolean }> = ({ path, folder, open }) => {
  if (folder) {
    return (
      <svg className="tree-icon tree-icon-folder" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {open ? <path d="M5 19a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l2 3h7a2 2 0 0 1 2 2v1M5 19h14l3-8H8z"></path> : <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"></path>}
      </svg>
    );
  }
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const cls = ext === 'tex' || ext === 'ltx' ? 'tex' : ext === 'bib' ? 'bib' : (BINARY_EXTENSIONS as readonly string[]).includes(ext) ? 'img' : 'other';
  return (
    <svg className={`tree-icon tree-icon-${cls}`} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {cls === 'img' ? (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </>
      ) : (
        <>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
        </>
      )}
    </svg>
  );
};

const FileTree: React.FC<FileTreeProps> = ({
  files,
  mainFile,
  activePath,
  dirty,
  busy,
  onOpen,
  onCreate,
  onUpload,
  onRename,
  onDelete,
  onSetMain,
  onDownload,
}) => {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; folder: boolean } | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadFolder = useRef('');

  const startCreate = (folder = '') => {
    setRenaming(null);
    setError(null);
    setCreating(folder);
    setDraft(folder ? `${folder}/` : '');
  };

  const commitCreate = async () => {
    const path = draft.trim();
    if (!path || path.endsWith('/')) {
      setCreating(null);
      return;
    }
    try {
      await onCreate(path);
      setCreating(null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const commitRename = async () => {
    if (!renaming) return;
    const to = draft.trim();
    if (!to || to === renaming.path) {
      setRenaming(null);
      return;
    }
    try {
      await onRename(renaming.path, to, renaming.folder);
      setRenaming(null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const inputKeys = (commit: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') {
      setCreating(null);
      setRenaming(null);
      setError(null);
    }
  };

  const openUpload = (folder: string) => {
    uploadFolder.current = folder;
    uploadRef.current?.click();
  };

  const renderNode = (node: Node, depth: number): React.ReactNode => {
    const pad = { paddingLeft: 10 + depth * 14 };
    if (renaming?.path === node.path) {
      return (
        <div key={node.path} className="tree-row tree-editing" style={pad}>
          <FileIcon path={node.path} folder={node.folder} />
          <input
            className="tree-input"
            value={draft}
            autoFocus
            aria-label={`Novo nome para ${node.path}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={inputKeys(commitRename)}
            onBlur={commitRename}
          />
        </div>
      );
    }
    if (node.folder) {
      const isCollapsed = collapsed.has(node.path);
      return (
        <div key={node.path} className="tree-folder">
          <div
            className="tree-row"
            style={pad}
            role="button"
            tabIndex={0}
            aria-expanded={!isCollapsed}
            onClick={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
          >
            <FileIcon path={node.path} folder open={!isCollapsed} />
            <span className="tree-name">{node.name}</span>
            <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
              <button className="tree-action" onClick={() => startCreate(node.path)} title="Novo arquivo nesta pasta" aria-label={`Novo arquivo em ${node.path}`}>+</button>
              <button className="tree-action" onClick={() => openUpload(node.path)} title="Enviar arquivos para esta pasta" aria-label={`Enviar arquivos para ${node.path}`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path></svg>
              </button>
              <button className="tree-action" onClick={() => { setRenaming({ path: node.path, folder: true }); setDraft(node.path); }} title="Renomear pasta" aria-label={`Renomear ${node.path}`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg>
              </button>
              <button className="tree-action tree-action-danger" onClick={() => onDelete(node.path, true)} title="Excluir pasta" aria-label={`Excluir ${node.path}`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              </button>
            </span>
          </div>
          {!isCollapsed && node.children.map((child) => renderNode(child, depth + 1))}
          {creating === node.path && renderCreate(depth + 1)}
        </div>
      );
    }
    const isMain = node.path === mainFile;
    const isTex = /\.(tex|ltx)$/i.test(node.path);
    return (
      <div
        key={node.path}
        className={`tree-row tree-file ${activePath === node.path ? 'active' : ''}`}
        style={pad}
        role="button"
        tabIndex={0}
        aria-current={activePath === node.path ? 'true' : undefined}
        onClick={() => onOpen(node.path)}
        onKeyDown={(e) => e.key === 'Enter' && onOpen(node.path)}
        title={node.path}
      >
        <FileIcon path={node.path} />
        <span className="tree-name">{node.name}</span>
        {isMain && <span className="tree-badge" title="Arquivo principal (é ele que é compilado)">principal</span>}
        {dirty.has(node.path) && <span className="tree-dirty" title="Alterações não salvas" aria-label="Alterações não salvas" />}
        <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
          {isTex && !isMain && (
            <button className="tree-action" onClick={() => onSetMain(node.path)} title="Usar como arquivo principal" aria-label={`Usar ${node.path} como principal`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
            </button>
          )}
          <button className="tree-action" onClick={() => onDownload(node.path)} title="Baixar arquivo" aria-label={`Baixar ${node.path}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          </button>
          <button className="tree-action" onClick={() => { setRenaming({ path: node.path, folder: false }); setDraft(node.path); setError(null); }} title="Renomear ou mover" aria-label={`Renomear ${node.path}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg>
          </button>
          {!isMain && (
            <button className="tree-action tree-action-danger" onClick={() => onDelete(node.path, false)} title="Excluir arquivo" aria-label={`Excluir ${node.path}`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          )}
        </span>
      </div>
    );
  };

  const renderCreate = (depth: number) => (
    <div className="tree-row tree-editing" style={{ paddingLeft: 10 + depth * 14 }}>
      <FileIcon path={draft || 'x.tex'} />
      <input
        className="tree-input"
        value={draft}
        autoFocus
        placeholder="capitulos/novo.tex"
        aria-label="Nome do novo arquivo"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={inputKeys(commitCreate)}
        onBlur={commitCreate}
      />
    </div>
  );

  return (
    <div className="latex-tree" aria-busy={busy || undefined}>
      <div className="latex-tree-header">
        <span>Arquivos</span>
        <div className="latex-tree-header-actions">
          <button className="tree-action" onClick={() => startCreate('')} title="Novo arquivo (.tex, .bib, .sty...)" aria-label="Novo arquivo">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
          <button className="tree-action" onClick={() => openUpload('')} title="Enviar imagens, .bib, .sty..." aria-label="Enviar arquivos">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path></svg>
          </button>
        </div>
      </div>
      <input
        ref={uploadRef}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const chosen = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (chosen.length) onUpload(chosen, uploadFolder.current);
        }}
      />
      {error && <p className="latex-tree-error" role="alert">{error}</p>}
      <div className="latex-tree-body">
        {creating === '' && renderCreate(0)}
        {tree.map((node) => renderNode(node, 0))}
      </div>
    </div>
  );
};

export default FileTree;
