import type { ClientBase } from 'pg';

/**
 * Contagens e checksums idênticos aos de db/import/verify.sql, calculados no
 * próprio banco. Cobrem IDs, donos, relacionamentos, textos, datas e (via md5)
 * o hash de senha. A saída não contém nenhum dado pessoal.
 */
export type Schemas = { auth: string; app: string };
export type Checksums = Record<'users' | 'accounts' | 'folders' | 'documents', { count: number; md5: string }>;

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Nome de schema inválido: ${name}`);
  return `"${name}"`;
};

const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

export async function computeChecksums(client: ClientBase, schemas: Schemas): Promise<Checksums> {
  const a = ident(schemas.auth);
  const p = ident(schemas.app);
  const { rows } = await client.query<{ name: keyof Checksums; count: string; md5: string }>(`
    SELECT 'users' AS name, count(*)::text AS count, md5(coalesce(string_agg(concat_ws('|',
             id::text, name, email, "emailVerified"::text, coalesce(image, ''), ${TS('"createdAt"')}
           ), E'\\n' ORDER BY id), '')) AS md5
    FROM ${a}."user"
    UNION ALL
    SELECT 'accounts', count(*)::text, md5(coalesce(string_agg(concat_ws('|',
             id::text, "accountId", "providerId", "userId"::text, md5(coalesce(password, '')), ${TS('"createdAt"')}
           ), E'\\n' ORDER BY id), ''))
    FROM ${a}.account
    UNION ALL
    SELECT 'folders', count(*)::text, md5(coalesce(string_agg(concat_ws('|',
             id::text, user_id::text, name, ${TS('created_at')}
           ), E'\\n' ORDER BY id), ''))
    FROM ${p}.folders
    UNION ALL
    SELECT 'documents', count(*)::text, md5(coalesce(string_agg(concat_ws('|',
             id::text, user_id::text, coalesce(folder_id::text, '-'), title, content, ${TS('created_at')}, ${TS('updated_at')}
           ), E'\\n' ORDER BY id), ''))
    FROM ${p}.documents`);
  const out = {} as Checksums;
  for (const r of rows) out[r.name] = { count: Number(r.count), md5: r.md5 };
  return out;
}

export function sameChecksums(a: Checksums, b: Checksums): boolean {
  return (Object.keys(a) as Array<keyof Checksums>).every(
    (k) => a[k].count === b[k]?.count && a[k].md5 === b[k]?.md5
  );
}

/** Linha para log: contagens + 8 primeiros caracteres de cada checksum. */
export const describeChecksums = (c: Checksums) =>
  (Object.keys(c) as Array<keyof Checksums>).map((k) => `${k}=${c[k].count} (${c[k].md5.slice(0, 8)})`).join(', ');
