import './FullScreenLoader.css';

interface FullScreenLoaderProps {
  message?: string;
}

const FullScreenLoader: React.FC<FullScreenLoaderProps> = ({ message = 'Carregando...' }) => (
  <div className="fullscreen-loader">
    <div className="fullscreen-loader-spinner"></div>
    <p>{message}</p>
  </div>
);

export default FullScreenLoader;
