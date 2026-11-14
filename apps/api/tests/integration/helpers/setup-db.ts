/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Setup global de tests de integración (MIG-034).
 *
 * Espera a que Postgres del compose esté listo y aplica el schema Prisma.
 * Se ejecuta UNA vez antes de todos los tests vía vitest globalSetup.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
// Importamos el PrismaClient re-exportado desde @didacta/database (en lugar
// de @prisma/client) para alinear con el resto del repo y evitar añadir
// `pg` o `@prisma/client` como devDeps de apps/api.
import { PrismaClient } from '@didacta/database';

/**
 * `localhost` → `127.0.0.1`, y no es cosmético.
 *
 * En Windows `localhost` resuelve PRIMERO a `::1`. Si el Postgres de pruebas
 * está publicado solo en IPv4 (`-p 127.0.0.1:5479:5432`, que es como se
 * levantan los contenedores por sesión), cada conexión NUEVA espera ~2 s a que
 * Windows dé por rechazado el intento por IPv6 antes de probar 127.0.0.1. Y el
 * `maxWait` de una transacción interactiva de Prisma es justo 2 s: los tests
 * de concurrencia de cobros (5 o 12 transacciones a la vez sobre un pool aún
 * frío) morían con «Unable to start a transaction in the given time» y
 * parecían inestables «bajo carga». Medido: 2080 ms por conexión con
 * `localhost`, 34 ms con `127.0.0.1`.
 *
 * Se normaliza aquí, en el único sitio por el que pasa la URL antes de que
 * los workers la hereden, para que dé igual qué escriba el entorno de quien
 * lanza la suite. Es la misma máquina; solo se ahorra el intento por IPv6.
 */
export function preferIpv4Loopback(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.hostname !== 'localhost') return rawUrl;
  url.hostname = '127.0.0.1';
  return url.toString();
}

const TEST_DATABASE_URL = preferIpv4Loopback(
  process.env.TEST_DATABASE_URL ??
    'postgresql://didacta_test:didacta_test@127.0.0.1:5433/didacta_test?schema=public',
);

const PRISMA_SCHEMA_PATH = resolve(
  __dirname,
  '../../../../..',
  'packages/database/prisma/schema.prisma',
);

/**
 * Intenta conectar a Postgres y ejecutar `SELECT 1` en bucle hasta que la DB
 * responda. Usa Prisma para la conexión (el package ya es dep transitiva del
 * monorepo) — evita añadir `pg` como devDep nuevo.
 */
async function waitForPostgres(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    const client = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL } },
      log: ['error'],
    });
    try {
      await client.$connect();
      await client.$queryRawUnsafe('SELECT 1');
      await client.$disconnect();
      return;
    } catch (err) {
      lastErr = err;
      try {
        await client.$disconnect();
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(
    `Postgres test container not ready after ${timeoutMs}ms. Last error: ${
      (lastErr as Error)?.message ?? lastErr
    }. ¿Está levantado el compose? Run: docker compose -f docker-compose.test.yml up -d`,
  );
}

function applySchema(): void {
  // `prisma db push` aplica el schema sin generar migraciones — perfecto
  // para tests efímeros (no nos importa el historial de migraciones, sólo
  // que la DB tenga las tablas correctas).
  //
  // `--accept-data-loss` permite drop de columnas no usadas; en una DB
  // recién creada no aplica, pero está aquí por idempotencia.
  // `--skip-generate` evita re-generar el cliente Prisma (ya existe).
  const env = {
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
  };

  // Invocamos directamente el entry JS de la CLI de Prisma con `node` —
  // evita los shims `.cmd`/sh que requieren resolver `node` en el PATH del
  // child process (problemático en Windows con vitest corriendo bajo SWC).
  // Usamos createRequire para resolver `prisma/package.json` dinámicamente:
  // así somos inmunes a la versión exacta de prisma instalada.
  const req = createRequire(__filename);
  const prismaPkg = req.resolve('prisma/package.json');
  const prismaCli = resolve(prismaPkg, '..', 'build', 'index.js');

  const result = spawnSync(
    process.execPath, // node — siempre disponible (somos un proceso Node)
    [
      prismaCli,
      'db',
      'push',
      '--schema',
      PRISMA_SCHEMA_PATH,
      '--skip-generate',
      '--accept-data-loss',
    ],
    {
      stdio: 'inherit',
      env,
    },
  );
  if (result.status !== 0) {
    throw new Error(`prisma db push failed (status=${result.status}). Revisa el output anterior.`);
  }
}

export async function setup(): Promise<void> {
  // Hacemos process.env.DATABASE_URL accesible para PrismaService antes de
  // que se importe el cliente. Los tests usan `createTestApp` que instancia
  // PrismaClient — éste lee DATABASE_URL del entorno en el constructor.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  // Los tests que leen TEST_DATABASE_URL por su cuenta (outbox, auditoría,
  // venta de cursos) heredan la URL ya normalizada.
  process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;

  // Las pruebas no tocan auth, pero PrismaService respeta NODE_ENV en el
  // logger. Forzamos test para silenciar logs verbosos.
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

  // El SDK respeta DIDACTA_DEV_BYPASS pero el bootstrap del LicenseModule
  // se hace por opciones explícitas en cada test, así que la env queda
  // controlada por test-app.ts. Aún así, evitamos contaminación cruzada
  // del shell que arrancó el runner.
  delete process.env.DIDACTA_DEV_BYPASS;
  delete process.env.DIDACTA_LICENSE_KEY;

  // AUTH_SECRET: lo necesita `loadAuthConfig()` cuando algún módulo bajo test
  // arrastra `TokenService` (admin endpoints con `JwtAuthGuard`). Mismo valor
  // determinista que usan los tests unit (jwt-guard.test.ts, auth.unit.test.ts).
  // 64 chars hex-like → cumple la validación `length >= 32` del config.
  if (!process.env.AUTH_SECRET) {
    process.env.AUTH_SECRET = 'a'.repeat(64);
  }
  if (!process.env.AUTH_URL) {
    process.env.AUTH_URL = 'https://didacta.test';
  }
  // TENANT_SETTINGS_ENC_KEY: requerida en producción por `AuthModule.useFactory`
  // para `SecretCipherService`. En test (NODE_ENV=test) hay fallback a 64 ceros,
  // pero seteamos una determinista por claridad de los logs y para que la
  // dev-experience match la del runner si alguien lo corre con NODE_ENV custom.
  if (!process.env.TENANT_SETTINGS_ENC_KEY) {
    process.env.TENANT_SETTINGS_ENC_KEY = '0'.repeat(64);
  }

  // eslint-disable-next-line no-console
  console.log('[integration:setup] Esperando Postgres en', TEST_DATABASE_URL);
  await waitForPostgres();

  // eslint-disable-next-line no-console
  console.log('[integration:setup] Aplicando schema Prisma vía db push');
  applySchema();

  // eslint-disable-next-line no-console
  console.log('[integration:setup] DB lista');
}

export async function teardown(): Promise<void> {
  // Nada que cerrar a nivel global: los tests cierran sus apps individualmente,
  // y el compose se baja desde el script npm con `down -v`.
}
