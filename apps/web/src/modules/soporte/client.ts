/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import type { TranslatorLike } from '@/lib/i18n/labels';
import {
  filtrosAQuery,
  type ContextoTicket,
  type CrearTicketInput,
  type DestinoTicket,
  type EstadoTicket,
  type TipoTicket,
} from './logic';

/** Cliente HTTP de mod.soporte («Ayuda y sugerencias»). */

const BASE = '/api/v1/modules/soporte';

export interface TicketView {
  id: string;
  tipo: TipoTicket;
  texto: string;
  estado: EstadoTicket;
  destino: DestinoTicket;
  tieneCaptura: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface AdminTicketView extends TicketView {
  autorId: string;
  autorNombre: string;
  contexto: { [K in keyof Required<ContextoTicket>]: string | null };
  notaInterna: string | null;
}

export type ConteoPorEstado = Record<EstadoTicket, number>;

/** A quién escribiría quien mira y si hay alguien al otro lado (`GET /canal`). */
export interface CanalSoporte {
  destino: DestinoTicket;
  disponible: boolean;
}

export interface AdminListado {
  items: AdminTicketView[];
  counts: ConteoPorEstado;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Session expired', status: 401 });
  return token;
}

function json(method: string, body?: unknown): RequestInit {
  return body === undefined ? { method } : { method, body: JSON.stringify(body) };
}

export const soporteApi = {
  async canal(): Promise<CanalSoporte> {
    return apiFetch<CanalSoporte>(`${BASE}/canal`, json('GET'), withAuth());
  },

  async crear(input: CrearTicketInput): Promise<TicketView> {
    return apiFetch<TicketView>(`${BASE}/tickets`, json('POST', input), withAuth());
  },

  async mios(): Promise<TicketView[]> {
    return apiFetch<TicketView[]>(`${BASE}/tickets/mios`, json('GET'), withAuth());
  },

  /**
   * La captura de un ticket. Pide Bearer, así que no vale un `<img src>`: se
   * baja como blob y quien la pinta crea (y libera) un object URL.
   */
  async captura(id: string): Promise<Blob> {
    const res = await fetch(`${BASE}/tickets/${encodeURIComponent(id)}/captura`, {
      headers: { Authorization: `Bearer ${withAuth()}` },
    });
    if (!res.ok) throw new ApiHttpError({ message: 'Screenshot unavailable', status: res.status });
    return res.blob();
  },

  async adminListar(
    f: { estado?: EstadoTicket | ''; tipo?: TipoTicket | '' } = {},
  ): Promise<AdminListado> {
    return apiFetch<AdminListado>(
      `${BASE}/admin/tickets${filtrosAQuery(f)}`,
      json('GET'),
      withAuth(),
    );
  },

  async adminObtener(id: string): Promise<AdminTicketView> {
    return apiFetch<AdminTicketView>(
      `${BASE}/admin/tickets/${encodeURIComponent(id)}`,
      json('GET'),
      withAuth(),
    );
  },

  async adminActualizar(
    id: string,
    patch: { estado?: EstadoTicket; notaInterna?: string | null },
  ): Promise<AdminTicketView> {
    return apiFetch<AdminTicketView>(
      `${BASE}/admin/tickets/${encodeURIComponent(id)}`,
      json('PATCH', patch),
      withAuth(),
    );
  },
};

/**
 * Mensaje para la persona a partir de un error del API, SIEMPRE en su idioma:
 * los `SOPORTE_*` (límite diario incluido) por su code; cualquier otra cosa,
 * la frase genérica del módulo. Nunca el `message` crudo del backend, que va
 * en español.
 */
export function mensajeDeError(e: unknown, tErrors: TranslatorLike, t: TranslatorLike): string {
  if (e instanceof ApiHttpError && e.code && !e.code.includes('.') && tErrors.has(e.code)) {
    return apiErrorMessage(e, tErrors);
  }
  return t('errorGenerico');
}

/** 403: el módulo está apagado (o, en la bandeja, quien mira no es del equipo). */
export function esProhibido(e: unknown): boolean {
  return e instanceof ApiHttpError && e.status === 403;
}

/** El contenido del archivo en base64 (sin el prefijo `data:...,`). */
export function archivoABase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}
