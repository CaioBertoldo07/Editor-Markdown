import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { readProjectFiles, readProjectZip, splitLatexUploads, LIMITS } from './projectImport';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const MAIN = '\\documentclass{article}\n\\begin{document}\nOi\n\\end{document}\n';

async function zipOf(build: (zip: JSZip) => void, compression: 'STORE' | 'DEFLATE' = 'DEFLATE'): Promise<Blob> {
  const zip = new JSZip();
  build(zip);
  const data = await zip.generateAsync({ type: 'uint8array', compression, platform: 'UNIX' });
  return new Blob([data as Uint8Array<ArrayBuffer>]);
}

describe('importação de projeto ZIP', () => {
  it('preserva a estrutura, tira a pasta raiz e acha o main.tex', async () => {
    const blob = await zipOf((z) => {
      z.file('Meu Projeto/main.tex', MAIN);
      z.file('Meu Projeto/capitulos/introducao.tex', 'Intro');
      z.file('Meu Projeto/referencias.bib', '@misc{a, title={A}}');
      z.file('Meu Projeto/imagens/arquitetura.png', PNG);
      z.file('Meu Projeto/estilos/configuracao.sty', '\\ProvidesPackage{x}');
    });
    const result = await readProjectZip(blob);
    expect(result.files.map((f) => f.path).sort()).toEqual([
      'capitulos/introducao.tex',
      'estilos/configuracao.sty',
      'imagens/arquitetura.png',
      'main.tex',
      'referencias.bib',
    ]);
    expect(result.mainFile).toBe('main.tex');
    expect(result.skipped).toEqual([]);
  });

  it('sugere o principal quando não se chama main.tex e lista os candidatos', async () => {
    const blob = await zipOf((z) => {
      z.file('tese.tex', MAIN);
      z.file('rascunho/teste.tex', MAIN);
      z.file('cap1.tex', '\\chapter{Um}');
    });
    const result = await readProjectZip(blob);
    expect(result.mainFile).toBe('tese.tex');
    expect(result.mainCandidates).toEqual(['tese.tex', 'rascunho/teste.tex']);
  });

  it('recusa path traversal e caminhos absolutos sem renomear', async () => {
    const blob = await zipOf((z) => {
      z.file('main.tex', MAIN);
      z.file('../fora.tex', 'x');
      z.file('a/../../fora2.tex', 'x');
      z.file('/etc/passwd.tex', 'x');
    });
    const result = await readProjectZip(blob);
    expect(result.files.map((f) => f.path)).toEqual(['main.tex']);
    expect(result.skipped.length).toBe(3);
  });

  it('ignora links simbólicos', async () => {
    const blob = await zipOf((z) => {
      z.file('main.tex', MAIN);
      z.file('link.tex', '/etc/passwd', { unixPermissions: 0o120777 });
    });
    const result = await readProjectZip(blob);
    expect(result.files.map((f) => f.path)).toEqual(['main.tex']);
    expect(result.skipped).toEqual([{ name: 'link.tex', reason: 'links simbólicos não são importados' }]);
  });

  it('recusa configs perigosas, ocultos, executáveis e arquivos gerados', async () => {
    const blob = await zipOf((z) => {
      z.file('main.tex', MAIN);
      z.file('latexmkrc', 'system("rm -rf /")');
      z.file('.latexmkrc', 'x');
      z.file('biber.conf', 'x');
      z.file('script.sh', 'x');
      z.file('main.aux', 'x');
      z.file('__MACOSX/._main.tex', 'x');
    });
    const result = await readProjectZip(blob);
    expect(result.files.map((f) => f.path)).toEqual(['main.tex']);
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.name, s.reason]));
    expect(reasons['latexmkrc']).toMatch(/segurança/);
    expect(reasons['.latexmkrc']).toMatch(/ocultos/);
    expect(reasons['script.sh']).toMatch(/não são aceitos/);
    expect(reasons['main.aux']).toMatch(/gerado pela compilação/);
    expect(reasons['__MACOSX/._main.tex']).toBeUndefined();
  });

  it('ZIP bomb por taxa de compressão é cancelada', async () => {
    const blob = await zipOf((z) => {
      z.file('main.tex', MAIN);
      z.file('figura.png', new Uint8Array(3 * 1024 * 1024)); // zeros comprimem ~1000:1
    });
    await expect(readProjectZip(blob)).rejects.toThrow(/compressão anormal/);
  });

  it('ZIP com tamanho declarado falso para de descompactar no limite', async () => {
    const big = new Uint8Array(LIMITS.binaryMaxBytes + 1024);
    big.set(PNG);
    for (let i = PNG.length; i < big.length; i++) big[i] = (i * 7919) % 251; // pouco compressível
    const zip = new JSZip();
    zip.file('main.tex', MAIN);
    zip.file('img.png', big);
    const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    // Adultera o tamanho descompactado (cabeçalho local e diretório central) para 100 bytes.
    const view = new DataView(data.buffer);
    for (let i = 0; i < data.length - 4; i++) {
      const sig = view.getUint32(i, true);
      if (sig === 0x04034b50 && new TextDecoder().decode(data.subarray(i + 30, i + 37)) === 'img.png') view.setUint32(i + 22, 100, true);
      if (sig === 0x02014b50 && new TextDecoder().decode(data.subarray(i + 46, i + 53)) === 'img.png') view.setUint32(i + 24, 100, true);
    }
    // O JSZip pode recusar já na abertura (tamanhos inconsistentes) ou nós no limite
    // de descompactação; nos dois casos nada é importado.
    await expect(readProjectZip(new Blob([data as Uint8Array<ArrayBuffer>]))).rejects.toThrow(/malicioso|Não foi possível abrir/);
  });

  it('limita a quantidade de arquivos', async () => {
    const blob = await zipOf((z) => {
      z.file('main.tex', MAIN);
      for (let i = 0; i < LIMITS.maxFiles + 5; i++) z.file(`cap/c${i}.tex`, 'x');
    });
    await expect(readProjectZip(blob)).rejects.toThrow(/300 arquivos/);
  });

  it('pula texto fora de UTF-8 e recusa ZIP sem .tex ou corrompido', async () => {
    const latin1 = await zipOf((z) => {
      z.file('main.tex', MAIN);
      z.file('acentos.tex', new Uint8Array([0x63, 0xe7, 0xe3, 0x6f])); // "ção" em Latin-1
    });
    const result = await readProjectZip(latin1);
    expect(result.skipped[0]!.reason).toMatch(/UTF-8/);
    await expect(readProjectZip(await zipOf((z) => z.file('a.png', PNG)))).rejects.toThrow(/nenhum arquivo .tex/);
    await expect(readProjectZip(new Blob(['não é zip']))).rejects.toThrow(/Não foi possível abrir/);
  });
});

describe('arquivos soltos', () => {
  it('agrupa .tex, .bib e imagens num projeto', async () => {
    const files = [new File([MAIN], 'artigo.tex'), new File(['@misc{a}'], 'refs.bib'), new File([PNG], 'fig.png')];
    const result = await readProjectFiles(files);
    expect(result.files.map((f) => f.path)).toEqual(['artigo.tex', 'refs.bib', 'fig.png']);
    expect(result.mainFile).toBe('artigo.tex');
  });

  it('separa o que é LaTeX do que é Markdown', () => {
    const md = new File(['# a'], 'nota.md');
    const tex = new File([MAIN], 'a.tex');
    const png = new File([PNG], 'fig.png');
    const zip = new File(['x'], 'proj.zip');
    expect(splitLatexUploads([md, tex, png, zip])).toEqual({ zips: [zip], latex: [tex, png], others: [md] });
    // Imagem sozinha não vira projeto LaTeX.
    expect(splitLatexUploads([md, png]).latex).toEqual([]);
  });
});
