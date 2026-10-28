/**
 * Integração com o TeX REAL. Roda só dentro da imagem (estágio `test` do
 * Dockerfile), como root, com o sandbox-exec instalado:
 *
 *   docker build --target test -t latex-compiler-test latex-compiler
 *   docker run --rm -e LATEX_INTEGRATION=1 latex-compiler-test
 */
import { crc32, deflateSync } from 'node:zlib';
import { readdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { compileProject, type ProjectFile } from '../src/compile.js';
import { loadConfig, type Config } from '../src/config.js';
import { sandboxSelfTest, type SelfTest } from '../src/sandbox.js';
import { SlotPool } from '../src/slots.js';

const enabled = process.env.LATEX_INTEGRATION === '1';
const TOKEN = 'token-de-teste-com-mais-de-32-caracteres-0000';

const enc = new TextEncoder();
const text = (path: string, content: string): ProjectFile => ({ path, data: enc.encode(content) });

/** PNG RGB válido, gerado aqui (sem arquivo binário no repositório). */
function png(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
}

/** O PDF usa object streams (compactados); o TeX informa as páginas no log. */
const pageCount = (log: string) => Number(log.match(/Output written on \S+ \((\d+) pages?/)?.[1] ?? 0);

let config: Config;
let selfTest: SelfTest;

const compile = (files: ProjectFile[], mainFile = 'main.tex', overrides: Partial<Config['limits']> = {}, signal = new AbortController().signal) =>
  compileProject({ ...config, limits: { ...config.limits, ...overrides } }, 1, { mainFile, files }, signal);

const article = (body: string, preamble = '') =>
  `\\documentclass{article}\n\\usepackage[T1]{fontenc}\n\\usepackage[utf8]{inputenc}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;

describe.skipIf(!enabled)('compilação real com TeX Live', () => {
  beforeAll(async () => {
    config = loadConfig({ COMPILER_TOKEN: TOKEN, JOBS_DIR: '/var/lib/latex-jobs', COMPILE_TIMEOUT_MS: '90000' });
    selfTest = await sandboxSelfTest(config);
  });

  afterAll(async () => {
    // Nenhum diretório temporário pode sobrar.
    expect((await readdir(config.jobsDir)).filter((n) => n.startsWith('job-'))).toEqual([]);
  });

  it('o sandbox passa no autoteste (UID, sem rede, sem ambiente do serviço, kpathsea)', () => {
    expect(selfTest.checks.filter((c) => !c.ok)).toEqual([]);
    expect(selfTest.ok).toBe(true);
  });

  it('compila um documento simples em PDF real', async () => {
    const r = await compile([text('main.tex', article('Olá, mundo! Acentuação: ção, ã, é.', '\\usepackage[brazil]{babel}'))]);
    expect(r.status).toBe('success');
    expect(r.pdf!.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(r.log)).toBe(1);
    expect(r.engine).toBe('pdflatex');
  });

  it('fórmulas matemáticas (amsmath)', async () => {
    const body = String.raw`
\begin{equation}\label{eq:euler} e^{i\pi} + 1 = 0 \end{equation}
\begin{align} \int_0^\infty e^{-x^2}\,dx &= \frac{\sqrt{\pi}}{2} \\ \sum_{n=1}^\infty \frac{1}{n^2} &= \frac{\pi^2}{6} \end{align}
Inline $\mathbb{R}^n$ e $\binom{n}{k}$. Ver \eqref{eq:euler}.`;
    const r = await compile([text('main.tex', article(body, '\\usepackage{amsmath,amssymb}'))]);
    expect(r.status).toBe('success');
  });

  it('tabelas (tabular, booktabs, multirow)', async () => {
    const body = String.raw`
\begin{table}[h]\centering
\begin{tabular}{lcr}\toprule
\multirow{2}{*}{Item} & A & B \\ & 1 & 2 \\ \midrule
x & y & z \\ \bottomrule
\end{tabular}\caption{Tabela}\label{tab:a}\end{table}
Tabela~\ref{tab:a}.`;
    const r = await compile([text('main.tex', article(body, '\\usepackage{booktabs,multirow}'))]);
    expect(r.status).toBe('success');
  });

  it('imagens (graphicx com PNG em subpasta)', async () => {
    const body = String.raw`\begin{figure}[h]\centering\includegraphics[width=3cm]{imagens/arquitetura.png}\caption{Arquitetura}\end{figure}`;
    const r = await compile([
      text('main.tex', article(body, '\\usepackage{graphicx}')),
      { path: 'imagens/arquitetura.png', data: png(40, 20, [59, 130, 246]) },
    ]);
    expect(r.status).toBe('success');
    expect(r.pdf!.toString('latin1')).toContain('/Subtype /Image');
  });

  it('referências cruzadas e sumário (várias passagens)', async () => {
    const body = String.raw`\tableofcontents
\section{Introdução}\label{sec:intro} Ver Seção~\ref{sec:met} na página~\pageref{sec:met}.
\section{Metodologia}\label{sec:met} Voltar à Seção~\ref{sec:intro}.`;
    const r = await compile([text('main.tex', article(body))]);
    expect(r.status).toBe('success');
    expect(r.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(r.log).not.toMatch(/undefined references/);
  });

  it('bibliografia com BibTeX (natbib)', async () => {
    const bib = '@book{knuth1984,\n  author = {Donald E. Knuth},\n  title = {The {\\TeX}book},\n  publisher = {Addison-Wesley},\n  year = {1984}\n}\n';
    const body = 'Como em \\citet{knuth1984}.\n\\bibliographystyle{plainnat}\n\\bibliography{referencias}';
    const r = await compile([text('main.tex', article(body, '\\usepackage{natbib}')), text('referencias.bib', bib)]);
    expect(r.status).toBe('success');
    expect(r.output).toMatch(/bibtex/i);
    expect(r.diagnostics.filter((d) => d.severity === 'warning')).toEqual([]);
  });

  it('bibliografia com biblatex + Biber', async () => {
    const bib = '@article{silva2020,\n  author = {Silva, Ana},\n  title = {Um estudo},\n  journaltitle = {Revista},\n  date = {2020}\n}\n';
    const body = 'Segundo \\textcite{silva2020}.\n\\printbibliography';
    const r = await compile([
      text('main.tex', article(body, '\\usepackage[brazil]{babel}\n\\usepackage{csquotes}\n\\usepackage[backend=biber,style=authoryear]{biblatex}\n\\addbibresource{referencias.bib}')),
      text('referencias.bib', bib),
    ]);
    expect(r.status).toBe('success');
    expect(r.output).toMatch(/biber/i);
    expect(r.diagnostics.filter((d) => d.severity === 'warning')).toEqual([]);
  });

  it('projeto com vários arquivos (\\input, \\include, .sty próprio)', async () => {
    const main = String.raw`\documentclass{report}
\usepackage{estilos/configuracao}
\begin{document}
\include{capitulos/introducao}
\include{capitulos/metodologia}
\end{document}
`;
    const r = await compile([
      text('main.tex', main),
      text('estilos/configuracao.sty', '\\ProvidesPackage{estilos/configuracao}\n\\newcommand{\\projeto}{Meu Projeto}\n'),
      text('capitulos/introducao.tex', '\\chapter{Introdução}\\label{cap:intro}\nSobre o \\projeto. Ver Capítulo~\\ref{cap:met}.\n'),
      text('capitulos/metodologia.tex', '\\chapter{Metodologia}\\label{cap:met}\n\\input{capitulos/trecho}\n'),
      text('capitulos/trecho.tex', 'Texto incluído com input.\n'),
    ]);
    expect(r.status).toBe('success');
    expect(pageCount(r.log)).toBeGreaterThanOrEqual(2);
  });

  it('XeLaTeX pelo comentário mágico, com fontspec', async () => {
    const main = '% !TEX program = xelatex\n\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\nUnicode direto: ação, π, “aspas”.\n\\end{document}\n';
    const r = await compile([text('main.tex', main)]);
    expect(r.engine).toBe('xelatex');
    expect(r.status).toBe('success');
  });

  it('LuaLaTeX pelo comentário mágico', async () => {
    const main = '% !TEX program = lualatex\n\\documentclass{article}\n\\begin{document}\nLua: \\directlua{tex.print(1+2)}\n\\end{document}\n';
    const r = await compile([text('main.tex', main)]);
    expect(r.engine).toBe('lualatex');
    expect(r.status).toBe('success');
  });

  it('erro de compilação aponta arquivo e linha, sem PDF', async () => {
    const main = '\\documentclass{article}\n\\begin{document}\nlinha 3\n\\comandoquenaoexiste\n\\end{document}\n';
    const r = await compile([text('main.tex', main)]);
    expect(r.status).toBe('error');
    expect(r.pdf).toBeNull();
    const err = r.diagnostics.find((d) => d.severity === 'error')!;
    expect(err).toMatchObject({ file: 'main.tex', line: 4 });
    expect(err.message).toContain('Comando LaTeX não reconhecido (\\comandoquenaoexiste) na linha 4');
    expect(r.log).toContain('Undefined control sequence');
    expect(r.log).not.toContain('/var/lib/latex-jobs');
  });

  it('erro dentro de um capítulo incluído', async () => {
    const r = await compile([
      text('main.tex', '\\documentclass{article}\n\\begin{document}\n\\input{capitulos/intro}\n\\end{document}\n'),
      text('capitulos/intro.tex', 'ok\n\nx^2\n'),
    ]);
    expect(r.status).toBe('error');
    expect(r.diagnostics[0]).toMatchObject({ file: 'capitulos/intro.tex', line: 3 });
  });

  it('pacote inexistente', async () => {
    const r = await compile([text('main.tex', article('x', '\\usepackage{pacotequenaoexiste}'))]);
    expect(r.status).toBe('error');
    expect(r.diagnostics[0]!.message).toContain('"pacotequenaoexiste.sty" não está disponível');
  });

  it('compilação travada é encerrada no tempo limite', async () => {
    const started = Date.now();
    const r = await compile([text('main.tex', '\\documentclass{article}\n\\def\\x{\\x}\n\\begin{document}\\x\\end{document}\n')], 'main.tex', {
      timeoutMs: 5_000,
    });
    expect(r.status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.diagnostics[0]!.message).toContain('tempo limite');
  });

  it('cancelamento mata a compilação em andamento', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_500);
    const started = Date.now();
    const r = await compile([text('main.tex', '\\documentclass{article}\n\\def\\x{\\x}\n\\begin{document}\\x\\end{document}\n')], 'main.tex', {}, controller.signal);
    expect(r.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('saída gigante é cortada pelo limite de disco', async () => {
    const main = String.raw`\documentclass{article}
\newwrite\f\immediate\openout\f=grande.txt
\def\linha{xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx}
\begin{document}\loop\immediate\write\f{\linha\linha\linha\linha\linha\linha\linha\linha}\iftrue\repeat\end{document}
`;
    const r = await compile([text('main.tex', main)], 'main.tex', { jobDiskBytes: 8 * 1024 * 1024, timeoutMs: 60_000 });
    expect(['too_large', 'error']).toContain(r.status);
    expect(r.pdf).toBeNull();
  });

  describe('segurança', () => {
    it('não lê arquivos fora do projeto (\\input{/etc/passwd})', async () => {
      const r = await compile([text('main.tex', article('\\input{/etc/passwd}'))]);
      expect(r.status).toBe('error');
      expect(r.log).not.toContain('root:x:0:0');
      expect(r.diagnostics.some((d) => /bloqueado|não encontrado/.test(d.message))).toBe(true);
    });

    it('não lê ../ (fora do diretório da compilação)', async () => {
      const r = await compile([text('main.tex', article('\\input{../../../etc/hostname}'))]);
      expect(r.status).toBe('error');
    });

    it('\\write18 não executa comandos', async () => {
      const r = await compile([
        text('main.tex', article('\\immediate\\write18{touch PWNED}\\IfFileExists{PWNED}{\\typeout{RESULTADO:EXECUTOU}}{\\typeout{RESULTADO:SEGURO}}')),
      ]);
      expect(r.log).toContain('RESULTADO:SEGURO');
      expect(r.log).not.toContain('RESULTADO:EXECUTOU');
      expect(r.log).toMatch(/runsystem\(.*\)\.\.\.disabled/);
      expect(r.diagnostics.some((d) => d.message.includes('shell-escape'))).toBe(true);
    });

    it('LuaLaTeX não executa comandos nem abre sockets', async () => {
      const main = String.raw`% !TEX program = lualatex
\documentclass{article}
\begin{document}
\directlua{
  local ok1 = pcall(function() return os.execute("touch PWNED") end)
  local ok2, sock = pcall(require, "socket")
  local net = "sem-rede"
  if ok2 and sock and sock.tcp then
    local c = sock.tcp()
    if c and c:connect("1.1.1.1", 80) then net = "COM-REDE" end
  end
  texio.write_nl("RESULTADO rede=" .. net)
  local env = io.open("/proc/1/environ", "r")
  texio.write_nl("RESULTADO environ=" .. (env and "VAZOU" or "bloqueado"))
  local jobs = io.open("/var/lib/latex-jobs/" .. "segredo-outra-compilacao.txt", "r")
  texio.write_nl("RESULTADO outrojob=" .. (jobs and "VAZOU" or "bloqueado"))
}
\IfFileExists{PWNED}{\typeout{RESULTADO:EXECUTOU}}{\typeout{RESULTADO:SEGURO}}
Página com conteúdo.
\end{document}
`;
      const r = await compile([text('main.tex', main)]);
      expect(r.status).toBe('success');
      expect(r.log).toContain('RESULTADO rede=sem-rede');
      expect(r.log).toContain('RESULTADO environ=bloqueado');
      expect(r.log).toContain('RESULTADO outrojob=bloqueado');
      expect(r.log).toContain('RESULTADO:SEGURO');
      expect(r.log).not.toContain('VAZOU');
    });

    it('uma compilação não lê o diretório de outra em andamento', async () => {
      // Compilação A (slot 2) fica rodando com um arquivo "secreto".
      const controller = new AbortController();
      const slow = compileProject(
        config,
        2,
        {
          mainFile: 'main.tex',
          files: [text('main.tex', '\\documentclass{article}\n\\def\\x{\\x}\n\\begin{document}\\x\\end{document}\n'), text('segredo.txt', 'SEGREDO-DO-USUARIO-A')],
        },
        controller.signal
      );
      await new Promise((r) => setTimeout(r, 800));
      const jobs = (await readdir(config.jobsDir)).filter((n) => n.startsWith('job-'));
      // Compilação B (slot 1, LuaLaTeX = leitura mais permissiva) tenta ler o arquivo de A.
      const probe = jobs.map((j) => `"/var/lib/latex-jobs/${j}/segredo.txt"`).join(',');
      const main = `% !TEX program = lualatex\n\\documentclass{article}\n\\begin{document}\n\\directlua{for _, p in ipairs({${probe}}) do local f = io.open(p, "r"); texio.write_nl("LEITURA " .. (f and f:read("*a") or "negada")) end}\nok\n\\end{document}\n`;
      const r = await compile([text('main.tex', main)]);
      controller.abort();
      await slow;
      expect(jobs.length).toBeGreaterThan(0);
      expect(r.log).toContain('LEITURA negada');
      expect(r.log).not.toContain('SEGREDO-DO-USUARIO-A');
    });

    it('latexmkrc do projeto é recusado antes de compilar', async () => {
      await expect(compile([text('main.tex', article('x')), text('latexmkrc', 'system("touch /tmp/pwned");')])).rejects.toThrow(/latexmkrc/);
    });

    it('caminho com ../ é recusado antes de compilar', async () => {
      await expect(compile([text('main.tex', article('x')), text('../fora.tex', 'x')])).rejects.toThrow(/caminho inválido/);
    });
  });

  describe('HTTP', () => {
    let url: string;
    let close: () => void;

    beforeAll(async () => {
      const app = createApp({ config, pool: new SlotPool(2, 4, 30_000), sandbox: () => selfTest });
      await new Promise<void>((resolve) => {
        const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
          url = `http://127.0.0.1:${info.port}`;
          resolve();
        });
        close = () => server.close();
      });
    });
    afterAll(() => close());

    const form = (files: ProjectFile[], mainFile = 'main.tex') => {
      const body = new FormData();
      body.set('manifest', JSON.stringify({ mainFile, files: files.map((f, i) => ({ path: f.path, field: `f${i}` })) }));
      files.forEach((f, i) => body.set(`f${i}`, new Blob([f.data])));
      return body;
    };

    it('exige o token', async () => {
      const res = await fetch(`${url}/compile`, { method: 'POST', body: form([text('main.tex', article('x'))]) });
      expect(res.status).toBe(401);
      const wrong = await fetch(`${url}/compile`, { method: 'POST', headers: { authorization: 'Bearer errado' }, body: form([]) });
      expect(wrong.status).toBe(401);
    });

    it('compila e devolve resultado + PDF em multipart', async () => {
      const res = await fetch(`${url}/compile`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: form([text('main.tex', article('via HTTP'))]),
      });
      expect(res.status).toBe(200);
      const data = await res.formData();
      const result = JSON.parse(String(data.get('result')));
      expect(result.status).toBe('success');
      const pdf = data.get('pdf') as Blob;
      expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(result.pdfBytes).toBe(pdf.size);
    });

    it('recusa projeto inválido com 400', async () => {
      const res = await fetch(`${url}/compile`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: form([text('main.tex', 'x'), text('.latexmkrc', 'x')]),
      });
      expect(res.status).toBe(400);
    });

    it('fechar a conexão cancela a compilação', async () => {
      const controller = new AbortController();
      const pending = fetch(`${url}/compile`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: form([text('main.tex', '\\documentclass{article}\n\\def\\x{\\x}\n\\begin{document}\\x\\end{document}\n')]),
        signal: controller.signal,
      }).catch(() => null);
      await new Promise((r) => setTimeout(r, 1_500));
      controller.abort();
      await pending;
      // O slot volta a ficar livre logo depois (sem esperar o tempo limite).
      const deadline = Date.now() + 5_000;
      let health: { queue: { free: number } } = { queue: { free: 0 } };
      while (Date.now() < deadline) {
        health = (await (await fetch(`${url}/health`)).json()) as typeof health;
        if (health.queue.free === 2) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(health.queue.free).toBe(2);
    });
  });
});
