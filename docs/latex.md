# LaTeX no Editor Markdown

Projetos LaTeX (.tex) com edição, compilação real em PDF, prévia no próprio app,
importação de `.tex`/`.zip` e exportação de `.tex`, `.zip` e PDF. Markdown
continua exatamente como antes.

## Arquitetura

| Parte | Onde | Responsabilidade |
| --- | --- | --- |
| Frontend | Vercel (`mark-editor/`) | Editor CodeMirror 6, árvore de arquivos, prévia PDF.js, importação/exportação |
| API | Railway (`api/`) | Sessão, autorização, arquivos dos projetos, cotas, fila de compilações por usuário |
| Compilador | Railway (`latex-compiler/`), **serviço separado** | TeX Live + latexmk em sandbox; sem banco, sem segredos |
| Banco | PostgreSQL do Railway | `documents.kind`, `documents.main_file`, `document_files` |

O navegador só fala com `/api/*` (mesmo domínio). A API lê os arquivos do projeto
como o usuário da sessão (RLS) e envia só eles ao compilador pela rede privada.
O compilador nunca vê cookies, IDs de usuário nem o banco.

### Compilação assíncrona

```
POST   /api/documents/:id/compile        -> 202 { job }        (cancela a anterior do mesmo documento)
GET    /api/compile-jobs/:jobId?wait=1   -> { job }            (long-poll de até 20 s)
GET    /api/compile-jobs/:jobId/pdf      -> application/pdf
DELETE /api/compile-jobs/:jobId          -> cancela
```

Assíncrona porque o Routing Middleware da Vercel precisa começar a responder em
~25 s e uma compilação pode demorar mais. Os jobs ficam **em memória** na API por
10 minutos (máx. 4 resultados por usuário, teto global de 256 MB de PDFs), com ID
aleatório **e** conferência do dono em toda leitura (job de outra pessoa = 404).

Limites por usuário: 2 compilações simultâneas (documentos diferentes) e 20 por
minuto (`COMPILE_MAX_ACTIVE_PER_USER`, `COMPILE_RATE_PER_MINUTE`).

> Vale para **uma réplica** da API (como hoje). Com várias réplicas, os jobs
> precisariam de armazenamento compartilhado (ex.: Redis) ou afinidade de sessão.

### Modelo de dados (migration `006_latex.sql`)

- `app.documents.kind` — `'markdown'` (padrão) ou `'latex'`. **Imutável para a
  API**: o `app_api` não tem `UPDATE` nessa coluna, então um documento Markdown
  nunca vira LaTeX. Documentos existentes ficam `'markdown'` pelo DEFAULT.
- `app.documents.main_file` — arquivo principal (obrigatório em LaTeX, nulo em Markdown).
- `app.document_files` — um registro por arquivo: texto em `content` (UTF-8) ou
  binário em `data`. FK composta `(document_id, user_id)` com `ON DELETE CASCADE`,
  RLS forçado, caminho único sem diferenciar maiúsculas, `CHECK` de caminho no banco.

A migration só **acrescenta** (colunas com default constante e uma tabela nova);
foi testada aplicando 001–005, populando com o `staging-seed` e só então a 006:
dados idênticos antes e depois (checksum), todos os documentos como Markdown.

### Por que os arquivos ficam no PostgreSQL

Imagens e fontes dos projetos ficam em `bytea` (`STORAGE EXTERNAL`), com limites
pequenos: **4 MB por binário, 1 MB por texto, 40 MB e 300 arquivos por projeto,
250 MB por usuário**. Justificativa:

- O backup diário já existente (`backup/`, criptografado e com restauração
  testada) cobre os projetos sem nenhuma peça nova. Um bucket exigiria um
  segundo backup, credenciais novas e outra política de acesso.
- O isolamento por usuário é o mesmo das outras tabelas (RLS + FK composta),
  sem URLs pré-assinadas que possam vazar.
- O plano Hobby não tem object storage incluso; um R2/bucket seria mais um
  serviço a manter.

**PDFs compilados não são guardados** no banco: são resultado, não fonte. Ficam
na memória da API por alguns minutos e no navegador enquanto o projeto está
aberto. Ao reabrir, a compilação automática gera de novo.

Se os projetos crescerem além disso, o caminho é mover `data` para um bucket
privado (a API já é o único ponto de leitura/escrita), com backup próprio.

## Segurança (resumo)

- Autenticação e autorização: tudo sob `requireSession`; dono conferido em cada
  rota (documento, arquivo, job, PDF); RLS forçado como segunda barreira.
- Entradas: caminhos com as mesmas regras na API, no compilador e no navegador
  (`paths.ts`, idêntico nos três — um teste confere); assinatura dos binários
  (PNG, JPEG, PDF, EPS, TTF, OTF); texto precisa ser UTF-8 sem bytes nulos;
  `latexmkrc`, `biber.conf`, `texmf.cnf` e arquivos ocultos recusados.
- XSS: arquivos do projeto servidos com `Content-Disposition: attachment`,
  `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`; só PNG/JPEG
  como imagem, o resto como `application/octet-stream`. Logs e diagnósticos são
  exibidos como texto pelo React. O PDF é desenhado em `<canvas>` pelo PDF.js
  (sem scripts de PDF, sem XFA).
