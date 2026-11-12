import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ZoomWebhookController } from '../src/modules/zoom-live/zoom-webhook.controller';

/**
 * Tests unit del webhook público de Zoom tras A2 (`work/migracion-env-a-panel.md`):
 * el secret ya no es un único env global — es per-tenant, resuelto por Host
 * ANTES de poder leer ningún secret (igual que `billing-public.controller.ts`).
 */

const TENANT_ID = 'tenant-1';
const SECRET = 'sekret-del-tenant';

function sign(body: string, secret = SECRET) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
  return { signatureHeader: `v0=${digest}`, timestampHeader: timestamp };
}

function makeReq(
  body: string,
  extraHeaders: Record<string, string> = {},
  host = 'academia.example.com',
) {
  const { signatureHeader, timestampHeader } = sign(body);
  return {
    headers: {
      host,
      'x-zm-signature': signatureHeader,
      'x-zm-request-timestamp': timestampHeader,
      ...extraHeaders,
    },
    rawBody: Buffer.from(body, 'utf8'),
  } as never;
}

function makeController(opts?: {
  tenant?: { id: string } | null;
  webhookSecret?: string | null;
  /** Secreto de webhook por tenant; gana a `webhookSecret` para los que liste. */
  secretsByTenant?: Record<string, string | null>;
  resolveWebhookTenantId?: ReturnType<typeof vi.fn>;
  handleWebhookEvent?: ReturnType<typeof vi.fn>;
}) {
  const defaultSecret = opts?.webhookSecret === undefined ? SECRET : opts.webhookSecret;
  const zoomLive = {
    getWebhookSecret: vi.fn(async (tenantId: string) =>
      opts?.secretsByTenant && tenantId in opts.secretsByTenant
        ? opts.secretsByTenant[tenantId]
        : defaultSecret,
    ),
    resolveWebhookTenantId: opts?.resolveWebhookTenantId ?? vi.fn().mockResolvedValue(TENANT_ID),
    handleWebhookEvent: opts?.handleWebhookEvent ?? vi.fn().mockResolvedValue({ result: 'OK' }),
  };
  const registry = { getZoomLiveService: () => zoomLive } as never;
  const tenantResolver = {
    resolveByHost: vi
      .fn()
      .mockResolvedValue(opts?.tenant === undefined ? { id: TENANT_ID } : opts.tenant),
  } as never;
  const auditLog = { record: vi.fn().mockResolvedValue(undefined) };
  const logger = { error: vi.fn() };
  return {
    controller: new ZoomWebhookController(
      registry,
      tenantResolver,
      auditLog as never,
      logger as never,
    ),
    zoomLive,
    auditLog,
    logger,
  };
}

