#!/usr/bin/env bash
# =============================================================================
# Editor Markdown — backup diário do PostgreSQL para o Cloudflare R2
#
# Fluxo (para em qualquer erro, sem gravar nada no banco de produção):
#   1. papéis (pg_dumpall --roles-only, sem senhas) + pg_dump custom de um
#      snapshot só-leitura, com a impressão digital da produção no MESMO snapshot
#   2. empacota (manifest com SHA-256 de cada peça) e criptografa (GPG AES-256)
#   3. envia para R2 em <prefixo>/<chave>/staging/
#   4. baixa de volta, confere o SHA-256, decripta e confere byte a byte
#   5. restaura num PostgreSQL TEMPORÁRIO e isolado (sem rede) — papéis, dono,
#      permissões, RLS — e exige impressão digital idêntica à da produção
#   6. só então promove para daily/ (e weekly/, uma vez por semana)
#   7. retenção independente de daily/ e weekly/ — apenas se tudo passou
#
# Logs: só nomes de arquivo, tamanhos, contagens e hashes. Nunca credenciais
# nem conteúdo do banco. A última linha é sempre RESULT=OK ou RESULT=FAILED.
# =============================================================================
set -Eeuo pipefail
umask 077

# shellcheck source=lib.sh
source /usr/local/lib/editor-markdown-backup/lib.sh

KEEP_DAILY="${KEEP_DAILY:-14}"
KEEP_WEEKLY="${KEEP_WEEKLY:-8}"
DUMP_TIMEOUT="${DUMP_TIMEOUT:-1800}"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
FILE_NAME="${APP_NAME}_${RUN_ID}.tar.gpg"
STEP="init"
STAGING_UPLOADED=0
SNAP_PID=""
START_TS="$(date +%s)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgbackup.XXXXXX")"

ping_healthcheck() { # $1 = "" | /start | /fail  (opcional)
  [[ -n "${HEALTHCHECK_URL:-}" ]] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${HEALTHCHECK_URL}${1}" || log "aviso: healthcheck ping falhou"
}

