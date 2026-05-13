import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@didacta/database';
import { PrismaService } from '../prisma/prisma.service';
import { DB_CAPS } from './module-manifest.schema';
import {
  DbError,
  type QueryOptions,
  type QueryResult,
  type SandboxedDb,
} from './sandboxed-db.types';

/**
 * Implementación real del cliente de BD que el host expone a los módulos
 * third-party del marketplace (alpha.51 — task DB-003 del plan ctx.db).
 *
 * NO es un servicio inyectable singleton para los módulos: cada (módulo,
 * request | onInstall) recibe una instancia scoped via `build()` que
 * memoriza el `tablePrefix` declarado en el manifest + el `tenantId`
 * resuelto del request. El dispatcher (DB-004) cablea el wiring.
 *
 * Capas defensivas (en orden, fail-fast):
 *  1. `validateSql()` — string check + statement length cap +
 *     anti-multi-statement + statement kind allowlist + table-prefix guard.
 *  2. Wrap en `prisma.$transaction` para poder `SET LOCAL`:
 *     - `app.current_tenant_id` → activa RLS para el módulo.
 *     - `statement_timeout` → Postgres aborta la query en el motor.
 *  3. `$queryRawUnsafe(sql, ...params)` con prepared statements (params
 *     posicionales `$1, $2...` — el host NUNCA hace string interpolation).
 *  4. Post-check: `rows.length > maxRows` → `DB_TOO_MANY_ROWS`.
 *  5. Cualquier error del motor pasa por `mapPostgresError()` que lo
 *     normaliza a uno de los `DbErrorCode` tipados. Esto desacopla al
 *     módulo de la versión exacta de Postgres/Prisma.
 *
 * Limitación conocida del SQL guard: el extractor de tabla refs es regex
 * + balanced-paren tracking; soporta los casos comunes (FROM/JOIN/INTO/
 * UPDATE/USING + ONLY + qualified idents + CTE aliases + funciones que
 * usan FROM como separador: extract/substring/trim/overlay/position).
 * NO usa un parser PG completo (nadie quiere meterse `pg-query-emscripten`
 * de 4 MB en el bundle del API). Los módulos que necesiten SQL exótico
 * (DSL, generated columns con functions raras) van a chocar con
 * DB_PREFIX_VIOLATION false-positive y deben simplificar la query.
 */

/// Defaults expuestos para tests + telemetría. Caps DUROS viven en
/// `module-manifest.schema.ts` (`DB_CAPS.*`) — sirven de mirror.
export const DB_DEFAULTS = {
  TIMEOUT_MS: 1000,
  MAX_TIMEOUT_MS: DB_CAPS.MAX_QUERY_TIMEOUT_MS,
  MAX_ROWS: 1000,
  MAX_ROWS_HARD_CAP: DB_CAPS.MAX_ROWS,
  MAX_STATEMENT_LENGTH: DB_CAPS.MAX_STATEMENT_LENGTH,
} as const;

/// Statement kinds permitidos en runtime. Cualquier otra cosa
/// (CREATE/DROP/ALTER/TRUNCATE/GRANT/REVOKE/COPY/SET ROLE/DO $$/etc.) es
/// DDL prohibida — la estructura del schema viene de las migrations
/// `prisma/migrations/*.sql` aplicadas en install (ADR-013), NUNCA del
/// código del módulo en runtime.
const ALLOWED_KINDS = new Set(['select', 'insert', 'update', 'delete', 'with', 'values']);

/// Funciones PG que usan `FROM` como separador entre argumentos. Si una
/// query las usa, hay que enmascarar el contenido de sus parens antes de
/// extraer table refs — de lo contrario `extract(year from created_at)`
/// dispara DB_PREFIX_VIOLATION en `created_at` (que es una columna, no
/// una tabla).
const FROM_FN_NAMES = ['extract', 'substring', 'trim', 'overlay', 'position'] as const;

@Injectable()
export class SandboxedDbService {
  private readonly logger = new Logger(SandboxedDbService.name);

