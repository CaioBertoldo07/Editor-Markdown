import { describe, expect, it } from 'vitest';
import { finalizeDiagnostics, parseBiberLog, parseBibtexLog, parseTexLog } from '../src/logParser.js';

const files = new Set(['main.tex', 'capitulos/intro.tex', 'refs.bib']);

describe('log do TeX', () => {
  it('erro de comando indefinido com arquivo, linha e comando', () => {
    const log = [
      'This is pdfTeX, Version 3.141592653-2.6-1.40.26',
      '(./main.tex',
      'LaTeX2e <2024-11-01>',
      '(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls',
      'Document Class: article 2024/06/29 v1.4n Standard LaTeX document class',
      ')',
      './main.tex:24: Undefined control sequence.',
      'l.24 Texto com \\comandoinexistente',
      '                                  {}',
      ')',
    ].join('\n');
    const [d] = parseTexLog(log, files);
    expect(d).toMatchObject({ severity: 'error', file: 'main.tex', line: 24 });
    expect(d!.message).toContain('Comando LaTeX não reconhecido (\\comandoinexistente) na linha 24');
    expect(d!.raw).toContain('Undefined control sequence');
  });

  it('erro em arquivo incluído', () => {
    const log = ['(./main.tex', '(./capitulos/intro.tex', './capitulos/intro.tex:3: Missing $ inserted.', 'l.3 a^', '2'].join('\n');
    const [d] = parseTexLog(log, files);
    expect(d).toMatchObject({ file: 'capitulos/intro.tex', line: 3 });
    expect(d!.message).toContain('modo matemático');
  });

  it('pacote ausente', () => {
    const log = ['(./main.tex', './main.tex:3: LaTeX Error: File `naoexiste.sty\' not found.', '', 'l.3 \\usepackage{naoexiste}'].join('\n');
    const [d] = parseTexLog(log, files);
    expect(d!.message).toContain('pacote ou classe "naoexiste.sty" não está disponível');
    expect(d!.line).toBe(3);
  });

  it('ambiente fechado errado', () => {
    const log = './main.tex:9: LaTeX Error: \\begin{itemize} on input line 5 ended by \\end{enumerate}.';
    const [d] = parseTexLog(log, files);
    expect(d!.message).toBe('O ambiente "itemize" aberto na linha 5 foi fechado com \\end{enumerate} na linha 9.');
  });

  it('erro sem -file-line-error usa a pilha de arquivos e o l.N', () => {
    const log = ['(./main.tex (./capitulos/intro.tex', '! Too many }\'s.', 'l.7 }', ''].join('\n');
    const [d] = parseTexLog(log, files);
    expect(d).toMatchObject({ file: 'capitulos/intro.tex', line: 7, severity: 'error' });
  });

  it('avisos de referência, citação e rótulo repetido', () => {
    const log = [
      '(./main.tex',
      "LaTeX Warning: Reference `fig:x' on page 1 undefined on input line 12.",
      "LaTeX Warning: Citation `knuth84' on page 1 undefined on input line 15.",
      "LaTeX Warning: Label `sec:a' multiply defined.",
      'LaTeX Warning: There were undefined references.',
    ].join('\n');
    const ds = parseTexLog(log, files);
    expect(ds.map((d) => d.severity)).toEqual(['warning', 'warning', 'warning', 'warning']);
    expect(ds[0]!.message).toContain('Referência "fig:x" não definida na linha 12');
    expect(ds[1]!.message).toContain('Citação "knuth84"');
    expect(ds[2]!.message).toContain('"sec:a" foi definido mais de uma vez');
  });

  it('aviso de pacote com continuação', () => {
    const log = [
      '(./main.tex',
      'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
      '(hyperref)                removing `math shift\' on input line 20.',
    ].join('\n');
    const [d] = parseTexLog(log, files);
    expect(d!.message).toContain('Aviso do pacote hyperref na linha 20');
    expect(d!.line).toBe(20);
  });

  it('caixas cheias viram informação', () => {
    const log = '(./main.tex\nOverfull \\hbox (12.3pt too wide) in paragraph at lines 30--31';
    const [d] = parseTexLog(log, files);
    expect(d).toMatchObject({ severity: 'info', line: 30, file: 'main.tex' });
    expect(d!.message).toContain('ultrapassa a margem');
  });

  it('acesso bloqueado pelo kpathsea e shell-escape', () => {
    const ds = parseTexLog(
      ['(./main.tex', 'pdflatex: Not reading from /etc/passwd (openin_any = p).', 'runsystem(touch x)...disabled.'].join('\n'),
      files
    );
    expect(ds[0]!.message).toContain('Acesso bloqueado a "/etc/passwd"');
    expect(ds[1]!.message).toContain('shell-escape');
  });

  it('documento sem páginas', () => {
    const [a] = parseTexLog('(./main.tex)\nNo pages of output.', files);
    const [b] = parseTexLog('warning  (pdf backend): no pages of output.', files);
    expect(a!.message).toContain('não gerou nenhuma página');
    expect(b!.severity).toBe('error');
  });

  it('fontspec no pdflatex sugere o XeLaTeX', () => {
    const log = '(./main.tex\n! Fatal Package fontspec Error: The fontspec package requires either XeTeX or LuaTeX.\n';
    const [d] = parseTexLog(log, files);
    expect(d!.message).toContain('XeLaTeX');
  });
});

describe('logs de bibliografia', () => {
  it('BibTeX', () => {
    const ds = parseBibtexLog(
      [
        'I couldn\'t open database file faltando.bib',
        'Warning--I didn\'t find a database entry for "semcitacao"',
        "I was expecting a `,' or a `}'---line 5 of file refs.bib",
      ].join('\n')
    );
    expect(ds[0]!.message).toContain('"faltando.bib" não encontrado');
    expect(ds[1]).toMatchObject({ severity: 'warning' });
    expect(ds[2]).toMatchObject({ severity: 'error', file: 'refs.bib', line: 5 });
  });

  it('Biber', () => {
    const ds = parseBiberLog(
      [
        "[101] Utils.pm:410> WARN - I didn't find a database entry for 'naoexiste' (section 0)",
        '[102] Biber.pm:131> ERROR - BibTeX subsystem: refs.bib_1234.utf8, line 4, syntax error: found "}", expected end of entry',
        '[103] Biber.pm:131> INFO - Done',
      ].join('\n')
    );
    expect(ds).toHaveLength(2);
    expect(ds[0]!.message).toContain('"naoexiste" não existe');
    expect(ds[1]).toMatchObject({ severity: 'error', file: 'refs.bib', line: 4 });
  });
});

describe('finalização', () => {
  it('remove repetidos, o "Emergency stop" redundante e ordena por gravidade', () => {
    const base = { file: 'main.tex', line: 1, source: 'latex' as const };
    const ds = finalizeDiagnostics([
      { ...base, severity: 'info', message: 'i', raw: 'i' },
      { ...base, severity: 'warning', message: 'w', raw: 'w' },
      { ...base, severity: 'warning', message: 'w', raw: 'w' },
      { ...base, severity: 'error', message: 'e', raw: 'Undefined control sequence.' },
      { ...base, severity: 'error', message: 'stop', raw: 'Emergency stop.' },
    ]);
    expect(ds.map((d) => d.message)).toEqual(['e', 'w', 'i']);
  });
});
