import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Document } from '../../types/document';
import { api, type LatexEngine } from '../../lib/api';
import { useDocuments } from '../../context/DocumentsContext';
import { isDirty, useLatexProject } from '../../latex/useLatexProject';
import { useCompiler, type CompilePhase } from '../../latex/useCompiler';
import { fileKindOf, normalizeProjectPath } from '../../latex/paths';
import { downloadPdf, downloadProjectZip, downloadTextFile } from '../../latex/projectExport';
import { saveBlob } from '../../utils/download';
import ConfirmModal from '../ConfirmModal/ConfirmModal';
import FileTree from './FileTree';
import DiagnosticsPanel from './DiagnosticsPanel';
import { buildIndex } from '../../latex/projectIndex';
import type { GotoRequest } from './LatexEditor';
import './LatexWorkspace.css';

// Editor e visualizador de PDF só são baixados quando um projeto LaTeX é aberto.
const LatexEditor = lazy(() => import('./LatexEditor'));
const PdfViewer = lazy(() => import('./PdfViewer'));

const PHASE: Record<CompilePhase, { label: string; tone: 'idle' | 'busy' | 'ok' | 'warn' | 'error' }> = {
  idle: { label: 'Aguardando compilação', tone: 'idle' },
  saving: { label: 'Salvando…', tone: 'busy' },
  compiling: { label: 'Compilando…', tone: 'busy' },
  success: { label: 'Compilação concluída', tone: 'ok' },
  warnings: { label: 'Concluída com avisos', tone: 'warn' },
  error: { label: 'Erro de compilação', tone: 'error' },
  timeout: { label: 'Tempo limite excedido', tone: 'error' },
  too_large: { label: 'Saída grande demais', tone: 'error' },
  cancelled: { label: 'Compilação cancelada', tone: 'idle' },
  busy: { label: 'Compilador ocupado', tone: 'warn' },
  unavailable: { label: 'Compilador indisponível', tone: 'error' },
};

const ENGINE_OPTIONS: Array<{ value: LatexEngine | 'auto'; label: string }> = [
  { value: 'auto', label: 'Automático' },
  { value: 'pdflatex', label: 'pdfLaTeX' },
  { value: 'xelatex', label: 'XeLaTeX' },
  { value: 'lualatex', label: 'LuaLaTeX' },
];
const MAGIC = /^\s*%\s*!\s*TeX\s+(?:TS-)?program\s*=\s*([A-Za-z]+)\s*\n?/im;

const SPLIT_KEY = 'latex-split';
const loadSplit = () => {
  try {
    const value = Number(localStorage.getItem(SPLIT_KEY));
    return value >= 25 && value <= 75 ? value : 50;
  } catch {
    return 50;
  }
};

type MobileTab = 'code' | 'pdf' | 'problems';

const isNarrow = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 900px)').matches;

interface LatexWorkspaceProps {
  doc: Document;
  isPreviewExpanded: boolean;
  onTogglePreviewExpanded: () => void;
  onSaveState: (state: { saving: boolean; lastSaved: string | null }) => void;
}

