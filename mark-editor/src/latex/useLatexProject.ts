import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ProjectFileInfo } from '../lib/api';
import { fileKindOf, normalizeProjectPath } from './paths';

/**
 * Estado de um projeto LaTeX aberto: arquivos, rascunhos locais e salvamento
 * automático por arquivo.
 *
 * - Cada arquivo de texto tem `saved` (o que o servidor tem) e `draft` (o que
 *   está no editor). Diferentes = alteração não salva.
 * - O salvamento de cada arquivo é uma fila: uma gravação só começa quando a
 *   anterior do mesmo arquivo terminou, então o servidor nunca fica com uma
 *   versão mais velha por chegada fora de ordem.
 * - `flush()` grava tudo o que está pendente (usado antes de compilar).
 */

export const AUTOSAVE_DELAY_MS = 1000;

export interface ProjectFile {
  path: string;
  kind: 'text' | 'binary';
  size: number;
  saved?: string;
  draft?: string;
}

export interface ProjectState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  mainFile: string;
  files: ProjectFile[];
  saving: boolean;
  saveError: string | null;
  lastSavedAt: string | null;
}

const byPath = (a: ProjectFile, b: ProjectFile) => a.path.localeCompare(b.path);

const fromServer = (info: ProjectFileInfo): ProjectFile =>
  info.kind === 'text'
    ? { path: info.path, kind: 'text', size: info.size, saved: info.content ?? '', draft: info.content ?? '' }
    : { path: info.path, kind: 'binary', size: info.size };

export const isDirty = (file: ProjectFile) => file.kind === 'text' && file.draft !== file.saved;

