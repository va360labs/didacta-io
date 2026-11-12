import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PayoutsWebhookSignatureInvalidError } from '../src/errors.js';
import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  assertStripeSignature,
  signStripePayload,
  verifyStripeSignature,
} from '../src/stripe/signature.js';

// ============================================================================
// Firma del webhook de Stripe con varios secretos y tolerancia de reloj.
//
// Los secretos son cadenas de test, no de ningún endpoint real.
// ============================================================================

const PLATAFORMA = 'whsec_test_endpoint_de_plataforma';
const CONECTADAS = 'whsec_test_endpoint_de_cuentas_conectadas';
const V2 = 'whsec_test_endpoint_v2';
const SECRETOS = [PLATAFORMA, CONECTADAS, V2] as const;

const AHORA = 1_794_000_000;
const CUERPO = JSON.stringify({
  id: 'evt_test_1',
  object: 'event',
  type: 'charge.updated',
  livemode: false,
  data: { object: { id: 'ch_test_1', amount: 10000 } },
});

/** Firma calculada a mano, sin pasar por el código bajo prueba. */
function firmaIndependiente(cuerpo: string, secreto: string, t: number): string {
  return createHmac('sha256', secreto).update(`${t}.${cuerpo}`, 'utf8').digest('hex');
}

function cabecera(cuerpo: string, secreto: string, t: number = AHORA): string {
  return `t=${t},v1=${firmaIndependiente(cuerpo, secreto, t)}`;
}

describe('verifyStripeSignature — firma válida', () => {
  it.each([
    ['plataforma', PLATAFORMA, 0],
    ['cuentas conectadas', CONECTADAS, 1],
    ['API v2', V2, 2],
  ])('vale con el secreto de %s y dice cuál casó', (_nombre, secreto, indice) => {
    const resultado = verifyStripeSignature({
      payload: CUERPO,
      header: cabecera(CUERPO, secreto),
      secrets: SECRETOS,
      nowSeconds: AHORA,
    });
    expect(resultado).toEqual({ valid: true, timestamp: AHORA, secretIndex: indice });
  });

  it('acepta el cuerpo como Buffer (el cuerpo crudo de la petición)', () => {
    const resultado = verifyStripeSignature({
      payload: Buffer.from(CUERPO, 'utf8'),
      header: cabecera(CUERPO, CONECTADAS),
      secrets: SECRETOS,
      nowSeconds: AHORA,
    });
    expect(resultado.valid).toBe(true);
  });

  it('acepta varias firmas v1 (rotación de secreto): basta con que una case', () => {
    const buena = firmaIndependiente(CUERPO, V2, AHORA);
    const vieja = firmaIndependiente(CUERPO, 'whsec_test_secreto_ya_retirado', AHORA);
    const resultado = verifyStripeSignature({
      payload: CUERPO,
      header: `t=${AHORA},v1=${vieja},v1=${buena},v0=loquesea`,
      secrets: SECRETOS,
      nowSeconds: AHORA,
    });
    expect(resultado).toEqual({ valid: true, timestamp: AHORA, secretIndex: 2 });
  });

  it('firma en mayúsculas hexadecimales también vale', () => {
    const resultado = verifyStripeSignature({
      payload: CUERPO,
      header: `t=${AHORA},v1=${firmaIndependiente(CUERPO, PLATAFORMA, AHORA).toUpperCase()}`,
      secrets: SECRETOS,
      nowSeconds: AHORA,
    });
    expect(resultado.valid).toBe(true);
  });

  it('signStripePayload produce una cabecera que verifica (y coincide con el cálculo a mano)', () => {
    const header = signStripePayload(CUERPO, PLATAFORMA, AHORA);
    expect(header).toBe(cabecera(CUERPO, PLATAFORMA));
    expect(
      verifyStripeSignature({ payload: CUERPO, header, secrets: [PLATAFORMA], nowSeconds: AHORA })
        .valid,
    ).toBe(true);
  });
});

