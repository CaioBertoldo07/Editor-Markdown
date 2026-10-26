# editor-markdown-backup

Backup lógico diário do PostgreSQL de produção do Editor Markdown para um bucket
privado do Cloudflare R2, criptografado e com restauração testada a cada execução.

O workspace do Railway é Hobby, sem backups nativos de banco. Por isso o backup é
este serviço cron próprio, baseado no `nosso-calendario-backup`, mas com bucket,
chaves e senha exclusivos do Editor Markdown.

## O que cada execução faz

1. Lê o banco como `app_backup`, um papel **só leitura** (`pg_read_all_data` +
   `BYPASSRLS`, sem superusuário; ver `api/db/migrations/005_backup_role.sql`),
   pela rede privada do Railway, em transação `READ ONLY`.
2. Exporta os **papéis** (`pg_dumpall --roles-only --no-role-passwords`) e o
   **banco** (`pg_dump` custom de um snapshot, com dono, GRANTs, RLS, policies,
   funções, extensões e configurações do banco). No mesmo snapshot, calcula a
   *impressão digital* da produção (`fingerprint.sql`): linhas por tabela,
   checksums dos dados migrados e estrutura. Só números e hashes.
3. Empacota tudo num `.tar` com `manifest.txt` (SHA-256 de cada peça) e
   criptografa com **GPG AES-256** (senha simétrica `BACKUP_PASSPHRASE`).
4. Envia para `postgres/<chave>/staging/`, baixa de volta, confere o
   **SHA-256**, decripta e compara byte a byte.
5. **Restaura** num PostgreSQL 18 temporário dentro do contêiner, sem rede e com
   os mesmos papéis, e exige impressão digital **idêntica** à da produção.
6. Só então promove para `daily/` e, uma vez por semana, copia para `weekly/`.
7. Aplica a retenção, independente em cada pasta (padrão: 14 diários e 8
   semanais), e apenas quando o backup do dia passou em tudo.

A última linha do log é sempre `RESULT=OK ...` ou
`RESULT=FAILED step=<etapa> exit=<código>`, e uma falha encerra o processo com
código diferente de zero. Os logs nunca mostram credenciais nem conteúdo de
documentos.

| Código | Etapa                                                  |
|--------|--------------------------------------------------------|
| 2      | configuração (variável ausente ou inválida)            |
| 3      | conexão, papéis, dump ou impressão digital da produção |
| 4      | conferência do arquivo no R2 (SHA-256, decriptação)    |
| 5      | restauração de teste diferente da produção             |
| 6      | promoção para `daily/`                                 |

## Railway

Serviço `editor-markdown-backup` no projeto `editor-markdown-producao`
(ambiente `production`):

- Fonte: este repositório, diretório raiz `/backup`, builder Dockerfile.
- Cron: `0 7 * * *` (07:00 UTC = 03:00 em Manaus). Política de reinício: `NEVER`.
- Sem domínio público: só sai para o R2 e entra no Postgres pela rede privada.

Essas configurações ficam no próprio serviço, e não num `railway.json`: o
config as code do Railway foi descontinuado.

### Variáveis

| Variável               | Valor                                                                                                   |
|------------------------|---------------------------------------------------------------------------------------------------------|
| `DATABASE_URL`         | `postgresql://app_backup:${{BACKUP_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` |
| `BACKUP_DB_PASSWORD`   | senha do papel `app_backup` (gerada; o ops a referencia para aplicar no banco)                          |
| `R2_ACCOUNT_ID`        | ID da conta Cloudflare                                                                                  |
| `R2_ACCESS_KEY_ID`     | chave de API do R2 **restrita a este bucket** (Object Read & Write)                                     |
| `R2_SECRET_ACCESS_KEY` | segredo dessa chave                                                                                     |
| `R2_BUCKET`            | `editor-markdown-backups`                                                                               |
| `BACKUP_PASSPHRASE`    | 32+ caracteres ASCII visíveis, sem espaços; **guarde uma cópia fora do Railway**                        |
| `KEEP_DAILY`           | `14` (opcional)                                                                                         |
| `KEEP_WEEKLY`          | `8` (opcional)                                                                                          |
| `BACKUP_KEY_ID`        | `v1` (opcional; pasta da senha em uso, ver rotação)                                                     |
| `HEALTHCHECK_URL`      | opcional: URL de monitoramento (ex.: healthchecks.io), recebe `/start`, `/fail` e sucesso                |

Sem a `BACKUP_PASSPHRASE`, nenhum backup pode ser aberto. Ela precisa existir
também num gerenciador de senhas, fora do Railway e do R2.

## Executar agora

Painel do Railway → `editor-markdown-backup` → **Run now**, ou pela API:
`deploymentInstanceExecutionCreate(input: { serviceInstanceId })`.

## Testar a restauração (sem tocar a produção)

`verify.sh` baixa o backup diário mais recente (ou uma chave informada), confere o
SHA-256 e a cifra (AES-256), decripta, restaura num PostgreSQL temporário e
compara com a impressão digital gravada no pacote. Precisa só das variáveis do
R2 e da `BACKUP_PASSPHRASE`:

```bash
docker build -t editor-markdown-backup backup/
railway run -p <projeto> -e production -s editor-markdown-backup -- \
  docker run --rm -e R2_ACCOUNT_ID -e R2_ACCESS_KEY_ID -e R2_SECRET_ACCESS_KEY \
    -e R2_BUCKET -e BACKUP_PASSPHRASE --entrypoint verify.sh editor-markdown-backup
```

## Restaurar de verdade (desastre)

Nunca restaure por cima do banco em uso. Restaure num PostgreSQL 18 **novo e
vazio**, confira e só então aponte a API para ele.

```bash
# 1. Baixe o arquivo (painel do R2 ou aws-cli) e confira o SHA-256 com o
#    metadado "sha256" do objeto
sha256sum editor-markdown_<data>.tar.gpg

# 2. Decripte (pede a BACKUP_PASSPHRASE) e extraia
gpg --decrypt --output backup.tar editor-markdown_<data>.tar.gpg
tar -xf backup.tar          # manifest.txt roles.sql db.dump fingerprint.txt
sha256sum roles.sql db.dump fingerprint.txt   # compare com manifest.txt

# 3. No PostgreSQL novo, como o superusuário de bootstrap (manifest:
#    bootstrap_role, normalmente "postgres"). O "CREATE ROLE postgres" falha por
#    já existir: é o único erro esperado.
export PGHOST=<host> PGPORT=<porta> PGUSER=postgres PGPASSWORD=<senha>
psql -d postgres -f roles.sql
pg_restore -d postgres --create --exit-on-error db.dump   # recria o banco com o nome original

# 4. Os papéis voltam SEM senha (de propósito). Defina-as com a tarefa
#    `migrate` do serviço editor-markdown-ops (APP_API_DB_PASSWORD e
#    BACKUP_DB_PASSWORD) apontando MIGRATION_DATABASE_URL para o banco novo.
```

`fingerprint.txt` é a impressão digital da produção no momento do backup. Rodar
`fingerprint.sql` no banco restaurado deve dar exatamente o mesmo resultado.

## Rotação da senha de criptografia

1. Defina a nova `BACKUP_PASSPHRASE` e `BACKUP_KEY_ID=v2`.
2. Os backups novos vão para `postgres/v2/`, e a retenção só enxerga a pasta da
   chave em uso.
3. Os de `postgres/v1/` continuam abrindo com a senha antiga. Apague-os
   manualmente quando os de `v2/` cobrirem o período desejado.
