import { describe, expect, it } from 'vitest';
import { paginateWp } from '../../src/index.js';

/// Tests del helper paginateWp (alpha.49 task 7).
///
/// Diseño: yield batches (no items) para batch insert downstream sin
/// reagrupar. Lee X-WP-TotalPages para terminación determinística;
/// fallback a "array vacío = fin" si el header no llega.

interface Item {
  id: number;
  title: string;
}

function mockHttp(
  handler: (url: string) => { status: number; body: string; headers?: Record<string, string> },
) {
  const make = async (url: string) => {
    const r = handler(url);
    return {
      status: r.status,
      body: r.body,
      headers: r.headers ?? {},
      bytesRead: r.body.length,
    };
  };
  return { get: make, post: make };
}

describe('paginateWp', () => {
  it('itera todas las páginas leyendo X-WP-TotalPages', async () => {
    const calls: string[] = [];
    const pages: Record<number, Item[]> = {
      1: [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' },
      ],
      2: [{ id: 3, title: 'c' }],
    };
    const http = mockHttp((url) => {
      calls.push(url);
      const m = url.match(/[?&]page=(\d+)/);
      const page = Number(m?.[1] ?? 1);
      return {
        status: 200,
        body: JSON.stringify(pages[page] ?? []),
        headers: { 'x-wp-totalpages': '2' },
      };
    });

    const batches: Item[][] = [];
    for await (const batch of paginateWp<Item>(http, 'https://wp.example/wp-json/wp/v2/posts', {
      authHeader: 'Basic xxx',
    })) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(2);
    expect(batches[1]).toHaveLength(1);
    expect(calls).toEqual([
      'https://wp.example/wp-json/wp/v2/posts?per_page=100&page=1',
      'https://wp.example/wp-json/wp/v2/posts?per_page=100&page=2',
    ]);
  });

  it('termina al recibir array vacío si X-WP-TotalPages no está presente', async () => {
    const pages: Record<number, Item[]> = {
      1: [{ id: 1, title: 'a' }],
      2: [], // upstream sin header → vacío significa fin
    };
    const http = mockHttp((url) => {
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? 1);
      return { status: 200, body: JSON.stringify(pages[page] ?? []) };
    });

    const batches: Item[][] = [];
    for await (const batch of paginateWp<Item>(http, 'https://wp.example/wp-json/wp/v2/posts', {
      authHeader: 'Basic xxx',
    })) {
      batches.push(batch);
    }
    expect(batches).toHaveLength(1);
  });

  it('respeta perPage del caller (con clamp 1..100)', async () => {
    const calls: string[] = [];
    const http = mockHttp((url) => {
      calls.push(url);
      return { status: 200, body: '[]' };
    });
    for await (const _ of paginateWp(http, 'https://wp.example/x', {
      authHeader: 'Basic xxx',
      perPage: 50,
    })) {
      // sin items
    }
    expect(calls[0]).toContain('per_page=50');
  });

  it('clampa perPage > 100 a 100', async () => {
    const calls: string[] = [];
    const http = mockHttp((url) => {
      calls.push(url);
      return { status: 200, body: '[]' };
    });
    for await (const _ of paginateWp(http, 'https://wp.example/x', {
      authHeader: 'Basic xxx',
      perPage: 500,
    })) {
      // sin items
    }
    expect(calls[0]).toContain('per_page=100');
  });

  it('clampa perPage < 1 a 1', async () => {
    const calls: string[] = [];
    const http = mockHttp((url) => {
      calls.push(url);
      return { status: 200, body: '[]' };
    });
    for await (const _ of paginateWp(http, 'https://wp.example/x', {
      authHeader: 'Basic xxx',
      perPage: 0,
    })) {
      // sin items
    }
    expect(calls[0]).toContain('per_page=1');
  });

  it('400 con rest_post_invalid_page_number → fin natural (no error)', async () => {
    const http = mockHttp((url) => {
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? 1);
      if (page === 1) {
        return {
          status: 200,
          body: JSON.stringify([{ id: 1 }, { id: 2 }]),
          // SIN x-wp-totalpages para forzar el iterator a pedir página 2
        };
      }
      return {
        status: 400,
        body: '{"code":"rest_post_invalid_page_number","message":"page > total"}',
      };
    });

    const batches: Item[][] = [];
    for await (const batch of paginateWp<Item>(http, 'https://wp.example/x', {
      authHeader: 'Basic xxx',
    })) {
      batches.push(batch);
    }
    expect(batches).toHaveLength(1);
  });

  it('400 con otro código → throw', async () => {
    const http = mockHttp(() => ({
      status: 400,
      body: '{"code":"rest_invalid_param","message":"per_page debe ser número"}',
    }));
    await expect(async () => {
      for await (const _ of paginateWp(http, 'https://wp.example/x', { authHeader: 'Basic xxx' })) {
        // no debería llegar
      }
    }).rejects.toThrow(/HTTP 400/);
  });

  it('500 → throw', async () => {
    const http = mockHttp(() => ({ status: 500, body: 'oops' }));
    await expect(async () => {
      for await (const _ of paginateWp(http, 'https://wp.example/x', { authHeader: 'Basic xxx' })) {
        // no debería llegar
      }
    }).rejects.toThrow(/HTTP 500/);
  });

  it('respuesta no-JSON → throw con mensaje claro', async () => {
    const http = mockHttp(() => ({ status: 200, body: '<html>error</html>' }));
    await expect(async () => {
      for await (const _ of paginateWp(http, 'https://wp.example/x', { authHeader: 'Basic xxx' })) {
        // no debería llegar
      }
    }).rejects.toThrow(/no JSON/);
  });

  it('respuesta JSON pero no array → throw', async () => {
    const http = mockHttp(() => ({ status: 200, body: '{"oops":true}' }));
    await expect(async () => {
      for await (const _ of paginateWp(http, 'https://wp.example/x', { authHeader: 'Basic xxx' })) {
        // no debería llegar
      }
    }).rejects.toThrow(/array/);
  });

  it('AbortSignal cancelado entre páginas → return sin yield', async () => {
    const ctrl = new AbortController();
    const http = mockHttp((url) => {
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? 1);
      if (page === 1) ctrl.abort(); // cancelamos justo después de pedir la 1ra
      return {
        status: 200,
        body: JSON.stringify([{ id: page }]),
        headers: { 'x-wp-totalpages': '5' },
      };
    });
    const batches: Item[][] = [];
    for await (const batch of paginateWp<Item>(http, 'https://wp.example/x', {
      authHeader: 'Basic xxx',
      signal: ctrl.signal,
    })) {
      batches.push(batch);
    }
    expect(batches).toHaveLength(1);
  });

  it('URL con query string existente preserva params (& en vez de ?)', async () => {
    const calls: string[] = [];
    const http = mockHttp((url) => {
      calls.push(url);
      return { status: 200, body: '[]' };
    });
    for await (const _ of paginateWp(http, 'https://wp.example/x?slug=foo', {
      authHeader: 'Basic xxx',
    })) {
      // sin items
    }
    expect(calls[0]).toContain('slug=foo&per_page=100&page=1');
  });
});
