import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { detectEngine, LATEXMK_FLAG, type Engine } from './engine.js';
import {
  finalizeDiagnostics,
  parseBiberLog,
  parseBibtexLog,
  parseTexLog,
  type Diagnostic,
} from './logParser.js';
import { normalizeProjectPath } from './paths.js';
import { killSlotProcesses, sandboxArgs, slotFor, texEnvironment, type Slot } from './sandbox.js';

export type ProjectFile = { path: string; data: Uint8Array };

export type CompileStatus = 'success' | 'warnings' | 'error' | 'timeout' | 'cancelled' | 'too_large';

export type CompileOutcome = {
  status: CompileStatus;
  engine: Engine;
  engineSource: 'request' | 'magic-comment' | 'packages' | 'default';
  durationMs: number;
  diagnostics: Diagnostic[];
  /** Log principal do TeX (última passagem), truncado. */
  log: string;
  /** Saída do latexmk (passagens, BibTeX/Biber), truncada. */
  output: string;
  pdf: Buffer | null;
};

export class InvalidProjectError extends Error {
  constructor(public readonly issue: string) {
    super(issue);
  }
}

/** Confere o projeto inteiro antes de tocar no disco. */
export function validateProject(
  mainFile: string,
  files: ProjectFile[],
  limits: Config['limits']
): { mainFile: string; files: ProjectFile[] } {
  if (files.length === 0) throw new InvalidProjectError('projeto sem arquivos');
  if (files.length > limits.maxFiles) throw new InvalidProjectError(`mais de ${limits.maxFiles} arquivos`);
  const seen = new Set<string>();
  const normalized = files.map((file) => {
    let p: string;
    try {
      p = normalizeProjectPath(file.path);
    } catch (err) {
      throw new InvalidProjectError(`caminho inválido "${file.path}": ${(err as Error).message}`);
    }
    const key = p.toLowerCase();
    if (seen.has(key)) throw new InvalidProjectError(`arquivo repetido: ${p}`);
    seen.add(key);
    return { path: p, data: file.data };
  });
  // Uma pasta e um arquivo com o mesmo nome ("a" e "a/b.tex") não cabem no disco.
  for (const key of seen) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join('/'))) throw new InvalidProjectError(`"${parts.slice(0, i).join('/')}" é arquivo e pasta ao mesmo tempo`);
    }
  }
  let main: string;
  try {
    main = normalizeProjectPath(mainFile);
  } catch {
    throw new InvalidProjectError('arquivo principal inválido');
  }
  if (!main.toLowerCase().endsWith('.tex')) throw new InvalidProjectError('o arquivo principal precisa ser .tex');
  if (!normalized.some((f) => f.path === main)) throw new InvalidProjectError('o arquivo principal não está no projeto');
  return { mainFile: main, files: normalized };
}

const decoder = new TextDecoder('utf-8');

/**
 * Lê um arquivo produzido pela compilação SEM seguir links simbólicos e só se
 * for um arquivo comum do UID do slot (o processo do TeX não é confiável; o
 * serviço, que roda como root, nunca pode ser enganado para ler outro arquivo).
 */
async function readJobOutput(file: string, slot: Slot, maxBytes: number): Promise<Buffer | null | 'too_large'> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.uid !== slot.uid || st.nlink !== 1) return null;
    if (st.size > maxBytes) return 'too_large';
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readText(file: string, slot: Slot, maxBytes: number): Promise<string> {
  const data = await readJobOutput(file, slot, maxBytes * 4);
  if (!data || data === 'too_large') return '';
  const text = decoder.decode(data);
  return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n[... log truncado ...]` : text;
}

/** Tamanho total do diretório (sem seguir links). */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else {
      try {
        total += (await lstat(full)).size;
      } catch {
        /* apagado no meio do caminho */
      }
    }
  }
  return total;
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[... truncado ...]` : text);

/** Tira o caminho do diretório temporário dos logs. */
const sanitize = (text: string, jobDir: string) => text.split(`${jobDir}/`).join('').split(jobDir).join('.');

