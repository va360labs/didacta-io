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
