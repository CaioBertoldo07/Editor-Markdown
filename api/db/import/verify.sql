-- Contagens e checksums para comparar Neon x Railway. Somente leitura.
-- A MESMA consulta roda nos dois lados; as saídas precisam ser idênticas.
--
--   psql "$NEON_DATABASE_URL"      -v auth_schema=neon_auth -v app_schema=public -f verify.sql
--   psql "$MIGRATION_DATABASE_URL" -v auth_schema=app_auth  -v app_schema=app    -f verify.sql
--
-- Os checksums cobrem IDs, donos, relacionamentos, textos e timestamps; o hash
-- de senha entra só como md5 (nada sensível aparece na saída).

\set ON_ERROR_STOP on
SET TIME ZONE 'UTC';
\pset format unaligned
\pset tuples_only on
\pset fieldsep ' '

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT 'users', count(*), md5(coalesce(string_agg(concat_ws('|',
         id::text, name, email, "emailVerified"::text, coalesce(image, ''),
         to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
       ), E'\n' ORDER BY id), ''))
FROM :"auth_schema"."user";

SELECT 'accounts', count(*), md5(coalesce(string_agg(concat_ws('|',
         id::text, "accountId", "providerId", "userId"::text, md5(coalesce(password, '')),
         to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
       ), E'\n' ORDER BY id), ''))
FROM :"auth_schema".account;

SELECT 'folders', count(*), md5(coalesce(string_agg(concat_ws('|',
         id::text, user_id::text, name,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
       ), E'\n' ORDER BY id), ''))
FROM :"app_schema".folders;

SELECT 'documents', count(*), md5(coalesce(string_agg(concat_ws('|',
         id::text, user_id::text, coalesce(folder_id::text, '-'), title, content,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
         to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
       ), E'\n' ORDER BY id), ''))
FROM :"app_schema".documents;

COMMIT;
