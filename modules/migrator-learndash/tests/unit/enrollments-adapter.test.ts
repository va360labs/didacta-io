import { describe, expect, it } from 'vitest';
import { adaptCanonicalToDidacta } from '../../src/index.js';
import { mapDirectEnrollment } from '../../src/mappers/index.js';

/// Path de matrículas (v1.1.0+ — modo "Solo alumnos matriculados"):
/// extract calcula el canonical con mapDirectEnrollment y el load lo pasa por
/// adaptCanonicalToDidacta('enrollments', ...) → input de
/// ctx.didacta.enrollments.upsertByExternalRef. El host espera externalRef del
/// propio enrollment + userExternalRef + courseExternalRef (schema .strict()),
/// y resuelve user+course por (externalSource, externalId).

describe('enrollments adapter (extract → load)', () => {
  it('mapDirectEnrollment → adaptCanonicalToDidacta produce el input que espera el host', () => {
    const mapped = mapDirectEnrollment('42', { id: 7 } as Parameters<
      typeof mapDirectEnrollment
    >[1]);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;

    const adapted = adaptCanonicalToDidacta(
      'enrollments',
      mapped.canonical as unknown as Record<string, unknown>,
    );
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.ns).toBe('enrollments');
    expect(adapted.input).toMatchObject({
      externalSource: 'learndash',
      userExternalRef: { externalSource: 'learndash', externalId: '7' },
      courseExternalRef: { externalSource: 'learndash', externalId: '42' },
      status: 'ACTIVE',
    });
    // externalId del enrollment estable y no vacío (idempotencia en el host).
    expect(typeof adapted.input.externalId).toBe('string');
    expect(String(adapted.input.externalId).length).toBeGreaterThan(0);
  });

  it('falla con código tipado si faltan las refs de user/course', () => {
    const adapted = adaptCanonicalToDidacta('enrollments', { status: 'active' });
    expect(adapted.ok).toBe(false);
    if (adapted.ok) return;
    expect(adapted.code).toBe('ADAPTER_ENROLLMENT_NO_REFS');
  });

  it('status completed del canonical → COMPLETED en el input del host', () => {
    const adapted = adaptCanonicalToDidacta('enrollments', {
      userSourceId: '7',
      courseSourceId: '42',
      status: 'completed',
      externalId: 'learndash:enrollment:42:7',
    });
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.input.status).toBe('COMPLETED');
  });
});
