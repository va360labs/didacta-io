import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWooSignature, WOO_ORDER_TOPICS } from '../src/woo-webhook-signature.js';

const SECRET = 'un-secreto-de-webhook-de-woocommerce';
const BODY = JSON.stringify({ id: 15809, status: 'completed', total: '297.00' });

function firmar(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

describe('verifyWooSignature', () => {
  it('acepta una firma legítima', () => {
    expect(
      verifyWooSignature({ signatureHeader: firmar(BODY), rawBody: BODY, secret: SECRET }),
    ).toBe(true);
  });

  it('rechaza una firma de otro secreto', () => {
    expect(
      verifyWooSignature({
        signatureHeader: firmar(BODY, 'otro-secreto-distinto-cualquiera'),
        rawBody: BODY,
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it('rechaza si el cuerpo cambió aunque sea un carácter', () => {
    // Es la defensa de verdad: sin esto, cualquiera podría regalarse acceso
    // reenviando un pedido ajeno con el importe o el email cambiados.
    const manipulado = BODY.replace('297.00', '0.00');
    expect(
      verifyWooSignature({ signatureHeader: firmar(BODY), rawBody: manipulado, secret: SECRET }),
    ).toBe(false);
  });

  it('rechaza sin cabecera de firma', () => {
    expect(verifyWooSignature({ signatureHeader: undefined, rawBody: BODY, secret: SECRET })).toBe(
      false,
    );
  });

  it('rechaza una firma vacía', () => {
    expect(verifyWooSignature({ signatureHeader: '', rawBody: BODY, secret: SECRET })).toBe(false);
  });

  it('rechaza si no hay secreto configurado', () => {
    // Sin secreto no se puede verificar nada: aceptar sería abrir el endpoint.
    expect(verifyWooSignature({ signatureHeader: firmar(BODY), rawBody: BODY, secret: '' })).toBe(
      false,
    );
  });

  it('rechaza un cuerpo vacío', () => {
    expect(verifyWooSignature({ signatureHeader: firmar(''), rawBody: '', secret: SECRET })).toBe(
      false,
    );
  });

  it('tolera espacios alrededor de la firma', () => {
    expect(
      verifyWooSignature({
        signatureHeader: `  ${firmar(BODY)}  `,
        rawBody: BODY,
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it('rechaza una firma en hex: Woo la manda en base64', () => {
    const hex = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex');
    expect(verifyWooSignature({ signatureHeader: hex, rawBody: BODY, secret: SECRET })).toBe(false);
  });

  it('rechaza basura sin reventar', () => {
    for (const basura of ['xxx', '===', 'v0=abc', '{"a":1}']) {
      expect(
        verifyWooSignature({ signatureHeader: basura, rawBody: BODY, secret: SECRET }),
        basura,
      ).toBe(false);
    }
  });

  it('el cuerpo se firma tal cual llega: reserializar el JSON rompe la firma', () => {
    const firma = firmar(BODY);
    const reserializado = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(
      verifyWooSignature({ signatureHeader: firma, rawBody: reserializado, secret: SECRET }),
    ).toBe(false);
  });
});

describe('WOO_ORDER_TOPICS', () => {
  it('cubre alta, cambio y borrado de pedido', () => {
    expect(WOO_ORDER_TOPICS.has('order.created')).toBe(true);
    expect(WOO_ORDER_TOPICS.has('order.updated')).toBe(true);
    expect(WOO_ORDER_TOPICS.has('order.deleted')).toBe(true);
  });

  it('ignora temas que no son de pedidos', () => {
    expect(WOO_ORDER_TOPICS.has('customer.created')).toBe(false);
    expect(WOO_ORDER_TOPICS.has('product.updated')).toBe(false);
  });
});
