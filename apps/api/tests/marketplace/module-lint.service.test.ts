import { describe, expect, it } from 'vitest';
import { ModuleLintService } from '../../src/marketplace/module-lint.service';

const lint = new ModuleLintService();

describe('ModuleLintService.lintBundle', () => {
  it('acepta require de la allowlist y devuelve la lista detectada', () => {
    const code = `
      const z = require('zod');
      const c = require('crypto');
      module.exports = { onInstall: () => {} };
    `;
    const result = lint.lintBundle(code);
    expect(result.detectedRequires.sort()).toEqual(['crypto', 'zod']);
  });

  it('rechaza requires fuera de la allowlist', () => {
    const code = `const lodash = require('lodash');`;
    expect(() => lint.lintBundle(code)).toThrowError(/MODULE_LINT_FAILED/);
  });

  it.each(['fs', 'node:fs', 'child_process', 'net', 'http', 'https', 'tls', 'worker_threads'])(
    'rechaza built-in prohibido %s',
    (mod) => {
      const code = `const f = require('${mod}');`;
      expect(() => lint.lintBundle(code)).toThrowError(/MODULE_LINT_FAILED/);
    },
  );

  it('rechaza `import` ESM', () => {
    const code = `import zod from 'zod';\nmodule.exports = {};`;
    expect(() => lint.lintBundle(code)).toThrowError(/import` ESM/);
  });

  it('rechaza `import(...)` dinámico', () => {
    const code = `module.exports = { onInstall: async () => { await import('zod'); } };`;
    expect(() => lint.lintBundle(code)).toThrowError(/dinámico/);
  });

  it.each([
    'eval("1+1")',
    'new Function("return 1")()',
    'process.exit(0)',
    'process.kill(1)',
    'process.binding("fs")',
    'WebAssembly.compile(buf)',
  ])('rechaza API peligrosa %s', (snippet) => {
    expect(() => lint.lintBundle(`module.exports = { run: () => { ${snippet}; } };`)).toThrowError(
      /APIs prohibidas/,
    );
  });

  it('módulo bien formado pasa sin issues', () => {
    const code = `
      "use strict";
      module.exports = {
        onInstall: function (ctx) { ctx.log('log', 'hola'); },
      };
    `;
    expect(() => lint.lintBundle(code)).not.toThrow();
  });
});
