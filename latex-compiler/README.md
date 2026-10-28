# editor-markdown-latex (compilador LaTeX)

Serviço isolado que compila projetos LaTeX em PDF para o Editor Markdown. Só a
API chama este serviço; ele **não tem acesso ao banco, à sessão nem a nenhum
segredo da aplicação** — recebe os arquivos do projeto, devolve PDF + diagnósticos.

```
navegador ──/api/*──> Vercel (middleware) ──> API (Railway)
                                               │  lê os arquivos do projeto no Postgres (RLS, como o usuário)
                                               │  POST /compile (rede privada, Bearer COMPILER_TOKEN)
                                               ▼
                                   editor-markdown-latex (este serviço, sem domínio público)
                                               │  sandbox-exec → latexmk → pdflatex/xelatex/lualatex, bibtex/biber
                                               ▼
                                   multipart: result (JSON) + pdf
```

## Motor: TeX Live + latexmk (e não Tectonic)

| Critério | TeX Live (Debian) + latexmk | Tectonic |
| --- | --- | --- |
| Pacotes | Coleções instaladas na imagem; tudo **offline** | Baixa pacotes sob demanda da internet (pode pré-cachear, mas o modo normal precisa de rede) |
| Sem rede de saída | Funciona sem rede | Conflita com o requisito de bloquear a rede |
| BibTeX, biblatex + Biber | Sim (Biber 2.20 casado com biblatex do mesmo TeX Live) | Biber só como binário externo, com versão casada manualmente |
| XeLaTeX / LuaLaTeX | Sim | XeTeX apenas |
| Passagens múltiplas | latexmk (padrão de fato, usado pelo Overleaf) | Embutido |
| Manutenção | Pacotes do Debian (atualizações de segurança via imagem base) | Projeto com manutenção mais lenta |
| Tamanho | Imagem de ~1,9 GB | Menor, mas o cache de pacotes cresce |

A combinação TeX Live + latexmk tem a maior compatibilidade com documentos
acadêmicos e é a única que cumpre "sem rede" sem gambiarras.

Coleções instaladas: `latex-base/recommended/extra`, `fonts-recommended`, `cm-super`,
`lmodern`, `science`, `pictures` (TikZ/pgfplots), `bibtex-extra` + `biber`,
`publishers` (IEEE, ACM, Elsevier, Springer, abnTeX2…), `xetex`, `luatex`,
`plain-generic`, idiomas português, inglês, espanhol e europeus.

## Isolamento de cada compilação

Camadas, da mais externa para a mais interna:

1. **Serviço separado** no Railway, sem domínio público (só rede privada), sem
   variáveis de banco nem segredos da API. Chamadas exigem `Authorization: Bearer
   <COMPILER_TOKEN>` (comparação em tempo constante). O token sai de
   `process.env` na subida e nunca é repassado ao TeX.
2. **UID próprio por slot** (`texjob1..texjob8`, sem login). O diretório de cada
   compilação é `0700` daquele UID: uma compilação não lê a outra, e nenhuma lê
   `/proc/1/environ` do serviço. O Node roda como root **só** para entregar cada
   job ao UID do slot; nenhum código do usuário roda como root.
3. **`sandbox-exec`** (`sandbox/sandbox-exec.c`, C + libseccomp), antes do `execvp`:
   - `setsid`, limites de **CPU, memória (RLIMIT_AS), tamanho de arquivo,
     processos e descritores**, core dump desligado;
   - troca para o UID/GID do slot (sem grupos) e confere que não volta a root;
   - `no_new_privs` + **seccomp**: sockets `AF_INET`, `AF_INET6`, `AF_NETLINK`,
     `AF_PACKET`… recusados (**sem rede**, inclusive DNS); `io_uring` (contornaria o
     filtro), `ptrace`, `process_vm_*`, `unshare`/`setns`/`mount`/`chroot`, `bpf`,
     `keyctl`, módulos e `clone` com flags de namespace recusados. Só `AF_UNIX` passa.
   - Funciona sem namespaces e sem `CAP_SYS_ADMIN`, ou seja, em contêineres comuns.
