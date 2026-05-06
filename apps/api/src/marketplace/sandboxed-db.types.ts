/**
 * Contrato del cliente de BD que el host expone a los módulos third-party
 * del marketplace. Definido en alpha.51.
 *
 * Antes de alpha.51 los módulos NO podían persistir state: el sandbox no
 * expone Prisma ni `node:sqlite`, y `ctx` solo tenía `{ log, http }`.
 * Resultado: `mod.migrator-learndash` mantenía sus jobs en memoria,
 * perdiéndolos al restart del container.
 *
 * Este contrato vive en archivo separado para que tres consumidores lo
 * compartan sin ciclos de import:
 *  1. `module-router.service.ts` — `ModuleRouteRequestContext.db`
 *  2. `module-sandbox.service.ts` — `ModuleInstallContext.db`
 *  3. `sandboxed-db.service.ts` (DB-003) — la implementación real
 *
 * Reglas estructurales del contrato (todas impuestas por el host):
 *  - **Aislamiento por tablePrefix**: el módulo SOLO puede leer/escribir
 *    tablas cuyo nombre empieza con su `manifest.tablePrefix`. SQL guard
 *    parsea cada query y rechaza cualquier referencia a tabla fuera
 *    del prefijo (`DB_PREFIX_VIOLATION`). Eso garantiza:
 *      - Cero acceso a tablas del core (user, course, tenant, …).
 *      - Cero acceso a tablas de OTROS módulos third-party.
 *      - Cero leak cross-tenant si el módulo olvida filtrar por tenant_id
 *        (defensa en profundidad: el host setea `app.current_tenant`
 *        para RLS antes de ejecutar la query).
 *  - **DDL prohibida en runtime**: el módulo NO puede CREATE/DROP/ALTER
 *    tablas. La estructura se define en `prisma/migrations/*.sql` del
 *    paquete y se aplica solo en install (alpha.42 ADR-013). Cualquier
 *    DDL en `query()` o `execute()` lanza `DB_INVALID_SQL`.
 *  - **Timeout duro**: max 10 segundos por query. Default 1 segundo.
 *    Más alto que eso indica I/O bloqueante mal diseñado.
 *  - **Row cap**: max 10_000 filas por SELECT. Default 1_000. Si la query
 *    devolvería más, se aborta con `DB_TOO_MANY_ROWS`. Para procesar
 *    volúmenes mayores el módulo debe paginar (LIMIT/OFFSET o cursor).
 *  - **Statement length cap**: max 50 KB. SQL más largo es código
 *    generado mal hecho.
 *  - **Sin transactions anidadas**: `transaction()` rechaza llamarse
 *    desde dentro de otro `transaction()`.
 */

/// Códigos de error tipados que `ctx.db` puede lanzar. El módulo decide
/// qué hacer con cada uno (retry, dlq, propagar al user, etc.). Los
/// errores de constraint del motor (unique, FK) se mapean a códigos
/// estables para que el módulo no dependa de los strings de Postgres.
export type DbErrorCode =
  | 'DB_PREFIX_VIOLATION'   // SQL referencia tabla fuera del tablePrefix del manifest.
  | 'DB_INVALID_SQL'        // SQL no parseable, DDL prohibida, statement vacío, etc.
  | 'DB_STATEMENT_TOO_LONG' // SQL > 50 KB.
  | 'DB_TIMEOUT'            // La query superó `timeoutMs`.
  | 'DB_TOO_MANY_ROWS'      // SELECT devolvería más filas que `maxRows`.
  | 'DB_TX_ABORTED'         // La transacción se abortó (rollback explícito o callback rejected).
  | 'DB_TX_NESTED'          // `transaction()` llamado desde dentro de otra `transaction()`.
  | 'DB_UNIQUE_VIOLATION'   // Postgres 23505 — constraint unique violado.
  | 'DB_FK_VIOLATION'       // Postgres 23503 — foreign key violado.
  | 'DB_NOT_NULL'           // Postgres 23502 — not null violado.
  | 'DB_CHECK_VIOLATION'    // Postgres 23514 — check constraint violado.
  | 'DB_NETWORK';           // Conexión perdida, deadlock, otro error de driver.

export class DbError extends Error {
  constructor(
    public readonly code: DbErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DbError';
  }
}

