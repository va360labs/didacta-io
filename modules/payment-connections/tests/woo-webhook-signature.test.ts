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

describe('verifyWooSignature · cuerpo con acentos (el caso que falló en producción)', () => {
  // Un pedido real lleva «Iniciación», «España», nombres con tildes… Mi primera
  // versión firmaba sobre el string y la prueba que hice era ASCII puro, así que
  // pasó en local y rechazó todas las entregas reales de WooCommerce.
  const ACENTOS = JSON.stringify({
    id: 15809,
    billing: { first_name: 'José', last_name: 'Muñoz Aragón', country: 'España' },
    line_items: [{ name: 'VPS Iniciación — edición 2026 · 100 % práctico' }],
  });

  it('acepta la firma de un cuerpo con caracteres no ASCII', () => {
    const body = Buffer.from(ACENTOS, 'utf8');
    const firma = createHmac('sha256', SECRET).update(body).digest('base64');
    expect(verifyWooSignature({ signatureHeader: firma, rawBody: body, secret: SECRET })).toBe(
      true,
    );
  });

  it('firmar sobre el Buffer y sobre su string dan el mismo HMAC cuando el UTF-8 es válido', () => {
    const body = Buffer.from(ACENTOS, 'utf8');
    expect(
      verifyWooSignature({ signatureHeader: hmacDe(body), rawBody: body, secret: SECRET }),
    ).toBe(true);
    expect(
      verifyWooSignature({ signatureHeader: hmacDe(body), rawBody: ACENTOS, secret: SECRET }),
    ).toBe(true);
  });

  it('con bytes que NO son UTF-8 válido, solo el Buffer verifica', () => {
    // Aquí es donde se rompía: pasar por string sustituye el byte inválido por
    // el carácter de reemplazo y el HMAC cambia para siempre.
    const body = Buffer.concat([
      Buffer.from('{"a":"'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}'),
    ]);
    const firma = hmacDe(body);
    expect(verifyWooSignature({ signatureHeader: firma, rawBody: body, secret: SECRET })).toBe(
      true,
    );
    expect(
      verifyWooSignature({
        signatureHeader: firma,
        rawBody: body.toString('utf8'),
        secret: SECRET,
      }),
      'pasar por string pierde los bytes: por eso hay que firmar el Buffer',
    ).toBe(false);
  });

  it('un Buffer vacío se rechaza', () => {
    expect(
      verifyWooSignature({ signatureHeader: 'x', rawBody: Buffer.alloc(0), secret: SECRET }),
    ).toBe(false);
  });
});

function hmacDe(body: Buffer): string {
  return createHmac('sha256', SECRET).update(body).digest('base64');
}

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