4. **TeX** (`tex/99-sandbox.cnf` + variáveis de ambiente de cada job):
   `shell_escape = f` (sem `\write18`, nem a lista restrita), `openout_any = p`,
   `openin_any = p` (pdfLaTeX/XeLaTeX: sem caminhos absolutos, `..` ou ocultos),
   `parse_first_line = f`, geração de fontes `mktex*` desligada.
   O LuaLaTeX usa `openin_any = r`: o luaotfload abre arquivos da árvore do TeX
   por caminho absoluto. Nesse caso a barreira é o UID do slot (só lê o que
   qualquer usuário do contêiner lê: a árvore do TeX, `/etc/passwd` etc.).
5. **latexmk -norc** com um rc próprio (`tex/latexmkrc`): nenhum `latexmkrc` do
   projeto é lido (seria código Perl). `biber --noconf`. `latexmkrc`,
   `biber.conf`, `texmf.cnf` e arquivos ocultos são recusados já na validação.
6. **Caminhos** (`src/paths.ts`, idêntico na API e no frontend): relativos, sem
   `.`/`..`, sem ocultos, sem `\`, sem letra de unidade, sem controle,
   extensões permitidas. Os arquivos são gravados com `O_EXCL` e conferidos
   dentro do diretório do job.
7. **Saídas lidas com `O_NOFOLLOW`**, só se forem arquivos comuns do UID do slot
   com um único link: um symlink criado pelo TeX não engana o serviço.
8. **Limpeza**: `pkill -KILL -u <slot>` ao fim de cada job, diretório removido,
   restos varridos na subida. `tini` é o PID 1 e recolhe os processos mortos.

**Autoteste na subida** (`GET /health`): UID do slot, socket IPv4/IPv6
bloqueado, ambiente do serviço inacessível, sem volta a root, `shell_escape=f`,
`openin_any=p`, `openout_any=p`. Se qualquer item falhar, o serviço responde
`503 sandbox_unavailable` e **não compila** — não existe modo "sem sandbox".

## Limites (variáveis de ambiente)

| Variável | Padrão | O quê |
| --- | --- | --- |
| `COMPILER_TOKEN` | — (obrigatória, 32+ caracteres) | Token que a API envia |
| `COMPILE_TIMEOUT_MS` | `60000` | Tempo total (todas as passagens) |
| `COMPILE_CPU_SECONDS` | = timeout | CPU por processo |
| `COMPILE_MEMORY_MB` | `2048` | Memória por processo |
| `COMPILE_MAX_FILE_MB` | `64` | Maior arquivo que o TeX escreve |
| `COMPILE_MAX_DISK_MB` | `256` | Soma do diretório do job (monitorada a cada 0,5 s) |
| `COMPILE_MAX_PROCESSES` | `32` | Processos por job |
| `COMPILE_MAX_OPEN_FILES` | `256` | Descritores por processo |
| `COMPILE_CONCURRENCY` | `2` (máx. 8) | Compilações simultâneas (um UID por slot) |
| `COMPILE_QUEUE_LENGTH` | `8` | Fila de espera; acima disso `503 compiler_busy` |
| `COMPILE_QUEUE_WAIT_MS` | `30000` | Espera máxima na fila |
| `COMPILE_MAX_REQUEST_MB` | `64` | Corpo da requisição (projeto inteiro) |
| `COMPILE_MAX_FILES` | `500` | Arquivos por projeto |
| `COMPILE_MAX_PDF_MB` | `25` | PDF gerado |
| `COMPILE_MAX_LOG_KB` | `512` | Log devolvido |

Memória do serviço: ~100 MB ocioso + até `COMPILE_CONCURRENCY × COMPILE_MEMORY_MB`
no pior caso. Com os padrões, 2–4 GB no Railway bastam.

**Cancelamento**: a API aborta a requisição (usuário cancelou, compilação mais
nova do mesmo documento, tempo esgotado) → a conexão fecha → o grupo de
processos do job é morto e o slot é liberado.

## API HTTP

- `GET /health` — sem autenticação (healthcheck do Railway); 200 só com o sandbox ativo.
- `POST /compile` — `multipart/form-data`: `manifest` = `{ mainFile, engine?, files: [{ path, field }] }`
  e um campo por arquivo. Resposta `multipart/form-data`: `result` (JSON: `status`,
  `engine`, `durationMs`, `diagnostics`, `log`, `output`, `pdfBytes`) e `pdf` quando compilou.
  `status`: `success`, `warnings`, `error`, `timeout`, `cancelled`, `too_large`.

O motor sai do comentário mágico do arquivo principal (`% !TEX program = xelatex`,
o mesmo do TeXstudio/VS Code/Overleaf), ou de `fontspec`/`unicode-math`/`polyglossia`
(→ XeLaTeX), ou é pdfLaTeX.

## Testes

```bash
npm ci && npm test                        # unitários (caminhos, log, motor, fila)
docker build --target test -t latex-compiler-test .
docker run --rm -e LATEX_INTEGRATION=1 latex-compiler-test   # TeX real: 29 cenários
```

Os testes de integração compilam documentos reais: fórmulas, tabelas, imagens,
referências cruzadas, BibTeX, biblatex/Biber, vários arquivos com `.sty` próprio,
XeLaTeX, LuaLaTeX, erros com arquivo/linha, pacote inexistente, laço infinito
(tempo limite), cancelamento, saída gigante, `\input{/etc/passwd}`, `../`,
`\write18`, Lua com `os.execute`/socket/leitura de `/proc/1/environ`, leitura do
diretório de outra compilação em andamento, `latexmkrc` no projeto, zero
processos (nem zumbis) depois de cancelar, e o HTTP (token, multipart,
cancelamento ao fechar a conexão).

## Railway (staging primeiro)

Serviço `editor-markdown-latex` no mesmo projeto/ambiente da API:

- Fonte: este repositório, **diretório raiz `/latex-compiler`**, builder Dockerfile
  (o último estágio, `runtime`, é a imagem de produção).
- **Sem domínio público** e sem TCP proxy. A API fala com
  `http://editor-markdown-latex.railway.internal:8080` pela rede privada.
