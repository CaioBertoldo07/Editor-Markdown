import { useState } from 'react';
import DocumentList from '../components/DocumentList/DocumentList';
import ThemeToggle from '../components/ThemeToggle/ThemeToggle';
import MobileMenu from '../components/MobileMenu/MobileMenu';
import UserMenu from '../components/UserMenu/UserMenu';
import AppIcon from '../components/AppIcon/AppIcon';
import { useAuth } from '../context/AuthContext';
import { greetingFor, displayName } from '../utils/greeting';
import './Home.css';

const Home = () => {
  const { user } = useAuth();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const toggleMobileMenu = () => {
    setIsMobileMenuOpen(!isMobileMenuOpen);
  };

  const closeMobileMenu = () => {
    setIsMobileMenuOpen(false);
  };

  return (
    <div className="home-container">
      <DocumentList isOpen={isMobileMenuOpen} onClose={closeMobileMenu} />
      
      <div className="home-content">
        <div className="home-header">
          <MobileMenu isOpen={isMobileMenuOpen} onToggle={toggleMobileMenu} />
          <UserMenu />
          <ThemeToggle />
        </div>
        
        <div className="welcome-message">
          <AppIcon className="welcome-logo" size={96} />
          <p className="welcome-greeting">
            {greetingFor()}, {displayName(user)}!
          </p>
          <h1>Editor Markdown</h1>
          <p>Selecione um documento na lista ou crie um novo para começar</p>
          
          <div className="features">
            <div className="feature">
              <span className="feature-icon">✨</span>
              <h3>Preview em Tempo Real</h3>
              <p>Veja suas alterações instantaneamente</p>
            </div>
            
            <div className="feature">
              <span className="feature-icon">🎨</span>
              <h3>Toolbar de Formatação</h3>
              <p>Formate seu texto facilmente</p>
            </div>
            
            <div className="feature">
              <span className="feature-icon">💾</span>
              <h3>Salvamento Automático</h3>
              <p>Seus documentos são salvos automaticamente</p>
            </div>

            <div className="feature">
              <span className="feature-icon">🌓</span>
              <h3>Tema Claro/Escuro</h3>
              <p>Escolha o tema que preferir</p>
            </div>
          </div>

          <p className="welcome-credit">Feito por Caio Bertoldo</p>
        </div>
      </div>
    </div>
  );
};

export default Home;