import { createClient } from '@neondatabase/neon-js';

const authUrl = import.meta.env.VITE_NEON_AUTH_URL;
const dataApiUrl = import.meta.env.VITE_NEON_DATA_API_URL;

if (!authUrl || !dataApiUrl) {
  throw new Error(
    'Faltam as variáveis VITE_NEON_AUTH_URL e VITE_NEON_DATA_API_URL. ' +
      'Copie o .env.example para .env e preencha com as URLs do seu projeto Neon.'
  );
}

/**
 * Cliente único do Neon: cuida do login (Managed Better Auth) e das queries
 * (Data API). O JWT da sessão é anexado automaticamente em cada request, e o
 * RLS no banco garante que cada usuário só enxerga as próprias linhas.
 */
export const neon = createClient({
  auth: { url: authUrl },
  dataApi: { url: dataApiUrl },
});