export interface QueryOptions {
  /// Timeout duro por query (ms). Cap del host: 10_000. Default: 1_000.
  /// Para queries que tardan más, el módulo está abusando — paginá o
  /// movilo al extract phase con `paginateWp`-equivalent.
  timeoutMs?: number;
  /// Rows máximas a devolver. Cap del host: 10_000. Default: 1_000.
  /// Superado → `DB_TOO_MANY_ROWS`. Para volúmenes mayores, paginá con
  /// LIMIT/OFFSET o cursor.
  maxRows?: number;
}

/// Resultado uniforme de query/execute. SELECT devuelve `rows` con la data
/// y `rowCount` igual a `rows.length`. INSERT/UPDATE/DELETE devuelven
/// `rows: []` y `rowCount` con las filas afectadas.
export interface QueryResult<TRow = Record<string, unknown>> {
  rows: TRow[];
  rowCount: number;
}

/// Cliente HTTP-like para BD: query (SELECT, RETURNING) + execute
/// (INSERT/UPDATE/DELETE sin RETURNING, count) + transaction.
///
/// `params` se pasan posicionalmente con `$1, $2, ...` (Postgres style).
/// El host NUNCA hace string interpolation — siempre prepared statements.
/// Eso elimina SQL injection sin esfuerzo del módulo.
export interface SandboxedDb {
  /// Ejecuta un SELECT (o INSERT/UPDATE/DELETE con RETURNING) y devuelve
  /// las filas resultantes. SQL parseado + validado contra tablePrefix
  /// antes de tocar Postgres.
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
    opts?: QueryOptions,
  ): Promise<QueryResult<TRow>>;

  /// Ejecuta un statement sin esperar filas (INSERT/UPDATE/DELETE plain).
  /// Devuelve `rowCount` con filas afectadas. Ideal para writes en batch
  /// donde no necesitás los datos resultantes.
  execute(
    sql: string,
    params?: ReadonlyArray<unknown>,
    opts?: QueryOptions,
  ): Promise<{ rowCount: number }>;

  /// Ejecuta `fn` dentro de una transacción Postgres. Commit si la promesa
  /// resuelve; rollback si lanza. La `tx` es el mismo `SandboxedDb` shape
  /// pero scoped a la conexión de la transacción. NO se permiten
  /// transactions anidadas (el host lanza `DB_TX_NESTED`).
  transaction<TResult>(
    fn: (tx: SandboxedDb) => Promise<TResult>,
  ): Promise<TResult>;
}

/// Cliente que rechaza TODO con `DB_PREFIX_VIOLATION`. Se inyecta a los
/// módulos que NO declaran `requiresDb: true` en su manifest. Mensaje
/// accionable para el dev: explica exactamente qué añadir al manifest.
export class BlockedSandboxedDb implements SandboxedDb {
  constructor(private readonly moduleName: string) {}

  async query<TRow = Record<string, unknown>>(): Promise<QueryResult<TRow>> {
    return this.reject();
  }
  async execute(): Promise<{ rowCount: number }> {
    return this.reject();
  }
  async transaction<TResult>(): Promise<TResult> {
    return this.reject();
  }
  private reject(): never {
    throw new DbError(
      'DB_PREFIX_VIOLATION',
      `Módulo "${this.moduleName}" intentó usar ctx.db pero no declara \`requiresDb: true\` en su manifest. Añadí "requiresDb": true al module.json (junto a tablePrefix, que ya debe estar) para habilitar el cliente de BD scoped a las tablas de tu módulo.`,
    );
  }
}

/// Placeholder para tests del dispatcher antes de tener la implementación
/// real. Lanza siempre `DB_NETWORK` con mensaje claro de que el wiring
/// no está cableado todavía.
export class NoopSandboxedDb implements SandboxedDb {
  async query<TRow = Record<string, unknown>>(): Promise<QueryResult<TRow>> {
    return this.reject();
  }
  async execute(): Promise<{ rowCount: number }> {
    return this.reject();
  }
  async transaction<TResult>(): Promise<TResult> {
    return this.reject();
  }
  private reject(): never {
    throw new DbError(
      'DB_NETWORK',
      'NoopSandboxedDb invocado — esto solo debería ocurrir en tests. En runtime el dispatcher inyecta BlockedSandboxedDb (módulo sin requiresDb) o SandboxedDbService (módulo con requiresDb).',
    );
  }
}
