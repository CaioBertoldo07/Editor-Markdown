-- 005 — Papel do backup
--
-- app_backup  papel usado pelo serviço editor-markdown-backup (pg_dump).
--             Só LEITURA de tudo (pg_read_all_data) e BYPASSRLS: o RLS é
--             forçado em app.folders/app.documents, e o pg_dump se recusa a
--             exportar tabelas com RLS se o papel não puder ignorá-lo.
--             Nunca grava: sem DML, sem ser dono de nada, sem superusuário.
-- O LOGIN e a senha são definidos fora das migrations (tarefa `migrate` do
-- serviço de operações, com BACKUP_DB_PASSWORD), como no app_api.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backup') THEN
    CREATE ROLE app_backup NOLOGIN;
  END IF;
END
$$;

ALTER ROLE app_backup NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;

GRANT pg_read_all_data TO app_backup;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_backup', current_database());
END
$$;
