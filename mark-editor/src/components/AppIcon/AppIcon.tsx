import { useTheme } from '../../context/ThemeContext';

interface AppIconProps {
  /** Lado do quadrado, em px. */
  size: number;
  className?: string;
}

/**
 * Marca do app. O ícone tem duas versões porque a arte é diferente em cada
 * tema — a escura some no fundo claro e vice-versa.
 */
const AppIcon: React.FC<AppIconProps> = ({ size, className }) => {
  const { theme } = useTheme();

  return (
    <img
      className={className}
      src={theme === 'light' ? '/icon-light.png' : '/icon.png'}
      alt=""
      width={size}
      height={size}
    />
  );
};

export default AppIcon;
