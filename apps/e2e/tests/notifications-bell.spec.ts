import { expect, test } from '@playwright/test';
import { bootstrapScenario, listEnrollments, trackProgress, API_URL } from '../helpers/api';

/**
 * Spec de notificaciones in-app (PR #61 + #62).
 *
 * Verifica que cuando el alumno completa un curso, las notificaciones
 * IN_APP (matrícula, course-completed, certificate-issued) se persisten
 * y son consultables por el alumno via /me/notifications.
 */

test.describe('Notificaciones in-app del alumno', () => {
  test('completar un curso genera notificaciones in-app del alumno', async () => {
    const scenario = await bootstrapScenario();
    const headers = {
      Authorization: `Bearer ${scenario.alumno.accessToken}`,
      'Content-Type': 'application/json',
    };

    const enrollments = await listEnrollments(scenario.alumno.accessToken);
    const ours = enrollments.find((e) => e.courseId === scenario.course.id);
    expect(ours).toBeDefined();
    const lessonId = scenario.course.modules[0]?.lessons[0]?.id;
    expect(lessonId).toBeDefined();

    await trackProgress({
      bearer: scenario.alumno.accessToken,
      enrollmentId: ours!.id,
      lessonId: lessonId!,
      durationSec: 60,
    });

    // Esperar dispatch del outbox.
    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`${API_URL}/api/v1/me/notifications`, { headers });
    expect(res.ok).toBe(true);
    const list = (await res.json()) as Array<{ id: string; readAt: string | null; title: string }>;
    expect(list.length).toBeGreaterThan(0);
    // Al menos una debería ser unread inicial.
    expect(list.some((n) => n.readAt === null)).toBe(true);
  });

  test('mark-all-read deja todas las notificaciones leídas', async () => {
    const scenario = await bootstrapScenario();
    const headers = {
      Authorization: `Bearer ${scenario.alumno.accessToken}`,
      'Content-Type': 'application/json',
    };

    // Generar al menos una notificación enrollment.created (matriculación inicial).
    await new Promise((r) => setTimeout(r, 200));

    const markAll = await fetch(`${API_URL}/api/v1/me/notifications/mark-all-read`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(markAll.ok).toBe(true);

    const after = await fetch(`${API_URL}/api/v1/me/notifications`, { headers });
    const list = (await after.json()) as Array<{ readAt: string | null }>;
    expect(
      list.every((n) => n.readAt !== null),
      'todas leídas',
    ).toBe(true);
  });
});
