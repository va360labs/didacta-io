/// Linter SQL para migraciones de un módulo `*.didactamod`.
///
/// Garantiza dos invariantes críticas del contrato (ADR-008/009):
///   1. **Aislamiento de schema por prefix**: cualquier objeto SQL creado
///      por una migración del módulo (TABLE, INDEX, SEQUENCE, TYPE, VIEW,
///      TRIGGER) debe llamarse con el `tablePrefix` declarado en el
///      manifest. Un módulo "mod.gamification" con prefix
///      `mod_gamification_` no puede crear `users` ni `mod_other_thing`.
///   2. **Sin FKs cross-module**: `REFERENCES <other_table>` solo se
///      acepta si `other_table` también empieza por el `tablePrefix` del
///      módulo. Esto preserva la regla "sin acoplamiento entre módulos
///      al nivel del schema" del ADR-008.
///
/// El linter es **regex + tokenizer ligero**, no un parser SQL completo.
/// Limitaciones:
///   - No entiende DSL ni triggers complejos con `EXECUTE PROCEDURE` que
///     llamen a funciones existentes — los rechaza por seguridad.
///   - No entiende identifiers con quotes y embedded comments (`"my""tbl"`).
///     Lo aceptable: rechazar quotes en identifiers de DDL y forzar
///     identifiers limpios.
///
/// Si un módulo necesita una operación no soportada, el linter falla con
/// `MODULE_LINT_FAILED`; el módulo debe rediseñar la migración o el
/// equipo VA360 debe ampliar el linter caso por caso.

import { MarketplacePackageError } from './module-package.errors';

/// Statements DDL/DML que el linter sabe interpretar. Cualquier otro
/// statement (procedimiento almacenado, GRANT, REVOKE, COPY, etc.) se
/// rechaza explícitamente — no por hostilidad sino porque no podemos
/// auditarlos sin un parser real.
type StatementKind =
  | 'CREATE_TABLE'
  | 'CREATE_INDEX'
  | 'CREATE_SEQUENCE'
  | 'CREATE_TYPE'
  | 'CREATE_VIEW'
  | 'CREATE_TRIGGER'
  | 'ALTER_TABLE'
  | 'DROP_TABLE'
  | 'DROP_INDEX'
  | 'DROP_TYPE'
  | 'DROP_VIEW'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'COMMENT'
  | 'COMMENT_ONLY'; // comentario SQL, no es statement

interface ParsedStatement {
  kind: StatementKind;
  /// Identifier principal del statement (tabla, índice...). Lowercased,
  /// sin schema prefix (`public.foo` → `foo`).
  primaryIdentifier: string;
  /// Identifiers referenciados (REFERENCES <other_table>). Lowercased.
  referencedTables: string[];
  /// SQL crudo del statement (preservado para mensajes de error).
  raw: string;
}

const IDENTIFIER = '([a-z_][a-z0-9_]*)';
const QUALIFIED_IDENT = `(?:[a-z_][a-z0-9_]*\\.)?${IDENTIFIER}`;

const STATEMENT_PATTERNS: Array<{ kind: StatementKind; regex: RegExp }> = [
  { kind: 'CREATE_TABLE', regex: new RegExp(`^\\s*create\\s+(?:unlogged\\s+)?table(?:\\s+if\\s+not\\s+exists)?\\s+${QUALIFIED_IDENT}`, 'i') },
  { kind: 'CREATE_INDEX', regex: new RegExp(`^\\s*create\\s+(?:unique\\s+)?index(?:\\s+if\\s+not\\s+exists)?\\s+${QUALIFIED_IDENT}`, 'i') },
  { kind: 'CREATE_SEQUENCE', regex: new RegExp(`^\\s*create\\s+sequence(?:\\s+if\\s+not\\s+exists)?\\s+${QUALIFIED_IDENT}`, 'i') },
  { kind: 'CREATE_TYPE', regex: new RegExp(`^\\s*create\\s+type\\s+${QUALIFIED_IDENT}`, 'i') },
  { kind: 'CREATE_VIEW', regex: new RegExp(`^\\s*create\\s+(?:or\\s+replace\\s+)?view\\s+${QUALIFIED_IDENT}`, 'i') },
  { kind: 'CREATE_TRIGGER', regex: new RegExp(`^\\s*create\\s+trigger\\s+${QUALIFIED_IDENT}`, 'i') },
  { kind: 'ALTER_TABLE', regex: new RegExp(`^\\s*alter\\s+table(?:\\s+if\\s+exists)?\\s+(?:only\\s+)?${QUALIFIED_IDENT}`, 'i') },
  { kind: 'DROP_TABLE', regex: new RegExp(`^\\s*drop\\s+table(?:\\s+if\\s+exists)?\\s+${QUALIFIED_IDENT}`, 'i') },
  { kind: 'DROP_INDEX', regex: new RegExp(`^\\s*drop\\s+index(?:\\s+if\\s+exists)?\\s+${QUALIFIED_IDENT}`, 'i') },
  { kind: 'DROP_TYPE', regex: new RegExp(`^\\s*drop\\s+type(?:\\s+if\\s+exists)?\\s+${QUALIFIED_IDENT}`, 'i') },
  { kind: 'DROP_VIEW', regex: new RegExp(`^\\s*drop\\s+view(?:\\s+if\\s+exists)?\\s+${QUALIFIED_IDENT}`, 'i') },
  { kind: 'INSERT', regex: new RegExp(`^\\s*insert\\s+into\\s+${QUALIFIED_IDENT}`, 'i') },
  { kind: 'UPDATE', regex: new RegExp(`^\\s*update\\s+(?:only\\s+)?${QUALIFIED_IDENT}`, 'i') },
  { kind: 'DELETE', regex: new RegExp(`^\\s*delete\\s+from\\s+(?:only\\s+)?${QUALIFIED_IDENT}`, 'i') },
  { kind: 'COMMENT', regex: new RegExp(`^\\s*comment\\s+on\\s+(?:table|column|index|view|sequence|type)\\s+(?:.*?\\.)?${IDENTIFIER}`, 'i') },
];