- Cache: `Cache-Control: no-store` em todo `/api/*`, inclusive PDF.
- Importação: ZIP aberto no navegador com proteção contra path traversal (o nome
  original da entrada é validado), links simbólicos, ZIP bombs (taxa de
  compressão e descompactação interrompida no limite), excesso de arquivos e
  tamanho total. A API valida cada arquivo de novo.
- Compilação: ver [`latex-compiler/README.md`](../latex-compiler/README.md)
  (UID por slot, seccomp sem rede, rlimits, sem shell-escape, autoteste que
  impede compilar sem isolamento).

## Variáveis novas

**API** (`api/`):

| Variável | Valor |
| --- | --- |
| `COMPILER_URL` | `http://editor-markdown-latex.railway.internal:8080` (vazio = compilação desligada, 503) |
| `COMPILER_TOKEN` | `${{editor-markdown-latex.COMPILER_TOKEN}}` |
| `COMPILER_TIMEOUT_MS` | opcional, padrão `150000` (fila + compilação) |
| `COMPILE_RATE_PER_MINUTE` | opcional, padrão `20` |
| `COMPILE_MAX_ACTIVE_PER_USER` | opcional, padrão `2` |

**Compilador**: `COMPILER_TOKEN` (+ limites opcionais, ver o README dele).
**Vercel**: nada novo.

## Procedimento seguro de publicação

A ordem importa: a API nova lê `documents.kind`, então a **migration vem antes**
do código. O frontend novo funciona com a API antiga (sem `kind` = Markdown).

### 1. Staging (banco sintético)

1. Criar o serviço `editor-markdown-latex` no projeto `editor-markdown`, ambiente
   `staging`: repositório, branch `feat/latex`, root `/latex-compiler`, sem
   domínio, healthcheck `/health`, `COMPILER_TOKEN` gerado.
2. Conferir os logs: as 8 linhas `sandbox: ok` e `sandbox ativo; compilações
   liberadas`. Se aparecer `SANDBOX INDISPONÍVEL`, **parar**: o Railway não
   permite o isolamento e nada é compilado (ver "Riscos").
3. Aplicar a 006 no `Postgres-sintetico`: serviço `editor-markdown-ops` com a
   branch `feat/latex` e `OPS_TASK=migrate`; conferir `Migrations aplicadas: 1`.
4. API de staging: branch `feat/latex`, `COMPILER_URL` e `COMPILER_TOKEN`.
   No log: `[api] compilação LaTeX ligada`.
5. `OPS_TASK=staging-check` (a verificação já conhece a 006 e a tabela nova).
6. Preview da Vercel apontando para a API de staging (hoje só a branch
   `migracao-railway` tem `API_ORIGIN` no Preview) e homologar com
   `ana.teste@example.invalid` / `bruno.teste@example.invalid`.

### 2. Produção (só com autorização expressa)

1. Backup manual do PostgreSQL de produção (`editor-markdown-backup` → Run now)
   e conferir `RESULT=OK`.
2. Criar `editor-markdown-latex` no projeto `editor-markdown-producao`, com um
   `COMPILER_TOKEN` **diferente** do staging; conferir o autoteste.
3. `OPS_TASK=migrate-plan` no `editor-markdown-ops` de produção (somente
   leitura): conferir host/banco de destino, `pendentes: 006_latex.sql` e as
   contagens de linhas iguais às do último backup. Só então `OPS_TASK=migrate`
   (aplica só a 006) e voltar para `idle`.
4. Merge do PR em `main` → deploy da API e da Vercel. Definir `COMPILER_URL`/
   `COMPILER_TOKEN` na API de produção.
5. Verificar: abrir um documento Markdown antigo (nada mudou), criar um projeto
   LaTeX, compilar, baixar o PDF.

**Reverter**: tirar `COMPILER_URL` desliga só a compilação (503), o resto segue.
Voltar o código da API para o commit anterior funciona com a 006 aplicada (as
colunas novas têm default e a API antiga não as lê). A 006 não precisa ser
desfeita; se for, `DROP TABLE app.document_files` e `DROP COLUMN kind, main_file`
apagam os projetos LaTeX — só com backup e decisão explícita.

## Testes

| Suíte | Comando | O que cobre |
| --- | --- | --- |
| Compilador, unitários | `cd latex-compiler && npm test` | caminhos, log → diagnósticos, motor, fila |
| Compilador, TeX real | `docker build --target test -t latex-compiler-test latex-compiler && docker run --rm -e LATEX_INTEGRATION=1 latex-compiler-test` | 29 cenários reais, inclusive os de segurança |
| API | `cd api && npm test` | migrations, RLS, rotas, cotas, isolamento, jobs |
| API + compilador real | `docker run -d -p 18080:8080 -e COMPILER_TOKEN=<t> latex-compiler` e `COMPILER_TEST_URL=http://127.0.0.1:18080 COMPILER_TEST_TOKEN=<t> npm test` | projeto com capítulos, imagem e BibTeX até o PDF |
| Frontend | `cd mark-editor && npm test && npm run build` | ZIP malicioso, importação, contextos, Markdown |
