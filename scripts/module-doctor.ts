#!/usr/bin/env tsx
/**
 * module-doctor.ts — Validador del contrato de módulo Didacta
 *
 * Verifica para cada módulo en `modules/<nombre>/`:
 *   - module.json existe y es JSON válido.
 *   - Campos obligatorios presentes (name, version, edition, tablePrefix, apiNamespace, ...).
 *   - Si edition === 'enterprise': requiredLicenseFeature presente.
 *   - tablePrefix con formato correcto (`mod_<nombre>_`).
 *   - apiNamespace con formato correcto (`/modules/<nombre>`).
 *   - README.md existe y contiene secciones obligatorias.
 *   - prisma/schema.prisma con todas las tablas con prefijo correcto (best-effort regex).
 *   - module.json COHERENTE con src/manifest.ts (el manifest runtime que parsea
 *     el registry): version, coreVersionRequired, tablePrefix, apiNamespace,
 *     permissions y eventos emitidos deben coincidir. Son dos vistas del mismo
 *     contrato y divergían en silencio (permisos `:` vs `.`, eventos sin
 *     declarar, versiones desincronizadas).
 *
 * Uso:
 *   pnpm tsx scripts/module-doctor.ts                  # valida todos
 *   pnpm tsx scripts/module-doctor.ts mod.courses     # valida uno
 *   pnpm tsx scripts/module-doctor.ts --all           # explícito
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(process.cwd());
const MODULES_DIR = resolve(ROOT, 'modules');

type Severity = 'error' | 'warning';
type Issue = { module: string; severity: Severity; field?: string; message: string };

const REQUIRED_TOP_FIELDS = [
  'name',
  'version',
  'edition',
  'coreVersionRequired',
  'tablePrefix',
  'apiNamespace',
];

const REQUIRED_README_SECTIONS = [
  /^#\s+`?mod\./m, // título con `mod.`
  /^##\s+(Edici[oó]n|Edition)/m,
  /^##\s+(Estado|Status)/m,
  /^##\s+(Resumen funcional|Summary)/m,
  /^##\s+(Modelo de datos|Data model)/m,
  /^##\s+(API p[uú]blica|Public API)/m,
  /^##\s+(Eventos|Events)/m,
  /^##\s+(Configuraci[oó]n|Configuration)/m,
  /^##\s+(Dependencias|Dependencies)/m,
];

function listModules(): string[] {
  if (!existsSync(MODULES_DIR)) return [];
  return readdirSync(MODULES_DIR).filter((name) => {
    const p = join(MODULES_DIR, name);
    return statSync(p).isDirectory() && existsSync(join(p, 'module.json'));
  });
}

function validateModule(moduleDir: string): Issue[] {
  const issues: Issue[] = [];
  const name = moduleDir;
  const dirPath = join(MODULES_DIR, moduleDir);
  const manifestPath = join(dirPath, 'module.json');
  const readmePath = join(dirPath, 'README.md');
  const schemaPath = join(dirPath, 'src', 'prisma', 'schema.prisma');

  // module.json
  let manifest: any = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err: any) {
    issues.push({
      module: name,
      severity: 'error',
      field: 'module.json',
      message: `Invalid JSON: ${err.message}`,
    });
    return issues;
  }

  // Campos requeridos
  for (const f of REQUIRED_TOP_FIELDS) {
    if (manifest[f] === undefined || manifest[f] === null) {
      issues.push({
        module: name,
        severity: 'error',
        field: f,
        message: `Missing required field "${f}"`,
      });
    }
  }

  // edition
  if (manifest.edition && !['community', 'enterprise'].includes(manifest.edition)) {
    issues.push({
      module: name,
      severity: 'error',
      field: 'edition',
      message: `Invalid edition "${manifest.edition}". Must be "community" or "enterprise".`,
    });
  }
  if (manifest.edition === 'enterprise' && !manifest.requiredLicenseFeature) {
    issues.push({
      module: name,
      severity: 'error',
      field: 'requiredLicenseFeature',
      message: `EE module must declare "requiredLicenseFeature".`,
    });
  }

  // tablePrefix
  if (manifest.tablePrefix) {
    // Espera mod_<kebab>_ — kebab del nombre sin el prefijo "mod."
    const expected = `mod_${(manifest.name || '').replace(/^mod\./, '').replace(/-/g, '_')}_`;
    if (manifest.tablePrefix !== expected) {
      issues.push({
        module: name,
        severity: 'error',
        field: 'tablePrefix',
        message: `tablePrefix is "${manifest.tablePrefix}", expected "${expected}".`,
      });
    }
  }

  // apiNamespace
  if (manifest.apiNamespace) {
    const expected = `/modules/${(manifest.name || '').replace(/^mod\./, '').replace(/\.ee$/, '')}`;
    if (!manifest.apiNamespace.startsWith('/modules/')) {
      issues.push({
        module: name,
        severity: 'error',
        field: 'apiNamespace',
        message: `apiNamespace must start with "/modules/", got "${manifest.apiNamespace}".`,
      });
    } else if (manifest.apiNamespace !== expected) {
      issues.push({
        module: name,
        severity: 'warning',
        field: 'apiNamespace',
        message: `apiNamespace "${manifest.apiNamespace}" does not match conventional "${expected}".`,
      });
    }
  }

  // eventsEmitted / eventsConsumed deben ser arrays
  for (const ek of ['eventsEmitted', 'eventsConsumed', 'permissions']) {
    if (manifest[ek] && !Array.isArray(manifest[ek])) {
      issues.push({
        module: name,
        severity: 'error',
        field: ek,
        message: `${ek} must be an array.`,
      });
    }
  }

  // README
  if (!existsSync(readmePath)) {
    issues.push({
      module: name,
      severity: 'error',
      field: 'README.md',
      message: `Missing README.md`,
    });
  } else {
    const readme = readFileSync(readmePath, 'utf8');
    for (const re of REQUIRED_README_SECTIONS) {
      if (!re.test(readme)) {
        issues.push({
          module: name,
          severity: 'warning',
          field: 'README.md',
          message: `README missing section matching ${re}`,
        });
      }
    }
  }

  // Coherencia module.json ↔ src/manifest.ts (contrato runtime)
  issues.push(...compareWithRuntimeManifest(name, dirPath, manifest));

  // Schema Prisma — verifica que las tablas usen el prefijo
  if (existsSync(schemaPath)) {
    const schema = readFileSync(schemaPath, 'utf8');
    const modelRegex = /^model\s+(\w+)\s*\{/gm;
    const mappedRegex = /@@map\s*\(\s*"([^"]+)"\s*\)/g;
    const tables: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = mappedRegex.exec(schema)) !== null) tables.push(m[1]);

    for (const table of tables) {
      if (manifest.tablePrefix && !table.startsWith(manifest.tablePrefix)) {
        issues.push({
          module: name,
          severity: 'error',
          field: 'schema.prisma',
          message: `Table "${table}" does not start with prefix "${manifest.tablePrefix}".`,
        });
      }
    }
  }

  return issues;
}

/**
 * Extrae un campo del objeto literal de `src/manifest.ts` por regex.
 * Los manifests runtime son literales formulaicos (string / array de strings),
 * así que no hace falta compilar TS para leerlos.
 */
