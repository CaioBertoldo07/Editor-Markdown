/**
 * Lê os logs do TeX, BibTeX e Biber e devolve diagnósticos estruturados, com
 * uma mensagem amigável (pt-BR) e o texto original para quem quiser detalhes.
 *
 * O compilador roda com max_print_line=10000 e -file-line-error, então as
 * mensagens não são quebradas em 79 colunas e os erros vêm como
 * "./arquivo.tex:24: mensagem".
 */

export type Severity = 'error' | 'warning' | 'info';

export type Diagnostic = {
  severity: Severity;
  /** Caminho relativo ao projeto (ou de um pacote do sistema), quando conhecido. */
  file: string | null;
  line: number | null;
  /** Mensagem amigável. */
  message: string;
  /** Mensagem original do TeX/BibTeX/Biber. */
  raw: string;
  source: 'latex' | 'bibtex' | 'biber' | 'latexmk';
};

const MAX_DIAGNOSTICS = 200;

const cleanPath = (file: string): string => file.replace(/^\.\//, '').trim();

/** Comando que causou um "Undefined control sequence": o último antes do ponto do erro. */
const culpritCommand = (context: string): string | null => {
  const match = context.match(/(\\[A-Za-z@]+|\\.)\s*$/);
  return match ? match[1]! : null;
};

const at = (line: number | null) => (line ? ` na linha ${line}` : '');

type Friendly = { severity?: Severity; message: string };

/** Mensagens de erro do TeX -> português. `context` é o trecho "l.24 ..." quando existe. */
function friendlyError(raw: string, line: number | null, context: string): Friendly {
  let m: RegExpMatchArray | null;
  if (/^Undefined control sequence/.test(raw)) {
    const cmd = culpritCommand(context);
    return {
      message: `Comando LaTeX não reconhecido${cmd ? ` (${cmd})` : ''}${at(line)}. Confira a grafia ou se o pacote que define o comando foi carregado com \\usepackage.`,
    };
  }
  if ((m = raw.match(/LaTeX Error: File `([^']+)' not found/))) {
    const name = m[1]!;
    const isPackage = /\.(sty|cls)$/.test(name);
    return {
      message: isPackage
        ? `O pacote ou classe "${name}" não está disponível no compilador${at(line)}. Inclua o arquivo no projeto ou use uma alternativa.`
        : `Arquivo "${name}" não encontrado no projeto${at(line)}.`,
    };
  }
  if ((m = raw.match(/LaTeX Error: Environment (\S+) undefined/))) {
    return { message: `Ambiente "${m[1]}" não reconhecido${at(line)}. Talvez falte carregar o pacote que o define.` };
  }
  if ((m = raw.match(/LaTeX Error: \\begin\{([^}]*)\} on input line (\d+) ended by \\end\{([^}]*)\}/))) {
    return { message: `O ambiente "${m[1]}" aberto na linha ${m[2]} foi fechado com \\end{${m[3]}}${at(line)}.` };
  }
  if ((m = raw.match(/LaTeX Error: \\begin\{([^}]*)\} ended by \\end\{([^}]*)\}/))) {
    return { message: `O ambiente "${m[1]}" foi fechado com \\end{${m[2]}}${at(line)}.` };
  }
  if (/LaTeX Error: Missing \\begin\{document\}/.test(raw)) {
    return { message: `Falta \\begin{document} (ou há texto antes dele)${at(line)}.` };
  }
  if (/LaTeX Error: Can be used only in preamble/.test(raw)) {
    return { message: `Este comando só pode ser usado no preâmbulo, antes de \\begin{document}${at(line)}.` };
  }
  if (/LaTeX Error: There's no line here to end/.test(raw)) {
    return { message: `Quebra de linha (\\\\) sem uma linha para terminar${at(line)}.` };
  }
  if ((m = raw.match(/LaTeX Error: Unknown graphics extension: (\S+)/))) {
    return { message: `Formato de imagem "${m[1]}" não suportado por este motor${at(line)}. Use PNG, JPG ou PDF.` };
  }
  if (/^Missing \$ inserted/.test(raw)) {
    return { message: `Símbolo de matemática fora do modo matemático${at(line)}. Faltou abrir ou fechar um "$"?` };
  }
  if (/^Missing \} inserted/.test(raw)) return { message: `Falta fechar uma chave "}"${at(line)}.` };
  if (/^Missing \{ inserted/.test(raw)) return { message: `Falta abrir uma chave "{"${at(line)}.` };
  if (/^Extra \}, or forgotten \$/.test(raw)) return { message: `Há uma chave "}" a mais ou um "$" esquecido${at(line)}.` };
  if (/^Too many \}'s/.test(raw)) return { message: `Há uma chave "}" a mais${at(line)}.` };
  if (/^Extra alignment tab has been changed/.test(raw)) {
    return { message: `A linha da tabela tem mais colunas (&) do que a tabela declara${at(line)}.` };
  }
  if (/^Misplaced alignment tab character &/.test(raw)) {
    return { message: `Caractere "&" fora de uma tabela${at(line)}. Para escrever o símbolo, use \\&.` };
  }
  if ((m = raw.match(/^File ended while scanning use of (\S+?)\.?$/))) {
    return { message: `O arquivo terminou antes de fechar o argumento de ${m[1]}${at(line)}. Falta uma "}"?` };
  }
  if ((m = raw.match(/^Paragraph ended before (\S+?) was complete/))) {
    return { message: `O parágrafo terminou antes de completar ${m[1]}${at(line)}. Falta uma "}"?` };
  }
  if (/^TeX capacity exceeded/.test(raw)) {
    return { message: `Limite interno do TeX excedido${at(line)} — provavelmente um comando que chama a si mesmo sem parar.` };
  }
  if (/fontspec package requires either XeTeX or LuaTeX/.test(raw)) {
    return {
      message: 'O pacote fontspec precisa do XeLaTeX ou LuaLaTeX. Escolha o motor XeLaTeX (ou adicione "% !TEX program = xelatex" na primeira linha).',
    };
  }
  if ((m = raw.match(/^(?:LaTeX|Package|Class) (\S+)? ?Error: (.*)$/))) {
    const who = raw.startsWith('Package') ? `do pacote ${m[1]}` : raw.startsWith('Class') ? `da classe ${m[1]}` : 'do LaTeX';
    return { message: `Erro ${who}${at(line)}: ${m[2]}` };
  }
  if ((m = raw.match(/^LaTeX Error: (.*)$/))) return { message: `Erro do LaTeX${at(line)}: ${m[1]}` };
  if (/^I can't write on file/.test(raw)) {
    return { message: `Não foi possível gravar um arquivo${at(line)}. Só é possível escrever dentro do projeto.` };
  }
  if ((m = raw.match(/^I can't find file `?([^']+)'?/))) {
    return { message: `Arquivo "${m[1]}" não encontrado${at(line)}.` };
  }
  if (/^Emergency stop/.test(raw)) return { message: 'A compilação foi interrompida por causa do erro anterior.' };
  return { message: `${raw}${line ? ` (linha ${line})` : ''}` };
}

function friendlyWarning(raw: string, line: number | null): Friendly | null {
  let m: RegExpMatchArray | null;
  if ((m = raw.match(/Reference `([^']+)' on page \d+ undefined/))) {
    return { message: `Referência "${m[1]}" não definida${at(line)}. Confira se existe um \\label{${m[1]}}.` };
  }
  if ((m = raw.match(/Citation `([^']+)' on page \d+ undefined/)) || (m = raw.match(/Citation '([^']+)' on page \d+ undefined/))) {
    return { message: `Citação "${m[1]}" não encontrada na bibliografia${at(line)}.` };
  }
  if ((m = raw.match(/Label `([^']+)' multiply defined/))) {
    return { message: `O rótulo "${m[1]}" foi definido mais de uma vez.` };
  }
  if (/There were undefined references/.test(raw)) return { message: 'Há referências ou citações não definidas no documento.' };
  if (/There were multiply-defined labels/.test(raw)) return null;
  // Consequência da política de segurança (sem shell-escape), não do documento.
  if (/Package epstopdf Warning: Shell escape feature is not enabled/.test(raw)) {
    return { severity: 'info', message: 'Imagens .eps não são convertidas automaticamente (shell-escape desativado). Use PNG, JPG ou PDF.' };
  }
  if (/Label\(s\) may have changed|Rerun to get/.test(raw)) return null;
  if (/Font shape .* (undefined|not available)/.test(raw) || /^LaTeX Font Warning/.test(raw)) {
    return { severity: 'info', message: `Fonte substituída: ${raw.replace(/^LaTeX Font Warning:\s*/, '')}` };
  }
  if ((m = raw.match(/^Package (\S+) Warning: (.*)$/))) return { message: `Aviso do pacote ${m[1]}${at(line)}: ${m[2]}` };
  if ((m = raw.match(/^Class (\S+) Warning: (.*)$/))) return { message: `Aviso da classe ${m[1]}${at(line)}: ${m[2]}` };
  if ((m = raw.match(/^LaTeX Warning: (.*)$/))) return { message: `Aviso${at(line)}: ${m[1]}` };
  return { message: raw };
}

type StackEntry = string | null;

/** Abre/fecha arquivos conforme os "(" e ")" do log, para saber em que arquivo estamos. */
function trackFiles(text: string, stack: StackEntry[]) {
  const re = /\(([^\s()]*)|\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0] === ')') {
      stack.pop();
    } else {
      const name = m[1] ?? '';
      stack.push(/\.[A-Za-z0-9]+$/.test(name) || name.startsWith('./') ? cleanPath(name) : null);
    }
  }
}

const currentFile = (stack: StackEntry[], projectFiles: ReadonlySet<string>): string | null => {
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i];
    if (entry && projectFiles.has(entry)) return entry;
  }
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i]!;
  return null;
};

const FILE_LINE_ERROR = /^((?:\.\/|\/)?[^\s:][^:]*?\.[A-Za-z0-9]+):(\d+): (.*)$/;
const WARNING = /^(LaTeX Warning|LaTeX Font Warning|Package \S+ Warning|Class \S+ Warning|pdfTeX warning(?: \([^)]*\))?): ?(.*)$/;
const BADBOX = /^(Overfull|Underfull) \\[hv]box \(([^)]*)\).*?(?:at lines? (\d+)(?:--\d+)?)?$/;

export function parseTexLog(log: string, projectFiles: ReadonlySet<string>): Diagnostic[] {
  const lines = log.split(/\r?\n/);
  const out: Diagnostic[] = [];
  const stack: StackEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;

    const fle = text.match(FILE_LINE_ERROR);
    if (fle || text.startsWith('! ')) {
      const raw = (fle ? fle[3]! : text.slice(2)).trim();
      let file = fle ? cleanPath(fle[1]!) : currentFile(stack, projectFiles);
      let line = fle ? Number(fle[2]) : null;
      // Contexto: as linhas seguintes até "l.<n> ..." (onde o TeX parou).
      let context = '';
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        const ctx = lines[j]!.match(/^l\.(\d+) (.*)$/);
        if (ctx) {
          line ??= Number(ctx[1]);
          context = ctx[2]!;
          break;
        }
      }
      // Erro detectado dentro de um pacote do sistema: aponta para o arquivo do projeto aberto.
      if (file && !projectFiles.has(file)) {
        const projectFile = currentFile(stack.filter((e) => e && projectFiles.has(e)), projectFiles);
        if (projectFile && !fle) file = projectFile;
      }
      const friendly = friendlyError(raw, line, context);
      out.push({ severity: 'error', file, line, message: friendly.message, raw: context ? `${raw}\n${context}` : raw, source: 'latex' });
      continue;
    }

    const warn = text.match(WARNING);
    if (warn) {
      // Continuação: linhas seguintes começando com "(pacote)" ou recuadas.
      let raw = `${warn[1]}: ${warn[2]}`;
      const pkg = warn[1]!.match(/^(?:Package|Class) (\S+)/)?.[1];
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        const next = lines[j]!;
        if (pkg && next.startsWith(`(${pkg})`)) raw += ' ' + next.slice(pkg.length + 2).trim();
        else if (!pkg && /^ {2,}\S/.test(next)) raw += ' ' + next.trim();
        else break;
        i = j;
      }
      raw = raw.replace(/\s+/g, ' ').trim();
      const lineMatch = raw.match(/on input line (\d+)/);
      const line = lineMatch ? Number(lineMatch[1]) : null;
      const friendly = friendlyWarning(raw, line);
      if (friendly) {
        out.push({
          severity: friendly.severity ?? (raw.startsWith('pdfTeX') ? 'info' : 'warning'),
          file: currentFile(stack, projectFiles),
          line,
          message: friendly.message,
          raw,
          source: 'latex',
        });
      }
      trackFiles(text, stack);
      continue;
    }

    const box = text.match(BADBOX);
    if (box) {
      const line = box[3] ? Number(box[3]) : null;
      out.push({
        severity: 'info',
        file: currentFile(stack, projectFiles),
        line,
        message: `${box[1] === 'Overfull' ? 'Texto ultrapassa a margem' : 'Espaçamento esticado'} (${box[2]})${at(line)}.`,
        raw: text.trim(),
        source: 'latex',
      });
      continue;
    }

    const blocked = text.match(/Not (reading from|writing to) (.+?) \(open(?:in|out)_any = p\)/);
    if (blocked) {
      out.push({
        severity: 'error',
        file: currentFile(stack, projectFiles),
        line: null,
        message: `Acesso bloqueado a "${blocked[2]}": o documento só pode ${blocked[1] === 'reading from' ? 'ler' : 'gravar'} arquivos do próprio projeto.`,
        raw: text.trim(),
        source: 'latex',
      });
      continue;
    }

    if (/^(?:No pages of output\.|warning\s+\(pdf backend\): no pages of output\.)/i.test(text.trim())) {
      out.push({
        severity: 'error',
        file: null,
        line: null,
        message: 'O documento não gerou nenhuma página. Ele tem algum conteúdo entre \\begin{document} e \\end{document}?',
        raw: text.trim(),
        source: 'latex',
      });
      continue;
    }

    if (/^runsystem\(.*\)\.\.\.disabled/.test(text)) {
      out.push({
        severity: 'warning',
        file: currentFile(stack, projectFiles),
        line: null,
        message: 'O documento tentou executar um comando do sistema (shell-escape), o que é desativado por segurança.',
        raw: text.trim(),
        source: 'latex',
      });
      continue;
    }

    trackFiles(text, stack);
  }
  return out;
}

export function parseBibtexLog(blg: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = blg.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    let m: RegExpMatchArray | null;
    if ((m = text.match(/^I couldn't open database file (.+)$/))) {
      out.push({ severity: 'error', file: null, line: null, message: `Arquivo de bibliografia "${m[1]}" não encontrado no projeto.`, raw: text, source: 'bibtex' });
    } else if ((m = text.match(/^I couldn't open style file (.+)$/))) {
      out.push({ severity: 'error', file: null, line: null, message: `Estilo de bibliografia "${m[1]}" não encontrado.`, raw: text, source: 'bibtex' });
    } else if ((m = text.match(/^Warning--I didn't find a database entry for "([^"]+)"/))) {
      out.push({ severity: 'warning', file: null, line: null, message: `A citação "${m[1]}" não existe nos arquivos .bib.`, raw: text, source: 'bibtex' });
    } else if ((m = text.match(/^Warning--(.+)$/))) {
      const where = lines[i + 1]?.match(/^--line (\d+) of file (.+)$/);
      out.push({
        severity: 'warning',
        file: where ? cleanPath(where[2]!) : null,
        line: where ? Number(where[1]) : null,
        message: `Aviso do BibTeX: ${m[1]}`,
        raw: text,
        source: 'bibtex',
      });
    } else if ((m = text.match(/^(.*)---line (\d+) of file (.+)$/))) {
      const message = m[1]!.trim() || lines[i - 1]?.trim() || 'erro de sintaxe';
      out.push({
        severity: 'error',
        file: cleanPath(m[3]!),
        line: Number(m[2]),
        message: `Erro no arquivo de bibliografia "${cleanPath(m[3]!)}" na linha ${m[2]}: ${message}`,
        raw: text,
        source: 'bibtex',
      });
    }
  }
  return out;
}

export function parseBiberLog(blg: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const text of blg.split(/\r?\n/)) {
    const m = text.match(/^\[\d+\]\s+\S+?>\s+(ERROR|WARN)\s+-\s+(.*)$/);
    if (!m) continue;
    const raw = m[2]!.trim();
    const severity: Severity = m[1] === 'ERROR' ? 'error' : 'warning';
    const lineMatch = raw.match(/, line (\d+),/);
    const bibFile = raw.match(/([^\s/]+\.bib)(?:_\d+\.utf8)?/)?.[1] ?? null;
    let message = raw;
    let mm: RegExpMatchArray | null;
    if ((mm = raw.match(/Cannot find '([^']+)'/)) || (mm = raw.match(/Cannot find (\S+)!/))) {
      message = `Arquivo de bibliografia "${mm[1]}" não encontrado no projeto.`;
    } else if ((mm = raw.match(/I didn't find a database entry for '([^']+)'/))) {
      message = `A citação "${mm[1]}" não existe nos arquivos .bib.`;
    } else if (/syntax error/i.test(raw)) {
      message = `Erro de sintaxe na bibliografia${bibFile ? ` "${bibFile}"` : ''}${lineMatch ? ` na linha ${lineMatch[1]}` : ''}: ${raw.replace(/^.*syntax error:\s*/i, '')}`;
    } else {
      message = `${severity === 'error' ? 'Erro' : 'Aviso'} do Biber: ${raw}`;
    }
    out.push({
      severity,
      file: bibFile,
      line: lineMatch ? Number(lineMatch[1]) : null,
      message,
      raw,
      source: 'biber',
    });
  }
  return out;
}

/** Remove repetidos (o mesmo aviso em várias passagens) e limita a quantidade. */
export function finalizeDiagnostics(all: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  // "Emergency stop" só acrescenta ruído quando já há um erro explicado.
  const hasRealError = all.some((d) => d.severity === 'error' && !/^Emergency stop/.test(d.raw));
  for (const d of all) {
    if (hasRealError && /^Emergency stop|^==> Fatal error occurred/.test(d.raw)) continue;
    const key = `${d.severity}|${d.file}|${d.line}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity]);
  return out.slice(0, MAX_DIAGNOSTICS);
}
