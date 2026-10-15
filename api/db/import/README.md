# Cópia Neon -> Railway

Scripts para a etapa de corte. **Não executar contra dados reais antes da
aprovação da etapa correspondente.** O teste `test/import.test.ts` ensaia o
roteiro inteiro com dados fictícios.

## O que é copiado

| Origem (Neon) | Destino (Railway) | Observação |
| --- | --- | --- |
| `neon_auth."user"` | `app_auth."user"` | IDs e timestamps preservados |
| `neon_auth.account` | `app_auth.account` | IDs e hashes de senha preservados |
| `public.folders` | `app.folders` | `user_id` text -> uuid |
| `public.documents` | `app.documents` | IDs, pasta, `created_at`, `updated_at` preservados |

Não é copiado: `session` (todas expiradas; todos fazem login de novo),
`verification`, `jwks` (contém a chave privada do Neon), `organization`,
`member`, `invitation`, `project_config`.

## Passo a passo

```bash
umask 077
WORK=$(mktemp -d) && cd "$WORK"

# 1. Exportar do Neon (transação somente leitura)
psql "$NEON_DATABASE_URL" -X -f /caminho/api/db/import/export-from-neon.sql

# 2. Destino: migrations aplicadas e banco vazio
#    (npm run migrate -- --set-api-password, no diretório api/)

# 3. Importar (uma transação; aborta se o destino não estiver vazio)
psql "$MIGRATION_DATABASE_URL" -X -f /caminho/api/db/import/import-to-railway.sql

# 4. Conferir: as duas saídas precisam ser idênticas
psql "$NEON_DATABASE_URL"      -X -v auth_schema=neon_auth -v app_schema=public -f /caminho/api/db/import/verify.sql > neon.txt
psql "$MIGRATION_DATABASE_URL" -X -v auth_schema=app_auth  -v app_schema=app    -f /caminho/api/db/import/verify.sql > railway.txt
diff neon.txt railway.txt && echo "OK: dados idênticos"

# 5. Apagar os CSVs (contêm hashes de senha)
cd / && rm -rf "$WORK"
```

Esperado com os dados atuais: 6 users, 6 accounts, 4 folders, 20 documents.
