import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type CompileJob, type CompileStatus, type LatexEngine } from '../lib/api';

/**
 * Compilação de um projeto LaTeX: manual ou automática (com debounce).
 *
 * - Só uma compilação por vez: começar outra cancela a anterior (no servidor
 *   também), e o resultado de uma compilação antiga é descartado.
 * - O último PDF VÁLIDO fica na tela. Se a compilação seguinte falha, `stale`
 *   indica que o PDF exibido é de uma versão anterior.
 * - Antes de compilar, grava as alterações pendentes (`flush`), para o
 *   servidor compilar exatamente o que está no editor.
 */

export const AUTO_COMPILE_DELAY_MS = 2000;
const AUTO_KEY = 'latex-auto-compile';

export type CompilePhase = 'idle' | 'saving' | 'compiling' | Exclude<CompileStatus, 'running'>;

export interface CompilerState {
  phase: CompilePhase;
  /** Última compilação terminada (diagnósticos, log). */
  lastJob: CompileJob | null;
  pdf: Uint8Array | null;
  /** O PDF exibido é anterior à última tentativa (que falhou). */
  stale: boolean;
  error: string | null;
  autoCompile: boolean;
}

const loadAuto = (): boolean => {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'false';
  } catch {
    return true;
  }
};

export function useCompiler(docId: string, flush: () => Promise<void>, engine: LatexEngine | undefined) {
  const [state, setState] = useState<CompilerState>({
    phase: 'idle',
    lastJob: null,
    pdf: null,
    stale: false,
    error: null,
    autoCompile: loadAuto(),
  });
  const seq = useRef(0);
  const current = useRef<{ jobId: string | null; abort: AbortController } | null>(null);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });

  const stopCurrent = useCallback(() => {
    const running = current.current;
    current.current = null;
    if (!running) return;
    running.abort.abort();
    if (running.jobId) api.latex.cancelJob(running.jobId).catch(() => undefined);
  }, []);

  const compile = useCallback(async () => {
    if (autoTimer.current) {
      clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }
    stopCurrent();
    const mySeq = ++seq.current;
    const abort = new AbortController();
    const mine = { jobId: null as string | null, abort };
    current.current = mine;
    const obsolete = () => mySeq !== seq.current;

    setState((prev) => ({ ...prev, phase: 'saving', error: null }));
    try {
      await flushRef.current();
      if (obsolete()) return;
      setState((prev) => ({ ...prev, phase: 'compiling' }));
      let job = await api.latex.compile(docId, engine);
      mine.jobId = job.id;
      while (job.status === 'running') {
        if (obsolete()) return;
        job = await api.latex.waitJob(job.id, abort.signal);
      }
      if (obsolete()) return;
      let pdf: Uint8Array | null = null;
      if (job.hasPdf) pdf = await api.latex.pdf(job.id, abort.signal);
      if (obsolete()) return;
      current.current = null;
      setState((prev) => ({
        ...prev,
        phase: job.status === 'running' ? 'compiling' : job.status,
        lastJob: job,
        pdf: pdf ?? prev.pdf,
        stale: pdf ? false : prev.pdf !== null,
      }));
    } catch (err) {
      if (obsolete() || (err as Error).name === 'AbortError') return;
      current.current = null;
      const message = err instanceof ApiError ? err.message : `Não foi possível compilar: ${(err as Error).message}`;
      setState((prev) => ({ ...prev, phase: 'unavailable', error: message, stale: prev.pdf !== null }));
    }
  }, [docId, engine, stopCurrent]);

  const cancel = useCallback(() => {
    seq.current += 1;
    stopCurrent();
    setState((prev) => ({ ...prev, phase: 'cancelled', stale: prev.pdf !== null }));
  }, [stopCurrent]);

  /** Chamado a cada alteração no texto: agenda a compilação automática. */
  const notifyChange = useCallback(() => {
    if (!state.autoCompile) return;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      void compile();
    }, AUTO_COMPILE_DELAY_MS);
  }, [compile, state.autoCompile]);

  const setAutoCompile = useCallback((value: boolean) => {
    try {
      localStorage.setItem(AUTO_KEY, String(value));
    } catch {
      /* preferência só desta sessão */
    }
    if (!value && autoTimer.current) {
      clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }
    setState((prev) => ({ ...prev, autoCompile: value }));
  }, []);

  useEffect(
    () => () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
      seq.current += 1;
      stopCurrent();
    },
    [stopCurrent]
  );

  return { state, compile, cancel, notifyChange, setAutoCompile };
}
