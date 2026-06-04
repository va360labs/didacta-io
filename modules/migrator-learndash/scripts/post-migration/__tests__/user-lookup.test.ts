import { describe, expect, it, vi } from 'vitest';
import { buildUserLookup, type FetchLike } from '../sync-enrollments-from-learndash.js';

function mkResponse(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(text) : body),
  };
}

const silentLog = vi.fn();

describe('buildUserLookup', () => {
  it('pagina hasta hasMore=false y construye el mapa wpId → didactaId', async () => {
    const calls: string[] = [];
    const fetchMock: FetchLike = async (url) => {
      calls.push(url);
      if (url.includes('page=1')) {
        return mkResponse(200, {
          items: [
            { id: 'uuid-1', externalSource: 'learndash', externalId: 'learndash:10' },
            { id: 'uuid-2', externalSource: 'learndash', externalId: 'learndash:11' },
            // Un user sin externalId debe ignorarse silenciosamente.
            { id: 'uuid-3', externalSource: 'learndash', externalId: null },
          ],
          total: 4,
          page: 1,
          limit: 500,
          hasMore: true,
        });
      }
      if (url.includes('page=2')) {
        return mkResponse(200, {
          items: [
            // Acepta también externalId plano sin prefijo (defensa).
            { id: 'uuid-4', externalSource: 'learndash', externalId: '12' },
          ],
          total: 4,
          page: 2,
          limit: 500,
          hasMore: false,
        });
      }
      throw new Error(`unexpected url ${url}`);
    };
    const map = await buildUserLookup(
      fetchMock,
      { didactaBaseUrl: 'https://api.test' },
      'TOKEN',
      silentLog as unknown as ReturnType<typeof vi.fn> & ((..._a: unknown[]) => void),
    );
    expect(map.size).toBe(3);
    expect(map.get('10')).toBe('uuid-1');
    expect(map.get('11')).toBe('uuid-2');
    expect(map.get('12')).toBe('uuid-4');
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('/api/v1/admin/users?externalSource=learndash');
    expect(calls[0]).toContain('page=1');
    expect(calls[1]).toContain('page=2');
  });

  it('si la API devuelve status != 200 lanza error con info útil', async () => {
    const fetchMock: FetchLike = async () => mkResponse(401, { message: 'unauthorized' });
    await expect(
      buildUserLookup(
        fetchMock,
        { didactaBaseUrl: 'https://api.test' },
        'BAD',
        silentLog as unknown as (..._a: unknown[]) => void,
      ),
    ).rejects.toThrow(/admin_users_list_failed/);
  });

  it('items con externalSource distinto a learndash se ignoran', async () => {
    const fetchMock: FetchLike = async () =>
      mkResponse(200, {
        items: [
          { id: 'uuid-x', externalSource: 'other', externalId: 'learndash:99' },
          { id: 'uuid-y', externalSource: 'learndash', externalId: 'learndash:7' },
        ],
        total: 2,
        page: 1,
        limit: 500,
        hasMore: false,
      });
    const map = await buildUserLookup(
      fetchMock,
      { didactaBaseUrl: 'https://api.test' },
      'T',
      silentLog as unknown as (..._a: unknown[]) => void,
    );
    expect(map.size).toBe(1);
    expect(map.get('7')).toBe('uuid-y');
    expect(map.has('99')).toBe(false);
  });
});
