import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyZoomSignature } from '../src/webhook-signature.js';

const SECRET = 'test-webhook-secret';

function signed(opts: { body: string; timestamp: number; secret?: string }): {
  signature: string;
  timestamp: string;
} {
  const ts = String(opts.timestamp);
  const hmac = createHmac('sha256', opts.secret ?? SECRET)
    .update(`v0:${ts}:${opts.body}`)
    .digest('hex');
  return { signature: `v0=${hmac}`, timestamp: ts };
}

describe('verifyZoomSignature', () => {
  const NOW = 1735689600000; // 2025-01-01 UTC

  it('acepta una firma válida dentro del drift', () => {
    const body = JSON.stringify({ event: 'meeting.started' });
    const { signature, timestamp } = signed({ body, timestamp: NOW });
    const ok = verifyZoomSignature({
      signatureHeader: signature,
      timestampHeader: timestamp,
      rawBody: body,
      secret: SECRET,
      now: () => NOW,
    });
    expect(ok).toBe(true);
  });

  it('rechaza si el body fue modificado tras firmar', () => {
    const body = JSON.stringify({ event: 'meeting.started' });
    const { signature, timestamp } = signed({ body, timestamp: NOW });
    const ok = verifyZoomSignature({
      signatureHeader: signature,
      timestampHeader: timestamp,
      rawBody: body + ' tampered',
      secret: SECRET,
      now: () => NOW,
    });
    expect(ok).toBe(false);
  });

  it('rechaza con secret distinto', () => {
    const body = '{}';
    const { signature, timestamp } = signed({ body, timestamp: NOW, secret: 'otro' });
    const ok = verifyZoomSignature({
      signatureHeader: signature,
      timestampHeader: timestamp,
      rawBody: body,
      secret: SECRET,
      now: () => NOW,
    });
    expect(ok).toBe(false);
  });

  // Formato REAL de Zoom: `x-zm-request-timestamp` va en SEGUNDOS (10
  // dígitos). Antes se comparaba tal cual contra Date.now() (ms), lo que daba
  // un drift de ~56 años y devolvía 401 a TODOS los webhooks reales —
  // invisible en los tests porque estos firmaban con ms.
  it('acepta el timestamp en segundos que envía Zoom de verdad', () => {
    const body = JSON.stringify({ event: 'meeting.started' });
    const seconds = Math.floor(NOW / 1000);
    const { signature, timestamp } = signed({ body, timestamp: seconds });
    const ok = verifyZoomSignature({
      signatureHeader: signature,
      timestampHeader: timestamp,
      rawBody: body,
      secret: SECRET,
      now: () => NOW,
    });
    expect(ok).toBe(true);
  });

  it('rechaza drift > 5 min también cuando el timestamp viene en segundos', () => {
    const body = '{}';
    const seconds = Math.floor(NOW / 1000) - 6 * 60;
    const { signature, timestamp } = signed({ body, timestamp: seconds });
    const ok = verifyZoomSignature({
      signatureHeader: signature,
      timestampHeader: timestamp,
      rawBody: body,
      secret: SECRET,
      now: () => NOW,
    });
    expect(ok).toBe(false);
  });

  it('rechaza si el timestamp tiene drift mayor a 5 minutos', () => {
    const body = '{}';
    const { signature, timestamp } = signed({ body, timestamp: NOW - 6 * 60 * 1000 });
    const ok = verifyZoomSignature({
      signatureHeader: signature,
      timestampHeader: timestamp,
      rawBody: body,
      secret: SECRET,
      now: () => NOW,
    });
    expect(ok).toBe(false);
  });

  it('rechaza headers ausentes', () => {
    expect(
      verifyZoomSignature({
        signatureHeader: undefined,
        timestampHeader: '1',
        rawBody: '',
        secret: SECRET,
      }),
    ).toBe(false);
    expect(
      verifyZoomSignature({
        signatureHeader: 'v0=abc',
        timestampHeader: undefined,
        rawBody: '',
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it('rechaza prefijo distinto de v0=', () => {
    const body = '{}';
    const expected = createHmac('sha256', SECRET).update(`v0:${NOW}:${body}`).digest('hex');
    const ok = verifyZoomSignature({
      signatureHeader: `v1=${expected}`,
      timestampHeader: String(NOW),
      rawBody: body,
      secret: SECRET,
      now: () => NOW,
    });
    expect(ok).toBe(false);
  });

  it('rechaza secret vacío', () => {
    const body = '{}';
    const { signature, timestamp } = signed({ body, timestamp: NOW });
    const ok = verifyZoomSignature({
      signatureHeader: signature,
      timestampHeader: timestamp,
      rawBody: body,
      secret: '',
      now: () => NOW,
    });
    expect(ok).toBe(false);
  });
});