cleanup() {
  local rc=$?
  set +e
  [[ -n "${SNAP_PID:-}" ]] && kill "$SNAP_PID" >/dev/null 2>&1
  stop_temp_pg
  if [[ $rc -ne 0 ]]; then
    if [[ $STAGING_UPLOADED -eq 1 ]]; then
      s3 s3 rm --only-show-errors "s3://${R2_BUCKET}/${STAGING_KEY}" >/dev/null 2>&1
    fi
    log "RESULT=FAILED step=${STEP} exit=${rc} duration=$(( $(date +%s) - START_TS ))s"
    ping_healthcheck /fail
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT

# --------------------------------------------------------------------------- 0
STEP="config"
[[ -n "${DATABASE_URL:-}" ]] || { log "erro: variáveis ausentes: DATABASE_URL"; exit 2; }
for v in KEEP_DAILY KEEP_WEEKLY; do
  [[ "${!v}" =~ ^[1-9][0-9]*$ ]] || { log "erro: ${v} precisa ser um inteiro >= 1"; exit 2; }
done
setup_r2
load_passphrase

# Conexão com o banco: somente leitura, identificada, com timeouts
export PGAPPNAME="${APP_NAME}-backup"
export PGCONNECT_TIMEOUT=20
export PGOPTIONS="-c default_transaction_read_only=on -c idle_in_transaction_session_timeout=600000"

log "início run=${RUN_ID} pg_dump=$(pg_dump --version | awk '{print $3}') chave=${BACKUP_KEY_ID} destino=${R2_BUCKET}/${BASE_PREFIX}/ retenção=${KEEP_DAILY}d/${KEEP_WEEKLY}s"
ping_healthcheck /start

STEP="r2-preflight"
s3 s3api head-bucket --bucket "$R2_BUCKET" >/dev/null
log "R2 acessível"

# --------------------------------------------------------------------------- 1
STEP="connect"
DB_INFO="$(psql "$DATABASE_URL" -XAtq -F'|' -v ON_ERROR_STOP=1 -c \
  "SELECT current_database(), current_user, current_setting('server_version'),
          (SELECT rolsuper FROM pg_roles WHERE rolname = current_user), (SELECT rolname FROM pg_roles WHERE oid = 10)")"
IFS='|' read -r DB_NAME DB_USER SERVER_VERSION DB_SUPER BOOTSTRAP <<<"$DB_INFO"
log "conectado db=${DB_NAME} papel=${DB_USER} servidor=${SERVER_VERSION}"
[[ "$BOOTSTRAP" =~ ^[a-z_][a-z0-9_]*$ ]] || { log "erro: superusuário de bootstrap com nome inesperado"; exit 3; }
[[ "$DB_SUPER" == "f" ]] || log "aviso: o backup está usando um superusuário; o recomendado é o papel app_backup"

BUNDLE="$WORK/bundle"
mkdir -p "$BUNDLE"

STEP="roles"
pg_dumpall --dbname="$DATABASE_URL" --roles-only --no-role-passwords --file="$BUNDLE/roles.sql" 2> "$WORK/roles.err" \
  || { show_errors "$WORK/roles.err"; exit 3; }
ROLE_COUNT=$(grep -c '^CREATE ROLE ' "$BUNDLE/roles.sql" || true)
(( ROLE_COUNT >= 1 )) || { log "erro: nenhum papel exportado"; exit 3; }

# Uma sessão só-leitura segura um snapshot; o pg_dump e a impressão digital da
# produção usam exatamente o mesmo instante, então a comparação é exata.
STEP="snapshot"
coproc SNAPSQL { psql "$DATABASE_URL" -XAtq -F'|' -v ON_ERROR_STOP=1 2>&1; }
SNAP_PID=$SNAPSQL_PID
exec {SNAP_IN}>&"${SNAPSQL[1]}" {SNAP_OUT}<&"${SNAPSQL[0]}"
printf '%s\n' "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;" "SELECT pg_export_snapshot();" >&"$SNAP_IN"
read -r -t 60 SNAPSHOT <&"$SNAP_OUT" || SNAPSHOT=""
if ! [[ "$SNAPSHOT" =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ ]]; then
  log "erro: não foi possível abrir snapshot de leitura"
  exit 3
fi

STEP="pg_dump"
t0=$(date +%s)
timeout "$DUMP_TIMEOUT" pg_dump --dbname="$DATABASE_URL" --snapshot="$SNAPSHOT" \
  --format=custom --compress=9 --lock-wait-timeout=60s \
  --file="$BUNDLE/db.dump" 2> "$WORK/dump.err" \
  || { show_errors "$WORK/dump.err"; exit 3; }
log "dump ok papéis=${ROLE_COUNT} tamanho=$(human "$(stat -c %s "$BUNDLE/db.dump")") tempo=$(( $(date +%s) - t0 ))s"

STEP="prod-fingerprint"
printf '%s\n' "\\i ${FINGERPRINT_SQL}" "SELECT '__END__';" "COMMIT;" '\q' >&"$SNAP_IN"
: > "$BUNDLE/fingerprint.txt"
line=""
while read -r -t 300 line <&"$SNAP_OUT"; do
  [[ "$line" == "__END__" ]] && break
  printf '%s\n' "$line" >> "$BUNDLE/fingerprint.txt"
done
[[ "$line" == "__END__" ]] || { log "erro: impressão digital da produção incompleta"; exit 3; }
exec {SNAP_IN}>&- {SNAP_OUT}<&-
wait "$SNAP_PID" 2>/dev/null || true
SNAP_PID=""
# Só linhas no formato tipo|nome|n|hash (uma mensagem de erro do psql não passa)
if grep -q -v -E '^(rows|data|struct)\|[^|]+\|[0-9]+\|([0-9a-f]{32}|-)$' "$BUNDLE/fingerprint.txt" \
   || ! grep -q '^data|documents|' "$BUNDLE/fingerprint.txt"; then
  log "erro: impressão digital da produção em formato inesperado"
  exit 3
fi
log "produção $(describe_fingerprint "$BUNDLE/fingerprint.txt")"

STEP="dump-check"
TOC_TABLES=$(pg_restore --list "$BUNDLE/db.dump" | grep -c ' TABLE DATA ' || true)
PROD_TABLES=$(grep -c '^rows|' "$BUNDLE/fingerprint.txt" || true)
if (( TOC_TABLES < 1 )) || (( TOC_TABLES != PROD_TABLES )); then
  log "erro: dump com ${TOC_TABLES} tabela(s) de dados, produção tem ${PROD_TABLES}"
  exit 3
fi

# --------------------------------------------------------------------------- 2
STEP="package"
{
  echo "app=${APP_NAME}"
  echo "run=${RUN_ID}"
  echo "database=${DB_NAME}"
  echo "bootstrap_role=${BOOTSTRAP}"
  echo "server_version=${SERVER_VERSION}"
  echo "pg_dump=$(pg_dump --version | awk '{print $3}')"
  echo "key=${BACKUP_KEY_ID}"
  for part in roles.sql db.dump fingerprint.txt; do
    echo "sha256_${part}=$(sha256 "$BUNDLE/$part")"
  done
} > "$BUNDLE/manifest.txt"
tar -cf "$WORK/bundle.tar" -C "$BUNDLE" manifest.txt roles.sql db.dump fingerprint.txt

STEP="encrypt"
gpg_encrypt "$WORK/bundle.tar" "$WORK/$FILE_NAME"
ENC_SIZE=$(stat -c %s "$WORK/$FILE_NAME")
ENC_SHA=$(sha256 "$WORK/$FILE_NAME")

# --------------------------------------------------------------------------- 3
STEP="upload"
STAGING_KEY="${BASE_PREFIX}/staging/${FILE_NAME}"
s3 s3 cp --only-show-errors "$WORK/$FILE_NAME" "s3://${R2_BUCKET}/${STAGING_KEY}" \
  --metadata "sha256=${ENC_SHA},app=${APP_NAME},key=${BACKUP_KEY_ID},database=${DB_NAME}" \
  --content-type application/octet-stream
STAGING_UPLOADED=1

# --------------------------------------------------------------------------- 4
STEP="verify-download"
s3 s3 cp --only-show-errors "s3://${R2_BUCKET}/${STAGING_KEY}" "$WORK/check.gpg"
[[ "$(sha256 "$WORK/check.gpg")" == "$ENC_SHA" ]] || { log "erro: SHA-256 do arquivo no R2 difere do local"; exit 4; }

STEP="verify-decrypt"
gpg_decrypt "$WORK/check.gpg" "$WORK/restore.tar"
cmp -s "$WORK/restore.tar" "$WORK/bundle.tar" || { log "erro: conteúdo decriptado difere do original"; exit 4; }
mkdir -p "$WORK/restore"
tar -xf "$WORK/restore.tar" -C "$WORK/restore"
check_bundle "$WORK/restore" || exit 4
rm -rf "${BUNDLE:?}" "${WORK:?}/bundle.tar" "${WORK:?}/restore.tar" "${WORK:?}/check.gpg" "${WORK:?}/${FILE_NAME:?}"
log "R2 conferido sha256=${ENC_SHA:0:16}… tamanho=$(human "$ENC_SIZE") decriptação e manifest ok"

# --------------------------------------------------------------------------- 5
STEP="restore-test"
t0=$(date +%s)
start_temp_pg "$BOOTSTRAP"
restore_and_fingerprint "$WORK/restore" "$DB_NAME" "$WORK/restored_fingerprint.txt" || exit 5
stop_temp_pg
if ! cmp -s "$WORK/restore/fingerprint.txt" "$WORK/restored_fingerprint.txt"; then
  DIFF_ITEMS=$(diff "$WORK/restore/fingerprint.txt" "$WORK/restored_fingerprint.txt" | grep '^[<>]' | cut -d'|' -f1,2 | sort -u | tr '\n' ' ' || true)
  log "erro: cópia restaurada difere da produção em: ${DIFF_ITEMS}"
  exit 5
fi
log "restauração isolada ok (papéis, permissões, RLS, estrutura e dados idênticos à produção) tempo=$(( $(date +%s) - t0 ))s"
rm -rf "$WORK/restore"

# --------------------------------------------------------------------------- 6
STEP="promote"
DAILY_KEY="${BASE_PREFIX}/daily/${FILE_NAME}"
s3 s3 cp --only-show-errors "s3://${R2_BUCKET}/${STAGING_KEY}" "s3://${R2_BUCKET}/${DAILY_KEY}"
DAILY_LEN=$(s3 s3api head-object --bucket "$R2_BUCKET" --key "$DAILY_KEY" --query ContentLength --output text)
[[ "$DAILY_LEN" == "$ENC_SIZE" ]] || { log "erro: cópia diária com tamanho inesperado"; exit 6; }
s3 s3 rm --only-show-errors "s3://${R2_BUCKET}/${STAGING_KEY}"
STAGING_UPLOADED=0

key_epoch() { # extrai o horário do nome do arquivo
  local ts; ts="$(basename "$1" | sed -E 's/.*_([0-9]{8})T([0-9]{2})([0-9]{2})([0-9]{2})Z.*/\1 \2:\3:\4/')"
  date -u -d "$ts" +%s
}

STEP="weekly"
LAST_WEEKLY="$(list_backups weekly | tail -1)"
WEEKLY_MSG="mantido"
# 6,5 dias de folga: um atraso de minutos no cron não pula a semana.
if [[ -z "$LAST_WEEKLY" ]] || (( $(date -u +%s) - $(key_epoch "$LAST_WEEKLY") >= 6*86400 + 12*3600 )); then
  s3 s3 cp --only-show-errors "s3://${R2_BUCKET}/${DAILY_KEY}" "s3://${R2_BUCKET}/${BASE_PREFIX}/weekly/${FILE_NAME}"
  WEEKLY_MSG="criado"
fi

# --------------------------------------------------------------------------- 7
prune() { # $1 = pasta, $2 = quantas manter
  local all newest count
  all="$(list_backups "$1")"
  newest="$(tail -1 <<<"$all")"
  count=$(grep -c . <<<"$all" || true)
  # Só apaga se o mais recente da pasta for o backup verificado nesta execução
  if [[ "${newest##*/}" != "$FILE_NAME" ]]; then
    log "$1: ${count} cópia(s) (sem limpeza nesta execução)"
    return 0
  fi
  if (( count > $2 )); then
    head -n $(( count - $2 )) <<<"$all" | while read -r old; do
      s3 s3 rm --only-show-errors "s3://${R2_BUCKET}/${old}"
      log "removido backup antigo $1/${old##*/}"
    done
    count=$2
  fi
  log "$1: ${count} cópia(s), limite ${2}"
}
STEP="retention"
prune daily "$KEEP_DAILY"
prune weekly "$KEEP_WEEKLY"

log "RESULT=OK arquivo=${DAILY_KEY} sha256=${ENC_SHA} tamanho=$(human "$ENC_SIZE") semanal=${WEEKLY_MSG} duração=$(( $(date +%s) - START_TS ))s"
ping_healthcheck ""
