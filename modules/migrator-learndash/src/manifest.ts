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
  /// HTTP saliente (alpha.49). Si el módulo necesita salir a internet,
  /// declara aquí los hosts permitidos + rate limit + body cap. El packager
  /// (didacta-modules-skill) serializa este bloque al manifest.jwt.
  http?: {
    allowedHosts: string[];
    unrestrictedHosts?: boolean;
    rateLimitPerHost: { requestsPerSecond: number; burst: number };
    maxBodyBytes: number;
  };
  /// ctx.db scoped al tablePrefix (alpha.51). Cuando es `true`, el host
  /// inyecta un cliente con SQL guard que solo deja tocar tablas que
  /// empiezan con `tablePrefix`. Si es `false`/undefined, el módulo
  /// recibe un cliente que rechaza con DB_PREFIX_VIOLATION + mensaje
  /// accionable. La estructura de tablas viene de prisma/migrations/*.sql
  /// aplicadas en install (ADR-013) — DDL prohibida en runtime.
  requiresDb?: boolean;
}

export const manifest: ModuleManifest = {
  name: 'mod.migrator-learndash',
  displayName: 'Migrador desde WordPress + LearnDash',
  description:
    'Importa cursos, lecciones, temas, quizzes, preguntas, usuarios, grupos, matrículas, media y progreso desde WordPress + LearnDash hacia Didacta. Wizard didáctico paso a paso, ETL con staging, idempotencia por checksum, reportes auditables.',
  version: '1.0.6',
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
  // Origen del cliente es arbitrario (cada usuario apunta a su propio
  // WordPress) — `*` con reconocimiento explícito vía `unrestrictedHosts`.
  // El SSRF guard del core sigue bloqueando IPs privadas/loopback. Rate
  // limit conservador para no tirar el WP del cliente (5rps con burst 10
  // ≈ 300 req/min — suficiente para un preflight de ~8 reqs y para el
  // extract phase paginando entidades una a una).
  http: {
    allowedHosts: ['*'],
    unrestrictedHosts: true,
    rateLimitPerHost: { requestsPerSecond: 5, burst: 10 },
    maxBodyBytes: 10 * 1024 * 1024, // 10 MB — un dump de cursos serializado
  },
  // alpha.51: el módulo persiste jobs/staging/audit/dlq en sus propias
  // tablas (`mod_migrator_learndash_*`, declaradas en prisma/migrations/
  // 20260503000000_init.sql). Antes de alpha.51 los jobs vivían en un
  // `Map` en memoria y se perdían al restart de la API. Con `requiresDb:
  // true` el host inyecta un cliente SQL scoped al tablePrefix.
  requiresDb: true,
};
