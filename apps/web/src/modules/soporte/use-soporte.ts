'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { authStorage } from '@/lib/auth-storage';
import { soporteApi, type CanalSoporte } from './client';

/** Slug del módulo. En Didacta Cloud nace encendido; cada aula puede apagarlo en Módulos. */
export const SOPORTE_MODULE = 'mod.soporte';

let cached: Promise<CanalSoporte | null> | null = null;
/** Token con el que se pidió `cached`: otra sesión (otra aula) vuelve a preguntar. */
let cachedFor: string | null = null;

/**
 * A quién escribiría quien mira (su equipo del aula o, si administra el aula,
 * Didacta) y si hay alguien al otro lado. Lo decide el servidor (`GET
 * /modules/soporte/canal`) con los roles de la sesión. Una sola consulta por
 * carga de página (la comparten el menú, el cajón del móvil, la cabecera del
 * modo sencillo y «Tus tickets»). Sin sesión, con el módulo apagado (403) o
 * ante cualquier fallo: `null`, y el botón no sale.
 */
function canalSoporte(): Promise<CanalSoporte | null> {
  const token = authStorage.getAccessToken();
  if (!token) return Promise.resolve(null);
  if (!cached || cachedFor !== token) {
    cachedFor = token;
    cached = soporteApi.canal().catch(() => {
      cached = null;
      return null;
    });
  }
  return cached;
}

const CAMBIO = 'didacta:modules-changed';

/** `null` mientras se sabe, con el módulo apagado o si falla; si no, el canal. */
export function useSoporteCanal(): CanalSoporte | null {
  const [canal, setCanal] = useState<CanalSoporte | null>(null);
  useEffect(() => {
    let alive = true;
    const cargar = () => {
      void canalSoporte().then((v) => {
        if (alive) setCanal(v);
      });
    };
    // El interruptor de Módulos avisa con este evento: se vuelve a preguntar.
    const alCambiar = () => {
      cached = null;
      cargar();
    };
    cargar();
    window.addEventListener(CAMBIO, alCambiar);
    return () => {
      alive = false;
      window.removeEventListener(CAMBIO, alCambiar);
    };
  }, []);
  return canal;
}
