import { randomUUID } from 'node:crypto';
import type { StoredFile } from './files.js';

/**
 * Compilações em andamento e resultados recentes, em memória.
 *
 * Por que assíncrono: o proxy da Vercel (Routing Middleware) precisa começar a
 * responder em ~25 s, e uma compilação pode levar mais. O navegador cria a
 * compilação (POST), acompanha com long-poll (GET ?wait=1, até 20 s por
 * chamada) e baixa o PDF no fim.
 *
 * Isolamento: o ID é um UUID aleatório E toda leitura confere o dono — um job
 * de outro usuário responde 404, igual a um inexistente. Os resultados
 * (log + PDF) expiram em poucos minutos e nunca são compartilhados entre
 * usuários nem entre documentos.
 *
 * Limitação: vale para UMA réplica da API (como hoje no Railway). Com várias
 * réplicas, os jobs precisariam de um armazenamento compartilhado.
 */

export type JobStatus =
  | 'running'
  | 'success'
  | 'warnings'
  | 'error'
  | 'timeout'
  | 'cancelled'
  | 'too_large'
  | 'busy'
  | 'unavailable';

export type Diagnostic = {
  severity: 'error' | 'warning' | 'info';
  file: string | null;
  line: number | null;
  message: string;
  raw: string;
  source: string;
};

export type JobResult = {
  engine: string | null;
  durationMs: number | null;
  diagnostics: Diagnostic[];
  log: string;
  output: string;
  pdfBytes: number;
  message: string | null;
};

type Job = {
  id: string;
  userId: string;
  documentId: string;
  status: JobStatus;
  createdAt: number;
  finishedAt: number | null;
  result: JobResult | null;
  pdf: Buffer | null;
  controller: AbortController;
  waiters: Set<() => void>;
};

export type CompilerClientOptions = {
  url: string;
  token: string;
  timeoutMs: number;
};

export type CompileRequest = { mainFile: string; engine?: string; files: StoredFile[] };

