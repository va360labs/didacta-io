import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Panel de calidad del tutor IA (/admin/ia/tutor).
 *
 * Cubre los caminos que NO necesitan un proveedor de IA configurado: listado
 * de preguntas y respuestas, autorización, validación y el informe mensual.
 *
 * Crear una corrección sí llama al proveedor de embeddings (hay que vectorizar
 * la pregunta para poder recuperarla luego), así que ese camino se cubre en los
 * tests unitarios del módulo con el `embedFn` mockeado —
 * `modules/ai-tutor/tests/review.service.test.ts` — y no aquí, donde
 * dependeríamos de una clave de OpenAI viva para que el CI pase.
 */

const TENANT = process.env.E2E_TENANT_SLUG ?? 'va360';
const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000';

/**
 * GET autenticado que devuelve estado y cuerpo ya parseado.
 *
 * El cuerpo de una `Response` sólo se puede leer UNA vez: hacer
 * `expect(res.status, await res.text())` y después `res.json()` revienta con
 * "Body is unusable". Se lee una sola vez aquí y el texto crudo viaja como
 * mensaje del assert para que un fallo diga qué contestó el servidor.
 */
async function get(
  path: string,
  bearer: string,
): Promise<{ status: number; raw: string; body: unknown }> {
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${bearer}` } });
  const raw = await res.text();
  return { status: res.status, raw, body: raw ? JSON.parse(raw) : null };
}

test.describe('Tutor IA · revisión de respuestas (API)', () => {
  test('el listado devuelve la forma esperada y el contador de pendientes', async () => {
    const bearer = await adminTokenForBootstrap(TENANT);
    const { status, raw, body } = await get('/api/v1/admin/ai-tutor/answers', bearer);
    expect(status, raw).toBe(200);

    const data = body as Record<string, unknown>;
    for (const campo of ['items', 'total', 'page', 'pageSize', 'pendientes']) {
      expect(data[campo], `campo ${campo} presente`).toBeDefined();
    }
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.total).toBe('number');
    expect(typeof data.pendientes).toBe('number');
    expect(data.page).toBe(1);
  });

  test('los filtros de estado y de "sin respaldo" no rompen el listado', async () => {
    const bearer = await adminTokenForBootstrap(TENANT);
    const { status, raw, body } = await get(
      '/api/v1/admin/ai-tutor/answers?status=PENDING&soloSinCitas=true&pageSize=5',
      bearer,
    );
    expect(status, raw).toBe(200);
    const data = body as { pageSize: number; items: unknown[] };
    expect(data.pageSize).toBe(5);
    expect(data.items.length).toBeLessThanOrEqual(5);
  });

  test('un estado inventado se rechaza con 400', async () => {
    const bearer = await adminTokenForBootstrap(TENANT);
    const res = await fetch(`${API_URL}/api/v1/admin/ai-tutor/answers?status=banana`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(res.status).toBe(400);
  });

  test('sin sesión no se ve nada', async () => {
    const res = await fetch(`${API_URL}/api/v1/admin/ai-tutor/answers`);
    expect(res.status).toBe(401);
  });

  test('un alumno no puede leer lo que preguntan los demás', async () => {
    // Es el punto sensible de esta pantalla: enseña preguntas con nombre y
    // apellidos. Si se cuela un rol no admin, es una fuga de datos personales.
    const alumno = await signup({
      tenantSlug: TENANT,
      email: `e2e-tutor-alumno-${Date.now()}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno E2E',
    });
    const res = await fetch(`${API_URL}/api/v1/admin/ai-tutor/answers`, {
      headers: { Authorization: `Bearer ${alumno.tokens.accessToken}` },
    });
    expect(res.status).toBe(401);
  });

  test('revisar una respuesta que no existe devuelve 404 con código propio', async () => {
    const bearer = await adminTokenForBootstrap(TENANT);
    const res = await fetch(`${API_URL}/api/v1/admin/ai-tutor/answers/${UUID_INEXISTENTE}/review`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'OK' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('AI_TUTOR_MESSAGE_NOT_FOUND');
  });

  test('marcar como corregida sin escribir la respuesta buena se rechaza', async () => {
    // Corregir sin dar la versión correcta no arregla nada: dejaría la respuesta
    // marcada como mala y al tutor repitiéndola igual.
    const bearer = await adminTokenForBootstrap(TENANT);
    const res = await fetch(`${API_URL}/api/v1/admin/ai-tutor/answers/${UUID_INEXISTENTE}/review`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'CORRECTED' }),
    });
    expect(res.status).toBe(400);
  });

  test('el conocimiento validado se lista aunque esté vacío', async () => {
    const bearer = await adminTokenForBootstrap(TENANT);
    const { status, raw, body } = await get('/api/v1/admin/ai-tutor/corrections', bearer);
    expect(status, raw).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });
});