  constructor(private readonly prisma: PrismaService) {}

  /// Construye un cliente de BD scoped a un módulo. `tenantId` debe venir
  /// del contexto del request (TenantContextService) o explícito en
  /// `onInstall` lifecycle. Si es `null`, NO se setea `app.current_tenant_id`
  /// y RLS bloqueará todas las queries que toquen tablas con tenant_id —
  /// es el comportamiento conservador para módulos que se cargan fuera de
  /// un request HTTP (workers de prueba, scripts admin).
  build(moduleName: string, tablePrefix: string, tenantId: string | null): SandboxedDb {
    if (!/^mod_[a-z0-9_]+_$/.test(tablePrefix)) {
      // Defensa en profundidad: el manifest schema ya valida esto en
      // install (TABLE_PREFIX_REGEX), pero si alguien construye el cliente
      // con un prefix raro no podemos garantizar el guard.
      throw new Error(
        `SandboxedDbService.build: tablePrefix inválido "${tablePrefix}". Esperado /^mod_[a-z0-9_]+_$/.`,
      );
    }
    return new ScopedSandboxedDb(
      this.prisma,
      this.logger,
      moduleName,
      tablePrefix,
      tenantId,
      null,
    );
  }
}

/// Implementación interna. NO instanciar directamente desde fuera del
/// servicio — usar `SandboxedDbService.build()`.
class ScopedSandboxedDb implements SandboxedDb {
  /// Si `txClient !== null`, estamos dentro de una `transaction()` del
  /// usuario y reusamos esa conexión en lugar de abrir un `$transaction`
  /// propio por query. Eso evita transactions anidadas (Prisma no las
  /// soporta a nivel cliente y Postgres usaría savepoints que NO queremos
  /// exponer al módulo).
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger,
    private readonly moduleName: string,
    private readonly tablePrefix: string,
    private readonly tenantId: string | null,
    private readonly txClient: Prisma.TransactionClient | null,
  ) {}

  query<TRow = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = [],
    opts: QueryOptions = {},
  ): Promise<QueryResult<TRow>> {
    return this.run<TRow>('query', sql, params, opts);
  }

  async execute(
    sql: string,
    params: ReadonlyArray<unknown> = [],
    opts: QueryOptions = {},
  ): Promise<{ rowCount: number }> {
    const result = await this.run('execute', sql, params, opts);
    return { rowCount: result.rowCount };
  }

  async transaction<TResult>(fn: (tx: SandboxedDb) => Promise<TResult>): Promise<TResult> {
    if (this.txClient) {
      throw new DbError(
        'DB_TX_NESTED',
        `Módulo "${this.moduleName}" llamó a ctx.db.transaction() desde dentro de otra transacción. No se permiten transactions anidadas — usá la tx exterior o reorganizá el flujo.`,
      );
    }
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await this.applyTenantScope(tx);
          const scoped = new ScopedSandboxedDb(
            this.prisma,
            this.logger,
            this.moduleName,
            this.tablePrefix,
            this.tenantId,
            tx,
          );
          return fn(scoped);
        },
        { timeout: DB_DEFAULTS.MAX_TIMEOUT_MS + 2_000 },
      );
    } catch (err) {
      if (err instanceof DbError) throw err;
      throw new DbError(
        'DB_TX_ABORTED',
        `Transaction abortada en módulo "${this.moduleName}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  private async run<TRow>(
    kind: 'query' | 'execute',
    sql: string,
    params: ReadonlyArray<unknown>,
    opts: QueryOptions,
  ): Promise<QueryResult<TRow>> {
    validateSql(sql, this.tablePrefix);
    const timeoutMs = clampTimeout(opts.timeoutMs);
    const maxRows = clampMaxRows(opts.maxRows);

    if (this.txClient) {
      // Ya estamos dentro de una tx del usuario — reusamos esa conexión.
      // El tenant scope lo seteó la `transaction()` que abrió la tx; solo
      // ajustamos `statement_timeout` por-query (SET LOCAL aplica al
      // resto de la tx, así que lo reseteamos en cada query).
      return this.executeStatement<TRow>(this.txClient, kind, sql, params, timeoutMs, maxRows);
    }

    // Top-level: envolvemos en `$transaction` propia para poder usar SET
    // LOCAL. Single-statement transaction → cero overhead percibido por
    // el módulo, equivalente semánticamente a una query sin tx.
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await this.applyTenantScope(tx);
          return this.executeStatement<TRow>(tx, kind, sql, params, timeoutMs, maxRows);
        },
        { timeout: timeoutMs + 2_000 },
      );
    } catch (err) {
      if (err instanceof DbError) throw err;
      throw mapPostgresError(err, timeoutMs);
    }
  }

  /// Ejecuta UN statement contra el client (sea PrismaService top-level o
  /// Prisma.TransactionClient interno). Setea `statement_timeout` antes
  /// de cada query — Postgres lo aborta en el motor sin depender de
  /// timers JS. Mapea errores PG a DbErrorCode tipados.
  private async executeStatement<TRow>(
    client: Prisma.TransactionClient,
    kind: 'query' | 'execute',
    sql: string,
    params: ReadonlyArray<unknown>,
    timeoutMs: number,
    maxRows: number,
  ): Promise<QueryResult<TRow>> {
    await client.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);

    const startedAt = Date.now();
    try {
      if (kind === 'query') {
        const rows = (await client.$queryRawUnsafe<TRow[]>(sql, ...params)) as TRow[];
        const arr: TRow[] = Array.isArray(rows) ? rows : [];
        if (arr.length > maxRows) {
          throw new DbError(
            'DB_TOO_MANY_ROWS',
            `Query devolvió ${arr.length} filas (max ${maxRows}). Paginá la consulta con LIMIT/OFFSET o cursor.`,
          );
        }
        this.logTrace('query', sql, arr.length, Date.now() - startedAt);
        return { rows: arr, rowCount: arr.length };
      }
      const count = await client.$executeRawUnsafe(sql, ...params);
      this.logTrace('execute', sql, count, Date.now() - startedAt);
      return { rows: [] as TRow[], rowCount: count };
    } catch (err) {
      if (err instanceof DbError) throw err;
      throw mapPostgresError(err, timeoutMs);
    }
  }

  /// `SET LOCAL app.current_tenant_id` para que las RLS policies del core
  /// filtren correctamente. Si `tenantId` es null, NO seteamos — RLS
  /// bloqueará tablas tenant-scoped y eso es el behaviour deseado para
  /// invocaciones fuera de request HTTP.
  private async applyTenantScope(tx: Prisma.TransactionClient): Promise<void> {
    if (!this.tenantId) return;
    // Validación defensiva: tenantId debe ser un UUID/string seguro. Lo
    // metemos via SET LOCAL con quotes — si tuviera quote/semicolon,
    // sería SQL injection. Whitelist estricto de chars permitidos.
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(this.tenantId)) {
      throw new DbError(
        'DB_NETWORK',
        `tenantId con caracteres no permitidos detectado en SandboxedDb. Aborto antes de tocar Postgres.`,
      );
    }
    await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${this.tenantId}'`);
  }

  private logTrace(kind: string, sql: string, count: number, ms: number): void {
    const preview = sql.replace(/\s+/g, ' ').slice(0, 80);
    this.logger.debug?.(
      `[mod:${this.moduleName}] db.${kind} → ${count} rows (${ms}ms) :: ${preview}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL guard — exportado para tests directos
// ─────────────────────────────────────────────────────────────────────────────

/// Valida un SQL crudo contra el contrato del cliente sandbox. Lanza
/// `DbError` con código tipado en el primer fallo (fail-fast). Pasa OK
/// (no lanza) si todas las invariantes se cumplen.
///
/// Invariantes:
///   1. SQL es string no-vacío con length ≤ MAX_STATEMENT_LENGTH.
///   2. UN solo statement (al menos un trailing `;` opcional).
///   3. Statement kind ∈ {select, insert, update, delete, with, values}.
///   4. Todas las refs a tablas (FROM/JOIN/INTO/UPDATE/USING + ONLY)
///      empiezan con `tablePrefix`. CTE aliases (de `WITH alias AS (...)`)
///      se excluyen del check.
export function validateSql(sql: string, tablePrefix: string): void {
  if (typeof sql !== 'string') {
    throw new DbError('DB_INVALID_SQL', `SQL debe ser string (recibido: ${typeof sql}).`);
  }
  if (sql.trim().length === 0) {
    throw new DbError('DB_INVALID_SQL', 'SQL vacío.');
  }
  if (sql.length > DB_DEFAULTS.MAX_STATEMENT_LENGTH) {
    throw new DbError(
      'DB_STATEMENT_TOO_LONG',
      `SQL de ${sql.length} chars excede el cap de ${DB_DEFAULTS.MAX_STATEMENT_LENGTH}. Si el statement es legítimo, divididlo o movilo a una migration de install.`,
    );
  }

  const stripped = stripCommentsAndStrings(sql);

  if (countNonTrailingSemicolons(stripped) > 0) {
    throw new DbError(
      'DB_INVALID_SQL',
      'Multi-statement SQL no permitido. ctx.db ejecuta UN solo statement por llamada — para varios, usá ctx.db.transaction(tx => …).',
    );
  }

  const kind = detectStatementKind(stripped);
  if (!ALLOWED_KINDS.has(kind)) {
    throw new DbError(
      'DB_INVALID_SQL',
      `Statement kind "${kind}" no permitido en runtime. ctx.db acepta solo SELECT/INSERT/UPDATE/DELETE/WITH/VALUES — DDL (CREATE/DROP/ALTER/TRUNCATE) viene de prisma/migrations/*.sql aplicadas en install (ADR-013).`,
    );
  }

  // Pre-procesamiento: enmascaramos el contenido de funciones que usan
  // FROM como separador (extract/substring/trim/overlay/position) para
  // que el extractor de table refs no las confunda con FROM <tabla>.
  const masked = maskFromFunctions(stripped);

  const cteAliases = extractCteAliases(masked);
  const tableRefs = extractTableRefs(masked);

  for (const ref of tableRefs) {
    if (cteAliases.has(ref)) continue;
    if (!ref.startsWith(tablePrefix)) {
      throw new DbError(
        'DB_PREFIX_VIOLATION',
        `Tabla "${ref}" fuera del tablePrefix "${tablePrefix}" del módulo. ctx.db solo puede tocar tablas que empiecen con ese prefijo. Si necesitás datos del core (user, course, etc.), pedilos via ctx.didacta API pública (no expuesta todavía — abre un PR en core con la necesidad).`,
      );
    }
  }
}

/// Quita comentarios `--` (línea), `/* ... */` (bloque) y reemplaza el
/// contenido de strings literales `'foo'` por espacios (preservando
/// length para que offsets de error sean útiles). NO toca quoted
/// identifiers `"foo"` — esos SON nombres de tabla/columna y deben
/// participar en la extracción de refs.
export function stripCommentsAndStrings(sql: string): string {
  // Comentarios primero. Bloque /* ... */ y línea --.
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  out = out.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));

  // Strings literales 'foo' con escape Postgres '' (doble apóstrofo).
  // Walk char-by-char para manejar `''` correctamente.
  const chars: string[] = [...out];
  let inStr = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!inStr) {
      if (ch === "'") inStr = true;
      continue;
    }
    if (ch === "'") {
      // ¿Doble apóstrofo (escape)?
      if (chars[i + 1] === "'") {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 1;
        continue;
      }
      // Cierre.
      inStr = false;
      continue;
    }
    chars[i] = ' ';
  }
  return chars.join('');
}

/// Cuenta `;` que NO sean trailing. `SELECT 1` y `SELECT 1;` y `SELECT 1; `
/// devuelven 0; `SELECT 1; SELECT 2` devuelve 1.
export function countNonTrailingSemicolons(sql: string): number {
  let count = 0;
  const trimmed = sql.replace(/\s+$/g, '');
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== ';') continue;
    // Si NO es el último char no-blanco, cuenta.
    const rest = trimmed.slice(i + 1).trim();
    if (rest.length > 0) count++;
  }
  return count;
}

/// Detecta el statement kind por la primera keyword no-blanca. Devuelve
/// la keyword en lowercase, o `'unknown'` si no matchea ninguna conocida.
export function detectStatementKind(sql: string): string {
  const m = sql.trimStart().match(/^([a-z]+)/i);
  return m ? m[1]!.toLowerCase() : 'unknown';
}

/// Enmascara el contenido (entre parens) de las funciones que usan FROM
/// como separador. Reemplaza chars dentro de los parens por espacios,
/// preservando la estructura de balanceo. Maneja parens anidados.
export function maskFromFunctions(sql: string): string {
  const FN_REGEX = new RegExp(
    `\\b(?:${FROM_FN_NAMES.join('|')})\\s*\\(`,
    'gi',
  );
  const chars = [...sql];
  for (const match of sql.matchAll(FN_REGEX)) {
    const start = match.index;
    if (typeof start !== 'number') continue;
    // Posicionarse en el `(` de apertura.
    const openIdx = sql.indexOf('(', start);
    if (openIdx === -1) continue;
    // Walk parens balanceados.
    let depth = 1;
    let i = openIdx + 1;
    while (i < sql.length && depth > 0) {
      const ch = sql[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0) break;
      // Reemplazo por espacio para mantener offsets.
      chars[i] = ' ';
      i++;
    }
  }
  return chars.join('');
}

/// Extrae los aliases de las CTEs (`WITH alias AS (...), alias2 AS (...)`).
/// Solo procesa si el SQL empieza con WITH. Walk balanceado de parens
/// para saltar cuerpos de CTE. Devuelve set lowercase, sin prefix.
export function extractCteAliases(sql: string): Set<string> {
  const out = new Set<string>();
  const trimmed = sql.trimStart();
  if (!/^with\b/i.test(trimmed)) return out;

  // Avanzar tras WITH y (opcional) RECURSIVE.
  let i = sql.indexOf(trimmed[0]!);
  i += 4; // 'with'.length
  // saltar RECURSIVE
  const recRe = /\s+recursive\b/iy;
  recRe.lastIndex = i;
  const recMatch = recRe.exec(sql);
  if (recMatch) i = recRe.lastIndex;

  while (i < sql.length) {
    // skip whitespace + comma
    while (i < sql.length && /[\s,]/.test(sql[i]!)) i++;
    // capturar alias
    const aliasMatch = sql.slice(i).match(/^"?([a-z_][\w]*)"?/i);
    if (!aliasMatch) break;
    out.add(aliasMatch[1]!.toLowerCase());
    i += aliasMatch[0].length;
    // saltar opcional (col1, col2, ...) — paren balanceado
    while (i < sql.length && /\s/.test(sql[i]!)) i++;
    if (sql[i] === '(') {
      i = skipBalancedParens(sql, i);
    }
    // saltar AS [MATERIALIZED|NOT MATERIALIZED]
    while (i < sql.length && /\s/.test(sql[i]!)) i++;
    if (!/^as\b/i.test(sql.slice(i))) break;
    i += 2; // 'as'
    while (i < sql.length && /\s/.test(sql[i]!)) i++;
    if (/^materialized\b/i.test(sql.slice(i))) i += 'materialized'.length;
    else if (/^not\s+materialized\b/i.test(sql.slice(i))) {
      i += sql.slice(i).match(/^not\s+materialized/i)![0].length;
    }
    while (i < sql.length && /\s/.test(sql[i]!)) i++;
    if (sql[i] !== '(') break;
    i = skipBalancedParens(sql, i);
    // posible coma → siguiente CTE; o terminamos.
    while (i < sql.length && /\s/.test(sql[i]!)) i++;
    if (sql[i] === ',') {
      i++;
      continue;
    }
    break;
  }
  return out;
}

function skipBalancedParens(sql: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  while (i < sql.length && depth > 0) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    i++;
  }
  return i;
}

/// Extrae todas las referencias a tablas (FROM/JOIN/INTO/UPDATE/USING +
/// ONLY opcional + qualified `schema.table`). Devuelve identifiers
/// lowercase, sin schema prefix, sin quotes. Set para deduplicar.
export function extractTableRefs(sql: string): Set<string> {
  const out = new Set<string>();
  // Patrón: keyword-de-tabla seguido de ONLY opcional y luego identifier
  // (posiblemente qualified). Capturamos el último segmento.
  // - `FROM <ident>` / `FROM ONLY <ident>` / `FROM "schema"."tbl"` / `FROM schema.tbl`
  // - `JOIN <ident>` (cualquier tipo de join — left/right/inner/cross/lateral)
  // - `INTO <ident>` (INSERT INTO <tbl>)
  // - `UPDATE <ident>` / `UPDATE ONLY <ident>` (top-level del statement)
  // - `USING <ident>` (USING en DELETE; USING también aparece en CREATE
  //    INDEX y JOIN ON USING (col), pero esos casos están filtrados:
  //    DDL ya rechazada arriba; JOIN USING se desambigua porque viene
  //    seguido de `(` (paren), no de un ident plain).
  const KW = '(?:from|join|into|update|using)';
  const QUALIFIED_IDENT = `(?:"?[a-z_][\\w]*"?\\s*\\.\\s*)?"?([a-z_][\\w]*)"?`;
  const re = new RegExp(`\\b${KW}\\b\\s+(?:only\\s+)?${QUALIFIED_IDENT}`, 'gi');

  for (const match of sql.matchAll(re)) {
    const ident = match[1];
    if (!ident) continue;
    const kw = match[0].slice(0, match[0].search(/\s/)).toLowerCase();

    // alpha.56: filtrar el caso `... ON CONFLICT (cols) DO UPDATE SET ...`.
    // El extractor matchea `UPDATE SET` y captura `set` como ident — false
    // positive porque `SET` es la cláusula de assignment, no una tabla.
    // PostgreSQL UPSERT estándar: `INSERT ... ON CONFLICT (...) DO UPDATE SET col=...`.
    // Detección: si la keyword es `update` y el token anterior es `do`,
    // skipear este match (es parte del DO UPDATE, no un UPDATE top-level).
    if (kw === 'update') {
      const startIdx = match.index ?? 0;
      // Mirar atrás hasta encontrar el token previo (saltando whitespace).
      let k = startIdx - 1;
      while (k >= 0 && /\s/.test(sql[k]!)) k--;
      // Capturar palabra anterior.
      let prevEnd = k + 1;
      while (k >= 0 && /[a-z_]/i.test(sql[k]!)) k--;
      const prev = sql.slice(k + 1, prevEnd).toLowerCase();
      if (prev === 'do') {
        // DO UPDATE SET — no es table ref. El INSERT INTO de la misma
        // statement ya añadió la table real al set.
        continue;
      }
    }

    // Filtrar el caso `JOIN USING (col)` — cuando la kw es USING y
    // viene seguido de `(`, no es una table ref. También filtra
    // `LATERAL <subquery>` que matchea pero no es tabla.
    const matchEnd = (match.index ?? 0) + match[0].length;
    // Saltar whitespace después del match.
    let j = matchEnd;
    while (j < sql.length && /\s/.test(sql[j]!)) j++;
    if (sql[j] === '(') {
      // El "ident" capturado es en realidad parte de algo como
      // `JOIN USING (col)` o función — descartar.
      // PERO ojo: `INSERT INTO mod_x_t (col1, col2) VALUES ...` también
      // matchea con `(` después. Ese SÍ es una table ref válida. Para
      // distinguir: si la keyword es `into` o `update`, el `(` de
      // después es la lista de columnas — es VÁLIDO. Si es `using`, el
      // `(` indica USING(col) que NO es una table ref.
      if (kw === 'using') continue;
      // for from/join, table-with-paren no es una sintaxis válida de PG
      // — las funciones table-valued usan `from func(args)` pero esas
      // ya las enmascaramos en `maskFromFunctions`. Si llegó hasta acá,
      // probablemente es algo no estándar — descartamos por seguridad.
      if (kw === 'from' || kw === 'join') continue;
    }
    out.add(ident.toLowerCase());
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clamps de opts
// ─────────────────────────────────────────────────────────────────────────────

function clampTimeout(requested: number | undefined): number {
  const v = requested ?? DB_DEFAULTS.TIMEOUT_MS;
  if (!Number.isFinite(v) || v <= 0) return DB_DEFAULTS.TIMEOUT_MS;
  if (v > DB_DEFAULTS.MAX_TIMEOUT_MS) return DB_DEFAULTS.MAX_TIMEOUT_MS;
  return Math.floor(v);
}

function clampMaxRows(requested: number | undefined): number {
  const v = requested ?? DB_DEFAULTS.MAX_ROWS;
  if (!Number.isFinite(v) || v <= 0) return DB_DEFAULTS.MAX_ROWS;
  if (v > DB_DEFAULTS.MAX_ROWS_HARD_CAP) return DB_DEFAULTS.MAX_ROWS_HARD_CAP;
  return Math.floor(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Error mapping
// ─────────────────────────────────────────────────────────────────────────────

/// Mapea un error de Prisma/Postgres a un `DbError` con código tipado.
/// Estrategia: SQLSTATE > Prisma code > parsing del mensaje. Lo último
/// es brittle pero práctico — Prisma para `$queryRawUnsafe` no expone
/// SQLSTATE de forma uniforme entre versiones, así que el mensaje es la
/// señal más confiable para muchos casos.
export function mapPostgresError(err: unknown, timeoutMs: number): DbError {
  if (err instanceof DbError) return err;
  const e = err as {
    code?: string;
    meta?: { code?: string };
    message?: string;
  };
  const message = e?.message ?? String(err);

  // SQLSTATE (cuando Prisma lo expone via meta.code)
  const sqlState = e?.meta?.code;
  if (sqlState === '23505') return new DbError('DB_UNIQUE_VIOLATION', message, err);
  if (sqlState === '23503') return new DbError('DB_FK_VIOLATION', message, err);
  if (sqlState === '23502') return new DbError('DB_NOT_NULL', message, err);
  if (sqlState === '23514') return new DbError('DB_CHECK_VIOLATION', message, err);
  if (sqlState === '57014') return new DbError('DB_TIMEOUT', `Query excedió ${timeoutMs}ms.`, err);

  // Prisma error code (también útil — algunos casos vienen como P-codes)
  if (e?.code === 'P2002') return new DbError('DB_UNIQUE_VIOLATION', message, err);
  if (e?.code === 'P2003') return new DbError('DB_FK_VIOLATION', message, err);
  if (e?.code === 'P2011') return new DbError('DB_NOT_NULL', message, err);

  // Fallback: parseo del mensaje. Postgres es bastante consistente con
  // los strings — hace 20+ años que los mensajes son estables.
  const lower = message.toLowerCase();
  if (
    lower.includes('canceling statement due to statement timeout') ||
    lower.includes('query_canceled')
  ) {
    return new DbError('DB_TIMEOUT', `Query excedió ${timeoutMs}ms.`, err);
  }
  if (lower.includes('duplicate key value') || lower.includes('unique constraint')) {
    return new DbError('DB_UNIQUE_VIOLATION', message, err);
  }
  if (lower.includes('foreign key constraint')) {
    return new DbError('DB_FK_VIOLATION', message, err);
  }
  if (lower.includes('null value') && lower.includes('not-null')) {
    return new DbError('DB_NOT_NULL', message, err);
  }
  if (lower.includes('check constraint')) {
    return new DbError('DB_CHECK_VIOLATION', message, err);
  }
  return new DbError('DB_NETWORK', message, err);
}
