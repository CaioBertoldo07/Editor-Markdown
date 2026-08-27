import type { AuthUser } from '../context/AuthContext';

/** "Bom dia" / "Boa tarde" / "Boa noite" conforme a hora local de quem acessa. */
export function greetingFor(date: Date = new Date()): string {
  const hour = date.getHours();

  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

/**
 * Primeiro nome de quem está logado. O nome é opcional no cadastro, então cai
 * para a parte do e-mail antes do @ quando não existe.
 */
export function displayName(user: AuthUser | null): string {
  if (!user) return '';

  const name = user.name?.trim();
  if (name) return name.split(/\s+/)[0];

  return user.email.split('@')[0];
}
