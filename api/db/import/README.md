# Cópia Neon -> Railway

**Nada aqui deve rodar contra dados reais sem autorização explícita.** Os dois
caminhos foram ensaiados só com dados fictícios (`test/transfer.test.ts` e
`test/import.test.ts`).

## O que é copiado

| Origem (Neon) | Destino (Railway) | Observação |
| --- | --- | --- |
| `neon_auth."user"` | `app_auth."user"` | IDs e timestamps preservados (`updatedAt` nulo vira `createdAt`) |
| `neon_auth.account` | `app_auth.account` | IDs e hashes de senha preservados |
| `public.folders` | `app.folders` | `user_id` text -> uuid |
| `public.documents` | `app.documents` | IDs, pasta, `created_at`, `updated_at` preservados (microssegundos) |

Não é copiado: `session`, `verification`, `jwks` (chave privada do Neon),
`organization`, `member`, `invitation`, `project_config`.

## Caminho A (recomendado): job dentro do Railway

Roda no serviço de operações do projeto Railway. Lê o Neon pela internet (TLS)
e grava no Postgres pela **rede privada**: nenhum arquivo em disco, nenhum
computador pessoal no meio e o Postgres nunca é exposto à internet.

1. No serviço `editor-markdown-ops` (staging), adicionar temporariamente
   `NEON_DATABASE_URL` (conexão do Neon com `sslmode=require`).
2. `OPS_TASK=transfer-inspect` -> deploy. Só lê (transação `READ ONLY`) e imprime
   contagens, nulos, formato dos hashes, trigger de `updated_at`. Nenhum dado pessoal.
3. Se não houver `PROBLEMA` no log: `OPS_TASK=transfer-execute` e
   `TRANSFER_CONFIRM=COPIAR-NEON-PARA-STAGING` -> deploy. Copia numa transação
   única e só faz COMMIT se contagens e checksums baterem.
4. Voltar `OPS_TASK=idle` e **apagar** `NEON_DATABASE_URL` e `TRANSFER_CONFIRM`.

Travas no código: origem precisa ser `*.neon.tech`; destino precisa ser
`*.railway.internal`; sessão da origem com `default_transaction_read_only`;
destino precisa estar vazio.

## Caminho B (alternativa): Windows + PowerShell + psql 18

`transfer-windows.ps1` faz export -> import -> verify com pasta temporária
restrita ao seu usuário (`icacls`), URLs lidas sem eco e limpeza no `finally`.
Exige ligar **temporariamente** o proxy TCP público do Postgres do Railway.

```powershell
cd <repositório>\api\db\import
powershell -ExecutionPolicy Bypass -File .\transfer-windows.ps1
# depois: desligar o proxy TCP público no Railway
```

Os CSVs contêm hashes de senha e conteúdo: ficam só na pasta temporária e são
apagados ao final (num SSD, prefira disco com BitLocker ligado).

## Conferência manual (qualquer caminho)

```text
psql <neon>    -X -v auth_schema=neon_auth -v app_schema=public -f verify.sql
psql <railway> -X -v auth_schema=app_auth  -v app_schema=app    -f verify.sql
```

As saídas precisam ser idênticas. Esperado com os dados atuais: 6 users,
6 accounts, 4 folders, 20 documents.
