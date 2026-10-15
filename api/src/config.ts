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
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Configuração inválida:\n- ${problems.join('\n- ')}`);
  }
  const e = parsed.data;
  const origin = new URL(e.BETTER_AUTH_URL).origin;

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
  };
}