function extractManifestString(src: string, field: string): string | undefined {
  const m = src.match(new RegExp(`\\b${field}:\\s*'([^']*)'`));
  return m ? m[1] : undefined;
}

function extractManifestStringArray(src: string, field: string): string[] | undefined {
  const m = src.match(new RegExp(`\\b${field}:\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) return undefined;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Normaliza entradas de permisos/eventos: string plano u objeto { name }. */
function namesOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => (typeof e === 'string' ? e : ((e as { name?: string })?.name ?? '')))
    .filter(Boolean);
}

function setDiff(a: string[], b: string[]): { missing: string[]; extra: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  return {
    missing: a.filter((x) => !sb.has(x)),
    extra: b.filter((x) => !sa.has(x)),
  };
}

/**
 * Compara module.json con src/manifest.ts (el manifest que parsea el registry
 * en runtime). Divergencias = error: son dos vistas del MISMO contrato.
 */
function compareWithRuntimeManifest(name: string, dirPath: string, json: any): Issue[] {
  const issues: Issue[] = [];
  const manifestTsPath = join(dirPath, 'src', 'manifest.ts');
  if (!existsSync(manifestTsPath)) return issues; // módulos sin manifest runtime (ZIP puro)
  const src = readFileSync(manifestTsPath, 'utf8');

  const err = (field: string, message: string) =>
    issues.push({ module: name, severity: 'error', field, message });

  // name: json corto `courses` ↔ ts `mod.courses` (los marketplace-style ya
  // llevan el prefijo en el json).
  const tsName = extractManifestString(src, 'name');
  const jsonShort = String(json.name ?? '').replace(/^mod\./, '');
  if (tsName && tsName !== `mod.${jsonShort}`) {
    err('name', `manifest.ts name "${tsName}" ≠ module.json name "mod.${jsonShort}".`);
  }

  for (const field of ['version', 'coreVersionRequired', 'tablePrefix', 'apiNamespace'] as const) {
    const tsVal = extractManifestString(src, field);
    const jsonVal = json[field];
    if (tsVal !== undefined && jsonVal !== undefined && tsVal !== jsonVal) {
      err(field, `module.json "${jsonVal}" ≠ src/manifest.ts "${tsVal}".`);
    }
  }

  const tsPerms = extractManifestStringArray(src, 'permissions');
  if (tsPerms) {
    const jsonPerms = namesOf(json.permissions);
    const { missing, extra } = setDiff(tsPerms, jsonPerms);
    if (missing.length > 0 || extra.length > 0) {
      err(
        'permissions',
        `permisos divergentes con src/manifest.ts` +
          (missing.length ? ` — faltan en module.json: [${missing.join(', ')}]` : '') +
          (extra.length ? ` — sobran en module.json: [${extra.join(', ')}]` : ''),
      );
    }
  }

  const tsEvents = extractManifestStringArray(src, 'eventsEmitted');
  if (tsEvents) {
    // First-party usa `events`; marketplace-style usa `eventsEmitted`.
    const jsonEvents = namesOf(json.events ?? json.eventsEmitted);
    const { missing, extra } = setDiff(tsEvents, jsonEvents);
    if (missing.length > 0 || extra.length > 0) {
      err(
        'events',
        `eventos emitidos divergentes con src/manifest.ts` +
          (missing.length ? ` — faltan en module.json: [${missing.join(', ')}]` : '') +
          (extra.length ? ` — sobran en module.json: [${extra.join(', ')}]` : ''),
      );
    }
  }

  return issues;
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));

  let modulesToCheck: string[];
  if (target) {
    if (!existsSync(join(MODULES_DIR, target))) {
      console.error(`Module not found: ${target}`);
      process.exit(2);
    }
    modulesToCheck = [target];
  } else {
    modulesToCheck = listModules();
  }

  if (modulesToCheck.length === 0) {
    console.log(`module-doctor: no modules found under ${MODULES_DIR}.`);
    process.exit(0);
  }

  console.log(`module-doctor: checking ${modulesToCheck.length} module(s)...\n`);

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const m of modulesToCheck) {
    const issues = validateModule(m);
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');
    totalErrors += errors.length;
    totalWarnings += warnings.length;

    if (issues.length === 0) {
      console.log(`✅ ${m} — OK`);
    } else {
      console.log(
        `${errors.length > 0 ? '❌' : '⚠️ '} ${m} — ${errors.length} error(s), ${warnings.length} warning(s)`,
      );
      for (const i of issues) {
        const icon = i.severity === 'error' ? '   ❌' : '   ⚠️ ';
        console.log(`${icon} [${i.field ?? '?'}] ${i.message}`);
      }
    }
  }

  console.log(
    `\nSummary: ${totalErrors} error(s), ${totalWarnings} warning(s) across ${modulesToCheck.length} module(s).`,
  );
  process.exit(totalErrors > 0 ? 1 : 0);
}

main();