test.describe('Tutor IA · informe mensual (API)', () => {
  test('un mes sin preguntas devuelve un informe a cero, no un error', async () => {
    const bearer = await adminTokenForBootstrap(TENANT);
    const { status, raw, body } = await get(
      '/api/v1/admin/ai-tutor/report/monthly?mes=2020-01',
      bearer,
    );
    expect(status, raw).toBe(200);

    const informe = body as {
      mes: string;
      desde: string;
      hasta: string;
      totalPreguntas: number;
      temas: unknown[];
      truncado: boolean;
    };
    expect(informe.mes).toBe('2020-01');
    expect(informe.desde).toBe('2020-01-01T00:00:00.000Z');
    // Límite superior exclusivo: el 1 de febrero ya no cuenta.
    expect(informe.hasta).toBe('2020-02-01T00:00:00.000Z');
    expect(informe.totalPreguntas).toBe(0);
    expect(informe.temas).toEqual([]);
    expect(informe.truncado).toBe(false);
  });

  test('sin mes usa el mes en curso', async () => {
    const bearer = await adminTokenForBootstrap(TENANT);
    const { status, raw, body } = await get('/api/v1/admin/ai-tutor/report/monthly', bearer);
    expect(status, raw).toBe(200);
    const ahora = new Date();
    const esperado = `${ahora.getUTCFullYear()}-${String(ahora.getUTCMonth() + 1).padStart(2, '0')}`;
    expect((body as { mes: string }).mes).toBe(esperado);
  });

  test('un mes mal escrito se rechaza con 400', async () => {
    const bearer = await adminTokenForBootstrap(TENANT);
    const res = await fetch(`${API_URL}/api/v1/admin/ai-tutor/report/monthly?mes=2026-13`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(res.status).toBe(400);
  });
});

test.describe('Tutor IA · pantalla del admin', () => {
  test('/admin/ia/tutor abre con sus tres pestañas', async ({ page, baseURL }) => {
    // El login va contra el origen de la web para que el token valga para el
    // backend al que la web proxea de verdad, sea cual sea.
    const signin = await page.request.post(`${baseURL}/api/v1/auth/signin`, {
      data: {
        tenantSlug: TENANT,
        email: process.env.E2E_ADMIN_EMAIL,
        password: process.env.E2E_ADMIN_PASSWORD,
      },
    });
    expect(signin.ok(), await signin.text()).toBe(true);
    const sesion = (await signin.json()) as {
      tokens: { accessToken: string; refreshToken: string };
      user: Record<string, unknown>;
    };

    await page.goto('/');
    await injectSession(page, {
      accessToken: sesion.tokens.accessToken,
      refreshToken: sesion.tokens.refreshToken,
      user: {
        ...(sesion.user as never),
        // Sin esto el gate de onboarding secuestra la navegación.
        onboardingCompletedAt: new Date().toISOString(),
      },
    });

    await page.goto('/admin/ia/tutor');

    await expect(page.getByRole('heading', { name: 'Tutor IA', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Revisión' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Conocimiento validado' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Informe mensual' })).toBeVisible();
  });
});
