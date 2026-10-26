-- Impressão digital do banco do Editor Markdown.
--
-- Roda igual na produção (papel app_backup, dentro do snapshot do pg_dump) e
-- na cópia restaurada; as duas saídas precisam ser idênticas, linha a linha.
-- Saída (psql -XAtq -F'|'):  tipo|nome|quantidade|md5
--   rows    linhas de cada tabela
--   data    checksums dos dados migrados (mesmos de api/src/ops/checksums.ts)
--   struct  papéis, permissões, RLS, policies, funções, constraints, índices...
-- Só números e hashes: nenhum dado pessoal, senha ou conteúdo de documento.

-- 1) Linhas por tabela
SELECT format('SELECT %L, %L, count(*), %L FROM %I.%I', 'rows', n.nspname || '.' || c.relname, '-', n.nspname, c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\_toast%'
  AND n.nspname NOT LIKE 'pg\_temp%'
ORDER BY n.nspname, c.relname
\gexec

-- 2) Dados migrados
SELECT 'data', 'users', count(*), md5(coalesce(string_agg(concat_ws('|',
         id::text, name, email, "emailVerified"::text, coalesce(image, ''), to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
       ), E'\n' ORDER BY id), ''))
FROM app_auth."user"
UNION ALL
SELECT 'data', 'accounts', count(*), md5(coalesce(string_agg(concat_ws('|',
         id::text, "accountId", "providerId", "userId"::text, md5(coalesce(password, '')), to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
       ), E'\n' ORDER BY id), ''))
FROM app_auth.account
UNION ALL
SELECT 'data', 'folders', count(*), md5(coalesce(string_agg(concat_ws('|',
         id::text, user_id::text, name, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
       ), E'\n' ORDER BY id), ''))
FROM app.folders
UNION ALL
SELECT 'data', 'documents', count(*), md5(coalesce(string_agg(concat_ws('|',
         id::text, user_id::text, coalesce(folder_id::text, '-'), title, content, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
       ), E'\n' ORDER BY id), ''))
FROM app.documents;

-- 3) Estrutura
WITH
sys AS (
  SELECT oid FROM pg_namespace
  WHERE nspname IN ('pg_catalog', 'information_schema') OR nspname LIKE 'pg\_toast%' OR nspname LIKE 'pg\_temp%'
),
items(kind, line) AS (
  SELECT 'roles', format('%s super=%s inherit=%s createrole=%s createdb=%s login=%s replication=%s bypassrls=%s connlimit=%s',
           rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit)
  FROM pg_roles WHERE rolname !~ '^pg_'
  UNION ALL
  SELECT 'memberships', format('%s in %s admin=%s inherit=%s set=%s', m.rolname, g.rolname, am.admin_option, am.inherit_option, am.set_option)
  FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
  UNION ALL
  SELECT 'role_settings', format('%s db=%s %s', coalesce(r.rolname, '*'), s.setdatabase <> 0, s.setconfig::text)
  FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid = s.setrole
  WHERE s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
  UNION ALL
  SELECT 'database', format('owner=%s encoding=%s acl=%s', pg_get_userbyid(d.datdba), pg_encoding_to_char(d.encoding),
           (SELECT coalesce(string_agg(a::text, ',' ORDER BY a::text), '') FROM unnest(d.datacl) a))
  FROM pg_database d WHERE d.datname = current_database()
  UNION ALL
  SELECT 'schemas', format('%s owner=%s acl=%s', n.nspname, pg_get_userbyid(n.nspowner),
           (SELECT coalesce(string_agg(a::text, ',' ORDER BY a::text), '') FROM unnest(n.nspacl) a))
  FROM pg_namespace n WHERE n.oid NOT IN (SELECT oid FROM sys)
  UNION ALL
  SELECT 'relations', format('%s %s.%s owner=%s rls=%s force=%s acl=%s', c.relkind, n.nspname, c.relname, pg_get_userbyid(c.relowner),
           c.relrowsecurity, c.relforcerowsecurity,
           (SELECT coalesce(string_agg(a::text, ',' ORDER BY a::text), '') FROM unnest(c.relacl) a))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND n.oid NOT IN (SELECT oid FROM sys)
  UNION ALL
  SELECT 'columns', format('%s.%s.%s %s notnull=%s default=%s acl=%s', n.nspname, c.relname, a.attname,
           format_type(a.atttypid, a.atttypmod), a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), '-'),
           (SELECT coalesce(string_agg(x::text, ',' ORDER BY x::text), '') FROM unnest(a.attacl) x))
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND n.oid NOT IN (SELECT oid FROM sys)
  UNION ALL
  SELECT 'constraints', format('%s.%s %s %s', n.nspname, cl.relname, co.conname, pg_get_constraintdef(co.oid))
  FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
  WHERE n.oid NOT IN (SELECT oid FROM sys)
  UNION ALL
  SELECT 'indexes', indexdef FROM pg_indexes
  WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  UNION ALL
  SELECT 'policies', format('%s.%s %s %s %s %s using=%s check=%s', schemaname, tablename, policyname, permissive, roles::text, cmd,
           coalesce(qual, '-'), coalesce(with_check, '-'))
  FROM pg_policies
  UNION ALL
  SELECT 'functions', format('%s.%s(%s) owner=%s secdef=%s src=%s acl=%s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
           pg_get_userbyid(p.proowner), p.prosecdef, md5(p.prosrc),
           (SELECT coalesce(string_agg(a::text, ',' ORDER BY a::text), '') FROM unnest(p.proacl) a))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.oid NOT IN (SELECT oid FROM sys)
  UNION ALL
  SELECT 'triggers', pg_get_triggerdef(t.oid)
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT t.tgisinternal AND n.oid NOT IN (SELECT oid FROM sys)
  UNION ALL
  SELECT 'extensions', format('%s %s', extname, extversion) FROM pg_extension
)
SELECT 'struct', kind, count(*), md5(string_agg(line, E'\n' ORDER BY line))
FROM items
GROUP BY kind
ORDER BY kind;
