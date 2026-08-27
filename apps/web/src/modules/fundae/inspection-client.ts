'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { apiFetch, ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

/**
 * Cliente HTTP del acceso de seguimiento Fundae (LMS-123).
 *
 * Son DOS contratos con dos audiencias distintas y por eso viven en el mismo
 * fichero pero en dos objetos separados:
 *
 *   · `fundaeInspectorsApi` — lo que hace el ADMIN: conceder y retirar las
 *     claves que el centro comunica a Fundae. Espeja los endpoints
 *     `/admin/fundae/groups/:id/inspectors` de `FundaeGroupsController`.
 *   · `fundaeInspectionApi` — lo que ve la INSPECCIÓN con esas claves. Espeja
 *     `/fundae/inspection` de `FundaeInspectionController`: solo lectura, y el
 *     backend vuelve a comprobar la concesión contra la base en cada llamada.
 *
 * El contenido del curso NO pasa por aquí: el inspector lo recorre por los
 * mismos endpoints que un alumno, gracias a la matrícula `source = INSPECTION`
 * que se crea al conceder el acceso.
 */

export interface FundaeInspectorAccess {
  id: string;
  groupId: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  grantedAt: string;
  grantedBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Calculado por el backend: ni revocado ni caducado. */
  activo: boolean;
  notas: string | null;
}

export interface GrantInspectorInput {
  userId: string;
  /** ISO-8601. Sin caducidad, el acceso dura hasta que se retire. */
  expiresAt?: string;
  notas?: string;
}

/** Una lección del itinerario, tal y como la ve la inspección. */
export interface InspectionLesson {
  orden: number;
  modulo: string;
  leccion: string;
  tipo: string;
  duracionMinutos: number | null;
  primerAccesoAt: string | null;
  ultimoAccesoAt: string | null;
  segundosRegistrados: number;
  completada: boolean;
  completadaAt: string | null;
  origenCompletado: string | null;
  /** Finalizada con respaldo distinto de la autodeclaración del alumno. */
  verificada: boolean;
}

export interface InspectionParticipant {
  userId: string;
  nombre: string | null;
  email: string | null;
  nifAlumno: string | null;
  horasAsistidas: number;
  horasSinVerificar: number;
  pctHoras: number;
  pctActividades: number;
  leccionesTotales: number;
  leccionesCompletadas: number;
  leccionesVerificadas: number;
  actividadesSuperadas: number;
  actividadesTotales: number;
  primerAccesoAt: string | null;
  ultimoAccesoAt: string | null;
  resultado: string | null;
  itinerario: InspectionLesson[];
}

export interface InspectionView {
  groupId: string;
  numeroGrupo: number;
  codigoAccion: string;
  denominacion: string;
  horasFormacion: number;
  courseId: string | null;
  fechaInicioPrevista: string;
  fechaFinPrevista: string;
  status: string;
  participants: InspectionParticipant[];
}

export interface InspectorGroupRef {
  groupId: string;
  numeroGrupo: number;
  codigoAccion: string;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return token;
}

/** Concesión y retirada del acceso. Admin del tenant. */
export const fundaeInspectorsApi = {
  async list(groupId: string): Promise<FundaeInspectorAccess[]> {
    return apiFetch<FundaeInspectorAccess[]>(
      `/api/v1/admin/fundae/groups/${groupId}/inspectors`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async grant(groupId: string, input: GrantInspectorInput): Promise<FundaeInspectorAccess> {
    return apiFetch<FundaeInspectorAccess>(
      `/api/v1/admin/fundae/groups/${groupId}/inspectors`,
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async revoke(groupId: string, userId: string): Promise<void> {
    await apiFetch<{ revoked: true }>(
      `/api/v1/admin/fundae/groups/${groupId}/inspectors/${userId}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },
};

/** Lo que ve la inspección con sus claves. Solo lectura. */
export const fundaeInspectionApi = {
  async myGroups(): Promise<InspectorGroupRef[]> {
    return apiFetch<InspectorGroupRef[]>(
      '/api/v1/fundae/inspection/groups',
      { method: 'GET' },
      withAuth(),
    );
  },

  async get(groupId: string): Promise<InspectionView> {
    return apiFetch<InspectionView>(
      `/api/v1/fundae/inspection/groups/${groupId}`,
      { method: 'GET' },
      withAuth(),
    );
  },
};

// ─────────────────────── entrada de menú del inspector ───────────────────────
//
// El inspector no es admin ni formador, así que el sidebar no puede gatear su
// entrada por rol: la concesión es un dato, no un rol. El hook consulta los
// grupos concedidos y el shell añade el item solo si hay alguno — de ahí que
// el item no se declare en `sidebarItems`, que se resuelve en build.
//
// Se cachea en memoria hasta recargar la página: es una lista minúscula que
// solo cambia cuando un admin concede o retira un acceso, y el shell la pide
// en cada navegación.

let cache: InspectorGroupRef[] | null = null;
let inflight: Promise<InspectorGroupRef[]> | null = null;

async function fetchMyGroups(): Promise<InspectorGroupRef[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      cache = await fundaeInspectionApi.myGroups();
      return cache;
    } catch {
      // Sin sesión, sin módulo o sin permiso: no hay entrada de menú y ya está.
      // Un fallo aquí no puede romper el shell de toda la aplicación.
      return [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Grupos que esta cuenta puede seguir ahora mismo. Devuelve `[]` mientras carga
 * y también cuando `enabled` es falso (módulo inactivo en el tenant), sin
 * llegar a hacer la petición.
 */
export function useFundaeInspectionGroups(enabled: boolean): InspectorGroupRef[] {
  const [groups, setGroups] = useState<InspectorGroupRef[]>(() => cache ?? []);

  useEffect(() => {
    if (!enabled) return;
    let aborted = false;
    void fetchMyGroups().then((list) => {
      if (!aborted) setGroups(list);
    });
    return () => {
      aborted = true;
    };
  }, [enabled]);

  return enabled ? groups : [];
}

export function invalidateFundaeInspectionCache() {
  cache = null;
}
