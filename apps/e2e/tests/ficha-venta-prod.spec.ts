import { expect, test } from '@playwright/test';
import { signin } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Smoke en PRODUCCIÓN de la ficha de venta de un curso que el alumno no tiene.
 * No crea nada: entra con la cuenta de pruebas y mira la ficha del curso que
 * está a la venta. Solo se ejecuta con PROD_SMOKE=1.
 */
const enabled = process.env.PROD_SMOKE === '1';

test.describe('PROD · ficha de venta del curso', () => {
  test.skip(!enabled, 'Solo con PROD_SMOKE=1');

  test('muestra precio real, acceso total y los CTAs del contenido bloqueado', async ({ page }) => {
    const email = process.env.PROD_TEST_EMAIL ?? '';
    const password = process.env.PROD_TEST_PASSWORD ?? '';
    const slug = process.env.PROD_COURSE_SLUG ?? 'curso-de-claude-code-de-cero-a-experto';

    const sesion = await signin({
      tenantSlug: process.env.PROD_TENANT_SLUG ?? 'va360',
      email,
      password,
    });
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: sesion.tokens.accessToken,
      user: { ...sesion.user, onboardingCompletedAt: new Date().toISOString() },
    });

    // Diagnóstico: registramos errores de consola y respuestas 4xx/5xx para
    // que un fallo aquí diga POR QUÉ, en vez de solo "no encontré el título".
    const errores: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errores.push(`console: ${m.text()}`);
    });
    page.on('pageerror', (e) => errores.push(`pageerror: ${e.message}`));
    page.on('response', (r) => {
      if (r.status() >= 400) errores.push(`http ${r.status()} ${r.url()}`);
    });

    await page.goto(`/cursos/${slug}`);
    await page.waitForTimeout(4000);
    if (errores.length) console.log('--- DIAGNÓSTICO ---\n' + errores.join('\n'));

    // Panel de venta con sus beneficios.
    await expect(page.getByRole('heading', { name: 'Empieza este curso' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/Acceso de por vida/i)).toBeVisible();

    // El curso se vende con precio único (una caja) o en varios formatos (una
    // rejilla de tarjetas). Ambas formas muestran importe y "pago único", así
    // que el spec cubre las dos sin depender del curso concreto.
    const cajasPrecio = page.getByText('Pago único · IVA incluido');
    await expect(cajasPrecio.first()).toBeVisible();
    await expect(cajasPrecio.first().locator('..')).toContainText('€');
    await expect(page.getByRole('button', { name: /^Comprar/i }).first()).toBeVisible();

    const formatos = await cajasPrecio.count();
    if (formatos > 1) {
      // Varios formatos: rejilla comparable con una recomendación visible.
      await expect(page.getByRole('heading', { name: 'Elige tu formato' })).toBeVisible();
      await expect(page.getByText('El más elegido').first()).toBeVisible();
    }

    // Caja de acceso total: precio de ENTRADA (el plan más barato) y la nota
    // que quita la objeción de la permanencia.
    await expect(page.getByText('Acceso total', { exact: false })).toBeVisible();
    // El texto lleva <strong> dentro, así que se comprueba sobre el contenedor.
    const cajaTotal = page.getByText('Cancela cuando quieras, sin permanencia').locator('..');
    await expect(cajaTotal).toContainText('Accede a');
    await expect(cajaTotal).toContainText('desde');
    // Hay DOS enlaces a la membresía a propósito (la caja de arriba y el bloque
    // bloqueado de abajo), así que se compara el de la caja de forma exacta.
    await expect(page.getByRole('link', { name: 'Ver membresías', exact: true })).toHaveAttribute(
      'href',
      '/unete',
    );

    // El muro de contenido bloqueado ahora sí ofrece salida.
    await expect(page.getByRole('heading', { name: 'Contenido bloqueado' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Comprar por/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Desbloquea todo/i })).toBeVisible();

    await page.screenshot({ path: 'apps/e2e/test-results/prod-ficha-venta.png', fullPage: true });
  });
});
