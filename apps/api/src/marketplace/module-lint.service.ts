import { Injectable, Logger } from '@nestjs/common';
import { MarketplacePackageError } from './module-package.errors';

/// Allowlist de módulos que un paquete `*.zip` puede requerir desde
/// su `dist/index.js`. La VM aislada intercepta cada `require` en runtime
/// (defensa principal); este lint estático es belt-and-suspenders, sirve
/// para fallar temprano antes de booteo y dejar mejor mensaje en el
/// `error_message` del row.
///
/// MOTIVACIÓN del subset: built-ins de Node solo los puramente CPU-bound
/// (sin I/O ni red). El módulo nunca debe tocar `fs`, `net`, `http`,
/// `child_process`, `worker_threads` directamente — todo I/O pasa por las
/// abstracciones de `@didacta/core-kernel` (StorageService, EventBus, etc.)
/// que la instancia controla y audita.
export const ALLOWED_REQUIRES = new Set<string>([
  '@didacta/core-kernel',
  '@nestjs/common',
  'zod',
  // Built-ins puros (sin I/O, sin red, sin spawn).
  'crypto',
  'node:crypto',
  'buffer',
  'node:buffer',
  'util',
  'node:util',
  'events',
  'node:events',
  'stream',
  'node:stream',
  'string_decoder',
  'node:string_decoder',
  'querystring',
  'node:querystring',
  'url',
  'node:url',
  'punycode',
  'node:punycode',
]);

/// Built-ins que se rechazan SIEMPRE, aunque alguien intente saltarse la
/// allowlist con un alias (`require('node:fs')`). Lista canonicalizada.
const FORBIDDEN_BUILTINS = new Set<string>([
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'child_process',
  'node:child_process',
  'net',
  'node:net',
  'http',
  'node:http',
  'https',
  'node:https',
  'tls',
  'node:tls',
  'dgram',
  'node:dgram',
  'dns',
  'node:dns',
  'cluster',
  'node:cluster',
  'worker_threads',
  'node:worker_threads',
  'perf_hooks',
  'node:perf_hooks',
  'os',
  'node:os',
  'path',
  'node:path',
  'process',
  'node:process',
  'vm',
  'node:vm',
  'inspector',
  'node:inspector',
]);

const REQUIRE_REGEX = /require\s*\(\s*(['"`])([^'"`\\]+?)\1\s*\)/g;
const IMPORT_REGEX = /^\s*import\b/m;
const DYNAMIC_IMPORT_REGEX = /\bimport\s*\(/;
const DANGEROUS_API_REGEX =
  /\b(eval\s*\(|new\s+Function\s*\(|process\s*\.\s*(exit|kill|binding)|WebAssembly\s*\.\s*compile)/;

export interface LintResult {
  detectedRequires: string[];
}

@Injectable()
export class ModuleLintService {
  private readonly logger = new Logger(ModuleLintService.name);

  /// Lint conservador del `dist/index.js`. Lanza `MarketplacePackageError`
  /// con código `MODULE_LINT_FAILED` si encuentra patrones prohibidos.
  ///
  /// Limitaciones conocidas (ASUMIDAS para MVP):
  ///   - Regex no entiende strings concatenadas en runtime (`require('f' + 's')`).
  ///     Estas pasan el lint pero son **rechazadas en runtime** por el
  ///     require proxy de la VM (defensa principal).
  ///   - No detecta `Reflect.get(global, 'process')` u ofuscaciones similares.
  ///     Lo mismo: la VM no expone `process` en su sandbox.
  ///   - Comentarios con `require('fs')` en JSDoc disparan falso positivo.
  ///     Aceptable: el ZIP debería contener código compilado, no JSDoc.
  lintBundle(distSource: string): LintResult {
    if (IMPORT_REGEX.test(distSource)) {
      throw new MarketplacePackageError(
        'MODULE_LINT_FAILED',
        'dist/index.js contiene `import` ESM. La VM solo ejecuta CommonJS — compila a CommonJS antes de empaquetar.',
      );
    }
    if (DYNAMIC_IMPORT_REGEX.test(distSource)) {
      throw new MarketplacePackageError(
        'MODULE_LINT_FAILED',
        'dist/index.js contiene `import(...)` dinámico. No soportado en la sandbox.',
      );
    }
    if (DANGEROUS_API_REGEX.test(distSource)) {
      throw new MarketplacePackageError(
        'MODULE_LINT_FAILED',
        'dist/index.js usa APIs prohibidas (eval, Function, process.exit/kill/binding, WebAssembly.compile).',
      );
    }

    const detected = new Set<string>();
    for (const match of distSource.matchAll(REQUIRE_REGEX)) {
      const id = match[2];
      if (!id) continue;
      detected.add(id);
      if (FORBIDDEN_BUILTINS.has(id)) {
        throw new MarketplacePackageError(
          'MODULE_LINT_FAILED',
          `dist/index.js requiere built-in prohibido: "${id}". Usa las abstracciones de @didacta/core-kernel.`,
          { forbidden: id },
        );
      }
      if (!ALLOWED_REQUIRES.has(id)) {
        throw new MarketplacePackageError(
          'MODULE_LINT_FAILED',
          `dist/index.js requiere módulo no autorizado: "${id}". Allowlist: ${Array.from(ALLOWED_REQUIRES).join(', ')}.`,
          { module: id },
        );
      }
    }

    return { detectedRequires: Array.from(detected) };
  }
}
