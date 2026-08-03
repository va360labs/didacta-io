/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@didacta/database';
import { Parser } from 'node-sql-parser/build/postgresql';
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
 * SQL guard (F4, alpha.97): el extractor de table refs usa el AST real de
 * `node-sql-parser` (dialecto `postgresql`, subpath `build/postgresql` para
 * no cargar el resto de dialectos — ~300 KB vs. los ~4 MB de
 * `pg-query-emscripten`, que se descartó en su momento por eso). Reemplaza
 * al validador anterior basado en regex + balanced-paren tracking, que
 * tenía falsos negativos reales y explotables: listas FROM separadas por
 * coma (`FROM mod_x_a, "user"`) y subqueries anidadas dentro de
 * extract/substring/trim/overlay/position (`substring(x FROM (SELECT ...
 * FROM "user") FOR 1)`) pasaban sin disparar `DB_PREFIX_VIOLATION` porque
 * el regex solo miraba el identifier pegado a FROM/JOIN/INTO/UPDATE/USING,
 * no la estructura real del árbol. El parser real resuelve todo eso de
 * forma nativa (joins implícitos, subqueries a cualquier profundidad,
 * UNION, alias con y sin AS, ON CONFLICT DO UPDATE SET, RETURNING).
 *
 * La gramática `postgresql` de la librería no cubre 100% del dialecto real
 * — antes de invocar `astify`/`tableList` se normaliza una COPIA del SQL
 * (`normalizeSqlForParsing`, nunca la que se ejecuta contra Postgres) para
 * sortear 4 huecos verificados: `ONLY` mal interpretado como nombre de
 * tabla, `$N::tipo` (cast de un parámetro posicional) fuera de una lista
 * SELECT top-level, la sintaxis SQL-standard de `SUBSTRING(x FROM a FOR b)`
 * / `OVERLAY(x PLACING y FROM a FOR b)`, y `VALUES (...)` como statement
 * top-level (sin INSERT). Cada normalización es sintáctica y con scope
 * acotado (nunca toca contenido dentro de parens anidados más profundos,
 * así que una subquery escondida ahí adentro sigue siendo detectada).
 * Statement kinds no soportados (DDL, COPY, DO, SET ROLE) se rechazan por
 * la keyword inicial ANTES de invocar el parser — ni falta que arranque.
 *
 * Limitación conocida que sigue vigente (no es objetivo de F4, es un guard
 * de tablas, no de funciones): llamadas a funciones peligrosas sin FROM
 * (`SELECT set_config(...)`, `SELECT pg_sleep(...)`) no tienen table ref
 * que chequear, así que pasan el guard igual que en el validador anterior.
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

/// Funciones PG con sintaxis SQL-standard (`FROM`/`FOR`/`PLACING` como
/// separador de argumentos, no coma) que la gramática `postgresql` de
/// `node-sql-parser` 5.4 NO reconoce — verificado empíricamente. `extract`,
/// `trim(... FROM ...)` y `position(... IN ...)` SÍ parsean nativos (no
/// necesitan normalización); solo `substring`/`overlay` necesitan reescribir
/// su `FROM`/`FOR`/`PLACING` de nivel superior a comas antes de parsear
/// (ver `rewriteSqlStandardFnSyntax`).
const FROM_FOR_PLACING_FN_NAMES = ['substring', 'overlay'] as const;

