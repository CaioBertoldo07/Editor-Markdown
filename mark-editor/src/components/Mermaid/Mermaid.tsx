import { useEffect, useState } from 'react';
import { useTheme } from '../../context/ThemeContext';
import { useDebounce } from '../../hooks/useDebounce';
import './Mermaid.css';

type MermaidApi = typeof import('mermaid').default;

/**
 * O mermaid é pesado (algumas centenas de KB), então ele entra por import
 * dinâmico: só baixa no primeiro documento que realmente tiver um diagrama.
 * A promise fica em módulo pra todos os diagramas da página compartilharem
 * o mesmo download.
 */
let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => mod.default);
  }
  return mermaidPromise;
}

// Cada render precisa de um id único: o mermaid usa isso nos ids internos do SVG.
let diagramCount = 0;

interface MermaidProps {
  chart: string;
}

const Mermaid: React.FC<MermaidProps> = ({ chart }) => {
  const { theme } = useTheme();
  // Enquanto o usuário digita o diagrama fica quebrado quase o tempo todo;
  // esperar a digitação parar evita rodar o parser a cada tecla.
  const source = useDebounce(chart.trim(), 300);
  // `svg` guarda o último desenho válido: em caso de erro ele não é
  // sobrescrito, então o diagrama continua na tela em vez de piscar vazio
  // quando uma edição no meio do caminho deixa a sintaxe inválida.
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!source) return;

    loadMermaid()
      .then(async (mermaid) => {
        // O mermaid pinta o fundo dos rótulos de seta com uma cor fixa, que
        // destoa no tema escuro. Puxar do CSS mantém tudo em sincronia com o
        // tema do app, inclusive se as variáveis mudarem depois.
        const css = getComputedStyle(document.documentElement);
        const bgMain = css.getPropertyValue('--bg-main').trim();

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'dark' ? 'dark' : 'default',
          fontFamily: 'inherit',
          themeVariables: bgMain ? { edgeLabelBackground: bgMain } : undefined,
        });

        // parse() antes de render(): com sintaxe inválida o render() do mermaid
        // além de lançar erro injeta um SVG de erro solto no body da página.
        const isValid = await mermaid.parse(source, { suppressErrors: true });
        if (cancelled) return;

        if (!isValid) {
          setFailed(true);
          return;
        }

        diagramCount += 1;
        const { svg: rendered } = await mermaid.render(`mermaid-${diagramCount}`, source);
        if (cancelled) return;

        setSvg(rendered);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [source, theme]);

  // Bloco ```mermaid vazio: nada a desenhar.
  if (!source) return null;

  // Falhou e não há nada válido pra mostrar: cai pro código cru, que é mais
  // útil que um espaço em branco.
  if (failed && !svg) {
    return (
      <div className="mermaid-error">
        <span className="mermaid-error-title">Diagrama com sintaxe inválida</span>
        <pre>
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return <div className="mermaid-loading">Carregando diagrama…</div>;
  }

  return (
    <div
      className={`mermaid-diagram${failed ? ' mermaid-diagram-stale' : ''}`}
      // O mermaid roda com securityLevel 'strict', que sanitiza o SVG gerado.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
};

export default Mermaid;
