import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { api, onUnauthorized } from '../lib/api';

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

interface AuthContextType {
  user: AuthUser | null;
  /** true enquanto a sessão existente ainda está sendo verificada */
  isLoading: boolean;
  /** Retorna a mensagem de erro, ou null em caso de sucesso */
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Sessão do Better Auth self-hosted (API no Railway). O cookie é HttpOnly e
 * fica no domínio do app; aqui só perguntamos à API quem está logado.
 * O cadastro público está desligado no servidor.
 */
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const readSession = useCallback(async () => {
    const sessionUser = await api.auth.getSession();
    setUser(sessionUser ? { id: sessionUser.id, email: sessionUser.email, name: sessionUser.name } : null);
    return !!sessionUser;
  }, []);

  // Restaurar sessão ao abrir o app
  useEffect(() => {
    readSession()
      .catch((err) => {
        console.error('Erro ao verificar sessão:', err);
        setUser(null);
      })
      .finally(() => setIsLoading(false));
  }, [readSession]);

  // Sessão expirada no meio do uso: volta para a tela de login.
  useEffect(() => {
    onUnauthorized(() => setUser(null));
    return () => onUnauthorized(null);
  }, []);

  const signIn = async (email: string, password: string): Promise<string | null> => {
    try {
      await api.auth.signIn(email, password);
      const ok = await readSession();
      return ok ? null : 'Não foi possível iniciar a sessão. Verifique se os cookies estão habilitados.';
    } catch (err) {
      console.error('Erro no login:', (err as Error).message);
      return (err as Error).message || 'Não foi possível entrar.';
    }
  };

  const signOut = async (): Promise<void> => {
    try {
      await api.auth.signOut();
    } catch (err) {
      console.error('Erro ao sair:', (err as Error).message);
    }
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth deve ser usado dentro de AuthProvider');
  }
  return context;
};
