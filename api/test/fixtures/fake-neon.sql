-- Banco FICTÍCIO com o mesmo formato do Neon atual (neon_auth + public), só
-- para ensaiar export -> import -> verify nos testes. Sem pg_session_jwt:
-- user_id não tem DEFAULT aqui. Todos os dados são inventados.

CREATE SCHEMA neon_auth;

CREATE TABLE neon_auth."user" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text, email text, "emailVerified" boolean, image text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP,
  role text, banned boolean, "banReason" text, "banExpires" timestamptz
);

CREATE TABLE neon_auth.account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId" text, "providerId" text,
  "userId" uuid REFERENCES neon_auth."user"(id) ON DELETE CASCADE,
  "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
  scope text, password text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamptz
);

CREATE TABLE neon_auth.session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "expiresAt" timestamptz, token text,
  "createdAt" timestamptz, "updatedAt" timestamptz, "ipAddress" text, "userAgent" text,
  "userId" uuid REFERENCES neon_auth."user"(id) ON DELETE CASCADE
);

CREATE TABLE neon_auth.jwks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "publicKey" text, "privateKey" text,
  "createdAt" timestamptz, "expiresAt" timestamptz
);

CREATE TABLE public.folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text,
  name text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text,
  folder_id uuid REFERENCES public.folders(id) ON DELETE SET NULL,
  title text DEFAULT 'Novo Documento',
  content text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
