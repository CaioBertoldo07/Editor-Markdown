-- Exportação SOMENTE LEITURA do Neon para CSV (Etapa de corte).
--
-- Uso (num diretório temporário protegido, ex.: umask 077):
--   psql "$NEON_DATABASE_URL" -f export-from-neon.sql
-- Gera user.csv, account.csv, folders.csv e documents.csv no diretório atual.
--
-- ATENÇÃO: account.csv contém hashes de senha. Nunca versionar, nunca enviar
-- por chat; apagar os CSVs ao terminar a importação.
-- Não exporta: session, verification, jwks (chave privada), organization,
-- member, invitation, project_config.

\set ON_ERROR_STOP on
SET TIME ZONE 'UTC';

-- Um único snapshot consistente para os quatro arquivos.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

\copy (SELECT id, name, email, "emailVerified", image, "createdAt", "updatedAt" FROM neon_auth."user" ORDER BY id) TO 'user.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", scope, password, "createdAt", "updatedAt" FROM neon_auth.account ORDER BY id) TO 'account.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT id, user_id, name, created_at FROM public.folders ORDER BY id) TO 'folders.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT id, user_id, folder_id, title, content, created_at, updated_at FROM public.documents ORDER BY id) TO 'documents.csv' WITH (FORMAT csv, HEADER true)

COMMIT;
