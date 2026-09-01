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
  const [showPassword, setShowPassword] = useState(false);
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
    // Trocar de tela deixa a senha visível de novo escondida: quem estava
    // conferindo o que digitou não pediu para continuar exibindo.
    setShowPassword(false);
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
          <div className="login-password">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'signup' ? 'Mínimo de 8 caracteres' : '••••••••'}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
            />

            <button
              type="button"
              className="login-password-toggle"
              onClick={() => setShowPassword((visible) => !visible)}
              title={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
              aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
              aria-pressed={showPassword}
            >
              {showPassword ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path>
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path>
                  <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path>
                  <line x1="1" y1="1" x2="23" y2="23"></line>
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
                </svg>
              )}
            </button>
          </div>
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

      <p className="login-credit">Feito por Caio Bertoldo</p>
    </div>
  );
};

export default Login;
