/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Helper para redactar campos sensibles de un objeto antes de devolverlo
 * al cliente. Usado por el endpoint GET de tenant-settings para exponer
 * los campos no-credenciales (host, user, from...) de un setting cifrado
 * sin filtrar passwords/keys/tokens. Ver UI-FIX-02.
 *
 * Matching case-insensitive contra una lista cerrada de nombres conocidos.
 * Si aparece un setting nuevo con un campo sensible que no esté listado,
 * hay que agregarlo acá — preferimos pecar de paranoicos.
 *
 * Recursivo: si encuentra un sub-objeto, redacta dentro. Arrays se devuelven
 * sin tocar (asumir que no contienen credenciales — el shape habitual es
 * `{ password: 'x', list: [...] }`, no `[ {password}, ... ]`).
 */

export const SENSITIVE_FIELD_NAMES = new Set([
  'password',
  'apikey',
  'api_key',
  'secret',
  'token',
  'clientsecret',
  'client_secret',
  'privatekey',
  'private_key',
  'webhooksecret',
  'webhook_secret',
  'signingsecret',
  'signing_secret',
  'refreshtoken',
  'refresh_token',
  'accesstoken',
  'access_token',
]);

export function redactSensitiveFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_FIELD_NAMES.has(k.toLowerCase())) {
      out[k] = null;
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactSensitiveFields(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Mergea un nuevo value (que llega del PUT del cliente) con el value previo
 * guardado en DB, preservando los campos sensibles del previo cuando el nuevo
 * los trae vacíos/null. Esto permite al admin actualizar host/user/from sin
 * tener que re-tipear la password en cada save — el cliente envía password
 * vacío y el server mantiene el guardado. Ver UI-FIX-02 (alpha.69).
 *
 * Comportamiento campo a campo:
 *
 *   - Campo sensible vacío en `next` y presente en `prev`     → mantiene `prev`
 *   - Campo sensible con valor real en `next`                 → usa `next` (cambia)
 *   - Campo sensible vacío en `next` y NO presente en `prev`  → queda vacío (correcto)
 *   - Campo no sensible                                       → siempre usa `next`
 *   - Recursivo en sub-objetos
 *
 * "Vacío" se entiende como `null`, `undefined`, o string trimmed que es `''`.
 * Esto es opinionado: si el admin quiere BORRAR explícitamente una password
 * guardada, tiene que usar el endpoint DELETE del tenant-setting (no este
 * upsert con string vacío). Trade-off elegido para que la UX de "guardar sin
 * re-tipear" sea posible.
 */
export function mergeSecretFields(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, nextValue] of Object.entries(next)) {
    const prevValue = prev[k];
    if (SENSITIVE_FIELD_NAMES.has(k.toLowerCase())) {
      const isEmpty =
        nextValue == null || (typeof nextValue === 'string' && nextValue.trim() === '');
      out[k] = isEmpty && k in prev ? prevValue : nextValue;
    } else if (
      nextValue !== null &&
      typeof nextValue === 'object' &&
      !Array.isArray(nextValue) &&
      prevValue !== null &&
      typeof prevValue === 'object' &&
      !Array.isArray(prevValue)
    ) {
      out[k] = mergeSecretFields(
        prevValue as Record<string, unknown>,
        nextValue as Record<string, unknown>,
      );
    } else {
      out[k] = nextValue;
    }
  }
  return out;
}
