import { describe, expect, it } from 'vitest';
import {
  runSync,
  type FetchLike,
  type Logger,
  type SyncConfig,
} from '../sync-enrollments-from-learndash.js';

function mkResponse(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(text) : body),
  };
}

const baseCfg: SyncConfig = {
  didactaBaseUrl: 'https://api.test',
  adminEmail: 'admin@test.io',
  adminPassword: 'pw',
  tenantSlug: 'acme',
  wpBaseUrl: 'https://va360.test',
  wpUsername: 'wp_admin',
  wpAppPassword: 'app-pw',
  dryRun: false,
  throttleRps: 1000, // alto = no penalizar el test
};

const noopLog: Logger = () => {};

describe('runSync (orchestrator integration with mocks)', () => {
  it('1 curso + 3 users (1 ya enrolled, 1 nuevo, 1 not migrated) reporta summary correcto', async () => {
    const postedEnrollments: Array<{ userId: string; courseId: string }> = [];

    const fetchMock: FetchLike = async (url, init) => {
      // SIGNIN
      if (url === 'https://api.test/api/v1/auth/signin') {
        return mkResponse(200, {
          tokens: { accessToken: 'TKN', refreshToken: 'REF' },
          mfaRequired: false,
          user: {
            id: 'admin-uuid',
            email: 'admin@test.io',
            tenantId: 'tenant-uuid',
            tenantSlug: 'acme',
            roles: ['super_admin'],
            mfaEnabled: false,
          },
        });
      }
      // ADMIN USERS LIST (1 página, hasMore=false)
      if (url.startsWith('https://api.test/api/v1/admin/users')) {
        return mkResponse(200, {
          items: [
            { id: 'user-A', externalSource: 'learndash', externalId: 'learndash:101' },
            { id: 'user-B', externalSource: 'learndash', externalId: 'learndash:102' },
            // OJO: no incluimos 103 → debe contar como usersNotFound
          ],
          total: 2,
          page: 1,
          limit: 500,
          hasMore: false,
        });
      }
      // COURSES LIST
      if (url === 'https://api.test/api/v1/modules/courses') {
        return mkResponse(200, [
          {
            id: 'course-uuid',
            externalSource: 'learndash',
            externalId: 'learndash:55',
            title: 'Curso de prueba',
          },
          {
            // Cursos no-learndash deben ignorarse.
            id: 'course-native',
            externalSource: null,
            externalId: null,
            title: 'Nativo',
          },
        ]);
      }
      // WP ENROLLED USERS (1 página, 3 items, segunda página vacía → break por items < perPage)
      if (url.startsWith('https://va360.test/wp-json/ldlms/v1/sfwd-courses/55/users')) {
        if (url.includes('page=1')) {
          return mkResponse(200, [{ id: 101 }, { id: 102 }, { id: 103 }]);
        }
        return mkResponse(200, []);
      }
      // CREATE ENROLLMENT
      if (
        url === 'https://api.test/api/v1/modules/learning/enrollments' &&
        (init?.method ?? 'GET') === 'POST'
      ) {
        const body = JSON.parse(init!.body!) as { userId: string; courseId: string };
        postedEnrollments.push(body);
        if (body.userId === 'user-A') {
          // user-A "ya estaba" → 409
          return mkResponse(409, { code: 'CONFLICT', message: 'enrollment already exists' });
        }
        // user-B se crea OK
        return mkResponse(201, {
          id: 'enrollment-uuid',
          userId: body.userId,
          courseId: body.courseId,
        });
      }
      throw new Error(`unmocked url ${url} method=${init?.method ?? 'GET'}`);
    };

    const { summary, exitCode } = await runSync({
      fetchImpl: fetchMock,
      cfg: baseCfg,
      log: noopLog,
      // throttle no-op para no añadir latencia en test
      throttle: { take: async () => {} },
    });

    expect(exitCode).toBe(0);
    expect(summary.tenant).toBe('acme');
    expect(summary.processedCourses).toBe(1);
    expect(summary.totalEnrollmentsCreated).toBe(1); // user-B
    expect(summary.alreadyExisted).toBe(1); // user-A
    expect(summary.usersNotFound).toBe(1); // wp 103
    expect(summary.courseUsersFailedToFetch).toBe(0);
    expect(summary.dryRun).toBe(false);

    // Verificar que ambas requests POST llegaron con los UUIDs correctos.
    expect(postedEnrollments).toEqual([
      { userId: 'user-A', courseId: 'course-uuid' },
      { userId: 'user-B', courseId: 'course-uuid' },
    ]);
  });

  it('dry-run NO postea enrollments y contabiliza como created (simbólico)', async () => {
    const postedEnrollments: Array<unknown> = [];

    const fetchMock: FetchLike = async (url, init) => {
      if (url === 'https://api.test/api/v1/auth/signin') {
        return mkResponse(200, {
          tokens: { accessToken: 'TKN', refreshToken: 'REF' },
          mfaRequired: false,
          user: {
            id: 'admin',
            email: 'a',
            tenantId: 't',
            tenantSlug: 'acme',
            roles: [],
            mfaEnabled: false,
          },
        });
      }
      if (url.startsWith('https://api.test/api/v1/admin/users')) {
        return mkResponse(200, {
          items: [{ id: 'user-A', externalSource: 'learndash', externalId: 'learndash:101' }],
          total: 1,
          page: 1,
          limit: 500,
          hasMore: false,
        });
      }
      if (url === 'https://api.test/api/v1/modules/courses') {
        return mkResponse(200, [
          { id: 'course-1', externalSource: 'learndash', externalId: 'learndash:55' },
        ]);
      }
      if (url.startsWith('https://va360.test/wp-json/ldlms/v1/sfwd-courses/55/users')) {
        if (url.includes('page=1')) return mkResponse(200, [{ id: 101 }]);
        return mkResponse(200, []);
      }
      if (url.endsWith('/enrollments') && (init?.method ?? 'GET') === 'POST') {
        postedEnrollments.push(init);
        return mkResponse(201, {});
      }
      throw new Error(`unmocked url ${url}`);
    };

    const { summary, exitCode } = await runSync({
      fetchImpl: fetchMock,
      cfg: { ...baseCfg, dryRun: true },
      log: noopLog,
      throttle: { take: async () => {} },
    });
    expect(exitCode).toBe(0);
    expect(summary.dryRun).toBe(true);
    expect(summary.totalEnrollmentsCreated).toBe(1);
    expect(postedEnrollments.length).toBe(0); // CLAVE: dry-run no POSTea
  });

  it('si el fetch del listado de users del curso falla, marca fetchFailed y suma courseUsersFailedToFetch', async () => {
    const fetchMock: FetchLike = async (url, init) => {
      if (url === 'https://api.test/api/v1/auth/signin') {
        return mkResponse(200, {
          tokens: { accessToken: 'T', refreshToken: 'R' },
          mfaRequired: false,
          user: {
            id: 'a',
            email: 'e',
            tenantId: 't',
            tenantSlug: 'acme',
            roles: [],
            mfaEnabled: false,
          },
        });
      }
      if (url.startsWith('https://api.test/api/v1/admin/users')) {
        return mkResponse(200, {
          items: [{ id: 'u1', externalSource: 'learndash', externalId: 'learndash:1' }],
          total: 1,
          page: 1,
          limit: 500,
          hasMore: false,
        });
      }
      if (url === 'https://api.test/api/v1/modules/courses') {
        return mkResponse(200, [
          { id: 'c1', externalSource: 'learndash', externalId: 'learndash:7' },
        ]);
      }
      if (url.startsWith('https://va360.test/wp-json/ldlms/v1/sfwd-courses/7/users')) {
        // 403 NO se reintenta (no es 5xx). Devuelve y processCourse traga.
        return mkResponse(403, { message: 'forbidden' });
      }
      if (url.endsWith('/enrollments') && (init?.method ?? 'GET') === 'POST') {
        throw new Error('no debería postear si WP falló');
      }
      throw new Error(`unmocked ${url}`);
    };

    const { summary, exitCode } = await runSync({
      fetchImpl: fetchMock,
      cfg: baseCfg,
      log: noopLog,
      throttle: { take: async () => {} },
    });
    expect(summary.courseUsersFailedToFetch).toBe(1);
    expect(summary.totalEnrollmentsCreated).toBe(0);
    // fetchFailed no cuenta como fail-rate por curso (no hay attempts) → exit 0.
    expect(exitCode).toBe(0);
  });
});
