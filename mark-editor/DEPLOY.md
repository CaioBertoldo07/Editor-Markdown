# Deploy na Vercel

SPA Vite. O navegador fala só com o próprio domínio: `/api/*` é repassado à
API do Railway pelo `middleware.ts` (Routing Middleware da Vercel). Login é o
Better Auth self-hosted da API (cookie HttpOnly, first-party); os dados vêm dos
endpoints REST da API. Não há mais nenhuma dependência do Neon.

## Variáveis (Settings → Environment Variables, SEM prefixo `VITE_`)

| Variável | Production | Preview |
| --- | --- | --- |
| `API_ORIGIN` | domínio público da API de **produção** | domínio da API de **staging** |
| `API_PROXY_SECRET` | `PROXY_SECRET` da API de produção | `PROXY_SECRET` da API de staging |

Nunca coloque o segredo de produção no escopo Preview: assim um Preview nunca
consegue gravar no banco de produção (a API de produção, com
`PROXY_REQUIRED=true`, recusa qualquer chamada sem o segredo e só confia na
origem de produção).

## Rotas

`vercel.json` reescreve tudo, exceto `/api/*`, para `index.html` (React Router).

## IP do cliente e rate limit

O middleware descarta os cabeçalhos de IP enviados pelo navegador e manda
`x-client-ip` com o IP que a borda da Vercel atribuiu à conexão, junto com
`x-proxy-secret`. A API só aceita `x-client-ip` quando o segredo confere.

## Dados antigos do navegador

No primeiro login com a conta vazia, o que estava no `localStorage` é enviado
uma única vez (`src/utils/migration.ts`). A flag `markdown-editor-migrated-to-neon`
continua a mesma: quem já migrou na época do Neon não migra de novo.
