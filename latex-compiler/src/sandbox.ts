import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Config, Limits } from './config.js';
import type { Engine } from './engine.js';

/**
 * Execução de comandos do TeX pelo sandbox-exec (ver sandbox/sandbox-exec.c):
 * UID do slot, limites de recursos, seccomp sem rede e ambiente mínimo.
 */

export type Slot = { index: number; uid: number; gid: number };

export const slotFor = (config: Config, index: number): Slot => ({
  index,
  uid: config.slotUidBase + index,
  gid: config.slotUidBase + index,
});

/**
 * Ambiente das compilações: só o necessário para o TeX. Nada do ambiente do
 * serviço (onde está o COMPILER_TOKEN) é repassado.
 *
 * Leitura: "p" (só o projeto) em pdfTeX/XeTeX. O LuaLaTeX precisa de "r": o
 * luaotfload abre arquivos da árvore do TeX por caminho absoluto com io.open,
 * que o modo "p" bloqueia. Nesse caso a barreira é o UID do slot: o processo
 * só lê arquivos do sistema que qualquer usuário lê (nunca o ambiente do
 * serviço nem o diretório de outra compilação). Escrita é "p" sempre.
 */
export function texEnvironment(jobDir: string, engine: Engine = 'pdflatex'): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: jobDir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    TMPDIR: path.join(jobDir, '.tmp'),
    TEXMFVAR: path.join(jobDir, '.texmf-var'),
    TEXMFCONFIG: path.join(jobDir, '.texmf-config'),
    TEXMFOUTPUT: jobDir,
    // Repetem o 99-sandbox.cnf: variáveis de ambiente têm precedência no kpathsea.
    shell_escape: 'f',
    openin_any: engine === 'lualatex' ? 'r' : 'p',
    openout_any: 'p',
    parse_first_line: 'f',
    MKTEXPK: '0',
    MKTEXTFM: '0',
    MKTEXMF: '0',
    MKTEXFMT: '0',
    max_print_line: '10000',
    error_line: '254',
    half_error_line: '238',
  };
}

export function sandboxArgs(config: Config, slot: Slot, limits: Limits, command: string[]): string[] {
  return [
    '--uid', String(slot.uid),
    '--gid', String(slot.gid),
    '--cpu', String(limits.cpuSeconds),
    '--mem', String(limits.memoryBytes),
    '--fsize', String(limits.fileSizeBytes),
    '--nproc', String(limits.maxProcesses),
    '--nofile', String(limits.maxOpenFiles),
    '--',
    ...command,
  ];
}

/** Mata tudo que ainda roda com o UID do slot (inclusive processos que fugiram do grupo). */
export function killSlotProcesses(slot: Slot) {
  spawnSync('pkill', ['-KILL', '-u', String(slot.uid)], { stdio: 'ignore' });
}

export type RunResult = { code: number | null; signal: NodeJS.Signals | null; output: string };

/** Roda um comando no sandbox e espera terminar (usado no autoteste). */
export function runSandboxed(
  config: Config,
  slot: Slot,
  limits: Limits,
  command: string[],
  cwd: string,
  timeoutMs = 15_000
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(config.sandboxBinary, sandboxArgs(config, slot, limits, command), {
      cwd,
      env: texEnvironment(cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      if (output.length < 64 * 1024) output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* já terminou */
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, output: String(err) });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}

export type SelfTest = { ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> };

/**
 * Autoteste na subida: só libera compilações se o isolamento funcionar de
 * verdade neste ambiente. Nunca há modo "sem sandbox".
 */
export async function sandboxSelfTest(config: Config): Promise<SelfTest> {
  const checks: SelfTest['checks'] = [];
  const slot = slotFor(config, 1);
  const dir = await mkdtemp(path.join(config.jobsDir, 'selftest-'));
  spawnSync('chown', [`${slot.uid}:${slot.gid}`, dir]);
  const limits = { ...config.limits, cpuSeconds: 10 };
  const check = async (name: string, command: string[], expect: (r: RunResult) => boolean) => {
    const result = await runSandboxed(config, slot, limits, command, dir);
    const ok = expect(result);
    checks.push({ name, ok, ...(ok ? {} : { detail: `code=${result.code} ${result.output.slice(0, 300)}` }) });
  };

  try {
    if (process.getuid?.() !== 0) {
      checks.push({ name: 'serviço como root (para trocar de UID)', ok: false, detail: `uid=${process.getuid?.()}` });
    }
    await check('roda com o UID do slot', ['/bin/sh', '-c', 'id -u'], (r) => r.code === 0 && r.output.trim() === String(slot.uid));
    await check(
      'socket IPv4 bloqueado',
      ['perl', '-MSocket', '-e', 'socket(my $s, PF_INET, SOCK_STREAM, 0) ? exit(0) : exit(42)'],
      (r) => r.code === 42
    );
    await check(
      'socket IPv6 bloqueado',
      ['perl', '-MSocket', '-e', 'socket(my $s, PF_INET6, SOCK_STREAM, 0) ? exit(0) : exit(42)'],
      (r) => r.code === 42
    );
    await check('ambiente do serviço inacessível', ['/bin/sh', '-c', 'cat /proc/1/environ >/dev/null 2>&1 && exit 0 || exit 42'], (r) => r.code === 42);
    await check('sem root de volta', ['/bin/sh', '-c', 'test "$(id -u)" != 0 && exit 42'], (r) => r.code === 42);
    await check('shell-escape desligado', ['kpsewhich', '-var-value=shell_escape'], (r) => r.output.trim() === 'f');
    await check('leitura restrita (openin_any=p)', ['kpsewhich', '-var-value=openin_any'], (r) => r.output.trim() === 'p');
    await check('escrita restrita (openout_any=p)', ['kpsewhich', '-var-value=openout_any'], (r) => r.output.trim() === 'p');
  } finally {
    killSlotProcesses(slot);
    await rm(dir, { recursive: true, force: true });
  }
  return { ok: checks.every((c) => c.ok), checks };
}
