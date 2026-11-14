import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tests de contrato: la imagen de runtime arranca SIN acceso a
 * binaries.prisma.sh (incluido el `prisma migrate deploy` del entrypoint).
 *
 * Hasta beta.22 la imagen llevaba los motores del CLI para `linux-musl`
 * (OpenSSL 1.1), pero el runner tiene OpenSSL 3, así que el CLI pedía
 * `linux-musl-openssl-3.0.x`, no lo encontraba y lo descargaba en CADA
 * arranque. Si binaries.prisma.sh no respondía durante un reinicio, el
 * contenedor no levantaba. Dos causas:
 *   1. El stage `base` no llevaba el binario `openssl`. Prisma 5, en Alpine,
 *      solo reconoce OpenSSL 3 por ese binario; sin él cae a OpenSSL 1.1.
 *   2. El `pnpm install --prod` del pruner reenlaza @prisma/engines desde la
 *      caché de pnpm y pisa los motores que había bajado `prisma generate`.
 *
 * La comprobación real es el `RUN --network=none` del runner (el build se
 * corta si el CLI necesitara red). Estos tests impiden que un refactor quite
 * las piezas sin que nadie se entere.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

/** Texto de un stage del Dockerfile, desde su `FROM … AS <name>` hasta el siguiente `FROM`. */
function stage(dockerfile: string, name: string): string {
  const lines = dockerfile.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\s*$`).test(l));
  if (start < 0) throw new Error(`stage ${name} no encontrado`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^FROM\s/.test(l));
  return lines.slice(start, end < 0 ? undefined : start + 1 + end).join('\n');
}

/** Instrucciones sin comentarios, para no dar por buena una línea comentada. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

describe('runtime image — Prisma sin descargas al arrancar', () => {
  const dockerfile = read('Dockerfile');

  it('el stage base instala openssl (Prisma detecta OpenSSL 3 en el build)', () => {
    expect(code(stage(dockerfile, 'base'))).toMatch(/apk add[^\n]*\bopenssl\b/);
  });

  it('builder y pruner heredan de base (y por tanto llevan openssl)', () => {
    expect(dockerfile).toMatch(/^FROM base AS fetcher$/m);
    expect(dockerfile).toMatch(/^FROM fetcher AS builder$/m);
    expect(dockerfile).toMatch(/^FROM builder AS pruner$/m);
  });

  it('el pruner conserva los motores del builder alrededor del `pnpm install --prod`', () => {
    // El install --prod reenlaza @prisma/engines desde la caché de pnpm y pisa
    // los motores que bajó `prisma generate` (beta.22 acabó con los de OpenSSL 1.1).
    const pruner = code(stage(dockerfile, 'pruner'));
    const stash = pruner.search(
      /cp -a "\$engines"\/libquery_engine-\* "\$engines"\/schema-engine-\* \/prisma-engines\//,
    );
    const install = pruner.indexOf('pnpm install --frozen-lockfile --prod');
    const restore = pruner.search(/cp -a \/prisma-engines\/\. "\$engines"\//);
    expect(stash).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(stash);
    expect(restore).toBeGreaterThan(install);
  });

  it('el runner comprueba el CLI de Prisma sin red, después de copiar el repo y el cliente', () => {
    const runner = code(stage(dockerfile, 'runner'));
    const guard = runner.search(/RUN --network=none[^]*?prisma validate/);
    expect(guard).toBeGreaterThan(0);
    expect(runner.indexOf('COPY --from=pruner')).toBeLessThan(guard);
    expect(runner.indexOf('node_modules/.prisma')).toBeLessThan(guard);
  });

  it('el runner no avisa a checkpoint.prisma.io en cada arranque', () => {
    expect(code(stage(dockerfile, 'runner'))).toMatch(/CHECKPOINT_DISABLE=1/);
  });

  it('el cliente generado incluye el motor de la imagen (linux-musl-openssl-3.0.x)', () => {
    const schema = read('packages/database/prisma/schema.prisma');
    const targets = /binaryTargets\s*=\s*\[([^\]]*)\]/.exec(schema)?.[1] ?? '';
    expect(targets).toContain('"linux-musl-openssl-3.0.x"');
  });
});
