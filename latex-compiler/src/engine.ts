export type Engine = 'pdflatex' | 'xelatex' | 'lualatex';
export const ENGINES: readonly Engine[] = ['pdflatex', 'xelatex', 'lualatex'];

/** Opção do latexmk para cada motor. */
export const LATEXMK_FLAG: Record<Engine, string> = {
  pdflatex: '-pdf',
  xelatex: '-pdfxe',
  lualatex: '-pdflua',
};

/**
 * Escolhe o motor do documento principal:
 * 1. comentário mágico nas primeiras linhas (`% !TEX program = xelatex`,
 *    o mesmo do TeXShop/TeXstudio/VS Code);
 * 2. pacotes que só funcionam em XeLaTeX/LuaLaTeX (fontspec, unicode-math,
 *    polyglossia) => xelatex;
 * 3. pdflatex.
 */
export function detectEngine(mainSource: string): { engine: Engine; source: 'magic-comment' | 'packages' | 'default' } {
  const head = mainSource.split('\n', 30).join('\n');
  const magic = head.match(/^\s*%\s*!\s*TeX\s+(?:TS-)?program\s*=\s*([A-Za-z]+)/im);
  if (magic) {
    const name = magic[1]!.toLowerCase();
    if ((ENGINES as readonly string[]).includes(name)) return { engine: name as Engine, source: 'magic-comment' };
  }
  const withoutComments = mainSource.replace(/(^|[^\\])%.*$/gm, '$1');
  if (/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(?:fontspec|unicode-math|polyglossia)\b[^}]*\}/.test(withoutComments)) {
    return { engine: 'xelatex', source: 'packages' };
  }
  return { engine: 'pdflatex', source: 'default' };
}
