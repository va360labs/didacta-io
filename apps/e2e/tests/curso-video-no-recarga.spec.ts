import { expect, test } from '@playwright/test';
import {
  adminTokenForBootstrap,
  API_URL,
  bootstrapScenario,
  createPublishedCourseWithHtmlLesson,
} from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Regresión: el vídeo NO debe recargarse mientras el alumno lo mira.
 *
 * Bug original (jul-2026): en lecciones con el vídeo incrustado dentro del HTML
 * enriquecido, cada reporte de progreso (tick de presencia 60s / visionado Bunny
 * ~20s) provocaba un `setState` en la página del curso → re-render → React
 * re-commiteaba el `dangerouslySetInnerHTML` del bloque de texto → el navegador
 * destruía y recreaba el `<iframe>` embebido → el vídeo se cortaba/reiniciaba.
 *
 * Fix: el bloque de HTML se renderiza en un componente MEMOIZADO
 * (`LessonRichHtml` en lesson-player.tsx). Mientras el `html` no cambie, el
 * subárbol no se re-renderiza y el iframe embebido sobrevive a los re-renders.
 *
 * Este test fuerza varios re-renders de arriba-abajo del árbol (evento
 * `didacta:session-updated`, que hace `setSession` en el AppLayout y re-renderiza
 * toda la app) y verifica que el MISMO nodo `<iframe>` sigue vivo. Sin el memo,
 * el iframe se recrearía y perdería la marca → el test falla. Requiere stack vivo
 * (web + API + DB con seed admin), igual que el resto de la suite e2e.
 */

const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';

test.describe('El vídeo embebido no se recarga en cada reporte de progreso', () => {
  test('UI: el iframe embebido sobrevive a los re-renders del player', async ({ page }) => {
    const scenario = await bootstrapScenario();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const stamp = Date.now();

    // Curso con una lección HTML que embebe un <iframe> con id estable.
    const embedHtml =
      '<p>Introducción a la clase.</p>' +
      '<iframe id="e2e-embed" src="about:blank" title="video embebido" width="640" height="360"></iframe>' +
      '<p>Cierre de la clase.</p>';
    const course = await createPublishedCourseWithHtmlLesson({
      bearer: adminToken,
      title: `Curso vídeo-HTML ${stamp}`,
      slug: `curso-video-html-${stamp}`,
      html: embedHtml,
    });

    // El alumno se matricula para poder ver el contenido.
    const enrollRes = await fetch(`${API_URL}/api/v1/modules/learning/enrollments/me`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${scenario.alumno.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ courseId: course.id }),
    });
    expect(enrollRes.ok, `self-enroll OK (got ${enrollRes.status})`).toBe(true);

    // Login como alumno (onboardingCompletedAt seteado para saltar el gate).
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: scenario.alumno.accessToken,
      user: {
        id: scenario.alumno.user.id,
        email: scenario.alumno.email,
        name: scenario.alumno.user.name ?? 'Alumno E2E',
        tenantId: scenario.alumno.user.tenantId,
        tenantSlug,
        roles: scenario.alumno.user.roles,
        mfaEnabled: false,
        onboardingCompletedAt: new Date().toISOString(),
      },
    });

    await page.goto(`/cursos/${course.slug}`);

    // El iframe embebido debe montarse dentro del contenido de la lección.
    const embed = page.locator('iframe#e2e-embed');
    await expect(embed).toBeAttached({ timeout: 15_000 });

    // Marcamos el nodo DOM actual del iframe para detectar si se recrea. Accedemos
    // al DOM vía `globalThis` (el tsconfig de e2e es Node, sin lib DOM).
    await page.evaluate(() => {
      const el = (
        globalThis as unknown as {
          document: { querySelector(s: string): { dataset: Record<string, string> } | null };
        }
      ).document.querySelector('iframe#e2e-embed');
      if (el) el.dataset.e2eMark = 'orig';
    });

    // Forzamos varios re-renders top-down de toda la app (mismo tipo de re-render
    // que provoca un reporte de progreso). Sin el memo, esto recrearía el iframe.
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        const g = globalThis as unknown as {
          dispatchEvent(e: unknown): void;
          Event: new (t: string) => unknown;
        };
        g.dispatchEvent(new g.Event('didacta:session-updated'));
      });
      await page.waitForTimeout(400);
    }

    // El iframe sigue siendo EL MISMO nodo (conserva la marca) → no se recreó.
    const stillMarked = await page.evaluate(() => {
      const el = (
        globalThis as unknown as {
          document: { querySelector(s: string): { dataset: Record<string, string> } | null };
        }
      ).document.querySelector('iframe#e2e-embed');
      return el ? (el.dataset.e2eMark ?? null) : null;
    });
    expect(stillMarked, 'el iframe embebido no debe recrearse en los re-renders').toBe('orig');
  });
});