/// Instancia única del parser — sin estado mutable entre llamadas, seguro
/// de reusar (Node.js es single-threaded por request).
const sqlParser = new Parser();
const PARSE_OPT = { database: 'postgresql' } as const;

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
    return new ScopedSandboxedDb(this.prisma, this.logger, moduleName, tablePrefix, tenantId, null);
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
///   2. UN solo statement (según el AST real — no un conteo de `;`).
///   3. Statement kind ∈ {select, insert, update, delete, with, values}.
///   4. Todas las refs a tablas del AST real (FROM/JOIN/INTO/UPDATE/USING,
///      joins implícitos por coma, subqueries a cualquier profundidad)
///      empiezan con `tablePrefix`. CTE aliases (de `WITH alias AS (...)`,
///      leídos del AST, no de un parser de CTEs a mano) se excluyen.
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

  // El statement kind se detecta por keyword inicial ANTES de invocar el
  // parser — barato, y filtra DDL/COPY/DO/SET que la gramática de
  // node-sql-parser ni siquiera intenta parsear (fail-fast real).
  const stripped = stripCommentsAndStrings(sql);
  const kind = detectStatementKind(stripped);
  if (!ALLOWED_KINDS.has(kind)) {
    throw new DbError(
      'DB_INVALID_SQL',
      `Statement kind "${kind}" no permitido en runtime. ctx.db acepta solo SELECT/INSERT/UPDATE/DELETE/WITH/VALUES — DDL (CREATE/DROP/ALTER/TRUNCATE) viene de prisma/migrations/*.sql aplicadas en install (ADR-013).`,
    );
  }

  const parseSql = normalizeSqlForParsing(sql, kind);

  let ast: unknown;
  let tableRefs: Set<string>;
  try {
    ast = sqlParser.astify(parseSql, PARSE_OPT);
    tableRefs = extractTableRefsFromNormalized(parseSql);
  } catch (err) {
    throw new DbError(
      'DB_INVALID_SQL',
      `SQL no pudo ser interpretado por el parser (sintaxis no reconocida): ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    );
  }

  const stmts = Array.isArray(ast) ? ast : [ast];
  if (stmts.length !== 1) {
    throw new DbError(
      'DB_INVALID_SQL',
      'Multi-statement SQL no permitido. ctx.db ejecuta UN solo statement por llamada — para varios, usá ctx.db.transaction(tx => …).',
    );
  }

  const cteAliases = new Set<string>();
  collectCteAliasNames(stmts[0], cteAliases);

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
/// length). Usado solo para detectar el statement kind por keyword
/// inicial — el parseo real de tablas lo hace el AST, que ya resuelve
/// comentarios/strings con su propio tokenizer.
export function stripCommentsAndStrings(sql: string): string {
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  out = out.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));

  const chars: string[] = [...out];
  let inStr = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!inStr) {
      if (ch === "'") inStr = true;
      continue;
    }
    if (ch === "'") {
      if (chars[i + 1] === "'") {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 1;
        continue;
      }
      inStr = false;
      continue;
    }
    chars[i] = ' ';
  }
  return chars.join('');
}

/// Detecta el statement kind por la primera keyword no-blanca. Devuelve
/// la keyword en lowercase, o `'unknown'` si no matchea ninguna conocida.
/// No es el componente de seguridad del guard (eso es la extracción de
/// table refs vía AST) — solo clasifica para el allowlist/fail-fast.
export function detectStatementKind(sql: string): string {
  const m = sql.trimStart().match(/^([a-z]+)/i);
  return m ? m[1]!.toLowerCase() : 'unknown';
}

/// Normaliza una COPIA del SQL para que la gramática `postgresql` de
/// node-sql-parser pueda parsearla, sin alterar lo que efectivamente se
/// ejecuta contra Postgres (`validateSql` solo usa el resultado para
/// analizar estructura, nunca lo pasa a `$queryRawUnsafe`). Cada
/// normalización es sintáctica y de scope acotado — ver comentario de
/// cabecera del archivo para el detalle de cada hueco cubierto.
export function normalizeSqlForParsing(sql: string, kind: string): string {
  let out = stripOnlyKeyword(sql);
  out = wrapPlaceholderCasts(out);
  out = rewriteSqlStandardFnSyntax(out);
  if (kind === 'values') {
    // `VALUES (...)` como statement top-level no es soportado por la
    // gramática. Envolver en `SELECT * FROM (...)` preserva 100% del
    // contenido original (incluida cualquier subquery anidada dentro de
    // una fila) para que el AST la siga viendo — solo cambia si un SELECT
    // "envoltorio" es válido, no qué tablas son alcanzables.
    out = `SELECT * FROM (${out}) AS __sandboxed_values_shim(__c)`;
  }
  return out;
}

/// `FROM ONLY tabla` / `UPDATE ONLY tabla` es sintaxis real de Postgres
/// (excluye tablas hijas de partición) que la gramática de
/// node-sql-parser NO reconoce — interpreta "ONLY" como el nombre de la
/// tabla y lo que sigue como su alias, escondiendo la tabla real del
/// extractor. Quitar la keyword `ONLY` dejando el identifier real intacto
/// no cambia qué tabla se referencia para efectos del guard.
export function stripOnlyKeyword(sql: string): string {
  return sql.replace(/\b(FROM|UPDATE)\s+ONLY\s+/gi, '$1 ');
}

/// `$N::tipo` (cast de un parámetro posicional) rompe la gramática de
/// node-sql-parser en casi cualquier posición salvo el tope de una lista
/// SELECT (`SELECT $1::uuid` parsea; `WHERE x = $1::uuid` no) — verificado
/// empíricamente contra los ~36 queries reales de mod.migrator-learndash,
/// que usan este patrón en casi todas sus queries. Envolver el parámetro
/// en parens (`($1)::uuid`) es sintácticamente equivalente y sí parsea en
/// todas las posiciones probadas.
export function wrapPlaceholderCasts(sql: string): string {
  return sql.replace(/\$(\d+)(?=\s*::)/g, '($&)');
}

/// `SUBSTRING(x FROM a [FOR b])` y `OVERLAY(x PLACING y FROM a [FOR b])`
/// son sintaxis SQL-standard que la gramática NO soporta (a diferencia de
/// `extract(... FROM ...)`, `trim(... FROM ...)` y `position(... IN ...)`,
/// que sí parsean nativos). Se reescribe a la forma equivalente por comas
/// (`substring(x, a, b)`) SOLO en el nivel superior de los argumentos de
/// la función — cualquier paren anidado (una subquery escondida como
/// argumento, p. ej. `substring(x FROM (SELECT secret FROM "user") FOR 1)`)
/// se preserva byte a byte, así que sigue siendo visible para el AST real.
export function rewriteSqlStandardFnSyntax(sql: string): string {
  const FN_REGEX = new RegExp(`\\b(?:${FROM_FOR_PLACING_FN_NAMES.join('|')})\\s*\\(`, 'gi');
  const matches = [...sql.matchAll(FN_REGEX)];
  if (matches.length === 0) return sql;

  let result = '';
  let idx = 0;
  for (const match of matches) {
    const start = match.index;
    if (typeof start !== 'number' || start < idx) continue;
    const openIdx = sql.indexOf('(', start);
    if (openIdx === -1) continue;

    result += sql.slice(idx, openIdx + 1);
    let depth = 1;
    let i = openIdx + 1;
    let rebuilt = '';
    while (i < sql.length && depth > 0) {
      const ch = sql[i];
      if (ch === '(') {
        depth++;
        rebuilt += ch;
        i++;
        continue;
      }
      if (ch === ')') {
        depth--;
        if (depth === 0) break;
        rebuilt += ch;
        i++;
        continue;
      }
      if (depth === 1) {
        const kwMatch = sql.slice(i).match(/^(FROM|FOR|PLACING)\b/i);
        if (kwMatch) {
          rebuilt += ',';
          i += kwMatch[0].length;
          continue;
        }
      }
      rebuilt += ch;
      i++;
    }
    result += rebuilt + ')';
    idx = i + 1;
  }
  result += sql.slice(idx);
  return result;
}

/// Recolecta recursivamente los nombres de alias de CTEs (`WITH alias AS
/// (...)`) leyendo la estructura real del AST (`node.with[].name.value`)
/// en cualquier nivel de anidamiento — reemplaza al parser de CTEs a mano
/// del validador anterior (regex + balanced-paren tracking).
export function collectCteAliasNames(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectCteAliasNames(item, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.with)) {
    for (const cte of obj.with) {
      const name = (cte as { name?: { value?: unknown } } | null)?.name?.value;
      if (typeof name === 'string') out.add(name.toLowerCase());
    }
  }
  for (const value of Object.values(obj)) {
    collectCteAliasNames(value, out);
  }
}

/// Extrae todas las referencias a tablas del SQL ya normalizado
/// (`normalizeSqlForParsing`) usando `Parser.tableList()` — el AST real
/// resuelve FROM/JOIN/INTO/UPDATE/USING, listas separadas por coma
/// (joins implícitos), UNION y subqueries a cualquier profundidad.
/// Devuelve identifiers lowercase, sin schema/db prefix. Los aliases de
/// CTE NO se excluyen acá — eso lo hace `validateSql` con
/// `collectCteAliasNames`, porque `tableList()` no distingue un alias de
/// CTE de una tabla real (ambos aparecen con el mismo formato).
export function extractTableRefsFromNormalized(normalizedSql: string): Set<string> {
  const raw = sqlParser.tableList(normalizedSql, PARSE_OPT);
  const out = new Set<string>();
  for (const entry of raw) {
    const segments = entry.split('::');
    const table = segments[segments.length - 1];
    if (table) out.add(table.toLowerCase());
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
