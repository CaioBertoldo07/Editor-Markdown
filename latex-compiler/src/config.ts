/**
 * Configuração do serviço de compilação. Todos os limites são configuráveis
 * por variável de ambiente; os padrões cabem num serviço de 2–4 GB.
 *
 * Este serviço NÃO recebe credenciais de banco nem segredos da API: só o
 * token que a API usa para chamá-lo.
 */

const int = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} precisa ser um inteiro entre ${min} e ${max}`);
  }
  return value;
};

export type Limits = {
  /** Tempo total (relógio) de uma compilação, com todas as passagens. */
  timeoutMs: number;
  /** CPU por processo (RLIMIT_CPU). */
  cpuSeconds: number;
  /** Espaço de endereçamento por processo (RLIMIT_AS). */
  memoryBytes: number;
  /** Maior arquivo que o TeX pode escrever (RLIMIT_FSIZE). */
  fileSizeBytes: number;
  /** Soma de tudo no diretório da compilação (entrada + saída). */
  jobDiskBytes: number;
  maxProcesses: number;
  maxOpenFiles: number;
  /** Corpo da requisição (projeto inteiro). */
  requestBytes: number;
  maxFiles: number;
  maxPdfBytes: number;
  /** Quanto do log volta para a API. */
  maxLogBytes: number;
};

export type Config = {
  port: number;
  host: string;
  token: string;
  jobsDir: string;
  concurrency: number;
  queueLength: number;
  queueWaitMs: number;
  limits: Limits;
  /** Primeiro UID/GID dos slots (texjob1 = base + 1). */
  slotUidBase: number;
  sandboxBinary: string;
  latexmkrc: string;
};

const MB = 1024 * 1024;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.COMPILER_TOKEN ?? '';
  if (token.length < 32) throw new Error('COMPILER_TOKEN precisa de pelo menos 32 caracteres');

  const timeoutMs = int(env, 'COMPILE_TIMEOUT_MS', 60_000, 5_000, 300_000);
  return {
    port: int(env, 'PORT', 8080, 1, 65535),
    host: env.HOST || '::',
    token,
    jobsDir: env.JOBS_DIR || '/var/lib/latex-jobs',
    // Há 8 usuários de slot na imagem (texjob1..texjob8).
    concurrency: int(env, 'COMPILE_CONCURRENCY', 2, 1, 8),
    queueLength: int(env, 'COMPILE_QUEUE_LENGTH', 8, 0, 100),
    queueWaitMs: int(env, 'COMPILE_QUEUE_WAIT_MS', 30_000, 1_000, 300_000),
    limits: {
      timeoutMs,
      cpuSeconds: int(env, 'COMPILE_CPU_SECONDS', Math.ceil(timeoutMs / 1000), 5, 600),
      memoryBytes: int(env, 'COMPILE_MEMORY_MB', 2048, 256, 16_384) * MB,
      fileSizeBytes: int(env, 'COMPILE_MAX_FILE_MB', 64, 1, 1024) * MB,
      jobDiskBytes: int(env, 'COMPILE_MAX_DISK_MB', 256, 16, 4096) * MB,
      maxProcesses: int(env, 'COMPILE_MAX_PROCESSES', 32, 4, 256),
      maxOpenFiles: int(env, 'COMPILE_MAX_OPEN_FILES', 256, 32, 4096),
      requestBytes: int(env, 'COMPILE_MAX_REQUEST_MB', 64, 1, 512) * MB,
      maxFiles: int(env, 'COMPILE_MAX_FILES', 500, 1, 5000),
      maxPdfBytes: int(env, 'COMPILE_MAX_PDF_MB', 25, 1, 200) * MB,
      maxLogBytes: int(env, 'COMPILE_MAX_LOG_KB', 512, 16, 8192) * 1024,
    },
    slotUidBase: 20_000,
    sandboxBinary: env.SANDBOX_BINARY || '/usr/local/bin/sandbox-exec',
    latexmkrc: env.LATEXMKRC || '/etc/latex-compiler/latexmkrc',
  };
}
