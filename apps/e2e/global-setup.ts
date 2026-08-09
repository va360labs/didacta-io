/**
 * Arranque único de la suite E2E.
 *
 * Existe por un motivo concreto: hasta ahora el arnés NUNCA levantaba el
 * producto entero, y las piezas que faltaban no fallaban — degradaban en
 * silencio. El resultado era una tanda con decenas de tests en rojo cuyos
 * síntomas (redirecciones a `/onboarding`, listas vacías, 401 en webhooks,
 * realtime que no llega) parecían bugs de producto y no lo eran.
 *
 * Este fichero convierte cada una de esas degradaciones silenciosas en un
 * fallo ruidoso ANTES de correr un solo test, y deja el entorno en el estado
 * que la suite da por supuesto:
 *
 *   1. api, web Y la api a través del rewrite de Next responden — las tres,
 *      porque la suite entera habla por el rewrite y ese camino puede estar
 *      caído con la api directa perfectamente sana.
 *   2. Redis configurado — sin él la mensajería realtime es un no-op silencioso.
 *   3. Cupo de rate limit con margen — con Redis activo el limiter deja de
 *      fallar abierto y el cupo público por defecto (30 req/min COMPARTIDOS
 *      por todo el tráfico anónimo) estrangula la suite.
 *   4. Secretos de webhooks de pago presentes.
 *   5. Espacios de sistema sembrados (`prisma/seed.sql`).
 *   6. Onboarding cerrado para los admins sembrados.
 *
 * Regla que rige todo el fichero: «no he podido comprobarlo» NUNCA se traduce
 * a un estado. Un no-2xx inesperado es un fallo con mensaje, no un estado
 * inferido — que es exactamente el agujero que tuvo `readInstanceState` y que
 * dejaba saltarse ENTERA la preparación del entorno sin que nada fallara.
 *
 * La receta completa para dejar el stack en pie está en `scripts/e2e-stack.sh`.
 */

import { completeOnboarding, ONBOARDING_AVATAR_URL, signin, SMOKE_API_URL } from './helpers/api';

/** Techo mínimo de rate limit por minuto para que una tanda serie no se ahogue. */
const MIN_RATE_LIMIT_PER_MIN = 1_000;

/** Espacios de sistema que crea `packages/database/prisma/seed.sql`. */
const SYSTEM_SPACE_SLUGS = ['general', 'anuncios', 'preguntas', 'recursos'];

/** Cuánto esperamos a que api y web respondan antes de rendirnos. */
const READINESS_TIMEOUT_MS = 120_000;
const READINESS_POLL_MS = 1_000;

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3010';
const API_URL = process.env.E2E_API_URL ?? BASE_URL;
const API_DIRECT_URL = process.env.E2E_API_DIRECT_URL ?? 'http://localhost:4000';

/** Los tres secretos sin los cuales los webhooks de pago responden 401. */
const REQUIRED_PAYMENT_SECRETS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SUBSCRIPTIONS_WEBHOOK_SECRET',
] as const;

function fail(what: string, why: string): never {
  throw new Error(
    `\n[arnés E2E] ${what}\n\n${why}\n\n` +
      `Receta completa del stack:  bash scripts/e2e-stack.sh all\n` +
      `Entorno canónico:           scripts/e2e-env.sh\n`,
  );
}

/**
 * Qué cuenta como «este servicio ya sirve». Se enumeran a propósito en vez de
 * aceptar cualquier respuesta: un 502 del proxy de Next TAMBIÉN es una
 * respuesta, y darlo por bueno era justo lo que dejaba pasar un rewrite que
 * todavía no proxyaba.
 */
type SondaAceptable = (status: number) => boolean;

/** Para endpoints de API: sólo 2xx. Un 5xx del proxy no es «arriba». */
const SOLO_2XX: SondaAceptable = (s) => s >= 200 && s < 300;

/** Para páginas de Next: 2xx o la redirección del gate de sesión (307/308). */
const PAGINA_SERVIDA: SondaAceptable = (s) => s >= 200 && s < 400;

async function waitForService(
  url: string,
  label: string,
  aceptable: SondaAceptable,
  pista: string,
): Promise<void> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let ultimo = 'sin intentos';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (aceptable(res.status)) return;
      ultimo = `HTTP ${res.status}`;
    } catch (err) {
      ultimo = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, READINESS_POLL_MS));
  }
  fail(
    `${label} no responde como debe en ${url}.`,
    `Tras ${READINESS_TIMEOUT_MS / 1000}s el último resultado fue: ${ultimo}.\n\n${pista}`,
  );
}

