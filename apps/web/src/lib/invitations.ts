'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch } from './api-client';

/**
 * Cliente del panel de invitaciones al aula.
 *
 * Todo se deduce de datos que ya existen: la fecha de invitación sale del token
 * de activación que crea cada envío, y la activación, del estado del usuario.
 * Por eso no hay que llevar ninguna lista aparte y el envío por lotes es
 * reanudable.
 */
export interface InvitationsSummary {
  total: number;
  activos: number;
  pendientes: number;
  invitados: number;
  activadosTrasInvitacion: number;
  sinInvitar: number;
  pendientesSinAcceso: number;
  tasaConversion: number | null;
  /** Envío por lotes en curso (o el último). Null si nunca se lanzó uno. */
  envio: EnvioEstado | null;
}

/**
 * Progreso del envío por lotes. El envío NO es síncrono: cada correo tarda
 * ~1 s (envío + pausa anti-spam), así que el servidor arranca el lote, responde
 * al instante y el panel sigue el avance leyendo esto del summary.
 */
export interface EnvioEstado {
  enCurso: boolean;
  total: number;
  enviados: number;
  fallidos: Array<{ email: string; error: string }>;
  iniciadoEn: string;
  terminadoEn: string | null;
}

export interface BatchStarted {
  aceptado: boolean;
  yaEnCurso: boolean;
  total: number;
}

export interface InvitationRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  /** Ya usó el aula alguna vez. No confundir con `status`: una cuenta se crea
   *  ACTIVE aunque su dueño todavía no haya definido contraseña ni entrado. */
  entrado: boolean;
  invitedAt: string | null;
  lastLoginAt: string | null;
  envios: number;
  /** Grupos de acceso a los que pertenece: lo que verá al entrar. */
  grupos: string[];
}

export interface InvitationsPage {
  items: InvitationRow[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface BatchResult {
  enviados: number;
  fallidos: Array<{ email: string; error: string }>;
  emails: string[];
  pendientesRestantes: number;
}

export type InvitationFilter = 'invitados' | 'activados' | 'sin-enviar' | 'sin-acceso';

const BASE = '/api/v1/admin/invitations';

export const invitationsApi = {
  async summary(bearer: string): Promise<InvitationsSummary> {
    return apiFetch<InvitationsSummary>(`${BASE}/summary`, { method: 'GET' }, bearer);
  },

  async list(
    bearer: string,
    opts: { filtro?: InvitationFilter; search?: string; page?: number; limit?: number } = {},
  ): Promise<InvitationsPage> {
    const qs = new URLSearchParams();
    if (opts.filtro) qs.set('filtro', opts.filtro);
    if (opts.search) qs.set('search', opts.search);
    if (opts.page) qs.set('page', String(opts.page));
    if (opts.limit) qs.set('limit', String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch<InvitationsPage>(`${BASE}${suffix}`, { method: 'GET' }, bearer);
  },

  /**
   * Arranca el lote. Vuelve enseguida: el avance se sigue en `summary().envio`.
   * `accessGroupId` (opcional): añade a cada destinatario del lote a ese
   * grupo de acceso, además de invitarlo.
   */
  async sendBatch(
    bearer: string,
    opts: { size?: number; emails?: string[]; pauseMs?: number; accessGroupId?: string } = {},
  ): Promise<BatchStarted> {
    return apiFetch<BatchStarted>(
      `${BASE}/send-batch`,
      { method: 'POST', body: JSON.stringify(opts) },
      bearer,
    );
  },
};
