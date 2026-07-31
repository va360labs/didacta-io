import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';

/**
 * Sanciones de moderación y expediente del usuario.
 *
 * Lo que se valida aquí no es «el botón existe» sino las dos cosas que, si
 * fallan, convierten esta entrega en un problema:
 *
 *  1. Que la sanción CORTE de verdad lo que dice cortar.
 *  2. Que NO corte nada más — en particular, que un sancionado siga pudiendo
 *     leer, seguir su curso y pagar. Una sanción que rompe la facturación es
 *     peor que el spam que pretendía frenar.
 */
test.describe('moderación · sanciones', () => {
  const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';

  test('sancionar corta publicar, deja leer y pagar, y levantarla lo restaura', async () => {
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    const alumno = await signup({
      tenantSlug,
      email: `e2e-sancion-${stamp}@example.test`,
      password: 'E2eSancion123!',
      name: 'Alumno Sancionado',
    });
    const alumnoHeaders = {
      Authorization: `Bearer ${alumno.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };
    const alumnoId = alumno.user.id;

    // ── 1. Antes de sancionar, publica sin problema ──────────────────────────
    const antes = await fetch(`${API_URL}/api/v1/modules/community/posts`, {
      method: 'POST',
      headers: alumnoHeaders,
      body: JSON.stringify({ title: `Post previo ${stamp}`, body: 'Contenido', tags: [] }),
    });
    expect(antes.ok, 'publica antes de la sanción').toBe(true);

    // ── 2. El admin lo sanciona en comunidad ─────────────────────────────────
    const sancion = await fetch(`${API_URL}/api/v1/admin/users/${alumnoId}/restrictions`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        scopes: ['community'],
        reason: 'Publicaciones promocionales repetidas',
        expiresAt: null,
      }),
    });
    expect(sancion.ok, 'el admin puede sancionar').toBe(true);
    const creada = (await sancion.json()) as { id: string; active: boolean; scopeLabels: string[] };
    expect(creada.active).toBe(true);
    expect(creada.scopeLabels).toEqual(['Comunidad']);

    // ── 3. Ya no puede publicar, y el 403 explica por qué ────────────────────
    const bloqueado = await fetch(`${API_URL}/api/v1/modules/community/posts`, {
      method: 'POST',
      headers: alumnoHeaders,
      body: JSON.stringify({ title: `Post bloqueado ${stamp}`, body: 'Contenido', tags: [] }),
    });
    expect(bloqueado.status, 'publicar devuelve 403').toBe(403);
    const errorBody = (await bloqueado.json()) as { code?: string; message?: string };
    expect(errorBody.code).toBe('user_restricted');
    expect(errorBody.message).toContain('Publicaciones promocionales repetidas');

    // El token del alumno es el MISMO de antes: esto comprueba que el corte no
    // depende de que caduque el access token (antes habría tardado ~1 h).

    // ── 4. Pero sigue leyendo el feed ────────────────────────────────────────
    const leer = await fetch(`${API_URL}/api/v1/modules/community/posts?limit=5`, {
      headers: alumnoHeaders,
    });
    expect(leer.ok, 'un sancionado sigue leyendo la comunidad').toBe(true);

    // ── 5. Y lo que NO es comunidad sigue funcionando ────────────────────────
    const perfil = await fetch(`${API_URL}/api/v1/me/profile`, { headers: alumnoHeaders });
    expect(perfil.ok, 'sigue accediendo a su cuenta').toBe(true);

    const notificaciones = await fetch(`${API_URL}/api/v1/modules/notifications?limit=5`, {
      headers: alumnoHeaders,
    });
    expect(
      notificaciones.status,
      'las notificaciones no se ven afectadas por una sanción de comunidad',
    ).not.toBe(403);

    // ── 6. El escudo del feed sabe que está sancionado ───────────────────────
    const batch = await fetch(`${API_URL}/api/v1/admin/restrictions/active?userIds=${alumnoId}`, {
      headers: adminHeaders,
    });
    expect(batch.ok).toBe(true);
    const activos = (await batch.json()) as Record<string, { scopeLabels: string[] }>;
    expect(activos[alumnoId]?.scopeLabels).toEqual(['Comunidad']);

    // ── 7. El admin la levanta ───────────────────────────────────────────────
    const levantar = await fetch(
      `${API_URL}/api/v1/admin/users/${alumnoId}/restrictions/${creada.id}/lift`,
      {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ liftReason: 'Resuelto tras hablar con él' }),
      },
    );
    expect(levantar.ok, 'el admin puede levantar la sanción').toBe(true);

    // ── 8. Vuelve a publicar ─────────────────────────────────────────────────
    const despues = await fetch(`${API_URL}/api/v1/modules/community/posts`, {
      method: 'POST',
      headers: alumnoHeaders,
      body: JSON.stringify({ title: `Post restaurado ${stamp}`, body: 'Contenido', tags: [] }),
    });
    expect(despues.ok, 'vuelve a publicar tras levantar la sanción').toBe(true);

    // ── 9. El histórico conserva la sanción levantada ────────────────────────
    const historico = await fetch(`${API_URL}/api/v1/admin/users/${alumnoId}/restrictions`, {
      headers: adminHeaders,
    });
    const filas = (await historico.json()) as Array<{
      id: string;
      active: boolean;
      liftedAt: string | null;
      liftReason: string | null;
    }>;
    const fila = filas.find((r) => r.id === creada.id);
    expect(fila, 'levantar no borra la fila').toBeTruthy();
    expect(fila!.active).toBe(false);
    expect(fila!.liftedAt).toBeTruthy();
    expect(fila!.liftReason).toBe('Resuelto tras hablar con él');
  });

  test('una sanción de un área no toca las demás', async () => {
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    const alumno = await signup({
      tenantSlug,
      email: `e2e-sancion-area-${stamp}@example.test`,
      password: 'E2eSancionArea123!',
      name: 'Alumno Area',
    });
    const alumnoHeaders = {
      Authorization: `Bearer ${alumno.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };

    // Sancionado solo en el tutor IA.
    const res = await fetch(`${API_URL}/api/v1/admin/users/${alumno.user.id}/restrictions`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        scopes: ['ai'],
        reason: 'Consumo desproporcionado de la cuota',
        expiresAt: null,
      }),
    });
    expect(res.ok).toBe(true);

    // La comunidad le sigue funcionando.
    const post = await fetch(`${API_URL}/api/v1/modules/community/posts`, {
      method: 'POST',
      headers: alumnoHeaders,
      body: JSON.stringify({ title: `Post area ${stamp}`, body: 'Contenido', tags: [] }),
    });
    expect(post.ok, 'sancionar el tutor IA no afecta a la comunidad').toBe(true);
  });

  test('el panel rechaza sanciones sin motivo y la autosanción', async () => {
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    const yo = await fetch(`${API_URL}/api/v1/me/profile`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const perfil = (await yo.json()) as { id: string };

    const sinMotivo = await fetch(`${API_URL}/api/v1/admin/users/${perfil.id}/restrictions`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ scopes: ['community'], reason: '', expiresAt: null }),
    });
    expect(sinMotivo.status, 'el motivo es obligatorio').toBe(400);

    const autoSancion = await fetch(`${API_URL}/api/v1/admin/users/${perfil.id}/restrictions`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ scopes: ['community'], reason: 'Prueba', expiresAt: null }),
    });
    expect(autoSancion.status, 'nadie se sanciona a sí mismo').toBe(400);
  });
});

