import { useState } from 'react';
import type { CompileDiagnostic, CompileJob } from '../../lib/api';

/**
 * Problemas da última compilação: mensagem amigável primeiro, local clicável
 * (arquivo:linha) e o texto original do TeX logo abaixo. O log completo fica
 * num painel expansível — disponível, mas sem atrapalhar quem está aprendendo.
 */

interface DiagnosticsPanelProps {
  job: CompileJob | null;
  onNavigate: (file: string, line: number) => void;
  projectFiles: string[];
}

const LABEL: Record<CompileDiagnostic['severity'], string> = { error: 'Erro', warning: 'Aviso', info: 'Info' };

const icon = (severity: CompileDiagnostic['severity']) =>
  severity === 'error' ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
  ) : severity === 'warning' ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
  );

const DiagnosticsPanel: React.FC<DiagnosticsPanelProps> = ({ job, onNavigate, projectFiles }) => {
  const [showInfo, setShowInfo] = useState(false);
  const all = job?.diagnostics ?? [];
  const counts = {
    error: all.filter((d) => d.severity === 'error').length,
    warning: all.filter((d) => d.severity === 'warning').length,
    info: all.filter((d) => d.severity === 'info').length,
  };
  const shown = showInfo ? all : all.filter((d) => d.severity !== 'info');
  const log = [job?.log, job?.output].filter(Boolean).join('\n\n---- saída do latexmk ----\n\n');

  if (!job) {
    return (
      <div className="latex-diagnostics">
        <p className="latex-diagnostics-empty">Compile para ver erros e avisos aqui.</p>
      </div>
    );
  }

  return (
    <div className="latex-diagnostics">
      <div className="latex-diagnostics-summary" aria-live="polite">
        <span className={`diag-count diag-error ${counts.error ? '' : 'zero'}`}>{icon('error')} {counts.error} {counts.error === 1 ? 'erro' : 'erros'}</span>
        <span className={`diag-count diag-warning ${counts.warning ? '' : 'zero'}`}>{icon('warning')} {counts.warning} {counts.warning === 1 ? 'aviso' : 'avisos'}</span>
        {counts.info > 0 && (
          <button className="diag-toggle-info" onClick={() => setShowInfo((v) => !v)} aria-pressed={showInfo}>
            {icon('info')} {counts.info} {showInfo ? 'ocultar informações' : 'informações'}
          </button>
        )}
      </div>

      {job.message && <p className="latex-diagnostics-message">{job.message}</p>}

      {shown.length === 0 && !job.message ? (
        <p className="latex-diagnostics-empty">Nenhum problema encontrado.</p>
      ) : (
        <ul className="latex-diagnostics-list">
          {shown.map((d, i) => {
            const navigable = d.file !== null && d.line !== null && projectFiles.includes(d.file);
            return (
              <li key={i} className={`diag-item diag-${d.severity}`}>
                <button
                  className="diag-main"
                  disabled={!navigable}
                  onClick={() => navigable && onNavigate(d.file!, d.line!)}
                  title={navigable ? `Ir para ${d.file}:${d.line}` : undefined}
                >
                  <span className="diag-badge">{icon(d.severity)}<span className="visually-hidden">{LABEL[d.severity]}</span></span>
                  <span className="diag-text">
                    <span className="diag-message">{d.message}</span>
                    {(d.file || d.line) && (
                      <span className="diag-location">
                        {d.file ?? '?'}
                        {d.line ? `:${d.line}` : ''}
                      </span>
                    )}
                  </span>
                </button>
                {d.raw && d.raw !== d.message && <code className="diag-raw">{d.raw}</code>}
              </li>
            );
          })}
        </ul>
      )}

      {log && (
        <details className="latex-log">
          <summary>Log técnico completo</summary>
          <pre>{log}</pre>
        </details>
      )}
    </div>
  );
};

export default DiagnosticsPanel;
