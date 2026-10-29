import { describe, expect, it } from 'vitest';
import { detectEngine } from '../src/engine.js';

describe('detecção do motor', () => {
  it('usa pdflatex por padrão', () => {
    expect(detectEngine('\\documentclass{article}\n\\begin{document}x\\end{document}')).toEqual({ engine: 'pdflatex', source: 'default' });
  });
  it('respeita o comentário mágico', () => {
    expect(detectEngine('% !TEX program = lualatex\n\\documentclass{article}').engine).toBe('lualatex');
    expect(detectEngine('%!TeX TS-program = XeLaTeX\n').engine).toBe('xelatex');
  });
  it('ignora motor desconhecido no comentário', () => {
    expect(detectEngine('% !TEX program = sh -c evil\n').engine).toBe('pdflatex');
  });
  it('escolhe xelatex com fontspec, unicode-math ou polyglossia', () => {
    expect(detectEngine('\\usepackage{fontspec}').engine).toBe('xelatex');
    expect(detectEngine('\\usepackage[math-style=ISO]{unicode-math}').engine).toBe('xelatex');
    expect(detectEngine('\\usepackage{amsmath,polyglossia}').source).toBe('packages');
  });
  it('não se engana com pacote comentado', () => {
    expect(detectEngine('% \\usepackage{fontspec}\n').engine).toBe('pdflatex');
  });
});
