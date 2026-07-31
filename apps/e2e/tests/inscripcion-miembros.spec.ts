import { createHash, createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec end-to-end del flujo de inscripción de miembros (gate Telegram + OTP por
 * email + validación manual) y de la gestión admin de impagos.
 *
 * API-driven (igual que inscribe-by-api.spec.ts): los endpoints públicos del
 * flujo (`/inscripcion/*`) son anónimos y resuelven el tenant por el Host del
 * request. Al pegarle a `API_URL` (localhost:3000) el Host es `localhost:3000`,
 * que el seed siembra como dominio verificado del tenant bootstrap → resuelve OK
 * sin cabecera extra.
 *
 * LÍMITE conocido: la Bot API de Telegram (`getChatMember`) NO se puede stubbear
 * desde un test e2e (es una llamada de red real al servicio del backend). En
 * test esa llamada falla/timeout → el servicio devuelve `inGroup: 'unknown'`.
 * Por eso aquí solo verificamos los caminos observables sin mockear la Bot API:
 *   - firma de Telegram inválida → 401.
 *   - firma válida → 200 + ticket (con `inGroup: 'unknown'`, porque getChatMember
 *     real falla en test).
 * Los caminos `inGroup: 'true' | 'false'` (usuario dentro/fuera del grupo)
 * requieren stub de la Bot API y están cubiertos en los unit tests
 * (apps/api/tests/*.test.ts con fake-prisma + TelegramService mockeado).
 *
 * Secretos opcionales de test (si faltan, el caso se marca test.skip):
 *   - TELEGRAM_BOT_TOKEN | E2E_TELEGRAM_BOT_TOKEN: para firmar el Login Widget.
 *   - AUTH_SECRET | E2E_AUTH_SECRET: para firmar tickets de paso (igual que el
 *     backend con `signTicket`).
 */

const BOT_TOKEN = process.env.E2E_TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? '';
const AUTH_SECRET = process.env.E2E_AUTH_SECRET ?? process.env.AUTH_SECRET ?? '';

interface ConfigResponse {
  configured: boolean;
  botUsername: string | null;
}

/** Lee `GET /inscripcion/config` (estado del gate de Telegram). */
async function fetchConfig(): Promise<ConfigResponse> {
  const res = await fetch(`${API_URL}/api/v1/inscripcion/config`);
  expect(res.status, 'GET /inscripcion/config responde 200').toBe(200);
  return (await res.json()) as ConfigResponse;
}

/**
 * Firma un payload del Telegram Login Widget igual que el backend lo valida
 * (`TelegramService.verifyLoginHash`): secret = sha256(BOT_TOKEN) crudo, dcs =
 * campos != hash con valores a string, ordenados alfabéticamente y unidos por
 * salto de línea, HMAC-SHA256 en hex.
 */
function signTelegramPayload(
  fields: Record<string, string | number>,
  botToken: string,
): Record<string, string | number> & { hash: string } {
  const dcs = Object.entries(fields)
    .filter(([key, value]) => key !== 'hash' && value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return { ...fields, hash };
}

/**
 * Firma un ticket de paso igual que el backend (`signed-ticket.ts`):
 * `<b64url(payload+exp)>.<b64url(hmacSHA256)>`.
 */
function signTicket(payload: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const data = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

test.describe('Inscripción de miembros · gate Telegram + OTP + validación manual', () => {
  test('GET /inscripcion/config devuelve { configured, botUsername }', async () => {
    const config = await fetchConfig();
    expect(config).toHaveProperty('configured');
    expect(typeof config.configured).toBe('boolean');
    expect(config).toHaveProperty('botUsername');
    // botUsername es string (si hay TELEGRAM_BOT_USERNAME) o null.
    expect(['string', 'object'].includes(typeof config.botUsername)).toBe(true);
  });

  test('POST telegram/verify con firma INVÁLIDA → 401', async () => {
    const config = await fetchConfig();
    // Si el gate no está configurado el endpoint devuelve 503 antes de validar
    // la firma — el caso de firma inválida (401) solo es observable con el gate
    // activo (TELEGRAM_BOT_TOKEN + TELEGRAM_GROUP_ID en el backend).
    test.skip(
      !config.configured,
      'gate de Telegram no configurado en el backend (faltan TELEGRAM_BOT_TOKEN/GROUP_ID) → devuelve 503',
    );

    const res = await fetch(`${API_URL}/api/v1/inscripcion/telegram/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: '123456789',
        auth_date: Math.floor(Date.now() / 1000),
        // hash claramente inválido pero con longitud de hex SHA-256 (64 chars).
        hash: 'f'.repeat(64),
      }),
    });
    expect(res.status, 'firma inválida → 401').toBe(401);
  });

  test('POST telegram/verify con firma VÁLIDA → 200 + ticket (inGroup unknown en test)', async () => {
    const config = await fetchConfig();
    test.skip(!config.configured, 'gate de Telegram no configurado en el backend → devuelve 503');
    test.skip(
      !BOT_TOKEN,
      'falta E2E_TELEGRAM_BOT_TOKEN/TELEGRAM_BOT_TOKEN en el entorno del test: no se puede firmar el Login Widget',
    );

    const payload = signTelegramPayload(
      {
        id: '987654321',
        first_name: 'E2E',
        auth_date: Math.floor(Date.now() / 1000),
      },
      BOT_TOKEN,
    );

    const res = await fetch(`${API_URL}/api/v1/inscripcion/telegram/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status, 'firma válida → 200').toBe(200);
    const body = (await res.json()) as { ok: boolean; inGroup: string; ticket: string };
    expect(body.ok).toBe(true);
    expect(typeof body.ticket).toBe('string');
    expect(body.ticket.length).toBeGreaterThan(0);
    // getChatMember real falla/timeout en test (no se puede stubbear la Bot API
    // desde e2e) → el tri-estado degrada a 'unknown'. Los caminos 'true'/'false'
    // se cubren en unit tests con TelegramService mockeado.
    expect(body.inGroup).toBe('unknown');
  });

  test('POST otp/request sin ticket válido → 401', async () => {
    const res = await fetch(`${API_URL}/api/v1/inscripcion/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `e2e-insc-${Date.now()}@example.test`,
        ticket: 'no.es-un-ticket-valido',
      }),
    });
    expect(res.status, 'ticket inválido → 401').toBe(401);
  });

  test('POST otp/request con ticket de Telegram válido → 200', async () => {
    test.skip(
      !AUTH_SECRET,
      'falta E2E_AUTH_SECRET/AUTH_SECRET en el entorno del test: no se puede firmar el ticket de Telegram',
    );

    // Reproducimos el ticket que telegram/verify emite (purpose 'telegram',
    // TTL 900s), firmado con el mismo AUTH_SECRET que usa el backend.
    const ticket = signTicket(
      { telegramId: '987654321', inGroup: 'unknown', purpose: 'telegram' },
      AUTH_SECRET,
      900,
    );

    const res = await fetch(`${API_URL}/api/v1/inscripcion/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `e2e-insc-${Date.now()}@example.test`,
        ticket,
      }),
    });
    expect(res.status, 'ticket válido → 200').toBe(200);
    const body = (await res.json()) as { ok: boolean; expiresInSeconds: number };
    expect(body.ok).toBe(true);
    expect(body.expiresInSeconds).toBeGreaterThan(0);

    // Verificar el OTP requiere leer el código del email capturado (Mailpit u
    // otro buzón de pruebas). No hay helper de Mailpit en e2e ni endpoint que
    // exponga el código (viaja SOLO por email, la BD guarda su SHA-256) → el
    // paso otp/verify queda cubierto en unit tests con SmtpAdapter mockeado.
  });

  test('POST register sin verificationToken válido → 401', async () => {
    const res = await fetch(`${API_URL}/api/v1/inscripcion/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Miembro E2E',
        password: 'E2eInscripcion123!',
        verificationToken: 'no.es-un-token-valido',
      }),
    });
    expect(res.status, 'verificationToken inválido → 401').toBe(401);
  });

  test('GET decision con token inválido → redirect a /inscripcion-miembros/decision?outcome=invalid', async () => {
    // No seguimos el redirect (no queremos cargar el frontend): inspeccionamos
    // el 302 y el header Location directamente.
    const res = await fetch(`${API_URL}/api/v1/inscripcion/decision?token=token-inexistente`, {
      redirect: 'manual',
    });
    expect(res.status, 'decision con token inválido → 302').toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/inscripcion-miembros/decision');
    expect(location).toContain('outcome=invalid');
  });
});

test.describe('Admin · impagos de inscripción (member_payment_flag)', () => {
  test('GET payment-flags sin auth → 401', async () => {
    const res = await fetch(`${API_URL}/api/v1/inscripcion/payment-flags`);
    expect(res.status, 'sin bearer → 401').toBe(401);
  });

  test('admin: upsert + GET refleja el alta y DELETE lo borra', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    // telegramId único por run para no chocar con otros tests/runs paralelos.
    const telegramId = String(Date.now()).slice(-12);
    const auth = { Authorization: `Bearer ${adminToken}` };

    // 1) Con bearer admin la lista responde 200 (array).
    const initialRes = await fetch(`${API_URL}/api/v1/inscripcion/payment-flags`, {
      headers: auth,
    });
    expect(initialRes.status, 'admin lista → 200').toBe(200);
    expect(Array.isArray(await initialRes.json())).toBe(true);

    // 2) Upsert: crea el flag de impago.
    const upsertRes = await fetch(`${API_URL}/api/v1/inscripcion/payment-flags`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegramId,
        name: 'Moroso E2E',
        isDelinquent: true,
        note: 'Alta de prueba e2e',
      }),
    });
    expect(upsertRes.status, 'upsert → 2xx').toBeLessThan(300);
    const upserted = (await upsertRes.json()) as { id: string };
    expect(typeof upserted.id).toBe('string');

    // 3) GET (filtrando por el telegramId) refleja el alta.
    const listRes = await fetch(
      `${API_URL}/api/v1/inscripcion/payment-flags?q=${encodeURIComponent(telegramId)}`,
      { headers: auth },
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{
      id: string;
      telegramId: string;
      isDelinquent: boolean;
    }>;
    const found = list.find((f) => f.telegramId === telegramId);
    expect(found, 'el flag recién creado aparece en la lista').toBeDefined();
    expect(found!.id).toBe(upserted.id);
    expect(found!.isDelinquent).toBe(true);

    // 4) DELETE lo borra.
    const delRes = await fetch(`${API_URL}/api/v1/inscripcion/payment-flags/${upserted.id}`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(delRes.status, 'delete → 2xx').toBeLessThan(300);

    // 5) GET ya no lo encuentra.
    const afterRes = await fetch(
      `${API_URL}/api/v1/inscripcion/payment-flags?q=${encodeURIComponent(telegramId)}`,
      { headers: auth },
    );
    expect(afterRes.status).toBe(200);
    const after = (await afterRes.json()) as Array<{ telegramId: string }>;
    expect(after.some((f) => f.telegramId === telegramId)).toBe(false);
  });
});
