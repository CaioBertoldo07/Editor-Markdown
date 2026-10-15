import pg from 'pg';
import type { PoolClient } from 'pg';

/**
 * Pool do papel app_api. O search_path aponta para app_auth (tabelas do
 * Better Auth sem prefixo); as tabelas do app são sempre qualificadas (app.*).
 */
export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    options: '-c search_path=app_auth -c statement_timeout=15000',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

/**
 * Executa `fn` numa transação marcada com o usuário da sessão.
 * `app.user_id` vale só dentro desta transação (set_config(..., true)), e é o
 * que as policies RLS usam. O userId vem SEMPRE da sessão autenticada.
 */
export async function withUser<T>(
  pool: pg.Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
