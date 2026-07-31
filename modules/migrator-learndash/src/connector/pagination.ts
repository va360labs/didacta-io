/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { RestConnector } from './client.js';

export interface PaginateOptions {
  strategy: 'page-number';
  perPage?: number;
  totalsHeader?: string;
  maxItems?: number;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

export interface Batch<T> {
  items: T[];
  page: number;
  total?: number;
  done: boolean;
}

/**
 * Iterador async sobre paginación page-number (WordPress / LearnDash).
 * Lee X-WP-Total / X-WP-TotalPages para conocer el total y parar.
 */
export async function* paginate<T>(
  connector: RestConnector,
  path: string,
  opts: PaginateOptions,
): AsyncIterableIterator<Batch<T>> {
  const perPage = Math.min(opts.perPage ?? 100, 100);
  const maxItems = opts.maxItems ?? 1_000_000;
  const totalsHeader = opts.totalsHeader ?? 'X-WP-Total';
  const totalPagesHeader = 'X-WP-TotalPages';

  let page = 1;
  let yielded = 0;
  let total: number | undefined;
  let totalPages: number | undefined;

  while (true) {
    if (opts.signal?.aborted) return;

    const response = await connector.requestRaw<T[]>('GET', path, {
      query: { ...opts.query, page, per_page: perPage },
      signal: opts.signal,
    });

    const items = Array.isArray(response.body) ? response.body : [];
    if (total === undefined) {
      const totalHeaderValue = response.headers.get(totalsHeader);
      if (totalHeaderValue !== null) {
        const parsed = Number(totalHeaderValue);
        if (!Number.isNaN(parsed)) total = parsed;
      }
      const totalPagesValue = response.headers.get(totalPagesHeader);
      if (totalPagesValue !== null) {
        const parsed = Number(totalPagesValue);
        if (!Number.isNaN(parsed)) totalPages = parsed;
      }
    }

    yielded += items.length;
    const reachedMax = yielded >= maxItems;
    const exhausted = items.length < perPage;
    const reachedLastPage = totalPages !== undefined && page >= totalPages;
    const done = reachedMax || exhausted || reachedLastPage;

    yield { items, page, total, done };

    if (done) return;
    page += 1;
  }
}
