import type { LdGroup, WpUser } from '../connector/index.js';
import type { CanonicalGroup, CanonicalEnrollment, MapResult } from './canonical.js';
import { externalId, unwrapTitle, decodeHtmlEntities } from './helpers.js';

export function mapGroup(raw: LdGroup): MapResult<CanonicalGroup> {
  const warnings: string[] = [];
  if (!raw || typeof raw.id !== 'number') {
    return { ok: false, errorCode: 'MALFORMED_PAYLOAD', errorMessage: 'grupo sin id', warnings };
  }
  const name = decodeHtmlEntities(unwrapTitle(raw.title));
  return {
    ok: true,
    warnings,
    canonical: {
      externalId: externalId(raw.id),
      sourceId: String(raw.id),
      name: name || `Grupo ${raw.id}`,
      slug: raw.slug || `group-${raw.id}`,
      modelHint: 'cohort', // default seguro; el wizard puede sobreescribir
    },
  };
}

/** Convierte un WpUser de la lista de usuarios de un curso/grupo en un enrollment. */
export function mapDirectEnrollment(
  courseSourceId: string,
  user: WpUser,
): MapResult<CanonicalEnrollment> {
  const warnings: string[] = [];
  if (!user || typeof user.id !== 'number') {
    return { ok: false, errorCode: 'MALFORMED_PAYLOAD', errorMessage: 'enrollment sin user.id', warnings };
  }
  return {
    ok: true,
    warnings,
    canonical: {
      externalId: `learndash:enrollment:${courseSourceId}:${user.id}`,
      kind: 'direct',
      userSourceId: String(user.id),
      courseSourceId,
      status: 'active',
    },
  };
}

export function mapGroupEnrollment(
  groupSourceId: string,
  user: WpUser,
): MapResult<CanonicalEnrollment> {
  const warnings: string[] = [];
  if (!user || typeof user.id !== 'number') {
    return { ok: false, errorCode: 'MALFORMED_PAYLOAD', errorMessage: 'enrollment sin user.id', warnings };
  }
  return {
    ok: true,
    warnings,
    canonical: {
      externalId: `learndash:enrollment:group:${groupSourceId}:${user.id}`,
      kind: 'group',
      userSourceId: String(user.id),
      groupSourceId,
      status: 'active',
    },
  };
}