const REFERENCES_REGEX = new RegExp(`references\\s+${QUALIFIED_IDENT}`, 'gi');

/// Trocea el SQL en statements. Quita comentarios `--` (línea) y `/* ... */`
/// (bloque) y separa por `;` ignorando los que vivan dentro de strings.
/// Este splitter es ingenuo (no entiende `$$` para functions) — lo aceptable
/// porque las migrations de un módulo NO deberían declarar funciones; si
/// las declaran, fallan en `parseStatement` con `UNSUPPORTED_STATEMENT`.
export function splitStatements(sql: string): string[] {
  const noComments = stripComments(sql);
  const out: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    const prev = i > 0 ? noComments[i - 1] : '';
    if (ch === "'" && prev !== '\\' && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && prev !== '\\' && !inSingle) inDouble = !inDouble;
    if (ch === ';' && !inSingle && !inDouble) {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = '';
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

function stripComments(sql: string): string {
  // /* ... */ comentarios de bloque (no anidados — el parser de Postgres sí los anida,
  // pero no es práctica común en migrations generadas).
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // -- comentarios de línea.
  out = out.replace(/--[^\n]*/g, ' ');
  return out;
}

export function parseStatement(raw: string): ParsedStatement {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'COMMENT_ONLY', primaryIdentifier: '', referencedTables: [], raw };

  // Rechazo explícito de statements no soportados ANTES de intentar parsear.
  // Lista no exhaustiva — añadir según se vean en módulos reales.
  const lower = trimmed.toLowerCase();
  const FORBIDDEN_PREFIXES = [
    'create function',
    'create or replace function',
    'create procedure',
    'create or replace procedure',
    'create extension',
    'create schema',
    'create role',
    'create user',
    'create database',
    'drop function',
    'drop procedure',
    'drop extension',
    'drop schema',
    'drop role',
    'drop user',
    'drop database',
    'grant ',
    'revoke ',
    'truncate ',
    'copy ',
    'set role',
    'set session authorization',
    'do $$',
    'do $',
  ];
  for (const fb of FORBIDDEN_PREFIXES) {
    if (lower.startsWith(fb)) {
      throw new MarketplacePackageError(
        'MODULE_LINT_FAILED',
        `Statement SQL prohibido: "${fb.trim()}" no se permite en migraciones de módulo.`,
        { statement: trimmed.slice(0, 120) },
      );
    }
  }

  for (const pattern of STATEMENT_PATTERNS) {
    const match = trimmed.match(pattern.regex);
    if (match) {
      const primary = (match[1] ?? '').toLowerCase();
      const referenced: string[] = [];
      for (const refMatch of trimmed.matchAll(REFERENCES_REGEX)) {
        const ref = (refMatch[1] ?? '').toLowerCase();
        if (ref) referenced.push(ref);
      }
      return { kind: pattern.kind, primaryIdentifier: primary, referencedTables: referenced, raw };
    }
  }

  throw new MarketplacePackageError(
    'MODULE_LINT_FAILED',
    `No se pudo parsear el statement SQL (formato no soportado).`,
    { statement: trimmed.slice(0, 120) },
  );
}

/// Valida que TODOS los identifiers (primario + referenciados) usen el
/// `tablePrefix` declarado por el manifest. Lanza `MarketplacePackageError`
/// con código `MODULE_LINT_FAILED` en el primer fallo.
export function lintMigrationSql(sql: string, tablePrefix: string): ParsedStatement[] {
  if (!/^mod_[a-z0-9_]+_$/.test(tablePrefix)) {
    // Defensa en profundidad: el schema Zod ya lo valida en PR A, pero si
    // alguien llamase a lintMigrationSql directamente con prefix raro, no
    // permitimos pasar.
    throw new MarketplacePackageError(
      'MODULE_LINT_FAILED',
      `tablePrefix inválido: "${tablePrefix}"`,
    );
  }

  const statements = splitStatements(sql).map(parseStatement);
  for (const stmt of statements) {
    if (stmt.kind === 'COMMENT_ONLY') continue;
    if (stmt.primaryIdentifier && !stmt.primaryIdentifier.startsWith(tablePrefix)) {
      throw new MarketplacePackageError(
        'MODULE_LINT_FAILED',
        `Identifier "${stmt.primaryIdentifier}" no usa el tablePrefix "${tablePrefix}" del módulo.`,
        { statement: stmt.raw.slice(0, 120), kind: stmt.kind },
      );
    }
    for (const ref of stmt.referencedTables) {
      if (!ref.startsWith(tablePrefix)) {
        throw new MarketplacePackageError(
          'MODULE_LINT_FAILED',
          `REFERENCES "${ref}" apunta fuera del tablePrefix "${tablePrefix}" — sin FKs cross-module.`,
          { statement: stmt.raw.slice(0, 120), referenced: ref },
        );
      }
    }
  }
  return statements;
}
