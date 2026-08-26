import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { neon } from '../lib/neon';

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
  signUp: (name: string, email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const readSession = useCallback(async () => {
    const result = await neon.auth.getSession();
    const sessionUser = result.data?.user;

    if (sessionUser) {
      setUser({
        id: sessionUser.id,
        email: sessionUser.email,
        name: sessionUser.name,
      });
      return true;
    }

    setUser(null);
    return false;
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

  const signIn = async (email: string, password: string): Promise<string | null> => {
    try {
      const result = await neon.auth.signIn.email({ email, password });
      if (result.error) return result.error.message ?? 'Não foi possível entrar.';

      await readSession();
      return null;
    } catch (err) {
      console.error('Erro no login:', err);
      return 'Não foi possível conectar ao servidor.';
    }
  };

  const signUp = async (name: string, email: string, password: string): Promise<string | null> => {
    try {
      const result = await neon.auth.signUp.email({ name, email, password });
      if (result.error) return result.error.message ?? 'Não foi possível criar a conta.';

      await readSession();
      return null;
    } catch (err) {
      console.error('Erro no cadastro:', err);
      return 'Não foi possível conectar ao servidor.';
    }
  };

  const signOut = async (): Promise<void> => {
    try {
      await neon.auth.signOut();
    } catch (err) {
      console.error('Erro ao sair:', err);
    }
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, signIn, signUp, signOut }}>
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
