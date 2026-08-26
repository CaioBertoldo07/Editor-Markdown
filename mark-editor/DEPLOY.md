# Deploy na Vercel

O app é um SPA Vite. Não existe backend próprio: o browser fala direto com o
Neon (Managed Better Auth para login, Data API para as queries) e o **RLS no
banco** é o que garante que cada usuário só enxerga as próprias linhas.

## Projeto Neon

| Item | Valor |
| --- | --- |
| Projeto | `editor-markdown` (`solitary-hall-10339146`) |
| Branch | `main` (`br-little-sky-avwkfchv`) |
| Banco | `neondb` |

Tabelas: `folders` e `documents`, ambas com `user_id text DEFAULT auth.user_id()`,
RLS ativo e uma policy `FOR ALL` que compara `auth.user_id() = user_id`.
`documents.folder_id` tem FK com `ON DELETE SET NULL` — apagar uma pasta não
apaga os documentos dela.

## Variáveis de ambiente

Na Vercel, em **Settings → Environment Variables**, adicione as duas variáveis
que estão no seu `.env` local:

- `VITE_NEON_AUTH_URL`
- `VITE_NEON_DATA_API_URL`

Elas são embutidas no bundle e ficam visíveis no browser — isso é esperado.
Quem protege os dados é o RLS, não o segredo dessas URLs.

## Domínio confiável (obrigatório em produção)

Qualquer porta de `localhost` já é liberada automaticamente, por isso o
desenvolvimento funciona sem configurar nada. **O domínio de produção não é.**
Depois do primeiro deploy, registre a URL da Vercel:

```bash
neon neon-auth domain add https://seu-app.vercel.app
```

Ou pelo Console: **Auth → Configuration → Domains**. Para os deploys de preview,
vale um curinga: `https://*.seu-app.vercel.app`.

Sem isso, os redirecionamentos de OAuth e de verificação de e-mail falham em
produção.

## Rotas

O `vercel.json` já reescreve todas as rotas para `index.html`. Sem isso, abrir
`/doc/<id>` direto ou dar F5 nessa URL retornaria 404, porque quem resolve a
rota é o React Router no cliente.

## Migração dos dados antigos

No primeiro login, se a conta estiver vazia no banco, o que estava no
`localStorage` é enviado para o Neon uma única vez (ver `src/utils/migration.ts`).
A flag `markdown-editor-migrated-to-neon` marca que isso já aconteceu, e a
migração só roda com a conta vazia — então entrar num segundo dispositivo que
ainda tenha rascunhos locais não duplica documentos.