/** Fala com o serviço de compilação (rede privada) e traduz a resposta. */
export async function callCompiler(
  options: CompilerClientOptions,
  request: CompileRequest,
  signal: AbortSignal
): Promise<{ status: JobStatus; result: JobResult; pdf: Buffer | null }> {
  const form = new FormData();
  form.set(
    'manifest',
    JSON.stringify({
      mainFile: request.mainFile,
      ...(request.engine ? { engine: request.engine } : {}),
      files: request.files.map((f, i) => ({ path: f.path, field: `f${i}` })),
    })
  );
  request.files.forEach((f, i) => {
    const bytes = f.data ? new Uint8Array(f.data) : new TextEncoder().encode(f.content ?? '');
    form.set(`f${i}`, new Blob([bytes]));
  });

  const empty = (message: string): JobResult => ({
    engine: null,
    durationMs: null,
    diagnostics: [],
    log: '',
    output: '',
    pdfBytes: 0,
    message,
  });

  const timeout = AbortSignal.timeout(options.timeoutMs);
  let res: Response;
  try {
    res = await fetch(new URL('/compile', options.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}` },
      body: form,
      signal: AbortSignal.any([signal, timeout]),
    });
  } catch {
    if (signal.aborted) return { status: 'cancelled', result: empty('Compilação cancelada.'), pdf: null };
    if (timeout.aborted) return { status: 'timeout', result: empty('O compilador não respondeu a tempo.'), pdf: null };
    return { status: 'unavailable', result: empty('O serviço de compilação está indisponível no momento.'), pdf: null };
  }

  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error === 'compiler_busy'
      ? { status: 'busy', result: empty('O compilador está ocupado. Tente de novo em alguns segundos.'), pdf: null }
      : { status: 'unavailable', result: empty('O serviço de compilação está indisponível no momento.'), pdf: null };
  }
  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { issue?: string };
    return { status: 'error', result: empty(`Projeto inválido: ${body.issue ?? 'verifique os arquivos'}.`), pdf: null };
  }
  if (!res.ok) {
    return { status: 'unavailable', result: empty('O serviço de compilação respondeu com erro.'), pdf: null };
  }

  const data = await res.formData();
  const parsed = JSON.parse(String(data.get('result'))) as Omit<JobResult, 'message'> & { status: JobStatus };
  const pdfEntry = data.get('pdf');
  const pdf = pdfEntry instanceof Blob ? Buffer.from(await pdfEntry.arrayBuffer()) : null;
  return {
    status: parsed.status,
    result: {
      engine: parsed.engine,
      durationMs: parsed.durationMs,
      diagnostics: parsed.diagnostics,
      log: parsed.log,
      output: parsed.output,
      pdfBytes: pdf?.length ?? 0,
      message: null,
    },
    pdf,
  };
}

const MAX_FINISHED_PER_USER = 4;

export class TooManyCompilesError extends Error {
  constructor(public readonly reason: 'active' | 'rate') {
    super(reason);
  }
}

export type JobManagerOptions = {
  /** Compilações simultâneas por usuário (documentos diferentes). */
  maxActivePerUser: number;
  /** Compilações iniciadas por usuário por minuto. */
  ratePerMinute: number;
  /** Quanto tempo o resultado (e o PDF) fica disponível depois de terminar. */
  retentionMs: number;
  /** Soma dos PDFs guardados em memória; acima disso, os mais antigos saem. */
  maxStoredPdfBytes: number;
};

export const DEFAULT_JOB_OPTIONS: JobManagerOptions = {
  maxActivePerUser: 2,
  ratePerMinute: 20,
  retentionMs: 10 * 60_000,
  maxStoredPdfBytes: 256 * 1024 * 1024,
};

export class CompileJobs {
  private jobs = new Map<string, Job>();
  private starts = new Map<string, number[]>();

  constructor(
    private readonly run: (request: CompileRequest, signal: AbortSignal) => ReturnType<typeof callCompiler>,
    private readonly options: JobManagerOptions = DEFAULT_JOB_OPTIONS
  ) {}

  /**
   * Começa uma compilação. Se o mesmo documento já está compilando, a anterior
   * é cancelada: o resultado dela ficaria obsoleto.
   */
  start(userId: string, documentId: string, request: CompileRequest): Job {
    this.sweep();
    for (const job of this.jobs.values()) {
      if (job.userId === userId && job.documentId === documentId && job.status === 'running') this.cancel(job);
    }
    const active = [...this.jobs.values()].filter((j) => j.userId === userId && j.status === 'running').length;
    if (active >= this.options.maxActivePerUser) throw new TooManyCompilesError('active');

    const now = Date.now();
    const recent = (this.starts.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.options.ratePerMinute) throw new TooManyCompilesError('rate');
    recent.push(now);
    this.starts.set(userId, recent);

    const job: Job = {
      id: randomUUID(),
      userId,
      documentId,
      status: 'running',
      createdAt: now,
      finishedAt: null,
      result: null,
      pdf: null,
      controller: new AbortController(),
      waiters: new Set(),
    };
    this.jobs.set(job.id, job);

    this.run(request, job.controller.signal)
      .then(({ status, result, pdf }) => this.finish(job, status, result, pdf))
      .catch(() =>
        this.finish(job, 'unavailable', {
          engine: null,
          durationMs: null,
          diagnostics: [],
          log: '',
          output: '',
          pdfBytes: 0,
          message: 'Falha inesperada ao compilar.',
        }, null)
      );
    return job;
  }

  /** Job do usuário (ou undefined: inexistente, expirado ou de outra pessoa). */
  get(userId: string, jobId: string): Job | undefined {
    const job = this.jobs.get(jobId);
    return job && job.userId === userId ? job : undefined;
  }

  /** Espera o job sair de "running" (ou o tempo acabar). */
  async wait(job: Job, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (job.status !== 'running') return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        job.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      job.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  cancel(job: Job) {
    if (job.status !== 'running') return;
    job.controller.abort();
    this.finish(job, 'cancelled', {
      engine: null,
      durationMs: null,
      diagnostics: [],
      log: '',
      output: '',
      pdfBytes: 0,
      message: 'Compilação cancelada.',
    }, null);
  }

  view(job: Job) {
    return {
      id: job.id,
      documentId: job.documentId,
      status: job.status,
      createdAt: new Date(job.createdAt).toISOString(),
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      hasPdf: job.pdf !== null,
      ...(job.result ?? {}),
    };
  }

  private finish(job: Job, status: JobStatus, result: JobResult, pdf: Buffer | null) {
    if (job.status !== 'running') return; // já cancelado
    job.status = status;
    job.result = result;
    job.pdf = pdf;
    job.finishedAt = Date.now();
    for (const waiter of [...job.waiters]) waiter();
    this.sweep();
  }

  /** Expira resultados antigos e respeita o teto de memória dos PDFs. */
  private sweep() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && now - job.finishedAt > this.options.retentionMs) this.jobs.delete(id);
    }
    // Cada usuário guarda só os últimos resultados: um usuário não consegue
    // empurrar para fora da memória os PDFs dos outros.
    const perUser = new Map<string, Job[]>();
    for (const job of this.jobs.values()) {
      if (!job.finishedAt) continue;
      perUser.set(job.userId, [...(perUser.get(job.userId) ?? []), job]);
    }
    for (const jobs of perUser.values()) {
      jobs.sort((a, b) => b.finishedAt! - a.finishedAt!);
      for (const old of jobs.slice(MAX_FINISHED_PER_USER)) this.jobs.delete(old.id);
    }
    const finished = [...this.jobs.values()].filter((j) => j.pdf).sort((a, b) => a.finishedAt! - b.finishedAt!);
    let total = finished.reduce((sum, j) => sum + j.pdf!.length, 0);
    for (const job of finished) {
      if (total <= this.options.maxStoredPdfBytes) break;
      total -= job.pdf!.length;
      this.jobs.delete(job.id);
    }
    for (const [userId, times] of this.starts) {
      const recent = times.filter((t) => now - t < 60_000);
      if (recent.length === 0) this.starts.delete(userId);
      else this.starts.set(userId, recent);
    }
  }
}
