-- 002 — Tabelas do Better Auth (schema app_auth)
--
-- Mesmas colunas (camelCase) que o Neon Auth usa em `neon_auth`, porque o Neon
-- Auth é o próprio Better Auth. Isso permite copiar `user` e `account`
-- preservando IDs, timestamps e hashes de senha.
-- IDs são uuid (advanced.database.generateId = "uuid" na API).
-- Não migramos: session, verification, jwks, organization, member,
-- invitation, project_config.

SET LOCAL ROLE app_owner;

CREATE TABLE app_auth."user" (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  email           text        NOT NULL,
  "emailVerified" boolean     NOT NULL DEFAULT false,
  image           text,
  "createdAt"     timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_email_key UNIQUE (email)
);

CREATE TABLE app_auth.account (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId"             text        NOT NULL,
  "providerId"            text        NOT NULL,
  "userId"                uuid        NOT NULL REFERENCES app_auth."user" (id) ON DELETE CASCADE,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope                   text,
  password                text,
  "createdAt"             timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT account_provider_account_key UNIQUE ("providerId", "accountId")
);
CREATE INDEX account_user_id_idx ON app_auth.account ("userId");

CREATE TABLE app_auth.session (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "expiresAt" timestamptz NOT NULL,
  token       text        NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress" text,
  "userAgent" text,
  "userId"    uuid        NOT NULL REFERENCES app_auth."user" (id) ON DELETE CASCADE,
  CONSTRAINT session_token_key UNIQUE (token)
);
CREATE INDEX session_user_id_idx ON app_auth.session ("userId");

CREATE TABLE app_auth.verification (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier  text        NOT NULL,
  value       text        NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX verification_identifier_idx ON app_auth.verification (identifier);

-- Contadores do rate limit do Better Auth (rateLimit.storage = "database").
CREATE TABLE app_auth."rateLimit" (
  id            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text    NOT NULL,
  count         integer NOT NULL,
  "lastRequest" bigint  NOT NULL,
  CONSTRAINT rate_limit_key_key UNIQUE (key)
);

-- A API é o servidor de autenticação: precisa de DML nestas tabelas.
-- Não recebe TRUNCATE, REFERENCES, TRIGGER nem DDL.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app_auth TO app_api;
