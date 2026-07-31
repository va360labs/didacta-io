/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { LdCourse } from '../connector/index.js';
import type { CanonicalCourse, MapResult } from './canonical.js';
import {
  externalId,
  mapWpStatus,
  unwrapTitle,
  decodeHtmlEntities,
  asNumber,
  asString,
} from './helpers.js';

export function mapCourse(raw: LdCourse): MapResult<CanonicalCourse> {
  const warnings: string[] = [];
  if (!raw || typeof raw.id !== 'number') {
    return {
      ok: false,
      errorCode: 'MALFORMED_PAYLOAD',
      errorMessage: 'curso sin id numérico',
      warnings,
    };
  }

  const title = decodeHtmlEntities(unwrapTitle(raw.title));
  if (!title) warnings.push(`curso ${raw.id} sin título`);

  const slug = raw.slug?.trim() || `course-${raw.id}`;
  if (!raw.slug) warnings.push(`curso ${raw.id} sin slug; se generará desde id`);

  const featuredMediaId = asNumber(raw.featured_media);
  const certId = asNumber(raw.certificate);
  const priceType = asString(raw.price_type);

  const pricing =
    priceType && priceType !== 'free' && raw.price
      ? {
          priceText: String(raw.price),
          amount: asNumber(raw.price),
        }
      : undefined;

  const prereqs = Array.isArray(raw.prerequisites) ? raw.prerequisites.map(String) : [];

  // El fixup inyecta `__sections` en raw_payload del course tras parsear
  // /sfwd-courses/:id/steps. Propagamos al canonical para que el load
  // pueda crear UN module sintético por section.
  const rawSections = (raw as { __sections?: unknown }).__sections;
  const sections = Array.isArray(rawSections)
    ? rawSections
        .map((s, i) => {
          if (!s || typeof s !== 'object') return null;
          const obj = s as { idx?: unknown; title?: unknown; lessonIds?: unknown };
          const idx = typeof obj.idx === 'number' ? obj.idx : i;
          const title = typeof obj.title === 'string' ? obj.title.trim() : '';
          const lessonIds = Array.isArray(obj.lessonIds)
            ? obj.lessonIds.filter((x) => typeof x === 'number')
            : [];
          if (!title || lessonIds.length === 0) return null;
          return { idx, title, lessonIds: lessonIds as number[] };
        })
        .filter((s): s is { idx: number; title: string; lessonIds: number[] } => s !== null)
    : undefined;

  return {
    ok: true,
    warnings,
    canonical: {
      externalId: externalId(raw.id),
      sourceId: String(raw.id),
      slug,
      title: title || `Curso ${raw.id}`,
      status: mapWpStatus(raw.status),
      featuredMediaSourceId: featuredMediaId !== undefined ? String(featuredMediaId) : undefined,
      certificateSourceId: certId !== undefined && certId !== 0 ? String(certId) : undefined,
      priceType:
        priceType === 'free' ||
        priceType === 'paynow' ||
        priceType === 'subscribe' ||
        priceType === 'closed'
          ? priceType
          : 'free',
      pricing,
      prerequisitesSourceIds: prereqs,
      modifiedAt: raw.modified_gmt,
      sections: sections && sections.length > 0 ? sections : undefined,
    },
  };
}
