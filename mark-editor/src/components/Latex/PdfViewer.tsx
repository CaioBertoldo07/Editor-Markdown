import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/**
 * Prévia do PDF compilado (PDF.js).
 *
 * - Páginas em rolagem contínua; só as visíveis (e vizinhas) são desenhadas.
 * - Zoom (+/−), ajustar à largura, navegação por página e total de páginas.
 * - Ao chegar um PDF novo (recompilação), mantém o zoom e volta para a mesma
 *   página e posição de leitura.
 * - Nada do PDF é executado: sem JavaScript de PDF, sem formulários XFA.
 */

type PdfjsModule = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfjsModule> | null = null;
const loadPdfjs = () => {
  pdfjsPromise ??= import('pdfjs-dist').then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = workerUrl;
    return mod;
  });
  return pdfjsPromise;
};

/** Quem libera um documento no PDF.js 6 é a tarefa que o carregou. */
const loadingTasks = new WeakMap<PDFDocumentProxy, PDFDocumentLoadingTask>();

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const PAGE_GAP = 12;

interface PdfViewerProps {
  data: Uint8Array | null;
  /** Mensagem quando ainda não há PDF. */
  emptyMessage: string;
}

type PageSize = { width: number; height: number };

const PdfViewer: React.FC<PdfViewerProps> = ({ data, emptyMessage }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [containerWidth, setContainerWidth] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1]));
  const [loadError, setLoadError] = useState<string | null>(null);
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const renders = useRef(new Map<number, RenderTask>());
  // Posição a restaurar quando o PDF novo terminar de montar.
  const restoreRef = useRef<{ page: number; offset: number } | null>(null);

  // Largura útil para "ajustar à largura". A área de rolagem só existe quando
  // há PDF, então o observador é ligado quando ela aparece.
  const hasData = data !== null;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasData]);

  const scale = (() => {
    if (zoom !== 'fit') return zoom;
    const widest = Math.max(...sizes.map((s) => s.width), 1);
    return containerWidth > 0 ? Math.max(0.3, (containerWidth - 32) / widest) : 1;
  })();

  /** Página e posição relativa dentro dela, no topo da área visível. */
  const readingPosition = useCallback(() => {
    const el = scrollRef.current;
    if (!el || sizes.length === 0) return null;
    let top = 16;
    for (let i = 0; i < sizes.length; i++) {
      const h = sizes[i]!.height * scale;
      if (el.scrollTop < top + h + PAGE_GAP) return { page: i + 1, offset: Math.max(0, (el.scrollTop - top) / h) };
      top += h + PAGE_GAP;
    }
    return { page: sizes.length, offset: 0 };
  }, [sizes, scale]);

  // Abre o PDF novo (e guarda onde o leitor estava no anterior).
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    restoreRef.current = readingPosition();
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        // O PDF.js transfere o buffer para o worker: passa uma cópia.
        const task = pdfjs.getDocument({ data: data.slice(), enableXfa: false, stopAtErrors: false });
        const doc = await task.promise;
        loadingTasks.set(doc, task);
        const pageSizes: PageSize[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          pageSizes.push({ width: vp.width, height: vp.height });
        }
        if (cancelled) {
          void task.destroy();
          return;
        }
        setLoadError(null);
        // O PDF anterior é liberado pelo cleanup do efeito abaixo.
        setPdf(doc);
        setSizes(pageSizes);
      } catch (err) {
        if (!cancelled) setLoadError(`Não foi possível exibir o PDF: ${(err as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
    // readingPosition muda com o zoom; aqui só interessa a troca de PDF.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => () => void (pdf && loadingTasks.get(pdf)?.destroy()), [pdf]);

  // Depois de montar as páginas do PDF novo, volta para a mesma posição.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const target = restoreRef.current;
    if (!el || !target || sizes.length === 0) return;
    restoreRef.current = null;
    const page = Math.min(target.page, sizes.length);
    let top = 16;
    for (let i = 0; i < page - 1; i++) top += sizes[i]!.height * scale + PAGE_GAP;
    el.scrollTop = top + target.offset * sizes[page - 1]!.height * scale;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf]);

  // Quais páginas estão visíveis (para desenhar só elas) e qual é a atual.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || sizes.length === 0) return;
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight;
    const next = new Set<number>();
    let top = 16;
    let current = 1;
    for (let i = 0; i < sizes.length; i++) {
      const h = sizes[i]!.height * scale;
      if (top + h >= viewTop - el.clientHeight && top <= viewBottom + el.clientHeight) next.add(i + 1);
      if (top <= viewTop + el.clientHeight / 3) current = i + 1;
      top += h + PAGE_GAP;
    }
    setVisible((prev) => (prev.size === next.size && [...next].every((p) => prev.has(p)) ? prev : next));
    setCurrentPage(current);
    setPageInput(String(current));
  }, [sizes, scale]);

  useEffect(onScroll, [onScroll, pdf]);

  // Desenha as páginas visíveis na escala atual.
  useEffect(() => {
    if (!pdf) return;
    const dpr = window.devicePixelRatio || 1;
    const tasks = renders.current;
    let cancelled = false;
    for (const pageNumber of visible) {
      const canvas = canvases.current.get(pageNumber);
      if (!canvas || pageNumber > pdf.numPages) continue;
      tasks.get(pageNumber)?.cancel();
      void pdf.getPage(pageNumber).then((page) => {
        if (cancelled) return;
        const viewport = page.getViewport({ scale: scale * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const task = page.render({ canvas, viewport });
        tasks.set(pageNumber, task);
        task.promise.catch(() => undefined);
      });
    }
    return () => {
      cancelled = true;
      for (const task of tasks.values()) task.cancel();
      tasks.clear();
    };
  }, [pdf, visible, scale]);

  const goToPage = (page: number) => {
    const el = scrollRef.current;
    if (!el || sizes.length === 0) return;
    const target = Math.min(Math.max(1, page), sizes.length);
    let top = 16;
    for (let i = 0; i < target - 1; i++) top += sizes[i]!.height * scale + PAGE_GAP;
    el.scrollTo({ top: top - 8 });
  };

  const changeZoom = (direction: 1 | -1) => {
    const position = readingPosition();
    const next =
      direction > 0 ? ZOOM_STEPS.find((z) => z > scale + 0.001) ?? ZOOM_STEPS.at(-1)! : [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.001) ?? ZOOM_STEPS[0]!;
    restoreRef.current = position;
    setZoom(next);
  };

  // Mantém a posição de leitura também ao mudar o zoom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const target = restoreRef.current;
    if (!el || !target || sizes.length === 0 || !pdf) return;
    restoreRef.current = null;
    let top = 16;
    for (let i = 0; i < target.page - 1; i++) top += sizes[i]!.height * scale + PAGE_GAP;
    el.scrollTop = top + target.offset * sizes[target.page - 1]!.height * scale;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  if (!data) {
    return (
      <div className="pdf-viewer pdf-viewer-empty">
        <div className="pdf-empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
          <p>{emptyMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar" role="toolbar" aria-label="Controles do PDF">
        <div className="pdf-toolbar-group">
          <button className="pdf-btn" onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} aria-label="Página anterior" title="Página anterior">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
          </button>
          <label className="pdf-page">
            <span className="visually-hidden">Página</span>
            <input
              value={pageInput}
              inputMode="numeric"
              aria-label="Página atual"
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && goToPage(Number(pageInput) || 1)}
              onBlur={() => setPageInput(String(currentPage))}
            />
            <span>de {sizes.length || '…'}</span>
          </label>
          <button className="pdf-btn" onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= sizes.length} aria-label="Próxima página" title="Próxima página">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </button>
        </div>
        <div className="pdf-toolbar-group">
          <button className="pdf-btn" onClick={() => changeZoom(-1)} aria-label="Diminuir zoom" title="Diminuir zoom">−</button>
          <span className="pdf-zoom" aria-live="polite">{Math.round(scale * 100)}%</span>
          <button className="pdf-btn" onClick={() => changeZoom(1)} aria-label="Aumentar zoom" title="Aumentar zoom">+</button>
          <button
            className={`pdf-btn pdf-btn-text ${zoom === 'fit' ? 'active' : ''}`}
            onClick={() => {
              restoreRef.current = readingPosition();
              setZoom('fit');
            }}
            title="Ajustar à largura"
          >
            Largura
          </button>
        </div>
      </div>

      {loadError && <div className="pdf-error">{loadError}</div>}

      <div className="pdf-scroll" ref={scrollRef} onScroll={onScroll} data-testid="pdf-scroll">
        {sizes.map((size, i) => (
          <div
            key={i}
            className="pdf-page-box"
            style={{ width: size.width * scale, height: size.height * scale }}
            aria-label={`Página ${i + 1}`}
          >
            <canvas
              ref={(el) => {
                if (el) canvases.current.set(i + 1, el);
                else canvases.current.delete(i + 1);
              }}
              style={{ width: size.width * scale, height: size.height * scale }}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export default PdfViewer;
