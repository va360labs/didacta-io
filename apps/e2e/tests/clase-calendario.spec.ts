import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Spec de "añadir la clase al calendario" (mod.zoom-live). API-driven, sin
 * navegador: lo que hay que garantizar vive en el servidor.
 *
 * Los endpoints de calendario son PÚBLICOS a propósito — se abren desde el
 * email de confirmación y desde el recordatorio de 2h antes, y un cliente de
 * correo no manda bearer token. Por eso el spec comprueba dos cosas a la vez:
 * que funcionan sin autenticación Y que no filtran el `joinUrl` de Zoom
 * (ADR-017), que es lo único que la inscripción protege de verdad.
 */

interface SessionView {
  id: string;
  topic: string;
  joinUrl: string | null;
}

test.describe('mod.zoom-live · añadir clase al calendario', () => {
  test('los endpoints de calendario son públicos, generan el evento y nunca exponen el joinUrl', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    // 1. Admin crea la clase (stub de Zoom → joinUrl determinístico).
    const topic = `Clase calendario E2E ${stamp}`;
    const created = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        topic,
        startTime: '2026-12-01T18:00:00+01:00',
        durationMinutes: 90,
        hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        timezone: 'Europe/Madrid',
      }),
    });
    expect(created.ok, `create OK (got ${created.status})`).toBe(true);
    const session = (await created.json()) as SessionView;
    expect(session.joinUrl).toMatch(/stub-zoom/);

    // 2. El .ics se sirve SIN Authorization (lo abre el cliente de correo).
    const icsRes = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/calendar.ics`,
    );
    expect(icsRes.ok, `ics OK (got ${icsRes.status})`).toBe(true);
    expect(icsRes.headers.get('content-type')).toContain('text/calendar');
    expect(icsRes.headers.get('content-disposition')).toContain('.ics');

    const ics = await icsRes.text();
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain(`UID:${session.id}@didacta`);
    // 18:00 Madrid (UTC+1 en diciembre) = 17:00Z, +90 min = 18:30Z.
    expect(ics).toContain('DTSTART:20261201T170000Z');
    expect(ics).toContain('DTEND:20261201T183000Z');
    expect(ics.replace(/\r\n /g, '')).toContain(`SUMMARY:${topic}`);
    // Lo que NO puede llevar: el enlace de Zoom (un .ics se reenvía).
    expect(ics).not.toMatch(/stub-zoom|zoom\.us/i);

    // 3. Los deeplinks redirigen al proveedor con el evento ya montado.
    const google = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/calendar/google`,
      { redirect: 'manual' },
    );
    expect(google.status).toBe(302);
    const googleUrl = new URL(google.headers.get('location') ?? '');
    expect(googleUrl.host).toBe('calendar.google.com');
    expect(googleUrl.searchParams.get('text')).toBe(topic);
    expect(googleUrl.searchParams.get('dates')).toBe('20261201T170000Z/20261201T183000Z');
    expect(googleUrl.toString()).not.toMatch(/stub-zoom/);

    for (const [target, host] of [
      ['outlook', 'outlook.live.com'],
      ['office365', 'outlook.office.com'],
    ] as const) {
      const res = await fetch(
        `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/calendar/${target}`,
        { redirect: 'manual' },
      );
      expect(res.status, `${target} redirige`).toBe(302);
      expect(new URL(res.headers.get('location') ?? '').host).toBe(host);
    }

    // 4. Un id que no es UUID responde 404, no un 500 de Prisma.
    const malformed = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/no-es-uuid/calendar.ics`,
    );
    expect(malformed.status).toBe(404);

    // 5. Clase cancelada → el evento deja de existir.
    const cancel = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    expect(cancel.ok).toBe(true);
    const afterCancel = await fetch(
      `${API_URL}/api/v1/modules/zoom-live/sessions/${session.id}/calendar.ics`,
    );
    expect(afterCancel.status).toBe(404);
  });

  test('la plantilla del recordatorio de 2h está en el catálogo de /admin/emails', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    const res = await fetch(`${API_URL}/api/v1/admin/notifications/templates/catalog`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.ok, `catálogo OK (got ${res.status})`).toBe(true);
    const catalog = (await res.json()) as Array<{
      key: string;
      defaultBody: string;
      variables: Array<{ name: string }>;
    }>;

    const reminder = catalog.find((t) => t.key === 'zoom.class.reminder');
    expect(reminder, 'zoom.class.reminder está en el catálogo').toBeDefined();
    const varNames = reminder!.variables.map((v) => v.name);
    expect(varNames).toContain('calendarGoogleUrl');
    expect(varNames).toContain('calendarIcsUrl');

    // La confirmación de inscripción también ofrece guardar la clase.
    const confirmed = catalog.find((t) => t.key === 'zoom.class.registration.confirmed');
    expect(confirmed).toBeDefined();
    expect(confirmed!.defaultBody).toContain('calendarGoogleUrl');
  });

  test('el recordatorio avisa a los inscritos una sola vez y se rearma si la clase se mueve', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    // Clase dentro de la ventana de aviso (90 min): entra en el barrido.
    const enNoventaMin = new Date(Date.now() + 90 * 60_000);
    const created = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        topic: `Clase recordatorio E2E ${stamp}`,
        startTime: enNoventaMin.toISOString(),
        durationMinutes: 60,
        hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        timezone: 'Europe/Madrid',
      }),
    });
    expect(created.ok, `create OK (got ${created.status})`).toBe(true);
    const clase = (await created.json()) as SessionView;

    const alumno = await signup({
      tenantSlug,
      email: `e2e-recordatorio-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno Recordatorio',
    });
    const alumnoHeaders = {
      Authorization: `Bearer ${alumno.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };
    const reg = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${clase.id}/register`, {
      method: 'POST',
      headers: alumnoHeaders,
      body: '{}',
    });
    expect(reg.ok).toBe(true);

    const runSweep = async () => {
      const res = await fetch(`${API_URL}/api/v1/modules/zoom-live/admin/reminders/run`, {
        method: 'POST',
        headers: adminHeaders,
        body: '{}',
      });
      expect(res.ok, `sweep OK (got ${res.status})`).toBe(true);
      return (await res.json()) as { sessions: number; reminders: number };
    };

    /** ¿Cuántos avisos de esta clase tiene el alumno en su bandeja in-app? */
    const contarAvisos = async () => {
      const res = await fetch(`${API_URL}/api/v1/me/notifications`, { headers: alumnoHeaders });
      expect(res.ok, `notificaciones OK (got ${res.status})`).toBe(true);
      const items = (await res.json()) as Array<{ templateKey: string; body: string }>;
      return items.filter(
        (n) => n.templateKey === 'zoom.class.reminder' && n.body.includes(String(stamp)),
      ).length;
    };

    // 1. El barrido recoge la clase y avisa al inscrito.
    const primera = await runSweep();
    expect(primera.sessions).toBeGreaterThanOrEqual(1);
    expect(await contarAvisos()).toBe(1);

    // 2. Repetir el barrido NO reenvía: el claim es de un solo ganador.
    await runSweep();
    expect(await contarAvisos()).toBe(1);

    // 3. Reprogramar la clase rearma el aviso — la hora que se envió ya no vale.
    const movida = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${clase.id}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ startTime: new Date(Date.now() + 100 * 60_000).toISOString() }),
    });
    expect(movida.ok, `update OK (got ${movida.status})`).toBe(true);

    await runSweep();
    expect(await contarAvisos()).toBe(2);

    // Limpieza: la BD de test es persistente entre runs y «Próximas citas»
    // solo muestra 4 citas. Una clase futura abandonada aquí desplaza a la de
    // otro spec y lo tumba sin que nadie haya tocado su código.
    await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${clase.id}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
  });

  test('al inscribirse en /clase/[id] se ofrece guardar la clase en el calendario', async ({
    page,
  }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    const enTresDias = new Date();
    enTresDias.setDate(enTresDias.getDate() + 3);
    enTresDias.setHours(18, 0, 0, 0);
    const topic = `Clase modal calendario ${stamp}`;
    const created = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic,
        startTime: enTresDias.toISOString(),
        durationMinutes: 60,
        hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        timezone: 'Europe/Madrid',
      }),
    });
    expect(created.ok, `create OK (got ${created.status})`).toBe(true);
    const clase = (await created.json()) as SessionView;

    // Sesión REAL de alumno: con token falso el primer 401 rebota a /signin.
    const alumno = await signup({
      tenantSlug,
      email: `e2e-cal-modal-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno Calendario',
    });
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
      refreshToken: alumno.tokens.refreshToken,
      user: { ...alumno.user, onboardingCompletedAt: new Date().toISOString() },
    });

    await page.goto(`/clase/${clase.id}`);
    await expect(page.getByRole('heading', { name: topic })).toBeVisible();

    // Antes de inscribirse no hay nada que guardar.
    await expect(page.getByTestId('add-to-calendar')).toBeHidden();

    await page.getByRole('button', { name: 'Inscribirme' }).click();

    // El modal se abre solo tras la inscripción, con los cuatro destinos.
    const modal = page.getByTestId('add-to-calendar');
    await expect(modal).toBeVisible();
    for (const target of ['google', 'outlook', 'office365', 'calendar.ics']) {
      await expect(page.getByTestId(`calendar-${target}`)).toBeVisible();
    }
    // Cada enlace apunta al endpoint público de la clase, no al joinUrl.
    await expect(page.getByTestId('calendar-google')).toHaveAttribute(
      'href',
      `/api/v1/modules/zoom-live/sessions/${clase.id}/calendar/google`,
    );
    await expect(page.getByTestId('calendar-calendar.ics')).toHaveAttribute(
      'href',
      `/api/v1/modules/zoom-live/sessions/${clase.id}/calendar.ics`,
    );

    // Se puede cerrar y volver a abrir desde el botón permanente.
    // `exact`: el sidebar tiene un "Cerrar sesión" que también casaría.
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(modal).toBeHidden();
    await page.getByRole('button', { name: 'Añadir al calendario' }).click();
    await expect(page.getByTestId('add-to-calendar')).toBeVisible();

    // Limpieza (ver nota del spec del recordatorio): no dejamos clases
    // futuras vivas en la BD de test compartida.
    await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions/${clase.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    });
  });
});
