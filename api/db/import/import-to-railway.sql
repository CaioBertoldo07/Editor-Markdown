-- Importação dos CSVs exportados do Neon para o PostgreSQL do Railway.
--
-- Uso (como ADMINISTRADOR, no diretório onde estão os CSVs, depois das migrations):
--   psql "$MIGRATION_DATABASE_URL" -f import-to-railway.sql
--
-- Garantias:
--   * tudo numa transação: qualquer erro desfaz a importação inteira;
--   * só roda em banco de destino VAZIO;
--   * preserva IDs, relacionamentos, timestamps e hashes de senha;
--   * única transformação: user_id text -> uuid (e "updatedAt" nulo do Better
--     Auth vira "createdAt"); títulos/conteúdos nulos FAZEM A IMPORTAÇÃO FALHAR
--     de propósito, para decisão manual.
--   * o trigger de updated_at só age em UPDATE, então INSERT preserva as datas.

\set ON_ERROR_STOP on
SET TIME ZONE 'UTC';

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app_auth."user")
     OR EXISTS (SELECT 1 FROM app_auth.account)
     OR EXISTS (SELECT 1 FROM app.folders)
     OR EXISTS (SELECT 1 FROM app.documents) THEN
    RAISE EXCEPTION 'Banco de destino não está vazio: importação abortada';
  END IF;
END
$$;

CREATE TEMP TABLE in_user (
  id uuid, name text, email text, "emailVerified" boolean, image text,
  "createdAt" timestamptz, "updatedAt" timestamptz
) ON COMMIT DROP;

CREATE TEMP TABLE in_account (
  id uuid, "accountId" text, "providerId" text, "userId" uuid,
  "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
  scope text, password text, "createdAt" timestamptz, "updatedAt" timestamptz
) ON COMMIT DROP;

CREATE TEMP TABLE in_folders (id uuid, user_id text, name text, created_at timestamptz) ON COMMIT DROP;

CREATE TEMP TABLE in_documents (
  id uuid, user_id text, folder_id uuid, title text, content text,
  created_at timestamptz, updated_at timestamptz
) ON COMMIT DROP;

\copy in_user FROM 'user.csv' WITH (FORMAT csv, HEADER true)
\copy in_account FROM 'account.csv' WITH (FORMAT csv, HEADER true)
\copy in_folders FROM 'folders.csv' WITH (FORMAT csv, HEADER true)
\copy in_documents FROM 'documents.csv' WITH (FORMAT csv, HEADER true)

INSERT INTO app_auth."user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
SELECT id, name, email, "emailVerified", image, "createdAt", COALESCE("updatedAt", "createdAt")
FROM in_user;

INSERT INTO app_auth.account (
  id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken",
  "accessTokenExpiresAt", "refreshTokenExpiresAt", scope, password, "createdAt", "updatedAt"
)
SELECT id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken",
       "accessTokenExpiresAt", "refreshTokenExpiresAt", scope, password, "createdAt",
       COALESCE("updatedAt", "createdAt")
FROM in_account;

INSERT INTO app.folders (id, user_id, name, created_at)
SELECT id, user_id::uuid, name, created_at FROM in_folders;

INSERT INTO app.documents (id, user_id, folder_id, title, content, created_at, updated_at)
SELECT id, user_id::uuid, folder_id, title, content, created_at, updated_at FROM in_documents;

-- Conferência dentro da transação: as contagens precisam bater com os CSVs.
DO $$
DECLARE
  bad text := '';
BEGIN
  IF (SELECT count(*) FROM app_auth."user") <> (SELECT count(*) FROM in_user) THEN bad := bad || ' user'; END IF;
  IF (SELECT count(*) FROM app_auth.account) <> (SELECT count(*) FROM in_account) THEN bad := bad || ' account'; END IF;
  IF (SELECT count(*) FROM app.folders) <> (SELECT count(*) FROM in_folders) THEN bad := bad || ' folders'; END IF;
  IF (SELECT count(*) FROM app.documents) <> (SELECT count(*) FROM in_documents) THEN bad := bad || ' documents'; END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'Contagens divergentes em:%', bad;
  END IF;
END
$$;

SELECT
  (SELECT count(*) FROM app_auth."user")  AS users,
  (SELECT count(*) FROM app_auth.account) AS accounts,
  (SELECT count(*) FROM app.folders)      AS folders,
  (SELECT count(*) FROM app.documents)    AS documents;

COMMIT;
