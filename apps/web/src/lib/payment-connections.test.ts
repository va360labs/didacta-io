import { describe, it, expect } from 'vitest';
import { classifySubscriptionStatus, connectionStatusStyle } from './payment-connections';

/**
 * Guardia de PARIDAD de `classifySubscriptionStatus`.
 *
 * Esta función está duplicada a propósito: la copia canónica vive en el módulo
 * backend `modules/payment-connections/src/payment-connections.service.ts` y esta
 * es su espejo en la web (apps/web no puede importar `@didacta/mod-payment-connections`,
 * mismo patrón que `formatAmount`). Para que las dos copias NO diverjan en silencio,
 * la tabla de abajo es IDÉNTICA a `SUBSCRIPTION_STATUS_TABLE` del test del módulo
 * (`modules/payment-connections/tests/payment-connections.service.test.ts`): si una
 * copia se edita sin la otra, su test falla.
 */
const SUBSCRIPTION_STATUS_TABLE: Record<
  string,
  { category: string; label: string; entitled: boolean }
> = {
  active: { category: 'active', label: 'Activa', entitled: true },
  trialing: { category: 'active', label: 'En prueba', entitled: true },
  past_due: { category: 'past_due', label: 'Pago atrasado (impago)', entitled: true },
  unpaid: { category: 'unpaid', label: 'Impago — suspendida', entitled: false },
  'on-hold': { category: 'past_due', label: 'En espera (impago)', entitled: true },
  paused: { category: 'paused', label: 'Pausada', entitled: false },
  'pending-cancel': { category: 'canceled', label: 'Baja programada', entitled: true },
  canceled: { category: 'canceled', label: 'Dada de baja', entitled: false },
  cancelled: { category: 'canceled', label: 'Dada de baja', entitled: false },
  expired: { category: 'canceled', label: 'Expirada', entitled: false },
  incomplete: { category: 'incomplete', label: 'Pago no completado', entitled: false },
  incomplete_expired: { category: 'incomplete', label: 'Pago no completado', entitled: false },
  pending: { category: 'incomplete', label: 'Pendiente de pago', entitled: false },
};

describe('classifySubscriptionStatus (web · paridad con el módulo)', () => {
  it('respeta la misma tabla canónica de (category, label, entitled)', () => {
    for (const [status, expected] of Object.entries(SUBSCRIPTION_STATUS_TABLE)) {
      expect({ status, ...classifySubscriptionStatus(status) }).toEqual({ status, ...expected });
    }
  });

  it('normaliza mayúsculas/espacios y cae a "Desconocido" en estados no reconocidos', () => {
    expect(classifySubscriptionStatus('  ACTIVE ').entitled).toBe(true);
    const unknown = classifySubscriptionStatus('rarísimo');
    expect(unknown).toEqual({ category: 'unknown', label: 'rarísimo', entitled: false });
  });
});

/**
 * Camino degradado de la badge de estado de una conexión.
 *
 * El bug que cierra: la página indexaba el mapa de estilos a pelo
 * (`map[status].key`). Un estado que el front no conozca —basta un deploy de
 * API por delante del de web— daba `undefined`, leer `.key` lanzaba un
 * TypeError y el error boundary dejaba TODA la pantalla de conexiones de pago
 * en blanco por una sola fila.
 */
describe('connectionStatusStyle', () => {
  it('los 4 estados conocidos traen su key de catálogo', () => {
    expect(connectionStatusStyle('VERIFIED').key).toBe('verified');
    expect(connectionStatusStyle('ERROR').key).toBe('error');
    expect(connectionStatusStyle('PENDING').key).toBe('pending');
    expect(connectionStatusStyle('DISCONNECTED').key).toBe('disconnected');
  });

  it('CAMINO DEGRADADO: un estado desconocido devuelve estilo neutro, no revienta', () => {
    for (const status of ['REVOKED', '', 'verified', 'ESTADO_NUEVO_DE_LA_API']) {
      const cfg = connectionStatusStyle(status);
      expect(cfg, status).toEqual({ key: null, variant: 'outline' });
      // `key: null` es lo que le dice al caller que pinte el código crudo en
      // vez de construir `connStatus.undefined` y pintar la key en pantalla.
      expect(cfg.key, status).toBeNull();
    }
  });
});