export function useLatexProject(docId: string, onServerUpdate: (updates: { updatedAt?: string; mainFile?: string }) => void) {
  const [state, setState] = useState<ProjectState>({
    status: 'loading',
    error: null,
    mainFile: '',
    files: [],
    saving: false,
    saveError: null,
    lastSavedAt: null,
  });
  // Espelho síncrono do estado, para as gravações lerem o rascunho mais novo.
  const filesRef = useRef<ProjectFile[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const queues = useRef(new Map<string, Promise<void>>());
  const pending = useRef(0);
  const onServerUpdateRef = useRef(onServerUpdate);
  useEffect(() => {
    onServerUpdateRef.current = onServerUpdate;
  });

  const setFiles = useCallback((update: (files: ProjectFile[]) => ProjectFile[]) => {
    filesRef.current = update(filesRef.current).sort(byPath);
    setState((prev) => ({ ...prev, files: filesRef.current }));
  }, []);

  // Uma instância por documento (o workspace é remontado com key={doc.id}).
  useEffect(() => {
    let cancelled = false;
    api.latex
      .listFiles(docId)
      .then((data) => {
        if (cancelled) return;
        filesRef.current = data.files.map(fromServer).sort(byPath);
        setState((prev) => ({ ...prev, status: 'ready', mainFile: data.mainFile, files: filesRef.current, error: null }));
      })
      .catch((err: Error) => {
        if (!cancelled) setState((prev) => ({ ...prev, status: 'error', error: err.message }));
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  /** Grava o rascunho atual de `path` (na fila daquele arquivo). */
  const saveNow = useCallback(
    (path: string): Promise<void> => {
      const timer = timers.current.get(path);
      if (timer) {
        clearTimeout(timer);
        timers.current.delete(path);
      }
      const previous = queues.current.get(path) ?? Promise.resolve();
      const next = previous.then(async () => {
        const file = filesRef.current.find((f) => f.path === path);
        if (!file || file.kind !== 'text' || file.draft === file.saved) return;
        const text = file.draft ?? '';
        pending.current += 1;
        setState((prev) => ({ ...prev, saving: true }));
        try {
          const { documentUpdatedAt } = await api.latex.writeFile(docId, path, text);
          setFiles((files) => files.map((f) => (f.path === path ? { ...f, saved: text, size: new Blob([text]).size } : f)));
          setState((prev) => ({ ...prev, saveError: null, lastSavedAt: documentUpdatedAt }));
          onServerUpdateRef.current({ updatedAt: documentUpdatedAt });
        } catch (err) {
          setState((prev) => ({ ...prev, saveError: `Não foi possível salvar ${path}: ${(err as Error).message}` }));
          throw err;
        } finally {
          pending.current -= 1;
          if (pending.current === 0) setState((prev) => ({ ...prev, saving: false }));
        }
      });
      // A fila continua mesmo se esta gravação falhar.
      queues.current.set(path, next.catch(() => undefined));
      return next;
    },
    [docId, setFiles]
  );

  const editText = useCallback(
    (path: string, text: string) => {
      setFiles((files) => files.map((f) => (f.path === path ? { ...f, draft: text } : f)));
      const existing = timers.current.get(path);
      if (existing) clearTimeout(existing);
      timers.current.set(
        path,
        setTimeout(() => {
          timers.current.delete(path);
          saveNow(path).catch(() => undefined);
        }, AUTOSAVE_DELAY_MS)
      );
    },
    [saveNow, setFiles]
  );

  /** Grava tudo o que está pendente; rejeita se alguma gravação falhar. */
  const flush = useCallback(async () => {
    const dirty = filesRef.current.filter(isDirty).map((f) => f.path);
    await Promise.all([...dirty.map((p) => saveNow(p)), ...queues.current.values()]);
  }, [saveNow]);

  const createFile = useCallback(
    async (rawPath: string, content: string | Uint8Array = '') => {
      const path = normalizeProjectPath(rawPath);
      const { file, documentUpdatedAt } = await api.latex.writeFile(docId, path, content);
      const text = typeof content === 'string' ? content : fileKindOf(path) === 'text' ? new TextDecoder().decode(content) : undefined;
      setFiles((files) => [
        ...files.filter((f) => f.path !== path),
        file.kind === 'text' ? { path, kind: 'text', size: file.size, saved: text ?? '', draft: text ?? '' } : { path, kind: 'binary', size: file.size },
      ]);
      onServerUpdateRef.current({ updatedAt: documentUpdatedAt });
      return path;
    },
    [docId, setFiles]
  );

  const rename = useCallback(
    async (from: string, rawTo: string, folder = false) => {
      await flush();
      const to = folder ? rawTo.replace(/\/+$/, '') : normalizeProjectPath(rawTo);
      const { mainFile, documentUpdatedAt } = await api.latex.move(docId, from, to, folder);
      setFiles((files) =>
        files.map((f) => {
          if (!folder) return f.path === from ? { ...f, path: to } : f;
          return f.path.startsWith(`${from}/`) ? { ...f, path: `${to}${f.path.slice(from.length)}` } : f;
        })
      );
      setState((prev) => ({ ...prev, mainFile }));
      onServerUpdateRef.current({ updatedAt: documentUpdatedAt, mainFile });
      return to;
    },
    [docId, flush, setFiles]
  );

  const remove = useCallback(
    async (path: string, folder = false) => {
      const { documentUpdatedAt } = folder ? await api.latex.removeFolder(docId, path) : await api.latex.remove(docId, path);
      setFiles((files) => files.filter((f) => (folder ? !f.path.startsWith(`${path}/`) : f.path !== path)));
      onServerUpdateRef.current({ updatedAt: documentUpdatedAt });
    },
    [docId, setFiles]
  );

  const setMainFile = useCallback(
    async (path: string) => {
      const doc = await api.documents.update(docId, { mainFile: path });
      setState((prev) => ({ ...prev, mainFile: path }));
      onServerUpdateRef.current({ updatedAt: doc.updatedAt, mainFile: path });
    },
    [docId]
  );

  // Aviso do navegador ao sair com alterações ainda não gravadas.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (filesRef.current.some(isDirty) || pending.current > 0) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // Ao trocar de documento ou sair da página, grava o que ficou pendente.
  useEffect(() => {
    const pendingTimers = timers.current;
    return () => {
      for (const [path, timer] of pendingTimers) {
        clearTimeout(timer);
        saveNow(path).catch(() => undefined);
      }
    };
  }, [saveNow]);

  return { state, editText, saveNow, flush, createFile, rename, remove, setMainFile, filesRef };
}
