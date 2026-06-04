import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/// Test estructural anti-código-muerto.
///
/// Hace un walk de imports `import … from './x'` partiendo desde los DOS
/// entries reales que el sandbox del host evalúa:
///
///   - `src/index.ts`     (server: handlers, onJobTick, etc.)
///   - `src/ui/admin.tsx` (UI: bundle del surface admin)
///
/// Cualquier `.ts`/`.tsx` bajo `src/` que NO sea alcanzable desde uno de
/// los dos entries es código muerto y este test falla.
///
/// Por qué existe este test: hasta v1.0.31 el repo contenía `src/etl/*` con
/// pinta de "capa de servicios" (orchestrator, extractor, ports, etc.). Era
/// residuo de la versión pre-sandbox y nunca se ejecutaba. Un PR de feature
/// añadió "sample mode" en `src/etl/extractor-sample.ts`, los unit tests
/// pasaron, la firma KMS pasó, la instalación devolvió signatureVerified=true
/// — pero el feature no funcionaba en runtime porque `src/index.ts` no
/// importaba el extractor. El usuario reportó el bug en producción.
///
/// Este test atrapa exactamente ese patrón: si añadís un `.ts` aislado y
/// olvidás cablearlo desde uno de los entries, CI lo marca antes del merge.
///
/// Si necesitás añadir un archivo standalone (script de build, helper de
/// CI que no entra al bundle, etc.), va FUERA de `src/` (en `scripts/`).
/// El test solo escanea `src/`.

const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');

const ENTRY_POINTS = [resolve(SRC_ROOT, 'index.ts'), resolve(SRC_ROOT, 'ui/admin.tsx')] as const;

/// Extrae todos los `import { … } from 'X'` / `import * as Y from 'X'` del
/// código fuente. Solo nos interesan los relative (que empiezan con `.`).
/// No usamos AST parser para no añadir dep — el regex cubre los casos del
/// repo (módulos ES modules sin `require()` dinámicos en producción).
function extractRelativeImports(source: string): string[] {
  const out: string[] = [];
  const importRegex = /(?:^|\n)\s*(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = importRegex.exec(source)) !== null) {
    out.push(m[1]!);
  }
  // `import 'foo'` side-effect import sin specifier
  const sideEffectRegex = /(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g;
  while ((m = sideEffectRegex.exec(source)) !== null) {
    out.push(m[1]!);
  }
  return out;
}

/// Resuelve un specifier relativo a un path absoluto. Maneja:
///   - `./x`           → `x.ts` / `x.tsx`
///   - `./x.js`        → `x.ts` / `x.tsx` (extension swap por NodeNext + esbuild)
///   - `./dir/index.js`→ `dir/index.ts`
///   - `./dir`         → `dir/index.ts`
function resolveImport(fromFile: string, specifier: string): string | null {
  const baseDir = dirname(fromFile);
  let candidate = resolve(baseDir, specifier);
  const candidates: string[] = [];

  // Si trae extensión `.js`/`.mjs`/`.cjs` (convención NodeNext), swap a `.ts`/`.tsx`.
  const ext = extname(candidate);
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const base = candidate.slice(0, -ext.length);
    candidates.push(base + '.ts', base + '.tsx');
  } else if (ext === '.json') {
    candidates.push(candidate);
  } else if (ext === '') {
    // `./x`         → x.ts, x.tsx, x/index.ts, x/index.tsx
    candidates.push(
      candidate + '.ts',
      candidate + '.tsx',
      join(candidate, 'index.ts'),
      join(candidate, 'index.tsx'),
    );
  } else {
    candidates.push(candidate);
  }

  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

function walkImportsBFS(entries: readonly string[]): Set<string> {
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const e of entries) {
    if (!existsSync(e)) continue;
    reachable.add(e);
    queue.push(e);
  }
  while (queue.length > 0) {
    const file = queue.shift()!;
    const source = readFileSync(file, 'utf8');
    const specifiers = extractRelativeImports(source);
    for (const spec of specifiers) {
      const resolved = resolveImport(file, spec);
      if (!resolved) continue;
      // Solo nos interesan archivos dentro de src/.
      if (!resolved.startsWith(SRC_ROOT)) continue;
      // JSON imports (ej. package.json) son lícitos pero no son `.ts/.tsx`,
      // así que no los añadimos al set de "código TS alcanzable".
      const e = extname(resolved);
      if (e !== '.ts' && e !== '.tsx') continue;
      if (reachable.has(resolved)) continue;
      reachable.add(resolved);
      queue.push(resolved);
    }
  }
  return reachable;
}

function listAllSrcTsFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else {
        const e = extname(full);
        if (e === '.ts' || e === '.tsx') {
          // Excluir archivos .d.ts puros y los .test.ts que viven fuera de src/.
          if (full.endsWith('.d.ts')) continue;
          out.push(full);
        }
      }
    }
  }
  walk(SRC_ROOT);
  return out;
}

describe('no-dead-imports', () => {
  it('todos los .ts/.tsx bajo src/ son alcanzables desde index.ts o ui/admin.tsx', () => {
    const reachable = walkImportsBFS(ENTRY_POINTS);
    const allFiles = listAllSrcTsFiles();
    const dead = allFiles.filter((f) => !reachable.has(f));

    const relativize = (f: string): string => relative(REPO_ROOT, f).replace(/\\/g, '/');

    if (dead.length > 0) {
      const list = dead.map(relativize).sort();
      throw new Error(
        [
          `Encontrados ${dead.length} archivo(s) en src/ no alcanzables desde ningún entry runtime:`,
          ...list.map((f) => `  - ${f}`),
          '',
          'Los entries reales del sandbox son:',
          ...ENTRY_POINTS.map((e) => `  - ${relativize(e)}`),
          '',
          'Si el archivo es código muerto: bórralo (`git rm`).',
          'Si NO es código muerto: añade el import donde corresponda en el entry o en algún archivo ya alcanzable.',
          'Si es un script standalone (no para el bundle): muévelo a `scripts/` (queda fuera del scan).',
          '',
          'Contexto: el sandbox del host evalúa SOLO los entries listados. Cualquier .ts',
          'aislado en src/ es invisible al runtime aunque sus tests pasen y se firme con KMS.',
          'Ver ARCHITECTURE.md.',
        ].join('\n'),
      );
    }

    expect(dead).toEqual([]);
  });
});
