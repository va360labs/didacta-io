'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { authStorage } from '@/lib/auth-storage';
import { meApi } from '@/lib/me';

/** Slug del módulo. En Didacta Cloud nace encendido; cada aula puede apagarlo en Módulos. */
export const SOPORTE_MODULE = 'mod.soporte';

let cached: Promise<boolean> | null = null;
/** Token con el que se pidió `cached`: otra sesión (otra aula) vuelve a preguntar. */
let cachedFor: string | null = null;

/**
 * ¿Está encendida la ayuda para el aula de quien mira? Sin sesión, no. Una
 * sola consulta a `GET /me/modules` por carga de página (la comparten el menú
 * de escritorio, el cajón del móvil y la cabecera del modo sencillo). Ante un
 * fallo se responde «apagado»: el botón no sale.
 */
function soporteEnabled(): Promise<boolean> {
  const token = authStorage.getAccessToken();
  if (!token) return Promise.resolve(false);
  if (!cached || cachedFor !== token) {
    cachedFor = token;
    cached = meApi
      .getMyModules(token)
      .then((r) => r.activeModules.includes(SOPORTE_MODULE))
      .catch(() => {
        cached = null;
        return false;
      });
  }
  return cached;
}

const CAMBIO = 'didacta:modules-changed';

/** `false` mientras se sabe o si está apagado; `true` con el módulo encendido. */
export function useSoporteEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    const cargar = () => {
      void soporteEnabled().then((v) => {
        if (alive) setEnabled(v);
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
  return enabled;
}
