import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import semver from 'semver';
import { describe, expect, it } from 'vitest';
import { resolveCoreContractVersion } from '../src/core-version';

/**
 * El invariante que mata el arranque: si un módulo first-party declara un
 * `coreVersionRequired` que la versión del core no satisface, el registry tira
 * `CoreVersionMismatchError` al registrarlo y **el API no levanta**.
 *
 * `module-doctor` ya lo comprueba, pero vive en su propio workflow. Esto lo
 * pone en la suite que corre SIEMPRE, y sobre los manifiestos de verdad — no
 * sobre un fixture. Es barato y cubre el único fallo que deja la instancia
 * muerta en vez de degradada.
 */

const MODULES_DIR = resolve(__dirname, '..', '..', '..', 'modules');

function manifiestos(): Array<{ modulo: string; requerido: string; runtime: string | null }> {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(MODULES_DIR, d.name, 'module.json')))
    .map((d) => {
      const json = JSON.parse(
        readFileSync(join(MODULES_DIR, d.name, 'module.json'), 'utf8'),
      ) as Record<string, unknown>;
      const manifestTs = join(MODULES_DIR, d.name, 'src', 'manifest.ts');
      const runtime = existsSync(manifestTs)
        ? (/coreVersionRequired\s*:\s*'([^']+)'/.exec(readFileSync(manifestTs, 'utf8'))?.[1] ??
          null)
        : null;
      return {
        modulo: d.name,
        requerido: String(json['coreVersionRequired'] ?? ''),
        runtime,
      };
    });
}

describe('manifiestos first-party contra la versión real del core', () => {
  it('encuentra los módulos del repo (si no, el resto de este fichero no probaría nada)', () => {
    // Sin esta guarda, un MODULES_DIR mal resuelto daría una lista vacía y los
    // tests de abajo pasarían en verde sin haber mirado un solo manifiesto.
    expect(manifiestos().length).toBeGreaterThanOrEqual(20);
  });

  it('todos arrancan con la versión de contrato que resuelve el core', () => {
    const contrato = resolveCoreContractVersion();
    const rotos = manifiestos()
      .filter((m) => !semver.satisfies(contrato, m.requerido))
      .map((m) => `${m.modulo} pide ${m.requerido}`);
    expect(rotos).toEqual([]);
  });

  it('module.json y src/manifest.ts declaran lo MISMO', () => {
    // Son dos ficheros que hay que mover a la vez: el registry parsea el .ts y
    // el instalador el .json. Desincronizarlos fue lo que hizo fracasar el
    // primer intento de subir estos rangos.
    const desincronizados = manifiestos()
      .filter((m) => m.runtime !== null && m.runtime !== m.requerido)
      .map((m) => `${m.modulo}: json=${m.requerido} ts=${m.runtime}`);
    expect(desincronizados).toEqual([]);
  });
});