function assertRealtimeBackendConfigured(): void {
  if (process.env['REDIS_URL']) return;
  fail(
    'Falta REDIS_URL.',
    'Sin Redis, `messaging-realtime.publisher` degrada a no-op SILENCIOSO: los\n' +
      'mensajes se guardan pero no se publican, y los specs de chat/mensajes\n' +
      'fallan esperando algo que nunca llega. Es la degradación que más tiempo\n' +
      'cuesta diagnosticar, así que el arnés se niega a correr sin ella.',
  );
}

function assertPaymentSecretsConfigured(): void {
  const missing = REQUIRED_PAYMENT_SECRETS.filter((name) => !process.env[name]);
  if (missing.length === 0) return;
  fail(
    `Faltan secretos de webhooks de pago: ${missing.join(', ')}.`,
    'Los specs de suscripciones y referidos FIRMAN sus propios webhooks con\n' +
      'estos valores. Sin ellos la API responde 401 y el fallo parece de\n' +
      'negocio. Son secretos sintéticos, no claves reales.',
  );
}

/**
 * Comprueba el cupo efectivo leyendo `X-RateLimit-Limit` de una petición
 * pública real. `/auth/signin` no pasa por JwtAuthGuard, así que el
 * interceptor global sí llega a ejecutarse y a escribir los headers.
 */
async function assertRateLimitHeadroom(): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantSlug: 'no-existe-a-proposito', email: 'x@x.test', password: 'x' }),
  });
  const header = res.headers.get('x-ratelimit-limit');
  if (!header) {
    // Camino degradado DELIBERADO: si el interceptor no llegó a correr no hay
    // cupo que comprobar, y abortar aquí dejaría la suite entera rehén de que
    // `/auth/signin` siga siendo la sonda buena. Se avisa en vez de callar, y
    // `tests/arnes-contrato.spec.ts` sí exige la cabecera: así la degradación
    // sale como UN test rojo con nombre, no como un arranque abortado.
    // eslint-disable-next-line no-console
    console.warn(
      `[arnés E2E] Sin cabecera X-RateLimit-Limit en /auth/signin (respondió HTTP ${res.status}):\n` +
        '            no se pudo comprobar el cupo. Lo verifica igualmente el test\n' +
        '            "Contrato del arnés E2E", que sí exige la cabecera.',
    );
    return;
  }
  const limit = Number.parseInt(header, 10);
  if (Number.isFinite(limit) && limit >= MIN_RATE_LIMIT_PER_MIN) return;
  fail(
    `El cupo de rate limit público es ${limit} req/min — demasiado bajo para la suite.`,
    'Con REDIS_URL activo el limiter deja de fallar abierto y entra en vigor el\n' +
      'cupo del plan community: 30 req/min PÚBLICAS compartidas por todo el\n' +
      'tráfico anónimo (bucket "anonymous"). Una tanda serie hace muchísimo más\n' +
      'que eso: cada signin() de cada spec cuenta.\n\n' +
      'Sube el techo con las variables que ya expone la API:\n' +
      `  RATE_LIMIT_COMMUNITY_PUBLIC_PER_MIN >= ${MIN_RATE_LIMIT_PER_MIN}\n` +
      `  RATE_LIMIT_COMMUNITY_AUTH_PER_MIN   >= ${MIN_RATE_LIMIT_PER_MIN}`,
  );
}

/** Cierra el onboarding del admin sembrado y devuelve su token. */
async function prepareAdmin(
  tenantSlug: string,
  email: string,
  password: string,
  baseUrl?: string,
): Promise<string> {
  let session;
  try {
    session = await signin({ tenantSlug, email, password }, baseUrl);
  } catch (err) {
    fail(
      `No se pudo iniciar sesión como ${email} en el tenant "${tenantSlug}".`,
      `${(err as Error).message}\n\n` +
        'La base no está sembrada, o lo está con otras credenciales.\n' +
        'Siémbrala con:  bash scripts/e2e-stack.sh db',
    );
  }
  const token = session.tokens.accessToken;
  await completeOnboarding(token, baseUrl);
  return token;
}