describe('verifyStripeSignature — firma inválida', () => {
  it('rechaza una firma hecha con un secreto que no está en la lista', () => {
    // El secreto de OTRO creador (modo claves propias) no abre el webhook de plataforma.
    const resultado = verifyStripeSignature({
      payload: CUERPO,
      header: cabecera(CUERPO, 'whsec_test_secreto_de_otro_creador'),
      secrets: SECRETOS,
      nowSeconds: AHORA,
    });
    expect(resultado).toEqual({ valid: false, reason: 'no_match' });
  });

  it('rechaza si el cuerpo cambió un solo carácter', () => {
    const resultado = verifyStripeSignature({
      payload: CUERPO.replace('10000', '10001'),
      header: cabecera(CUERPO, PLATAFORMA),
      secrets: SECRETOS,
      nowSeconds: AHORA,
    });
    expect(resultado).toEqual({ valid: false, reason: 'no_match' });
  });

  it('rechaza si el JSON se volvió a serializar (el cuerpo tiene que ser el crudo)', () => {
    const reserializado = JSON.stringify(JSON.parse(CUERPO), null, 2);
    expect(reserializado).not.toBe(CUERPO);
    const resultado = verifyStripeSignature({
      payload: reserializado,
      header: cabecera(CUERPO, PLATAFORMA),
      secrets: SECRETOS,
      nowSeconds: AHORA,
    });
    expect(resultado).toEqual({ valid: false, reason: 'no_match' });
  });

  it('rechaza una firma con el último dígito cambiado', () => {
    const buena = firmaIndependiente(CUERPO, PLATAFORMA, AHORA);
    const ultimo = buena.endsWith('0') ? '1' : '0';
    const resultado = verifyStripeSignature({
      payload: CUERPO,
      header: `t=${AHORA},v1=${buena.slice(0, -1)}${ultimo}`,
      secrets: SECRETOS,
      nowSeconds: AHORA,
    });
    expect(resultado).toEqual({ valid: false, reason: 'no_match' });
  });

  it('sin secretos configurados no vale nada (y un secreto vacío no cuenta)', () => {
    const firmadaConVacio = `t=${AHORA},v1=${firmaIndependiente(CUERPO, '', AHORA)}`;
    expect(
      verifyStripeSignature({
        payload: CUERPO,
        header: firmadaConVacio,
        secrets: [],
        nowSeconds: AHORA,
      }),
    ).toEqual({ valid: false, reason: 'no_secrets' });
    expect(
      verifyStripeSignature({
        payload: CUERPO,
        header: firmadaConVacio,
        secrets: [''],
        nowSeconds: AHORA,
      }),
    ).toEqual({ valid: false, reason: 'no_secrets' });
    // Con un secreto vacío colado entre los buenos, firmar con '' sigue sin valer,
    // y el índice del que sí casa es el de la lista original.
    expect(
      verifyStripeSignature({
        payload: CUERPO,
        header: firmadaConVacio,
        secrets: ['', PLATAFORMA],
        nowSeconds: AHORA,
      }),
    ).toEqual({ valid: false, reason: 'no_match' });
    expect(
      verifyStripeSignature({
        payload: CUERPO,
        header: cabecera(CUERPO, PLATAFORMA),
        secrets: ['', PLATAFORMA],
        nowSeconds: AHORA,
      }),
    ).toEqual({ valid: true, timestamp: AHORA, secretIndex: 1 });
  });
});

describe('verifyStripeSignature — cabecera manipulada', () => {
  const buena = firmaIndependiente(CUERPO, PLATAFORMA, AHORA);

  it('rechaza si se cambia la marca de tiempo conservando la firma', () => {
    // El `t` forma parte de lo firmado: moverlo invalida la firma.
    const resultado = verifyStripeSignature({
      payload: CUERPO,
      header: `t=${AHORA + 1},v1=${buena}`,
      secrets: SECRETOS,
      nowSeconds: AHORA,
    });
    expect(resultado).toEqual({ valid: false, reason: 'no_match' });
  });

  it('rechaza una cabecera con dos t= (no se elige uno)', () => {
    const resultado = verifyStripeSignature({
      payload: CUERPO,
      header: `t=${AHORA},t=${AHORA - 9999},v1=${buena}`,
      secrets: SECRETOS,
      nowSeconds: AHORA,
    });
    expect(resultado).toEqual({ valid: false, reason: 'malformed_header' });
  });

  it.each([
    ['sin t=', `v1=${buena}`],
    ['sin v1=', `t=${AHORA}`],
    ['solo v0=', `t=${AHORA},v0=${buena}`],
    ['t no numérico', `t=ahora,v1=${buena}`],
    ['t negativo', `t=-${AHORA},v1=${buena}`],
    ['basura', 'esto no es una cabecera'],
  ])('cabecera mal formada: %s', (_nombre, header) => {
    expect(
      verifyStripeSignature({ payload: CUERPO, header, secrets: SECRETOS, nowSeconds: AHORA }),
    ).toEqual({ valid: false, reason: 'malformed_header' });
  });

  it.each([undefined, null, ''])('cabecera ausente (%s)', (header) => {
    expect(
      verifyStripeSignature({ payload: CUERPO, header, secrets: SECRETOS, nowSeconds: AHORA }),
    ).toEqual({ valid: false, reason: 'missing_header' });
  });

  it.each([
    ['firma corta', 'abcd'],
    ['firma vacía', ''],
    ['firma no hexadecimal', 'z'.repeat(64)],
    ['firma larga', `${buena}00`],
  ])('no revienta ni vale con %s', (_nombre, firma) => {
    expect(
      verifyStripeSignature({
        payload: CUERPO,
        header: `t=${AHORA},v1=${firma}`,
        secrets: SECRETOS,
        nowSeconds: AHORA,
      }),
    ).toEqual({ valid: false, reason: 'no_match' });
  });

  it('una firma de 64 ceros no casa por la comparación de relleno', () => {
    expect(
      verifyStripeSignature({
        payload: CUERPO,
        header: `t=${AHORA},v1=${'0'.repeat(64)}`,
        secrets: SECRETOS,
        nowSeconds: AHORA,
      }),
    ).toEqual({ valid: false, reason: 'no_match' });
  });
});

