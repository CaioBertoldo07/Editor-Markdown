import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { DocumentsProvider } from './context/DocumentsContext';
import { ThemeProvider } from './context/ThemeContext';
import Home from './pages/Home';
import EditorPage from './pages/EditorPage';
import './styles/global.css';

function App() {
  return (
    <ThemeProvider>
      <DocumentsProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/doc/:id" element={<EditorPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </DocumentsProvider>
    </ThemeProvider>
  );
}

export default App;