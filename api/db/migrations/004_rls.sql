-- 004 — Row-Level Security
--
-- Segunda barreira de isolamento: mesmo que uma query da API esqueça o filtro
-- por usuário, o banco só devolve/altera linhas do usuário da sessão.
-- FORCE faz a regra valer também para o dono das tabelas (app_owner).
-- Superusuários continuam ignorando RLS — por isso a API nunca usa o admin.

SET LOCAL ROLE app_owner;

ALTER TABLE app.folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.folders FORCE ROW LEVEL SECURITY;
ALTER TABLE app.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.documents FORCE ROW LEVEL SECURITY;

CREATE POLICY folders_owner ON app.folders
  FOR ALL TO app_api
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

CREATE POLICY documents_owner ON app.documents
  FOR ALL TO app_api
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());
