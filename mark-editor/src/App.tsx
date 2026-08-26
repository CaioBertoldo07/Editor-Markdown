import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { DocumentsProvider } from './context/DocumentsContext';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import SyncError from './components/SyncError/SyncError';
import FullScreenLoader from './components/FullScreenLoader/FullScreenLoader';
import Home from './pages/Home';
import Login from './pages/Login';
import EditorPage from './pages/EditorPage';
import './styles/global.css';

/** Rotas do app: só montam depois que a sessão foi verificada */
const AppRoutes = () => {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <FullScreenLoader message="Verificando sua sessão..." />;
  }

  if (!user) {
    return <Login />;
  }

  return (
    <DocumentsProvider>
      <SyncError />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/doc/:id" element={<EditorPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </DocumentsProvider>
  );
};

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
