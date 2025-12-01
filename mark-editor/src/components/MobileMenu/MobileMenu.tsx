import './MobileMenu.css';

interface MobileMenuProps {
  isOpen: boolean;
  onToggle: () => void;
}

const MobileMenu: React.FC<MobileMenuProps> = ({ isOpen, onToggle }) => {
  return (
    <button 
      className={`mobile-menu-btn ${isOpen ? 'active' : ''}`}
      onClick={onToggle}
      aria-label="Menu"
    >
      <span></span>
      <span></span>
      <span></span>
    </button>
  );
};

export default MobileMenu;