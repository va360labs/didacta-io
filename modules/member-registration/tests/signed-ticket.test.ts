import { describe, expect, it } from 'vitest';
import { signTicket, verifyTicket } from '../src/signed-ticket.js';

// ============================================================================
// Tests de los tickets firmados (HMAC-SHA256) del flujo de inscripción.
// Cubren el roundtrip sign+verify y los caminos de rechazo: firma manipulada,
// ticket expirado, formato inválido y secreto distinto. Sin DB ni red.
// ============================================================================

const SECRET = 'auth-secret-de-test-1234567890';

describe('signed-ticket', () => {
  describe('signTicket + verifyTicket (roundtrip)', () => {
    it('firma y verifica devolviendo los claims originales + exp', () => {
      const ticket = signTicket(
        { telegramId: '999', inGroup: 'true', purpose: 'telegram' },
        SECRET,
        300,
      );
      // El ticket compacto tiene formato <data>.<sig> (dos partes).
      expect(ticket.split('.')).toHaveLength(2);

      const claims = verifyTicket<{
        telegramId: string;
        inGroup: string;
        purpose: string;
        exp: number;
      }>(ticket, SECRET);

      expect(claims).not.toBeNull();
      expect(claims?.telegramId).toBe('999');
      expect(claims?.inGroup).toBe('true');
      expect(claims?.purpose).toBe('telegram');
      // El TTL se materializa como `exp` absoluto en segundos.
      expect(typeof claims?.exp).toBe('number');
      expect(claims!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  describe('caminos de rechazo (devuelven null, nunca lanzan)', () => {
    it('rechaza una firma manipulada', () => {
      const ticket = signTicket({ a: 1 }, SECRET, 300);
      const [data] = ticket.split('.');
      // Reemplazamos la firma por una de la misma longitud pero inválida.
      const tampered = `${data}.${'A'.repeat(ticket.split('.')[1]!.length)}`;
      expect(verifyTicket(tampered, SECRET)).toBeNull();
    });

    it('rechaza si el payload (data) fue modificado tras firmar', () => {
      const ticket = signTicket({ a: 1 }, SECRET, 300);
      const [data, sig] = ticket.split('.');
      // Misma longitud de data pero contenido distinto ⇒ firma no cuadra.
      const flippedChar = data![0] === 'A' ? 'B' : 'A';
      const tamperedData = flippedChar + data!.slice(1);
      expect(verifyTicket(`${tamperedData}.${sig}`, SECRET)).toBeNull();
    });

    it('rechaza un ticket expirado (TTL negativo ⇒ exp en el pasado)', () => {
      const expired = signTicket({ a: 1 }, SECRET, -10);
      expect(verifyTicket(expired, SECRET)).toBeNull();
    });

    it('rechaza un ticket con exp ya pasado aunque la firma sea válida', () => {
      // TTL 0 ⇒ exp == nowSeconds(); la verificación exige exp >= now, pero
      // con -1 garantizamos que está en el pasado de forma determinista.
      const expired = signTicket({ a: 1 }, SECRET, -1);
      expect(verifyTicket(expired, SECRET)).toBeNull();
    });

    it('rechaza formato inválido: sin punto separador', () => {
      expect(verifyTicket('soloundato', SECRET)).toBeNull();
    });

    it('rechaza formato inválido: más de dos partes', () => {
      expect(verifyTicket('a.b.c', SECRET)).toBeNull();
    });

    it('rechaza formato inválido: parte vacía', () => {
      expect(verifyTicket('.firma', SECRET)).toBeNull();
      expect(verifyTicket('data.', SECRET)).toBeNull();
    });

    it('rechaza string vacío', () => {
      expect(verifyTicket('', SECRET)).toBeNull();
    });

    it('rechaza un token que no es string', () => {
      // El contrato dice "nunca lanza"; un no-string ⇒ null.
      expect(verifyTicket(undefined as unknown as string, SECRET)).toBeNull();
      expect(verifyTicket(null as unknown as string, SECRET)).toBeNull();
      expect(verifyTicket(123 as unknown as string, SECRET)).toBeNull();
    });

    it('rechaza si se verifica con un secreto distinto', () => {
      const ticket = signTicket({ a: 1 }, SECRET, 300);
      expect(verifyTicket(ticket, 'otro-secreto-totalmente-distinto')).toBeNull();
    });

    it('rechaza si el data no es JSON válido en base64url', () => {
      // `***` no es base64url; al decodificar/parsear da basura ⇒ null.
      // Aun así primero falla la firma, pero confirmamos que no lanza.
      expect(verifyTicket('***.***', SECRET)).toBeNull();
    });
  });
});
