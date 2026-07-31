import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tests de contract sobre la imagen runtime (Dockerfile + entrypoint.sh).
 *
 * Protegen contra la regresión del bug EACCES en /app/data/storage del
 * primer install de módulo via marketplace en cualquier deploy nuevo.
 *
 * El bug ocurre cuando se cumplen LAS DOS condiciones simultáneamente:
 *   1. El proceso de la app corre como usuario no-root (`USER didacta`)
 *   2. El entrypoint NO chownea /app/data antes de bajar privilegios
 *
 * Docker monta un volumen vacío como root:root y la app (UID 1001) no
 * puede crear /app/data/storage. Result: HTTP 500 al instalar cualquier ZIP.
 *
 * El fix robusto es el patrón de las imágenes oficiales de Postgres/Redis:
 * arrancar como root, chown del volumen, drop a UID 1001 con su-exec, y
 * exec del proceso final. Estos tests garantizan que cualquier refactor
 * futuro mantiene las dos piezas del patrón en su sitio.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

describe('runtime image — storage volume permissions', () => {
  describe('Dockerfile', () => {
    const dockerfile = read('Dockerfile');

    it('instala su-exec en el stage runner (necesario para drop de privilegios)', () => {
      // El bloque apk add del runner debe contener su-exec literalmente.
      // Si alguien lo quita, el entrypoint fallará con "su-exec: not found"
      // y el container quedará atascado como root o crasheará.
      expect(dockerfile).toMatch(/apk add[^]+su-exec[^]+tini/);
    });

    it('NO declara USER didacta activo (debe entrar como root para chown)', () => {
      // Buscar líneas USER no comentadas. El patrón init-as-root del entrypoint
      // requiere arrancar como root; el switch a didacta lo hace su-exec.
      const activeUserLines = dockerfile.split('\n').filter((line) => /^\s*USER\s+\S/.test(line));
      expect(activeUserLines).toEqual([]);
    });
  });

  describe('entrypoint.sh', () => {
    const entrypoint = read('infra/docker/entrypoint.sh');

    it('detecta arranque como root (UID 0)', () => {
      expect(entrypoint).toMatch(/id -u.*==\s*"0"|id -u.*=\s*"0"/);
    });

    it('asegura /app/data/storage y chownea el volumen a didacta', () => {
      expect(entrypoint).toContain('mkdir -p /app/data/storage');
      expect(entrypoint).toMatch(/chown -R didacta:didacta\s+\/app\/data/);
    });

    it('hace exec re-entrante con su-exec didacta:didacta', () => {
      // Re-exec con "$0" "$@" preserva el comando original (start, api, web, etc.)
      // y entrega PID 1 al proceso bajado a didacta. Sin re-exec, su-exec
      // forkearía y el wait/trap del entrypoint no funcionaría.
      expect(entrypoint).toMatch(/exec\s+su-exec\s+didacta:didacta\s+"\$0"\s+"\$@"/);
    });

    it('el bloque init-as-root está antes de cualquier operación de filesystem en /app/data', () => {
      // Si el chown viniera después de, p.ej., ensure_pgvector_extension
      // (que no toca /app/data) sería OK. Pero si está después de start_all
      // o de cualquier escritura, no sirve. Verificamos que el if root está
      // antes de la primera mención de "$DATABASE_URL" (run_migrations) y de
      // las funciones start_*.
      const idx = (needle: string) => entrypoint.indexOf(needle);
      const rootBlock = idx('su-exec didacta:didacta');
      const firstFunctionUse = Math.min(idx('start_all()'), idx('run_migrations()'));
      expect(rootBlock).toBeGreaterThan(0);
      expect(rootBlock).toBeLessThan(firstFunctionUse);
    });
  });
});
