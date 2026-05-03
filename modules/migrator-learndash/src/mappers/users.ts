import type { WpUser } from '../connector/index.js';
import type { CanonicalUser, MapResult } from './canonical.js';
import { externalId, mapWpRoles, safeEmail } from './helpers.js';

export function mapUser(raw: WpUser): MapResult<CanonicalUser> {
  const warnings: string[] = [];

  if (!raw || typeof raw.id !== 'number') {
    return {
      ok: false,
      errorCode: 'MALFORMED_PAYLOAD',
      errorMessage: 'usuario sin id numérico',
      warnings,
    };
  }

  const email = safeEmail(raw.email);
  if (!email) {
    return {
      ok: false,
      errorCode: 'MISSING_EMAIL',
      errorMessage: `usuario ${raw.id} sin email válido`,
      warnings,
    };
  }

  const username = raw.username?.trim() || undefined;
  if (!username) warnings.push('username vacío; se generará desde el email');

  return {
    ok: true,
    warnings,
    canonical: {
      externalId: externalId(raw.id),
      sourceId: String(raw.id),
      email,
      username,
      displayName: raw.name?.trim() || username || email,
      registeredAt: raw.registered_date,
      roles: mapWpRoles(raw.roles),
    },
  };
}
