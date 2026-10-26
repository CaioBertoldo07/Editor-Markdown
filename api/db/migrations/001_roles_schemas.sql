-- 001 — Papéis e schemas
--
-- Roda como o administrador do banco (no Railway, o usuário `postgres`).
-- Cria dois papéis sem privilégios administrativos:
--   app_owner  dono dos schemas e tabelas; NOLOGIN (ninguém entra como ele)
--   app_api    papel usado pela API; só DML, NOBYPASSRLS, sem ser dono de nada
-- O LOGIN e a senha do app_api são definidos fora das migrations
-- (`npm run migrate -- --set-api-password`), para nenhum segredo ir para o git.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
    CREATE ROLE app_api NOLOGIN;
  END IF;
END
$$;

-- Reafirma os atributos mesmo que os papéis já existissem.
ALTER ROLE app_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE app_api NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- O administrador precisa poder assumir app_owner (SET ROLE) nas próximas migrations.
GRANT app_owner TO CURRENT_USER;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_api', current_database());
  -- search_path padrão do app_api neste banco: tabelas do Better Auth sem prefixo.
  EXECUTE format('ALTER ROLE app_api IN DATABASE %I SET search_path = app_auth', current_database());
END
$$;

CREATE SCHEMA IF NOT EXISTS app_auth AUTHORIZATION app_owner;
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION app_owner;

REVOKE ALL ON SCHEMA app_auth FROM PUBLIC;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app_auth TO app_api;
GRANT USAGE ON SCHEMA app TO app_api;
