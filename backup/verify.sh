#!/usr/bin/env bash
# =============================================================================
# Editor Markdown — teste de restauração a partir do R2 (não toca a produção)
#
#   verify.sh [chave]   sem chave: o backup diário mais recente
#
#   1. baixa o arquivo e confere o SHA-256 com o registrado no upload
#   2. decripta (BACKUP_PASSPHRASE) e confere o SHA-256 de cada peça
#   3. restaura papéis + banco num PostgreSQL TEMPORÁRIO e isolado (sem rede)
#   4. compara a impressão digital da cópia com a da produção no momento do
#      backup (gravada dentro do próprio pacote)
#
# Precisa só do R2 e da senha: nenhuma conexão com o banco de produção.
# =============================================================================
set -Eeuo pipefail
umask 077

# shellcheck source=lib.sh
source /usr/local/lib/editor-markdown-backup/lib.sh

STEP="init"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgverify.XXXXXX")"
cleanup() {
  local rc=$?
  set +e
  stop_temp_pg
  [[ $rc -ne 0 ]] && log "VERIFY=FAILED step=${STEP} exit=${rc}"
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT

STEP="config"
setup_r2
load_passphrase

STEP="locate"
KEY="${1:-$(list_backups daily | tail -1)}"
[[ -n "$KEY" ]] || { log "erro: nenhum backup em ${R2_BUCKET}/${BASE_PREFIX}/daily/"; exit 2; }
[[ "${KEY##*/}" =~ $NAME_REGEX ]] || { log "erro: nome de backup inesperado: ${KEY##*/}"; exit 2; }
log "verificando ${R2_BUCKET}/${KEY}"

STEP="download"
EXPECTED_SHA="$(s3 s3api head-object --bucket "$R2_BUCKET" --key "$KEY" --query 'Metadata.sha256' --output text)"
s3 s3 cp --only-show-errors "s3://${R2_BUCKET}/${KEY}" "$WORK/backup.tar.gpg"
ACTUAL_SHA="$(sha256 "$WORK/backup.tar.gpg")"
[[ "$ACTUAL_SHA" == "$EXPECTED_SHA" ]] || { log "erro: SHA-256 difere do registrado no upload"; exit 3; }
log "SHA-256 ok ${ACTUAL_SHA} tamanho=$(human "$(stat -c %s "$WORK/backup.tar.gpg")")"

STEP="decrypt"
# O arquivo precisa estar criptografado: o pacote OpenPGP simétrico começa
# com o marcador do bloco SKESK, e o tar puro nunca abre aqui.
if tar -tf "$WORK/backup.tar.gpg" >/dev/null 2>&1; then
  log "erro: o arquivo no R2 não está criptografado"
  exit 3
fi
ENC_INFO="$(gpg --list-packets --batch --pinentry-mode loopback --passphrase-fd 3 "$WORK/backup.tar.gpg" \
  3< <(printf '%s' "$PASSPHRASE") 2>/dev/null | grep -m1 -o -E 'symkey enc packet: version [0-9]+, cipher [0-9]+' || true)"
# No OpenPGP, o algoritmo 9 é AES-256.
[[ "$ENC_INFO" =~ cipher\ 9$ ]] || { log "erro: o arquivo não está criptografado com AES-256 (${ENC_INFO:-sem pacote simétrico})"; exit 3; }
log "criptografia: OpenPGP simétrico, AES-256"
gpg_decrypt "$WORK/backup.tar.gpg" "$WORK/backup.tar"
mkdir -p "$WORK/bundle"
tar -xf "$WORK/backup.tar" -C "$WORK/bundle"
check_bundle "$WORK/bundle" || exit 3
DB_NAME="$(manifest_value "$WORK/bundle" database)"
BOOTSTRAP="$(manifest_value "$WORK/bundle" bootstrap_role)"
log "decriptação ok; manifest confere (run=$(manifest_value "$WORK/bundle" run) servidor=$(manifest_value "$WORK/bundle" server_version))"

STEP="restore"
start_temp_pg "${BOOTSTRAP:-postgres}"
restore_and_fingerprint "$WORK/bundle" "$DB_NAME" "$WORK/restored.txt" || exit 4
stop_temp_pg

STEP="compare"
log "no backup  $(describe_fingerprint "$WORK/bundle/fingerprint.txt")"
log "restaurado $(describe_fingerprint "$WORK/restored.txt")"
if ! cmp -s "$WORK/bundle/fingerprint.txt" "$WORK/restored.txt"; then
  log "erro: diferenças em: $(diff "$WORK/bundle/fingerprint.txt" "$WORK/restored.txt" | grep '^[<>]' | cut -d'|' -f1,2 | sort -u | tr '\n' ' ')"
  exit 5
fi
# Checksums completos dos dados migrados, para comparar com a produção atual
grep '^data|' "$WORK/restored.txt" | while IFS='|' read -r _ name count md5; do log "checksum ${name} ${count} ${md5}"; done
log "VERIFY=OK ${KEY##*/}: restauração idêntica à produção no momento do backup"