export async function compileProject(
  config: Config,
  slotIndex: number,
  input: { mainFile: string; files: ProjectFile[]; engine?: Engine },
  signal: AbortSignal
): Promise<CompileOutcome> {
  const started = Date.now();
  const limits = config.limits;
  const { mainFile, files } = validateProject(input.mainFile, input.files, limits);
  const slot = slotFor(config, slotIndex);

  const mainSource = decoder.decode(files.find((f) => f.path === mainFile)!.data);
  const detected = detectEngine(mainSource);
  const engine = input.engine ?? detected.engine;
  const engineSource = input.engine ? 'request' : detected.source;

  const jobDir = await mkdtemp(path.join(config.jobsDir, 'job-'));
  try {
    for (const file of files) {
      const target = path.join(jobDir, ...file.path.split('/'));
      // Defesa extra além da validação: o destino tem que ficar dentro do diretório.
      if (!target.startsWith(jobDir + path.sep)) throw new InvalidProjectError(`caminho inválido: ${file.path}`);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.data, { flag: 'wx', mode: 0o600 });
    }
    for (const sub of ['.tmp', '.texmf-var', '.texmf-config']) await mkdir(path.join(jobDir, sub), { mode: 0o700 });
    // Tudo passa a ser do UID do slot; o diretório continua 0700.
    const chown = spawnSync('chown', ['-R', `${slot.uid}:${slot.gid}`, jobDir]);
    if (chown.status !== 0) throw new Error('chown falhou');

    const command = [
      'latexmk',
      '-norc',
      '-r', config.latexmkrc,
      LATEXMK_FLAG[engine],
      '-interaction=nonstopmode',
      '-file-line-error',
      mainFile,
    ];

    const child = spawn(config.sandboxBinary, sandboxArgs(config, slot, limits, command), {
      cwd: jobDir,
      env: texEnvironment(jobDir, engine),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let output = '';
    const collect = (chunk: Buffer) => {
      if (output.length < limits.maxLogBytes * 2) output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let stopReason: 'timeout' | 'cancelled' | 'too_large' | null = null;
    const stop = (reason: NonNullable<typeof stopReason>) => {
      if (stopReason) return;
      stopReason = reason;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* já terminou */
      }
      killSlotProcesses(slot);
    };

    const timer = setTimeout(() => stop('timeout'), limits.timeoutMs);
    const onAbort = () => stop('cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) stop('cancelled');
    let checkingDisk = false;
    const diskWatch = setInterval(async () => {
      if (checkingDisk) return;
      checkingDisk = true;
      try {
        if ((await dirSize(jobDir)) > limits.jobDiskBytes) stop('too_large');
      } finally {
        checkingDisk = false;
      }
    }, 500);

    const exit = await new Promise<{ code: number | null }>((resolve) => {
      child.on('error', () => resolve({ code: null }));
      child.on('close', (code) => resolve({ code }));
    });
    clearTimeout(timer);
    clearInterval(diskWatch);
    signal.removeEventListener('abort', onAbort);
    killSlotProcesses(slot);

    const stem = path.posix.basename(mainFile, path.posix.extname(mainFile));
    const projectFiles = new Set(files.map((f) => f.path));
    const log = sanitize(await readText(path.join(jobDir, `${stem}.log`), slot, limits.maxLogBytes), jobDir);
    const blg = sanitize(await readText(path.join(jobDir, `${stem}.blg`), slot, limits.maxLogBytes), jobDir);
    const cleanOutput = truncate(sanitize(output, jobDir), limits.maxLogBytes);

    const diagnostics: Diagnostic[] = [...parseTexLog(log, projectFiles)];
    if (blg) diagnostics.push(...(/^\[\d+\]/m.test(blg) ? parseBiberLog(blg) : parseBibtexLog(blg)));

    const base = { engine, engineSource, log: truncate(log, limits.maxLogBytes), output: cleanOutput } as const;
    const done = (status: CompileStatus, extra: Diagnostic[] = [], pdf: Buffer | null = null): CompileOutcome => ({
      ...base,
      status,
      durationMs: Date.now() - started,
      diagnostics: finalizeDiagnostics([...extra, ...diagnostics]),
      pdf,
    });

    if (stopReason === 'cancelled') return done('cancelled');
    if (stopReason === 'timeout') {
      return done('timeout', [
        {
          severity: 'error',
          file: null,
          line: null,
          message: `A compilação passou do tempo limite de ${Math.round(limits.timeoutMs / 1000)} s e foi encerrada. Verifique se há laços infinitos ou um documento muito pesado.`,
          raw: 'timeout',
          source: 'latexmk',
        },
      ]);
    }
    if (stopReason === 'too_large') {
      return done('too_large', [
        {
          severity: 'error',
          file: null,
          line: null,
          message: `A compilação gerou mais de ${Math.round(limits.jobDiskBytes / 1024 / 1024)} MB de arquivos e foi encerrada.`,
          raw: 'disk limit',
          source: 'latexmk',
        },
      ]);
    }

    const pdf = await readJobOutput(path.join(jobDir, `${stem}.pdf`), slot, limits.maxPdfBytes);
    if (pdf === 'too_large') {
      return done('too_large', [
        {
          severity: 'error',
          file: null,
          line: null,
          message: `O PDF gerado passou de ${Math.round(limits.maxPdfBytes / 1024 / 1024)} MB.`,
          raw: 'pdf limit',
          source: 'latexmk',
        },
      ]);
    }

    const hasErrors = diagnostics.some((d) => d.severity === 'error');
    const validPdf = pdf !== null && pdf.subarray(0, 5).toString('latin1') === '%PDF-';
    if (exit.code !== 0 || hasErrors || !validPdf) {
      const extra: Diagnostic[] = [];
      if (!hasErrors) {
        const latexmkError = cleanOutput
          .split('\n')
          .find((l) => /^Latexmk: (Missing input file|.*[Ee]rror)/.test(l) || /^sandbox-exec:/.test(l));
        extra.push({
          severity: 'error',
          file: null,
          line: null,
          message: latexmkError
            ? `A compilação falhou: ${latexmkError.replace(/^Latexmk:\s*/, '')}`
            : 'A compilação falhou sem gerar o PDF. Veja o log completo para os detalhes.',
          raw: latexmkError ?? `exit ${exit.code}`,
          source: 'latexmk',
        });
      }
      return done('error', extra);
    }
    const hasWarnings = diagnostics.some((d) => d.severity === 'warning');
    return done(hasWarnings ? 'warnings' : 'success', [], pdf);
  } finally {
    killSlotProcesses(slot);
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Remove restos de compilações anteriores (ex.: o serviço reiniciou no meio de uma). */
export async function sweepJobsDir(jobsDir: string) {
  const entries = await readdir(jobsDir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((name) => name.startsWith('job-') || name.startsWith('selftest-'))
      .map((name) => rm(path.join(jobsDir, name), { recursive: true, force: true }).catch(() => undefined))
  );
}
