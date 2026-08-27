import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle/ThemeToggle';
import AppIcon from '../components/AppIcon/AppIcon';
import './Login.css';

const Login = () => {
  const { signIn, signUp } = useAuth();

  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === 'signup' && password.length < 8) {
      setError('A senha precisa ter pelo menos 8 caracteres.');
      return;
    }

    setIsSubmitting(true);

    const message =
      mode === 'signup'
        ? await signUp(name.trim() || email.split('@')[0], email.trim(), password)
        : await signIn(email.trim(), password);

    setIsSubmitting(false);

    if (message) setError(message);
  };

  const toggleMode = () => {
    setMode((prev) => (prev === 'signin' ? 'signup' : 'signin'));
    setError(null);
  };

  return (
    <div className="login-page">
      <div className="login-theme-toggle">
        <ThemeToggle />
      </div>

      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-brand">
          <AppIcon className="login-logo" size={72} />
          <h1>Editor Markdown</h1>
          <p>
            {mode === 'signin'
              ? 'Entre para acessar seus documentos de qualquer lugar'
              : 'Crie sua conta para sincronizar seus documentos'}
          </p>
        </div>

        {mode === 'signup' && (
          <label className="login-field">
            <span>Nome</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Como quer ser chamado"
              autoComplete="name"
            />
          </label>
        )}

        <label className="login-field">
          <span>E-mail</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="voce@exemplo.com"
            autoComplete="email"
            required
          />
        </label>

        <label className="login-field">
          <span>Senha</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'signup' ? 'Mínimo de 8 caracteres' : '••••••••'}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            required
          />
        </label>

        {error && <div className="login-error">{error}</div>}

        <button type="submit" className="login-submit" disabled={isSubmitting}>
          {isSubmitting ? 'Aguarde...' : mode === 'signin' ? 'Entrar' : 'Criar conta'}
        </button>

        <p className="login-switch">
          {mode === 'signin' ? 'Ainda não tem conta?' : 'Já tem uma conta?'}{' '}
          <button type="button" onClick={toggleMode}>
            {mode === 'signin' ? 'Criar conta' : 'Entrar'}
          </button>
        </p>
      </form>
    </div>
  );
};

export default Login;
