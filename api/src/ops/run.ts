import { runMigrations, setApiRolePassword, setBackupRolePassword } from '../db/migrate.js';
import { runStagingCheck } from './staging-check.js';
import { runExecute, runInspect } from './transfer.js';

/**
 * Ponto de entrada do serviço de OPERAÇÕES (nunca da API). A tarefa vem de
 * OPS_TASK; o processo roda uma vez e termina.
 *
 *   migrate            migrations + LOGIN/senha do app_api (e do app_backup, com BACKUP_DB_PASSWORD)
 *   staging-check      verificação completa do staging com dados fictícios
 *   transfer-inspect   leitura somente leitura do Neon (agregados, sem dados)
 *   transfer-execute   cópia Neon -> Railway (exige TRANSFER_CONFIRM)
 *   idle               não faz nada (estado seguro entre tarefas)
 */

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Variável ${name} ausente`);
  return value;
};

async function main(): Promise<number> {
  const task = process.env.OPS_TASK ?? 'idle';
  console.log(`[ops] tarefa: ${task}`);

  switch (task) {
    case 'idle':
      return 0;
    case 'migrate': {
      const url = required('MIGRATION_DATABASE_URL');
      const result = await runMigrations(url);
      console.log(`[ops] migrations aplicadas: ${result.applied.join(', ') || 'nenhuma'}; já existentes: ${result.skipped.length}`);
      await setApiRolePassword(url, required('APP_API_DB_PASSWORD'));
      console.log('[ops] LOGIN e senha do app_api definidos');
      // Opcional: só onde existe o serviço de backup.
      const backupPassword = process.env.BACKUP_DB_PASSWORD;
      if (backupPassword) {
        await setBackupRolePassword(url, backupPassword);
        console.log('[ops] LOGIN e senha do app_backup definidos');
      }
      return 0;
    }
    case 'staging-check': {
      const ok = await runStagingCheck({
        adminUrl: required('MIGRATION_DATABASE_URL'),
        privateUrl: required('STAGING_PRIVATE_URL'),
        publicUrl: process.env.STAGING_PUBLIC_URL || null,
        origin: required('STAGING_ORIGIN'),
        accessKey: process.env.STAGING_ACCESS_KEY || null,
      });
      return ok ? 0 : 1;
    }
    case 'transfer-inspect': {
      const r = await runInspect({ sourceUrl: required('NEON_DATABASE_URL'), targetUrl: required('MIGRATION_DATABASE_URL') });
      return r.problems.length === 0 ? 0 : 1;
    }
    case 'transfer-execute':
      await runExecute({
        sourceUrl: required('NEON_DATABASE_URL'),
        targetUrl: required('MIGRATION_DATABASE_URL'),
        confirmation: process.env.TRANSFER_CONFIRM ?? '',
      });
      return 0;
    default:
      throw new Error(`OPS_TASK desconhecida: ${task}`);
  }
}

main()
  .then((code) => {
    console.log(`[ops] fim (código ${code})`);
    process.exit(code);
  })
  .catch((err: Error) => {
    console.error(`[ops] ERRO: ${err.message}`);
    process.exit(1);
  });
