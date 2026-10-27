import pg from 'pg';
import { neonStyleHash } from './staging-check.js';

/**
 * Dados SINTÉTICOS para um banco de staging (ou local): dois usuários de teste,
 * pastas e documentos que exercitam markdown, diagramas mermaid e tentativas de
 * XSS que não podem executar.
 *
 * Travas (qualquer uma falhando aborta antes de gravar):
 * - ambiente: RAILWAY_ENVIRONMENT_NAME === 'staging', ou allowLocal com o banco
 *   em localhost/127.0.0.1;
 * - o banco só pode conter usuários com e-mail de domínio reservado
 *   (.invalid, .test, .example): nunca roda sobre dados reais.
 *
 * Rodar de novo recria só os usuários de teste (e, em cascata, os documentos
 * deles). Nenhuma senha é impressa.
 */

export type SeedOptions = {
  adminUrl: string;
  password: string;
  environmentName: string | undefined;
  allowLocal?: boolean;
  log?: (line: string) => void;
};

export const SEED_USERS = [
  { email: 'ana.teste@example.invalid', name: 'Ana Teste (fictícia)' },
  { email: 'bruno.teste@example.invalid', name: 'Bruno Teste (fictício)' },
] as const;

const RESERVED_DOMAIN = /\.(invalid|test|example)$/i;

const WELCOME = `# Boas-vindas (documento fictício)

Este documento é **sintético** e existe só para testes.

## Listas e tarefas

- Item com *itálico* e \`código\`
- [Link comum](https://example.com)
  - Subitem

- [x] Tarefa concluída
- [ ] Tarefa pendente

## Tabela

| Coluna | Valor |
|:-------|------:|
| A      |     1 |
| B      |     2 |

> Citação de exemplo.

\`\`\`ts
const soma = (a: number, b: number) => a + b;
\`\`\`
`;

const DIAGRAMS = `# Diagramas mermaid (fictício)

\`\`\`mermaid
flowchart TD
  A[Início] --> B{Decisão}
  B -->|sim| C[Fim]
  B -->|não| D[Volta]
  D --> A
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant N as Navegador
  participant V as Vercel
  participant R as Railway
  N->>V: DELETE /api/documents/:id
  V->>R: repassa
  R-->>V: 204
  V-->>N: 204
\`\`\`

\`\`\`mermaid
classDiagram
  class Documento {
    +string id
    +string titulo
    +salvar()
  }
  class Pasta
  Pasta "1" --> "*" Documento
\`\`\`

\`\`\`mermaid
stateDiagram-v2
  [*] --> Rascunho
  Rascunho --> Publicado
  Publicado --> [*]
\`\`\`

\`\`\`mermaid
erDiagram
  USUARIO ||--o{ DOCUMENTO : escreve
  PASTA ||--o{ DOCUMENTO : contem
\`\`\`

\`\`\`mermaid
gantt
  title Cronograma fictício
  dateFormat YYYY-MM-DD
  section Fase 1
  Tarefa A :a1, 2026-01-01, 7d
  Tarefa B :after a1, 5d
\`\`\`

\`\`\`mermaid
pie title Distribuição fictícia
  "A" : 40
  "B" : 35
  "C" : 25
\`\`\`

\`\`\`mermaid
mindmap
  root((Editor))
    Markdown
    Mermaid
    Pastas
\`\`\`

\`\`\`mermaid
flowchart LR
  F["$$x^2 + y^2 = z^2$$"] --> G[Fórmula com KaTeX]
\`\`\`
`;

/** Cada linha tenta executar código; o teste passa se nada executar. */
const XSS = `# Teste de XSS (nada aqui pode executar)

<script>window.__xss = 'script'</script>

<img src="x" onerror="window.__xss = 'img'">

<iframe src="javascript:window.__xss='iframe'"></iframe>

<svg onload="window.__xss = 'svg'"></svg>

[link javascript](javascript:window.__xss='link')

![imagem javascript](javascript:window.__xss='imagem')

\`\`\`mermaid
flowchart TD
  A["<img src=x onerror=window.__xss='mermaid-label'>"] --> B
  click A href "javascript:window.__xss='mermaid-click'"
  click B call alert()
\`\`\`
`;

export async function runStagingSeed(o: SeedOptions): Promise<{ users: number; folders: number; documents: number }> {
  const log = o.log ?? console.log;
  const target = new URL(o.adminUrl);
  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname);
  if (o.environmentName !== 'staging' && !(o.allowLocal && isLocal)) {
    throw new Error('staging-seed só roda no ambiente staging do Railway (ou localmente com permissão explícita)');
  }
  if (o.password.length < 16) throw new Error('A senha dos usuários de teste precisa de pelo menos 16 caracteres');

  const client = new pg.Client({ connectionString: o.adminUrl, application_name: 'editor-markdown-staging-seed' });
  await client.connect();
  try {
    await client.query('BEGIN');
    const { rows: users } = await client.query<{ email: string }>('SELECT email FROM app_auth."user"');
    const real = users.filter((u) => !RESERVED_DOMAIN.test(u.email.split('@')[1] ?? ''));
    if (real.length > 0) {
      throw new Error(`O banco tem ${real.length} usuário(s) que não são de teste: nada foi gravado`);
    }

    await client.query('DELETE FROM app_auth."user" WHERE email = ANY($1)', [SEED_USERS.map((u) => u.email)]);

    const ids: string[] = [];
    for (const u of SEED_USERS) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO app_auth."user" (name, email, "emailVerified") VALUES ($1, $2, true) RETURNING id`,
        [u.name, u.email]
      );
      const id = rows[0]!.id;
      ids.push(id);
      await client.query(
        `INSERT INTO app_auth.account ("accountId", "providerId", "userId", password) VALUES ($1, 'credential', $2, $3)`,
        [id, id, neonStyleHash(o.password)]
      );
    }
    const [ana, bruno] = ids as [string, string];

    const folder = async (userId: string, name: string) =>
      (await client.query<{ id: string }>('INSERT INTO app.folders (user_id, name) VALUES ($1, $2) RETURNING id', [userId, name]))
        .rows[0]!.id;
    const doc = (userId: string, title: string, content: string, folderId: string | null = null) =>
      client.query('INSERT INTO app.documents (user_id, folder_id, title, content) VALUES ($1, $2, $3, $4)', [
        userId,
        folderId,
        title,
        content,
      ]);

    const projetos = await folder(ana, 'Projetos (fictício)');
    const diagramas = await folder(ana, 'Diagramas (fictício)');
    await doc(ana, 'Boas-vindas (fictício)', WELCOME, projetos);
    await doc(ana, 'Diagramas mermaid (fictício)', DIAGRAMS, diagramas);
    await doc(ana, 'Teste de XSS (fictício)', XSS, diagramas);
    await doc(ana, 'Rascunho sem pasta (fictício)', 'Texto simples, sem pasta.');
    await doc(bruno, 'Documento privado do Bruno (fictício)', 'Só o Bruno pode ver este documento.');

    await client.query('COMMIT');
    const counts = { users: SEED_USERS.length, folders: 2, documents: 5 };
    log(`[seed] usuários de teste: ${counts.users}, pastas: ${counts.folders}, documentos: ${counts.documents}`);
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}
