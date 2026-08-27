/**
 * Colorização de Markdown para o editor.
 *
 * O destaque é feito linha a linha de propósito: o espelho do editor renderiza
 * uma <div> por linha, então um tokenizador que atravessasse linhas (como os de
 * uso geral) não teria onde encaixar. A única coisa que depende de contexto é o
 * bloco de código cercado, resolvido por `computeFenceFlags`.
 */

export interface Token {
  text: string;
  /** Sufixo da classe CSS aplicada (`md-heading`, `md-bold`, ...). */
  kind?: string;
}

/** Abertura ou fechamento de bloco cercado: ``` ou ~~~ */
const FENCE = /^\s{0,3}(```|~~~)/;

/** Linha inteira vira título: `# ` até `###### `. */
const HEADING = /^\s{0,3}#{1,6}\s/;

/** Régua horizontal: ---, ***, ___ (três ou mais). */
const HORIZONTAL_RULE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;

/** Citação (`>`) ou marcador de lista (`-`, `*`, `+`, `1.`) no começo da linha. */
const LINE_PREFIX = /^(\s*(?:>\s?)+|\s*(?:[-*+]|\d+[.)])\s)/;

/**
 * Um passe só para todos os inline. A ordem importa: código antes de tudo (o
 * que está em crase não é formatado), e negrito antes de itálico, senão `**`
 * seria lido como dois itálicos.
 *
 * Todos os grupos usam classe negada em vez de `.*?`, o que mantém o casamento
 * linear e evita backtracking catastrófico em linhas longas.
 */
const INLINE = new RegExp(
  [
    '(`[^`]+`)', // código
    '(\\*\\*[^*]+\\*\\*|__[^_]+__)', // negrito
    '(\\*[^*\\s][^*]*\\*|_[^_\\s][^_]*_)', // itálico
    '(~~[^~]+~~)', // riscado
    '(!?\\[[^\\]]*\\]\\([^)]*\\))', // link e imagem
    '(https?://[^\\s)]+)', // url solta
    '(\\|)', // separador de tabela
  ].join('|'),
  'g'
);

const INLINE_KINDS = ['code', 'bold', 'italic', 'strike', 'link', 'url', 'table'];

/**
 * Para cada linha, diz se ela está *dentro* de um bloco de código cercado.
 * A linha da própria cerca não conta como dentro — ela tem estilo próprio.
 */
export function computeFenceFlags(lines: string[]): boolean[] {
  const flags: boolean[] = new Array(lines.length);
  let open = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE.test(lines[i])) {
      flags[i] = false;
      open = !open;
    } else {
      flags[i] = open;
    }
  }

  return flags;
}

function tokenizeInline(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) {
      tokens.push({ text: text.slice(last, match.index) });
    }

    // Só um dos grupos casou; o índice dele diz qual é o tipo.
    let kind: string | undefined;
    for (let i = 0; i < INLINE_KINDS.length; i += 1) {
      if (match[i + 1] !== undefined) {
        kind = INLINE_KINDS[i];
        break;
      }
    }

    tokens.push({ text: match[0], kind });
    last = match.index + match[0].length;
  }

  if (last < text.length) {
    tokens.push({ text: text.slice(last) });
  }

  return tokens;
}

export function tokenizeLine(line: string, insideFence: boolean): Token[] {
  if (insideFence) return [{ text: line, kind: 'code-block' }];
  if (FENCE.test(line)) return [{ text: line, kind: 'fence' }];
  if (!line) return [];

  if (HEADING.test(line)) return [{ text: line, kind: 'heading' }];
  if (HORIZONTAL_RULE.test(line)) return [{ text: line, kind: 'rule' }];

  const prefix = LINE_PREFIX.exec(line);
  if (!prefix) return tokenizeInline(line);

  return [{ text: prefix[1], kind: 'marker' }, ...tokenizeInline(line.slice(prefix[1].length))];
}
