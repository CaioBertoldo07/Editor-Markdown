#!/usr/bin/env bash
# Funções comuns a backup.sh e verify.sh. Nunca imprimem credenciais nem
# conteúdo do banco: só nomes de arquivo, tamanhos, contagens e hashes.

APP_NAME="${APP_NAME:-editor-markdown}"
R2_PREFIX="${R2_PREFIX:-postgres}"
BACKUP_KEY_ID="${BACKUP_KEY_ID:-v1}"
FINGERPRINT_SQL="${FINGERPRINT_SQL:-/usr/local/share/editor-markdown-backup/fingerprint.sql}"
NAME_REGEX="^${APP_NAME}_[0-9]{8}T[0-9]{6}Z\.tar\.gpg$"

log() { printf '%s [backup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || printf '%sB' "$1"; }
sha256() { sha256sum "$1" | awk '{print $1}'; }

# Mostra no máximo 3 linhas de erro de uma ferramenta, sem as linhas DETAIL/
# CONTEXT (é nelas que o PostgreSQL costuma citar valores de linhas).
show_errors() { # $1 = arquivo com o stderr
  grep -E -i 'error|fatal|erro' "$1" | grep -v -E '^(DETAIL|CONTEXT|HINT)|COPY .* line' | head -3 | cut -c1-200 || true
}

# R2 (API S3) -----------------------------------------------------------------
setup_r2() {
  local missing=() v
  for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
    [[ -n "${!v:-}" ]] || missing+=("$v")
  done
  if (( ${#missing[@]} )); then
    log "erro: variáveis ausentes: ${missing[*]}"
    exit 2
  fi
  R2_ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
  BASE_PREFIX="${R2_PREFIX}/${BACKUP_KEY_ID}"
  export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export AWS_DEFAULT_REGION="auto"
  export AWS_EC2_METADATA_DISABLED=true
  # O R2 não aceita os checksums CRC que o aws-cli recente envia por padrão.
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
  export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
  unset R2_SECRET_ACCESS_KEY
}

s3() { aws --endpoint-url "$R2_ENDPOINT" "$@"; }

list_backups() { # $1 = daily|weekly -> chaves válidas, em ordem cronológica
  s3 s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix "${BASE_PREFIX}/$1/" --query 'Contents[].Key' --output text \
    | tr '\t' '\n' \
    | while read -r key; do
        if [[ "${key##*/}" =~ $NAME_REGEX ]]; then echo "$key"; fi
      done \
    | sort
}

# Criptografia (GPG simétrico, AES-256) ---------------------------------------
load_passphrase() {
  PASSPHRASE="${BACKUP_PASSPHRASE:-}"
  # A senha fica só neste shell: nenhum processo filho (aws, psql...) a herda.
  unset BACKUP_PASSPHRASE
  if [[ -z "$PASSPHRASE" ]]; then
    log "erro: variáveis ausentes: BACKUP_PASSPHRASE"
    exit 2
  fi
  if (( ${#PASSPHRASE} < 32 )); then
    log "erro: BACKUP_PASSPHRASE muito curta (mínimo 32 caracteres)"
    exit 2
  fi
  local LC_ALL=C
  if ! [[ "$PASSPHRASE" =~ ^[!-~]+$ ]]; then
    # Espaço, quebra de linha ou acento viram uma senha que ninguém consegue
    # digitar de novo no gpg de outro computador.
    log "erro: BACKUP_PASSPHRASE deve ter só letras, números e símbolos ASCII, sem espaços nem quebras de linha"
    exit 2
  fi
  export GNUPGHOME="$WORK/gnupg"
  mkdir -m 700 "$GNUPGHOME"
}

gpg_encrypt() { # $1 = entrada, $2 = saída
  gpg --batch --quiet --yes --no-symkey-cache --pinentry-mode loopback --passphrase-fd 3 \
    --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --s2k-count 65011712 \
    --compress-algo none --output "$2" "$1" \
    3< <(printf '%s' "$PASSPHRASE")
}

gpg_decrypt() { # $1 = entrada, $2 = saída
  gpg --batch --quiet --yes --no-symkey-cache --pinentry-mode loopback --passphrase-fd 3 \
    --decrypt --output "$2" "$1" \
    3< <(printf '%s' "$PASSPHRASE")
}

# Pacote: manifest.txt, roles.sql, db.dump, fingerprint.txt -------------------
manifest_value() { # $1 = diretório do pacote, $2 = chave
  awk -F= -v k="$2" '$1 == k {print substr($0, length(k) + 2)}' "$1/manifest.txt"
}

check_bundle() { # $1 = diretório extraído; confere o SHA-256 de cada peça
  local dir="$1" part expected
  for part in roles.sql db.dump fingerprint.txt; do
    [[ -s "$dir/$part" ]] || { log "erro: pacote sem ${part}"; return 1; }
    expected="$(manifest_value "$dir" "sha256_${part}")"
    if [[ -z "$expected" || "$(sha256 "$dir/$part")" != "$expected" ]]; then
      log "erro: SHA-256 de ${part} não confere com o manifest"
      return 1
    fi
  done
}

# PostgreSQL temporário e isolado ---------------------------------------------
# Sem rede (só socket local), sem fsync, apagado ao final. Nasce com o mesmo
# superusuário de bootstrap da produção (manifest: bootstrap_role): só ele
# pode refazer os GRANT ... GRANTED BY <bootstrap> do pg_dumpall.
TMP_PG_STARTED=0

start_temp_pg() { # $1 = superusuário de bootstrap
  BOOTSTRAP_ROLE="$1"
  initdb -D "$WORK/pgdata" -U "$BOOTSTRAP_ROLE" --auth=trust --encoding=UTF8 --locale=en_US.UTF-8 --no-instructions \
    > "$WORK/initdb.log" 2>&1 || { show_errors "$WORK/initdb.log"; return 1; }
  mkdir -p "$WORK/sock"
  pg_ctl -D "$WORK/pgdata" -w -l "$WORK/pg.log" \
    -o "-c listen_addresses='' -k $WORK/sock -c fsync=off -c full_page_writes=off -c synchronous_commit=off" start >/dev/null
  TMP_PG_STARTED=1
}

stop_temp_pg() {
  if [[ $TMP_PG_STARTED -eq 1 ]]; then
    pg_ctl -D "$WORK/pgdata" -m fast -w stop >/dev/null 2>&1 || pg_ctl -D "$WORK/pgdata" -m immediate -w stop >/dev/null 2>&1
    TMP_PG_STARTED=0
  fi
  rm -rf "$WORK/pgdata"
}

# Restaura papéis + banco (com dono, permissões, RLS e configurações do banco)
# e grava a impressão digital da cópia em $3.
restore_and_fingerprint() { # $1 = diretório do pacote, $2 = nome do banco, $3 = saída
  local dir="$1" db="$2" out="$3"
  (
    unset PGOPTIONS PGAPPNAME DATABASE_URL PGPASSWORD
    export PGHOST="$WORK/sock" PGUSER="$BOOTSTRAP_ROLE"
    # O bootstrap já existe (criado pelo initdb): só a criação dele é pulada;
    # o ALTER ROLE com os atributos dele roda normalmente.
    grep -v -x -F "CREATE ROLE ${BOOTSTRAP_ROLE};" "$dir/roles.sql" \
      | psql -d postgres -X -q -v ON_ERROR_STOP=1 > /dev/null 2> "$WORK/roles.err" \
      || { log "erro: falha ao recriar os papéis"; show_errors "$WORK/roles.err"; exit 1; }
    pg_restore --dbname=postgres --create --exit-on-error "$dir/db.dump" 2> "$WORK/restore.err" \
      || { log "erro: pg_restore falhou"; show_errors "$WORK/restore.err"; exit 1; }
    psql -d "$db" -XAtq -F'|' -v ON_ERROR_STOP=1 -f "$FINGERPRINT_SQL" > "$out" 2> "$WORK/fp.err" \
      || { log "erro: impressão digital da cópia falhou"; show_errors "$WORK/fp.err"; exit 1; }
  )
}

# Resumo para o log: contagens e 8 primeiros caracteres dos checksums.
describe_fingerprint() { # $1 = arquivo
  awk -F'|' '
    $1 == "data"   { d = d sprintf("%s%s=%s(%s)", (d ? " " : ""), $2, $3, substr($4, 1, 8)) }
    $1 == "rows"   { t++; r += $3 }
    $1 == "struct" { s = s sprintf("%s%s=%s", (s ? " " : ""), $2, $3) }
    END { printf "dados: %s | tabelas=%d linhas=%d | estrutura: %s", d, t, r, s }
  ' "$1"
}
