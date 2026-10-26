# Mesma base do PostgreSQL de produção (imagem Debian do PostgreSQL 18):
# pg_dump/pg_restore/initdb 18, locale en_US.UTF-8 e a mesma ordenação de texto
# (glibc), para a restauração de teste recriar o banco exatamente igual.
FROM postgres:18

RUN apt-get update \
 && apt-get install -y --no-install-recommends awscli gnupg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && aws --version && gpg --version | head -1 && pg_dump --version \
 && mkdir -p /usr/local/lib/editor-markdown-backup /usr/local/share/editor-markdown-backup

# Diretórios criados antes: o --chmod do COPY valeria também para eles.
COPY --chmod=0644 lib.sh /usr/local/lib/editor-markdown-backup/lib.sh
COPY --chmod=0644 fingerprint.sql /usr/local/share/editor-markdown-backup/fingerprint.sql
COPY --chmod=0755 backup.sh /usr/local/bin/backup.sh
COPY --chmod=0755 verify.sh /usr/local/bin/verify.sh

# Roda sem root (o initdb do teste de restauração exige isso)
USER postgres
WORKDIR /tmp

# Substitui o entrypoint padrão da imagem: aqui NÃO sobe servidor nenhum,
# só executa o backup e termina. Teste de restauração: --entrypoint verify.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
