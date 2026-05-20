/**
 * Helper compartido para resolver el directorio del volumen persistente.
 *
 * Caso de uso: en producción (Docker/Easypanel/k8s) la app necesita
 * persistir archivos que sobreviven a redeploys — uploads del storage,
 * clave maestra de cifrado, evidencias, etc. El operador monta un
 * volumen y la app tiene que encontrarlo aunque no setee env vars.
 *
 * Orden de resolución (primero gana):
 *
 *   1. `override` (argumento explícito del caller)
 *   2. `STORAGE_ROOT` (env var, convención del docker-compose oficial)
 *   3. `/app/data/storage` (path Docker estándar, detectado por existsSync)
 *   4. `/app/data` (parent del path estándar, también detectado por existsSync)
 *   5. `./data/storage` relativo al CWD (último recurso — dev local)
 *
 * Razón del paso 3-4: Easypanel y muchos PaaS configuran el mount del
 * volumen desde su UI **separada** de las env vars del service. El
 * operador monta `/app/data/storage` y la app tiene que detectarlo aunque
 * `STORAGE_ROOT` nunca aparezca en `process.env`. Sin estos pasos el
 * código caería al path relativo al CWD (efímero) y se perderían datos.
 *
 * Ver incidentes:
 * - alpha.71 (cipher-key): la clave maestra iba a CWD efímero.
 * - alpha.72 (local-disk-storage): los uploads (logos, certs, SCORM,
 *   evidencias Fundae) iban a CWD efímero.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCKER_PATHS = ['/app/data/storage', '/app/data'] as const;

export function resolvePersistentDataRoot(override?: string): string {
  if (override && override.trim().length > 0) {
    return resolve(override);
  }
  const fromEnv = process.env['STORAGE_ROOT'];
  if (fromEnv && fromEnv.trim().length > 0) {
    return resolve(fromEnv);
  }
  for (const candidate of DOCKER_PATHS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return resolve('./data/storage');
}
