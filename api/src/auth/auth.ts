import { betterAuth } from 'better-auth';
import type pg from 'pg';
import type { Config } from '../config.js';

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 dias, como no Neon Auth
export const SIGN_IN_WINDOW_SECONDS = 60;
export const SIGN_IN_MAX_PER_IP = 5;

/**
 * Better Auth self-hosted, no lugar do Neon Auth.
 *
 * - Só e-mail/senha; cadastro público DESLIGADO (disableSignUp).
 * - Hash padrão do Better Auth (scrypt N=16384, r=16, p=1, 64 bytes,
 *   "salt:chave" em hex) — o mesmo formato gravado pelo Neon Auth, então os
 *   hashes migrados validam sem reset. Não customizar `password.hash/verify`.
 * - IDs uuid gerados pela aplicação, compatíveis com os IDs existentes.
 * - Rate limit persistido no banco (app_auth."rateLimit").
 */
export function createAuth(config: Config, pool: pg.Pool) {
  return betterAuth({
    appName: 'Editor Markdown',
    baseURL: config.baseUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
    database: pool,
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: false,
    },
    session: {
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/*': { window: SIGN_IN_WINDOW_SECONDS, max: SIGN_IN_MAX_PER_IP },
        '/sign-up/*': { window: 60, max: 3 },
      },
    },
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: config.secureCookies,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: 'lax',
        path: '/',
      },
      ipAddress: {
        ipAddressHeaders: config.ipAddressHeaders,
        ...(config.trustedProxies.length > 0 ? { trustedProxies: config.trustedProxies } : {}),
      },
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
