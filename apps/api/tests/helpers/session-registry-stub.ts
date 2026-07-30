import type { SessionRegistryService } from '../../src/auth/session-registry.service';
import type { SessionClaims, SignedTokens } from '../../src/auth/token.service';

/**
 * Stub de `SessionRegistryService` para tests unitarios que solo quieren
 * comprobar que un flujo de autenticación emite tokens.
 *
 * Emite firmando de verdad pero sin tocar la BD: la escritura de la fila
 * `session` la cubren `session-registry.service.test.ts` y la spec E2E, y
 * añadirla aquí obligaría a que cada mock de Prisma del repo tuviera un
 * `session.create`.
 */
export function sessionRegistryStub(tokens: {
  sign: (claims: SessionClaims) => Promise<SignedTokens>;
}): SessionRegistryService {
  const sid = '00000000-0000-4000-8000-000000000000';
  return {
    issue: (claims: Omit<SessionClaims, 'sid'>) => tokens.sign({ ...claims, sid }),
    rotate: (existing: string | undefined, claims: Omit<SessionClaims, 'sid'>) =>
      tokens.sign({ ...claims, sid: existing ?? sid }),
  } as unknown as SessionRegistryService;
}
