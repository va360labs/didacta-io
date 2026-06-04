import { describe, expect, it, vi } from 'vitest';
import { listWpCourseEnrolledUserIds, type FetchLike } from '../sync-enrollments-from-learndash.js';

function mkResponse(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(text) : body),
  };
}

const silentLog = vi.fn();

const baseCfg = {
  wpBaseUrl: 'https://va360.test',
  wpUsername: 'wp_admin',
  wpAppPassword: 'app-pw',
};

describe('listWpCourseEnrolledUserIds — shape detection', () => {
  it('soporta shape Array<{ id }> (objetos con id numérico)', async () => {
    const fetchMock: FetchLike = async (url) => {
      if (url.includes('page=1')) {
        return mkResponse(200, [{ id: 101 }, { id: 102 }, { id: 103 }]);
      }
      return mkResponse(200, []);
    };
    const ids = await listWpCourseEnrolledUserIds(
      fetchMock,
      baseCfg,
      'learndash:55',
      silentLog as unknown as (..._a: unknown[]) => void,
    );
    expect(ids.sort()).toEqual(['101', '102', '103']);
  });

  it('soporta shape string[] (regresión real del endpoint LD V1)', async () => {
    // Shape observado contra va360.academy: el endpoint
    // /wp-json/ldlms/v1/sfwd-courses/:id/users devuelve un array de
    // strings con los WP user IDs, no objetos con { id }.
    const fetchMock: FetchLike = async (url) => {
      if (url.includes('page=1')) {
        return mkResponse(200, ['101', '102', '103']);
      }
      return mkResponse(200, []);
    };
    const ids = await listWpCourseEnrolledUserIds(
      fetchMock,
      baseCfg,
      'learndash:55',
      silentLog as unknown as (..._a: unknown[]) => void,
    );
    expect(ids.sort()).toEqual(['101', '102', '103']);
  });

  it('soporta shape mixta dentro de la misma página (defensa)', async () => {
    const fetchMock: FetchLike = async (url) => {
      if (url.includes('page=1')) {
        return mkResponse(200, ['101', { id: 102 }, 103, null, { id: null }]);
      }
      return mkResponse(200, []);
    };
    const ids = await listWpCourseEnrolledUserIds(
      fetchMock,
      baseCfg,
      'learndash:55',
      silentLog as unknown as (..._a: unknown[]) => void,
    );
    expect(ids.sort()).toEqual(['101', '102', '103']);
  });

  it('ignora externalId sin prefijo learndash: y arma la URL igual', async () => {
    const calls: string[] = [];
    const fetchMock: FetchLike = async (url) => {
      calls.push(url);
      return mkResponse(200, []);
    };
    await listWpCourseEnrolledUserIds(
      fetchMock,
      baseCfg,
      '55',
      silentLog as unknown as (..._a: unknown[]) => void,
    );
    expect(calls[0]).toContain('/wp-json/ldlms/v1/sfwd-courses/55/users');
  });

  it('lanza si el body no es un array', async () => {
    const fetchMock: FetchLike = async () =>
      mkResponse(200, { error: 'should be array but it is object' });
    await expect(
      listWpCourseEnrolledUserIds(
        fetchMock,
        baseCfg,
        'learndash:55',
        silentLog as unknown as (..._a: unknown[]) => void,
      ),
    ).rejects.toThrow(/wp_course_users_invalid_shape/);
  });
});
