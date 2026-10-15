-- 003 — Documentos e pastas (schema app)
--
-- Equivalentes a public.documents/public.folders do Neon, com três reforços:
--   * user_id é uuid NOT NULL com FK para app_auth."user" (ON DELETE CASCADE);
--   * a FK composta (folder_id, user_id) -> folders(id, user_id) impede que um
--     documento aponte para a pasta de outro usuário;
--   * o dono vem de app.current_user_id() (definido pela API a partir da
--     sessão) — o papel app_api nem tem permissão de gravar user_id.
-- `ON DELETE SET NULL (folder_id)` (PostgreSQL 15+) zera só a pasta ao apagá-la,
-- mantendo o documento e o dono.

SET LOCAL ROLE app_owner;

-- Usuário da requisição atual. A API faz, dentro de cada transação:
--   SELECT set_config('app.user_id', '<uuid da sessão>', true)
-- Fora disso devolve NULL, e as policies não liberam nenhuma linha.
CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_updated_at() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO app_api;

CREATE TABLE app.folders (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL DEFAULT app.current_user_id()
                         REFERENCES app_auth."user" (id) ON DELETE CASCADE,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT folders_id_user_key UNIQUE (id, user_id)
);
CREATE INDEX folders_user_created_idx ON app.folders (user_id, created_at);

CREATE TABLE app.documents (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL DEFAULT app.current_user_id()
                         REFERENCES app_auth."user" (id) ON DELETE CASCADE,
  folder_id  uuid,
  title      text        NOT NULL DEFAULT 'Novo Documento',
  content    text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_folder_owner_fkey
    FOREIGN KEY (folder_id, user_id) REFERENCES app.folders (id, user_id)
    ON DELETE SET NULL (folder_id)
);
CREATE INDEX documents_user_updated_idx ON app.documents (user_id, updated_at DESC);
CREATE INDEX documents_folder_idx ON app.documents (folder_id, user_id);

-- Só em UPDATE: inserts (inclusive a importação do Neon) preservam updated_at.
CREATE TRIGGER documents_set_updated_at
  BEFORE UPDATE ON app.documents
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Privilégios por coluna: a API nunca grava id/user_id (vêm dos DEFAULTs) nem
-- reescreve created_at/updated_at depois de criado.
GRANT SELECT, DELETE ON app.folders, app.documents TO app_api;
GRANT INSERT (name, created_at) ON app.folders TO app_api;
GRANT UPDATE (name) ON app.folders TO app_api;
GRANT INSERT (folder_id, title, content, created_at, updated_at) ON app.documents TO app_api;
GRANT UPDATE (folder_id, title, content) ON app.documents TO app_api;
