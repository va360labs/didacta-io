'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { ApiHttpError } from './api-client';
import { coursesApi, type CourseCategory } from './courses';

/**
 * Cache module-level de las categorías curadas del tenant. Mismo patrón
 * que useCommunityTags: la primera vista que monta el hook hace el
 * fetch; las siguientes obtienen el snapshot cacheado de inmediato.
 *
 * `invalidate*Cache` se llama desde la UI admin tras crear/editar/borrar
 * para que el catálogo y el builder vean los cambios sin refresh full.
 */
let cache: ReadonlyMap<string, CourseCategory> | null = null;
let inflight: Promise<ReadonlyMap<string, CourseCategory>> | null = null;

async function fetchCategories(): Promise<ReadonlyMap<string, CourseCategory>> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const list = await coursesApi.listManagedCategories();
      const map = new Map<string, CourseCategory>();
      for (const c of list) map.set(c.name, c);
      cache = map;
      return map;
    } catch (e) {
      // Si la lectura falla cacheamos un map vacío para que la UI caiga
      // al estilo genérico sin reintentar en cada render.
      if (e instanceof ApiHttpError) {
        cache = new Map();
        return cache;
      }
      cache = new Map();
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useCourseCategories(): ReadonlyMap<string, CourseCategory> {
  const [byName, setByName] = useState<ReadonlyMap<string, CourseCategory>>(
    () => cache ?? new Map(),
  );

  useEffect(() => {
    let aborted = false;
    void fetchCategories().then((map) => {
      if (!aborted) setByName(map);
    });
    return () => {
      aborted = true;
    };
  }, []);

  return byName;
}

export function invalidateCourseCategoriesCache() {
  cache = null;
}