describe('verifyStripeSignature — tolerancia de reloj', () => {
  it('la tolerancia por defecto son 300 s', () => {
    expect(DEFAULT_SIGNATURE_TOLERANCE_SECONDS).toBe(300);
  });

  it.each([
    ['justo en el límite, hacia atrás', -300, true],
    ['un segundo más viejo que el límite', -301, false],
    ['justo en el límite, hacia delante', 300, true],
    ['un segundo más en el futuro que el límite', 301, false],
  ])('%s', (_nombre, desfase, vale) => {
    const t = AHORA + desfase;
    const resultado = verifyStripeSignature({
      payload: CUERPO,
      header: cabecera(CUERPO, PLATAFORMA, t),
      secrets: SECRETOS,
      nowSeconds: AHORA,
    });
    expect(resultado).toEqual(
      vale
        ? { valid: true, timestamp: t, secretIndex: 0 }
        : { valid: false, reason: 'timestamp_out_of_tolerance' },
    );
  });

  it('un evento firmado de verdad pero de hace una hora se rechaza (repetición)', () => {
    const resultado = verifyStripeSignature({
      payload: CUERPO,
      header: cabecera(CUERPO, PLATAFORMA, AHORA - 3600),
      secrets: SECRETOS,
      nowSeconds: AHORA,
    });
    expect(resultado).toEqual({ valid: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('la tolerancia es configurable', () => {
    const header = cabecera(CUERPO, PLATAFORMA, AHORA - 3600);
    expect(
      verifyStripeSignature({
        payload: CUERPO,
        header,
        secrets: SECRETOS,
        nowSeconds: AHORA,
        toleranceSeconds: 3600,
      }).valid,
    ).toBe(true);
    expect(
      verifyStripeSignature({
        payload: CUERPO,
        header,
        secrets: SECRETOS,
        nowSeconds: AHORA,
        toleranceSeconds: 3599,
      }).valid,
    ).toBe(false);
  });

  it('a una firma falsa fuera de tolerancia se le dice no_match, no la hora', () => {
    const resultado = verifyStripeSignature({
      payload: CUERPO,
      header: cabecera(CUERPO, 'whsec_test_secreto_de_otro_creador', AHORA - 3600),
      secrets: SECRETOS,
      nowSeconds: AHORA,
    });
    expect(resultado).toEqual({ valid: false, reason: 'no_match' });
  });

  it('sin nowSeconds usa el reloj del sistema', () => {
    const ahoraReal = Math.floor(Date.now() / 1000);
    expect(
      verifyStripeSignature({
        payload: CUERPO,
        header: cabecera(CUERPO, PLATAFORMA, ahoraReal),
        secrets: SECRETOS,
      }).valid,
    ).toBe(true);
    expect(
      verifyStripeSignature({
        payload: CUERPO,
        header: cabecera(CUERPO, PLATAFORMA, ahoraReal - 86_400),
        secrets: SECRETOS,
      }),
    ).toEqual({ valid: false, reason: 'timestamp_out_of_tolerance' });
  });
});

describe('assertStripeSignature', () => {
  it('devuelve la marca de tiempo y el secreto que casó', () => {
    expect(
      assertStripeSignature({
        payload: CUERPO,
        header: cabecera(CUERPO, CONECTADAS),
        secrets: SECRETOS,
        nowSeconds: AHORA,
      }),
    ).toEqual({ timestamp: AHORA, secretIndex: 1 });
  });

  it('lanza el error de dominio con el motivo, sin el secreto ni la firma', () => {
    let error: unknown;
    try {
      assertStripeSignature({
        payload: CUERPO,
        header: cabecera(CUERPO, 'whsec_test_secreto_de_otro_creador'),
        secrets: SECRETOS,
        nowSeconds: AHORA,
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PayoutsWebhookSignatureInvalidError);
    const e = error as PayoutsWebhookSignatureInvalidError;
    expect(e.code).toBe('PAYOUTS_WEBHOOK_SIGNATURE_INVALID');
    expect(e.detail).toBe('no_match');
    for (const secreto of SECRETOS) expect(e.message).not.toContain(secreto);
  });
});
