/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { apiAs, freshTenant, sql, type FreshTenant } from './simple-tenant';

const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'didacta-postgres-test';
const PG_USER = process.env.E2E_PG_USER ?? 'didacta_test';
const PG_DB = process.env.E2E_PG_DB ?? 'didacta_test';
const SEED_SQL = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'database',
  'prisma',
  'seed.sql',
);

/**
 * `seed.sql` (los espacios de sistema de la comunidad), como lo aplica el
 * contenedor en cada arranque. Un aula creada con la API en marcha no los tiene
 * hasta el siguiente reinicio: aquí se aplica a mano, DESPUÉS de fijar el
 * idioma del aula, que es lo que el seed lee para nombrarlos.
 */
export function applySeedSql(): void {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      PG_CONTAINER,
      'psql',
      '-U',
      PG_USER,
      '-d',
      PG_DB,
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-f',
      '-',
    ],
    { input: readFileSync(SEED_SQL), stdio: ['pipe', 'ignore', 'inherit'] },
  );
}

export interface AulaSembrada {
  tenant: FreshTenant;
  /** Token del operador (admin del aula). */
  opToken: string;
  alumnaEmail: string;
  alumnaToken: string;
  /** Directo con su encuesta post-clase ya creada. */
  sessionId: string;
  /** Contenido que crea el propio test (se excluye al buscar palabras ajenas). */
  contenido: string[];
}

/**
 * Un aula NUEVA en MODO COMPLETO con el idioma del aula fijado y todo lo que el
 * servidor siembra o compone para todos ya generado: espacios de sistema,
 * canal de profesores de una alumna, una publicación en «preguntas» (avisando
 * a todos), un directo con su encuesta, la biblioteca de recursos y la página
 * de membresía activa sin titular propio.
 */
export async function aulaCompletaSembrada(
  slug: string,
  locale: 'en' | 'pt',
  textos: { post: string; cuerpo: string; directo: string },
): Promise<AulaSembrada> {
  const tenant = await freshTenant(slug, false);
  const op = await apiAs<{ tokens: { accessToken: string } }>(tenant.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: {
      tenantSlug: tenant.slug,
      email: `operador@${tenant.slug}.test`,
      password: tenant.password,
    },
  });
  const opToken = op.tokens.accessToken;
  await apiAs(tenant.host, '/api/v1/admin/tenant-settings/academy', {
    method: 'PUT',
    bearer: opToken,
    body: { locale },
  });
  applySeedSql();

  // Una alumna, que entra con contraseña propia.
  const alumnaEmail = `alumna@${tenant.slug}.test`;
  await apiAs(tenant.host, '/api/v1/admin/users', {
    method: 'POST',
    bearer: opToken,
    body: { email: alumnaEmail, role: 'alumno' },
  });
  const token = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  sql(
    `INSERT INTO password_reset_token (id, user_id, tenant_id, token_hash, expires_at, created_at) ` +
      `SELECT gen_random_uuid(), u.id, u.tenant_id, '${hash}', now() + interval '1 day', now() ` +
      `FROM "user" u WHERE u.email = '${alumnaEmail}'`,
  );
  await apiAs(tenant.host, '/api/v1/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword: tenant.password },
  });
  const alumna = await apiAs<{ tokens: { accessToken: string } }>(
    tenant.host,
    '/api/v1/auth/signin',
    {
      method: 'POST',
      body: { tenantSlug: tenant.slug, email: alumnaEmail, password: tenant.password },
    },
  );
  const alumnaToken = alumna.tokens.accessToken;
  await apiAs(tenant.host, '/api/v1/me/profile', {
    method: 'PATCH',
    bearer: alumnaToken,
    body: { name: 'Alumna Teste', avatarUrl: '/api/v1/storage/file/avatars/e2e-harness.png' },
  });
  await apiAs(tenant.host, '/api/v1/me/onboarding/complete', {
    method: 'POST',
    bearer: alumnaToken,
  });

  // Una publicación en el espacio de preguntas, avisando a todos (el aviso lo
  // compone el servidor).
  await apiAs(tenant.host, '/api/v1/modules/community/posts', {
    method: 'POST',
    bearer: opToken,
    body: { title: textos.post, body: textos.cuerpo, tags: ['preguntas'], notifyAll: true },
  });

  // Un directo con su encuesta post-clase (la crea el servidor).
  const session = await apiAs<{ id: string }>(tenant.host, '/api/v1/modules/zoom-live/sessions', {
    method: 'POST',
    bearer: opToken,
    body: {
      topic: textos.directo,
      startTime: new Date(Date.now() + 86_400_000).toISOString(),
      durationMinutes: 60,
      hostEmail: tenant.creatorEmail,
      timezone: 'Europe/Madrid',
      externalJoinUrl: 'https://meet.example.com/abc-defg-hij',
    },
  });
  await apiAs(tenant.host, `/api/v1/modules/surveys/admin/sessions/${session.id}`, {
    method: 'POST',
    bearer: opToken,
  });

  // Página de membresía activa SIN titular propio: el de por defecto lo pone
  // la web en el idioma del aula.
  await apiAs(tenant.host, '/api/v1/membership/admin/config', {
    method: 'PUT',
    bearer: opToken,
    body: { active: true },
  });

  return {
    tenant,
    opToken,
    alumnaEmail,
    alumnaToken,
    sessionId: session.id,
    contenido: [tenant.slug, textos.post, textos.cuerpo, textos.directo, 'Alumna Teste'],
  };
}

/** Lo que el servidor escribió en español fijo antes de este arreglo. */
export const SEMBRADO_EN_ESPANOL = [
  'Profesores',
  'preguntas',
  'anuncios',
  'Preguntas y dudas',
  'Workflows de clase',
  'Skills y agentes',
  'Hazte miembro',
  'recomendarías',
  'ha publicado en la comunidad',
] as const;
