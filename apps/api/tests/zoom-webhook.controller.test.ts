import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
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
  resolveWebhookTenantId?: ReturnType<typeof vi.fn>;
  handleWebhookEvent?: ReturnType<typeof vi.fn>;
}) {
  const zoomLive = {
    getWebhookSecret: vi
      .fn()
      .mockResolvedValue(opts?.webhookSecret === undefined ? SECRET : opts.webhookSecret),
    resolveWebhookTenantId: opts?.resolveWebhookTenantId ?? vi.fn().mockResolvedValue(TENANT_ID),
    handleWebhookEvent: opts?.handleWebhookEvent ?? vi.fn().mockResolvedValue({ result: 'OK' }),
  };
  const registry = { getZoomLiveService: () => zoomLive } as never;
  const tenantResolver = {
    resolveByHost: vi
      .fn()
      .mockResolvedValue(opts?.tenant === undefined ? { id: TENANT_ID } : opts.tenant),
  } as never;
  return { controller: new ZoomWebhookController(registry, tenantResolver), zoomLive };
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

  it('payload con shape desconocido → IGNORED sin tocar handleWebhookEvent', async () => {
    const handleWebhookEvent = vi.fn();
    const { controller } = makeController({ handleWebhookEvent });
    const body = JSON.stringify({ not: 'a webhook event' });

    const result = await controller.handle(makeReq(body));

    expect(result).toEqual({ result: 'IGNORED', reason: 'unknown_payload_shape' });
    expect(handleWebhookEvent).not.toHaveBeenCalled();
  });
});
