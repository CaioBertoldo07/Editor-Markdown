# Serviço de compilação LaTeX do Editor Markdown.
#
# TeX Live do Debian (offline: nenhum pacote é baixado durante a compilação),
# latexmk para as passagens múltiplas, BibTeX e Biber. Cada compilação roda
# pelo sandbox-exec (seccomp sem rede, UID próprio, limites de recursos).
#
# O ÚLTIMO estágio (runtime) é a imagem de produção — é o que o Railway usa.
# Testes de integração com o TeX real: docker build --target test .

# Compila o sandbox-exec (C + libseccomp).
FROM debian:trixie-slim AS sandbox
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev libseccomp-dev \
 && rm -rf /var/lib/apt/lists/*
COPY sandbox/sandbox-exec.c /src/sandbox-exec.c
RUN gcc -O2 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE -pie \
      -o /sandbox-exec /src/sandbox-exec.c -lseccomp

# Build do serviço Node (TypeScript -> dist).
FROM node:22-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --include=dev
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# TeX Live + usuários dos slots + sandbox (base de teste e produção).
FROM node:22-trixie-slim AS tex

# Coleções escolhidas para documentos acadêmicos: LaTeX base/recomendado/extra,
# fontes, matemática e ciência, figuras (TikZ/pgfplots), bibliografia
# (BibTeX, biblatex + Biber), estilos de editoras (IEEE, ACM, Elsevier,
# Springer, abnTeX2...), XeLaTeX/LuaLaTeX e português. Sem documentação.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      texlive-base texlive-latex-base texlive-latex-recommended texlive-latex-extra \
      texlive-fonts-recommended lmodern cm-super fonts-lmodern \
      texlive-science texlive-pictures texlive-bibtex-extra biber \
      texlive-publishers texlive-xetex texlive-luatex texlive-plain-generic \
      texlive-lang-portuguese texlive-lang-english texlive-lang-spanish texlive-lang-european \
      latexmk libseccomp2 procps fontconfig tini \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/*

# Política do kpathsea para todos os programas TeX (também repetida nas
# variáveis de ambiente de cada compilação): sem shell-escape, leitura e
# escrita só dentro do diretório da compilação.
COPY tex/99-sandbox.cnf /etc/texmf/texmf.d/99-sandbox.cnf
RUN update-texmf >/dev/null \
 && test "$(kpsewhich -var-value=shell_escape)" = "f" \
 && test "$(kpsewhich -var-value=openin_any)" = "p" \
 && test "$(kpsewhich -var-value=openout_any)" = "p"
# Caches de fontes prontos na imagem (só leitura nas compilações).
RUN fc-cache -s >/dev/null && luaotfload-tool --update --force >/dev/null

# Um usuário sem login por slot de compilação simultânea (máximo 8). Os
# diretórios são criados antes dos COPY porque o --chmod valeria para eles.
RUN for i in 1 2 3 4 5 6 7 8; do \
      groupadd --system --gid "$((20000 + i))" "texjob$i" \
      && useradd --system --uid "$((20000 + i))" --gid "$((20000 + i))" \
           --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "texjob$i"; \
    done \
 && install -d -m 0711 -o root -g root /var/lib/latex-jobs \
 && install -d -m 0755 /etc/latex-compiler

COPY --from=sandbox --chmod=0755 /sandbox-exec /usr/local/bin/sandbox-exec
COPY --chmod=0644 tex/latexmkrc /etc/latex-compiler/latexmkrc
ENV JOBS_DIR=/var/lib/latex-jobs

# tini como PID 1: recolhe os processos do TeX mortos por cancelamento ou
# tempo limite. Sem ele, viram zumbis do Node (PID 1) e esgotam o limite de
# processos do UID do slot.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Testes de integração com o TeX real (dependências de desenvolvimento).
FROM tex AS test
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --include=dev
COPY tsconfig.json tsconfig.build.json vitest.config.ts ./
COPY src ./src
COPY test ./test
CMD ["node_modules/.bin/vitest", "run"]

# Produção.
FROM tex AS runtime
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# O serviço roda como root SÓ para entregar cada compilação a um UID de slot
# (o sandbox-exec troca de usuário antes de executar o TeX). Nenhum código do
# usuário roda como root.
ENV NODE_ENV=production PORT=8080 HOST=::
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
