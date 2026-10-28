import { describe, expect, it } from 'vitest';
import { fileKindOf, normalizeProjectPath, safeProjectPath } from '../src/paths.js';

describe('caminhos do projeto', () => {
  it('aceita caminhos relativos comuns', () => {
    expect(normalizeProjectPath('main.tex')).toBe('main.tex');
    expect(normalizeProjectPath('capitulos/introdução.tex')).toBe('capitulos/introdução.tex');
    expect(normalizeProjectPath('imagens/Figura 1 (a).png')).toBe('imagens/Figura 1 (a).png');
    expect(normalizeProjectPath('estilos/configuracao.sty')).toBe('estilos/configuracao.sty');
  });

  it('normaliza para NFC', () => {
    const decomposed = 'introduc\u0327a\u0303o.tex';
    expect(normalizeProjectPath(decomposed)).toBe('introdução.tex');
  });

  it.each([
    ['../segredo.tex'],
    ['capitulos/../../x.tex'],
    ['./main.tex'],
    ['/etc/passwd.tex'],
    ['C:/Windows/x.tex'],
    ['c:x.tex'],
    ['capitulos\\intro.tex'],
    ['a//b.tex'],
    ['capitulos/'],
    ['.latexmkrc'],
    ['latexmkrc'],
    ['sub/LATEXMKRC'],
    ['biber.conf'],
    ['texmf.cnf'],
    ['.hidden/x.tex'],
    ['x\u0000.tex'],
    ['x\n.tex'],
    [' main.tex'],
    ['main.tex '],
    ['script.sh'],
    ['main'],
    ['a/b/c/d/e/f/g/h/i.tex'],
    ['x'.repeat(201) + '.tex'],
    ['arquivo<1>.tex'],
    ['arquivo|.tex'],
    [''],
  ])('recusa %j', (input) => {
    expect(safeProjectPath(input)).toBeNull();
  });

  it('classifica texto e binário pela extensão', () => {
    expect(fileKindOf('main.tex')).toBe('text');
    expect(fileKindOf('refs.BIB')).toBe('text');
    expect(fileKindOf('img/logo.PNG')).toBe('binary');
    expect(fileKindOf('fig.pdf')).toBe('binary');
    expect(fileKindOf('virus.exe')).toBeNull();
    expect(fileKindOf('page.html')).toBeNull();
    expect(fileKindOf('image.svg')).toBeNull();
  });
});
