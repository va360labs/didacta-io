import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import {
  adminSessionForBootstrap,
  API_URL,
  createSmokeStudent,
  SMOKE_API_URL,
  SMOKE_TENANT_SLUG,
  TENANT_SLUG,
} from '../helpers/api';

/**
 * Contrato del arnés: comprueba que el stack levantó el producto ENTERO.
 *
 * Por qué existe. Las piezas que faltaban en el arnés no fallaban: degradaban
 * en silencio, y el síntoma aparecía a treinta ficheros de distancia. Sin los
 * espacios de sistema, los specs de comunidad fallaban «por UI». Sin cerrar el
 * onboarding del admin, cualquier ruta autenticada acababa en el asistente y
 * el fallo parecía de la página de destino. Sin Redis, la mensajería realtime
 * era un no-op y los tests esperaban un mensaje que nadie iba a publicar.
 *
 * Cada `test` de aquí es una de esas condiciones. Si el stack está mal
 * montado, rompe UNA cosa con un mensaje que dice qué falta, en vez de dejar
 * veinticinco rojos que parecen bugs de producto.
 *
 * Los tres primeros cubren además los caminos DEGRADADOS que `global-setup.ts`
 * deja abiertos a propósito (instancia virgen y MFA obligatorio): aquí se
 * afirma el estado que esos caminos dan por bueno, así que si alguien deja
 * puesta una de esas condiciones en el stack del golden path, se ve.
 */

/** Espacios que crea `packages/database/prisma/seed.sql` para cada tenant. */
const SYSTEM_SPACE_SLUGS = ['general', 'anuncios', 'preguntas', 'recursos'];

/** Mismo suelo que exige `global-setup.ts` para no estrangular la tanda. */
const MIN_RATE_LIMIT_PER_MIN = 1_000;

const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'didacta-postgres-test';
const PG_USER = process.env.E2E_PG_USER ?? 'didacta_test';
const PG_DB = process.env.E2E_PG_DB ?? 'didacta_test';

test.describe('Contrato del arnés E2E', () => {
  test('la instancia está inicializada y sin la política de MFA obligatoria', async () => {
    // Es el estado que asume el golden path. Con `initialized:false`
    // (instancia virgen) o con DIDACTA_REQUIRE_MFA_ADMIN activo,
    // `global-setup.ts` se salta la preparación del admin a propósito — y
    // entonces media suite falla por el gate de onboarding sin decir por qué.
    const status = (await (await fetch(`${API_URL}/api/v1/setup/status`)).json()) as {
      initialized: boolean;
    };
    expect(status.initialized, 'la base está sembrada (bash scripts/e2e-stack.sh db)').toBe(true);
    expect(
      process.env['DIDACTA_REQUIRE_MFA_ADMIN'],
      'el golden path corre SIN la política de MFA obligatoria (tiene su propio job)',
    ).not.toBe('true');
  });

  test('el rate limit está activo y con margen para una tanda entera', async () => {
    // Con REDIS_URL el limiter deja de fallar abierto. Que cuente es lo que
    // queremos (es el código de producción); lo que no puede es estrangular:
    // el cupo público por defecto son 30 req/min COMPARTIDAS por todo el
    // tráfico anónimo, y cada signin() de cada spec cae en ese bucket.
    const res = await fetch(`${API_URL}/api/v1/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantSlug: 'no-existe', email: 'x@x.test', password: 'x' }),
    });
    const limit = res.headers.get('x-ratelimit-limit');
    expect(limit, 'el interceptor de rate limit escribe sus cabeceras').not.toBeNull();
    expect(Number.parseInt(limit!, 10)).toBeGreaterThanOrEqual(MIN_RATE_LIMIT_PER_MIN);

    // `remaining < limit` prueba que Redis está contando de verdad: en el
    // camino failsafe (sin Redis) el servicio devuelve `remaining === limit`.
    const remaining = Number.parseInt(res.headers.get('x-ratelimit-remaining') ?? '-1', 10);
    expect(remaining, 'Redis está contando (si no, remaining seria igual al limite)').toBeLessThan(
      Number.parseInt(limit!, 10),
    );
  });

  test('los espacios de sistema de seed.sql existen en el tenant principal', async () => {
    const { accessToken } = await adminSessionForBootstrap(TENANT_SLUG);
    const res = await fetch(`${API_URL}/api/v1/modules/community/spaces`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as
      | Array<{ slug: string }>
      | { spaces?: Array<{ slug: string }> };
    const slugs = (Array.isArray(body) ? body : (body.spaces ?? [])).map((s) => s.slug);
    for (const slug of SYSTEM_SPACE_SLUGS) {
      expect(slugs, `falta el espacio de sistema "${slug}" — ¿se aplicó seed.sql?`).toContain(slug);
    }
  });

  test('el admin sembrado tiene el onboarding cerrado', async () => {
    const { accessToken } = await adminSessionForBootstrap(TENANT_SLUG);
    const res = await fetch(`${API_URL}/api/v1/me/onboarding/status`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const status = (await res.json()) as { completed: boolean };
    expect(
      status.completed,
      'sin esto el gate de (app)/layout.tsx desvía toda ruta autenticada a /onboarding',
    ).toBe(true);
  });

  test('el tenant de smoke existe, es alcanzable y NO es el principal', async () => {
    expect(SMOKE_TENANT_SLUG).not.toBe(TENANT_SLUG);
    const alumna = await createSmokeStudent('contrato');
    expect(alumna.user.tenantSlug, 'el alta cayó en el tenant de smoke').toBe(SMOKE_TENANT_SLUG);
    expect(alumna.user.onboardingCompletedAt, 'con el onboarding ya cerrado').toBeTruthy();
    // Que se resuelva por Host y no por el slug del body es justo lo que hace
    // que haga falta SMOKE_API_URL: ver el comentario en helpers/api.ts.
    expect(SMOKE_API_URL).not.toBe(API_URL);
  });

  test('el Postgres del stack responde por el mismo camino que usa catalogo-publico', () => {
    // `catalogo-publico.spec.ts` siembra por `docker exec … psql` contra el
    // contenedor POR NOMBRE. Apuntaba a uno que no existía y sus dos tests
    // fallaban por eso. Aquí se comprueba el camino, no el dato.
    const out = execFileSync(
      'docker',
      ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-t', '-A', '-c', 'SELECT 1'],
      { encoding: 'utf8' },
    ).trim();
    expect(
      out,
      `docker exec ${PG_CONTAINER} no responde — ¿está levantado el compose de test?`,
    ).toBe('1');
  });

  test('los secretos de webhooks de pago son coherentes entre la API y los specs', () => {
    // Los specs FIRMAN sus propios webhooks. Si el nombre que lee el spec y el
    // que valida la API divergen, la firma no cuadra y el 400 parece un fallo
    // de negocio. Pasó: sólo estaba puesto E2E_BILLING_WEBHOOK_SECRET.
    const apiSide = process.env['STRIPE_WEBHOOK_SECRET'];
    expect(apiSide, 'STRIPE_WEBHOOK_SECRET (lado API)').toBeTruthy();
    expect(process.env['E2E_STRIPE_WEBHOOK_SECRET'], 'lo usan membership-trial y referrals').toBe(
      apiSide,
    );
    expect(process.env['E2E_BILLING_WEBHOOK_SECRET'], 'lo usa catalogo-publico').toBe(apiSide);
  });
});