describe('ZoomWebhookController', () => {
  it('sin tenant resuelto por Host → 404 (no llega a leer ningún secret)', async () => {
    const { controller, zoomLive } = makeController({ tenant: null });
    const body = JSON.stringify({ event_id: 'e1', event: 'meeting.started', payload: {} });

    await expect(controller.handle(makeReq(body))).rejects.toBeInstanceOf(NotFoundException);
    expect(zoomLive.getWebhookSecret).not.toHaveBeenCalled();
  });

  it('tenant resuelto pero sin webhookSecret configurado → 401', async () => {
    const { controller } = makeController({ webhookSecret: null });
    const body = JSON.stringify({ event_id: 'e1', event: 'meeting.started', payload: {} });

    await expect(controller.handle(makeReq(body))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('firma inválida (secret equivocado) → 401', async () => {
    const { controller } = makeController({ webhookSecret: SECRET });
    const body = JSON.stringify({ event_id: 'e1', event: 'meeting.started', payload: {} });
    const { timestampHeader } = sign(body, 'otro-secret-distinto');

    const req = {
      headers: {
        host: 'academia.example.com',
        'x-zm-signature': 'v0=' + '0'.repeat(64),
        'x-zm-request-timestamp': timestampHeader,
      },
      rawBody: Buffer.from(body, 'utf8'),
    } as never;

    await expect(controller.handle(req)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('handshake endpoint.url_validation responde con encryptedToken calculado con el secret del tenant', async () => {
    const { controller } = makeController();
    const body = JSON.stringify({
      event_id: 'e1',
      event: 'endpoint.url_validation',
      payload: { plainToken: 'abc123' },
    });

    const result = (await controller.handle(makeReq(body))) as {
      plainToken: string;
      encryptedToken: string;
    };

    expect(result.plainToken).toBe('abc123');
    expect(result.encryptedToken).toBe(createHmac('sha256', SECRET).update('abc123').digest('hex'));
  });

  it('evento válido: delega en resolveWebhookTenantId + handleWebhookEvent y devuelve el outcome', async () => {
    const handleWebhookEvent = vi.fn().mockResolvedValue({ result: 'OK', sessionId: 'sess-1' });
    const { controller, zoomLive } = makeController({ handleWebhookEvent });
    const body = JSON.stringify({
      event_id: 'e1',
      event: 'meeting.started',
      payload: { object: { id: '999' } },
    });

    const result = await controller.handle(makeReq(body));

    expect(zoomLive.resolveWebhookTenantId).toHaveBeenCalled();
    expect(handleWebhookEvent).toHaveBeenCalled();
    expect(result).toEqual({ result: 'OK', sessionId: 'sess-1' });
  });

  it('aviso REAL de Zoom (sin event_id en el cuerpo): se procesa, no se descarta', async () => {
    // Zoom manda `{ event, event_ts, payload }`. Cuando el schema exigía
    // `event_id`, esto contestaba IGNORED/unknown_payload_shape y la clase
    // nunca cambiaba de estado.
    const handleWebhookEvent = vi.fn().mockResolvedValue({ result: 'OK', sessionId: 'sess-1' });
    const { controller, zoomLive } = makeController({ handleWebhookEvent });
    const body = JSON.stringify({
      event: 'meeting.ended',
      event_ts: 1785782996000,
      payload: {
        account_id: 'abc123',
        object: { id: 87470222827, uuid: 'someUuid==', end_time: '2026-08-03T18:49:56Z' },
      },
    });

    const result = await controller.handle(makeReq(body));

    expect(result).toEqual({ result: 'OK', sessionId: 'sess-1' });
    expect(zoomLive.resolveWebhookTenantId).toHaveBeenCalledTimes(1);
    expect(handleWebhookEvent).toHaveBeenCalledTimes(1);
    const [event, opts] = handleWebhookEvent.mock.calls[0]!;
    expect(event).toMatchObject({ event: 'meeting.ended', event_ts: 1785782996000 });
    expect(event.event_id).toBeUndefined();
    // El cuerpo crudo viaja al módulo: es el respaldo de la clave de
    // idempotencia cuando el aviso no trae `event_ts`.
    // …y el tenant VERIFICADO (el del dominio), para que el módulo solo mire
    // sus clases.
    expect(opts).toEqual({ rawBody: body, tenantId: TENANT_ID });
  });

  it('payload con shape desconocido → IGNORED sin tocar handleWebhookEvent', async () => {
    const handleWebhookEvent = vi.fn();
    const { controller } = makeController({ handleWebhookEvent });
    const body = JSON.stringify({ not: 'a webhook event' });

    const result = await controller.handle(makeReq(body));

    expect(result).toEqual({ result: 'IGNORED', reason: 'unknown_payload_shape' });
    expect(handleWebhookEvent).not.toHaveBeenCalled();
  });

  /**
   * El id de la reunión lo escribe quien firma. Antes, el aviso se procesaba
   * para el aula DUEÑA de la reunión aunque lo hubiera firmado otra: el admin
   * del aula B, con su propio secreto de Zoom y el id de una clase del aula A
   * (que ve cualquier alumno de A), le cambiaba el estado a la clase, le
   * lanzaba la encuesta post-clase o le colgaba como grabación un enlace suyo.
   */
  describe('aislamiento entre aulas', () => {
    const AULA_A = 'aula-a';
    const AULA_B = 'aula-b';
    const SECRET_B = 'secreto-de-zoom-de-B';
    const body = JSON.stringify({
      event: 'recording.completed',
      event_ts: 1785782996000,
      payload: {
        object: { id: 87470222827, share_url: 'https://phishing.example/grabacion' },
      },
    });

    function reqFirmadaPorB() {
      const { signatureHeader, timestampHeader } = sign(body, SECRET_B);
      return {
        headers: {
          host: 'aula-b.example.com',
          'x-zm-signature': signatureHeader,
          'x-zm-request-timestamp': timestampHeader,
        },
        ip: '203.0.113.7',
        rawBody: Buffer.from(body, 'utf8'),
      } as never;
    }

    it('ATAQUE: aviso firmado por B con el id de una clase de A, en el dominio de B → 403 y no se procesa', async () => {
      const handleWebhookEvent = vi.fn();
      const { controller, auditLog, logger } = makeController({
        tenant: { id: AULA_B },
        secretsByTenant: { [AULA_B]: SECRET_B, [AULA_A]: 'secreto-de-zoom-de-A' },
        resolveWebhookTenantId: vi.fn().mockResolvedValue(AULA_A),
        handleWebhookEvent,
      });

      await expect(controller.handle(reqFirmadaPorB())).rejects.toBeInstanceOf(ForbiddenException);

      expect(handleWebhookEvent).not.toHaveBeenCalled();
      // Rastro: log de error + auditoría en el aula que FIRMÓ.
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(auditLog.record).toHaveBeenCalledTimes(1);
      expect(auditLog.record.mock.calls[0]![0]).toMatchObject({
        tenantId: AULA_B,
        action: 'security.webhook.tenant_mismatch',
        resourceType: 'zoom_webhook',
      });
    });

    it('ATAQUE: la víctima no tiene secreto de Zoom configurado → 403 igualmente', async () => {
      const handleWebhookEvent = vi.fn();
      const { controller } = makeController({
        tenant: { id: AULA_B },
        secretsByTenant: { [AULA_B]: SECRET_B, [AULA_A]: null },
        resolveWebhookTenantId: vi.fn().mockResolvedValue(AULA_A),
        handleWebhookEvent,
      });

      await expect(controller.handle(reqFirmadaPorB())).rejects.toBeInstanceOf(ForbiddenException);
      expect(handleWebhookEvent).not.toHaveBeenCalled();
    });

    it('CONTROL: aviso de B sobre una clase de B → se procesa para B', async () => {
      const handleWebhookEvent = vi.fn().mockResolvedValue({ result: 'OK', sessionId: 's-b' });
      const { controller, auditLog } = makeController({
        tenant: { id: AULA_B },
        secretsByTenant: { [AULA_B]: SECRET_B },
        resolveWebhookTenantId: vi.fn().mockResolvedValue(AULA_B),
        handleWebhookEvent,
      });

      await expect(controller.handle(reqFirmadaPorB())).resolves.toEqual({
        result: 'OK',
        sessionId: 's-b',
      });
      expect(handleWebhookEvent.mock.calls[0]![1]).toEqual({ rawBody: body, tenantId: AULA_B });
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('reunión que no es de ningún aula → se archiva en la del dominio, nunca sin tenant', async () => {
      const handleWebhookEvent = vi.fn().mockResolvedValue({ result: 'IGNORED' });
      const { controller } = makeController({
        tenant: { id: AULA_B },
        secretsByTenant: { [AULA_B]: SECRET_B },
        resolveWebhookTenantId: vi.fn().mockResolvedValue(null),
        handleWebhookEvent,
      });

      await controller.handle(reqFirmadaPorB());
      expect(handleWebhookEvent.mock.calls[0]![1]).toEqual({ rawBody: body, tenantId: AULA_B });
    });

    it('COMPATIBILIDAD: la misma app de Zoom en dos aulas (mismo secreto) → se procesa para la dueña de la reunión', async () => {
      const handleWebhookEvent = vi.fn().mockResolvedValue({ result: 'OK', sessionId: 's-a' });
      const { controller, auditLog } = makeController({
        tenant: { id: AULA_B },
        secretsByTenant: { [AULA_B]: SECRET_B, [AULA_A]: SECRET_B },
        resolveWebhookTenantId: vi.fn().mockResolvedValue(AULA_A),
        handleWebhookEvent,
      });

      await expect(controller.handle(reqFirmadaPorB())).resolves.toEqual({
        result: 'OK',
        sessionId: 's-a',
      });
      expect(handleWebhookEvent.mock.calls[0]![1]).toEqual({ rawBody: body, tenantId: AULA_A });
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });
});
