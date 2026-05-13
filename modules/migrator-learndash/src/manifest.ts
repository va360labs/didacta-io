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
  /// ctx.didacta — API pública del core scoped al módulo (alpha.52).
  /// Permite crear/upsertear users, courses, lessons, etc. del core sin
  /// tocar Prisma directo. Idempotencia por (externalSource, externalId).
  /// `permissions` es lista cerrada validada por el host. Sin este bloque,
  /// el módulo recibe un cliente que rechaza con DIDACTA_PERMISSION_DENIED.
  didacta?: {
    externalSource: string;
    permissions: string[];
  };
  /// Job lifecycle (alpha.53+). Si el módulo expone `onJobTick`, declarar
  /// el nombre de la función exportada aquí. El host valida en install
  /// que `module.exports[onTickFn]` existe — si no, MODULE_BOOT_FAILED.
  /// El worker BullMQ del host invoca `onJobTick(ctx)` por cada tick del
  /// job (después de POST /jobs lo encolar). Sin este bloque, el módulo
  /// es síncrono — los handlers HTTP responden, pero los jobs persisten
  /// en `pending` para siempre.
  jobLifecycle?: {
    onTickFn: string;
    /// Tope de ticks por hora (defensa anti-bucle infinito). El host
    /// puede aplicar throttling si excede. Default 600 (1 tick/6s).
    maxTicksPerHour?: number;
  };
  /// ctx.secrets store cifrado scoped al módulo + tenant (alpha.56). Si
  /// `true`, el host inyecta `SandboxedSecrets` con get/set/delete/list.
  /// Necesario para que POST /jobs guarde el appPassword de WP y onJobTick
  /// (cada tick fresco, sin estado in-process) lo descifre por demanda.
  /// Sin este bloque el módulo no podría autenticar contra WordPress en
  /// las phases de extract (ET-001).
  requiresSecrets?: boolean;
  /// Caps específicos del módulo (más estrictos que los defaults del core).
  /// `allowedKeyPattern` fuerza que TODA key matchee la regex — guard
  /// contra bugs en el propio módulo que escriban keys tenant-globales por
  /// accidente cuando solo queremos job-scoped.
  secretsLifecycle?: {
    maxKeys?: number;
    maxValueBytes?: number;
    allowedKeyPattern?: string;
  };
}

export const manifest: ModuleManifest = {
  name: 'mod.migrator-learndash',
  displayName: 'Migrador desde WordPress + LearnDash',
  description:
    'Importa cursos, lecciones, temas, quizzes, preguntas, usuarios, grupos, matrículas, media y progreso desde WordPress + LearnDash hacia Didacta. Wizard didáctico paso a paso, ETL con staging, idempotencia por checksum, reportes auditables.',
  version: '1.0.10',
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
  // alpha.52: el load phase del migrator (Sprint 4 / ET-003) crea entidades
  // reales en el core (users, courses, modules, lessons, quizzes,
  // enrollments, media) usando ctx.didacta. Idempotencia por externalRef:
  // re-correr un job NO duplica. Source identificador "learndash" (matchea
  // el ADR-014 — `external_source` permanece estable entre versiones del
  // módulo). Lista completa de permisos porque el migrador toca todas las
  // entidades importables; otros módulos third-party deberían declarar
  // SOLO los permisos que necesitan (least privilege).
  didacta: {
    externalSource: 'learndash',
    permissions: [
      'users.upsertByExternalRef',
      'users.findByExternalRef',
      'users.deleteByExternalRef',
      'courses.upsertByExternalRef',
      'courses.findByExternalRef',
      'courses.publish',
      'courses.deleteByExternalRef',
      'modules.upsertByExternalRef',
      'modules.findByExternalRef',
      'modules.deleteByExternalRef',
      'lessons.upsertByExternalRef',
      'lessons.findByExternalRef',
      'lessons.deleteByExternalRef',
      'quizzes.upsertByExternalRef',
      'quizzes.findByExternalRef',
      'quizzes.deleteByExternalRef',
      'quizzes.upsertQuestions',
      'enrollments.upsertByExternalRef',
      'enrollments.findByExternalRef',
      'enrollments.deleteByExternalRef',
      'media.uploadFromUrl',
      'media.uploadFromBytes',
    ],
  },
  // alpha.53: el módulo expone `onJobTick` para que el worker BullMQ del
  // host avance el state machine del job. Ver src/index.ts para la
  // implementación. Sin este bloque, el host NO encolaría los jobs y
  // quedarían en `pending` para siempre. Tope de 600 ticks/h por job
  // (1 tick cada 6s) para limitar abuso si el módulo cae en un bucle.
  jobLifecycle: {
    onTickFn: 'onJobTick',
    maxTicksPerHour: 600,
  },
  // alpha.56: el migrador necesita persistir el appPassword de WP entre
  // POST /jobs y el primer tick del worker BullMQ. Antes de alpha.56 el
  // password se descartaba al persistir el job (regla "appPassword NUNCA
  // se persiste en source_profile") — eso bloqueaba ET-001 porque el
  // worker arranca con ctx fresco y no tiene cómo autenticar contra WP.
  // ctx.secrets resuelve: cipher AES-256-GCM at-rest, key resuelta via
  // loadCipherKey() (sin fricción primer install). allowedKeyPattern
  // fuerza que TODA key sea job-scoped (^job:<uuid>:learndash:...) para
  // que un bug del módulo no escriba secretos tenant-globales por accidente.
  requiresSecrets: true,
  secretsLifecycle: {
    // Defensa profundidad: cap conservador. Cada job vivo guarda 1 key
    // (appPassword). 16 jobs concurrentes por tenant es ya mucho — más
    // que eso huele a leak de cleanup. Si llegamos al cap, set() falla y
    // el handler responde 503 al wizard pidiendo al admin que limpie.
    maxKeys: 16,
    // 1 KB cubre cualquier appPassword realista (WP los limita a 24 chars
    // por defecto, pero algunas extensiones permiten más). Más que eso
    // huele a basura embebida.
    maxValueBytes: 1024,
    // Forzar prefix job:<uuid>:learndash:* para no permitir keys
    // tenant-globales. Si el día de mañana queremos agregar settings
    // tenant-level (ej. webhook secret persistido cross-jobs), cambiamos
    // este pattern explícitamente — pero hoy NO queremos eso.
    allowedKeyPattern: '^job:[a-f0-9-]{36}:learndash:[a-zA-Z0-9_]{1,40}$',
  },
};