- Healthcheck: `/health` (só passa com o sandbox ativo). Restart: on failure.
- Variáveis: `COMPILER_TOKEN` (gere com `openssl rand -hex 32`) e, se quiser,
  os limites acima. **Nenhuma** variável de banco, Better Auth ou proxy.
- Recursos: 2 vCPU / 4 GB é folgado para `COMPILE_CONCURRENCY=2`.

Na API: `COMPILER_URL=http://editor-markdown-latex.railway.internal:8080` e
`COMPILER_TOKEN=${{editor-markdown-latex.COMPILER_TOKEN}}`.

Ver o procedimento completo (ordem segura, migration 006, verificação) em
[`docs/latex.md`](../docs/latex.md).

## Limitações conhecidas

- Não há **shell-escape**: pacotes que dependem dele não funcionam —
  `minted` (use `listings`), `svg` (converta para PDF/PNG), `epstopdf`
  automático (envie `.eps` já convertido), `gnuplottex`, `pythontex`,
  `\write18` em geral.
- Imagens: PNG, JPG e PDF. EPS só funciona se o documento não precisar de
  conversão (ex.: `latex`+`dvips`, que não é o fluxo usado). SVG não é aceito.
- Fontes do sistema no XeLaTeX/LuaLaTeX: as do TeX Live (Latin Modern, TeX Gyre,
  etc.). Fontes próprias entram como `.ttf`/`.otf` no projeto.
- Pacotes fora das coleções instaladas (ex.: `texlive-fonts-extra`, `-humanities`,
  `-music`) não estão disponíveis; o erro aparece como "pacote não disponível".
  Um `.sty`/`.cls` próprio pode ser enviado junto com o projeto.
- `makeindex` roda pelo latexmk; `glossaries` com `makeglossaries` não (seria
  um programa externo via regra customizada, que está desligada).