const LatexWorkspace: React.FC<LatexWorkspaceProps> = ({ doc, isPreviewExpanded, onTogglePreviewExpanded, onSaveState }) => {
  const { applyServerUpdate } = useDocuments();
  const onServerUpdate = useCallback((updates: { updatedAt?: string; mainFile?: string }) => applyServerUpdate(doc.id, updates), [applyServerUpdate, doc.id]);
  const project = useLatexProject(doc.id, onServerUpdate);
  const { state } = project;

  const [activePath, setActivePath] = useState<string | null>(null);
  const [gotoRequest, setGotoRequest] = useState<GotoRequest | null>(null);
  const [split, setSplit] = useState(loadSplit);
  const [isResizing, setIsResizing] = useState(false);
  // No celular a árvore é uma gaveta: começa fechada e fecha ao abrir um arquivo.
  const [showTree, setShowTree] = useState(() => !isNarrow());
  const [mobileTab, setMobileTab] = useState<MobileTab>('code');
  const [problemsToggle, setProblemsToggle] = useState<{ jobId: string | null; open: boolean }>({ jobId: null, open: false });
  const [confirmDelete, setConfirmDelete] = useState<{ path: string; folder: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [binaryUrl, setBinaryUrl] = useState<string | null>(null);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const panesRef = useRef<HTMLDivElement>(null);

  const mainText = state.files.find((f) => f.path === state.mainFile)?.draft ?? '';
  const magic = mainText.match(MAGIC)?.[1]?.toLowerCase();
  const engine = (['pdflatex', 'xelatex', 'lualatex'] as const).find((e) => e === magic);
  // O motor vai no comentário mágico do arquivo principal (portável: vale também
  // no Overleaf, TeXstudio e VS Code); o compilador lê de lá.
  const compiler = useCompiler(doc.id, project.flush, undefined);
  const { compile, cancel, notifyChange, setAutoCompile } = compiler;
  const cstate = compiler.state;

  // Abre o arquivo principal assim que o projeto carrega.
  const currentPath = activePath ?? (state.status === 'ready' ? state.mainFile : null);
  const active = state.files.find((f) => f.path === currentPath) ?? null;
  const dirty = useMemo(() => new Set(state.files.filter(isDirty).map((f) => f.path)), [state.files]);

  // Compila uma vez ao abrir, se a compilação automática estiver ligada.
  const compiledOnOpen = useRef(false);
  useEffect(() => {
    if (state.status === 'ready' && !compiledOnOpen.current && cstate.autoCompile) {
      compiledOnOpen.current = true;
      void compile();
    }
  }, [state.status, cstate.autoCompile, compile]);

  useEffect(() => {
    onSaveState({ saving: state.saving, lastSaved: state.lastSavedAt ?? doc.updatedAt });
  }, [state.saving, state.lastSavedAt, doc.updatedAt, onSaveState]);

  // Imagem/PDF aberto na árvore: mostra uma prévia do arquivo.
  useEffect(() => {
    if (!active || active.kind !== 'binary') return;
    let url: string | null = null;
    let cancelled = false;
    api.latex
      .readFile(doc.id, active.path)
      .then((bytes) => {
        if (cancelled) return;
        const type = /\.png$/i.test(active.path) ? 'image/png' : /\.jpe?g$/i.test(active.path) ? 'image/jpeg' : 'application/octet-stream';
        url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
        setBinaryUrl(url);
      })
      .catch((err: Error) => setNotice(err.message));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setBinaryUrl(null);
    };
  }, [active, doc.id]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(timer);
  }, [notice]);

  // O painel de problemas abre sozinho quando a compilação falha; depois vale
  // a escolha do usuário para aquela compilação.
  const failed = cstate.phase === 'error' || cstate.phase === 'timeout';
  const problemsOpen = problemsToggle.jobId === (cstate.lastJob?.id ?? null) ? problemsToggle.open : failed;
  const toggleProblems = () => setProblemsToggle({ jobId: cstate.lastJob?.id ?? null, open: !problemsOpen });

  const index = useMemo(
    () => buildIndex(state.files.map((f) => ({ path: f.path, text: f.kind === 'text' ? f.draft : undefined }))),
    [state.files]
  );
  const indexRef = useRef(index);
  useEffect(() => {
    indexRef.current = index;
  });

  const diagnostics = useMemo(() => cstate.lastJob?.diagnostics ?? [], [cstate.lastJob]);
  const fileDiagnostics = useMemo(() => diagnostics.filter((d) => d.file === currentPath), [diagnostics, currentPath]);
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = diagnostics.filter((d) => d.severity === 'warning').length;

  const handleChange = useCallback(
    (text: string) => {
      if (!currentPath) return;
      project.editText(currentPath, text);
      notifyChange();
    },
    [currentPath, project, notifyChange]
  );

  const navigate = (file: string, line: number) => {
    setActivePath(file);
    setMobileTab('code');
    setGotoRequest({ path: file, line, nonce: Date.now() });
  };

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (err) {
      setNotice((err as Error).message);
      throw err;
    }
  };

  const createFile = async (rawPath: string) => {
    const path = normalizeProjectPath(rawPath);
    if (fileKindOf(path) !== 'text') throw new Error('Crie arquivos de texto (.tex, .bib, .sty...). Imagens entram pelo botão de envio.');
    await run(() => project.createFile(path, ''));
    setActivePath(path);
  };

  const uploadFiles = async (chosen: File[], folder: string) => {
    for (const file of chosen) {
      try {
        const path = normalizeProjectPath(folder ? `${folder}/${file.name}` : file.name);
        await project.createFile(path, new Uint8Array(await file.arrayBuffer()));
      } catch (err) {
        setNotice(`${file.name}: ${(err as Error).message}`);
      }
    }
    notifyChange();
  };

  const setEngine = (value: LatexEngine | 'auto') => {
    const main = state.files.find((f) => f.path === state.mainFile);
    if (!main || main.kind !== 'text') return;
    const text = (main.draft ?? '').replace(MAGIC, '');
    project.editText(state.mainFile, value === 'auto' ? text : `% !TEX program = ${value}\n${text}`);
    notifyChange();
  };

  const downloadActive = () => {
    const file = active?.kind === 'text' ? active : state.files.find((f) => f.path === state.mainFile);
    if (file) downloadTextFile(file.path, file.draft ?? '');
  };

  const downloadFile = async (path: string) => {
    const file = state.files.find((f) => f.path === path);
    if (!file) return;
    if (file.kind === 'text') return downloadTextFile(path, file.draft ?? '');
    try {
      const bytes = await api.latex.readFile(doc.id, path);
      saveBlob(new Blob([bytes as Uint8Array<ArrayBuffer>]), path.slice(path.lastIndexOf('/') + 1));
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  // --- Divisória redimensionável entre código e PDF ---
  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsResizing(true);
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizing || !panesRef.current) return;
    const rect = panesRef.current.getBoundingClientRect();
    const treeWidth = showTree ? 220 : 0;
    const percent = ((e.clientX - rect.left - treeWidth) / (rect.width - treeWidth)) * 100;
    setSplit(Math.min(75, Math.max(25, percent)));
  };
  const onResizeEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizing) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setIsResizing(false);
    try {
      localStorage.setItem(SPLIT_KEY, String(Math.round(split)));
    } catch {
      /* só nesta sessão */
    }
  };

  const phase = PHASE[cstate.phase];
  const compiling = cstate.phase === 'compiling' || cstate.phase === 'saving';

  if (state.status === 'loading') {
    return <div className="latex-loading">Carregando o projeto…</div>;
  }
  if (state.status === 'error') {
    return <div className="latex-loading latex-loading-error">Não foi possível abrir o projeto: {state.error}</div>;
  }

  return (
    <div className={`latex-workspace mobile-${mobileTab} ${isResizing ? 'resizing' : ''}`}>
      <div className="latex-bar">
        <div className="latex-bar-left">
          <button
            className={`latex-icon-btn ${showTree ? 'active' : ''}`}
            onClick={() => setShowTree((v) => !v)}
            aria-pressed={showTree}
            title={showTree ? 'Ocultar arquivos' : 'Mostrar arquivos'}
            aria-label="Arquivos do projeto"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
          </button>
          <span className="latex-current-file" title={currentPath ?? ''}>
            {currentPath ?? '—'}
            {currentPath && dirty.has(currentPath) && <span className="latex-unsaved">não salvo</span>}
          </span>
        </div>

        <div className="latex-bar-right">
          <label className="latex-engine">
            <span>Motor</span>
            <select value={engine ?? 'auto'} onChange={(e) => setEngine(e.target.value as LatexEngine | 'auto')} aria-label="Motor LaTeX">
              {ENGINE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          <label className="latex-auto" title="Compilar automaticamente depois de uma pausa na digitação">
            <input type="checkbox" checked={cstate.autoCompile} onChange={(e) => setAutoCompile(e.target.checked)} />
            <span className="latex-switch" aria-hidden="true" />
            <span>Auto</span>
          </label>

          <span className={`latex-status tone-${phase.tone}`} role="status" aria-live="polite">
            {phase.tone === 'busy' && <span className="latex-spinner" aria-hidden="true" />}
            {phase.label}
            {/* Tempo só quando é o desta compilação (não o da anterior, após cancelar). */}
            {cstate.lastJob?.durationMs && cstate.phase === cstate.lastJob.status ? (
              <span className="latex-status-time">{(cstate.lastJob.durationMs / 1000).toFixed(1)} s</span>
            ) : null}
          </span>

          {compiling ? (
            <button className="latex-compile latex-compile-cancel" onClick={cancel} title="Cancelar compilação">
              Cancelar
            </button>
          ) : (
            <button className="latex-compile" onClick={() => void compile()} title="Compilar (Ctrl+Enter)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>
              Compilar
            </button>
          )}

          <div className="latex-download">
            <button
              className="latex-icon-btn"
              onClick={() => setDownloadOpen((v) => !v)}
              aria-expanded={downloadOpen}
              aria-haspopup="menu"
              title="Baixar"
              aria-label="Baixar"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            </button>
            {downloadOpen && (
              <div className="latex-menu" role="menu" onMouseLeave={() => setDownloadOpen(false)}>
                <button role="menuitem" disabled={!cstate.pdf} onClick={() => { setDownloadOpen(false); if (cstate.pdf) downloadPdf(doc.title, cstate.pdf); }}>
                  PDF compilado{cstate.stale ? ' (versão anterior)' : ''}
                </button>
                <button role="menuitem" onClick={() => { setDownloadOpen(false); downloadActive(); }}>
                  Arquivo .tex aberto
                </button>
                <button
                  role="menuitem"
                  onClick={async () => {
                    setDownloadOpen(false);
                    try {
                      await project.flush();
                      await downloadProjectZip(doc);
                    } catch (err) {
                      setNotice((err as Error).message);
                    }
                  }}
                >
                  Projeto completo (.zip)
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="latex-tabs" role="tablist" aria-label="Alternar entre código e prévia">
        {(['code', 'pdf', 'problems'] as const).map((tab) => (
          <button key={tab} role="tab" aria-selected={mobileTab === tab} className={mobileTab === tab ? 'active' : ''} onClick={() => setMobileTab(tab)}>
            {tab === 'code' ? 'Código' : tab === 'pdf' ? 'PDF' : `Problemas${errorCount + warningCount ? ` (${errorCount + warningCount})` : ''}`}
          </button>
        ))}
      </div>

      {(notice || state.saveError) && (
        <div className="latex-notice" role="alert">
          {notice ?? state.saveError}
          <button onClick={() => setNotice(null)} aria-label="Fechar aviso">×</button>
        </div>
      )}

      <div
        className="latex-panes"
        ref={panesRef}
        style={{ '--latex-split': `${split}%` } as React.CSSProperties}
      >
        {showTree && (
          <aside className="latex-files">
            <FileTree
              files={state.files}
              mainFile={state.mainFile}
              activePath={currentPath}
              dirty={dirty}
              busy={state.saving}
              onOpen={(path) => {
                setActivePath(path);
                setMobileTab('code');
                if (isNarrow()) setShowTree(false);
              }}
              onCreate={createFile}
              onUpload={(files, folder) => void uploadFiles(files, folder)}
              onRename={async (from, to, folder) => {
                const target = await project.rename(from, to, folder);
                if (!folder && currentPath === from) setActivePath(target);
                if (folder && currentPath?.startsWith(`${from}/`)) setActivePath(`${target}${currentPath.slice(from.length)}`);
              }}
              onDelete={(path, folder) => setConfirmDelete({ path, folder })}
              onSetMain={(path) => void run(() => project.setMainFile(path)).catch(() => undefined)}
              onDownload={(path) => void downloadFile(path)}
            />
          </aside>
        )}

        <section className="latex-code" aria-label="Código LaTeX">
          {active?.kind === 'text' ? (
            <Suspense fallback={<div className="latex-loading">Carregando o editor…</div>}>
              <LatexEditor
                path={active.path}
                initialText={active.draft ?? ''}
                diagnostics={fileDiagnostics}
                gotoRequest={gotoRequest}
                onChange={handleChange}
                onCompile={() => void compile()}
                onSave={() => void compile()}
                getIndex={() => indexRef.current}
              />
            </Suspense>
          ) : active ? (
            <div className="latex-binary">
              {binaryUrl && /\.(png|jpe?g)$/i.test(active.path) ? (
                <img src={binaryUrl} alt={active.path} />
              ) : (
                <p>Arquivo binário ({(active.size / 1024).toFixed(0)} KB). Ele é usado na compilação e pode ser baixado pela árvore.</p>
              )}
              <span className="latex-binary-name">{active.path}</span>
            </div>
          ) : (
            <div className="latex-loading">Selecione um arquivo.</div>
          )}
        </section>

        <div
          className="latex-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Ajustar a divisão entre código e PDF"
          aria-valuenow={Math.round(split)}
          aria-valuemin={25}
          aria-valuemax={75}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onDoubleClick={() => setSplit(50)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setSplit((s) => Math.max(25, s - 2));
            if (e.key === 'ArrowRight') setSplit((s) => Math.min(75, s + 2));
          }}
        />

        <section className={`latex-preview ${isPreviewExpanded ? 'expanded' : ''}`} aria-label="Prévia do PDF">
          {cstate.stale && cstate.pdf && (
            <p className="latex-stale" role="note">
              Mostrando a última versão que compilou — a atual tem {cstate.phase === 'error' ? 'erros' : 'problemas'}.
            </p>
          )}
          <div className="latex-preview-head">
            <button className="latex-icon-btn latex-expand" onClick={onTogglePreviewExpanded} title={isPreviewExpanded ? 'Sair do modo ampliado (Esc)' : 'Ampliar prévia (Ctrl+Shift+F)'} aria-label={isPreviewExpanded ? 'Sair do modo ampliado' : 'Ampliar prévia'}>
              {isPreviewExpanded ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"></path><path d="M21 8h-3a2 2 0 0 1-2-2V3"></path><path d="M3 16h3a2 2 0 0 1 2 2v3"></path><path d="M16 21v-3a2 2 0 0 1 2-2h3"></path></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>
              )}
            </button>
          </div>
          <Suspense fallback={<div className="latex-loading">Carregando o visualizador…</div>}>
            <PdfViewer
              data={cstate.pdf}
              emptyMessage={
                compiling
                  ? 'Compilando o documento…'
                  : cstate.error ?? (cstate.phase === 'idle' ? 'Clique em Compilar para gerar o PDF.' : 'Corrija os erros e compile de novo para ver o PDF.')
              }
            />
          </Suspense>

          <div className={`latex-problems ${problemsOpen ? 'open' : ''}`}>
            <button className="latex-problems-toggle" onClick={toggleProblems} aria-expanded={problemsOpen}>
              <span>Problemas</span>
              {errorCount > 0 && <span className="pill pill-error">{errorCount}</span>}
              {warningCount > 0 && <span className="pill pill-warning">{warningCount}</span>}
              <svg className="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
            </button>
            {problemsOpen && <DiagnosticsPanel job={cstate.lastJob} onNavigate={navigate} projectFiles={state.files.map((f) => f.path)} />}
          </div>
        </section>

        <section className="latex-problems-mobile" aria-label="Problemas da compilação">
          <DiagnosticsPanel job={cstate.lastJob} onNavigate={navigate} projectFiles={state.files.map((f) => f.path)} />
        </section>
      </div>

      <ConfirmModal
        isOpen={confirmDelete !== null}
        title={confirmDelete?.folder ? 'Excluir pasta' : 'Excluir arquivo'}
        message={
          confirmDelete?.folder
            ? `Excluir a pasta "${confirmDelete.path}" e todos os arquivos dentro dela? Esta ação não pode ser desfeita.`
            : `Excluir "${confirmDelete?.path}" do projeto? Esta ação não pode ser desfeita.`
        }
        confirmText="Excluir"
        cancelText="Cancelar"
        type="danger"
        onConfirm={() => {
          const target = confirmDelete;
          setConfirmDelete(null);
          if (!target) return;
          void run(() => project.remove(target.path, target.folder))
            .then(() => {
              if (currentPath === target.path || (target.folder && currentPath?.startsWith(`${target.path}/`))) setActivePath(null);
            })
            .catch(() => undefined);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};

export default LatexWorkspace;
