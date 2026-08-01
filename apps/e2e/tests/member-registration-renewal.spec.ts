import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec e2e del recordatorio de pago desde el panel de solicitudes de inscripción
 * (`/admin/solicitudes-miembros`): endpoints `GET .../renewal-context` y
 * `POST .../renewal-email` del admin del módulo (`/modules/member-registration/admin`).
 *
 * API-driven (igual que member-registration.spec.ts). Cubrimos los caminos
 * OBSERVABLES sin infraestructura externa: autorización (401), validación (400) y
 * "no encontrado" (404). El happy-path completo (resolver el enlace de Stripe y
 * enviar por SMTP) NO se puede ejercitar en e2e — requiere una cuenta Stripe
 * conectada con permiso de Facturas + SMTP del tenant — y queda cubierto en los
 * unit tests (apps/api/tests/member-registration-admin-renewal.controller.test.ts +
 * modules/payment-connections/tests con resolveRenewalUrlByRef).
 */

const BASE = `${API_URL}/api/v1/modules/member-registration/admin`;
// UUID válido que no existe en la BD (un id no-UUID haría tirar el cast de
// Prisma con 500 en vez de ejercitar el camino "no encontrado").
const ABSENT_USER = '00000000-0000-4000-8000-0000000000e2';

test.describe('Admin · recordatorio de pago desde solicitudes de inscripción', () => {
  test('GET renewal-context sin auth → 401', async () => {
    const res = await fetch(`${BASE}/requests/${ABSENT_USER}/renewal-context?subscriptionId=sub_x`);
    expect(res.status, 'sin bearer → 401').toBe(401);
  });

  test('POST renewal-email sin auth → 401', async () => {
    const res = await fetch(`${BASE}/requests/${ABSENT_USER}/renewal-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Hola', body: 'Paga aquí.' }),
    });
    expect(res.status, 'sin bearer → 401').toBe(401);
  });

  test('admin: caminos de validación y "no encontrado"', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const auth = { Authorization: `Bearer ${adminToken}` };
    const json = { ...auth, 'Content-Type': 'application/json' };

    // renewal-context sin subscriptionId → 200 con la plantilla del tenant y
    // sin enlace de renovación (sirve para escribir a quien NO tiene
    // suscripción detectada; subscriptionId es opcional desde 3b7325e).
    const noSub = await fetch(`${BASE}/requests/${ABSENT_USER}/renewal-context`, { headers: auth });
    expect(noSub.status, 'sin subscriptionId → 200 (plantilla sin enlace)').toBe(200);
    const noSubBody = (await noSub.json()) as { template: unknown; renewalUrl: unknown };
    expect(noSubBody.template, 'la plantilla del tenant viene igualmente').toBeTruthy();
    expect(noSubBody.renewalUrl, 'sin suscripción no hay enlace de renovación').toBeNull();

    // renewal-context de una suscripción que no está en el lookup → 404.
    const notFound = await fetch(
      `${BASE}/requests/${ABSENT_USER}/renewal-context?subscriptionId=sub_inexistente`,
      { headers: auth },
    );
    expect(notFound.status, 'suscripción no encontrada → 404').toBe(404);

    // renewal-email con cuerpo vacío → 400 (validación zod antes del handler).
    const badBody = await fetch(`${BASE}/requests/${ABSENT_USER}/renewal-email`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ subject: '', body: '' }),
    });
    expect(badBody.status, 'cuerpo vacío → 400').toBe(400);

    // renewal-email (cuerpo válido) a un solicitante inexistente → 404.
    const noUser = await fetch(`${BASE}/requests/${ABSENT_USER}/renewal-email`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ subject: 'Renueva tu plan', body: 'Paga aquí: https://example.test' }),
    });
    expect(noUser.status, 'solicitante inexistente → 404').toBe(404);
  });
});
