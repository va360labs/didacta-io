/**
 * Manifest del módulo embebido en el bundle.
 *
 * NO usa `parseModuleManifest()` del core-kernel: el módulo corre en
 * VM aislada del host con allowlist estricta de requires; importar el
 * core-kernel solo para validación es overhead innecesario. El manifest
 * que importa para el host es el del `manifest.jwt` del ZIP — éste es
 * solo data de presentación dentro del bundle.
 */
export interface ModuleManifest {
  name: string;
  displayName: string;
  description: string;
  version: string;
  author?: string;
  license?: string;
  category?: string;
  coreVersionRequired: string;
  tablePrefix: string;
  apiNamespace: string;
  permissions: string[];
  eventsEmitted: string[];
  eventsConsumed: string[];
}

export const manifest: ModuleManifest = {
  name: 'mod.migrator-learndash',
  displayName: 'Migrador desde WordPress + LearnDash',
  description:
    'Importa cursos, lecciones, temas, quizzes, preguntas, usuarios, grupos, matrículas, media y progreso desde WordPress + LearnDash hacia Didacta. Wizard didáctico paso a paso, ETL con staging, idempotencia por checksum, reportes auditables.',
  version: '1.0.0',
  author: 'Didacta',
  license: 'Proprietary',
  category: 'migration',
  coreVersionRequired: '^0.0.0',
  tablePrefix: 'mod_migrator_learndash_',
  apiNamespace: '/modules/migrator-learndash',
  permissions: [
    'migrator-learndash.import.create',
    'migrator-learndash.import.read',
    'migrator-learndash.import.cancel',
    'migrator-learndash.import.rollback',
    'migrator-learndash.report.read',
    'migrator-learndash.report.export',
  ],
  eventsEmitted: [
    'migrator-learndash.import.started',
    'migrator-learndash.import.completed',
    'migrator-learndash.import.failed',
    'migrator-learndash.import.cancelled',
    'migrator-learndash.import.rollback.started',
    'migrator-learndash.import.rollback.completed',
  ],
  eventsConsumed: [],
};
