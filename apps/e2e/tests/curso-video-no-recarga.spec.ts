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
 *
 * El iframe es un embed de YouTube de verdad, no un `about:blank` con `id`.
 * El saneado de lecciones (servidor `packages/core-kernel/src/html/sanitize.ts`
 * y navegador `sanitizeLessonHtml`) solo deja pasar iframes de proveedores de
 * vídeo y quita siempre el `id` (DOM clobbering): con el `about:blank` el
 * iframe no llegaba a la página y el spec fallaba buscando algo que el producto
 * elimina a propósito. Se localiza por `title`, que sí sobrevive, y el
 * reproductor se sirve desde el propio test: no se sale a internet.
 *
 * YouTube y no Bunny: un embed de Bunny pegado en el HTML no se queda como
 * iframe, lo sustituye el reproductor que pide su URL a la API
 * (`lesson-html-videos.tsx`). El caso de este spec —el vídeo que va TAL CUAL
 * dentro del HTML memoizado— es el de los demás proveedores.
 */

const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';

/** Un embed real de YouTube: de los pocos hosts que el saneado admite. */
const EMBED_SRC = 'https://www.youtube-nocookie.com/embed/e2eNoRecarga';
const EMBED_TITLE = 'video embebido e2e';

test.describe('El vídeo embebido no se recarga en cada reporte de progreso', () => {
  test('UI: el iframe embebido sobrevive a los re-renders del player', async ({ page }) => {
    const scenario = await bootstrapScenario();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const stamp = Date.now();

    // Curso con una lección HTML que embebe el reproductor de YouTube.
    const embedHtml =
      '<p>Introducción a la clase.</p>' +
      `<iframe src="${EMBED_SRC}" title="${EMBED_TITLE}" width="640" height="360"></iframe>` +
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

    // El reproductor no se pide a internet: lo sirve el test.
    await page.route('https://www.youtube-nocookie.com/**', (r) =>
      r.fulfill({ contentType: 'text/html', body: '<html><body>reproductor</body></html>' }),
    );

    await page.goto(`/courses/${course.slug}`);

    // El iframe embebido debe montarse dentro del contenido de la lección, con
    // su `src` intacto: el saneado lo deja pasar porque es un proveedor de vídeo.
    const embed = page.locator(`iframe[title="${EMBED_TITLE}"]`);
    await expect(embed).toBeAttached({ timeout: 15_000 });
    await expect(embed).toHaveAttribute('src', EMBED_SRC);

    // Marcamos el nodo DOM actual del iframe para detectar si se recrea. Accedemos
    // al DOM vía `globalThis` (el tsconfig de e2e es Node, sin lib DOM).
    const sel = `iframe[title="${EMBED_TITLE}"]`;
    const marked = await page.evaluate((selector) => {
      const el = (
        globalThis as unknown as {
          document: { querySelector(s: string): { dataset: Record<string, string> } | null };
        }
      ).document.querySelector(selector);
      if (el) el.dataset.e2eMark = 'orig';
      return el !== null;
    }, sel);
    expect(marked, 'el iframe se ha podido marcar').toBe(true);

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
    const stillMarked = await page.evaluate((selector) => {
      const el = (
        globalThis as unknown as {
          document: { querySelector(s: string): { dataset: Record<string, string> } | null };
        }
      ).document.querySelector(selector);
      return el ? (el.dataset.e2eMark ?? null) : null;
    }, sel);
    expect(stillMarked, 'el iframe embebido no debe recrearse en los re-renders').toBe('orig');
  });
});
