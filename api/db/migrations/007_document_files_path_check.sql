-- 007 — Reescreve document_files_path_check numa forma estável
--
-- A regra é a MESMA da 006; muda só a escrita. Na 006, o primeiro termo era
-- `length(path) BETWEEN 1 AND 200`, que o PostgreSQL guarda como um AND
-- aninhado. O pg_dump devolve o texto desse AND e, ao restaurar, ele volta
-- achatado: a constraint restaurada fica com outros parênteses. O teste de
-- restauração do backup compara a estrutura linha a linha e (corretamente)
-- acusa a diferença. Escrito com >= e <=, o texto sobrevive ao dump/restore
-- sem mudar.
--
-- Nada de dados muda: a constraint nova valida as linhas existentes ao ser
-- criada (as que passavam na regra antiga passam nesta, que é equivalente).

SET LOCAL ROLE app_owner;

ALTER TABLE app.document_files
  DROP CONSTRAINT document_files_path_check,
  ADD CONSTRAINT document_files_path_check CHECK (
    length(path) >= 1
    AND length(path) <= 200
    AND path !~ '(^|/)\.'
    AND path !~ '^/'
    AND path !~ '/$'
    AND path !~ '//'
    AND position(E'\\' IN path) = 0
    AND path !~ '[[:cntrl:]]'
  );
