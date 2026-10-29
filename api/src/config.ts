import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Interface de escuta: 0.0.0.0 (IPv4) ou :: (IPv6/dual-stack, se o host suportar). */
  HOST: z.string().min(1).default('0.0.0.0'),
  /** Conexão do papel app_api (nunca o administrador). */
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET precisa de pelo menos 32 caracteres'),
  /** Origem pública do app, ex.: https://editor-markdown-beta.vercel.app */
  BETTER_AUTH_URL: z.url(),
  /** Origens extras aceitas (a de BETTER_AUTH_URL já entra). Separadas por vírgula. */
  TRUSTED_ORIGINS: csv,
  /** Cabeçalhos de onde ler o IP do cliente, em ordem. */
  IP_ADDRESS_HEADERS: z
    .string()
    .default('x-forwarded-for')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    ),
  /** IPs/CIDRs dos proxies confiáveis (Vercel/Railway), para ler cadeias de X-Forwarded-For. */
  TRUSTED_PROXIES: csv,
  /**
   * Só em staging: exige o cabeçalho `x-staging-key` com este valor em todas as
   * rotas, exceto GET /api/health. Vazio = desligado (produção).
   */
  STAGING_ACCESS_KEY: z
    .string()
    .default('')
    .refine((v) => v === '' || v.length >= 32, 'STAGING_ACCESS_KEY precisa de pelo menos 32 caracteres'),
  /**
   * Segredo compartilhado com o middleware da Vercel (cabeçalho x-proxy-secret).
   * Com ele, o IP do rate limit vem de x-client-ip. Vazio = sem proxy confiável.
   */
  PROXY_SECRET: z
    .string()
    .default('')
    .refine((v) => v === '' || v.length >= 32, 'PROXY_SECRET precisa de pelo menos 32 caracteres'),
  /** true = só atende chamadas do proxy (exceto GET /api/health). Produção: true. */
  PROXY_REQUIRED: z
    .enum(['true', 'false', ''])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Serviço de compilação LaTeX (rede privada do Railway, ex.:
   * http://editor-markdown-latex.railway.internal:8080). Vazio = compilação
   * desligada (503 compiler_not_configured); o resto do app funciona igual.
   */
  COMPILER_URL: z.union([z.literal(''), z.url()]).default(''),
  COMPILER_TOKEN: z
    .string()
    .default('')
    .refine((v) => v === '' || v.length >= 32, 'COMPILER_TOKEN precisa de pelo menos 32 caracteres'),
  /** Espera máxima pela resposta do compilador (fila + compilação). */
  COMPILER_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(150_000),
  COMPILE_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(20),
  COMPILE_MAX_ACTIVE_PER_USER: z.coerce.number().int().min(1).max(20).default(2),
  /** Só em staging: liga GET /api/_diag/request (cabeçalhos de proxy, IPs mascarados). */
  ENABLE_REQUEST_DIAGNOSTICS: z
    .enum(['true', 'false', ''])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databaseUrl: string;
  dbPoolMax: number;
  authSecret: string;
  baseUrl: string;
  trustedOrigins: string[];
  ipAddressHeaders: string[];
  trustedProxies: string[];
  /** Cookies com Secure: obrigatório sempre que a origem é https. */
  secureCookies: boolean;
  stagingAccessKey: string | null;
  requestDiagnostics: boolean;
  proxySecret: string | null;
  proxyRequired: boolean;
  compiler: {
    url: string;
    token: string;
    timeoutMs: number;
    ratePerMinute: number;
    maxActivePerUser: number;
  } | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Configuração inválida:\n- ${problems.join('\n- ')}`);
  }
  const e = parsed.data;
  const origin = new URL(e.BETTER_AUTH_URL).origin;

  if (e.PROXY_REQUIRED && !e.PROXY_SECRET) {
    throw new Error('PROXY_REQUIRED=true exige PROXY_SECRET');
  }

  if (e.COMPILER_URL && !e.COMPILER_TOKEN) {
    throw new Error('COMPILER_URL exige COMPILER_TOKEN');
  }

  if (e.NODE_ENV === 'production' && !origin.startsWith('https://')) {
    throw new Error('BETTER_AUTH_URL precisa ser https em produção');
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    authSecret: e.BETTER_AUTH_SECRET,
    baseUrl: origin,
    trustedOrigins: [...new Set([origin, ...e.TRUSTED_ORIGINS])],
    ipAddressHeaders: e.IP_ADDRESS_HEADERS,
    trustedProxies: e.TRUSTED_PROXIES,
    secureCookies: origin.startsWith('https://'),
    stagingAccessKey: e.STAGING_ACCESS_KEY || null,
    requestDiagnostics: e.ENABLE_REQUEST_DIAGNOSTICS,
    proxySecret: e.PROXY_SECRET || null,
    proxyRequired: e.PROXY_REQUIRED,
    compiler: e.COMPILER_URL
      ? {
          url: e.COMPILER_URL,
          token: e.COMPILER_TOKEN,
          timeoutMs: e.COMPILER_TIMEOUT_MS,
          ratePerMinute: e.COMPILE_RATE_PER_MINUTE,
          maxActivePerUser: e.COMPILE_MAX_ACTIVE_PER_USER,
        }
      : null,
  };
}
