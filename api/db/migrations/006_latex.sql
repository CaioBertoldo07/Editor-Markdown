-- 006 — Documentos LaTeX (projetos com vários arquivos)
--
-- Só ACRESCENTA estrutura; nada existente é alterado ou apagado:
--   * app.documents ganha `kind` ('markdown' | 'latex', padrão 'markdown') e
--     `main_file` (arquivo principal do projeto LaTeX). Os documentos atuais
--     ficam 'markdown' pelo DEFAULT (ADD COLUMN com default constante não
--     reescreve a tabela no PostgreSQL 11+).
--   * O tipo é IMUTÁVEL para a API (sem GRANT UPDATE em kind): um documento
--     Markdown nunca vira LaTeX, nem por engano.
--   * app.document_files guarda os arquivos de cada projeto LaTeX: texto
--     (.tex, .bib, .sty...) em `content`, binários (imagens, fontes) em `data`.
--     Limites de tamanho na API (arquivo, projeto e usuário); os PDFs
--     compilados NÃO são guardados (ficam só em memória por alguns minutos).
--   * Mesmo modelo de isolamento das outras tabelas: user_id vindo da sessão,
--     FK composta (document_id, user_id) e RLS forçado.

SET LOCAL ROLE app_owner;

ALTER TABLE app.documents
  ADD COLUMN kind text NOT NULL DEFAULT 'markdown',
  ADD COLUMN main_file text,
  ADD CONSTRAINT documents_kind_check CHECK (kind IN ('markdown', 'latex')),
  ADD CONSTRAINT documents_main_file_check CHECK (
    (kind = 'markdown' AND main_file IS NULL)
    OR (kind = 'latex' AND main_file IS NOT NULL AND length(main_file) BETWEEN 1 AND 200)
  ),
  ADD CONSTRAINT documents_id_user_key UNIQUE (id, user_id);

CREATE TABLE app.document_files (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL DEFAULT app.current_user_id(),
  document_id uuid        NOT NULL,
  path        text        NOT NULL,
  content     text,
  data        bytea,
  size_bytes  integer     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_files_document_fkey
    FOREIGN KEY (document_id, user_id) REFERENCES app.documents (id, user_id) ON DELETE CASCADE,
  -- Exatamente um dos dois: texto OU binário.
  CONSTRAINT document_files_payload_check CHECK ((content IS NULL) <> (data IS NULL)),
  CONSTRAINT document_files_size_check CHECK (size_bytes BETWEEN 0 AND 8388608),
  -- Última barreira contra caminhos que saiam do projeto (a API valida antes,
  -- com as mesmas regras do compilador): relativo, sem "." inicial em nenhum
  -- segmento (cobre "." e ".."), sem "\", sem "//", sem caracteres de controle.
  CONSTRAINT document_files_path_check CHECK (
    length(path) BETWEEN 1 AND 200
    AND path !~ '(^|/)\.'
    AND path !~ '^/'
    AND path !~ '/$'
    AND path !~ '//'
    AND position(E'\\' IN path) = 0
    AND path !~ '[[:cntrl:]]'
  )
);

-- Um caminho por projeto, sem diferenciar maiúsculas (o ZIP exportado precisa
-- abrir no Windows e no macOS sem um arquivo sobrescrever o outro).
CREATE UNIQUE INDEX document_files_path_key ON app.document_files (document_id, lower(path));
CREATE INDEX document_files_user_idx ON app.document_files (user_id);

-- Imagens já vêm comprimidas: guardar fora da linha sem tentar comprimir de novo.
ALTER TABLE app.document_files ALTER COLUMN data SET STORAGE EXTERNAL;

CREATE TRIGGER document_files_set_updated_at
  BEFORE UPDATE ON app.document_files
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.document_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.document_files FORCE ROW LEVEL SECURITY;

CREATE POLICY document_files_owner ON app.document_files
  FOR ALL TO app_api
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

-- Privilégios por coluna, como nas outras tabelas: a API nunca grava id/user_id
-- nem as datas; kind só na criação.
GRANT INSERT (kind, main_file) ON app.documents TO app_api;
GRANT UPDATE (main_file) ON app.documents TO app_api;
GRANT SELECT, DELETE ON app.document_files TO app_api;
GRANT INSERT (document_id, path, content, data, size_bytes) ON app.document_files TO app_api;
GRANT UPDATE (path, content, data, size_bytes) ON app.document_files TO app_api;