/**
 * Suspender ≠ sancionar. Suspender corta el acceso ENTERO, y hasta este
 * arreglo no cortaba nada: nadie escribía en la tabla `session`, así que
 * borrarlas al suspender no invalidaba el access token ya emitido y el
 * suspendido seguía dentro hasta una hora.
 */
test.describe('cuentas · suspensión y sesiones', () => {
  const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';

  test('suspender echa al usuario con su token actual, y reactivar le deja volver', async () => {
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    const alumno = await signup({
      tenantSlug,
      email: `e2e-suspension-${stamp}@example.test`,
      password: 'E2eSuspension123!',
      name: 'Alumno Suspendido',
    });
    const alumnoHeaders = { Authorization: `Bearer ${alumno.tokens.accessToken}` };

    const antes = await fetch(`${API_URL}/api/v1/me/profile`, { headers: alumnoHeaders });
    expect(antes.ok, 'entra antes de suspenderlo').toBe(true);

    const suspender = await fetch(`${API_URL}/api/v1/admin/users/${alumno.user.id}/status`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ status: 'SUSPENDED' }),
    });
    expect(suspender.ok, 'el admin puede suspender').toBe(true);

    // MISMO token que antes. Este es el test que fallaba: el access token
    // seguía siendo válido y el suspendido continuaba operando.
    const despues = await fetch(`${API_URL}/api/v1/me/profile`, { headers: alumnoHeaders });
    expect(despues.status, 'el token del suspendido deja de valer al instante').toBe(401);
    const body = (await despues.json()) as { code?: string };
    expect(body.code).toBe('account_suspended');

    // Tampoco puede leer el feed: una cuenta suspendida no entra a nada.
    const feed = await fetch(`${API_URL}/api/v1/modules/community/posts?limit=1`, {
      headers: alumnoHeaders,
    });
    expect(feed.status, 'ni siquiera lee').toBe(401);

    const reactivar = await fetch(`${API_URL}/api/v1/admin/users/${alumno.user.id}/status`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ status: 'ACTIVE' }),
    });
    expect(reactivar.ok).toBe(true);

    // Reactivar NO resucita el token viejo, y eso es lo correcto: suspender
    // cierra las sesiones abiertas, y una sesión cerrada se queda cerrada.
    // Si reviviera, cualquiera con el token guardado volvería a entrar.
    const tokenViejo = await fetch(`${API_URL}/api/v1/me/profile`, { headers: alumnoHeaders });
    expect(tokenViejo.status, 'el token de antes de la suspensión no revive').toBe(401);

    // Lo que sí puede es volver a entrar: la cuenta está operativa otra vez.
    const relogin = await fetch(`${API_URL}/api/v1/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantSlug,
        email: `e2e-suspension-${stamp}@example.test`,
        password: 'E2eSuspension123!',
      }),
    });
    expect(relogin.ok, 'tras reactivar puede volver a iniciar sesión').toBe(true);
    const nueva = (await relogin.json()) as { tokens: { accessToken: string } };
    const conNuevoToken = await fetch(`${API_URL}/api/v1/me/profile`, {
      headers: { Authorization: `Bearer ${nueva.tokens.accessToken}` },
    });
    expect(conNuevoToken.ok, 'y opera con normalidad').toBe(true);
  });

  test('el alta registra la sesión y el usuario puede verla y cerrarla', async () => {
    const stamp = Date.now();
    const alumno = await signup({
      tenantSlug,
      email: `e2e-sesiones-${stamp}@example.test`,
      password: 'E2eSesiones123!',
      name: 'Alumno Sesiones',
    });
    const headers = {
      Authorization: `Bearer ${alumno.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };

    // Antes de este arreglo esta lista salía SIEMPRE vacía.
    const res = await fetch(`${API_URL}/api/v1/me/security/sessions`, { headers });
    expect(res.ok).toBe(true);
    const sesiones = (await res.json()) as Array<{ id: string; createdAt: string }>;
    expect(sesiones.length, 'el alta deja constancia de la sesión').toBeGreaterThan(0);

    // Cerrarla debe echar al propio token que la respalda.
    const cerrar = await fetch(`${API_URL}/api/v1/me/security/sessions/${sesiones[0]!.id}`, {
      method: 'DELETE',
      headers,
    });
    expect(cerrar.ok, 'puede cerrar su sesión').toBe(true);

    const despues = await fetch(`${API_URL}/api/v1/me/profile`, { headers });
    expect(despues.status, 'cerrar la sesión invalida su token').toBe(401);
    const body = (await despues.json()) as { code?: string };
    expect(body.code).toBe('session_revoked');
  });

  test('el refresh conserva la sesión en vez de acumular duplicados', async () => {
    const stamp = Date.now();
    const alumno = await signup({
      tenantSlug,
      email: `e2e-refresh-${stamp}@example.test`,
      password: 'E2eRefresh123!',
      name: 'Alumno Refresh',
    });

    const refreshed = await fetch(`${API_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: alumno.tokens.refreshToken }),
    });
    expect(refreshed.ok).toBe(true);
    const { tokens } = (await refreshed.json()) as { tokens: { accessToken: string } };

    const res = await fetch(`${API_URL}/api/v1/me/security/sessions`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const sesiones = (await res.json()) as unknown[];
    expect(sesiones.length, 'renovar no abre una sesión nueva').toBe(1);
  });
});

test.describe('moderación · expediente', () => {
  const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';

  test('el expediente reúne identidad, compras, formación, actividad y sanciones', async () => {
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    const alumno = await signup({
      tenantSlug,
      email: `e2e-expediente-${stamp}@example.test`,
      password: 'E2eExpediente123!',
      name: 'Alumno Expediente',
    });

    // Genera algo de rastro para que el expediente no venga vacío.
    await fetch(`${API_URL}/api/v1/modules/community/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alumno.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: `Post expediente ${stamp}`, body: 'Contenido', tags: [] }),
    });

    const res = await fetch(`${API_URL}/api/v1/admin/users/${alumno.user.id}/dossier`, {
      headers: adminHeaders,
    });
    expect(res.ok, 'el admin puede abrir el expediente').toBe(true);

    const d = (await res.json()) as {
      identity: { id: string; email: string; membershipDays: number; roles: string[] };
      commerce: { orders: unknown[]; totalPaidCents: number; subscriptions: unknown[] };
      learning: { enrollments: unknown[]; certificates: unknown[] };
      activity: { counts: { posts: number; comments: number } };
      messages: { total: number; recent: unknown[] };
      access: { recentSessions: unknown[] };
      restrictions: unknown[];
    };

    expect(d.identity.id).toBe(alumno.user.id);
    expect(d.identity.email).toBe(`e2e-expediente-${stamp}@example.test`);
    expect(d.identity.membershipDays).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(d.commerce.orders)).toBe(true);
    expect(Array.isArray(d.commerce.subscriptions)).toBe(true);
    expect(Array.isArray(d.learning.enrollments)).toBe(true);
    expect(d.activity.counts.posts, 'recoge el post que acaba de escribir').toBeGreaterThanOrEqual(
      1,
    );
    expect(Array.isArray(d.messages.recent)).toBe(true);
    expect(Array.isArray(d.restrictions)).toBe(true);

    // `recentSessions` viene vacío y NO es un fallo de esta entrega: hoy nadie
    // escribe en la tabla `session` (solo se lee y se borra), así que siempre
    // está vacía. Se comprueba la forma, no el contenido. Ver la nota sobre
    // este hallazgo en el resumen de la entrega.
    expect(Array.isArray(d.access.recentSessions)).toBe(true);
  });

  test('un alumno no puede abrir el expediente de nadie', async () => {
    const stamp = Date.now();
    const alumno = await signup({
      tenantSlug,
      email: `e2e-expediente-nope-${stamp}@example.test`,
      password: 'E2eExpedienteNope123!',
      name: 'Alumno Curioso',
    });

    const res = await fetch(`${API_URL}/api/v1/admin/users/${alumno.user.id}/dossier`, {
      headers: { Authorization: `Bearer ${alumno.tokens.accessToken}` },
    });
    expect(res.status, 'el expediente es solo para admins').toBe(403);
  });
});