/** Verifica por API que `seed.sql` corrió: los 4 espacios de sistema existen. */
async function assertSystemSpacesSeeded(bearer: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/modules/community/spaces`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) {
    fail(
      `GET /modules/community/spaces devolvió ${res.status}.`,
      'Sin este endpoint no se puede verificar el sembrado de espacios.',
    );
  }
  const body = (await res.json()) as unknown;
  const spaces = Array.isArray(body) ? body : (body as { spaces?: unknown }).spaces;
  if (!Array.isArray(spaces)) {
    // Mismo criterio que `readInstanceState`: un cuerpo con otra forma es "no
    // he podido preguntar", no "no hay espacios". Antes esto caía a `[]` y el
    // arranque abortaba diciendo que faltaba el seed, que es una pista falsa.
    fail(
      `GET /modules/community/spaces devolvió un cuerpo con forma inesperada.`,
      `Se esperaba un array o \`{ spaces: [...] }\` y llegó: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  const present = new Set((spaces as Array<{ slug: string }>).map((s) => s.slug));
  const missing = SYSTEM_SPACE_SLUGS.filter((slug) => !present.has(slug));
  if (missing.length === 0) return;
  fail(
    `Faltan espacios de sistema: ${missing.join(', ')}.`,
    '`packages/database/prisma/seed.sql` no se ha aplicado. Lo aplica\n' +
      '`infra/docker/entrypoint.sh` en el contenedor de producto, pero `db:seed`\n' +
      'por sí solo NO lo hace: `mod_community_space` se queda a 0 filas y todo\n' +
      'lo de comunidad y espacios falla por datos que no existen.\n\n' +
      'Aplícalo con:  bash scripts/e2e-stack.sh db',
  );
}

/**
 * Estado de la instancia. Son DOS respuestas válidas, y no hay una tercera:
 * «no he podido preguntar» NO es un estado, es un fallo.
 */
type EstadoInstancia = 'inicializada' | 'virgen';

/**
 * ¿La instancia ya tiene al menos un tenant? Se lo preguntamos al producto
 * (`GET /setup/status`) en vez de deducirlo de una variable de entorno: el job
 * del wizard de `/setup` corre a propósito contra una instancia VIRGEN, y ahí
 * no hay admin sembrado que preparar. Distinguirlo por estado real evita un
 * interruptor de "sáltate el arranque" que tarde o temprano se deja puesto.
 *
 * OJO — aquí vivía el agujero que este fichero existe para no tener. La
 * versión anterior devolvía `boolean` y hacía `if (!res.ok) return false`, o
 * sea que CUALQUIER no-2xx se traducía a «instancia virgen». Y la petición va
 * a `E2E_API_URL`, que es la web (`http://localhost:3010`), o sea a través del
 * rewrite de Next: un 502 del proxy —el stack sano, sólo el rewrite todavía
 * sin proxyar— se leía como «no hay tenants», el arranque se saltaba ENTERA la
 * preparación del entorno con un `console.info`, y la tanda daba 43 rojos que
 * parecían del producto.
 *
 * Por eso ahora: sólo un 200 con `initialized` booleano es una respuesta.
 * Cualquier otra cosa —error de red, no-2xx, cuerpo con otra forma— es un
 * fallo ruidoso, porque significa que no sabemos en qué estado está la
 * instancia, y actuar sin saberlo es exactamente lo que rompió la tanda.
 */
async function readInstanceState(): Promise<EstadoInstancia> {
  const url = `${API_URL}/api/v1/setup/status`;
  const noSePudoPreguntar = (detalle: string): never =>
    fail(
      `No se pudo determinar el estado de la instancia en ${url}.`,
      `${detalle}\n\n` +
        'Esto NO se interpreta como "instancia virgen": no saberlo es un fallo.\n' +
        'Recuerda que E2E_API_URL apunta a la web, así que esta llamada pasa por\n' +
        'el rewrite de Next (`next.config.mjs`), no por la API directa. Si la API\n' +
        'directa responde y esto no, el que falla es el rewrite.\n\n' +
        'Diagnóstico:  bash scripts/e2e-stack.sh check',
    );

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return noSePudoPreguntar(`La petición ni siquiera llegó: ${(err as Error).message}`);
  }

  if (res.status !== 200) {
    const cuerpo = await res.text().catch(() => '');
    return noSePudoPreguntar(
      `Respondió HTTP ${res.status}. Cuerpo: ${cuerpo.slice(0, 200) || '(vacío)'}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return noSePudoPreguntar(`El 200 no traía JSON: ${(err as Error).message}`);
  }

  const initialized = (body as { initialized?: unknown }).initialized;
  if (typeof initialized !== 'boolean') {
    return noSePudoPreguntar(
      `El cuerpo no trae \`initialized\` booleano: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }

  return initialized ? 'inicializada' : 'virgen';
}

export default async function globalSetup(): Promise<void> {
  await waitForService(
    `${API_DIRECT_URL}/healthz`,
    'La API',
    SOLO_2XX,
    'Arranca el stack con:  bash scripts/e2e-stack.sh start',
  );
  await waitForService(
    `${BASE_URL}/signin`,
    'La web',
    PAGINA_SERVIDA,
    'Arranca el stack con:  bash scripts/e2e-stack.sh start',
  );
  // La API A TRAVÉS DEL REWRITE de Next, que es por donde habla la suite
  // entera (`E2E_API_URL` es la web, no la API directa). Sondearla aquí la
  // calienta Y la verifica: antes el arranque sólo miraba `healthz` directo y
  // `/signin`, así que este camino —del que depende cada spec— nunca se
  // comprobaba y su primer uso real caía dentro de `readInstanceState`.
  await waitForService(
    `${API_URL}/api/v1/setup/status`,
    'La API a través del rewrite de Next',
    SOLO_2XX,
    'La API directa puede estar perfectamente y este camino no. Comprueba el\n' +
      'rewrite de `apps/web/next.config.mjs` y que API_INTERNAL_URL apuntaba a la\n' +
      'API cuando se construyó la web: se congela en el build, no basta con\n' +
      'reexportar la variable.',
  );

  assertRealtimeBackendConfigured();
  assertPaymentSecretsConfigured();
  await assertRateLimitHeadroom();

  if ((await readInstanceState()) === 'virgen') {
    // eslint-disable-next-line no-console
    console.info(
      '[arnés E2E] Instancia sin inicializar (el producto dice initialized:false):\n' +
        '            sólo comprobaciones de entorno. Es el estado que necesita el\n' +
        '            wizard de /setup — ver el job "setup-wizard".',
    );
    return;
  }

  // La política de MFA obligatoria para admins (opt-in, default off) hace que
  // el token del signin llegue sin verificar. Preparar el onboarding desde
  // aquí obligaría a completar el ciclo setup→enable y dejaría a
  // `mfa-setup.spec.ts` sin el estado inicial que ejercita, así que en ese
  // stack la preparación la hacen los propios specs.
  if (process.env['DIDACTA_REQUIRE_MFA_ADMIN'] === 'true') {
    // eslint-disable-next-line no-console
    console.info(
      '[arnés E2E] DIDACTA_REQUIRE_MFA_ADMIN activo: la preparación del admin la\n' +
        '            hacen los specs de MFA, que son los que ejercitan ese flujo.',
    );
    return;
  }

  const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    fail(
      'Faltan E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD.',
      'Son las credenciales del admin que siembra `seed.ts`. Sin ellas ningún\n' +
        'spec puede autenticarse.',
    );
  }

  const adminToken = await prepareAdmin(tenantSlug, email, password);
  await assertSystemSpacesSeeded(adminToken);

  // El tenant de smoke tiene su propio admin sembrado. Se le habla por la API
  // DIRECTA en 127.0.0.1 porque el Host manda sobre el `tenantSlug` del body
  // (ver SMOKE_API_URL en helpers/api.ts); esta llamada verifica de paso que
  // el segundo tenant existe y es alcanzable, que es justo lo que necesitan
  // `redesign-smoke` y `mobile-nav`.
  const smokeSlug = process.env.E2E_SMOKE_TENANT_SLUG ?? 'e2e-smoke';
  const smokeEmail = process.env.E2E_SMOKE_ADMIN_EMAIL;
  if (smokeEmail) {
    await prepareAdmin(smokeSlug, smokeEmail, password, SMOKE_API_URL);
  }

  // eslint-disable-next-line no-console
  console.info(
    `[arnés E2E] Listo · tenant=${tenantSlug} · smoke=${smokeSlug} · avatar=${ONBOARDING_AVATAR_URL}`,
  );
}
