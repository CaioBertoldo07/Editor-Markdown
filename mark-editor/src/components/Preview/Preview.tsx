import ReactMarkdown from 'react-markdown';
import './Preview.css';

interface PreviewProps {
  content: string;
}

const Preview: React.FC<PreviewProps> = ({ content }) => {
  return (
    <div className="preview-container">
      <div className="preview-content">
        {content ? (
          <ReactMarkdown>{content}</ReactMarkdown>
        ) : (
          <div className="preview-empty">
            <p>O preview aparecerá aqui</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Preview;