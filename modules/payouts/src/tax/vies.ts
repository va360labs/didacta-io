/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { FetchLike } from '../stripe/platform-stripe.client.js';

/**
 * Comprobación de un NIF-IVA en VIES, el servicio público de la Comisión
 * Europea (API REST `check-vat-number`).
 *
 * VIES se cae a menudo (cada Estado miembro responde por su cuenta, y algunos
 * tienen ventanas de mantenimiento). Por eso aquí NUNCA se lanza: lo que no se
 * pudo comprobar vuelve como `unavailable` y quien llama lo deja «pendiente»
 * para reintentarlo, sin bloquear al creador.
 *
 * Si la instalación tiene NIF-IVA propio (`requester`), se envía como
 * solicitante: VIES devuelve entonces un número de consulta, que es la prueba
 * de que se comprobó (art. 18 del Reglamento de Ejecución 282/2011).
 */

export const VIES_CHECK_URL =
  'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';

export type ViesResult =
  | {
      readonly status: 'valid' | 'invalid';
      readonly checkedAt: Date;
      /** Número de consulta (con solicitante). Vacío si VIES no lo dio. */
      readonly consultation: string | null;
    }
  | { readonly status: 'unavailable'; readonly checkedAt: Date; readonly detail: string };

export interface ViesClient {
  check(prefix: string, number: string): Promise<ViesResult>;
}

export interface FetchViesClientOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  /** NIF-IVA del operador como solicitante (`ESB24805335`), para el número de consulta. */
  readonly requesterVatId?: string | null;
  readonly now?: () => Date;
  readonly url?: string;
}

interface ViesResponse {
  readonly valid?: unknown;
  readonly requestIdentifier?: unknown;
  readonly actionSucceed?: unknown;
  readonly errorWrappers?: ReadonlyArray<{ readonly error?: unknown }>;
}

export class FetchViesClient implements ViesClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly url: string;
  private readonly requester: { prefix: string; number: string } | null;

  constructor(options: FetchViesClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.now = options.now ?? (() => new Date());
    this.url = options.url ?? VIES_CHECK_URL;
    const requester = options.requesterVatId?.trim().toUpperCase() ?? '';
    this.requester = /^[A-Z]{2}[A-Z0-9]{2,13}$/.test(requester)
      ? { prefix: requester.slice(0, 2), number: requester.slice(2) }
      : null;
  }

  async check(prefix: string, number: string): Promise<ViesResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          countryCode: prefix,
          vatNumber: number,
          ...(this.requester
            ? {
                requesterMemberStateCode: this.requester.prefix,
                requesterNumber: this.requester.number,
              }
            : {}),
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      let body: ViesResponse = {};
      try {
        body = JSON.parse(text) as ViesResponse;
      } catch {
        return this.unavailable(`respuesta no JSON (HTTP ${response.status})`);
      }
      const error = body.errorWrappers?.[0]?.error;
      if (!response.ok || body.actionSucceed === false || typeof error === 'string') {
        return this.unavailable(typeof error === 'string' ? error : `HTTP ${response.status}`);
      }
      if (typeof body.valid !== 'boolean') return this.unavailable('respuesta sin «valid»');
      const consultation =
        typeof body.requestIdentifier === 'string' && body.requestIdentifier.trim()
          ? body.requestIdentifier.trim()
          : null;
      return { status: body.valid ? 'valid' : 'invalid', checkedAt: this.now(), consultation };
    } catch (err) {
      return this.unavailable(
        (err as Error)?.name === 'AbortError' ? 'tiempo agotado' : (err as Error).message,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private unavailable(detail: string): ViesResult {
    return { status: 'unavailable', checkedAt: this.now(), detail: detail.slice(0, 200) };
  }
}
