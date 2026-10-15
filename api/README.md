# API do Editor Markdown

Backend que substitui o Neon Auth e a Neon Data API. Roda no Railway, fala com
o PostgreSQL 18 do Railway pela rede privada e atende o frontend da Vercel pelo
mesmo domínio (rewrite `/api/*`, a configurar na etapa de integração).

- Node.js 22+, TypeScript, [Hono](https://hono.dev), `pg`, Zod
- [Better Auth](https://better-auth.com) self-hosted: só e-mail/senha, cadastro público desligado
- Testes com Vitest sobre PostgreSQL 18 isolado (embutido via `embedded-postgres`)

> Status: Etapa 2 (fundação). Ainda não está em produção nem ligada ao frontend.

## Estrutura

```
api/
├── db/
│   ├── migrations/          # SQL versionado, aplicado em ordem pelo src/db/migrate.ts
│   │   ├── 001_roles_schemas.sql   papéis app_owner/app_api, schemas app_auth e app
│   │   ├── 002_auth_tables.sql     user, account, session, verification, rateLimit
│   │   ├── 003_app_tables.sql      folders, documents, FKs, índices, trigger
│   │   └── 004_rls.sql             RLS forçado + policies por usuário
│   └── import/              # roteiro de cópia Neon -> Railway (NÃO executado nesta etapa)
│       ├── export-from-neon.sql
│       ├── import-to-railway.sql
│       └── verify.sql
├── src/
│   ├── index.ts             # servidor HTTP
│   ├── app.ts               # rotas e middlewares
│   ├── config.ts            # variáveis de ambiente validadas
│   ├── auth/                # Better Auth, sessão obrigatória, limite por e-mail
│   ├── db/                  # pool do app_api, withUser(), executor de migrations
│   ├── http/                # schemas Zod, erros, mapeamento de linhas
│   └── routes/              # documents, folders
└── test/                    # Vitest (banco isolado, dados fictícios)
```

## Rotas

| Método e rota | Uso |
| --- | --- |
| `GET /api/health` | Saúde (sem autenticação) |
| `POST /api/auth/sign-in/email`, `POST /api/auth/sign-out`, `GET /api/auth/get-session` | Better Auth |
| `GET /api/documents` | Lista os documentos do usuário |
| `POST /api/documents` | Cria um documento `{ title?, content?, folderId? }` |
| `POST /api/documents/import` | Cria até 100 documentos `{ folderId?, documents: [{ title, content, updatedAt? }] }` |
| `PATCH /api/documents/:id` | Edita título/conteúdo ou move `{ title?, content?, folderId? }` |
| `DELETE /api/documents/:id` | Exclui |
| `GET /api/folders` | Lista as pastas |
| `POST /api/folders` | Cria `{ name?, createdAt? }` |
| `PATCH /api/folders/:id` | Renomeia `{ name }` |
| `DELETE /api/folders/:id` | Exclui a pasta; os documentos ficam sem pasta |

Tudo em `/api/documents` e `/api/folders` exige sessão (`401` sem ela). Recurso
de outro usuário ou inexistente responde `404`. Campos extras no corpo
(inclusive `user_id`/`userId`) são recusados com `400`.

## Segurança em camadas

1. **Sessão:** o usuário vem só do cookie do Better Auth, conferido no banco.
2. **Consulta:** toda query filtra `user_id = <usuário da sessão>`; pasta de destino é conferida antes.
3. **Banco:** a API conecta como `app_api` (sem `BYPASSRLS`, sem ser dona de nada,
   sem permissão de gravar `user_id`). Cada requisição roda numa transação com
   `set_config('app.user_id', ...)`, e o RLS forçado só libera as linhas desse usuário.
   A FK composta `(folder_id, user_id)` impede documento em pasta alheia.

Login: rate limit por IP no banco (5 tentativas/min em `/sign-in/*`) e limite por
e-mail em memória (10 tentativas/15 min). Cookies `HttpOnly`, `Secure` (origem https)
e `SameSite=Lax`.

## Desenvolvimento

```bash
cd api
npm ci
npm test            # sobe um PostgreSQL 18 temporário, aplica as migrations e roda tudo
npm run typecheck
npm run build
```

Para usar um Postgres próprio nos testes, defina `TEST_DATABASE_URL` com uma conexão
de administrador para um banco descartável cujo nome contenha `test`.

## Migrations

```bash
# conexão de ADMINISTRADOR, só no terminal de quem aplica
export MIGRATION_DATABASE_URL=postgres://postgres:...@host:port/db
export APP_API_DB_PASSWORD=$(openssl rand -hex 32)
npm run build && npm run migrate -- --set-api-password
```

- Cada arquivo roda numa transação e fica registrado em `public.schema_migrations` com checksum.
- Migration já aplicada não pode ser editada: crie a próxima (`005_...sql`).
- A senha do `app_api` nunca vai para o git; o serviço da API usa só `DATABASE_URL` com esse papel.

## Importação dos dados do Neon

Ver [`db/import/README.md`](db/import/README.md). Nada foi importado nesta etapa.
